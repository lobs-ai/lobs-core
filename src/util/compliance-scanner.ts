/**
 * SAIL Compliance Scanner — 3-tier PII/sensitivity detection pipeline.
 *
 * Architecture (per research memo, 2026-03-06):
 *
 *   Tier 1 — Presidio pre-filter  (<1ms, pure regex)
 *     Fast-path for obviously sensitive messages (SSN, credit card, email).
 *     ~65–75% accuracy alone; catches high-precision structural PII.
 *
 *   Tier 2 — BERT-small ONNX     (10–20ms, DEFAULT-ON)
 *     Token classification NER model (gravitee-io/bert-small-pii-detection).
 *     F1 ~0.84; catches person names, org refs, financial IDs at high precision.
 *     Runs in a worker_thread to avoid blocking the event loop.
 *     Gracefully degrades to Tier 1 only if model is unavailable.
 *
 *   Tier 3 — Small LLM via Ollama (300ms–1s, OPT-IN)
 *     Semantic scan for FERPA/HIPAA edge cases that BERT misses.
 *     Only triggered when opts.deepScan=true (e.g., complianceRequired=true).
 *     Returns a human-readable reason explaining the violation.
 *
 * Default behavior:
 *   - Tier 1 + Tier 2 run on EVERY message (default-on)
 *   - Tier 3 only runs when deepScan=true
 *   - If sensitive=true and session is cloud → warn user (never hard-block by default)
 *
 * @see ~/lobs-control/state/research/sail-compliance-classifier/FINAL-MEMO.md
 */

import { Worker } from "node:worker_threads";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Entity types detectable by the scanner. */
export type EntityType =
  | "US_SSN"
  | "CREDIT_CARD"
  | "EMAIL_ADDRESS"
  | "PHONE_NUMBER"
  | "PERSON"
  | "US_BANK_NUMBER"
  | "US_PASSPORT"
  | "US_DRIVER_LICENSE"
  | "IP_ADDRESS"
  | "IBAN_CODE"
  | "MEDICAL_LICENSE"
  | "URL"
  | "SENSITIVE_SEMANTIC"; // LLM-tier only

/** Result returned by scanMessage(). */
export interface ScanResult {
  /** True if the message contains potentially sensitive content. */
  sensitive: boolean;
  /** Detected entity type labels (may be empty if sensitive=false). */
  entities: EntityType[];
  /** Confidence score (0–1). 1.0 = exact Presidio regex match; BERT = model confidence; LLM = 0.9 fixed. */
  confidence: number;
  /** For LLM-tier: explanation of why the message is sensitive. */
  reason?: string;
  /** Which tier triggered the result. Useful for logging/metrics. */
  tier: "presidio" | "bert" | "llm" | "none";
}

/** Options for scanMessage(). */
export interface ScanOptions {
  /**
   * When true, runs the Tier 3 Ollama LLM scan after BERT.
   * Intended for sessions where task/project has complianceRequired=true.
   */
  deepScan?: boolean;
  /**
   * Ollama model to use for deep scan. Defaults to "qwen2.5:0.5b".
   * Must be available via Ollama HTTP API.
   */
  llmModel?: string;
  /**
   * Ollama base URL. Defaults to "http://127.0.0.1:11434".
   */
  ollamaBaseUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1: Presidio pre-filter (pure regex, zero dependencies)
// ─────────────────────────────────────────────────────────────────────────────

/** Presidio-style regex patterns with entity type labels. */
const PRESIDIO_PATTERNS: Array<{ type: EntityType; pattern: RegExp }> = [
  // US Social Security Number
  { type: "US_SSN",        pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/ },
  // Credit card (Luhn-format, major card types)
  { type: "CREDIT_CARD",  pattern: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12}|3(?:0[0-5]|[68]\d)\d{11})\b/ },
  // Email addresses
  { type: "EMAIL_ADDRESS", pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/ },
  // US phone numbers (handles parenthesized area codes like (555) 867-5309)
  { type: "PHONE_NUMBER",  pattern: /(?<![0-9])(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}(?![0-9])/ },
  // US bank routing (ABA): 9-digit starting with 0,1,2,3
  { type: "US_BANK_NUMBER", pattern: /\b[0-3]\d{8}\b/ },
  // IPv4 addresses
  { type: "IP_ADDRESS",   pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  // IBAN codes
  { type: "IBAN_CODE",    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}(?:[A-Z0-9]{0,16})\b/ },
];

