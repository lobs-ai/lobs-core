# GSI Office Hours Bot

**A Discord bot that answers student questions using course materials, escalates to human TAs when confidence is low, and logs all interactions for TA review.**

## Status

- ✅ **Core agent** (`gsi-agent.ts`) — Answers questions with citations, confidence scoring, and escalation logic
- ✅ **Memory integration** (`gsi-ingest.ts`) — Ingest course PDFs, syllabi, lecture notes into lobs-memory
- ✅ **Discord `/ask` slash command** (`discord-commands.ts`) — `/ask question:<your question>`
- ✅ **Course config system** (`gsi-config.ts`) — Per-course settings, TA escalation, thresholds
- ✅ **EECS 281 seed FAQ** (`seed-data/eecs281-faq.json`) — 20 real Q&A pairs bootstrapped from common student questions
- ✅ **Setup script** (`setup-course.sh`) — Deploy to any Discord server in 2 minutes

**Target:** $500–2000/course/semester. 10 UMich courses = warm beachhead with zero CAC.

---

## Quick Start (5 minutes)

### 1. Prerequisites
```bash
# Lobs core must be running
lobs status

# Check Discord bot is configured
lobs-config-check
```

### 2. Get Your Discord Server IDs
In Discord (with Developer Mode ON):
- Right-click server → Copy Server ID → **Guild ID**
- Right-click TA username → Copy User ID → **TA User ID** (repeat for each TA)
- Right-click channel name → Copy Channel ID → **Log Channel ID** (optional)

### 3. Run Setup Script
```bash
cd ~/lobs/lobs-core/src/gsi
./setup-course.sh \
  --course eecs281 \
  --guild 1234567890 \
  --ta 9876543210 \
  --ta 1111111111 \
  --log-channel 2222222222
```

This:
- Creates `~/.lobs/gsi/eecs281.json` with your config
- Ingests the EECS 281 FAQ seed data into lobs-memory
- Enables the bot for your Discord server

### 4. Restart Lobs
```bash
lobs restart
```

### 5. Test It
In your Discord server:
```
/ask question:What is the difference between BFS and DFS?
```

Expected: Bot answers within 3–5 seconds with citations. If unsure (confidence < threshold), DMs a TA with the question + draft answer.

---

## How It Works

### User Asks a Question
Student types `/ask question:What is dynamic programming?` in Discord.

### Bot Searches Course Materials
1. Query lobs-memory for docs related to the question
2. Use the question + retrieved docs as context
3. Call Claude to generate an answer with citations

### Scoring & Decision
- If **confidence ≥ threshold** (default 65%): Post answer directly to channel
- If **confidence < threshold**: Mark as escalation
  - Post "Checking with TA..." in channel
  - DM each configured TA with: student, question, draft answer, confidence
  - Log to the log channel (if configured)

### TA Review
TA receives DM with the student's question and bot's draft answer. TA can:
1. Edit and post the draft themselves
2. Click to jump to the channel and answer directly
3. Use the draft as a basis for a fuller explanation

---

## File Structure

```
src/gsi/
├── gsi-agent.ts              # Core question-answering logic
├── gsi-ingest.ts             # PDF/markdown/text ingestion pipeline
├── gsi-config.ts             # Course config loader (from ~/.lobs/gsi/)
├── seed-data/
│   └── eecs281-faq.json      # Seed Q&A for bootstrapping EECS 281
├── setup-course.sh           # One-command deployment script
└── README.md                 # This file
```

**Integration points:**
- `src/services/discord-commands.ts` — Wires `/ask` slash command
- `src/main.ts` — Loads GSI configs on startup
- `lobs-memory` (external) — Vector DB for course materials

---

## Adding a New Course

### Option A: Use the Setup Script (Recommended)
```bash
./setup-course.sh \
  --course eecs376 \
  --name "EECS 376: Foundations of Computer Science" \
  --guild <GUILD_ID> \
  --ta <TA_ID> \
  --materials ~/syllabi/eecs376/
```

This creates `~/.lobs/gsi/eecs376.json` and ingests materials.

### Option B: Manual Setup

1. **Create a seed FAQ** (optional but recommended):
   ```json
   // src/gsi/seed-data/eecs376-faq.json
   [
     {
       "question": "...",
       "answer": "...",
       "source": "...",
       "tags": ["eecs376"]
     }
   ]
   ```

