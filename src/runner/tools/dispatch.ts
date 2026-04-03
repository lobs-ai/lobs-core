/**
 * dispatch_agent tool — launches a lightweight read-only sub-agent for search and investigation tasks.
 *
 * The sub-agent runs in its own throwaway context with a restricted tool set
 * (read-only: Read, Grep, Glob, find_files, code_search, ls). Only the final
 * text response is returned to the caller, keeping the main agent's context clean.
 */

import type { ToolDefinition, ToolExecutorResult } from "../types.js";
import { runAgent } from "../agent-loop.js";

export const dispatchAgentToolDefinition: ToolDefinition = {
  name: "dispatch_agent",
  description:
    "Launch a lightweight read-only sub-agent for search and investigation tasks. The sub-agent runs in its own context with restricted tools (Read, Grep, Glob, find_files, code_search, ls only — no write/execute). Returns only the sub-agent's final text response, keeping your context clean. Use this instead of reading many files yourself when searching for something.",
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "What to search for or investigate. Be specific — the sub-agent has no context beyond this instruction.",
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the sub-agent. Defaults to your current working directory.",
      },
    },
    required: ["task"],
  },
};

export async function dispatchAgentTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<ToolExecutorResult> {
  const task = params.task as string;
  const agentCwd = (params.cwd as string) || cwd;

  if (!task || task.trim().length === 0) {
    return { output: "Error: task is required", sideEffects: undefined };
  }

  // Restricted read-only tool set — no write, edit, exec, or agent spawning
  const readOnlyTools = [
    "read",
    "grep",
    "glob",
    "find_files",
    "code_search",
    "ls",
  ] as const;

  try {
    const result = await runAgent({
      agent: "researcher",
      task: `You are a search agent. Find the answer to this question and respond with a concise, specific answer. Include file paths and line numbers when referencing code.\n\nQuestion: ${task}`,
      model: "anthropic/claude-sonnet-4-20250514",
      cwd: agentCwd,
      tools: [...readOnlyTools],
      maxTurns: 15,
      timeout: 120,
      disableTranscript: true,
    });

    if (result.succeeded && result.output.trim().length > 0) {
      const output = result.output.trim();
      const meta = `[dispatch_agent completed in ${result.turns} turns, ${result.durationSeconds.toFixed(1)}s]`;
      return { output: `${meta}\n\n${output}`, sideEffects: undefined };
    }

    if (!result.succeeded) {
      return {
        output: `dispatch_agent failed: ${result.error || "unknown error"} (${result.turns} turns, ${result.durationSeconds.toFixed(1)}s)`,
        sideEffects: undefined,
      };
    }

    return { output: "dispatch_agent returned empty result", sideEffects: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: `dispatch_agent error: ${message}`, sideEffects: undefined };
  }
}
