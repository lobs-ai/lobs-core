# ADR: Local Model Tier for SAIL Compliance

**Status**: Accepted  
**Date**: 2026-03-06  
**Author**: Architect agent  
**Context**: SAIL compliance meeting — need a defined product tier for institutions that cannot send data to cloud AI providers.

---

## Problem Statement

SAIL (and similar institutional customers — universities, healthcare, K-12) cannot use cloud AI providers for student records (FERPA), health data (HIPAA), or other regulated data. They need PAW to run AI entirely on-premises. The existing PAW cloud tier ($20/mo) is unsuitable for these customers.

We need to define:
1. What the local model tier includes (feature list)
2. How to price it (pricing model + upgrade path)
3. How it surfaces during onboarding (integration spec)
4. What hardware is required (minimum spec + recommendations)

**Important**: The compliance enforcement infrastructure (bifurcated memory, hierarchical compliance settings, model-resolve hook, compliance status reports) is already built or in progress. This ADR defines the **product packaging** around that infrastructure.

---

## Solution Overview

Two tiers:

| | Cloud Tier | Local Model Tier |
|---|---|---|
| Price | $20/mo | $65/mo |
| AI provider | Anthropic / OpenAI | Local model (Ollama, LM Studio, llama.cpp) |
| Compliant memory | ❌ | ✅ |
| FERPA/HIPAA safe | ❌ | ✅ |
| Data leaves machine | Yes | Never |
| Setup complexity | Low | Medium |

Upgrade path: Cloud → Local is a one-click plan upgrade in the client portal + a local model setup wizard.

---

## Feature List: Local Model Tier

### Core Compliance Features (already built — activate at this tier)
- **Compliance mode per project/task/chat** — `compliance_required=true` routes all AI calls to local model (`hierarchical-compliance-settings`)
- **Bifurcated memory** — `memory-compliant/` directory never injected into cloud sessions; cloud AI literally cannot see compliant memories
- **Compliance model enforcement** — `before_model_resolve` hook overrides model to configured local endpoint for all compliant sessions
- **Anomaly detection** — flags compliant memories accidentally placed in non-compliant directory
- **Compliance status reports** — per-session breakdown of compliant vs non-compliant calls, export-ready for audits

### Local Tier Additions (new, requires implementation)
- **Local model setup wizard** — guided Ollama/LM Studio install, model download, and connection test during onboarding
- **Model health check** — ongoing ping to local model; fallback notification if model is unavailable (no silent cloud fallback)
- **Compliance audit log export** — CSV/PDF export of compliant call metrics for institutional audits
- **"Compliance-first" default** — new projects default to `compliance_required=true` (opt-out rather than opt-in)
- **Data residency badge** — UI indicator showing all data stays on-device; exportable for IT review

### NOT included in local tier (intentionally)
- Multi-user / institution-wide deployment — that's a separate enterprise tier
- Guaranteed model response times — depends on customer hardware
- PAW managing the local model process — customer runs their own Ollama/LM Studio

---

## Pricing Model

### Tiers

**Cloud Tier — $20/mo per user**
- Cloud AI (Anthropic/OpenAI via user-provided API key or PAW demo key)
- Standard memory system (non-compliant)
- NOT suitable for FERPA/HIPAA data

**Local Model Tier — $65/mo per user**
- Everything in Cloud tier
- All compliance enforcement features
- Local model setup wizard during onboarding
- Compliance audit log export
- Compliance-first defaults
- Email support for local model setup (1 setup call included)

**Institution License — pricing TBD (future)**
- Flat-rate per-institution pricing
- On-prem PAW server deployment
- Multi-user shared local model server
- Dedicated support

### Upgrade Path

1. User signs up on Cloud tier ($20/mo)
2. In client portal: "Upgrade to Compliance Tier" button
3. Payment confirmation → tier updates in DB
4. **Onboarding wizard relaunches** for local model setup (see spec below)
5. New projects default to compliance-first

### Downgrade

- Local → Cloud downgrade is blocked if any projects/tasks/memories are marked `compliance_required=true`
- User must explicitly un-flag compliance on all data before downgrading
- This is intentional: prevents accidental data exposure

---

## Hardware Requirements

### Minimum (works, slow)

| Component | Minimum |
|---|---|
| RAM | 16 GB |
| CPU | 8-core (Apple M1 / AMD Ryzen 5 / Intel i7) |
| Storage | 10 GB free (for model files) |
| GPU | Not required |
| OS | macOS 13+, Ubuntu 22.04+, Windows 11 |

Suitable models: Llama 3.2 3B (Q8), Mistral 7B (Q4), Phi-3 mini  
Expected response: 5–20 tokens/sec

### Recommended (good UX)