2. **Create course config**:
   ```json
   // ~/.lobs/gsi/eecs376.json
   {
     "courseId": "eecs376",
     "courseName": "EECS 376: Foundations of Computer Science",
     "guildId": "YOUR_GUILD_ID",
     "channelIds": ["OPTIONAL_CHANNEL_IDS"],
     "escalationUserIds": ["TA_ID_1", "TA_ID_2"],
     "memoryCollections": ["eecs376-course"],
     "confidenceThreshold": 0.65,
     "dmEscalations": false,
     "logChannelId": "OPTIONAL_LOG_CHANNEL_ID",
     "enabled": true
   }
   ```

3. **Ingest materials** (optional):
   ```bash
   node dist/gsi/gsi-ingest.js \
     --course eecs376 \
     --dir ~/syllabi/eecs376/
   ```

4. **Restart lobs**:
   ```bash
   lobs restart
   ```

---

## Configuration Reference

**File location:** `~/.lobs/gsi/<courseId>.json`

| Field | Type | Description |
|-------|------|-------------|
| `courseId` | string | Unique ID (e.g., "eecs281"). Used as memory collection name. |
| `courseName` | string | Display name (e.g., "EECS 281: Data Structures & Algorithms") |
| `guildId` | string | Discord guild (server) ID. If empty, bot is disabled. |
| `channelIds` | string[] | Optional: restrict bot to specific channels. If empty, all channels allowed. |
| `escalationUserIds` | string[] | Discord user IDs to DM for low-confidence answers |
| `memoryCollections` | string[] | lobs-memory collection names (usually one: `["{courseId}-course"]`) |
| `confidenceThreshold` | number | 0–1. Answers below this are escalated. Default: 0.65 |
| `dmEscalations` | boolean | If true, DM only the first TA. If false, DM all TAs. |
| `logChannelId` | string | Optional: Discord channel to log all Q&A (answered + escalated) |
| `enabled` | boolean | Enable/disable the bot for this course |

---

## Ingesting Course Materials

### Supported Formats
- **PDFs** → extracted to text (requires `pdfjs-dist`)
- **Markdown** (`.md`) → ingested as-is
- **Plain text** (`.txt`) → ingested as-is
- **JSON Q&A** → ingested as structured QA pairs (see `eecs281-faq.json`)

### Usage
```bash
# One-shot: ingest materials from a directory
node dist/gsi/gsi-ingest.js \
  --course eecs281 \
  --dir ~/materials/eecs281/ \
  --tags "lecture:4,syllabus"

# Or use the setup script with --materials
./setup-course.sh --course eecs281 --guild 123 --ta 456 --materials ~/materials/
```

### Tips
- **Start small:** Ingest just the syllabus and 2–3 key lectures first. Test `/ask` to validate answers.
- **Iterative:** Add more materials as the course progresses.
- **Naming:** Use clear filenames (e.g., `lecture-4-sorting.pdf`, `syllabus-f24.md`) — they appear in citations.
- **Deduplication:** If you ingest the same material twice, lobs-memory may have duplicates. Harmless but wastes space.

---

## Monitoring & Debugging

### Check Current Config
```bash
cat ~/.lobs/gsi/eecs281.json
```

### View Logs
```bash
# All GSI-related events
lobs logs --tail 100 | grep -i gsi

# Or follow live
lobs logs --follow | grep -i ask
```

### Verify Memory Ingestion
```bash
# Check what's in lobs-memory
curl http://localhost:7420/collections/eecs281-course
```

### Test the Agent Directly
```typescript
// In a Node REPL or test file
import { answerStudentQuestion } from './dist/gsi/gsi-agent.js';
import { loadCourseConfig } from './dist/gsi/gsi-config.js';

const course = loadCourseConfig('eecs281');
const answer = await answerStudentQuestion('What is a stack?', course);
console.log(answer);
```

---

## Troubleshooting

### `/ask` command doesn't appear in Discord
- **Cause:** Slash commands are cached locally. Clear Discord's cache.
- **Fix:** Hold Ctrl+Shift+Delete (Windows) or Cmd+Shift+Delete (Mac) in Discord, or wait 1 hour for cache to expire.
- Alternatively: Kick and re-invite the bot.

### Bot responds but answers are wrong/generic
- **Cause:** Course materials not ingested or irrelevant to the question.
- **Fix:** 
  1. Check `lobs logs | grep -i ingest` to see if materials were loaded.
  2. Verify `~/.lobs/gsi/eecs281.json` has `enabled: true` and correct `guildId`.
  3. Restart lobs: `lobs restart`

