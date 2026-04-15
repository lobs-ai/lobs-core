#!/opt/homebrew/bin/tsx
/**
 * paw-status — Quick status overview of the PAW system.
 *
 * Usage:
 *   paw-status              Full overview
 *   paw-status agents       Agent status only
 *   paw-status workers      Recent worker runs
 *   paw-status tasks        Task counts by status
 */

import { getDb, closeDb } from "./db.js";

function parseArgs(argv: string[]): { cmd: string } {
  return { cmd: argv[0] ?? "all" };
}

const args = parseArgs(process.argv.slice(2));
const db = getDb();

try {
  if (args.cmd === "all" || args.cmd === "tasks") {
    const counts = db.prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status ORDER BY count DESC").all() as any[];
    console.log("\n📋 Tasks:");
    for (const r of counts) console.log(`  ${r.status}: ${r.count}`);
  }

  if (args.cmd === "all" || args.cmd === "agents") {
    const agents = db.prepare("SELECT agent_type, status, current_task_id FROM agent_status").all() as any[];
    console.log("\n🤖 Agents:");
    for (const a of agents) {
      const task = a.current_task_id ? ` → task ${a.current_task_id.slice(0, 8)}` : "";
      console.log(`  ${a.agent_type}: ${a.status || "idle"}${task}`);
    }
  }

  if (args.cmd === "all" || args.cmd === "workers") {
    const runs = db.prepare("SELECT id, agent_type, succeeded, model, started_at, ended_at, duration_seconds FROM worker_runs ORDER BY started_at DESC LIMIT 10").all() as any[];
    console.log("\n⚙️ Recent Workers:");
    for (const r of runs) {
      const status = r.succeeded === 1 ? "✓" : r.succeeded === 0 ? "✗" : "?";
      const dur = r.duration_seconds ? `${Math.round(r.duration_seconds)}s` : "running";
      console.log(`  ${status} #${r.id} ${r.agent_type} (${r.model ?? "?"}) ${dur}`);
    }
  }

  if (args.cmd === "all") {
    const inbox = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN requires_action = 1 AND action_status = 'pending' THEN 1 ELSE 0 END) as needs_action FROM inbox_items").get() as any;
    console.log(`\n📬 Inbox: ${inbox.needs_action ?? 0} needs action, ${inbox.total} total`);
  }

  console.log("");
} finally {
  closeDb();
}
