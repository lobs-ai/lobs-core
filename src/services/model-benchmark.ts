/**
 * Model benchmark service — tests free pool models and scores them.
 *
 * Runs 5 quick tests per model (summarization, classification, reasoning,
 * instruction-following, reliability) and produces a weighted composite score.
 * Results persist to ~/.lobs/config/benchmark-results.json and are used to
 * auto-rank the free model pool.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getModelConfig, saveModelConfig } from "../config/models.js";
import { getFreeModelPool, getOpenCodeApiKey } from "./free-model-pool.js";

const HOME = process.env.HOME ?? "";
const BENCHMARK_PATH = resolve(HOME, ".lobs/config/benchmark-results.json");

// ── Types ────────────────────────────────────────────────────────────────────

export interface TestResult {
  name: string;
  category: "summarization" | "classification" | "reasoning" | "instruction-following" | "reliability";
  passed: boolean;
  score: number;      // 0-100
  latencyMs: number;
  error?: string;
}

export interface BenchmarkResult {
  modelId: string;
  timestamp: number;
  tests: TestResult[];
  overallScore: number;   // 0-100, weighted composite
  latencyAvgMs: number;
  successRate: number;    // 0-1
  qualityScore: number;   // 0-100
}

export interface BenchmarkHistory {
  lastRun: number;
  results: BenchmarkResult[];
  pinned: string[];    // Models always at top priority
  excluded: string[];  // Models never used
}

// ── Test cases ───────────────────────────────────────────────────────────────

const SUMMARIZE_INPUT = `
Artificial intelligence (AI) is intelligence demonstrated by machines, as opposed to the natural
intelligence displayed by animals including humans. AI research has been defined as the field of
study of intelligent agents, which refers to any system that perceives its environment and takes
actions that maximize its chance of achieving its goals. The term "artificial intelligence" had
previously been used to describe machines that mimic and display human cognitive skills associated
with the human mind, such as learning and problem solving. This definition has since been rejected
by major AI researchers who now describe AI in terms of rationality and acting rationally, which
does not limit how intelligence can be articulated. AI applications include advanced web search
engines, recommendation systems, understanding human speech, self-driving cars, automated
decision-making, and competing at the highest level in strategic game systems. As machines become
increasingly capable, tasks considered to require intelligence are often removed from the definition
of AI, a phenomenon known as the AI effect. For instance, optical character recognition is
frequently excluded from things considered to be AI, having become a routine technology. Modern AI
techniques include deep learning, which has produced results comparable to and in some cases
surpassing human expert performance.
`.trim();

// Key terms that a valid summary should mention
const SUMMARIZE_KEY_TERMS = ["artificial intelligence", "machines", "learning"];

const CLASSIFICATION_OPTIONS = ["bug", "feature", "question", "other"];
const CLASSIFICATION_INPUT = "The login button doesn't work when I click it on the home page.";
const CLASSIFICATION_EXPECTED = "bug";

const REASONING_INPUT = "If A is greater than B, and B is greater than C, what is the relationship between A and C? Answer in one sentence.";
const REASONING_EXPECTED = ["a is greater than c", "a > c", "a is larger than c", "a is bigger than c"];

const INSTRUCTION_INPUT = `Respond with ONLY a JSON object and nothing else. No explanation, no markdown, no code blocks. Just raw JSON. The JSON must be: {"result": "hello"}`;

const RELIABILITY_INPUT = "Please respond with just the word OK and nothing else.";

// ── API call helper ──────────────────────────────────────────────────────────

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

async function callModel(
  modelId: string,
  baseUrl: string,
  apiKey: string,
  prompt: string,
  timeoutMs = 15_000,
): Promise<{ content: string; latencyMs: number }> {
  const start = Date.now();

  const messages: ChatMessage[] = [{ role: "user", content: prompt }];

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: 500,
      temperature: 0.1,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const latencyMs = Date.now() - start;

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data?.choices?.[0]?.message?.content ?? "";
  return { content, latencyMs };
}

// ── Individual test runners ──────────────────────────────────────────────────

async function runSummarizationTest(
  modelId: string,
  baseUrl: string,
  apiKey: string,
): Promise<TestResult> {
  const prompt = `Summarize the following text in exactly 2 sentences:\n\n${SUMMARIZE_INPUT}`;

  try {
    const { content, latencyMs } = await callModel(modelId, baseUrl, apiKey, prompt);
    const lower = content.toLowerCase().trim();

    // Length check: a 2-sentence summary should be 20-400 chars
    const lengthOk = lower.length >= 20 && lower.length <= 400;
    // Key term check: should contain at least 2 of the key terms
    const keyTermHits = SUMMARIZE_KEY_TERMS.filter(t => lower.includes(t)).length;
    const contentOk = keyTermHits >= 2;
    // Sentence count: rough check — 1-4 sentences is fine
    const sentenceCount = (lower.match(/[.!?]+/g) ?? []).length;
    const sentenceOk = sentenceCount >= 1 && sentenceCount <= 4;

    const passed = lengthOk && contentOk && sentenceOk;
    const score = Math.round(
      (lengthOk ? 33 : 0) + (contentOk ? 34 : 0) + (sentenceOk ? 33 : 0),
    );

    return { name: "summarization", category: "summarization", passed, score, latencyMs };
  } catch (err) {
    return {
      name: "summarization",
      category: "summarization",
      passed: false,
      score: 0,
      latencyMs: 15_000,
      error: String(err),
    };
  }
}

async function runClassificationTest(
  modelId: string,
  baseUrl: string,
  apiKey: string,
): Promise<TestResult> {
  const opts = CLASSIFICATION_OPTIONS.join(", ");
  const prompt = `Classify the following message into exactly one of these categories: ${opts}.\n\nMessage: "${CLASSIFICATION_INPUT}"\n\nRespond with ONLY the category name, nothing else.`;

  try {
    const { content, latencyMs } = await callModel(modelId, baseUrl, apiKey, prompt);
    const lower = content.toLowerCase().trim();

    // Extract the category — allow for minor formatting (punctuation, spaces)
    const found = CLASSIFICATION_OPTIONS.find(opt => lower.includes(opt));
    const passed = found === CLASSIFICATION_EXPECTED;
    const score = passed ? 100 : (found ? 30 : 0);

    return { name: "classification", category: "classification", passed, score, latencyMs };
  } catch (err) {
    return {
      name: "classification",
      category: "classification",
      passed: false,
      score: 0,
      latencyMs: 15_000,
      error: String(err),
    };
  }
}

async function runReasoningTest(
  modelId: string,
  baseUrl: string,
  apiKey: string,
): Promise<TestResult> {
  try {
    const { content, latencyMs } = await callModel(modelId, baseUrl, apiKey, REASONING_INPUT);
    const lower = content.toLowerCase();

    const passed = REASONING_EXPECTED.some(phrase => lower.includes(phrase));
    const score = passed ? 100 : 0;

    return { name: "reasoning", category: "reasoning", passed, score, latencyMs };
  } catch (err) {
    return {
      name: "reasoning",
      category: "reasoning",
      passed: false,
      score: 0,
      latencyMs: 15_000,
      error: String(err),
    };
  }
}

async function runInstructionFollowingTest(
  modelId: string,
  baseUrl: string,
  apiKey: string,
): Promise<TestResult> {
  try {
    const { content, latencyMs } = await callModel(modelId, baseUrl, apiKey, INSTRUCTION_INPUT);
    const trimmed = content.trim();

    // Try to extract JSON — strip any accidental markdown fences
    const jsonStr = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Try finding a JSON object within the response
      const match = trimmed.match(/\{[^}]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { /* ignore */ }
      }
    }

    const hasResult = typeof parsed === "object" && parsed !== null && "result" in parsed;
    const correctValue = hasResult && (parsed as Record<string, unknown>)["result"] === "hello";
    const passed = hasResult && correctValue;
    const score = passed ? 100 : hasResult ? 50 : (parsed ? 20 : 0);

    return {
      name: "instruction-following",
      category: "instruction-following",
      passed,
      score,
      latencyMs,
    };
  } catch (err) {
    return {
      name: "instruction-following",
      category: "instruction-following",
      passed: false,
      score: 0,
      latencyMs: 15_000,
      error: String(err),
    };
  }
}

