#!/usr/bin/env node
/**
 * Mock `claude` binary for tests of ClaudeCliClient.
 *
 * Behavior is driven by env vars:
 *   MOCK_CLAUDE_MODE   = "text" | "fail" | "echo-argv" | "echo-stdin" | "error-result" | "error-result-fail" | "overage-rejected-but-allowed" | "quota-truly-exhausted" | "auth-401" | "auth-401-then-text"
 *   MOCK_CLAUDE_TEXT   = canned assistant text (default "ok")
 *   MOCK_CLAUDE_EXIT   = exit code (default 0)
 *   MOCK_CLAUDE_STDERR = text to write to stderr
 *   MOCK_CLAUDE_LOGFILE = optional path to dump observed argv + stdin
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";

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

  if (mode === "auth-401") {
    // Synthesizes the exact shape claude-cli emits on 401: subtype="success"
    // (the turn completed) but is_error=true with the synthetic auth message.
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      api_error_status: "401",
      session_id: "mock-session-58e88",
    }) + "\n");
    process.exit(exitCode || 1);
  }

  if (mode === "auth-401-then-text") {
    // Stateful via a counter file: first spawn returns 401, second returns text.
    // Used to verify ClaudeCliClient retries OAuth-race 401s in-process.
    const counterFile = process.env.MOCK_CLAUDE_STATE_FILE;
    if (!counterFile) {
      process.stderr.write("auth-401-then-text mode requires MOCK_CLAUDE_STATE_FILE\n");
      process.exit(2);
    }
    const count = existsSync(counterFile)
      ? parseInt(readFileSync(counterFile, "utf8").trim() || "0", 10)
      : 0;
    writeFileSync(counterFile, String(count + 1));
    if (count === 0) {
      process.stdout.write(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        api_error_status: "401",
        session_id: "mock-session-retry",
      }) + "\n");
      process.exit(1);
    }
    // Second spawn: success.
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
      session_id: "mock-session-retry",
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }) + "\n");
    process.exit(0);
  }

  if (mode === "overage-rejected-but-allowed") {
    // Org has overage billing disabled — every rate_limit_event has
    // overageStatus=rejected, but status=allowed means there IS quota left.
    // Combined with an unrelated structured error, this used to be
    // misclassified as quota exhaustion. The error should surface as-is.
    process.stdout.write(JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: Math.floor(Date.now() / 1000) + 3600,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled_until",
        isUsingOverage: false,
      },
    }) + "\n");
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Request failed (request id: deadbeef)",
      api_error_status: "529 overloaded",
      session_id: "mock-session",
    }) + "\n");
    process.exit(exitCode || 1);
  }

  if (mode === "quota-truly-exhausted") {
    // status=exceeded_limit — bucket is actually empty. Should be classified
    // as quota exhaustion with retry_after derived from resetsAt.
    process.stdout.write(JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "exceeded_limit",
        resetsAt: Math.floor(Date.now() / 1000) + 900,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled_until",
        isUsingOverage: false,
      },
    }) + "\n");
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "Your organization has disabled Claude subscription access for Claude Code",
      session_id: "mock-session",
    }) + "\n");
    process.exit(exitCode || 1);
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
