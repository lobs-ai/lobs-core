/**
 * Discord OAuth2 + guild management API
 *
 * Endpoints:
 *   GET  /api/discord/connect          → redirect to Discord OAuth2 invite URL
 *   GET  /api/discord/callback         → OAuth2 callback: validate state, store guild mapping
 *   GET  /api/discord/guilds           → list connected Discord guilds (optionally filtered by client_id)
 *   DELETE /api/discord/guilds/:id     → disconnect a guild (soft: sets status=disconnected)
 *   GET  /api/discord/dm-users         → list DM-enabled users for a client
 *   POST /api/discord/dm-users         → register a Discord user ID for DM routing
 *   DELETE /api/discord/dm-users/:id   → deregister a DM user
 *   GET  /api/discord/deployments      → list deployments (used by paw-discord-router)
 *   GET  /api/discord/deployments/:slug → get one deployment by client_slug
 *   PUT  /api/discord/deployments/:slug → upsert deployment (called by provision-webhook)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import { getDb } from "../db/connection.js";
import { encryptSecret } from "../services/crypto.js";
import { discordGuilds, discordDmUsers, deployments } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { json, error, parseBody } from "./index.js";
import { discordService } from "../services/discord.js";

// ── Config (read from env at call time, not at import time) ──────────────────

function cfg() {
  const stateSecret = process.env.DISCORD_STATE_SECRET || process.env.GATEWAY_SECRET || "";
  return {
    clientId:        process.env.DISCORD_CLIENT_ID || "",
    clientSecret:    process.env.DISCORD_CLIENT_SECRET || "",
    callbackUrl:     process.env.DISCORD_OAUTH_CALLBACK_URL || "https://paw.engineering/api/discord/callback",
    stateSecret,
    stateSecretConfigured: stateSecret.length > 0,
    botPermissions:  "2048", // Send Messages
  };
}

// ── State JWT (HMAC-SHA256, 15-minute expiry) ──────────────────────────────

function signState(clientId: string, nonce: string): string {
  const payload = { clientId, nonce, exp: Math.floor(Date.now() / 1000) + 900 };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", cfg().stateSecret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyState(state: string): { clientId: string; nonce: string } | null {
  try {
    const [data, sig] = state.split(".");
    if (!data || !sig) return null;
    const expected = createHmac("sha256", cfg().stateSecret).update(data).digest("base64url");
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { clientId: payload.clientId, nonce: payload.nonce };
  } catch {
    return null;
  }
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function handleDiscordRequest(
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string | undefined,
  parts: string[]
): Promise<void> {
  const method = req.method?.toUpperCase() ?? "GET";
  const sub = subPath ?? "";

  // GET /api/discord/connect?client_id=<id>&client_slug=<slug>
  if (sub === "connect" && method === "GET") {
    return handleConnect(req, res);
  }

  // GET /api/discord/callback?code=...&guild_id=...&state=...
  if (sub === "callback" && method === "GET") {
    return handleCallback(req, res);
  }

  // /api/discord/guilds[/:id]
  if (sub === "guilds") {
    const guildId = parts[2]; // parts[0]=discord, parts[1]=guilds, parts[2]=id
    if (!guildId) {
      if (method === "GET")    return handleListGuilds(req, res);
    } else {
      if (method === "DELETE") return handleDeleteGuild(req, res, guildId);
    }
  }

  // /api/discord/dm-users[/:id]
  if (sub === "dm-users") {
    const dmId = parts[2];
    if (!dmId) {
      if (method === "GET")    return handleListDmUsers(req, res);
      if (method === "POST")   return handleCreateDmUser(req, res);
    } else {
      if (method === "DELETE") return handleDeleteDmUser(req, res, dmId);
    }
  }

  // /api/discord/deployments[/:slug]
  if (sub === "deployments") {
    const slug = parts[2];
    if (!slug) {
      if (method === "GET")    return handleListDeployments(req, res);
    } else {
      if (method === "GET")    return handleGetDeployment(req, res, slug);
      if (method === "PUT")    return handleUpsertDeployment(req, res, slug);
    }
  }

  // GET /api/discord/status
  if (sub === "status" && method === "GET") {
    return handleBotStatus(req, res);
  }

  error(res, `Discord: no route for ${method} /api/discord/${sub}`, 404);
}

// ── Connect: generate OAuth2 invite URL ──────────────────────────────────────

async function handleConnect(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const clientId  = url.searchParams.get("client_id") ?? "";
  const clientSlug = url.searchParams.get("client_slug") ?? "";

  if (!clientId) return error(res, "client_id is required", 400);

  const { clientId: botClientId, callbackUrl, botPermissions, stateSecretConfigured } = cfg();
  if (!stateSecretConfigured) {
    return error(res, "DISCORD_STATE_SECRET or GATEWAY_SECRET must be set", 503);
  }
  if (!botClientId) return error(res, "DISCORD_CLIENT_ID not configured on server", 503);

  const nonce = randomUUID();
  const state = signState(clientId + "|" + clientSlug, nonce);

  const inviteUrl = new URL("https://discord.com/oauth2/authorize");
  inviteUrl.searchParams.set("client_id", botClientId);
  inviteUrl.searchParams.set("scope", "bot");
  inviteUrl.searchParams.set("permissions", botPermissions);
  inviteUrl.searchParams.set("redirect_uri", callbackUrl);
  inviteUrl.searchParams.set("response_type", "code");
  inviteUrl.searchParams.set("state", state);

  res.writeHead(302, { Location: inviteUrl.toString() });
  res.end();
}

// ── Callback: validate state, exchange code, store guild mapping ─────────────

async function handleCallback(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const code    = url.searchParams.get("code");
  const guildId = url.searchParams.get("guild_id");
  const state   = url.searchParams.get("state") ?? "";

  if (!code || !guildId) {
    return error(res, "Missing code or guild_id from Discord callback", 400);
  }

  if (!cfg().stateSecretConfigured) {
    return error(res, "DISCORD_STATE_SECRET or GATEWAY_SECRET must be set", 503);
  }

  const statePayload = verifyState(state);
  if (!statePayload) {
    return error(res, "Invalid or expired state parameter (possible CSRF)", 403);
  }

  // Parse clientId|clientSlug from the signed state
  const [clientId, clientSlug] = statePayload.clientId.split("|");
  if (!clientId || !clientSlug) {
    return error(res, "Malformed state payload", 400);
  }

  const { clientId: botClientId, clientSecret, callbackUrl } = cfg();

  // Exchange code for token (we don't actually need the token for guild-add flow,
  // Discord already tells us guild_id in the callback URL, but we still exchange
  // so we can get the guild name and validate the code is real)
  let guildName: string | null = null;
  if (botClientId && clientSecret) {
    try {
      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id:     botClientId,
          client_secret: clientSecret,
          grant_type:    "authorization_code",
          code,
          redirect_uri:  callbackUrl,
        }),
      });
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json() as { guild?: { name?: string; id?: string } };
        guildName = tokenData.guild?.name ?? null;
      }
    } catch {
      // Non-fatal: we still have guild_id from the query param
    }
  }

  // Upsert the guild mapping
  const db = getDb();
  const existing = db.select().from(discordGuilds).where(eq(discordGuilds.guildId, guildId)).get();

  if (existing) {
    db.update(discordGuilds)
      .set({
        clientId,
        clientSlug,
        guildName: guildName ?? existing.guildName,
        status: "active",
        addedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(discordGuilds.guildId, guildId))
      .run();
  } else {
    db.insert(discordGuilds).values({
      id:         randomUUID(),
      guildId,
      guildName,
      clientId,
      clientSlug,
      addedAt:    Math.floor(Date.now() / 1000),
      status:     "active",
    }).run();
  }

  // Redirect back to dashboard with success flag
  const dashboardUrl = process.env.DASHBOARD_URL || "https://paw.engineering/dashboard";
  res.writeHead(302, { Location: `${dashboardUrl}?discord=connected` });
  res.end();
}

// ── Guilds: list ─────────────────────────────────────────────────────────────

async function handleListGuilds(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const clientId   = url.searchParams.get("client_id");
  const clientSlug = url.searchParams.get("client_slug");

  const db = getDb();
  let rows;
  if (clientId) {
    rows = db.select().from(discordGuilds).where(eq(discordGuilds.clientId, clientId)).all();
  } else if (clientSlug) {
    rows = db.select().from(discordGuilds).where(eq(discordGuilds.clientSlug, clientSlug)).all();
  } else {
    rows = db.select().from(discordGuilds).all();
  }
  json(res, rows);
}

// ── Guilds: delete ───────────────────────────────────────────────────────────

async function handleDeleteGuild(req: IncomingMessage, res: ServerResponse, id: string) {
  const db = getDb();
  db.update(discordGuilds)
    .set({ status: "disconnected" })
    .where(eq(discordGuilds.id, id))
    .run();
  json(res, { ok: true });
}

// ── DM Users: list ────────────────────────────────────────────────────────────

async function handleListDmUsers(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const clientId   = url.searchParams.get("client_id");
  const clientSlug = url.searchParams.get("client_slug");

  const db = getDb();
  let rows;
  if (clientId) {
    rows = db.select().from(discordDmUsers).where(eq(discordDmUsers.clientId, clientId)).all();
  } else if (clientSlug) {
    rows = db.select().from(discordDmUsers).where(eq(discordDmUsers.clientSlug, clientSlug)).all();
  } else {
    rows = db.select().from(discordDmUsers).all();
  }
  json(res, rows);
}

// ── DM Users: create ─────────────────────────────────────────────────────────

async function handleCreateDmUser(req: IncomingMessage, res: ServerResponse) {
  const body = await parseBody(req) as {
    discord_user_id?: string;
    client_id?: string;
    client_slug?: string;
  };
  if (!body.discord_user_id || !body.client_id || !body.client_slug) {
    return error(res, "discord_user_id, client_id, and client_slug are required", 400);
  }

  const db = getDb();
  const existing = db.select().from(discordDmUsers)
    .where(eq(discordDmUsers.discordUserId, body.discord_user_id))
    .get();

  if (existing) {
    db.update(discordDmUsers)
      .set({
        clientId: body.client_id,
        clientSlug: body.client_slug,
        status: "active",
        registeredAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(discordDmUsers.discordUserId, body.discord_user_id))
      .run();
    const updated = db.select().from(discordDmUsers)
      .where(eq(discordDmUsers.discordUserId, body.discord_user_id))
      .get();
    return json(res, updated);
  }

  const row = {
    id:             randomUUID(),
    discordUserId:  body.discord_user_id,
    clientId:       body.client_id,
    clientSlug:     body.client_slug,
    registeredAt:   Math.floor(Date.now() / 1000),
    status:         "active",
  };
  db.insert(discordDmUsers).values(row).run();
  json(res, row, 201);
}

// ── DM Users: delete ─────────────────────────────────────────────────────────

async function handleDeleteDmUser(req: IncomingMessage, res: ServerResponse, id: string) {
  const db = getDb();
  db.update(discordDmUsers)
    .set({ status: "inactive" })
    .where(eq(discordDmUsers.id, id))
    .run();
  json(res, { ok: true });
}

// ── Deployments: list ────────────────────────────────────────────────────────

async function handleListDeployments(req: IncomingMessage, res: ServerResponse) {
  const db = getDb();
  const rows = db.select({
    id:            deployments.id,
    clientSlug:    deployments.clientSlug,
    clientId:      deployments.clientId,
    gatewayUrl:    deployments.gatewayUrl,
    containerName: deployments.containerName,
    isDemo:        deployments.isDemo,
    status:        deployments.status,
    provisionedAt: deployments.provisionedAt,
    // Omit gatewaySecret from list response for security
  }).from(deployments).all();
  json(res, rows);
}

// ── Deployments: get one ─────────────────────────────────────────────────────
// NOTE: gatewaySecret is intentionally omitted — it is write-only (PUT only).

async function handleGetDeployment(req: IncomingMessage, res: ServerResponse, slug: string) {
  const db = getDb();
  const row = db.select({
    id:            deployments.id,
    clientSlug:    deployments.clientSlug,
    clientId:      deployments.clientId,
    gatewayUrl:    deployments.gatewayUrl,
    containerName: deployments.containerName,
    isDemo:        deployments.isDemo,
    status:        deployments.status,
    provisionedAt: deployments.provisionedAt,
    // gatewaySecret intentionally excluded — write-only field
  }).from(deployments)
    .where(eq(deployments.clientSlug, slug))
    .get();
  if (!row) return error(res, `No deployment found for client_slug=${slug}`, 404);
  json(res, row);
}

// ── Deployments: upsert (called by provision-webhook.js) ────────────────────

async function handleUpsertDeployment(req: IncomingMessage, res: ServerResponse, slug: string) {
  const body = await parseBody(req) as {
    client_id?: string;
    gateway_url?: string;
    gateway_secret?: string;
    container_name?: string;
    is_demo?: boolean;
    status?: string;
  };

  if (!body.gateway_url) return error(res, "gateway_url is required", 400);

  const db = getDb();
  const existing = db.select().from(deployments)
    .where(eq(deployments.clientSlug, slug))
    .get();

  const now = new Date().toISOString();

  if (existing) {
    // Encrypt new secret if provided; otherwise keep existing encrypted value
    const newSecret = body.gateway_secret != null
      ? encryptSecret(body.gateway_secret)
      : existing.gatewaySecret;
    db.update(deployments).set({
      clientId:      body.client_id      ?? existing.clientId,
      gatewayUrl:    body.gateway_url    ?? existing.gatewayUrl,
      gatewaySecret: newSecret,
      containerName: body.container_name ?? existing.containerName,
      isDemo:        body.is_demo        ?? existing.isDemo,
      status:        body.status         ?? existing.status,
      provisionedAt: now,
    }).where(eq(deployments.clientSlug, slug)).run();
  } else {
    db.insert(deployments).values({
      id:            randomUUID(),
      clientSlug:    slug,
      clientId:      body.client_id      ?? null,
      gatewayUrl:    body.gateway_url,
      gatewaySecret: encryptSecret(body.gateway_secret ?? null),
      containerName: body.container_name ?? `paw-client-${slug}`,
      isDemo:        body.is_demo        ?? false,
      provisionedAt: now,
      status:        body.status         ?? "active",
    }).run();
  }

  // Return updated row without the secret — gatewaySecret is write-only
  const updated = db.select({
    id:            deployments.id,
    clientSlug:    deployments.clientSlug,
    clientId:      deployments.clientId,
    gatewayUrl:    deployments.gatewayUrl,
    containerName: deployments.containerName,
    isDemo:        deployments.isDemo,
    status:        deployments.status,
    provisionedAt: deployments.provisionedAt,
  }).from(deployments)
    .where(eq(deployments.clientSlug, slug))
    .get();
  json(res, updated);
}

// ── Bot Status ────────────────────────────────────────────────────────────────

async function handleBotStatus(req: IncomingMessage, res: ServerResponse) {
  const connected = discordService.isConnected();
  json(res, {
    connected,
    guild: connected ? (process.env.DISCORD_GUILD_ID ?? null) : null,
  });
}
