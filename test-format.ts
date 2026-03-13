import { formatBytes } from "./src/util/format.js";

console.log("Testing formatBytes function:\n");

const tests = [
  { input: 0, expected: "0 B" },
  { input: 1024, expected: "1.0 KB" },
  { input: 1536, decimals: 2, expected: "1.50 KB" },
  { input: 1048576, expected: "1.0 MB" },
  { input: 512, expected: "512.0 B" },
  { input: 1073741824, expected: "1.0 GB" },
];

for (const test of tests) {
  const result = "decimals" in test 
    ? formatBytes(test.input, test.decimals) 
    : formatBytes(test.input);
  const pass = result === test.expected ? "✅" : "❌";
  console.log(`${pass} formatBytes(${test.input}${test.decimals ? `, ${test.decimals}` : ""}) = "${result}" (expected: "${test.expected}")`);
}

// Test error case
console.log("\nTesting error case:");
try {
  formatBytes(-100);
  console.log("❌ Should have thrown error for negative input");
} catch (err) {
  console.log("✅ Correctly threw error for negative input:", (err as Error).message);
}
