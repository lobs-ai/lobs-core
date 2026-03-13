/**
 * Prompt builder — assemble system prompts for worker agents.
 *
 * Each agent type gets a tailored system prompt with:
 * - Role and behavioral guidance
 * - Project context from lobs-memory (when available)
 * - Task-specific context refs
 * - Learnings from prior runs
 */

import { readFileSync, existsSync } from "node:fs";
import type { AgentSpec } from "./types.js";
import { assembleContext, type AssembledContext } from "./context-engine.js";

// ── Agent Templates ──────────────────────────────────────────────────────────

const AGENT_TEMPLATES: Record<string, string> = {
  programmer: `You are an expert programmer. Your job is to write clean, correct, well-tested code.

Rules:
- Read and understand existing code before making changes
- Follow the project's existing patterns and conventions
- Write tests for new functionality
- Run tests and ensure they pass before finishing
- Commit your changes with a clear commit message: git add -A && git commit -m "agent(programmer): <summary>"
- If you encounter an error, debug it systematically — read the error, check the relevant code, fix it
- Do NOT leave TODO comments or placeholder code — implement fully or don't implement at all

When done, verify your work compiles/builds and tests pass.`,

  writer: `You are a technical writer. Your job is to create clear, accurate documentation.

Rules:
- Write for the intended audience (developers, users, or stakeholders)
- Use concrete examples and avoid vague language
- Structure documents logically with headers and sections
- Verify technical accuracy by checking the actual code/systems
- Commit your output: git add -A && git commit -m "agent(writer): <summary>"
- Push your changes and verify the push succeeded`,

  researcher: `You are a research analyst. Your job is to investigate topics thoroughly and produce actionable findings.

Rules:
- Gather information from multiple sources
- Distinguish facts from opinions and assumptions
- Organize findings by relevance and actionability
- Include source references where applicable
- Write a clear summary with concrete recommendations
- Save your findings to the designated output location`,

  reviewer: `You are a code reviewer. Your job is to review changes for correctness, security, and quality.

Rules:
- Focus on the changed files — don't audit the entire codebase
- Check for: logic errors, security issues, missing tests, edge cases
- Be specific about issues — cite file, line, and what's wrong
- Distinguish critical issues from suggestions
- If everything looks good, say so clearly
- Checkpoint your findings as you go (in case the session is interrupted)`,

  architect: `You are a system architect. Your job is to produce design documents — NOT implementation code.

Rules:
- Produce design docs, ADRs (Architecture Decision Records), or specs
- Include: context, decision, consequences, alternatives considered
- Reference existing architecture and constraints
- Keep designs concrete and implementable
- Do NOT write implementation code — only documentation
- Commit your design doc: git add -A && git commit -m "agent(architect): <summary>"`,
};

const DEFAULT_TEMPLATE = `You are an AI agent. Complete the assigned task thoroughly and correctly.

Rules:
- Read and understand the task before starting
- Work systematically
- Verify your work before declaring done`;

// ── Prompt Builder ───────────────────────────────────────────────────────────

/**
 * Build a complete system prompt for an agent run.
 */
export function buildSystemPrompt(spec: AgentSpec): string {
  const parts: string[] = [];

  // Agent template
  const template = AGENT_TEMPLATES[spec.agent] ?? DEFAULT_TEMPLATE;
  parts.push(template);

  // Working directory context
  parts.push(`\nWorking directory: ${spec.cwd}`);

  // Current date/time
  parts.push(`Current date: ${new Date().toISOString().split("T")[0]}`);

  // Context refs — pre-loaded file content
  if (spec.context?.contextRefs?.length) {
    parts.push("\n---\n## Reference Context");
    for (const ref of spec.context.contextRefs) {
      const truncated = ref.content.length > 30000
        ? ref.content.slice(0, 30000) + "\n\n(truncated)"
        : ref.content;
      parts.push(`### File: ${ref.path}\n${truncated}`);
    }
    parts.push("---");
  }

  // Learnings
  if (spec.context?.learnings) {
    parts.push(`\n## Relevant Learnings\n${spec.context.learnings}`);
  }

  // Additional context (from lobs-memory search, etc.)
  if (spec.context?.additionalContext) {
    parts.push(`\n${spec.context.additionalContext}`);
  }

  return parts.join("\n");
}

/**
 * Build a system prompt with intelligent context from the context engine.
 *
 * This is the upgraded path — uses task classification, token budgeting,
 * and multi-layer retrieval instead of static context assembly.
 */
export async function buildSmartSystemPrompt(spec: AgentSpec): Promise<{
  systemPrompt: string;
  context: AssembledContext;
}> {
  // Assemble context using the engine
  const context = await assembleContext({
    task: spec.task,
    agentType: spec.agent,
    projectId: spec.context?.projectId,
    contextRefs: spec.context?.contextRefs?.map(r => r.path),
  });

  // Build the base prompt (agent template + working dir + date)
  const parts: string[] = [];

  const template = AGENT_TEMPLATES[spec.agent] ?? DEFAULT_TEMPLATE;
  parts.push(template);
  parts.push(`\nWorking directory: ${spec.cwd}`);
  parts.push(`Current date: ${new Date().toISOString().split("T")[0]}`);

  // Add the intelligently assembled context
  if (context.contextBlock) {
    parts.push(`\n---\n${context.contextBlock}\n---`);
  }

  // Add any additional raw context (for backwards compatibility)
  if (spec.context?.additionalContext) {
    parts.push(`\n${spec.context.additionalContext}`);
  }

  return {
    systemPrompt: parts.join("\n"),
    context,
  };
}

/**
 * Load context ref files from disk.
 * Returns only files that exist and are readable.
 */
export function loadContextRefs(paths: string[]): Array<{ path: string; content: string }> {
  const loaded: Array<{ path: string; content: string }> = [];

  for (const path of paths) {
    const resolved = path.replace(/^~/, process.env.HOME ?? "");
    if (!existsSync(resolved)) continue;

    try {
      const content = readFileSync(resolved, "utf-8").trim();
      if (content.length > 0) {
        loaded.push({ path, content: content.slice(0, 50000) });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return loaded;
}
