/**
 * Tests for ADR-0013: diff-based automatic code review triggers.
 *
 * Validates that shouldTriggerReview correctly fires on security-sensitive
 * patterns and skips non-sensitive diffs.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldTriggerReview } from "../src/orchestrator/review-triggers.js";

// ---------------------------------------------------------------------------
// Helpers: create a temporary git repo with a single commit
// ---------------------------------------------------------------------------

function initRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "paw-review-test-"));

  // Init git repo with a baseline commit so HEAD~1 exists
  spawnSync("git", ["init", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });

  // Baseline commit (empty README)
  writeFileSync(join(dir, "README.md"), "# test\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });

  // Second commit with the test files
  for (const [filePath, content] of Object.entries(files)) {
    const abs = join(dir, filePath);
    mkdirSync(join(dir, filePath, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "feat: test change"], { cwd: dir });

  return dir;
}

let tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});

function makeRepo(files: Record<string, string>): string {
  const dir = initRepo(files);
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Tests: should NOT trigger review
// ---------------------------------------------------------------------------

describe("shouldTriggerReview — no trigger", () => {
  it("returns shouldReview=false for a trivial README change", () => {
    const repo = makeRepo({
      "README.md": "# Project\n\nUpdated description.\n",
    });

    const result = shouldTriggerReview({
      repoPath: repo,
      taskId: "test-task-001",
      taskTitle: "Update README",
    });

    expect(result.shouldReview).toBe(false);
    expect(result.triggers).toHaveLength(0);
  });

  it("returns shouldReview=false when repoPath is null", () => {
    const result = shouldTriggerReview({
      repoPath: null,
      taskId: "test-task-002",
      taskTitle: "Some task",
    });

    expect(result.shouldReview).toBe(false);
    expect(result.reason).toContain("no_repo_path");
  });

  it("returns shouldReview=false for a non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "paw-nongit-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "foo.txt"), "hello\n");

    const result = shouldTriggerReview({
      repoPath: dir,
      taskId: "test-task-003",
      taskTitle: "Some task",
    });

    expect(result.shouldReview).toBe(false);
    expect(result.reason).toContain("not_a_git_repo");
  });
});

// ---------------------------------------------------------------------------
// Tests: SECURITY trigger
// ---------------------------------------------------------------------------

describe("shouldTriggerReview — security trigger", () => {
  it("fires on auth-related code changes", () => {
    const repo = makeRepo({
      "src/auth.ts": `
export function verifyToken(token: string): boolean {
  const secret = process.env.JWT_SECRET;
  return jwt.verify(token, secret);
}
`,
    });

    const result = shouldTriggerReview({
      repoPath: repo,
      taskId: "test-task-010",
      taskTitle: "Add JWT token verification",
    });

    expect(result.shouldReview).toBe(true);
    expect(result.triggers).toContain("security");
  });

  it("fires on files with 'auth' in the filename", () => {
    const repo = makeRepo({
      "middleware/auth-guard.ts": `
export function authGuard(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  next();
}
`,
    });

    const result = shouldTriggerReview({
      repoPath: repo,
      taskId: "test-task-011",
      taskTitle: "Add auth guard middleware",
    });

    expect(result.shouldReview).toBe(true);
    expect(result.triggers).toContain("security");
  });

  it("fires on crypto/encryption changes", () => {
    const repo = makeRepo({
      "src/crypto.ts": `
import { createCipheriv, randomBytes } from "crypto";

export function encrypt(data: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return iv.toString("hex") + cipher.update(data, "utf8", "hex") + cipher.final("hex");
}
`,
    });

    const result = shouldTriggerReview({
      repoPath: repo,
      taskId: "test-task-012",
      taskTitle: "Add AES encryption helper",
    });

    expect(result.shouldReview).toBe(true);
    expect(result.triggers).toContain("security");
  });
});

// ---------------------------------------------------------------------------
// Tests: DB_SCHEMA_CHANGE trigger
// ---------------------------------------------------------------------------

describe("shouldTriggerReview — db_schema_change trigger", () => {
  it("fires when a migration file is added", () => {
    const repo = makeRepo({
      "db/migrations/0001_add_users.sql": `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
`,
    });

    const result = shouldTriggerReview({
      repoPath: repo,
      taskId: "test-task-020",
      taskTitle: "Add users table migration",
    });

    expect(result.shouldReview).toBe(true);
    expect(result.triggers).toContain("db_schema_change");
  });

  it("fires when schema.ts is modified", () => {
    const repo = makeRepo({
      "src/db/schema.ts": `
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
});
`,
    });

    const result = shouldTriggerReview({
      repoPath: repo,
      taskId: "test-task-021",
      taskTitle: "Add users schema",
    });

    expect(result.shouldReview).toBe(true);
    expect(result.triggers).toContain("db_schema_change");
  });
});

// ---------------------------------------------------------------------------
// Tests: NEW_API_ENDPOINT trigger
// ---------------------------------------------------------------------------

describe("shouldTriggerReview — new_api_endpoint trigger", () => {
  it("fires when a new FastAPI route decorator is added", () => {
    // The API route pattern matches Python-style route decorators (@router.get, @app.route).
    const repo = makeRepo({
      "app/routes/items.py": `
from fastapi import APIRouter

router = APIRouter()

@router.get("/items")
def list_items():
    return {"items": []}

@router.post("/items")
def create_item(name: str):
    return {"id": "new-id", "name": name}
`,
    });

    const result = shouldTriggerReview({
      repoPath: repo,
      taskId: "test-task-030",
      taskTitle: "Add items API routes",
    });

    expect(result.shouldReview).toBe(true);
    expect(result.triggers).toContain("new_api_endpoint");
  });
});

// ---------------------------------------------------------------------------
// Tests: LARGE_REFACTOR trigger
// ---------------------------------------------------------------------------

describe("shouldTriggerReview — large_refactor trigger", () => {
  it("fires when >500 lines are changed", () => {
    // Generate a file with 600+ lines
    const lines = Array.from({ length: 600 }, (_, i) => `const x${i} = ${i};`);
    const repo = makeRepo({
      "src/generated.ts": lines.join("\n") + "\n",
    });

    const result = shouldTriggerReview({
      repoPath: repo,
      taskId: "test-task-040",
      taskTitle: "Large generated module",
    });

    expect(result.shouldReview).toBe(true);
    expect(result.triggers).toContain("large_refactor");
    expect(result.stats.linesChanged).toBeGreaterThan(500);
  });
});

// ---------------------------------------------------------------------------
// Tests: ReviewTriggerResult shape
// ---------------------------------------------------------------------------

describe("shouldTriggerReview — result shape", () => {
  it("includes stats in all results", () => {
    const result = shouldTriggerReview({
      repoPath: null,
      taskId: "test-task-050",
      taskTitle: "Shape check",
    });

    expect(result).toHaveProperty("shouldReview");
    expect(result).toHaveProperty("triggers");
    expect(result).toHaveProperty("reason");
    expect(result).toHaveProperty("stats");
    expect(result.stats).toHaveProperty("linesAdded");
    expect(result.stats).toHaveProperty("linesRemoved");
    expect(result.stats).toHaveProperty("linesChanged");
    expect(result.stats).toHaveProperty("fileCount");
    expect(result.stats).toHaveProperty("newTests");
  });
});
