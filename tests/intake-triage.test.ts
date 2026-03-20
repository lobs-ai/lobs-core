/**
 * Tests for src/services/intake-triage.ts
 *
 * In test mode (VITEST=true), the service automatically skips the local model
 * and uses the pure heuristic fallback. This gives us deterministic, fast tests
 * for all the classification logic.
 *
 * Tests cover:
 * - Category detection (bug, feature, research, documentation, review, meeting,
 *   email, notification, administrative, system, other)
 * - Urgency detection (critical, high, medium, low)
 * - Route selection
 * - Model tier mapping
 * - Agent selection by category
 * - shouldNotify and requiresAction logic
 * - Summary truncation
 * - Result shape validation
 */

import { describe, expect, it } from "vitest";
import { triageIncomingItem } from "../src/services/intake-triage.js";
import type { IntakeTriageResult } from "../src/services/intake-triage.js";

// ── Helper ─────────────────────────────────────────────────────────────────────

async function triage(
  title: string,
  content = "",
  kind: "task" | "email" | "notification" | "message" = "task",
): Promise<IntakeTriageResult> {
  return triageIncomingItem({ kind, title, content });
}

// ── Result shape ──────────────────────────────────────────────────────────────

describe("triageIncomingItem — result shape", () => {
  it("returns all required fields", async () => {
    const result = await triage("Fix login bug");
    expect(typeof result.kind).toBe("string");
    expect(typeof result.category).toBe("string");
    expect(typeof result.urgency).toBe("string");
    expect(typeof result.route).toBe("string");
    expect(typeof result.modelTier).toBe("string");
    expect(typeof result.agent).toBe("string");
    expect(typeof result.requiresAction).toBe("boolean");
    expect(typeof result.shouldNotify).toBe("boolean");
    expect(typeof result.summary).toBe("string");
    expect(typeof result.confidence).toBe("number");
    expect(typeof result.reasoning).toBe("string");
    expect(typeof result.localModelUsed).toBe("boolean");
  });

  it("kind is passed through correctly", async () => {
    const task = await triage("some task", "", "task");
    expect(task.kind).toBe("task");

    const email = await triage("an email", "", "email");
    expect(email.kind).toBe("email");
  });

  it("confidence is between 0 and 1", async () => {
    const result = await triage("Deploy new feature to prod");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("summary is non-empty", async () => {
    const result = await triage("Review PR for payment module");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("localModelUsed is false in test mode (VITEST env var)", async () => {
    const result = await triage("Any task");
    expect(result.localModelUsed).toBe(false);
  });
});

// ── Category detection ────────────────────────────────────────────────────────

describe("triageIncomingItem — category detection", () => {
  it("'bug' trigger words → category=bug", async () => {
    expect((await triage("Fix the regression in auth")).category).toBe("bug");
    expect((await triage("Debug the broken API endpoint")).category).toBe("bug");
    expect((await triage("Failing tests in checkout flow")).category).toBe("bug");
  });

  it("'feature' trigger words → category=feature", async () => {
    expect((await triage("Implement OAuth login")).category).toBe("feature");
    expect((await triage("Build new dashboard widget")).category).toBe("feature");
    expect((await triage("Add dark mode support")).category).toBe("feature");
    expect((await triage("Create user settings page")).category).toBe("feature");
  });

  it("'system' / outage keywords → category=system", async () => {
    expect((await triage("OUTAGE: payment service is down")).category).toBe("system");
    expect((await triage("Incident: SEV1 alert triggered")).category).toBe("system");
    expect((await triage("Exception in production worker")).category).toBe("system");
  });

  it("'research' keywords → category=research", async () => {
    expect((await triage("Research new caching strategies")).category).toBe("research");
    expect((await triage("Investigate memory leak cause")).category).toBe("research");
    expect((await triage("Analyze competitor pricing")).category).toBe("research");
  });

  it("'documentation' keywords → category=documentation", async () => {
    expect((await triage("Update the README for new setup")).category).toBe("documentation");
    expect((await triage("Write up the onboarding guide")).category).toBe("documentation");
    // "docs" is a direct doc keyword; "document" alone doesn't match \bdoc\b
    expect((await triage("Review docs for the API")).category).toBe("documentation");
  });

  it("'review' keywords → category=review", async () => {
    expect((await triage("Review pull request #123")).category).toBe("review");
    expect((await triage("QA the staging environment")).category).toBe("review");
    expect((await triage("Audit data pipeline configuration")).category).toBe("review");
  });

  it("'meeting' keywords → category=meeting", async () => {
    expect((await triage("Schedule meeting with design team")).category).toBe("meeting");
    expect((await triage("Calendar invite for sprint planning")).category).toBe("meeting");
  });

  it("kind=email with no specific keyword → category=email", async () => {
    const result = await triage("Checking in on project status", "", "email");
    expect(result.category).toBe("email");
  });

  it("kind=notification with no category-matching keyword → category=notification", async () => {
    // "build" matches the feature regex, so use a title without trigger keywords
    const result = await triage("Pipeline status update", "", "notification");
    expect(result.category).toBe("notification");
  });

  it("'administrative' keywords → category=administrative", async () => {
    expect((await triage("Approve the Q4 expense report")).category).toBe("administrative");
    expect((await triage("Process invoice from vendor")).category).toBe("administrative");
  });

  it("unrecognised text → category=other", async () => {
    expect((await triage("Do the thing")).category).toBe("other");
    expect((await triage("Miscellaneous stuff")).category).toBe("other");
  });

  it("content field contributes to category detection", async () => {
    const result = await triage("Ticket #4001", "This is a bug with the login form");
    expect(result.category).toBe("bug");
  });
});

// ── Urgency detection ─────────────────────────────────────────────────────────

describe("triageIncomingItem — urgency detection", () => {
  it("'ASAP' / 'urgent' → urgency=critical", async () => {
    expect((await triage("Fix this ASAP")).urgency).toBe("critical");
    expect((await triage("Urgent: server down")).urgency).toBe("critical");
    expect((await triage("P0 payment failure, fix immediately")).urgency).toBe("critical");
    expect((await triage("System blocked")).urgency).toBe("critical");
  });

  it("'today' / 'deadline' / 'important' → urgency=high", async () => {
    expect((await triage("Need this today")).urgency).toBe("high");
    expect((await triage("Deadline approaching for report")).urgency).toBe("high");
    expect((await triage("Important: review before meeting")).urgency).toBe("high");
    expect((await triage("Overdue task from last sprint")).urgency).toBe("high");
  });

  it("'this week' / 'follow up' → urgency=medium", async () => {
    expect((await triage("Review this week when you can")).urgency).toBe("medium");
    expect((await triage("Follow up on open issues")).urgency).toBe("medium");
    const r = await triage("Please review when you have time", "action needed");
    expect(r).toBeTruthy();
  });

  it("neutral / informational text → urgency=low", async () => {
    expect((await triage("Nice to have: add dark mode")).urgency).toBe("low");
    expect((await triage("Random thought about the codebase")).urgency).toBe("low");
  });

  it("SEV1 → urgency=critical (system category)", async () => {
    const result = await triage("SEV1 incident in production");
    expect(result.urgency).toBe("critical");
  });
});

// ── Route selection ───────────────────────────────────────────────────────────

describe("triageIncomingItem — route selection", () => {
  it("critical urgency → route=strong", async () => {
    const result = await triage("Fix this ASAP — system down");
    expect(result.route).toBe("strong");
  });

  it("system category → route=strong", async () => {
    const result = await triage("Outage detected in production");
    expect(result.route).toBe("strong");
  });

  it("security keyword → route=strong", async () => {
    const result = await triage("Security vulnerability in auth module");
    expect(result.route).toBe("strong");
  });

  it("architecture keyword → route=strong", async () => {
    const result = await triage("Plan the architecture for new microservice");
    expect(result.route).toBe("strong");
  });

  it("bug category → route=standard", async () => {
    const result = await triage("Fix the regression in payments");
    expect(result.route).toBe("standard");
  });

  it("feature category → route=standard", async () => {
    const result = await triage("Implement new notifications feature");
    expect(result.route).toBe("standard");
  });

  it("research category → route=standard", async () => {
    const result = await triage("Research new ML models for our use case");
    expect(result.route).toBe("standard");
  });

  it("low-urgency notification → route=defer", async () => {
    // "build" matches feature regex. Use a title without category-matching keywords.
    const result = await triage("Pipeline status update", "", "notification");
    expect(result.route).toBe("defer");
  });
});

// ── Model tier mapping ────────────────────────────────────────────────────────

describe("triageIncomingItem — model tier mapping", () => {
  it("strong route → modelTier=strong", async () => {
    const result = await triage("ASAP: fix critical prod issue");
    expect(result.modelTier).toBe("strong");
  });

  it("standard route with research/high urgency → modelTier=standard", async () => {
    const result = await triage("Research and analyze today's market data");
    expect(result.modelTier).toBe("standard");
  });

  it("defer route → modelTier=micro", async () => {
    const result = await triage("Pipeline status update", "", "notification");
    expect(result.modelTier).toBe("micro");
  });
});

// ── Agent selection ───────────────────────────────────────────────────────────

describe("triageIncomingItem — agent selection by category", () => {
  it("bug category → programmer agent", async () => {
    expect((await triage("Fix the broken tests")).agent).toBe("programmer");
  });

  it("feature category → programmer agent", async () => {
    expect((await triage("Implement new login flow")).agent).toBe("programmer");
  });

  it("system category → programmer agent", async () => {
    expect((await triage("OUTAGE: database is down")).agent).toBe("programmer");
  });

  it("research category → researcher agent", async () => {
    expect((await triage("Research best practices for caching")).agent).toBe("researcher");
  });

  it("documentation category → writer agent", async () => {
    expect((await triage("Update README with new setup steps")).agent).toBe("writer");
  });

  it("email category → writer agent", async () => {
    // Use a title without other category keywords so it falls to the email kind
    const result = await triage("Hello from the team", "", "email");
    expect(result.agent).toBe("writer");
  });

  it("review category → reviewer agent", async () => {
    expect((await triage("Review pull request for new checkout")).agent).toBe("reviewer");
  });

  it("meeting category → researcher agent", async () => {
    expect((await triage("Schedule sprint planning meeting")).agent).toBe("researcher");
  });
});

// ── shouldNotify and requiresAction ───────────────────────────────────────────

describe("triageIncomingItem — shouldNotify and requiresAction", () => {
  it("critical urgency → shouldNotify=true", async () => {
    const result = await triage("ASAP: emergency fix needed");
    expect(result.shouldNotify).toBe(true);
  });

  it("system category → shouldNotify=true", async () => {
    const result = await triage("Production outage detected");
    expect(result.shouldNotify).toBe(true);
  });

  it("low-priority notification → requiresAction=false", async () => {
    const result = await triage("Pipeline status update", "", "notification");
    expect(result.requiresAction).toBe(false);
  });

  it("standard-route task → requiresAction=true", async () => {
    const result = await triage("Fix this bug today");
    expect(result.requiresAction).toBe(true);
  });
});

// ── Summary truncation ────────────────────────────────────────────────────────

describe("triageIncomingItem — summary truncation", () => {
  it("short title appears verbatim in summary", async () => {
    const result = await triage("Fix auth bug");
    expect(result.summary).toContain("Fix auth bug");
  });

  it("very long title is truncated to ≤160 chars", async () => {
    const longTitle = "A ".repeat(100).trim(); // 199 chars
    const result = await triage(longTitle);
    expect(result.summary.length).toBeLessThanOrEqual(161); // 160 + ellipsis char
  });

  it("truncated summary ends with ellipsis (…)", async () => {
    const longTitle = "Important task: ".repeat(15).trim();
    const result = await triage(longTitle);
    if (result.summary.length > 160) {
      expect(result.summary.endsWith("…")).toBe(true);
    }
  });

  it("empty title falls back to content for summary", async () => {
    const result = await triage("", "This is the content to summarize");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("extra whitespace in title is collapsed in summary", async () => {
    const result = await triage("Fix   multiple   spaces  here");
    expect(result.summary).not.toContain("  ");
  });
});

// ── Priority scoring edge cases ───────────────────────────────────────────────

describe("triageIncomingItem — edge cases", () => {
  it("handles empty content gracefully", async () => {
    const result = await triage("Review open PRs");
    expect(result).toBeTruthy();
    expect(result.kind).toBe("task");
  });

  it("handles null content gracefully", async () => {
    const result = await triageIncomingItem({ kind: "task", title: "Check deployment", content: null });
    expect(result.summary).toBeTruthy();
  });

  it("uppercase title keywords still detected", async () => {
    const result = await triage("URGENT: FIX THE BROKEN DEPLOY");
    expect(result.urgency).toBe("critical");
  });

  it("p0 keyword triggers critical urgency", async () => {
    const result = await triage("P0 payment service failure");
    expect(result.urgency).toBe("critical");
  });

  it("p1 keyword triggers high urgency", async () => {
    const result = await triage("P1 checkout service slow");
    expect(result.urgency).toBe("high");
  });

  it("multiple urgency signals — highest wins", async () => {
    // 'asap' = critical, 'today' = high → critical wins because it's checked first
    const result = await triage("Need this today asap");
    expect(result.urgency).toBe("critical");
  });
});
