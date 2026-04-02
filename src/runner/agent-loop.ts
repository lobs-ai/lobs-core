/**
 * Agent loop — the core LLM ↔ tool execution cycle.
 *
 * Multi-provider: Anthropic (native), OpenAI, LM Studio, OpenRouter, any OpenAI-compatible.
 * Uses provider abstraction to normalize all responses to a common format.
 */

import type {
  AgentSpec,
  AgentResult,
  TokenUsage,
  ToolResult,
} from "./types.js";
export type { AgentPhase } from "./types.js";
import { MODEL_COSTS as COSTS } from "./types.js";
import { getToolDefinitions, executeTool } from "./tools/index.js";
import { buildSystemPrompt, buildSmartSystemPrompt } from "./prompt-builder.js";
import { parseModelString, createResilientClient, type LLMMessage, type LLMResponse } from "./providers.js";
import { createHash, randomBytes } from "node:crypto";
import { SessionTranscript, type TurnRecord } from "./session-transcript.js";
import { shouldCompact, estimateTokens } from "./context-manager.js";
import { compactMessages as smartCompactMessages, pruneToolResults } from "../services/compaction.js";
import { getHookRegistry } from "./hooks.js";
import { LoopDetector } from "./loop-detector.js";
import { asClaudeSystemReminder, buildDynamicPromptStateSections } from "../claude-runtime/llm-prompt.js";

export type { AgentSpec, AgentResult };

const DEFAULT_MAX_TURNS = 200;
const DEFAULT_MAX_TOKENS = 16384;

function buildPostToolReminder(currentCwd: string, results: ToolResult[]): string {
  const successful = results.filter((result) => !result.is_error).length;
  const failed = results.length - successful;
  const lines = [
    "You have fresh tool results.",
    `Working directory: ${currentCwd}`,
    `Tool calls this round: ${results.length} total, ${successful} succeeded, ${failed} failed.`,
    "Use these results to decide the next concrete step.",
    "If the latest tool results already solve the user's request, respond and stop.",
    "If you changed files, prefer a targeted verification step before concluding.",
    "If the task is complete, stop instead of making extra tool calls.",
    "If more work is needed, prefer the smallest next read/search/edit/exec action that reduces uncertainty.",
  ];
  return asClaudeSystemReminder(lines.join("\n"));
}

type QueryPhase = "initial" | "resume" | "post_tool" | "continuation" | "redirected";

type QueryState = {
  phase: QueryPhase;
  currentCwd: string;
  continuationCount: number;
  turnIndex: number;
  lastStopReason?: LLMResponse["stopReason"];
  pendingReminder?: string;
  carryForwardState?: string;
};

function queueQueryReminder(queryState: QueryState, reminder: string): void {
  queryState.pendingReminder = queryState.pendingReminder
    ? `${queryState.pendingReminder}\n\n${reminder}`
    : reminder;
}

function flushPendingReminder(messages: LLMMessage[], queryState: QueryState): void {
  if (!queryState.pendingReminder) return;
  messages.push({
    role: "user",
    content: [{ type: "text", text: queryState.pendingReminder }],
  });
  queryState.pendingReminder = undefined;
}

function buildContinuationReminder(continuationCount: number): string {
  return asClaudeSystemReminder(
    `Continue from where you left off. This is continuation attempt ${continuationCount}/2. ` +
    "Do not restart the task or repeat prior reasoning. Finish the interrupted response cleanly."
  );
}

function buildRedirectedReminder(message: string): string {
  return asClaudeSystemReminder(`Message from parent agent:\n${message}`);
}

function buildResumeReminder(): string {
  return asClaudeSystemReminder(
    "Your session was interrupted by a process restart. " +
    "Your full conversation history has been restored. " +
    "Continue where you left off. Orient quickly if needed, then keep working. " +
    "Do not restart the task from scratch."
  );
}

