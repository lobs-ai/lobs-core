/**
 * Task sensitivity classifier — Tier 1 regex-based FERPA/HIPAA/PII detection.
 *
 * Mirrors the Tier 1 logic from lobs-server/app/services/sensitivity_classifier.py
 * but runs natively in the plugin so is_compliant is set in the plugin DB (lobs.db)
 * at task creation time — no cross-DB sync required.
 *
 * Called synchronously from the task POST handler before the row is inserted.
 * Fast (<1ms) so it does not add meaningful latency to task creation.
 *
 * Design decision: Option 1 from the FERPA gap audit — "plugin-side classification".
 * See: docs/decisions/ADR-ferpa-gap-sync.md (if present) or the PAW task notes.
 *
 * Patterns are intentionally conservative (high recall / lower precision):
 * false positives route to a local model; false negatives leak to cloud.
 * For tasks where a human explicitly sets compliance_required=false, that wins.
 */

import { log } from "../util/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sensitive patterns (Tier 1: regex, synchronous, <1ms)
// Mirrors SENSITIVE_PATTERNS in sensitivity_classifier.py + extends with more
// FERPA/HIPAA terms and the patterns from compliance-scanner.ts
// ─────────────────────────────────────────────────────────────────────────────

interface SensitivePattern {
  pattern: RegExp;
  name: string;
}

const SENSITIVE_PATTERNS: SensitivePattern[] = [
  // ── PII ─────────────────────────────────────────────────────────────────
  { pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/, name: "ssn" },
  { pattern: /(?:born|dob|date\s+of\s+birth)[:\s]+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/i, name: "dob" },
  { pattern: /(?:password|api[_\s]key|secret[_\s]key|access[_\s]token)[:\s]+\S{8,}/i, name: "credential" },
  // Email addresses
  { pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/, name: "email" },
  // US phone numbers
  { pattern: /(?<![0-9])(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}(?![0-9])/, name: "phone" },
  // Credit cards (major card types)
  { pattern: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12}|3(?:0[0-5]|[68]\d)\d{11})\b/, name: "credit_card" },

  // ── FERPA ────────────────────────────────────────────────────────────────
  { pattern: /(?:student\s*(?:id|number|#))[:\s]*[A-Z0-9]{5,12}/i, name: "student_id" },
  { pattern: /(?:student\s+record|grade\s+report|transcript|IEP\b|504\s+plan)/i, name: "ferpa_term" },
  { pattern: /\b(?:FERPA)\b/, name: "ferpa_acronym" },
  // Broader FERPA terms: enrollment records, disciplinary files
  { pattern: /(?:enrollment\s+record|disciplinary\s+(?:record|file|action)|academic\s+record)/i, name: "ferpa_record" },
  // Grade-related (be specific to avoid false hits on "grade level" in innocuous tasks)
  { pattern: /(?:final\s+grade|grade\s+change|GPA\s+of|failing\s+grade|academic\s+probation)/i, name: "ferpa_grade" },

  // ── HIPAA / Health ───────────────────────────────────────────────────────
  { pattern: /(?:mrn|patient\s*id|chart\s*#)[:\s]*[0-9]{5,10}/i, name: "mrn" },
  { pattern: /(?:diagnos(?:ed|is|ed\s+with)|medical\s+history|prescription(?:s)?\b|mental\s+health\s+(?:record|treatment)|treatment\s+plan)/i, name: "hipaa_term" },
  { pattern: /\b(?:HIPAA|PHI)\b/, name: "hipaa_acronym" },
  // Additional health terms
  { pattern: /(?:health\s+record|electronic\s+health|EHR\b|EMR\b|patient\s+data|clinical\s+note)/i, name: "hipaa_record" },
  { pattern: /(?:medication(?:s)?\s+list|drug\s+interaction|dosage\s+information|lab\s+result)/i, name: "hipaa_health" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface SensitivityResult {
  sensitive: boolean;
  /** Which pattern matched first, for logging. */
  matchedPattern?: string;
}

/**
 * Classify a task as sensitive based on its title and notes.
 *
 * Returns { sensitive: true } if any FERPA/HIPAA/PII pattern matches.
 * Fast synchronous check (<1ms). No external calls.
 *
 * @param title  Task title (or empty string)
 * @param notes  Task notes / description (or empty string)
 */
export function classifyTaskSensitivity(title: string, notes: string): SensitivityResult {
  const text = [title, notes].filter(Boolean).join(" ");
  if (!text.trim()) return { sensitive: false };

  for (const { pattern, name } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      return { sensitive: true, matchedPattern: name };
    }
  }
  return { sensitive: false };
}

/**
 * Classify and log the result for a named task.
 * Returns true if the task should be marked is_compliant=1.
 */
export function classifyAndLog(taskId: string, title: string, notes: string): boolean {
  const result = classifyTaskSensitivity(title, notes);
  if (result.sensitive) {
    log().info(
      `[TASK_SENSITIVITY] Task ${taskId.slice(0, 8)} classified SENSITIVE ` +
      `(pattern=${result.matchedPattern ?? "unknown"}) — setting is_compliant=1`,
    );
  }
  return result.sensitive;
}
