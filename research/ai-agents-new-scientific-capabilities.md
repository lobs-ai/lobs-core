# AI Agents Enabling Genuinely New Scientific Capabilities
**Research Memo — 2026-04-11**
**Scope:** What can AI agents do in science that is categorically new — not faster reviews, but impossible-without-agents capabilities

---

## Criteria Applied
For each domain, I applied a strict filter:
- The agent must be the **primary actor**, not an assistant
- The capability must be **impossible or impractical at human scale** — not just slow
- Something must be **physically produced or discovered** as a result (a compound, a proof, a detection)

---

## 1. Autonomous Scientific Hypothesis Generation & Testing (Self-Driving Labs)

### What's actually new here
A human chemist can design ~5–10 synthesis experiments per week. A self-driving lab can design, execute, interpret, and iterate **hundreds per day**, with each iteration informed by the last. The agent isn't summarizing what a chemist decided — it *is* the chemist, planner, analyst, and lab technician simultaneously. The novelty is **closed-loop autonomous iteration**: the agent changes its own hypotheses based on experimental outcomes without human intervention between cycles.

### The A-Lab (Berkeley) — Best Existing Example
- **Paper:** "An autonomous laboratory for the accelerated synthesis of novel materials" — *Nature* 624, 86–93 (2023). DOI: 10.1038/s41586-023-06734-w
- **What it did:** In **17 days of unattended operation**, synthesized **41 novel inorganic compounds** from a candidate set of 58. Human chemists would take years to attempt the same breadth.
- **Architecture:** 
  - Ab initio DFT databases (Materials Project) for candidate generation
  - ML models to predict synthesis conditions
  - Robotic arms handle all physical operations (weighing, mixing, firing, characterizing)
  - Active learning loop: each failure narrows the parameter space for the next attempt
- **The new capability:** Not just speed. The system explored **synthesis condition spaces** that humans wouldn't bother trying because the probability of success looked low. The agent has no psychology of failure — it runs the low-probability experiments.

### Other Self-Driving Lab Projects
| Project | Domain | Key Capability |
|---|---|---|
| **Emerald Cloud Lab** (now Absci) | Biology/chemistry | Remote programmable lab; API-accessible instruments. Researchers write code, robots run experiments. |
| **Strateos** | Drug discovery | Cloud robotics platform; open API for experiment scheduling |
| **Autonomous Chemistry Lab (MIT/Cheetah)** | Organic synthesis | Automated retrosynthesis + physical synthesis execution |
| **Adam/Eve robots (Manchester)** | Drug discovery / genomics | Adam was first robot to independently discover scientific knowledge (yeast gene functions, 2009) |

### Open Data & Tools Available to Small Teams
- **Materials Project API** (`mp-api`, free): 150,000+ computed material properties, formation energies, band gaps. Query targets computationally.
- **AFLOW** (aflow.org): 3.5M+ compounds, REST API. For high-throughput screening.
- **Citrination** (Citrine Informatics): ML platform for materials property prediction
- **NOMAD Repository**: Open DFT calculation data
- **RXN for Chemistry** (IBM): API for chemical reaction prediction — predicts products AND synthesis routes
- **Chemputer** (Hessian group): Open-source chemical synthesis robot software

### Feasibility for a Small Team
**High** if not requiring physical robotics. A software-only team can:
1. Pull Materials Project candidates via API
2. Use ML models (MEGNet, CGCNN, or MatBERT) to filter/rank candidates
3. Use RXN4Chemistry API to predict synthesis routes
4. Submit to Emerald Cloud Lab or Strateos for physical execution
5. Parse XRD/spectroscopy results and feed back into the loop

The agent layer (hypothesis → experiment design → result interpretation → new hypothesis) is **entirely buildable** without owning a robot. The gap is wet lab execution — cloud labs solve this for biology; inorganic materials still requires either a partner lab or significant capital.

---

## 2. Space Research — Specific Bottlenecks Agents Can Uniquely Address

