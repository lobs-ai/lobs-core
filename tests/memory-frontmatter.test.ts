/**
 * Unit tests for memory frontmatter parser.
 * @see src/util/memory-frontmatter.ts
 */

import { describe, it, expect } from "vitest";
import {
  parseMemoryFrontmatter,
  stripFrontmatter,
  isMemoryCompliant,
} from "../src/util/memory-frontmatter.js";

describe("parseMemoryFrontmatter", () => {
  it("returns non-compliant defaults when no frontmatter is present", () => {
    const result = parseMemoryFrontmatter("# My Memory\n\nSome content here.");
    expect(result.hasFrontmatter).toBe(false);
    expect(result.complianceRequired).toBe(false);
    expect(result.tags).toEqual([]);
  });

  it("parses compliance_required: true", () => {
    const content = `---
compliance_required: true
---
# Sensitive Memory
Student data here.`;
    const result = parseMemoryFrontmatter(content);
    expect(result.hasFrontmatter).toBe(true);
    expect(result.complianceRequired).toBe(true);
  });

  it("parses compliance_required: yes", () => {
    const content = `---
compliance_required: yes
---
Content`;
    expect(parseMemoryFrontmatter(content).complianceRequired).toBe(true);
  });

  it("parses compliance_required: false", () => {
    const content = `---
compliance_required: false
---
Content`;
    const result = parseMemoryFrontmatter(content);
    expect(result.hasFrontmatter).toBe(true);
    expect(result.complianceRequired).toBe(false);
  });

  it("parses inline tag array", () => {
    const content = `---
compliance_required: true
tags: [ferpa, student-data, pii]
---
Content`;
    const result = parseMemoryFrontmatter(content);
    expect(result.tags).toEqual(["ferpa", "student-data", "pii"]);
  });

  it("parses block-style tags", () => {
    const content = `---
compliance_required: true
tags:
  - ferpa
  - hipaa
---
Content`;
    const result = parseMemoryFrontmatter(content);
    expect(result.tags).toContain("ferpa");
    expect(result.tags).toContain("hipaa");
  });

  it("returns empty tags when no tags key", () => {
    const content = `---
compliance_required: true
---
Content`;
    expect(parseMemoryFrontmatter(content).tags).toEqual([]);
  });

  it("handles frontmatter with other keys", () => {
    const content = `---
title: My memory
date: 2026-03-06
compliance_required: true
---
Content`;
    expect(parseMemoryFrontmatter(content).complianceRequired).toBe(true);
  });
});

describe("stripFrontmatter", () => {
  it("removes frontmatter block", () => {
    const content = `---
compliance_required: true
---
# Actual content
Some text.`;
    const stripped = stripFrontmatter(content);
    expect(stripped).not.toContain("compliance_required");
    expect(stripped).toContain("# Actual content");
  });

  it("is a no-op when no frontmatter", () => {
    const content = "# Just content\nNo frontmatter here.";
    expect(stripFrontmatter(content)).toBe(content);
  });
});

describe("isMemoryCompliant", () => {
  it("returns true when file is in compliant dir", () => {
    expect(isMemoryCompliant({ inCompliantDir: true, content: "# regular content" })).toBe(true);
  });

  it("returns true when frontmatter declares compliance_required", () => {
    const content = `---
compliance_required: true
---
Sensitive`;
    expect(isMemoryCompliant({ inCompliantDir: false, content })).toBe(true);
  });

  it("returns false for regular file with no frontmatter", () => {
    expect(isMemoryCompliant({ inCompliantDir: false, content: "# Regular memory" })).toBe(false);
  });

  it("returns false for regular file with compliance_required: false frontmatter", () => {
    const content = `---
compliance_required: false
---
Safe content`;
    expect(isMemoryCompliant({ inCompliantDir: false, content })).toBe(false);
  });
});
