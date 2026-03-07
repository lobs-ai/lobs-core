# SAIL Compliance Classifier — Integration Reference

> Implementation of the BERT-small ONNX + Presidio compliance scanner,
> per research memo: `~/lobs-control/state/research/sail-compliance-classifier/FINAL-MEMO.md`

---

## Overview

The SAIL compliance scanner adds content-aware PII/sensitivity detection
to the PAW plugin. It runs on every message before cloud model routing,
catching accidental exposure of SSNs, emails, credit cards, and more —
without requiring users to manually flip compliance flags.

### 3-Tier Pipeline

```
Message arrives
    │
    ▼
[Tier 1: Presidio pre-filter] — <1ms, pure regex
    │ SSN / email / credit card / phone → immediate flag
    │ Clean → continue
    ▼
[Tier 2: BERT-small ONNX] — 10–20ms, DEFAULT-ON
    │ Token classification NER model
    │ Runs in worker_thread (non-blocking)
    │ Sensitive → flag; Clean → continue
    ▼
[Tier 3: Small LLM via Ollama] — 300ms–1s, OPT-IN
    │ Only when deepScan=true (complianceRequired=true project)
    │ Semantic scan for FERPA/HIPAA edge cases
    ▼
ScanResult { sensitive, entities, confidence, reason, tier }
```

---

## Files

| File | Role |
|------|------|
| `src/util/compliance-scanner.ts` | Main scanner service; 3-tier pipeline |
| `src/util/compliance-scanner-worker.ts` | BERT ONNX worker thread |
| `src/hooks/prompt-build.ts` | Integration point (scanner called here) |
| `tests/compliance-scanner.test.ts` | Test suite |
| `SAIL-COMPLIANCE-CLASSIFIER.md` | This file |

---

## Usage

```typescript
import { scanMessage } from "./util/compliance-scanner.js";

// Default-on (Tier 1 + Tier 2)
const result = await scanMessage("My SSN is 123-45-6789");
// → { sensitive: true, entities: ["US_SSN"], confidence: 1.0, tier: "presidio" }

// Opt-in deep scan (Tier 1 + Tier 2 + Tier 3 Ollama)
const result = await scanMessage(text, { deepScan: true });
// → { sensitive: true, entities: ["SENSITIVE_SEMANTIC"], confidence: 0.9, reason: "...", tier: "llm" }
```

### ScanResult

```typescript
interface ScanResult {
  sensitive: boolean;    // true if any tier detected sensitive content
  entities: string[];    // detected entity type labels
  confidence: number;    // 0–1 (1.0 = Presidio exact match)
  reason?: string;       // LLM tier: explanation of sensitivity
  tier: "presidio" | "bert" | "llm" | "none";  // which tier flagged it
}
```

---

## Integration in `prompt-build.ts`

The scanner runs inside the `before_prompt_build` hook, after task context is assembled but before the prompt is returned. On detection:

1. **Cloud model session** → appends a `<sail-compliance-warning>` block to the prompt, alerting the agent not to expand on sensitive content.
2. **Local model session** → logged as debug (no warning needed; local is safe).
3. **complianceRequired=true task** → `deepScan=true` is passed (enables LLM tier).
4. **Scanner errors** → non-fatal; logged as warn; agent proceeds normally.

> **No hard-blocking.** Per research memo recommendation, the initial launch
> uses warn-only mode. The routing layer can optionally reroute based on
> `scanResult.sensitive` + `isCloudModel(session.model)`.

---

## BERT Model Setup

The BERT-small ONNX model (`gravitee-io/bert-small-pii-detection`) must be
downloaded separately. It is NOT bundled in the npm package.

### Local development

```bash
# Download model files from HuggingFace Hub
mkdir -p ~/.openclaw/models/bert-small-pii
cd ~/.openclaw/models/bert-small-pii

# Option A: huggingface-cli (requires pip install huggingface_hub)
huggingface-cli download gravitee-io/bert-small-pii-detection \
  model.onnx vocab.txt --local-dir .

# Option B: direct curl
curl -L "https://huggingface.co/gravitee-io/bert-small-pii-detection/resolve/main/model.onnx" \
  -o model.onnx
curl -L "https://huggingface.co/gravitee-io/bert-small-pii-detection/resolve/main/vocab.txt" \
  -o vocab.txt
```

