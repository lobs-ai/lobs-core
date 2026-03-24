/**
 * Integration tests for post-success-validator.ts
 *
 * Coverage:
 * (1) Artifact detection with null repoPath fallback across ~/lobs, ~/paw, ~/apps
 * (2) mtime-based session matching with concurrent tasks (session file selection)
 * (3) Fallback directory search with non-existent directories
 * (4) No false phantom-flags on succeeded tasks that produced real output
 *
 * Regression prevention:
 * - Hardcoded ~/apps-only assumption: null repoPath must check ~/lobs, ~/paw, ~/apps
 * - null repoPath must trigger broad fallback scan, NOT return immediate no_artifacts
 * - Concurrent task session matching must select the correct session via mtime
 * - git dirty state (staged, unstaged) must count as artifacts
 *
 * NOTE on macOS compatibility:
 *   `find -newermt <ISO-8601>` (used by checkAnyRecentFiles / checkWriterArtifacts)
 *   does NOT work on macOS with the "T" + "Z" ISO format — macOS find rejects it.
 *   This means mtime-only paths are unreliable on macOS.
 *   Tests that rely purely on file mtime detection (no git repo) are marked
 *   PLATFORM:LINUX-ONLY and skipped on macOS.
 *   All other tests use git operations (commits, staged files) which are cross-platform.
 *
 * All tests use tmpdir for isolation — never touch the real HOME.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, utimesSync, mkdtempSync, mkdirSync as mkdir } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { execSync } from "node:child_process";
import { validatePostSuccessArtifacts } from "../src/orchestrator/post-success-validator.js";

// ─── Platform detection ───────────────────────────────────────────────────────
const IS_MACOS = platform() === "darwin";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let fakeHome: string;

/**
 * Create a file at `path` with the given content and optionally backdate its
 * mtime (ageSec seconds in the past).  Returns the full path.
 */
function touch(path: string, content = "x".repeat(128), ageSec = 0): string {
  mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(path, content);
  if (ageSec > 0) {
    const t = new Date(Date.now() - ageSec * 1_000);
    utimesSync(path, t, t);
  }
  return path;
}

/**
 * Initialise a minimal git repo at `dir` so all git commands succeed.
 * The "init" commit is backdated to 1 hour ago so it never falls inside
 * any recent-window check (git log --since=<10min ago>).
 */
function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" });
  // Backdate the empty init commit so it never falls in any "recent" window
  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  execSync("git commit --allow-empty -m 'init'", {
    cwd: dir,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: oneHourAgo,
      GIT_AUTHOR_DATE: oneHourAgo,
    },
  });
}

/**
 * Create and commit a file in a git repo.  The commit timestamp is "now",
 * so git log --since=<5 minutes ago> will always pick it up.
 */
function commitFile(repoDir: string, filename: string, content = "change"): void {
  // Compute parent directory: for flat names like "work.ts", parent is repoDir
  const slashIdx = filename.lastIndexOf("/");
  const parentDir = slashIdx === -1 ? repoDir : join(repoDir, filename.slice(0, slashIdx));
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(join(repoDir, filename), content);
  execSync(`git -C "${repoDir}" add "${filename}"`, { stdio: "ignore" });
  execSync(`git -C "${repoDir}" commit -m "test commit"`, { stdio: "ignore" });
}

/**
 * Stage (but do NOT commit) a file — so git status --porcelain sees it.
 */
function stageFile(repoDir: string, filename: string, content = "staged"): void {
  const slashIdx = filename.lastIndexOf("/");
  const parentDir = slashIdx === -1 ? repoDir : join(repoDir, filename.slice(0, slashIdx));
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(join(repoDir, filename), content);
  execSync(`git -C "${repoDir}" add "${filename}"`, { stdio: "ignore" });
}

/**
 * Write a JSONL session file to fakeHome/.lobs/agents/<agentType>/sessions/<name>.jsonl
 * with tool-call records that reference `repoPath` so detectActualWorkingRepos() can
 * extract it.  Returns the full path to the session file.
 */
