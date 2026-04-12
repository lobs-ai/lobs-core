/**
 * Tool sets for different session types.
 * Filters available tools based on the context: Nexus API, Discord, DM, or system.
 */

import type { ToolName } from "../types.js";

export type SessionType = "nexus" | "discord" | "system" | "dm" | "voice";

// Nexus/API chat — no Discord tools (discord is enabled on-demand via tool_manage)
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
  "dispatch_agent",
  "check_agents",
  "message_agent",
  "stop_agent",
  "process",
  "humanize",
  "imagine",
  "html_to_pdf",
  "tool_manage",
  "discord",
  "task_create",
  "task_update",
  "task_delete",
  "task_list",
  "task_view",
  "goal_create",
  "goal_update",
  "goal_list",
  "goal_view",
];

// Discord DM sessions — same as nexus (no discord tool needed, replies are inline)
const DM_TOOLS: ToolName[] = [
  ...NEXUS_TOOLS,
];

// Discord server/guild sessions — same as nexus (discord is already in NEXUS_TOOLS)
const DISCORD_GUILD_TOOLS: ToolName[] = [
  ...NEXUS_TOOLS,
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
  "dispatch_agent",
];

// System/proactive sessions — full access (needs to message users)
const SYSTEM_TOOLS: ToolName[] = [
  ...DISCORD_GUILD_TOOLS,
  "cron",
];

export function getToolsForSession(type: SessionType): ToolName[] {
  switch (type) {
    case "nexus":
      return NEXUS_TOOLS;
    case "discord":
      return DISCORD_GUILD_TOOLS;
    case "dm":
      return DM_TOOLS;
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