function buildCarryForwardState(params: {
  currentCwd: string;
  lastAssistantText: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  results?: ToolResult[];
}): string | null {
  const { currentCwd, lastAssistantText, toolCalls, results } = params;
  const lines = ["Carry-forward state:", `- Working directory: ${currentCwd}`];

  if (toolCalls && toolCalls.length > 0) {
    lines.push(`- Last tool round: ${toolCalls.map((call) => call.name).join(", ")}`);
  }

  if (results && results.length > 0) {
    const failures = results.filter((result) => result.is_error).length;
    lines.push(`- Last tool status: ${results.length - failures} succeeded, ${failures} failed`);
  }

  const trimmed = lastAssistantText.trim();
  if (trimmed.length > 0) {
    lines.push(`- Last assistant conclusion: ${trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed}`);
  }

  return lines.length > 1 ? asClaudeSystemReminder(lines.join("\n")) : null;
}

function truncateStateValue(value: string, maxLength = 400): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

function collectFilePaths(toolCalls: Array<{ name: string; input: Record<string, unknown> }>): string[] {
  const files = new Set<string>();
  for (const call of toolCalls) {
    const candidate = (call.input.file_path as string) ?? (call.input.path as string);
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      files.add(candidate.trim());
    }
  }
  return Array.from(files);
}

function updateWorkingStateFromAssistant(spec: AgentSpec, params: {
  currentCwd: string;
  lastAssistantText: string;
}): void {
  const context = (spec.context ??= {});
  const workingState = (context.workingState ??= {});
  workingState.currentCwd = params.currentCwd;
  if (params.lastAssistantText.trim().length > 0) {
    workingState.lastAssistantConclusion = truncateStateValue(params.lastAssistantText);
  }
  if (!workingState.objective && typeof spec.task === "string") {
    workingState.objective = spec.task.trim().split("\n").find((line) => line.trim().length > 0) ?? spec.task.trim();
  }
}

function updateWorkingStateFromTools(spec: AgentSpec, params: {
  currentCwd: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  results: ToolResult[];
}): void {
  const context = (spec.context ??= {});
  const workingState = (context.workingState ??= {});
  workingState.currentCwd = params.currentCwd;
  const failures = params.results.filter((result) => result.is_error).length;
  workingState.recentToolSummary =
    `${params.toolCalls.map((call) => call.name).join(", ")}; ` +
    `${params.results.length - failures} succeeded, ${failures} failed`;

  const filesInPlay = new Set(workingState.filesInPlay ?? []);
  for (const file of collectFilePaths(params.toolCalls)) filesInPlay.add(file);
  workingState.filesInPlay = Array.from(filesInPlay).slice(-12);

  if (failures > 0) {
    const failedTools = params.toolCalls
      .filter((_, index) => params.results[index]?.is_error)
      .map((call) => call.name);
    const outstanding = new Set(workingState.outstandingWork ?? []);
    outstanding.add(`Resolve failures from: ${failedTools.join(", ")}`);
    workingState.outstandingWork = Array.from(outstanding).slice(-8);
  }
}

function parseStructuredSubagentEvent(text: string): {
  runId: string;
  agentType: string;
  status: "completed" | "failed" | "running" | "unknown";
  task: string;
  turns?: number;
  costUsd?: number;
  durationSeconds?: number;
  result?: string;
} | null {
  const normalized = text.startsWith("[System Event] ")
    ? text.slice("[System Event] ".length)
    : text;
  if (!normalized.startsWith("[Subagent event]")) return null;

  const lines = normalized.split("\n");
  const map = new Map<string, string>();
  let outcomeLabel: string | null = null;
  const outcomeLines: string[] = [];

  for (const line of lines.slice(1)) {
    if (!outcomeLabel) {
      const match = line.match(/^([a-z_]+):\s*(.*)$/);
      if (match) {
        const [, key, value] = match;
        if (key === "result" || key === "error") {
          outcomeLabel = key;
          if (value) outcomeLines.push(value);
        } else {
          map.set(key, value);
        }
        continue;
      }
    }
    if (outcomeLabel) outcomeLines.push(line);
  }

  const runId = map.get("run_id");
  const agentType = map.get("agent_type");
  const task = map.get("task");
  if (!runId || !agentType || !task) return null;

  const statusValue = map.get("status");
  const status = statusValue === "completed" || statusValue === "failed" || statusValue === "running"
    ? statusValue
    : "unknown";

  const turns = map.get("turns");
  const costUsd = map.get("cost_usd");
  const durationSeconds = map.get("duration_seconds");

  return {
    runId,
    agentType,
    status,
    task,
    ...(turns ? { turns: Number(turns) } : {}),
    ...(costUsd ? { costUsd: Number(costUsd) } : {}),
    ...(durationSeconds ? { durationSeconds: Number(durationSeconds) } : {}),
    ...(outcomeLines.length > 0 ? { result: truncateStateValue(outcomeLines.join("\n"), 600) } : {}),
  };
}

