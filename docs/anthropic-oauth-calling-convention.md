# Anthropic OAuth / Setup-Token Calling Convention

When using a **setup-token** (`sk-ant-oat01-*`) instead of an API key (`sk-ant-api*`), the Anthropic API enforces additional requirements. Requests that don't match Claude Code's calling convention are rejected.

This was reverse-engineered from the pi-mono reference (`packages/ai/src/providers/anthropic.ts`) and validated against our runner in March 2026.

## Why This Matters

Setup-tokens (OAuth tokens) are issued by Claude Code's OAuth flow. The Anthropic API validates that requests using these tokens look like legitimate Claude Code requests. If any of the following are missing or wrong, the API returns 400/401/403.

---

## SDK Constructor — OAuth Path

```typescript
const client = new Anthropic({
  apiKey: null,                        // MUST be null for OAuth
  authToken: token,                    // sk-ant-oat01-...
  dangerouslyAllowBrowser: true,       // Required
  defaultHeaders: {
    "accept": "application/json",
    "anthropic-dangerous-direct-browser-access": "true",   // Required
    "anthropic-beta": `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`,
    "user-agent": `claude-cli/${claudeCodeVersion}`,       // Must look like Claude CLI
    "x-app": "cli",
  },
});
```

## SDK Constructor — API Key Path

```typescript
const client = new Anthropic({
  apiKey: key,
  dangerouslyAllowBrowser: true,
  defaultHeaders: {
    "accept": "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-beta": betaFeatures.join(","),
    // No user-agent/x-app needed for API keys
  },
});
```

## Beta Features (Dynamic)

```typescript
const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];

// Only add interleaved-thinking for older models — it's built-in on 4.6 models
if (!supportsAdaptiveThinking(modelId)) {
  betaFeatures.push("interleaved-thinking-2025-05-14");
}

function supportsAdaptiveThinking(modelId: string): boolean {
  return modelId.includes("opus-4-6") || modelId.includes("opus-4.6")
      || modelId.includes("sonnet-4-6") || modelId.includes("sonnet-4.6");
}
```

## System Prompt — OAuth MUST Prepend Claude Code Identity

```typescript
const systemBlocks = [];

if (isOAuth) {
  systemBlocks.push({
    type: "text",
    text: "You are Claude Code, Anthropic's official CLI for Claude.",
    cache_control: { type: "ephemeral" },
  });
}

systemBlocks.push({
  type: "text",
  text: actualSystemPrompt,
  cache_control: { type: "ephemeral" },
});
```

## Tool Name Mapping — OAuth Requires Claude Code Canonical Names

The API validates tool names for OAuth tokens. Tools must use Claude Code's casing.

```typescript
const claudeCodeTools = [
  "Read", "Write", "Edit", "Bash", "Grep", "Glob",
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "KillShell",
  "NotebookEdit", "Skill", "Task", "TaskOutput", "TodoWrite",
  "WebFetch", "WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Outbound: our tool name → Claude Code name
const toClaudeCodeName = (name: string): string =>
  ccToolLookup.get(name.toLowerCase()) ?? name;

// Inbound: Claude Code name → our tool name (match back to original definitions)
const fromClaudeCodeName = (name: string, tools?: ToolDefinition[]): string => {
  if (tools?.length) {
    const matched = tools.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (matched) return matched.name;
  }
  return name;
};
```

**Apply in three places:**
1. **Tool definitions** sent to API: `toClaudeCodeName(tool.name)`
2. **Assistant messages in history** containing `tool_use` blocks: `toClaudeCodeName(block.name)`
3. **Response** tool_use blocks coming back: `fromClaudeCodeName(block.name, originalTools)`

## Streaming — Use `.stream()` Not `.create()`

```typescript
// OAuth path requires streaming
const stream = client.messages.stream({ ...params, stream: true });

// For collecting full response:
const response = await stream.finalMessage();

// Or for SSE event iteration (reference pattern):
for await (const event of stream) {
  if (event.type === "message_start") { /* initial usage */ }
  else if (event.type === "content_block_start") { /* new block */ }
  else if (event.type === "content_block_delta") { /* incremental content */ }
  else if (event.type === "message_delta") { /* stop_reason, final usage */ }
}
```

## Thinking Mode — Adaptive vs Budget

```typescript
// Opus 4.6 / Sonnet 4.6: adaptive thinking (Claude decides when/how much)
if (supportsAdaptiveThinking(modelId)) {
  params.thinking = { type: "adaptive" };
  // Optional effort level:
  params.output_config = { effort: "high" }; // low | medium | high | max (max = Opus only)
} else {
  // Older models: budget-based
  params.thinking = { type: "enabled", budget_tokens: 1024 };
}

// When thinking is enabled, use max_output_tokens instead of max_tokens
params.max_output_tokens = maxTokens;
```

## Quick Reference Table

| Aspect | OAuth (sk-ant-oat*) | API Key (sk-ant-api*) |
|---|---|---|
| Auth header | `Authorization: Bearer <token>` | `x-api-key: <key>` |
| SDK constructor | `apiKey: null, authToken: token` | `apiKey: key` |
| `dangerouslyAllowBrowser` | `true` | `true` |
| `anthropic-dangerous-direct-browser-access` | `"true"` | `"true"` |
| Betas | `claude-code-20250219,oauth-2025-04-20,` + features | features only |
| `user-agent` | `claude-cli/<version>` | not needed |
| `x-app` | `cli` | not needed |
| System prompt | **Must** prepend Claude Code identity | Your prompt only |
| Tool names | Mapped through `toClaudeCodeName()` | As-is |
| `service_tier` | Not set | `"auto"` or `"standard_only"` |
| `context-1m` beta | Blocked (filter out) | Allowed |

## Source

- Reference implementation: `pi-mono/packages/ai/src/providers/anthropic.ts`
- Claude Code tool name history: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
- Our implementation: `lobs-core/src/runner/providers.ts`
