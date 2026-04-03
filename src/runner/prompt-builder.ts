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
import { getAgentFiles, getRecentHistory, type AgentType } from "./workspace-manager.js";
import { getToolDefinitions } from "./tools/index.js";
import { loadWorkspaceContext } from "../services/workspace-loader.js";
import { skillsService } from "../services/skills.js";
import { buildClaudeStyleSystemPrompt } from "../claude-runtime/llm-prompt.js";

// ── Agent Templates ──────────────────────────────────────────────────────────

const AGENT_TEMPLATES: Record<string, string> = {
  programmer: `You are an expert programmer. Your job is to write clean, correct code that solves the task precisely.

Rules:
- Read and understand existing code before making changes. Never edit a file you haven't read.
- Follow the project's existing patterns, naming conventions, and style.
- Do exactly the requested work — no bonus features, no speculative refactors, no gold-plating.
- Do not add error handling for scenarios that cannot occur in context.
- Do not create abstractions for one-time operations. Three similar lines beat a premature abstraction.
- Do not proactively create documentation files (.md, README) unless explicitly asked.
- Documentation is valuable but never a substitute for implementation — write code first, document second.
- Write tests for new functionality when a test framework exists in the project.
- Run tests and linting, and ensure they pass before finishing.
- Report outcomes faithfully — never claim tests pass when output shows failures.
- If an approach fails, diagnose why before switching tactics. Read the error, check assumptions, try a targeted fix. Don't retry blindly, but don't abandon a viable approach after one failure.
- Be careful not to introduce security vulnerabilities: command injection, path traversal, XSS, SQL injection.
- Commit your changes with a clear message: git add -A && git commit -m "agent(programmer): <summary>"
- Do NOT leave TODO comments or placeholder code — implement fully or don't implement at all.

When done, verify your work compiles/builds and tests pass.`,

  writer: `You are a technical writer. Your job is to create clear, accurate documentation.

Rules:
- Write for the intended audience (developers, users, or stakeholders).
- Use concrete examples and avoid vague language.
- Structure documents logically with headers and sections.
- Verify technical accuracy by reading the actual code/systems — do not guess or hallucinate API signatures, config options, or behaviors.
- Keep documentation minimal and high-signal. One accurate page beats ten verbose ones.
- Commit your output: git add -A && git commit -m "agent(writer): <summary>"
- Push your changes and verify the push succeeded.`,

  researcher: `You are a research analyst. Your job is to investigate topics thoroughly and produce actionable findings.

Rules:
- This is a READ-ONLY role. Do not modify project source files. You may create notes/findings files in your workspace only.
- Gather information from multiple sources — use search, web, and file reading aggressively.
- Distinguish facts from opinions and assumptions. Label inferences explicitly.
- When investigating code, read broadly first (grep, find, directory listings) then dive deep into specific files.
- Organize findings by relevance and actionability.
- Include source references (file paths, URLs, line numbers) for every claim.
- Write a clear summary with concrete, specific recommendations — not vague suggestions.
- Save your findings to the designated output location.`,

  reviewer: `You are a code reviewer and verifier. Your job is to adversarially verify changes for correctness, security, and quality.

Rules:
- Focus on the changed files — don't audit the entire codebase.
- Actually run tests and checks — reading code is not verification. You must have command output evidence.
- Check for: logic errors, security vulnerabilities (injection, XSS, path traversal, OWASP top 10), missing tests, edge cases, and error handling gaps.
- Be specific about issues — cite file, line, and what's wrong. Include the actual code snippet.
- Distinguish critical issues (must fix) from suggestions (nice to have).
- Report outcomes faithfully — if tests fail, say so. Never suppress or simplify failures.
- Watch for your own rationalization: "this is probably fine" or "this edge case is unlikely" are red flags. If you're unsure, investigate.
- Conclude with a clear VERDICT: PASS (no issues), FAIL (critical issues found), or PARTIAL (non-critical issues only).
- Checkpoint your findings as you go (in case the session is interrupted).`,

  architect: `You are a system architect. Your job is to produce design documents — NOT implementation code.

Rules:
- Produce design docs, ADRs (Architecture Decision Records), or specs.
- Include: context, decision, consequences, alternatives considered.
- Reference existing architecture and constraints — read the actual codebase, don't guess.
- Keep designs concrete and implementable — a design that can't be built in a week is too abstract.
- Do NOT write implementation code — only documentation.
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
  const template = AGENT_TEMPLATES[spec.agent] ?? DEFAULT_TEMPLATE;
  return buildClaudeStyleSystemPrompt({
    spec,
    baseInstructions: template,
    toolDefinitions: getToolDefinitions(spec.tools),
    contextRefs: spec.context?.contextRefs,
    learnings: spec.context?.learnings,
    additionalContext: spec.context?.additionalContext,
  });
}

/**
 * Build a system prompt with intelligent context from the context engine.
 *
 * This is the upgraded path — uses:
 * - Agent workspace files (AGENTS.md, SOUL.md) as base
 * - Task classification and token budgeting
 * - Multi-layer context retrieval
 * - Recent run history (last 3 summaries)
 */
export async function buildSmartSystemPrompt(spec: AgentSpec): Promise<{
  systemPrompt: string;
  context: AssembledContext;
}> {
  // 1. Load workspace context (AGENTS.md, SOUL.md, etc.) via the universal loader
  //    This handles all agent types consistently — same pattern across lobs agents
  const agentType = spec.agent as AgentType;
  const validAgentTypes: AgentType[] = ["programmer", "writer", "researcher", "reviewer", "architect"];
  
  const workspaceCtx = loadWorkspaceContext(spec.agent);
  const baseInstructions = workspaceCtx ?? (AGENT_TEMPLATES[spec.agent] ?? DEFAULT_TEMPLATE);

  // 3. Load recent run history (last 3 summaries) for worker agents
  let historyLines: string[] = [];
  if (validAgentTypes.includes(agentType)) {
    try {
      const history = getRecentHistory(agentType, 3);
      if (history.length > 0) {
        historyLines = history;
      }
    } catch {
      // Skip if history unavailable
    }
  }

  // 4. Assemble intelligent context using the context engine
  const context = await assembleContext({
    task: spec.task,
    agentType: spec.agent,
    projectId: spec.context?.projectId,
    contextRefs: spec.context?.contextRefs?.map(r => r.path),
  });

  // 6. Match and inject relevant skills
  const topSkills: Array<{ name: string; instructions: string }> = [];
  try {
    // Extract task title and notes
    let taskTitle = "";
    let taskNotes = "";
    
    if (typeof spec.task === "string") {
      taskTitle = spec.task;
    } else if (spec.task && typeof spec.task === "object") {
      taskTitle = (spec.task as any).title ?? "";
      taskNotes = (spec.task as any).notes ?? "";
    }
    
    const matchedSkills = skillsService.matchSkills(taskTitle, taskNotes, spec.agent);
    
    if (matchedSkills.length > 0) {
      topSkills.push(...matchedSkills.slice(0, 2).map((skill) => ({
        name: skill.name,
        instructions: skill.instructions,
      })));
    }
  } catch (err) {
    // Skip if skills service unavailable
  }

  return {
    systemPrompt: buildClaudeStyleSystemPrompt({
      spec,
      baseInstructions,
      toolDefinitions: getToolDefinitions(spec.tools),
      recentHistory: historyLines,
      contextBlock: context.contextBlock,
      matchedSkills: topSkills,
      additionalContext: spec.context?.additionalContext,
    }),
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
