/**
 * Agent control tools — lets agents spawn other agents, run pipelines, and coordinate work.
 *
 * This is the key differentiator: agents can dynamically compose work instead of
 * relying on static orchestrator pipelines. A programmer can spawn a reviewer,
 * an architect can kick off parallel implementations, etc.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "../../util/logger.js";
import { runAgent, calculateCost } from "../agent-loop.js";
import type { AgentSpec } from "../agent-loop.js";
import { getModelForTier } from "../../config/models.js";
import type { ToolDefinition, ToolName } from "../types.js";

const HOME = process.env.HOME ?? "";

// Rich tracking for active spawned agents
interface ActiveAgent {
  type: string;
  task: string;
  startedAt: number;
  modelTier: string;
  model: string;
  abortController: AbortController;
  /** Queue of messages to inject into the agent's conversation */
  messageQueue: string[];
  /** Progress tracking */
  turns: number;
  lastActivity: number;
  costUsd: number;
}

// In-memory tracking for active spawned agents
const activeAgents = new Map<string, ActiveAgent>();

// Default tools each agent type gets
const AGENT_DEFAULT_TOOLS: Record<string, ToolName[]> = {
  programmer: ["exec", "read", "write", "edit", "memory_search", "memory_read", "memory_write"],
  reviewer: ["exec", "read", "memory_search", "memory_read", "memory_write"],
  researcher: ["exec", "read", "write", "web_search", "web_fetch", "memory_search", "memory_read", "memory_write"],
  writer: ["read", "write", "edit", "memory_search", "memory_read", "memory_write"],
  architect: ["read", "write", "memory_search", "memory_read", "memory_write"],
};

export const AGENT_CONTROL_TOOLS: ToolDefinition[] = [
  {
    name: "spawn_agent",
    description: `Spawn another agent to perform a subtask. The agent runs in the background and you'll receive a notification when it completes.

Use this when:
- You need a code review (spawn reviewer)
- A subtask requires different expertise (spawn researcher for investigation)
- You want parallel work on independent pieces (spawn multiple agents)
- You need an architectural opinion (spawn architect)

Agent types: programmer, reviewer, researcher, writer, architect
Model tiers: micro (local/free), small, medium, standard, strong (opus)

The spawned agent gets its own workspace context, tools, and memory access.
It does NOT see your conversation — only the task you give it.

Returns immediately with a run ID. The agent works in the background and announces completion automatically.`,
    input_schema: {
      type: "object" as const,
      properties: {
        agent_type: {
          type: "string",
          enum: ["programmer", "reviewer", "researcher", "writer", "architect"],
          description: "Type of agent to spawn",
        },
        task: {
          type: "string",
          description: "Full task description for the agent. Be specific — include file paths, context, acceptance criteria.",
        },
        model_tier: {
          type: "string",
          enum: ["micro", "small", "medium", "standard", "strong"],
          description: "Model tier. Default: standard for most work, small for simple/mechanical tasks, micro for trivial tasks. Only use strong for genuinely exceptional reasoning needs.",
        },
        cwd: {
          type: "string",
          description: "Working directory for the agent (default: your current working directory)",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 7200, max: 7200)",
        },
        extra_tools: {
          type: "array",
          items: { type: "string" },
          description: "Additional tools beyond the agent's defaults (e.g., 'web_search', 'memory_write')",
        },
      },
      required: ["agent_type", "task"],
    },
  },
  {
    name: "list_agents",
    description: `[Deprecated: use check_agents instead] List all currently running spawned agents.

Returns information about active background agents including their run IDs, types, tasks, and how long they've been running.`,
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "run_pipeline",
    description: `Run a multi-agent pipeline where each agent's output feeds into the next.

Built-in pipelines:
- implement-and-review: programmer writes code → reviewer checks quality
- design-and-implement: architect creates design doc → programmer implements it
- research-and-write: researcher investigates → writer creates documentation

You can also define custom pipelines with arbitrary stages.

Each stage gets the previous stage's output as context.
Pipeline stops if any stage fails.`,
    input_schema: {
      type: "object" as const,
      properties: {
        pipeline: {
          type: "string",
          enum: ["implement-and-review", "design-and-implement", "research-and-write", "custom"],
          description: "Pipeline to run, or 'custom' for a custom pipeline",
        },
        task: {
          type: "string",
          description: "The task description that all pipeline stages work on",
        },
        stages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              agent_type: { type: "string" },
              model_tier: { type: "string" },
              task_suffix: { type: "string", description: "Additional instructions for this stage" },
            },
            required: ["agent_type"],
          },
          description: "Custom pipeline stages (only used when pipeline='custom')",
        },
        cwd: {
          type: "string",
          description: "Working directory for all agents in the pipeline",
        },
      },
      required: ["pipeline", "task"],
    },
  },
  {
    name: "check_agents",
    description: `Check status of spawned subagents. Shows all active agents with their progress, turns, cost, and duration. Can also check a specific agent by run ID.`,
    input_schema: {
      type: "object" as const,
      properties: {
        run_id: {
          type: "string",
          description: "Optional: specific agent run ID to check. Omit to see all active agents.",
        },
      },
      required: [],
    },
  },
  {
    name: "message_agent",
    description: `Send a message to a running subagent. The message will be injected into the agent's conversation as a user message on its next turn. Use this to provide additional context, redirect the agent, or give feedback while it's working.`,
    input_schema: {
      type: "object" as const,
      properties: {
        run_id: {
          type: "string",
          description: "The agent's run ID",
        },
        message: {
          type: "string",
          description: "Message to inject into the agent's conversation",
        },
      },
      required: ["run_id", "message"],
    },
  },
  {
    name: "stop_agent",
    description: `Stop a running subagent. The agent will be gracefully terminated at the end of its current turn.`,
    input_schema: {
      type: "object" as const,
      properties: {
        run_id: {
          type: "string",
          description: "The agent's run ID to stop",
        },
      },
      required: ["run_id"],
    },
  },
];

