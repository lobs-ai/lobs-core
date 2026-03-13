/**
 * Web search tool — Brave Search API.
 * 
 * web_fetch intentionally omitted — will be added later with a custom implementation.
 */

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

const FRESHNESS_MAP: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

interface BraveResult {
  title: string;
  url: string;
  description: string;
}

interface BraveResponse {
  web?: {
    results?: BraveResult[];
  };
  query?: {
    original?: string;
    altered?: string;
  };
}

export async function webSearchTool(
  params: Record<string, unknown>,
): Promise<string> {
  const query = params.query as string;
  if (!query || typeof query !== "string") {
    throw new Error("query is required and must be a string");
  }

  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error("BRAVE_API_KEY environment variable is not set");
  }

  const count = Math.min(Math.max(typeof params.count === "number" ? params.count : 5, 1), 10);
  const country = (params.country as string) ?? "US";
  const freshness = params.freshness
    ? FRESHNESS_MAP[(params.freshness as string).toLowerCase()] ?? (params.freshness as string)
    : undefined;

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  if (country && country !== "ALL") url.searchParams.set("country", country);
  if (freshness) url.searchParams.set("freshness", freshness);

  const response = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as BraveResponse;
  const results = data.web?.results ?? [];

  if (results.length === 0) {
    return `No results found for: ${query}`;
  }

  const formatted = results.map((r, i) => {
    const parts = [`${i + 1}. ${r.title}`];
    parts.push(`   URL: ${r.url}`);
    if (r.description) parts.push(`   ${r.description}`);
    return parts.join("\n");
  });

  let output = formatted.join("\n\n");

  // Note if query was altered
  if (data.query?.altered && data.query.altered !== data.query.original) {
    output = `(Showing results for: ${data.query.altered})\n\n${output}`;
  }

  return output;
}
