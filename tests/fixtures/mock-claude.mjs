#!/usr/bin/env node
/**
 * Mock `claude` binary for tests of ClaudeCliClient.
 *
 * Behavior is driven by env vars:
 *   MOCK_CLAUDE_MODE   = "text" | "fail" | "echo-argv" | "echo-stdin" | "error-result" | "error-result-fail"
 *   MOCK_CLAUDE_TEXT   = canned assistant text (default "ok")
 *   MOCK_CLAUDE_EXIT   = exit code (default 0)
 *   MOCK_CLAUDE_STDERR = text to write to stderr
 *   MOCK_CLAUDE_LOGFILE = optional path to dump observed argv + stdin
 */
import { writeFileSync } from "node:fs";

const mode = process.env.MOCK_CLAUDE_MODE || "text";
const text = process.env.MOCK_CLAUDE_TEXT || "ok";
const exitCode = parseInt(process.env.MOCK_CLAUDE_EXIT || "0", 10);
const stderrText = process.env.MOCK_CLAUDE_STDERR || "";
const logFile = process.env.MOCK_CLAUDE_LOGFILE;

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });

process.stdin.on("end", () => {
  if (logFile) {
    writeFileSync(logFile, JSON.stringify({ argv: process.argv.slice(2), stdin }, null, 2));
  }
  if (stderrText) process.stderr.write(stderrText);

  if (mode === "fail") {
    process.exit(exitCode || 1);
  }

  // Always emit init.
  process.stdout.write(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "mock-session",
    model: "claude-haiku-4-5",
  }) + "\n");

  if (mode === "error-result") {
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "mock error from result",
      stop_reason: "end_turn",
    }) + "\n");
    process.exit(exitCode);
  }

  if (mode === "error-result-fail") {
    // Real-world shape: claude exits non-zero but stdout still contains a
    // structured result event we want to surface.
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Request failed (request id: bfdb18e5)",
      api_error_status: "529 overloaded",
      session_id: "mock-session",
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        server_tool_use: { web_search_count: 0 },
      },
    }) + "\n");
    process.exit(exitCode || 1);
  }

  // Default text mode — emit an assistant message + a success result.
  process.stdout.write(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  }) + "\n");
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    stop_reason: "end_turn",
    session_id: "mock-session",
    usage: {
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    },
  }) + "\n");
  process.exit(exitCode);
});
