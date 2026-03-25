/**
 * Realtime Voice Context — builds the system prompt for Realtime voice sessions
 *
 * Combines the voice-optimized system prompt with relevant context from
 * the context engine, tailored for low-latency conversational use.
 */

import { buildVoiceSystemPrompt } from "../workspace-loader.js";
import { assembleContext } from "../../runner/context-engine.js";

/**
 * Build the instructions string for the RealtimeAgent.
 *
 * Includes the voice personality prompt plus a trimmed context window
 * (smaller budget than text sessions since latency matters).
 */
export async function buildRealtimeInstructions(): Promise<string> {
  const voicePrompt = buildVoiceSystemPrompt();

  const parts: string[] = [voicePrompt];

  // Attempt to enrich with context from the context engine
  try {
    const assembled = await assembleContext({
      task: "Voice conversation — general assistant",
      agentType: "main",
      config: { maxContextTokens: 4000 }, // Smaller budget for voice
    });

    if (assembled.contextBlock) {
      parts.push("\n---\n## Context\n" + assembled.contextBlock);
    }
  } catch (err) {
    // Context engine unavailable — proceed without context
    console.warn(
      "[voice:realtime] Context engine unavailable, continuing without context:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Add current time so the model knows when it is
  const now = new Date();
  parts.push(
    `\nCurrent time: ${now.toLocaleString("en-US", { timeZone: "America/New_York" })} (Eastern Time)`,
  );

  return parts.join("\n");
}
