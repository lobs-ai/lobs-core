import { librarianAskTool } from "./src/runner/tools/librarian.js";

async function run() {
  const result = await librarianAskTool(
    { question: "What did we decide about the Ship ADR?", scope: "decisions" },
    process.cwd()
  );
  console.log("=== TOOL RESULT ===");
  console.log(result);
  console.log("=== END RESULT ===");
}

run().catch(console.error);
