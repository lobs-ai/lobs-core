/**
 * Web tools — search and fetch using Playwright headless browser
 *
 * web_fetch uses browserService (Playwright) as the primary path.
 * The legacy Python/Scrapling script (web_fetch.py) is no longer used.
 */

import { browserService } from "../../services/browser.js";
import type { ToolDefinition } from "../types.js";

export const webSearchToolDefinition: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web and return titles, URLs, and snippets. Use this when you need current or external information instead of local repo context.",
  input_schema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description: "Search query string",
      },
      query: {
        type: "string",
        description: "Backward-compatible query field; q is preferred",
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
    required: [],
  },
};

export async function webSearchTool(
  params: Record<string, unknown>,
): Promise<string> {
  const query = (params.query as string) ?? (params.q as string);
  if (!query || typeof query !== "string") {
    throw new Error("query is required and must be a string");
  }

  const count = Math.min(
    Math.max(typeof params.count === "number" ? params.count : 5, 1),
    10,
  );

  const language = typeof params.language === "string" ? params.language : undefined;
  const country = typeof params.country === "string" ? params.country : undefined;

  try {
    const results = await browserService.search(query, count, { language, country });

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

// ── web_fetch via Playwright (browserService) ────────────────────────────────

export const webFetchToolDefinition: ToolDefinition = {
  name: "web_fetch",
  description:
    "Fetch and extract readable content from a URL, including rendered web pages. Use this to read articles, documentation, or specific pages after you already know the URL.",
  input_schema: {
    type: "object",
    properties: {
      href: {
        type: "string",
        description: "HTTP or HTTPS URL to fetch",
      },
      url: {
        type: "string",
        description: "Backward-compatible URL field; href is preferred",
      },
      maxChars: {
        type: "number",
        description: "Maximum characters to return (default 6000)",
      },
    },
    required: [],
  },
};

export async function webFetchTool(
  params: Record<string, unknown>,
): Promise<string> {
  const url = (params.url as string) ?? (params.href as string);
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
    // Primary path: Playwright via browserService (JS-rendered, no anti-bot issues)
    const result = await browserService.fetch(url, maxChars);

    const parts: string[] = [];
    if (result.title) parts.push(`Title: ${result.title}`);
    parts.push(`URL: ${result.url}`);
    parts.push(`Length: ${result.content.length} chars`);
    parts.push("");
    parts.push(result.content);

    return parts.join("\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Failed to fetch ${url}: ${message}`;
  }
}
