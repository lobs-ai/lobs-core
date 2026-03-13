/**
 * Smoke test for the agent runner — tests multiple providers.
 * Run: npx tsx tests/runner-smoke.ts
 */

import { runAgent } from "../src/runner/index.js";

const TASK = "Create a file at /tmp/lobs-runner-test.txt containing 'Hello from Lobs runner!', then read it back to verify.";

async function testProvider(label: string, model: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing: ${label} (${model})`);
  console.log("=".repeat(60));

  const result = await runAgent({
    task: TASK,
    agent: "programmer",
    model,
    cwd: process.env.HOME ?? "/tmp",
    tools: ["exec", "read", "write", "edit"],
    timeout: 120,
    onProgress: (update) => {
      if (update.type === "tool_call") {
        console.log(`  [turn ${update.turn}] tool: ${update.toolName}`);
      }
    },
  });

  console.log(`\nResult: ${result.succeeded ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`  Stop: ${result.stopReason} | Turns: ${result.turns} | Duration: ${result.durationSeconds.toFixed(1)}s`);
  console.log(`  Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
  console.log(`  Cost: $${result.costUsd.toFixed(6)}`);
  if (result.error) console.log(`  Error: ${result.error}`);

  // Verify file
  const { readFileSync, unlinkSync } = await import("node:fs");
  try {
    const content = readFileSync("/tmp/lobs-runner-test.txt", "utf-8");
    console.log(`  File: "${content.trim()}"`);
    unlinkSync("/tmp/lobs-runner-test.txt");
  } catch {
    console.log("  File: not created");
  }

  return result.succeeded;
}

async function main() {
  console.log("=== Lobs Agent Runner — Multi-Provider Smoke Test ===");

  const results: Record<string, boolean> = {};

  // Test 1: Anthropic (OAuth)
  results["Anthropic Sonnet"] = await testProvider(
    "Anthropic Sonnet 4 (OAuth)",
    "anthropic/claude-sonnet-4-20250514"
  );

  // Test 2: LM Studio (local)
  try {
    const check = await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(2000) });
    if (check.ok) {
      results["LM Studio Qwen"] = await testProvider(
        "LM Studio Qwen 3.5 9B",
        "lmstudio/qwen/qwen3.5-9b"
      );
    }
  } catch {
    console.log("\n⚠️ LM Studio not available — skipping local model test");
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("Summary:");
  for (const [name, passed] of Object.entries(results)) {
    console.log(`  ${passed ? "✅" : "❌"} ${name}`);
  }

  const allPassed = Object.values(results).every(Boolean);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
