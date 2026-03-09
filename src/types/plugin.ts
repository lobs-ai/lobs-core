/**
 * PAW Plugin System — type definitions
 */

export interface UIAffordance {
  id: string;          // "summarize-button", "reply-chips", etc.
  type: "button" | "chips" | "inline-text" | "badge" | "rewrite-menu" | "context-panel";
  target: string;      // where it appears: "task-card", "inbox-message", "calendar-event", "text-input", "pr-widget"
  label?: string;
  icon?: string;
  aiAction: string;    // what the AI does: "summarize", "suggest-reply", "explain", "rewrite", "generate"
  config?: Record<string, unknown>;
}

export interface PawPlugin {
  id: string;
  name: string;
  description: string;
  category: "dev" | "academic" | "productivity" | "lifestyle";
  enabled: boolean;
  config: Record<string, unknown>;
  configSchema: Record<string, unknown>;
  uiAffordances: UIAffordance[];
}
