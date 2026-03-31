import type { ToolDefinition } from "../runner/types.js";

export const CLAUDE_CODE_TOOL_ALIASES: Record<string, string> = {
  exec: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  glob: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  spawn_agent: "Task",
};

const INTERNAL_TOOL_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(CLAUDE_CODE_TOOL_ALIASES).map(([internal, external]) => [external, internal]),
);

export function toClaudeCodeToolName(name: string): string {
  return CLAUDE_CODE_TOOL_ALIASES[name] ?? name;
}

export function fromClaudeCodeToolName(name: string): string {
  return INTERNAL_TOOL_ALIASES[name] ?? name;
}

export function asClaudeCodeToolDefinition(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    name: toClaudeCodeToolName(definition.name),
  };
}

