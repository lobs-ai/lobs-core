# AI Agent Opportunities: Real-World Bottlenecks Outside Healthcare

**Research date:** 2026-04-11  
**Scope:** 5 domains — OSS maintenance, legal review, supply chain, peer review, government permitting  
**Method:** Web search + primary source fetch across ~20 sources

---

## 1. Open-Source Project Maintenance

### The Pain Point

Open-source maintainer burnout is a well-documented crisis, not a vibe. Key numbers:

- **44% of maintainers** report burnout as a significant problem (Tidelift 2023 Maintainer Survey, n=400+)
- **60% are unpaid** for their maintenance work despite projects being embedded in commercial software
- The **Linux kernel** receives ~8,000–10,000 patches per merge window; the review queue is managed by a thin layer of trusted lieutenants. Greg Kroah-Hartman alone handles the driver subsystem for thousands of patches per cycle
- **Kubernetes** has ~3,000 open issues at any given time; some PRs wait months for review due to reviewer bandwidth. The k8s project has formal "lgtm" and "approve" bot workflows but human bottleneck remains
- **React, Vue, Angular**: popular JS frameworks routinely have 500–1,500 open issues. Vue 3's migration issues sat open for 12–18 months on average during peak transition
- GitHub's own data (2022 Octoverse): **median first-response time** for issues in popular repos is 3–5 days; median time to close is **weeks to months**. In the top 1% of repos (most stars), issues are actually harder to get triaged — too much volume

**What burns maintainers out specifically:**
- Duplicate/invalid bug reports (estimated 30–50% of incoming issues)
- Reproducing bugs on specific environments they don't have
- Writing rejection messages politely for out-of-scope PRs
- Chasing contributors for missing info (no repro steps, no version info)
- Keeping changelog, release notes, CHANGELOG.md up to date

### Current State of Automation

Existing tools are **rule-based bots**, not agents:
- **Probot** (GitHub): staleness bots, label bots, PR size checkers — purely reactive rules
- **GitHub Actions**: CI/CD automation, but no semantic understanding
- **Kodiak**: auto-merge bot based on rules
- **Renovate / Dependabot**: dependency update PRs — narrow scope

**Agent-based tools emerging (2024–2025):**
- **SWE-agent** (Princeton, open-source): takes a GitHub issue, autonomously tries to fix it. State-of-the-art on SWE-bench among open-source projects. Repo: `github.com/SWE-agent/SWE-agent`
- **OpenHands** (formerly OpenDevin): open-source autonomous software engineering platform. Has a "resolver" that automatically fixes GitHub issues. Repo: `github.com/All-Hands-AI/OpenHands`
- **Devin** (Cognition, commercial): autonomous engineer, can reproduce bugs, write fixes, open PRs

**Gap:** None of these focus on *triage* — the pre-code work of classifying, deduplicating, requesting info, and routing issues. That's 60–70% of maintainer interrupt-driven work.

### Why Agents Specifically

Simple ML classifiers can label issues. Agents can:
1. **Read the issue** → fetch the linked code → **reproduce the bug** in a sandbox
2. Search existing issues for **duplicates** using semantic similarity + actual code context
3. **Post a structured reply**: "I reproduced this on Node 18.2, not on 20.x. Likely related to #4521. Missing: your webpack config."
4. **Escalate with context** — not just a label, but a summary of what the agent found
5. Loop: if maintainer responds, continue the thread autonomously

The multi-step, multi-tool, stateful nature of triage is precisely the agent use case. A classifier can't fetch your repo and run your test suite.

### Feasibility for a Small Team

**High.** The surface area is well-defined:
- GitHub API is excellent
- Sandboxed code execution is solved (E2B, Modal, Fly.io)
- SWE-agent is MIT-licensed and forkable
- Target market: maintainers of mid-sized OSS projects (500–5,000 stars) who are drowning but not resourced like Linux
- Monetization: GitHub App, $20–50/month per repo, or per-seat for org accounts

