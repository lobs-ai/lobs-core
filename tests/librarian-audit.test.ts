import { describe, expect, it } from "vitest";
import { isKnownMirrorPath, isStalenessExempt } from "../src/runner/tools/librarian.js";

describe("librarian audit path filtering", () => {
  it("recognizes the lobs-brain shared-memory compatibility mirror", () => {
    expect(isKnownMirrorPath("/Users/lobs/lobs/lobs-brain/shared-memory/decisions/example.md")).toBe(true);
    expect(isKnownMirrorPath("/Users/lobs/lobs/lobs-shared-memory/decisions/example.md")).toBe(false);
  });

  it("exempts stable archival/context docs from age-only staleness alerts", () => {
    expect(isStalenessExempt("/Users/lobs/.lobs/agents/main/context/memory/archive/2026-04.md")).toBe(true);
    expect(isStalenessExempt("/Users/lobs/.lobs/agents/main/context/memory/weekly/2026-W18.md")).toBe(true);
    expect(isStalenessExempt("/Users/lobs/lobs/lobs-core/docs/archive/old-design.md")).toBe(true);
    expect(isStalenessExempt("/Users/lobs/.lobs/agents/main/context/PROJECT-lobs.md")).toBe(true);
    expect(isStalenessExempt("/Users/lobs/.lobs/agents/main/context/IDENTITY.md")).toBe(true);
    expect(isStalenessExempt("/Users/lobs/lobs/lobs-core/docs/current-runbook.md")).toBe(false);
  });
});
