# GSI Office Hours Agent

AI-powered teaching assistant that answers repetitive student questions in Discord using course materials (syllabus, lecture PDFs, past Q&A). Drafts answers with citations; escalates to human TAs when confidence is low.

**Business target:** $500–2000/course/semester · 10 UMich courses = warm beachhead · zero CAC (TA-to-TA referral)

---

## How It Works

1. **Ingest** course materials (syllabus, slides, PDFs) into lobs-memory
2. Students type `/ask What's the time complexity of Dijkstra's?` in Discord
3. Bot searches lobs-memory for relevant chunks, generates answer with citations
4. If confidence ≥ threshold → posts answer with source citations
5. If confidence < threshold → notifies human TAs with the draft answer for review

---

## Setup: New Course

### 1. Create the course config

```bash
mkdir -p ~/.lobs/gsi
```

Create `~/.lobs/gsi/<courseId>.json`:

```json
{
  "courseId": "eecs281",
  "courseName": "EECS 281: Data Structures & Algorithms",
  "guildId": "YOUR_DISCORD_GUILD_ID",
  "channelIds": ["CHANNEL_ID_1", "CHANNEL_ID_2"],
  "escalationUserIds": ["TA_DISCORD_USER_ID_1", "TA_DISCORD_USER_ID_2"],
  "memoryCollections": ["eecs281-course"],
  "confidenceThreshold": 0.65,
  "dmEscalations": false,
  "logChannelId": "TA_LOG_CHANNEL_ID",
  "enabled": true
}
```

**Fields:**
- `guildId` — right-click server → Copy Server ID (enable Developer Mode in Discord settings)
- `channelIds` — channels where `/ask` is active; empty array = all channels in the guild
- `escalationUserIds` — Discord user IDs of TAs who get notified on low-confidence answers
- `confidenceThreshold` — 0–1; below this, escalate to human TA (default 0.65)
- `dmEscalations` — if true, DM TAs privately; if false, ping them in `logChannelId`
- `logChannelId` — private TA channel for Q&A logging and escalation pings

### 2. Ingest course materials

```bash
# Ingest all PDFs/markdown in a directory
cd ~/lobs/lobs-core
npx ts-node src/gsi/gsi-ingest.ts --course eecs281 --dir ~/courses/eecs281/materials/

# Ingest a single file with a custom label
npx ts-node src/gsi/gsi-ingest.ts --course eecs281 --file syllabus.pdf --label "EECS 281 Syllabus F2025"

# Ingest a single lecture slide PDF
npx ts-node src/gsi/gsi-ingest.ts --course eecs281 --file lecture01-complexity.pdf --label "Lecture 1: Complexity"
```

**Supported formats:** `.pdf` (requires `pdftotext`: `brew install poppler`), `.txt`, `.md`, `.json`

**For PDFs:** Install pdftotext first:
```bash
brew install poppler
```

### 3. Restart lobs-core to register the `/ask` slash command

```bash
lobs restart
```

The `/ask` command is registered globally when lobs-core starts up. It will be available in any guild where the bot is invited.

### 4. Invite the bot to the course Discord server

The bot needs these permissions:
- `bot` scope
- `application.commands` scope  
- Bot permissions: Send Messages, Read Message History, Use Application Commands

Use the Discord Developer Portal to generate an invite link with these scopes.

---

## Ingesting Past Q&A (Piazza Posts)

Past answered questions are the highest-value training data. Format them as JSON:

```json
[
  {
    "question": "What is the time complexity of building a heap?",
    "answer": "Building a heap using the bottom-up heapify approach is O(n), not O(n log n) as you might expect..."
  },
  {
    "question": "Can we use STL containers in Project 3?",
    "answer": "Yes, you may use any STL container. However, you should implement your own..."
  }
]
```

Then ingest:
```bash
npx ts-node src/gsi/gsi-ingest.ts --course eecs281 --file piazza-fa24.json --label "Piazza FA2024 Answered Posts"
```

---

## Confidence Tuning

The bot blends two confidence signals:
1. **LLM self-reported confidence** — the model assesses its own certainty
2. **Retrieval quality** — how relevant and high-scoring the retrieved chunks are

Tuning tips:
- **Too many escalations?** Lower `confidenceThreshold` (e.g. 0.55)
- **Wrong answers getting posted?** Raise `confidenceThreshold` (e.g. 0.75)
- **Answers missing context?** Ingest more course materials or past Q&A
- **Answers too generic?** Make sure ingested content is course-specific

---

## Architecture

```
Student types /ask in Discord
        │
        ▼
handleAskCommand() in discord-commands.ts
        │
        ├── getCourseForChannel() → loads ~/.lobs/gsi/<courseId>.json
        │
        ▼
answerStudentQuestion() in gsi-agent.ts
        │
        ├── searchCourseKnowledge() → lobs-memory vector search (port 7420)
        │       Searches configured collections, returns scored chunks
        │
        ├── generateAnswer() → Claude Haiku
        │       Synthesizes answer from chunks, self-reports confidence
        │
        └── blendConfidence() → combines LLM + retrieval quality
                │
                ├── confidence ≥ threshold → formatAnswerForDiscord() → post
                └── confidence < threshold → formatEscalationDM() → ping TAs
```

**Files:**
- `src/gsi/gsi-config.ts` — Course config schema + file loader
- `src/gsi/gsi-agent.ts` — Core answer engine (search → LLM → confidence → escalate)
- `src/gsi/gsi-ingest.ts` — Material ingestion pipeline (PDF → chunks → lobs-memory)
- `src/services/discord-commands.ts` — `/ask` slash command handler

---

## SaaS Expansion Plan

Current: single-instance (Lobs's bot) for prototyping at EECS 281.

To scale to paying customers:
1. Multi-tenant config: one JSON per course, multiple guilds supported
2. Piazza scraper: auto-import answered posts on a schedule
3. Web dashboard: TAs upload materials, see Q&A analytics, tune confidence threshold
4. Per-course billing: $500/semester base + $100/100 students/month
5. Referral: happy TAs refer to next semester's TAs → zero CAC

**Target**: 10 UMich CS courses = $5,000–20,000/semester ARR, all from warm TA referrals.
