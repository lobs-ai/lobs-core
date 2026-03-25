/**
 * Training Data Harvester
 *
 * Extracts training examples from real usage data:
 * - main_agent_messages (Discord conversations)
 * - chat_messages (Nexus web conversations)
 * - Session transcripts (subagent runs)
 * - Sentinel task outputs (calendar, system)
 *
 * Runs on schedule via cron. Deduplicates by source_id.
 * All examples land in training_samples for human review.
 */

import { randomUUID } from "node:crypto";
import { sql, eq, desc, and, isNull, count } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { log } from "../util/logger.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const HOME = process.env.HOME ?? "";

// ── Types ──────────────────────────────────────────────────────────────

interface HarvestResult {
  source: string;
  extracted: number;
  skipped: number;
  errors: number;
}

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

interface TrainingSample {
  id: string;
  sourceType: string;       // discord_conversation | nexus_chat | agent_session | sentinel_task
  sourceId: string;          // dedup key — unique per source conversation/run
  taskType: string;          // triage | response_style | calendar_analysis | system_analysis | summarization | code_task
  conversation: ConversationTurn[];  // full ChatML-compatible conversation
  systemPrompt: string;
  qualityScore: number;      // 0.0–1.0 heuristic score
  qualityFlags: string[];    // reasons for score adjustments
  tokenCount: number;        // estimated total tokens
  metadata: Record<string, unknown>;
}

// ── Quality Scoring ────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  // Rough: 1 token ≈ 4 chars for English
  return Math.ceil(text.length / 4);
}

function scoreConversation(turns: ConversationTurn[]): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0.5; // baseline

  // Must have at least one user and one assistant turn
  const hasUser = turns.some(t => t.role === "user");
  const hasAssistant = turns.some(t => t.role === "assistant");
  if (!hasUser || !hasAssistant) {
    flags.push("missing_role");
    return { score: 0.0, flags };
  }

  // Multi-turn conversations are more valuable
  const turnCount = turns.length;
  if (turnCount >= 4) { score += 0.1; flags.push("multi_turn"); }
  if (turnCount >= 8) { score += 0.1; flags.push("deep_conversation"); }

  // Substantive assistant responses (not just "hey" or tool dumps)
  const assistantTurns = turns.filter(t => t.role === "assistant");
  const avgAssistantLength = assistantTurns.reduce((sum, t) => sum + t.content.length, 0) / assistantTurns.length;
  if (avgAssistantLength > 200) { score += 0.1; flags.push("substantive_responses"); }
  if (avgAssistantLength < 20) { score -= 0.2; flags.push("very_short_responses"); }

  // Penalize tool-heavy conversations (less useful for style training)
  const toolTurns = turns.filter(t => t.content.startsWith("[Tool"));
  if (toolTurns.length > turns.length * 0.5) {
    score -= 0.2;
    flags.push("tool_heavy");
  }

  // Penalize system/heartbeat messages
  const systemMessages = turns.filter(t =>
    t.content.includes("[System Event]") ||
    t.content.includes("HEARTBEAT") ||
    /\bNO_REPLY\b/.test(t.content)
  );
  if (systemMessages.length > 0) {
    score -= 0.1;
    flags.push("has_system_messages");
  }

  // Bonus for conversations that show real task completion
  const hasTaskSignals = turns.some(t =>
    t.content.includes("done") ||
    t.content.includes("fixed") ||
    t.content.includes("deployed") ||
    t.content.includes("committed")
  );
  if (hasTaskSignals) { score += 0.1; flags.push("task_completion"); }

  return { score: Math.max(0, Math.min(1, score)), flags };
}

// ── Conversation Extraction ────────────────────────────────────────────

/**
 * Group main_agent_messages into conversations by time gaps.
 * A gap > 30 minutes = new conversation.
 */
function groupIntoConversations(
  messages: Array<{ role: string; content: string; created_at: string; channel_id: string | null }>
): ConversationTurn[][] {
  const conversations: ConversationTurn[][] = [];
  let current: ConversationTurn[] = [];
  let lastTime: Date | null = null;
  let lastChannel: string | null = null;

  const GAP_MS = 30 * 60 * 1000; // 30 minutes

  for (const msg of messages) {
    const time = new Date(msg.created_at + "Z");
    const channel = msg.channel_id;

    // New conversation if: time gap > 30min OR channel changed
    if (lastTime && (time.getTime() - lastTime.getTime() > GAP_MS || channel !== lastChannel)) {
      if (current.length >= 2) conversations.push(current);
      current = [];
    }

    current.push({
      role: msg.role as "user" | "assistant",
      content: msg.content,
      timestamp: msg.created_at,
    });
    lastTime = time;
    lastChannel = channel;
  }
  if (current.length >= 2) conversations.push(current);

  return conversations;
}

