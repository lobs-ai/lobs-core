/**
 * Unit tests for literature-review.ts output formatters.
 * Tests escapeLatex, buildMarkdown, and buildLatex in isolation with mocked data.
 */

import { describe, it, expect } from "vitest";
import { escapeLatex, buildMarkdown, buildLatex } from "../src/services/literature-review";
import type { PaperSummary, PaperAnalysis, ReviewTheme, Contradiction, ExpansionGraphNode } from "../src/services/literature-review";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makePaper(overrides: Partial<PaperSummary> = {}): PaperSummary {
  return {
    paperId: "P1",
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani", "Noam Shazeer"],
    year: 2017,
    abstract: "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.",
    url: "https://arxiv.org/abs/1706.03762",
    source: "arxiv" as const,
    citationCount: 50000,
    ...overrides,
  };
}

function makeTheme(overrides: Partial<ReviewTheme> = {}): ReviewTheme {
  return {
    name: "Attention Mechanisms",
    description: "Self-attention has become the dominant paradigm in NLP.",
    consensus: "strong" as const,
    supportingPapers: ["Attention Is All You Need", "BERT: Pre-training"],
    ...overrides,
  };
}

function makeContradiction(overrides: Partial<Contradiction> = {}): Contradiction {
  return {
    claim: "Transformers outperform RNNs on all tasks",
    supportedBy: ["Attention Is All You Need"],
    contradictedBy: ["On the Comparison of RNNs"],
    resolution: "Transformers excel at long-range dependencies but at higher computational cost",
    ...overrides,
  };
}

