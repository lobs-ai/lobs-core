/**
 * Test the context engine — classification, budgeting, and assembly.
 * Run: npx tsx tests/context-engine-test.ts
 */

import { classifyTask, allocateBudget, assembleContext } from "../src/runner/index.js";

function testClassifier() {
  console.log("=== Task Classifier ===\n");

  const testCases = [
    "Fix the auth bug in paw-hub where login fails after token expiry",
    "Design the new handoff architecture for multi-agent context sharing",
    "Review PR #42 for the lobs-memory reranker changes",
    "Research options for graph databases vs SQLite for entity storage",
    "Write documentation for the agent runner API",
    "Set up CI/CD pipeline with Docker for paw-hub deployment",
    "Implement the web_fetch tool for the agent runner",
    "How does the context engine work?",
  ];

  for (const task of testCases) {
    const result = classifyTask(task);
    console.log(`Task: "${task.slice(0, 60)}..."`);
    console.log(`  Type: ${result.taskType} (confidence: ${result.confidence.toFixed(2)})`);
    console.log(`  Topic: ${result.topic}`);
    if (result.project) console.log(`  Project: ${result.project}`);
    if (result.entities.length) console.log(`  Entities: ${result.entities.join(", ")}`);
    console.log();
  }
}

function testBudgetAllocator() {
  console.log("=== Token Budget Allocator ===\n");

  const types = ["coding", "debugging", "architecture", "review", "research", "conversation"] as const;
  const maxTokens = 8000;

  for (const type of types) {
    const budget = allocateBudget(type, maxTokens);
    const a = budget.allocations;
    console.log(`${type}:`);
    console.log(`  memory: ${a.memory} (${(a.memory/maxTokens*100).toFixed(0)}%) | project: ${a.project} (${(a.project/maxTokens*100).toFixed(0)}%) | code: ${a.code} (${(a.code/maxTokens*100).toFixed(0)}%) | session: ${a.session} (${(a.session/maxTokens*100).toFixed(0)}%) | instructions: ${a.instructions} (${(a.instructions/maxTokens*100).toFixed(0)}%)`);
  }
  console.log();
}

async function testAssembly() {
  console.log("=== Context Assembly (with lobs-memory) ===\n");

  // Check if lobs-memory is running
  try {
    const check = await fetch("http://localhost:7420/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test", maxResults: 1 }),
      signal: AbortSignal.timeout(30000),
    });
    if (!check.ok) throw new Error("not ok");
  } catch {
    console.log("⚠️ lobs-memory not running — skipping assembly test\n");
    return;
  }

  const context = await assembleContext({
    task: "Fix the auth middleware in paw-hub to properly handle token refresh",
    agentType: "programmer",
    projectId: "paw-hub",
  });

  console.log(`Classification: ${context.classification.taskType} (${context.classification.confidence.toFixed(2)})`);
  console.log(`Topic: ${context.classification.topic}`);
  console.log(`Project: ${context.classification.project ?? "none"}`);
  console.log(`Total tokens: ${context.totalTokens}`);
  console.log(`Budget: ${context.budget.total}`);
  console.log();

  for (const layer of context.layers) {
    if (layer.chunks.length === 0) continue;
    console.log(`Layer: ${layer.category} (${layer.chunks.length} chunks, ${layer.tokensUsed} tokens)`);
    for (const chunk of layer.chunks.slice(0, 2)) {
      console.log(`  - ${chunk.source} (score: ${chunk.score.toFixed(3)}, ${chunk.tokens} tokens)`);
    }
  }

  console.log(`\nContext block length: ${context.contextBlock.length} chars`);
  console.log(`Preview:\n${context.contextBlock.slice(0, 500)}...`);
}

async function main() {
  testClassifier();
  testBudgetAllocator();
  await testAssembly();
  console.log("\n✅ Context engine tests complete");
}

main().catch(console.error);
