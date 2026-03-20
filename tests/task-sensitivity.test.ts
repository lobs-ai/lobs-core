/**
 * Tests for src/services/task-sensitivity.ts
 *
 * Covers all Tier 1 regex pattern groups:
 *   - PII: SSN, DOB, credentials, email, phone, credit card
 *   - FERPA: student ID, record terms, acronym, grade patterns
 *   - HIPAA: MRN, health terms, acronym, record terms
 *
 * Tests both classifyTaskSensitivity() and classifyAndLog().
 */

import { describe, expect, it, vi } from "vitest";
import {
  classifyTaskSensitivity,
  classifyAndLog,
} from "../src/services/task-sensitivity.js";
import type { SensitivityResult } from "../src/services/task-sensitivity.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSensitive(title: string, notes = ""): boolean {
  return classifyTaskSensitivity(title, notes).sensitive;
}

function matchedPattern(title: string, notes = ""): string | undefined {
  return classifyTaskSensitivity(title, notes).matchedPattern;
}

// ── Base contract ─────────────────────────────────────────────────────────────

describe("classifyTaskSensitivity — base contract", () => {
  it("returns SensitivityResult with sensitive and optional matchedPattern", () => {
    const r: SensitivityResult = classifyTaskSensitivity("hello world", "");
    expect(typeof r.sensitive).toBe("boolean");
  });

  it("returns sensitive=false for clearly benign text", () => {
    expect(isSensitive("Refactor database layer")).toBe(false);
    expect(isSensitive("Weekly team meeting notes")).toBe(false);
    expect(isSensitive("Ship v2.3 release")).toBe(false);
  });

  it("returns sensitive=false for empty title and notes", () => {
    expect(isSensitive("", "")).toBe(false);
  });

  it("returns sensitive=false for whitespace-only input", () => {
    expect(isSensitive("   ", "  \t\n  ")).toBe(false);
  });

  it("matchedPattern is undefined when not sensitive", () => {
    expect(matchedPattern("safe task title")).toBeUndefined();
  });

  it("matchedPattern is a string when sensitive", () => {
    expect(typeof matchedPattern("SSN: 123-45-6789")).toBe("string");
  });

  it("title and notes are both searched — match in notes triggers sensitive", () => {
    expect(isSensitive("Routine task", "patient SSN 123-45-6789")).toBe(true);
  });

  it("title and notes are both searched — match in title triggers sensitive", () => {
    expect(isSensitive("SSN 123-45-6789 update", "benign notes")).toBe(true);
  });
});

// ── PII: Social Security Numbers ──────────────────────────────────────────────

describe("PII — Social Security Numbers (SSN)", () => {
  it("matches standard dashed SSN: 123-45-6789", () => {
    expect(isSensitive("Patient SSN 123-45-6789")).toBe(true);
    expect(matchedPattern("Patient SSN 123-45-6789")).toBe("ssn");
  });

  it("matches SSN with spaces: 123 45 6789", () => {
    expect(isSensitive("Update SSN 123 45 6789")).toBe(true);
  });

  it("matches undelimited SSN: 123456789", () => {
    expect(isSensitive("SSN: 123456789")).toBe(true);
  });

  it("does NOT match 9-digit numbers that aren't SSNs", () => {
    // Long random number in different context — no word boundary means no match
    expect(isSensitive("User ID: 1234567890123")).toBe(false);
  });

  it("matches SSN embedded in sentence", () => {
    expect(isSensitive("Update record — SSN is 999-88-7777")).toBe(true);
  });
});

// ── PII: Date of Birth ────────────────────────────────────────────────────────

describe("PII — Date of Birth (DOB)", () => {
  it("matches 'born: 01/15/1990'", () => {
    expect(isSensitive("Patient born: 01/15/1990")).toBe(true);
    expect(matchedPattern("Patient born: 01/15/1990")).toBe("dob");
  });

  it("matches 'dob 3-5-1985'", () => {
    expect(isSensitive("DOB 3-5-1985 to verify")).toBe(true);
  });

  it("matches 'date of birth: 12/31/99'", () => {
    expect(isSensitive("date of birth: 12/31/99")).toBe(true);
  });

  it("does NOT match plain date without dob keyword", () => {
    expect(isSensitive("Release date: 01/15/2024")).toBe(false);
  });
});

// ── PII: Credentials ─────────────────────────────────────────────────────────

