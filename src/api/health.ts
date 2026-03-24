import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { json } from "./index.js";
import { isMemoryReady, getMemoryHealth } from "../services/memory/index.js";
import { discordService } from "../services/discord.js";
import { getKeyPool } from "../services/key-pool.js";

const HOME = process.env.HOME ?? "";
const PID_FILE = resolve(HOME, ".lobs/lobs.pid");
const GOOGLE_TOKEN_FILE = resolve(HOME, ".lobs/credentials/google_token.json");
const GOOGLE_CREDENTIALS_FILE = resolve(HOME, ".lobs/credentials/client_secret.json");

async function checkLmStudio(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkImagine(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:7421/health", { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function checkDb(): boolean {
  const dbPath = resolve(HOME, ".lobs/lobs.db");
  return existsSync(dbPath);
}

function getPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

// ── Service health types ─────────────────────────────────────────────────────

type ServiceStatus = "ok" | "degraded" | "down" | "unconfigured";

interface ServiceHealth {
  id: string;
  name: string;
  status: ServiceStatus;
  message?: string;
  fix?: string;
  severity: "error" | "warning" | "info";
}

async function checkGoogleToken(): Promise<{ valid: boolean; message: string }> {
  if (!existsSync(GOOGLE_TOKEN_FILE)) return { valid: false, message: "Token file missing" };
  if (!existsSync(GOOGLE_CREDENTIALS_FILE)) return { valid: false, message: "Client secret missing" };

  try {
    const token = JSON.parse(readFileSync(GOOGLE_TOKEN_FILE, "utf8"));
    if (!token.refresh_token) return { valid: false, message: "No refresh token — reauth needed" };

    const creds = JSON.parse(readFileSync(GOOGLE_CREDENTIALS_FILE, "utf8"));
    const installed = creds.installed ?? creds.web;
    const body = new URLSearchParams({
      client_id: installed.client_id,
      client_secret: installed.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    });

    const res = await fetch(token.token_uri || "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) return { valid: true, message: "Token valid" };
    const data = await res.json().catch(() => ({})) as Record<string, string>;
    return { valid: false, message: data.error_description ?? data.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { valid: false, message: String(err) };
  }
}

async function getServiceWarnings(): Promise<ServiceHealth[]> {
  const services: ServiceHealth[] = [];

  const [memoryOk, lmStudioOk, imagineOk, googleResult] = await Promise.all([
    Promise.resolve(isMemoryReady()),
    checkLmStudio(),
    checkImagine(),
    checkGoogleToken(),
  ]);

  // Memory service (in-process)
  if (!memoryOk) {
    services.push({
      id: "memory-server", name: "Memory Service", status: "down",
      message: "Memory search unavailable (in-process module not initialized)",
      fix: "Check startup logs or run: lobs restart",
      severity: "error",
    });
  }

  // LM Studio
  if (!lmStudioOk) {
    services.push({
      id: "lm-studio", name: "LM Studio", status: "down",
      message: "Local models unavailable",
      fix: "Start LM Studio or run: lobs preflight",
      severity: "warning",
    });
  }

  // Imagine
  if (!imagineOk) {
    services.push({
      id: "imagine", name: "Image Generation", status: "down",
      message: "lobs-imagine service not responding",
      fix: "Service auto-starts on demand — will recover",
      severity: "info",
    });
  }

  // Discord
  const discordState = discordService.getState();
  if (discordState !== "ready") {
    const isConnecting = discordState === "connecting" || discordState === "reconnecting";
    services.push({
      id: "discord", name: "Discord", status: isConnecting ? "degraded" : "down",
      message: isConnecting ? `Discord ${discordState}...` : "Discord disconnected",
      fix: isConnecting ? "Reconnecting automatically" : "Check Discord token or network",
      severity: isConnecting ? "warning" : "error",
    });
  }

  // Google APIs
  if (!existsSync(GOOGLE_TOKEN_FILE)) {
    services.push({
      id: "google", name: "Google APIs", status: "unconfigured",
      message: "No Google token file",
      fix: "Run: python3 scripts/google-reauth.py",
      severity: "warning",
    });
  } else if (!googleResult.valid) {
    services.push({
      id: "google", name: "Google APIs", status: "down",
      message: googleResult.message,
      fix: "Run: python3 scripts/google-reauth.py",
      severity: "error",
    });
  }

  // Key pool
  try {
    const poolStatus = getKeyPool().getFullStatus();
    for (const [provider, info] of Object.entries(poolStatus.providers)) {
      if (info.total > 0 && info.healthy === 0) {
        services.push({
          id: `keys-${provider}`, name: `${provider} API Keys`, status: "down",
          message: `All ${info.total} key(s) unhealthy`,
          fix: `Check API key quota/billing for ${provider}`,
          severity: "error",
        });
      } else if (info.total > 0 && info.healthy < info.total) {
        services.push({
          id: `keys-${provider}`, name: `${provider} API Keys`, status: "degraded",
          message: `${info.healthy}/${info.total} keys healthy`,
          fix: `Some ${provider} keys have errors — check quota/billing`,
          severity: "warning",
        });
      }
    }
  } catch {
    // Key pool not initialized yet — skip
  }

  // Database
  if (!checkDb()) {
    services.push({
      id: "database", name: "Database", status: "down",
      message: "Database file not found",
      fix: "Run: lobs restart",
      severity: "error",
    });
  }

  return services;
}

// ── Request handlers ─────────────────────────────────────────────────────────

export async function handleHealthRequest(_req: IncomingMessage, res: ServerResponse, sub?: string): Promise<void> {
  // /api/health/services — lightweight service warnings for dashboard
  if (sub === "services") {
    const warnings = await getServiceWarnings();
    return json(res, {
      services: warnings,
      hasWarnings: warnings.length > 0,
      checkedAt: new Date().toISOString(),
    });
  }

  // Default: full health check
  const [memoryReady, lmStudio] = await Promise.all([
    Promise.resolve(isMemoryReady()),
    checkLmStudio(),
  ]);

  const db = checkDb();
  const pid = getPid();
  const status = db ? "healthy" : "unhealthy";

  let memoryInfo: Record<string, unknown> = { status: "down" };
  if (memoryReady) {
    try {
      const health = await getMemoryHealth();
      memoryInfo = {
        status: health.status,
        mode: "in-process",
        uptime: health.uptime,
        documents: health.index.documents,
        chunks: health.index.chunks,
      };
    } catch {
      memoryInfo = { status: "error", mode: "in-process" };
    }
  }

  const body: Record<string, unknown> = {
    status,
    uptime: process.uptime(),
    pid: pid ?? process.pid,
    db: db ? "ok" : "error",
    memory: memoryInfo,
    lm_studio: lmStudio ? "ok" : "down",
  };

  if (!lmStudio) {
    body.lm_studio_diagnostic = {
      hint: "LM Studio appears unreachable. Run `lobs preflight` or query the diagnostic API for details.",
      api: {
        status: "/api/lm-studio",
        models: "/api/lm-studio/models",
        latency: "/api/lm-studio/latency",
      },
      cli: "lobs preflight",
    };
  }

  json(res, body);
}