// Built-in pipeline definitions
const BUILTIN_PIPELINES: Record<string, Array<{ agentType: string; modelTier: string; taskPrefix: string }>> = {
  "implement-and-review": [
    { agentType: "programmer", modelTier: "standard", taskPrefix: "Implement the following:\n\n" },
    { agentType: "reviewer", modelTier: "small", taskPrefix: "Review the code changes from the previous implementation. Check for bugs, edge cases, and code quality. Provide specific feedback.\n\nImplementation task:\n" },
  ],
  "design-and-implement": [
    { agentType: "architect", modelTier: "strong", taskPrefix: "Create a design document for:\n\n" },
    { agentType: "programmer", modelTier: "standard", taskPrefix: "Implement the following design. Follow the architecture exactly as specified.\n\nDesign:\n" },
  ],
  "research-and-write": [
    { agentType: "researcher", modelTier: "standard", taskPrefix: "Research the following topic thoroughly:\n\n" },
    { agentType: "writer", modelTier: "small", taskPrefix: "Write clear documentation based on the research findings below:\n\nResearch:\n" },
  ],
};

/**
 * Execute the spawn_agent tool.
 */
export async function executeSpawnAgent(
  input: Record<string, unknown>,
  parentCwd?: string,
  channelId?: string,
  onComplete?: (result: { runId: string; agentType: string; succeeded: boolean; output: string; error?: string }) => void,
): Promise<string> {
  const agentType = input.agent_type as string;
  const task = input.task as string;
  const modelTier = (input.model_tier as string) ?? "standard";
  // If no cwd specified, try to find the right repo for the task
  const defaultCwd = parentCwd ?? HOME;
  const cwd = (input.cwd as string) ?? defaultCwd;
  const timeout = Math.min((input.timeout as number) ?? 7200, 7200);
  const maxTurns = input.max_turns as number | undefined;
  const extraTools = (input.extra_tools as string[]) ?? [];

  const model = getModelForTier(modelTier);
  const noDefaultTools = input.no_default_tools === true;
  const tools = noDefaultTools ? [] : [...(AGENT_DEFAULT_TOOLS[agentType] ?? AGENT_DEFAULT_TOOLS.programmer)] as ToolName[];

  // Add extra tools
  for (const t of extraTools) {
    if (!tools.includes(t as ToolName)) {
      tools.push(t as ToolName);
    }
  }

  const runId = randomUUID().slice(0, 8);

  log().info(`[AGENT_TOOL] Spawning ${agentType} (id=${runId}, model=${modelTier}, timeout=${timeout}s)`);

  // Create abort controller for this agent
  const abortController = new AbortController();

  // Track the spawned agent with rich metadata
  activeAgents.set(runId, {
    type: agentType,
    task: task.slice(0, 200),
    startedAt: Date.now(),
    modelTier,
    model,
    abortController,
    messageQueue: [],
    turns: 0,
    lastActivity: Date.now(),
    costUsd: 0,
  });

  const spec: AgentSpec = {
    agent: agentType,
    task,
    model,
    tools,
    cwd,
    timeout,
    ...(maxTurns != null && { maxTurns }),
    abortSignal: abortController.signal,
    onProgress: (progress) => {
      const agent = activeAgents.get(runId);
      if (agent) {
        agent.turns = progress.turn;
        agent.lastActivity = Date.now();
        if (progress.usage) {
          agent.costUsd = calculateCost(model, progress.usage);
        }
      }
    },
    getInjectedMessages: () => {
      const agent = activeAgents.get(runId);
      if (!agent || agent.messageQueue.length === 0) return [];
      const msgs = [...agent.messageQueue];
      agent.messageQueue.length = 0; // drain
      return msgs;
    },
  };

  // Capture the channelId for completion callback (so results go back to the right channel)
  const originChannel = channelId;

  // Fire-and-forget: run in background
  runAgent(spec).then(result => {
    // Remove from active tracking
    activeAgents.delete(runId);

    // Log the result
    const logDir = resolve(HOME, ".lobs/agents", agentType, "sessions");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const logFile = resolve(logDir, `spawned-${Date.now()}.jsonl`);
    appendFileSync(logFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      runId,
      task: task.slice(0, 200),
      model,
      succeeded: result.succeeded,
      turns: result.turns,
      costUsd: result.costUsd,
      durationSeconds: result.durationSeconds,
    }) + "\n");

    // Fire onComplete callback if provided (for reflection workers, etc.)
    if (onComplete) {
      try {
        onComplete({ runId, agentType, succeeded: result.succeeded, output: result.output, error: result.error });
      } catch (cbErr) {
        log().error(`[AGENT_TOOL] onComplete callback error for ${runId}: ${cbErr}`);
      }
    }

    // Announce completion back to main agent on the originating channel
    const mainAgent = (globalThis as any).__lobsMainAgent;
    if (mainAgent) {
      const status = result.succeeded ? "✅ completed" : "❌ failed";
      const announcement = [
        `[Subagent ${status}] ${agentType} (${runId})`,
        `Task: ${task.slice(0, 200)}`,
        `Turns: ${result.turns} | Cost: $${result.costUsd.toFixed(4)} | Duration: ${result.durationSeconds.toFixed(1)}s`,
        "",
        result.succeeded ? "Output:" : `Error: ${result.error || result.stopReason}`,
        result.output.slice(0, 3000),
      ].join("\n");

      mainAgent.handleSystemEvent(announcement, originChannel).catch((err: any) => {
        console.error("[spawn_agent] Failed to announce completion:", err);
      });
    }
  }).catch(err => {
    // Remove from active tracking on crash
    activeAgents.delete(runId);

    const msg = err instanceof Error ? err.message : String(err);
    log().error(`[AGENT_TOOL] spawn_agent ${runId} crashed: ${msg}`);

    // Announce crash to main agent
    const mainAgent = (globalThis as any).__lobsMainAgent;
    if (mainAgent) {
      mainAgent.handleSystemEvent(
        `[Subagent ❌ crashed] ${agentType} (${runId}): ${String(err).slice(0, 500)}`,
        originChannel,
      ).catch(() => {});
    }
  });

  // Return immediately
  return `🚀 Spawned ${agentType} agent (id: ${runId})\nTask: ${task.slice(0, 200)}\nModel: ${modelTier}\nThe agent is working in the background. You'll receive a completion notification when it finishes.`;
}

