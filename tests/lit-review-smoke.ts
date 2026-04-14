/**
 * E2E smoke test for the Literature Review service.
 * Runs a real multi-hop literature review against arXiv + Semantic Scholar APIs.
 * Run: npx tsx tests/lit-review-smoke.ts
 */

import { runLiteratureReview } from "../src/services/literature-review.js";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const OUT_FILE = "/tmp/lobs-lit-review-smoke.md";

interface TestResult {
  label: string;
  passed: boolean;
  durationSeconds: number;
  details?: string;
}

async function runSmoke() {
  console.log("=== Literature Review — E2E Smoke Test ===\n");
  console.log("Question: What are the latest advances in retrieval-augmented generation (RAG) for LLMs?\n");

  const results: TestResult[] = [];
  const start = Date.now();

  try {
    console.log("⏳ Running multi-hop literature review (depth=2, seed=3, related=3)...\n");

    const review = await runLiteratureReview({
      question: "What are the latest advances in retrieval-augmented generation (RAG) for LLMs?",
      seedCount: 3,
      expansionDepth: 2,
      relatedPerPaper: 3,
      maxPapers: 20,
      tier: "micro",
      outputFormat: "markdown",
    });

    const elapsed = (Date.now() - start) / 1000;

    // ── Validate structure ──────────────────────────────────────────
    const checks: [string, boolean][] = [
      ["has question", Boolean(review.question)],
      ["has generatedAt", Boolean(review.generatedAt)],
      ["has markdown", Boolean(review.markdown && review.markdown.length > 200)],
      ["has themes", Array.isArray(review.themes) && review.themes.length > 0],
      ["themes have names", review.themes.every((t) => Boolean(t.name))],
      ["has gaps", Array.isArray(review.gaps)],
      ["has contradictions", Array.isArray(review.contradictions)],
      ["has topPapers", Array.isArray(review.topPapers) && review.topPapers.length >= 3],
      ["papers have titles", review.topPapers.every((p) => Boolean(p.title))],
      ["papers have authors", review.topPapers.every((p) => p.authors.length > 0)],
      ["papers have discoveryPath", review.topPapers.every((p) => Boolean(p.discoveryPath))],
      ["has papersAnalyzed count", typeof review.papersAnalyzed === "number"],
      ["has tokensUsed", typeof review.tokensUsed === "number"],
      ["has expansionGraph", Array.isArray(review.expansionGraph)],
    ];

    if (review.markdown) {
      writeFileSync(OUT_FILE, review.markdown, "utf-8");
      console.log(`📄 Markdown written to: ${OUT_FILE}\n`);
    }

    // ── Report ──────────────────────────────────────────────────────
    console.log(`${"=".repeat(60)}`);
    console.log(`Results — completed in ${elapsed.toFixed(1)}s\n`);

    let allPassed = true;
    for (const [label, passed] of checks) {
      console.log(`  ${passed ? "✅" : "❌"} ${label}`);
      if (!passed) allPassed = false;
    }

    console.log(`\n📊 Stats:`);
    console.log(`  Papers found:  ${review.topPapers.length}`);
    console.log(`  Themes:        ${review.themes.length}`);
    console.log(`  Gaps:          ${review.gaps.length}`);
    console.log(`  Contradictions: ${review.contradictions.length}`);
    console.log(`  Markdown chars: ${review.markdown?.length ?? 0}`);

    // Discovery path breakdown
    const pathCounts: Record<string, number> = {};
    for (const paper of review.topPapers) {
      pathCounts[paper.discoveryPath] = (pathCounts[paper.discoveryPath] ?? 0) + 1;
    }
    console.log(`  Discovery paths: ${JSON.stringify(pathCounts)}`);

    // Source breakdown
    const sourceCounts: Record<string, number> = {};
    for (const paper of review.topPapers) {
      sourceCounts[paper.source] = (sourceCounts[paper.source] ?? 0) + 1;
    }
    console.log(`  Sources: ${JSON.stringify(sourceCounts)}`);

    results.push({
      label: "Multi-hop lit review (depth=2)",
      passed: allPassed,
      durationSeconds: elapsed,
      details: `${review.topPapers.length} papers, ${review.themes.length} themes`,
    });

    // ── Theme summary ───────────────────────────────────────────────
    if (review.themes.length > 0) {
      console.log(`\n📚 Top themes:`);
      for (const theme of review.themes.slice(0, 3)) {
        console.log(`  • [${theme.name}] — ${theme.paperCount} papers`);
      }
    }

    if (review.gaps.length > 0) {
      console.log(`\n🔍 Top gaps:`);
      for (const gap of review.gaps.slice(0, 3)) {
        console.log(`  • ${typeof gap === "string" ? gap : gap.hypothesis}`);
      }
    }

    // Cleanup
    try {
      if (existsSync(OUT_FILE)) unlinkSync(OUT_FILE);
    } catch {}

    // ── Summary ────────────────────────────────────────────────────
    console.log(`\n${"=".repeat(60)}`);
    console.log("Summary:");
    for (const r of results) {
      console.log(`  ${r.passed ? "✅" : "❌"} ${r.label} (${r.durationSeconds.toFixed(1)}s)`);
      if (r.details) console.log(`      ${r.details}`);
    }

    const allOk = results.every((r) => r.passed);
    console.log(`\n${allOk ? "✅ All checks passed!" : "❌ Some checks failed."}`);
    process.exit(allOk ? 0 : 1);
  } catch (err) {
    const elapsed = (Date.now() - start) / 1000;
    console.error(`\n❌ Fatal error after ${elapsed.toFixed(1)}s:`);
    console.error(err);
    process.exit(1);
  }
}

runSmoke();