function absorbStructuredEventIntoContext(spec: AgentSpec, text: string): void {
  const parsed = parseStructuredSubagentEvent(text);
  if (!parsed) return;

  const context = (spec.context ??= {});
  const events = context.subagentEvents ?? [];
  const next = events.filter((event) => event.runId !== parsed.runId);
  next.push(parsed);
  context.subagentEvents = next.slice(-8);

  const workingState = (context.workingState ??= {});
  const outstanding = new Set(workingState.outstandingWork ?? []);
  if (parsed.status === "failed") {
    outstanding.add(`Review failed subagent ${parsed.agentType} (${parsed.runId}) and recover the task`);
  } else if (parsed.status === "completed") {
    outstanding.add(`Integrate subagent ${parsed.agentType} (${parsed.runId}) result into the next step`);
  }
  workingState.outstandingWork = Array.from(outstanding).slice(-8);
}

function absorbMessageContentIntoContext(spec: AgentSpec, content: LLMMessage["content"]): void {
  if (typeof content === "string") {
    absorbStructuredEventIntoContext(spec, content);
    return;
  }

  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      absorbStructuredEventIntoContext(spec, block.text);
    }
  }
}

// Loop detection now handled by LoopDetector class

/**
 * Run an agent to completion.
 *
 * The loop:
 * 1. Parse model string → resolve provider + credentials
 * 2. Build system prompt + task message
 * 3. Call LLM API
 * 4. If tool_use → execute tools → feed results back → goto 3
 * 5. If end_turn → extract output → return result
 */
