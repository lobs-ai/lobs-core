/**
 * demo-traces.ts — seed the database with realistic agent execution traces
 * for the HN demo.
 *
 * Generates a set of 4 realistic agent runs that showcase the replay debugger:
 * 1. goals-worker — long run with many tool calls, memory reads
 * 2. programmer — multi-turn code edit/test cycle
 * 3. daily-brief — short informational run
 * 4. research-agent — run that times out mid-way (shows failure handling)
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeToolUseId(): string {
  return `toolu_${randomBytes(12).toString("hex")}`;
}

function makeTimeline(baseMs: number, durationMs: number, steps: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < steps; i++) {
    times.push(baseMs + Math.floor((durationMs / steps) * i));
  }
  return times;
}

// ── Trace builders ────────────────────────────────────────────────────────────

/**
 * goals-worker: typical 8-turn run that processes 3 tasks and writes memory
 */
async function seedGoalsWorker(db: Database.Database, baseMs: number): Promise<void> {
  const taskId = "task_goals_worker_demo";
  const agentType = "goals-worker";
  const traceId = newTraceId();
  const rootSpanId = newSpanId();
  let t = baseMs;

  createAgentTrace(db, {
    traceId, runId: taskId, agentType, taskId,
    taskSummary: "Goals worker: process pending tasks, create subtasks, update goal progress",
    model: "anthropic/claude-sonnet-4-5",
  });

  insertSpan(db, {
    spanId: rootSpanId, traceId, parentSpanId: null,
    name: `agent:${agentType}`, kind: "agent",
    startTimeMs: t, endTimeMs: null, durationMs: null, status: "running",
    attributes: { "agent.type": agentType, "task.id": taskId },
    events: [{ timeMs: t, name: "agent_start" }],
  });

  let totalIn = 0, totalOut = 0, totalTools = 0;

  // Turn 1: read memory + list tasks
  {
    const llmId = newSpanId(); const ls = t; t += 9200;
    const iTokens = 1240, oTokens = 620;
    insertSpan(db, { spanId: llmId, traceId, parentSpanId: rootSpanId, name: "llm:turn_1", kind: "llm", startTimeMs: ls, endTimeMs: null, durationMs: null, status: "running", attributes: { "llm.turn": 1, "llm.model": "claude-sonnet-4-5", "llm.message_count": 3 }, events: [] });
    updateSpan(db, llmId, { endTimeMs: t, durationMs: t - ls, status: "ok", attributes: { "llm.stop_reason": "tool_use", "llm.input_tokens": iTokens, "llm.output_tokens": oTokens, "llm.cache_read_tokens": 440 }, events: [] });
    totalIn += iTokens; totalOut += oTokens;

    // memory_search
    const tId1 = newSpanId(); const ts1 = t; t += 380;
    insertSpan(db, { spanId: tId1, traceId, parentSpanId: llmId, name: "tool:memory_search", kind: "tool", startTimeMs: ts1, endTimeMs: null, durationMs: null, status: "running", attributes: { "tool.name": "memory_search", "tool.use_id": fakeToolUseId(), "tool.params": { query: "recent goal progress and blockers" } }, events: [] });
    updateSpan(db, tId1, { endTimeMs: t, durationMs: t - ts1, status: "ok", attributes: { "tool.name": "memory_search", "tool.result_preview": "Found 4 relevant memories: goal progress, task backlog, last sprint notes", "tool.result_length": 1840 }, events: [] });
    totalTools++;

    // lobs-tasks
    const tId2 = newSpanId(); const ts2 = t; t += 220;
    insertSpan(db, { spanId: tId2, traceId, parentSpanId: llmId, name: "tool:lobs-tasks", kind: "tool", startTimeMs: ts2, endTimeMs: null, durationMs: null, status: "running", attributes: { "tool.name": "lobs-tasks", "tool.use_id": fakeToolUseId(), "tool.params": { subcommand: "list" } }, events: [] });
    updateSpan(db, tId2, { endTimeMs: t, durationMs: t - ts2, status: "ok", attributes: { "tool.name": "lobs-tasks", "tool.result_preview": "5 active tasks, 3 waiting, 12 completed today", "tool.result_length": 680 }, events: [] });
    totalTools++;
  }

  // Turn 2: analyze + spawn subtask
  {
    const llmId = newSpanId(); const ls = t + 400; t = ls + 11800;
    const iTokens = 2450, oTokens = 980;
    insertSpan(db, { spanId: llmId, traceId, parentSpanId: rootSpanId, name: "llm:turn_2", kind: "llm", startTimeMs: ls, endTimeMs: null, durationMs: null, status: "running", attributes: { "llm.turn": 2, "llm.model": "claude-sonnet-4-5", "llm.message_count": 7 }, events: [] });
    updateSpan(db, llmId, { endTimeMs: t, durationMs: t - ls, status: "ok", attributes: { "llm.stop_reason": "tool_use", "llm.input_tokens": iTokens, "llm.output_tokens": oTokens, "llm.cache_read_tokens": 890 }, events: [] });
    totalIn += iTokens; totalOut += oTokens;

    // task_create
    const tId = newSpanId(); const ts = t; t += 310;
    insertSpan(db, { spanId: tId, traceId, parentSpanId: llmId, name: "tool:task_create", kind: "tool", startTimeMs: ts, endTimeMs: null, durationMs: null, status: "running", attributes: { "tool.name": "task_create", "tool.use_id": fakeToolUseId(), "tool.params": { title: "Implement agent replay debugger HN demo", goal_id: "8f994079" } }, events: [] });
    updateSpan(db, tId, { endTimeMs: t, durationMs: t - ts, status: "ok", attributes: { "tool.name": "task_create", "tool.result_preview": "Created task task_replay_demo with id task_0a3f2c", "tool.result_length": 240 }, events: [] });
    totalTools++;
  }

  // Turn 3: memory write
  {
    const llmId = newSpanId(); const ls = t + 600; t = ls + 8400;
    const iTokens = 3100, oTokens = 540;
    insertSpan(db, { spanId: llmId, traceId, parentSpanId: rootSpanId, name: "llm:turn_3", kind: "llm", startTimeMs: ls, endTimeMs: null, durationMs: null, status: "running", attributes: { "llm.turn": 3, "llm.model": "claude-sonnet-4-5", "llm.message_count": 11 }, events: [] });
    updateSpan(db, llmId, { endTimeMs: t, durationMs: t - ls, status: "ok", attributes: { "llm.stop_reason": "tool_use", "llm.input_tokens": iTokens, "llm.output_tokens": oTokens, "llm.cache_read_tokens": 1200 }, events: [] });
    totalIn += iTokens; totalOut += oTokens;

    // memory_write
    const tId = newSpanId(); const ts = t; t += 180;
    insertSpan(db, { spanId: tId, traceId, parentSpanId: llmId, name: "tool:memory_write", kind: "tool", startTimeMs: ts, endTimeMs: null, durationMs: null, status: "running", attributes: { "tool.name": "memory_write", "tool.use_id": fakeToolUseId(), "tool.params": { category: "decision", content: "Replay debugger is the highest-priority OSS deliverable for Q2" } }, events: [] });
    updateSpan(db, tId, { endTimeMs: t, durationMs: t - ts, status: "ok", attributes: { "tool.name": "memory_write", "tool.result_preview": "Memory written to 2026-04-12.md", "tool.result_length": 48 }, events: [] });
    totalTools++;
  }

  // Turn 4: final summary (end_turn)
  {
    const llmId = newSpanId(); const ls = t + 300; t = ls + 7200;
    const iTokens = 3600, oTokens = 820;
    insertSpan(db, { spanId: llmId, traceId, parentSpanId: rootSpanId, name: "llm:turn_4", kind: "llm", startTimeMs: ls, endTimeMs: null, durationMs: null, status: "running", attributes: { "llm.turn": 4, "llm.model": "claude-sonnet-4-5", "llm.message_count": 15 }, events: [] });
    updateSpan(db, llmId, { endTimeMs: t, durationMs: t - ls, status: "ok", attributes: { "llm.stop_reason": "end_turn", "llm.input_tokens": iTokens, "llm.output_tokens": oTokens, "llm.cache_read_tokens": 1540 }, events: [] });
    totalIn += iTokens; totalOut += oTokens;
  }

  const endTime = t + 800;
  updateSpan(db, rootSpanId, { endTimeMs: endTime, durationMs: endTime - baseMs, status: "ok", attributes: { "agent.type": agentType, "agent.turns": 4, "agent.tool_calls": totalTools, "agent.stop_reason": "end_turn" }, events: [{ timeMs: endTime - 200, name: "agent_end", attributes: { reason: "end_turn" } }] });
  updateAgentTrace(db, traceId, { status: "completed", endTimeMs: endTime, durationMs: endTime - baseMs, totalTurns: 4, totalToolCalls: totalTools, inputTokens: totalIn, outputTokens: totalOut, costUsd: (totalIn * 3 + totalOut * 15) / 1_000_000, stopReason: "end_turn", spanCount: 4 + totalTools + 1 });
  console.log(`[demo-traces] ✅ goals-worker trace ${traceId}`);
}

