import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  searchArxiv,
  searchSemanticScholar,
  type PaperSummary,
  type LitReviewRequest,
} from "../src/services/literature-review.js";

// ─── Mock data ─────────────────────────────────────────────────────────────

const MOCK_ARXIV_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2101.12345v1</id>
    <title>Attention Is All You Need</title>
    <summary>We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.</summary>
    <published>2017-12-05</published>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <link rel="alternate" type="text/html" href="http://arxiv.org/abs/2101.12345v1"/>
    <link title="pdf" type="application/pdf" href="http://arxiv.org/pdf/2101.12345v1"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2106.06725</id>
    <title>BERT: Pre-training of Deep Bidirectional Transformers</title>
    <summary>We introduce a new language representation model called BERT.</summary>
    <published>2018-10-11</published>
    <author><name>Jacob Devlin</name></author>
    <author><name>Ming-Wei Chang</name></author>
    <link rel="alternate" type="text/html" href="http://arxiv.org/abs/2106.06725"/>
    <link title="pdf" type="application/pdf" href="http://arxiv.org/pdf/2106.06725"/>
  </entry>
</feed>`;

const MOCK_SS_RESPONSE = {
  data: [
    {
      paperId: "s2-12345",
      title: "Language Models as Knowledge Bases",
      authors: [
        { name: "Fabio Petroni" },
        { name: "Tim Rocktäschel" },
      ],
      year: 2021,
      abstract: "We analyze the factoid knowledge stored in the weights of a large language model.",
      url: "https://www.semanticscholar.org/paper/12345",
      openAccessPdf: null,
      citationCount: 3800,
      fieldsOfStudy: ["Computer Science"],
      externalIds: { DOI: "10.18653/v1/2021" },
    },
  ],
};

// ─── Test setup ────────────────────────────────────────────────────────────

describe("LiteratureReviewService – mocked integration", () => {
  beforeEach(() => {
    // Mock global fetch for all tests in this suite
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.includes("arxiv.org")) {
          return new Response(MOCK_ARXIV_RESPONSE, {
            status: 200,
            headers: { "Content-Type": "application/atom+xml" },
          });
        }
        if (typeof url === "string" && url.includes("semanticscholar.org")) {
          return new Response(JSON.stringify(MOCK_SS_RESPONSE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      }),
    );
  });

  it("searchArxiv returns PaperSummary array with all required fields", async () => {
    const results = await searchArxiv("attention transformer", 5);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    const first = results[0];
    expect(first).toHaveProperty("paperId");
    expect(first).toHaveProperty("title");
    expect(first).toHaveProperty("authors");
    expect(first).toHaveProperty("abstract");
    expect(first).toHaveProperty("url");
    expect(first).toHaveProperty("pdfUrl");
    expect(first).toHaveProperty("year");
    expect(first).toHaveProperty("source", "arxiv");
    expect(first).toHaveProperty("discoveryPath");
  });

  it("searchArxiv normalizes paperId (strips version suffix)", async () => {
    const results = await searchArxiv("attention", 5);
    if (results.length > 0) {
      // Should strip 'v1' from ID
      expect(results[0].paperId).not.toMatch(/v\d+$/);
    }
  });

  it("searchArxiv cleans whitespace in abstracts", async () => {
    const results = await searchArxiv("transformer", 5);
    if (results.length > 0) {
      // No triple-whitespace runs
      expect(results[0].abstract).not.toContain("   ");
    }
  });

  it("searchSemanticScholar returns PaperSummary array", async () => {
    const results = await searchSemanticScholar("language models", 5, "test-key");

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    const first = results[0];
    expect(first).toHaveProperty("paperId");
    expect(first).toHaveProperty("title");
    expect(first).toHaveProperty("authors");
    expect(first).toHaveProperty("source", "semantic-scholar");
    expect(first).toHaveProperty("url");
  });

  it("searchSemanticScholar passes API key in header", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify(MOCK_SS_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await searchSemanticScholar("test query", 5, "sk-test-key-123");

    // Check that any call included the API key header
    const calls = mockFetch.mock.calls;
    const hasApiKeyCall = calls.some((call: any[]) => {
      const opts = call[1];
      return opts?.headers?.["x-api-key"] === "sk-test-key-123";
    });
    expect(hasApiKeyCall).toBe(true);
  });
});

describe("LiteratureReviewService – type contracts", () => {
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
    expect(req.tier).toBe("small");
  });

  it("PaperSummary has all required fields", () => {
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
    const mockPapers: PaperSummary[] = [
      {
        paperId: "2101.12345",
        title: "Attention Is All You Need",
        authors: ["Ashish Vaswani", "Noam Shazeer"],
        year: 2017,
        abstract: "We propose a new simple network architecture, the Transformer.",
        url: "https://arxiv.org/abs/2101.12345",
        pdfUrl: "https://arxiv.org/pdf/2101.12345",
        citationCount: 89000,
        fields: ["cs.CL", "cs.LG"],
        discoveryPath: "seed",
        source: "arxiv",
        externalIds: { arXiv: "2101.12345" },
      },
    ];

    for (const p of mockPapers) {
      expect(p.paperId).toBeTruthy();
      expect(p.title).toBeTruthy();
      expect(p.authors.length).toBeGreaterThan(0);
      expect(["arxiv", "semantic-scholar"]).toContain(p.source);
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
