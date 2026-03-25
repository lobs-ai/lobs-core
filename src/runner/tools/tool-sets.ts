/**
 * Tool sets for different session types.
 * Filters available tools based on the context: Nexus API, Discord, DM, or system.
 */

import type { ToolName } from "../types.js";

export type SessionType = "nexus" | "discord" | "system" | "dm" | "voice";

// Nexus/API chat — no Discord tools needed
const NEXUS_TOOLS: ToolName[] = [
  "exec",
  "read",
  "write",
  "edit",
  "ls",
  "grep",
  "glob",
  "find_files",
  "code_search",
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_read",
  "memory_write",
  "spawn_agent",
  "process",
  "humanize",
  "imagine",
  "html_to_pdf",
];

// Discord channel sessions — add message + react
const DISCORD_TOOLS: ToolName[] = [
  ...NEXUS_TOOLS,
  "message",
  "react",
];

// Voice sessions — conversational, lightweight but capable
const VOICE_TOOLS: ToolName[] = [
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_read",
  "read",
  "grep",
  "glob",
  "spawn_agent",
];

// System/proactive sessions — full access (needs to message users)
const SYSTEM_TOOLS: ToolName[] = [
  ...DISCORD_TOOLS,
  "cron",
];

export function getToolsForSession(type: SessionType): ToolName[] {
  switch (type) {
    case "nexus":
      return NEXUS_TOOLS;
    case "discord":
      return DISCORD_TOOLS;
    case "dm":
      return DISCORD_TOOLS;
    case "voice":
      return VOICE_TOOLS;
    case "system":
      return SYSTEM_TOOLS;
    default:
      return NEXUS_TOOLS;
  }
}

/**
 * Infer session type from channelId.
 */
export function getSessionType(channelId: string): SessionType {
  if (channelId.startsWith("nexus:") || channelId.startsWith("api-")) {
    return "nexus";
  }
  if (channelId.startsWith("voice:")) {
    return "voice";
  }
  if (channelId === "system") {
    return "system";
  }
  // For Discord, we treat all channels the same (guild channels and DMs both get Discord tools)
  // Could differentiate DM vs guild in the future based on Discord channel type
  return "discord";
}
