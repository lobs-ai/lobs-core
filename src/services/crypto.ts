/**
 * crypto.ts — AES-256-GCM encryption for sensitive fields stored in SQLite.
 *
 * Usage:
 *   const cipher = encryptSecret("my-plaintext");  // store in DB
 *   const plain  = decryptSecret(cipher);           // read from DB
 *
 * Key source: GATEWAY_SECRET_KEY env var (32-byte hex, 64 hex chars).
 * If the key is absent the functions pass values through unchanged so the
 * server still starts; a warning is logged once.
 *
 * Format stored in DB:
 *   "enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>"
 *
 * Values that don't start with "enc:v1:" are treated as legacy plaintext and
 * returned as-is by decryptSecret (graceful migration).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const ALGO   = "aes-256-gcm";

let _key: Buffer | null | undefined = undefined; // undefined = not yet resolved

function getKey(): Buffer | null {
  if (_key !== undefined) return _key;

  const hex = process.env.GATEWAY_SECRET_KEY;
  if (!hex) {
    console.warn(
      "[crypto] GATEWAY_SECRET_KEY not set — gateway_secret stored unencrypted. " +
      "Set a 64-hex-char key to enable at-rest encryption."
    );
    _key = null;
    return null;
  }
  if (hex.length !== 64) {
    console.error(
      `[crypto] GATEWAY_SECRET_KEY must be exactly 64 hex chars (32 bytes); got ${hex.length} chars. Encryption disabled.`
    );
    _key = null;
    return null;
  }
  _key = Buffer.from(hex, "hex");
  return _key;
}

/**
 * Encrypt a plaintext secret for storage. Returns the encrypted envelope
 * string, or the original value if no key is configured.
 */
export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null;
  const key = getKey();
  if (!key) return plaintext; // no-op if key not configured

  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

/**
 * Decrypt an encrypted envelope. Returns the plaintext, or the original value
 * if it is not an encrypted envelope (legacy/migration path).
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  if (!stored.startsWith(PREFIX)) {
    // Legacy plaintext — return as-is; will be re-encrypted on next write.
    return stored;
  }

  const key = getKey();
  if (!key) {
    // Key disappeared after encryption — cannot decrypt; return null safely.
    console.error("[crypto] Encrypted value found but GATEWAY_SECRET_KEY is unset — cannot decrypt.");
    return null;
  }

  const rest  = stored.slice(PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 3) {
    console.error("[crypto] Malformed encrypted envelope:", stored.slice(0, 30));
    return null;
  }
  const [ivHex, tagHex, ctHex] = parts;
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ctHex, "hex")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch (err) {
    console.error("[crypto] Decryption failed:", (err as Error).message);
    return null;
  }
}
