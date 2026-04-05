/**
 * Tests for web_fetch tool — verifies Playwright-based fetching
 * works end-to-end in the content validation pipeline context.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { webFetchTool, webFetchToolDefinition } from "../src/runner/tools/web.js";

// Mock the browser service so tests don't need a real browser
vi.mock("../src/services/browser.js", () => ({
  browserService: {
    fetch: vi.fn(),
  },
}));

import { browserService } from "../src/services/browser.js";

const mockFetch = vi.mocked(browserService.fetch);

describe("web_fetch tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      expect(webFetchToolDefinition.name).toBe("web_fetch");
    });

    it("should have an empty required array (url validation is done at runtime)", () => {
      expect(webFetchToolDefinition.input_schema.required).toEqual([]);
    });

    it("should not reference Scrapling or Python in description", () => {
      expect(webFetchToolDefinition.description).not.toMatch(/scrapling|python/i);
    });

    it("should document maxChars parameter", () => {
      expect(webFetchToolDefinition.input_schema.properties).toHaveProperty("maxChars");
    });
  });

  describe("URL validation", () => {
    it("should reject missing url", async () => {
      await expect(webFetchTool({})).rejects.toThrow("url is required");
    });

    it("should reject non-string url", async () => {
      await expect(webFetchTool({ url: 42 })).rejects.toThrow("url is required");
    });

    it("should reject non-HTTP/HTTPS protocols", async () => {
      await expect(webFetchTool({ url: "ftp://example.com/file" })).rejects.toThrow(
        "Only HTTP and HTTPS URLs are supported"
      );
    });

    it("should reject malformed URLs", async () => {
      await expect(webFetchTool({ url: "not-a-url" })).rejects.toThrow("Invalid URL");
    });
  });

  describe("successful fetch — Playwright backend", () => {
    it("should call browserService.fetch with the url and default maxChars", async () => {
      mockFetch.mockResolvedValueOnce({
        title: "Example Domain",
        url: "https://example.com",
        content: "This domain is for use in illustrative examples.",
      });

      await webFetchTool({ url: "https://example.com" });

      expect(mockFetch).toHaveBeenCalledWith("https://example.com", 6000);
    });

    it("should respect custom maxChars", async () => {
      mockFetch.mockResolvedValueOnce({
        title: "Docs",
        url: "https://docs.example.com",
        content: "Documentation content here.",
      });

      await webFetchTool({ url: "https://docs.example.com", maxChars: 1000 });

      expect(mockFetch).toHaveBeenCalledWith("https://docs.example.com", 1000);
    });

    it("should format output with title, url, and content length", async () => {
      const content = "Some fetched page content that is useful.";
      mockFetch.mockResolvedValueOnce({
        title: "My Page",
        url: "https://example.com/page",
        content,
      });

      const result = await webFetchTool({ url: "https://example.com/page" });

      expect(result).toContain("Title: My Page");
      expect(result).toContain("URL: https://example.com/page");
      expect(result).toContain(`Length: ${content.length} chars`);
      expect(result).toContain(content);
    });

    it("should work without a title (omits title line)", async () => {
      mockFetch.mockResolvedValueOnce({
        title: "",
        url: "https://example.com",
        content: "No title page.",
      });

      const result = await webFetchTool({ url: "https://example.com" });

      expect(result).not.toContain("Title:");
      expect(result).toContain("URL: https://example.com");
    });

    it("should NOT call Python/Scrapling script", async () => {
      // web_fetch must go through browserService.fetch, not execFile/python
      // Verified by: mockFetch captures the call — if Python were invoked
      // instead, mockFetch would have 0 calls.
      mockFetch.mockResolvedValueOnce({
        title: "Test",
        url: "https://example.com",
        content: "Content",
      });

      await webFetchTool({ url: "https://example.com" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("error handling", () => {
    it("should return error message string (not throw) when browser fetch fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Browser launch failed"));

      const result = await webFetchTool({ url: "https://example.com" });

      expect(result).toContain("Failed to fetch https://example.com");
      expect(result).toContain("Browser launch failed");
    });

    it("should handle timeout errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Timeout 20000ms exceeded"));

      const result = await webFetchTool({ url: "https://slow.example.com" });

      expect(result).toMatch(/Failed to fetch.*Timeout/);
    });
  });

  describe("content validation pipeline integration", () => {
    it("should fetch external URL and return content suitable for validation", async () => {
      // Simulates the validation pipeline calling web_fetch on a content URL
      const validationContent = [
        "# Product Documentation",
        "This product does X, Y, and Z.",
        "Version: 2.1.0",
        "Last updated: 2026-03-17",
      ].join("\n");

      mockFetch.mockResolvedValueOnce({
        title: "Product Docs - v2.1.0",
        url: "https://docs.product.example.com/v2",
        content: validationContent,
      });

      const result = await webFetchTool({
        url: "https://docs.product.example.com/v2",
        maxChars: 10000,
      });

      // Pipeline receives structured output with title, url, and content
      expect(result).toContain("Title: Product Docs - v2.1.0");
      expect(result).toContain("URL: https://docs.product.example.com/v2");
      expect(result).toContain("# Product Documentation");
      expect(result).toContain("Version: 2.1.0");
    });

    it("should be callable with https URLs used in link validation workflows", async () => {
      const urls = [
        "https://github.com/example/repo",
        "https://api.example.com/docs",
        "https://cdn.example.com/assets/readme.md",
      ];

      for (const url of urls) {
        mockFetch.mockResolvedValueOnce({
          title: "Page",
          url,
          content: "Page content",
        });

        const result = await webFetchTool({ url });
        expect(result).toContain(`URL: ${url}`);
      }

      expect(mockFetch).toHaveBeenCalledTimes(urls.length);
    });
  });
});
