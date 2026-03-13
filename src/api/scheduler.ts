import type { IncomingMessage, ServerResponse } from "node:http";
import { execSync } from "node:child_process";
import { json, error } from "./index.js";

/**
 * Scheduler endpoint — manage OpenClaw cron jobs.
 * 
 * GET /api/scheduler → list all cron jobs
 * POST /api/scheduler/:name/toggle → toggle enabled state
 * POST /api/scheduler/:name/run → trigger immediate run
 */

export async function handleSchedulerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  jobName?: string,
  parts: string[] = [],
): Promise<void> {
  const method = req.method;

  // GET /api/scheduler — list all jobs
  if (!jobName && method === "GET") {
    try {
      const output = execSync("openclaw cron list --json", { encoding: "utf-8" });
      const jobs = JSON.parse(output);
      
      // Transform to frontend format
      const formatted = jobs.map((job: any) => ({
        name: job.name ?? job.id,
        cron: job.schedule ?? job.cron ?? "unknown",
        enabled: job.enabled !== false, // Default true if missing
        last_run: job.lastRun ?? job.lastFired ?? null,
      }));

      return json(res, { jobs: formatted });
    } catch (err) {
      return error(res, `Failed to list cron jobs: ${String(err)}`, 500);
    }
  }

  // POST /api/scheduler/:name/toggle
  if (jobName && parts[2] === "toggle" && method === "POST") {
    try {
      // Get current state
      const listOutput = execSync("openclaw cron list --json", { encoding: "utf-8" });
      const jobs = JSON.parse(listOutput);
      const job = jobs.find((j: any) => (j.name ?? j.id) === jobName);
      
      if (!job) {
        return error(res, `Job not found: ${jobName}`, 404);
      }

      const currentlyEnabled = job.enabled !== false;
      const action = currentlyEnabled ? "disable" : "enable";
      
      execSync(`openclaw cron ${action} ${jobName}`, { encoding: "utf-8" });
      
      return json(res, { 
        success: true, 
        name: jobName, 
        enabled: !currentlyEnabled 
      });
    } catch (err) {
      return error(res, `Failed to toggle job: ${String(err)}`, 500);
    }
  }

  // POST /api/scheduler/:name/run
  if (jobName && parts[2] === "run" && method === "POST") {
    try {
      execSync(`openclaw cron run ${jobName}`, { encoding: "utf-8" });
      
      return json(res, { 
        success: true, 
        name: jobName, 
        message: "Job triggered successfully" 
      });
    } catch (err) {
      return error(res, `Failed to run job: ${String(err)}`, 500);
    }
  }

  return error(res, "Invalid scheduler endpoint", 404);
}
