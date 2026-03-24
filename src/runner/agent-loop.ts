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
import { MODEL_COSTS as COSTS } from "./types.js";
import { getToolDefinitions, executeTool } from "./tools/index.js";
import { buildSystemPrompt, buildSmartSystemPrompt } from "./prompt-builder.js";
import { parseModelString, createResilientClient, type LLMMessage, type LLMResponse } from "./providers.js";
import { createHash, randomBytes } from "node:crypto";
import { SessionTranscript, type TurnRecord } from "./session-transcript.js";
import { shouldCompact, compactMessages } from "./context-manager.js";
import { getHookRegistry } from "./hooks.js";
import { LoopDetector } from "./loop-detector.js";

export type { AgentSpec, AgentResult };

const DEFAULT_MAX_TURNS = 200;
const DEFAULT_MAX_TOKENS = 16384;

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
  const transcript = new SessionTranscript(spec.agent, runId);

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
    // Use taskId or runId as sessionId for sticky key assignment (prompt caching benefit)
    const sessionId = spec.context?.taskId ?? runId;
    client = createResilientClient(spec.model, {
      sessionId,
      maxRetries: 3,
    });
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
  if (isResume && spec.resumeMessages) {
    messages.push(...spec.resumeMessages);
    resumedTurnCount = Math.floor(spec.resumeMessages.length / 2); // rough estimate
    // Inject a resume notice so the agent knows it was interrupted
    messages.push({
      role: "user",
      content: [{ type: "text", text:
        "[System] Your session was interrupted by a process restart. " +
        "Your full conversation history has been restored. " +
        "Continue where you left off — orient fast (check state if needed) then keep working. " +
        "Do NOT restart the task from scratch."
      }],
    });
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
  let continuationCount = 0;
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
      console.debug(
        `[agent-loop] run=${runId} agent=${spec.agent} turn=${turns} ` +
        `messages=${messages.length} input_tokens=${usage.inputTokens} output_tokens=${usage.outputTokens}`,
      );

      // Check if we need to compact context
      if (shouldCompact(usage.inputTokens, spec.model)) {
        const beforeCount = messages.length;
        messages.splice(0, messages.length, ...compactMessages(messages));
        const afterCount = messages.length;

        if (beforeCount !== afterCount) {
          console.log(
            `[Context compaction] Reduced messages from ${beforeCount} to ${afterCount} (${usage.inputTokens.toLocaleString()} input tokens)`
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

      // Emit before_llm_call hook
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
        response = await client.createMessage({
          model: providerConfig.modelId,
          system: systemPrompt,
          messages,
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

      // Extract tool calls from response for transcript
      const toolCalls = response.content
        .filter((block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => block.type === "tool_use")
        .map((block) => ({ name: block.name, input: block.input }));

      // Write turn to transcript
      transcript.writeTurn({
        turn: turns,
        timestamp: new Date().toISOString(),
        messages: [...messages], // Snapshot current messages
        response,
        usage,
        toolCalls,
      });

      // Progress callback
      if (spec.onProgress) {
        for (const block of response.content) {
          if (block.type === "text") {
            spec.onProgress({ turn: turns, type: "text", text: block.text, usage });
          } else if (block.type === "tool_use") {
            spec.onProgress({ turn: turns, type: "tool_call", toolName: block.name, usage });
          }
        }
      }

      // Add assistant response to history
      messages.push({ role: "assistant", content: response.content as LLMMessage["content"] });

      // Extract any text output
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          lastTextOutput = block.text;
        }
      }

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
        continuationCount++;
        if (continuationCount <= 2) {
          console.log(`[agent-loop] max_tokens hit — requesting continuation (attempt ${continuationCount}/2)`);
          console.debug(
            `[agent-loop] run=${runId} agent=${spec.agent} turn=${turns} continue_after=max_tokens attempt=${continuationCount}`,
          );
          messages.push({ role: "assistant", content: response.content as LLMMessage["content"] });
          messages.push({ role: "user", content: [{ type: "text", text: "Continue from where you left off." }] });
          continue;
        }
        // Exhausted continuation attempts — treat as complete
        console.warn(`[agent-loop] max_tokens hit after ${continuationCount} continuations — treating as end_turn`);
        stopReason = "end_turn";
        break;
      }

      // If we got tool_use, execute them
      if (response.stopReason === "tool_use") {
        const toolCalls = response.content.filter(
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
            const { result, sideEffects } = await executeTool(call.name, call.input, call.id, currentCwd);
            
            // Apply side effects (e.g. cwd changes from cd/workdir)
            if (sideEffects?.newCwd) {
              currentCwd = sideEffects.newCwd;
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
            // Inject warning into context
            const warningMsg = loopResult.message || "Loop pattern detected";
            
            messages.push({
              role: "user",
              content: [{ type: "text", text: warningMsg }],
            });

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
    transcript.writeSummary({
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
    transcript.writeSummary({
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
function calculateCost(model: string, usage: TokenUsage): number {
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
