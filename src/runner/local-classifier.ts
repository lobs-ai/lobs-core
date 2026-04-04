/**
 * Local model classifier — uses LM Studio for fast, free categorization tasks.
 *
 * This is one of our biggest advantages: we can use a local model
 * for classification, routing, summarization, and other lightweight intelligence
 * without burning API tokens.
 *
 * Use cases:
 * - Task classification (which agent type handles this?)
 * - Priority scoring (how urgent is this?)
 * - Content categorization (what topic/project does this relate to?)
 * - Tool output summarization (compress 100KB of exec output)
 * - Commit message generation
 * - Quick yes/no decisions
 * - Memory relevance scoring
 * - Sentiment/intent detection in inbox items
 */

import { log } from "../util/logger.js";
import { getLocalConfig, getModelConfig } from "../config/models.js";
import { getFreeModelPool, getOpenCodeApiKey } from "../services/free-model-pool.js";

const LM_STUDIO_BASE = process.env.LM_STUDIO_URL ?? getLocalConfig().baseUrl;
const DEFAULT_MODEL = process.env.LOCAL_MODEL ?? getLocalConfig().chatModel;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 8000; // Keep prompts small for local models

export interface ClassifyResult<T extends string = string> {
  category: T;
  confidence: number; // 0-1
  reasoning?: string;
}

export interface SummarizeResult {
  summary: string;
  keyPoints: string[];
}

/**
 * Call the local LM Studio model with a prompt.
 * Returns raw text response. Fast and free.
 * Tries free cloud models first, falls back to local LM Studio.
 */
