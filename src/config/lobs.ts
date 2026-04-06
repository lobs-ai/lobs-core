import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HOME = process.env.HOME ?? "";

export interface LobsRuntimeConfig {
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

export function getAgentMemoryDir(agentType: string): string {
  return join(getAgentContextDir(agentType), "memory");
}

export function getAgentCompliantMemoryDir(agentType: string): string {
  return join(getAgentContextDir(agentType), "memory-compliant");
}

export function getAgentSessionsDir(agentType: string): string {
  return join(getAgentDir(agentType), "sessions");
}
