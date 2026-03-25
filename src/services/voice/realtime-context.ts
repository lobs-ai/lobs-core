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
    "Available tools in this live session right now:",
    ...realtimeVoiceTools.map(
      (tool) => `- ${tool.name}: ${tool.description}`,
    ),
    "If a request matches one of these tools, call the tool instead of merely describing it.",
    "Do not say you cannot see your tools. Do not say you are unsure what tools are available.",
    "Examples:",
    '- If Rafe says "write this down", call write_note.',
    '- If Rafe asks "what tools do you have", answer with the tool names directly.',
    '- If Rafe asks about his life, projects, schedule, or preferences, use search_memory if needed before claiming you do not know.',
  ].join("\n");
  const parts: string[] = [voicePrompt, toolCatalog, workspaceContext];

  // Add current time so the model knows when it is
  const now = new Date();
  parts.push(
    `\nCurrent time: ${now.toLocaleString("en-US", { timeZone: "America/New_York" })} (Eastern Time)`,
  );

  return parts.join("\n");
}
