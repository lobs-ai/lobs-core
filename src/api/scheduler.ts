import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseBody } from "./index.js";
import { getCronService } from "../services/cron.js";
import { getSchedulerIntelligenceSnapshot } from "../services/scheduler-intelligence.js";

/**
 * Scheduler endpoint — manage cron jobs via the CronService.
 *
 * GET    /api/scheduler               → list all cron jobs (system + agent)
 * POST   /api/scheduler               → create a new agent job
 * DELETE /api/scheduler/:id           → delete an agent job
 * POST   /api/scheduler/:id/toggle    → toggle enabled state
 * POST   /api/scheduler/:id/run       → trigger immediate run
 */

export async function handleSchedulerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  jobName?: string,
  parts: string[] = [],
): Promise<void> {
  const method = req.method;
  const cronService = getCronService();

  if (!cronService) {
    return error(res, "Cron service not initialized", 500);
  }

  if (jobName === "intelligence" && method === "GET") {
    try {
      const snapshot = await getSchedulerIntelligenceSnapshot();
      return json(res, snapshot);
    } catch (err) {
      return error(res, `Failed to compute scheduler intelligence: ${String(err)}`, 500);
    }
  }

  // GET /api/scheduler — list all jobs
  if (!jobName && method === "GET") {
    try {
      const jobs = cronService.listAllJobs();
      const formatted = jobs.map((job) => ({
        id: job.id,
        name: job.name,
        kind: job.kind,
        payloadKind: job.payloadKind,
        schedule: job.schedule,
        enabled: job.enabled,
        lastRun: job.lastRun ?? null,
        nextRun: job.nextRun ?? null,
      }));

      return json(res, { jobs: formatted });
    } catch (err) {
      return error(res, `Failed to list cron jobs: ${String(err)}`, 500);
    }
  }

  // POST /api/scheduler — create a new agent job
  if (!jobName && method === "POST") {
    try {
      const body = (await parseBody(req)) as Record<string, unknown>;

      const name = body.name as string | undefined;
      const schedule = body.schedule as string | undefined;
      const payload = body.payload as string | undefined;
      const enabled = body.enabled !== undefined ? Boolean(body.enabled) : true;
      const payloadKind = (body.payload_kind as "agent" | "script") || "agent";

      if (!name || !schedule || !payload) {
        return error(res, "Missing required fields: name, schedule, payload", 400);
      }

      const job = cronService.addAgentJob({
        name,
        schedule: {
          kind: "cron",
          expr: schedule,
          tz: "America/New_York",
        },
        payload,
        payloadKind,
        enabled,
      });

      return json(
        res,
        {
          id: job.id,
          name: job.name,
          schedule: job.schedule.expr,
          payload: job.payload,
          enabled: job.enabled,
          created_at: job.createdAt,
        },
        201,
      );
    } catch (err) {
      return error(res, `Failed to create job: ${String(err)}`, 500);
    }
  }

  // DELETE /api/scheduler/:id — delete an agent job
  if (jobName && !parts[2] && method === "DELETE") {
    try {
      // Look up the job to verify it exists and isn't a system job
      const jobs = cronService.listAllJobs();
      const job = jobs.find((j) => j.id === jobName || j.name === jobName);

      if (!job) {
        return error(res, `Job not found: ${jobName}`, 404);
      }

      if (job.kind === "system") {
        return error(res, "Cannot delete system jobs", 400);
      }

      const removed = cronService.removeAgentJob(job.id);
      if (!removed) {
        return error(res, `Failed to remove job: ${jobName}`, 500);
      }

      return json(res, { ok: true });
    } catch (err) {
      return error(res, `Failed to delete job: ${String(err)}`, 500);
    }
  }

  // POST /api/scheduler/:id/toggle
  if (jobName && parts[2] === "toggle" && method === "POST") {
    try {
      const jobs = cronService.listAllJobs();
      const job = jobs.find((j) => j.name === jobName || j.id === jobName);

      if (!job) {
        return error(res, `Job not found: ${jobName}`, 404);
      }

      if (job.kind === "system") {
        cronService.toggleSystemJob(job.id, !job.enabled);
      } else {
        cronService.toggleAgentJob(job.id, !job.enabled);
      }

      return json(res, {
        success: true,
        id: job.id,
        name: job.name,
        kind: job.kind,
        enabled: !job.enabled,
      });
    } catch (err) {
      return error(res, `Failed to toggle job: ${String(err)}`, 500);
    }
  }

  // POST /api/scheduler/:id/run — trigger an immediate run
  if (jobName && parts[2] === "run" && method === "POST") {
    try {
      const jobs = cronService.listAllJobs();
      const job = jobs.find((j) => j.name === jobName || j.id === jobName);

      if (!job) {
        return error(res, `Job not found: ${jobName}`, 404);
      }

      const triggered = await cronService.triggerJob(job.id);
      if (!triggered) {
        return error(res, `Failed to trigger job: ${jobName}`, 500);
      }

      return json(res, { success: true, id: job.id, name: job.name });
    } catch (err) {
      return error(res, `Failed to run job: ${String(err)}`, 500);
    }
  }

  return error(res, "Invalid scheduler endpoint", 404);
}
