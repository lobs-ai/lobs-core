/**
 * Shared types for PAW plugin.
 */

export type AgentType = "programmer" | "writer" | "researcher" | "reviewer" | "architect";

export type TaskStatus = "inbox" | "active" | "completed" | "rejected" | "waiting_on";
export type WorkState = "not_started" | "in_progress" | "needs_review" | "done" | "failed";

export type ModelTier = "micro" | "small" | "medium" | "standard" | "strong";

export type ApprovalTier = "auto" | "bot" | "owner";

export interface PawConfig {
  dbPath?: string;
  scanIntervalMs?: number;
  maxConcurrentWorkers?: number;
  defaultModelTier?: ModelTier;
}

export interface WorkerState {
  sessionKey: string;
  taskId: string;
  agentType: AgentType;
  projectId?: string;
  model?: string;
  startedAt: number;
}
