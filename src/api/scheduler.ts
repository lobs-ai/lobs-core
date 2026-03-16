import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error } from "./index.js";
import { getCronService } from "../services/cron.js";

/**
 * Scheduler endpoint — manage cron jobs via the CronService.
 *
 * GET  /api/scheduler               → list all cron jobs (system + agent)
 * POST /api/scheduler/:name/toggle  → toggle enabled state
 * POST /api/scheduler/:name/run     → trigger immediate run
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

  // GET /api/scheduler — list all jobs
  if (!jobName && method === "GET") {
    try {
      const jobs = cronService.listAllJobs();
      const formatted = jobs.map((job) => ({
        id: job.id,
        name: job.name,
        kind: job.kind,
        schedule: job.schedule,
        enabled: job.enabled,
        last_run: job.lastRun ?? null,
      }));

      return json(res, { jobs: formatted });
    } catch (err) {
      return error(res, `Failed to list cron jobs: ${String(err)}`, 500);
    }
  }

  // POST /api/scheduler/:name/toggle
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

  // POST /api/scheduler/:name/run — trigger an immediate run
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
