/**
 * Memory extractor — uses a local LLM (LM Studio) to extract candidate
 * memories from event clusters.
 *
 * Makes direct HTTP calls to http://localhost:1234/v1/chat/completions.
 * Never calls Anthropic/OpenAI APIs. Never crashes — all errors are caught
 * and return empty arrays.
 */

import { log } from "../util/logger.js";
import type { EventCluster } from "./clustering.js";
import type { MemoryEvent } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const LM_STUDIO_URL = "http://localhost:1234/v1/chat/completions";
const LM_STUDIO_MODEL = "qwen/qwen3.5-9b";
const MAX_CONTENT_CHARS = 6000; // ~1.5k tokens of event content
const REQUEST_TIMEOUT_MS = 60_000;

// ── Evidence thresholds ──────────────────────────────────────────────────────

const EVIDENCE_THRESHOLDS: Record<
  MemoryCandidate["memoryType"],
  { minEvents: number; minConfidence: number }
> = {
  learning: { minEvents: 2, minConfidence: 0.6 },
  decision: { minEvents: 1, minConfidence: 0.8 },
  pattern: { minEvents: 3, minConfidence: 0.5 },
  preference: { minEvents: 2, minConfidence: 0.7 },
  fact: { minEvents: 1, minConfidence: 0.9 },
};

// ── Public types ─────────────────────────────────────────────────────────────

export interface MemoryCandidate {
  content: string;
  memoryType: "learning" | "decision" | "pattern" | "preference" | "fact";
  confidence: number;
  /** 0 = reflection-extracted, 1 = agent-stated */
  sourceAuthority: 0 | 1;
  scope: "system" | "agent" | "session";
  evidenceEventIds: number[];
}

// ── Prompt construction ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a memory extraction assistant. Your job is to identify durable, reusable memories from agent activity logs.

Memory types:
- learning: Something discovered through trial and error or observation
- decision: An explicit choice made (architecture, approach, tool selection)
- pattern: Recurring behavior or structure worth recognizing
- preference: Stable preference (user or system) about how things should be done
- fact: A concrete, verifiable fact (version number, config value, URL, etc.)

Output ONLY a JSON array. No prose, no markdown fences. Each element:
{
  "content": "<concise memory text, 1-3 sentences>",
  "memoryType": "learning|decision|pattern|preference|fact",
  "confidence": <0.0-1.0>,
  "sourceAuthority": <0 or 1>,
  "scope": "system|agent|session",
  "evidenceEventIds": [<event id numbers>]
}

Rules:
- Only extract memories that would be useful in future sessions
- Skip routine/ephemeral actions (file reads, directory listings)
- Confidence 0.9+ only for directly stated facts or decisions
- sourceAuthority=1 only when agent explicitly states a memory/decision
- evidenceEventIds must contain at least the IDs of supporting events`;

function buildUserPrompt(cluster: EventCluster): string {
  const eventLines: string[] = [];
  let chars = 0;

  for (const event of cluster.events) {
    const line = formatEvent(event);
    if (chars + line.length > MAX_CONTENT_CHARS) break;
    eventLines.push(line);
    chars += line.length;
  }

  return `Extract memories from these agent events (cluster priority: ${cluster.priority} — ${cluster.reason}):\n\n${eventLines.join("\n")}`;
}

function formatEvent(event: MemoryEvent): string {
  const ts = event.timestamp.slice(0, 19); // "YYYY-MM-DDTHH:MM:SS"
  return `[${event.id}] ${ts} ${event.event_type.toUpperCase()} (score=${event.signal_score.toFixed(1)}): ${event.content}`;
}

// ── LLM call ─────────────────────────────────────────────────────────────────

interface LmStudioMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LmStudioRequest {
  model: string;
  messages: LmStudioMessage[];
  temperature: number;
  max_tokens: number;
  stream: false;
}

interface LmStudioResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    total_tokens?: number;
  };
}

async function callLmStudio(
  messages: LmStudioMessage[],
): Promise<{ text: string; tokensUsed: number }> {
  const body: LmStudioRequest = {
    model: LM_STUDIO_MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 1024,
    stream: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(LM_STUDIO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LM Studio HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as LmStudioResponse;
    const text = data.choices?.[0]?.message?.content ?? "";
    const tokensUsed = data.usage?.total_tokens ?? 0;

    return { text, tokensUsed };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Response parsing ─────────────────────────────────────────────────────────

function parseJsonArray(text: string): unknown[] {
  // Strip markdown code fences if present
  const cleaned = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  // Find the JSON array
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON array found in response: ${cleaned.slice(0, 100)}`);
  }

  return JSON.parse(cleaned.slice(start, end + 1)) as unknown[];
}

