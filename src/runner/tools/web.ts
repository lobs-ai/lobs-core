/**
 * Web tools — search (Brave API) and fetch (Scrapling).
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// ── web_fetch via Scrapling ──────────────────────────────────────────────────

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
        description: "Maximum characters to return (default 50000)",
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

/** Path to the Python venv and script */
const VENV_PYTHON = resolve(process.env.HOME ?? "", "lobs/lobs-core/tools-venv/bin/python3");
const FETCH_SCRIPT = resolve(process.env.HOME ?? "", "lobs/lobs-core/src/runner/tools/web_fetch.py");

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

  const maxChars = typeof params.maxChars === "number" ? params.maxChars : 50000;
  const mode = (params.mode as string) ?? "markdown";

  return new Promise<string>((resolve, reject) => {
    const args = [FETCH_SCRIPT, url, "--max-chars", String(maxChars), "--mode", mode];
    let stdout = "";
    let stderr = "";

    const proc = spawn(VENV_PYTHON, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 45_000,
    });

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("error", (err) => {
      resolve(`Error running web_fetch: ${err.message}`);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(`web_fetch failed (exit ${code}): ${stderr.slice(0, 500)}`);
        return;
      }

      try {
        const result = JSON.parse(stdout);
        if (!result.ok) {
          resolve(`Failed to fetch ${url}: ${result.error}`);
          return;
        }

        const parts: string[] = [];
        if (result.title) parts.push(`Title: ${result.title}`);
        parts.push(`URL: ${result.url}`);
        parts.push(`Length: ${result.length} chars${result.truncated ? " (truncated)" : ""}`);
        parts.push("");
        parts.push(result.content);

        resolve(parts.join("\n"));
      } catch {
        resolve(stdout || `web_fetch returned no output`);
      }
    });
  });
}
