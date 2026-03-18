import { describe, expect, it } from "vitest";
import { applyDailyAnalysisToContent } from "../src/workers/memory-processor.js";
import { parseMemoryFrontmatter } from "../src/util/memory-frontmatter.js";

describe("applyDailyAnalysisToContent", () => {
  it("adds summary, tags, and carry-forward sections", () => {
    const updated = applyDailyAnalysisToContent("# 2026-03-17 — Daily Memory\n\n## Events\n\n- did work\n", {
      summaryBullets: ["- Shipped local memory worker", "- Added daily memory summaries"],
      tags: ["lobs-core", "memory-processing"],
      carryForward: ["- Verify the cron run in production"],
    });

    const frontmatter = parseMemoryFrontmatter(updated);
    expect(frontmatter.tags).toEqual(["lobs-core", "memory-processing"]);
    expect(updated).toContain("## Auto-Summary");
    expect(updated).toContain("- Shipped local memory worker");
    expect(updated).toContain("## Auto-Tags");
    expect(updated).toContain("`lobs-core` `memory-processing`");
    expect(updated).toContain("## Carry Forward");
  });

  it("replaces existing generated sections instead of duplicating them", () => {
    const original = `---
compliance_required: false
tags: [existing]
---
# Daily Memory

## Auto-Summary
- Old summary

## Auto-Tags
\`existing\`
`;

    const updated = applyDailyAnalysisToContent(original, {
      summaryBullets: ["- New summary"],
      tags: ["existing", "new-tag"],
      carryForward: [],
    });

    expect(updated.match(/## Auto-Summary/g)?.length).toBe(1);
    expect(updated).not.toContain("- Old summary");
    expect(updated).toContain("- New summary");
    expect(updated.match(/## Auto-Tags/g)?.length).toBe(1);

    const frontmatter = parseMemoryFrontmatter(updated);
    expect(frontmatter.tags).toEqual(["existing", "new-tag"]);
  });
});
