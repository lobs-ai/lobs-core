/**
 * Memory frontmatter parser.
 *
 * Memory files optionally carry YAML front matter that declares compliance status:
 *
 *   ---
 *   compliance_required: true
 *   tags: [ferpa, student-data]
 *   ---
 *
 * This utility parses that frontmatter. It is used by:
 * - The memory scanner (to build the compliance index)
 * - memories-fs (for anomaly detection)
 *
 * Files WITHOUT frontmatter default to non-compliant (cloud-safe).
 * Directory placement (`memory-compliant/`) is the primary enforcement mechanism;
 * frontmatter is a secondary metadata/validation layer.
 */

export interface MemoryFrontmatter {
  /** True if this memory contains sensitive/regulated data (FERPA, HIPAA, SOC 2). */
  complianceRequired: boolean;
  /** Compliance-related tags (e.g., "ferpa", "hipaa", "pii"). */
  tags: string[];
  /** Raw frontmatter was present in the file. */
  hasFrontmatter: boolean;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

/**
 * Parse YAML front matter from memory file content.
 * Returns defaults (non-compliant, no tags) if no frontmatter is present.
 */
export function parseMemoryFrontmatter(content: string): MemoryFrontmatter {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { complianceRequired: false, tags: [], hasFrontmatter: false };
  }

  const block = match[1];

  // compliance_required: true|yes|1
  const compliantMatch = /^compliance_required\s*:\s*(.+)$/m.exec(block);
  let complianceRequired = false;
  if (compliantMatch) {
    const val = compliantMatch[1].trim().toLowerCase();
    complianceRequired = val === "true" || val === "yes" || val === "1";
  }

  // tags: [tag1, tag2] OR tags:\n  - tag1\n  - tag2
  const tags: string[] = [];
  const inlineTagsMatch = /^tags\s*:\s*\[([^\]]*)\]$/m.exec(block);
  if (inlineTagsMatch) {
    inlineTagsMatch[1].split(",").forEach(t => {
      const tag = t.trim().replace(/^['"]|['"]$/g, "");
      if (tag) tags.push(tag);
    });
  } else {
    // Block-style tags
    const blockTagsSection = /^tags\s*:\s*\n((?:[ \t]*-[ \t]+.+\n?)+)/m.exec(block);
    if (blockTagsSection) {
      blockTagsSection[1].split("\n").forEach(line => {
        const tag = line.replace(/^\s*-\s*/, "").trim().replace(/^['"]|['"]$/g, "");
        if (tag) tags.push(tag);
      });
    }
  }

  return { complianceRequired, tags, hasFrontmatter: true };
}

/**
 * Strip YAML frontmatter from memory file content.
 * Returns the content without the frontmatter block.
 */
export function stripFrontmatter(content: string): string {
  return content.replace(FRONTMATTER_RE, "");
}

/**
 * Build a normalized YAML frontmatter block for memory files.
 */
export function formatMemoryFrontmatter(frontmatter: {
  complianceRequired: boolean;
  tags: string[];
}): string {
  const uniqueTags = Array.from(
    new Set(frontmatter.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
  ).sort();
  const tagList = uniqueTags.length > 0 ? `[${uniqueTags.join(", ")}]` : "[]";
  return `---\ncompliance_required: ${frontmatter.complianceRequired}\ntags: ${tagList}\n---\n`;
}

/**
 * Rewrite a file's frontmatter while preserving its markdown body.
 */
export function upsertMemoryFrontmatter(
  content: string,
  updates: Partial<Pick<MemoryFrontmatter, "complianceRequired" | "tags">>,
): string {
  const current = parseMemoryFrontmatter(content);
  const body = stripFrontmatter(content).trimStart();
  return (
    formatMemoryFrontmatter({
      complianceRequired: updates.complianceRequired ?? current.complianceRequired,
      tags: updates.tags ?? current.tags,
    }) + body
  );
}

/**
 * Determine if a memory file is compliant (local-model-only) based on:
 * 1. Its directory placement (`memory-compliant/` → always compliant)
 * 2. Its frontmatter (as fallback/metadata)
 */
export function isMemoryCompliant(opts: {
  inCompliantDir: boolean;
  content: string;
}): boolean {
  if (opts.inCompliantDir) return true;
  const { complianceRequired } = parseMemoryFrontmatter(opts.content);
  return complianceRequired;
}
