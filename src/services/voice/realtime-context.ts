/**
 * Realtime Voice Context — builds the system prompt for Realtime voice sessions
 *
 * Combines the voice-optimized system prompt with core identity files
 * (SOUL.md, USER.md, MEMORY.md) so the voice model knows who it is.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildVoiceSystemPrompt } from "../workspace-loader.js";
import { getAgentDir, getAgentContextDir } from "../../config/lobs.js";

/** Read a file from the main agent dir or its context dir */
function readAgentFile(filename: string): string | null {
  const dirs = [getAgentDir("main"), getAgentContextDir("main")];
  for (const dir of dirs) {
    const fp = join(dir, filename);
    if (existsSync(fp)) {
      try {
        return readFileSync(fp, "utf-8");
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/**
 * Build the instructions string for the RealtimeAgent.
 *
 * Includes the voice personality prompt plus core identity files
 * so the model knows who it is, who Rafe is, and what it's working on.
 */
export async function buildRealtimeInstructions(): Promise<string> {
  const voicePrompt = buildVoiceSystemPrompt();

  const parts: string[] = [voicePrompt];

  // Load core identity files — these are essential for the model to know who it is
  const identityFiles = ["SOUL.md", "USER.md", "MEMORY.md"];
  for (const filename of identityFiles) {
    const content = readAgentFile(filename);
    if (content) {
      parts.push(`\n---\n## ${filename}\n${content}`);
    }
  }

  // Add current time so the model knows when it is
  const now = new Date();
  parts.push(
    `\nCurrent time: ${now.toLocaleString("en-US", { timeZone: "America/New_York" })} (Eastern Time)`,
  );

  return parts.join("\n");
}