// ── Source Harvesters ──────────────────────────────────────────────────

/**
 * Harvest Discord/main agent conversations.
 * Creates training samples for response_style and triage tasks.
 */
async function harvestMainAgentMessages(db: ReturnType<typeof getDb>): Promise<HarvestResult> {
  const result: HarvestResult = { source: "main_agent_messages", extracted: 0, skipped: 0, errors: 0 };

  try {
    // Get all messages ordered by time
    const messages = db.all(sql`
      SELECT role, content, created_at, channel_id
      FROM main_agent_messages
      ORDER BY created_at ASC
    `) as Array<{ role: string; content: string; created_at: string; channel_id: string | null }>;

    const conversations = groupIntoConversations(messages);

    for (const convo of conversations) {
      // Filter out tool-call-only turns for response_style training
      const cleanTurns = convo.filter(t =>
        !t.content.startsWith("[Tool calls]") &&
        !t.content.startsWith("[Tool results]") &&
        !/\bNO_REPLY\b/.test(t.content) &&
        !t.content.includes("[System Event]") &&
        t.content.trim().length > 0
      );

      if (cleanTurns.length < 2) { result.skipped++; continue; }

      // Create a stable source ID from first message timestamp
      const sourceId = `discord:${cleanTurns[0].timestamp}`;

      // Check if already harvested
      const existing = db.get(sql`
        SELECT id FROM training_samples WHERE source_id = ${sourceId}
      `);
      if (existing) { result.skipped++; continue; }

      const { score, flags } = scoreConversation(cleanTurns);
      const totalTokens = cleanTurns.reduce((sum, t) => sum + estimateTokens(t.content), 0);

      // Skip extremely low quality
      if (score < 0.2) { result.skipped++; continue; }

      // Skip if too long for training (> 8k tokens is unwieldy for 9B model)
      if (totalTokens > 8000) {
        // Truncate to last N turns that fit
        const truncated = truncateConversation(cleanTurns, 6000);
        if (truncated.length < 2) { result.skipped++; continue; }
        insertSample(db, {
          id: randomUUID(),
          sourceType: "discord_conversation",
          sourceId,
          taskType: "response_style",
          conversation: truncated,
          systemPrompt: RESPONSE_STYLE_SYSTEM,
          qualityScore: score - 0.1, // slight penalty for truncation
          qualityFlags: [...flags, "truncated"],
          tokenCount: truncated.reduce((sum, t) => sum + estimateTokens(t.content), 0),
          metadata: { originalTurns: cleanTurns.length, truncatedTurns: truncated.length },
        });
      } else {
        insertSample(db, {
          id: randomUUID(),
          sourceType: "discord_conversation",
          sourceId,
          taskType: "response_style",
          conversation: cleanTurns,
          systemPrompt: RESPONSE_STYLE_SYSTEM,
          qualityScore: score,
          qualityFlags: flags,
          tokenCount: totalTokens,
          metadata: { turns: cleanTurns.length },
        });
      }
      result.extracted++;
    }
  } catch (err) {
    log().error(`[harvester] Error harvesting main_agent_messages: ${err}`);
    result.errors++;
  }

  return result;
}

/**
 * Harvest Nexus chat conversations.
 */
