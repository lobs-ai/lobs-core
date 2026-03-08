/**
 * before_prompt_build hook — inject task/project context into worker prompts.
 *
 * When a PAW-managed worker session starts, this hook injects:
 * - Task title, notes, and requirements
 * - Project context (repo path, type)
 * - Agent-specific instructions
 *
 * A/B Variant:
 *   Variant A (control):   context-first ordering  (task_id hash % 2 === 0)
 *   Variant B (treatment): task-first ordering     (task_id hash % 2 === 1)
 *
 * The assigned variant is stored in worker_runs.prompt_variant for analysis.
 */

import { eq, and, isNull } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getDb } from "../db/connection.js";
import { workerRuns, tasks, projects } from "../db/schema.js";
import { log } from "../util/logger.js";
import { scanMessage } from "../util/compliance-scanner.js";
import { isCloudModel } from "../util/compliance-model.js";
import { LearningService, inferTaskCategory } from "../services/learning.js";

const learningService = new LearningService();

const WORKSPACE_BASE = join(process.env.HOME || "/Users/lobs", ".openclaw");

/**
 * Read compliant memory files for a given agent type from memory-compliant/.
 * Only called when the session is compliance-mode (task/project has complianceRequired=true).
 */
async function readCompliantMemories(agentType: string): Promise<string[]> {
  const compliantDir = join(WORKSPACE_BASE, `workspace-${agentType}`, "memory-compliant");
  const contents: string[] = [];
  try {
    const files = await readdir(compliantDir);
    for (const f of files) {
      if (!f.endsWith(".md") && !f.endsWith(".txt")) continue;
      try {
        const content = await readFile(join(compliantDir, f), "utf-8");
        contents.push(`### ${f}\n${content.trim()}`);
      } catch {}
    }
  } catch {}
  return contents;
}

/**
 * Deterministic A/B assignment based on task_id.
 * Uses the last 8 hex chars of the task id as a numeric hash → 50/50 split.
 * Falls back to "A" if the id can't be parsed.
 */
function assignVariant(taskId: string): "A" | "B" {
  const hex = taskId.replace(/-/g, "").slice(-8);
  const num = parseInt(hex, 16);
  if (isNaN(num)) return "A";
  return num % 2 === 0 ? "A" : "B";
}

