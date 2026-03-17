/**
 * Plugin System API — /api/plugins, /api/ui-affordances, /api/ui-config
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { plugins, uiConfig } from "../db/schema.js";
import { json, error, parseBody } from "./index.js";
import type { PawPlugin, UIAffordance } from "../types/plugin.js";
import { getModelForTier } from "../config/models.js";
import { getGatewayConfig } from "../config/lobs.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToPlugin(row: typeof plugins.$inferSelect): PawPlugin {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    category: row.category as PawPlugin["category"],
    enabled: Boolean(row.enabled),
    config: safeJson(row.config, {}),
    configSchema: safeJson(row.configSchema, {}),
    uiAffordances: safeJson(row.uiAffordances, []) as UIAffordance[],
  };
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function now(): string {
  return new Date().toISOString();
}

// ── /api/plugins ──────────────────────────────────────────────────────────────

export async function handlePluginsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  parts: string[] = [],
): Promise<void> {
  const db = getDb();
  const method = req.method ?? "GET";

  // POST /api/plugins/:id/invoke
  if (id && parts[2] === "invoke") {
    if (method !== "POST") return error(res, "Method not allowed", 405);
    return handleInvoke(req, res, id);
  }

  // Single plugin
  if (id) {
    switch (method) {
      case "GET": {
        const row = db.select().from(plugins).where(eq(plugins.id, id)).get();
        if (!row) return error(res, "Plugin not found", 404);
        return json(res, rowToPlugin(row));
      }
      case "PATCH": {
        const body = await parseBody(req) as Record<string, unknown>;
        const updates: Partial<typeof plugins.$inferInsert> = { updatedAt: now() };

        if (typeof body.enabled === "boolean") updates.enabled = body.enabled ? 1 : 0;
        if (typeof body.enabled === "number") updates.enabled = body.enabled;
        if (body.config !== undefined) updates.config = JSON.stringify(body.config);

        db.update(plugins).set(updates).where(eq(plugins.id, id)).run();
        const updated = db.select().from(plugins).where(eq(plugins.id, id)).get();
        if (!updated) return error(res, "Plugin not found", 404);
        return json(res, rowToPlugin(updated));
      }
      default:
        return error(res, "Method not allowed", 405);
    }
  }

  // Collection
  if (method === "GET") {
    const rows = db.select().from(plugins).all();
    return json(res, { plugins: rows.map(rowToPlugin) });
  }

  return error(res, "Method not allowed", 405);
}

// ── /api/ui-affordances ───────────────────────────────────────────────────────

export async function handleUiAffordancesRequest(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const db = getDb();
  const rows = db.select().from(plugins).where(eq(plugins.enabled, 1)).all();

  const affordances: Array<UIAffordance & { pluginId: string }> = [];
  for (const row of rows) {
    const aff = safeJson(row.uiAffordances, []) as UIAffordance[];
    for (const a of aff) {
      affordances.push({ ...a, pluginId: row.id });
    }
  }

  return json(res, { affordances });
}

// ── /api/plugins/:id/invoke ───────────────────────────────────────────────────

async function handleInvoke(
  req: IncomingMessage,
  res: ServerResponse,
  pluginId: string,
): Promise<void> {
  const db = getDb();
  const row = db.select().from(plugins).where(eq(plugins.id, pluginId)).get();
  if (!row) return error(res, "Plugin not found", 404);
  if (!row.enabled) return error(res, "Plugin is disabled", 400);

  const body = await parseBody(req) as { affordanceId?: string; context?: string };
  const { affordanceId, context } = body;

  if (!affordanceId || !context) {
    return error(res, "affordanceId and context are required", 400);
  }

  const affordances = safeJson(row.uiAffordances, []) as UIAffordance[];
  const affordance = affordances.find((a) => a.id === affordanceId);
  if (!affordance) return error(res, "Affordance not found", 404);

  const prompt = buildPrompt(affordance.aiAction, context);
  if (!prompt) return error(res, `Unknown aiAction: ${affordance.aiAction}`, 400);

  // Simple model call via spawn — using a minimal approach
  // For now, return a descriptive placeholder since we don't have a sync model call
  // The task spec says sessions_spawn with mode:"run" — but that's async.
  // We'll use a simple direct approach: invoke via the orchestrator settings / model
  // In practice the Nexus client can use streaming; here we return synchronously
  // with a stub and let a future PR wire in the actual model gateway.
  const result = await callModel(prompt);
  return json(res, { result, pluginId, affordanceId });
}

function buildPrompt(aiAction: string, context: string): string | null {
  switch (aiAction) {
    case "summarize":
      return `Summarize this concisely in 2-3 sentences:\n\n${context}`;
    case "suggest-reply":
      return `Suggest 3 short, contextually appropriate replies to this message. Return each on a new line, no numbering:\n\n${context}`;
    case "explain":
      return `Explain this simply and clearly in 2-3 sentences:\n\n${context}`;
    case "rewrite":
      return `Rewrite this more concisely while keeping the meaning:\n\n${context}`;
    case "generate":
      return `Generate a conventional commit message for these changes. Return ONLY the commit message:\n\n${context}`;
    case "assess":
      return `Give a brief health assessment (1-2 sentences) of this project/system based on the data:\n\n${context}`;
    case "extract-actions":
      return `Extract actionable items from this content. Return each as a bullet point:\n\n${context}`;
    case "optimize":
      return `Suggest optimizations or improvements based on this data. Be specific and actionable:\n\n${context}`;
    case "insights":
      return `What are the key insights from this data? Return 2-3 bullet points:\n\n${context}`;
    case "daily-summary":
      return `Generate a concise daily summary from this activity data. Include highlights, completions, and anything needing attention:\n\n${context}`;
    default:
      return null;
  }
}

async function callModel(prompt: string): Promise<string> {
  // Fast path: call the local gateway API directly via HTTP.
  const cfg = getGatewayConfig();
  let gatewayPort = cfg.port;
  let gatewayToken = cfg.token;

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v2/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
      },
      body: JSON.stringify({
        tool: "sessions/spawn",
        sessionKey: "agent:sink:paw-orchestrator-v2",
        args: {
          task: prompt,
          model: getModelForTier("small"),
          mode: "run",
          cleanup: "delete",
          runTimeoutSeconds: 30,
        },
      }),
    });

    const data = (await response.json()) as Record<string, unknown>;
    // Extract result text from the spawn response
    const result = data?.result as Record<string, unknown> | undefined;
    const content = result?.content as Array<Record<string, unknown>> | undefined;
    if (content?.[0]?.text) {
      try {
        const parsed = JSON.parse(content[0].text as string);
        return parsed?.text ?? parsed?.result ?? String(content[0].text);
      } catch {
        return String(content[0].text);
      }
    }
    return "[AI processing...]";
  } catch {
    return "[AI unavailable]";
  }
}

// ── /api/ui-config ────────────────────────────────────────────────────────────

export async function handleUiConfigRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const db = getDb();
  const method = req.method ?? "GET";

  if (method === "GET") {
    let row = db.select().from(uiConfig).where(eq(uiConfig.id, "default")).get();
    if (!row) {
      // Auto-create default row
      db.insert(uiConfig).values({ id: "default", layout: "command-center", updatedAt: now() }).run();
      row = db.select().from(uiConfig).where(eq(uiConfig.id, "default")).get()!;
    }
    return json(res, {
      id: row.id,
      layout: row.layout,
      widgetOrder: safeJson(row.widgetOrder, []),
      hiddenWidgets: safeJson(row.hiddenWidgets, []),
      agentHighlights: safeJson(row.agentHighlights, []),
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    });
  }

  if (method === "PATCH") {
    const body = await parseBody(req) as Record<string, unknown>;
    const updates: Partial<typeof uiConfig.$inferInsert> = { updatedAt: now() };

    if (typeof body.layout === "string") updates.layout = body.layout;
    if (body.widgetOrder !== undefined) updates.widgetOrder = JSON.stringify(body.widgetOrder);
    if (body.hiddenWidgets !== undefined) updates.hiddenWidgets = JSON.stringify(body.hiddenWidgets);
    if (body.agentHighlights !== undefined) updates.agentHighlights = JSON.stringify(body.agentHighlights);
    if (typeof body.updatedBy === "string") updates.updatedBy = body.updatedBy;

    // Upsert
    db.insert(uiConfig)
      .values({ id: "default", layout: "command-center", updatedAt: now(), ...updates })
      .onConflictDoUpdate({ target: uiConfig.id, set: updates })
      .run();

    const row = db.select().from(uiConfig).where(eq(uiConfig.id, "default")).get()!;
    return json(res, {
      id: row.id,
      layout: row.layout,
      widgetOrder: safeJson(row.widgetOrder, []),
      hiddenWidgets: safeJson(row.hiddenWidgets, []),
      agentHighlights: safeJson(row.agentHighlights, []),
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    });
  }

  return error(res, "Method not allowed", 405);
}
