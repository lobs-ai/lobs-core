/**
 * before_model_resolve hook — ModelChooser integration + compliance enforcement.
 *
 * This hook fires before every model call in any session. It does two things:
 *
 * 1. Tier-based model resolution: if the session was registered with a model tier
 *    (e.g. an orchestrator-spawned subagent), resolve the tier to a concrete model.
 *
 * 2. Compliance enforcement: if the session is a chat session with
 *    compliance_required=true, override the model with the configured local
 *    compliance model (orchestrator_settings.compliance_model). This ensures that
 *    ALL LLM calls in a compliant chat session are routed to the local model,
 *    never to a cloud provider.
 *
 * Priority: compliance enforcement > tier-based resolution > default model.
 */

import type { LobsPluginApi } from "../types/lobs-plugin.js";
import { resolveModelForTier, type ModelTier } from "../orchestrator/model-chooser.js";
import { log } from "../util/logger.js";
import { getRawDb } from "../db/connection.js";

const sessionTierMap = new Map<string, { tier: ModelTier; agentType: string }>();

export function setSessionModelTier(sessionKey: string, tier: ModelTier, agentType: string): void {
  sessionTierMap.set(sessionKey, { tier, agentType });
}

export function clearSessionModelTier(sessionKey: string): void {
  sessionTierMap.delete(sessionKey);
}

/**
 * Look up the configured compliance model from orchestrator_settings.
 * Returns null if not configured (chat compliance enforcement will not override
 * to avoid silently breaking sessions when no local model is set up).
 */
function getComplianceModel(): string | null {
  try {
    const db = getRawDb();
    const row = db.prepare(
      `SELECT value FROM orchestrator_settings WHERE key = 'compliance_model'`
    ).get() as { value: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as unknown;
    return typeof parsed === "string" && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Check whether a given session key belongs to a chat session with
 * compliance_required=1. Returns false on DB errors (fail-open for availability).
 */
function isChatSessionCompliant(sessionKey: string): boolean {
  try {
    const db = getRawDb();
    const row = db.prepare(
      `SELECT compliance_required FROM chat_sessions WHERE session_key = ?`
    ).get(sessionKey) as { compliance_required: number | null } | undefined;
    return Boolean(row?.compliance_required);
  } catch {
    return false;
  }
}

export function registerModelResolveHook(api: LobsPluginApi): void {
  api.on("before_model_resolve", async (_event: unknown, ctx: unknown): Promise<Record<string, unknown>> => {
    const sessionKey = (ctx as Record<string, unknown>).sessionKey as string | undefined;
    if (!sessionKey) return {};

    // ── 1. Compliance gate: check if this is a compliant chat session ──────────
    // Check compliance before tier resolution so it always wins.
    if (isChatSessionCompliant(sessionKey)) {
      const complianceModel = getComplianceModel();
      if (complianceModel) {
        log().info(
          `[COMPLIANCE] Chat session ${sessionKey.slice(0, 30)} compliance_required=true — ` +
          `overriding model to local: ${complianceModel}`
        );
        return { modelOverride: complianceModel };
      }
      // compliance_model not configured — log a warning but don't block the chat
      // (blocking chat would be too disruptive for interactive sessions; task dispatch
      //  is the harder gate that blocks when compliance_model is missing)
      log().warn(
        `[COMPLIANCE] Chat session ${sessionKey.slice(0, 30)} compliance_required=true but ` +
        `'compliance_model' is not configured in orchestrator_settings — using default model. ` +
        `Set compliance_model via SQL: UPDATE orchestrator_settings SET value = '"your/local-model"' WHERE key = 'compliance_model'`
      );
      return {};
    }

    // ── 2. Tier-based resolution (orchestrator-dispatched subagents) ───────────
    const mapping = sessionTierMap.get(sessionKey);
    if (!mapping) return {};

    const resolved = resolveModelForTier(mapping.tier, mapping.agentType);
    if (resolved) {
      log().info(`[PAW] Model resolved: tier=${mapping.tier} agent=${mapping.agentType} → ${resolved}`);
      return { modelOverride: resolved };
    }
    return {};
  });
}
