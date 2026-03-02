/**
 * Escalation Manager — tiered failure handling.
 * Port of lobs-server/app/orchestrator/escalation.py + escalation_enhanced.py
 *
 * Tiers:
 *   0 = auto-retry (handled by control loop)
 *   1 = alert creation
 *   2 = agent_switch (try different agent type)
 *   3 = diagnostic (spawn diagnostic session)
 *   4 = human escalation (inbox alert, high severity)
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, inboxItems } from "../db/schema.js";
import { log } from "../util/logger.js";

export const ESCALATION_TIERS = {
  RETRY: 0,
  ALERT: 1,
  AGENT_SWITCH: 2,
  DIAGNOSTIC: 3,
  HUMAN: 4,
} as const;

export type EscalationTier = typeof ESCALATION_TIERS[keyof typeof ESCALATION_TIERS];

export interface EscalationResult {
  tier: EscalationTier;
  action: string;
  alertId?: string;
  newAgentType?: string;
}

export class EscalationManager {
  /**
   * Determine next escalation tier for a task and execute it.
   */
  escalate(taskId: string, projectId: string, errorLog: string, currentTier: EscalationTier = 0): EscalationResult {
    const db = getDb();
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    const taskTitle = task?.title ?? taskId.slice(0, 8);
    const nextTier = Math.min(currentTier + 1, ESCALATION_TIERS.HUMAN) as EscalationTier;

    // Update task escalation tier
    db.update(tasks).set({ escalationTier: nextTier, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId)).run();

    log().warn(`[ESCALATION] Task ${taskId.slice(0, 8)} → tier ${nextTier} (${_tierName(nextTier)})`);

    switch (nextTier) {
      case ESCALATION_TIERS.ALERT: {
        const alertId = this.createFailureAlert(taskId, projectId, taskTitle, errorLog, "medium");
        return { tier: nextTier, action: "alert_created", alertId };
      }
      case ESCALATION_TIERS.AGENT_SWITCH: {
        const newAgent = this._pickAlternativeAgent(task?.agent ?? "programmer");
        db.update(tasks).set({ agent: newAgent, workState: "not_started", updatedAt: new Date().toISOString() })
          .where(eq(tasks.id, taskId)).run();
        const alertId = this.createFailureAlert(taskId, projectId, taskTitle,
          `Auto-switched from ${task?.agent} → ${newAgent}\n\n${errorLog}`, "medium");
        return { tier: nextTier, action: "agent_switched", newAgentType: newAgent, alertId };
      }
      case ESCALATION_TIERS.DIAGNOSTIC: {
        const alertId = this.createFailureAlert(taskId, projectId, taskTitle,
          `**Diagnostic trigger** — task has failed ${nextTier} times.\n\n${errorLog}`, "high");
        return { tier: nextTier, action: "diagnostic_triggered", alertId };
      }
      case ESCALATION_TIERS.HUMAN:
      default: {
        const alertId = this.createFailureAlert(taskId, projectId, taskTitle,
          `**🚨 HUMAN INTERVENTION REQUIRED** — all automated recovery exhausted.\n\n${errorLog}`, "critical");
        db.update(tasks).set({ status: "waiting_on", updatedAt: new Date().toISOString() })
          .where(eq(tasks.id, taskId)).run();
        return { tier: nextTier, action: "human_escalated", alertId };
      }
    }
  }

  createFailureAlert(taskId: string, projectId: string, taskTitle: string, errorLog: string, severity = "medium"): string {
    const db = getDb();
    const alertId = `alert_${taskId.slice(0, 8)}_${Date.now()}`;
    const now = new Date().toISOString();
    const body = `**Task ID:** \`${taskId}\`\n**Project:** \`${projectId}\`\n**Severity:** ${severity}\n\n**Error:**\n\`\`\`\n${errorLog.slice(0, 1000)}\n\`\`\``;
    try {
      db.insert(inboxItems).values({
        id: alertId,
        title: `🚨 Task Failure: ${taskTitle}`,
        content: body,
        summary: `Task ${taskId.slice(0, 8)} failed in ${projectId}`,
        isRead: false,
        modifiedAt: now,
      }).run();
      log().info(`[ESCALATION] Created alert ${alertId} (severity=${severity})`);
    } catch (e) {
      log().error(`[ESCALATION] Failed to create alert: ${String(e)}`);
    }
    return alertId;
  }

  escalateStuckTask(taskId: string, projectId: string, durationMinutes: number): string {
    const db = getDb();
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    const taskTitle = task?.title ?? taskId.slice(0, 8);
    const severity = durationMinutes > 60 ? "critical" : "high";
    const alertId = `stuck_${taskId.slice(0, 8)}_${Date.now()}`;
    const now = new Date().toISOString();
    try {
      db.insert(inboxItems).values({
        id: alertId,
        title: `⏰ Task Timeout: ${taskTitle}`,
        content: `**Task ID:** \`${taskId}\`\n**Project:** \`${projectId}\`\n**Duration:** ${durationMinutes} minutes\n\nThis task may be stuck.`,
        summary: `Task ${taskId.slice(0, 8)} stuck for ${durationMinutes}m`,
        isRead: false,
        modifiedAt: now,
      }).run();
    } catch (e) {
      log().error(`[ESCALATION] Failed to create stuck alert: ${String(e)}`);
    }
    return alertId;
  }

  private _pickAlternativeAgent(currentAgent: string): string {
    const alternatives: Record<string, string> = {
      programmer: "architect",
      architect: "programmer",
      researcher: "programmer",
      writer: "researcher",
      reviewer: "programmer",
    };
    return alternatives[currentAgent] ?? "programmer";
  }
}

function _tierName(tier: EscalationTier): string {
  return Object.entries(ESCALATION_TIERS).find(([, v]) => v === tier)?.[0].toLowerCase() ?? "unknown";
}
