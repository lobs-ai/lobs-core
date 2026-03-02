/**
 * before_tool_call hook — approval tier enforcement.
 *
 * Checks task approval tier before allowing tool execution:
 * - Tier A (auto): Bug fixes, docs, research, tests → allow all tools
 * - Tier B (lobs): Refactors, new utilities → allow, log for audit
 * - Tier C (rafe): UI, features, architecture → block destructive tools, create inbox item
 *
 * Dangerous tools: exec with rm/deploy/push, message send to external channels
 */

import { eq, and, isNull } from "drizzle-orm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { workerRuns, tasks, inboxItems } from "../db/schema.js";
import { randomUUID } from "node:crypto";
import { log } from "../util/logger.js";

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bgit\s+push\b/,
  /\bgit\s+merge\b/,
  /\bdeploy\b/,
  /\bkubectl\s+(apply|delete)\b/,
];

export function registerToolGateHook(api: OpenClawPluginApi): void {
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

    // Determine approval tier based on task/agent
    const tier = classifyApprovalTier(task.agent ?? "", task.notes ?? "");

    const toolName = (event as Record<string, unknown>).toolName as string;
    const toolInput = JSON.stringify((event as Record<string, unknown>).toolInput ?? {});

    // Tier A: auto-approve everything
    if (tier === "A") return;

    // Tier B: allow but log
    if (tier === "B") {
      if (isDangerous(toolName, toolInput)) {
        log().warn(`[PAW] Tier B tool gate: ${toolName} on task ${task.id.slice(0, 8)} — allowed with audit`);
      }
      return;
    }

    // Tier C: block dangerous tools
    if (tier === "C" && isDangerous(toolName, toolInput)) {
      log().warn(`[PAW] Tier C tool BLOCKED: ${toolName} on task ${task.id.slice(0, 8)}`);

      // Create inbox item for Rafe
      db.insert(inboxItems).values({
        id: randomUUID(),
        title: `Approval needed: ${toolName} on "${task.title}"`,
        content: `Task: ${task.title}\nTool: ${toolName}\nInput: ${toolInput.slice(0, 500)}`,
        isRead: false,
      }).run();

      return { block: true, blockReason: "Tier C: requires Rafe approval" };
    }

    return;
  });
}

function classifyApprovalTier(agent: string, notes: string): "A" | "B" | "C" {
  const lower = (agent + " " + notes).toLowerCase();

  // Tier A: bug fixes, docs, research, tests
  if (/bug.?fix|test|doc|research|investigation/i.test(lower)) return "A";

  // Tier C: UI, features, architecture
  if (/feature|ui|architecture|design|new\s+endpoint/i.test(lower)) return "C";

  // Tier B: everything else (refactors, utilities)
  return "B";
}

function isDangerous(toolName: string, toolInput: string): boolean {
  if (toolName === "exec" || toolName === "Bash") {
    return DANGEROUS_PATTERNS.some(p => p.test(toolInput));
  }
  if (toolName === "message" && /send/i.test(toolInput)) return true;
  return false;
}
