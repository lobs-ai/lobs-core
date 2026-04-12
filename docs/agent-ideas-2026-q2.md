# Agent Project Ideas — 2026 Q2 Evaluation

**Objective:** Maintain 2-3 agent project ideas in active evaluation/prototype stage. Each idea evaluated on: business case, technical feasibility, cost, implementation difficulty, and market timing.

**Status:** Generate 6 new ideas, score each, select top 2-3 for prototype.

---

## Idea 1: Research Paper Summarization Agent (SaaS)

**Concept:** Multi-page research paper → structured JSON summaries (abstract, methods, key findings, citations, limitations). Used by researchers, grad students, scientists doing literature reviews. Agents recursively summarize sections, synthesize across papers, generate comparison tables.

**Market:**
- 15M+ researchers globally
- Current tools: expensive (Elicit AI, Consensus, Scholarcy) or mediocre (generic LLM summarization)
- Price elasticity: high — researchers will pay $10-50/month for good summaries
- Expansion: auto-digest journal feeds, generate research briefing emails

**Technical:**
- Leverage existing lit-review service (459 lines, untested but code-complete)
- Need PDF extraction pipeline (pdfparse or pypdf)
- Multi-agent loop: extract → summarize sections → compare → rank
- MiniMax: cheap at $0.000x per token; good for high-volume processing

**Feasibility:** HIGH. Lit-review service already exists. PDF parsing is standard.

**Cost:** $500-2000 setup (engineer time), ~$0.02-0.05 per paper at MiniMax rates.

**Difficulty:** MEDIUM. Core logic done, needs PDF pipeline + API wrapper + payment system.

**Timeline:** Prototype in 1 week, MVP in 3 weeks.

**Classification:** SaaS. Recurring revenue model.

---

## Idea 2: Code Review + Explanation Agent (B2B Developer Tool)

**Concept:** GitHub hook → agent reviews each PR, explains changes in plain English for code owners, flags issues before merge. Agents: read diff → ask why → flag patterns → explain business impact.

**Market:**
- 20M+ developers on GitHub
- Enterprise pain: code review bottleneck, senior devs spend 4+ hours/week
- Pricing: $50-200/month/repo (B2B)
- Existing: GitHub Copilot only does completions, not review

**Technical:**
- GitHub API for PR diff + comments
- Agentic loop: parse diff → understand intent → evaluate tradeoffs → flag risks
- Model: Sonnet for code understanding (better at reasoning than MiniMax)
- Integration: Discord webhook for async notifications OR github app for native reviews

**Feasibility:** HIGH. GitHub API is stable. Code understanding is Claude's strength.

**Cost:** ~$0.05-0.20 per PR at Sonnet rates. Can offset with usage tiers.

**Difficulty:** MEDIUM-LOW. Main work: GitHub integration + pattern database.

**Timeline:** MVP in 2 weeks.

**Classification:** SaaS. B2B, entry price $50/month for single repo.

---

## Idea 3: Legal Document Reviewer + Risk Summarizer (SaaS, High-Touch)

**Concept:** Contract → agent flags risk clauses, explains legal jargon, highlights deviations from standard templates. Uses RAG over legal precedent database. Escalates high-risk items to human attorney.

**Market:**
- 5M+ small businesses / freelancers sign contracts yearly
- Pain: legal review is expensive ($500-5k per contract)
- Current alternatives: Levity AI (basic), Ironclad (enterprise-only), DIY templates
- Price: $20-100 per contract review (high willingness to pay)

**Technical:**
- Document parsing (PDF/DOCX)
- RAG: Index common contract templates + precedent (Wikipedia, public contracts)
- Multi-agent: risk detector → plain-English explainer → severity rater
- Escalation: flag for human attorney triage

**Feasibility:** MEDIUM. Legal domain is deep. Need careful evaluation of accuracy.

**Cost:** ~$0.02-0.10 per contract (mostly LLM). Attorney escalation: $0 (agent escalates, humans charge separately).

**Difficulty:** MEDIUM. Domain complexity is high; liability concerns.

**Timeline:** Prototype in 2 weeks (basic risk flagging), full MVP 6 weeks (needs legal domain vetting).

**Classification:** SaaS. High touch (sales-assisted, legal vetting required).

---

## Idea 4: Meeting Notes Processor + Action Item Extractor (Internal Tool / Light SaaS)

**Concept:** Transcription (from Riverside.fm, Zencastr, or raw audio) → structured meeting notes, action items w/ assignees, decision log. Agents: extract speaker → summarize by topic → extract actions → map to people.

**Market:**
- 500M+ meetings/week in large orgs
- Pain: Otter.ai gets transcription right but misses structure; Fireflies.ai is expensive
- Pricing: $15-40/month, high usage retention (used in all meetings)
- Expansion: calendar integration → auto-pull meetings → auto-notes

**Technical:**
- Audio input: Riverside/Zencastr API OR file upload
- Multi-agent: transcription (use existing service) → summarize → extract actions → assign owners
- Storage: Postgres for notes, Discord/Slack for notification
- MiniMax: cheap enough for high volume

**Feasibility:** HIGH. Transcription is solved (Deepgram, Whisper API). Structuring is pure agentic work.

**Cost:** ~$0.01 per meeting (mostly transcription service).

**Difficulty:** LOW-MEDIUM. Integration is the main work.

**Timeline:** MVP in 1-2 weeks (just agent + storage). Full integration with calendars: 3-4 weeks.

**Classification:** Light SaaS (internal tool + shareable workspace). Entry price $20/month.

---

## Idea 5: Job Application + Resume Tailor Agent (Consumer SaaS)

**Concept:** User uploads job posting + resume → agent tailors resume to match posting, generates cover letter, scores application competitiveness. Multi-agent: parse job → analyze resume fit → rewrite → generate letter → score (0-100).

