/**
 * Suggestions API — proxies to the lobslab-home admin API
 * for managing feature requests submitted via home.lobslab.com.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseBody } from "./index.js";

const HOME_URL = process.env.LOBSLAB_HOME_URL ?? "http://127.0.0.1:3100";
const ADMIN_SECRET = process.env.LOBSLAB_HOME_SECRET ?? "cc39f69052f16497650e05822933620b539c5912b2cc5ded";

async function proxyToHome(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": ADMIN_SECRET,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${HOME_URL}${path}`, opts);
  const data = await resp.json();
  return { status: resp.status, data };
}

/** Map task status → suggestion status for auto-sync. */
const TASK_TO_SUGGESTION: Record<string, string> = {
  active: "building",
  completed: "done",
  rejected: "wontdo",
};

/**
 * When a task linked to a suggestion changes status, update the suggestion too.
 * Called fire-and-forget from the tasks API.
 */
export async function syncSuggestionStatus(
  task: Record<string, unknown>,
): Promise<void> {
  if (task.external_source !== "suggestion" && task.externalSource !== "suggestion") return;
  const suggestionId = (task.external_id ?? task.externalId) as string | undefined;
  if (!suggestionId) return;

  const newStatus = TASK_TO_SUGGESTION[task.status as string];
  if (!newStatus) return;

  await proxyToHome("PATCH", `/api/admin/requests/${suggestionId}`, { status: newStatus });
}

export async function handleSuggestionsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  parts?: string[],
): Promise<void> {
  const method = req.method ?? "GET";

  // GET /api/suggestions — list all requests
  if (method === "GET" && !id) {
    try {
      const { status, data } = await proxyToHome("GET", "/api/admin/requests");
      json(res, data, status);
    } catch (err) {
      error(res, `Failed to fetch suggestions: ${err}`, 502);
    }
    return;
  }

  // PATCH /api/suggestions/:id — update status
  if (method === "PATCH" && id) {
    try {
      const body = await parseBody(req);
      const { status, data } = await proxyToHome("PATCH", `/api/admin/requests/${id}`, body);
      json(res, data, status);
    } catch (err) {
      error(res, `Failed to update suggestion: ${err}`, 502);
    }
    return;
  }

  // DELETE /api/suggestions/:id — delete request
  if (method === "DELETE" && id) {
    try {
      const { status, data } = await proxyToHome("DELETE", `/api/admin/requests/${id}`);
      json(res, data, status);
    } catch (err) {
      error(res, `Failed to delete suggestion: ${err}`, 502);
    }
    return;
  }

  error(res, "Method not allowed", 405);
}
