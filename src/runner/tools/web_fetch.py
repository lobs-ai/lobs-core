#!/usr/bin/env python3
"""
web_fetch tool — fetch and extract readable content from URLs using Scrapling.

Usage: python3 web_fetch.py <url> [--max-chars N] [--mode markdown|text]

Scrapling provides:
- Adaptive parsing (handles page changes)
- Anti-bot bypass (Cloudflare, etc.)
- Clean content extraction
- CSS selector support

Output: JSON with extracted content, title, metadata.
"""

import sys
import os
import json
import argparse
import ssl
import certifi

# Fix SSL certs for curl_cffi in venvs
os.environ.setdefault("CURL_CA_BUNDLE", certifi.where())
os.environ.setdefault("SSL_CERT_FILE", certifi.where())

from scrapling import Fetcher

def fetch_url(url: str, max_chars: int = 50000, mode: str = "markdown") -> dict:
    """Fetch a URL and extract readable content."""
    try:
        fetcher = Fetcher()
        page = fetcher.get(url, timeout=30, verify=False)
        
        if page.status != 200:
            return {
                "ok": False,
                "error": f"HTTP {page.status}",
                "url": url,
            }
        
        # Get the page title
        title_el = page.find("title")
        title = title_el.text.strip() if title_el else ""
        
        # Extract main content
        # Try common content containers first
        content_selectors = [
            "article",
            "main",
            "[role='main']",
            ".content",
            ".post-content",
            ".entry-content",
            ".article-body",
            "#content",
            "#main-content",
        ]
        
        content_el = None
        for selector in content_selectors:
            try:
                found = page.find(selector)
                if found and found.text.strip():
                    content_el = found
                    break
            except Exception:
                continue
        
        # Fall back to body
        if not content_el:
            content_el = page.find("body")
        
        if not content_el:
            return {
                "ok": True,
                "url": url,
                "title": title,
                "content": "",
                "length": 0,
                "truncated": False,
            }
        
        # Extract text content
        if mode == "text":
            content = content_el.text.strip()
        else:
            # For markdown mode, extract structured text
            content = extract_markdown(content_el)
        
        # Truncate if needed
        truncated = len(content) > max_chars
        if truncated:
            content = content[:max_chars]
        
        return {
            "ok": True,
            "url": url,
            "title": title,
            "content": content,
            "length": len(content),
            "truncated": truncated,
        }
        
    except Exception as e:
        return {
            "ok": False,
            "error": str(e),
            "url": url,
        }


def extract_markdown(element) -> str:
    """Extract content as markdown-ish text from an element."""
    parts = []
    
    # Get all text-bearing elements
    for el in element.find_all("h1, h2, h3, h4, h5, h6, p, li, pre, code, blockquote, td, th"):
        tag = el.tag.lower() if hasattr(el, 'tag') else ""
        text = el.text.strip()
        
        if not text:
            continue
            
        if tag in ("h1",):
            parts.append(f"\n# {text}\n")
        elif tag in ("h2",):
            parts.append(f"\n## {text}\n")
        elif tag in ("h3",):
            parts.append(f"\n### {text}\n")
        elif tag in ("h4", "h5", "h6"):
            parts.append(f"\n#### {text}\n")
        elif tag == "li":
            parts.append(f"- {text}")
        elif tag in ("pre", "code"):
            parts.append(f"```\n{text}\n```")
        elif tag == "blockquote":
            parts.append(f"> {text}")
        elif tag in ("td", "th"):
            parts.append(f"| {text} ")
        else:
            parts.append(text)
    
    result = "\n".join(parts)
    
    # Clean up excessive whitespace
    while "\n\n\n" in result:
        result = result.replace("\n\n\n", "\n\n")
    
    # If structured extraction got nothing useful, fall back to plain text
    if len(result.strip()) < 100:
        return element.text.strip()
    
    return result.strip()


def main():
    parser = argparse.ArgumentParser(description="Fetch and extract web content")
    parser.add_argument("url", help="URL to fetch")
    parser.add_argument("--max-chars", type=int, default=50000)
    parser.add_argument("--mode", choices=["markdown", "text"], default="markdown")
    
    args = parser.parse_args()
    result = fetch_url(args.url, args.max_chars, args.mode)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