function writeSession(agentType: string, repoPath: string, filename: string, ageSec = 0): string {
  const sessDir = join(fakeHome, ".lobs", "agents", agentType, "sessions");
  mkdirSync(sessDir, { recursive: true });
  const record = {
    toolCalls: [
      {
        name: "exec",
        input: { command: `cd ${repoPath} && git add -A && git commit -m "task"` },
      },
    ],
  };
  const sessionPath = join(sessDir, filename);
  writeFileSync(sessionPath, JSON.stringify(record) + "\n");
  if (ageSec > 0) {
    const t = new Date(Date.now() - ageSec * 1_000);
    utimesSync(sessionPath, t, t);
  }
  return sessionPath;
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "psv-test-"));
  vi.stubEnv("HOME", fakeHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fakeHome, { recursive: true, force: true });
});

// ─── 1. Agent type filtering ──────────────────────────────────────────────────

describe("(1) Agent type filtering", () => {
  it("returns valid for null agentType — no false phantoms on unknown agents", () => {
    const result = validatePostSuccessArtifacts(null, null, 5_000, null, null);
    expect(result.status).toBe("valid");
  });

  it("returns valid for 'researcher' (not in VALIDATED_AGENTS)", () => {
    const result = validatePostSuccessArtifacts("researcher", null, 5_000, null, null);
    expect(result.status).toBe("valid");
  });

  it("returns valid for arbitrary unknown agent type", () => {
    const result = validatePostSuccessArtifacts("some-future-agent", null, 5_000, null, null);
    expect(result.status).toBe("valid");
  });

  it("validates 'programmer' — empty repo with no commits returns no_artifacts", () => {
    const repoDir = join(fakeHome, "empty-repo");
    initGitRepo(repoDir);
    // No commits after init, no staged files

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = validatePostSuccessArtifacts("programmer", repoDir, 90_000, null, startedAt);
    expect(result.status).toBe("no_artifacts");
  });

  it("validates 'reviewer' — empty repo returns no_artifacts", () => {
    const repoDir = join(fakeHome, "empty-repo");
    initGitRepo(repoDir);

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = validatePostSuccessArtifacts("reviewer", repoDir, 90_000, null, startedAt);
    expect(result.status).toBe("no_artifacts");
  });

  it("validates 'architect' — empty repo returns no_artifacts", () => {
    const repoDir = join(fakeHome, "empty-repo");
    initGitRepo(repoDir);

    const result = validatePostSuccessArtifacts("architect", repoDir, 90_000, null, null);
    expect(result.status).toBe("no_artifacts");
  });
});

// ─── 2. Git artifact detection (programmer / reviewer / architect) ────────────

