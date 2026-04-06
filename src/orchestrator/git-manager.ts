/**
 * Git Manager — auto-commit after worker completion, branch management.
 * Port of lobs-server/app/orchestrator/git_manager.py
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../util/logger.js";
import { getBotName } from "../config/identity.js";

function getGitIdentity(): { name: string; email: string } {
  const configPath = join(homedir(), ".lobs", "config", "lobs.json");
  try {
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.git?.name && config.git?.email) {
        return { name: config.git.name, email: config.git.email };
      }
    }
  } catch {}
  return {
    name: process.env.LOBS_GIT_NAME ?? getBotName(),
    email: process.env.LOBS_GIT_EMAIL ?? "lobs@localhost",
  };
}

const TEMPLATE_FILES = ["AGENTS.md", "SOUL.md", "TOOLS.md", "USER.md", "IDENTITY.md", "WORKER_RULES.md", "HEARTBEAT.md"];

export class GitManager {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  private git(...args: string[]): { stdout: string; stderr: string; code: number } {
    const result = spawnSync("git", ["-C", this.repoPath, ...args], { encoding: "utf8" });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
  }

  createTaskBranch(taskIdShort: string): boolean {
    const branch = `task/${taskIdShort}`;
    try {
      this.git("fetch", "origin");
      const sym = this.git("symbolic-ref", "refs/remotes/origin/HEAD");
      const defaultBranch = sym.code === 0 ? sym.stdout.trim().split("/").pop()! : "main";
      this.git("checkout", defaultBranch);
      this.git("pull", "--rebase", "origin", defaultBranch);
      const res = this.git("checkout", "-b", branch);
      if (res.code !== 0) {
        log().warn(`[GIT] Could not create branch ${branch}: ${res.stderr}`);
        return false;
      }
      log().info(`[GIT] Created branch ${branch} in ${this.repoPath}`);
      return true;
    } catch (e) {
      log().error(`[GIT] createTaskBranch failed: ${String(e)}`);
      return false;
    }
  }

  copyTemplateFiles(agentWorkspace: string): string[] {
    const copied: string[] = [];
    for (const filename of TEMPLATE_FILES) {
      const src = join(agentWorkspace, filename);
      const dst = join(this.repoPath, filename);
      if (!existsSync(src)) continue;
      try {
        writeFileSync(dst, readFileSync(src, "utf8"), "utf8");
        copied.push(filename);
      } catch (e) {
        log().warn(`[GIT] Failed to copy ${filename}: ${String(e)}`);
      }
    }
    log().info(`[GIT] Copied ${copied.length} template files`);
    return copied;
  }

  cleanupTemplateFiles(): void {
    for (const filename of TEMPLATE_FILES) {
      const filepath = join(this.repoPath, filename);
      if (existsSync(filepath)) {
        try {
          execSync(`rm -f "${filepath}"`);
        } catch (_) {}
      }
    }
  }

  hasChanges(): [boolean, string] {
    try {
      this.git("add", "-A");
      for (const f of TEMPLATE_FILES) this.git("reset", "HEAD", f);
      const diff = this.git("diff", "--cached", "--stat");
      const stat = diff.stdout.trim();
      return [stat.length > 0, stat];
    } catch (e) {
      log().error(`[GIT] hasChanges failed: ${String(e)}`);
      return [false, ""];
    }
  }

  commitChanges(taskId: string, taskTitle: string, agentType: string): boolean {
    const [hasChg, stat] = this.hasChanges();
    if (!hasChg) {
      log().info(`[GIT] No changes to commit for task ${taskId.slice(0, 8)}`);
      return false;
    }

    const msg = `feat(${agentType}): ${taskTitle}\n\nTask: ${taskId}\nAgent: ${agentType}\n\n${stat}`;
    try {
      const identity = getGitIdentity();
      this.git("config", "user.name", identity.name);
      this.git("config", "user.email", identity.email);
      const res = this.git("commit", "-m", msg);
      if (res.code !== 0) {
        log().error(`[GIT] Commit failed: ${res.stderr}`);
        return false;
      }
      log().info(`[GIT] Committed changes for task ${taskId.slice(0, 8)}`);
      return true;
    } catch (e) {
      log().error(`[GIT] commitChanges failed: ${String(e)}`);
      return false;
    }
  }

  getDiffSummary(): string {
    try {
      const diff = this.git("diff", "HEAD~1", "--stat");
      return diff.stdout.trim();
    } catch (_) {
      return "";
    }
  }

  pushBranch(branch: string): boolean {
    try {
      const res = this.git("push", "--set-upstream", "origin", branch);
      if (res.code !== 0) {
        log().warn(`[GIT] Push failed: ${res.stderr}`);
        return false;
      }
      log().info(`[GIT] Pushed branch ${branch}`);
      return true;
    } catch (e) {
      log().error(`[GIT] pushBranch failed: ${String(e)}`);
      return false;
    }
  }

  getCurrentBranch(): string {
    const res = this.git("branch", "--show-current");
    return res.stdout.trim();
  }
}
