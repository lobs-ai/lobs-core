/**
 * Hook system — event interception for agent runner.
 *
 * Allows modifying behavior at key points:
 * - Before/after agent starts/ends
 * - Before/after tool calls (can deny or modify)
 * - Before/after LLM calls
 * - After context assembly or compaction
 * - On errors
 */

export type HookName =
  | "before_agent_start"   // Before agent loop begins
  | "after_agent_end"      // After agent completes
  | "before_tool_call"     // Before executing a tool (can modify/deny)
  | "after_tool_call"      // After tool returns (can modify result)
  | "before_llm_call"      // Before calling the LLM API
  | "after_llm_call"       // After LLM response
  | "context_assembled"    // After context engine assembles context
  | "session_compacted"    // After mid-run compaction
  | "on_error";            // On any error

export interface HookEvent {
  hookName: HookName;
  agentType: string;
  taskId?: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

export type HookHandler = (event: HookEvent) => Promise<HookEvent | null>; // null = cancel

interface HookRegistration {
  handler: HookHandler;
  priority: number;
}

/**
 * Singleton hook registry.
 * Handlers are called in priority order (higher number = earlier).
 */
export class HookRegistry {
  private hooks: Map<HookName, HookRegistration[]> = new Map();

  /**
   * Register a hook handler.
   * @param hook - Hook name to listen for
   * @param handler - Handler function (return null to cancel)
   * @param priority - Execution order (higher = earlier, default 0)
   */
  register(hook: HookName, handler: HookHandler, priority: number = 0): void {
    const existing = this.hooks.get(hook) ?? [];
    existing.push({ handler, priority });
    // Sort by priority descending
    existing.sort((a, b) => b.priority - a.priority);
    this.hooks.set(hook, existing);
  }

  /**
   * Unregister a hook handler.
   */
  unregister(hook: HookName, handler: HookHandler): void {
    const existing = this.hooks.get(hook);
    if (!existing) return;
    
    const filtered = existing.filter((reg) => reg.handler !== handler);
    if (filtered.length === 0) {
      this.hooks.delete(hook);
    } else {
      this.hooks.set(hook, filtered);
    }
  }

  /**
   * Emit a hook event.
   * Handlers are called in priority order.
   * If any handler returns null, the event is cancelled.
   * @returns Modified event, or null if cancelled
   */
  async emit(event: HookEvent): Promise<HookEvent | null> {
    const handlers = this.hooks.get(event.hookName);
    if (!handlers || handlers.length === 0) {
      return event;
    }

    let current: HookEvent | null = event;

    for (const { handler } of handlers) {
      if (current === null) break;
      
      try {
        current = await handler(current);
      } catch (error) {
        console.error(`[hooks] Error in ${event.hookName} handler:`, error);
        // Continue to next handler on error
      }
    }

    return current;
  }

  /**
   * Get count of registered handlers for a hook.
   */
  getHandlerCount(hook: HookName): number {
    return this.hooks.get(hook)?.length ?? 0;
  }

  /**
   * Clear all handlers for a hook (or all hooks if none specified).
   */
  clear(hook?: HookName): void {
    if (hook) {
      this.hooks.delete(hook);
    } else {
      this.hooks.clear();
    }
  }
}

// Singleton instance
const registry = new HookRegistry();

export function getHookRegistry(): HookRegistry {
  return registry;
}