async function callLocal(
  prompt: string,
  options?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  }
): Promise<string> {
  const maxTokens = options?.maxTokens ?? 256;
  const temperature = options?.temperature ?? 0.1;

  // Truncate prompt if too long for local model
  const truncatedPrompt = prompt.length > MAX_INPUT_CHARS
    ? prompt.slice(0, MAX_INPUT_CHARS) + "\n... [truncated]"
    : prompt;

  const messages = [{ role: "user", content: truncatedPrompt }];

  // Try free model pool first
  const cfg = getModelConfig();
  if (cfg.free?.enabled !== false) {
    const pool = getFreeModelPool();
    const freeModel = pool.getNextModel();
    if (freeModel) {
      const apiKey = getOpenCodeApiKey();
      const freeTimeoutMs = cfg.free?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), freeTimeoutMs);
      try {
        log().debug?.(`[local-classifier] Using free model ${freeModel.id}`);
        const response = await fetch(`${freeModel.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: freeModel.id,
            messages,
            max_tokens: maxTokens,
            temperature,
            stream: false,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Free model ${freeModel.id} returned ${response.status}: ${await response.text()}`);
        }

        const data = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content?.trim() ?? "";
        if (!text) throw new Error(`Free model ${freeModel.id} returned empty response`);

        pool.reportSuccess(freeModel.id);
        return text;
      } catch (err) {
        pool.reportFailure(freeModel.id);
        log().warn(`[local-classifier] Free model ${freeModel.id} failed, falling back to local: ${err}`);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  // Fallback: local LM Studio
  const model = options?.model ?? DEFAULT_MODEL;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${LM_STUDIO_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LM Studio returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Local model timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check if the local LM Studio server is available.
 */
export async function isLocalModelAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${LM_STUDIO_BASE}/models`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Classify text into one of the given categories.
 * Uses local model — fast and free.
 *
 * @example
 * const result = await classify("Fix the login button CSS", ["bug", "feature", "refactor", "docs"]);
 * // { category: "bug", confidence: 0.9 }
 */
export async function classify<T extends string>(
  text: string,
  categories: T[],
  context?: string,
): Promise<ClassifyResult<T>> {
  const prompt = `Classify the following text into exactly ONE of these categories: ${categories.join(", ")}

${context ? `Context: ${context}\n\n` : ""}Text: ${text}

Respond with ONLY a JSON object: {"category": "<one of the categories>", "confidence": <0.0-1.0>}
Do not include any other text.`;

  try {
    const raw = await callLocal(prompt, { maxTokens: 64, temperature: 0 });
    const parsed = JSON.parse(raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
    const category = parsed.category as T;

    // Validate category is in the list
    if (!categories.includes(category)) {
      log().warn(`[LOCAL_CLASSIFIER] Invalid category "${category}", using first: ${categories[0]}`);
      return { category: categories[0], confidence: 0.3 };
    }

    return {
      category,
      confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
    };
  } catch (err) {
    log().warn(`[LOCAL_CLASSIFIER] classify failed: ${err}`);
    return { category: categories[0], confidence: 0.1 };
  }
}

/**
 * Classify which agent should handle a task.
 */
export async function classifyAgent(
  title: string,
  notes: string,
): Promise<ClassifyResult<"programmer" | "researcher" | "writer" | "reviewer" | "architect">> {
  const agents = ["programmer", "researcher", "writer", "reviewer", "architect"] as const;
  const context = `Agent types:
- programmer: write code, fix bugs, run tests, implement features, devops/CI/repo setup
- researcher: investigate topics, compare options, analyze, synthesize findings
- writer: create documentation, write-ups, summaries, content
- reviewer: code review, quality checks, provide feedback on existing work
- architect: system design, technical strategy, design docs (ADRs, specs) — NEVER implementation`;

  return classify(`${title}\n\n${notes}`, [...agents], context);
}

/**
 * Classify task priority.
 */
export async function classifyPriority(
  title: string,
  notes: string,
): Promise<ClassifyResult<"critical" | "high" | "medium" | "low">> {
  const priorities = ["critical", "high", "medium", "low"] as const;
  return classify(`${title}\n\n${notes}`, [...priorities], "Priority based on urgency and impact");
}

/**
 * Classify which project a task belongs to.
 */
export async function classifyProject(
  title: string,
  notes: string,
  projectNames: string[],
): Promise<ClassifyResult> {
  return classify(
    `${title}\n\n${notes}`,
    projectNames,
    "Which project does this task belong to?",
  );
}

/**
 * Summarize text using the local model.
 * Good for compressing tool output, long documents, etc.
 */
export async function summarize(
  text: string,
  maxLength: number = 200,
): Promise<SummarizeResult> {
  const prompt = `Summarize the following text in ${maxLength} characters or less.
Also list 1-3 key points as a JSON array.

Text: ${text}

Respond with ONLY a JSON object: {"summary": "<summary>", "keyPoints": ["<point1>", "<point2>"]}`;

  try {
    const raw = await callLocal(prompt, { maxTokens: 512, temperature: 0.2 });
    const parsed = JSON.parse(raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
    return {
      summary: parsed.summary ?? text.slice(0, maxLength),
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
    };
  } catch {
    // Fallback: just truncate
    return {
      summary: text.slice(0, maxLength) + "...",
      keyPoints: [],
    };
  }
}

/**
 * Quick yes/no decision using local model.
 */
export async function decide(
  question: string,
  context?: string,
): Promise<{ answer: boolean; confidence: number }> {
  const result = await classify(
    question,
    ["yes", "no"],
    context,
  );
  return {
    answer: result.category === "yes",
    confidence: result.confidence,
  };
}

/**
 * Score relevance of a memory chunk to a query (0-1).
 * Useful for post-retrieval reranking when the ONNX reranker is down.
 */
export async function scoreRelevance(
  query: string,
  document: string,
): Promise<number> {
  const prompt = `Rate how relevant this document is to the query on a scale of 0.0 to 1.0.

Query: ${query}
Document: ${document}

Respond with ONLY a number between 0.0 and 1.0.`;

  try {
    const raw = await callLocal(prompt, { maxTokens: 8, temperature: 0 });
    const score = parseFloat(raw.trim());
    if (isNaN(score)) return 0.5;
    return Math.min(1, Math.max(0, score));
  } catch {
    return 0.5;
  }
}

/**
 * Generate a commit message from a diff.
 */
export async function generateCommitMessage(diff: string): Promise<string> {
  const prompt = `Generate a concise git commit message for this diff. Use conventional commits format (feat/fix/docs/refactor/test/chore).

Diff:
${diff}

Respond with ONLY the commit message (one line, no quotes).`;

  try {
    return await callLocal(prompt, { maxTokens: 64, temperature: 0.3 });
  } catch {
    return "chore: update files";
  }
}

/**
 * Extract structured information from unstructured text.
 */
export async function extract<T>(
  text: string,
  schema: string,
): Promise<T | null> {
  const prompt = `Extract structured data from this text according to the schema.

Schema: ${schema}

Text: ${text}

Respond with ONLY a valid JSON object matching the schema.`;

  try {
    const raw = await callLocal(prompt, { maxTokens: 512, temperature: 0 });
    return JSON.parse(raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim()) as T;
  } catch {
    return null;
  }
}
