/**
 * Claude Code CLI client — routes through the `claude -p` binary so we use
 * the user's Claude Code OAuth subscription instead of paying API rates.
 *
 * Model strings: "claude-cli/opus", "claude-cli/sonnet", "claude-cli/haiku".
 *
 * Two modes:
 *
 *   - Text completion (no `tools`): claude generates a response from the
 *     prompt and exits. We parse the JSONL `result` event for text + usage.
 *
 *   - Tool-calling agent (`tools` + `toolExecutor`): we stand up an in-process
 *     MCP server that exposes the caller's tools to claude, then spawn
 *     `claude -p --mcp-config '{...}' --allowedTools 'mcp__lobs__*'`. Claude
 *     drives its own agent loop, calling our tools via MCP. We return the
 *     final text response as a single LLMResponse — callers using
 *     agent-loop.ts see one createMessage call with `stop_reason=end_turn`
 *     and no tool_use blocks, which terminates the outer loop correctly.
 */
import { spawn } from "node:child_process";
import type {
  ClaudeCliToolExecutor,
  LLMClient,
  LLMMessage,
  LLMResponse,
} from "./providers.js";
import type { ToolDefinition, TokenUsage } from "./types.js";
import {
  startClaudeCliMcpServer,
  CLAUDE_CLI_MCP_SERVER_NAME,
  type ClaudeCliMcpServerHandle,
} from "./claude-cli-mcp-server.js";

const CLAUDE_BINARY = process.env.LOBS_CLAUDE_CLI_PATH || "claude";

/**
 * Map a lobs-style model id to the alias claude expects on --model.
 * Accepts both the short aliases ("opus") and full ids ("claude-opus-4-7").
 */
export const CLAUDE_CLI_MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "claude-opus-4-7": "opus",
  "claude-opus-4-6": "opus",
  "claude-opus-4-5": "opus",
  "claude-opus-4": "opus",
  sonnet: "sonnet",
  "claude-sonnet-4-7": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4": "sonnet",
  haiku: "haiku",
  "claude-haiku-4-5": "haiku",
  "claude-haiku-4": "haiku",
};

export function resolveClaudeCliModelAlias(modelId: string): string {
  return CLAUDE_CLI_MODEL_ALIASES[modelId] ?? modelId;
}

/**
 * Env vars that would steer the Claude CLI to a different provider/endpoint
 * (Bedrock, Vertex, API key, etc.) instead of using the local OAuth login.
 * Mirrors openclaw's CLAUDE_CLI_CLEAR_ENV.
 */
export const CLAUDE_CLI_CLEAR_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
];