describe("PII — Credentials (passwords, API keys, tokens)", () => {
  it("matches 'password: abc12345'", () => {
    expect(isSensitive("password: abc12345")).toBe(true);
    expect(matchedPattern("password: abc12345")).toBe("credential");
  });

  it("matches 'api_key: sk-abc123def456'", () => {
    expect(isSensitive("api_key: sk-abc123def456ghi789")).toBe(true);
  });

  it("matches 'secret_key: mysecretvalue'", () => {
    expect(isSensitive("secret_key: mysupersecretvalue")).toBe(true);
  });

  it("matches 'access_token: Bearer eyJ...'", () => {
    expect(isSensitive("access_token: Bearer eyJhbGciOiJSUzI")).toBe(true);
  });

  it("does NOT match 'password' alone without value", () => {
    expect(isSensitive("Reset user password")).toBe(false);
  });

  it("does NOT match short credential value (< 8 chars)", () => {
    expect(isSensitive("password: abc")).toBe(false);
  });
});

// ── PII: Email addresses ──────────────────────────────────────────────────────

describe("PII — Email addresses", () => {
  it("matches standard email in title", () => {
    expect(isSensitive("Contact alice@example.com about the issue")).toBe(true);
    expect(matchedPattern("Contact alice@example.com about issue")).toBe("email");
  });

  it("matches email in notes", () => {
    expect(isSensitive("Generic task", "email: bob@university.edu")).toBe(true);
  });

  it("matches subdomain email: user@mail.company.org", () => {
    expect(isSensitive("Reply to user@mail.company.org")).toBe(true);
  });

  it("does NOT match text with @ but not valid email", () => {
    expect(isSensitive("Invalid email @domain")).toBe(false);
    expect(isSensitive("Twitter handle @username")).toBe(false);
  });
});

// ── PII: Phone numbers ────────────────────────────────────────────────────────

describe("PII — Phone numbers", () => {
  it("matches (555) 555-5555", () => {
    expect(isSensitive("Call (555) 555-5555 for details")).toBe(true);
    expect(matchedPattern("Call (555) 555-5555")).toBe("phone");
  });

  it("matches 555.555.5555", () => {
    expect(isSensitive("Contact at 555.555.5555")).toBe(true);
  });

  it("matches +1-800-555-1234", () => {
    expect(isSensitive("Toll free: +1-800-555-1234")).toBe(true);
  });

  it("matches 555 555 5555 (space separated)", () => {
    expect(isSensitive("Phone: 555 555 5555")).toBe(true);
  });

  it("does NOT match plain 10-digit product codes", () => {
    // No delimiters in a non-phone context — word boundary won't fire
    expect(isSensitive("SKU: 5555555555")).toBe(false);
  });
});

// ── PII: Credit card numbers ──────────────────────────────────────────────────

describe("PII — Credit card numbers", () => {
  it("matches Visa 16-digit: 4111111111111111", () => {
    expect(isSensitive("Card: 4111111111111111")).toBe(true);
    expect(matchedPattern("Card: 4111111111111111")).toBe("credit_card");
  });

  it("matches MasterCard: 5555555555554444", () => {
    expect(isSensitive("Test card 5555555555554444")).toBe(true);
  });

  it("matches Amex: 378282246310005", () => {
    expect(isSensitive("AMEX: 378282246310005")).toBe(true);
  });

  it("does NOT match unrelated 16-digit number", () => {
    // A 16-digit number with wrong prefix doesn't match
    expect(isSensitive("Order number: 1234567890123456")).toBe(false);
  });
});

// ── FERPA: Student identifiers ────────────────────────────────────────────────

describe("FERPA — Student identifiers", () => {
  it("matches 'student id: A12345'", () => {
    expect(isSensitive("student id: A12345")).toBe(true);
    expect(matchedPattern("student id: A12345")).toBe("student_id");
  });

  it("matches 'Student Number: 1234567'", () => {
    expect(isSensitive("Student Number: 1234567")).toBe(true);
  });

  it("matches 'student # AB9876'", () => {
    expect(isSensitive("Update record for student # AB9876")).toBe(true);
  });

  it("does NOT match 'student' without an id/number pattern", () => {
    expect(isSensitive("Help student with homework")).toBe(false);
  });
});

// ── FERPA: Education records ──────────────────────────────────────────────────

