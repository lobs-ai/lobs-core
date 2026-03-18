import { describe, expect, it } from "vitest";
import { getRawDb } from "../src/db/connection.js";
import { ResearchQueueService } from "../src/services/research-queue.js";

describe("ResearchQueueService", () => {
  it("processes queued text research into a stored brief", async () => {
    const service = new ResearchQueueService(getRawDb(), {
      fetchSource: async (item) => ({
        sourceTitle: item.title,
        sourceText: item.sourceText ?? "",
        sourceUrl: null,
      }),
      summarize: async () => ({
        summary: "SQLite 3.46 improved JSON and query planning behavior.",
        keyPoints: ["JSON support changed", "Planner improvements matter for heavy reads"],
        followUps: ["Check if our migrations rely on changed JSON behavior"],
        tokensUsed: 42,
        model: "local-qwen-test",
      }),
    });

    const queued = service.enqueue({
      title: "SQLite release notes",
      sourceType: "text",
      sourceText: "Release notes body",
      topic: "dependencies",
      tags: ["sqlite", "release-notes"],
      priority: 200,
    });

    const result = await service.processNext();

    expect(result.processed).toBe(true);
    expect(result.itemId).toBe(queued.id);
    expect(result.status).toBe("completed");

    const item = service.getQueueItem(queued.id);
    expect(item?.status).toBe("completed");

    const briefs = service.listBriefsForItem(queued.id);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.summary).toContain("SQLite 3.46");
    expect(briefs[0]?.keyPoints).toContain("JSON support changed");

    expect(service.getStats()).toMatchObject({
      queued: 0,
      completed: 1,
      failed: 0,
      briefs: 1,
    });
  });

  it("marks a queue item failed when source fetching blows up", async () => {
    const service = new ResearchQueueService(getRawDb(), {
      fetchSource: async () => {
        throw new Error("network unavailable");
      },
      summarize: async () => ({
        summary: "unused",
        keyPoints: [],
        followUps: [],
        tokensUsed: 0,
        model: "unused",
      }),
    });

    const queued = service.enqueue({
      title: "Upstream changelog",
      sourceType: "url",
      sourceUrl: "https://example.com/changelog",
    });

    const result = await service.processNext();

    expect(result.processed).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("network unavailable");

    const item = service.getQueueItem(queued.id);
    expect(item?.status).toBe("failed");
    expect(item?.error).toContain("network unavailable");
    expect(service.listBriefsForItem(queued.id)).toHaveLength(0);
  });
});