### TA doesn't receive DM escalations
- **Cause:** TA user IDs not configured, or TA has DMs disabled from bots.
- **Fix:**
  1. Verify `escalationUserIds` in `~/.lobs/gsi/eecs281.json` includes the TA's actual Discord user ID.
  2. Ask TA to allow DMs from this server's bot (Discord Server Settings → Privacy).
  3. Check `lobs logs` for DM errors.

### Bot is slow to respond
- **Cause:** Large number of documents in memory or slow LM Studio.
- **Fix:**
  1. Check `lobs status` — LM Studio should show a model loaded.
  2. Check model tier: `/model` in Discord. GSI uses `medium` tier by default.
  3. Limit memory search scope: edit `gsi-agent.ts` to search fewer top-k results.

### Confidence scores seem wrong
- **Cause:** Claude's confidence estimation is heuristic-based (it's not a Bayesian model).
- **Fix:** Adjust `confidenceThreshold` in config up/down based on observed performance. Start at 0.65, tune from there.

---

## Development

### Building
```bash
lobs build
```

### Testing
```typescript
// Test the answer generation directly
import { answerStudentQuestion } from './src/gsi/gsi-agent.js';

const result = await answerStudentQuestion('What is a hash table?', {
  courseId: 'eecs281',
  courseName: 'EECS 281',
  memoryCollections: ['eecs281-course'],
  confidenceThreshold: 0.65,
  // ... other config
});

console.log(result.answer);
console.log(`Confidence: ${result.confidence}`);
```

### Adding Citation Metadata
When ingesting materials, add `source` and `tags` to each chunk:

```typescript
// gsi-ingest.ts
const chunks = [{
  text: "...",
  source: "Lecture 4: Sorting Algorithms",  // What shows in citations
  tags: ["lecture:4", "sorting", "eecs281"]
}];
```

---

## FAQ

**Q: Can I use this for courses at other universities?**
A: Yes! The bot works with any Discord server and any course materials. Just adapt the seed Q&A and materials ingestion.

**Q: What if a student asks something outside the course scope?**
A: The bot will have low confidence (no relevant course materials to cite). Escalation logic kicks in → TA gets a DM.

**Q: How much does it cost to run?**
A: Lobs-core is self-hosted. The only API cost is Claude API calls (typically $0.01–$0.05 per question, depending on context size). No Discord costs.

**Q: Can I customize the bot's personality?**
A: Yes! Edit the system prompt in `gsi-agent.ts` line ~50. Make it friendlier, more formal, etc.

**Q: What's the accuracy/quality?**
A: Depends on course materials quality and confidence threshold. Start with 65%, monitor escalations, adjust up/down. Target: 80%+ of questions answered without escalation.

---

## Architecture Notes

### Memory Pipeline
1. User uploads/ingests materials → `gsi-ingest.ts`
2. Files parsed → chunked by semantic similarity
3. Chunks embedded (OpenAI/local) → stored in lobs-memory
4. Query comes in → vector search for top-k relevant chunks
5. Chunks + question → Claude for answer generation

### Escalation Design
- **Why escalate?** TAs might explain better, students might need clarification, or the bot's answer might be wrong.
- **Low confidence threshold (0.65):** Safer but more escalations → more TA load
- **High threshold (0.85):** Fewer escalations but riskier (wrong answers to students)
- **Tuning:** Monitor escalations for a week, adjust to find your sweet spot.

### Citation Accuracy
The bot cites sources from memory chunks. If source metadata is wrong, citations are wrong. Ensure materials are ingested with clear `source` labels.

---

## Next Steps

1. **Deploy to EECS 281** (Fall 2024) — validate with real students
2. **A/B test confidence thresholds** — find the sweet spot between coverage and TA load
3. **Expand to EECS 376, 281F, 203** — 4 courses = ~$2k/semester baseline
4. **Build a web dashboard** for TAs to review escalations, tune threshold, see analytics
5. **Collect feedback** from students + TAs → iterate

---

## Support

- **Issues?** Check the troubleshooting section above.
- **Feature requests?** Open an issue in the lobs-core repo.
- **Questions?** Ask on the `#gsi-dev` Discord channel (or dm Rafe).

Good luck! 🚀
