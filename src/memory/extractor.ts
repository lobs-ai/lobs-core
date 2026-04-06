/**
 * Memory extractor — uses Claude Haiku to extract candidate memories
 * from event clusters during reflection.
 *
 * Philosophy: importance is the only filter. Tool calls, routine file reads,
 * and mechanical actions are noise. Decisions, learnings, user preferences,
 * debugging insights, and architectural choices are signal. The LLM decides
 * what matters — we don't pre-filter or truncate aggressively.
 *
 * Errors are thrown (not swallowed) so the caller can retry with backoff.
 */

import { log } from "../util/logger.js";
import { getBotName, getOwnerName } from "../config/identity.js";
import { parseModelString, createClient } from "../runner/providers.js";
import { getModelForTier } from "../config/models.js";
import type { EventCluster } from "./clustering.js";
import type { MemoryEvent } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const EXTRACTION_MODEL = getModelForTier("small");
const MAX_RESPONSE_TOKENS = 2048;

/**
 * Max chars of event content to send per extraction call.
 * Haiku has 200k context — we can afford to be generous.
 * ~4 chars/token → 15k chars ≈ 3.75k input tokens. Cheap.
 */
const MAX_CONTENT_CHARS = 15_000;

// ── Evidence thresholds ──────────────────────────────────────────────────────

const EVIDENCE_THRESHOLDS: Record<
  MemoryCandidate["memoryType"],
  { minEvents: number; minConfidence: number }