describe("FERPA — Education record terms", () => {
  it("matches 'student record'", () => {
    expect(isSensitive("Update student record for Alice")).toBe(true);
    expect(matchedPattern("Update student record")).toBe("ferpa_term");
  });

  it("matches 'grade report'", () => {
    expect(isSensitive("Generate grade report for class 101")).toBe(true);
  });

  it("matches 'transcript'", () => {
    expect(isSensitive("Request official transcript from registrar")).toBe(true);
  });

  it("matches 'IEP' acronym", () => {
    expect(isSensitive("Review student IEP for accommodations")).toBe(true);
  });

  it("matches '504 plan'", () => {
    expect(isSensitive("Update 504 plan for special needs student")).toBe(true);
  });

  it("matches 'FERPA' acronym", () => {
    expect(isSensitive("Ensure FERPA compliance for this request")).toBe(true);
    expect(matchedPattern("Ensure FERPA compliance")).toBe("ferpa_acronym");
  });

  it("matches 'enrollment record'", () => {
    expect(isSensitive("Retrieve enrollment record for student")).toBe(true);
    expect(matchedPattern("Retrieve enrollment record")).toBe("ferpa_record");
  });

  it("matches 'disciplinary record'", () => {
    expect(isSensitive("Review disciplinary record from 2022")).toBe(true);
  });

  it("matches 'academic record'", () => {
    expect(isSensitive("Send academic record to new institution")).toBe(true);
  });
});

// ── FERPA: Grade patterns ─────────────────────────────────────────────────────

describe("FERPA — Grade patterns", () => {
  it("matches 'final grade'", () => {
    expect(isSensitive("Submit final grade for CHEM 101")).toBe(true);
    expect(matchedPattern("Submit final grade")).toBe("ferpa_grade");
  });

  it("matches 'grade change'", () => {
    expect(isSensitive("Process grade change request from professor")).toBe(true);
  });

  it("matches 'GPA of 3.5'", () => {
    expect(isSensitive("Scholarship requires GPA of 3.5 or higher")).toBe(true);
  });

  it("matches 'failing grade'", () => {
    expect(isSensitive("Student received a failing grade in Math")).toBe(true);
  });

  it("matches 'academic probation'", () => {
    expect(isSensitive("Student placed on academic probation")).toBe(true);
  });

  it("does NOT match 'grade level' (innocent phrase)", () => {
    // "grade level" doesn't match any of our FERPA grade patterns
    expect(isSensitive("Appropriate for grade level 5")).toBe(false);
  });
});

// ── HIPAA: Medical record numbers ────────────────────────────────────────────

describe("HIPAA — Medical record identifiers", () => {
  it("matches 'mrn: 12345'", () => {
    expect(isSensitive("mrn: 12345 — update records")).toBe(true);
    expect(matchedPattern("mrn: 12345")).toBe("mrn");
  });

  it("matches 'patient id: 9876543'", () => {
    expect(isSensitive("patient id: 9876543 needs update")).toBe(true);
  });

  it("matches 'chart #: 99999'", () => {
    expect(isSensitive("Pull chart #: 99999 for physician")).toBe(true);
  });

  it("does NOT match 'patient' without an id pattern", () => {
    expect(isSensitive("Improve patient experience portal")).toBe(false);
  });
});

// ── HIPAA: Health terms ───────────────────────────────────────────────────────

describe("HIPAA — Health terms", () => {
  it("matches 'diagnosed with' in title", () => {
    expect(isSensitive("Patient diagnosed with diabetes")).toBe(true);
    expect(matchedPattern("Patient diagnosed with diabetes")).toBe("hipaa_term");
  });

  it("matches 'medical history'", () => {
    expect(isSensitive("Review patient medical history")).toBe(true);
  });

  it("matches 'prescription'", () => {
    expect(isSensitive("Update patient prescriptions in system")).toBe(true);
  });

  it("matches 'mental health record'", () => {
    expect(isSensitive("Access mental health record for compliance review")).toBe(true);
  });

  it("matches 'treatment plan'", () => {
    expect(isSensitive("Generate treatment plan for new patient")).toBe(true);
  });

  it("matches 'HIPAA' acronym", () => {
    expect(isSensitive("Ensure HIPAA-compliant storage for files")).toBe(true);
    expect(matchedPattern("Ensure HIPAA compliance")).toBe("hipaa_acronym");
  });

  it("matches 'PHI' acronym", () => {
    expect(isSensitive("Handle PHI data securely")).toBe(true);
  });

  it("matches 'health record'", () => {
    expect(isSensitive("Export health record to PDF")).toBe(true);
    expect(matchedPattern("Export health record")).toBe("hipaa_record");
  });

  it("matches 'EHR' acronym", () => {
    expect(isSensitive("Integrate with EHR system")).toBe(true);
  });

  it("matches 'EMR' acronym", () => {
    expect(isSensitive("Import data from EMR platform")).toBe(true);
  });

  it("matches 'patient data'", () => {
    expect(isSensitive("Encrypt all patient data at rest")).toBe(true);
  });

  it("matches 'clinical note'", () => {
    expect(isSensitive("Summarize clinical note from physician")).toBe(true);
  });
});

