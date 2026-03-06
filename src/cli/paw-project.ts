#!/usr/bin/env tsx
/**
 * paw-project — Create, list, manage, sync, and archive PAW projects.
 *
 * Usage:
 *   paw-project list [--archived]
 *   paw-project get <id>
 *   paw-project create --title "..." --type kanban [--notes "..."] [--repo-path "..."] [--github-repo "owner/repo"]
 *   paw-project update <id> [--title "..."] [--notes "..."] [--repo-path "..."] [--github-repo "..."]
 *   paw-project add-task <project-id> --title "..." [--agent programmer] [--tier standard] [--notes "..."]
 *   paw-project tasks <id> [--status active] [--limit 30]
 *   paw-project publish <id>
 *   paw-project archive <id>
 *   paw-project unarchive <id>
 *   paw-project sync <id>
 */

import { getDb, closeDb } from "./db.js";
import { randomUUID } from "node:crypto";

const TYPES = ["kanban", "research", "tracker", "project"];
const AGENTS = ["programmer", "writer", "researcher", "reviewer", "architect"];
const TIERS = ["micro", "small", "medium", "standard", "strong"];

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

function resolveProject(db: any, idOrTitle: string) {
  // Try exact id, prefix match, then title substring
  const row =
    db.prepare("SELECT * FROM projects WHERE id = ?").get(idOrTitle) ??
    db.prepare("SELECT * FROM projects WHERE id LIKE ?").get(`${idOrTitle}%`) ??
    db.prepare("SELECT * FROM projects WHERE lower(title) LIKE ?").get(`%${idOrTitle.toLowerCase()}%`);
  return row;
}

