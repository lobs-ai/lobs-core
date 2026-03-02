/**
 * GitHub Integration
 * Port of lobs-server/app/services/github_sync.py
 * Syncs GitHub issues to tasks, tracks PR status.
 * Uses `gh` CLI (already installed and authed).
 */

import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, projects } from "../db/schema.js";
import { log } from "../util/logger.js";

interface GitHubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  updatedAt: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  url: string;
  body?: string;
}

function runGh(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 45_000 });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function issueStateToTaskStatus(state: string): string {
  return state === "closed" ? "completed" : "inbox";
}

export class GitHubSyncService {
  /**
   * Sync all GitHub-tracked projects.
   */
  syncAll(): { synced: number; errors: number; total: number } {
    const db = getDb();
    const allProjects = db.select().from(projects)
      .where(eq(projects.archived, false))
      .all()
      .filter(p => p.tracking === "github" && p.githubRepo);

    let synced = 0, errors = 0;
    for (const project of allProjects) {
      try {
        this.syncProject(project.id, project.githubRepo!);
        synced++;
      } catch (e) {
        log().warn(`[GITHUB] Failed to sync ${project.githubRepo}: ${String(e)}`);
        errors++;
      }
    }
    log().info(`[GITHUB] syncAll: synced=${synced} errors=${errors} total=${allProjects.length}`);
    return { synced, errors, total: allProjects.length };
  }

  /**
   * Sync a single project's GitHub issues to tasks.
   */
  syncProject(projectId: string, repo: string): { imported: number; updated: number; skipped: number } {
    const result = runGh("issue", "list", "--repo", repo, "--state", "all",
      "--limit", "200", "--json", "number,title,state,updatedAt,labels,assignees,url,body");

    if (!result.ok) {
      throw new Error(`gh CLI error: ${result.stderr.slice(0, 300)}`);
    }

    const issues: GitHubIssue[] = JSON.parse(result.stdout);
    const db = getDb();

    // Build lookup of existing tasks by external_id
    const existing = db.select().from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.externalSource, "github")))
      .all();
    const byExternalId = new Map(existing.map(t => [t.externalId ?? String(t.githubIssueNumber), t]));

    let imported = 0, updated = 0, skipped = 0;
    const now = new Date().toISOString();

    for (const issue of issues) {
      const externalId = String(issue.number);
      const existing = byExternalId.get(externalId);
      const status = issueStateToTaskStatus(issue.state);

      if (!existing) {
        db.insert(tasks).values({
          id: randomUUID(),
          title: issue.title,
          status,
          projectId,
          externalSource: "github",
          externalId,
          externalUpdatedAt: issue.updatedAt,
          githubIssueNumber: issue.number,
          notes: issue.body?.slice(0, 2000) ?? null,
          owner: "lobs",
          workState: "not_started",
          createdAt: now,
          updatedAt: now,
        }).run();
        imported++;
      } else if (existing.externalUpdatedAt && existing.externalUpdatedAt < issue.updatedAt) {
        db.update(tasks).set({
          title: issue.title,
          status,
          externalUpdatedAt: issue.updatedAt,
          updatedAt: now,
        }).where(eq(tasks.id, existing.id)).run();
        updated++;
      } else {
        skipped++;
      }
    }

    log().info(`[GITHUB] Synced ${repo}: imported=${imported} updated=${updated} skipped=${skipped}`);
    return { imported, updated, skipped };
  }

  /**
   * Get PR status for a repo.
   */
  getPRStatus(repo: string): Array<{ number: number; title: string; state: string; url: string }> {
    const result = runGh("pr", "list", "--repo", repo, "--state", "open",
      "--limit", "50", "--json", "number,title,state,url");
    if (!result.ok) {
      log().warn(`[GITHUB] getPRStatus failed for ${repo}: ${result.stderr.slice(0, 200)}`);
      return [];
    }
    try {
      return JSON.parse(result.stdout);
    } catch (_) {
      return [];
    }
  }
}
