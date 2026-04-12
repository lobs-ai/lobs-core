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
import { AGENT_CONTROL_TOOLS, executeSpawnAgent, executeRunPipeline, executeListAgents, executeCheckAgents, executeMessageAgent, executeStopAgent } from "./agent-control.js";
import { cronToolDefinition, executeCronTool } from "./cron.js";
import { discordToolDefinition, executeDiscordTool, setDiscordService as setDiscordToolDiscord } from "./discord.js";
import { processToolDefinition, processTool } from "./process.js";
import { humanizeToolDefinition, humanizeTool } from "./humanize.js";
import { imagineToolDefinition, imagineTool } from "./imagine.js";
import { htmlToPdfToolDefinition, htmlToPdfTool } from "./html-to-pdf.js";
import { dispatchAgentToolDefinition, dispatchAgentTool } from "./dispatch.js";
import { librarianAskToolDefinition, librarianAskTool, librarianReindexToolDefinition, reindexKnowledgeBaseTool } from "./librarian.js";
import { toolManageDefinition, toolManageTool } from "./tool-manage.js";
import { TASK_TOOL_DEFINITIONS, TASK_TOOL_EXECUTORS } from "./tasks.js";
import { getDynamicToolLoader } from "./dynamic-tools.js";
import { getToolManager } from "./tool-manager.js";
import {
  asClaudeCodeToolDefinition,
  fromClaudeCodeToolName,
} from "../../claude-runtime/tool-contracts.js";

export { setDiscordToolDiscord };

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

function formatToolOutput(
  toolName: string,
  output: string,
  sideEffects?: ToolSideEffects,
): string {
  const normalized = fromClaudeCodeToolName(toolName);

  if (normalized === "exec") {
    const lines = [output.trim()];
    if (sideEffects?.newCwd) {
      lines.push(`working_directory_now: ${sideEffects.newCwd}`);
    }
    return lines.filter((line) => line.length > 0).join("\n\n");
  }

  if (normalized === "edit") {
    return output.startsWith("Edit ")
      ? output
      : `Edit result:\n${output}`;
  }

  if (normalized === "read") {
    return `Read result:\n${output}`;
  }

  if (normalized === "write") {
    return output.startsWith("Write ")
      ? output
      : `Write result:\n${output}`;
  }

  if (normalized === "spawn_agent" || normalized === "check_agents" || normalized === "message_agent" || normalized === "stop_agent") {
    return `Subagent tool result:\n${output}`;
  }

  return output;
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
  check_agents: {
    definition: () => getAgentControlDefinition("check_agents"),
    execute: (params) => executeCheckAgents(params),
  },
  message_agent: {
    definition: () => getAgentControlDefinition("message_agent"),
    execute: (params) => executeMessageAgent(params),
  },
  stop_agent: {
    definition: () => getAgentControlDefinition("stop_agent"),
    execute: (params) => executeStopAgent(params),
  },
  cron: {
    definition: cronToolDefinition,
    execute: (params) => executeCronTool(params),
  },
  discord: {
    definition: discordToolDefinition,
    execute: (params) => executeDiscordTool(params),
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
  dispatch_agent: {
    definition: dispatchAgentToolDefinition,
    execute: (params, cwd) => dispatchAgentTool(params, cwd),
  },
  tool_manage: {
    definition: toolManageDefinition,
    execute: toolManageTool,
  },
  librarian_ask: {
    definition: librarianAskToolDefinition,
    execute: (params, cwd) => librarianAskTool(params, cwd),
  },
  librarian_reindex_knowledge_base: {
    definition: librarianReindexToolDefinition,
    execute: (params, cwd) => reindexKnowledgeBaseTool(params, cwd),
  },
  // Task and goal management tools
  task_create: { definition: TASK_TOOL_DEFINITIONS[0], execute: TASK_TOOL_EXECUTORS.task_create },
  task_update: { definition: TASK_TOOL_DEFINITIONS[1], execute: TASK_TOOL_EXECUTORS.task_update },
  task_delete: { definition: TASK_TOOL_DEFINITIONS[2], execute: TASK_TOOL_EXECUTORS.task_delete },
  task_list:   { definition: TASK_TOOL_DEFINITIONS[3], execute: TASK_TOOL_EXECUTORS.task_list },
  task_view:   { definition: TASK_TOOL_DEFINITIONS[4], execute: TASK_TOOL_EXECUTORS.task_view },
  goal_create: { definition: TASK_TOOL_DEFINITIONS[5], execute: TASK_TOOL_EXECUTORS.goal_create },
  goal_update: { definition: TASK_TOOL_DEFINITIONS[6], execute: TASK_TOOL_EXECUTORS.goal_update },
  goal_list:   { definition: TASK_TOOL_DEFINITIONS[7], execute: TASK_TOOL_EXECUTORS.goal_list },
  goal_view:   { definition: TASK_TOOL_DEFINITIONS[8], execute: TASK_TOOL_EXECUTORS.goal_view },
};

/**
 * Get tool definitions for the Anthropic API.
 */
export function getToolDefinitions(tools: ToolName[]): ToolDefinition[] {
  const manager = getToolManager();
  const staticDefs = tools
    .filter((name) => TOOL_REGISTRY[name] && manager.isEnabled(name))
    .map((name) => {
      const definition = getDefinition(TOOL_REGISTRY[name]);
      return asClaudeCodeToolDefinition(definition);
    });

  // Append dynamic tool definitions, deduplicating by name to avoid API errors
  const loader = getDynamicToolLoader();
  const dynamicDefs = loader ? loader.getDefinitions() : [];

  const allDefs = [...staticDefs, ...dynamicDefs];
  const seen = new Set<string>();
  return allDefs.filter(def => {
    if (seen.has(def.name)) return false;
    seen.add(def.name);
    return true;
  });
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
  const internalName = fromClaudeCodeToolName(toolName);
  const manager = getToolManager();

  // Block execution of disabled tools
  if (!manager.isEnabled(internalName as ToolName)) {
    return {
      result: {
        tool_use_id: toolUseId,
        type: "tool_result",
        content: `Tool '${toolName}' is currently disabled. Use tool_manage (action: enable) to enable it.`,
        is_error: true,
      },
    };
  }

  const entry = TOOL_REGISTRY[internalName as ToolName];

  if (!entry) {
    // Check dynamic tools
    const loader = getDynamicToolLoader();
    if (loader?.has(internalName)) {
      try {
        const output = await loader.execute(internalName, params, cwd);
        return {
          result: {
            tool_use_id: toolUseId,
            type: "tool_result",
            content: output,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          result: {
            tool_use_id: toolUseId,
            type: "tool_result",
            content: `Error executing dynamic tool: ${message}`,
            is_error: true,
          },
        };
      }
    }

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
        content: formatToolOutput(toolName, output, sideEffects),
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
