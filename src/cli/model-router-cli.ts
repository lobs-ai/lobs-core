/**
 * Model Router CLI commands
 *
 * Subcommands:
 *   status     — Show full routing status
 *   providers  — List all providers and their models
 *   usage      — Show usage breakdown per provider
 *   route      — Show what model would be selected for a category
 *   enable     — Enable a provider
 *   disable    — Disable a provider
 *   set-limit  — Set usage limit for a provider
 *   policy     — Show routing policy details
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { getModelRouter } from "../services/model-router.js";
import { getUsageTracker } from "../services/provider-usage-tracker.js";
import type { TaskCategory } from "../services/model-router.js";
import type { UsageLimits } from "../services/provider-usage-tracker.js";
import { getModelConfig, getModelForTier, setTier } from "../config/models.js";
import { loadKeyConfig } from "../config/keys.js";
import { getDb } from "../db/connection.js";
import { projects } from "../db/schema.js";
import { eq, or } from "drizzle-orm";

// ── ANSI Colors ───────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function c(text: string, color: keyof typeof C): string {
  return `${C[color]}${text}${C.reset}`;
}

function bold(text: string): string {
  return `${C.bright}${text}${C.reset}`;
}

function dim(text: string): string {
  return `${C.dim}${text}${C.reset}`;
}

function fmt$(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function pct(used: number, limit: number): string {
  if (limit === 0) return "";
  return ` (${((used / limit) * 100).toFixed(1)}%)`;
}

// ── Config path ───────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".lobs", "config", "model-router.json");

interface RouterConfig {
  policy?: unknown;
  providers?: Record<string, { enabled?: boolean; healthy?: boolean }>;
  modelOverrides?: Record<string, unknown>;
}

function loadRouterConfig(): RouterConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as RouterConfig;
  } catch {
    return {};
  }
}

function saveRouterConfig(cfg: RouterConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

// ── Task categories (kept in sync with model-router.ts) ───────────────────────

const TASK_CATEGORIES: TaskCategory[] = [
  "agent-loop",
  "subagent",
  "memory-processing",
  "classification",
  "summarization",
  "embedding",
  "background",
  "benchmark",
];

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const router = getModelRouter();
  const status = router.getStatus();
  const { providers, policy } = status;

  console.log("\n" + bold("Model Router Status"));
  console.log(c("═══════════════════", "cyan"));

  // Global policy
  console.log("\n" + bold("Routing Policy:"));
  console.log(
    `  Block training providers: ${
      policy.global.blockTrainingProviders ? c("Yes", "yellow") : c("No", "green")
    }`
  );
  console.log(
    `  Fallback to local: ${policy.global.fallbackToLocal ? c("Yes", "green") : c("No", "yellow")}`
  );
  const sensitiveCats = policy.global.sensitiveCategories.join(", ");
  console.log(`  Sensitive categories: ${c(sensitiveCats, "yellow")}`);

  // Providers
  console.log("\n" + bold("Providers:"));
  for (const p of providers) {
    let icon: string;
    let detail: string;

    if (!p.enabled) {
      icon = c("❌", "red");
      detail = c("disabled", "dim");
    } else if (!p.healthy) {
      icon = c("⚠️ ", "yellow");
      detail = c("unhealthy", "yellow");
    } else {
      icon = c("✅", "green");
      const freeCount = countFreeModels(p.id);
      const paidCount = p.modelCount - freeCount;
      if (freeCount > 0 && paidCount > 0) {
        detail = `${p.modelCount} models (${freeCount} free, ${paidCount} paid)`;
      } else if (freeCount > 0) {
        detail = `${p.modelCount} models (all free)`;
      } else {
        detail = `${p.modelCount} models`;
      }
    }

    const paddedName = p.id.padEnd(18);
    console.log(`  ${icon} ${bold(paddedName)} — ${detail}`);
  }

  // Task routing
  console.log("\n" + bold("Task Routing:"));
  const catWidth = Math.max(...Object.keys(policy.routes).map((k) => k.length));
  for (const [cat, rule] of Object.entries(policy.routes)) {
    const isSensitive = policy.global.sensitiveCategories.includes(cat as TaskCategory);
    const isLocal = rule.localOnly;
    const tiersStr = rule.allowedTiers.join(", ");
    const provStr = rule.providers.join(", ");
    const paddedCat = cat.padEnd(catWidth);

    let suffix = "";
    if (isLocal) suffix += " " + c("🔒", "cyan");
    if (isSensitive) suffix += " " + c("⚠️  sensitive", "yellow");

    console.log(
      `  ${c(paddedCat, "cyan")}  → ${provStr}  [${dim(tiersStr)}]${suffix}`
    );
  }

  console.log("");
}

function countFreeModels(providerId: string): number {
  const router = getModelRouter();
  const status = router.getStatus();
  // Re-select via selectModel isn't ideal — but we don't have a getProviders() method.
  // Use the providers list from status + selectModel free model count via internal knowledge.
  // We'll do a best-effort by calling getStatus() then iterating the policy.
  // The router doesn't expose provider models directly via getStatus, so we check
  // via multiple selectModel calls — but that's expensive.
  // Instead: since we know the providers from the status, just return 0 for unknown.
  // The actual free count comes from the providers config — we use the status hint.
  void status; // suppress unused warning
  void providerId;
  return 0;
}

async function cmdProviders(): Promise<void> {
  // Ensure keys from keys.json are loaded into process.env
  loadKeyConfig();
  const router = getModelRouter();
  const status = router.getStatus();
  const tracker = getUsageTracker();

  for (const p of status.providers) {
    const paddedStatus = p.enabled
      ? p.healthy
        ? c("enabled", "green")
        : c("unhealthy", "yellow")
      : c("disabled", "red");

    console.log("\n" + bold(p.id) + dim(` (${paddedStatus})`));

    // API key status
    const keyInfo = getProviderKeyInfo(p.id);
    if (keyInfo) {
      const keyStatus = keyInfo.set
        ? c("✅ set", "green")
        : c("❌ not set", "red");
      console.log(`  API Key: ${keyInfo.envKey} ${keyStatus}`);
    }

    // Data policy
    const dataPolicy = getProviderDataPolicy(p.id);
    if (dataPolicy) {
      const policyColor =
        dataPolicy === "no-training"
          ? "green"
          : dataPolicy === "may-train"
          ? "yellow"
          : "gray";
      console.log(`  Data Policy: ${c(dataPolicy, policyColor)}`);
    }

    // Usage summary
    const summary = tracker.getSummary(p.id);
    const hasLimits = Object.keys(summary.limitDetails).length > 0;
    if (hasLimits) {
      const parts: string[] = [];
      if (summary.limitDetails.perMonth) {
        const d = summary.limitDetails.perMonth;
        const bar = d.blocked ? c(" ⛔ OVER LIMIT", "red") : "";
        parts.push(
          `${fmt$(d.used)} / ${fmt$(d.limit)} this month${pct(d.used, d.limit)}${bar}`
        );
      }
      if (summary.limitDetails.per5Hours) {
        const d = summary.limitDetails.per5Hours;
        const bar = d.blocked ? c(" ⛔", "red") : "";
        parts.push(`${fmt$(d.used)} / ${fmt$(d.limit)} last 5h${bar}`);
      }
      if (summary.limitDetails.perWeek) {
        const d = summary.limitDetails.perWeek;
        const bar = d.blocked ? c(" ⛔", "red") : "";
        parts.push(`${fmt$(d.used)} / ${fmt$(d.limit)} this week${bar}`);
      }
      if (parts.length > 0) {
        console.log(`  Usage: ${parts.join(" | ")}`);
      }
    }

    // Model listing via selectModel probe for each category
    // Since ModelRouter doesn't expose its internal model list via getStatus,
    // we show the model count and status from what's available.
    console.log(`  Models: ${p.modelCount} total, ${p.healthyModelCount} healthy`);
  }

  console.log("");
}

async function cmdUsage(): Promise<void> {
  const tracker = getUsageTracker();
  const summaries = tracker.getAllSummaries();

  console.log("\n" + bold("Usage Summary"));
  console.log(c("═════════════", "cyan"));

  let totalThisMonth = 0;

  for (const s of summaries) {
    const hasAnyUsage =
      s.last5Hours > 0 || s.lastWeek > 0 || s.thisMonth > 0 || s.last24Hours > 0;
    const hasLimits = Object.keys(s.limitDetails).length > 0;

    if (!hasAnyUsage && !hasLimits) continue;

    totalThisMonth += s.thisMonth;

    console.log(`\n${bold(s.providerId)}:`);

    if (s.limitDetails.per5Hours) {
      const d = s.limitDetails.per5Hours;
      const bar = limitBar(d.used, d.limit);
      const blocked = d.blocked ? c(" ⛔ BLOCKED", "red") : "";
      console.log(
        `  Last 5h:    ${fmt$(d.used)} / ${fmt$(d.limit)}${pct(d.used, d.limit)}  ${bar}${blocked}`
      );
    } else if (s.last5Hours > 0) {
      console.log(`  Last 5h:    ${fmt$(s.last5Hours)}`);
    }

    if (s.limitDetails.perDay) {
      const d = s.limitDetails.perDay;
      const bar = limitBar(d.used, d.limit);
      const blocked = d.blocked ? c(" ⛔ BLOCKED", "red") : "";
      console.log(
        `  Last 24h:   ${fmt$(d.used)} / ${fmt$(d.limit)}${pct(d.used, d.limit)}  ${bar}${blocked}`
      );
    } else if (s.last24Hours > 0) {
      console.log(`  Last 24h:   ${fmt$(s.last24Hours)}`);
    }

    if (s.limitDetails.perWeek) {
      const d = s.limitDetails.perWeek;
      const bar = limitBar(d.used, d.limit);
      const blocked = d.blocked ? c(" ⛔ BLOCKED", "red") : "";
      console.log(
        `  This week:  ${fmt$(d.used)} / ${fmt$(d.limit)}${pct(d.used, d.limit)}  ${bar}${blocked}`
      );
    } else if (s.lastWeek > 0) {
      console.log(`  This week:  ${fmt$(s.lastWeek)}`);
    }

    if (s.limitDetails.perMonth) {
      const d = s.limitDetails.perMonth;
      const bar = limitBar(d.used, d.limit);
      const blocked = d.blocked ? c(" ⛔ BLOCKED", "red") : "";
      console.log(
        `  This month: ${fmt$(d.used)} / ${fmt$(d.limit)}${pct(d.used, d.limit)}  ${bar}${blocked}`
      );
    } else if (s.thisMonth > 0) {
      console.log(`  This month: ${fmt$(s.thisMonth)}`);
    }
  }

  console.log(
    `\n${bold("Total estimated spend this month:")} ${c(fmt$(totalThisMonth), "cyan")}\n`
  );
}

function limitBar(used: number, limit: number): string {
  if (limit === 0) return "";
  const pctVal = Math.min(1, used / limit);
  const width = 12;
  const filled = Math.round(pctVal * width);
  const empty = width - filled;
  const color = pctVal >= 1 ? "red" : pctVal >= 0.8 ? "yellow" : "green";
  return c("[" + "█".repeat(filled) + "░".repeat(empty) + "]", color);
}

async function cmdRoute(args: string[]): Promise<void> {
  const category = args[0] as TaskCategory | undefined;

  if (!category) {
    console.error(c("Error: category required", "red"));
    console.log(`\nUsage: lobs models route <category>`);
    console.log(`\nAvailable categories:`);
    for (const cat of TASK_CATEGORIES) {
      console.log(`  ${cat}`);
    }
    process.exit(1);
  }

  if (!TASK_CATEGORIES.includes(category)) {
    console.error(c(`Error: unknown category "${category}"`, "red"));
    console.log(`\nAvailable categories: ${TASK_CATEGORIES.join(", ")}`);
    process.exit(1);
  }

  const router = getModelRouter();
  const status = router.getStatus();
  const rule = status.policy.routes[category];

  console.log(`\n${bold("Route:")} ${c(category, "cyan")}`);
  console.log(`  Approved providers: ${rule.providers.join(", ")}`);
  console.log(`  Allowed tiers: ${rule.allowedTiers.join(", ")}`);
  console.log(`  Min quality: ${rule.minQuality}`);

  if (rule.localOnly) {
    console.log(`\n  ${c("🔒 Local only — no remote model will be selected", "cyan")}`);
    console.log("");
    return;
  }

  const selection = router.selectModel(category);
  if (!selection) {
    const isSensitive = status.policy.global.sensitiveCategories.includes(category);
    console.log(
      `\n  ${c("No model available", "yellow")} — all providers unhealthy, over limit, or filtered out.`
    );
    if (status.policy.global.fallbackToLocal) {
      console.log(`  Fallback: local (lmstudio)`);
    }
    if (isSensitive) {
      console.log(`  ${c("⚠️  Sensitive category", "yellow")} — training providers may be blocked`);
    }
  } else {
    const keyStatus = selection.apiKey ? c("✅ key set", "green") : c("⚠️  no key", "yellow");
    const policyColor =
      selection.dataPolicy === "no-training"
        ? "green"
        : selection.dataPolicy === "may-train"
        ? "yellow"
        : "gray";
    console.log(
      `\n  ${bold("Selected:")} ${c(selection.providerId, "cyan")} / ${bold(selection.modelId)}`
    );
    console.log(
      `    Tier: ${selection.costTier}  Quality: ${selection.quality}  Policy: ${c(selection.dataPolicy, policyColor)}  ${keyStatus}`
    );
    console.log(`    API format: ${selection.apiFormat}`);

    if (status.policy.global.fallbackToLocal) {
      console.log(`\n  ${dim("Fallback: local (lmstudio)")} if this provider fails`);
    }
  }
  console.log("");
}

async function cmdEnable(args: string[]): Promise<void> {
  const providerId = args[0];
  if (!providerId) {
    console.error(c("Error: provider ID required", "red"));
    console.log("Usage: lobs models enable <provider-id>");
    process.exit(1);
  }

  const cfg = loadRouterConfig();
  cfg.providers = cfg.providers ?? {};
  cfg.providers[providerId] = { ...cfg.providers[providerId], enabled: true };
  saveRouterConfig(cfg);

  getModelRouter().reload();

  console.log(c("✅", "green") + ` Enabled provider: ${bold(providerId)}`);
}

async function cmdDisable(args: string[]): Promise<void> {
  const providerId = args[0];
  if (!providerId) {
    console.error(c("Error: provider ID required", "red"));
    console.log("Usage: lobs models disable <provider-id>");
    process.exit(1);
  }

  const cfg = loadRouterConfig();
  cfg.providers = cfg.providers ?? {};
  cfg.providers[providerId] = { ...cfg.providers[providerId], enabled: false };
  saveRouterConfig(cfg);

  getModelRouter().reload();

  console.log(c("✅", "green") + ` Disabled provider: ${bold(providerId)}`);
}

async function cmdSetLimit(args: string[]): Promise<void> {
  const [providerId, period, amountStr] = args;

  const validPeriods = ["per5Hours", "perWeek", "perMonth", "perDay"] as const;
  type Period = typeof validPeriods[number];

  if (!providerId || !period || !amountStr) {
    console.error(c("Error: provider, period, and amount are required", "red"));
    console.log("Usage: lobs models set-limit <provider> <period> <amount>");
    console.log(`Periods: ${validPeriods.join(", ")}`);
    process.exit(1);
  }

  if (!validPeriods.includes(period as Period)) {
    console.error(c(`Error: invalid period "${period}"`, "red"));
    console.log(`Valid periods: ${validPeriods.join(", ")}`);
    process.exit(1);
  }

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount < 0) {
    console.error(c(`Error: invalid amount "${amountStr}"`, "red"));
    process.exit(1);
  }

  const tracker = getUsageTracker();
  const existing = tracker.getSummary(providerId).limits;
  const updated: UsageLimits = { ...existing, [period as Period]: amount };
  tracker.setLimits(providerId, updated);

  const periodLabels: Record<Period, string> = {
    per5Hours: "5-hour",
    perWeek: "weekly",
    perMonth: "monthly",
    perDay: "daily",
  };

  console.log(
    c("✅", "green") +
      ` Set ${bold(providerId)} ${periodLabels[period as Period]} limit to ${c(fmt$(amount), "cyan")}`
  );
}

async function cmdPolicy(): Promise<void> {
  const router = getModelRouter();
  const status = router.getStatus();
  const { policy } = status;

  console.log("\n" + bold("Routing Policy Details"));
  console.log(c("══════════════════════", "cyan"));

  console.log("\n" + bold("Global:"));
  console.log(
    `  blockTrainingProviders: ${
      policy.global.blockTrainingProviders ? c("true", "yellow") : c("false", "green")
    }`
  );
  console.log(
    `  fallbackToLocal: ${policy.global.fallbackToLocal ? c("true", "green") : c("false", "yellow")}`
  );
  console.log(
    `  sensitiveCategories: ${c(policy.global.sensitiveCategories.join(", "), "yellow")}`
  );

  console.log("\n" + bold("Routes:"));
  for (const [cat, rule] of Object.entries(policy.routes)) {
    const isSensitive = policy.global.sensitiveCategories.includes(cat as TaskCategory);
    const catLabel = isSensitive
      ? c(cat, "yellow") + " " + c("⚠️ ", "yellow")
      : c(cat, "cyan");

    console.log(`\n  ${catLabel}`);
    console.log(`    providers:    ${rule.providers.join(", ")}`);
    console.log(`    tiers:        ${rule.allowedTiers.join(", ")}`);
    console.log(`    minQuality:   ${rule.minQuality}`);
    if (rule.maxCostPer1MOutput > 0) {
      console.log(`    maxCostPer1M: ${fmt$(rule.maxCostPer1MOutput)}`);
    }
    if (rule.localOnly) {
      console.log(`    localOnly:    ${c("true 🔒", "cyan")}`);
    }
  }

  console.log(
    "\n" +
      dim(`Config file: ${CONFIG_PATH}`) +
      (existsSync(CONFIG_PATH)
        ? " " + c("(overrides active)", "yellow")
        : " " + c("(using defaults)", "dim")) +
      "\n"
  );
}

// ── Provider metadata helpers ─────────────────────────────────────────────────
// These mirror the static data in model-router.ts. Since ModelRouter doesn't
// expose provider detail via getStatus(), we keep minimal info here.

interface ProviderMeta {
  envKey: string;
  dataPolicy: string;
}

const PROVIDER_META: Record<string, ProviderMeta> = {
  "opencode-zen": { envKey: "OPENCODE_API_KEY", dataPolicy: "may-train (free models)" },
  "opencode-go": { envKey: "OPENCODE_API_KEY", dataPolicy: "no-training" },
  "z-ai": { envKey: "ZAI_API_KEY", dataPolicy: "unknown" },
  "minimax": { envKey: "MINIMAX_API_KEY", dataPolicy: "unknown" },
  "kimi": { envKey: "KIMI_API_KEY", dataPolicy: "unknown" },
  "anthropic": { envKey: "ANTHROPIC_API_KEY", dataPolicy: "no-training" },
  "openai": { envKey: "OPENAI_API_KEY", dataPolicy: "no-training" },
  "openai-codex": { envKey: "OPENAI_CODEX_TOKEN", dataPolicy: "no-training" },
  "lmstudio": { envKey: "", dataPolicy: "local (no training)" },
};

function getProviderKeyInfo(
  providerId: string
): { envKey: string; set: boolean } | null {
  const meta = PROVIDER_META[providerId];
  if (!meta || !meta.envKey) return null;
  return {
    envKey: meta.envKey,
    set: !!process.env[meta.envKey],
  };
}

function getProviderDataPolicy(providerId: string): string | null {
  return PROVIDER_META[providerId]?.dataPolicy ?? null;
}

async function cmdTiers(): Promise<void> {
  const cfg = getModelConfig();
  const tiers = cfg.tiers as Record<string, string>;

  console.log("\n" + bold("Model Tiers"));
  console.log(c("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550", "cyan"));

  const maxLen = Math.max(...Object.keys(tiers).map((k) => k.length));
  for (const [tier, model] of Object.entries(tiers)) {
    console.log(`  ${c(tier.padEnd(maxLen), "cyan")}  \u2192 ${model}`);
  }

  // Project overrides
  const db = getDb();
  const rows = db
    .select({ id: projects.id, title: projects.title, defaultModelTier: projects.defaultModelTier })
    .from(projects)
    .all();

  const withTier = rows.filter((r: { id: string; title: string; defaultModelTier: string | null }) => r.defaultModelTier);
  const withoutTier = rows.filter((r: { id: string; title: string; defaultModelTier: string | null }) => !r.defaultModelTier);

  console.log("\n" + bold("Project Overrides:"));
  for (const row of withTier) {
    const model = row.defaultModelTier ? getModelForTier(row.defaultModelTier) : null;
    console.log(`  ${c(row.title, "cyan")}  \u2192 ${row.defaultModelTier} (${model ?? "unknown"})`);
  }
  for (const row of withoutTier.slice(0, 5)) {
    console.log(`  ${dim(row.title)}  \u2192 ${dim("(system default)")}`);
  }
  if (withoutTier.length > 5) {
    console.log(dim(`  ... and ${withoutTier.length - 5} more with system default`));
  }

  console.log("");
}
async function cmdSetTier(args: string[]): Promise<void> {
  const [tier, model] = args;
  if (!tier || !model) {
    console.error(c("Error: tier and model are required", "red"));
    console.log("Usage: lobs models set-tier <tier> <model>");
    process.exit(1);
  }

  try {
    setTier(tier, model);
    console.log(c("✅", "green") + ` Set tier ${bold(tier)} → ${c(model, "cyan")}`);
  } catch (err) {
    console.error(c(`Error: ${(err as Error).message}`, "red"));
    process.exit(1);
  }
}

async function cmdSetProjectTier(args: string[]): Promise<void> {
  const [projectRef, tier] = args;
  if (!projectRef || !tier) {
    console.error(c("Error: project and tier are required", "red"));
    console.log("Usage: lobs models set-project-tier <project-id-or-title> <tier>");
    process.exit(1);
  }

  // Validate tier exists
  const cfg = getModelConfig();
  const tiers = cfg.tiers as Record<string, string>;
  if (!(tier in tiers)) {
    console.error(c(`Error: unknown tier "${tier}". Valid: ${Object.keys(tiers).join(", ")}`, "red"));
    process.exit(1);
  }

  const db = getDb();
  // Look up project by ID or title (case-insensitive)
  const row = db
    .select({ id: projects.id, title: projects.title })
    .from(projects)
    .where(or(eq(projects.id, projectRef), eq(projects.title, projectRef)))
    .get();

  if (!row) {
    console.error(c(`Error: project not found: "${projectRef}"`, "red"));
    process.exit(1);
  }

  db.update(projects).set({ defaultModelTier: tier }).where(eq(projects.id, row.id)).run();

  console.log(c("✅", "green") + ` Set project ${bold(row.title)} default tier → ${c(tier, "cyan")}`);
}


// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`\n${bold("lobs models")} — Model router management\n`);
  console.log("Subcommands:");
  console.log("  status              Show router status and routing policy");
  console.log("  providers           List all providers and their models");
  console.log("  usage               Show usage breakdown per provider");
  console.log("  route <category>    Show what model would be selected for a task");
  console.log("  enable <id>         Enable a provider");
  console.log("  disable <id>        Disable a provider");
  console.log(
    "  set-limit <p> <period> <$>  Set usage limit (periods: per5Hours, perWeek, perMonth, perDay)"
  );
  console.log("  policy              Show routing policy details");
  console.log("  tiers               Show current tier → model mappings");
  console.log("  set-tier <t> <m>    Update a tier mapping");
  console.log("  set-project-tier <project> <tier>  Set project default tier\n");
  console.log(`Task categories: ${TASK_CATEGORIES.join(", ")}\n`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function cmdModelRouter(
  subcommand: string,
  args: string[]
): Promise<void> {
  switch (subcommand) {
    case "status":
      await cmdStatus();
      break;
    case "providers":
      await cmdProviders();
      break;
    case "usage":
      await cmdUsage();
      break;
    case "route":
      await cmdRoute(args);
      break;
    case "enable":
      await cmdEnable(args);
      break;
    case "disable":
      await cmdDisable(args);
      break;
    case "set-limit":
      await cmdSetLimit(args);
      break;
    case "policy":
      await cmdPolicy();
      break;
    case "tiers":
      await cmdTiers();
      break;
    case "set-tier":
      await cmdSetTier(args);
      break;
    case "set-project-tier":
      await cmdSetProjectTier(args);
      break;
    default:
      printHelp();
      break;
  }
}
