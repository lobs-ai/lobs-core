#!/usr/bin/env tsx
/**
 * paw-task — Create, list, update, and manage PAW tasks.
 *
 * Usage:
 *   paw-task create --title "Fix bug" --agent programmer --tier standard [--notes "..."] [--project ID] [--status active]
 *   paw-task list [--status active] [--agent programmer] [--limit 20]
 *   paw-task get <id>
 *   paw-task update <id> --status completed [--notes "..."]
 *   paw-task cancel <id>
 *   paw-task archive <id>
 */

import { getDb, closeDb } from "./db.js";
import { randomUUID } from "node:crypto";
import { inferProjectId } from "../util/project-inference.js";

const AGENTS = ["programmer", "writer", "researcher", "reviewer", "architect"];
const TIERS = ["micro", "small", "medium", "standard", "strong"];
const STATUSES = ["inbox", "active", "completed", "cancelled", "rejected", "archived", "waiting_on"];

function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string> } {
  const cmd = argv[0] ?? "help";
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      flags[key] = argv[++i] ?? "true";
    } else {
      pos.push(argv[i]);
    }
  }
  return { cmd, pos, flags };
}

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const db = getDb();

try {
  switch (args.cmd) {
    case "create": {
      const title = args.flags.title;
      if (!title) die("--title is required");
      const agent = args.flags.agent ?? "programmer";
      if (!AGENTS.includes(agent)) die(`Invalid agent: ${agent}. Must be one of: ${AGENTS.join(", ")}`);
      const tier = args.flags.tier ?? "standard";
      if (!TIERS.includes(tier)) die(`Invalid tier: ${tier}. Must be one of: ${TIERS.join(", ")}`);
      const status = args.flags.status ?? "active";
      if (!STATUSES.includes(status)) die(`Invalid status: ${status}`);
      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(`INSERT INTO tasks (id, title, status, agent, model_tier, notes, project_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, title, status, agent, tier,
        args.flags.notes ?? null,
        args.flags.project ?? inferProjectId(title, args.flags.notes) ?? null,
        now, now
      );
      console.log(JSON.stringify({ ok: true, id, title, agent, tier, status }));
      break;
    }

    case "list": {
      const limit = parseInt(args.flags.limit ?? "20");
      let query = "SELECT id, title, status, agent, model_tier, created_at, updated_at FROM tasks";
      const conditions: string[] = [];
      const params: string[] = [];

      if (args.flags.status) { conditions.push("status = ?"); params.push(args.flags.status); }
      if (args.flags.agent) { conditions.push("agent = ?"); params.push(args.flags.agent); }
      if (args.flags.project) { conditions.push("project_id = ?"); params.push(args.flags.project); }

      if (conditions.length) query += " WHERE " + conditions.join(" AND ");
      query += " ORDER BY updated_at DESC LIMIT ?";
      params.push(String(limit));

      const rows = db.prepare(query).all(...params);
      console.log(JSON.stringify(rows, null, 2));
      break;
    }

    case "get": {
      const id = args.pos[0];
      if (!id) die("Task ID required");
      const row = db.prepare("SELECT * FROM tasks WHERE id = ? OR id LIKE ?").get(id, `${id}%`);
      if (!row) die(`Task not found: ${id}`);
      console.log(JSON.stringify(row, null, 2));
      break;
    }

    case "update": {
      const id = args.pos[0];
      if (!id) die("Task ID required");
      const row = db.prepare("SELECT id FROM tasks WHERE id = ? OR id LIKE ?").get(id, `${id}%`) as any;
      if (!row) die(`Task not found: ${id}`);
      const sets: string[] = ["updated_at = ?"];
      const params: string[] = [new Date().toISOString()];
      for (const [key, col] of Object.entries({ status: "status", notes: "notes", agent: "agent", tier: "model_tier", project: "project_id", title: "title" })) {
        if (args.flags[key]) { sets.push(`${col} = ?`); params.push(args.flags[key]); }
      }
      params.push(row.id);
      db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      console.log(JSON.stringify({ ok: true, id: row.id }));
      break;
    }

    case "cancel": {
      const id = args.pos[0];
      if (!id) die("Task ID required");
      const row = db.prepare("SELECT id FROM tasks WHERE id = ? OR id LIKE ?").get(id, `${id}%`) as any;
      if (!row) die(`Task not found: ${id}`);
      db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
      console.log(JSON.stringify({ ok: true, id: row.id, status: "cancelled" }));
      break;
    }

    case "archive": {
      const id = args.pos[0];
      if (!id) die("Task ID required");
      const row = db.prepare("SELECT id FROM tasks WHERE id = ? OR id LIKE ?").get(id, `${id}%`) as any;
      if (!row) die(`Task not found: ${id}`);
      db.prepare("UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
      console.log(JSON.stringify({ ok: true, id: row.id, status: "archived" }));
      break;
    }

    default:
      console.log(`Usage: paw-task <create|list|get|update|cancel|archive> [options]

Commands:
  create  --title "..." --agent <type> --tier <tier> [--notes "..."] [--project ID]
  list    [--status active] [--agent programmer] [--limit 20]
  get     <id-or-prefix>
  update  <id> [--status ...] [--notes ...] [--agent ...] [--tier ...] [--title ...]
  cancel  <id>
  archive <id>

Agents: ${AGENTS.join(", ")}
Tiers:  ${TIERS.join(", ")}`);
  }
} finally {
  closeDb();
}
