/**
 * Voice configuration — loads voice.json from ~/.lobs/config/
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLobsRoot } from "../../config/lobs.js";
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "./types.js";

let cachedConfig: VoiceConfig | null = null;

export function getVoiceConfigPath(): string {
  return resolve(getLobsRoot(), "config", "voice.json");
}

export function loadVoiceConfig(): VoiceConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = getVoiceConfigPath();
  if (!existsSync(configPath)) {
    console.log("[voice] No voice.json found, using defaults (disabled)");
    return DEFAULT_VOICE_CONFIG;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    cachedConfig = { ...DEFAULT_VOICE_CONFIG, ...raw };
    return cachedConfig!;
  } catch (err) {
    console.error("[voice] Failed to parse voice.json:", err);
    return DEFAULT_VOICE_CONFIG;
  }
}

/** Force reload config from disk (e.g., after config change) */
export function reloadVoiceConfig(): VoiceConfig {
  cachedConfig = null;
  return loadVoiceConfig();
}