describe("(2) Git artifact detection", () => {
  it("detects a recent git commit → valid", () => {
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    commitFile(repoDir, "src/feature.ts");

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = validatePostSuccessArtifacts("programmer", repoDir, 90_000, null, startedAt);
    expect(result.status).toBe("valid");
  });

  it("detects staged (uncommitted) changes as artifacts — git status --porcelain", () => {
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    stageFile(repoDir, "pending.ts");

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = validatePostSuccessArtifacts("programmer", repoDir, 90_000, null, startedAt);
    expect(result.status).toBe("valid");
  });

  it("does NOT count commits older than the task's startedAt", () => {
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    // No post-init commits. startedAt = far future (+2h) so even now is before it.
    // The 60s skew buffer means cutoff = future - 60s ≈ still in the future.
    // Nothing written after init → no_artifacts.
    const startedAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

    const result = validatePostSuccessArtifacts("programmer", repoDir, 90_000, null, startedAt);
    expect(result.status).toBe("no_artifacts");
  });

  it("returns no_artifacts when project repo does not exist (no fallback either)", () => {
    const result = validatePostSuccessArtifacts(
      "programmer",
      join(fakeHome, "ghost-repo"),
      90_000,
      null,
      new Date().toISOString(),
    );
    expect(result.status).toBe("no_artifacts");
  });

  it("flags fast completion as 'suspicious' even when git artifacts are present", () => {
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    commitFile(repoDir, "work.ts");

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    // durationMs = 10s — below 60s FAST_THRESHOLD_MS
    const result = validatePostSuccessArtifacts("programmer", repoDir, 10_000, null, startedAt);
    expect(result.status).toBe("suspicious");
    if (result.status === "suspicious") {
      expect(result.reason).toMatch(/10s < 60s/);
    }
  });

  it("does NOT flag suspicious at exactly the 60s threshold", () => {
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    commitFile(repoDir, "work.ts");

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = validatePostSuccessArtifacts("programmer", repoDir, 60_000, null, startedAt);
    expect(result.status).toBe("valid");
  });

  it("treats null durationMs as non-fast (never suspicious on duration alone)", () => {
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    commitFile(repoDir, "work.ts");

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = validatePostSuccessArtifacts("programmer", repoDir, null, null, startedAt);
    expect(result.status).toBe("valid");
  });

  it("detects commit when startedAt is null (uses fallback window)", () => {
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    commitFile(repoDir, "work.ts");

    // null startedAt → fallback 10-minute window; commit was just made → valid
    const result = validatePostSuccessArtifacts("programmer", repoDir, 90_000, null, null);
    expect(result.status).toBe("valid");
  });

  it("applies 60s clock-skew buffer before startedAt", () => {
    /**
     * buildTimeCutoff subtracts 1 minute from startedAt to account for clock skew.
     * A commit made between (startedAt - 60s) and startedAt must still be detected.
     */
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    commitFile(repoDir, "skewed.ts");

    // startedAt = 30 seconds from now (in the future — simulates skew)
    // Without the 60s buffer the commit (made "now") would be BEFORE cutoff
    const startedAt = new Date(Date.now() + 30_000).toISOString();
    const result = validatePostSuccessArtifacts("programmer", repoDir, 90_000, null, startedAt);
    expect(result.status).toBe("valid");
  });
});

// ─── 3. null repoPath fallback — regression guard for ~/apps-only assumption ──

describe("(3) null repoPath fallback — ~/lobs, ~/paw, ~/apps coverage (regression)", () => {
  /**
   * REGRESSION GUARD: The original validator only checked ~/apps when repoPath=null.
   * After the fix, ~/lobs and ~/paw are also in the fallback search list.
   *
   * These tests use git repos (not mtime-only) so they work on macOS too.
   * A session transcript is written so detectActualWorkingRepos() finds the path.
   */

  it("finds artifact in ~/lobs via session transcript when repoPath is null", () => {
    const repoDir = join(fakeHome, "lobs", "lobs-core");
    initGitRepo(repoDir);
    commitFile(repoDir, "src/fix.ts");

    // Write a session that references this repo so detectActualWorkingRepos() picks it up
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    writeSession("programmer", repoDir, "spawned-task-abc.jsonl", 60); // 1 min old

    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, startedAt);
    expect(result.status).toBe("valid");
    expect(result.status).not.toBe("no_artifacts"); // explicit regression assertion
  });

  it("finds artifact in ~/paw via session transcript when repoPath is null", () => {
    const repoDir = join(fakeHome, "paw", "paw-hub");
    initGitRepo(repoDir);
    commitFile(repoDir, "src/component.ts");

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    writeSession("programmer", repoDir, "spawned-task-def.jsonl", 60);

    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, startedAt);
    expect(result.status).toBe("valid");
    expect(result.status).not.toBe("no_artifacts");
  });

  it("finds artifact in ~/apps via session transcript when repoPath is null", () => {
    const repoDir = join(fakeHome, "apps", "my-app");
    initGitRepo(repoDir);
    commitFile(repoDir, "index.ts");

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    writeSession("programmer", repoDir, "spawned-task-ghi.jsonl", 60);

    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, startedAt);
    expect(result.status).toBe("valid");
    expect(result.status).not.toBe("no_artifacts");
  });

  it.skipIf(IS_MACOS)(
    "PLATFORM:LINUX-ONLY — mtime-based fallback: finds file in ~/lobs without session transcript",
    () => {
      // On Linux, find -newermt with ISO 8601 works.
      // No session, but a freshly modified file in ~/lobs triggers the mtime path.
      const lobsDir = join(fakeHome, "lobs", "lobs-core");
      touch(join(lobsDir, "result.ts"), "output");

      const startedAt = new Date(Date.now() - 2 * 60_000).toISOString();
      const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, startedAt);
      expect(result.status).toBe("valid");
    },
  );

  it.skipIf(IS_MACOS)(
    "PLATFORM:LINUX-ONLY — mtime-based fallback: finds file in ~/paw without session transcript",
    () => {
      const pawDir = join(fakeHome, "paw", "paw-hub");
      touch(join(pawDir, "result.ts"), "output");

      const startedAt = new Date(Date.now() - 2 * 60_000).toISOString();
      const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, startedAt);
      expect(result.status).toBe("valid");
    },
  );

  it("returns no_artifacts when null repoPath and no session transcript exists", () => {
    // fakeHome has no repos, no sessions — all fallbacks are empty
    const startedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, startedAt);
    expect(result.status).toBe("no_artifacts");
  });

  it("no_artifacts reason mentions repo=none when repoPath is null", () => {
    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, new Date().toISOString());
    expect(result.status).toBe("no_artifacts");
    if (result.status === "no_artifacts") {
      expect(result.reason).toMatch(/repo=none/);
    }
  });
});

