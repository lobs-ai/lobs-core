/**
 * Task decomposition system — automatically splits complex tasks into subtasks.
 *
 * Uses a small/fast model (haiku or local) to analyze tasks and identify
 * distinct steps that can be broken into separate subtasks with dependencies.
 */

import { log } from "../util/logger.js";
import { runAgent } from "../runner/index.js";
import { getRawDb } from "../db/connection.js";

export interface DecomposedTask {
  title: string;
  agentType: string;
  notes: string;
  /** IDs of tasks that must complete before this one */
  dependsOn?: string[];
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  agent?: string;
  projectId?: string;
}

/**
 * Analyze a task and decompose it into subtasks if it's complex.
 *
 * Returns:
 * - Empty array if task is simple (single step)
 * - Array of subtasks with dependencies if task is complex
 *
 * Subtasks are inserted into the DB with blocked_by references.
 * Original task becomes a "parent" that completes when all children complete.
 */
export async function decomposeTask(task: Task): Promise<DecomposedTask[]> {
  log().info(`[DECOMPOSER] Analyzing task ${task.id.slice(0, 8)}: "${task.title.slice(0, 60)}"`);

  // Build decomposition prompt
  const decompPrompt = `
# Task Decomposition Analysis

You are an expert project manager. Analyze this task and determine if it should be split into subtasks.

## Task
**Title:** ${task.title}

**Description:**
${task.notes ?? "(no description)"}

---

**Your job:** Determine if this task has multiple distinct steps that should be handled separately.

**Split if:**
- Task mentions "design AND implement" (these are separate phases)
- Task has multiple clear deliverables (docs, code, tests, deployment)
- Task spans multiple systems or repos
- Task requires research before execution

**Don't split if:**
- Task is a single coherent action (e.g., "fix bug X", "add feature Y")
- Steps are tightly coupled and must be done together
- Task is already scoped to one deliverable

**Respond with ONE of:**

1. \`SIMPLE\` — task is fine as-is, no decomposition needed
2. \`COMPLEX\` — task should be split, followed by subtasks in this format:

\`\`\`
COMPLEX

SUBTASKS:
1. [agent_type] Title of subtask 1
   Notes: Brief description
   DependsOn: (none or list of subtask numbers this depends on)

2. [agent_type] Title of subtask 2
   Notes: Brief description
   DependsOn: 1

3. [agent_type] Title of subtask 3
   Notes: Brief description  
   DependsOn: 1,2
\`\`\`

**Agent types:** programmer, writer, researcher, reviewer, architect

**Important:**
- Use \`architect\` for design-only tasks (ADRs, specs, diagrams)
- Use \`programmer\` for implementation
- Set up dependency chains correctly (e.g., design must complete before implement)
`.trim();

  try {
    // Use haiku for fast decomposition analysis
    const result = await runAgent({
      task: decompPrompt,
      agent: "researcher", // Use researcher for analysis
      model: "anthropic/claude-haiku-4-5-20250507", // Fast, cheap model
      cwd: process.cwd(),
      tools: [], // No tools needed — just analysis
      timeout: 120, // 2 minutes max
      maxTurns: 5,
    });

    if (!result.succeeded) {
      log().warn(`[DECOMPOSER] Analysis failed for task ${task.id.slice(0, 8)}: ${result.error}`);
      return [];
    }

    // Parse output
    const output = result.output.trim();

    if (output.startsWith("SIMPLE") || !output.includes("COMPLEX")) {
      log().info(`[DECOMPOSER] Task ${task.id.slice(0, 8)} is simple — no decomposition`);
      return [];
    }

    // Parse subtasks
    const subtasks = parseSubtasks(output);

    if (subtasks.length === 0) {
      log().warn(`[DECOMPOSER] Failed to parse subtasks for task ${task.id.slice(0, 8)}`);
      return [];
    }

    log().info(
      `[DECOMPOSER] Decomposed task ${task.id.slice(0, 8)} into ${subtasks.length} subtasks`,
    );

    // Insert subtasks into DB with dependencies
    const insertedIds = insertSubtasks(task, subtasks);

    // Mark original task as "decomposed" — it will complete when children complete
    markAsDecomposed(task.id, insertedIds);

    return subtasks;
  } catch (error) {
    log().error(`[DECOMPOSER] Error analyzing task ${task.id.slice(0, 8)}: ${error}`);
    return [];
  }
}

/**
 * Parse subtasks from decomposer output.
 */
