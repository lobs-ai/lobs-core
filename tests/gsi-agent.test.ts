/**
 * GSI Agent Tests
 *
 * Tests pure functions in gsi-agent.ts:
 *   - parseAnswerWithConfidence: JSON confidence block extraction
 *   - extractCitations: inline citation + retrieval source harvesting
 *   - blendConfidence: LLM confidence + retrieval quality blending
 *   - registerEscalation / resolveEscalationForTA / resolveEscalationById: in-memory escalation store
 *   - getPendingEscalationTAIds / getPendingEscalationCount / getPendingEscalationSummary: store queries
 *   - formatAnswerForDiscord / formatEscalationDM / formatEscalationChannelReply: Discord formatting
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  parseAnswerWithConfidence,
  extractCitations,
  blendConfidence,
  registerEscalation,
  resolveEscalationForTA,
  resolveEscalationById,
  getPendingEscalationTAIds,
  getPendingEscalationCount,
  getPendingEscalationSummary,
  formatAnswerForDiscord,
  formatEscalationDM,
  formatEscalationChannelReply,
  type PendingEscalation,
  type GsiAnswer,
  type GsiEscalation,
} from "../src/gsi/gsi-agent.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEscalation(overrides: Partial<PendingEscalation> = {}): PendingEscalation {
  return {
    id: "ask-abc",
    taUserId: "ta-user-1",
    channelId: "ch-123",
    guildId: "guild-456",
    question: "What is a priority queue?",
    askedBy: "<@student-789>",
    courseName: "EECS 281",
    draftAnswer: "A priority queue is a data structure where elements have priorities...",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeAnswer(overrides: Partial<GsiAnswer> = {}): GsiAnswer {
  return {
    answer: "A priority queue orders elements by priority. [Source: Lecture 5]",
    confidence: 0.85,
    citations: ["Lecture 5"],
    shouldEscalate: false,
    retrievalResults: [],
    question: "What is a priority queue?",
    ...overrides,
  };
}

function makeSearchResult(score: number, source = "Lecture 5") {
  return { score, source, chunk: "sample content", metadata: {} };
}

// Reset the in-memory store before each test by draining all escalations
beforeEach(() => {
  // Drain all TAs
  const ids = getPendingEscalationTAIds();
  for (const taId of ids) {
    while (resolveEscalationForTA(taId) !== null) {
      // keep draining
    }
  }
});

// ── parseAnswerWithConfidence ─────────────────────────────────────────────────

describe("parseAnswerWithConfidence", () => {
  it("extracts confidence from JSON block at end of text", () => {
    const raw = 'A priority queue orders elements by priority. {"confidence": 0.9, "reason": "covered in lecture"}';
    const result = parseAnswerWithConfidence(raw);
    expect(result.confidence).toBeCloseTo(0.9);
    expect(result.confidenceReason).toBe("covered in lecture");
    expect(result.answerText).toBe("A priority queue orders elements by priority.");
  });

  it("defaults to 0.5 confidence when no JSON block present", () => {
    const raw = "Some answer without a confidence block.";
    const result = parseAnswerWithConfidence(raw);
    expect(result.confidence).toBe(0.5);
    expect(result.confidenceReason).toBe("unknown");
    expect(result.answerText).toBe("Some answer without a confidence block.");
  });

  it("clamps confidence to [0, 1]", () => {
    const raw = 'Answer. {"confidence": 1.5, "reason": "overconfident"}';
    const result = parseAnswerWithConfidence(raw);
    expect(result.confidence).toBe(1);
  });

  it("defaults to 0.5 when confidence value is negative (regex only matches digits)", () => {
    // The regex matches [0-9.]+ so negative numbers don't match → falls back to default 0.5.
    // This is acceptable: the LLM shouldn't return negative confidence; malformed input = default.
    const raw = 'Answer. {"confidence": -0.2, "reason": "negative"}';
    const result = parseAnswerWithConfidence(raw);
    expect(result.confidence).toBe(0.5);
  });

  it("handles whitespace variations in JSON block", () => {
    const raw = 'Answer here. { "confidence" : 0.75, "reason" : "partial coverage" }';
    const result = parseAnswerWithConfidence(raw);
    expect(result.confidence).toBeCloseTo(0.75);
    expect(result.confidenceReason).toBe("partial coverage");
  });

  it("removes the JSON block from the displayed answer text", () => {
    const raw = 'Final answer. {"confidence": 0.8, "reason": "well covered"}';
    const result = parseAnswerWithConfidence(raw);
    expect(result.answerText).not.toContain("confidence");
    expect(result.answerText).not.toContain("0.8");
  });

  it("handles JSON block in middle of text (uses full raw for answer minus block)", () => {
    const raw = 'Part one. {"confidence": 0.6, "reason": "partial"} Part two.';
    const result = parseAnswerWithConfidence(raw);
    expect(result.confidence).toBeCloseTo(0.6);
    expect(result.answerText).toContain("Part one");
    expect(result.answerText).toContain("Part two");
  });
});

// ── extractCitations ──────────────────────────────────────────────────────────

describe("extractCitations", () => {
  it("extracts inline [Source: X] citations from answer text", () => {
    const text = "Priority queues use heaps [Source: Lecture 5] as shown in [Source: Syllabus].";
    const citations = extractCitations(text, []);
    expect(citations).toContain("Lecture 5");
    expect(citations).toContain("Syllabus");
  });

  it("adds sources from top 3 retrieval results", () => {
    const results = [
      makeSearchResult(0.9, "Lecture 5"),
      makeSearchResult(0.8, "Homework 2"),
      makeSearchResult(0.7, "Syllabus"),
      makeSearchResult(0.6, "Piazza Post #42"),
    ];
    const citations = extractCitations("An answer with no inline cites.", results);
    expect(citations).toContain("Lecture 5");
    expect(citations).toContain("Homework 2");
    expect(citations).toContain("Syllabus");
    // Only top 3 — 4th should NOT be added
    expect(citations).not.toContain("Piazza Post #42");
  });

  it("deduplicates sources (inline cite + retrieval for same source)", () => {
    const results = [makeSearchResult(0.9, "Lecture 5")];
    const text = "Covered in [Source: Lecture 5].";
    const citations = extractCitations(text, results);
    const lectureCount = citations.filter(c => c === "Lecture 5").length;
    expect(lectureCount).toBe(1);
  });

  it("returns empty array when no cites and no retrieval results", () => {
    const citations = extractCitations("An answer with nothing.", []);
    expect(citations).toHaveLength(0);
  });

  it("is case-insensitive for [Source:] tag", () => {
    const text = "See [source: Lecture 5] or [SOURCE: HW2].";
    const citations = extractCitations(text, []);
    expect(citations).toContain("Lecture 5");
    expect(citations).toContain("HW2");
  });

  it("handles retrieval results with no source field gracefully", () => {
    const results = [{ score: 0.9, chunk: "some content", metadata: {} }] as any;
    expect(() => extractCitations("answer", results)).not.toThrow();
  });
});

// ── blendConfidence ───────────────────────────────────────────────────────────

describe("blendConfidence", () => {
  it("caps confidence at 0.3 when no retrieval results", () => {
    expect(blendConfidence(0.9, [])).toBe(0.3);
    expect(blendConfidence(0.1, [])).toBe(0.1); // already below cap
  });

  it("adds retrieval bonus for high-scoring results", () => {
    const results = [makeSearchResult(1.0), makeSearchResult(1.0)];
    // bonus = (1.0 * 0.6 + 1.0 * 0.4) * 0.2 = 0.2
    const blended = blendConfidence(0.7, results);
    expect(blended).toBeCloseTo(0.7 + 0.2, 2);
  });

  it("applies coverage penalty when only 1 result", () => {
    const results = [makeSearchResult(0.8)];
    // bonus ≈ 0.8 * 0.2 = 0.16; penalty = 0.1; net = +0.06
    const blended = blendConfidence(0.6, results);
    // (0.8*0.6 + 0.8*0.4)*0.2 - 0.1 = 0.16 - 0.1 = 0.06; 0.6 + 0.06 = 0.66
    expect(blended).toBeCloseTo(0.66, 2);
  });

  it("does not apply coverage penalty with 2+ results", () => {
    const results = [makeSearchResult(0.8), makeSearchResult(0.4)];
    // bonus = (0.8 * 0.6 + 0.6 * 0.4) * 0.2 = (0.48 + 0.24) * 0.2 = 0.144
    const blended = blendConfidence(0.5, results);
    const avgScore = (0.8 + 0.4) / 2; // 0.6
    const expectedBonus = (0.8 * 0.6 + avgScore * 0.4) * 0.2;
    expect(blended).toBeCloseTo(0.5 + expectedBonus, 3);
  });

  it("clamps result to [0, 1]", () => {
    const results = [makeSearchResult(1.0), makeSearchResult(1.0)];
    const blended = blendConfidence(0.99, results);
    expect(blended).toBeLessThanOrEqual(1);
    expect(blended).toBeGreaterThanOrEqual(0);
  });

  it("never returns negative", () => {
    const results = [makeSearchResult(0.0)];
    const blended = blendConfidence(0.05, results);
    expect(blended).toBeGreaterThanOrEqual(0);
  });
});

// ── Escalation Store ──────────────────────────────────────────────────────────

describe("Escalation Store", () => {
  describe("registerEscalation + resolveEscalationForTA", () => {
    it("resolves registered escalation for the correct TA", () => {
      const esc = makeEscalation({ id: "ask-001", taUserId: "ta-1" });
      registerEscalation(esc);
      const resolved = resolveEscalationForTA("ta-1");
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe("ask-001");
    });

    it("returns null for a TA with no escalations", () => {
      expect(resolveEscalationForTA("ta-nobody")).toBeNull();
    });

    it("queues FIFO — oldest escalation resolved first", () => {
      registerEscalation(makeEscalation({ id: "ask-first", taUserId: "ta-2", createdAt: Date.now() - 2000 }));
      registerEscalation(makeEscalation({ id: "ask-second", taUserId: "ta-2", createdAt: Date.now() - 1000 }));
      registerEscalation(makeEscalation({ id: "ask-third", taUserId: "ta-2", createdAt: Date.now() }));

      // They're inserted in order, FIFO resolves first registered first
      expect(resolveEscalationForTA("ta-2")!.id).toBe("ask-first");
      expect(resolveEscalationForTA("ta-2")!.id).toBe("ask-second");
      expect(resolveEscalationForTA("ta-2")!.id).toBe("ask-third");
      expect(resolveEscalationForTA("ta-2")).toBeNull();
    });

    it("removes resolved escalation from store (consumes it)", () => {
      registerEscalation(makeEscalation({ id: "consume-me", taUserId: "ta-3" }));
      resolveEscalationForTA("ta-3");
      expect(resolveEscalationForTA("ta-3")).toBeNull();
    });

    it("drops expired escalations (TTL > 24h)", () => {
      const expired = makeEscalation({
        id: "old-esc",
        taUserId: "ta-4",
        createdAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      });
      registerEscalation(expired);
      expect(resolveEscalationForTA("ta-4")).toBeNull();
    });

    it("isolates escalations per TA — TA A's escalation not visible to TA B", () => {
      registerEscalation(makeEscalation({ id: "ta-a-esc", taUserId: "ta-a" }));
      expect(resolveEscalationForTA("ta-b")).toBeNull();
      // Clean up
      resolveEscalationForTA("ta-a");
    });
  });

  describe("resolveEscalationById", () => {
    it("resolves escalation by ID regardless of which TA queue", () => {
      registerEscalation(makeEscalation({ id: "by-id-test", taUserId: "ta-5" }));
      const resolved = resolveEscalationById("by-id-test");
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe("by-id-test");
    });

    it("returns null for unknown ID", () => {
      expect(resolveEscalationById("nonexistent-id")).toBeNull();
    });

    it("removes only the specific escalation, leaves others", () => {
      registerEscalation(makeEscalation({ id: "keep-me", taUserId: "ta-6" }));
      registerEscalation(makeEscalation({ id: "find-me", taUserId: "ta-6" }));

      resolveEscalationById("find-me");

      const remaining = resolveEscalationForTA("ta-6");
      expect(remaining).not.toBeNull();
      expect(remaining!.id).toBe("keep-me");
    });

    it("returns null for expired escalation by ID", () => {
      registerEscalation(makeEscalation({
        id: "old-by-id",
        taUserId: "ta-7",
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
      }));
      expect(resolveEscalationById("old-by-id")).toBeNull();
    });
  });

  describe("getPendingEscalationTAIds", () => {
    it("includes TAs with fresh escalations", () => {
      registerEscalation(makeEscalation({ id: "ta-ids-test", taUserId: "ta-check" }));
      const ids = getPendingEscalationTAIds();
      expect(ids.has("ta-check")).toBe(true);
      resolveEscalationForTA("ta-check");
    });

    it("excludes TAs with only expired escalations", () => {
      registerEscalation(makeEscalation({
        id: "expired-ta",
        taUserId: "ta-expired",
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
      }));
      const ids = getPendingEscalationTAIds();
      expect(ids.has("ta-expired")).toBe(false);
    });
  });

  describe("getPendingEscalationCount", () => {
    it("counts all fresh escalations across all TAs", () => {
      registerEscalation(makeEscalation({ id: "count-1", taUserId: "ta-count-a" }));
      registerEscalation(makeEscalation({ id: "count-2", taUserId: "ta-count-a" }));
      registerEscalation(makeEscalation({ id: "count-3", taUserId: "ta-count-b" }));

      expect(getPendingEscalationCount()).toBeGreaterThanOrEqual(3);

      resolveEscalationForTA("ta-count-a");
      resolveEscalationForTA("ta-count-a");
      resolveEscalationForTA("ta-count-b");
    });

    it("does not count expired escalations", () => {
      const before = getPendingEscalationCount();
      registerEscalation(makeEscalation({
        id: "expired-count",
        taUserId: "ta-expired-count",
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
      }));
      expect(getPendingEscalationCount()).toBe(before);
    });
  });

  describe("getPendingEscalationSummary", () => {
    it("returns summary with count and oldest timestamp", () => {
      const t1 = Date.now() - 5000;
      const t2 = Date.now() - 1000;
      registerEscalation(makeEscalation({ id: "sum-1", taUserId: "ta-sum", createdAt: t1 }));
      registerEscalation(makeEscalation({ id: "sum-2", taUserId: "ta-sum", createdAt: t2 }));

      const summary = getPendingEscalationSummary();
      const entry = summary.find(s => s.taUserId === "ta-sum");
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(2);
      expect(entry!.oldest).toBe(t1);

      resolveEscalationForTA("ta-sum");
      resolveEscalationForTA("ta-sum");
    });

    it("excludes TAs with only expired escalations", () => {
      registerEscalation(makeEscalation({
        id: "sum-expired",
        taUserId: "ta-sum-exp",
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
      }));
      const summary = getPendingEscalationSummary();
      expect(summary.find(s => s.taUserId === "ta-sum-exp")).toBeUndefined();
    });
  });
});

// ── Discord Formatting ────────────────────────────────────────────────────────

describe("formatAnswerForDiscord", () => {
  it("includes course name in header", () => {
    const answer = makeAnswer({ confidence: 0.9 });
    const msg = formatAnswerForDiscord(answer, "EECS 281");
    expect(msg).toContain("EECS 281");
  });

  it("includes the answer text", () => {
    const answer = makeAnswer({ answer: "A heap is a tree-based data structure." });
    const msg = formatAnswerForDiscord(answer, "EECS 281");
    expect(msg).toContain("A heap is a tree-based data structure.");
  });

  it("shows green emoji for high confidence (>=0.85)", () => {
    const answer = makeAnswer({ confidence: 0.9 });
    const msg = formatAnswerForDiscord(answer, "EECS 281");
    expect(msg).toContain("🟢");
  });

  it("shows yellow emoji for medium confidence (0.65-0.84)", () => {
    const answer = makeAnswer({ confidence: 0.75 });
    const msg = formatAnswerForDiscord(answer, "EECS 281");
    expect(msg).toContain("🟡");
  });

  it("shows red emoji for low confidence (<0.65)", () => {
    const answer = makeAnswer({ confidence: 0.4 });
    const msg = formatAnswerForDiscord(answer, "EECS 281");
    expect(msg).toContain("🔴");
  });

  it("includes citations when present", () => {
    const answer = makeAnswer({ citations: ["Lecture 5", "Syllabus"] });
    const msg = formatAnswerForDiscord(answer, "EECS 281");
    expect(msg).toContain("Lecture 5");
    expect(msg).toContain("Syllabus");
    expect(msg).toContain("Sources");
  });

  it("omits citations section when no citations", () => {
    const answer = makeAnswer({ citations: [] });
    const msg = formatAnswerForDiscord(answer, "EECS 281");
    expect(msg).not.toContain("Sources");
  });

  it("includes confidence percentage", () => {
    const answer = makeAnswer({ confidence: 0.85 });
    const msg = formatAnswerForDiscord(answer, "EECS 281");
    expect(msg).toContain("85%");
  });
});

describe("formatEscalationDM", () => {
  it("includes course channel mention", () => {
    const esc: GsiEscalation = {
      channelId: "ch-999",
      question: "What is a hash table?",
      askedBy: "<@student-123>",
      courseName: "EECS 281",
      confidence: 0.4,
      reason: "insufficient retrieval",
      draftAnswer: "A hash table maps keys to values.",
    };
    const msg = formatEscalationDM(esc);
    expect(msg).toContain("<#ch-999>");
  });

  it("includes student mention", () => {
    const esc: GsiEscalation = {
      channelId: "ch-999",
      question: "Q",
      askedBy: "<@student-456>",
      courseName: "EECS 281",
      confidence: 0.3,
      reason: "low confidence",
      draftAnswer: "draft",
    };
    const msg = formatEscalationDM(esc);
    expect(msg).toContain("<@student-456>");
  });

  it("includes confidence percentage", () => {
    const esc: GsiEscalation = {
      channelId: "ch-999",
      question: "Q",
      askedBy: "<@s>",
      courseName: "EECS 281",
      confidence: 0.35,
      reason: "low",
      draftAnswer: "draft",
    };
    const msg = formatEscalationDM(esc);
    expect(msg).toContain("35%");
  });

  it("includes the original question", () => {
    const esc: GsiEscalation = {
      channelId: "ch-999",
      question: "How do hash collisions work?",
      askedBy: "<@s>",
      courseName: "EECS 281",
      confidence: 0.4,
      reason: "low",
      draftAnswer: "draft",
    };
    const msg = formatEscalationDM(esc);
    expect(msg).toContain("How do hash collisions work?");
  });

  it("includes the draft answer", () => {
    const esc: GsiEscalation = {
      channelId: "ch-999",
      question: "Q",
      askedBy: "<@s>",
      courseName: "EECS 281",
      confidence: 0.4,
      reason: "low",
      draftAnswer: "My draft answer text here.",
    };
    const msg = formatEscalationDM(esc);
    expect(msg).toContain("My draft answer text here.");
  });
});

describe("formatEscalationChannelReply", () => {
  it("mentions the student", () => {
    const msg = formatEscalationChannelReply("<@student-789>", "EECS 281");
    expect(msg).toContain("<@student-789>");
  });

  it("includes course name", () => {
    const msg = formatEscalationChannelReply("<@s>", "EECS 291");
    expect(msg).toContain("EECS 291");
  });

  it("mentions Piazza or office hours for follow-up", () => {
    const msg = formatEscalationChannelReply("<@s>", "EECS 281");
    expect(msg.toLowerCase()).toMatch(/piazza|office hours/);
  });
});
