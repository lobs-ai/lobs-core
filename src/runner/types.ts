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
  /** Model to use (e.g. "claude-sonnet-4-5-20250514") */
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
  /** Extended thinking mode (Anthropic) */
  thinking?: {
    type: "enabled";
    budgetTokens: number;
  };
}

export type ToolName = "exec" | "read" | "write" | "edit" | "web_search" | "web_fetch" | "memory_search" | "memory_read" | "memory_write";

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
  stopReason: "end_turn" | "max_turns" | "timeout" | "error";
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

/** Cost per million tokens by model (partial match on key) */
export const MODEL_COSTS: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  // Sonnet 4.5
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // Sonnet 4
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // Opus 4.6
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  // Opus 4
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  // Haiku 4.5
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // Haiku 3.5
  "claude-haiku-3-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};