function parseSubtasks(output: string): DecomposedTask[] {
  const subtasks: DecomposedTask[] = [];

  // Extract SUBTASKS section
  const subtasksMatch = output.match(/SUBTASKS:(.*)/is);
  if (!subtasksMatch) return [];

  const subtasksText = subtasksMatch[1];
  const lines = subtasksText.split("\n");

  let currentSubtask: Partial<DecomposedTask> | null = null;

  for (const line of lines) {
    // Match subtask header: "1. [agent_type] Title"
    const headerMatch = line.match(/^\s*\d+\.\s*\[(\w+)\]\s*(.+)/);
    if (headerMatch) {
      // Save previous subtask if exists
      if (currentSubtask && currentSubtask.title && currentSubtask.agentType) {
        subtasks.push(currentSubtask as DecomposedTask);
      }

      // Start new subtask
      currentSubtask = {
        agentType: headerMatch[1],
        title: headerMatch[2].trim(),
        notes: "",
        dependsOn: [],
      };
      continue;
    }

    // Match notes line
    const notesMatch = line.match(/^\s*Notes:\s*(.+)/i);
    if (notesMatch && currentSubtask) {
      currentSubtask.notes = notesMatch[1].trim();
      continue;
    }

    // Match dependsOn line
    const depsMatch = line.match(/^\s*DependsOn:\s*(.+)/i);
    if (depsMatch && currentSubtask) {
      const depsText = depsMatch[1].trim();
      if (depsText !== "(none)" && depsText !== "none") {
        // Parse comma-separated numbers
        const depNumbers = depsText
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n));
        currentSubtask.dependsOn = depNumbers.map((n) => `subtask-${n}`);
      }
      continue;
    }
  }

  // Save last subtask
  if (currentSubtask && currentSubtask.title && currentSubtask.agentType) {
    subtasks.push(currentSubtask as DecomposedTask);
  }

  return subtasks;
}

/**
 * Insert subtasks into the database with dependency references.
 */
function insertSubtasks(parentTask: Task, subtasks: DecomposedTask[]): string[] {
  const db = getRawDb();
  const insertedIds: string[] = [];
  const idMap = new Map<string, string>(); // subtask-N → actual UUID

  // First pass: create all subtasks
  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];
    const subtaskId = db
      .prepare(
        `INSERT INTO tasks (id, title, notes, status, agent, project_id, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, 'active', ?, ?, datetime('now'), datetime('now'))
         RETURNING id`,
      )
      .get(
        `${subtask.title}`,
        subtask.notes,
        subtask.agentType,
        parentTask.projectId ?? null,
      ) as { id: string };

    insertedIds.push(subtaskId.id);
    idMap.set(`subtask-${i + 1}`, subtaskId.id);

    log().debug?.(
      `[DECOMPOSER] Created subtask ${i + 1}/${subtasks.length}: ${subtaskId.id.slice(0, 8)} (${subtask.agentType})`,
    );
  }

  // Second pass: set up blocked_by dependencies
  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];
    const subtaskId = insertedIds[i];

    if (subtask.dependsOn && subtask.dependsOn.length > 0) {
      // Resolve placeholder IDs to actual UUIDs
      const blockedByIds = subtask.dependsOn
        .map((dep) => idMap.get(dep))
        .filter((id): id is string => id !== undefined);

      if (blockedByIds.length > 0) {
        db.prepare(`UPDATE tasks SET blocked_by = ? WHERE id = ?`).run(
          JSON.stringify(blockedByIds),
          subtaskId,
        );

        log().debug?.(
          `[DECOMPOSER] Subtask ${subtaskId.slice(0, 8)} depends on ${blockedByIds.map((id) => id.slice(0, 8)).join(", ")}`,
        );
      }
    }
  }

  return insertedIds;
}

/**
 * Mark the original task as decomposed and link to children.
 */
function markAsDecomposed(taskId: string, childIds: string[]): void {
  const db = getRawDb();

  // Store child IDs in notes or a new field
  db.prepare(
    `UPDATE tasks 
     SET work_state = 'decomposed',
         notes = COALESCE(notes, '') || '\n\n---\nDecomposed into subtasks: ' || ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(childIds.map((id) => id.slice(0, 8)).join(", "), taskId);

  log().info(
    `[DECOMPOSER] Marked task ${taskId.slice(0, 8)} as decomposed (${childIds.length} children)`,
  );
}
