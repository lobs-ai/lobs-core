import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DynamicToolLoader } from "../src/runner/tools/dynamic-tools.js";

let toolRoot: string | null = null;

function makeToolRoot(): string {
  toolRoot = join(tmpdir(), `lobs-dynamic-tools-test-${process.pid}-${Date.now()}`);
  mkdirSync(toolRoot, { recursive: true });
  return toolRoot;
}

afterEach(() => {
  if (toolRoot) {
    rmSync(toolRoot, { recursive: true, force: true });
    toolRoot = null;
  }
});

describe("DynamicToolLoader", () => {
  it("executes TypeScript tools instead of returning their source", async () => {
    const root = makeToolRoot();
    const dir = join(root, "native-tool");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tool.json"), JSON.stringify({
      name: "native-tool",
      description: "test native ts tool",
      input_schema: {
        type: "object",
        properties: {
          args: { type: "array", items: { type: "string" } },
        },
      },
      implementation: "typescript",
    }));
    writeFileSync(join(dir, "run.ts"), `
export default async function run(input: { args?: string[] } = {}) {
  return {
    command: ["/opt/homebrew/bin/lobs", ...(input.args ?? [])].join(" "),
    ok: true,
  };
}
`);

    const loader = new DynamicToolLoader(root);
    loader.loadAll();

    const output = await loader.execute("native-tool", { args: ["status"] }, root);

    expect(output).toContain("/opt/homebrew/bin/lobs status");
    expect(output).toContain('"ok": true');
    expect(output).not.toContain("export default async function");
  });
});