async function harvestChatMessages(db: ReturnType<typeof getDb>): Promise<HarvestResult> {
  const result: HarvestResult = { source: "chat_messages", extracted: 0, skipped: 0, errors: 0 };

  try {
    // Get all sessions
    const sessions = db.all(sql`
      SELECT DISTINCT session_key FROM chat_messages
    `) as Array<{ session_key: string }>;

    for (const { session_key } of sessions) {
      const sourceId = `nexus:${session_key}`;

      const existing = db.get(sql`
        SELECT id FROM training_samples WHERE source_id = ${sourceId}
      `);
      if (existing) { result.skipped++; continue; }

      const messages = db.all(sql`
        SELECT role, content, created_at
        FROM chat_messages
        WHERE session_key = ${session_key}
        ORDER BY created_at ASC
      `) as Array<{ role: string; content: string; created_at: string }>;

      // Filter to clean turns
      const cleanTurns: ConversationTurn[] = messages
        .filter(m =>
          (m.role === "user" || m.role === "assistant") &&
          !m.content.startsWith("[Tool") &&
          m.content.trim().length > 0
        )
        .map(m => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: m.created_at,
        }));

      if (cleanTurns.length < 2) { result.skipped++; continue; }

      const { score, flags } = scoreConversation(cleanTurns);
      if (score < 0.2) { result.skipped++; continue; }

      const totalTokens = cleanTurns.reduce((sum, t) => sum + estimateTokens(t.content), 0);
      const finalTurns = totalTokens > 8000 ? truncateConversation(cleanTurns, 6000) : cleanTurns;
      if (finalTurns.length < 2) { result.skipped++; continue; }

      insertSample(db, {
        id: randomUUID(),
        sourceType: "nexus_chat",
        sourceId,
        taskType: "response_style",
        conversation: finalTurns,
        systemPrompt: RESPONSE_STYLE_SYSTEM,
        qualityScore: score,
        qualityFlags: flags,
        tokenCount: finalTurns.reduce((sum, t) => sum + estimateTokens(t.content), 0),
        metadata: { session: session_key, turns: finalTurns.length },
      });
      result.extracted++;
    }
  } catch (err) {
    log().error(`[harvester] Error harvesting chat_messages: ${err}`);
    result.errors++;
  }

  return result;
}

/**
 * Harvest session transcripts from subagent runs.
 * These become code_task training samples — task prompt → execution trace.
 */
async function harvestSessionTranscripts(db: ReturnType<typeof getDb>): Promise<HarvestResult> {
  const result: HarvestResult = { source: "session_transcripts", extracted: 0, skipped: 0, errors: 0 };

  const agentDirs = ["programmer", "architect", "reviewer", "researcher", "writer"];

  for (const agentType of agentDirs) {
    const sessionsDir = resolve(HOME, `.lobs/agents/${agentType}/sessions`);
    if (!existsSync(sessionsDir)) continue;

    const files = readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));

    for (const file of files) {
      const sourceId = `session:${agentType}:${file}`;

      const existing = db.get(sql`
        SELECT id FROM training_samples WHERE source_id = ${sourceId}
      `);
      if (existing) { result.skipped++; continue; }

      try {
        const content = readFileSync(join(sessionsDir, file), "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        if (lines.length < 2) { result.skipped++; continue; }

        // Parse JSONL — each line is a turn
        const turns: ConversationTurn[] = [];
        let taskPrompt = "";

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            // First turn usually has the task in messages[0]
            if (entry.turn === 1 && entry.messages?.length > 0) {
              taskPrompt = entry.messages[0]?.content ?? "";
            }
            // Extract the assistant response
            if (entry.response) {
              turns.push({ role: "assistant", content: entry.response, timestamp: entry.timestamp });
            }
            // Extract user messages (tool results, etc.)
            if (entry.messages) {
              for (const msg of entry.messages) {
                if (msg.role === "user" || msg.role === "assistant") {
                  turns.push({ role: msg.role, content: msg.content ?? "", timestamp: entry.timestamp });
                }
              }
            }
          } catch { /* skip malformed lines */ }
        }

        if (turns.length < 2 || !taskPrompt) { result.skipped++; continue; }

        // For session transcripts, we create a condensed version:
        // task prompt + final output (not the full tool-call chain)
        const condensed = condenseSessionToTraining(taskPrompt, turns, agentType);
        if (!condensed) { result.skipped++; continue; }

        const { score, flags } = scoreConversation(condensed.turns);

        insertSample(db, {
          id: randomUUID(),
          sourceType: "agent_session",
          sourceId,
          taskType: `${agentType}_task`,
          conversation: condensed.turns,
          systemPrompt: condensed.systemPrompt,
          qualityScore: Math.max(score, 0.4), // agent sessions have baseline value
          qualityFlags: [...flags, `agent:${agentType}`],
          tokenCount: condensed.turns.reduce((sum, t) => sum + estimateTokens(t.content), 0),
          metadata: {
            agentType,
            sessionFile: file,
            originalTurns: turns.length,
            condensedTurns: condensed.turns.length,
          },
        });
        result.extracted++;
      } catch (err) {
        log().error(`[harvester] Error processing session ${file}: ${err}`);
        result.errors++;
      }
    }
  }

  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────

