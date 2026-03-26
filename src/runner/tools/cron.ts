/**
 * Cron tool — lets the main agent manage scheduled jobs and reminders.
 *
 * System jobs (heartbeat, memory-condensation) are visible in `list` but
 * can only be toggled — they cannot be added or removed via this tool.
 */

import type { ToolDefinition } from "../types.js";
import { getCronService } from "../../services/cron.js";

export const cronToolDefinition: ToolDefinition = {
  name: "cron",
  description:
    "Manage scheduled jobs and reminders. Actions: list, add, remove, toggle. " +
    "Use schedule_kind='at' with schedule_at (ISO timestamp) for one-shot reminders. " +
    "Use schedule_kind='every' with schedule_every_ms for recurring intervals. " +
    "Use schedule_kind='cron' with schedule_expr for cron expressions. " +
    "System jobs (heartbeat, memory-condensation) are visible but can only be toggled, not added or removed.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "add", "remove", "toggle"],
        description: "Action to perform",
      },
      name: {
        type: "string",
        description: "Job name (for add)",
      },
      schedule_kind: {
        type: "string",
        enum: ["cron", "at", "every"],
        description: "Schedule type",
      },
      schedule_expr: {
        type: "string",
        description: "Cron expression (e.g. '*/30 * * * *')",
      },
      schedule_at: {
        type: "string",
        description: "ISO timestamp for one-shot jobs (e.g. '2025-03-15T14:00:00-04:00')",
      },
      schedule_every_ms: {
        type: "number",
        description: "Interval in milliseconds (for kind=every)",
      },
      payload: {
        type: "string",
        description: "Text to inject as a system event when the job fires",
      },
      payload_kind: {
        type: "string",
        enum: ["agent", "script", "standup"],
        description:
          "Execution mode: 'agent' fires text into the LLM, 'script' runs a shell command directly without LLM, 'standup' gathers project data (git, PRs, issues, tasks) first then fires the LLM with pre-loaded context. Default: 'agent'.",
      },
      channel_id: {
        type: "string",
        description:
          "Discord channel ID to post the job's replies to. If omitted, output goes to the default alerts channel.",
      },
      job_id: {
        type: "string",
        description: "Job ID (for remove/toggle)",
      },
      enabled: {
        type: "boolean",
        description: "Enable/disable (for toggle)",
      },
    },
    required: ["action"],
  },
};

export async function executeCronTool(
  input: Record<string, unknown>,
): Promise<string> {
  const cronService = getCronService();
  if (!cronService) return "Error: Cron service not initialized";

  const action = input.action as string;

  switch (action) {
    case "list": {
      const jobs = cronService.listAllJobs();
      return JSON.stringify(
        jobs.map((j) => ({
          id: j.id,
          name: j.name,
          kind: j.kind,
          payloadKind: j.payloadKind,
          schedule: j.schedule,
          enabled: j.enabled,
          lastRun: j.lastRun,
        })),
        null,
        2,
      );
    }
    case "add": {
      const job = cronService.addAgentJob({
        name: (input.name as string) || "Unnamed",
        schedule: {
          kind: (input.schedule_kind as "cron" | "at" | "every") || "at",
          expr: input.schedule_expr as string | undefined,
          at: input.schedule_at as string | undefined,
          everyMs: input.schedule_every_ms as number | undefined,
        },
        payload: (input.payload as string) || "",
        payloadKind: (input.payload_kind as "agent" | "script" | "standup") || "agent",
        enabled: true,
        channelId: (input.channel_id as string) || undefined,
      });
      return JSON.stringify({ ok: true, id: job.id, name: job.name });
    }
    case "remove": {
      const jobId = input.job_id as string;
      // Prevent removing system jobs
      const all = cronService.listAllJobs();
      const found = all.find((j) => j.id === jobId);
      if (found?.kind === "system") {
        return JSON.stringify({ ok: false, error: "System jobs cannot be removed. Use toggle to disable." });
      }
      cronService.removeAgentJob(jobId);
      return JSON.stringify({ ok: true });
    }
    case "toggle": {
      const jobId = input.job_id as string;
      const shouldEnable = input.enabled !== false;
      // Check if it's a system job or agent job
      const all = cronService.listAllJobs();
      const found = all.find((j) => j.id === jobId);
      if (found?.kind === "system") {
        const ok = cronService.toggleSystemJob(jobId, shouldEnable);
        return JSON.stringify({ ok });
      } else {
        cronService.toggleAgentJob(jobId, shouldEnable);
        return JSON.stringify({ ok: true });
      }
    }
    default:
      return `Unknown action: ${action}`;
  }
}
