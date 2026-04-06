/**
 * Identity configuration for the bot instance.
 * 
 * Loads from {LOBS_ROOT}/config/identity.json. Falls back to
 * "Lobs"/"Rafe" defaults for backward compatibility.
 * 
 * See ADR-009: Multi-Instance Identity Decoupling.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLobsRoot } from "./lobs.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BotIdentity {
  name: string;
  id: string;
}

export interface OwnerIdentity {
  name: string;
  id: string;
  discordId?: string;
}

export interface IdentityConfig {
  bot: BotIdentity;
  owner: OwnerIdentity;
}

// ── Defaults (backward compatible) ───────────────────────────────────────────

const DEFAULT_IDENTITY: IdentityConfig = {
  bot: { name: "Lobs", id: "lobs" },
  owner: { name: "Rafe", id: "rafe", discordId: "644578016298795010" },
};

// ── Loading ──────────────────────────────────────────────────────────────────

let cached: IdentityConfig | null = null;

function loadIdentityConfig(): IdentityConfig {
  if (cached) return cached;

  const configPath = resolve(getLobsRoot(), "config", "identity.json");
  if (!existsSync(configPath)) {
    cached = DEFAULT_IDENTITY;
    return cached;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    cached = {
      bot: {
        name: raw?.bot?.name ?? DEFAULT_IDENTITY.bot.name,
        id: raw?.bot?.id ?? DEFAULT_IDENTITY.bot.id,
      },
      owner: {
        name: raw?.owner?.name ?? DEFAULT_IDENTITY.owner.name,
        id: raw?.owner?.id ?? DEFAULT_IDENTITY.owner.id,
        discordId: raw?.owner?.discordId ?? DEFAULT_IDENTITY.owner.discordId,
      },
    };
    return cached;
  } catch (err) {
    console.warn(`[identity] Failed to load ${configPath}:`, err);
    cached = DEFAULT_IDENTITY;
    return cached;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Bot display name (e.g. "Lobs", "Virt") */
export function getBotName(): string {
  return loadIdentityConfig().bot.name;
}

/** Bot identifier, lowercase (e.g. "lobs", "virt") */
export function getBotId(): string {
  return loadIdentityConfig().bot.id;
}

/** Owner display name (e.g. "Rafe", "Marcus") */
export function getOwnerName(): string {
  return loadIdentityConfig().owner.name;
}

/** Owner identifier, lowercase (e.g. "rafe", "marcus") */
export function getOwnerId(): string {
  return loadIdentityConfig().owner.id;
}

/** Owner's Discord user ID, if configured */
export function getOwnerDiscordId(): string | undefined {
  return loadIdentityConfig().owner.discordId;
}

/** Full identity config object */
export function getIdentity(): IdentityConfig {
  return loadIdentityConfig();
}

/** Reset cached config (for testing or config reload) */
export function resetIdentityCache(): void {
  cached = null;
}