function truncateConversation(turns: ConversationTurn[], maxTokens: number): ConversationTurn[] {
  // Keep from the end, working backwards
  const result: ConversationTurn[] = [];
  let tokens = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = estimateTokens(turns[i].content);
    if (tokens + t > maxTokens) break;
    result.unshift(turns[i]);
    tokens += t;
  }
  return result;
}

function condenseSessionToTraining(
  taskPrompt: string,
  turns: ConversationTurn[],
  agentType: string
): { turns: ConversationTurn[]; systemPrompt: string } | null {
  // Extract just the task and final substantive responses
  // Skip tool call/result noise
  const substantive = turns.filter(t =>
    !t.content.startsWith("[Tool") &&
    t.content.trim().length > 50 &&
    t.role === "assistant"
  );

  if (substantive.length === 0) return null;

  // Take the last substantive assistant response as the "answer"
  const finalResponse = substantive[substantive.length - 1];

  return {
    systemPrompt: AGENT_TASK_SYSTEM(agentType),
    turns: [
      { role: "user", content: taskPrompt },
      { role: "assistant", content: finalResponse.content },
    ],
  };
}

function insertSample(db: ReturnType<typeof getDb>, sample: TrainingSample): void {
  db.run(sql`
    INSERT INTO training_samples (
      id, source_type, source_id, task_type, conversation, system_prompt,
      quality_score, quality_flags, token_count, review_status, metadata,
      created_at, updated_at
    ) VALUES (
      ${sample.id},
      ${sample.sourceType},
      ${sample.sourceId},
      ${sample.taskType},
      ${JSON.stringify(sample.conversation)},
      ${sample.systemPrompt},
      ${sample.qualityScore},
      ${JSON.stringify(sample.qualityFlags)},
      ${sample.tokenCount},
      'pending',
      ${JSON.stringify(sample.metadata)},
      datetime('now'),
      datetime('now')
    )
  `);
}

// ── System Prompts for Training ────────────────────────────────────────

const RESPONSE_STYLE_SYSTEM = `You are Lobs, a personal AI agent for Rafe. You are direct, concise, and slightly dry. You have opinions and act on them. You match the energy of the conversation — short messages get short replies. You never use filler phrases like "Great question!" or "I'd be happy to help!" You just help. You're a competent friend who happens to be very good at their job.`;

const AGENT_TASK_SYSTEM = (agentType: string) =>
  `You are a ${agentType} agent in the Lobs system. You receive tasks and execute them competently. You write clean code, follow existing patterns, and deliver complete solutions. Be thorough but concise in your explanations.`;

const TRIAGE_SYSTEM = `You are a message triage classifier. Given a user message, classify it:
- agent_type: which agent should handle this (programmer/researcher/writer/reviewer/architect/main)
- priority: low/medium/high/urgent
- message_type: question/task/chat/system
- summary: one-line summary of what's being asked

Respond as JSON.`;

// ── Main Harvest Function ──────────────────────────────────────────────

export async function runHarvest(): Promise<HarvestResult[]> {
  log().info("[harvester] Starting training data harvest...");
  const db = getDb();

  // Ensure training_samples table exists
  ensureTrainingSamplesTable(db);

  const results = await Promise.all([
    harvestMainAgentMessages(db),
    harvestChatMessages(db),
    harvestSessionTranscripts(db),
  ]);

  const total = results.reduce((sum, r) => sum + r.extracted, 0);
  const skipped = results.reduce((sum, r) => sum + r.skipped, 0);
  log().info(`[harvester] Harvest complete: ${total} new samples, ${skipped} skipped`);

  return results;
}

/**
 * Get harvest statistics.
 */
export function getHarvestStats(): {
  total: number;
  bySource: Record<string, number>;
  byTaskType: Record<string, number>;
  byStatus: Record<string, number>;
  avgQuality: number;
} {
  const db = getDb();
  ensureTrainingSamplesTable(db);

  const total = (db.get(sql`SELECT count(*) as c FROM training_samples`) as any)?.c ?? 0;

  const bySource: Record<string, number> = {};
  const sourceRows = db.all(sql`SELECT source_type, count(*) as c FROM training_samples GROUP BY source_type`) as any[];
  for (const r of sourceRows) bySource[r.source_type] = r.c;

  const byTaskType: Record<string, number> = {};
  const taskRows = db.all(sql`SELECT task_type, count(*) as c FROM training_samples GROUP BY task_type`) as any[];
  for (const r of taskRows) byTaskType[r.task_type] = r.c;

  const byStatus: Record<string, number> = {};
  const statusRows = db.all(sql`SELECT review_status, count(*) as c FROM training_samples GROUP BY review_status`) as any[];
  for (const r of statusRows) byStatus[r.review_status] = r.c;

  const avgQ = (db.get(sql`SELECT avg(quality_score) as avg FROM training_samples`) as any)?.avg ?? 0;

  return { total, bySource, byTaskType, byStatus, avgQuality: Math.round(avgQ * 100) / 100 };
}

