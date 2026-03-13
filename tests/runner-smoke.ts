/**
 * Smoke test for the agent runner.
 * Run: npx tsx tests/runner-smoke.ts
 */

import { runAgent } from "../src/runner/index.js";

async function main() {
  console.log("=== Agent Runner Smoke Test ===\n");

  const result = await runAgent({
    task: "List the files in the current directory, then create a file called /tmp/lobs-runner-test.txt with the text 'Hello from Lobs runner!'. Finally, read the file back to confirm it was written correctly.",
    agent: "programmer",
    model: "claude-sonnet-4-20250514",
    cwd: process.env.HOME ?? "/tmp",
    tools: ["exec", "read", "write", "edit"],
    timeout: 60,
    onProgress: (update) => {
      if (update.type === "tool_call") {
        console.log(`  [turn ${update.turn}] tool: ${update.toolName}`);
      }
    },
  });

  console.log("\n=== Result ===");
  console.log(`Succeeded: ${result.succeeded}`);
  console.log(`Stop reason: ${result.stopReason}`);
  console.log(`Turns: ${result.turns}`);
  console.log(`Duration: ${result.durationSeconds.toFixed(1)}s`);
  console.log(`Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
  console.log(`Cost: $${result.costUsd.toFixed(6)}`);
  if (result.error) console.log(`Error: ${result.error}`);
  console.log(`\nOutput (last ${Math.min(500, result.output.length)} chars):`);
  console.log(result.output.slice(-500));

  // Verify the file was created
  const { readFileSync, unlinkSync } = await import("node:fs");
  try {
    const content = readFileSync("/tmp/lobs-runner-test.txt", "utf-8");
    console.log(`\n✅ Test file content: "${content.trim()}"`);
    unlinkSync("/tmp/lobs-runner-test.txt");
    console.log("✅ Cleanup done");
  } catch {
    console.log("\n❌ Test file was not created");
  }

  process.exit(result.succeeded ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