| Component | Recommended |
|---|---|
| RAM | 32 GB |
| CPU | Apple M2/M3, AMD Ryzen 7/9, Intel i9 |
| GPU | NVIDIA RTX 3090 / 4070+ (8GB+ VRAM) or Apple Silicon unified memory |
| Storage | 50 GB free |

Suitable models: Llama 3.1 8B (Q5/Q6), Mistral 7B Instruct (Q8), Llama 3.1 70B (Q2/Q4 with enough RAM)  
Expected response: 30–60 tokens/sec

### Server / Multi-User (future enterprise tier)

| Component | Server Spec |
|---|---|
| RAM | 128+ GB |
| GPU | 2× NVIDIA A100 / H100 (for 70B models) |
| Storage | 500 GB+ NVMe |
| Network | Gigabit internal |

Suitable models: Llama 3.1 70B full precision, Mixtral 8×7B  
Expected: 10–40 tokens/sec per concurrent user

### Model Recommendations by Use Case

| Use Case | Recommended Model | Size |
|---|---|---|
| General assistant (FERPA-safe) | Llama 3.1 8B Instruct Q5 | ~6 GB |
| Code + analysis | Qwen 2.5 Coder 7B Q5 | ~5 GB |
| Long-form documents | Mistral 7B Instruct Q8 | ~8 GB |
| Low-resource machines | Phi-3 Mini Q8 | ~2 GB |

All of the above are available via Ollama with a single `ollama pull` command.

---

## Onboarding Integration Spec

### When It Surfaces

The local model setup wizard appears in two scenarios:
1. **New user signup** selects "Compliance/FERPA" during the onboarding wizard's institution type question
2. **Existing user upgrades** from Cloud to Local tier in the client portal

### Onboarding Wizard Flow (additions to existing wizard)

The existing onboarding wizard (blocked task: "Build onboarding wizard UI") needs a new step inserted between personality setup and brain dump:

```
Step 1: Name + Personality  (existing)
Step 2: Institution type     (new — triggers compliance path if SAIL/FERPA/HIPAA selected)
Step 3: Local Model Setup    (new — ONLY if compliance path)
Step 4: Compliance defaults  (new — ONLY if compliance path)
Step 5: Brain dump           (existing)
```

### Step 2: Institution Type Question

Simple radio selection:
```
What best describes your use case?

○ Personal assistant — I'm using PAW for my own productivity
○ Education / Research — I work in a school, university, or research institution  
● FERPA / HIPAA Compliance required — I handle student or patient data
○ Business (non-regulated) — Company use, no special compliance needs
```

If FERPA/HIPAA selected → local model path is shown. User is told:
> "PAW's Compliance Tier keeps all AI processing on your device. Nothing is sent to OpenAI or Anthropic. We'll help you set up a local AI model now — it takes about 5 minutes."

### Step 3: Local Model Setup Wizard

**Sub-step 3a: Detect existing installation**
- Plugin checks if Ollama is running (`http://localhost:11434/api/tags`)
- If yes → skip to model selection
- If no → show install button

**Sub-step 3b: Install Ollama** (if not detected)
- Show: "Install Ollama — free, open source, runs AI on your computer"
- Button: "Download Ollama" → opens `https://ollama.com/download` in browser
- Poll every 5s for Ollama to come online (max 3 min timeout)
- On detection: "✅ Ollama detected"

**Sub-step 3c: Model Selection**
Show hardware-matched recommendations:
```
Detected: Apple M2, 16 GB RAM

Recommended models:
● Llama 3.1 8B Instruct   — Best all-around   [~5 min download]  [Pull]
○ Phi-3 Mini              — Fastest, lighter   [~2 min download]  [Pull]
○ Mistral 7B Instruct     — Good for writing   [~5 min download]  [Pull]
○ Custom model name...    [text input]
```

Hardware detection: read from system info API (macOS: `sysctl hw.memsize`, Linux: `/proc/meminfo`). If < 16GB, default to Phi-3 Mini. If GPU detected via Ollama, show larger models.

**Sub-step 3d: Pull model**
- Call `ollama pull {model}` via Ollama API stream
- Show progress bar with MB downloaded / total
- On complete: "✅ Llama 3.1 8B ready"

**Sub-step 3e: Connection test**
- Send a test prompt ("Say 'ready' in one word")
- Measure response time
- Show: "✅ Local model connected — 32 tokens/sec"
- Save model identifier to `orchestrator_settings.compliance_model`

### Step 4: Compliance Defaults

Simple toggle screen:
```
Compliance defaults for new projects:

[✅] New projects default to compliance-required (recommended)
[✅] Warn before sending data to cloud AI
[✅] Compliance badge visible in chat sessions

These can be changed per-project at any time.
```

Write selections to `orchestrator_settings` table:
- `compliance_defaults_project`: boolean
- `compliance_warn_cloud`: boolean  
- `compliance_badge`: boolean

