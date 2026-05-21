/**
 * Dynamic tool loader — loads and executes agent-created tools from ~/.lobs/tools/
 *
 * Tools are stored as directories: ~/.lobs/tools/{name}/
 *   tool.json     — definition + metadata
 *   run.sh        — shell implementation
 *   run.ts        — TypeScript implementation
 *   steps.md      — procedural implementation
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLobsRoot } from "../../config/lobs.js";
import { execFile } from "node:child_process";
import type { ToolDefinition } from "../types.js";
import { getShellExecutable } from "./shell.js";

export interface ToolJson {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  implementation: "shell" | "typescript" | "procedural";
  created_at: string;
  created_by: string;
  version: number;
}

interface DynamicToolEntry {
  toolJson: ToolJson;
  dir: string;
}

const SHELL_TIMEOUT_MS = 30_000;
const TYPESCRIPT_TIMEOUT_MS = 30_000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, "../../..");
const TSX_IMPORT = resolve(PROJECT_ROOT, "node_modules/tsx/dist/esm/index.mjs");

export class DynamicToolLoader {
  private toolsDir: string;
  private registered: Map<string, DynamicToolEntry> = new Map();

  constructor(toolsDir?: string) {
    this.toolsDir = toolsDir ?? resolve(getLobsRoot(), "tools");
  }

  /**
   * Called once at startup — scans ~/.lobs/tools/*\/tool.json and registers each.
   */
  loadAll(): void {
    if (!existsSync(this.toolsDir)) {
      mkdirSync(this.toolsDir, { recursive: true });
      return;
    }

    const entries = readdirSync(this.toolsDir, { withFileTypes: true });
    let loaded = 0;
    let failed = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const toolJsonPath = join(this.toolsDir, entry.name, "tool.json");
      if (!existsSync(toolJsonPath)) continue;

      try {
        const raw = readFileSync(toolJsonPath, "utf-8");
        const toolJson = JSON.parse(raw) as ToolJson;
        this.registered.set(toolJson.name, {
          toolJson,
          dir: join(this.toolsDir, entry.name),
        });
        loaded++;
      } catch (err) {
        console.warn(`[dynamic-tools] Failed to load tool at ${toolJsonPath}: ${err}`);
        failed++;
      }
    }

    if (loaded > 0 || failed > 0) {
      console.log(`[dynamic-tools] Loaded ${loaded} dynamic tool(s)${failed > 0 ? `, ${failed} failed` : ""}`);
    }
  }

  /**
   * Hot-register a tool (called by tool_manage after create/edit).
   */
  register(name: string, toolJson: ToolJson, dir: string): void {
    this.registered.set(name, { toolJson, dir });
  }

  /**
   * Remove a tool from the in-memory registry.
   */
  deregister(name: string): void {
    this.registered.delete(name);
  }

  /**
   * Get all registered dynamic tool definitions (for merging into getToolDefinitions).
   */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.registered.values()).map(({ toolJson }) => ({
      name: toolJson.name,
      description: toolJson.description,
      input_schema: toolJson.input_schema,
    }));
  }

  /**
   * Execute a dynamic tool by name.
   */
  async execute(name: string, params: Record<string, unknown>, cwd: string): Promise<string> {
    const entry = this.registered.get(name);
    if (!entry) {
      throw new Error(`Dynamic tool not found: ${name}`);
    }

    const { toolJson, dir } = entry;

    switch (toolJson.implementation) {
      case "shell":
        return this.executeShell(dir, params, cwd);
      case "typescript":
        return this.executeTypeScript(dir, params, cwd);
      case "procedural":
        return this.executeProcedural(dir);
      default:
        throw new Error(`Unknown implementation type: ${(toolJson as ToolJson).implementation}`);
    }
  }

  /**
   * Check if a name is a registered dynamic tool.
   */
  has(name: string): boolean {
    return this.registered.has(name);
  }

  /**
   * Return the tool directory path for a given tool name.
   */
  getToolDir(name: string): string {
    return join(this.toolsDir, name);
  }

  /**
   * Return the base tools directory.
   */
  getToolsDir(): string {
    return this.toolsDir;
  }

  // ─── private execution methods ────────────────────────────────────────────

  private executeShell(dir: string, params: Record<string, unknown>, cwd: string): Promise<string> {
    const scriptPath = join(dir, "run.sh");
    if (!existsSync(scriptPath)) {
      throw new Error("Shell implementation file (run.sh) not found");
    }

    // Pass params as TOOL_<PARAM> env vars
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    for (const [key, value] of Object.entries(params)) {
      env[`TOOL_${key.toUpperCase()}`] = String(value ?? "");
    }

    return new Promise((resolve, reject) => {
      execFile(getShellExecutable(), [scriptPath], {
        env,
        cwd,
        timeout: SHELL_TIMEOUT_MS,
      }, (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || error.message;
          reject(new Error(`Shell tool failed: ${message}`));
          return;
        }
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        resolve(output || "(no output)");
      });
    });
  }

  private executeTypeScript(dir: string, params: Record<string, unknown>, cwd: string): Promise<string> {
    const scriptPath = join(dir, "run.ts");
    if (!existsSync(scriptPath)) {
      throw new Error("TypeScript implementation file (run.ts) not found");
    }

    const wrapperPath = join(tmpdir(), `lobs-dynamic-tool-${process.pid}-${Date.now()}.mjs`);
    const wrapper = `
import { pathToFileURL } from "node:url";

const scriptPath = process.argv[2];
const params = JSON.parse(process.env.LOBS_TOOL_INPUT ?? "{}");
const mod = await import(pathToFileURL(scriptPath).href + "?t=" + Date.now());
const tool = mod.default ?? mod.run;

if (typeof tool !== "function") {
  throw new Error("TypeScript tool must export a default function or named run function");
}

const result = await tool(params);
if (typeof result === "string") {
  console.log(result);
} else if (result !== undefined) {
  console.log(JSON.stringify(result, null, 2));
}
`;
    writeFileSync(wrapperPath, wrapper, "utf-8");

    return new Promise((resolve, reject) => {
      execFile(process.execPath, ["--import", TSX_IMPORT, wrapperPath, scriptPath], {
        cwd,
        timeout: TYPESCRIPT_TIMEOUT_MS,
        env: {
          ...process.env,
          LOBS_TOOL_INPUT: JSON.stringify(params),
        },
      }, (error, stdout, stderr) => {
        rmSync(wrapperPath, { force: true });
        if (error) {
          const message = stderr.trim() || error.message;
          reject(new Error(`TypeScript tool failed: ${message}`));
          return;
        }
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        resolve(output || "(no output)");
      }).on("error", () => {
        rmSync(wrapperPath, { force: true });
      });
    });
  }

  private executeProcedural(dir: string): Promise<string> {
    const stepsPath = join(dir, "steps.md");
    if (!existsSync(stepsPath)) {
      throw new Error("Procedural implementation file (steps.md) not found");
    }
    const content = readFileSync(stepsPath, "utf-8");
    return Promise.resolve(content);
  }
}

// ─── singleton ────────────────────────────────────────────────────────────────

let _loader: DynamicToolLoader | null = null;

/**
 * Initialize the singleton DynamicToolLoader and load all persisted tools.
 * Must be called once during startup (after fs is ready).
 */
export function initDynamicToolLoader(toolsDir?: string): DynamicToolLoader {
  _loader = new DynamicToolLoader(toolsDir);
  _loader.loadAll();
  return _loader;
}

/**
 * Get the singleton loader. Returns null if not yet initialized.
 */
export function getDynamicToolLoader(): DynamicToolLoader | null {
  return _loader;
}
