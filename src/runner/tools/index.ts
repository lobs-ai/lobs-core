/**
 * Tool registry — maps tool names to definitions and executors.
 */

import type { ToolDefinition, ToolName, ToolResult, ToolExecutionResult, ToolExecutorResult, ToolSideEffects } from "../types.js";
import { execToolDefinition, execTool } from "./exec.js";
import { readToolDefinition, readTool } from "./read.js";
import { writeToolDefinition, writeTool } from "./write.js";
import { editToolDefinition, editTool } from "./edit.js";
import { lsToolDefinition, lsTool } from "./ls.js";
import { grepToolDefinition, grepTool } from "./grep.js";
import { globToolDefinition, globTool } from "./glob.js";
import { findFilesToolDefinition, findFilesTool } from "./find-files.js";
import { codeSearchToolDefinition, codeSearchTool } from "./code-search.js";
import { webSearchToolDefinition, webSearchTool, webFetchToolDefinition, webFetchTool } from "./web.js";
import { memorySearchToolDefinition, memorySearchTool, memoryReadToolDefinition, memoryReadTool, memoryWriteToolDefinition, memoryWriteTool } from "./memory.js";
import { AGENT_CONTROL_TOOLS, executeSpawnAgent, executeRunPipeline, executeListAgents } from "./agent-control.js";
import { cronToolDefinition, executeCronTool } from "./cron.js";
import { messageToolDefinition, executeMessageTool } from "./message.js";
import { reactToolDefinition, executeReactTool, setDiscordService as setReactDiscord } from "./react.js";
import { processToolDefinition, processTool } from "./process.js";
import { humanizeToolDefinition, humanizeTool } from "./humanize.js";
import { imagineToolDefinition, imagineTool } from "./imagine.js";
import { htmlToPdfToolDefinition, htmlToPdfTool } from "./html-to-pdf.js";

export { setReactDiscord };

export type { ToolSideEffects, ToolExecutorResult };

/** Optional context passed to tools from the conversation loop */
export interface ToolContext {
  channelId?: string;
  toolUseId?: string;
}

export type ToolExecutor = (params: Record<string, unknown>, cwd: string, context?: ToolContext) => Promise<ToolExecutorResult>;

interface ToolEntry {
  definition: ToolDefinition | (() => ToolDefinition);
  execute: ToolExecutor;
}

function getDefinition(entry: ToolEntry): ToolDefinition {
  return typeof entry.definition === "function"
    ? entry.definition()
    : entry.definition;
}

function getAgentControlDefinition(name: ToolDefinition["name"]): ToolDefinition {
  const definition = AGENT_CONTROL_TOOLS.find((tool) => tool.name === name);
  if (!definition) {
    throw new Error(`Missing agent control tool definition: ${name}`);
  }
  return definition;
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
  ls: {
    definition: lsToolDefinition,
    execute: lsTool,
  },
  grep: {
    definition: grepToolDefinition,
    execute: grepTool,
  },
  glob: {
    definition: globToolDefinition,
    execute: globTool,
  },
  find_files: {
    definition: findFilesToolDefinition,
    execute: findFilesTool,
  },
  code_search: {
    definition: codeSearchToolDefinition,
    execute: codeSearchTool,
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
  memory_write: {
    definition: memoryWriteToolDefinition,
    execute: (params) => memoryWriteTool(params),
  },
  spawn_agent: {
    definition: () => getAgentControlDefinition("spawn_agent"),
    execute: (params, cwd, context) => executeSpawnAgent(params, cwd, context?.channelId),
  },
  run_pipeline: {
    definition: () => getAgentControlDefinition("run_pipeline"),
    execute: (params, cwd) => executeRunPipeline(params, cwd),
  },
  list_agents: {
    definition: () => getAgentControlDefinition("list_agents"),
    execute: (params) => executeListAgents(),
  },
  cron: {
    definition: cronToolDefinition,
    execute: (params) => executeCronTool(params),
  },
  message: {
    definition: messageToolDefinition,
    execute: (params) => executeMessageTool(params),
  },
  react: {
    definition: reactToolDefinition,
    execute: (params) => executeReactTool(params),
  },
  process: {
    definition: processToolDefinition,
    execute: (params, cwd) => processTool(params, cwd),
  },
  humanize: {
    definition: humanizeToolDefinition,
    execute: (params, cwd) => humanizeTool(params, cwd),
  },
  imagine: {
    definition: imagineToolDefinition,
    execute: (params, _cwd, context) => imagineTool(params, { toolUseId: context?.toolUseId }),
  },
  html_to_pdf: {
    definition: htmlToPdfToolDefinition,
    execute: (params, cwd) => htmlToPdfTool(params, cwd),
  },
};

/**
 * Get tool definitions for the Anthropic API.
 */
export function getToolDefinitions(tools: ToolName[]): ToolDefinition[] {
  return tools
    .filter((name) => TOOL_REGISTRY[name])
    .map((name) => getDefinition(TOOL_REGISTRY[name]));
}

/**
 * Execute a tool call and return the result with any side effects.
 */
export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  toolUseId: string,
  cwd: string,
  context?: ToolContext,
): Promise<ToolExecutionResult> {
  const entry = TOOL_REGISTRY[toolName as ToolName];

  if (!entry) {
    return {
      result: {
        tool_use_id: toolUseId,
        type: "tool_result",
        content: `Unknown tool: ${toolName}`,
        is_error: true,
      },
    };
  }

  try {
    const enrichedContext: ToolContext = { ...context, toolUseId };
    const raw = await entry.execute(params, cwd, enrichedContext);
    
    // Extract side effects if the tool returned them
    const output = typeof raw === "string" ? raw : raw.output;
    const sideEffects = typeof raw === "string" ? undefined : raw.sideEffects;
    
    return {
      result: {
        tool_use_id: toolUseId,
        type: "tool_result",
        content: output,
      },
      sideEffects,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: {
        tool_use_id: toolUseId,
        type: "tool_result",
        content: `Error: ${message}`,
        is_error: true,
      },
    };
  }
}
