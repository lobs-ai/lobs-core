#!/usr/bin/env tsx
/**
 * paw-inbox — Create, list, and manage PAW inbox items.
 *
 * Usage:
 *   paw-inbox create --title "..." --content "..." [--summary "..."] [--type suggestion] [--action] [--agent writer]
 *   paw-inbox list [--action-only] [--unread-only] [--limit 20]
 *   paw-inbox get <id>
 *   paw-inbox approve <id>
 *   paw-inbox reject <id>
 *   paw-inbox read <id>
 *   paw-inbox delete <id>
 */

import { getDb, closeDb } from "./db.js";
import { randomUUID } from "node:crypto";

const TYPES = ["notice", "suggestion", "approval", "report"];

function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string> } {
  const cmd = argv[0] ?? "help";
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--action") { flags.action = "true"; continue; }
    if (argv[i] === "--action-only") { flags["action-only"] = "true"; continue; }
    if (argv[i] === "--unread-only") { flags["unread-only"] = "true"; continue; }
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
      const type = args.flags.type ?? "suggestion";
      if (!TYPES.includes(type)) die(`Invalid type: ${type}. Must be one of: ${TYPES.join(", ")}`);
      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(`INSERT INTO inbox_items (id, title, content, summary, is_read, modified_at, type, requires_action, action_status, source_agent)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'pending', ?)`).run(
        id, title,
        args.flags.content ?? null,
        args.flags.summary ?? null,
        now, type,
        args.flags.action ? 1 : 0,
        args.flags.agent ?? null
      );
      console.log(JSON.stringify({ ok: true, id, title, type, requiresAction: !!args.flags.action }));
      break;
    }

    case "list": {
      let query = "SELECT id, title, type, requires_action, action_status, is_read, source_agent, modified_at FROM inbox_items";
      const conditions: string[] = [];
      if (args.flags["action-only"]) conditions.push("requires_action = 1 AND action_status = 'pending'");
      if (args.flags["unread-only"]) conditions.push("is_read = 0");
      if (conditions.length) query += " WHERE " + conditions.join(" AND ");
      query += " ORDER BY modified_at DESC LIMIT " + (args.flags.limit ?? "20");
      const rows = db.prepare(query).all();
      console.log(JSON.stringify(rows, null, 2));
      break;
    }

    case "get": {
      const id = args.pos[0];
      if (!id) die("Item ID required");
      const row = db.prepare("SELECT * FROM inbox_items WHERE id = ? OR id LIKE ?").get(id, `${id}%`);
      if (!row) die(`Item not found: ${id}`);
      console.log(JSON.stringify(row, null, 2));
      break;
    }

    case "approve": {
      const id = args.pos[0];
      if (!id) die("Item ID required");
      const row = db.prepare("SELECT id FROM inbox_items WHERE id = ? OR id LIKE ?").get(id, `${id}%`) as any;
      if (!row) die(`Item not found: ${id}`);
      db.prepare("UPDATE inbox_items SET action_status = 'approved', is_read = 1 WHERE id = ?").run(row.id);
      console.log(JSON.stringify({ ok: true, id: row.id, action_status: "approved" }));
      break;
    }

    case "reject": {
      const id = args.pos[0];
      if (!id) die("Item ID required");
      const row = db.prepare("SELECT id FROM inbox_items WHERE id = ? OR id LIKE ?").get(id, `${id}%`) as any;
      if (!row) die(`Item not found: ${id}`);
      db.prepare("UPDATE inbox_items SET action_status = 'rejected', is_read = 1 WHERE id = ?").run(row.id);
      console.log(JSON.stringify({ ok: true, id: row.id, action_status: "rejected" }));
      break;
    }

    case "read": {
      const id = args.pos[0];
      if (!id) die("Item ID required");
      const row = db.prepare("SELECT id FROM inbox_items WHERE id = ? OR id LIKE ?").get(id, `${id}%`) as any;
      if (!row) die(`Item not found: ${id}`);
      db.prepare("UPDATE inbox_items SET is_read = 1 WHERE id = ?").run(row.id);
      console.log(JSON.stringify({ ok: true, id: row.id }));
      break;
    }

    case "update": {
      const id = args.pos[0];
      if (!id) die("Item ID required");
      const row = db.prepare("SELECT id FROM inbox_items WHERE id = ? OR id LIKE ?").get(id, `${id}%`) as any;
      if (!row) die(`Item not found: ${id}`);
      const sets: string[] = [];
      const params: string[] = [];
      if (args.flags["action-status"]) { sets.push("action_status = ?"); params.push(args.flags["action-status"]); }
      if (args.flags.type) { sets.push("type = ?"); params.push(args.flags.type); }
      if (args.flags.title) { sets.push("title = ?"); params.push(args.flags.title); }
      if (sets.length === 0) die("Nothing to update. Use --action-status, --type, or --title");
      params.push(row.id);
      db.prepare(`UPDATE inbox_items SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      console.log(JSON.stringify({ ok: true, id: row.id }));
      break;
    }

    case "delete": {
      const id = args.pos[0];
      if (!id) die("Item ID required");
      const row = db.prepare("SELECT id FROM inbox_items WHERE id = ? OR id LIKE ?").get(id, `${id}%`) as any;
      if (!row) die(`Item not found: ${id}`);
      db.prepare("DELETE FROM inbox_items WHERE id = ?").run(row.id);
      console.log(JSON.stringify({ ok: true, id: row.id, deleted: true }));
      break;
    }

    default:
      console.log(`Usage: paw-inbox <create|list|get|approve|reject|read|delete> [options]

Commands:
  create   --title "..." [--content "..."] [--summary "..."] [--type suggestion] [--action] [--agent writer]
  list     [--action-only] [--unread-only] [--limit 20]
  get      <id-or-prefix>
  approve  <id>
  reject   <id>
  read     <id>
  delete   <id>

Types: ${TYPES.join(", ")}
--action flag marks item as requiring user action`);
  }
} finally {
  closeDb();
}