**Closest existing play:** `github.com/github/spark` (GitHub's internal experiments), and several Y Combinator companies in the 2024 batch targeting this.

---

## 2. Legal Document Review / Contract Analysis

### The Pain Point

E-discovery and contract review are the single largest labor cost in litigation and transactional law:

- **$50–100 per hour** for contract review attorneys; **$300–500/hr** for senior associates doing the same work
- A medium-size litigation matter can involve **1–10 million documents**; review costs routinely hit **$1–5M per matter**
- RAND Corporation studies estimate **document review = 70–80% of total e-discovery costs**
- The US legal market spends approximately **$350 billion/year** on legal services; a substantial fraction is document review
- **Manual review accuracy** is approximately 67–80% for relevance determinations — meaning human reviewers are wrong 20–33% of the time on first pass
- In contract work: a standard M&A due diligence review of a target company's contracts (500–2,000 contracts) takes **3–6 weeks** of associate time at large firms

**Specific broken workflows:**
- NDAs: median time to execute at large companies = **26 days** (World Commerce & Contracting, 2019 — this hasn't improved much)
- Contract renewal tracking: manual calendaring, missed deadlines costing companies millions in auto-renewals they didn't want
- Regulatory compliance review: checking hundreds of vendor contracts against GDPR/CCPA obligations is manual and error-prone

### Current State of Automation

**Generation 1 (keyword/rules):** Relativity, Nuix — fast keyword search, basic filtering. Widely deployed. Not intelligent.

**Generation 2 (ML classifiers):** Technology-Assisted Review (TAR), predictive coding. Reduces review volume by 50–70%. Widely accepted in courts since *Da Silva Moore v. Publicis* (2012). Tools: Relativity Active Learning, Reveal, DISCO.

**Generation 3 (LLM-based, 2023–present):**
- **Harvey AI** (commercial): trained on legal data, used by A&O Shearman, Allen & Overy, PwC Legal. Focuses on contract Q&A, drafting, due diligence
- **Ironclad** (contract lifecycle management): AI clause extraction and risk flagging
- **Kira Systems** (acquired by Litera): machine learning contract review, clause identification
- **Lexion**: contract management + AI for SMBs
- **CoCounsel** (Thomson Reuters / Casetext acquisition, $650M): AI legal assistant with document review capabilities
- **Spellbook**: AI contract drafting for transactional lawyers

**The gap:** These are mostly **Q&A interfaces** on top of documents. They don't *act*. They answer "does this contract have a limitation of liability clause?" They don't: negotiate redlines autonomously, track obligations across a portfolio of contracts, flag when a vendor contract conflicts with a customer contract, or run a multi-step due diligence workflow.

### Why Agents Specifically

An agent on a due diligence task can:
1. Ingest all target company contracts
2. For each contract: extract key terms (term, auto-renewal, governing law, IP ownership, change-of-control provisions)
3. Cross-reference extracted terms against the acquirer's standard positions
4. Flag conflicts, escalate high-risk items, draft a summary memo
5. When a lawyer asks "which contracts need consent for the acquisition?" — run the query, find the change-of-control clauses, draft the consent request letters

This is **multi-step, multi-document, action-taking work** — not a classifier.

### Feasibility for a Small Team

**Medium-High.** 
- Data is the moat — legal AI companies spend heavily on fine-tuning on legal corpora
- BUT: the SMB/mid-market is underserved. Harvey targets BigLaw. A small team could target: mid-size law firms (10–50 attorneys), in-house legal teams at Series B–D companies, commercial real estate operators with large lease portfolios
- Open-source starting point: **LlamaIndex** has legal document parsing examples; **Langchain** has contract review chains
- Regulatory risk: giving "legal advice" is restricted. Tool must be positioned as "legal research assistance"

---

## 3. Supply Chain Optimization

### The Pain Point

Supply chain inefficiency is massive and concentrated in manual, paper-based processes:

- **$507 billion** of working capital is trapped in S&P 1500 supply chains due to manual paper-based processes (BIMCO research, cited 2023)
- **Manual confirmation/data entry** accounts for 13–19% of total logistics costs; costs the US economy **~$95 billion/year** (NextBillion.ai analysis citing industry studies)
- **BackOps** (raised $6M in 2024) positions itself as solving a "$100 billion logistics inefficiency problem" — specifically the back-office operations of freight brokers
- European shippers face a **€2.5 billion automation gap** in transport management systems

**The SMB-specific problem:**

Large shippers (Walmart, Amazon) have sophisticated ERP/WMS/TMS systems. **SMBs (10–200 employees) typically run on:**
- Excel spreadsheets for inventory planning
- Email threads for purchase orders
- Phone calls and PDFs for carrier quotes
- Manual data re-entry across 3–5 disconnected systems (QuickBooks, a carrier portal, a WMS, email, a customer portal)

Specific broken workflows:
- **Spot freight quoting**: a shipping manager sends emails/makes calls to 5–10 carriers, collects quotes in a spreadsheet, manually picks the best — takes **2–4 hours per shipment**
- **Inventory reorder**: manually checking stock levels, manually creating POs, manually sending to suppliers — often resulting in stockouts (mean cost: **9% of annual revenue** per stockout event, IHL Group)
- **Proof of delivery / exception management**: "Where's my load?" queries take 15–30 min of manual tracking portal digging per incident; high-volume shippers have dedicated staff for this

### Current State of Automation

**Enterprise:** SAP TM, Oracle SCM, Blue Yonder — fully automated but cost $500K–$5M to implement, require large IT teams, 12–18 month implementations. Inaccessible to SMBs.

**SMB tools (rule-based):**
- Flexport: digitizes freight booking, but still human-heavy for exceptions
- project44: real-time visibility, but primarily for mid-market+
- Samsara: fleet/driver tracking for companies that own trucks

**AI-native (2023–2025):**
- **Shipwell**: AI-powered TMS targeting mid-market
- **Transfix**: AI-powered freight matching
- **Freightos**: instant freight rate comparison (more like a marketplace than an agent)
- **BackOps**: AI back-office for freight brokers specifically

**The gap:** None of these are *agents* that can take a multi-step, exception-heavy workflow end-to-end. They're still dashboards that humans monitor. When a shipment is late, a human still calls the carrier, updates the customer, re-routes if necessary.

### Why Agents Specifically

The supply chain exception case is the killer app for agents:
1. Shipment is 4 hours late → agent detects via API
2. Agent checks delivery window commitment to customer
3. Agent calls carrier API (or sends structured email) to get ETA update
4. Agent computes: will this breach SLA? If yes → find alternative carrier with available capacity
5. Agent drafts customer notification, gets human approval, sends it
6. Agent updates ERP with new ETA, logs the incident

This is **exactly** what agents are good at: multi-step, multi-system, time-sensitive, requires judgment but follows a known playbook 80% of the time.

### Feasibility for a Small Team

**High for a narrow wedge.**
- Don't try to build a TMS. Pick one painful workflow: exception management, or spot freight quoting, or reorder point automation
- APIs exist: Flexport API, project44, FedEx/UPS/USPS APIs, Shippo, EasyPost
- Target: freight brokers (20–100 employees) or e-commerce companies with 50–500 daily shipments
- Revenue model: per-shipment fee ($0.50–$2) or SaaS ($500–$2,000/month)
- Existing open-source: limited — this is a greenfield space for agents. LangGraph for workflow orchestration, Temporal for durable execution

---

## 4. Scientific Peer Review

### The Pain Point

Peer review is broken at scale. The system was designed for a world with ~10,000 papers/year; we now publish **2–3 million papers/year**.

Concrete numbers:
- **Average time from submission to first decision**: 3–6 months across most journals; top journals (Nature, Science, Cell) often 4–8 weeks for desk rejection, but 3–6 months if sent for review
- **SciRev** (scirev.org) — a crowd-sourced journal review tracker — shows median first-review-round durations of 6–20 weeks depending on field
- **Reviewer decline rates**: 40–60% of invited reviewers decline (Publons/Clarivate data); editors send 5–8 invitations to get 2–3 reviews
- **Reviewer shortage**: estimated **15 million hours** of peer review work performed annually for free (Publons 2018 estimate); this is increasing as publication volume grows faster than reviewer capacity
- **Time to publication** for accepted papers: median 6–12 months from submission to print/online
- **Preprint servers** (arXiv, bioRxiv) have exploded as a response — but preprints lack quality signals

**Specific broken workflows:**
- Editors manually scanning submissions for scope fit (desk rejection) — takes 30–60 min per paper
- Identifying qualified reviewers who will actually respond — editorial assistants spend hours per paper on this
- Chasing reviewers who said yes but haven't submitted (the #1 delay source)
- Consolidating reviewer comments into a decision letter
- Checking for statistical errors, figure manipulation, reference integrity

### Current State of Automation

**Existing tools:**
- **Editorial Manager, ScholarOne**: submission management software — pure workflow, no intelligence
- **iThenticate**: plagiarism detection (Turnitin for academic papers)
- **Statcheck** (R package, open-source): automatically checks statistical reporting in psychology papers — caught errors in 50% of papers in one study
- **ImageTwin**: detects image manipulation in figures
- **scite.ai**: citation context analysis — "this paper supports / contradicts / mentions this claim"

**Emerging AI review tools:**
- **Galactica** (Meta, 2022): withdrawn after criticism — hallucinated citations confidently
- **ReviewerGPT** (2023, paper): GPT-4 as a reviewer — showed LLMs can flag methodological issues but miss domain-specific nuances
- **AI Scientist** (Sakana AI, 2024): end-to-end automated paper writing AND reviewing — controversial but demonstrated feasibility
- **ARIES** (Nature Portfolio): AI system to help editors assess statistical and methodological quality
- **Semantic Scholar**: AI-powered paper recommendations and citation graphs — helps editors find reviewers

**Key paper:** *"Can large language models provide useful feedback on research papers?"* (Liang et al., 2023, arXiv:2310.01783) — found GPT-4 review feedback overlapped ~30% with human reviewer feedback; useful for surface issues, not deep domain expertise.

### Why Agents Specifically

The specific value of an agent over a single LLM call:
1. **Desk rejection triage**: Read paper → check against journal scope → check author's prior publications (Semantic Scholar API) → flag if out of scope with reasoning
2. **Reviewer identification**: Extract paper's topics/methods → search reviewer databases → check reviewer's recent papers → check COI (institution, co-authors) → draft personalized invitation
3. **Nudge loop**: Track pending reviewer invitations → send reminders at day 7, 14, 21 → escalate to editor at day 28
4. **Statistical checking**: Extract statistical claims → run Statcheck-style verification → flag anomalies for human attention
5. **Decision letter drafting**: Consolidate reviews → draft structured decision letter → human editor reviews and approves

None of these require superhuman AI. They require **coordination, memory, multi-step execution, and API access** — the agent primitive.

### Feasibility for a Small Team

**Medium — access is the hard part.**
- Journals and publishers (Elsevier, Springer Nature, Wiley) are large bureaucratic organizations; selling to them is a 12–24 month enterprise sales cycle
- **Better target**: preprint servers (arXiv, bioRxiv, SSRN) OR open-access journals (PLOS ONE, PeerJ) — more technically accessible, more willing to experiment
- **Or**: build tools for *authors* preparing submissions (pre-submission checklist, statistical review, reference verification) — B2C with lower friction
- Open-source: Statcheck (R, MIT), Semantic Scholar API (free), OpenAlex API (free, 250M papers)
- Revenue: institutional licensing to journals ($50K–$500K/year) or author-side SaaS ($20–100/submission)

---

## 5. Government Permitting / Regulatory Compliance

### The Pain Point

Government permitting is among the most consistently manual, slow, and costly processes in the US economy:

**Building permits:**
- Average permit approval time: **4–12 weeks** for residential; **3–12 months** for commercial; up to **2–3 years** for large infrastructure
- Building permit fees have **doubled as a percentage of construction costs** since 1998 (NAHB data): from 0.9% to 1.8% of total construction costs
- For a $665K average new home (2024 NAHB data): **$7,640 in permit fees alone**, plus $6,260 water/sewer inspection, $6,480 architecture/engineering fees — total regulatory overhead ~$93,000 per home (NAHB 2024 estimate: regulations add $93,870 to average new home price)
- NYC permit backlogs: the NYC DOB has had multi-year backlogs; some permit applications waited **18–24 months** for review

**Environmental permits:**
- EPA air quality permits (Title V): **2–3 year** average processing time
- Section 404 wetland permits (Army Corps of Engineers): **788 days average** for individual permits (2019 GAO report)
- FERC energy project permits: average **4–7 years** for large projects

**The manual workflow problem:**
- Most municipalities still accept paper applications or poorly-designed web forms
- Plan reviewers manually check drawings against code — a residential permit review takes **4–40 hours** of reviewer time
- Applicants don't know *why* they're rejected or what's missing; each iteration adds weeks
- Compliance tracking (environmental, zoning, ADA): companies manually maintain spreadsheets of permit expiration dates and renewal requirements

### Current State of Automation

**Government-side:**
- **Tyler Technologies** (Enterprise Permitting & Licensing): dominant incumbent, used by thousands of US municipalities. Workflow automation but not AI-powered review
- **OpenGov**: cloud-based permitting platform, some AI features being added
- **Accela**: competitor to Tyler, similar profile
- **Augence.ai**: new (2024–2025 startup) — "Smart Construction Permitting" with AI, founded by enterprise software veterans. Explicitly targeting AI-based plan review

**Private compliance side:**
- **Compliance.ai**: regulatory change monitoring (financial services focus)
- **Legalzoom, Avalara**: business license and tax compliance
- **No dominant player** exists for environmental permit tracking for mid-market companies

**The specific gap:** Automated *plan review* — checking submitted drawings against building codes — is the biggest unsolved problem. A human reviewer checks: setbacks, egress, structural loads, electrical, plumbing, fire code. This is a multi-document, multi-code-book lookup task.

### Why Agents Specifically

A permitting agent can:
1. **Pre-submission check**: Applicant uploads plans → agent checks against local zoning code + building code → returns structured list of deficiencies before submission → saves 1–4 iteration cycles
2. **Application assembly**: Agent knows jurisdiction X requires forms A, B, C; fetches current versions; pre-fills from project data; flags missing items
3. **Status monitoring**: Poll permit portal → detect status changes → notify stakeholder → trigger next step (schedule inspection, pay fee, upload revised plans)
4. **Compliance tracking**: For a company with 50 facilities in 20 jurisdictions → maintain calendar of permit renewals, inspection dates, reporting deadlines → auto-draft renewal applications 60 days before expiration

The reason agents beat simple automation here:
- **Codes change** — an agent can fetch current code, not rely on a static ruleset
- **Jurisdictions vary** — every county has different forms, fees, and requirements; an agent can navigate this dynamically
- **Communication is unstructured** — permit comments come back as free-text PDFs; an agent can parse them and suggest responses

### Feasibility for a Small Team

**Medium-High with the right wedge.**
- Don't attack the government-side (selling to municipalities is brutal)
- **Attack the applicant side**: builders, architects, environmental consultants, real estate developers — they have direct pain and budget
- Narrow wedge: **pre-submission plan check for residential permits** in the top 10 US metros (each has published code + fee schedule)
- Building codes are partially standardized: IBC (International Building Code) is the base for most US jurisdictions; amendements are local
- Open-source: **UpCodes** (upCodes.com) has digitized building codes; **ICC** (International Code Council) has APIs
- Related open project: **PERMIT-AI** (research prototypes exist in academic literature; no dominant open-source implementation found)
- Revenue: $500–$2,000 per permit application checked, or $1,000–$5,000/month SaaS for high-volume builders

---

## Cross-Domain Synthesis

### Ranking by Feasibility for a Small Team

| Domain | Pain Severity | Automation Gap | Access to Data | Sales Complexity | **Overall** |
|--------|--------------|---------------|----------------|-----------------|-------------|
| OSS Maintenance | High | Large | Easy (GitHub API) | Low (self-serve) | ⭐⭐⭐⭐⭐ |
| Supply Chain (narrow) | High | Large | Medium (carrier APIs) | Medium (SMB sales) | ⭐⭐⭐⭐ |
| Legal (SMB/in-house) | Very High | Medium | Medium (documents) | Medium | ⭐⭐⭐⭐ |
| Government Permitting | High | Large | Medium (codes public) | Medium (builders) | ⭐⭐⭐⭐ |
| Peer Review | High | Medium | Hard (journal access) | Hard (enterprise) | ⭐⭐⭐ |

### Common Pattern: The Agent Sweet Spot

All five domains share the same failure mode: **processes that are too complex for rules, too high-volume for humans, and too action-oriented for pure ML classifiers.**

The pattern is always:
1. Ingest unstructured input (issue, document, shipment data, paper, permit application)
2. Retrieve context (code, precedent, rates, code books, reviewer database)
3. Make a structured judgment
4. Take an action or draft a communication
5. Loop based on response

This is the agent loop. Simple automation fails at step 2. ML models fail at steps 4–5. Agents cover the full chain.

### Highest-Conviction Opportunity

**OSS Maintenance Triage Agent** is the clearest opportunity for a small team:
- Problem is severe and getting worse
- Target users are technical and will adopt quickly if the tool works
- GitHub API + sandbox execution (E2B) + SWE-agent as base = buildable in weeks
- No dominant player owns this specific workflow
- Viral distribution: maintainers talk to each other; word-of-mouth within OSS communities

**Close second: Supply Chain Exception Management** for freight brokers — the $100B BackOps market, narrow workflow, good APIs.

---

## Sources

1. Tidelift 2023 Open Source Maintainer Survey — tidelift.com
2. GitHub Octoverse 2022 — octoverse.github.com
3. SWE-agent — github.com/SWE-agent/SWE-agent (Princeton NLP)
4. OpenHands — github.com/All-Hands-AI/OpenHands
5. RAND Corporation e-discovery cost studies (multiple years)
6. BIMCO Trade Digitalisation Paper, 2023 — drybulkmagazine.com
7. BackOps $6M raise, 2024 — successquarterly.com
8. NextBillion.ai logistics cost analysis — nextbillion.ai
9. European TMS Automation Gap — transportmanagement.org
10. SciRev journal review tracker — scirev.org
11. Liang et al. 2023, "Can LLMs provide useful feedback on research papers?" — arXiv:2310.01783
12. AI Scientist (Sakana AI, 2024) — sakana.ai
13. Statcheck — statcheck.io
14. NAHB regulatory cost data 2024 — nahb.org / nwrealtor.com
15. GAO report on Section 404 permit timing, 2019 — gao.gov
16. Augence.ai — augence.ai
17. Harvey AI — harvey.ai
18. Ironclad, Kira Systems, CoCounsel — product sites
19. World Commerce & Contracting NDA cycle time data, 2019
20. Da Silva Moore v. Publicis (SDNY 2012) — TAR legal precedent
