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

  const actionJudgment = [
    "",
    "## Action Judgment During Meetings",
    "",
    "When you hear something that could be an action, decide:",
    "",
    "EXECUTE NOW (use search_memory, read_file, web_search, spawn_agent) if:",
    '- Someone asks a direct question you can answer with a tool ("what does that PR look like?", "what\'s in that file?")',
    '- A factual dispute needs resolution ("I think we changed that last week" → search_memory)',
    '- The discussion is blocked on information you can retrieve ("do we have a design doc for that?")',
    "- Someone explicitly asks you to look something up",
    "",
    "DEFER (use defer_action) if:",
    '- It\'s a task to do after the meeting ("we should refactor the auth module")',
    '- It\'s a follow-up investigation ("we need to look into why CI is slow")',
    '- It requires sustained work, not a quick lookup ("write a design doc for the new API")',
    "- It emerged from discussion as a good idea but nobody needs the result right now",
    "- It would take the conversation off-track to execute immediately",
    "",
    "When deferring, use the defer_action tool with a clear description.",
    "Don't announce every deferral — just quietly log it.",
    'If someone explicitly asks you to write something down or remember something, use defer_action AND briefly acknowledge it ("Got it, I\'ll track that.").',
    "",
  ].join("\n");
  const parts: string[] = [voicePrompt, toolCatalog, actionJudgment, workspaceContext];

  // Add current time so the model knows when it is
  const now = new Date();
  parts.push(
    `\nCurrent time: ${now.toLocaleString("en-US", { timeZone: "America/New_York" })} (Eastern Time)`,
  );

  return parts.join("\n");
}
