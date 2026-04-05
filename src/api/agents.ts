import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../db/connection.js";
import { agentProfiles, agentStatus } from "../db/schema.js";
import { json } from "./index.js";
import { getActiveAgents } from "../runner/tools/agent-control.js";

export async function handleAgentRequest(_req: IncomingMessage, res: ServerResponse, _id?: string): Promise<void> {
  const db = getDb();
  const profiles = db.select().from(agentProfiles).all();
  const statuses = db.select().from(agentStatus).all();
  const merged = profiles.map(p => ({ ...p, status: statuses.find(s => s.agentType === p.agentType) ?? null }));
  return json(res, merged);
}

/** Get currently running subagents for Nexus UI */
export async function handleActiveAgentsRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const agents = getActiveAgents();
  return json(res, agents);
}
