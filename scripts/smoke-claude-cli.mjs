// Smoke test the claude-cli client directly. Bypasses providers.ts because
// the broader module graph has unrelated unmet deps in this sandbox.
//   node scripts/smoke-claude-cli.mjs [claude-cli/haiku|opus|sonnet]
import { createClaudeCliClient } from "../dist/runner/claude-cli-client.js";

const modelRef = process.argv[2] || "claude-cli/haiku";
const modelId = modelRef.includes("/") ? modelRef.split("/").slice(1).join("/") : modelRef;

console.log(`[smoke] modelRef=${modelRef} modelId=${modelId}`);
const client = createClaudeCliClient(modelId, { sessionId: "smoke-test" });
const response = await client.createMessage({
  model: modelId,
  system: "Reply with exactly one short sentence. No preamble.",
  messages: [{ role: "user", content: "Say hello in 4 words or fewer." }],
  tools: [],
  maxTokens: 64,
});

const textBlock = response.content.find((b) => b.type === "text");
console.log(`[smoke] stop=${response.stopReason} text=${JSON.stringify(textBlock?.text ?? "")}`);
console.log(`[smoke] usage=${JSON.stringify(response.usage)}`);

// Now exercise the tool-rejection path
console.log(`[smoke] rejecting tools…`);
try {
  await client.createMessage({
    model: modelId,
    system: "",
    messages: [{ role: "user", content: "noop" }],
    tools: [{ name: "fake", description: "fake", input_schema: { type: "object", properties: {} } }],
    maxTokens: 16,
  });
  console.log(`[smoke] FAIL: tools didn't reject`);
  process.exit(1);
} catch (err) {
  console.log(`[smoke] ok: tool rejection — ${err.message.slice(0, 80)}…`);
}
