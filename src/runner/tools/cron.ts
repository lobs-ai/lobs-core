/**
 * Cron tool — lets the main agent manage scheduled jobs and reminders.
 */

import type { ToolDefinition } from "../types.js";
import { getCronService } from "../../services/cron.js";

export const cronToolDefinition: ToolDefinition = {
  name: "cron",
  description:
    "Manage scheduled jobs and reminders. Actions: list, add, remove, toggle. " +
    "Use schedule_kind='at' with schedule_at (ISO timestamp) for one-shot reminders. " +
    "Use schedule_kind='every' with schedule_every_ms for recurring intervals. " +
    "Use schedule_kind='cron' with schedule_expr for cron expressions.",
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
      const jobs = cronService.listJobs();
      return JSON.stringify(
        jobs.map((j) => ({
          id: j.id,
          name: j.name,
          schedule: j.schedule,
          enabled: j.enabled,
          lastFired: j.lastFired,
        })),
        null,
        2,
      );
    }
    case "add": {
      const job = cronService.addJob({
        name: (input.name as string) || "Unnamed",
        schedule: {
          kind: (input.schedule_kind as "cron" | "at" | "every") || "at",
          expr: input.schedule_expr as string | undefined,
          at: input.schedule_at as string | undefined,
          everyMs: input.schedule_every_ms as number | undefined,
        },
        payload: (input.payload as string) || "",
        enabled: true,
      });
      return JSON.stringify({ ok: true, id: job.id, name: job.name });
    }
    case "remove": {
      cronService.removeJob(input.job_id as string);
      return JSON.stringify({ ok: true });
    }
    case "toggle": {
      cronService.toggleJob(
        input.job_id as string,
        input.enabled !== false,
      );
      return JSON.stringify({ ok: true });
    }
    default:
      return `Unknown action: ${action}`;
  }
}