### Custom path

Set `SAIL_BERT_MODEL_PATH` environment variable to the absolute path of `model.onnx`.

### Docker deployment

Add to Dockerfile:

```dockerfile
RUN pip install --quiet huggingface_hub && \
    huggingface-cli download gravitee-io/bert-small-pii-detection \
      model.onnx vocab.txt --local-dir /opt/sail/models/bert-small-pii
```

The worker resolves `/opt/sail/models/bert-small-pii/model.onnx` automatically.

### npm dependency

```bash
npm install onnxruntime-node
```

If `onnxruntime-node` is not installed, Tier 2 is silently skipped and the
scanner falls back to Presidio-only (Tier 1 still runs).

---

## Behavior Matrix

| Scenario | Tier 1 | Tier 2 | Tier 3 | Action |
|----------|--------|--------|--------|--------|
| Normal chat, cloud model, SSN in text | ✅ fires | skipped | skipped | Warn in prompt |
| Normal chat, cloud model, no PII | ✅ pass | ✅ pass | skipped | Nothing |
| complianceRequired, cloud model, FERPA | ✅ pass | ✅ pass | ✅ fires | Warn in prompt |
| complianceRequired, local model, PII | ✅ fires | skipped | — | Log only |
| BERT model not installed | ✅ runs | ❌ skipped | — | Presidio-only |
| Ollama not running | ✅ runs | ✅ runs | ❌ skipped | BERT result used |

---

## Detected Entity Types

| Entity | Source | F1 |
|--------|--------|----|
| US_SSN | Presidio + BERT | 0.97 |
| CREDIT_CARD | Presidio + BERT | 0.91 |
| EMAIL_ADDRESS | Presidio + BERT | 0.92 |
| PHONE_NUMBER | Presidio + BERT | 0.88 |
| PERSON | BERT | 0.90 |
| US_BANK_NUMBER | Presidio + BERT | 0.97 |
| IP_ADDRESS | Presidio + BERT | — |
| IBAN_CODE | Presidio + BERT | — |
| MEDICAL_LICENSE | BERT | — |
| SENSITIVE_SEMANTIC | LLM (Tier 3) | varies |

---

## LLM Deep Scan (Tier 3)

When `deepScan: true` is passed, the scanner queries Ollama after BERT:

- Default model: `qwen2.5:0.5b` (350MB Q4, ~300ms on Apple Silicon)
- Catches FERPA/HIPAA edge cases that lack explicit PII tokens
- Returns `reason` field explaining the violation
- If Ollama is unavailable: skipped silently (no error surfaced)

### Configuring the LLM model

```typescript
const result = await scanMessage(text, {
  deepScan: true,
  llmModel: "llama3.2:1b",          // more accurate but slower
  ollamaBaseUrl: "http://127.0.0.1:11434",
});
```

---

## False Positives

Per research memo: **start with warn-only mode, not hard-block.**

If false positives become a problem:
1. Raise `CONFIDENCE_THRESHOLD` in `compliance-scanner-worker.ts` (default: 0.75)
2. Add a user feedback mechanism ("This was misclassified") to tune thresholds
3. Consider disabling Tier 2 for specific task types via `opts`

---

## Future Improvements

- [ ] User feedback loop ("misclassified") to log false positives for threshold tuning
- [ ] Hard-block mode (gated by `SAIL_SCANNER_BLOCK_MODE=true` env var)
- [ ] Routing integration: auto-reroute to local model when sensitive + cloud
- [ ] Async post-scan for complianceRequired projects (non-blocking secondary check)
- [ ] Annual model review (BERT won't auto-adapt to new PII formats)
- [ ] GLiNER support for zero-shot custom entity types (opt-in)
