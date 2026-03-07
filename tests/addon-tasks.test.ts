/**
 * Tests for the tasks add-on
 *
 * Validates that the tasks add-on is structurally correct and
 * compatible with the add-on ingestion system.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const ADDON_DIR = resolve(__dirname, "../addons/tasks");
const ADDON_MD = resolve(ADDON_DIR, "addon.md");
const README_MD = resolve(ADDON_DIR, "README.md");
const SKILL_MD = resolve(ADDON_DIR, "tasks/SKILL.md");

// ---------------------------------------------------------------------------
// File structure
// ---------------------------------------------------------------------------

describe("Tasks add-on — file structure", () => {
  it("has addon.md", () => {
    expect(existsSync(ADDON_MD)).toBe(true);
  });

  it("has README.md", () => {
    expect(existsSync(README_MD)).toBe(true);
  });

  it("has tasks/SKILL.md", () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addon.md — frontmatter and operations
// ---------------------------------------------------------------------------

describe("Tasks add-on — addon.md", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(ADDON_MD, "utf-8");
  });

  it("has valid frontmatter with name: tasks", () => {
    expect(content).toMatch(/^---/);
    expect(content).toMatch(/name:\s*tasks/);
  });

  it("has a version field", () => {
    expect(content).toMatch(/version:\s*\d+\.\d+\.\d+/);
  });

  it("has a description field", () => {
    expect(content).toMatch(/description:\s*.+/);
  });

  it("has a skill-install @target operation", () => {
    expect(content).toMatch(/@target:.*\[skill-install\]/);
  });

  it("skill-install references the 'tasks' folder", () => {
    // The skill-install target should reference the tasks subfolder
    const skillInstallMatch = content.match(
      /##\s+@target:[^\n]+\[skill-install\][^\n]*\n([\s\S]+?)(?=##\s+@target:|$)/
    );
    expect(skillInstallMatch).not.toBeNull();
    const skillContent = skillInstallMatch![1].trim();
    expect(skillContent).toBe("tasks");
  });

  it("has an append-section @target operation for AGENTS.md", () => {
    expect(content).toMatch(/@target:\s*~\/apps\/AGENTS\.md\s+\[append-section\]/);
  });

  it("AGENTS.md section mentions task management", () => {
    expect(content).toMatch(/Task Management/i);
  });

  it("AGENTS.md section mentions POST \/api\/tasks", () => {
    expect(content).toMatch(/POST \/api\/tasks/);
  });

  it("AGENTS.md section mentions PATCH \/api\/tasks\/:id", () => {
    expect(content).toMatch(/PATCH \/api\/tasks\/:id/);
  });
});

// ---------------------------------------------------------------------------
// tasks/SKILL.md — content completeness
// ---------------------------------------------------------------------------

describe("Tasks add-on — SKILL.md content", () => {
  let skill: string;

  beforeAll(() => {
    skill = readFileSync(SKILL_MD, "utf-8");
  });

  it("has valid frontmatter with name: tasks", () => {
    expect(skill).toMatch(/^---/);
    expect(skill).toMatch(/name:\s*tasks/);
  });

  it("has a description in frontmatter", () => {
    expect(skill).toMatch(/description:\s*.+/);
  });

  it("documents how to create a task (POST)", () => {
    expect(skill).toMatch(/POST.*\/api\/tasks/);
    expect(skill).toMatch(/Create a Task/i);
  });

  it("documents how to list tasks (GET)", () => {
    expect(skill).toMatch(/GET.*\/api\/tasks|\/api\/tasks.*GET/i);
    expect(skill).toMatch(/List Tasks/i);
  });

  it("documents how to update a task (PATCH)", () => {
    expect(skill).toMatch(/PATCH.*\/api\/tasks/);
    expect(skill).toMatch(/Update a Task/i);
  });

  it("documents how to close or cancel a task", () => {
    expect(skill).toMatch(/Close|Cancel/i);
    expect(skill).toMatch(/workState.*done|done.*workState/i);
  });

  it("includes all required task fields", () => {
    expect(skill).toMatch(/title/);
    expect(skill).toMatch(/workState/);
    expect(skill).toMatch(/agent/);
    expect(skill).toMatch(/notes/);
  });

  it("includes auth header documentation", () => {
    expect(skill).toMatch(/Authorization.*Bearer/i);
  });

  it("includes base URL documentation", () => {
    expect(skill).toMatch(/http:\/\/127\.0\.0\.1:18789/);
  });

  it("documents user commands this skill handles", () => {
    expect(skill).toMatch(/create a task/i);
    expect(skill).toMatch(/list.*tasks|tasks.*active/i);
    expect(skill).toMatch(/mark.*done|done.*workState/i);
  });

  it("documents workState values", () => {
    expect(skill).toMatch(/not_started|queued|in_progress|blocked|done/);
  });

  it("documents error handling", () => {
    expect(skill).toMatch(/Error Handling/i);
    expect(skill).toMatch(/401/);
    expect(skill).toMatch(/404/);
  });

  it("documents task notes format", () => {
    expect(skill).toMatch(/## Problem/);
    expect(skill).toMatch(/## Acceptance Criteria/);
  });
});

// ---------------------------------------------------------------------------
// Ingestion compatibility — dry-run via ingest.py
// ---------------------------------------------------------------------------

describe("Tasks add-on — ingest.py compatibility", () => {
  it("passes dry-run without errors", () => {
    const ingestScript = resolve(process.env.HOME!, ".openclaw/addons/ingest.py");

    if (!existsSync(ingestScript)) {
      // Skip if ingest.py is not installed (CI without OpenClaw)
      console.warn("Skipping ingest dry-run — ingest.py not found at", ingestScript);
      return;
    }

    let output: string;
    try {
      output = execSync(
        `python3 "${ingestScript}" --dry-run --file "${ADDON_MD}"`,
        { encoding: "utf-8", timeout: 15_000 }
      );
    } catch (err: any) {
      throw new Error(`ingest.py dry-run failed:\n${err.stdout}\n${err.stderr}`);
    }

    expect(output).toMatch(/DRY RUN/i);
    expect(output).not.toMatch(/ERROR/i);
    expect(output).toMatch(/skill-install/i);
    expect(output).toMatch(/append-section/i);
  });
});
