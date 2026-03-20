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

type InvokeRequestBody = {
  affordanceId?: string;
  context?: string;
  refine?: boolean;
  refinementNotes?: string;
};

type PromptPlan = {
  prompt: string;
  modelTier: string;
  refinementTier?: string;
  mode: "draft" | "single-pass";
  draftKind?: string;
};

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

  const body = await parseBody(req) as InvokeRequestBody;
  const { affordanceId, context } = body;

  if (!affordanceId || !context) {
    return error(res, "affordanceId and context are required", 400);
  }

  const affordances = safeJson(row.uiAffordances, []) as UIAffordance[];
  const affordance = affordances.find((a) => a.id === affordanceId);
  if (!affordance) return error(res, "Affordance not found", 404);

  const payload = await invokeAffordance(affordance, context, {
    pluginId,
    affordanceId,
    refine: body.refine,
    refinementNotes: body.refinementNotes,
  });
  return json(res, payload);
}

export async function invokeAffordance(
  affordance: UIAffordance,
  context: string,
  options?: {
    pluginId?: string;
    affordanceId?: string;
    refine?: boolean;
    refinementNotes?: string;
  },
): Promise<Record<string, unknown>> {
  const plan = buildPromptPlan(affordance, context);
  if (!plan) throw new Error(`Unknown aiAction: ${affordance.aiAction}`);

  const draft = await callModel(plan.prompt, { modelTier: plan.modelTier });
  if (plan.mode === "draft" && options?.refine) {
    const refinementPrompt = buildRefinementPrompt(plan, context, draft, options.refinementNotes);
    const refined = await callModel(refinementPrompt, {
      modelTier: plan.refinementTier ?? "standard",
    });
    return {
      result: refined,
      draft,
      pluginId: options?.pluginId,
      affordanceId: options?.affordanceId,
      mode: "refined",
      draftModelTier: plan.modelTier,
      refinementModelTier: plan.refinementTier ?? "standard",
      draftKind: plan.draftKind ?? "generic",
    };
  }

  return {
    result: draft,
    pluginId: options?.pluginId,
    affordanceId: options?.affordanceId,
    mode: plan.mode,
    modelTier: plan.modelTier,
    draftKind: plan.draftKind ?? "generic",
    nextStep: plan.mode === "draft"
      ? "Use a stronger model or edit manually if the draft needs refinement."
      : undefined,
  };
}

export function buildPromptPlan(affordance: UIAffordance, context: string): PromptPlan | null {
  const aiAction = affordance.aiAction;
  switch (aiAction) {
    case "summarize":
      return {
        prompt: `Summarize this concisely in 2-3 sentences:\n\n${context}`,
        modelTier: "small",
        mode: "single-pass",
      };
    case "suggest-reply":
      return {
        prompt: `Suggest 3 short, contextually appropriate replies to this message. Return each on a new line, no numbering:\n\n${context}`,
        modelTier: "small",
        mode: "single-pass",
      };
    case "explain":
      return {
        prompt: `Explain this simply and clearly in 2-3 sentences:\n\n${context}`,
        modelTier: "small",
        mode: "single-pass",
      };
    case "rewrite":
      return {
        prompt: `Rewrite this more concisely while keeping the meaning:\n\n${context}`,
        modelTier: "small",
        mode: "single-pass",
      };
    case "generate":
      return buildDraftPrompt(affordance, context);
    case "assess":
      return {
        prompt: `Give a brief health assessment (1-2 sentences) of this project/system based on the data:\n\n${context}`,
        modelTier: "small",
        mode: "single-pass",
      };
    case "extract-actions":
      return {
        prompt: `Extract actionable items from this content. Return each as a bullet point:\n\n${context}`,
        modelTier: "small",
        mode: "single-pass",
      };
    case "optimize":
      return {
        prompt: `Suggest optimizations or improvements based on this data. Be specific and actionable:\n\n${context}`,
        modelTier: "small",
        mode: "single-pass",
      };
    case "insights":
      return {
        prompt: `What are the key insights from this data? Return 2-3 bullet points:\n\n${context}`,
        modelTier: "small",
        mode: "single-pass",
      };
    case "daily-summary":
      return {
        prompt: `Generate a concise daily summary from this activity data. Include highlights, completions, and anything needing attention:\n\n${context}`,
        modelTier: "small",
        mode: "single-pass",
      };
    default:
      return null;
  }
}

function buildDraftPrompt(affordance: UIAffordance, context: string): PromptPlan {
  const cfg = (affordance.config ?? {}) as Record<string, unknown>;
  const template = typeof cfg.template === "string" ? cfg.template : "commit-message";
  const modelTier = typeof cfg.modelTier === "string" ? cfg.modelTier : "micro";
  const refinementTier = typeof cfg.refinementTier === "string" ? cfg.refinementTier : "standard";

  const commonPrefix = [
    "Produce a fast first draft only.",
    "This draft is boilerplate and may be refined later by a stronger model or a human.",
    "Prefer a useful structure over polish.",
  ].join(" ");

  switch (template) {
    case "pr-description":
      return {
        prompt: `${commonPrefix}

Write a pull request description using these sections:
- Summary
- Changes
- Testing
- Risks / Follow-ups

Keep it concise, concrete, and easy to edit.

Context:
${context}`,
        modelTier,
        refinementTier,
        mode: "draft",
        draftKind: template,
      };
    case "doc-stub":
      return {
        prompt: `${commonPrefix}

Write a documentation stub with these sections:
- Title
- Purpose
- Scope
- Current status
- Open questions

Do not invent deep details. Leave clear placeholders where needed.

Context:
${context}`,
        modelTier,
        refinementTier,
        mode: "draft",
        draftKind: template,
      };
    case "test-scaffold":
      return {
        prompt: `${commonPrefix}

Generate test scaffolding only. Return a concise skeleton with:
- test suite name
- core test cases
- TODO placeholders for setup/assertions

Do not claim tests already pass. Keep implementation details minimal.

Context:
${context}`,
        modelTier,
        refinementTier,
        mode: "draft",
        draftKind: template,
      };
    case "commit-message":
    default:
      return {
        prompt: `${commonPrefix}

Generate a conventional commit message for these changes.
Return ONLY the commit message on one line.

Context:
${context}`,
        modelTier,
        refinementTier,
        mode: "draft",
        draftKind: "commit-message",
      };
  }
}

export function buildRefinementPrompt(
  plan: PromptPlan,
  context: string,
  draft: string,
  refinementNotes?: string,
): string {
  const notesBlock = refinementNotes?.trim()
    ? `\nRefinement notes:\n${refinementNotes.trim()}\n`
    : "";

  return `Refine this ${plan.draftKind ?? "generated"} draft created by a smaller local model.
Improve clarity, correctness, and completeness without changing the underlying intent unless the context requires it.${notesBlock}
Original context:
${context}

Draft to refine:
${draft}

Return only the refined final text.`;
}

async function callModel(prompt: string, options?: { modelTier?: string }): Promise<string> {
  // Fast path: call the local gateway API directly via HTTP.
  const cfg = getGatewayConfig();
  const gatewayPort = cfg.port;
  const gatewayToken = cfg.token;

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
          model: getModelForTier(options?.modelTier ?? "small"),
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