### 2a. The Data Backlog Problem (This Is Real and Severe)

**TESS Mission:**
- Observes 200,000+ stars continuously, ~27-day sectors, full sky coverage
- Generates ~100 GB/day of light curve data
- As of 2024, **thousands of TESS Objects of Interest (TOIs) remain unclassified** — humans physically cannot review them all
- The TESS pipeline flags candidates; a second human vetting pass is the bottleneck

**What an agent can do that's genuinely new:**
An agent running **continuous transit search + anomaly classification** across all TESS light curves simultaneously can:
- Detect **non-periodic transit patterns** (single transits, irregular timing variations) that rule-based pipelines miss
- Cross-correlate with GAIA stellar parameters, 2MASS photometry, and ground-based RV catalogs in real-time
- Autonomously **trigger follow-up observations** via APIs (Las Cumbres Observatory has an open API for this)
- Prioritize target queues based on habitability scoring — something no static pipeline does

**Tools available:**
- `lightkurve` (Python): full API access to all Kepler/K2/TESS data via MAST archive. `pip install lightkurve`. Free.
- `astroquery`: programmatic access to SIMBAD, NED, VizieR, MAST
- MAST API (mast.stsci.edu): NASA's archive, full REST API, free
- ExoFOP-TESS: community follow-up coordination, has API
- Las Cumbres Observatory (lco.global): open telescope network, submission API, ~$0.20/hr for 1m telescope time

**Specific open problem:** Planet Hunters TESS (citizen science) has a confirmed backlog of unreviewed light curves. An agent with `lightkurve` + a trained transit classifier could systematically cover this space in days. Humans take years.

### 2b. AEGIS — Autonomous Onboard Spacecraft Science (Deployed, Real)
- **AEGIS** (Autonomous Exploration for Gathering Increased Science) has been running on **Curiosity** since 2016, now on **Perseverance**
- It autonomously selects rock targets for ChemCam/LIBS analysis without waiting for Earth commands (one-way light travel: 3–22 minutes)
- **The new capability:** Rovers can operate scientifically during the ~16-hour communication blackout window, executing dozens of additional analyses per sol
- Paper: Francis et al., iSAIRAS 2024 (NASA JPL)
- **What's not done yet:** AEGIS targets *where to look*, but the agent doesn't yet generate hypotheses about *what it found*. The gap: connecting spectral results to geological hypotheses and autonomously revising traversal plans based on findings. This is the next frontier.

### 2c. SETI Signal Analysis — Genuinely Unsolved
- **Breakthrough Listen Open Data:** All radio telescope observations publicly available at `breakthroughinitiatives.org/opendatasearch`
- Data volumes: Green Bank Telescope generates ~PB-scale archives; analyzed fraction is small
- **Current approach:** Narrow-band Doppler drift search (turboSETI). Misses: wideband signals, pulsed signals, signals not optimized for our detection methods
- **Recent work:** arXiv:2505.03927 — ML anomaly detection on Breakthrough Listen data, Parkes + Green Bank, 2025
- **What an agent enables:** Unsupervised anomaly detection across **all signal morphologies simultaneously** — not just the signal types humans decided to look for in 1970. An agent can define new signal categories by clustering, find signals that don't fit any template, and flag them for human review.
- **Feasibility:** High. The data is public. `blimpy` (Python) reads BL filterbank files. A small team could build an autonomous pipeline: download → embed signal spectrograms → cluster → surface anomalies → log candidates. This is buildable in weeks.

### 2d. Asteroid Mining Feasibility Analysis
- **Minor Planet Center** (MPC) catalogs 1.3M+ asteroids with orbital elements — all public
- **WISE/NEOWISE** thermal infrared data gives size/albedo for ~160,000 asteroids
- An agent could autonomously:
  - Compute delta-V for spacecraft rendezvous with every catalogued NEA
  - Cross-correlate composition proxies (spectral type, albedo) with resource models
  - Rank targets by $/kg extracted vs. mission cost
  - Monitor newly discovered objects and trigger alerts when a high-value, low-delta-V target appears