/**
 * programmer: 6-turn coding session — read files, edit, build, fix type errors
 */
async function seedProgrammerAgent(db: Database.Database, baseMs: number): Promise<void> {
  const taskId = "task_programmer_fix_tracer";
  const agentType = "programmer";
  const traceId = newTraceId();
  const rootSpanId = newSpanId();
  let t = baseMs;

  createAgentTrace(db, {
    traceId, runId: taskId, agentType, taskId,
    taskSummary: "Fix tracer-hook.ts: db._client → $client, add API prefix bug fix",
    model: "anthropic/claude-sonnet-4-6",
  });

  insertSpan(db, {
    spanId: rootSpanId, traceId, parentSpanId: null,
    name: `agent:${agentType}`, kind: "agent",
    startTimeMs: t, endTimeMs: null, durationMs: null, status: "running",
    attributes: { "agent.type": agentType, "task.id": taskId },
    events: [{ timeMs: t, name: "agent_start" }],
  });

  let totalIn = 0, totalOut = 0, totalTools = 0;

  const turns = [
    { tools: [{ name: "Read", params: { file_path: "src/tracer/trace-store.ts" }, ms: 60, result: "Read 280 lines — found PawDB._client usage throughout" }], iT: 880, oT: 440, stop: "tool_use" },
    { tools: [{ name: "Read", params: { file_path: "src/hooks/tracer-hook.ts" }, ms: 50, result: "Read 376 lines — function signatures use PawDB type" }, { name: "Bash", params: { cmd: "node -e \"const {drizzle}=require('drizzle-orm/better-sqlite3')...\"" }, ms: 820, result: "keys: [], $client: exists, same ref: true" }], iT: 1640, oT: 680, stop: "tool_use" },
    { tools: [{ name: "Write", params: { file_path: "src/tracer/trace-store.ts", content: "<full refactored file>" }, ms: 90, result: "File written (294 lines)" }, { name: "Edit", params: { file_path: "src/hooks/tracer-hook.ts", old_string: "import type { PawDB }", new_string: "import type Database from 'better-sqlite3'" }, ms: 40, result: "Edit applied" }], iT: 2800, oT: 820, stop: "tool_use" },
    { tools: [{ name: "Edit", params: { file_path: "src/api/router.ts", old_string: "getDb()", new_string: "getRawDb()" }, ms: 35, result: "Edit applied" }, { name: "Bash", params: { cmd: "npm run typecheck 2>&1 | grep error" }, ms: 4200, result: "No tracer errors. 2 pre-existing errors in discord-commands.ts" }], iT: 3400, oT: 560, stop: "tool_use" },
    { tools: [{ name: "Bash", params: { cmd: "npm run build 2>&1 | tail -5" }, ms: 12400, result: "✓ Build succeeded" }], iT: 3800, oT: 340, stop: "tool_use" },
    { tools: [], iT: 4100, oT: 660, stop: "end_turn" },
  ];

  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti];
    const llmId = newSpanId(); const ls = t + (ti === 0 ? 0 : 600); t = ls + 6000 + ti * 800;
    insertSpan(db, { spanId: llmId, traceId, parentSpanId: rootSpanId, name: `llm:turn_${ti + 1}`, kind: "llm", startTimeMs: ls, endTimeMs: null, durationMs: null, status: "running", attributes: { "llm.turn": ti + 1, "llm.model": "claude-sonnet-4-6", "llm.message_count": 3 + ti * 4 }, events: [] });
    updateSpan(db, llmId, { endTimeMs: t, durationMs: t - ls, status: "ok", attributes: { "llm.stop_reason": turn.stop, "llm.input_tokens": turn.iT, "llm.output_tokens": turn.oT, "llm.cache_read_tokens": Math.floor(turn.iT * 0.35) }, events: [] });
    totalIn += turn.iT; totalOut += turn.oT;

    for (const tool of turn.tools) {
      const tId = newSpanId(); const ts = t; t += tool.ms;
      insertSpan(db, { spanId: tId, traceId, parentSpanId: llmId, name: `tool:${tool.name}`, kind: "tool", startTimeMs: ts, endTimeMs: null, durationMs: null, status: "running", attributes: { "tool.name": tool.name, "tool.use_id": fakeToolUseId(), "tool.params": tool.params }, events: [] });
      updateSpan(db, tId, { endTimeMs: t, durationMs: tool.ms, status: "ok", attributes: { "tool.name": tool.name, "tool.result_preview": tool.result, "tool.result_length": tool.result.length * 8 }, events: [] });
      totalTools++;
    }
  }

  // commit step
  {
    const llmId = newSpanId(); const ls = t + 400; t = ls + 5800;
    const commitId = newSpanId(); const cs = t; t += 1200;
    insertSpan(db, { spanId: llmId, traceId, parentSpanId: rootSpanId, name: "llm:turn_7", kind: "llm", startTimeMs: ls, endTimeMs: null, durationMs: null, status: "running", attributes: { "llm.turn": 7, "llm.model": "claude-sonnet-4-6", "llm.message_count": 27 }, events: [] });
    updateSpan(db, llmId, { endTimeMs: t, durationMs: t - ls, status: "ok", attributes: { "llm.stop_reason": "tool_use", "llm.input_tokens": 4200, "llm.output_tokens": 380, "llm.cache_read_tokens": 1520 }, events: [] });
    totalIn += 4200; totalOut += 380;
    insertSpan(db, { spanId: commitId, traceId, parentSpanId: llmId, name: "tool:Bash", kind: "tool", startTimeMs: cs, endTimeMs: null, durationMs: null, status: "running", attributes: { "tool.name": "Bash", "tool.use_id": fakeToolUseId(), "tool.params": { cmd: "git add -A && git commit -m 'fix(tracer): use Database.Database directly instead of PawDB._client'" } }, events: [] });
    updateSpan(db, commitId, { endTimeMs: t, durationMs: 1200, status: "ok", attributes: { "tool.name": "Bash", "tool.result_preview": "[main a3f2c19] fix(tracer): use Database.Database directly instead of PawDB._client\n 4 files changed, 148 insertions(+), 89 deletions(-)", "tool.result_length": 280 }, events: [] });
    totalTools++;
  }

  const endTime = t + 600;
  updateSpan(db, rootSpanId, { endTimeMs: endTime, durationMs: endTime - baseMs, status: "ok", attributes: { "agent.type": agentType, "agent.turns": 7, "agent.tool_calls": totalTools }, events: [{ timeMs: endTime - 200, name: "agent_end", attributes: { reason: "end_turn" } }] });
  updateAgentTrace(db, traceId, { status: "completed", endTimeMs: endTime, durationMs: endTime - baseMs, totalTurns: 7, totalToolCalls: totalTools, inputTokens: totalIn, outputTokens: totalOut, costUsd: (totalIn * 3 + totalOut * 15) / 1_000_000, stopReason: "end_turn", spanCount: 7 + totalTools + 1 });
  console.log(`[demo-traces] ✅ programmer trace ${traceId}`);
}

