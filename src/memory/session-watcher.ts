/**
 * SessionWatcher — out-of-band knowledge extraction from live sessions.
 *
 * Registers on after_llm_call hook, tracks turn counts per session,
 * and periodically extracts learnings/decisions/preferences from the
 * transcript without touching the live conversation.
 *
 * All extraction is fire-and-forget: never blocks the live session.
 */

import { getHookRegistry, type HookEvent } from "../runner/hooks.js";
import { SessionTranscript, type TurnRecord } from "../runner/session-transcript.js";
import { reconcile } from "./reconciler.js";
import { isMemoryDbReady } from "./db.js";
import { parseModelString, createClient } from "../runner/providers.js";
import { getModelForTier } from "../config/models.js";
import { log } from "../util/logger.js";
import type { MemoryCandidate } from "./extractor.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const TURN_THRESHOLD = 10;                    // Extract every N turns
const MIN_EXTRACTION_INTERVAL_MS = 60_000;   // Max 1 extraction per minute per session
const MAX_CONTENT_CHARS = 8_000;             // Cap transcript content sent to Haiku
const MAX_RESPONSE_TOKENS = 1024;            // Haiku response cap
const EXTRACTION_MODEL = getModelForTier("small");

// ── Per-session state ──────────────────────────────────────────────────────────

interface SessionState {
  turnsSinceLastExtraction: number;
  lastExtractionTime: number;
  extractionRunning: boolean;
  totalExtractions: number;
}

const sessionStates = new Map<string, SessionState>();

// ── Hook handler ───────────────────────────────────────────────────────────────

async function handleAfterLlmCall(event: HookEvent): Promise<HookEvent | null> {
  const { agentType } = event;
  const turn = (event.data.turn as number | undefined) ?? 0;
  const runId = (event.data.runId as string | undefined) ?? event.taskId ?? "unknown";

  // Get or create session state
  let state = sessionStates.get(runId);
  if (!state) {
    state = {
      turnsSinceLastExtraction: 0,
      lastExtractionTime: 0,
      extractionRunning: false,
      totalExtractions: 0,
    };
    sessionStates.set(runId, state);
  }

  state.turnsSinceLastExtraction++;

  const shouldExtract =
    state.turnsSinceLastExtraction >= TURN_THRESHOLD &&
    !state.extractionRunning &&
    Date.now() - state.lastExtractionTime >= MIN_EXTRACTION_INTERVAL_MS;

  if (shouldExtract) {
    state.extractionRunning = true;
    // Fire-and-forget — never await this in the hook
    runExtraction(runId, agentType, turn)
      .catch((err) => {
        log().warn(`[session-watcher] Extraction failed for ${runId}: ${String(err)}`);
      })
      .finally(() => {
        const s = sessionStates.get(runId);
        if (s) {
          s.extractionRunning = false;
          s.turnsSinceLastExtraction = 0;
          s.lastExtractionTime = Date.now();
          s.totalExtractions++;
        }
      });
  }

  return event; // Always pass through — never cancel
}

// ── Extraction logic ───────────────────────────────────────────────────────────

