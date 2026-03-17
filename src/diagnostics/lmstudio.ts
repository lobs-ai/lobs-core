/**
 * LM Studio model availability diagnostic.
 *
 * Queries the LM Studio API for loaded models, collects every local model ID
 * referenced in agent config, and reports any that are missing or have drifted.
 *
 * Usage:
 *   import { runLmStudioDiagnostic } from "../diagnostics/lmstudio.js";
 *
 *   // Before spawning — throws/warns if required local models are missing
 *   const report = await runLmStudioDiagnostic();
 *   if (!report.ok) { ... handle mismatches ... }
 *
 * CLI:
 *   lobs models
 */

import { getModelConfig } from "../config/models.js";
import { log } from "../util/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LmStudioModel {
  id: string;
  object: string;
  owned_by?: string;
}

export interface LmStudioModelsResponse {
  object: string;
  data: LmStudioModel[];
}

export interface ModelMismatch {
  configId: string;       // What config says (e.g. "qwen3.5-35b-mlx")
  location: string;       // Where in config (e.g. "tiers.micro", "local.chatModel")
  loadedIds: string[];    // What LM Studio actually has loaded
  suggestion?: string;    // Closest match if found
}

export interface LmStudioDiagnosticReport {
  ok: boolean;
  reachable: boolean;
  loadedModels: string[];      // All model IDs currently loaded in LM Studio
  configuredLocalModels: {     // All local model refs extracted from config
    id: string;
    location: string;
  }[];
  mismatches: ModelMismatch[];  // Config refs not found in loaded models
  warnings: string[];           // Non-fatal issues (e.g. no local models configured)
  checkedAt: Date;
}

// ── Model ID extraction ───────────────────────────────────────────────────────

/** Strip provider prefix: "lmstudio/qwen3-4b" → "qwen3-4b" */
function stripPrefix(modelId: string): string {
  const sep = modelId.indexOf("/");
  return sep !== -1 ? modelId.slice(sep + 1) : modelId;
}

/** Detect if a model ID is intended for LM Studio (local). */
function isLocalModelId(id: string): boolean {
  return (
    id.startsWith("lmstudio/") ||
    id.startsWith("local/") ||
    id.startsWith("ollama/") ||
    // Non-prefixed IDs in the local config block are always local
    !id.includes("/")
  );
}

export interface ConfigModelRef {
  id: string;          // Raw model ID from config
  bareId: string;      // After stripping provider prefix
  location: string;    // JSON path in config (for display)
}

/**
 * Extract all local (LM Studio) model references from the current config.
 *
 * Scans:
 *   - tiers.* (any that look like local models)
 *   - agents.*.primary / agents.*.fallbacks (same)
 *   - local.chatModel
 *   - local.embeddingModel
 */
export function extractLocalModelRefs(): ConfigModelRef[] {
  const cfg = getModelConfig();
  const refs: ConfigModelRef[] = [];

  const add = (id: string, location: string) => {
    if (!id || !isLocalModelId(id)) return;
    refs.push({ id, bareId: stripPrefix(id), location });
  };

  // Tiers
  for (const [tier, model] of Object.entries(cfg.tiers)) {
    add(model, `tiers.${tier}`);
  }

  // Agents
  for (const [agentType, chain] of Object.entries(cfg.agents)) {
    add(chain.primary, `agents.${agentType}.primary`);
    chain.fallbacks.forEach((fb, i) => add(fb, `agents.${agentType}.fallbacks[${i}]`));
  }

  // Local block (these are always local by definition — no prefix check needed)
  if (cfg.local.chatModel) {
    refs.push({
      id: cfg.local.chatModel,
      bareId: stripPrefix(cfg.local.chatModel),
      location: "local.chatModel",
    });
  }
  if (cfg.local.embeddingModel) {
    refs.push({
      id: cfg.local.embeddingModel,
      bareId: stripPrefix(cfg.local.embeddingModel),
      location: "local.embeddingModel",
    });
  }

  // Deduplicate by (bareId, location)
  const seen = new Set<string>();
  return refs.filter(r => {
    const key = `${r.bareId}::${r.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── LM Studio API ─────────────────────────────────────────────────────────────

/**
 * Fetch loaded models from LM Studio /v1/models endpoint.
 * Returns null if LM Studio is unreachable.
 */
export async function fetchLoadedModels(baseUrl: string, timeoutMs = 4000): Promise<LmStudioModel[] | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      log().warn(`[LM_STUDIO_DIAG] /v1/models returned HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as LmStudioModelsResponse;
    return Array.isArray(data.data) ? data.data : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("TimeoutError") || msg.includes("fetch failed")) {
      log().debug?.(`[LM_STUDIO_DIAG] LM Studio unreachable at ${baseUrl}: ${msg}`);
    } else {
      log().warn(`[LM_STUDIO_DIAG] Unexpected error querying ${url}: ${msg}`);
    }
    return null;
  }
}

