/**
 * Config CLI — manage keys, tiers, fallbacks, and task routes
 *
 * Subcommands:
 *   show                  — Full config overview
 *   keys                  — List API keys (masked)
 *   set-key               — Add/update an API key
 *   remove-key            — Remove an API key
 *   set-fallback          — Set tier fallback chain
 *   set-agent-fallback    — Set agent fallback chain
 *   routes                — Show task→tier routing
 *   set-route             — Set task category route
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { getModelConfig, saveModelConfig, resetModelConfig, setTier, DEFAULT_CONFIG } from "../config/models.js";

// ── Paths ─────────────────────────────────────────────────────────────────────

const HOME = homedir();
const CONFIG_DIR = resolve(HOME, ".lobs/config");
const SECRETS_DIR = resolve(CONFIG_DIR, "secrets");
const KEYS_PATH = resolve(SECRETS_DIR, "keys.json");
const MODELS_PATH = resolve(CONFIG_DIR, "models.json");

// ── ANSI Colors ───────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function c(text: string, color: keyof typeof C): string {
  return `${C[color]}${text}${C.reset}`;
}

function bold(text: string): string {
  return `${C.bright}${text}${C.reset}`;
}

// ── Known providers ───────────────────────────────────────────────────────────

const KNOWN_PROVIDERS = [
  "anthropic",
  "openai",
  "openai-codex",
  "opencode-go",
  "opencode-zen",
  "z-ai",
  "minimax",
  "kimi",
];

/** Map provider ID → env var name */
const PROVIDER_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-codex": "OPENAI_CODEX_TOKEN",
  "opencode-go": "OPENCODE_API_KEY",
  "opencode-zen": "OPENCODE_API_KEY",
  "z-ai": "Z_AI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  kimi: "KIMI_API_KEY",
};

// ── Task categories ───────────────────────────────────────────────────────────

const TASK_CATEGORIES = [
  "agent-loop",
  "subagent",
  "memory-processing",
  "classification",
  "summarization",
  "embedding",
  "background",
  "benchmark",
] as const;

type TaskCategory = typeof TASK_CATEGORIES[number];

// ── Keys file I/O ─────────────────────────────────────────────────────────────

interface KeyEntry {
  key: string;
  label: string;
}

type KeysFile = Record<string, KeyEntry[]>;

function loadKeys(): KeysFile {
  if (!existsSync(KEYS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(KEYS_PATH, "utf-8")) as KeysFile;
  } catch {
    return {};
  }
}

function saveKeys(keys: KeysFile): void {
  mkdirSync(dirname(KEYS_PATH), { recursive: true });
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2) + "\n", "utf-8");
}

function maskKey(key: string): string {
  if (!key) return c("(empty)", "gray");
  if (key.length <= 6) return "*".repeat(key.length);
  return "..." + key.slice(-6);
}

// ── Models file I/O ───────────────────────────────────────────────────────────

interface ModelsFileExtended {
  tiers?: Record<string, string>;
  tierFallbacks?: Record<string, string[]>;
  agents?: Record<string, { primary: string; fallbacks: string[] }>;
  taskRoutes?: Record<string, string>;
  local?: Record<string, unknown>;
  voice?: { realtimeModel?: string; transcriptionModel?: string };
  scheduler?: Record<string, unknown>;
  costs?: Record<string, unknown>;
  contextLimits?: Record<string, unknown>;
  [key: string]: unknown;
}

function loadModelsFile(): ModelsFileExtended {
  if (!existsSync(MODELS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(MODELS_PATH, "utf-8")) as ModelsFileExtended;
  } catch {
    return {};
  }
}

