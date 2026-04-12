# GSI Office Hours Agent — EECS 281/291

An AI agent that handles repetitive student questions on Discord, learning from your course's syllabus, lecture notes, and past Piazza answers. It drafts responses with citations and escalates to a human TA when confidence is low.

**Current status**: Fully implemented. Ready to deploy to your Discord server.

---

## Quick Start (EECS 281 TAs)

### Step 1 — Get the bot into your Discord server

Contact Rafe (the system admin) with your Discord server's **Guild ID**:
1. Enable Developer Mode in Discord: Settings → Advanced → Developer Mode
2. Right-click your server name → Copy Server ID
3. Share the ID — the bot will be added within 24 hours

### Step 2 — Run `/gsi-setup` in your server

Once the bot is in your server, use these slash commands (admin only):

```
/gsi-setup init course:eecs281 name:EECS 281 description:Data Structures and Algorithms
/gsi-setup channel channel:#ask-gsi
/gsi-setup status
```

This configures the bot for your course and designates a channel for student questions.

### Step 3 — Seed the knowledge base

The bot comes pre-loaded with **52 EECS 281 FAQ items** covering common topics (complexity analysis, STL containers, graph algorithms, debugging, project submission, etc.).

To add your course materials:

```bash
# Ingest your syllabus and lecture notes
npx ts-node src/gsi/gsi-ingest.ts --course eecs281 --dir ~/path/to/lecture-pdfs/

# Ingest a specific file
npx ts-node src/gsi/gsi-ingest.ts --course eecs281 --file syllabus.pdf --label "EECS 281 Syllabus F2025"
```

Supported formats: `.pdf`, `.md`, `.txt`, `.json`

### Step 4 (optional but high-value) — Import past Piazza posts

Past Piazza Q&A is the single most valuable knowledge source. Here's how to import it:

```bash
# 1. Install the Piazza API wrapper
pip install piazza-api

# 2. Fetch your course posts (finds course ID from your Piazza URL)
python3 src/gsi/scripts/fetch-piazza.py \
  --email your@umich.edu \
  --course-id <nid-from-piazza-url> \
  > posts.json

# 3. Ingest into the knowledge base
npx ts-node src/gsi/piazza-scraper.ts \
  --course eecs281 \
  --json posts.json \
  --min-views 3

# Done — the agent now knows everything your TAs have answered this semester
```

> **Finding your Piazza course ID**: Go to `piazza.com/class/<nid>` — that `<nid>` is what you need.

---

## How Students Use It

Students type `/ask` in your designated channel:

```
/ask question:What's the difference between BFS and Dijkstra?
```

The bot:
1. Searches your course's knowledge base (FAQ + lecture notes + Piazza history)
2. Generates a draft answer with citations (e.g., "Per EECS 281 Lecture — Graph Algorithms...")
3. Posts the answer publicly in the channel
4. If confidence is low, appends a note that a TA will follow up

---

## What It's Good At

✅ **Repetitive logistics questions**: syllabus policies, late days, submission format, autograder behavior  
✅ **Common algorithm questions**: complexity analysis, STL usage, debugging patterns  
✅ **Questions already answered on Piazza**: finds the existing answer instantly  
✅ **Pointing to the right lecture**: "This is covered in Lecture 8 — Graph Representations"  

## What It Escalates

🔁 **Novel edge cases** that aren't in the knowledge base  
🔁 **Grade disputes** — always routes to a human  
🔁 **Ambiguous specs** — flags for TA clarification  
🔁 **Low-confidence answers** (score < 0.6) — posts draft + "a TA will verify this"  

---

## Architecture

```
Student Discord message
        │
        ▼
  /ask slash command
        │
        ▼
  gsi-agent.ts          ← orchestrates the response
        │
        ├── lobs-memory search  ← semantic search over course materials
        │       └── eecs281-course collection
        │               ├── FAQ seed data (52 items)
        │               ├── Ingested lecture PDFs / syllabus
        │               └── Piazza post history
        │
        ├── LLM (Claude/GPT)    ← generates natural language answer + citations
        │
        └── Confidence check
                ├── High (≥0.7): post answer directly
                └── Low (<0.7):  post draft + "TA will verify"
```

---

## File Reference

| File | Purpose |
|------|---------|
| `gsi-agent.ts` | Core agent logic — search + LLM + confidence scoring |
| `gsi-ingest.ts` | Ingest PDFs/markdown/JSON into lobs-memory |
| `piazza-scraper.ts` | Parse & ingest Piazza post exports |
| `gsi-seed.ts` | Auto-seeds FAQ on startup |
| `gsi-config.ts` | Course configuration types |
| `seed-data/eecs281-faq.json` | 52 curated EECS 281 FAQ items |
| `scripts/fetch-piazza.py` | Python helper to fetch Piazza posts via API |

---

## Admin Commands (Discord)

```
/gsi-setup init     — Register a course
/gsi-setup channel  — Set the designated Q&A channel
/gsi-setup status   — Show configuration + knowledge base stats
/gsi-setup seed     — Re-run the FAQ seeder
```

---

## Scaling to Other Courses

This system is course-agnostic. To add EECS 376, EECS 482, or any other course:

```
/gsi-setup init course:eecs376 name:EECS 376 description:Theory of Computation
```

Then ingest that course's materials the same way. Each course gets its own isolated knowledge base collection in lobs-memory.

---

## SaaS Roadmap

The goal is to offer this as a service to UMich GSI coordinators:

- **$500–2000/course/semester** depending on usage
- Self-serve onboarding (TA does `/gsi-setup` themselves after invite)
- Usage dashboard: questions answered, escalation rate, top topics
- Automatic Piazza sync (daily re-ingestion of new resolved posts)
- Multi-platform: Discord + Slack + Piazza direct answers

Target: 10 UMich courses by end of Winter 2026 semester.