export function buildClaudeCliChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") continue;
    if (CLAUDE_CLI_CLEAR_ENV.includes(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Flatten the message history into a single prompt for `claude -p`.
 *
 * claude -p doesn't accept an Anthropic-style messages[] array — it takes one
 * prompt and replies. For multi-turn callers we serialize prior turns with
 * role tags so the model has the conversation context, then emit the latest
 * user message as the live prompt.
 */
export function flattenMessagesToPrompt(messages: LLMMessage[]): string {
  if (messages.length === 0) return "";

  const blockToText = (content: LLMMessage["content"]): string => {
    if (typeof content === "string") return content;
    const parts: string[] = [];
    for (const raw of content) {
      const b = raw as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b.type === "tool_use") {
        parts.push(
          `[tool_use ${String(b.name)}(${JSON.stringify(b.input ?? {})})]`,
        );
      } else if (b.type === "tool_result") {
        const inner =
          typeof b.content === "string"
            ? b.content
            : JSON.stringify(b.content);
        parts.push(`[tool_result ${String(b.tool_use_id ?? "")}: ${inner}]`);
      } else if (b.type === "image") {
        parts.push("[image omitted]");
      }
    }
    return parts.join("\n");
  };

  if (messages.length === 1) {
    return blockToText(messages[0].content);
  }

  const sections: string[] = [];
  for (let i = 0; i < messages.length - 1; i += 1) {
    const msg = messages[i];
    const tag = msg.role === "user" ? "User" : "Assistant";
    sections.push(`${tag}: ${blockToText(msg.content)}`);
  }
  const last = messages[messages.length - 1];
  if (last.role === "user") {
    sections.push(`User: ${blockToText(last.content)}`);
  } else {
    sections.push(`Assistant: ${blockToText(last.content)}`);
    sections.push("User: (continue)");
  }
  return sections.join("\n\n");
}

type StreamEvent = Record<string, unknown>;

export interface ParsedResult {
  text: string;
  thinking: string;
  usage: TokenUsage;
  stopReason: LLMResponse["stopReason"];
  sessionId?: string;
  errorMessage?: string;
}

export function parseJsonlOutput(stdout: string): ParsedResult {
  let assistantText = "";
  let thinkingText = "";
  let usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let stopReason: LLMResponse["stopReason"] = "end_turn";
  let sessionId: string | undefined;
  let errorMessage: string | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue;
    }

    const type = event.type;
    if (type === "system" && (event as { subtype?: string }).subtype === "init") {
      sessionId = (event as { session_id?: string }).session_id;
      continue;
    }

    if (type === "result") {
      const result = event as {
        result?: string;
        stop_reason?: string;
        is_error?: boolean;
        api_error_status?: string | null;
        usage?: Record<string, unknown>;
        session_id?: string;
      };
      if (typeof result.result === "string" && result.result.length > 0) {
        assistantText = result.result;
      }
      if (result.is_error) {
        errorMessage =
          result.result ||
          result.api_error_status ||
          "claude -p reported an error";
      }
      switch (result.stop_reason) {
        case "end_turn":
          stopReason = "end_turn";
          break;
        case "tool_use":
          stopReason = "tool_use";
          break;
        case "max_tokens":
          stopReason = "max_tokens";
          break;
        default:
          stopReason = "stop";
      }
      if (result.usage && typeof result.usage === "object") {
        const u = result.usage as Record<string, number | undefined>;
        usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        };
      }
      if (result.session_id) sessionId = result.session_id;
      continue;
    }

    if (type === "assistant") {
      const message = (event as { message?: { content?: unknown[] } }).message;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const raw of blocks) {
        const block = raw as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") {
          assistantText = block.text;
        } else if (
          block.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          thinkingText = block.thinking;
        }
      }
      continue;
    }
  }

  return {
    text: assistantText,
    thinking: thinkingText,
    usage,
    stopReason,
    sessionId,
    errorMessage,
  };
}

export interface BuildArgsParams {
  model: string;
  systemPrompt: string;
  mcp?: { url: string; authToken: string };
}

/**
 * Pure: build the argv we'll pass to `claude`. Exported for test coverage of
 * the MCP-vs-text-only branching and arg ordering.
 */
export function buildClaudeCliArgs(params: BuildArgsParams): string[] {
  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "user",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    resolveClaudeCliModelAlias(params.model),
  ];

  if (params.mcp) {
    const mcpConfig = {
      mcpServers: {
        [CLAUDE_CLI_MCP_SERVER_NAME]: {
          type: "http",
          url: params.mcp.url,
          headers: { Authorization: `Bearer ${params.mcp.authToken}` },
        },
      },
    };
    args.push("--mcp-config", JSON.stringify(mcpConfig));
    args.push("--strict-mcp-config");
    args.push("--allowedTools", `mcp__${CLAUDE_CLI_MCP_SERVER_NAME}__*`);
  } else {
    // No tools — disable claude's built-ins so it acts as a pure completion engine.
    args.push("--tools", "");
  }

  if (params.systemPrompt && params.systemPrompt.trim().length > 0) {
    args.push("--append-system-prompt", params.systemPrompt);
  }

  return args;
}

