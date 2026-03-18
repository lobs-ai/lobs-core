import { afterEach, describe, expect, test, vi } from "vitest";
import type { UIAffordance } from "../src/types/plugin.js";
import { buildPromptPlan, buildRefinementPrompt, invokeAffordance } from "../src/api/plugins.js";
import { getModelForTier } from "../src/config/models.js";

describe("Draft generation plugin API", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("plans commit-message generation as a local-first draft", () => {
    const affordance: UIAffordance = {
      id: "commit-gen-button",
      type: "button",
      target: "pr-widget",
      label: "Generate commit message",
      aiAction: "generate",
      config: {
        template: "commit-message",
        modelTier: "micro",
        refinementTier: "standard",
      },
    };

    const plan = buildPromptPlan(affordance, "diff --git a/file.ts b/file.ts");

    expect(plan).toBeDefined();
    expect(plan?.mode).toBe("draft");
    expect(plan?.modelTier).toBe("micro");
    expect(plan?.draftKind).toBe("commit-message");
    expect(plan?.prompt).toContain("fast first draft only");
    expect(plan?.prompt).toContain("Return ONLY the commit message on one line");
  });

  test("plans PR description drafts with structured sections", () => {
    const affordance: UIAffordance = {
      id: "pr-description-draft",
      type: "button",
      target: "pr-widget",
      label: "Draft PR description",
      aiAction: "generate",
      config: {
        template: "pr-description",
        modelTier: "micro",
        refinementTier: "standard",
      },
    };

    const plan = buildPromptPlan(affordance, "Added retry handling and tests");

    expect(plan?.draftKind).toBe("pr-description");
    expect(plan?.prompt).toContain("Summary");
    expect(plan?.prompt).toContain("Changes");
    expect(plan?.prompt).toContain("Testing");
    expect(plan?.prompt).toContain("Risks / Follow-ups");
  });

  test("builds a stronger-model refinement prompt from the local draft", () => {
    const prompt = buildRefinementPrompt(
      {
        prompt: "draft prompt",
        modelTier: "micro",
        refinementTier: "strong",
        mode: "draft",
        draftKind: "doc-stub",
      },
      "Implement scheduling docs",
      "Title: Scheduling\nPurpose: TODO",
      "Tighten wording and fill obvious gaps.",
    );

    expect(prompt).toContain("smaller local model");
    expect(prompt).toContain("Implement scheduling docs");
    expect(prompt).toContain("Title: Scheduling");
    expect(prompt).toContain("Tighten wording and fill obvious gaps.");
  });

  test("runs generate affordances through local-first draft mode by default", async () => {
    const affordance: UIAffordance = {
      id: "doc-stub-draft",
      type: "button",
      target: "task-card",
      label: "Draft doc stub",
      aiAction: "generate",
      config: {
        template: "doc-stub",
        modelTier: "micro",
        refinementTier: "strong",
      },
    };

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        result: {
          content: [{ text: "Title: Draft Doc\nPurpose: placeholder" }],
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    global.fetch = fetchMock as typeof global.fetch;

    const result = await invokeAffordance(affordance, "Document the scheduler");

    expect(result.mode).toBe("draft");
    expect(result.modelTier).toBe("micro");
    expect(result.result).toBe("Title: Draft Doc\nPurpose: placeholder");

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload.args.model).toBe(getModelForTier("micro"));
  });

  test("optionally refines the local draft with a stronger model", async () => {
    const affordance: UIAffordance = {
      id: "test-scaffold-draft",
      type: "button",
      target: "task-card",
      label: "Draft test scaffold",
      aiAction: "generate",
      config: {
        template: "test-scaffold",
        modelTier: "micro",
        refinementTier: "strong",
      },
    };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          result: {
            content: [{ text: "describe('x', () => { it.todo('works'); })" }],
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          result: {
            content: [{ text: "describe('scheduler', () => { it.todo('handles retries'); });" }],
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    global.fetch = fetchMock as typeof global.fetch;

    const result = await invokeAffordance(affordance, "Add retry tests for scheduler", {
      refine: true,
      refinementNotes: "Use the scheduler naming from the codebase.",
    });

    expect(result.mode).toBe("refined");
    expect(result.draftModelTier).toBe("micro");
    expect(result.refinementModelTier).toBe("strong");
    expect(result.draft).toBe("describe('x', () => { it.todo('works'); })");
    expect(result.result).toBe("describe('scheduler', () => { it.todo('handles retries'); });");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const draftPayload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const refinePayload = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(draftPayload.args.model).toBe(getModelForTier("micro"));
    expect(refinePayload.args.model).toBe(getModelForTier("strong"));
    expect(String(refinePayload.args.task)).toContain("Use the scheduler naming from the codebase.");
    expect(String(refinePayload.args.task)).toContain("describe('x', () => { it.todo('works'); })");
  });
});
