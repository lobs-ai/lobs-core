/**
 * Agent runner — public API.
 *
 * This is the entry point for running agents through our own execution engine.
 * No OpenClaw dependency — calls the Anthropic API directly, executes tools in-process.
 *
 * Usage:
 *   import { runAgent } from "./runner/index.js";
 *
 *   const result = await runAgent({
 *     task: "Fix the auth bug in src/auth.ts",
 *     agent: "programmer",
 *     model: "claude-sonnet-4-5-20250514",
 *     cwd: "/path/to/repo",
 *     tools: ["exec", "read", "write", "edit"],
 *     timeout: 900,
 *   });
 *
 *   console.log(result.succeeded, result.usage, result.costUsd);
 */

export { runAgent } from "./agent-loop.js";
export type { AgentSpec, AgentResult, TokenUsage, ProgressUpdate, ToolName } from "./types.js";
export { buildSystemPrompt, loadContextRefs } from "./prompt-builder.js";
export { getToolDefinitions, executeTool } from "./tools/index.js";