// ─── 4. Fallback with partially non-existent directories ─────────────────────

describe("(4) Fallback with partially non-existent directories", () => {
  it("skips non-existent ~/lobs but finds artifact in ~/paw via session", () => {
    // ~/lobs does NOT exist in fakeHome — only ~/paw does
    const repoDir = join(fakeHome, "paw", "paw-hub");
    initGitRepo(repoDir);
    commitFile(repoDir, "fix.ts");

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    writeSession("programmer", repoDir, "spawned-abc.jsonl", 60);

    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, startedAt);
    expect(result.status).toBe("valid");
  });

  it("handles all fallback dirs missing — no crash, returns no_artifacts", () => {
    expect(() =>
      validatePostSuccessArtifacts("programmer", null, 90_000, null, new Date().toISOString()),
    ).not.toThrow();

    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, new Date().toISOString());
    expect(result.status).toBe("no_artifacts");
  });

  it("handles non-existent explicit repoPath — no crash", () => {
    expect(() =>
      validatePostSuccessArtifacts(
        "programmer",
        "/this/path/does/not/exist",
        90_000,
        null,
        new Date().toISOString(),
      ),
    ).not.toThrow();
  });

  it("non-existent repoPath with no fallback → no_artifacts (not an exception)", () => {
    const result = validatePostSuccessArtifacts(
      "programmer",
      "/this/path/does/not/exist",
      90_000,
      null,
      new Date().toISOString(),
    );
    expect(result.status).toBe("no_artifacts");
  });
});

// ─── 5. Session mtime matching for concurrent tasks ──────────────────────────

