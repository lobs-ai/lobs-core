/**
 * Memory extractor — uses Claude Haiku to extract candidate memories
 * from event clusters during reflection.
 *
 * Uses the shared provider infrastructure (parseModelString/createClient)
 * so it benefits from key rotation, error handling, etc.
 * Never crashes — all errors are caught and return empty arrays.
 */

import { log } from "../util/logger.js";
import { parseModelString, createClient } from "../runner/providers.js";
import type { EventCluster } from "./clustering.js";
import type { MemoryEvent } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const EXTRACTION_MODEL = "anthropic/claude-haiku-4-5";
const MAX_CONTENT_CHARS = 6000; // ~1.5k tokens of event content
const MAX_RESPONSE_TOKENS = 2048;

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
  title: string;
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
  "title": "<short 3-8 word title for this memory>",
  "content": "<concise memory text, 1-3 sentences>",
  "memoryType": "learning|decision|pattern|preference|fact",
  "confidence": <0.0-1.0>,
  "sourceAuthority": <0 or 1>,
  "scope": "system|agent|session",
  "evidenceEventIds": [<event id numbers>]
}

IMPORTANT — Quality filters (reject these):
- Ephemeral state: branch names, test counts, "system is working", process status
- Implementation narration: "initialized X", "wired Y into Z", "registered hook"
- Redundant architecture: don't re-describe how the memory system works — it already knows
- Version-specific: exact version numbers or timing data that will be stale tomorrow
- Meta-observations: observations about the extraction/memory process itself

KEEP only memories that a future agent session would genuinely benefit from:
- User preferences and corrections (highest value)
- Architectural decisions with rationale (WHY, not just WHAT)
- Hard-won debugging insights (what was wrong, why it was hard to find)
- External system gotchas (API quirks, service limitations)
- Project-specific domain knowledge

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

async function callHaiku(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; tokensUsed: number }> {
  const config = parseModelString(EXTRACTION_MODEL);
  const client = createClient(config);

  const response = await client.createMessage({
    model: config.modelId,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    tools: [],
    maxTokens: MAX_RESPONSE_TOKENS,
  });

  const text = (response.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("");

  const tokensUsed =
    (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0);

  return { text, tokensUsed };
}

// ── Response parsing ─────────────────────────────────────────────────────────

function parseJsonArray(text: string): unknown[] {
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

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
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

  return { title, content, memoryType, confidence, sourceAuthority, scope, evidenceEventIds };
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
 * Extract candidate memories from an event cluster using Claude Haiku.
 *
 * Returns an empty array if the API is unavailable or returns unparseable output.
 * Never throws.
 */
export async function extractMemories(cluster: EventCluster): Promise<MemoryCandidate[]> {
  if (cluster.events.length === 0) return [];

  const userPrompt = buildUserPrompt(cluster);

  try {
    const { text, tokensUsed } = await callHaiku(SYSTEM_PROMPT, userPrompt);

    _totalTokensUsed += tokensUsed;

    if (!text.trim()) {
      log().warn("[extractor] Haiku returned empty response");
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

    log().info(
      `[extractor] Extracted ${candidates.length} candidates from cluster (${cluster.events.length} events, ${tokensUsed} tokens)`,
    );

    return candidates;
  } catch (err) {
    log().warn(`[extractor] Extraction failed: ${String(err)}`);
    return [];
  }
}
