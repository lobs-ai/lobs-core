/**
 * Claude Code CLI client — routes through the `claude -p` binary so we use
 * the user's Claude Code OAuth subscription instead of paying API rates.
 *
 * Model strings: "claude-cli/opus", "claude-cli/sonnet", "claude-cli/haiku".
 *
 * Scope (current):
 *   - Text completions only (system + user/assistant message history → text).
 *   - Tool calling is not yet supported via this provider. If `tools` is
 *     non-empty, we throw a clear error pointing to the anthropic/ prefix.
 *     The plan is to add an in-process MCP server that exposes the agent's
 *     tools to claude — modeled on openclaw's cli-runner — but that requires
 *     extending the LLMClient interface to carry a tool executor, which is a
 *     separate change.
 */
import { spawn } from "node:child_process";
import type {
  LLMClient,
  LLMMessage,
  LLMResponse,
} from "./providers.js";
import type { ToolDefinition, TokenUsage } from "./types.js";

const CLAUDE_BINARY = process.env.LOBS_CLAUDE_CLI_PATH || "claude";

/**
 * Map a lobs-style model id to the alias claude expects on --model.
 * Accepts both the short aliases ("opus") and full ids ("claude-opus-4-7").
 */
const MODEL_ALIASES: Record<string, string> = {
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

function resolveModelAlias(modelId: string): string {
  return MODEL_ALIASES[modelId] ?? modelId;
}

/**
 * Env vars that would steer the Claude CLI to a different provider/endpoint
 * (Bedrock, Vertex, API key, etc.) instead of using the local OAuth login.
 * Mirrors openclaw's CLAUDE_CLI_CLEAR_ENV.
 */
const CLAUDE_CLEAR_ENV = [
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

function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (CLAUDE_CLEAR_ENV.includes(key)) continue;
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
function flattenMessagesToPrompt(messages: LLMMessage[]): string {
  if (messages.length === 0) return "";

  const blockToText = (
    content: LLMMessage["content"],
  ): string => {
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

interface ParsedResult {
  text: string;
  thinking: string;
  usage: TokenUsage;
  stopReason: LLMResponse["stopReason"];
  sessionId?: string;
  errorMessage?: string;
}

function parseJsonlOutput(stdout: string): ParsedResult {
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
        // Prefer the final consolidated result text when available.
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
          // Stream-json emits multiple incremental assistant messages; we keep
          // the latest text per message (each event carries the full block,
          // not a delta, in non-partial mode).
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

export interface ClaudeCliClientOptions {
  sessionId?: string;
  /** Override the binary path. Defaults to env LOBS_CLAUDE_CLI_PATH or "claude". */
  binaryPath?: string;
}

export class ClaudeCliClient implements LLMClient {
  private readonly modelAlias: string;
  private readonly sessionId?: string;
  private readonly binary: string;

  constructor(modelId: string, options?: ClaudeCliClientOptions) {
    this.modelAlias = resolveModelAlias(modelId);
    this.sessionId = options?.sessionId;
    this.binary = options?.binaryPath || CLAUDE_BINARY;
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
  }): Promise<LLMResponse> {
    if (params.tools.length > 0) {
      throw new Error(
        "claude-cli provider does not support tool calling yet. " +
          "Use the anthropic/ prefix (e.g. anthropic/claude-opus-4-6) for " +
          "agent-loop calls that need tools, or omit tools to use claude-cli " +
          "for text completions. Planned: MCP-server bridge so claude can " +
          "call lobs-core tools directly.",
      );
    }

    const prompt = flattenMessagesToPrompt(params.messages);
    if (!prompt) {
      throw new Error("claude-cli: empty prompt — no messages provided");
    }

    const args: string[] = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "user",
      "--tools",
      "", // disable claude's built-in tools — we use it as a plain completion engine
      "--permission-mode",
      "bypassPermissions",
      "--model",
      resolveModelAlias(params.model || this.modelAlias),
    ];
    if (params.system && params.system.trim().length > 0) {
      args.push("--append-system-prompt", params.system);
    }

    const env = buildChildEnv();

    return await new Promise<LLMResponse>((resolve, reject) => {
      const child = spawn(this.binary, args, {
        env,
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
          reject(
            new Error(
              `claude-cli exited ${code} (model=${resolveModelAlias(params.model || this.modelAlias)}): ${tail || "no output"}`,
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

      // Send the prompt on stdin so we don't hit argv length limits and
      // don't have to worry about shell escaping.
      child.stdin.end(prompt);
    });
  }
}

export function createClaudeCliClient(
  modelId: string,
  options?: ClaudeCliClientOptions,
): ClaudeCliClient {
  return new ClaudeCliClient(modelId, options);
}
