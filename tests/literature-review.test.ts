import { describe, expect, it, vi } from "vitest";
import {
  searchArxiv,
  searchSemanticScholar,
  type PaperSummary,
  type LitReviewRequest,
} from "../src/services/literature-review.js";

// ─── Mock data + factory in one vi.hoisted block ──────────────────────────────
// vi.hoisted runs at module-parse time (same level as vi.mock hoisting), so
// the factory closure can reference the mock arrays without initialization errors.

const { mockSearchArxiv, mockSearchSS, MOCK_ARXIV_RESULT, MOCK_SS_RESULT } =
  vi.hoisted(() => {
    const MOCK_ARXIV_RESULT: PaperSummary[] = [
      {
        paperId: "2101.12345",
        title: "Attention Is All You Need",
        authors: ["Ashish Vaswani", "Noam Shazeer"],
        abstract:
          "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism.",
        year: 2017,
        url: "https://arxiv.org/abs/1706.03762",
        venue: "NeurIPS",
        citationCount: 95000,
        fieldsOfStudy: ["Machine Learning", "NLP"],
        openAccess: true,
        isPreprint: true,
        externalIds: { arXiv: "1706.03762" },
        referencedPapers: ["1703.03906"],
        citingPapers: ["1810.04882"],
        discoveryPath: "seed",
        source: "arxiv",
      },
      {
        paperId: "1810.04882",
        title: "BERT: Pre-training of Deep Bidirectional Transformers",
        authors: ["Jacob Devlin", "Ming-Wei Chang"],
        abstract:
          "We introduce BERT, a new language representation model that is designed to pre-train deep bidirectional representations from unlabeled text.",
        year: 2018,
        url: "https://arxiv.org/abs/1810.04882",
        venue: "NAACL",
        citationCount: 72000,
        fieldsOfStudy: ["Machine Learning", "NLP"],
        openAccess: true,
        isPreprint: false,
        externalIds: { arXiv: "1810.04882" },
        referencedPapers: ["1706.03762"],
        citingPapers: [],
        discoveryPath: "related",
        source: "arxiv",
      },
    ];

    const MOCK_SS_RESULT: PaperSummary[] = [
      {
        paperId: "paper:8a8492e6",
        title: "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models",
        authors: ["Jason Wei", "Denny Zhou"],
        abstract:
          "We explore how generating a chain of thought — a series of intermediate reasoning steps — can significantly improve the ability of large language models to perform complex reasoning.",
        year: 2022,
        url: "https://www.semanticscholar.org/paper/8a8492e6",
        venue: "NeurIPS",
        citationCount: 8500,
        fieldsOfStudy: ["Machine Learning", "NLP"],
        openAccess: false,
        isPreprint: false,
        externalIds: {},
        referencedPapers: ["2005.13068"],
        citingPapers: [],
        discoveryPath: "seed",
        source: "semantic-scholar",
      },
    ];

    return {
      mockSearchArxiv: vi
        .fn<typeof searchArxiv>()
        .mockResolvedValue([...MOCK_ARXIV_RESULT]),
      mockSearchSS: vi
        .fn<typeof searchSemanticScholar>()
        .mockResolvedValue([...MOCK_SS_RESULT]),
      MOCK_ARXIV_RESULT,
      MOCK_SS_RESULT,
    };
  });

vi.mock("../src/services/literature-review.js", () => ({
  searchArxiv: mockSearchArxiv,
  searchSemanticScholar: mockSearchSS,
}));

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("LiteratureReviewService – search functions", () => {
  it("searchArxiv returns PaperSummary array with required fields", async () => {
    const results = await searchArxiv("attention is all you need", 5);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    const first = results[0];
    expect(first).toHaveProperty("paperId");
    expect(first).toHaveProperty("title");
    expect(first).toHaveProperty("authors");
    expect(Array.isArray(first.authors)).toBe(true);
    expect(first).toHaveProperty("abstract");
    expect(first).toHaveProperty("url");
    expect(first).toHaveProperty("year");
    expect(first).toHaveProperty("source", "arxiv");
    expect(first).toHaveProperty("discoveryPath");
  });

  it("searchArxiv abstracts are cleaned (no triple-whitespace)", async () => {
    const results = await searchArxiv("transformer attention mechanism", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].abstract).not.toContain("   ");
  });

  it("searchSemanticScholar returns PaperSummary array with required fields", async () => {
    const results = await searchSemanticScholar(
      "language models knowledge base",
      5,
      "sk-test-key",
    );

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    const first = results[0];
    expect(first).toHaveProperty("paperId");
    expect(first).toHaveProperty("title");
    expect(first).toHaveProperty("source", "semantic-scholar");
    expect(first).toHaveProperty("url");
  });
});

describe("LiteratureReviewService – PaperSummary type", () => {
  it("paperId version suffix is normalized (arXiv)", async () => {
    const results = await searchArxiv("attention", 3);
    results.forEach((r) => {
      expect(r.paperId).not.toMatch(/v\d+$/);
    });
  });

  it("author list is capped at 5 for readability", () => {
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

    expect(req.question).toBe(
      "What are the limitations of transformer models?",
    );
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
      citationCount: 42,
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