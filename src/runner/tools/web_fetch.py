#!/usr/bin/env python3
"""
web_fetch tool — fetch and extract readable content from URLs using Scrapling.

Usage: python3 web_fetch.py <url> [--max-chars N] [--mode markdown|text]

Output: JSON with extracted content, title, metadata.
"""

import sys
import os
import json
import argparse
import certifi

# Fix SSL certs for curl_cffi in venvs
os.environ.setdefault("CURL_CA_BUNDLE", certifi.where())
os.environ.setdefault("SSL_CERT_FILE", certifi.where())

# Suppress scrapling/urllib3 warnings and logs from stderr
import logging
import warnings
logging.disable(logging.CRITICAL)
warnings.filterwarnings("ignore")

from scrapling import Fetcher


def get_text(element) -> str:
    """Reliably get text from a scrapling element."""
    # .text can be empty on container elements, get_all_text() is more reliable
    if hasattr(element, "get_all_text"):
        text = element.get_all_text()
        if text and text.strip():
            return text.strip()
    if hasattr(element, "text") and element.text:
        return element.text.strip()
    return ""


def extract_markdown(element) -> str:
    """Extract content as markdown-ish text from an element."""
    parts = []

    for el in element.find_all("h1, h2, h3, h4, h5, h6, p, li, pre, code, blockquote"):
        tag = el.tag.lower() if hasattr(el, "tag") else ""
        text = get_text(el)

        if not text:
            continue

        if tag == "h1":
            parts.append(f"\n# {text}\n")
        elif tag == "h2":
            parts.append(f"\n## {text}\n")
        elif tag == "h3":
            parts.append(f"\n### {text}\n")
        elif tag in ("h4", "h5", "h6"):
            parts.append(f"\n#### {text}\n")
        elif tag == "li":
            parts.append(f"- {text}")
        elif tag in ("pre", "code"):
            parts.append(f"```\n{text}\n```")
        elif tag == "blockquote":
            parts.append(f"> {text}")
        else:
            parts.append(text)

    result = "\n".join(parts)

    # Clean up excessive whitespace
    while "\n\n\n" in result:
        result = result.replace("\n\n\n", "\n\n")

    # If structured extraction got nothing useful, fall back to get_all_text
    if len(result.strip()) < 50:
        return get_text(element)

    return result.strip()


def fetch_url(url: str, max_chars: int = 50000, mode: str = "markdown") -> dict:
    """Fetch a URL and extract readable content."""
    try:
        fetcher = Fetcher()
        page = fetcher.get(url, timeout=30, verify=False)

        if page.status != 200:
            return {"ok": False, "error": f"HTTP {page.status}", "url": url}

        # Get the page title
        title_el = page.find("title")
        title = get_text(title_el) if title_el else ""

        # Try common content containers first
        content_selectors = [
            "article", "main", "[role='main']",
            ".content", ".post-content", ".entry-content",
            ".article-body", "#content", "#main-content",
        ]

        content_text = ""
        for selector in content_selectors:
            try:
                found = page.find(selector)
                if found:
                    text = get_text(found)
                    if text and len(text) > 50:
                        if mode == "markdown":
                            content_text = extract_markdown(found)
                        else:
                            content_text = text
                        break
            except Exception:
                continue

        # Fall back to full page text
        if not content_text:
            if mode == "markdown":
                body = page.find("body")
                if body:
                    content_text = extract_markdown(body)
                else:
                    content_text = page.get_all_text() or ""
            else:
                content_text = page.get_all_text() or ""

        content_text = content_text.strip()

        # Truncate if needed
        truncated = len(content_text) > max_chars
        if truncated:
            content_text = content_text[:max_chars]

        return {
            "ok": True,
            "url": url,
            "title": title,
            "content": content_text,
            "length": len(content_text),
            "truncated": truncated,
        }

    except Exception as e:
        return {"ok": False, "error": str(e), "url": url}


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
