/**
 * Compliance API — /api/compliance/status
 *
 * Returns a privacy report for the AI Privacy Report page in Nexus.
 * Classifies model_usage_events as "compliant" (local) or "non-compliant" (cloud).
 *
 * Response shape expected by CompliancePage.jsx:
 * {
 *   generatedAt: string,
 *   last7Days: WindowData,
 *   last30Days: WindowData,
 *   allTime: WindowData,
 *   note?: string,
 * }
 *
 * WindowData = {
 *   totalCalls, compliantCalls, nonCompliantCalls,
 *   compliantPct, nonCompliantPct,
 *   providerBreakdown: Array<{ provider, compliant, calls, tokens }>
 * }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getRawDb } from "../db/connection.js";
import { json, error } from "./index.js";
import { isCompliantCall } from "./usage.js";

interface UsageEvent {
  provider: string | null;
  route_type: string | null;
  requests: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  timestamp: string | null;
}

interface ProviderBucket {
  compliant: boolean;
  calls: number;
  tokens: number;
}

function buildWindowData(events: UsageEvent[]): {
  totalCalls: number;
  compliantCalls: number;
  nonCompliantCalls: number;
  compliantPct: number;
  nonCompliantPct: number;
  providerBreakdown: Array<{ provider: string; compliant: boolean; calls: number; tokens: number }>;
} {
  const byProvider: Record<string, ProviderBucket> = {};

  let compliantCalls = 0;
  let nonCompliantCalls = 0;

  for (const e of events) {
    const provider = e.provider ?? "unknown";
    const routeType = e.route_type ?? "api";
    const compliant = isCompliantCall(provider, routeType);
    const calls = e.requests ?? 1;
    const tokens = (e.input_tokens ?? 0) + (e.output_tokens ?? 0);

    if (compliant) compliantCalls += calls;
    else nonCompliantCalls += calls;

    const key = `${provider}::${String(compliant)}`;
    const bucket = byProvider[key] ?? { compliant, calls: 0, tokens: 0 };
    bucket.calls += calls;
    bucket.tokens += tokens;
    byProvider[key] = bucket;
  }

  const totalCalls = compliantCalls + nonCompliantCalls;
  const compliantPct = totalCalls > 0 ? Math.round((compliantCalls / totalCalls) * 10000) / 100 : 0;
  const nonCompliantPct = totalCalls > 0 ? Math.round((nonCompliantCalls / totalCalls) * 10000) / 100 : 0;

  const providerBreakdown = Object.entries(byProvider)
    .map(([key, b]) => ({
      provider: key.split("::")[0],
      compliant: b.compliant,
      calls: b.calls,
      tokens: b.tokens,
    }))
    .sort((a, b) => b.calls - a.calls);

  return { totalCalls, compliantCalls, nonCompliantCalls, compliantPct, nonCompliantPct, providerBreakdown };
}

/**
 * GET /api/compliance/hierarchy
 *
 * Returns a summary of compliance settings at each level (project / task / chat)
 * so the Nexus UI can render visual indicators (shield icons, banners, etc.)
 * for each entity.
 *
 * Response shape:
 * {
 *   generatedAt: string,
 *   projects: { total, compliant, nonCompliant },
 *   tasks: { total, compliant, inherited, explicit, nonCompliant },
 *   chatSessions: { total, compliant, nonCompliant },
 *   complianceModelConfigured: boolean,
 *   complianceModel: string | null,
 * }
 */