/**
 * Execute the list_agents tool.
 * @deprecated Use executeCheckAgents instead.
 */
export async function executeListAgents(): Promise<string> {
  if (activeAgents.size === 0) {
    return "No agents currently running.";
  }

  const lines: string[] = [`Active agents (${activeAgents.size}):\n`];
  const now = Date.now();

  for (const [runId, info] of activeAgents.entries()) {
    const elapsedSeconds = Math.floor((now - info.startedAt) / 1000);
    const elapsedMin = Math.floor(elapsedSeconds / 60);
    const elapsedSec = elapsedSeconds % 60;
    const elapsed = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsedSec}s`;

    lines.push(`• ${runId} — ${info.type} (running ${elapsed})`);
    lines.push(`  Task: ${info.task}`);
  }

  return lines.join("\n");
}

/**
 * Execute the check_agents tool — rich status for all or one agent.
 */
export async function executeCheckAgents(input: Record<string, unknown>): Promise<string> {
  const runId = input.run_id as string | undefined;

  if (activeAgents.size === 0) {
    return "No agents currently running.";
  }

  const now = Date.now();

  function formatAgent(id: string, info: ActiveAgent, detailed: boolean): string {
    const elapsedMs = now - info.startedAt;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const elapsedMin = Math.floor(elapsedSeconds / 60);
    const elapsedSec = elapsedSeconds % 60;
    const elapsed = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsedSec}s`;

    const lastActivityAgo = Math.floor((now - info.lastActivity) / 1000);
    const lastActivityStr = lastActivityAgo < 5
      ? "just now"
      : lastActivityAgo < 60
        ? `${lastActivityAgo}s ago`
        : `${Math.floor(lastActivityAgo / 60)}m ago`;

    const lines: string[] = [
      `• ${id} — ${info.type} [${info.modelTier}]`,
      `  Running: ${elapsed} | Turns: ${info.turns} | Cost: $${info.costUsd.toFixed(4)} | Last activity: ${lastActivityStr}`,
      `  Task: ${info.task.slice(0, 120)}${info.task.length > 120 ? "…" : ""}`,
    ];

    if (detailed) {
      lines.push(`  Model: ${info.model}`);
      if (info.messageQueue.length > 0) {
        lines.push(`  Pending messages: ${info.messageQueue.length} queued`);
      }
    }

    return lines.join("\n");
  }

  // Single agent detail
  if (runId) {
    const info = activeAgents.get(runId);
    if (!info) {
      return `No active agent with run ID: ${runId}\n(It may have already completed or never existed.)`;
    }
    return formatAgent(runId, info, true);
  }

  // All agents
  const lines: string[] = [`Active agents (${activeAgents.size}):\n`];
  for (const [id, info] of activeAgents.entries()) {
    lines.push(formatAgent(id, info, false));
  }
  return lines.join("\n");
}

