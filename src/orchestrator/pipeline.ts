/**
 * Pipeline execution system — chains agents with automatic context handoff.
 *
 * Example: implement-and-review pipeline runs programmer → reviewer automatically,
 * passing the programmer's output as additional context to the reviewer.
 */

import { log } from "../util/logger.js";
import { runAgent } from "../runner/index.js";
import type { AgentResult } from "../runner/types.js";

export interface PipelineStage {
  agentType: string;
  modelTier?: string;
  /** Transform previous stage's output before passing to this stage */
  transform?: (prevOutput: string) => string;
  /** Skip this stage if condition returns false */
  condition?: (prevResult: AgentResult) => boolean;
}

export interface Pipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
  /** Callback fired after each stage completes */
  onStageComplete?: (stage: number, result: AgentResult) => void;
}

export interface PipelineResult {
  succeeded: boolean;
  stageResults: AgentResult[];
  /** Final output from the last successful stage */
  output: string;
  /** Total cost across all stages */
  totalCost: number;
  /** Total duration in seconds */
  totalDuration: number;
  /** Error message if pipeline failed */
  error?: string;
}

export interface TaskContext {
  taskId: string;
  title: string;
  notes: string;
  projectId?: string;
  repoPath?: string;
  contextRefs?: string[];
}

/**
 * Execute a pipeline of agent stages with automatic context handoff.
 *
 * Each stage receives:
 * - The original task prompt
 * - The output from the previous stage (if any)
 *
 * Pipeline stops if:
 * - Any stage fails (unless condition says to skip)
 * - All stages complete successfully
 *
 * Results from all stages are recorded in the returned PipelineResult.
 */
export async function executePipeline(
  pipeline: Pipeline,
  task: TaskContext,
): Promise<PipelineResult> {
  log().info(`[PIPELINE] Starting '${pipeline.name}' for task ${task.taskId.slice(0, 8)}`);

  const stageResults: AgentResult[] = [];
  let previousOutput = "";
  let totalCost = 0;
  let totalDuration = 0;

  for (let i = 0; i < pipeline.stages.length; i++) {
    const stage = pipeline.stages[i];
    const stageNum = i + 1;

    log().debug?.(`[PIPELINE] Stage ${stageNum}/${pipeline.stages.length}: ${stage.agentType}`);

    // Check condition — skip if returns false
    if (stage.condition && stageResults.length > 0) {
      const prevResult = stageResults[stageResults.length - 1];
      if (!stage.condition(prevResult)) {
        log().info(`[PIPELINE] Skipping stage ${stageNum} (${stage.agentType}) — condition failed`);
        continue;
      }
    }

    // Build stage prompt
    let stagePrompt = `${task.title}\n\n${task.notes}`;

    // Add previous stage output if this isn't the first stage
    if (previousOutput) {
      const transformedOutput = stage.transform
        ? stage.transform(previousOutput)
        : previousOutput;

      stagePrompt += `\n\n---\n## Output from Previous Stage\n${transformedOutput}\n---`;
    }

    // Run the stage
    try {
      const result = await runAgent({
        task: stagePrompt,
        agent: stage.agentType,
        model: resolveModel(stage.modelTier ?? "standard", stage.agentType),
        cwd: task.repoPath ?? process.cwd(),
        tools: ["exec", "read", "write", "edit", "memory_search", "memory_read"],
        timeout: 900, // 15 minutes per stage
        maxTurns: 200,
      });

      stageResults.push(result);
      totalCost += result.costUsd;
      totalDuration += result.durationSeconds;

      // Fire callback if provided
      if (pipeline.onStageComplete) {
        pipeline.onStageComplete(stageNum, result);
      }

      // Stop pipeline if this stage failed
      if (!result.succeeded) {
        log().warn(
          `[PIPELINE] Stage ${stageNum} (${stage.agentType}) failed — stopping pipeline`,
        );
        return {
          succeeded: false,
          stageResults,
          output: previousOutput, // Return output from last successful stage
          totalCost,
          totalDuration,
          error: result.error ?? "Stage failed",
        };
      }

      // Update previous output for next stage
      previousOutput = result.output;
    } catch (error) {
      log().error(`[PIPELINE] Stage ${stageNum} threw error: ${error}`);
      return {
        succeeded: false,
        stageResults,
        output: previousOutput,
        totalCost,
        totalDuration,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  log().info(
    `[PIPELINE] Completed '${pipeline.name}' — ${stageResults.length} stages, ` +
    `cost=$${totalCost.toFixed(4)}, duration=${totalDuration}s`,
  );

  return {
    succeeded: true,
    stageResults,
    output: previousOutput,
    totalCost,
    totalDuration,
  };
}

/**
 * Built-in pipeline: programmer → reviewer
 * Auto-reviews all code changes.
 */
export function implementAndReviewPipeline(): Pipeline {
  return {
    id: "implement-and-review",
    name: "Implement & Review",
    stages: [
      {
        agentType: "programmer",
        modelTier: "standard",
      },
      {
        agentType: "reviewer",
        modelTier: "standard",
        transform: (prevOutput) =>
          `Review the following implementation:\n\n${prevOutput.slice(0, 10000)}`,
      },
    ],
  };
}

/**
 * Built-in pipeline: architect → programmer
 * Creates design doc first, then implements based on it.
 */
export function designAndImplementPipeline(): Pipeline {
  return {
    id: "design-and-implement",
    name: "Design & Implement",
    stages: [
      {
        agentType: "architect",
        modelTier: "strong",
      },
      {
        agentType: "programmer",
        modelTier: "standard",
        transform: (prevOutput) =>
          `Implement the following design:\n\n${prevOutput.slice(0, 10000)}`,
      },
    ],
  };
}

/**
 * Built-in pipeline: researcher → writer
 * Researches a topic, then writes documentation based on findings.
 */
export function researchAndWritePipeline(): Pipeline {
  return {
    id: "research-and-write",
    name: "Research & Write",
    stages: [
      {
        agentType: "researcher",
        modelTier: "standard",
      },
      {
        agentType: "writer",
        modelTier: "standard",
        transform: (prevOutput) =>
          `Write documentation based on these findings:\n\n${prevOutput.slice(0, 10000)}`,
      },
    ],
  };
}

// ── Model Resolution ─────────────────────────────────────────────────────────

/** Simple model resolver — use tier name directly for now */
function resolveModel(tier: string, _agentType: string): string {
  const tierMap: Record<string, string> = {
    micro: "lmstudio/qwen2.5-coder:7b",
    small: "anthropic/claude-sonnet-4-5-20250514",
    medium: "anthropic/claude-sonnet-4-5-20250514",
    standard: "anthropic/claude-sonnet-4-5-20250514",
    strong: "anthropic/claude-opus-4-20250724",
  };

  return tierMap[tier] ?? tierMap.standard;
}