/**
 * Fast Presidio-style regex pre-filter.
 * Returns null if no patterns match (fast-path: message is clean).
 * Returns a ScanResult immediately on first match (short-circuit).
 */
export function presidioPreFilter(text: string): ScanResult | null {
  for (const { type, pattern } of PRESIDIO_PATTERNS) {
    if (pattern.test(text)) {
      return {
        sensitive: true,
        entities: [type],
        confidence: 1.0,
        tier: "presidio",
      };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2: BERT-small ONNX (worker thread, default-on)
// ─────────────────────────────────────────────────────────────────────────────

/** Result shape returned by the worker thread. */
interface BertWorkerResult {
  sensitive: boolean;
  entities: EntityType[];
  confidence: number;
  error?: string;
}

const BERT_WORKER_TIMEOUT_MS = 5_000; // 5s — model should return in ~20ms; timeout = circuit breaker

/**
 * Run BERT-small ONNX inference in a worker thread.
 * Returns null if the worker is unavailable (graceful fallback to Presidio-only).
 */
async function runBertScan(text: string): Promise<ScanResult | null> {
  const workerPath = join(__dirname, "compliance-scanner-worker.js");

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        log().warn?.("[compliance-scanner] BERT worker timed out — falling back to Presidio-only");
        resolve(null);
      }
    }, BERT_WORKER_TIMEOUT_MS);

    let worker: Worker;
    try {
      worker = new Worker(workerPath, { workerData: { text } });
    } catch (err) {
      // Worker script not found (compiled dist not present) — graceful fallback
      clearTimeout(timer);
      log().debug?.("[compliance-scanner] BERT worker unavailable — compiled worker not found");
      resolve(null);
      return;
    }

    worker.on("message", (result: BertWorkerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();

      if (result.error) {
        log().warn?.(`[compliance-scanner] BERT worker error: ${result.error}`);
        resolve(null);
        return;
      }

      resolve({
        sensitive: result.sensitive,
        entities: result.entities,
        confidence: result.confidence,
        tier: "bert",
      });
    });

    worker.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log().warn?.(`[compliance-scanner] BERT worker crashed: ${err.message}`);
      resolve(null);
    });

    worker.on("exit", (code) => {
      if (settled) return;
      if (code !== 0) {
        settled = true;
        clearTimeout(timer);
        log().warn?.(`[compliance-scanner] BERT worker exited with code ${code}`);
        resolve(null);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3: Small LLM via Ollama (opt-in deep scan)
// ─────────────────────────────────────────────────────────────────────────────

const OLLAMA_DEFAULT_MODEL = "qwen2.5:0.5b";
const OLLAMA_DEFAULT_BASE  = "http://127.0.0.1:11434";
const OLLAMA_TIMEOUT_MS    = 10_000;

const DEEP_SCAN_PROMPT = `You are a compliance classifier. Determine if the following message contains sensitive regulated data.

Categories to check:
- FERPA: student records, grades, enrollment, disciplinary records
- HIPAA: patient health info, diagnoses, treatment plans, medication, PHI
- PII: names + context suggesting financial/health/legal vulnerability
- Sensitive research: non-anonymized data about human subjects

Respond in JSON only. No explanation outside JSON.
Schema: { "sensitive": boolean, "reason": string | null }

If NOT sensitive, return: { "sensitive": false, "reason": null }
If sensitive, return: { "sensitive": true, "reason": "brief explanation of what makes it sensitive" }

Message to evaluate:
---
{{MESSAGE}}
---
`;

/**
 * Run a small LLM via Ollama for semantic deep-scan.
 * Returns null if Ollama is unavailable (graceful fallback).
 */
async function runLlmScan(
  text: string,
  model: string = OLLAMA_DEFAULT_MODEL,
  baseUrl: string = OLLAMA_DEFAULT_BASE,
): Promise<ScanResult | null> {
  const prompt = DEEP_SCAN_PROMPT.replace("{{MESSAGE}}", text.slice(0, 2_000)); // cap to 2k chars
  const url = `${baseUrl}/api/generate`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    let rawBody: string;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, stream: false, format: "json" }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        log().warn?.(`[compliance-scanner] Ollama returned HTTP ${res.status} — skipping LLM tier`);
        return null;
      }
      rawBody = await res.text();
    } catch (fetchErr) {
      clearTimeout(timeout);
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      log().debug?.(`[compliance-scanner] Ollama unavailable (${msg}) — skipping LLM tier`);
      return null;
    }

    // Ollama wraps the model output in { "response": "..." }
    let ollamaPayload: { response?: string };
    try {
      ollamaPayload = JSON.parse(rawBody) as { response?: string };
    } catch {
      log().warn?.("[compliance-scanner] Ollama response was not valid JSON");
      return null;
    }

    const responseText = ollamaPayload.response ?? rawBody;
    let parsed: { sensitive?: boolean; reason?: string | null };
    try {
      parsed = JSON.parse(responseText) as { sensitive?: boolean; reason?: string | null };
    } catch {
      // Try extracting JSON substring from a potentially verbose response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log().warn?.("[compliance-scanner] LLM response contained no JSON object");
        return null;
      }
      try {
        parsed = JSON.parse(jsonMatch[0]) as { sensitive?: boolean; reason?: string | null };
      } catch {
        log().warn?.("[compliance-scanner] LLM response JSON was malformed");
        return null;
      }
    }

    if (typeof parsed.sensitive !== "boolean") {
      log().warn?.("[compliance-scanner] LLM response missing 'sensitive' field");
      return null;
    }

    return {
      sensitive: parsed.sensitive,
      entities: parsed.sensitive ? ["SENSITIVE_SEMANTIC"] : [],
      confidence: 0.9,
      reason: parsed.reason ?? undefined,
      tier: "llm",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log().warn?.(`[compliance-scanner] LLM scan error: ${msg}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan a message for sensitive content using the 3-tier pipeline.
 *
 * Pipeline:
 *   1. Presidio regex (always, <1ms)
 *   2. BERT-small ONNX (always, ~10–20ms)
 *   3. Ollama LLM (only when opts.deepScan=true)
 *
 * If sensitive=true and the current session uses a cloud model, the caller
 * should warn the user or reroute to a local model. Hard-blocking is NOT
 * recommended at launch — use warn-only mode.
 *
 * @param text  The full message text to scan.
 * @param opts  Options for the scan pipeline.
 * @returns     ScanResult describing sensitivity, entities, confidence, and tier.
 */
export async function scanMessage(
  text: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const trimmed = text.trim();

  if (!trimmed) {
    return { sensitive: false, entities: [], confidence: 1.0, tier: "none" };
  }

  // ── Tier 1: Presidio ──────────────────────────────────────────────────────
  const presidioResult = presidioPreFilter(trimmed);
  if (presidioResult) {
    log().debug?.(`[compliance-scanner] Presidio hit: ${presidioResult.entities.join(", ")}`);
    // Still run LLM if deepScan requested, but presidio already flagged it
    // Skip BERT (unnecessary cost once Presidio already matched)
    if (opts.deepScan) {
      const llmResult = await runLlmScan(
        trimmed,
        opts.llmModel,
        opts.ollamaBaseUrl,
      );
      if (llmResult) return llmResult;
    }
    return presidioResult;
  }

  // ── Tier 2: BERT-small ONNX ───────────────────────────────────────────────
  const bertResult = await runBertScan(trimmed);
  if (bertResult?.sensitive) {
    log().debug?.(`[compliance-scanner] BERT hit: ${bertResult.entities.join(", ")} (conf=${bertResult.confidence.toFixed(2)})`);
    if (opts.deepScan) {
      const llmResult = await runLlmScan(
        trimmed,
        opts.llmModel,
        opts.ollamaBaseUrl,
      );
      if (llmResult) return llmResult;
    }
    return bertResult;
  }

  // ── Tier 3: LLM deep scan (opt-in) ────────────────────────────────────────
  if (opts.deepScan) {
    const llmResult = await runLlmScan(
      trimmed,
      opts.llmModel,
      opts.ollamaBaseUrl,
    );
    if (llmResult) {
      if (llmResult.sensitive) {
        log().debug?.(`[compliance-scanner] LLM hit: ${llmResult.reason ?? "no reason provided"}`);
      }
      return llmResult;
    }
  }

  // No tier flagged this message
  return {
    sensitive: false,
    entities: [],
    confidence: bertResult?.confidence ?? 1.0,
    tier: bertResult ? "bert" : (presidioResult ? "presidio" : "none"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports for convenience
// ─────────────────────────────────────────────────────────────────────────────

export { PRESIDIO_PATTERNS };
