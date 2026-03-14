/**
 * Web tools — search and fetch using Playwright headless browser
 */

import { browserService } from "../../services/browser.js";
import type { ToolDefinition } from "../types.js";

export const webSearchToolDefinition: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web using Brave Search API. Returns titles, URLs, and snippets. " +
    "Supports region-specific and localized search via country and language parameters.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query string",
      },
      count: {
        type: "number",
        description: "Number of results to return (1-10, default 5)",
      },
      country: {
        type: "string",
        description: "2-letter country code for region-specific results (e.g., 'US', 'DE')",
      },
      freshness: {
        type: "string",
        description: "Filter by time: 'day', 'week', 'month', or 'year'",
      },
    },
    required: ["query"],
  },
};

export async function webSearchTool(
  params: Record<string, unknown>,
): Promise<string> {
  const query = params.query as string;
  if (!query || typeof query !== "string") {
    throw new Error("query is required and must be a string");
  }

  const count = Math.min(
    Math.max(typeof params.count === "number" ? params.count : 5, 1),
    10,
  );

  try {
    const results = await browserService.search(query, count);

    if (results.length === 0) {
      return `No results found for: ${query}`;
    }

    const formatted = results.map((r, i) => {
      const parts = [`${i + 1}. ${r.title}`];
      parts.push(`   URL: ${r.url}`);
      if (r.snippet) parts.push(`   ${r.snippet}`);
      return parts.join("\n");
    });

    return formatted.join("\n\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Web search failed: ${message}`);
  }
}

// ── web_fetch via Playwright ─────────────────────────────────────────────────

export const webFetchToolDefinition: ToolDefinition = {
  name: "web_fetch",
  description:
    "Fetch and extract readable content from a URL. Returns clean text/markdown from web pages. " +
    "Handles anti-bot systems and dynamic content. Use for reading articles, docs, and web pages.",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "HTTP or HTTPS URL to fetch",
      },
      maxChars: {
        type: "number",
        description: "Maximum characters to return (default 6000)",
      },
      mode: {
        type: "string",
        enum: ["markdown", "text"],
        description: "Extraction mode (default: markdown)",
      },
    },
    required: ["url"],
  },
};

export async function webFetchTool(
  params: Record<string, unknown>,
): Promise<string> {
  const url = params.url as string;
  if (!url || typeof url !== "string") {
    throw new Error("url is required and must be a string");
  }

  // Validate URL
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Only HTTP and HTTPS URLs are supported");
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("Only HTTP")) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }

  const maxChars =
    typeof params.maxChars === "number" ? params.maxChars : 6000;

  try {
    const result = await browserService.fetch(url, maxChars);

    const parts: string[] = [];
    if (result.title) parts.push(`Title: ${result.title}`);
    parts.push(`URL: ${result.url}`);
    const truncated = result.content.length >= maxChars;
    parts.push(
      `Length: ${result.content.length} chars${truncated ? " (truncated)" : ""}`,
    );
    parts.push("");
    parts.push(result.content);

    return parts.join("\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Failed to fetch ${url}: ${message}`;
  }
}
