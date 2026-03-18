import { describe, it } from "vitest";
import { processTool } from "../src/runner/tools/process.js";

describe("Timeout Debug", () => {
  it("debug timeout", async () => {
    const r = await processTool({ action: "start", command: "sleep 100", timeout: 1 }, "/tmp");
    const { sessionId } = JSON.parse(r);
    console.log("Started:", sessionId);

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      const p = await processTool({ action: "poll", sessionId }, "/tmp");
      const d = JSON.parse(p);
      console.log(`t=${(i+1)*200}ms: status=${d.status} exitCode=${d.exitCode} timedOut=${d.timedOut}`);
      if (d.status === "exited") break;
    }
  }, 8000);
});
