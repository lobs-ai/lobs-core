import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error } from "./index.js";
import { getCronService } from "../services/cron.js";

/**
 * Scheduler endpoint — manage cron jobs via the CronService.
 *
 * GET  /api/scheduler           → list all cron jobs
 * POST /api/scheduler/:name/toggle → toggle enabled state
 * POST /api/scheduler/:name/run    → trigger immediate run (not yet supported)
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
      const jobs = cronService.listJobs();
      const formatted = jobs.map((job) => ({
        name: job.name,
        id: job.id,
        cron:
          job.schedule.kind === "cron"
            ? job.schedule.expr
            : job.schedule.kind === "every"
              ? `every ${job.schedule.everyMs}ms`
              : `at ${job.schedule.at}`,
        kind: job.schedule.kind,
        enabled: job.enabled,
        last_run: job.lastFired ?? null,
      }));

      return json(res, { jobs: formatted });
    } catch (err) {
      return error(res, `Failed to list cron jobs: ${String(err)}`, 500);
    }
  }

  // POST /api/scheduler/:name/toggle
  if (jobName && parts[2] === "toggle" && method === "POST") {
    try {
      const jobs = cronService.listJobs();
      const job = jobs.find((j) => j.name === jobName || j.id === jobName);

      if (!job) {
        return error(res, `Job not found: ${jobName}`, 404);
      }

      cronService.toggleJob(job.id, !job.enabled);

      return json(res, {
        success: true,
        name: job.name,
        enabled: !job.enabled,
      });
    } catch (err) {
      return error(res, `Failed to toggle job: ${String(err)}`, 500);
    }
  }

  // POST /api/scheduler/:name/run — not yet wired (would need to expose fireJob)
  if (jobName && parts[2] === "run" && method === "POST") {
    return error(
      res,
      "Manual job triggering not yet supported via API",
      501,
    );
  }

  return error(res, "Invalid scheduler endpoint", 404);
}