export function registerPromptBuildHook(api: OpenClawPluginApi): void {
  api.on("before_prompt_build", async (_event, ctx) => {
    const sessionKey = (ctx as Record<string, unknown>).sessionKey as string | undefined;
    if (!sessionKey) return {};

    // Check if this is a PAW-managed worker
    const db = getDb();
    const run = db.select().from(workerRuns)
      .where(and(
        eq(workerRuns.workerId, sessionKey),
        isNull(workerRuns.endedAt),
      ))
      .get();

    if (!run || !run.taskId) return {};

    const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
    if (!task) return {};

    let project = null;
    if (task.projectId) {
      project = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    }

    // Determine and persist A/B variant
    const variant = assignVariant(task.id);
    db.update(workerRuns)
      .set({ promptVariant: variant })
      .where(eq(workerRuns.id, run.id))
      .run();

    log().debug?.(`[PAW] Prompt variant ${variant} for task ${task.id} (session ${sessionKey})`);

    // ── Build context blocks ──────────────────────────────────────────

    const taskBlock: string[] = [`Task: ${task.title}`];
    if (task.notes) taskBlock.push(`Notes: ${task.notes}`);
    if (task.agent) taskBlock.push(`Agent Role: ${task.agent}`);

    const projectBlock: string[] = [];
    if (project) {
      projectBlock.push(`Project: ${project.title}`);
      if (project.repoPath) projectBlock.push(`Repo: ${project.repoPath}`);
    }

    // ── Assemble prompt according to variant ──────────────────────────

    let innerLines: string[];
    if (variant === "B") {
      // Variant B (treatment): task-first — model anchors on goal immediately
      innerLines = [...taskBlock, ...projectBlock];
    } else {
      // Variant A (control): context-first
      innerLines = [...projectBlock, ...taskBlock];
    }

    const lines = [`<paw-task-context>`, ...innerLines, `</paw-task-context>`];
    let prependContext = lines.join("\n");

    // ── Learning injection ────────────────────────────────────────────────
    // Inject relevant learnings from past task outcomes into the prompt.
    // Hot-reloadable kill switch: returns "" if LEARNING_INJECTION_ENABLED=false.
    // Confidence threshold filters out low-confidence learnings (default 0.7).
    if (task.agent) {
      try {
        const taskCategory = inferTaskCategory(task.title, task.notes ?? undefined);
        const learningBlock = learningService.buildPromptInjection(task.agent, taskCategory);
        if (learningBlock) {
          prependContext += learningBlock;
          log().debug?.(`[LEARNING] Injected learnings for agent=${task.agent} category=${taskCategory}`);
        }
      } catch (e) {
        log().warn?.(`[LEARNING] Injection error (non-fatal): ${e}`);
      }
    }

    // ── Compliance memory injection ───────────────────────────────────────
    // When the task or project has compliance_required=true, append the agent's
    // compliant memory files to the prompt. These files live in memory-compliant/
    // and are NEVER included in cloud model sessions (structural enforcement).
    const isCompliant =
      Boolean((task as Record<string, unknown>).complianceRequired) ||
      Boolean((project as Record<string, unknown> | null)?.complianceRequired);

    if (isCompliant && task.agent) {
      const compliantMemories = await readCompliantMemories(task.agent);
      if (compliantMemories.length > 0) {
        prependContext +=
          "\n\n<compliance-memories>\n" +
          compliantMemories.join("\n\n---\n\n") +
          "\n</compliance-memories>";
        log().debug?.(`[PAW] Injected ${compliantMemories.length} compliant memory file(s) for agent ${task.agent}`);
      }
    }

    // ── SAIL compliance scanner ───────────────────────────────────────────
    // Run BERT-small ONNX scan on the incoming prompt context (default-on).
    // For complianceRequired tasks, also run the LLM deep scan (opt-in).
    // On detection: warn in logs. Hard-blocking is NOT done here — the caller
    // (routing layer) is responsible for rerouting or surfacing warnings.
    // @see src/util/compliance-scanner.ts
    const scanInput = [task.title, task.notes].filter(Boolean).join("\n");
    if (scanInput) {
      try {
        const scanResult = await scanMessage(scanInput, { deepScan: isCompliant });

        if (scanResult.sensitive) {
          const model = (ctx as Record<string, unknown>).model as string | undefined;
          const isCloud = model ? isCloudModel(model) : false;
          const entityList = scanResult.entities.join(", ");

          log().warn?.(
            `[PAW] SAIL compliance scanner flagged task "${task.title}" ` +
            `— tier=${scanResult.tier}, entities=[${entityList}], conf=${scanResult.confidence.toFixed(2)}, cloud=${isCloud}` +
            (scanResult.reason ? `, reason="${scanResult.reason}"` : ""),
          );

          // Append a compliance warning to the prompt context so the agent
          // is aware that its task description contains sensitive content.
          if (isCloud) {
            prependContext +=
              "\n\n<sail-compliance-warning>\n" +
              "⚠️ This task context was flagged by the SAIL compliance scanner. " +
              `Detected: ${entityList}. ` +
              "You are currently using a cloud model. Exercise caution — do NOT repeat or expand on any sensitive data in your response.\n" +
              "</sail-compliance-warning>";
          }
        }
      } catch (scanErr) {
        // Scanner errors must never block the agent from running
        const msg = scanErr instanceof Error ? scanErr.message : String(scanErr);
        log().warn?.(`[PAW] Compliance scanner error (non-fatal): ${msg}`);
      }
    }

    return { prependContext };
  });
}
