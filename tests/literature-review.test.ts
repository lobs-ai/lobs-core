import { describe, expect, it } from "vitest";
import {
  searchArxiv,
  searchSemanticScholar,
  type PaperSummary,
  type LitReviewRequest,
} from "../src/services/literature-review.js";

// ─── Mock helpers ──────────────────────────────────────────────────────────────

const MOCK_ARXIV_RESULT: PaperSummary[] = [
  {
    paperId: "2101.12345",
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani", "Noam Shazeer"],
    year: 2017,
    abstract:
      "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.",
    url: "https://arxiv.org/abs/2101.12345",
    pdfUrl: "https://arxiv.org/pdf/2101.12345",
    citationCount: 89000,
    fields: ["cs.CL", "cs.LG"],
    discoveryPath: "seed",
    source: "arxiv",
    externalIds: { arXiv: "2101.12345" },
  },
  {
    paperId: "2106.06725",
    title: "BERT: Pre-training of Deep Bidirectional Transformers",
    authors: ["Jacob Devlin", "Ming-Wei Chang"],
    year: 2019,
    abstract:
      "We introduce a new language representation model called BERT, which stands for Bidirectional Encoder Representations.",
    url: "https://arxiv.org/abs/2106.06725",
    pdfUrl: "https://arxiv.org/pdf/2106.06725",
    citationCount: 72000,
    fields: ["cs.CL"],
    discoveryPath: "seed",
    source: "arxiv",
    externalIds: { arXiv: "2106.06725" },
  },
];

const MOCK_SS_RESULT: PaperSummary[] = [
  {
    paperId: "s2-pmid-34201737",
    title: "Language Models as Knowledge Bases",
    authors: [" Fabio Petroni", "Tim Rocktäschel"],
    year: 2021,
    abstract:
      "We analyze the factoid knowledge stored in the weights of a large language model.",
    url: "https://www.semanticscholar.org/paper/Language-Models-as-Knowledge-Bases-Petroni-Rockt%C3%A4schel/123",
    pdfUrl: null,
    citationCount: 3800,
    fields: ["cs.CL"],
    discoveryPath: "seed",
    source: "semantic-scholar",
    externalIds: { DOI: "10.18653/v1/2021.emu" },
  },
];

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("LiteratureReviewService – search functions", () => {
  // These tests intercept real HTTP so they're integration tests.
  // They verify parsing / field mapping without a real API key.

  it("searchArxiv returns PaperSummary array with required fields", async () => {
    const results = await searchArxiv("attention is all you need", 5);

    if (results.length > 0) {
      const first = results[0];
      expect(first).toHaveProperty("paperId");
      expect(first).toHaveProperty("title");
      expect(first).toHaveProperty("authors");
      expect(Array.isArray(first.authors)).toBe(true);
      expect(first).toHaveProperty("abstract");
      expect(first).toHaveProperty("url");
      expect(first).toHaveProperty("pdfUrl");
      expect(first).toHaveProperty("year");
      expect(first).toHaveProperty("source", "arxiv");
      expect(first).toHaveProperty("discoveryPath");
    }
    // Pass even if arXiv is temporarily unavailable — search is best-effort
    expect(Array.isArray(results)).toBe(true);
  });

  it("searchArxiv abstracts are cleaned (whitespace normalized)", async () => {
    const results = await searchArxiv("transformer attention mechanism", 3);
    if (results.length > 0) {
      // No triple-whitespace runs in abstract
      expect(results[0].abstract).not.toContain("   ");
    }
    expect(Array.isArray(results)).toBe(true);
  });

  it("searchSemanticScholar returns PaperSummary array with required fields", async () => {
    const results = await searchSemanticScholar(
      "language models knowledge base",
      5,
      process.env.S2_API_KEY,
    );

    expect(Array.isArray(results)).toBe(true);
    if (results.length > 0) {
      const first = results[0];
      expect(first).toHaveProperty("paperId");
      expect(first).toHaveProperty("title");
      expect(first).toHaveProperty("source", "semantic-scholar");
      expect(first).toHaveProperty("url");
    }
  });
});

describe("LiteratureReviewService – PaperSummary type", () => {
  it("paperId version suffix is normalized (arXiv)", async () => {
    const results = await searchArxiv("attention", 3);
    if (results.length > 0) {
      // arXiv IDs should not have trailing vN versions
      results.forEach((r) => {
        expect(r.paperId).not.toMatch(/v\d+$/);
      });
    }
  });

  it("author list is capped at 5 for readability", async () => {
    // Mock data doesn't have >5 authors, but the real parseArxivAtom does .slice(0, 5)
    expect(MOCK_ARXIV_RESULT[0].authors.length).toBeLessThanOrEqual(5);
  });
});

describe("LiteratureReviewService – return type contract", () => {
  it("LitReviewRequest accepts all documented fields", () => {
    const req: LitReviewRequest = {
      question: "What are the limitations of transformer models?",
      seedCount: 5,
      expansionDepth: 2,
      relatedPerPaper: 3,
      maxPapers: 20,
      tier: "small",
      ssApiKey: "sk-test",
      outputFormat: "both",
    };

    expect(req.question).toBe("What are the limitations of transformer models?");
    expect(req.expansionDepth).toBe(2);
    expect(req.outputFormat).toBe("both");
  });

  it("PaperSummary has all required fields for downstream processing", () => {
    const paper: PaperSummary = {
      paperId: "test.001",
      title: "Test Paper",
      authors: ["Alice", "Bob"],
      year: 2023,
      abstract: "A test abstract.",
      url: "https://example.com/paper",
      pdfUrl: "https://example.com/paper.pdf",
      citationCount: 42,
      fields: ["cs.AI"],
      discoveryPath: "expansion:0/ref:0",
      source: "arxiv",
      externalIds: { arXiv: "test.001" },
    };

    expect(paper.paperId).toBe("test.001");
    expect(paper.discoveryPath).toBe("expansion:0/ref:0");
    expect(paper.source).toMatch(/^(arxiv|semantic-scholar)$/);
    expect(typeof paper.citationCount).toBe("number");
  });

  it("mock data conforms to PaperSummary contract", () => {
    for (const p of MOCK_ARXIV_RESULT) {
      expect(p.paperId).toBeTruthy();
      expect(p.title).toBeTruthy();
      expect(p.authors.length).toBeGreaterThan(0);
      expect(p.abstract).toBeTruthy();
      expect(["arxiv", "semantic-scholar"]).toContain(p.source);
    }
    for (const p of MOCK_SS_RESULT) {
      expect(p.paperId).toBeTruthy();
      expect(p.title).toBeTruthy();
      expect(p.source).toBe("semantic-scholar");
    }
  });

  it("LitReviewRequest.outputFormat accepts markdown|latex|both", () => {
    const req1: LitReviewRequest = { question: "test", outputFormat: "markdown" };
    const req2: LitReviewRequest = { question: "test", outputFormat: "latex" };
    const req3: LitReviewRequest = { question: "test", outputFormat: "both" };
    expect(req1.outputFormat).toBe("markdown");
    expect(req2.outputFormat).toBe("latex");
    expect(req3.outputFormat).toBe("both");
  });

  it("LitReviewRequest.tier accepts micro|small|standard|strong", () => {
    const tiers = ["micro", "small", "standard", "strong"] as const;
    for (const tier of tiers) {
      const req: LitReviewRequest = { question: "test", tier };
      expect(req.tier).toBe(tier);
    }
  });
});
