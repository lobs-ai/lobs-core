/**
 * before_tool_call hook — approval tier enforcement + hard blocks.
 *
 * Hard blocks (ALL tiers, always blocked):
 * - Workers mutating the PAW DB (UPDATE/INSERT/DELETE on tasks, worker_runs, agent_status)
 * - Workers editing lobs config files
 * - Workers running gateway restart/config commands
 *
 * Tier-based (soft) enforcement:
 * - Tier A (auto): Bug fixes, docs, research, tests → allow remaining tools
 * - Tier B (lobs): Refactors, new utilities → allow, log for audit
 * - Tier C (rafe): UI, features, architecture → block destructive tools, create inbox item
 *
 * Dangerous tools: exec with rm/deploy/push, message send to external channels
 */

import { eq, and, isNull } from "drizzle-orm";
import type { LobsPluginApi } from "../types/lobs-plugin.js";
import { getDb, getRawDb } from "../db/connection.js";
import { workerRuns, tasks, inboxItems } from "../db/schema.js";
import { randomUUID } from "node:crypto";
import { log } from "../util/logger.js";
import { classifyApprovalTier } from "../util/approval-tier.js";

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bgit\s+push\b/,
  /\bgit\s+merge\b/,
  /\bdeploy\b/,
  /\bkubectl\s+(apply|delete)\b/,
];

/**
 * Hard-blocked patterns for ALL workers regardless of tier.
 * These protect orchestrator state from being mutated by workers.
 */
const HARD_BLOCK_EXEC_PATTERNS = [
  // Block sqlite3 mutations against the PAW DB
  /sqlite3\s+.*paw\.db\s+.*\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b/i,
  /sqlite3\s+.*paw\.db\s+["'].*\b(UPDATE|INSERT|DELETE|ALTER|DROP)\b/i,
  // Block editing lobs config files
  /\blobs\.json\b/,
  /\blobs\.ya?ml\b/,
  // Block gateway commands
  /\blobs\s+gateway\b/i,
];

/**
 * Hard-blocked tool names that workers must never call.
 */
const HARD_BLOCK_TOOLS = new Set(["gateway"]);

/**
 * Hard-blocked file path patterns for write/edit tools.
 */
const HARD_BLOCK_FILE_PATTERNS = [
  /lobs\.json$/,
  /lobs\.ya?ml$/,
  /paw\.db$/,
];

export function registerToolGateHook(api: LobsPluginApi): void {
  api.on("before_tool_call", async (event, ctx) => {
    const sessionKey = (ctx as Record<string, unknown>).sessionKey as string | undefined;
    if (!sessionKey) return;

    // Check if this session is a PAW-managed worker
    const db = getDb();
    const run = db.select().from(workerRuns)
      .where(and(
        eq(workerRuns.workerId, sessionKey),
        isNull(workerRuns.endedAt),
      ))
      .get();

    if (!run || !run.taskId) return;

    const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
    if (!task) return;

    // ── Stall watchdog: update last_tool_call_at ─────────────────────
    // Track the most recent tool call so the control loop can detect stalls.
    try {
      getRawDb().prepare(
        `UPDATE worker_runs SET last_tool_call_at = ? WHERE id = ? AND ended_at IS NULL`
      ).run(new Date().toISOString(), run.id);
    } catch {}

    const toolName = (event as Record<string, unknown>).toolName as string;
    const toolInput = (event as Record<string, unknown>).toolInput as Record<string, unknown> ?? {};
    const toolInputStr = JSON.stringify(toolInput);

    // ── Hard blocks (all tiers) ──────────────────────────────────────

    // Block specific tool names entirely
    if (HARD_BLOCK_TOOLS.has(toolName)) {
      log().warn(`[PAW] HARD BLOCK: tool "${toolName}" denied for worker on task ${task.id.slice(0, 8)}`);
      return { block: true, blockReason: `Workers cannot use the "${toolName}" tool. Only the orchestrator or Lobs can do this.` };
    }

    // Block exec commands that mutate orchestrator state
    if (toolName === "exec" || toolName === "Bash") {
      const command = (toolInput.command as string) ?? toolInputStr;
      for (const pattern of HARD_BLOCK_EXEC_PATTERNS) {
        if (pattern.test(command)) {
          log().warn(`[PAW] HARD BLOCK: exec pattern "${pattern}" matched for worker on task ${task.id.slice(0, 8)}: ${command.slice(0, 200)}`);
          return { block: true, blockReason: "Workers cannot modify lobs.json, lobs.db, or gateway config. Only the orchestrator or Lobs can do this." };
        }
      }
    }

    // Block write/edit to protected files
    if (toolName === "Write" || toolName === "Edit" || toolName === "write" || toolName === "edit") {
      const filePath = (toolInput.file_path as string) ?? (toolInput.path as string) ?? "";
      for (const pattern of HARD_BLOCK_FILE_PATTERNS) {
        if (pattern.test(filePath)) {
          log().warn(`[PAW] HARD BLOCK: file write to "${filePath}" denied for worker on task ${task.id.slice(0, 8)}`);
          return { block: true, blockReason: `Workers cannot modify "${filePath}". Only the orchestrator or Lobs can do this.` };
        }
      }
    }

    // ── Tier-based enforcement ───────────────────────────────────────

    const tier = classifyApprovalTier(task.agent ?? "", task.notes ?? "");

    // Tier A: auto-approve everything (hard blocks already handled above)
    if (tier === "A") return;

    // Tier B: allow but log
    if (tier === "B") {
      if (isDangerous(toolName, toolInputStr)) {
        log().warn(`[PAW] Tier B tool gate: ${toolName} on task ${task.id.slice(0, 8)} — allowed with audit`);
      }
      return;
    }

    // Tier C: block dangerous tools
    if (tier === "C" && isDangerous(toolName, toolInputStr)) {
      log().warn(`[PAW] Tier C tool BLOCKED: ${toolName} on task ${task.id.slice(0, 8)}`);

      // Create inbox item for Rafe
      db.insert(inboxItems).values({
        id: randomUUID(),
        title: `Approval needed: ${toolName} on "${task.title}"`,
        content: `Task: ${task.title}\nTool: ${toolName}\nInput: ${toolInputStr.slice(0, 500)}`,
        isRead: false,
      }).run();

      return { block: true, blockReason: "Tier C: requires Rafe approval" };
    }

    return;
  });
}

function isDangerous(toolName: string, toolInput: string): boolean {
  if (toolName === "exec" || toolName === "Bash") {
    return DANGEROUS_PATTERNS.some(p => p.test(toolInput));
  }
  if (toolName === "message" && /send/i.test(toolInput)) return true;
  return false;
}