describe("(5) Session mtime matching for concurrent tasks", () => {
  /**
   * When multiple sessions exist (concurrent tasks), detectActualWorkingRepos()
   * picks the session whose mtime falls within [startedAt, startedAt + 30min].
   * These tests verify that the correct session (and thus the correct repo) is selected.
   */

  it("selects the session matching startedAt window — finds correct repo", () => {
    const correctRepo = join(fakeHome, "lobs", "correct-repo");
    const wrongRepo = join(fakeHome, "lobs", "wrong-repo");
    initGitRepo(correctRepo);
    initGitRepo(wrongRepo);
    commitFile(correctRepo, "work.ts");
    // NOTE: wrongRepo has NO commits after init → no artifacts

    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago

    // correctSession: mtime = 8 minutes ago → within [10min ago, 10min ago + 30min]
    writeSession("programmer", correctRepo, "spawned-correct.jsonl", 8 * 60);

    // wrongSession: mtime = 45 minutes ago → OUTSIDE the window
    writeSession("programmer", wrongRepo, "spawned-wrong.jsonl", 45 * 60);

    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, startedAt);
    expect(result.status).toBe("valid");
  });

  it("falls back to most recent session when none matches the startedAt window", () => {
    // No session within the startedAt window → falls back to most recent
    const repoDir = join(fakeHome, "lobs", "myrepo");
    initGitRepo(repoDir);
    commitFile(repoDir, "latest.ts");

    const startedAt = new Date(Date.now() - 3 * 60_000).toISOString(); // 3 min ago

    // Session from 2 hours ago → outside 30-min window but IS the most recent
    writeSession("programmer", repoDir, "spawned-old.jsonl", 2 * 60 * 60);

    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, startedAt);
    // Most recent session is used as fallback → finds the repo → valid
    expect(result.status).toBe("valid");
  });

  it("ignores sessions that reference repos with no recent commits", () => {
    const emptyRepo = join(fakeHome, "lobs", "stale-repo");
    initGitRepo(emptyRepo);
    // No post-init commits

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    writeSession("programmer", emptyRepo, "spawned-stale.jsonl", 3 * 60);

    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, startedAt);
    expect(result.status).toBe("no_artifacts");
  });

  it("returns no_artifacts when sessions dir does not exist (null startedAt)", () => {
    // sessionsDir at fakeHome/.lobs/agents/programmer/sessions doesn't exist
    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, null);
    expect(result.status).toBe("no_artifacts");
  });

  it("handles corrupted session JSONL lines without crashing", () => {
    const sessDir = join(fakeHome, ".lobs", "agents", "programmer", "sessions");
    mkdirSync(sessDir, { recursive: true });
    // Mix of invalid and valid lines
    writeFileSync(
      join(sessDir, "spawned-corrupt.jsonl"),
      ["not-json", "{broken", "", JSON.stringify({ toolCalls: [] })].join("\n"),
    );

    expect(() =>
      validatePostSuccessArtifacts("programmer", null, 90_000, null, new Date().toISOString()),
    ).not.toThrow();
  });

  it("handles session dir with zero .jsonl files gracefully", () => {
    const sessDir = join(fakeHome, ".lobs", "agents", "programmer", "sessions");
    mkdirSync(sessDir, { recursive: true });
    // Create a non-jsonl file — should be ignored
    writeFileSync(join(sessDir, "session.txt"), "ignored");

    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, new Date().toISOString());
    expect(result.status).toBe("no_artifacts");
  });
});

// ─── 6. No false phantom-flags on legitimate succeeded tasks ──────────────────

describe("(6) No false phantom-flags on legitimate succeeded tasks", () => {
  /**
   * Replicate the three false-positive patterns from
   * docs/post-mortems/2026-03-23-phantom-task-44b653d0.md
   */

  it("programmer: committed work in project repo → valid, not phantom", () => {
    const repoDir = join(fakeHome, "lobs", "lobs-core");
    initGitRepo(repoDir);
    commitFile(repoDir, "src/orchestrator/fix.ts");

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = validatePostSuccessArtifacts("programmer", repoDir, 3 * 60_000, null, startedAt);
    expect(result.status).toBe("valid");
    expect(result.status).not.toBe("no_artifacts");
  });

  it("reviewer: left staged review notes (no commit) → valid, not phantom", () => {
    const repoDir = join(fakeHome, "paw", "paw-hub");
    initGitRepo(repoDir);
    stageFile(repoDir, "REVIEW.md");

    const result = validatePostSuccessArtifacts("reviewer", repoDir, 3 * 60_000, null, null);
    expect(result.status).toBe("valid");
    expect(result.status).not.toBe("no_artifacts");
  });

  it("writer: expected_artifacts all present → valid, not phantom", () => {
    const docPath = join(fakeHome, "lobs-shared-memory", "docs", "guide.md");
    touch(docPath, "# Guide\nContent here");

    const artifacts = [{ path: docPath }];
    const result = validatePostSuccessArtifacts("writer", null, 3 * 60_000, artifacts, null);
    expect(result.status).toBe("valid");
  });

  it("cross-repo: task repoPath is wrong, but agent worked in a different repo → valid", () => {
    /**
     * A task filed under paw-hub (projectRepo) but the programmer agent
     * actually committed in lobs-core. With repoPath=null and a session transcript
     * the fallback should find the actual work.
     */
    const actualRepo = join(fakeHome, "lobs", "lobs-core");
    initGitRepo(actualRepo);
    commitFile(actualRepo, "src/cross-repo-fix.ts");

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    writeSession("programmer", actualRepo, "spawned-cross.jsonl", 3 * 60);

    // repoPath=null (simulates wrong/missing repo_path on the task)
    const result = validatePostSuccessArtifacts("programmer", null, 3 * 60_000, null, startedAt);
    expect(result.status).toBe("valid");
    expect(result.status).not.toBe("no_artifacts");
  });

  it("genuine phantom: zero output produced → no_artifacts (correct)", () => {
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    // No commits after init, no staged files, no session transcript

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = validatePostSuccessArtifacts("programmer", repoDir, 3 * 60_000, null, startedAt);
    expect(result.status).toBe("no_artifacts");
  });

  it("legitimate quick task (>60s) not flagged suspicious", () => {
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    commitFile(repoDir, "trivial.ts");

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = validatePostSuccessArtifacts("programmer", repoDir, 90_000, null, startedAt);
    expect(result.status).toBe("valid");
    expect(result.status).not.toBe("suspicious");
  });
});

