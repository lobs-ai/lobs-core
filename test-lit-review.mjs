#!/usr/bin/env node

/**
 * Quick test of the literature review service
 * Run: node test-lit-review.mjs
 *
 * Full review test (takes ~2-3min): node test-lit-review.mjs --full
 * LaTeX output:                     node test-lit-review.mjs --full --latex
 */

import { runLiteratureReview, lookupPaper } from "./dist/services/literature-review.js";

const args = process.argv.slice(2);
const FULL = args.includes("--full");
const LATEX = args.includes("--latex");

async function test() {
  console.log("=== Literature Review Service Test ===\n");

  console.log("Testing lookupPaper...");
  try {
    const papers = await lookupPaper("attention is all you need transformer");
    console.log(`Found ${papers.length} papers:`);
    papers.slice(0, 4).forEach((p, i) => {
      const src = p.source === "arxiv" ? "arXiv" : "S2";
      console.log(`  ${i + 1}. [${src}] "${p.title}" (${p.year ?? "?"}, ${p.citationCount} citations)`);
      console.log(`     Path: ${p.discoveryPath}`);
    });
    console.log("✓ lookupPaper OK\n");
  } catch (err) {
    console.error("✗ lookupPaper failed:", err.message);
  }

  if (FULL) {
    console.log("Testing runLiteratureReview (multi-hop, depth=1)...");
    console.log("This will take ~2-3 minutes...\n");
    try {
      const review = await runLiteratureReview({
        question: "What are the latest advances in neural network attention mechanisms for long-context understanding?",
        seedCount: 8,
        maxPapers: 8,
        expansionDepth: 1,
        relatedPerPaper: 3,
        tier: "small",
        outputFormat: LATEX ? "both" : "markdown",
      });

      console.log(`\n✓ Review complete!`);
      console.log(`  Papers analyzed: ${review.papersAnalyzed}`);
      console.log(`  Total discovered: ${review.totalPapersDiscovered}`);
      console.log(`  Tokens used: ${review.tokensUsed}`);
      console.log(`  Themes: ${review.themes.length}`);
      console.log(`  Gaps identified: ${review.gaps.length}`);
      console.log(`  Contradictions: ${review.contradictions.length}`);

      // Show expansion graph summary
      if (review.expansionGraph.length > 0) {
        const depths = [...new Set(review.expansionGraph.map(n => n.depth))].sort();
        console.log(`\n  Discovery graph:`);
        for (const depth of depths) {
          const nodes = review.expansionGraph.filter(n => n.depth === depth);
          console.log(`    Depth ${depth}: ${nodes.length} papers`);
        }
      }

      console.log("\n--- Markdown preview (first 1000 chars) ---");
      console.log(review.markdown.slice(0, 1000));
      if (review.markdown.length > 1000) console.log("...(truncated)");

      if (review.latex) {
        console.log("\n--- LaTeX preview (first 300 chars) ---");
        console.log(review.latex.slice(0, 300));
        console.log("...(truncated)");
      }
    } catch (err) {
      console.error("✗ runLiteratureReview failed:", err.message);
      console.error(err.stack);
    }
  } else {
    console.log("(Skipping full review — pass --full to run it)");
  }
}

test().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
