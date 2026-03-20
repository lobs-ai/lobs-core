/**
 * Tests for src/services/crypto.ts
 *
 * Covers:
 *   - encryptSecret / decryptSecret round-trip
 *   - null/undefined passthrough
 *   - Legacy plaintext passthrough (no prefix)
 *   - No-op when GATEWAY_SECRET_KEY is not set
 *   - Invalid key length (not 64 hex chars)
 *   - Malformed envelope handling
 *   - Tampered ciphertext / IV / tag (authentication failure)
 *   - Unique IV per encryption (non-deterministic output)
 *   - Empty string encryption
 *   - Very long plaintext
 *   - Special characters / Unicode
 *   - Envelope format validation (enc:v1:<iv>:<tag>:<ct>)
 *
 * NOTE: The module caches the key in a module-level variable (_key).
 * Each describe block clears/sets GATEWAY_SECRET_KEY before importing.
 * We use vi.resetModules() to get fresh module state for each key scenario.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── A valid 32-byte (64 hex char) test key ───────────────────────────────────

const VALID_KEY = "a".repeat(64); // 64 hex chars = 32 bytes (all 0xaa)
const VALID_KEY_2 = "b".repeat(64); // different valid key

// ── Helper to reset module state between key tests ──────────────────────────

async function loadCrypto() {
  // Force module re-evaluation by clearing the cache
  vi.resetModules();
  const mod = await import("../src/services/crypto.js");
  return mod;
}

// ── Round-trip tests (key configured) ───────────────────────────────────────

describe("encrypt/decrypt round-trip with valid key", () => {
  beforeEach(() => {
    process.env.GATEWAY_SECRET_KEY = VALID_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.GATEWAY_SECRET_KEY;
    vi.resetModules();
  });

  it("encrypts and decrypts a simple string", async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const plaintext = "my-secret-api-key";
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it("round-trips the empty string", async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const encrypted = encryptSecret("");
    expect(decryptSecret(encrypted)).toBe("");
  });

  it("round-trips a very long string (16KB)", async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const longStr = "x".repeat(16_384);
    const encrypted = encryptSecret(longStr);
    expect(decryptSecret(encrypted)).toBe(longStr);
  });

  it("round-trips a string with Unicode and special characters", async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const unicode = "Hello 世界 🔐 \n\t\r";
    const encrypted = encryptSecret(unicode);
    expect(decryptSecret(encrypted)).toBe(unicode);
  });

  it("round-trips a JSON-encoded value", async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const json = JSON.stringify({ token: "sk-abc123", expires: 1234567890 });
    const encrypted = encryptSecret(json);
    expect(decryptSecret(encrypted)).toBe(json);
  });

  it("round-trips a string with colons (does not confuse envelope parsing)", async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const withColons = "user:password:host:port:db";
    const encrypted = encryptSecret(withColons);
    expect(decryptSecret(encrypted)).toBe(withColons);
  });

  it("two encryptions of the same plaintext produce different ciphertexts (random IV)", async () => {
    const { encryptSecret } = await loadCrypto();
    const enc1 = encryptSecret("same-secret");
    const enc2 = encryptSecret("same-secret");
    expect(enc1).not.toBe(enc2); // Different IVs → different output
  });

  it("encrypted envelope starts with 'enc:v1:' prefix", async () => {
    const { encryptSecret } = await loadCrypto();
    const encrypted = encryptSecret("secret");
    expect(encrypted).toMatch(/^enc:v1:/);
  });

  it("encrypted envelope has exactly 4 colon-delimited segments (after prefix)", async () => {
    const { encryptSecret } = await loadCrypto();
    const encrypted = encryptSecret("test") as string;
    const withoutPrefix = encrypted.slice("enc:v1:".length);
    const parts = withoutPrefix.split(":");
    expect(parts).toHaveLength(3); // iv:tag:ciphertext
  });

  it("IV is 24 hex chars (12 bytes × 2 hex per byte)", async () => {
    const { encryptSecret } = await loadCrypto();
    const encrypted = encryptSecret("test") as string;
    const parts = encrypted.slice("enc:v1:".length).split(":");
    expect(parts[0]).toMatch(/^[0-9a-f]{24}$/); // 12-byte IV = 24 hex chars
  });

  it("auth tag is 32 hex chars (16 bytes × 2 hex per byte)", async () => {
    const { encryptSecret } = await loadCrypto();
    const encrypted = encryptSecret("test") as string;
    const parts = encrypted.slice("enc:v1:".length).split(":");
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/); // 16-byte GCM tag = 32 hex chars
  });
});

// ── null / undefined passthrough ─────────────────────────────────────────────

describe("null/undefined passthrough", () => {
  beforeEach(() => {
    process.env.GATEWAY_SECRET_KEY = VALID_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.GATEWAY_SECRET_KEY;
    vi.resetModules();
  });

  it("encryptSecret(null) returns null", async () => {
    const { encryptSecret } = await loadCrypto();
    expect(encryptSecret(null)).toBeNull();
  });

  it("encryptSecret(undefined) returns null", async () => {
    const { encryptSecret } = await loadCrypto();
    expect(encryptSecret(undefined)).toBeNull();
  });

  it("decryptSecret(null) returns null", async () => {
    const { decryptSecret } = await loadCrypto();
    expect(decryptSecret(null)).toBeNull();
  });

  it("decryptSecret(undefined) returns null", async () => {
    const { decryptSecret } = await loadCrypto();
    expect(decryptSecret(undefined)).toBeNull();
  });
});

// ── Legacy plaintext passthrough (no "enc:v1:" prefix) ───────────────────────

describe("legacy plaintext passthrough", () => {
  beforeEach(() => {
    process.env.GATEWAY_SECRET_KEY = VALID_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.GATEWAY_SECRET_KEY;
    vi.resetModules();
  });

  it("decryptSecret returns plaintext as-is for legacy values", async () => {
    const { decryptSecret } = await loadCrypto();
    const legacy = "sk-abc123-not-encrypted";
    expect(decryptSecret(legacy)).toBe(legacy);
  });

  it("decryptSecret returns empty string for empty legacy value", async () => {
    const { decryptSecret } = await loadCrypto();
    expect(decryptSecret("")).toBe("");
  });

  it("decryptSecret returns partial prefix as-is (only 'enc:' not 'enc:v1:')", async () => {
    const { decryptSecret } = await loadCrypto();
    const partialPrefix = "enc:not-a-real-envelope";
    expect(decryptSecret(partialPrefix)).toBe(partialPrefix);
  });
});

// ── No-op when GATEWAY_SECRET_KEY is absent ───────────────────────────────────

describe("no-op without GATEWAY_SECRET_KEY", () => {
  beforeEach(() => {
    delete process.env.GATEWAY_SECRET_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("encryptSecret returns plaintext unchanged when no key", async () => {
    const { encryptSecret } = await loadCrypto();
    const plaintext = "my-secret";
    expect(encryptSecret(plaintext)).toBe(plaintext);
  });

  it("encryptSecret(null) still returns null with no key", async () => {
    const { encryptSecret } = await loadCrypto();
    expect(encryptSecret(null)).toBeNull();
  });

  it("decryptSecret returns non-prefixed value unchanged when no key", async () => {
    const { decryptSecret } = await loadCrypto();
    expect(decryptSecret("plaintext-value")).toBe("plaintext-value");
  });

  it("decryptSecret returns null for enc:v1: prefix when no key (cannot decrypt)", async () => {
    const { decryptSecret } = await loadCrypto();
    const fakeEnvelope = "enc:v1:aabbcc:ddeeff:112233";
    // Key is missing — must return null (cannot decrypt)
    expect(decryptSecret(fakeEnvelope)).toBeNull();
  });
});

// ── Invalid key length ───────────────────────────────────────────────────────

describe("invalid GATEWAY_SECRET_KEY", () => {
  afterEach(() => {
    delete process.env.GATEWAY_SECRET_KEY;
    vi.resetModules();
  });

  it("treats key with wrong length (< 64 chars) as missing", async () => {
    process.env.GATEWAY_SECRET_KEY = "abc123"; // Too short
    vi.resetModules();
    const { encryptSecret } = await loadCrypto();
    // Should pass through unchanged (encryption disabled)
    expect(encryptSecret("secret")).toBe("secret");
  });

  it("treats key with wrong length (> 64 chars) as missing", async () => {
    process.env.GATEWAY_SECRET_KEY = "a".repeat(66); // 66 chars
    vi.resetModules();
    const { encryptSecret } = await loadCrypto();
    expect(encryptSecret("secret")).toBe("secret");
  });

  it("treats non-hex key as producing invalid crypto (throws or returns null)", async () => {
    // 64 chars but not valid hex (g-z aren't valid hex digits)
    // Buffer.from("gggg...", "hex") yields an empty buffer → invalid key length
    // The module accepts the key length (64 chars) but createCipheriv will throw
    // We test that this error does not produce a silent incorrect result
    process.env.GATEWAY_SECRET_KEY = "g".repeat(64);
    vi.resetModules();
    const { encryptSecret } = await loadCrypto();
    // Either throws (RangeError: Invalid key length) or returns plaintext
    // We just check the function handles the bad key deterministically
    let result: string | null | undefined;
    try {
      result = encryptSecret("secret");
    } catch (e) {
      // If it throws with RangeError that's acceptable behavior
      expect((e as Error).message).toContain("key");
      return;
    }
    // If it doesn't throw, it falls back to plaintext (treated as disabled)
    expect(result).toBe("secret");
  });
});

// ── Malformed envelope handling ───────────────────────────────────────────────

describe("malformed encrypted envelope", () => {
  beforeEach(() => {
    process.env.GATEWAY_SECRET_KEY = VALID_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.GATEWAY_SECRET_KEY;
    vi.resetModules();
  });

  it("returns null for envelope with too few parts (< 3 colons after prefix)", async () => {
    const { decryptSecret } = await loadCrypto();
    const badEnvelope = "enc:v1:aabbcc:ddeeff"; // only 2 parts
    expect(decryptSecret(badEnvelope)).toBeNull();
  });

  it("returns null for envelope with garbage hex in IV", async () => {
    const { decryptSecret } = await loadCrypto();
    const badIv = "enc:v1:ZZZZZZZZZZZZZZZZZZZZZZZZ:aa".repeat(1) +
      "bbccddee00112233:aabbccdd";
    expect(decryptSecret(badIv)).toBeNull();
  });

  it("returns null for tampered ciphertext (authentication tag mismatch)", async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const encrypted = encryptSecret("original") as string;

    // Tamper with the last byte of the ciphertext hex
    const lastChar = encrypted[encrypted.length - 1];
    const tampered = encrypted.slice(0, -1) + (lastChar === "0" ? "1" : "0");

    expect(decryptSecret(tampered)).toBeNull();
  });

  it("returns null for tampered auth tag (authentication failure)", async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const encrypted = encryptSecret("test-value") as string;

    // Find the tag portion and flip a bit
    const parts = encrypted.slice("enc:v1:".length).split(":");
    parts[1] = parts[1].slice(0, -1) + (parts[1][parts[1].length - 1] === "0" ? "1" : "0");
    const tampered = "enc:v1:" + parts.join(":");

    expect(decryptSecret(tampered)).toBeNull();
  });

  it("returns null when wrong key is used for decryption", async () => {
    // Encrypt with VALID_KEY, then decrypt with VALID_KEY_2
    process.env.GATEWAY_SECRET_KEY = VALID_KEY;
    vi.resetModules();
    const { encryptSecret } = await loadCrypto();
    const encrypted = encryptSecret("secret-value") as string;

    // Switch to different key
    process.env.GATEWAY_SECRET_KEY = VALID_KEY_2;
    vi.resetModules();
    const { decryptSecret } = await loadCrypto();
    expect(decryptSecret(encrypted)).toBeNull();
  });
});

// ── Key caching ───────────────────────────────────────────────────────────────

describe("key caching behavior", () => {
  afterEach(() => {
    delete process.env.GATEWAY_SECRET_KEY;
    vi.resetModules();
  });

  it("multiple calls within same module instance use cached key", async () => {
    process.env.GATEWAY_SECRET_KEY = VALID_KEY;
    vi.resetModules();
    const { encryptSecret, decryptSecret } = await loadCrypto();

    const enc1 = encryptSecret("value1");
    const enc2 = encryptSecret("value2");
    // Both should encrypt (key was cached from first call)
    expect(enc1).toMatch(/^enc:v1:/);
    expect(enc2).toMatch(/^enc:v1:/);
    expect(decryptSecret(enc1)).toBe("value1");
    expect(decryptSecret(enc2)).toBe("value2");
  });

  it("returns consistent encrypted/decrypted values across multiple calls", async () => {
    process.env.GATEWAY_SECRET_KEY = VALID_KEY;
    vi.resetModules();
    const { encryptSecret, decryptSecret } = await loadCrypto();

    // Encrypt the same value 5 times — each output is different (random IV)
    const values = Array.from({ length: 5 }, () => encryptSecret("constant")) as string[];
    const allUnique = new Set(values).size === 5;
    expect(allUnique).toBe(true);

    // But all decrypt to the same plaintext
    values.forEach(v => {
      expect(decryptSecret(v)).toBe("constant");
    });
  });
});