// ─── 7. Writer agent — expected_artifacts spec paths ─────────────────────────

describe("(7) Writer agent — expected_artifacts spec", () => {
  it("all expected_artifacts present → valid", () => {
    const p1 = join(fakeHome, "docs", "doc1.md");
    const p2 = join(fakeHome, "docs", "doc2.md");
    touch(p1, "content");
    touch(p2, "content");

    const result = validatePostSuccessArtifacts("writer", null, 3 * 60_000, [{ path: p1 }, { path: p2 }], null);
    expect(result.status).toBe("valid");
  });

  it("all expected_artifacts missing → no_artifacts", () => {
    const artifacts = [
      { path: join(fakeHome, "docs", "missing1.md") },
      { path: join(fakeHome, "docs", "missing2.md") },
    ];
    const result = validatePostSuccessArtifacts("writer", null, 3 * 60_000, artifacts, null);
    expect(result.status).toBe("no_artifacts");
  });

  it("partial expected_artifacts present (some present, some missing) → valid", () => {
    const present = join(fakeHome, "docs", "present.md");
    touch(present, "content");
    const missing = join(fakeHome, "docs", "missing.md");

    const result = validatePostSuccessArtifacts(
      "writer",
      null,
      3 * 60_000,
      [{ path: present }, { path: missing }],
      null,
    );
    // Partial: at least one present → valid
    expect(result.status).toBe("valid");
  });

  it("expands ~ in expected_artifacts paths using HOME env", () => {
    const docPath = join(fakeHome, "docs", "tilde.md");
    touch(docPath, "content");
    // Express path with ~ (relies on vi.stubEnv HOME = fakeHome)
    const tildePath = docPath.replace(fakeHome, "~");

    const result = validatePostSuccessArtifacts("writer", null, 3 * 60_000, [{ path: tildePath }], null);
    expect(result.status).toBe("valid");
  });

  it("empty array expected_artifacts → falls back to mtime/dir scan", () => {
    // On macOS mtime-based scan may return no_artifacts; that's acceptable.
    // What must NOT happen: it must not throw.
    expect(() =>
      validatePostSuccessArtifacts("writer", null, 3 * 60_000, [], null),
    ).not.toThrow();
  });

  it("non-array expected_artifacts (bad type) → falls back gracefully without crash", () => {
    expect(() =>
      validatePostSuccessArtifacts("writer", null, 3 * 60_000, "bad-type" as unknown, null),
    ).not.toThrow();
  });

  it("expected_artifacts spec objects missing 'path' key → falls back gracefully", () => {
    const artifacts = [{ url: "https://example.com/doc" }]; // no 'path' field
    expect(() =>
      validatePostSuccessArtifacts("writer", null, 3 * 60_000, artifacts, null),
    ).not.toThrow();
  });
});