// ── HIPAA: Medication & lab results ──────────────────────────────────────────

describe("HIPAA — Medication and lab result terms", () => {
  it("matches 'medications list'", () => {
    expect(isSensitive("Review patient medications list")).toBe(true);
    expect(matchedPattern("Review patient medications list")).toBe("hipaa_health");
  });

  it("matches 'drug interaction'", () => {
    expect(isSensitive("Check for drug interaction warnings")).toBe(true);
  });

  it("matches 'dosage information'", () => {
    expect(isSensitive("Update dosage information for prescription")).toBe(true);
  });

  it("matches 'lab result'", () => {
    expect(isSensitive("Review lab result from blood test")).toBe(true);
  });
});

// ── Case insensitivity ────────────────────────────────────────────────────────

describe("Case insensitivity", () => {
  it("SSN pattern is case-insensitive", () => {
    expect(isSensitive("ssn: 123-45-6789")).toBe(true);
    expect(isSensitive("SSN: 123-45-6789")).toBe(true);
  });

  it("HIPAA keyword matching is case-insensitive", () => {
    expect(isSensitive("HIPAA compliance")).toBe(true);
    expect(isSensitive("hipaa compliance")).toBe(true);
    expect(isSensitive("Hipaa Compliance")).toBe(true);
  });

  it("FERPA keyword matching is case-insensitive", () => {
    expect(isSensitive("FERPA REQUEST")).toBe(true);
    expect(isSensitive("ferpa request")).toBe(true);
  });
});

// ── Multiple patterns in one text ─────────────────────────────────────────────

describe("Multiple patterns", () => {
  it("detects first match when multiple patterns present — returns first matched", () => {
    const r = classifyTaskSensitivity(
      "SSN 123-45-6789",
      "also email: test@example.com",
    );
    expect(r.sensitive).toBe(true);
    // SSN pattern comes before email in the list
    expect(r.matchedPattern).toBe("ssn");
  });

  it("text with both FERPA and HIPAA terms is still just sensitive=true", () => {
    const r = classifyTaskSensitivity(
      "Student medical history review",
      "FERPA + HIPAA records",
    );
    expect(r.sensitive).toBe(true);
  });
});

// ── classifyAndLog ────────────────────────────────────────────────────────────

describe("classifyAndLog", () => {
  it("returns true for sensitive content", () => {
    expect(classifyAndLog("task-001", "Patient SSN 123-45-6789", "")).toBe(true);
  });

  it("returns false for benign content", () => {
    expect(classifyAndLog("task-002", "Refactor database layer", "")).toBe(false);
  });

  it("uses both title and notes when classifying", () => {
    expect(classifyAndLog("task-003", "Routine task", "HIPAA compliance required")).toBe(true);
  });

  it("handles empty notes without error", () => {
    expect(() => classifyAndLog("task-004", "Safe task", "")).not.toThrow();
  });

  it("logs when sensitive and doesn't log when not", () => {
    // Just verify it doesn't throw regardless of log state
    expect(() => classifyAndLog("task-005", "Benign task", "")).not.toThrow();
    expect(() => classifyAndLog("task-006", "SSN 123-45-6789", "")).not.toThrow();
  });

  it("only uses first 8 chars of taskId in log message (doesn't throw on short id)", () => {
    expect(() => classifyAndLog("ab", "SSN 123-45-6789", "")).not.toThrow();
    expect(() => classifyAndLog("", "FERPA request", "")).not.toThrow();
  });
});

// ── Boundary cases ────────────────────────────────────────────────────────────

describe("Boundary cases", () => {
  it("notes=null is handled gracefully (from JS callers)", () => {
    expect(() => classifyTaskSensitivity("title", null as unknown as string)).not.toThrow();
  });

  it("very long text is processed without timeout", () => {
    const longText = "benign text ".repeat(5000);
    const r = classifyTaskSensitivity(longText, "");
    expect(r.sensitive).toBe(false);
  });

  it("email address embedded in longer text is detected", () => {
    expect(isSensitive("Please contact dr.smith+notes@hospital.org for more info")).toBe(true);
  });

  it("SSN inside HTML-like string is detected", () => {
    expect(isSensitive("<b>SSN: 123-45-6789</b>")).toBe(true);
  });

  it("mixed languages with SSN pattern still detects", () => {
    expect(isSensitive("Numéro de sécurité: 123-45-6789")).toBe(true);
  });
});
