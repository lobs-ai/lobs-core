/**
 * Agent control tools — lets agents spawn other agents, run pipelines, and coordinate work.
 *
 * This is the key differentiator: agents can dynamically compose work instead of
 * relying on static orchestrator pipelines. A programmer can spawn a reviewer,
 * an architect can kick off parallel implementations, etc.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { log } from "../../util/logger.js";
import { runAgent, type AgentSpec } from "../agent-loop.js";
import { parseModelString } from "../providers.js";
import type { ToolDefinition, ToolName } from "../types.js";

const HOME = process.env.HOME ?? "";

// Default tools each agent type gets
const AGENT_DEFAULT_TOOLS: Record<string, ToolName[]> = {
  programmer: ["exec", "read", "write", "edit", "memory_search", "memory_read", "memory_write"],
  reviewer: ["exec", "read", "memory_search", "memory_read", "memory_write"],
  researcher: ["exec", "read", "write", "web_search", "memory_search", "memory_read", "memory_write"],
  writer: ["read", "write", "edit", "memory_search", "memory_read", "memory_write"],
  architect: ["read", "write", "memory_search", "memory_read", "memory_write"],
};

// Model tier mapping (simplified — orchestrator has the full version)
import { getModelForTier } from "../../config/models.js";

export const AGENT_CONTROL_TOOLS: ToolDefinition[] = [
  {
    name: "spawn_agent",
    description: `Spawn another agent to perform a subtask. The agent runs to completion and returns its output.

Use this when:
- You need a code review (spawn reviewer)
- A subtask requires different expertise (spawn researcher for investigation)
- You want parallel work on independent pieces (spawn multiple agents)
- You need an architectural opinion (spawn architect)

Agent types: programmer, reviewer, researcher, writer, architect
Model tiers: micro (local/free), small, medium, standard, strong (opus)

The spawned agent gets its own workspace context, tools, and memory access.
It does NOT see your conversation — only the task you give it.`,
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
          description: "Model tier. Default: small for most work, micro for simple tasks, strong for complex reasoning.",
        },
        cwd: {
          type: "string",
          description: "Working directory for the agent (default: your current working directory)",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 600, max: 900)",
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
export async function executeSpawnAgent(input: Record<string, unknown>, parentCwd?: string): Promise<string> {
  const agentType = input.agent_type as string;
  const task = input.task as string;
  const modelTier = (input.model_tier as string) ?? "small";
  const cwd = (input.cwd as string) ?? parentCwd ?? `${HOME}/lobs/lobs-core`;
  const timeout = Math.min((input.timeout as number) ?? 600, 900);
  const extraTools = (input.extra_tools as string[]) ?? [];

  const model = getModelForTier(modelTier);
  const tools = [...(AGENT_DEFAULT_TOOLS[agentType] ?? AGENT_DEFAULT_TOOLS.programmer)] as ToolName[];

  // Add extra tools
  for (const t of extraTools) {
    if (!tools.includes(t as ToolName)) {
      tools.push(t as ToolName);
    }
  }

  log().info(`[AGENT_TOOL] Spawning ${agentType} (model=${modelTier}, timeout=${timeout}s)`);

  const spec: AgentSpec = {
    agent: agentType,
    task,
    model,
    tools,
    cwd,
    timeout,
  };

  try {
    const result = await runAgent(spec);

    // Log the result
    const logDir = resolve(HOME, ".lobs/agents", agentType, "sessions");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const logFile = resolve(logDir, `spawned-${Date.now()}.jsonl`);
    appendFileSync(logFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      task: task.slice(0, 200),
      model,
      succeeded: result.succeeded,
      turns: result.turns,
      costUsd: result.costUsd,
      durationSeconds: result.durationSeconds,
    }) + "\n");

    if (result.succeeded) {
      return [
        `✅ ${agentType} completed successfully`,
        `Turns: ${result.turns} | Cost: $${result.costUsd.toFixed(4)} | Duration: ${result.durationSeconds.toFixed(1)}s`,
        "",
        "Output:",
        result.output,
      ].join("\n");
    } else {
      return [
        `❌ ${agentType} failed (${result.stopReason})`,
        result.error ? `Error: ${result.error}` : "",
        `Turns: ${result.turns} | Cost: $${result.costUsd.toFixed(4)}`,
        "",
        "Last output:",
        result.output,
      ].join("\n");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log().error(`[AGENT_TOOL] spawn_agent failed: ${msg}`);
    return `❌ Failed to spawn ${agentType}: ${msg}`;
  }
}

/**
 * Execute the run_pipeline tool.
 */
export async function executeRunPipeline(input: Record<string, unknown>, parentCwd?: string): Promise<string> {
  const pipelineName = input.pipeline as string;
  const task = input.task as string;
  const cwd = (input.cwd as string) ?? parentCwd ?? `${HOME}/lobs/lobs-core`;

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
