/**
 * Circuit Breaker — prevents cascading infrastructure failures.
 * Port of lobs-server/app/orchestrator/circuit_breaker.py
 */

import { log } from "../util/logger.js";

const INFRA_PATTERNS: Array<[RegExp, string]> = [
  [/gateway.*(token.*mismatch|auth.*failed|unauthorized)|unauthorized.*gateway/i, "gateway_auth"],
  [/session file locked/i, "session_lock"],
  [/No API key found for provider|missing.*api.*key/i, "missing_api_key"],
  [/connect failed.*unauthorized/i, "gateway_auth"],
  [/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i, "service_unavailable"],
  [/All models failed/i, "all_models_failed"],
  [/FailoverError/i, "failover_exhausted"],
  [/rate.?limit|429|too many requests/i, "rate_limited"],
];

interface CircuitState {
  isOpen: boolean;
  reason: string;
  openedAt: number;
  consecutiveFailures: number;
  lastFailureType: string;
}

function newState(): CircuitState {
  return { isOpen: false, reason: "", openedAt: 0, consecutiveFailures: 0, lastFailureType: "" };
}

export class CircuitBreaker {
  private threshold: number;
  private cooldownMs: number;
  private global: CircuitState = newState();
  private projects = new Map<string, CircuitState>();
  private agents = new Map<string, CircuitState>();

  constructor(threshold = 3, cooldownSeconds = 300) {
    this.threshold = threshold;
    this.cooldownMs = cooldownSeconds * 1000;
  }

  classifyFailure(errorLog: string, failureReason = ""): [boolean, string] {
    const text = `${failureReason}\n${errorLog}`;
    for (const [pattern, type] of INFRA_PATTERNS) {
      if (pattern.test(text)) return [true, type];
    }
    return [false, ""];
  }

  recordFailure(_taskId: string, projectId: string, agentType: string, errorLog: string, failureReason = ""): boolean {
    const [isInfra, infraType] = this.classifyFailure(errorLog, failureReason);
    if (!isInfra) {
      this._resetCircuit(projectId, agentType);
      return false;
    }
    this.global.consecutiveFailures++;
    this.global.lastFailureType = infraType;

    if (!this.projects.has(projectId)) this.projects.set(projectId, newState());
    const proj = this.projects.get(projectId)!;
    proj.consecutiveFailures++;
    proj.lastFailureType = infraType;

    if (!this.agents.has(agentType)) this.agents.set(agentType, newState());
    const agent = this.agents.get(agentType)!;
    agent.consecutiveFailures++;
    agent.lastFailureType = infraType;

    log().warn(`[CIRCUIT] Infra failure: ${infraType} (proj=${projectId}, agent=${agentType}, global=${this.global.consecutiveFailures}/${this.threshold})`);

    if (this.global.consecutiveFailures >= this.threshold) this._openGlobal(infraType);
    if (proj.consecutiveFailures >= this.threshold) this._openProject(projectId, infraType);
    if (agent.consecutiveFailures >= this.threshold) this._openAgent(agentType, infraType);

    return true;
  }

  recordSuccess(projectId: string, agentType: string): void {
    this._resetCircuit(projectId, agentType);
    if (this.global.isOpen) {
      log().info("[CIRCUIT] Global circuit closing — success");
      this.global = newState();
    }
  }

  shouldAllowSpawn(projectId: string, agentType: string): [boolean, string] {
    const now = Date.now();
    const agentCircuit = this.agents.get(agentType);
    if (agentCircuit?.isOpen) {
      const elapsed = now - agentCircuit.openedAt;
      if (elapsed >= this.cooldownMs) return [true, ""];
      const rem = Math.ceil((this.cooldownMs - elapsed) / 1000);
      return [false, `Circuit OPEN for ${agentType}: ${agentCircuit.lastFailureType}. ${rem}s remaining.`];
    }
    const projCircuit = this.projects.get(projectId);
    if (projCircuit?.isOpen) {
      const elapsed = now - projCircuit.openedAt;
      if (elapsed >= this.cooldownMs) return [true, ""];
      const rem = Math.ceil((this.cooldownMs - elapsed) / 1000);
      return [false, `Circuit OPEN for project ${projectId}: ${projCircuit.lastFailureType}. ${rem}s remaining.`];
    }
    if (this.global.isOpen) {
      const elapsed = now - this.global.openedAt;
      if (elapsed >= this.cooldownMs) return [true, ""];
      const rem = Math.ceil((this.cooldownMs - elapsed) / 1000);
      return [false, `GLOBAL CIRCUIT OPEN: ${this.global.reason}. ${rem}s remaining.`];
    }
    return [true, ""];
  }

  get isOpen(): boolean {
    if (this.global.isOpen) return true;
    for (const c of this.projects.values()) if (c.isOpen) return true;
    for (const c of this.agents.values()) if (c.isOpen) return true;
    return false;
  }

  getStatus(): Record<string, unknown> {
    const now = Date.now();
    return {
      global: {
        isOpen: this.global.isOpen,
        reason: this.global.reason,
        consecutiveFailures: this.global.consecutiveFailures,
        cooldownRemaining: this.global.isOpen ? Math.max(0, Math.ceil((this.cooldownMs - (now - this.global.openedAt)) / 1000)) : 0,
      },
      projects: Object.fromEntries(
        [...this.projects.entries()].filter(([, c]) => c.consecutiveFailures > 0)
          .map(([id, c]) => [id, { isOpen: c.isOpen, consecutiveFailures: c.consecutiveFailures, lastFailureType: c.lastFailureType }])
      ),
      agents: Object.fromEntries(
        [...this.agents.entries()].filter(([, c]) => c.consecutiveFailures > 0)
          .map(([t, c]) => [t, { isOpen: c.isOpen, consecutiveFailures: c.consecutiveFailures, lastFailureType: c.lastFailureType }])
      ),
    };
  }

  private _openGlobal(infraType: string): void {
    this.global.isOpen = true; this.global.openedAt = Date.now(); this.global.reason = infraType;
    log().error(`[CIRCUIT] ⚠️ GLOBAL CIRCUIT OPEN — ${infraType}`);
  }
  private _openProject(projectId: string, infraType: string): void {
    const c = this.projects.get(projectId)!;
    c.isOpen = true; c.openedAt = Date.now();
    log().error(`[CIRCUIT] ⚠️ PROJECT CIRCUIT OPEN — ${projectId}: ${infraType}`);
  }
  private _openAgent(agentType: string, infraType: string): void {
    const c = this.agents.get(agentType)!;
    c.isOpen = true; c.openedAt = Date.now();
    log().error(`[CIRCUIT] ⚠️ AGENT CIRCUIT OPEN — ${agentType}: ${infraType}`);
  }
  private _resetCircuit(projectId: string, agentType: string): void {
    if (this.projects.has(projectId)) { const was = this.projects.get(projectId)!.isOpen; this.projects.set(projectId, newState()); if (was) log().info(`[CIRCUIT] Project circuit closed: ${projectId}`); }
    if (this.agents.has(agentType)) { const was = this.agents.get(agentType)!.isOpen; this.agents.set(agentType, newState()); if (was) log().info(`[CIRCUIT] Agent circuit closed: ${agentType}`); }
  }
}