> = {
  learning: { minEvents: 1, minConfidence: 0.6 },
  decision: { minEvents: 1, minConfidence: 0.7 },
  pattern: { minEvents: 2, minConfidence: 0.5 },
  preference: { minEvents: 1, minConfidence: 0.7 },
  fact: { minEvents: 1, minConfidence: 0.8 },
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

const SYSTEM_PROMPT = `You are a memory extraction assistant for an AI agent called ${getBotName()}. Your job is to identify memories that will be USEFUL IN FUTURE SESSIONS — things a fresh agent instance needs to know that it can't find in code, git history, or docs.

Context about ${getBotName()}:
- ${getBotName()} is a personal AI agent for ${getOwnerName()}, a grad student (MS in CSE) at the University of Michigan
- ${getBotName()} runs as a persistent service (lobs-core) with Discord integration, tools (exec, read, write, web search, etc.), and structured memory
- Main projects: ${getBotName()} itself (AI agent platform), PAW (SaaS hosting platform with collaborator Marcus), Flock (esports)
- ${getOwnerName()} and ${getBotName()} are building one of the best AI agent setups in the world — ${getBotName()} should be maximally proactive and useful
- Marcus (Discord: Ontoral) is a PAW project collaborator. Virt is Marcus's AI bot.

This context helps you distinguish between:
- Durable facts about people/projects vs. session-local implementation details
- User preferences vs. one-time instructions
- System architecture decisions vs. routine code changes

Memory types:
- learning: Something discovered through experience — debugging insights, API quirks, what worked/didn't
- decision: An explicit choice made about something ONGOING — architecture, approach, tool selection, and WHY
- pattern: Recurring behavior worth recognizing across sessions
- preference: A DURABLE user preference about how things should be done going forward (not a one-time instruction)
- fact: Concrete, durable fact — project structure, key people, URLs, configurations

THE KEY QUESTION: "Will a fresh agent session need this information, and can it NOT get it from code/git/docs?"

EXTRACT — genuinely useful for future sessions:
- Durable user preferences ("always use TypeScript", "don't message about low-priority stuff")
- People and relationships (who works on what, who has what role)
- External system quirks that aren't documented (API gotchas, service limitations)
- Hard-won debugging insights where the root cause was non-obvious
- Project domain knowledge that lives nowhere else
- User facts (schedule, preferences, background) stated naturally in conversation

SKIP — these are NOT memories:
- Implementation details from the current session ("changed X to Y", "removed the cap") — git is the record
- Session-local directives ("fix this bug", "use backoff here") — instructions, not preferences
- Code changes, refactors, config tweaks — the code is the record
- "System is healthy" / "build passed" / "restart worked" — ephemeral status
- Descriptions of what was just built or shipped — the PR/commit describes it
- Meta-observations about the agent's own systems (memory pipeline, reflection, extraction)
- Anything the agent could re-derive by reading the codebase

A "preference" means the user wants something GOING FORWARD, not that they asked for something in this session. "Remove the caps from this code" is a session instruction. "I prefer importance-driven filtering over hard caps" would be a preference — but only if stated as a general principle, not as a specific code change request.

If the events contain nothing worth remembering for future sessions, return an empty array []. Most sessions should produce 0-2 memories. Returning [] is the RIGHT answer for routine work sessions.

Output ONLY a JSON array. No prose, no markdown fences. Each element:
{
  "title": "<short 3-8 word title>",
  "content": "<concise memory, 1-3 sentences>",
  "memoryType": "learning|decision|pattern|preference|fact",
  "confidence": <0.0-1.0>,
  "sourceAuthority": <0 or 1>,
  "scope": "system|agent|session",
  "evidenceEventIds": [<event id numbers>]
}

Rules:
- Confidence 0.9+ only for directly stated facts or explicit user preferences
- sourceAuthority=1 only when the user explicitly states something
- evidenceEventIds must reference actual event IDs from the input
- Fewer is better. One good memory beats five mediocre ones. Zero is fine.
- When in doubt, don't extract it.`;

/**
 * Build the user prompt from a cluster.
 * Pre-filters obvious noise (low-signal tool_result events) to maximize
 * the useful content within our char budget.
 */
function buildUserPrompt(cluster: EventCluster): string {
  const eventLines: string[] = [];
  let chars = 0;

  // First pass: include all high-signal events and non-tool events
  const prioritized = [...cluster.events].sort((a, b) => {
    // User input always first
    if (a.event_type === "user_input" && b.event_type !== "user_input") return -1;
    if (b.event_type === "user_input" && a.event_type !== "user_input") return 1;
    // Then errors/decisions
    if (a.event_type === "error" && b.event_type !== "error") return -1;
    if (b.event_type === "error" && a.event_type !== "error") return 1;
    if (a.event_type === "decision" && b.event_type !== "decision") return -1;
    if (b.event_type === "decision" && a.event_type !== "decision") return 1;
    // Then by signal score descending
    return b.signal_score - a.signal_score;
  });

  for (const event of prioritized) {
    // Skip very low-signal tool results — they're noise (routine reads, listings)
    if (
      event.event_type === "tool_result" &&
      event.signal_score < 0.4 &&
      chars > MAX_CONTENT_CHARS * 0.3 // only skip if we already have decent content
    ) {
      continue;
    }

    const line = formatEvent(event);
    if (chars + line.length > MAX_CONTENT_CHARS) continue; // skip, don't break — try smaller events
    eventLines.push(line);
    chars += line.length;
  }

  return `Extract important memories from these agent events (cluster: ${cluster.priority} priority — ${cluster.reason}):\n\n${eventLines.join("\n")}`;
}

function formatEvent(event: MemoryEvent): string {
  const ts = event.timestamp.slice(0, 19);
  // Truncate very long individual event content (some tool results are huge)
  const content =
    event.content.length > 500
      ? event.content.slice(0, 500) + "…"
      : event.content;
  return `[${event.id}] ${ts} ${event.event_type.toUpperCase()} (signal=${event.signal_score.toFixed(1)}): ${content}`;
}

// ── LLM call ─────────────────────────────────────────────────────────────────

/**
 * Call Haiku for extraction. Throws on error so caller can retry.
 */
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

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON array found in response: ${cleaned.slice(0, 200)}`);
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
 * THROWS on LLM errors so the caller can retry with backoff.
 * Returns empty array only when there's genuinely nothing to extract.
 */
export async function extractMemories(cluster: EventCluster): Promise<MemoryCandidate[]> {
  if (cluster.events.length === 0) return [];

  const userPrompt = buildUserPrompt(cluster);

  const { text, tokensUsed } = await callHaiku(SYSTEM_PROMPT, userPrompt);

  _totalTokensUsed += tokensUsed;

  if (!text.trim()) {
    log().warn("[extractor] Haiku returned empty response");
    return [];
  }

  let rawItems: unknown[];
  try {
    rawItems = parseJsonArray(text);
  } catch (parseErr) {
    log().warn(`[extractor] Failed to parse Haiku response: ${String(parseErr)}`);
    // Parse failures aren't retryable — Haiku just gave bad JSON. Return empty.
    return [];
  }

  const candidates: MemoryCandidate[] = [];

  for (const item of rawItems) {
    const candidate = validateCandidate(item);
    if (!candidate) continue;
    if (!meetsThreshold(candidate, cluster.events.length)) continue;
    candidates.push(candidate);
  }

  log().info(
    `[extractor] Extracted ${candidates.length} candidates from cluster ` +
      `(${cluster.events.length} events, ${tokensUsed} tokens)`,
  );

  return candidates;
}
