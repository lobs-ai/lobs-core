/**
 * CLI handler for `lobs models benchmark|status|pin|unpin|exclude|include`
 */

import { getModelBenchmark, BenchmarkResult, TestResult } from "../services/model-benchmark.js";
import { getFreeModelPool, getOpenCodeApiKey } from "../services/free-model-pool.js";

// ── ANSI colorize helper ──────────────────────────────────────────────────────

function colorize(text: string, color: string): string {
  const colors: Record<string, string> = {
    red:    "\x1b[31m",
    green:  "\x1b[32m",
    yellow: "\x1b[33m",
    blue:   "\x1b[34m",
    cyan:   "\x1b[36m",
    gray:   "\x1b[90m",
    bright: "\x1b[1m",
    dim:    "\x1b[2m",
    reset:  "\x1b[0m",
  };
  return `${colors[color] ?? ""}${text}${colors.reset}`;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function padEnd(s: string, len: number): string {
  // Strip ANSI codes for length calculation
  // eslint-disable-next-line no-control-regex
  const bare = s.replace(/\[[0-9;]*m/g, "");
  const pad = Math.max(0, len - bare.length);
  return s + " ".repeat(pad);
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatCooldown(ms: number): string {
  if (ms <= 0) return "--";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s left`;
  const m = Math.ceil(s / 60);
  return `${m}m left`;
}

function formatAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffS = Math.floor(diffMs / 1000);
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffM / 60);
  return `${diffH}h ago`;
}

function scoreColor(score: number): string {
  if (score >= 85) return "green";
  if (score >= 60) return "yellow";
  return "red";
}

// ── Status command ────────────────────────────────────────────────────────────

async function cmdModelsStatus(): Promise<void> {
  const apiKey = getOpenCodeApiKey();
  const pool = getFreeModelPool();
  const health = pool.getHealthSummary();
  const models = pool.getModels();
  const benchmark = getModelBenchmark();
  const history = benchmark.loadHistory();

  // Build score map from history
  const scoreMap = new Map<string, number>();
  for (const r of history.results) {
    scoreMap.set(r.modelId, r.overallScore);
  }

  console.log("");
  console.log(colorize("Free Model Pool Status", "bright"));

  console.log(`  API Key:  ${apiKey ? colorize("✓ configured", "green") : colorize("✗ not set", "red")}`);
  console.log(`  Pool:     ${colorize(`${health.healthy}/${health.total} models healthy`, health.healthy > 0 ? "green" : "red")}`);
  if (history.lastRun > 0) {
    console.log(`  Benchmark: ${formatAgo(history.lastRun)}`);
  } else {
    console.log(`  Benchmark: ${colorize("never run", "dim")}`);
  }

  console.log("");

  // Table header
  const COL_IDX   = 3;
  const COL_MODEL  = 25;
  const COL_SCORE  = 7;
  const COL_HEALTH = 11;
  const COL_FAIL   = 9;
  const COL_COOL   = 12;

  const header = [
    padEnd("#",        COL_IDX),
    padEnd("Model",    COL_MODEL),
    padEnd("Score",    COL_SCORE),
    padEnd("Health",   COL_HEALTH),
    padEnd("Failures", COL_FAIL),
    "Cooldown",
  ].join("  ");
  console.log("  " + colorize(header, "dim"));

  const divider = [
    "─".repeat(COL_IDX),
    "─".repeat(COL_MODEL),
    "─".repeat(COL_SCORE),
    "─".repeat(COL_HEALTH),
    "─".repeat(COL_FAIL),
    "─".repeat(COL_COOL),
  ].join("  ");
  console.log("  " + colorize(divider, "dim"));

  const excluded = new Set(history.excluded);
  const pinned = history.pinned;

  // Sort models by priority
  const sorted = [...models].sort((a, b) => a.priority - b.priority);

  let rank = 1;
  for (const m of sorted) {
    if (excluded.has(m.id)) continue;
    const score = scoreMap.get(m.id);
    const scoreStr = score !== undefined ? score.toFixed(1) : "--";
    const now = Date.now();
    const cooldownRemaining = m.cooldownUntil ? Math.max(0, m.cooldownUntil - now) : 0;
    const healthStr = m.healthy
      ? colorize("✓ healthy", "green")
      : colorize("✗ cooled", "red");
    const failStr = m.failureCount > 0 ? String(m.failureCount) : "0";
    const coolStr = !m.healthy && cooldownRemaining > 0 ? colorize(formatCooldown(cooldownRemaining), "yellow") : "--";
    const scoreColorized = score !== undefined ? colorize(scoreStr, scoreColor(score)) : colorize("--", "dim");

    const row = [
      padEnd(String(rank), COL_IDX),
      padEnd(m.id, COL_MODEL),
      padEnd(scoreColorized, COL_SCORE),
      padEnd(healthStr, COL_HEALTH),
      padEnd(failStr, COL_FAIL),
      coolStr,
    ].join("  ");
    console.log("  " + row);
    rank++;
  }

  // Excluded models
  for (const modelId of excluded) {
    const score = scoreMap.get(modelId);
    const scoreStr = score !== undefined ? score.toFixed(1) : "--";
    const row = [
      padEnd(colorize("✗", "red"), COL_IDX),
      padEnd(modelId, COL_MODEL),
      padEnd(colorize(scoreStr, "dim"), COL_SCORE),
      padEnd(colorize("excluded", "dim"), COL_HEALTH),
      padEnd("--", COL_FAIL),
      "--",
    ].join("  ");
    console.log("  " + row);
  }

  console.log("");

  if (pinned.length > 0) {
    console.log(`  ${colorize("Pinned:", "cyan")}   ${pinned.join(", ")}`);
  }
  if (excluded.size > 0) {
    console.log(`  ${colorize("Excluded:", "cyan")} ${[...excluded].join(", ")}`);
  }
  console.log("");
}

// ── Benchmark command ─────────────────────────────────────────────────────────

async function cmdRunBenchmark(): Promise<void> {
  const apiKey = getOpenCodeApiKey();
  if (!apiKey) {
    console.error(colorize("✗ No OpenCode API key configured.", "red"));
    console.error("  Set OPENCODE_API_KEY env var or add it to ~/.lobs/config/models.json");
    process.exit(1);
  }

  const pool = getFreeModelPool();
  const models = pool.getModels();
  const benchmark = getModelBenchmark();
  const history = benchmark.loadHistory();
  const excluded = new Set(history.excluded);
  const activeModels = models.filter(m => !excluded.has(m.id));

  console.log("");
  console.log(colorize(`Running benchmark against ${activeModels.length} free models...`, "cyan"));
  console.log("");

  const results: BenchmarkResult[] = [];
  for (const model of models) {
    if (excluded.has(model.id)) {
      console.log(`  ${colorize("─", "dim")} ${colorize(model.id, "dim")} ${colorize("(excluded, skipping)", "dim")}`);
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

    console.log(`  ${colorize("▶", "cyan")} Testing ${colorize(model.id, "bright")}...`);

    const testResults: TestResult[] = [];
    try {
      const result = await benchmark.benchmarkModel(
        model.id,
        model.baseUrl,
        apiKey,
        (test) => {
          const icon = test.passed ? colorize("✓", "green") : colorize("✗", "red");
          const score = test.score.toString().padStart(3);
          const latency = formatMs(test.latencyMs).padStart(6);
          console.log(`    ${icon} ${padEnd(test.name, 22)} score=${score}  latency=${latency}${test.error ? colorize(`  err: ${test.error.slice(0, 60)}`, "dim") : ""}`);
          testResults.push(test);
        },
      );
      results.push(result);
      console.log(`    ${colorize("→", "dim")} overall score: ${colorize(result.overallScore.toFixed(1), scoreColor(result.overallScore))}`);
    } catch (err) {
      console.log(`    ${colorize("✗ unreachable:", "red")} ${String(err).slice(0, 80)}`);
      results.push({
        modelId: model.id,
        timestamp: Date.now(),
        tests: testResults,
        overallScore: 0,
        latencyAvgMs: 0,
        successRate: 0,
        qualityScore: 0,
      });
    }
    console.log("");
  }

  // Print summary table
  console.log(colorize("  Results", "bright"));
  console.log("");

  const COL_MODEL   = 25;
  const COL_QUALITY = 9;
  const COL_LATENCY = 9;
  const COL_RELY    = 13;
  const COL_SCORE   = 7;
  const COL_STATUS  = 12;

  const header = [
    padEnd("Model",       COL_MODEL),
    padEnd("Quality",     COL_QUALITY),
    padEnd("Latency",     COL_LATENCY),
    padEnd("Reliability", COL_RELY),
    padEnd("Score",       COL_SCORE),
    "Status",
  ].join("  ");
  console.log("  " + colorize(header, "dim"));

  const divider = [
    "─".repeat(COL_MODEL),
    "─".repeat(COL_QUALITY),
    "─".repeat(COL_LATENCY),
    "─".repeat(COL_RELY),
    "─".repeat(COL_SCORE),
    "─".repeat(COL_STATUS),
  ].join("  ");
  console.log("  " + colorize(divider, "dim"));

  // Sort by score descending for display
  const sorted = [...results].sort((a, b) => b.overallScore - a.overallScore);
  let displayRank = 1;

  for (const r of sorted) {
    const isExcluded = excluded.has(r.modelId);
    const isUnreachable = r.successRate === 0 && r.tests.length > 0;

    const qualityStr = r.qualityScore > 0 ? String(r.qualityScore) : "--";
    const latencyStr = r.latencyAvgMs > 0 ? formatMs(r.latencyAvgMs) : "--";
    const relyStr    = r.tests.length > 0 ? `${Math.round(r.successRate * 100)}%` : "0%";
    const scoreStr   = r.overallScore > 0 ? r.overallScore.toFixed(1) : "0.0";

    let statusStr: string;
    if (isExcluded) {
      statusStr = colorize("✗ excluded", "dim");
    } else if (isUnreachable) {
      statusStr = colorize("✗ unreachable", "red");
    } else {
      statusStr = colorize(`✓ #${displayRank}`, "green");
      displayRank++;
    }

    const row = [
      padEnd(r.modelId, COL_MODEL),
      padEnd(colorize(qualityStr, r.qualityScore > 0 ? scoreColor(r.qualityScore) : "dim"), COL_QUALITY),
      padEnd(colorize(latencyStr, "cyan"), COL_LATENCY),
      padEnd(relyStr, COL_RELY),
      padEnd(colorize(scoreStr, scoreColor(r.overallScore)), COL_SCORE),
      statusStr,
    ].join("  ");
    console.log("  " + row);
  }

  console.log("");

  // Apply rankings
  benchmark.applyRankings(results);
  console.log(colorize("  Updated model priorities.", "green") + " Run `lobs models status` to see current pool.");
  console.log("");
}

// ── Pin / unpin / exclude / include ──────────────────────────────────────────

async function cmdPin(modelId: string | undefined): Promise<void> {
  if (!modelId) {
    console.error(colorize("Usage: lobs models pin <model-id>", "red"));
    process.exit(1);
  }
  const benchmark = getModelBenchmark();
  benchmark.pinModel(modelId);
  console.log(colorize(`✓ Pinned ${modelId} to top priority.`, "green"));
}

async function cmdUnpin(modelId: string | undefined): Promise<void> {
  if (!modelId) {
    console.error(colorize("Usage: lobs models unpin <model-id>", "red"));
    process.exit(1);
  }
  const benchmark = getModelBenchmark();
  benchmark.unpinModel(modelId);
  console.log(colorize(`✓ Unpinned ${modelId}.`, "green"));
}

async function cmdExclude(modelId: string | undefined): Promise<void> {
  if (!modelId) {
    console.error(colorize("Usage: lobs models exclude <model-id>", "red"));
    process.exit(1);
  }
  const benchmark = getModelBenchmark();
  benchmark.excludeModel(modelId);
  console.log(colorize(`✓ Excluded ${modelId} from rotation.`, "green"));
}

async function cmdInclude(modelId: string | undefined): Promise<void> {
  if (!modelId) {
    console.error(colorize("Usage: lobs models include <model-id>", "red"));
    process.exit(1);
  }
  const benchmark = getModelBenchmark();
  benchmark.includeModel(modelId);
  console.log(colorize(`✓ Re-included ${modelId} in rotation.`, "green"));
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function cmdModelsBenchmark(subcommand?: string, args?: string[]): Promise<void> {
  const target = args?.[0];

  switch (subcommand) {
    case "status":
      await cmdModelsStatus();
      break;

    case "pin":
      await cmdPin(target);
      break;

    case "unpin":
      await cmdUnpin(target);
      break;

    case "exclude":
      await cmdExclude(target);
      break;

    case "include":
      await cmdInclude(target);
      break;

    default:
      // Default: run benchmark
      await cmdRunBenchmark();
      break;
  }
}
