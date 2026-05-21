// End-to-end smoke test: ClaudeCliClient + real claude binary + MCP server.
// Asks claude to call our "Add" tool and verify the result.
//   node scripts/smoke-claude-cli-tools.mjs
import { ClaudeCliClient } from "../dist/runner/claude-cli-client.js";

const modelRef = process.argv[2] || "claude-cli/haiku";
const modelId = modelRef.includes("/") ? modelRef.split("/").slice(1).join("/") : modelRef;

let observedCall = null;

const client = new ClaudeCliClient(modelId);
const response = await client.createMessage({
  model: modelId,
  system: "When you need to add two numbers, you MUST call the Add tool. Do not compute it yourself.",
  messages: [{ role: "user", content: "What is 17 plus 25? Use the Add tool." }],
  tools: [
    {
      name: "Add",
      description: "Add two integers and return the sum.",
      input_schema: {
        type: "object",
        properties: {
          a: { type: "integer", description: "first addend" },
          b: { type: "integer", description: "second addend" },
        },
        required: ["a", "b"],
      },
    },
  ],
  maxTokens: 200,
  toolExecutor: async (name, input) => {
    observedCall = { name, input };
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return { content: String(a + b) };
  },
});

const textBlock = response.content.find((b) => b.type === "text");
console.log(`[smoke] toolCalled=${JSON.stringify(observedCall)}`);
console.log(`[smoke] stop=${response.stopReason} text=${JSON.stringify(textBlock?.text ?? "")}`);
console.log(`[smoke] usage=${JSON.stringify(response.usage)}`);

if (!observedCall) {
  console.error("[smoke] FAIL: tool was never called");
  process.exit(1);
}
if (textBlock?.text?.includes("42")) {
  console.log("[smoke] PASS: response includes 42");
} else {
  console.warn("[smoke] WARN: response didn't include 42, but tool was called");
}
