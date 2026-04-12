#!/usr/bin/env python3
"""
Piazza Post Fetcher — GSI Office Hours Agent helper script.

Fetches all posts from a Piazza course and dumps them to JSON for ingestion
by the GSI agent's Piazza scraper (src/gsi/piazza-scraper.ts).

Requirements:
  pip install piazza-api

Usage:
  python3 fetch-piazza.py --email you@umich.edu --course-id <nid> > posts.json
  python3 fetch-piazza.py --email you@umich.edu --course-id <nid> --limit 200 > posts.json

How to find your course ID (nid):
  1. Go to your Piazza course
  2. Look at the URL: https://piazza.com/class/<nid>
  3. Copy that nid value

Then ingest into lobs-memory:
  npx ts-node src/gsi/piazza-scraper.ts --course eecs281 --json posts.json
"""

import argparse
import json
import sys
import getpass
import time

def main():
    parser = argparse.ArgumentParser(description="Fetch Piazza posts for GSI agent ingestion")
    parser.add_argument("--email", required=True, help="Your Piazza email")
    parser.add_argument("--course-id", required=True, help="Piazza course nid (from URL)")
    parser.add_argument("--limit", type=int, default=None, help="Max posts to fetch (default: all)")
    parser.add_argument("--password", default=None, help="Password (prompted if not provided)")
    parser.add_argument("--resolved-only", action="store_true", help="Only fetch resolved posts")
    parser.add_argument("--delay", type=float, default=0.5, help="Delay between API calls in seconds (default: 0.5)")
    args = parser.parse_args()

    try:
        import piazza_api
    except ImportError:
        print("Error: piazza-api not installed. Run: pip install piazza-api", file=sys.stderr)
        sys.exit(1)

    password = args.password or getpass.getpass(f"Piazza password for {args.email}: ")

    print(f"Logging in as {args.email}...", file=sys.stderr)
    p = piazza_api.Piazza()
    try:
        p.user_login(email=args.email, password=password)
    except Exception as e:
        print(f"Login failed: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Fetching course {args.course_id}...", file=sys.stderr)
    try:
        network = p.network(args.course_id)
    except Exception as e:
        print(f"Could not access course: {e}", file=sys.stderr)
        sys.exit(1)

    print("Fetching post feed...", file=sys.stderr)
    posts = []
    count = 0

    try:
        feed = network.get_feed(limit=args.limit or 9999, offset=0)
        feed_items = feed.get("feed", [])
        print(f"Found {len(feed_items)} posts in feed", file=sys.stderr)

        for item in feed_items:
            if args.limit and count >= args.limit:
                break

            post_id = item.get("id") or item.get("nr")
            if not post_id:
                continue

            try:
                post = network.get_post(post_id)
                posts.append(post)
                count += 1
                if count % 25 == 0:
                    print(f"  Fetched {count} posts...", file=sys.stderr)
                time.sleep(args.delay)
            except Exception as e:
                print(f"  Warning: could not fetch post {post_id}: {e}", file=sys.stderr)
                continue

    except Exception as e:
        print(f"Error fetching feed: {e}", file=sys.stderr)
        # Try alternative approach: get_all_posts
        try:
            print("Trying get_all_posts approach...", file=sys.stderr)
            for post in network.iter_all_posts(sleep=args.delay):
                if args.limit and count >= args.limit:
                    break
                posts.append(post)
                count += 1
                if count % 25 == 0:
                    print(f"  Fetched {count} posts...", file=sys.stderr)
        except Exception as e2:
            print(f"Both fetch methods failed: {e2}", file=sys.stderr)
            sys.exit(1)

    print(f"\nFetched {len(posts)} posts total", file=sys.stderr)
    print(f"Writing JSON to stdout...", file=sys.stderr)

    # Output JSON — the piazza-scraper.ts will parse this format
    json.dump(posts, sys.stdout, indent=2, default=str)
    print("", file=sys.stderr)
    print(f"Done! Run: npx ts-node src/gsi/piazza-scraper.ts --course eecs281 --json posts.json", file=sys.stderr)

if __name__ == "__main__":
    main()
