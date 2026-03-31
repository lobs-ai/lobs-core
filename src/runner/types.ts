/**
 * Agent runner types — our own agent execution engine.
 */

export interface AgentSpec {
  /** Task prompt — what the agent should do */
  task: string;
  /** Agent type (programmer, writer, researcher, reviewer, architect) */
  agent: string;
  /** System prompt override (otherwise built from agent template) */
  systemPrompt?: string;
  /** Model to use (e.g. "claude-sonnet-4-6") */
  model: string;
  /** Provider (anthropic, openai) — defaults to anthropic */
  provider?: "anthropic" | "openai";
  /** Working directory for exec/file operations */
  cwd: string;
  /** Tools to enable */
  tools: ToolName[];
  /** Max execution time in seconds */
  timeout: number;
  /** Max LLM turns before forced stop */
  maxTurns?: number;
  /** Context to inject (from lobs-memory, task notes, etc.) */
  context?: AgentContext;
  /** Callback for progress updates */
  onProgress?: (update: ProgressUpdate) => void;
  /** Seed the loop with an explicit message history instead of task-only initialization */
  initialMessages?: import("./providers.js").LLMMessage[];
  /** Override the LLM client used by the shared agent loop */
  clientOverride?: import("./providers.js").LLMClient;
  /** Sanitize or rewrite assistant content blocks before they are stored back into the loop */
  sanitizeResponseContent?: (
    content: import("./providers.js").LLMResponse["content"],
  ) => import("./providers.js").LLMResponse["content"];
  /** Override tool execution for session-specific environments such as the main agent */
  toolExecutor?: (
    toolName: string,
    params: Record<string, unknown>,
    toolUseId: string,
    cwd: string,
    context?: { channelId?: string; toolUseId?: string },
  ) => Promise<ToolExecutionResult>;
  /** Hook before each model call */
  beforeLlmCall?: (event: {
    turn: number;
    messages: import("./providers.js").LLMMessage[];
    systemPrompt: string;
    currentCwd: string;
  }) => Promise<void> | void;
  /** Hook after each model call */
  afterLlmCall?: (event: {
    turn: number;
    response: import("./providers.js").LLMResponse;
    currentCwd: string;
  }) => Promise<void> | void;
  /** Hook before each tool execution */
  onToolStart?: (event: {
    turn: number;
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
    currentCwd: string;
  }) => Promise<void> | void;
  /** Hook after each tool execution */
  onToolResult?: (event: {
    turn: number;
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
    result: ToolResult;
    sideEffects?: ToolSideEffects;
    durationMs: number;
    currentCwd: string;
  }) => Promise<void> | void;
  /** Hook after an assistant tool-use response and its tool-result roundtrip complete */
  onToolRound?: (event: {
    turn: number;
    assistantContent: import("./providers.js").LLMResponse["content"];
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    results: ToolResult[];
    currentCwd: string;
  }) => Promise<void> | void;
  /** Extended thinking mode (Anthropic) */
  thinking?: {
    type: "enabled";
    budgetTokens: number;
  } | {
    type: "adaptive";
  };
  /**
   * Prior conversation messages for session resumption.
   * When set, the agent loop resumes from these messages instead of
   * starting fresh with just the task prompt.
   */
  resumeMessages?: import("./providers.js").LLMMessage[];
  /** Override the session/run ID (for transcript file naming) */
  runId?: string;
  /** Disable JSONL/markdown transcript persistence for host-managed loops like the main agent */
  disableTranscript?: boolean;
  /**
   * Abort signal for graceful shutdown.
   * When aborted, the agent loop finishes the current turn then writes a
   * shutdown checkpoint (stopReason="interrupted") so the run can be resumed
   * after a restart without losing progress.
   */
  abortSignal?: AbortSignal;
  /**
   * Optional function to drain injected messages from the parent agent.
   * Called at the start of each turn; returned messages are prepended as
   * user messages before the LLM call. Used by message_agent tool.
   */
  getInjectedMessages?: () => string[];
  /** Called when the agent's phase changes (waiting_llm, executing_tool, between_turns) */
  onPhaseChange?: (phase: AgentPhase) => void;
}

export type AgentPhase =
  | { phase: 'waiting_llm'; turn: number; startedAt: number }
  | { phase: 'executing_tool'; turn: number; toolName: string; startedAt: number }
  | { phase: 'between_turns'; turn: number; startedAt: number }
  | { phase: 'compacting'; turn: number; startedAt: number };

export type ToolName = "exec" | "read" | "write" | "edit" | "ls" | "grep" | "glob" | "find_files" | "code_search" | "web_search" | "web_fetch" | "memory_search" | "memory_read" | "memory_write" | "spawn_agent" | "run_pipeline" | "list_agents" | "check_agents" | "message_agent" | "stop_agent" | "cron" | "discord" | "process" | "humanize" | "imagine" | "html_to_pdf";

export interface AgentContext {
  taskId?: string;
  projectId?: string;
  /** Pre-loaded context files content */
  contextRefs?: Array<{ path: string; content: string }>;
  /** Learnings to inject */
  learnings?: string;
  /** Additional system context */
  additionalContext?: string;
}

export interface AgentResult {
  succeeded: boolean;
  /** Final text output from the agent */
  output: string;
  /** Token usage */
  usage: TokenUsage;
  /** Estimated cost in USD */
  costUsd: number;
  /** Duration in seconds */
  durationSeconds: number;
  /** Number of LLM turns */
  turns: number;
  /** How the run ended */
  stopReason: "end_turn" | "max_turns" | "timeout" | "error" | "interrupted";
  /** Error message if failed */
  error?: string;
  /** Files created or modified during the run */
  artifacts?: string[];
  /** Extended thinking content (if thinking mode enabled) */
  thinkingContent?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens?: number;
}

export interface ProgressUpdate {
  turn: number;
  type: "tool_call" | "text" | "error";
  toolName?: string;
  text?: string;
  usage?: TokenUsage;
}

/** Tool definition for Anthropic API */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Tool execution result */
export interface ToolResult {
  tool_use_id: string;
  type: "tool_result";
  content: string | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;
  is_error?: boolean;
}

/** Side effects a tool can signal back to the agent loop */
export interface ToolSideEffects {
  /** Update the agent's current working directory */
  newCwd?: string;
}

/** Result from a tool executor — either a plain string or string + side effects */
export type ToolExecutorResult = string | { output: string; sideEffects: ToolSideEffects };

/** Extended tool execution result with side effects */
export interface ToolExecutionResult {
  result: ToolResult;
  /** Side effects to apply to the agent loop state */
  sideEffects?: ToolSideEffects;
}

import { getModelConfig } from "../config/models.js";

/** Cost per million tokens by model (reads from config) */
export function getModelCosts(): Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> {
  return getModelConfig().costs;
}

/** @deprecated Use getModelCosts() — kept for backwards compat */
export const MODEL_COSTS = getModelConfig().costs;
