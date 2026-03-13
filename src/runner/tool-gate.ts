/**
 * Tool gating — policy enforcement for agent tool access.
 *
 * Uses the hook system to deny tool calls based on agent type.
 * - Reviewer: read-only (deny write, edit, exec)
 * - Architect: design-only (deny exec)
 * - All agents: deny tools not in their toolset
 */

import { getHookRegistry, type HookEvent } from "./hooks.js";
import type { ToolName } from "./types.js";
import { log } from "../util/logger.js";

export interface ToolGateConfig {
  // Tools that are always allowed (empty = no blanket allow)
  alwaysAllow: string[];
  
  // Tools that need confirmation (not implemented yet, just flag)
  requireConfirmation: string[];
  
  // Tools that are denied for certain agent types
  denyByAgent: Record<string, string[]>;
  
  // Max exec timeout override per agent type (seconds)
  maxExecTimeout: Record<string, number>;
}

const DEFAULT_CONFIG: ToolGateConfig = {
  alwaysAllow: [],
  requireConfirmation: [],
  denyByAgent: {
    // Reviewer is read-only
    reviewer: ["write", "edit", "exec"],
    
    // Architect writes design docs, but doesn't run code
    architect: ["exec"],
  },
  maxExecTimeout: {
    // Reviewers get no exec anyway, but be defensive
    reviewer: 0,
    
    // Architects don't need exec
    architect: 0,
    
    // Programmers get full timeout
    programmer: 300,
    
    // Writers don't run code
    writer: 10,
    
    // Researchers may need to run analysis scripts
    researcher: 60,
  },
};

/**
 * Tool gate hook handler.
 * Returns null to deny the tool call.
 */
async function toolGateHandler(event: HookEvent): Promise<HookEvent | null> {
  const { agentType, data } = event;
  const toolName = data.toolName as string;
  const allowedTools = data.allowedTools as string[] | undefined;
  const config = DEFAULT_CONFIG;

  // Check if tool is in agent's allowed toolset
  if (allowedTools && !allowedTools.includes(toolName)) {
    log().info(`[tool-gate] Denied ${toolName} for ${agentType}: not in agent toolset`);
    event.data.denied = true;
    event.data.reason = `Tool "${toolName}" is not available to ${agentType} agents`;
    return null;
  }

  // Check agent-specific denials
  const deniedForAgent = config.denyByAgent[agentType] ?? [];
  if (deniedForAgent.includes(toolName)) {
    log().info(`[tool-gate] Denied ${toolName} for ${agentType}: agent policy`);
    event.data.denied = true;
    event.data.reason = `Tool "${toolName}" is denied for ${agentType} agents`;
    return null;
  }

  // Apply exec timeout override
  if (toolName === "exec" && data.params) {
    const params = data.params as Record<string, unknown>;
    const maxTimeout = config.maxExecTimeout[agentType];
    
    if (maxTimeout !== undefined) {
      const requestedTimeout = (params.timeout as number) ?? 30;
      
      if (requestedTimeout > maxTimeout) {
        log().info(`[tool-gate] Capped exec timeout for ${agentType}: ${requestedTimeout}s → ${maxTimeout}s`);
        params.timeout = maxTimeout;
        event.data.params = params;
      }
    }
  }

  // Allowed
  return event;
}

/**
 * Initialize tool gating.
 * Call this once at startup to register the hook.
 */
export function initToolGate(config?: Partial<ToolGateConfig>): void {
  const registry = getHookRegistry();
  
  // Merge config if provided
  if (config) {
    Object.assign(DEFAULT_CONFIG, config);
  }
  
  // Register as high-priority hook (runs early)
  registry.register("before_tool_call", toolGateHandler, 100);
  
  log().info("[tool-gate] Initialized");
}

/**
 * Get current tool gate configuration.
 */
export function getToolGateConfig(): ToolGateConfig {
  return { ...DEFAULT_CONFIG };
}