- **No one is doing this continuously.** Planetary Resources and Deep Space Industries did it manually. This is an autonomous monitoring + prioritization problem that's entirely software-solvable.

---

## 3. Climate & Environmental Monitoring

### What Agents Enable That's New
The bottleneck isn't collecting satellite imagery — it's **acting on it at the speed it arrives**. Sentinel-2 images every point on Earth every 5 days at 10m resolution. Humans review maybe 0.1% of it. An agent that runs continuously against this feed can:
- Detect deforestation events within **days of occurrence**, not months
- Correlate changes across satellite sources (Sentinel-2 optical + Sentinel-1 SAR for cloud-penetrating monitoring)
- Automatically notify enforcement agencies via API
- Track **methane plume sources** from TROPOMI data and attribute them to specific facilities

### Real Projects and Evidence
- **Global Forest Watch** (Global Forest Watch API, free): Change alert system, but it's threshold-based, not agent-driven
- **Nature (2025):** Real-time deforestation anomaly detection using YOLOv8 + LangChain agent — context-aware dynamic threshold adjustment (DOI in search result: s41598-025-23617-4)
- **TROPOMI/Sentinel-5P:** Methane, NO2, CO data, global, daily. ESA open data. Python: `sentinelsat` API.
- **Planet Labs:** 3m resolution, daily global coverage. Commercial but has research program. API available.
- **Google Earth Engine (GEE):** Processes petabytes of satellite data server-side. Free for research. Python/JS API. This is the agent's compute substrate.

### The Genuinely New Capability: Closed-Loop Environmental Response
Current systems *alert* humans. An agent can:
1. Detect anomaly in Sentinel-2 imagery (new clearing in protected forest)
2. Cross-reference FIRMS fire data, OSM roads, land tenure records
3. Pull prior images to establish baseline + rate of change
4. File a structured incident report with coordinates, area, rate of change, and satellite imagery cutout via API to enforcement system
5. Set a watch flag on that location for daily monitoring

**No human in the loop until step 5.** This is categorically different from current practice.

### Coral Reef Monitoring (New Deployed Example)
- CCTech + Stream Ocean autonomous reef monitoring system (2025): AI-powered biodiversity analysis from continuous underwater sensors
- *Scientific Reports* (2025): Deep learning for automated coral reef monitoring with real-time marine animal detection
- The new capability: continuous 24/7 monitoring of reef health metrics — bleaching onset, species population shifts — at temporal resolution impossible for human divers

### Open Tools for a Small Team
| Tool | What it gives you |
|---|---|
| `sentinelsat` (Python) | Download Sentinel-1/2/5P imagery programmatically |
| Google Earth Engine Python API | Petabyte-scale satellite analysis, free for research |
| STAC (SpatioTemporal Asset Catalog) | Standardized API for querying any satellite archive |
| `rasterio` / `xarray` | Geospatial raster processing |
| FIRMS API (NASA) | Real-time fire/hotspot data |
| Global Forest Watch API | Deforestation alerts feed |

**Feasibility for small team:** High. GEE handles the compute. The agent layer is: monitor feed → run change detection model → classify change → act on high-confidence detections. A two-person team could build a working pipeline in 2–3 months.

---

## 4. Mathematical Conjecture Generation

### What's Actually New
Mathematicians produce conjectures at the rate of human insight — sporadic, slow. An algorithm exploring the space of mathematical relationships has **no cognitive bias toward "interesting" structures**, no confirmation bias, and can evaluate millions of candidate relationships in the time a mathematician spends on coffee. The agent doesn't replace proof — it generates **candidates for proof** that humans then verify.

