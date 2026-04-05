/**
 * ToolManager — runtime registry for conditionally enabled/disabled tools.
 *
 * By default all tools are enabled. Individual tools can be disabled
 * (e.g., `discord` for Nexus sessions to avoid bloating every prompt).
 * The agent can toggle tools via `tool_manage enable/disable` actions.
 *
 * Disabled tools are excluded from getToolDefinitions() and blocked at
 * executeTool() time, so they never appear in the prompt and can't be called.
 */

import type { ToolName } from "../types.js";

// Tools that start disabled (only enabled on-demand)
const DEFAULT_DISABLED: ToolName[] = ["discord"];

class ToolManager {
  private disabled: Set<ToolName> = new Set(DEFAULT_DISABLED);

  /** Disable a tool. */
  disable(name: ToolName): void {
    this.disabled.add(name);
    console.log(`[tool-manager] Disabled: ${name}`);
  }

  /** Enable a tool. */
  enable(name: ToolName): void {
    this.disabled.delete(name);
    console.log(`[tool-manager] Enabled: ${name}`);
  }

  /** Returns true if the tool is currently enabled. */
  isEnabled(name: ToolName): boolean {
    return !this.disabled.has(name);
  }

  /** Returns all currently enabled tools from a given list. */
  filterEnabled(tools: ToolName[]): ToolName[] {
    return tools.filter((t) => this.isEnabled(t));
  }

  /** List tools that are currently disabled. */
  listDisabled(): ToolName[] {
    return Array.from(this.disabled);
  }
}

// ─── singleton ────────────────────────────────────────────────────────────────

let _instance: ToolManager | null = null;

export function initToolManager(): ToolManager {
  _instance = new ToolManager();
  return _instance;
}

export function getToolManager(): ToolManager {
  if (!_instance) {
    // Lazy init (should only happen in tests)
    _instance = new ToolManager();
  }
  return _instance;
}
