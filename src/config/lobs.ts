import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const _require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));

const HOME = process.env.HOME ?? "";

export interface LobsRuntimeConfig {
  server?: {
    port?: number;
  };
  gateway?: {
    port?: number;
    auth?: {
      token?: string;
    };
  };
  circuitBreaker?: {
    failureThreshold?: number;
    cooldownMinutes?: number;
    windowMinutes?: number;
    enabled?: boolean;
  };
}

export function getLobsRoot(): string {
  return process.env.LOBS_ROOT ?? resolve(HOME, ".lobs");
}

export function getLobsConfigPath(): string {
  return process.env.LOBS_CONFIG ?? resolve(getLobsRoot(), "config", "lobs.json");
}

export function loadLobsConfig(): LobsRuntimeConfig {
  const configPath = getLobsConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as LobsRuntimeConfig;
  } catch {
    return {};
  }
}

export function getGatewayConfig(): { port: number; token: string } {
  const config = loadLobsConfig();
  return {
    port: config.gateway?.port ?? 18789,
    token: config.gateway?.auth?.token ?? "",
  };
}

/**
 * Get the server port for this agent instance.
 * Priority: LOBS_PORT env var > lobs.json server.port > default 9420
 */
export function getServerPort(): number {
  // Env var takes precedence
  if (process.env.LOBS_PORT) {
    const parsed = parseInt(process.env.LOBS_PORT, 10);
    if (!isNaN(parsed)) return parsed;
  }
  // Then config file
  const config = loadLobsConfig();
  console.log("[lobs:config] server port override:", config.server?.port, "from config at", getLobsConfigPath());
  if (config.server?.port) return config.server.port;
  // Default
  return 9420;
}

export function getSubagentRunsPath(): string {
  return join(getLobsRoot(), "subagents", "runs.json");
}

export function getAgentsRoot(): string {
  return join(getLobsRoot(), "agents");
}

export function getAgentDir(agentType: string): string {
  return join(getAgentsRoot(), agentType);
}

export function getAgentContextDir(agentType: string): string {
  return join(getAgentDir(agentType), "context");
}

/**
 * Get this agent's names for plain-text mention detection.
 * Reads bot.name and bot.id from identity.json in the current LOBS_ROOT.
 * Falls back to AGENT_NAME env var (Docker), then "lobs".
 * Returns lowercase names for case-insensitive matching.
 */
let _agentMentionNames: string[] | null = null;

export function getAgentMentionNames(): string[] {
  if (_agentMentionNames) return _agentMentionNames;

  const names = new Set<string>();

  // Primary source: identity.json in this agent's config dir
  const identityPath = resolve(getLobsRoot(), "config", "identity.json");
  if (existsSync(identityPath)) {
    try {
      const raw = JSON.parse(readFileSync(identityPath, "utf-8"));
      if (raw?.bot?.name) names.add(raw.bot.name.toLowerCase());
      if (raw?.bot?.id) names.add(raw.bot.id.toLowerCase());
    } catch {}
  }

  // Fallback: AGENT_NAME env var (set in Docker containers)
  if (process.env.AGENT_NAME) names.add(process.env.AGENT_NAME.toLowerCase());

  // Last resort
  if (!names.size) names.add("lobs");

  _agentMentionNames = [...names];
  return _agentMentionNames;
}

/** Reset cached agent names (for testing or config reload) */
export function resetAgentMentionCache(): void {
  _agentMentionNames = null;
}

export function getAgentMemoryDir(agentType: string): string {
  return join(getAgentContextDir(agentType), "memory");
}

export function getAgentCompliantMemoryDir(agentType: string): string {
  return join(getAgentContextDir(agentType), "memory-compliant");
}

export function getAgentSessionsDir(agentType: string): string {
  return join(getAgentDir(agentType), "sessions");
}