/**
 * daily-brief: short 2-turn run, just reads and posts
 */
async function seedDailyBrief(db: Database.Database, baseMs: number): Promise<void> {
  const taskId = "task_daily_brief_morning";
  const agentType = "daily-brief";
  const traceId = newTraceId();
  const rootSpanId = newSpanId();
  let t = baseMs;

  createAgentTrace(db, {
    traceId, runId: taskId, agentType, taskId,
    taskSummary: "Morning brief: GitHub commits, task summary, weather, calendar",
    model: "anthropic/claude-haiku-3-5",
  });

  insertSpan(db, {
    spanId: rootSpanId, traceId, parentSpanId: null,
    name: `agent:${agentType}`, kind: "agent",
    startTimeMs: t, endTimeMs: null, durationMs: null, status: "running",
    attributes: { "agent.type": agentType, "task.id": taskId },
    events: [{ timeMs: t, name: "agent_start" }],
  });

  // Turn 1: fetch data
  const llm1 = newSpanId(); const l1s = t; t += 4800;
  insertSpan(db, { spanId: llm1, traceId, parentSpanId: rootSpanId, name: "llm:turn_1", kind: "llm", startTimeMs: l1s, endTimeMs: null, durationMs: null, status: "running", attributes: { "llm.turn": 1, "llm.model": "claude-haiku-3-5", "llm.message_count": 2 }, events: [] });
  updateSpan(db, llm1, { endTimeMs: t, durationMs: t - l1s, status: "ok", attributes: { "llm.stop_reason": "tool_use", "llm.input_tokens": 620, "llm.output_tokens": 280, "llm.cache_read_tokens": 0 }, events: [] });

  const githubTool = newSpanId(); const gts = t; t += 1200;
  insertSpan(db, { spanId: githubTool, traceId, parentSpanId: llm1, name: "tool:Bash", kind: "tool", startTimeMs: gts, endTimeMs: null, durationMs: null, status: "running", attributes: { "tool.name": "Bash", "tool.use_id": fakeToolUseId(), "tool.params": { cmd: "gh api /repos/lobs-ai/lobs-core/commits --jq '.[:5]'" } }, events: [] });
  updateSpan(db, githubTool, { endTimeMs: t, durationMs: 1200, status: "ok", attributes: { "tool.name": "Bash", "tool.result_preview": "5 recent commits: fix(tracer), feat(daily-brief), feat(tracer), fix(tests), fix(discord)", "tool.result_length": 1840 }, events: [] });

  const tasksTool = newSpanId(); const tts = t; t += 180;
  insertSpan(db, { spanId: tasksTool, traceId, parentSpanId: llm1, name: "tool:lobs-tasks", kind: "tool", startTimeMs: tts, endTimeMs: null, durationMs: null, status: "running", attributes: { "tool.name": "lobs-tasks", "tool.use_id": fakeToolUseId(), "tool.params": { subcommand: "list" } }, events: [] });
  updateSpan(db, tasksTool, { endTimeMs: t, durationMs: 180, status: "ok", attributes: { "tool.name": "lobs-tasks", "tool.result_preview": "5 active tasks, 9 completed today", "tool.result_length": 420 }, events: [] });

  // Turn 2: post to discord
  const llm2 = newSpanId(); const l2s = t + 300; t = l2s + 5600;
  insertSpan(db, { spanId: llm2, traceId, parentSpanId: rootSpanId, name: "llm:turn_2", kind: "llm", startTimeMs: l2s, endTimeMs: null, durationMs: null, status: "running", attributes: { "llm.turn": 2, "llm.model": "claude-haiku-3-5", "llm.message_count": 8 }, events: [] });
  updateSpan(db, llm2, { endTimeMs: t, durationMs: t - l2s, status: "ok", attributes: { "llm.stop_reason": "tool_use", "llm.input_tokens": 1840, "llm.output_tokens": 620, "llm.cache_read_tokens": 440 }, events: [] });

  const discordTool = newSpanId(); const dts = t; t += 320;
  insertSpan(db, { spanId: discordTool, traceId, parentSpanId: llm2, name: "tool:discord-post", kind: "tool", startTimeMs: dts, endTimeMs: null, durationMs: null, status: "running", attributes: { "tool.name": "discord-post", "tool.use_id": fakeToolUseId(), "tool.params": { channel_id: "1466918907002323174", content: "**Morning Brief — Apr 12**\n\n..." } }, events: [] });
  updateSpan(db, discordTool, { endTimeMs: t, durationMs: 320, status: "ok", attributes: { "tool.name": "discord-post", "tool.result_preview": "Message posted (id: 1492810234567890123)", "tool.result_length": 80 }, events: [] });

  const endTime = t + 400;
  updateSpan(db, rootSpanId, { endTimeMs: endTime, durationMs: endTime - baseMs, status: "ok", attributes: { "agent.type": agentType, "agent.turns": 2, "agent.tool_calls": 3 }, events: [{ timeMs: endTime - 100, name: "agent_end", attributes: { reason: "end_turn" } }] });
  updateAgentTrace(db, traceId, { status: "completed", endTimeMs: endTime, durationMs: endTime - baseMs, totalTurns: 2, totalToolCalls: 3, inputTokens: 620 + 1840, outputTokens: 280 + 620, costUsd: 0.0002, stopReason: "end_turn", spanCount: 2 + 3 + 1 });
  console.log(`[demo-traces] ✅ daily-brief trace ${traceId}`);
}