function renderProject(p: any): string {
  const lines: string[] = [
    `Project: ${p.title} (${p.id})`,
    `  Type:     ${p.type}`,
    `  Archived: ${p.archived ? "yes" : "no"}`,
  ];
  if (p.repo_path) lines.push(`  Repo:     ${p.repo_path}`);
  if (p.github_repo) lines.push(`  GitHub:   ${p.github_repo}`);
  if (p.tracking) lines.push(`  Tracking: ${p.tracking}`);
  if (p.notes) lines.push(`  Notes:    ${p.notes}`);
  lines.push(`  Created:  ${p.created_at}`);
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
const db = getDb();

try {
  switch (args.cmd) {
    case "list": {
      const showArchived = args.flags.archived === "true" || args.flags.archived === "";
      const rows = db
        .prepare(
          showArchived
            ? "SELECT * FROM projects ORDER BY sort_order, title"
            : "SELECT * FROM projects WHERE archived = 0 ORDER BY sort_order, title"
        )
        .all();
      console.log(JSON.stringify(rows, null, 2));
      break;
    }

    case "get": {
      const id = args.pos[0];
      if (!id) die("Project ID or title required");
      const row = resolveProject(db, id);
      if (!row) die(`Project not found: ${id}`);
      console.log(JSON.stringify(row, null, 2));
      break;
    }

    case "create": {
      const title = args.flags.title;
      if (!title) die("--title is required");
      const type = args.flags.type ?? "kanban";
      if (!TYPES.includes(type)) die(`Invalid type: ${type}. Must be one of: ${TYPES.join(", ")}`);
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO projects (id, title, type, notes, repo_path, github_repo, tracking, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(
        id,
        title,
        type,
        args.flags.notes ?? null,
        args.flags["repo-path"] ?? null,
        args.flags["github-repo"] ?? null,
        args.flags["github-repo"] ? "github" : (args.flags["repo-path"] ? "local" : null),
        now,
        now
      );
      console.log(JSON.stringify({ ok: true, id, title, type }));
      break;
    }

    case "update": {
      const id = args.pos[0];
      if (!id) die("Project ID required");
      const row = resolveProject(db, id) as any;
      if (!row) die(`Project not found: ${id}`);
      const sets: string[] = ["updated_at = ?"];
      const params: (string | null)[] = [new Date().toISOString()];
      const fieldMap: Record<string, string> = {
        title: "title",
        notes: "notes",
        type: "type",
        "repo-path": "repo_path",
        "github-repo": "github_repo",
        tracking: "tracking",
      };
      for (const [flag, col] of Object.entries(fieldMap)) {
        if (args.flags[flag] !== undefined) {
          sets.push(`${col} = ?`);
          params.push(args.flags[flag]);
        }
      }
      params.push(row.id);
      db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      console.log(JSON.stringify({ ok: true, id: row.id }));
      break;
    }

    case "add-task": {
      const projectId = args.pos[0];
      if (!projectId) die("Project ID required as first argument");
      const project = resolveProject(db, projectId) as any;
      if (!project) die(`Project not found: ${projectId}`);

      const title = args.flags.title;
      if (!title) die("--title is required");
      const agent = args.flags.agent ?? "programmer";
      if (!AGENTS.includes(agent)) die(`Invalid agent: ${agent}`);
      const tier = args.flags.tier ?? "standard";
      if (!TIERS.includes(tier)) die(`Invalid tier: ${tier}`);
      const status = args.flags.status ?? "active";

      const taskId = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks (id, title, status, agent, model_tier, notes, project_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(taskId, title, status, agent, tier, args.flags.notes ?? null, project.id, now, now);
      console.log(JSON.stringify({ ok: true, id: taskId, title, project: project.id, agent, tier }));
      break;
    }

    case "tasks": {
      const id = args.pos[0];
      if (!id) die("Project ID required");
      const project = resolveProject(db, id) as any;
      if (!project) die(`Project not found: ${id}`);
      const limit = parseInt(args.flags.limit ?? "30");
      let query = "SELECT id, title, status, agent, model_tier, notes, created_at, updated_at FROM tasks WHERE project_id = ?";
      const params: (string | number)[] = [project.id];
      if (args.flags.status) {
        query += " AND status = ?";
        params.push(args.flags.status);
      }
      query += " ORDER BY updated_at DESC LIMIT ?";
      params.push(limit);
      const rows = db.prepare(query).all(...params);
      console.log(JSON.stringify(rows, null, 2));
      break;
    }

    case "publish": {
      const id = args.pos[0];
      if (!id) die("Project ID required");
      const project = resolveProject(db, id) as any;
      if (!project) die(`Project not found: ${id}`);

      const tasks = db.prepare(
        "SELECT id, title, status, agent, model_tier, notes FROM tasks WHERE project_id = ? ORDER BY status, updated_at DESC"
      ).all(project.id) as any[];

      const byStatus: Record<string, any[]> = {};
      for (const t of tasks) {
        (byStatus[t.status] ??= []).push(t);
      }

      const lines: string[] = [
        `# ${project.title}`,
        "",
        `**ID:** ${project.id}`,
        `**Type:** ${project.type}`,
        `**Status:** ${project.archived ? "Archived" : "Active"}`,
      ];
      if (project.repo_path) lines.push(`**Repo:** \`${project.repo_path}\``);
      if (project.github_repo) lines.push(`**GitHub:** https://github.com/${project.github_repo}`);
      if (project.notes) { lines.push(""); lines.push(project.notes); }

      lines.push("", `## Tasks (${tasks.length} total)`, "");

      const STATUS_ORDER = ["active", "inbox", "waiting_on", "completed", "cancelled", "archived", "rejected"];
      for (const status of STATUS_ORDER) {
        const group = byStatus[status];
        if (!group?.length) continue;
        lines.push(`### ${status.replace("_", " ").replace(/\b\w/g, c => c.toUpperCase())} (${group.length})`);
        lines.push("");
        for (const t of group) {
          const badge = t.agent ? ` [${t.agent}]` : "";
          lines.push(`- **${t.title}**${badge} \`${t.id.slice(0, 8)}\``);
          if (t.notes) {
            const firstLine = t.notes.split("\n")[0].trim();
            if (firstLine) lines.push(`  > ${firstLine.slice(0, 120)}`);
          }
        }
        lines.push("");
      }

      console.log(lines.join("\n"));
      break;
    }

    case "archive": {
      const id = args.pos[0];
      if (!id) die("Project ID required");
      const project = resolveProject(db, id) as any;
      if (!project) die(`Project not found: ${id}`);
      db.prepare("UPDATE projects SET archived = 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), project.id);
      console.log(JSON.stringify({ ok: true, id: project.id, title: project.title, archived: true }));
      break;
    }

    case "unarchive": {
      const id = args.pos[0];
      if (!id) die("Project ID required");
      const project = resolveProject(db, id) as any;
      if (!project) die(`Project not found: ${id}`);
      db.prepare("UPDATE projects SET archived = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), project.id);
      console.log(JSON.stringify({ ok: true, id: project.id, title: project.title, archived: false }));
      break;
    }

    case "sync": {
      const id = args.pos[0];
      if (!id) die("Project ID required");
      const project = resolveProject(db, id) as any;
      if (!project) die(`Project not found: ${id}`);
      if (!project.github_repo) die(`Project ${project.title} has no github_repo configured`);

      // Fetch open issues from GitHub via gh CLI
      const { execSync } = await import("child_process");
      let issues: any[];
      try {
        const out = execSync(
          `gh issue list --repo "${project.github_repo}" --state open --json number,title,body,labels,updatedAt --limit 100`,
          { encoding: "utf8" }
        );
        issues = JSON.parse(out);
      } catch (e: any) {
        die(`GitHub fetch failed: ${e.message}`);
      }

      let created = 0;
      let skipped = 0;
      const now = new Date().toISOString();

      for (const issue of issues) {
        const externalId = `${project.github_repo}#${issue.number}`;
        const existing = db.prepare("SELECT id FROM tasks WHERE external_id = ?").get(externalId);
        if (existing) { skipped++; continue; }

        const taskId = randomUUID();
        const labelNames = (issue.labels ?? []).map((l: any) => l.name).join(", ");
        const notes = [
          issue.body?.trim() ? issue.body.trim().slice(0, 1000) : null,
          labelNames ? `Labels: ${labelNames}` : null,
        ].filter(Boolean).join("\n\n") || null;

        db.prepare(
          `INSERT INTO tasks (id, title, status, agent, model_tier, notes, project_id, external_source, external_id, external_updated_at, sync_state, created_at, updated_at)
           VALUES (?, ?, 'inbox', 'programmer', 'standard', ?, ?, 'github', ?, ?, 'synced', ?, ?)`
        ).run(taskId, issue.title, notes, project.id, externalId, issue.updatedAt, now, now);
        created++;
      }

      console.log(JSON.stringify({
        ok: true,
        project: project.id,
        repo: project.github_repo,
        issues_found: issues.length,
        created,
        skipped,
      }));
      break;
    }

    default:
      console.log(`Usage: paw-project <command> [options]

Commands:
  list        [--archived]                          List all projects
  get         <id>                                  Show project details
  create      --title "..." --type kanban           Create a new project
              [--notes "..."] [--repo-path "..."] [--github-repo "owner/repo"]
  update      <id> [--title ...] [--notes ...]      Update project fields
              [--repo-path ...] [--github-repo ...]
  add-task    <project-id> --title "..."            Add a task to a project
              [--agent programmer] [--tier standard] [--notes "..."]
  tasks       <id> [--status active] [--limit 30]  List tasks for a project
  publish     <id>                                  Print rich markdown summary
  archive     <id>                                  Mark project as archived
  unarchive   <id>                                  Restore archived project
  sync        <id>                                  Sync GitHub issues as tasks

Types:   ${TYPES.join(", ")}
Agents:  ${AGENTS.join(", ")}
Tiers:   ${TIERS.join(", ")}`);
  }
} finally {
  closeDb();
}