// ── Fuzzy matching ────────────────────────────────────────────────────────────

/**
 * Attempt to find the closest loaded model for a config ID.
 *
 * Strategy (in order):
 * 1. Exact match on bare ID
 * 2. Loaded model ID *contains* config ID (handles path suffixes like "-mlx")
 * 3. Config ID *contains* loaded model ID
 * 4. Shared prefix of ≥6 chars
 */
export function findClosestMatch(bareId: string, loadedIds: string[]): string | undefined {
  const normalize = (s: string) => s.toLowerCase().replace(/[-_.\s]/g, "");
  const normalizedTarget = normalize(bareId);

  // 1. Exact
  const exact = loadedIds.find(id => normalize(id) === normalizedTarget);
  if (exact) return exact;

  // 2. Loaded ID contains config ID (e.g. loaded="qwen3.5-35b-mlx-instruct", config="qwen3.5-35b")
  const loadedContains = loadedIds.find(id => normalize(id).includes(normalizedTarget));
  if (loadedContains) return loadedContains;

  // 3. Config ID contains loaded ID
  const configContains = loadedIds.find(id => normalizedTarget.includes(normalize(id)));
  if (configContains) return configContains;

  // 4. Shared prefix of ≥6 chars
  const PREFIX_MIN = 6;
  let bestLen = 0;
  let bestId: string | undefined;
  for (const id of loadedIds) {
    const normId = normalize(id);
    let sharedLen = 0;
    const minLen = Math.min(normalizedTarget.length, normId.length);
    for (let i = 0; i < minLen; i++) {
      if (normalizedTarget[i] === normId[i]) sharedLen++;
      else break;
    }
    if (sharedLen >= PREFIX_MIN && sharedLen > bestLen) {
      bestLen = sharedLen;
      bestId = id;
    }
  }
  return bestId;
}

// ── Core diagnostic ───────────────────────────────────────────────────────────

/**
 * Run the full LM Studio availability diagnostic.
 *
 * @param options.baseUrl  Override the LM Studio URL (default: from config)
 * @param options.timeoutMs  Per-request timeout (default: 4000)
 */