### Onboarding API Changes Needed

The existing onboarding wizard handoff (programmer task) needs to accept:
```typescript
interface OnboardingPayload {
  // existing
  name: string;
  personality: string;
  brain_dump?: string;
  
  // new: compliance
  institution_type: "personal" | "education" | "ferpa_hipaa" | "business";
  compliance_tier: boolean;
  local_model?: string;  // e.g. "ollama/llama3.1:8b"
  compliance_defaults?: {
    projects_default_compliant: boolean;
    warn_cloud: boolean;
    badge_visible: boolean;
  };
}
```

### Upgrade Flow (existing user)

When an existing cloud-tier user upgrades:
1. Payment succeeds → `users.tier` updated to `local`
2. API returns `{ redirect: "/setup/local-model" }`
3. Client portal shows the Local Model Setup wizard (Steps 3–4 only)
4. After completion, user is returned to dashboard
5. Toast: "Compliance Tier active — your data stays on this device"

---

## Risks and Tradeoffs

**Risk: Local model quality is worse than cloud AI**  
Users who upgrade for compliance may be disappointed by the capability drop.  
Mitigation: be honest in the upgrade flow — show a capability comparison. Non-sensitive tasks can still use cloud AI (compliance mode is opt-in per project, not forced system-wide unless they set that default).

**Risk: Ollama isn't running when user expects compliance**  
If local model goes offline, compliant sessions should fail hard, not silently fall back to cloud.  
Mitigation: `model-health-check` ping on startup; clear error if model is unavailable. Already partially handled by `getComplianceModel()` returning null (sessions fail rather than reroute).

**Risk: Hardware requirements surprise users**  
A user on a 4GB RAM machine can't run any useful local model.  
Mitigation: detect hardware early (Step 3a), surface requirements before Ollama install, and offer Phi-3 Mini as a minimum viable option.

**Risk: SAIL may want server-side Ollama (not per-user)**  
A university wants one Ollama server shared by all staff.  
Mitigation: the compliance_model setting accepts any URL, including a remote Ollama endpoint (e.g., `http://ollama.sail.edu:11434`). Document this. Full institution tier is future work.

---

## Implementation Plan

### Tasks for Programmer

**Task 1: Onboarding wizard — institution type step and compliance path**  
Add Step 2 (institution type) and Steps 3–4 (local model setup, compliance defaults) to the onboarding wizard.  
- UI: radio selection, Ollama detection, model pull with progress, connection test  
- API: extend onboarding payload to accept compliance fields  
- Save to: `orchestrator_settings.compliance_model`, `compliance_defaults_*`  
- Depends on: existing onboarding wizard task (blocked)

**Task 2: Model health check — startup ping + error surfacing**  
On PAW startup (or OpenClaw plugin init), if `compliance_model` is set, ping the local model endpoint.  
- If unavailable: set a `compliance_model_status` flag in DB  
- Surface as a banner in the dashboard: "⚠️ Local model offline — compliance sessions will fail"  
- No cloud fallback on failure (fail hard)

**Task 3: Compliance audit log export**  
Export compliance call metrics (already tracked in compliance status reports) as:  
- CSV: timestamp, session_id, model, compliant, data_categories  
- PDF summary report suitable for institutional audit

**Task 4: Compliance-first default setting**  
When `compliance_defaults.projects_default_compliant = true`, any new project created gets `compliance_required=true` automatically.  
Wire this to the project creation API.

**Task 5: Downgrade guard**  
Block Local→Cloud downgrade in client portal if any projects/tasks/memories are compliance-flagged.  
Show list of flagged items with "remove compliance flag" actions before allowing downgrade.

### Tasks for Writer

**Task 6: Compliance tier onboarding copy**  
Write the in-wizard text for Steps 2–4:
- Institution type descriptions (non-jargon)
- "Why local model" explanation (FERPA/HIPAA plain English)
- Hardware requirements page (linked from wizard if under-spec)
- Post-setup success message

---

## Testing Strategy

- **Unit**: `compliance-model.ts` already tested; add tests for health check logic
- **Integration**: onboarding flow with Ollama running (test container or real)  
- **E2E**: full signup → local model setup → create compliant project → verify no cloud calls made
- **Manual**: run on minimum-spec machine (16GB, no GPU) to validate UX

---

## Open Questions (not blocking, but needs resolution before launch)

1. **Remote Ollama support**: allow `compliance_model = "http://ollama.company.edu:11434/..."` for institution-shared servers? Current code supports it (any URL works), but onboarding wizard only handles localhost. Add as a "Advanced: use institution server" option.

2. **Model update flow**: when SAIL's IT updates their Ollama model, how does PAW know? Possibly a re-test button in settings.

3. **Compliance tier pricing validation**: $65/mo is a guess. Get actual feedback from SAIL before publishing.