// ─── 8. Result shape contracts ────────────────────────────────────────────────

describe("(8) Result shape contracts", () => {
  it("'valid' result has no reason field", () => {
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    commitFile(repoDir, "x.ts");

    const result = validatePostSuccessArtifacts(
      "programmer",
      repoDir,
      90_000,
      null,
      new Date(Date.now() - 5 * 60_000).toISOString(),
    );
    expect(result.status).toBe("valid");
    expect((result as Record<string, unknown>)["reason"]).toBeUndefined();
  });

  it("'no_artifacts' result has a non-empty reason string", () => {
    const result = validatePostSuccessArtifacts(
      "programmer",
      join(fakeHome, "missing-repo"),
      120_000,
      null,
      new Date().toISOString(),
    );
    expect(result.status).toBe("no_artifacts");
    if (result.status === "no_artifacts") {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("'no_artifacts' reason includes duration in seconds", () => {
    const result = validatePostSuccessArtifacts(
      "programmer",
      join(fakeHome, "missing-repo"),
      120_000,
      null,
      new Date().toISOString(),
    );
    if (result.status === "no_artifacts") {
      expect(result.reason).toMatch(/120s/);
    }
  });

  it("'no_artifacts' reason mentions duration=unknown when durationMs is null", () => {
    const result = validatePostSuccessArtifacts(
      "programmer",
      join(fakeHome, "missing-repo"),
      null,
      null,
      new Date().toISOString(),
    );
    if (result.status === "no_artifacts") {
      expect(result.reason).toMatch(/duration=unknown/);
    }
  });

  it("'no_artifacts' reason mentions repo=none when repoPath is null", () => {
    const result = validatePostSuccessArtifacts("programmer", null, 90_000, null, new Date().toISOString());
    if (result.status === "no_artifacts") {
      expect(result.reason).toMatch(/repo=none/);
    }
  });

  it("'suspicious' reason mentions both actual duration and 60s threshold", () => {
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    commitFile(repoDir, "x.ts");

    const result = validatePostSuccessArtifacts(
      "programmer",
      repoDir,
      5_000,
      null,
      new Date(Date.now() - 5 * 60_000).toISOString(),
    );
    expect(result.status).toBe("suspicious");
    if (result.status === "suspicious") {
      expect(result.reason).toMatch(/5s/);
      expect(result.reason).toMatch(/60s/);
    }
  });

  it("'suspicious' result has both status and reason fields", () => {
    const repoDir = join(fakeHome, "myrepo");
    initGitRepo(repoDir);
    commitFile(repoDir, "x.ts");

    const result = validatePostSuccessArtifacts(
      "programmer",
      repoDir,
      5_000,
      null,
      new Date(Date.now() - 5 * 60_000).toISOString(),
    );
    expect(result).toHaveProperty("status", "suspicious");
    expect(result).toHaveProperty("reason");
  });
});

// ─── 9. Tilde expansion in repoPath ──────────────────────────────────────────

describe("(9) Tilde expansion in repoPath", () => {
  it("expands ~ in repoPath using HOME env", () => {
    const repoDir = join(fakeHome, "my-project");
    initGitRepo(repoDir);
    commitFile(repoDir, "work.ts");

    // Pass the path with ~ instead of the actual home
    const tildeRepo = repoDir.replace(fakeHome, "~");
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = validatePostSuccessArtifacts("programmer", tildeRepo, 90_000, null, startedAt);
    expect(result.status).toBe("valid");
  });

  it("handles absolute repoPath without tilde", () => {
    const repoDir = join(fakeHome, "my-project");
    initGitRepo(repoDir);
    commitFile(repoDir, "work.ts");

    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = validatePostSuccessArtifacts("programmer", repoDir, 90_000, null, startedAt);
    expect(result.status).toBe("valid");
  });
});