export async function runLmStudioDiagnostic(options: {
  baseUrl?: string;
  timeoutMs?: number;
} = {}): Promise<LmStudioDiagnosticReport> {
  const cfg = getModelConfig();
  const baseUrl = options.baseUrl ?? cfg.local.baseUrl;
  const timeoutMs = options.timeoutMs ?? 4000;
  const checkedAt = new Date();

  const configRefs = extractLocalModelRefs();
  const warnings: string[] = [];

  // ── Query LM Studio ───────────────────────────────────────────────────────

  const loaded = await fetchLoadedModels(baseUrl, timeoutMs);

  if (loaded === null) {
    // LM Studio is down — warn but don't fail if no local models are configured
    if (configRefs.length === 0) {
      warnings.push(`LM Studio unreachable at ${baseUrl} (no local models configured — OK)`);
      return {
        ok: true,
        reachable: false,
        loadedModels: [],
        configuredLocalModels: configRefs.map(r => ({ id: r.id, location: r.location })),
        mismatches: [],
        warnings,
        checkedAt,
      };
    }

    // Local models are configured but LM Studio is down — this IS a problem
    const mismatches: ModelMismatch[] = configRefs.map(r => ({
      configId: r.id,
      location: r.location,
      loadedIds: [],
      suggestion: undefined,
    }));

    return {
      ok: false,
      reachable: false,
      loadedModels: [],
      configuredLocalModels: configRefs.map(r => ({ id: r.id, location: r.location })),
      mismatches,
      warnings: [`LM Studio unreachable at ${baseUrl} — ${configRefs.length} local model(s) cannot be verified`],
      checkedAt,
    };
  }

  // ── Match config refs against loaded models ───────────────────────────────

  const loadedIds = loaded.map(m => m.id);
  const normalize = (s: string) => s.toLowerCase().replace(/[-_.\s]/g, "");

  if (loadedIds.length === 0) {
    warnings.push("LM Studio is reachable but no models are loaded");
  }

  const mismatches: ModelMismatch[] = [];

  for (const ref of configRefs) {
    // Check if this ref is satisfied by any loaded model
    const satisfied = loadedIds.some(
      id => normalize(id) === normalize(ref.bareId),
    );

    if (!satisfied) {
      const suggestion = findClosestMatch(ref.bareId, loadedIds);
      mismatches.push({
        configId: ref.id,
        location: ref.location,
        loadedIds,
        suggestion,
      });
    }
  }

  const ok = mismatches.length === 0;

  return {
    ok,
    reachable: true,
    loadedModels: loadedIds,
    configuredLocalModels: configRefs.map(r => ({ id: r.id, location: r.location })),
    mismatches,
    warnings,
    checkedAt,
  };
}

// ── Pre-spawn guard ───────────────────────────────────────────────────────────

/**
 * Check that the specific model IDs a spawn will use are available in LM Studio.
 *
 * Intended for use immediately before spawning a local-model agent.
 * Does NOT throw — returns a structured result so the caller can decide.
 *
 * @param modelIds  Model IDs the spawn will use (primary + fallbacks)
 * @returns { ok, missingIds, loadedModels, suggestions }
 */