async function runReliabilityTest(
  modelId: string,
  baseUrl: string,
  apiKey: string,
): Promise<TestResult> {
  try {
    const { content, latencyMs } = await callModel(modelId, baseUrl, apiKey, RELIABILITY_INPUT, 10_000);
    const lower = content.toLowerCase().trim();
    const passed = lower.includes("ok") || lower === "ok.";
    const score = passed ? 100 : content.length > 0 ? 50 : 0;

    return { name: "reliability", category: "reliability", passed, score, latencyMs };
  } catch (err) {
    return {
      name: "reliability",
      category: "reliability",
      passed: false,
      score: 0,
      latencyMs: 10_000,
      error: String(err),
    };
  }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Compute overall score from test results.
 * Weights: quality (tests 1-4) = 50%, latency = 20%, reliability = 30%
 * Latency is normalized relative to 500ms baseline (lower is better).
 */
function computeScore(
  tests: TestResult[],
  allLatencies?: number[], // For group normalization
): { overallScore: number; qualityScore: number; latencyAvgMs: number; successRate: number } {
  const qualityTests = tests.filter(t => t.category !== "reliability");
  const reliabilityTests = tests.filter(t => t.category === "reliability");

  const qualityScore =
    qualityTests.length > 0
      ? Math.round(qualityTests.reduce((sum, t) => sum + t.score, 0) / qualityTests.length)
      : 0;

  const latencyAvgMs =
    tests.length > 0
      ? Math.round(tests.reduce((sum, t) => sum + t.latencyMs, 0) / tests.length)
      : 9999;

  const successRate =
    tests.length > 0
      ? tests.filter(t => t.passed).length / tests.length
      : 0;

  const reliabilityScore =
    reliabilityTests.length > 0
      ? Math.round(reliabilityTests.reduce((sum, t) => sum + t.score, 0) / reliabilityTests.length)
      : 0;

  // Latency score: normalized — 200ms = 100, 3000ms = 0, linear
  const maxLatencyMs = allLatencies
    ? Math.max(...allLatencies, 3000)
    : 3000;
  const latencyScore = Math.max(0, Math.min(100, Math.round(100 * (1 - latencyAvgMs / maxLatencyMs))));

  const overallScore = Math.round(
    qualityScore * 0.5 + latencyScore * 0.2 + reliabilityScore * 0.3,
  );

  return { overallScore, qualityScore, latencyAvgMs, successRate };
}

// ── ModelBenchmark class ─────────────────────────────────────────────────────

export class ModelBenchmark {
  // ── History I/O ──

  loadHistory(): BenchmarkHistory {
    if (existsSync(BENCHMARK_PATH)) {
      try {
        return JSON.parse(readFileSync(BENCHMARK_PATH, "utf-8")) as BenchmarkHistory;
      } catch { /* ignore — return fresh */ }
    }
    return { lastRun: 0, results: [], pinned: [], excluded: [] };
  }

  saveHistory(history: BenchmarkHistory): void {
    mkdirSync(resolve(HOME, ".lobs/config"), { recursive: true });
    writeFileSync(BENCHMARK_PATH, JSON.stringify(history, null, 2));
  }

  // ── Benchmark a single model ──

  async benchmarkModel(
    modelId: string,
    baseUrl: string,
    apiKey: string,
    onProgress?: (test: TestResult) => void,
  ): Promise<BenchmarkResult> {
    const tests: TestResult[] = [];

    const run = async (testFn: () => Promise<TestResult>) => {
      const result = await testFn();
      tests.push(result);
      onProgress?.(result);
    };

    await run(() => runSummarizationTest(modelId, baseUrl, apiKey));
    await run(() => runClassificationTest(modelId, baseUrl, apiKey));
    await run(() => runReasoningTest(modelId, baseUrl, apiKey));
    await run(() => runInstructionFollowingTest(modelId, baseUrl, apiKey));
    await run(() => runReliabilityTest(modelId, baseUrl, apiKey));

    const { overallScore, qualityScore, latencyAvgMs, successRate } = computeScore(tests);

    return {
      modelId,
      timestamp: Date.now(),
      tests,
      overallScore,
      qualityScore,
      latencyAvgMs,
      successRate,
    };
  }

  // ── Run full benchmark ──

  async runFullBenchmark(
    onProgress?: (modelId: string, test: TestResult) => void,
  ): Promise<BenchmarkResult[]> {
    const apiKey = getOpenCodeApiKey();
    if (!apiKey) throw new Error("No OpenCode API key configured");

    const pool = getFreeModelPool();
    const models = pool.getModels();
    const history = this.loadHistory();
    const excluded = new Set(history.excluded);

    const results: BenchmarkResult[] = [];

    for (const model of models) {
      if (excluded.has(model.id)) {
        // Return a zero-score result for excluded models
        results.push({
          modelId: model.id,
          timestamp: Date.now(),
          tests: [],
          overallScore: 0,
          latencyAvgMs: 0,
          successRate: 0,
          qualityScore: 0,
        });
        continue;
      }

      const result = await this.benchmarkModel(
        model.id,
        model.baseUrl,
        apiKey,
        (test) => onProgress?.(model.id, test),
      );
      results.push(result);
    }

    // Normalize latency scores across the group
    const latencies = results
      .filter(r => r.latencyAvgMs > 0)
      .map(r => r.latencyAvgMs);

    if (latencies.length > 0) {
      // Re-compute overall scores with group-normalized latency
      for (const result of results) {
        if (result.tests.length === 0) continue;
        const { overallScore } = computeScore(result.tests, latencies);
        result.overallScore = overallScore;
      }
    }

    // Save history
    history.lastRun = Date.now();
    history.results = results;
    this.saveHistory(history);

    return results;
  }

  // ── Apply rankings to pool ──

  applyRankings(results: BenchmarkResult[]): void {
    const history = this.loadHistory();
    const pinned = history.pinned;
    const excluded = new Set(history.excluded);

    // Sort non-pinned, non-excluded models by score descending
    const scoredModels = results
      .filter(r => !pinned.includes(r.modelId) && !excluded.has(r.modelId))
      .sort((a, b) => b.overallScore - a.overallScore);

    // Build priority assignments
    const priorities: Array<{ id: string; priority: number }> = [];

    // 1. Pinned models get priority 1..N (in pin order)
    pinned.forEach((modelId, i) => {
      priorities.push({ id: modelId, priority: i + 1 });
    });

    // 2. Ranked models get priority N+1 onward
    scoredModels.forEach((result, i) => {
      priorities.push({ id: result.modelId, priority: pinned.length + i + 1 });
    });

    // Update the free model pool
    const pool = getFreeModelPool();
    pool.updatePriorities(priorities);

    // Exclude models
    for (const modelId of excluded) {
      pool.excludeModel(modelId);
    }

    // Also persist the updated priorities to models.json
    const cfg = getModelConfig();
    if (cfg.free) {
      for (const p of priorities) {
        const m = cfg.free.models.find(m => m.id === p.id);
        if (m) m.priority = p.priority;
      }
      // Remove excluded from config
      cfg.free.models = cfg.free.models.filter(m => !excluded.has(m.id));
      saveModelConfig(cfg);
    }
  }

  // ── User overrides ──

  pinModel(modelId: string): void {
    const history = this.loadHistory();
    if (!history.pinned.includes(modelId)) {
      history.pinned.push(modelId);
      // Remove from excluded if present
      history.excluded = history.excluded.filter(id => id !== modelId);
    }
    this.saveHistory(history);
  }

  unpinModel(modelId: string): void {
    const history = this.loadHistory();
    history.pinned = history.pinned.filter(id => id !== modelId);
    this.saveHistory(history);
  }

  excludeModel(modelId: string): void {
    const history = this.loadHistory();
    if (!history.excluded.includes(modelId)) {
      history.excluded.push(modelId);
      // Remove from pinned if present
      history.pinned = history.pinned.filter(id => id !== modelId);
    }
    this.saveHistory(history);

    // Also remove from live pool
    const pool = getFreeModelPool();
    pool.excludeModel(modelId);
  }

  includeModel(modelId: string): void {
    const history = this.loadHistory();
    history.excluded = history.excluded.filter(id => id !== modelId);
    this.saveHistory(history);

    // Re-add to pool with the config's definition
    const cfg = getModelConfig();
    const modelDef = cfg.free?.models.find(m => m.id === modelId);
    if (modelDef) {
      const pool = getFreeModelPool();
      pool.includeModel(modelId, {
        provider: modelDef.provider,
        baseUrl: modelDef.baseUrl,
        priority: modelDef.priority,
      });
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _benchmark: ModelBenchmark | null = null;

export function getModelBenchmark(): ModelBenchmark {
  if (!_benchmark) _benchmark = new ModelBenchmark();
  return _benchmark;
}
