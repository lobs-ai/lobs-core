/**
 * Simple test of spawn_agent - bypasses the tools registry to avoid circular imports
 */

import { runAgent, type AgentSpec } from "./src/runner/agent-loop.js";

const reviewTask = `Review the formatBytes utility function in ~/lobs/lobs-core/src/util/format.ts

Check for:
1. Correctness - does it properly convert bytes to KB/MB/GB/etc?
2. Edge cases - does it handle 0, negative numbers, very large numbers?
3. Code quality - is the implementation clean and maintainable?
4. Documentation - are the JSDoc comments accurate and helpful?

Provide specific feedback on any issues found.

Expected behavior:
- formatBytes(1024) should return '1.0 KB'
- formatBytes(1048576) should return '1.0 MB'
- formatBytes(0) should return '0 B'`;

const spec: AgentSpec = {
  agent: "reviewer",
  task: reviewTask,
  model: "anthropic/claude-sonnet-4-20250514",
  tools: ["exec", "read", "memory_search", "memory_read"],
  cwd: process.env.HOME + "/lobs/lobs-core",
  timeout: 300,
};

console.log("🚀 Spawning reviewer agent...\n");

try {
  const result = await runAgent(spec);
  
  console.log("\n" + "=".repeat(80));
  if (result.succeeded) {
    console.log("✅ Reviewer completed successfully");
    console.log(`Turns: ${result.turns} | Cost: $${result.costUsd.toFixed(4)} | Duration: ${result.durationSeconds.toFixed(1)}s`);
    console.log("=".repeat(80));
    console.log("\nReviewer Output:\n");
    console.log(result.output);
  } else {
    console.log(`❌ Reviewer failed (${result.stopReason})`);
    if (result.error) console.log(`Error: ${result.error}`);
    console.log(`Turns: ${result.turns} | Cost: $${result.costUsd.toFixed(4)}`);
    console.log("=".repeat(80));
    console.log("\nLast output:\n");
    console.log(result.output);
  }
} catch (err) {
  console.error("❌ Failed to spawn reviewer:", err);
  process.exit(1);
}
