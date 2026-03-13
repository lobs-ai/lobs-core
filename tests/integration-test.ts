/**
 * Integration test — runs a real task through the full pipeline:
 * context engine → prompt builder → agent runner
 *
 * Logs the assembled context and system prompt for inspection.
 */

import { assembleContext, classifyTask } from "../src/runner/context-engine.js";
import { buildSmartSystemPrompt } from "../src/runner/prompt-builder.js";
import { runAgent } from "../src/runner/agent-loop.js";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const HOME = process.env.HOME ?? "";
const OUTPUT_DIR = resolve(HOME, "lobs/lobs-core/tests/output");

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const taskTitle = "Create a VERSION.md file for the lobs-core project";
  const taskNotes = `## Problem
The lobs-core project needs a VERSION.md file that tracks the current version and changelog.

## Acceptance Criteria
- [ ] VERSION.md exists at the project root
- [ ] Contains current version (0.1.0) and date
- [ ] Lists recent features added (agent runner, context engine, memory tools)
- [ ] Follows standard changelog format

## Constraints
- Just create the file — nothing else
- Keep it concise`;

  const agentType = "programmer";
  const projectId = "lobs-memory";
  const repoPath = resolve(HOME, "lobs-memory");

  console.log("=== Step 1: Task Classification ===\n");
  const classification = classifyTask(`${taskTitle}\n\n${taskNotes}`, undefined, agentType);
  console.log(`  Type: ${classification.taskType}`);
  console.log(`  Topic: ${classification.topic}`);
  console.log(`  Project: ${classification.project}`);
  console.log(`  Confidence: ${classification.confidence}`);
  console.log(`  Entities: ${classification.entities.join(", ") || "none"}`);

  console.log("\n=== Step 2: Context Assembly ===\n");
  const context = await assembleContext({
    task: `${taskTitle}\n\n${taskNotes}`,
    agentType,
    projectId,
    contextRefs: [resolve(HOME, "lobs-memory/server/index.ts")],
  });

  console.log(`  Total tokens: ${context.totalTokens}`);
  console.log(`  Layers:`);
  for (const layer of context.layers) {
    console.log(`    ${layer.category}: ${layer.chunks.length} chunks, ${layer.tokensUsed} tokens`);
  }
  console.log(`  Budget: ${JSON.stringify(context.budget.allocations)}`);

  // Save full context block
  writeFileSync(resolve(OUTPUT_DIR, "context-block.md"), context.contextBlock);
  console.log(`\n  Context block saved to tests/output/context-block.md (${context.contextBlock.length} chars)`);

  console.log("\n=== Step 3: System Prompt ===\n");
  const smartPrompt = await buildSmartSystemPrompt({
    task: `${taskTitle}\n\n${taskNotes}`,
    agent: agentType,
    model: "anthropic/claude-sonnet-4-20250514",
    cwd: repoPath,
    tools: ["exec", "read", "write", "edit", "memory_search", "memory_read"],
  });

  writeFileSync(resolve(OUTPUT_DIR, "system-prompt.md"), smartPrompt.systemPrompt);
  console.log(`  System prompt saved to tests/output/system-prompt.md (${smartPrompt.systemPrompt.length} chars)`);
  console.log(`  Preview (first 500 chars):\n`);
  console.log(smartPrompt.systemPrompt.slice(0, 500));

  console.log("\n\n=== Step 4: Agent Run ===\n");
  const fullPrompt = `${taskTitle}\n\n${taskNotes}\n\n${context.contextBlock}`;
  
  writeFileSync(resolve(OUTPUT_DIR, "full-prompt.md"), fullPrompt);
  console.log(`  Full prompt saved to tests/output/full-prompt.md (${fullPrompt.length} chars)`);

  console.log("  Starting agent...\n");

  const result = await runAgent({
    task: fullPrompt,
    agent: agentType,
    model: "anthropic/claude-sonnet-4-20250514",
    cwd: repoPath,
    tools: ["exec", "read", "write", "edit", "memory_search", "memory_read"],
    timeout: 120,
    maxTurns: 30,
  });

  console.log("\n=== Step 5: Results ===\n");
  console.log(`  Success: ${result.succeeded}`);
  console.log(`  Stop reason: ${result.stopReason}`);
  console.log(`  Turns: ${result.turns}`);
  console.log(`  Duration: ${result.durationSeconds.toFixed(1)}s`);
  console.log(`  Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
  console.log(`  Cost: $${result.costUsd.toFixed(4)}`);
  if (result.error) console.log(`  Error: ${result.error}`);
  console.log(`\n  Output (first 1000 chars):\n`);
  console.log(result.output.slice(0, 1000));

  // Save full result
  writeFileSync(resolve(OUTPUT_DIR, "result.json"), JSON.stringify({
    succeeded: result.succeeded,
    stopReason: result.stopReason,
    turns: result.turns,
    durationSeconds: result.durationSeconds,
    usage: result.usage,
    costUsd: result.costUsd,
    error: result.error,
    output: result.output,
  }, null, 2));

  console.log("\n\n=== All output saved to tests/output/ ===");
  console.log("Files: context-block.md, system-prompt.md, full-prompt.md, result.json");
}

main().catch((err) => {
  console.error("Integration test failed:", err);
  process.exit(1);
});