/**
 * Export approved samples as JSONL for fine-tuning.
 * Format: ChatML conversations compatible with Unsloth/Axolotl.
 */
export function exportTrainingJSONL(opts?: {
  taskType?: string;
  minQuality?: number;
  includeCorrections?: boolean;
}): string {
  const db = getDb();
  const minQ = opts?.minQuality ?? 0.3;

  let rows: any[];
  if (opts?.taskType) {
    rows = db.all(sql`
      SELECT * FROM training_samples
      WHERE review_status IN ('approved', 'corrected')
        AND quality_score >= ${minQ}
        AND task_type = ${opts.taskType}
      ORDER BY quality_score DESC
    `);
  } else {
    rows = db.all(sql`
      SELECT * FROM training_samples
      WHERE review_status IN ('approved', 'corrected')
        AND quality_score >= ${minQ}
      ORDER BY quality_score DESC
    `);
  }

  const lines: string[] = [];
  for (const row of rows) {
    const conversation = JSON.parse(row.conversation);
    const correctedConvo = row.corrected_conversation ? JSON.parse(row.corrected_conversation) : null;
    const finalConvo = correctedConvo ?? conversation;

    // ChatML format for Unsloth
    const messages = [
      { role: "system", content: row.system_prompt },
      ...finalConvo.map((t: ConversationTurn) => ({
        role: t.role,
        content: t.content,
      })),
    ];

    lines.push(JSON.stringify({ conversations: messages }));
  }

  return lines.join("\n");
}

/**
 * Get samples for review in the Nexus UI.
 */
export function getSamplesForReview(opts?: {
  status?: string;
  taskType?: string;
  limit?: number;
  offset?: number;
}): any[] {
  const db = getDb();
  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;
  const status = opts?.status ?? "pending";

  if (opts?.taskType) {
    return db.all(sql`
      SELECT * FROM training_samples
      WHERE review_status = ${status} AND task_type = ${opts.taskType}
      ORDER BY quality_score DESC, created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as any[];
  }

  return db.all(sql`
    SELECT * FROM training_samples
    WHERE review_status = ${status}
    ORDER BY quality_score DESC, created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `) as any[];
}

/**
 * Approve, reject, or correct a sample.
 */
export function reviewSample(
  id: string,
  action: "approve" | "reject" | "correct",
  correctedConversation?: ConversationTurn[]
): void {
  const db = getDb();
  if (action === "correct" && correctedConversation) {
    db.run(sql`
      UPDATE training_samples
      SET review_status = 'corrected',
          corrected_conversation = ${JSON.stringify(correctedConversation)},
          updated_at = datetime('now')
      WHERE id = ${id}
    `);
  } else {
    const status = action === "approve" ? "approved" : "rejected";
    db.run(sql`
      UPDATE training_samples
      SET review_status = ${status}, updated_at = datetime('now')
      WHERE id = ${id}
    `);
  }
}

/**
 * Bulk approve all samples above a quality threshold.
 */
export function bulkApprove(minQuality: number = 0.6): number {
  const db = getDb();
  const result = db.run(sql`
    UPDATE training_samples
    SET review_status = 'approved', updated_at = datetime('now')
    WHERE review_status = 'pending' AND quality_score >= ${minQuality}
  `);
  return (result as any).changes ?? 0;
}

// ── Schema ─────────────────────────────────────────────────────────────

function ensureTrainingSamplesTable(db: ReturnType<typeof getDb>): void {
  db.run(sql`CREATE TABLE IF NOT EXISTS training_samples (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL UNIQUE,
    task_type TEXT NOT NULL,
    conversation TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    corrected_conversation TEXT,
    quality_score REAL NOT NULL DEFAULT 0.5,
    quality_flags TEXT,
    token_count INTEGER NOT NULL DEFAULT 0,
    review_status TEXT NOT NULL DEFAULT 'pending',
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_ts_source_id ON training_samples(source_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_ts_task_type ON training_samples(task_type)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_ts_review_status ON training_samples(review_status)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_ts_quality ON training_samples(quality_score)`);
}