/**
 * research-agent: times out on turn 5 after expensive web fetches
 */
async function seedTimedOutAgent(db: Database.Database, baseMs: number): Promise<void> {
  const taskId = "task_research_hn_post";
  const agentType = "research-agent";
  const traceId = newTraceId();
  const rootSpanId = newSpanId();
  let t = baseMs;

  createAgentTrace(db, {
    traceId, runId: taskId, agentType, taskId,
    taskSummary: "Write HN Show post for Agent Replay Debugger launch",
    model: "anthropic/claude-sonnet-4-5",
  });

  insertSpan(db, {
    spanId: rootSpanId, traceId, parentSpanId: null,
    name: `agent:${agentType}`, kind: "agent",
    startTimeMs: t, endTimeMs: null, durationMs: null, status: "running",
    attributes: { "agent.type": agentType, "task.id": taskId },
    events: [{ timeMs: t, name: "agent_start" }],
  });

  let totalIn = 0, totalOut = 0;

  // Turns 1-4: web searches, fetches
  const turnDefs = [
    { tools: [{ name: "web_search", ms: 2100, result: "10 results for 'AI agent observability tools 2025'" }, { name: "web_fetch", ms: 3800, result: "Fetched honeycomb.io/blog: 4200 chars" }], iT: 980, oT: 560, stop: "tool_use" },
    { tools: [{ name: "web_search", ms: 1900, result: "8 results for 'LLM trace replay debugger open source'" }, { name: "web_fetch", ms: 4200, result: "Fetched langsmith.dev: 5100 chars" }], iT: 2200, oT: 740, stop: "tool_use" },
    { tools: [{ name: "web_fetch", ms: 38400, result: "Fetched arXiv paper on agent observability: 18k chars — WARNING: slow" }], iT: 3800, oT: 420, stop: "tool_use" },  // slow
    { tools: [{ name: "memory_search", ms: 320, result: "Found 3 prior memories about HN posts" }], iT: 5100, oT: 890, stop: "tool_use" },
  ];

  for (let ti = 0; ti < turnDefs.length; ti++) {
    const turn = turnDefs[ti];
    const llmId = newSpanId(); const ls = t + 600; t = ls + 7200 + ti * 1200;
    insertSpan(db, { spanId: llmId, traceId, parentSpanId: rootSpanId, name: `llm:turn_${ti + 1}`, kind: "llm", startTimeMs: ls, endTimeMs: null, durationMs: null, status: "running", attributes: { "llm.turn": ti + 1, "llm.model": "claude-sonnet-4-5", "llm.message_count": 3 + ti * 6 }, events: [] });
    updateSpan(db, llmId, { endTimeMs: t, durationMs: t - ls, status: "ok", attributes: { "llm.stop_reason": turn.stop, "llm.input_tokens": turn.iT, "llm.output_tokens": turn.oT, "llm.cache_read_tokens": Math.floor(turn.iT * 0.3) }, events: [] });
    totalIn += turn.iT; totalOut += turn.oT;

    for (const tool of turn.tools) {
      const tId = newSpanId(); const ts = t; t += tool.ms;
      const isSlowFetch = tool.ms > 10000;
      insertSpan(db, { spanId: tId, traceId, parentSpanId: llmId, name: `tool:${tool.name}`, kind: "tool", startTimeMs: ts, endTimeMs: null, durationMs: null, status: "running", attributes: { "tool.name": tool.name, "tool.use_id": fakeToolUseId() }, events: [] });
      updateSpan(db, tId, { endTimeMs: t, durationMs: tool.ms, status: "ok", attributes: { "tool.name": tool.name, "tool.result_preview": tool.result, "tool.result_length": parseInt(tool.result.match(/(\d+)k? chars/)?.[1] ?? "500") * (tool.result.includes("k") ? 1000 : 1) }, events: isSlowFetch ? [{ timeMs: ts + 5000, name: "slow_fetch_warning", attributes: { elapsed_ms: 5000 } }] : [] });
    }
  }

  // Turn 5: LLM call gets cut off by timeout
  const timeoutLlmId = newSpanId(); const tls = t + 600; t = tls + 180000; // 3 min timeout
  insertSpan(db, { spanId: timeoutLlmId, traceId, parentSpanId: rootSpanId, name: "llm:turn_5", kind: "llm", startTimeMs: tls, endTimeMs: null, durationMs: null, status: "running", attributes: { "llm.turn": 5, "llm.model": "claude-sonnet-4-5", "llm.message_count": 27 }, events: [] });
  // Timeout fires — span ended with error
  updateSpan(db, timeoutLlmId, { endTimeMs: tls + 180000, durationMs: 180000, status: "error", attributes: { "llm.error": "LLM turn timeout after 180s", "llm.input_tokens": 0, "llm.output_tokens": 0 }, events: [{ timeMs: tls + 180000, name: "timeout", attributes: { timeout_ms: 180000 } }] });

  // Error span
  const errSpanId = newSpanId();
  insertSpan(db, { spanId: errSpanId, traceId, parentSpanId: rootSpanId, name: "error:timeout", kind: "error", startTimeMs: tls + 180000, endTimeMs: tls + 180200, durationMs: 200, status: "error", attributes: { "error.type": "LLMTurnTimeout", "error.message": "LLM turn timed out after 180000ms", "error.recoverable": false }, events: [] });

  const endTime = tls + 180400;
  updateSpan(db, rootSpanId, { endTimeMs: endTime, durationMs: endTime - baseMs, status: "error", attributes: { "agent.type": agentType, "agent.turns": 5, "agent.stop_reason": "timeout", "agent.error": "LLM turn timed out after 180000ms" }, events: [{ timeMs: endTime, name: "agent_error", attributes: { reason: "timeout" } }] });
  updateAgentTrace(db, traceId, { status: "timeout", endTimeMs: endTime, durationMs: endTime - baseMs, totalTurns: 5, totalToolCalls: 5, inputTokens: totalIn, outputTokens: totalOut, costUsd: (totalIn * 3 + totalOut * 15) / 1_000_000, stopReason: "timeout", errorMessage: "LLM turn timed out after 180000ms", spanCount: 5 + 5 + 2 });
  console.log(`[demo-traces] ✅ research-agent (timeout) trace ${traceId}`);
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function seedDemoTraces(db: Database.Database, _config: DemoTraceConfig = {}): Promise<void> {
  const now = Date.now();
  // Space traces 2 hours apart, ending now
  const bases = [
    now - 6 * 60 * 60 * 1000,   // 6h ago: goals-worker
    now - 4 * 60 * 60 * 1000,   // 4h ago: programmer
    now - 2 * 60 * 60 * 1000,   // 2h ago: daily-brief
    now - 1 * 60 * 60 * 1000,   // 1h ago: research-agent (timeout)
  ];

  await seedGoalsWorker(db, bases[0]);
  await seedProgrammerAgent(db, bases[1]);
  await seedDailyBrief(db, bases[2]);
  await seedTimedOutAgent(db, bases[3]);

  console.log("[demo-traces] ✅ All demo traces seeded.");
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = getRawDb();
  seedDemoTraces(db)
    .then(() => {
      console.log("[demo-traces] Done!");
      process.exit(0);
    })
    .catch(err => {
      console.error("[demo-traces] Error:", err);
      process.exit(1);
    });
}
