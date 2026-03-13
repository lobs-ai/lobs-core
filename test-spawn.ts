import { executeSpawnAgent } from "./src/runner/tools/agent-control.js";

const input = {
  agent_type: "reviewer",
  task: `Review the formatBytes utility function in ~/lobs/lobs-core/src/util/format.ts

Check for:
1. Correctness - does it properly convert bytes to KB/MB/GB/etc?
2. Edge cases - does it handle 0, negative numbers, very large numbers?
3. Code quality - is the implementation clean and maintainable?
4. Documentation - are the JSDoc comments accurate and helpful?

Provide specific feedback on any issues found.

Expected behavior:
- formatBytes(1024) should return '1.0 KB'
- formatBytes(1048576) should return '1.0 MB'
- formatBytes(0) should return '0 B'`,
  model_tier: "small",
  timeout: 300
};

const result = await executeSpawnAgent(input, process.cwd());
console.log(result);
