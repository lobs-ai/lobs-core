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

/**
 * Lobslab service registry — maps services to their codebase and deploy info.
 * Used to auto-enrich suggestion tasks with context the submitter wouldn't have.
 */
const LOBSLAB_SERVICES: Record<string, {
  name: string;
  keywords: string[];
  repo: string;
  codePath: string;
  deployCmd: string;
  url: string;
  notes?: string;
}> = {
  ballz: {
    name: "Ballz",
    keywords: ["ballz", "ball", "click", "idle", "prestige", "generator", "upgrade", "machine"],
    repo: "~/lobs/lobslab-apps/",
    codePath: "apps/ballz/index.html (single-file HTML game)",
    deployCmd: "cd ~/lobs/lobslab-apps && docker compose up -d ballz --build",
    url: "ballz.lobslab.com",
  },
  crapuler: {
    name: "Crapuler",
    keywords: ["crapuler", "crap", "dice", "craps", "casino", "gambling"],
    repo: "~/lobs/lobslab-apps/",
    codePath: "apps/crapuler/",
    deployCmd: "cd ~/lobs/lobslab-apps && docker compose up -d crapuler --build",
    url: "crapuler.lobslab.com",
  },
  home: {
    name: "Lobslab Home",
    keywords: ["home", "landing", "homepage", "suggestion", "request", "lobslab"],
    repo: "~/lobs/lobslab-infra/",
    codePath: "home/",
    deployCmd: "cd ~/lobs/lobslab-infra && docker compose up -d lobslab-home --build",
    url: "home.lobslab.com",
  },
};

/**
 * Match a suggestion to a lobslab service based on title/description keywords.
 */
function matchService(title: string, description?: string): typeof LOBSLAB_SERVICES[string] | null {
  const text = `${title} ${description ?? ""}`.toLowerCase();
  let best: { svc: typeof LOBSLAB_SERVICES[string]; hits: number } | null = null;

  for (const svc of Object.values(LOBSLAB_SERVICES)) {
    const hits = svc.keywords.filter(kw => text.includes(kw)).length;
    if (hits > 0 && (!best || hits > best.hits)) {
      best = { svc, hits };
    }
  }
  return best?.svc ?? null;
}

/**
 * Build enriched task notes for a suggestion, including service context.
 */
export function enrichSuggestionNotes(title: string, description?: string): string {
  const svc = matchService(title, description);
  let notes = `Feature request from lobslab.com:\n\n**${title}**`;
  if (description) notes += `\n\n${description}`;

  if (svc) {
    notes += `\n\n## Service: ${svc.name}`;
    notes += `\n- **Repo:** ${svc.repo}`;
    notes += `\n- **Code:** ${svc.codePath}`;
    notes += `\n- **Live at:** ${svc.url}`;
    notes += `\n- **Deploy:** \`${svc.deployCmd}\``;
    if (svc.notes) notes += `\n- **Notes:** ${svc.notes}`;
    notes += `\n\n**After making changes, deploy the service and commit/push your changes.**`;
  }

  return notes;
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
