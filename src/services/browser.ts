/**
 * Browser service — Playwright headless browser for web search and fetch
 */

import { chromium, Browser, BrowserContext } from "playwright";

class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launching: Promise<void> | null = null;

  /**
   * Lazy launch — starts browser on first use
   */
  async ensureBrowser(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) {
      await this.launching;
      return this.context!;
    }
    this.launching = this._launch();
    await this.launching;
    return this.context!;
  }

  private async _launch() {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
  }

  async search(query: string, count: number = 5): Promise<SearchResult[]> {
    const ctx = await this.ensureBrowser();
    const page = await ctx.newPage();
    try {
      // Try DuckDuckGo HTML (lighter, less blocking than Google)
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

      // Extract results
      const results = await page.evaluate((maxResults: number) => {
        const items = document.querySelectorAll(".result");
        return Array.from(items)
          .slice(0, maxResults)
          .map((el) => {
            const titleEl = el.querySelector(".result__title a, .result__a");
            const snippetEl = el.querySelector(".result__snippet");
            const urlEl = el.querySelector(".result__url");
            return {
              title: titleEl?.textContent?.trim() || "",
              url:
                titleEl?.getAttribute("href") ||
                urlEl?.textContent?.trim() ||
                "",
              snippet: snippetEl?.textContent?.trim() || "",
            };
          })
          .filter((r) => r.title && r.url);
      }, count);

      // Clean DDG redirect URLs
      return results.map((r) => ({
        ...r,
        url: r.url.startsWith("//duckduckgo.com/l/?")
          ? decodeURIComponent(
              new URL("https:" + r.url).searchParams.get("uddg") || r.url,
            )
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

      // Wait a bit for JS rendering
      await page.waitForTimeout(1000);

      // Extract readable text
      const content = await page.evaluate(() => {
        // Remove scripts, styles, nav, footer, etc.
        const removeSelectors = [
          "script",
          "style",
          "nav",
          "footer",
          "header",
          "aside",
          ".sidebar",
          ".nav",
          ".footer",
          ".header",
          ".ad",
          ".advertisement",
        ];
        removeSelectors.forEach((sel) => {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        });

        // Try to find main content
        const main =
          document.querySelector(
            "main, article, .content, .post, #content, #main",
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

  async shutdown() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
    }
  }
}

// Singleton
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