/**
 * Execute the message_agent tool — queue a message for injection.
 */
export async function executeMessageAgent(input: Record<string, unknown>): Promise<string> {
  const runId = input.run_id as string;
  const message = input.message as string;

  const agent = activeAgents.get(runId);
  if (!agent) {
    return `❌ No active agent with run ID: ${runId}\n(It may have already completed or never existed.)`;
  }

  agent.messageQueue.push(message);
  return `✉️ Message queued for agent ${runId} (${agent.type})\nIt will be injected at the start of the agent's next turn.\nMessage: ${message.slice(0, 200)}${message.length > 200 ? "…" : ""}`;
}

/**
 * Execute the stop_agent tool — abort a running agent.
 */
export async function executeStopAgent(input: Record<string, unknown>): Promise<string> {
  const runId = input.run_id as string;

  const agent = activeAgents.get(runId);
  if (!agent) {
    return `❌ No active agent with run ID: ${runId}\n(It may have already completed or never existed.)`;
  }

  agent.abortController.abort();
  return `🛑 Stop signal sent to agent ${runId} (${agent.type})\nThe agent will finish its current turn and then stop gracefully.`;
}

/**
 * Execute the run_pipeline tool.
 */
export async function executeRunPipeline(input: Record<string, unknown>, parentCwd?: string): Promise<string> {
  const pipelineName = input.pipeline as string;
  const task = input.task as string;
  const defaultCwd = parentCwd ?? HOME;
  const cwd = (input.cwd as string) ?? defaultCwd;

  let stages: Array<{ agentType: string; modelTier: string; taskPrefix: string }>;

  if (pipelineName === "custom") {
    const customStages = (input.stages as Array<Record<string, unknown>>) ?? [];
    if (customStages.length === 0) {
      return "❌ Custom pipeline requires at least one stage";
    }
    stages = customStages.map(s => ({
      agentType: (s.agent_type as string) ?? "programmer",
      modelTier: (s.model_tier as string) ?? "small",
      taskPrefix: (s.task_suffix as string) ? `${s.task_suffix}\n\n` : "",
    }));
  } else {
    stages = BUILTIN_PIPELINES[pipelineName];
    if (!stages) {
      return `❌ Unknown pipeline: ${pipelineName}. Available: ${Object.keys(BUILTIN_PIPELINES).join(", ")}`;
    }
  }

  log().info(`[AGENT_TOOL] Running pipeline '${pipelineName}' with ${stages.length} stages`);

  const results: Array<{ agentType: string; succeeded: boolean; output: string; cost: number; duration: number }> = [];
  let previousOutput = "";

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const model = getModelForTier(stage.modelTier);
    const tools = [...(AGENT_DEFAULT_TOOLS[stage.agentType] ?? AGENT_DEFAULT_TOOLS.programmer)] as ToolName[];

    // Build task with previous output as context
    let stageTask = stage.taskPrefix + task;
    if (previousOutput) {
      stageTask += `\n\n--- Previous stage output (${results[results.length - 1]?.agentType ?? "unknown"}) ---\n${previousOutput}`;
    }

    log().info(`[AGENT_TOOL] Pipeline stage ${i + 1}/${stages.length}: ${stage.agentType}`);

    const spec: AgentSpec = {
      agent: stage.agentType,
      task: stageTask,
      model,
      tools,
      cwd,
      timeout: 600,
    };

    try {
      const result = await runAgent(spec);
      results.push({
        agentType: stage.agentType,
        succeeded: result.succeeded,
        output: result.output,
        cost: result.costUsd,
        duration: result.durationSeconds,
      });

      if (!result.succeeded) {
        // Pipeline stops on failure
        return formatPipelineResult(pipelineName, results, `Stage ${i + 1} (${stage.agentType}) failed: ${result.error ?? result.stopReason}`);
      }

      previousOutput = result.output;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ agentType: stage.agentType, succeeded: false, output: msg, cost: 0, duration: 0 });
      return formatPipelineResult(pipelineName, results, `Stage ${i + 1} (${stage.agentType}) error: ${msg}`);
    }
  }

  return formatPipelineResult(pipelineName, results);
}

function formatPipelineResult(
  name: string,
  results: Array<{ agentType: string; succeeded: boolean; output: string; cost: number; duration: number }>,
  error?: string,
): string {
  const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  const allSucceeded = results.every(r => r.succeeded);

  const lines: string[] = [
    `${allSucceeded ? "✅" : "❌"} Pipeline '${name}' ${allSucceeded ? "completed" : "failed"}`,
    `Stages: ${results.length} | Cost: $${totalCost.toFixed(4)} | Duration: ${totalDuration.toFixed(1)}s`,
  ];

  if (error) lines.push(`Error: ${error}`);

  lines.push("");
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`--- Stage ${i + 1}: ${r.agentType} (${r.succeeded ? "✅" : "❌"}) ---`);
    lines.push(r.output.slice(0, 2000));
    lines.push("");
  }

  return lines.join("\n");
}