function saveModelsFile(data: ModelsFileExtended): void {
  mkdirSync(dirname(MODELS_PATH), { recursive: true });
  writeFileSync(MODELS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
  resetModelConfig();
}

// ── Subcommand: keys ──────────────────────────────────────────────────────────

function cmdKeys(): void {
  const keys = loadKeys();

  console.log("\n" + bold("API Keys"));
  console.log(c("════════", "cyan"));
  console.log("");

  for (const provider of KNOWN_PROVIDERS) {
    const entries = keys[provider];
    if (!entries || entries.length === 0) {
      console.log(c(provider + ":", "gray") + c("  (not configured)", "dim"));
      continue;
    }

    console.log(bold(provider + ":"));
    for (const entry of entries) {
      const masked = maskKey(entry.key);
      const status = entry.key
        ? c("✅", "green")
        : c("⚠️ ", "yellow") + c(" not set", "yellow");
      const label = entry.label.padEnd(12);
      console.log(`  ${label} ${masked.padEnd(12)}  ${status}`);
    }
  }

  // Show any extra providers not in KNOWN_PROVIDERS
  for (const provider of Object.keys(keys)) {
    if (KNOWN_PROVIDERS.includes(provider)) continue;
    const entries = keys[provider];
    console.log(bold(provider + ":") + c("  (custom)", "dim"));
    for (const entry of entries) {
      const masked = maskKey(entry.key);
      const status = entry.key ? c("✅", "green") : c("⚠️  not set", "yellow");
      const label = entry.label.padEnd(12);
      console.log(`  ${label} ${masked.padEnd(12)}  ${status}`);
    }
  }

  console.log("");
}

// ── Subcommand: set-key ───────────────────────────────────────────────────────

function cmdSetKey(args: string[]): void {
  // Parse: set-key <provider> <key> [--label <name>]
  if (args.length < 2) {
    console.error(c("Error: provider and key are required", "red"));
    console.log("Usage: lobs config set-key <provider> <key> [--label <name>]");
    process.exit(1);
  }

  const [provider, key] = args;
  let label = "default";
  const labelIdx = args.indexOf("--label");
  if (labelIdx !== -1 && args[labelIdx + 1]) {
    label = args[labelIdx + 1];
  }

  const keys = loadKeys();
  if (!keys[provider]) keys[provider] = [];

  const existing = keys[provider].findIndex((e) => e.label === label);
  if (existing !== -1) {
    keys[provider][existing].key = key;
    console.log(c("✅", "green") + ` Updated key for ${bold(provider)} (label: ${label})`);
  } else {
    keys[provider].push({ key, label });
    console.log(c("✅", "green") + ` Added key for ${bold(provider)} (label: ${label})`);
  }

  saveKeys(keys);

  // Set env var for current process so it takes effect immediately
  const envKey = PROVIDER_ENV[provider];
  if (envKey) {
    process.env[envKey] = key;
    console.log(c("  →", "dim") + ` Set ${envKey} in current process`);
  }
}

// ── Subcommand: remove-key ────────────────────────────────────────────────────

function cmdRemoveKey(args: string[]): void {
  if (args.length < 1) {
    console.error(c("Error: provider is required", "red"));
    console.log("Usage: lobs config remove-key <provider> [--label <name>]");
    process.exit(1);
  }

  const [provider] = args;
  let label: string | undefined;
  const labelIdx = args.indexOf("--label");
  if (labelIdx !== -1 && args[labelIdx + 1]) {
    label = args[labelIdx + 1];
  }

  const keys = loadKeys();
  if (!keys[provider] || keys[provider].length === 0) {
    console.error(c(`Error: no keys configured for provider "${provider}"`, "red"));
    process.exit(1);
  }

  if (label) {
    const before = keys[provider].length;
    keys[provider] = keys[provider].filter((e) => e.label !== label);
    if (keys[provider].length === before) {
      console.error(c(`Error: no key with label "${label}" for provider "${provider}"`, "red"));
      process.exit(1);
    }
    if (keys[provider].length === 0) delete keys[provider];
    saveKeys(keys);
    console.log(c("✅", "green") + ` Removed key for ${bold(provider)} (label: ${label})`);
  } else if (keys[provider].length === 1) {
    const removed = keys[provider][0];
    delete keys[provider];
    saveKeys(keys);
    console.log(c("✅", "green") + ` Removed key for ${bold(provider)} (label: ${removed.label})`);
  } else {
    const labels = keys[provider].map((e) => e.label).join(", ");
    console.error(c(`Error: provider "${provider}" has multiple keys. Specify --label:`, "red"));
    console.log(`  Labels: ${labels}`);
    process.exit(1);
  }
}

// ── Subcommand: set-fallback ──────────────────────────────────────────────────

function cmdSetFallback(args: string[]): void {
  if (args.length < 2) {
    console.error(c("Error: tier and at least one model are required", "red"));
    console.log("Usage: lobs config set-fallback <tier> <model1> [model2...]");
    process.exit(1);
  }

  const [tier, ...models] = args;
  const data = loadModelsFile();
  if (!data.tierFallbacks) data.tierFallbacks = {};
  data.tierFallbacks[tier] = models;
  saveModelsFile(data);

  const chain = models.join(" → ");
  console.log(c("✅", "green") + ` Set fallbacks for tier ${c(tier, "cyan")}: ${chain}`);
}

// ── Subcommand: set-agent-fallback ────────────────────────────────────────────

function cmdSetAgentFallback(args: string[]): void {
  if (args.length < 2) {
    console.error(c("Error: agent and at least one model are required", "red"));
    console.log("Usage: lobs config set-agent-fallback <agent> <model1> [model2...]");
    process.exit(1);
  }

  const [agent, ...models] = args;
  const data = loadModelsFile();
  if (!data.agents) data.agents = {};
  if (!data.agents[agent]) {
    // Use first model as primary if agent doesn't exist yet
    data.agents[agent] = { primary: models[0], fallbacks: models.slice(1) };
    const chain = models.join(" → ");
    console.log(c("✅", "green") + ` Created agent ${c(agent, "cyan")} with primary: ${models[0]}, fallbacks: ${models.slice(1).join(" → ") || "(none)"}`);
  } else {
    data.agents[agent].fallbacks = models;
    const chain = models.join(" → ");
    console.log(c("✅", "green") + ` Set fallbacks for agent ${c(agent, "cyan")}: ${chain}`);
  }
  saveModelsFile(data);
}

// ── Subcommand: routes ────────────────────────────────────────────────────────

function cmdRoutes(): void {
  const data = loadModelsFile();
  const cfg = getModelConfig();
  const taskRoutes = data.taskRoutes ?? {};
  const tiers = (data.tiers ?? {}) as Record<string, string>;

  // Defaults for categories not explicitly set
  const DEFAULT_ROUTES: Record<TaskCategory, string> = {
    "agent-loop":         "standard",
    "subagent":           "standard",
    "memory-processing":  "small",
    "classification":     "small",
    "summarization":      "local",
    "embedding":          "local",
    "background":         "small",
    "benchmark":          "medium",
  };

  const SENSITIVE: Set<string> = new Set(["memory-processing", "summarization", "embedding"]);
  const LOCAL_ONLY: Set<string> = new Set(["summarization", "embedding"]);

  console.log("\n" + bold("Task Routes"));
  console.log(c("═══════════", "cyan"));
  console.log("");

  const catWidth = Math.max(...TASK_CATEGORIES.map((c) => c.length));

  for (const cat of TASK_CATEGORIES) {
    const tier = (taskRoutes[cat] as string | undefined) ?? DEFAULT_ROUTES[cat];
    const model =
      tier === "local"
        ? "lmstudio"
        : (tiers[tier] ?? (cfg.tiers as Record<string, string>)[tier] ?? tier);

    const paddedCat = cat.padEnd(catWidth);
    let suffix = "";
    if (LOCAL_ONLY.has(cat)) suffix += " " + c("🔒", "cyan");
    if (SENSITIVE.has(cat) && !LOCAL_ONLY.has(cat)) suffix += " " + c("⚠️  sensitive", "yellow");

    const tierLabel = c(`(${tier})`, "dim");
    const modelStr = tier === "local" ? c("lmstudio", "gray") + c(" (local only)", "dim") : c(model, "green");
    console.log(`  ${c(paddedCat, "cyan")}  ${modelStr} ${tierLabel}${suffix}`);
  }

  console.log("");
  console.log(c("  Use `lobs config set-route <category> <tier>` to change a route.", "dim"));
  console.log(c("  Tiers: micro, small, medium, standard, strong, local", "dim"));
  console.log("");
}

// ── Subcommand: set-route ─────────────────────────────────────────────────────

function cmdSetRoute(args: string[]): void {
  if (args.length < 2) {
    console.error(c("Error: category and tier are required", "red"));
    console.log("Usage: lobs config set-route <category> <tier>");
    console.log(`Categories: ${TASK_CATEGORIES.join(", ")}`);
    process.exit(1);
  }

  const [category, tier] = args;

  if (!TASK_CATEGORIES.includes(category as TaskCategory)) {
    console.error(c(`Error: unknown category "${category}"`, "red"));
    console.log(`Valid categories: ${TASK_CATEGORIES.join(", ")}`);
    process.exit(1);
  }

  const data = loadModelsFile();
  const cfg = getModelConfig();
  const tiers = (data.tiers ?? {}) as Record<string, string>;
  const allTiers = { ...(cfg.tiers as Record<string, string>), ...tiers };

  const modelForTier =
    tier === "local"
      ? "lmstudio (local only)"
      : allTiers[tier] ?? `(tier not found: ${tier})`;

  if (!data.taskRoutes) data.taskRoutes = {};
  (data.taskRoutes as Record<string, string>)[category] = tier;
  saveModelsFile(data);

  console.log(
    c("✅", "green") +
      ` ${c(category, "cyan")} will use tier ${c(tier, "bright")} (${modelForTier})`
  );
}

// ── Subcommand: set-tier ─────────────────────────────────────────────────────

function cmdSetTier(args: string[]): void {
  if (args.length < 2) {
    console.error(c("Error: tier and model are required", "red"));
    console.log("Usage: lobs config set-tier <tier> <model>");
    console.log("Tiers: micro, small, medium, standard, strong");
    process.exit(1);
  }

  const [tier, model] = args;
  try {
    setTier(tier, model);
    console.log(c("✅", "green") + ` Set tier ${c(tier, "cyan")} → ${c(model, "green")}`);
  } catch (err) {
    console.error(c(`Error: ${(err as Error).message}`, "red"));
    process.exit(1);
  }
}

// ── Subcommand: set-agent ─────────────────────────────────────────────────────

function cmdSetAgent(args: string[]): void {
  if (args.length < 2) {
    console.error(c("Error: agent and model are required", "red"));
    console.log("Usage: lobs config set-agent <agent> <model>");
    console.log("Agents: programmer, researcher, writer, reviewer, architect, suggester");
    process.exit(1);
  }

  const [agent, model] = args;
  const data = loadModelsFile();
  if (!data.agents) data.agents = {};
  if (!data.agents[agent]) {
    data.agents[agent] = { primary: model, fallbacks: [] };
  } else {
    data.agents[agent].primary = model;
  }
  saveModelsFile(data);
  console.log(c("✅", "green") + ` Set agent ${c(agent, "cyan")} primary model → ${c(model, "green")}`);
}

// ── Subcommand: set-voice ─────────────────────────────────────────────────────

function cmdSetVoice(args: string[]): void {
  if (args.length < 2) {
    console.error(c("Error: key and model are required", "red"));
    console.log("Usage: lobs config set-voice <key> <model>");
    console.log("Keys: realtime, transcription");
    process.exit(1);
  }

  const [key, model] = args;
  const data = loadModelsFile();
  if (!data.voice) data.voice = {};

  if (key === "realtime") {
    data.voice.realtimeModel = model;
    saveModelsFile(data);
    console.log(c("✅", "green") + ` Set voice realtime model → ${c(model, "green")}`);
  } else if (key === "transcription") {
    data.voice.transcriptionModel = model;
    saveModelsFile(data);
    console.log(c("✅", "green") + ` Set voice transcription model → ${c(model, "green")}`);
  } else {
    console.error(c(`Error: unknown voice key "${key}"`, "red"));
    console.log("Valid keys: realtime, transcription");
    process.exit(1);
  }
}

// ── Subcommand: set-local ─────────────────────────────────────────────────────

const LOCAL_KEYS = ["chatModel", "summaryModel", "embeddingModel", "baseUrl"] as const;
type LocalKey = typeof LOCAL_KEYS[number];

function cmdSetLocal(args: string[]): void {
  if (args.length < 2) {
    console.error(c("Error: key and value are required", "red"));
    console.log("Usage: lobs config set-local <key> <value>");
    console.log(`Keys: ${LOCAL_KEYS.join(", ")}`);
    process.exit(1);
  }

  const [key, value] = args;
  if (!LOCAL_KEYS.includes(key as LocalKey)) {
    console.error(c(`Error: unknown local key "${key}"`, "red"));
    console.log(`Valid keys: ${LOCAL_KEYS.join(", ")}`);
    process.exit(1);
  }

  const data = loadModelsFile();
  if (!data.local) data.local = {};
  data.local[key] = value;
  saveModelsFile(data);
  console.log(c("✅", "green") + ` Set local.${c(key, "cyan")} → ${c(value, "green")}`);
}

// ── Subcommand: set-scheduler ─────────────────────────────────────────────────

const SCHEDULER_BOOL_KEYS = ["enabled", "localOnly"] as const;
const SCHEDULER_NUM_KEYS = ["temperature", "maxTokens"] as const;
const SCHEDULER_STR_KEYS = ["tier", "overrideModel"] as const;
const SCHEDULER_ALL_KEYS = [...SCHEDULER_BOOL_KEYS, ...SCHEDULER_NUM_KEYS, ...SCHEDULER_STR_KEYS] as const;
type SchedulerKey = typeof SCHEDULER_ALL_KEYS[number];

function cmdSetScheduler(args: string[]): void {
  if (args.length < 2) {
    console.error(c("Error: key and value are required", "red"));
    console.log("Usage: lobs config set-scheduler <key> <value>");
    console.log(`Keys: ${SCHEDULER_ALL_KEYS.join(", ")}`);
    process.exit(1);
  }

  const [key, rawValue] = args;
  if (!SCHEDULER_ALL_KEYS.includes(key as SchedulerKey)) {
    console.error(c(`Error: unknown scheduler key "${key}"`, "red"));
    console.log(`Valid keys: ${SCHEDULER_ALL_KEYS.join(", ")}`);
    process.exit(1);
  }

  let value: unknown = rawValue;
  if (SCHEDULER_BOOL_KEYS.includes(key as typeof SCHEDULER_BOOL_KEYS[number])) {
    value = rawValue === "true" || rawValue === "1";
  } else if (SCHEDULER_NUM_KEYS.includes(key as typeof SCHEDULER_NUM_KEYS[number])) {
    value = parseFloat(rawValue);
    if (isNaN(value as number)) {
      console.error(c(`Error: "${key}" must be a number`, "red"));
      process.exit(1);
    }
  } else if (key === "overrideModel" && (rawValue === "null" || rawValue === "")) {
    value = null;
  }

  const data = loadModelsFile();
  if (!data.scheduler) data.scheduler = {};
  data.scheduler[key] = value;
  saveModelsFile(data);
  console.log(c("✅", "green") + ` Set scheduler.${c(key, "cyan")} → ${c(String(value), "green")}`);
}

// ── Subcommand: edit ──────────────────────────────────────────────────────────

function cmdEdit(): void {
  // Ensure the file exists before opening
  if (!existsSync(MODELS_PATH)) {
    mkdirSync(dirname(MODELS_PATH), { recursive: true });
    writeFileSync(MODELS_PATH, "{}\n", "utf-8");
    console.log(c(`Created ${MODELS_PATH}`, "dim"));
  }

  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vim";
  console.log(c(`Opening ${MODELS_PATH} in ${editor}...`, "dim"));

  const result = spawnSync(editor, [MODELS_PATH], { stdio: "inherit" });
  if (result.error) {
    console.error(c(`Error launching editor: ${result.error.message}`, "red"));
    process.exit(1);
  }

  // Reload config after editing
  resetModelConfig();
  console.log(c("✅ Config reloaded.", "green"));
}

// ── Subcommand: init ──────────────────────────────────────────────────────────

function cmdInit(args: string[]): void {
  const force = args.includes("--force");

  if (existsSync(MODELS_PATH) && !force) {
    console.warn(c(`⚠️  ${MODELS_PATH} already exists. Use --force to overwrite.`, "yellow"));
    process.exit(1);
  }

  mkdirSync(dirname(MODELS_PATH), { recursive: true });
  writeFileSync(MODELS_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf-8");
  resetModelConfig();
  console.log(c("✅", "green") + ` Created ${MODELS_PATH} with full default config.`);
  console.log(c(`  Edit it directly or use \`lobs config set-*\` commands.`, "dim"));
}

// ── Subcommand: show ──────────────────────────────────────────────────────────

function cmdShow(): void {
  const keys = loadKeys();
  const data = loadModelsFile();
  const cfg = getModelConfig();
  const tiers = (data.tiers ?? {}) as Record<string, string>;
  const allTiers = { ...(cfg.tiers as Record<string, string>), ...tiers };
  const tierFallbacks = (data.tierFallbacks ?? {}) as Record<string, string[]>;
  const taskRoutes = (data.taskRoutes ?? {}) as Record<string, string>;

  console.log("\n" + bold("=== Lobs Config Overview ===") + "\n");

  // ── API Keys ──
  console.log(bold("API Keys:"));
  let anyKeys = false;
  for (const provider of KNOWN_PROVIDERS) {
    const entries = keys[provider];
    if (!entries || entries.length === 0) continue;
    anyKeys = true;
    for (const entry of entries) {
      const masked = maskKey(entry.key);
      const status = entry.key ? c("✅", "green") : c("⚠️ ", "yellow");
      console.log(`  ${status} ${bold(provider)} (${entry.label}): ${masked}`);
    }
  }
  if (!anyKeys) console.log(c("  (no keys configured)", "dim"));
  console.log("");

  // ── Tiers ──
  console.log(bold("Tiers:"));
  const tierNames = ["micro", "small", "medium", "standard", "strong"] as const;
  for (const tier of tierNames) {
    const model = allTiers[tier] ?? "(not set)";
    const fallbacks = tierFallbacks[tier];
    const fb = fallbacks?.length ? c(`  → ${fallbacks.join(" → ")}`, "dim") : "";
    console.log(`  ${c(tier.padEnd(10), "cyan")}  ${c(model, "green")}${fb}`);
  }
  console.log("");

  // ── Agents ──
  const agents = data.agents ?? cfg.agents;
  if (agents && Object.keys(agents).length > 0) {
    console.log(bold("Agents:"));
    for (const [agent, chain] of Object.entries(agents)) {
      const fb = chain.fallbacks?.length ? c(`  → ${chain.fallbacks.join(" → ")}`, "dim") : "";
      console.log(`  ${c(agent.padEnd(12), "cyan")}  ${c(chain.primary, "green")}${fb}`);
    }
    console.log("");
  }

  // ── Task Routes ──
  if (Object.keys(taskRoutes).length > 0) {
    console.log(bold("Task Routes (overrides):"));
    for (const [cat, tier] of Object.entries(taskRoutes)) {
      const model = tier === "local" ? "lmstudio" : allTiers[tier] ?? tier;
      console.log(`  ${c(cat.padEnd(20), "cyan")}  tier: ${c(tier, "bright")} (${model})`);
    }
    console.log("");
  }

  // ── Voice ──
  const voice = cfg.voice ?? { realtimeModel: "gpt-4o-realtime-preview", transcriptionModel: "gpt-4o-mini-transcribe" };
  console.log(bold("Voice Models:"));
  console.log(`  ${c("realtime".padEnd(16), "cyan")}  ${c(voice.realtimeModel, "green")}`);
  console.log(`  ${c("transcription".padEnd(16), "cyan")}  ${c(voice.transcriptionModel, "green")}`);
  console.log("");

  // ── Local ──
  const local = cfg.local;
  console.log(bold("Local Models (LM Studio):"));
  console.log(`  ${c("baseUrl".padEnd(16), "cyan")}  ${c(local.baseUrl, "green")}`);
  console.log(`  ${c("chatModel".padEnd(16), "cyan")}  ${c(local.chatModel, "green")}`);
  if (local.summaryModel) {
    console.log(`  ${c("summaryModel".padEnd(16), "cyan")}  ${c(local.summaryModel, "green")}`);
  }
  console.log(`  ${c("embeddingModel".padEnd(16), "cyan")}  ${c(local.embeddingModel, "green")}`);
  console.log("");

  // ── Scheduler ──
  const sched = cfg.scheduler;
  if (sched) {
    console.log(bold("Scheduler:"));
    const schedEntries: [string, unknown][] = [
      ["enabled",       sched.enabled],
      ["localOnly",     sched.localOnly],
      ["tier",          sched.tier],
      ["overrideModel", sched.overrideModel ?? "(none)"],
      ["temperature",   sched.temperature],
      ["maxTokens",     sched.maxTokens],
    ];
    for (const [k, v] of schedEntries) {
      if (v === undefined) continue;
      console.log(`  ${c(k.padEnd(16), "cyan")}  ${c(String(v), "green")}`);
    }
    console.log("");
  }

  // ── Config files ──
  console.log(bold("Config files:"));
  const files = [
    "models.json",
    "discord.json",
    "model-router.json",
    "secrets/keys.json",
    "secrets/discord-token.json",
  ];
  for (const file of files) {
    const path = resolve(CONFIG_DIR, file);
    const fileExists = existsSync(path);
    const status = fileExists ? c("✓", "green") : c("✗", "gray");
    console.log(`  ${status} ${file}`);
  }
  console.log("");
  console.log(c(`Config dir: ${CONFIG_DIR}`, "dim"));
  console.log("");
}

// ── Help ──────────────────────────────────────────────────────────────────────

function cmdHelp(): void {
  console.log("\n" + bold("lobs config") + " — manage keys, tiers, fallbacks, and routes\n");
  console.log(c("Usage:", "cyan"));
  console.log("  lobs config show                       Full config overview");
  console.log("  lobs config check                      Validate config files");
  console.log("  lobs config keys                       List API keys (masked)");
  console.log("  lobs config set-key <p> <k> [--label]  Add/update API key");
  console.log("  lobs config remove-key <p> [--label]   Remove API key");
  console.log("  lobs config set-fallback <t> <m...>    Set tier fallback chain");
  console.log("  lobs config set-agent-fallback <a> <m..>  Set agent fallback chain");
  console.log("  lobs config routes                     Show task→tier routing");
  console.log("  lobs config set-route <cat> <tier>     Set task category route");
  console.log("  lobs config set-tier <tier> <model>    Set a tier's model");
  console.log("  lobs config set-agent <agent> <model>  Set an agent's primary model");
  console.log("  lobs config set-voice <key> <model>    Set voice model (realtime|transcription)");
  console.log("  lobs config set-local <key> <value>    Set local model setting");
  console.log("  lobs config set-scheduler <key> <val>  Set scheduler setting");
  console.log("  lobs config edit                       Open models.json in $EDITOR");
  console.log("  lobs config init [--force]             Create models.json with full defaults");
  console.log("");
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function cmdConfig(subcommand: string, args: string[]): Promise<void> {
  switch (subcommand) {
    case "show":
      cmdShow();
      break;
    case "keys":
      cmdKeys();
      break;
    case "set-key":
      cmdSetKey(args);
      break;
    case "remove-key":
      cmdRemoveKey(args);
      break;
    case "set-fallback":
      cmdSetFallback(args);
      break;
    case "set-agent-fallback":
      cmdSetAgentFallback(args);
      break;
    case "routes":
      cmdRoutes();
      break;
    case "set-route":
      cmdSetRoute(args);
      break;
    case "set-tier":
      cmdSetTier(args);
      break;
    case "set-agent":
      cmdSetAgent(args);
      break;
    case "set-voice":
      cmdSetVoice(args);
      break;
    case "set-local":
      cmdSetLocal(args);
      break;
    case "set-scheduler":
      cmdSetScheduler(args);
      break;
    case "edit":
      cmdEdit();
      break;
    case "init":
      cmdInit(args);
      break;
    case "help":
    case "--help":
      cmdHelp();
      break;
    default:
      console.error(c(`Unknown config subcommand: "${subcommand}"`, "red"));
      cmdHelp();
      process.exit(1);
  }
}