export async function runAgent(spec: AgentSpec): Promise<AgentResult> {
  const startTime = Date.now();
  const maxTurns = spec.maxTurns ?? DEFAULT_MAX_TURNS;
  const isResume = Boolean(spec.resumeMessages?.length);

  // Generate or use existing run ID for session persistence
  const runId = spec.runId ?? spec.context?.taskId ?? randomBytes(8).toString("hex");
  const transcript = spec.disableTranscript
    ? null
    : new SessionTranscript(spec.agent, runId);

  // Emit before_agent_start hook
  const hookRegistry = getHookRegistry();
  const startEvent = await hookRegistry.emit({
    hookName: "before_agent_start",
    agentType: spec.agent,
    taskId: spec.context?.taskId,
    data: { spec },
    timestamp: new Date(),
  });
  
  // If hook cancelled the start, return early
  if (!startEvent) {
    return {
      succeeded: false,
      output: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      durationSeconds: 0,
      turns: 0,
      stopReason: "error",
      error: "Agent start cancelled by hook",
    };
  }

  // Resolve provider from model string
  const providerConfig = parseModelString(spec.model);

  // Create LLM client with session ID for sticky key assignment
  let client;
  try {
    if (spec.clientOverride) {
      client = spec.clientOverride;
    } else {
      // Use taskId or runId as sessionId for sticky key assignment (prompt caching benefit)
      const sessionId = spec.context?.taskId ?? runId;
      client = createResilientClient(spec.model, {
        sessionId,
        maxRetries: 3,
      });
    }
  } catch (error) {
    return {
      succeeded: false,
      output: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      durationSeconds: 0,
      turns: 0,
      stopReason: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Build system prompt — use smart context engine if no explicit system prompt
  let systemPrompt: string;
  if (spec.systemPrompt) {
    systemPrompt = spec.systemPrompt;
  } else {
    try {
      // Try smart prompt with context engine (needs lobs-memory running)
      const smart = await buildSmartSystemPrompt(spec);
      systemPrompt = smart.systemPrompt;
    } catch {
      // Fall back to static prompt if context engine unavailable
      systemPrompt = buildSystemPrompt(spec);
    }
  }

  // Get tool definitions for the API
  const tools = getToolDefinitions(spec.tools);

  // Initialize message history — resume from prior session or start fresh
  const messages: LLMMessage[] = [];
  let resumedTurnCount = 0;
  const queryState: QueryState = {
    phase: isResume ? "resume" : "initial",
    currentCwd: spec.cwd,
    continuationCount: 0,
    turnIndex: 0,
  };
  if (spec.initialMessages && spec.initialMessages.length > 0) {
    messages.push(...spec.initialMessages);
    for (const message of spec.initialMessages) {
      absorbMessageContentIntoContext(spec, message.content);
    }
  } else if (isResume && spec.resumeMessages) {
    messages.push(...spec.resumeMessages);
    for (const message of spec.resumeMessages) {
      absorbMessageContentIntoContext(spec, message.content);
    }
    resumedTurnCount = Math.floor(spec.resumeMessages.length / 2); // rough estimate
    queueQueryReminder(queryState, buildResumeReminder());
    console.log(
      `[agent-loop] run=${runId} agent=${spec.agent} RESUMING session ` +
      `with ${spec.resumeMessages.length} prior messages (~${resumedTurnCount} turns)`
    );
  } else {
    messages.push({ role: "user", content: spec.task });
  }

  // Token tracking
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  let turns = 0;
  let lastTextOutput = "";
  let stopReason: AgentResult["stopReason"] = "end_turn";
  let thinkingContent = "";
  
  // Mutable cwd — tracks the agent's "current directory" across tool calls.
  // Updated when exec detects cd commands or workdir params.
  let currentCwd = spec.cwd;

  // Loop detection
  const loopDetector = new LoopDetector();

  // Timeout
  const timeoutMs = spec.timeout * 1000;

  try {
    while (turns < maxTurns) {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        stopReason = "timeout";
        break;
      }

      // Check abort signal — graceful shutdown before starting a new LLM call
      if (spec.abortSignal?.aborted) {
        stopReason = "interrupted";
        break;
      }

      turns++;
      queryState.turnIndex = turns;
      console.debug(
        `[agent-loop] run=${runId} agent=${spec.agent} turn=${turns} ` +
        `messages=${messages.length} input_tokens=${usage.inputTokens} output_tokens=${usage.outputTokens}`,
      );

      // Emit between_turns phase
      spec.onPhaseChange?.({ phase: 'between_turns', turn: turns, startedAt: Date.now() });

      // Check if we need to compact context
      if (shouldCompact(messages, spec.model)) {
        spec.onPhaseChange?.({ phase: 'compacting', turn: turns, startedAt: Date.now() });
        const beforeCount = messages.length;

        // Use smart LLM-based compaction
        const compactionResult = await smartCompactMessages(messages);
        if (compactionResult.compacted) {
          messages.splice(0, messages.length, ...compactionResult.messages);
        }
        const afterCount = messages.length;

        if (beforeCount !== afterCount) {
          console.log(
            `[Context compaction] Reduced messages from ${beforeCount} to ${afterCount} (estimated ${estimateTokens(messages).toLocaleString()} tokens)`
          );

          // Emit session_compacted hook
          await hookRegistry.emit({
            hookName: "session_compacted",
            agentType: spec.agent,
            taskId: spec.context?.taskId,
            data: { beforeCount, afterCount, inputTokens: usage.inputTokens },
            timestamp: new Date(),
          });
        }
      }

      // Check for injected messages from parent agent (via message_agent tool)
      if (spec.getInjectedMessages) {
        const injected = spec.getInjectedMessages();
        for (const msg of injected) {
          absorbStructuredEventIntoContext(spec, msg);
          queueQueryReminder(queryState, buildRedirectedReminder(msg));
          queryState.phase = "redirected";
          console.debug(`[agent-loop] run=${runId} injected message from parent`);
        }
      }

      if (queryState.carryForwardState) {
        queueQueryReminder(queryState, queryState.carryForwardState);
        queryState.carryForwardState = undefined;
      }

      flushPendingReminder(messages, queryState);

      const dynamicPromptState = buildDynamicPromptStateSections(spec);
      const llmSystemPrompt = dynamicPromptState
        ? `${systemPrompt}\n\n${dynamicPromptState}`
        : systemPrompt;

      // Emit before_llm_call hook
      await spec.beforeLlmCall?.({
        turn: turns,
        messages: [...messages],
        systemPrompt: llmSystemPrompt,
        currentCwd,
      });
      const beforeLlmEvent = await hookRegistry.emit({
        hookName: "before_llm_call",
        agentType: spec.agent,
        taskId: spec.context?.taskId,
        data: { turn: turns, model: spec.model, messageCount: messages.length },
        timestamp: new Date(),
      });
      
      // If hook cancelled the call, break loop
      if (!beforeLlmEvent) {
        stopReason = "error";
        break;
      }

      // Call the LLM
      let response: LLMResponse;
      try {
        console.debug(
          `[agent-loop] run=${runId} agent=${spec.agent} turn=${turns} ` +
          `calling_llm model=${providerConfig.modelId} tools=${tools.length}`,
        );
        spec.onPhaseChange?.({ phase: 'waiting_llm', turn: turns, startedAt: Date.now() });
        response = await client.createMessage({
          model: providerConfig.modelId,
          system: llmSystemPrompt,
          messages: pruneToolResults(messages),
          tools,
          maxTokens: DEFAULT_MAX_TOKENS,
          thinking: spec.thinking,
        });
        console.debug(
          `[agent-loop] run=${runId} agent=${spec.agent} turn=${turns} ` +
          `llm_response stop=${response.stopReason} blocks=${response.content.length} ` +
          `usage_in=${response.usage.inputTokens} usage_out=${response.usage.outputTokens}`,
        );
      } catch (error) {
        // Check if it's a timeout
        if (Date.now() - startTime > timeoutMs) {
          stopReason = "timeout";
          break;
        }
        throw error;
      }

      // Emit after_llm_call hook
      await spec.afterLlmCall?.({
        turn: turns,
        response,
        currentCwd,
      });
      await hookRegistry.emit({
        hookName: "after_llm_call",
        agentType: spec.agent,
        taskId: spec.context?.taskId,
        data: { 
          turn: turns, 
          stopReason: response.stopReason,
          usage: response.usage,
        },
        timestamp: new Date(),
      });

      // Track usage
      queryState.lastStopReason = response.stopReason;
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.cacheReadTokens += response.usage.cacheReadTokens;
      usage.cacheWriteTokens += response.usage.cacheWriteTokens;
      if (response.usage.thinkingTokens) {
        usage.thinkingTokens = (usage.thinkingTokens ?? 0) + response.usage.thinkingTokens;
      }

      // Capture thinking content
      if (response.thinkingContent) {
        thinkingContent += (thinkingContent ? "\n\n" : "") + response.thinkingContent;
      }

      const responseContent = spec.sanitizeResponseContent
        ? spec.sanitizeResponseContent(response.content)
        : response.content;

      // Extract tool calls from response for transcript
      const toolCalls = responseContent
        .filter((block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => block.type === "tool_use")
        .map((block) => ({ name: block.name, input: block.input }));

      // Write turn to transcript
      transcript?.writeTurn({
        turn: turns,
        timestamp: new Date().toISOString(),
        messages: [...messages], // Snapshot current messages
        response: { ...response, content: responseContent },
        usage,
        toolCalls,
      });

      // Progress callback
      if (spec.onProgress) {
        for (const block of responseContent) {
          if (block.type === "text") {
            spec.onProgress({ turn: turns, type: "text", text: block.text, usage });
          } else if (block.type === "tool_use") {
            spec.onProgress({ turn: turns, type: "tool_call", toolName: block.name, usage });
          }
        }
      }

      // Add assistant response to history
      messages.push({ role: "assistant", content: responseContent as LLMMessage["content"] });

      // Extract any text output
      for (const block of responseContent) {
        if (block.type === "text" && block.text.trim().length > 0) {
          lastTextOutput = block.text;
        }
      }
      updateWorkingStateFromAssistant(spec, {
        currentCwd,
        lastAssistantText: lastTextOutput,
      });
      queryState.carryForwardState = buildCarryForwardState({
        currentCwd,
        lastAssistantText: lastTextOutput,
        toolCalls,
      }) ?? undefined;

      // Check stop reason
      if (response.stopReason === "end_turn" || response.stopReason === "stop") {
        console.debug(
          `[agent-loop] run=${runId} agent=${spec.agent} turn=${turns} stop=end_turn`,
        );
        stopReason = "end_turn";
        break;
      }

      if (response.stopReason === "max_tokens") {
        // Model hit output token limit mid-response — ask it to continue
        // rather than silently truncating. Give it 2 continuation attempts.
        queryState.continuationCount++;
        queryState.phase = "continuation";
        if (queryState.continuationCount <= 2) {
          console.log(`[agent-loop] max_tokens hit — requesting continuation (attempt ${queryState.continuationCount}/2)`);
          console.debug(
            `[agent-loop] run=${runId} agent=${spec.agent} turn=${turns} continue_after=max_tokens attempt=${queryState.continuationCount}`,
          );
          // The assistant message was already pushed above. If it contains
          // incomplete tool_use blocks (common when max_tokens truncates mid-
          // tool-call), we must provide tool_result stubs before asking the
          // model to continue, otherwise the API rejects the request.
          const pendingToolUses = responseContent.filter(
            (block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
              block.type === "tool_use"
          );
          if (pendingToolUses.length > 0) {
            const toolResults = pendingToolUses.map((tc) => ({
              type: "tool_result" as const,
              tool_use_id: tc.id,
              content: asClaudeSystemReminder(
                "The previous response was truncated by the output token limit. Retry this tool call in full if it is still needed."
              ),
              is_error: true,
            }));
            messages.push({ role: "user", content: toolResults as unknown as LLMMessage["content"] });
            queueQueryReminder(
              queryState,
              asClaudeSystemReminder(
                "The previous response was truncated while producing tool calls. " +
                "Re-issue any still-needed tool call completely and only once."
              ),
            );
          } else {
            queueQueryReminder(queryState, buildContinuationReminder(queryState.continuationCount));
          }
          continue;
        }
        // Exhausted continuation attempts — treat as complete
        console.warn(`[agent-loop] max_tokens hit after ${queryState.continuationCount} continuations — treating as end_turn`);
        stopReason = "end_turn";
        break;
      }

      // If we got tool_use, execute them
      if (response.stopReason === "tool_use") {
        const toolCalls = responseContent.filter(
          (block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
            block.type === "tool_use"
        );

        if (toolCalls.length === 0) {
          stopReason = "end_turn";
          break;
        }

        // Execute tool calls with hooks
        const results = await Promise.all(
          toolCalls.map(async (call) => {
            console.debug(
              `[agent-loop] run=${runId} agent=${spec.agent} turn=${turns} ` +
              `tool_start name=${call.name} id=${call.id}`,
            );
            spec.onPhaseChange?.({ phase: 'executing_tool', turn: turns, toolName: call.name, startedAt: Date.now() });
            await spec.onToolStart?.({
              turn: turns,
              toolName: call.name,
              toolUseId: call.id,
              input: call.input,
              currentCwd,
            });
            // Emit before_tool_call hook
            const beforeToolEvent = await hookRegistry.emit({
              hookName: "before_tool_call",
              agentType: spec.agent,
              taskId: spec.context?.taskId,
              data: { 
                toolName: call.name, 
                params: call.input,
                toolUseId: call.id,
                allowedTools: spec.tools,
                denied: false,
                reason: undefined,
              },
              timestamp: new Date(),
            });
            
            // If hook cancelled the tool call, return denial
            if (!beforeToolEvent) {
              return {
                tool_use_id: call.id,
                type: "tool_result" as const,
                content: "Tool call denied by policy",
                is_error: true,
              };
            }
            
            // If hook modified the event to deny it
            if ((beforeToolEvent.data as Record<string, unknown>).denied) {
              return {
                tool_use_id: call.id,
                type: "tool_result" as const,
                content: String((beforeToolEvent.data as Record<string, unknown>).reason ?? "Tool call denied by policy"),
                is_error: true,
              };
            }
            
            // Execute the tool
            const toolStartedAt = Date.now();
            const { result, sideEffects } = spec.toolExecutor
              ? await spec.toolExecutor(call.name, call.input, call.id, currentCwd, { toolUseId: call.id })
              : await executeTool(call.name, call.input, call.id, currentCwd);
            
            // Apply side effects (e.g. cwd changes from cd/workdir)
            if (sideEffects?.newCwd) {
              currentCwd = sideEffects.newCwd;
              queryState.currentCwd = sideEffects.newCwd;
              console.debug(
                `[agent-loop] run=${runId} agent=${spec.agent} cwd_changed to=${currentCwd}`,
              );
            }
            
            const resultContent = typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content);
            console.debug(
              `[agent-loop] run=${runId} agent=${spec.agent} turn=${turns} ` +
              `tool_done name=${call.name} id=${call.id} error=${Boolean(result.is_error)} ` +
              `result_len=${resultContent.length}`,
            );
            
            // Emit after_tool_call hook
            await spec.onToolResult?.({
              turn: turns,
              toolName: call.name,
              toolUseId: call.id,
              input: call.input,
              result,
              sideEffects,
              durationMs: Date.now() - toolStartedAt,
              currentCwd,
            });
            const afterToolEvent = await hookRegistry.emit({
              hookName: "after_tool_call",
              agentType: spec.agent,
              taskId: spec.context?.taskId,
              data: { 
                toolName: call.name,
                toolUseId: call.id,
                result,
                isError: result.is_error,
              },
              timestamp: new Date(),
            });
            
            // Hook can modify the result
            if (afterToolEvent && (afterToolEvent.data as Record<string, unknown>).result) {
              return (afterToolEvent.data as Record<string, unknown>).result as ToolResult;
            }
            
            return result;
          })
        );

        // Check for tool loops with the new multi-pattern detector
        for (const call of toolCalls) {
          const resultContent = results.find(r => r.tool_use_id === call.id)?.content;
          const outputStr = typeof resultContent === "string" 
            ? resultContent 
            : JSON.stringify(resultContent);
          
          const loopResult = loopDetector.record(call.name, call.input, outputStr);
          
          if (loopResult.detected && loopResult.severity === "critical") {
            // Force-stop on critical loop
            stopReason = "error";
            const errorMsg = loopResult.message || "Critical loop detected";
            
            const durationSeconds = (Date.now() - startTime) / 1000;
            const result: AgentResult = {
              succeeded: false,
              output: lastTextOutput,
              usage,
              costUsd: calculateCost(spec.model, usage),
              durationSeconds,
              turns,
              stopReason,
              error: errorMsg,
              thinkingContent: thinkingContent || undefined,
            };

            // Emit on_error hook
            await hookRegistry.emit({
              hookName: "on_error",
              agentType: spec.agent,
              taskId: spec.context?.taskId,
              data: { error: errorMsg, turns, durationSeconds },
              timestamp: new Date(),
            });

            // Emit after_agent_end hook
            await hookRegistry.emit({
              hookName: "after_agent_end",
              agentType: spec.agent,
              taskId: spec.context?.taskId,
              data: { result, durationSeconds, turns, error: errorMsg },
              timestamp: new Date(),
            });
            
            return result;
          }
          
          if (loopResult.detected && loopResult.severity === "warning") {
            // Queue warning as a reminder so it arrives AFTER the tool_results message.
            // Pushing a user message here would insert it between the assistant's tool_use
            // blocks and the tool_results, breaking the Anthropic API pairing requirement.
            const warningMsg = loopResult.message || "Loop pattern detected";
            queueQueryReminder(queryState, asClaudeSystemReminder(warningMsg));

            // Progress callback for the warning
            if (spec.onProgress) {
              spec.onProgress({ 
                turn: turns, 
                type: "error", 
                text: warningMsg,
                usage 
              });
            }

            break; // Only inject one warning per turn
          }
        }

        // Add tool results to history
        messages.push({
          role: "user",
          content: results as unknown as LLMMessage["content"],
        });
        queueQueryReminder(queryState, buildPostToolReminder(currentCwd, results));
        queryState.phase = "post_tool";
        queryState.continuationCount = 0;
        queryState.carryForwardState = buildCarryForwardState({
          currentCwd,
          lastAssistantText: lastTextOutput,
          toolCalls,
          results,
        }) ?? undefined;
        updateWorkingStateFromTools(spec, {
          currentCwd,
          toolCalls,
          results,
        });
        await spec.onToolRound?.({
          turn: turns,
          assistantContent: responseContent,
          toolCalls,
          results,
          currentCwd,
        });
        console.debug(
          `[agent-loop] run=${runId} agent=${spec.agent} turn=${turns} ` +
          `tool_roundtrip count=${results.length} continuing=true`,
        );

        // Check abort signal after tool execution — don't start next LLM call
        if (spec.abortSignal?.aborted) {
          stopReason = "interrupted";
          break;
        }

        continue;
      }

      // Unknown stop reason — end the loop
      console.debug(
        `[agent-loop] run=${runId} agent=${spec.agent} turn=${turns} ` +
        `stop=unknown(${response.stopReason})`,
      );
      break;
    }

    if (turns >= maxTurns) {
      console.debug(
        `[agent-loop] run=${runId} agent=${spec.agent} reached max_turns=${maxTurns}`,
      );
      stopReason = "max_turns";
    }

    const durationSeconds = (Date.now() - startTime) / 1000;
    const costUsd = calculateCost(spec.model, usage);

    // Write final summary — for interrupted runs this is the resume checkpoint
    transcript?.writeSummary({
      type: "summary",
      runId,
      agentType: spec.agent,
      taskId: spec.context?.taskId,
      succeeded: stopReason === "end_turn",
      totalTurns: turns,
      totalUsage: usage,
      durationSeconds,
      stopReason,
      timestamp: new Date().toISOString(),
    });

    if (stopReason === "interrupted") {
      console.log(
        `[agent-loop] run=${runId} agent=${spec.agent} CHECKPOINT written — ` +
        `turns=${turns} messages=${messages.length} duration_s=${durationSeconds.toFixed(1)} ` +
        `(will resume on next restart if task is re-queued)`
      );
    }

    const result: AgentResult = {
      succeeded: stopReason === "end_turn",
      output: lastTextOutput,
      usage,
      costUsd,
      durationSeconds,
      turns,
      stopReason,
      thinkingContent: thinkingContent || undefined,
    };
    console.debug(
      `[agent-loop] run=${runId} agent=${spec.agent} finished ` +
      `stop=${stopReason} turns=${turns} duration_s=${durationSeconds.toFixed(1)}`,
    );

    // Emit after_agent_end hook
    await hookRegistry.emit({
      hookName: "after_agent_end",
      agentType: spec.agent,
      taskId: spec.context?.taskId,
      data: { result, durationSeconds, turns },
      timestamp: new Date(),
    });

    return result;
  } catch (error) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    const costUsd = calculateCost(spec.model, usage);
    const message = error instanceof Error ? error.message : String(error);
    console.debug(
      `[agent-loop] run=${runId} agent=${spec.agent} errored ` +
      `turns=${turns} duration_s=${durationSeconds.toFixed(1)} error=${message}`,
    );

    // Emit on_error hook
    await hookRegistry.emit({
      hookName: "on_error",
      agentType: spec.agent,
      taskId: spec.context?.taskId,
      data: { error: message, turns, durationSeconds },
      timestamp: new Date(),
    });

    // Write error summary
    transcript?.writeSummary({
      type: "summary",
      runId,
      agentType: spec.agent,
      taskId: spec.context?.taskId,
      succeeded: false,
      totalTurns: turns,
      totalUsage: usage,
      durationSeconds,
      stopReason: "error",
      error: message,
      timestamp: new Date().toISOString(),
    });

    const result: AgentResult = {
      succeeded: false,
      output: lastTextOutput,
      usage,
      costUsd,
      durationSeconds,
      turns,
      stopReason: "error",
      error: message,
      thinkingContent: thinkingContent || undefined,
    };

    // Emit after_agent_end hook (even on error)
    await hookRegistry.emit({
      hookName: "after_agent_end",
      agentType: spec.agent,
      taskId: spec.context?.taskId,
      data: { result, durationSeconds, turns, error: message },
      timestamp: new Date(),
    });

    return result;
  }
}

/**
 * Calculate cost based on model pricing.
 */
export function calculateCost(model: string, usage: TokenUsage): number {
  const costEntry = Object.entries(COSTS).find(([key]) => model.includes(key));
  if (!costEntry) return 0;

  const [, rates] = costEntry;
  const cost =
    (usage.inputTokens * rates.input) / 1_000_000 +
    (usage.outputTokens * rates.output) / 1_000_000 +
    (usage.cacheReadTokens * rates.cacheRead) / 1_000_000 +
    (usage.cacheWriteTokens * rates.cacheWrite) / 1_000_000;

  return Math.round(cost * 1_000_000) / 1_000_000;
}