export interface ClaudeCliClientOptions {
  sessionId?: string;
  /** Override the binary path. Defaults to env LOBS_CLAUDE_CLI_PATH or "claude". */
  binaryPath?: string;
  /**
   * Override how the MCP server is started — used by tests to inject a stub.
   */
  startMcpServer?: typeof startClaudeCliMcpServer;
}

export class ClaudeCliClient implements LLMClient {
  private readonly defaultModelAlias: string;
  private readonly sessionId?: string;
  private readonly binary: string;
  private readonly startMcpServer: typeof startClaudeCliMcpServer;

  constructor(modelId: string, options?: ClaudeCliClientOptions) {
    this.defaultModelAlias = resolveClaudeCliModelAlias(modelId);
    this.sessionId = options?.sessionId;
    this.binary = options?.binaryPath || CLAUDE_BINARY;
    this.startMcpServer = options?.startMcpServer ?? startClaudeCliMcpServer;
  }

  async createMessage(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    thinking?:
      | { type: "enabled"; budgetTokens: number }
      | { type: "adaptive" };
    toolExecutor?: ClaudeCliToolExecutor;
  }): Promise<LLMResponse> {
    const prompt = flattenMessagesToPrompt(params.messages);
    if (!prompt) {
      throw new Error("claude-cli: empty prompt — no messages provided");
    }

    const wantsTools = params.tools.length > 0;
    if (wantsTools && !params.toolExecutor) {
      throw new Error(
        "claude-cli: tools were provided but no toolExecutor — the caller " +
          "must pass an executor so the in-process MCP server can dispatch " +
          "tool calls back to lobs-core.",
      );
    }

    let mcpHandle: ClaudeCliMcpServerHandle | undefined;
    if (wantsTools && params.toolExecutor) {
      mcpHandle = await this.startMcpServer({
        tools: params.tools,
        executor: params.toolExecutor,
      });
    }

    try {
      const args = buildClaudeCliArgs({
        model: params.model || this.defaultModelAlias,
        systemPrompt: params.system,
        mcp: mcpHandle
          ? { url: mcpHandle.url, authToken: mcpHandle.authToken }
          : undefined,
      });
      const env = buildClaudeCliChildEnv();
      return await this.spawnAndCollect({ args, env, prompt, modelLabel: params.model });
    } finally {
      if (mcpHandle) {
        await mcpHandle.close();
      }
    }
  }

  private async spawnAndCollect(params: {
    args: string[];
    env: Record<string, string>;
    prompt: string;
    modelLabel: string;
  }): Promise<LLMResponse> {
    return await new Promise<LLMResponse>((resolve, reject) => {
      const child = spawn(this.binary, params.args, {
        env: params.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (err) => {
        reject(
          new Error(
            `claude-cli: failed to spawn "${this.binary}": ${err.message}. ` +
              `Set LOBS_CLAUDE_CLI_PATH or install Claude Code.`,
          ),
        );
      });

      child.on("close", (code) => {
        if (code !== 0) {
          const tail = stderr.trim() || stdout.trim().slice(-500);
          const aliased = resolveClaudeCliModelAlias(
            params.modelLabel || this.defaultModelAlias,
          );
          reject(
            new Error(
              `claude-cli exited ${code} (model=${aliased}): ${tail || "no output"}`,
            ),
          );
          return;
        }
        const parsed = parseJsonlOutput(stdout);
        if (parsed.errorMessage) {
          reject(new Error(`claude-cli: ${parsed.errorMessage}`));
          return;
        }
        const content: LLMResponse["content"] = parsed.text
          ? [{ type: "text", text: parsed.text }]
          : [{ type: "text", text: "" }];
        const response: LLMResponse = {
          content,
          stopReason: parsed.stopReason,
          usage: parsed.usage,
        };
        if (parsed.thinking) {
          response.thinkingContent = parsed.thinking;
        }
        resolve(response);
      });

      child.stdin.end(params.prompt);
    });
  }
}

export function createClaudeCliClient(
  modelId: string,
  options?: ClaudeCliClientOptions,
): ClaudeCliClient {
  return new ClaudeCliClient(modelId, options);
}
