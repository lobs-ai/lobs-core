/**
 * Browser service — Playwright headless browser for web search and page fetching.
 * 
 * Search order: Google → DuckDuckGo fallback
 * Browser is lazy-launched on first use and reused across calls.
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";

class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launching: Promise<void> | null = null;

  async ensureBrowser(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) {
      await this.launching;
      return this.context!;
    }
    this.launching = this._launch().catch((err) => {
      // Clear so next call retries instead of caching the failure
      this.launching = null;
      throw err;
    });
    await this.launching;
    return this.context!;
  }

  private async _launch() {
    // Use new headless mode (--headless=new) to avoid bot detection.
    // The old headless mode gets blocked by most search engines.
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

  async search(query: string, count: number = 5): Promise<SearchResult[]> {
    // Try Google first, fall back to DuckDuckGo
    try {
      const results = await this.searchGoogle(query, count);
      if (results.length > 0) return results;
    } catch (err) {
      console.warn("[browser] Google search failed, trying DuckDuckGo:", (err as Error).message);
    }

    try {
      return await this.searchDDG(query, count);
    } catch (err) {
      console.error("[browser] DuckDuckGo search also failed:", (err as Error).message);
      return [];
    }
  }

  private async searchGoogle(query: string, count: number): Promise<SearchResult[]> {
    const ctx = await this.ensureBrowser();
    const page = await ctx.newPage();
    try {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${count}&hl=en`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

      // Check for CAPTCHA/consent
      const blocked = await page.evaluate(() => {
        const body = document.body.innerText.toLowerCase();
        return body.includes("unusual traffic") || body.includes("captcha") || 
               document.querySelector("form[action*='consent']") !== null;
      });
      if (blocked) throw new Error("Google blocked (CAPTCHA/consent)");

      const results = await page.evaluate((maxResults: number) => {
        const items = document.querySelectorAll("div.g, div[data-sokoban-container]");
        return Array.from(items).slice(0, maxResults).map(el => {
          const linkEl = el.querySelector("a[href^='http']");
          const titleEl = el.querySelector("h3");
          const snippetEl = el.querySelector("[data-sncf], .VwiC3b, [style*='-webkit-line-clamp']");
          if (!linkEl || !titleEl) return null;
          return {
            title: titleEl.textContent?.trim() || "",
            url: linkEl.getAttribute("href") || "",
            snippet: snippetEl?.textContent?.trim() || "",
          };
        }).filter(Boolean) as Array<{ title: string; url: string; snippet: string }>;
      }, count);

      return results;
    } finally {
      await page.close();
    }
  }

  private async searchDDG(query: string, count: number): Promise<SearchResult[]> {
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

      // Clean DDG redirect URLs
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

  /** Take a screenshot of a page */
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
