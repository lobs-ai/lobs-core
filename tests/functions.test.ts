import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/connection.js";
import { tasks, inboxItems } from "../src/db/schema.js";
import {
  workerCapacity,
  activeWorkers,
  numTasks,
  numUnread,
  evaluateCondition,
  evaluateExpression,
  interpolate,
} from "../src/workflow/functions.js";

describe("Workflow Functions", () => {
  describe("Query Functions", () => {
    it("workerCapacity should return non-negative", () => {
      expect(workerCapacity()).toBeGreaterThanOrEqual(0);
    });

    it("activeWorkers should return non-negative", () => {
      expect(activeWorkers()).toBeGreaterThanOrEqual(0);
    });

    it("numTasks should count by status group", () => {
      const db = getDb();
      const id = randomUUID();
      db.insert(tasks).values({ id, title: "Count test", status: "inbox" }).run();

      const open = numTasks("open");
      expect(open).toBeGreaterThanOrEqual(1);
    });

    it("numUnread should count unread inbox items", () => {
      const db = getDb();
      const id = randomUUID();
      db.insert(inboxItems).values({ id, title: "Unread", isRead: false }).run();

      const unread = numUnread();
      expect(unread).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Expression Evaluation", () => {
    it("should evaluate simple comparisons", () => {
      expect(evaluateCondition("1 == 1", {})).toBe(true);
      expect(evaluateCondition("1 == 2", {})).toBe(false);
    });

    it("should evaluate context lookups", () => {
      const ctx = { run_tests: { returncode: 0 } };
      expect(evaluateCondition("run_tests.returncode == 0", ctx)).toBe(true);
      expect(evaluateCondition("run_tests.returncode == 1", ctx)).toBe(false);
    });

    it("should handle boolean results", () => {
      expect(evaluateCondition("true", {})).toBe(true);
      expect(evaluateCondition("false", {})).toBe(false);
    });
  });

  describe("String Interpolation", () => {
    it("should interpolate {task.title}", () => {
      const ctx = { task: { title: "Fix bug" } };
      expect(interpolate("{task.title}", ctx)).toBe("Fix bug");
    });

    it("should handle missing keys gracefully", () => {
      const result = interpolate("{missing.key}", {});
      expect(typeof result).toBe("string");
    });

    it("should interpolate multiple placeholders", () => {
      const ctx = { task: { title: "Bug" }, project: { repo_path: "/tmp/repo" } };
      expect(interpolate("{task.title} in {project.repo_path}", ctx)).toBe("Bug in /tmp/repo");
    });
  });
});
