/**
 * Tool registry — maps tool names to definitions and executors.
 */

import type { ToolDefinition, ToolName, ToolResult } from "../types.js";
import { execToolDefinition, execTool } from "./exec.js";
import { readToolDefinition, readTool, writeToolDefinition, writeTool, editToolDefinition, editTool } from "./files.js";
import { webSearchToolDefinition, webSearchTool, webFetchToolDefinition, webFetchTool } from "./web.js";
import { memorySearchToolDefinition, memorySearchTool, memoryReadToolDefinition, memoryReadTool } from "./memory.js";

export type ToolExecutor = (params: Record<string, unknown>, cwd: string) => Promise<string>;

interface ToolEntry {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

const TOOL_REGISTRY: Record<ToolName, ToolEntry> = {
  exec: {
    definition: execToolDefinition,
    execute: execTool,
  },
  read: {
    definition: readToolDefinition,
    execute: readTool,
  },
  write: {
    definition: writeToolDefinition,
    execute: writeTool,
  },
  edit: {
    definition: editToolDefinition,
    execute: editTool,
  },
  web_search: {
    definition: webSearchToolDefinition,
    execute: (params) => webSearchTool(params),
  },
  web_fetch: {
    definition: webFetchToolDefinition,
    execute: (params) => webFetchTool(params),
  },
  memory_search: {
    definition: memorySearchToolDefinition,
    execute: (params) => memorySearchTool(params),
  },
  memory_read: {
    definition: memoryReadToolDefinition,
    execute: (params) => memoryReadTool(params),
  },
};

/**
 * Get tool definitions for the Anthropic API.
 */
export function getToolDefinitions(tools: ToolName[]): ToolDefinition[] {
  return tools
    .filter((name) => TOOL_REGISTRY[name])
    .map((name) => TOOL_REGISTRY[name].definition);
}

/**
 * Execute a tool call and return the result.
 */
export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  toolUseId: string,
  cwd: string,
): Promise<ToolResult> {
  const entry = TOOL_REGISTRY[toolName as ToolName];

  if (!entry) {
    return {
      tool_use_id: toolUseId,
      type: "tool_result",
      content: `Unknown tool: ${toolName}`,
      is_error: true,
    };
  }

  try {
    const result = await entry.execute(params, cwd);
    return {
      tool_use_id: toolUseId,
      type: "tool_result",
      content: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tool_use_id: toolUseId,
      type: "tool_result",
      content: `Error: ${message}`,
      is_error: true,
    };
  }
}
