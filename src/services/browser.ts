/**
 * Browser service — SearXNG for search, Playwright for page fetching.
 * 
 * Search: local SearXNG instance (no CAPTCHAs, aggregates multiple engines)
 * Fetch: Playwright headless browser for JS-rendered pages
 */

import { chromium, Browser, BrowserContext } from "playwright";

const SEARXNG_URL = process.env.SEARXNG_URL || "http://localhost:8888";

class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launching: Promise<void> | null = null;

  /** Lazy-launch Playwright (only needed for fetch/screenshot, not search) */
  async ensureBrowser(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) {
      await this.launching;
      return this.context!;
    }
    this.launching = this._launch().catch((err) => {
      this.launching = null;
      throw err;
    });
    await this.launching;
    return this.context!;
  }

  private async _launch() {
    this.browser = await chromium.launch({
      headless: false,
      args: ["--headless=new"],
    });
    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
  }

  /**
   * Search via local SearXNG instance.
   * No CAPTCHAs, no rate limits, aggregates Google/Bing/DuckDuckGo/Brave/etc.
   */
  async search(query: string, count: number = 5, options?: { language?: string; country?: string }): Promise<SearchResult[]> {
    try {
      const params = new URLSearchParams({
        q: query,
        format: "json",
        language: options?.language || "en",
      });

      const response = await fetch(`${SEARXNG_URL}/search?${params.toString()}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(`SearXNG returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as SearXNGResponse;
      
      return data.results.slice(0, count).map(r => ({
        title: r.title || "",
        url: r.url || "",
        snippet: r.content || "",
      }));
    } catch (err) {
      console.error("[browser] SearXNG search failed:", (err as Error).message);
      // Fall back to DuckDuckGo HTML scraping as last resort
      try {
        return await this.searchDDGFallback(query, count);
      } catch (fallbackErr) {
        console.error("[browser] DDG fallback also failed:", (fallbackErr as Error).message);
        return [];
      }
    }
  }

  /** Emergency fallback: scrape DDG HTML (only if SearXNG is down) */
  private async searchDDGFallback(query: string, count: number): Promise<SearchResult[]> {
    const ctx = await this.ensureBrowser();
    const page = await ctx.newPage();
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

      const results = await page.evaluate((maxResults: number) => {
        const items = document.querySelectorAll(".result");
        return Array.from(items).slice(0, maxResults).map(el => {
          const titleEl = el.querySelector(".result__title a, .result__a");
          const snippetEl = el.querySelector(".result__snippet");
          return {
            title: titleEl?.textContent?.trim() || "",
            url: titleEl?.getAttribute("href") || "",
            snippet: snippetEl?.textContent?.trim() || "",
          };
        }).filter(r => r.title && r.url);
      }, count);

      return results.map(r => ({
        ...r,
        url: r.url.startsWith("//duckduckgo.com/l/?")
          ? decodeURIComponent(new URL("https:" + r.url).searchParams.get("uddg") || r.url)
          : r.url,
      }));
    } finally {
      await page.close();
    }
  }

  async fetch(url: string, maxChars: number = 50000): Promise<FetchResult> {
    const ctx = await this.ensureBrowser();
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1500); // JS rendering

      const content = await page.evaluate(() => {
        // Remove noise
        ["script", "style", "nav", "footer", "header", "aside", 
         ".sidebar", ".nav", ".footer", ".header", ".ad", ".advertisement",
         "[role='banner']", "[role='navigation']", ".cookie-banner", ".popup"]
          .forEach(sel => {
            document.querySelectorAll(sel).forEach(el => el.remove());
          });

        const main = document.querySelector(
          "main, article, .content, .post, #content, #main, [role='main']"
        ) || document.body;

        return {
          title: document.title,
          text: (main as HTMLElement).innerText || main.textContent || "",
          url: window.location.href,
        };
      });

      return {
        title: content.title,
        url: content.url,
        content: content.text.substring(0, maxChars),
      };
    } finally {
      await page.close();
    }
  }

  async screenshot(url: string, path: string): Promise<void> {
    const ctx = await this.ensureBrowser();
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1000);
      await page.screenshot({ path, fullPage: false });
    } finally {
      await page.close();
    }
  }

  async shutdown() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.launching = null;
    }
  }
}

export const browserService = new BrowserService();

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchResult {
  title: string;
  url: string;
  content: string;
}

interface SearXNGResult {
  title: string;
  url: string;
  content: string;
  engine: string;
  score: number;
}

interface SearXNGResponse {
  results: SearXNGResult[];
  number_of_results: number;
  query: string;
}