### FunSearch (DeepMind, 2023–2024)
- **Paper:** "Mathematical discoveries from program search with large language models" — *Nature* 625, 468–475 (2024)
- **What it did:** Discovered new upper bounds for the **cap set problem** (combinatorics) — a problem open for decades. Also improved best-known solutions to bin packing.
- **Mechanism:** LLM generates Python functions that *compute* mathematical objects. An evaluator scores them. The best functions are fed back as examples. This is evolutionary program search guided by an LLM.
- **Key insight:** The LLM doesn't solve math — it generates **diverse program variations** that a symbolic evaluator can score. The agent explores program space; evaluation is rigorous.
- **Code:** Not fully open-sourced, but the approach is reproducible. DeepMind's AlphaTensor (matrix multiplication) used a similar approach.

### Ramanujan Machine / Ramanujan Library
- **Original Ramanujan Machine (Technion, 2021):** Algorithm that generates conjectures about mathematical constants (π, e, ζ(3)) as continued fractions. Found formulas resembling Ramanujan's hand-discovered identities.
- **Ramanujan Library (arXiv:2412.12361, ICLR 2025):** Extends this to a **hypergraph of integer relations** — nodes are constants, edges are formulas connecting them. System uses PSLQ algorithm to discover relations.
  - Discovered **75 previously unknown connections** between mathematical constants
  - Found new formulas for the "first continued fraction" constant C₁
  - Generalized a century-old Ramanujan formula for π and e
- **Code:** Public open-source API. Available on GitHub (Kaminer group, Technion).
- **What the agent does:** Systematically enumerates candidate integer relations via lattice-based algorithms, tests them numerically to high precision, filters to those that hold, then checks against known literature. Humans cannot enumerate this space manually.

### Open Problems Amenable to Automated Exploration
| Problem Class | Why Agents Help |
|---|---|
| **Integer sequences** (OEIS) | 370,000+ sequences; agent can search for undiscovered relationships between them. OEIS has full data export. |
| **Extremal combinatorics** | FunSearch showed this directly — searching for functions achieving extremal values |
| **Number theory / constants** | Ramanujan Library approach — systematic enumeration of relationships |
| **Graph theory** | Automated search for graph invariant bounds; conjecture generators exist (GraPHedron, AutoGraphiX) |
| **Knot theory** | Neural networks have already found new topological invariants (DeepMind, *Nature* 2021) |

### Tools Available
- **PSLQ algorithm:** Implemented in `mpmath` (Python). Free.
- **Wolfram Mathematica** (for verification; commercial) or **SageMath** (free, open-source)
- **OEIS API:** Full sequence database, downloadable
- **FunSearch-style approach:** Reproducible with any capable LLM + Python evaluator
- **GraPHedron:** Open-source conjecture generator for graph theory

### Feasibility
**Medium-High.** The math domain has the advantage that evaluation is cheap and rigorous — you don't need a physical lab. A small team can implement a FunSearch-style loop targeting a specific open problem in weeks. The hard part is choosing the right problem domain where the search space is constrained enough to find signal.

---

## 5. Genomics / Personalized Medicine

### 5a. Autonomous CRISPR Guide RNA Design
**What's new:** Designing guide RNAs (gRNAs) for a novel therapeutic target requires:
- Screening thousands of candidate sequences for on-target efficacy
- Predicting off-target cuts across the entire genome (3B+ positions)
- Optimizing for delivery system compatibility, secondary structure, GC content
- Iterating based on cell line assay results

This is a search problem in a space too large for human intuition. An agent can:
1. Accept a therapeutic target (gene + disease variant)
2. Enumerate all candidate gRNAs computationally
3. Score each via ML models (Azimuth, DeepCRISPR, CRISPOR)
4. Rank by predicted efficacy × specificity
5. Design validation experiments
6. Interpret assay results and re-rank

**Key tools:**
- **CRISPOR** (crispor.tefor.net): Web + API, predicts on/off-target scores for any gRNA. Open source, self-hostable.
- **DeepCRISPR** (GitHub: bm2-lab/DeepCRISPR): Deep learning model for gRNA efficacy prediction
- **Cas-OFFinder**: Fast off-target search, command-line, free
- **Benchling API**: Lab notebook + sequence design, has API for programmatic gRNA submission
- **GenomicFeatures / Bioconductor**: R/Python tools for genomic coordinate manipulation