async function runExtraction(runId: string, agentType: string, currentTurn: number): Promise<void> {
  if (!isMemoryDbReady()) return;

  // Load recent turns from transcript JSONL
  let allTurns: TurnRecord[];
  try {
    allTurns = SessionTranscript.load(agentType, runId);
  } catch (err) {
    log().warn(`[session-watcher] Could not load transcript for ${agentType}/${runId}: ${String(err)}`);
    return;
  }

  if (!allTurns || allTurns.length === 0) return;

  // Take the last TURN_THRESHOLD turns
  const recentTurns = allTurns.slice(-TURN_THRESHOLD);

  // Build text content from turns: keep user prompts + assistant text, skip tool I/O
  const textContent = recentTurns
    .map((turn) => {
      const parts: string[] = [];

      // User messages — string content only
      for (const msg of turn.messages) {
        if (msg.role === "user" && typeof msg.content === "string") {
          parts.push(`User: ${msg.content}`);
        }
      }

      // Assistant text blocks from response
      for (const block of turn.response.content) {
        if (block.type === "text" && "text" in block && typeof block.text === "string") {
          parts.push(`Assistant: ${block.text}`);
        }
      }

      return parts.join("\n");
    })
    .filter(Boolean)
    .join("\n---\n");

  if (textContent.length < 100) return; // Too little content to be useful

  const truncated = textContent.slice(-MAX_CONTENT_CHARS);

  // Call extraction model
  const candidates = await extractFromTranscript(truncated, agentType);
  if (candidates.length === 0) return;

  // Feed through reconciler
  const reconcileRunId = `session-watcher-${runId}-${Date.now()}`;
  try {
    const result = await reconcile(candidates, reconcileRunId);
    log().info(
      `[session-watcher] ${agentType}/${runId} turn ${currentTurn}: ` +
        `${candidates.length} candidates → ${result.newMemories.length} new, ` +
        `${result.reinforcedMemories.length} reinforced`,
    );
  } catch (err) {
    log().warn(`[session-watcher] Reconciliation failed for ${runId}: ${String(err)}`);
  }
}

// ── LLM extraction ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You extract durable knowledge from AI agent session transcripts. Focus on:
- Learnings: debugging insights, API quirks, what worked/didn't, gotchas discovered
- Decisions: architectural choices, tool preferences, approach selections with reasoning
- Preferences: how the user wants things to work going forward
- Facts: concrete durable info — project structure, people, configurations

IGNORE: routine tool calls, file reads, mechanical code changes, session-specific implementation details.
KEY QUESTION: "Will a fresh agent session need this, and can it NOT get it from code/git/docs?"

Return a JSON array of objects:
[{ "type": "learning"|"decision"|"preference"|"fact", "title": "short title", "content": "what was learned/decided", "confidence": 0.0-1.0 }]

Return [] if nothing worth extracting. Be selective — only genuinely useful future knowledge.`;

async function extractFromTranscript(text: string, agentType: string): Promise<MemoryCandidate[]> {
  try {
    const config = parseModelString(EXTRACTION_MODEL);
    const client = createClient(config);

    const response = await client.createMessage({
      model: config.modelId,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Agent type: ${agentType}\n\nRecent conversation:\n${text}` }],
      tools: [],
      maxTokens: MAX_RESPONSE_TOKENS,
    });

    const responseText = (response.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    // Parse JSON — handle markdown code fences
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      type: string;
      title: string;
      content: string;
      confidence: number;
    }>;

    if (!Array.isArray(parsed)) return [];

    const validTypes = new Set(["learning", "decision", "preference", "fact", "pattern"]);
    return parsed
      .filter((item) => validTypes.has(item.type) && item.content && item.confidence > 0)
      .map((item) => ({
        title: item.title ?? "",
        content: item.content,
        memoryType: item.type as MemoryCandidate["memoryType"],
        confidence: Math.min(1.0, Math.max(0.0, item.confidence)),
        sourceAuthority: 0 as const, // reflection-extracted
        scope: "system" as const,
        evidenceEventIds: [],
      }));
  } catch (err) {
    log().warn(`[session-watcher] LLM extraction failed: ${String(err)}`);
    return [];
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

let registered = false;

export function registerSessionWatcher(): void {
  if (registered) return;
  const registry = getHookRegistry();
  registry.register("after_llm_call", handleAfterLlmCall, -10); // Low priority — run after other hooks
  registered = true;
  log().info("[session-watcher] Registered on after_llm_call hook");
}

export function unregisterSessionWatcher(): void {
  if (!registered) return;
  const registry = getHookRegistry();
  registry.unregister("after_llm_call", handleAfterLlmCall);
  registered = false;
  sessionStates.clear();
  log().info("[session-watcher] Unregistered");
}

/** Get stats for debugging/introspection */
export function getSessionWatcherStats(): Record<string, SessionState> {
  return Object.fromEntries(sessionStates);
}
