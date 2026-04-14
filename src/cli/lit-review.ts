#!/usr/bin/env node
/**
 * lit-review — Autonomous Literature Review CLI
 *
 * Usage:
 *   lit-review "transformer attention mechanisms in NLP"
 *   lit-review --depth 2 --papers 30 --tier standard "diffusion models for image synthesis"
 *   lit-review --output ./my-review --latex "federated learning privacy"
 *
 * Outputs (in --output dir, default: ./lit-review-<slug>-<date>):
 *   papers.json         All discovered papers with relevance metadata
 *   contradictions.md   Flagged claim conflicts across papers with source attribution
 *   related-work.md     Positioned draft related work section with citations
 *   full-review.md      Complete structured review (themes, gaps, analyses)
 *   review.tex          LaTeX source (only with --latex)
 *
 * Environment:
 *   S2_API_KEY          Semantic Scholar API key (optional but improves rate limits)
 *                       Set in ~/.lobs/config/secrets/api-keys.json as "semanticScholar"
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { runLiteratureReview } from "../services/literature-review.js";
import type { LiteratureReview, PaperSummary, Contradiction } from "../services/literature-review.js";

// ─── CLI Arg Parsing ──────────────────────────────────────────────────────────

interface CliArgs {
  topic: string;
  outputDir: string | null;
  depth: number;
  papers: number;
  tier: "micro" | "small" | "standard" | "strong";
  latex: boolean;
  seedCount: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // strip node + script
  const result: CliArgs = {
    topic: "",
    outputDir: null,
    depth: 1,
    papers: 20,
    tier: "small",
    latex: false,
    seedCount: 10,
    help: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--output":
      case "-o":
        result.outputDir = args[++i] ?? null;
        break;
      case "--depth":
      case "-d":
        result.depth = parseInt(args[++i] ?? "1", 10);
        break;
      case "--papers":
      case "-p":
        result.papers = parseInt(args[++i] ?? "20", 10);
        break;
      case "--seed-count":
        result.seedCount = parseInt(args[++i] ?? "10", 10);
        break;
      case "--tier":
      case "-t":
        result.tier = (args[++i] ?? "small") as CliArgs["tier"];
        break;
      case "--latex":
        result.latex = true;
        break;
      default:
        if (!arg.startsWith("--")) {
          positional.push(arg);
        }
        break;
    }
  }

  result.topic = positional.join(" ").trim();
  return result;
}

function printHelp(): void {
  console.log(`
lit-review — Autonomous Literature Review CLI

USAGE
  lit-review [options] "<research topic>"

ARGUMENTS
  topic             Research question or topic (wrap in quotes if multi-word)

OPTIONS
  -o, --output DIR  Output directory (default: ./lit-review-<slug>-<date>)
  -d, --depth N     Multi-hop expansion depth (default: 1, max: 3)
  -p, --papers N    Max papers to analyze (default: 20)
  --seed-count N    Initial seed papers per source (default: 10)
  -t, --tier TIER   LLM tier: micro|small|standard|strong (default: small)
  --latex           Also generate LaTeX output (review.tex)
  -h, --help        Show this help

OUTPUTS (in output directory)
  papers.json       All discovered papers with metadata and relevance scores
  contradictions.md Flagged claim conflicts across papers with source attribution
  related-work.md   Positioned draft related work section with inline citations
  full-review.md    Complete structured review (themes, gaps, detailed analyses)
  review.tex        LaTeX source (only with --latex)

ENVIRONMENT
  S2_API_KEY        Semantic Scholar API key (improves rate limits)
                    Add to ~/.lobs/config/secrets/api-keys.json as "semanticScholar"

EXAMPLES
  lit-review "transformer attention mechanisms in NLP"
  lit-review --depth 2 --papers 30 "diffusion models for image synthesis"
  lit-review --tier standard --latex "federated learning and differential privacy"
  lit-review -o ~/research/my-review "mixture of experts scaling laws"
`.trim());
}

// ─── S2 API Key Loader ────────────────────────────────────────────────────────

function loadS2ApiKey(): string | undefined {
  if (process.env.S2_API_KEY) return process.env.S2_API_KEY;

  try {
    const home = process.env.HOME ?? "/Users/lobs";
    const keyFile = join(home, ".lobs", "config", "secrets", "api-keys.json");
    const raw = readFileSync(keyFile, "utf-8");
    const keys = JSON.parse(raw) as Record<string, string>;
    return keys.semanticScholar ?? keys.s2 ?? undefined;
  } catch {
    return undefined;
  }
}

// ─── Output Builders ──────────────────────────────────────────────────────────

function buildPapersJson(review: LiteratureReview): string {
  const output = {
    question: review.question,
    generatedAt: review.generatedAt,
    papersAnalyzed: review.papersAnalyzed,
    totalPapersDiscovered: review.totalPapersDiscovered,
    papers: review.topPapers.map((p, i) => ({
      rank: i + 1,
      paperId: p.paperId,
      title: p.title,
      authors: p.authors,
      year: p.year,
      citationCount: p.citationCount,
      source: p.source,
      url: p.url,
      pdfUrl: p.pdfUrl,
      abstract: p.abstract,
      tldr: p.tldr ?? null,
      fields: p.fields,
      discoveryPath: p.discoveryPath,
    })),
    expansionGraph: review.expansionGraph,
    tokensUsed: review.tokensUsed,
  };
  return JSON.stringify(output, null, 2);
}

function buildContradictionsMarkdown(review: LiteratureReview): string {
  const lines: string[] = [];
  const date = review.generatedAt.split("T")[0];

  lines.push(`# Contradictions & Debates`);
  lines.push(`*Literature review: "${review.question}"*`);
  lines.push(`*Generated ${date} · ${review.papersAnalyzed} papers analyzed*`);
  lines.push("");

  if (review.contradictions.length === 0) {
    lines.push("No significant contradictions detected across the analyzed papers.");
    lines.push("");
    lines.push("This may indicate:");
    lines.push("- Strong consensus in the field");
    lines.push("- Papers represent different sub-problems rather than competing claims");
    lines.push("- The analysis scope was too narrow to surface debates");
    return lines.join("\n");
  }

  lines.push("## Summary");
  lines.push("");
  lines.push(`Found **${review.contradictions.length}** contested claim${review.contradictions.length === 1 ? "" : "s"} across the literature.`);
  lines.push("");
  lines.push("| # | Contested Claim | Papers For | Papers Against |");
  lines.push("|---|-----------------|-----------|----------------|");
  review.contradictions.forEach((c, i) => {
    const claim = c.claim.length > 60 ? c.claim.slice(0, 57) + "…" : c.claim;
    lines.push(`| ${i + 1} | ${claim} | ${c.supportedBy.length} | ${c.contradictedBy.length} |`);
  });
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Detailed Contradictions");
  lines.push("");

  review.contradictions.forEach((c: Contradiction, i: number) => {
    lines.push(`### ${i + 1}. ${c.claim}`);
    lines.push("");

    if (c.supportedBy.length > 0) {
      lines.push("**Papers supporting this claim:**");
      c.supportedBy.forEach(title => lines.push(`- ${title}`));
      lines.push("");
    }

    if (c.contradictedBy.length > 0) {
      lines.push("**Papers contradicting this claim:**");
      c.contradictedBy.forEach(title => lines.push(`- ${title}`));
      lines.push("");
    }

    if (c.resolution) {
      lines.push("**Possible resolution:**");
      lines.push(`> ${c.resolution}`);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  });

  lines.push("## Paper Index");
  lines.push("");
  lines.push("For full citation details, see `papers.json`.");
  lines.push("");
  review.topPapers.slice(0, 15).forEach((p: PaperSummary, i: number) => {
    const authStr = p.authors.slice(0, 2).join(", ") + (p.authors.length > 2 ? " et al." : "");
    const urlPart = p.url ? ` — [link](${p.url})` : "";
    lines.push(`${i + 1}. **${p.title}** (${authStr}, ${p.year ?? "??"})${urlPart}`);
  });

  return lines.join("\n");
}

function buildRelatedWorkMarkdown(review: LiteratureReview): string {
  const lines: string[] = [];
  const date = review.generatedAt.split("T")[0];

  lines.push(`# Related Work Draft`);
  lines.push(`*Research topic: "${review.question}"*`);
  lines.push(`*Generated ${date} · Based on ${review.papersAnalyzed} papers · Draft for human editing*`);
  lines.push("");
  lines.push("> ⚠️ **This is an AI-generated draft.** Verify all claims and citations before including in a submission.");
  lines.push("> Citations use paper titles as placeholders — replace with proper `[Author et al., YEAR]` format for your target venue.");
  lines.push("");
  lines.push("---");
  lines.push("");

  // Build citation index: title → [N]
  const citeMap = new Map<string, number>();
  review.topPapers.forEach((p, i) => {
    citeMap.set(p.title, i + 1);
  });

  // Find closest citation ref for a title mention (fuzzy match on prefix)
  function citeRef(title: string): string {
    const exact = citeMap.get(title);
    if (exact !== undefined) return `[${exact}]`;
    const lowerTitle = title.toLowerCase();
    for (const [key, num] of citeMap.entries()) {
      if (lowerTitle.includes(key.toLowerCase().slice(0, 25)) ||
          key.toLowerCase().includes(lowerTitle.slice(0, 25))) {
        return `[${num}]`;
      }
    }
    return "";
  }

  lines.push("## Related Work");
  lines.push("");

  if (review.themes.length > 0) {
    const strongThemes = review.themes.filter(t => t.consensus === "strong");
    const emergingThemes = review.themes.filter(t => t.consensus === "emerging");
    const contestedThemes = review.themes.filter(t => t.consensus === "contested");

    // Established consensus themes
    if (strongThemes.length > 0) {
      for (const theme of strongThemes) {
        const refs = theme.supportingPapers
          .slice(0, 3)
          .map(t => citeRef(t))
          .filter(Boolean)
          .join(", ");
        lines.push(`**${theme.name}.** ${theme.description}` + (refs ? ` ${refs}` : ""));
        lines.push("");
      }
    }

    // Emerging and contested themes
    const activeThemes = [...emergingThemes, ...contestedThemes];
    if (activeThemes.length > 0) {
      lines.push("More recently, several directions have emerged with less consensus.");
      lines.push("");
      for (const theme of activeThemes) {
        const refs = theme.supportingPapers
          .slice(0, 3)
          .map(t => citeRef(t))
          .filter(Boolean)
          .join(", ");
        const label = theme.consensus === "contested" ? "contested" : "emerging";
        lines.push(`**${theme.name}** *(${label})*. ${theme.description}` + (refs ? ` ${refs}` : ""));
        lines.push("");
      }
    }

    // Open debates
    if (review.contradictions.length > 0) {
      lines.push("### Open Debates");
      lines.push("");
      lines.push("The literature is not fully settled on several key questions:");
      lines.push("");
      for (const c of review.contradictions) {
        const forRefs = c.supportedBy.slice(0, 2).map(t => citeRef(t)).filter(Boolean).join(", ");
        const againstRefs = c.contradictedBy.slice(0, 2).map(t => citeRef(t)).filter(Boolean).join(", ");
        let debate = `- **${c.claim}**`;
        const refParts: string[] = [];
        if (forRefs) refParts.push(`supported: ${forRefs}`);
        if (againstRefs) refParts.push(`contested: ${againstRefs}`);
        if (refParts.length > 0) debate += ` (${refParts.join("; ")})`;
        lines.push(debate);
        if (c.resolution) {
          lines.push(`  *Possible resolution: ${c.resolution}*`);
        }
      }
      lines.push("");
    }

    // Gap bridge to the new work
    if (review.gaps.length > 0) {
      lines.push("### Positioning");
      lines.push("");
      lines.push("Despite this progress, several gaps remain:");
      lines.push("");
      for (const gap of review.gaps) {
        lines.push(`- ${gap}`);
      }
      lines.push("");
      lines.push("Our work addresses [DESCRIBE YOUR CONTRIBUTION HERE], directly targeting the gap described above.");
      lines.push("");
    }
  } else {
    lines.push("*The synthesis engine found insufficient papers to generate structured themes.*");
    lines.push("*See `full-review.md` for the complete analysis and `papers.json` for the paper list.*");
    lines.push("");
  }

  // References
  lines.push("---");
  lines.push("");
  lines.push("## References");
  lines.push("");
  lines.push("*Replace these with your venue's citation format (BibTeX, numbered, etc.)*");
  lines.push("");
  review.topPapers.forEach((p: PaperSummary, i: number) => {
    const authStr = p.authors.length > 0
      ? p.authors.slice(0, 3).join(", ") + (p.authors.length > 3 ? ", et al." : "")
      : "Unknown authors";
    const yearStr = p.year ? ` (${p.year})` : "";
    const urlStr = p.url ? `\n   ${p.url}` : "";
    lines.push(`[${i + 1}] ${authStr}${yearStr}. "${p.title}."${urlStr}`);
  });

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSlug(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 50);
}

function resolveOutputDir(topic: string, override: string | null): string {
  if (override) return resolve(override);
  const date = new Date().toISOString().slice(0, 10);
  const slug = makeSlug(topic);
  return resolve(`lit-review-${slug}-${date}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.topic) {
    console.error("Error: research topic is required");
    console.error('Usage: lit-review "your research topic here"');
    console.error("       lit-review --help for full options");
    process.exit(1);
  }

  const validTiers = ["micro", "small", "standard", "strong"];
  if (!validTiers.includes(args.tier)) {
    console.error(`Error: invalid tier "${args.tier}". Must be one of: ${validTiers.join(", ")}`);
    process.exit(1);
  }

  const s2ApiKey = loadS2ApiKey();
  if (s2ApiKey) {
    console.error("✓ Semantic Scholar API key found");
  } else {
    console.error("ℹ No Semantic Scholar API key — using free tier (1 req/sec)");
    console.error('  To add one: ~/.lobs/config/secrets/api-keys.json → { "semanticScholar": "<key>" }');
  }

  const outputDir = resolveOutputDir(args.topic, args.outputDir);
  console.error(`\n📁 Output directory: ${outputDir}`);
  console.error(`📖 Topic: "${args.topic}"`);
  console.error(`⚙  Config: depth=${args.depth}, papers=${args.papers}, tier=${args.tier}`);
  console.error("");
  console.error("🔍 Starting literature review...");

  const startTime = Date.now();
  let review: LiteratureReview;

  try {
    review = await runLiteratureReview({
      question: args.topic,
      seedCount: args.seedCount,
      expansionDepth: args.depth,
      maxPapers: args.papers,
      tier: args.tier,
      ssApiKey: s2ApiKey,
      outputFormat: args.latex ? "both" : "markdown",
    });
  } catch (err) {
    console.error("\n❌ Literature review failed:", (err as Error).message);
    if (process.env.DEBUG) console.error((err as Error).stack);
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n✅ Review complete in ${elapsed}s`);
  console.error(`   Papers discovered: ${review.totalPapersDiscovered}`);
  console.error(`   Papers analyzed:   ${review.papersAnalyzed}`);
  console.error(`   Themes found:      ${review.themes.length}`);
  console.error(`   Gaps identified:   ${review.gaps.length}`);
  console.error(`   Contradictions:    ${review.contradictions.length}`);
  console.error(`   Tokens used:       ${review.tokensUsed.toLocaleString()}`);
  console.error("");

  mkdirSync(outputDir, { recursive: true });

  writeFileSync(join(outputDir, "papers.json"), buildPapersJson(review), "utf-8");
  console.error(`📄 papers.json         (${review.topPapers.length} papers)`);

  writeFileSync(join(outputDir, "contradictions.md"), buildContradictionsMarkdown(review), "utf-8");
  console.error(`⚡ contradictions.md   (${review.contradictions.length} detected)`);

  writeFileSync(join(outputDir, "related-work.md"), buildRelatedWorkMarkdown(review), "utf-8");
  console.error(`✍️  related-work.md     (draft with ${review.themes.length} themes)`);

  writeFileSync(join(outputDir, "full-review.md"), review.markdown, "utf-8");
  console.error(`📚 full-review.md      (complete structured review)`);

  if (args.latex && review.latex) {
    writeFileSync(join(outputDir, "review.tex"), review.latex, "utf-8");
    console.error(`📐 review.tex          (LaTeX source)`);
  }

  console.error("");
  console.error(`Done. Files written to: ${outputDir}`);

  // Structured JSON summary to stdout for scripting
  const summary = {
    topic: review.question,
    outputDir,
    papersAnalyzed: review.papersAnalyzed,
    totalDiscovered: review.totalPapersDiscovered,
    themes: review.themes.length,
    gaps: review.gaps.length,
    contradictions: review.contradictions.length,
    tokensUsed: review.tokensUsed,
    elapsedSeconds: parseFloat(elapsed),
    files: [
      join(outputDir, "papers.json"),
      join(outputDir, "contradictions.md"),
      join(outputDir, "related-work.md"),
      join(outputDir, "full-review.md"),
      ...(args.latex && review.latex ? [join(outputDir, "review.tex")] : []),
    ],
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

main().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
