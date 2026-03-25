/**
 * Realtime Voice Context — builds the system prompt for Realtime voice sessions
 *
 * Reuses the main-agent workspace context loader so voice gets the same
 * always-loaded identity files and context semantics as text chat.
 */

import { buildVoiceSystemPrompt, loadWorkspaceContext } from "../workspace-loader.js";
import { realtimeVoiceTools } from "./realtime-tools.js";

/**
 * Build the instructions string for the RealtimeAgent.
 *
 * Includes the voice personality prompt plus core identity files
 * so the model knows who it is, who Rafe is, and what it's working on.
 */
export async function buildRealtimeInstructions(): Promise<string> {
  const voicePrompt = buildVoiceSystemPrompt();
  const workspaceContext = loadWorkspaceContext("main");
  const toolCatalog = [
    "Live tools in this session:",
    ...realtimeVoiceTools.map(
      (tool) => `- ${tool.name}: ${tool.description}`,
    ),
    "If one clearly fits, use it.",
    "Don't say you can't see your tools.",
    'If Rafe says "write this down", use write_note.',
    "If there's a bigger issue to work on, use spawn_agent.",
  ].join("\n");
  const parts: string[] = [voicePrompt, toolCatalog, workspaceContext];

  // Add current time so the model knows when it is
  const now = new Date();
  parts.push(
    `\nCurrent time: ${now.toLocaleString("en-US", { timeZone: "America/New_York" })} (Eastern Time)`,
  );

  return parts.join("\n");
}