async function handleHierarchyRequest(res: ServerResponse): Promise<void> {
  try {
    const db = getRawDb();

    const projectStats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN compliance_required = 1 THEN 1 ELSE 0 END) AS compliant
      FROM projects
      WHERE archived = 0 OR archived IS NULL
    `).get() as { total: number; compliant: number };

    // Compliant project IDs (for cascade calculation)
    const compliantProjectIds = (db.prepare(
      `SELECT id FROM projects WHERE compliance_required = 1`
    ).all() as { id: string }[]).map(r => r.id);

    // Tasks where compliance is explicitly set on the task
    const taskExplicit = db.prepare(`
      SELECT COUNT(*) AS cnt FROM tasks WHERE compliance_required = 1
    `).get() as { cnt: number };

    // Tasks where compliance is inherited from project (task not explicitly compliant, project is)
    let taskInherited = 0;
    if (compliantProjectIds.length > 0) {
      const placeholders = compliantProjectIds.map(() => "?").join(",");
      const res2 = db.prepare(`
        SELECT COUNT(*) AS cnt FROM tasks
        WHERE compliance_required = 0 OR compliance_required IS NULL
          AND project_id IN (${placeholders})
      `).get(...compliantProjectIds) as { cnt: number };
      taskInherited = res2.cnt ?? 0;
    }

    const taskTotal = db.prepare(`SELECT COUNT(*) AS cnt FROM tasks`).get() as { cnt: number };
    const taskCompliant = taskExplicit.cnt + taskInherited;

    const chatStats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN compliance_required = 1 THEN 1 ELSE 0 END) AS compliant
      FROM chat_sessions
      WHERE is_active = 1
    `).get() as { total: number; compliant: number };

    // Check compliance_model setting
    const cmRow = db.prepare(
      `SELECT value FROM orchestrator_settings WHERE key = 'compliance_model'`
    ).get() as { value: string } | undefined;
    let complianceModel: string | null = null;
    if (cmRow) {
      try {
        const parsed = JSON.parse(cmRow.value) as unknown;
        if (typeof parsed === "string" && parsed.length > 0) complianceModel = parsed;
      } catch {}
    }

    return json(res, {
      generatedAt: new Date().toISOString(),
      projects: {
        total: projectStats.total ?? 0,
        compliant: projectStats.compliant ?? 0,
        nonCompliant: (projectStats.total ?? 0) - (projectStats.compliant ?? 0),
      },
      tasks: {
        total: taskTotal.cnt ?? 0,
        compliant: taskCompliant,
        inherited: taskInherited,
        explicit: taskExplicit.cnt ?? 0,
        nonCompliant: (taskTotal.cnt ?? 0) - taskCompliant,
      },
      chatSessions: {
        total: chatStats.total ?? 0,
        compliant: chatStats.compliant ?? 0,
        nonCompliant: (chatStats.total ?? 0) - (chatStats.compliant ?? 0),
      },
      complianceModelConfigured: complianceModel !== null,
      complianceModel,
    });
  } catch (e) {
    return json(res, {
      generatedAt: new Date().toISOString(),
      projects: { total: 0, compliant: 0, nonCompliant: 0 },
      tasks: { total: 0, compliant: 0, inherited: 0, explicit: 0, nonCompliant: 0 },
      chatSessions: { total: 0, compliant: 0, nonCompliant: 0 },
      complianceModelConfigured: false,
      complianceModel: null,
      note: `Could not read hierarchy data: ${String(e)}`,
    });
  }
}

export async function handleComplianceRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
  if (req.method !== "GET") return error(res, "Method not allowed", 405);
  if (sub === "hierarchy") return handleHierarchyRequest(res);
  if (sub !== "status") return error(res, "Unknown compliance endpoint", 404);

  try {
    const db = getRawDb();

    const allEvents = db.prepare(
      `SELECT provider, route_type, requests, input_tokens, output_tokens, timestamp
       FROM model_usage_events
       ORDER BY timestamp DESC`
    ).all() as UsageEvent[];

    const now = new Date();
    const cutoff7 = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
    const cutoff30 = new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();

    const events7 = allEvents.filter(e => (e.timestamp ?? "") >= cutoff7);
    const events30 = allEvents.filter(e => (e.timestamp ?? "") >= cutoff30);

    return json(res, {
      generatedAt: now.toISOString(),
      last7Days: buildWindowData(events7),
      last30Days: buildWindowData(events30),
      allTime: buildWindowData(allEvents),
    });
  } catch (e) {
    return json(res, {
      generatedAt: new Date().toISOString(),
      last7Days: { totalCalls: 0, compliantCalls: 0, nonCompliantCalls: 0, compliantPct: 0, nonCompliantPct: 0, providerBreakdown: [] },
      last30Days: { totalCalls: 0, compliantCalls: 0, nonCompliantCalls: 0, compliantPct: 0, nonCompliantPct: 0, providerBreakdown: [] },
      allTime: { totalCalls: 0, compliantCalls: 0, nonCompliantCalls: 0, compliantPct: 0, nonCompliantPct: 0, providerBreakdown: [] },
      note: "AI usage data unavailable — PAW database may be initializing.",
    });
  }
}
