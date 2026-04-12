/**
 * demo-traces.ts — seed the database with realistic agent execution traces
 * for the HN demo.
 *
 * Run via:
 *   node dist/tracer/demo-traces.js
 *
 * Generates a complete agent execution trace showing:
 * - Multi-turn LLM conversation
 * - Tool calls (web search, memory operations)
 * - Error recovery
 * - Final summary and conclusions
 */

import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { getRawDb } from "../db/connection.js";
import {
  createAgentTrace,
  insertSpan,
  updateSpan,
  updateAgentTrace,
  newSpanId,
  newTraceId,
} from "./trace-store.js";

interface DemoTraceConfig {
  taskId?: string;
  agentType?: string;
  turns?: number;
  withErrors?: boolean;
}

export async function seedDemoTraces(db: Database.Database, config: DemoTraceConfig = {}): Promise<void> {
  const {
    taskId = "demo-task-2025-04",
    agentType = "research-agent",
    turns = 3,
    withErrors = true,
  } = config;

  console.log(`[demo-traces] Seeding realistic ${agentType} execution trace...`);

  const traceId = newTraceId();
  const rootSpanId = newSpanId();
  const runId = taskId;
  const startTime = Date.now() - 45000; // Started 45 seconds ago
  let currentTime = startTime;

  // Create agent trace
  createAgentTrace(db, {
    traceId,
    runId,
    agentType,
    taskId,
    taskSummary: "Research: What are the latest advances in AI agents in 2025?",
    model: "claude-3.5-sonnet",
  });

  // Root span (agent execution)
  insertSpan(db, {
    spanId: rootSpanId,
    traceId,
    parentSpanId: null,
    name: `agent:${agentType}`,
    kind: "agent",
    startTimeMs: startTime,
    endTimeMs: null,
    durationMs: null,
    status: "running",
    attributes: {
      "agent.type": agentType,
      "task.id": taskId,
      "task.summary": "Research agent discovering latest AI advances",
    },
    events: [{ timeMs: startTime, name: "agent_start" }],
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;

  // Simulate 3 LLM turns with tool calls
  for (let turnNum = 1; turnNum <= turns; turnNum++) {
    currentTime += 2000; // 2 second delay before each turn

    // LLM span
    const llmSpanId = newSpanId();
    const llmStartTime = currentTime;
    const messageCount = turnNum === 1 ? 1 : 3 + turnNum * 2;
    const inputTokens = 800 + turnNum * 200;
    const outputTokens = 500 + turnNum * 150;

    insertSpan(db, {
      spanId: llmSpanId,
      traceId,
      parentSpanId: rootSpanId,
      name: `llm:turn_${turnNum}`,
      kind: "llm",
      startTimeMs: llmStartTime,
      endTimeMs: null,
      durationMs: null,
      status: "running",
      attributes: {
        "llm.turn": turnNum,
        "llm.model": "claude-3.5-sonnet",
        "llm.message_count": messageCount,
        "llm.system_prompt_tokens": 500,
      },
      events: [],
    });

    currentTime += 8000 + turnNum * 1000; // LLM takes 8-11 seconds
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;

    updateSpan(db, llmSpanId, {
      endTimeMs: currentTime,
      durationMs: currentTime - llmStartTime,
      status: "ok",
      attributes: {
        "llm.stop_reason": "end_turn",
        "llm.input_tokens": inputTokens,
        "llm.output_tokens": outputTokens,
        "llm.cache_read_tokens": Math.floor(inputTokens * 0.2),
      },
      events: [],
    });

    // Tool calls after LLM
    const toolsForTurn = turnNum === 1 ? 1 : turnNum === 2 ? 2 : 1;
    for (let toolNum = 0; toolNum < toolsForTurn; toolNum++) {
      currentTime += 500; // 500ms between tool calls
      toolCallCount++;

      const toolNames = ["web_search", "memory_read", "memory_write", "web_fetch"];
      const toolName = toolNames[(turnNum + toolNum) % toolNames.length];
      const toolSpanId = newSpanId();
      const toolStartTime = currentTime;

      // Simulate tool execution
      const toolDuration = toolName === "web_search" ? 3000 : toolName === "web_fetch" ? 4000 : 500;
      const isError = withErrors && turnNum === 2 && toolNum === 0;

      insertSpan(db, {
        spanId: toolSpanId,
        traceId,
        parentSpanId: llmSpanId,
        name: `tool:${toolName}`,
        kind: "tool",
        startTimeMs: toolStartTime,
        endTimeMs: null,
        durationMs: null,
        status: "running",
        attributes: {
          "tool.name": toolName,
          "tool.use_id": `use_${randomBytes(12).toString("hex")}`,
          "tool.params": {
            query: "AI agent advances 2025",
            max_results: 10,
          },
        },
        events: [],
      });

      currentTime += toolDuration;

      updateSpan(db, toolSpanId, {
        endTimeMs: currentTime,
        durationMs: toolDuration,
        status: isError ? "error" : "ok",
        attributes: {
          "tool.name": toolName,
          "tool.is_error": isError,
          "tool.result_preview": isError
            ? "Network timeout retrieving search results"
            : `Successfully retrieved ${4 + toolNum} relevant sources`,
          "tool.result_length": isError ? 0 : 2500 + toolNum * 500,
        },
        events: isError
          ? [
              {
                timeMs: toolStartTime + toolDuration - 500,
                name: "tool_error",
                attributes: { error: "timeout" },
              },
            ]
          : [],
      });

      // Simulate recovery turn after error
      if (isError && turnNum === 2) {
        currentTime += 1000;
        const recoverySpanId = newSpanId();
        const recoveryStartTime = currentTime;

        insertSpan(db, {
          spanId: recoverySpanId,
          traceId,
          parentSpanId: rootSpanId,
          name: "recovery:after_error",
          kind: "agent",
          startTimeMs: recoveryStartTime,
          endTimeMs: null,
          durationMs: null,
          status: "running",
          attributes: {
            "recovery.reason": "tool_timeout",
            "recovery.retry_count": 1,
          },
          events: [],
        });

        currentTime += 2000;
        updateSpan(db, recoverySpanId, {
          endTimeMs: currentTime,
          durationMs: currentTime - recoveryStartTime,
          status: "ok",
          attributes: {
            "recovery.successful": true,
          },
          events: [{ timeMs: currentTime - 500, name: "retry_succeeded" }],
        });
      }
    }
  }

  // Final summary
  const endTime = currentTime + 1000;

  updateSpan(db, rootSpanId, {
    endTimeMs: endTime,
    durationMs: endTime - startTime,
    status: "ok",
    attributes: {
      "agent.type": agentType,
      "agent.turns": turns,
      "agent.tool_calls": toolCallCount,
      "agent.stop_reason": "completed",
      "agent.input_tokens": totalInputTokens,
      "agent.output_tokens": totalOutputTokens,
    },
    events: [
      { timeMs: endTime - 500, name: "agent_end", attributes: { reason: "completed" } },
    ],
  });

  updateAgentTrace(db, traceId, {
    status: "completed",
    endTimeMs: endTime,
    durationMs: endTime - startTime,
    totalTurns: turns,
    totalToolCalls: toolCallCount,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    costUsd: (totalInputTokens * 0.003 + totalOutputTokens * 0.015) / 1000,
    stopReason: "completed",
    spanCount: turns + toolCallCount + 2, // +2 for root and recovery spans
  });

  console.log(
    `[demo-traces] ✅ Created demo trace:`,
    { traceId, taskId, turns, toolCalls: toolCallCount, durationMs: endTime - startTime }
  );
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = getRawDb();
  seedDemoTraces(db, {
    taskId: "demo-research-2025-04",
    agentType: "research-agent",
    turns: 3,
    withErrors: true,
  })
    .then(() => {
      console.log("[demo-traces] Done!");
      process.exit(0);
    })
    .catch(err => {
      console.error("[demo-traces] Error:", err);
      process.exit(1);
    });
}