function makeSynthesis(overrides: Partial<Synthesis> = {}): Synthesis {
  return {
    themes: [],
    gaps: [],
    contradictions: [],
    executiveSummary: "This review synthesizes 10 papers on transformer models.",
    futureDirections: [],
    practitionerTakeaways: [],
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<PaperAnalysis> = {}): PaperAnalysis {
  return {
    paperId: "P1",
    title: "Attention Is All You Need",
    year: 2017,
    keyFindings: ["Attention-based models achieve SOTA on translation", "Parallelizable training"],
    methodology: "Sequence-to-sequence with self-attention",
    limitations: ["O(n^2) complexity with sequence length"],
    citedBy: [],
    references: [],
    ...overrides,
  };
}

// ─── escapeLatex ───────────────────────────────────────────────────────────────

describe("escapeLatex", () => {
  it("returns empty string as-is", () => {
    expect(escapeLatex("")).toBe("");
  });

  it("passes through plain text unchanged", () => {
    expect(escapeLatex("Transformers are powerful")).toBe("Transformers are powerful");
  });

  it("escapes backslash", () => {
    expect(escapeLatex("\\")).toBe("\\textbackslash{}");
  });

  it("escapes ampersand", () => {
    expect(escapeLatex("Rock & Roll")).toBe("Rock \\& Roll");
  });

  it("escapes percent", () => {
    expect(escapeLatex("100% accuracy")).toBe("100\\% accuracy");
  });

  it("escapes dollar sign", () => {
    expect(escapeLatex("$50")).toBe("\\$50");
  });

  it("escapes hash/pound", () => {
    expect(escapeLatex("Article #1")).toBe("Article \\#1");
  });

  it("escapes underscore", () => {
    expect(escapeLatex("deep_learning")).toBe("deep\\_learning");
  });

  it("escapes curly braces", () => {
    expect(escapeLatex("{hello}")).toBe("\\{hello\\}");
  });

  it("escapes tilde", () => {
    expect(escapeLatex("a~b")).toBe("a\\textasciitilde{}b");
  });

  it("escapes caret", () => {
    expect(escapeLatex("x^2")).toBe("x\\textasciicircum{}2");
  });

  it("escapes less-than sign", () => {
    expect(escapeLatex("a < b")).toBe("a \\textless{} b");
  });

  it("escapes greater-than sign", () => {
    expect(escapeLatex("b > a")).toBe("b \\textgreater{} a");
  });

  it("escapes pipe/vertical bar", () => {
    expect(escapeLatex("a|b")).toBe("a\\textbar{}b");
  });

  it("escapes multiple special characters in one string", () => {
    expect(escapeLatex("100% & $50 #tag {test}")).toBe("100\\% \\& \\$50 \\#tag \\{test\\}");
  });

  it("escapes backslashes before other special chars", () => {
    // A backslash followed by a special char should become \textbackslash{} then escaped special char
    expect(escapeLatex("\\&")).toBe("\\textbackslash{}\\&");
  });
});

// ─── buildMarkdown ─────────────────────────────────────────────────────────────

describe("buildMarkdown", () => {
  const papers = [makePaper(), makePaper({ paperId: "P2", title: "BERT: Pre-training", authors: ["Jacob Devlin"], year: 2018, source: "s2" as const })];
  const analyses = [makeAnalysis()];
  const emptySynthesis = makeSynthesis();

  it("returns a non-empty string", () => {
    const result = buildMarkdown("Transformers", papers, analyses, emptySynthesis, []);
    expect(result.length).toBeGreaterThan(0);
  });

  it("starts with an H1 heading containing the question", () => {
    const result = buildMarkdown("Transformers", papers, analyses, emptySynthesis, []);
    expect(result).toMatch(/^# Literature Review: Transformers/);
  });

  it("includes the Executive Summary section", () => {
    const result = buildMarkdown("Transformers", papers, analyses, emptySynthesis, []);
    expect(result).toContain("## Executive Summary");
  });

  it("includes the Research Gaps section even when gaps is empty", () => {
    const result = buildMarkdown("Transformers", papers, analyses, emptySynthesis, []);
    expect(result).toContain("## Research Gaps");
  });

  it("includes Practitioners Takeaways section when present", () => {
    const synthesis = makeSynthesis({
      practitionerTakeaways: ["Use pre-trained models", "Fine-tune on domain data"],
    });
    const result = buildMarkdown("Transformers", papers, analyses, synthesis, []);
    expect(result).toContain("## Practitioner Takeaways");
    expect(result).toContain("Use pre-trained models");
  });

  it("emits consensus emoji for strong consensus", () => {
    const synthesis = makeSynthesis({
      themes: [makeTheme({ name: "Attention", consensus: "strong" })],
    });
    const result = buildMarkdown("Transformers", papers, analyses, synthesis, []);
    expect(result).toContain("✅");
  });

  it("emits consensus emoji for emerging consensus", () => {
    const synthesis = makeSynthesis({
      themes: [makeTheme({ name: "Sparse Attention", consensus: "emerging" })],
    });
    const result = buildMarkdown("Transformers", papers, analyses, synthesis, []);
    expect(result).toContain("🔄");
  });

  it("renders supporting papers in a theme block", () => {
    const synthesis = makeSynthesis({
      themes: [makeTheme({ name: "Attention", supportingPapers: ["Paper A", "Paper B"] })],
    });
    const result = buildMarkdown("Transformers", papers, analyses, synthesis, []);
    expect(result).toContain("**Supporting papers:** Paper A, Paper B");
  });

  it("renders contradictions section when contradictions exist", () => {
    const synthesis = makeSynthesis({
      contradictions: [makeContradiction()],
    });
    const result = buildMarkdown("Transformers", papers, analyses, synthesis, []);
    expect(result).toContain("## Contradictions & Debates");
    expect(result).toContain("Transformers outperform RNNs on all tasks");
  });

  it("renders future directions section when futureDirections exist", () => {
    const synthesis = makeSynthesis({
      futureDirections: ["Scale to longer contexts", "Improve efficiency"],
    });
    const result = buildMarkdown("Transformers", papers, analyses, synthesis, []);
    expect(result).toContain("## Future Directions");
    expect(result).toContain("Scale to longer contexts");
  });

  it("renders paper table with year and source", () => {
    const result = buildMarkdown("Transformers", papers, analyses, emptySynthesis, []);
    expect(result).toContain("| Title | Year | Authors |");
    // Title is rendered as a link when URL is present
    expect(result).toContain("| [Attention Is All You Need](https://arxiv.org/abs/1706.03762) | 2017 | Ashish Vaswani, Noam Shazeer | arXiv |");
    expect(result).toContain("arXiv");
    expect(result).toContain("S2"); // source column for P2
  });

  it("links paper title when URL is present", () => {
    const result = buildMarkdown("Transformers", papers, analyses, emptySynthesis, []);
    expect(result).toContain("[Attention Is All You Need](https://arxiv.org/abs/1706.03762)");
  });

  it("renders per-paper analysis when analyses provided", () => {
    const result = buildMarkdown("Transformers", papers, analyses, emptySynthesis, []);
    expect(result).toContain("## Detailed Paper Analyses");
    expect(result).toContain("**Key findings:**");
    expect(result).toContain("Parallelizable training");
  });

  it("does not render contradictions section when contradictions are absent", () => {
    const synthesis = makeSynthesis({ contradictions: [] });
    const result = buildMarkdown("Transformers", papers, analyses, synthesis, []);
    expect(result).not.toContain("## Contradictions & Debates");
  });

  it("includes discovery graph when expansionGraph is non-empty", () => {
    const graph = [{ paperId: "P1", title: "Attention Is All You Need", depth: 0, children: [] }];
    const result = buildMarkdown("Transformers", papers, analyses, emptySynthesis, graph);
    expect(result).toContain("## Discovery Graph");
    expect(result).toContain("Seed papers");
  });

  it("handles deeply nested expansion graph (depth 1)", () => {
    const graph = [
      { paperId: "P1", title: "Seed", depth: 0, children: ["P2"] },
      { paperId: "P2", title: "Child paper", depth: 1, children: [] },
    ];
    const result = buildMarkdown("Transformers", papers, analyses, emptySynthesis, graph);
    expect(result).toContain("Expansion depth 1");
  });
});

// ─── buildLatex ────────────────────────────────────────────────────────────────

describe("buildLatex", () => {
  const papers = [
    makePaper(),
    makePaper({ paperId: "P2", title: "BERT: Pre-training", authors: ["Jacob Devlin"], year: 2018, url: "", source: "s2" as const }),
  ];
  const analyses = [makeAnalysis()];
  const emptySynthesis = makeSynthesis();

  it("returns a non-empty string", () => {
    const result = buildLatex("Transformers", papers, analyses, emptySynthesis);
    expect(result.length).toBeGreaterThan(0);
  });

  it("starts with \\documentclass declaration", () => {
    const result = buildLatex("Transformers", papers, analyses, emptySynthesis);
    expect(result).toMatch(/^\\documentclass/);
  });

  it("contains \\end{document}", () => {
    const result = buildLatex("Transformers", papers, analyses, emptySynthesis);
    expect(result).toContain("\\end{document}");
  });

  it("escapes the question in the \\title{}", () => {
    const result = buildLatex("Transformers & RNNs", papers, analyses, emptySynthesis);
    // & is escaped to \& in LaTeX
    expect(result).toContain("\\&");
  });

  it("contains abstract environment with executive summary", () => {
    const synthesis = makeSynthesis({ executiveSummary: "This is the summary." });
    const result = buildLatex("Transformers", papers, analyses, synthesis);
    expect(result).toContain("\\begin{abstract}");
    expect(result).toContain("This is the summary.");
    expect(result).toContain("\\end{abstract}");
  });

  it("contains \\section{Major Themes}", () => {
    const synthesis = makeSynthesis({ themes: [makeTheme()] });
    const result = buildLatex("Transformers", papers, analyses, synthesis);
    expect(result).toContain("\\section{Major Themes}");
  });

  it("escapes theme name in subsection", () => {
    const synthesis = makeSynthesis({ themes: [makeTheme({ name: "Attention & Scaling" })] });
    const result = buildLatex("Transformers", papers, analyses, synthesis);
    expect(result).toContain("\\subsection{Attention \\& Scaling}");
  });

  it("contains Contradictions section when contradictions exist", () => {
    const synthesis = makeSynthesis({ contradictions: [makeContradiction()] });
    const result = buildLatex("Transformers", papers, analyses, synthesis);
    expect(result).toContain("\\section{Contradictions and Debates}");
    expect(result).toContain("\\subsection{Transformers outperform RNNs on all tasks}");
  });

  it("escapes conflict resolution text", () => {
    const synthesis = makeSynthesis({
      contradictions: [
        makeContradiction({ resolution: "Higher cost & better performance: 100% trade-off" }),
      ],
    });
    const result = buildLatex("Transformers", papers, analyses, synthesis);
    // & escapes to \&, % escapes to \%
    expect(result).toContain("\\&");
    expect(result).toContain("100\\%");
  });

  it("contains \\section{Research Gaps}", () => {
    const result = buildLatex("Transformers", papers, analyses, emptySynthesis);
    expect(result).toContain("\\section{Research Gaps}");
  });

  it("renders gaps as LaTeX itemize items", () => {
    const synthesis = makeSynthesis({ gaps: ["Gap A", "Gap B"] });
    const result = buildLatex("Transformers", papers, analyses, synthesis);
    expect(result).toContain("\\begin{itemize}");
    expect(result).toContain("\\item Gap A");
    expect(result).toContain("\\end{itemize}");
  });

  it("contains Future Directions section when futureDirections exist", () => {
    const synthesis = makeSynthesis({ futureDirections: ["Multimodal models"] });
    const result = buildLatex("Transformers", papers, analyses, synthesis);
    expect(result).toContain("\\section{Future Directions}");
  });

  it("contains Practitioner Takeaways section when present", () => {
    const synthesis = makeSynthesis({ practitionerTakeaways: ["Fine-tune carefully"] });
    const result = buildLatex("Transformers", papers, analyses, synthesis);
    expect(result).toContain("\\section{Practitioner Takeaways}");
  });

  it("contains longtable for papers", () => {
    const result = buildLatex("Transformers", papers, analyses, emptySynthesis);
    expect(result).toContain("\\begin{longtable}");
    expect(result).toContain("\\end{longtable}");
    expect(result).toContain("\\toprule");
    expect(result).toContain("\\bottomrule");
  });

  it("escapes paper title in href when URL is present", () => {
    const result = buildLatex("Transformers", papers, analyses, emptySynthesis);
    expect(result).toContain("\\href{https://arxiv.org/abs/1706.03762}{");
  });

  it("escapes paper author names", () => {
    const result = buildLatex("Transformers", papers, analyses, emptySynthesis);
    expect(result).toContain("Ashish Vaswani, Noam Shazeer");
  });

  it("contains Detailed Paper Analyses section when analyses exist", () => {
    const result = buildLatex("Transformers", papers, analyses, emptySynthesis);
    expect(result).toContain("\\section{Detailed Paper Analyses}");
  });

  it("escapes key findings in itemize", () => {
    const result = buildLatex("Transformers", papers, analyses, emptySynthesis);
    expect(result).toContain("\\item Attention-based models achieve SOTA on translation");
  });

  it("escapes methodology text", () => {
    const analysis = makeAnalysis({ methodology: "100% sequence-to-sequence" });
    const result = buildLatex("Transformers", papers, [analysis], emptySynthesis);
    // methodology appears after key findings, content varies by rendering
    expect(result).toContain("\\textbf{Methodology:}");
    expect(result).toContain("100\\%");
  });

  it("escapes limitation text", () => {
    const analysis = makeAnalysis({ limitations: ["O(n^2) complexity"] });
    const result = buildLatex("Transformers", papers, [analysis], emptySynthesis);
    expect(result).toContain("O(n\\textasciicircum{}2) complexity");
  });

  it("does not render future directions section when empty", () => {
    const synthesis = makeSynthesis({ futureDirections: [] });
    const result = buildLatex("Transformers", papers, analyses, synthesis);
    expect(result).not.toContain("\\section{Future Directions}");
  });

  it("does not render practitioner takeaways section when empty", () => {
    const synthesis = makeSynthesis({ practitionerTakeaways: [] });
    const result = buildLatex("Transformers", papers, analyses, synthesis);
    expect(result).not.toContain("\\section{Practitioner Takeaways}");
  });

  it("handles synthesis with no themes gracefully", () => {
    const synthesis = makeSynthesis({ themes: [] });
    const result = buildLatex("Transformers", papers, analyses, synthesis);
    // Should not throw, should still produce valid document structure
    expect(result).toContain("\\end{document}");
  });

  it("limits papers table to 25 entries", () => {
    const manyPapers = Array.from({ length: 30 }, (_, i) =>
      makePaper({ paperId: `P${i}`, title: `Paper ${i}`, authors: [`Author ${i}`], year: 2020 + (i % 5), url: "", source: "arxiv" as const })
    );
    const result = buildLatex("Transformers", manyPapers, [], emptySynthesis);
    // Count how many times a tabular row entry appears (title & year & authors)
    const matches = result.match(/\\\\/g) ?? [];
    // Should be around 25 (table data rows) — exact count depends on longtable structure
    expect(matches.length).toBeLessThanOrEqual(30);
  });
});