function validateCandidate(raw: unknown): MemoryCandidate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const content = typeof obj.content === "string" ? obj.content.trim() : "";
  if (!content) return null;

  const validTypes = ["learning", "decision", "pattern", "preference", "fact"] as const;
  const memoryType = validTypes.includes(obj.memoryType as (typeof validTypes)[number])
    ? (obj.memoryType as MemoryCandidate["memoryType"])
    : null;
  if (!memoryType) return null;

  const confidence =
    typeof obj.confidence === "number"
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0;

  const sourceAuthority: 0 | 1 = obj.sourceAuthority === 1 ? 1 : 0;

  const validScopes = ["system", "agent", "session"] as const;
  const scope = validScopes.includes(obj.scope as (typeof validScopes)[number])
    ? (obj.scope as MemoryCandidate["scope"])
    : "session";

  const evidenceEventIds = Array.isArray(obj.evidenceEventIds)
    ? (obj.evidenceEventIds as unknown[]).filter((id) => typeof id === "number").map(Number)
    : [];

  return { content, memoryType, confidence, sourceAuthority, scope, evidenceEventIds };
}

// ── Threshold filtering ──────────────────────────────────────────────────────

function meetsThreshold(candidate: MemoryCandidate, clusterEventCount: number): boolean {
  const threshold = EVIDENCE_THRESHOLDS[candidate.memoryType];
  if (!threshold) return false;

  const evidenceCount = candidate.evidenceEventIds.length;
  const effectiveEvents = Math.max(evidenceCount, clusterEventCount > 0 ? 1 : 0);

  if (effectiveEvents < threshold.minEvents) return false;
  if (candidate.confidence < threshold.minConfidence) return false;

  return true;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Tokens used across all extraction calls in the current process lifetime */
let _totalTokensUsed = 0;

export function getTotalTokensUsed(): number {
  return _totalTokensUsed;
}

export function resetTokenCounter(): void {
  _totalTokensUsed = 0;
}

/**
 * Extract candidate memories from an event cluster using a local LLM.
 *
 * Returns an empty array if the LLM is unavailable or returns unparseable output.
 * Never throws.
 */
export async function extractMemories(cluster: EventCluster): Promise<MemoryCandidate[]> {
  if (cluster.events.length === 0) return [];

  const userPrompt = buildUserPrompt(cluster);

  try {
    const { text, tokensUsed } = await callLmStudio([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ]);

    _totalTokensUsed += tokensUsed;

    if (!text.trim()) {
      log().warn("[extractor] LM Studio returned empty response");
      return [];
    }

    const rawItems = parseJsonArray(text);
    const candidates: MemoryCandidate[] = [];

    for (const item of rawItems) {
      const candidate = validateCandidate(item);
      if (!candidate) continue;
      if (!meetsThreshold(candidate, cluster.events.length)) continue;
      candidates.push(candidate);
    }

    return candidates;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      log().warn("[extractor] LM Studio request timed out");
    } else {
      log().warn(`[extractor] Extraction failed: ${String(err)}`);
    }
    return [];
  }
}
