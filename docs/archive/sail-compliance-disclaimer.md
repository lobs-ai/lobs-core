# SAIL Compliance Disclaimer — Copy & Onboarding Flow Spec

**Status**: Draft  
**Date**: 2026-03-06  
**Author**: Writer agent  
**For**: SAIL onboarding wizard (Step: Data & Privacy)

---

## Disclaimer Copy

### Heading

**Before we get started — a quick note about your data**

### Body

PAW uses AI to help you work faster. By default, it routes your requests through cloud AI providers (like Anthropic's Claude or OpenAI's GPT). That's fast and capable, but it means your words travel to a third-party server.

That's fine for most work. It's **not** fine for certain types of sensitive data.

**Do not put the following into cloud AI:**

- **Student records or grades** — protected by FERPA (Family Educational Rights and Privacy Act). Sending student PII, academic records, or enrollment data to a cloud provider is a compliance violation.
- **Health or medical information** — protected by HIPAA (Health Insurance Portability and Accountability Act). This includes patient records, diagnoses, treatment notes, and anything that identifies an individual's health status.
- **Confidential business data under SOC 2** — if your organization is SOC 2 audited, data governed by your Trust Services Criteria (customer data, internal financials, access logs) should not leave your controlled environment.

**In plain terms:** if you wouldn't email it to a stranger, don't put it in cloud AI.

---

### The local model alternative

PAW supports a **local model tier** — AI that runs entirely on your machine. No data leaves your network. No third-party servers. No compliance risk.

If you work with FERPA-protected student data, HIPAA-covered health information, or other sensitive content, you should run a local model for those tasks.

You can configure your default model now, or switch on a per-task basis later. Projects and tasks can be flagged as **compliance-required**, which automatically routes them to your local model.

> **Don't have a local model set up yet?** You can skip this for now and configure it later in Settings → Model → Local Model. We'll remind you before routing any flagged task to a cloud model.

---

### Acknowledgment

*[ ] I understand that cloud AI should not be used with FERPA, HIPAA, or SOC 2-protected data, and that PAW provides a local model option for compliant use.*

---

## Onboarding Flow Spec

### Where it lives

**Step 3 of the onboarding wizard** — after name/personality setup, before the brain dump.

Label: `Data & Privacy`

This step is non-skippable for SAIL deployments. The acknowledgment checkbox must be checked to proceed.

---

### Flow

```
Step 1: Welcome + Name
Step 2: Personality / Working Style
Step 3: Data & Privacy  ← this disclaimer
Step 4: Brain Dump (optional)
Step 5: Model Setup (cloud key or local model)
Step 6: Done
```

---

### Step 3 UI Spec

**Page title:** Before we get started — a quick note about your data

**Layout:** Single-column, max-width 680px. No sidebar. No distractions.

**Sections:**

1. **The rule** — brief statement that cloud AI ≠ compliant for sensitive data
2. **What's protected** — three callout boxes (FERPA / HIPAA / SOC 2), each with:
   - Regulation name + acronym expansion
   - One-sentence plain-language description of what it protects
   - Example of what NOT to put in cloud AI
3. **The local model option** — short paragraph + CTA to configure local model now or defer
4. **Acknowledgment checkbox** — required to proceed
5. **Continue button** — disabled until checkbox is checked

---

### Callout Box Copy

#### FERPA
**FERPA** — Family Educational Rights and Privacy Act  
Protects student education records.  
*Don't put in cloud AI: student names + grades, enrollment records, academic performance data, disciplinary files.*

#### HIPAA
**HIPAA** — Health Insurance Portability and Accountability Act  
Protects individually identifiable health information.  
*Don't put in cloud AI: patient names, diagnoses, treatment notes, insurance information, any data that links a person to their health status.*

#### SOC 2
**SOC 2** — Service Organization Control 2  
Governs how organizations handle customer data under Trust Services Criteria.  
*Don't put in cloud AI: customer PII, internal audit logs, access credentials, confidential business records covered by your SOC 2 scope.*

---

### Post-Onboarding Behavior

Once the user acknowledges:

- Their account is flagged as `compliance_acknowledged: true` with a timestamp
- Compliance mode becomes available at the project and task level
- Any task flagged `compliance_required: true` will route to the local model (or block with a warning if no local model is configured)
- The compliance status badge appears in Nexus task views

If the user skips local model setup in Step 5, they will see a non-blocking reminder banner the first time they try to flag a task as compliance-required:

> **Local model not configured.** Compliance-required tasks won't be sent to cloud AI, but you'll need a local model to run them. [Configure now] [Remind me later]

---

## Notes / Judgment Calls

- Kept the disclaimer user-facing and plain-language, not legal text. It's a heads-up, not a liability waiver.
- SOC 2 is included because it was in the brief, but it's the loosest of the three — "SOC 2-protected data" isn't a fixed legal category like FERPA/HIPAA. The copy reflects that by describing it in terms of what's typically in scope.
- The "don't email it to a stranger" heuristic is informal but effective for non-technical users. Keep it unless legal pushes back.
- Step 3 is non-skippable. Making it optional defeats the purpose and creates liability exposure.
- Deferred local model setup is allowed because many users won't have Ollama running yet. Blocking on it in onboarding would create friction for everyone.