### 5b. Patient-Specific Drug Interaction Prediction
**The new capability:** A pharmacogenomics agent can, given a patient's full variant call file (VCF from WGS):
- Query PharmGKB for all known variant-drug associations for their specific SNPs
- Query DGIdb for their specific gene-drug interactions
- Cross-reference against a proposed drug regimen
- Flag predicted CYP450 metabolizer status (affects dosing for 25%+ of drugs)
- Generate a ranked list of drug-gene-drug interaction risks *specific to that patient's genome*

No human can manually cross-reference a patient's 4M+ variants against all known pharmacogenomic associations. An agent can in minutes.

**Open tools:**
| Tool | What it provides |
|---|---|
| **PharmGKB API** (pharmgkb.org) | Curated variant-drug-phenotype associations |
| **DGIdb 5.0 API** (dgidb.org) | Drug-gene interaction database, GraphQL API |
| **ClinVar API** (NCBI) | Clinical variant classifications |
| **PyVCF / cyvcf2** | Parse patient VCF files |
| **CPIC Guidelines API** | Clinical pharmacogenomics implementation consortium — dosing guidelines by genotype |
| **OpenTargets API** | Target-disease-drug associations, GraphQL |

### 5c. Protein Design for Novel Therapeutics (Not Just Folding)
**AlphaFold2 solved structure prediction.** The next frontier — which agents are actively tackling — is **inverse design**: given a desired function, design a protein sequence that achieves it.

**Current pipeline (deployable now):**
1. **RFdiffusion** (Baker Lab, UW): Generate novel protein backbones conditioned on a target binding site. Takes a receptor structure, outputs a binder backbone. Open source on GitHub.
2. **ProteinMPNN** (Baker Lab): Given a backbone, generate amino acid sequences likely to fold into it. ~1 second per design, no expert customization needed.
3. **AlphaFold2 / ESMFold / Boltz-2**: Validate that the designed sequence actually folds as predicted (in silico).
4. **Rosetta**: Energy minimization and stability scoring.

**Full pipeline: RFdiffusion → ProteinMPNN → AlphaFold2 → Rosetta** can design **thousands of candidate binders per hour** on a GPU cluster. A human structural biologist designs a handful per year.

**What's genuinely new:** The agent isn't assisting a human designer — it's generating the design space autonomously. The human reviews top-ranked candidates. Without the agent, most of that design space would never be explored.

**Feasibility for small team:** Medium. All tools are open source. GPU compute required (A100 or similar for RFdiffusion). The pipeline is well-documented — the Australian Protein Design Initiative has a Nextflow workflow on GitHub (`nf-binder-design`). A computational biologist + ML engineer could deploy this in 1–2 months.

---

## Cross-Cutting Assessment

### Ranking by Feasibility for a Small Team (Software-Focused)

| Domain | Feasibility | Data Available | Key Blocker |
|---|---|---|---|
| **TESS exoplanet agents** | 🟢 High | MAST API, lightkurve, free | Need compute + trained classifier |
| **SETI anomaly detection** | 🟢 High | Breakthrough Listen public data | Compute for PB-scale signal data |
| **Math conjecture (Ramanujan/FunSearch)** | 🟢 High | OEIS, mpmath, open APIs | Choosing the right problem scope |
| **Climate/deforestation monitoring** | 🟢 High | GEE, Sentinel, FIRMS, free | ML change detection model |
| **Materials discovery (software-only)** | 🟡 Medium | Materials Project, AFLOW | Physical execution needs lab partner |
| **CRISPR gRNA design** | 🟡 Medium | CRISPOR, DeepCRISPR, open | Validation requires wet lab |
| **Protein design** | 🟡 Medium | All tools open source | GPU compute + wet lab validation |
| **Patient pharmacogenomics** | 🟡 Medium | PharmGKB, DGIdb, CPIC, free | Patient data access + regulatory |
| **Autonomous spacecraft** | 🔴 Low | AEGIS is deployed but closed | No access to spacecraft hardware |