export async function checkModelsBeforeSpawn(
  modelIds: string[],
  options: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<{
  ok: boolean;
  missingIds: string[];
  loadedModels: string[];
  suggestions: Record<string, string>;  // missing id → closest loaded id
  reachable: boolean;
}> {
  const localIds = modelIds.filter(isLocalModelId).map(stripPrefix);

  // If none of the models are local, skip the check entirely
  if (localIds.length === 0) {
    return { ok: true, missingIds: [], loadedModels: [], suggestions: {}, reachable: true };
  }

  const cfg = getModelConfig();
  const baseUrl = options.baseUrl ?? cfg.local.baseUrl;
  const loaded = await fetchLoadedModels(baseUrl, options.timeoutMs ?? 3000);

  if (loaded === null) {
    return {
      ok: false,
      missingIds: localIds,
      loadedModels: [],
      suggestions: {},
      reachable: false,
    };
  }

  const loadedIds = loaded.map(m => m.id);
  const normalize = (s: string) => s.toLowerCase().replace(/[-_.\s]/g, "");

  const missingIds: string[] = [];
  const suggestions: Record<string, string> = {};

  for (const id of localIds) {
    const found = loadedIds.some(lid => normalize(lid) === normalize(id));
    if (!found) {
      missingIds.push(id);
      const suggestion = findClosestMatch(id, loadedIds);
      if (suggestion) suggestions[id] = suggestion;
    }
  }

  return {
    ok: missingIds.length === 0,
    missingIds,
    loadedModels: loadedIds,
    suggestions,
    reachable: true,
  };
}

// ── Report formatting ─────────────────────────────────────────────────────────

/**
 * Format a diagnostic report as human-readable CLI output.
 * Returns an array of lines — caller provides colorization.
 */
export function formatDiagnosticReport(
  report: LmStudioDiagnosticReport,
  opts: { color?: boolean } = {},
): string[] {
  const c = opts.color ?? true;

  const green  = (s: string) => c ? `\x1b[32m${s}\x1b[0m` : s;
  const red    = (s: string) => c ? `\x1b[31m${s}\x1b[0m` : s;
  const yellow = (s: string) => c ? `\x1b[33m${s}\x1b[0m` : s;
  const cyan   = (s: string) => c ? `\x1b[36m${s}\x1b[0m` : s;
  const gray   = (s: string) => c ? `\x1b[90m${s}\x1b[0m` : s;
  const bright = (s: string) => c ? `\x1b[1m${s}\x1b[0m` : s;
  const dim    = (s: string) => c ? `\x1b[2m${s}\x1b[0m` : s;

  const lines: string[] = [];
  const cfg = getModelConfig();

  lines.push("");
  lines.push(bright("=== LM Studio Model Diagnostic ==="));
  lines.push("");

  // Reachability
  const reachLabel = report.reachable
    ? green("✓ reachable")
    : red("✗ unreachable");
  lines.push(`${cyan("LM Studio")}  ${reachLabel}  ${gray(cfg.local.baseUrl)}`);
  lines.push(`${"Checked".padEnd(11)} ${gray(report.checkedAt.toLocaleTimeString())}`);
  lines.push("");

  // Loaded models
  lines.push(cyan("Loaded Models:"));
  if (!report.reachable) {
    lines.push(`  ${red("(cannot connect)")}`);
  } else if (report.loadedModels.length === 0) {
    lines.push(`  ${yellow("(none — load a model in LM Studio)")}`);
  } else {
    for (const id of report.loadedModels) {
      lines.push(`  ${green("●")} ${id}`);
    }
  }
  lines.push("");

  // Config references
  lines.push(cyan("Configured Local Models:"));
  if (report.configuredLocalModels.length === 0) {
    lines.push(`  ${dim("(none)")}`);
  } else {
    for (const { id, location } of report.configuredLocalModels) {
      const isMissing = report.mismatches.some(m => m.configId === id && m.location === location);
      const icon = isMissing ? red("✗") : green("✓");
      lines.push(`  ${icon} ${id.padEnd(40)} ${gray(location)}`);
    }
  }
  lines.push("");

  // Mismatches
  if (report.mismatches.length === 0) {
    if (report.reachable) {
      lines.push(green("✓ All configured local models are loaded"));
    }
  } else {
    lines.push(red(`✗ ${report.mismatches.length} mismatch(es) found:`));
    lines.push("");
    for (const mm of report.mismatches) {
      lines.push(`  ${red("✗")} ${bright(mm.configId)}`);
      lines.push(`    ${dim("config location:")} ${mm.location}`);
      if (!report.reachable) {
        lines.push(`    ${yellow("LM Studio unreachable — cannot verify")}`);
      } else if (mm.loadedIds.length === 0) {
        lines.push(`    ${yellow("No models loaded in LM Studio")}`);
      } else {
        lines.push(`    ${dim("loaded models:")} ${mm.loadedIds.slice(0, 3).join(", ")}${mm.loadedIds.length > 3 ? ` +${mm.loadedIds.length - 3} more` : ""}`);
      }
      if (mm.suggestion) {
        lines.push(`    ${yellow("→ Closest match:")} ${bright(mm.suggestion)}`);
        lines.push(`    ${dim("  Fix: update config to use")} ${mm.suggestion}`);
      } else if (report.reachable && mm.loadedIds.length > 0) {
        lines.push(`    ${yellow("No close match found — load the model in LM Studio or update config")}`);
      }
      lines.push("");
    }

    lines.push(dim("How to fix:"));
    lines.push(dim("  1. Load the model in LM Studio (Server → Models → Load)"));
    lines.push(dim("  2. Or update ~/.lobs/config/models.json to match a loaded model ID"));
    lines.push(dim("  3. Run 'lobs models' again to verify"));
  }

  // Warnings
  if (report.warnings.length > 0) {
    lines.push("");
    for (const w of report.warnings) {
      lines.push(`  ${yellow("⚠")} ${w}`);
    }
  }

  lines.push("");
  return lines;
}
