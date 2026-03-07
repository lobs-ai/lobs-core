/**
 * Infer project_id from task title/notes when not explicitly provided.
 * Uses keyword matching against active projects. Returns null if no match.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { projects } from "../db/schema.js";
import { log } from "./logger.js";

interface ProjectRule {
  id: string;
  title: string;
  keywords: string[];
}

let cachedRules: ProjectRule[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000;

const KEYWORD_OVERRIDES: Record<string, string[]> = {
  "proj-paw": [
    "paw", "orchestrator", "control loop", "control-loop", "workflow", "worker",
    "spawn", "model chooser", "model-chooser", "task router", "task-router",
    "reviewer", "smoke-test", "smoke test", "prompt sla", "batch api",
    "model tracking", "spawn_count", "spawn count", "agent status",
    "reflection", "reflections", "sweep", "inbox", "escalation",
    "heartbeat", "stall", "watchdog", "stall_timeout", "stall-prevention",
    "guardrail", "circuit breaker", "dedup", "deduplication",
    "piiranha", "pii", "classifier", "artifact validation",
    "researcher agent", "programmer agent", "writer agent",
  ],
  "2bfb7b22-f6ec-454a-9f82-7539a302badb": [
    "nexus", "dashboard", "glass card", "glasscard", "command palette",
  ],
  "proj-shared-mem": [
    "shared memory", "shared-memory", "lobs-shared-memory", "auto-commit",
    "adr", "runbook", "index.md", "research index", "reflections to lobs",
    "route.*reflections", "sync.*adr", "workspace adr",
  ],
  "c85119a5-0ee0-42b0-94c6-7c01a0139ce1": [
    "~/apps", "apps/", "apps/_template", "fastapi+html",
  ],
  "proj-flock": ["flock"],
};

function loadRules(): ProjectRule[] {
  if (cachedRules && Date.now() - cacheTime < CACHE_TTL_MS) return cachedRules;
  try {
    const db = getDb();
    const rows = db.select().from(projects).where(eq(projects.archived, false)).all();
    cachedRules = rows.map((r: any) => {
      const title = r.title ?? "";
      const autoKeywords = title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
      const overrides = KEYWORD_OVERRIDES[r.id] ?? [];
      return {
        id: r.id,
        title,
        keywords: [...new Set([...overrides, ...autoKeywords])],
      };
    });
    cacheTime = Date.now();
  } catch (e) {
    log().error(`[PROJECT_INFERENCE] loadRules error: ${e}`);
    cachedRules = [];
  }
  return cachedRules!;
}

/**
 * Infer project_id from task title and optional notes.
 * Returns project id or null if no confident match.
 */
export function inferProjectId(title: string, notes?: string | null): string | null {
  const rules = loadRules();
  const text = `${title} ${notes ?? ""}`.toLowerCase();

  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const rule of rules) {
    let score = 0;
    for (const kw of rule.keywords) {
      if (text.includes(kw)) {
        score += kw.length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = rule.id;
    }
  }

  if (bestScore < 4) return null;

  log().debug?.(`[PROJECT_INFERENCE] "${title.slice(0, 50)}" → ${bestMatch} (score=${bestScore})`);
  return bestMatch;
}