### The Common Pattern Across All Domains
Every one of these opportunities shares the same structure:
1. **Search space is astronomically large** — more candidates than humans can evaluate
2. **Evaluation is automatable** — either computationally (math, materials screening, gRNA scoring) or via API (cloud labs, telescope time)
3. **Iteration is the key** — the agent's advantage compounds with each cycle; humans can't iterate at this speed
4. **Data exists but is underexplored** — the bottleneck isn't data collection, it's systematic analysis

The distinction from "AI reviews stuff faster": in all these cases, the agent is **generating the candidates**, **designing the tests**, and **interpreting the results** — not reviewing human-generated content. The human role shifts from scientist-as-experimenter to scientist-as-goal-setter.

---

## Top 3 Recommendations for Where to Build First

### 1. Autonomous TESS Exoplanet Agent (Easiest high-impact entry point)
- All data free, well-documented API
- Clear evaluation metric (transit detection + false positive rejection)
- Existing community infrastructure (TOI catalog, ExoFOP)
- Can trigger real follow-up observations via Las Cumbres API
- Impact: could find planets that would otherwise never be confirmed

### 2. SETI Continuous Anomaly Monitor
- Public data, no physical hardware needed
- Problem is genuinely unsolved — existing tools only search for one signal type
- Low bar to publishing novel methodology
- `blimpy` + unsupervised clustering is buildable fast

### 3. Autonomous Deforestation Enforcement Agent (GEE + Sentinel)
- Real-world policy impact, not just academic
- GEE handles all compute, agent just orchestrates
- Closed loop is achievable: detect → characterize → report → monitor
- Connects to existing enforcement infrastructure

---

## Sources & References

1. Szymanski, N. et al. "An autonomous laboratory for the accelerated synthesis of novel materials." *Nature* 624, 86–93 (2023). https://doi.org/10.1038/s41586-023-06734-w
2. Romera-Paredes, B. et al. "Mathematical discoveries from program search with large language models." *Nature* 625, 468–475 (2024). [FunSearch]
3. Beit-Halachmi, I. & Kaminer, I. "The Ramanujan Library — Automated Discovery on the Hypergraph of Integer Relations." arXiv:2412.12361 (2024). ICLR 2025.
4. Francis, R. et al. "AEGIS M2020." iSAIRAS 2024. https://ai.jpl.nasa.gov/public/documents/papers/francis-isairas-2024.pdf
5. Thompson, M. et al. "AEGIS autonomous targeting for ChemCam on Mars Science Laboratory." *Science Robotics* 2(7), eaan4582 (2017).
6. Breakthrough Listen Open Data Archive: https://breakthroughinitiatives.org/opendatasearch
7. arXiv:2505.03927 — ML anomaly detection on Breakthrough Listen data (2025)
8. *Nature Scientific Reports* (2025): Real-time deforestation anomaly detection using YOLOv8-LangChain. DOI: s41598-025-23617-4
9. Lightkurve documentation: https://lightkurve.github.io/lightkurve/
10. Materials Project API: https://materialsproject.org/api
11. DGIdb 5.0: Jumper et al., *Nucleic Acids Research* 52(D1):D1227 (2024).
12. RFdiffusion: Watson, J. et al. "De novo design of protein structure and function with RFdiffusion." *Nature* 620, 1089–1100 (2023). Baker Lab GitHub: https://github.com/RosettaCommons/RFdiffusion
13. ProteinMPNN: Dauparas, J. et al. *Science* 378, 49–56 (2022). https://www.ipd.uw.edu/software/
14. CRISPOR: http://crispor.tefor.net / GitHub: https://github.com/maximilianh/crispr-screen
15. nf-binder-design (Australian Protein Design Initiative): https://australian-protein-design-initiative.github.io/nf-binder-design/