**Market:**
- 10M+ job seekers/month
- Pain: resume tailoring takes 1-2 hours per application; most applications get rejected due to poor fit
- Current tools: Resume builders (static), ChatGPT (requires manual prompting)
- Price: $5-20 per application, or $10/month subscription

**Technical:**
- Input: job posting (URL or paste), resume (PDF/text)
- Agents: parse job requirements → match to resume → identify gaps → rewrite sections → generate cover letter → score
- Scoring: use internal rubric (keywords, experience level, industry, years)
- Model: MiniMax or Sonnet (good at generation + reasoning)

**Feasibility:** HIGH. Straightforward agentic loop.

**Cost:** ~$0.01-0.05 per application (mostly LLM).

**Difficulty:** LOW. Main work: PDF parsing, UI, payment system.

**Timeline:** MVP in 1 week.

**Classification:** B2C SaaS. Pay-as-you-go ($5/application) or subscription ($10/month = 2 applications).

---

## Idea 6: Investor Due Diligence Analyzer (B2B, High-Value)

**Concept:** Startup funding round → agent analyzes deck, financial model, market TAM, comparable exits, risk factors. Generates scorecards for VCs. Uses RAG over deal DB + public market data.

**Market:**
- 50k+ angel investors, 10k+ VCs globally
- Pain: due diligence is time-consuming (100+ hours per deal), often missed risks
- Current tools: PitchBook (data only), Carta (portfolio tracking)
- Price: $1k-10k per deal analysis (B2B), or SaaS subscription $500/month for analysts

**Technical:**
- Input: pitch deck (PDF), financial model (CSV/Excel)
- RAG: Index 50k+ public startups, their trajectories, exits, failures
- Agents: parse deck → extract metrics → benchmark against comparable → calculate TAM → flag red flags → score (0-100)
- Escalation: flag for senior analyst review

**Feasibility:** MEDIUM. Market data is available (Crunchbase, PitchBook APIs). Risk scoring is subjective.

**Cost:** ~$0.05-0.30 per deal (mostly RAG retrieval + LLM).

**Difficulty:** MEDIUM-HIGH. Requires financial domain expertise; liability if analysis is poor.

**Timeline:** Prototype in 3 weeks, MVP in 6-8 weeks (needs validation with actual VCs).

**Classification:** B2B SaaS. Enterprise or per-deal pricing.

---

## Scoring Matrix

| Idea | Market Size | Revenue Potential | Build Difficulty | Timeline | Liability Risk | Score |
|------|-------------|-------------------|------------------|----------|----------------|----- |
| **Research Paper Summary** | Large (15M) | HIGH (SaaS) | Medium | 3 wks | Low | **8.5/10** |
| **Code Review** | Large (20M) | HIGH (B2B) | Medium | 2 wks | Low | **8.7/10** |
| **Legal Reviewer** | Medium (5M) | VERY HIGH | Medium | 6 wks | HIGH | 6.5/10 |
| **Meeting Notes** | Huge (500M) | High (SaaS) | Low | 2 wks | Low | **8.8/10** |
| **Job Tailor** | Large (10M) | Medium (B2C) | Low | 1 wk | Low | **7.5/10** |
| **Investor DD** | Medium (50k) | VERY HIGH | High | 6-8 wks | HIGH | 6.0/10 |

---

## Recommendation

**Top 3 for Immediate Prototyping:**

1. **Meeting Notes Processor** (Score: 8.8)
   - Fastest to MVP (1-2 weeks)
   - Lowest technical risk
   - Immediate use case (Rafe can eat his own dog food in Lobs-Lab Discord)
   - Can validate in real time with actual meetings

2. **Code Review Agent** (Score: 8.7)
   - High GitHub market penetration
   - Clear B2B revenue model ($50/month/repo = $600/year per customer)
   - Leverage Lobs-core itself as beta customer (review PRs on lobs-core)
   - Defensible: hard to replicate without agentic reasoning

3. **Research Paper Summary** (Score: 8.5)
   - Lit-review service already 70% done
   - Academic market is ready to pay ($50/month for 5-paper/month service)
   - Can validate with UMich GSI network (Rafe's connections)
   - Expansion path: auto-digest journals, research briefing service

---

## Progress Log

### 2026-04-12 — Code Review Agent prototype built ✅
- **Prototype:** `~/lobs/prototypes/code-review/code-review-agent.ts` (430 lines)
- **Status:** Working end-to-end. Smoke-tested against real GitHub PRs.
- **What it does:** Fetches PR diff via GitHub API → understands intent → per-file review → synthesis (risk level, breaking changes, merge readiness) → formatted Markdown output → optional GitHub comment post
- **Smoke test result:** Reviewed `expressjs/express#5550` — correctly flagged as BLOCKED/critical: PR inserts "apana college" into CI YAML (vandalism or accidental), would break all builds. Zero false negatives on a genuinely bad PR.
- **Cost per run:** ~$0.003 (claude-haiku-4-5, typical 3-10 file PR)
- **Next:** Wire GitHub webhook into lobs-core, auto-review all new PRs in lobs-ai org

## Next Steps

- **This week:** Register GitHub App on lobs-ai org, add webhook handler to lobs-core `src/api/webhooks-github.ts`
- **Next:** Auto-review all new PRs in lobs-core + paw-hub, Discord DM on critical issues found
- **Then:** Lit-review service PDF pipeline (70% done — needs arXiv PDF ingestion)
- **Month 2:** Evaluate traction on code review, decide whether to SaaS-ify

---

**Author:** Programmer Agent  
**Date:** 2026-04-12  
**Status:** Code Review Agent prototype ✅ complete. GitHub App integration next.
