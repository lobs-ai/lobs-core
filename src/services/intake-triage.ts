import { classifyAgent, extract, isLocalModelAvailable } from "../runner/local-classifier.js";

export type IntakeKind = "task" | "email" | "notification" | "message";
export type IntakeUrgency = "critical" | "high" | "medium" | "low";
export type IntakeRoute = "defer" | "local" | "standard" | "strong";
export type IntakeCategory =
  | "bug"
  | "feature"
  | "research"
  | "documentation"
  | "review"
  | "meeting"
  | "email"
  | "notification"
  | "administrative"
  | "system"
  | "other";
export type IntakeAgent = "programmer" | "researcher" | "writer" | "reviewer" | "architect";
export type IntakeModelTier = "micro" | "small" | "medium" | "standard" | "strong";

export interface IntakeTriageResult {
  kind: IntakeKind;
  category: IntakeCategory;
  urgency: IntakeUrgency;
  route: IntakeRoute;
  modelTier: IntakeModelTier;
  agent: IntakeAgent;
  requiresAction: boolean;
  shouldNotify: boolean;
  summary: string;
  confidence: number;
  reasoning: string;
  localModelUsed: boolean;
}

interface LocalTriageShape {
  category?: IntakeCategory;
  urgency?: IntakeUrgency;
  route?: IntakeRoute;
  modelTier?: IntakeModelTier;
  requiresAction?: boolean;
  shouldNotify?: boolean;
  summary?: string;
  reasoning?: string;
}

const TRIAGE_CATEGORY_VALUES: IntakeCategory[] = [
  "bug",
  "feature",
  "research",
  "documentation",
  "review",
  "meeting",
  "email",
  "notification",
  "administrative",
  "system",
  "other",
];

const TRIAGE_URGENCY_VALUES: IntakeUrgency[] = ["critical", "high", "medium", "low"];
const TRIAGE_ROUTE_VALUES: IntakeRoute[] = ["defer", "local", "standard", "strong"];
const TRIAGE_MODEL_VALUES: IntakeModelTier[] = ["micro", "small", "medium", "standard", "strong"];
const TRIAGE_AGENT_VALUES: IntakeAgent[] = ["programmer", "researcher", "writer", "reviewer", "architect"];

function clampConfidence(value: unknown, fallback = 0.45): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function truncateSummary(text: string, limit = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function chooseAgentByCategory(category: IntakeCategory): IntakeAgent {
  switch (category) {
    case "bug":
    case "feature":
    case "system":
      return "programmer";
    case "research":
    case "meeting":
      return "researcher";
    case "documentation":
    case "email":
    case "administrative":
      return "writer";
    case "review":
      return "reviewer";
    default:
      return "researcher";
  }
}

function detectCategory(text: string, kind: IntakeKind): IntakeCategory {
  const lower = text.toLowerCase();
  if (/\b(sev|severity)\s*1\b|\boutage\b|\bincident\b|\bdown\b|\berror\b|\bexception\b/.test(lower)) return "system";
  if (/\bfix\b|\bbug\b|\bregression\b|\bbroken\b|\bfailing\b|\bdebug\b/.test(lower)) return "bug";
  if (/\bimplement\b|\bbuild\b|\bship\b|\bfeature\b|\badd\b|\bcreate\b/.test(lower)) return "feature";
  if (/\bresearch\b|\banalyze\b|\binvestigate\b|\bcompare\b|\bwhy\b/.test(lower)) return "research";
  if (/\bdoc\b|\bdocs\b|\breadme\b|\bwrite up\b|\bsummary\b/.test(lower)) return "documentation";
  if (/\breview\b|\bpr\b|\bpull request\b|\bqa\b|\baudit\b/.test(lower)) return "review";
  if (/\bmeeting\b|\bcalendar\b|\bschedule\b|\binvite\b/.test(lower)) return "meeting";
  if (kind === "email") return "email";
  if (kind === "notification") return "notification";
  if (/\binvoice\b|\bbilling\b|\bexpense\b|\bapprove\b|\badmin\b/.test(lower)) return "administrative";
  return "other";
}

function detectUrgency(text: string): IntakeUrgency {
  const lower = text.toLowerCase();
  if (/\basap\b|\burgent\b|\bimmediately\b|\bnow\b|\bblocked\b|\bsev(?:erity)?\s*1\b|\bp0\b/.test(lower)) return "critical";
  if (/\btoday\b|\bsoon\b|\bdeadline\b|\boverdue\b|\bimportant\b|\bp1\b/.test(lower)) return "high";
  if (/\bthis week\b|\bfollow up\b|\bplease review\b|\baction needed\b/.test(lower)) return "medium";
  return "low";
}

function chooseRoute(category: IntakeCategory, urgency: IntakeUrgency, kind: IntakeKind, text: string): IntakeRoute {
  const lower = text.toLowerCase();
  if (urgency === "critical") return "strong";
  if (category === "system" || /\barchitecture\b|\bmigration\b|\bsecurity\b/.test(lower)) return "strong";
  if (category === "bug" || category === "feature" || category === "research" || urgency === "high") return "standard";
  if (kind === "notification" && urgency === "low") return "defer";
  return "local";
}

function routeToModelTier(route: IntakeRoute, category: IntakeCategory, urgency: IntakeUrgency): IntakeModelTier {
  if (route === "strong") return "strong";
  if (route === "standard") {
    if (category === "research" || urgency === "high") return "standard";
    return "medium";
  }
  if (route === "defer") return "micro";
  return urgency === "low" ? "micro" : "small";
}

function buildFallback(kind: IntakeKind, title: string, content: string): IntakeTriageResult {
  const combined = `${title}\n\n${content}`.trim();
  const category = detectCategory(combined, kind);
  const urgency = detectUrgency(combined);
  const route = chooseRoute(category, urgency, kind, combined);
  const modelTier = routeToModelTier(route, category, urgency);
  const requiresAction = route !== "defer" && (urgency !== "low" || !["notification", "other"].includes(category));
  const shouldNotify = urgency === "critical" || category === "system";

  return {
    kind,
    category,
    urgency,
    route,
    modelTier,
    agent: chooseAgentByCategory(category),
    requiresAction,
    shouldNotify,
    summary: truncateSummary(title || content || combined),
    confidence: 0.42,
    reasoning: "heuristic fallback",
    localModelUsed: false,
  };
}

function shouldSkipLocalModel(): boolean {
  return process.env["VITEST"] === "true" || process.env["NODE_ENV"] === "test";
}

async function maybeRunLocalTriage(kind: IntakeKind, title: string, content: string): Promise<LocalTriageShape | null> {
  if (shouldSkipLocalModel()) return null;
  if (!await isLocalModelAvailable()) return null;

  const schema = `{
  "category": "${TRIAGE_CATEGORY_VALUES.join('" | "')}",
  "urgency": "${TRIAGE_URGENCY_VALUES.join('" | "')}",
  "route": "${TRIAGE_ROUTE_VALUES.join('" | "')}",
  "modelTier": "${TRIAGE_MODEL_VALUES.join('" | "')}",
  "requiresAction": boolean,
  "shouldNotify": boolean,
  "summary": "short summary",
  "reasoning": "brief reason"
}`;

  return extract<LocalTriageShape>(
    `Classify this incoming ${kind} for triage and routing.

Title: ${title}

Content:
${content}`,
    schema,
  );
}

export async function triageIncomingItem(input: {
  kind: IntakeKind;
  title: string;
  content?: string | null;
}): Promise<IntakeTriageResult> {
  const fallback = buildFallback(input.kind, input.title, input.content ?? "");
  const local = await maybeRunLocalTriage(input.kind, input.title, input.content ?? "");
  const agentGuess = await (async () => {
    if (shouldSkipLocalModel()) return fallback.agent;
    if (fallback.route === "defer") return fallback.agent;
    try {
      if (!await isLocalModelAvailable()) return fallback.agent;
      const result = await classifyAgent(input.title, input.content ?? "");
      return normalizeEnum(result.category, TRIAGE_AGENT_VALUES, fallback.agent);
    } catch {
      return fallback.agent;
    }
  })();

  if (!local) {
    return {
      ...fallback,
      agent: agentGuess,
    };
  }

  return {
    kind: input.kind,
    category: normalizeEnum(local.category, TRIAGE_CATEGORY_VALUES, fallback.category),
    urgency: normalizeEnum(local.urgency, TRIAGE_URGENCY_VALUES, fallback.urgency),
    route: normalizeEnum(local.route, TRIAGE_ROUTE_VALUES, fallback.route),
    modelTier: normalizeEnum(local.modelTier, TRIAGE_MODEL_VALUES, fallback.modelTier),
    agent: agentGuess,
    requiresAction: typeof local.requiresAction === "boolean" ? local.requiresAction : fallback.requiresAction,
    shouldNotify: typeof local.shouldNotify === "boolean" ? local.shouldNotify : fallback.shouldNotify,
    summary: truncateSummary(local.summary ?? fallback.summary),
    confidence: clampConfidence(local.reasoning ? 0.78 : 0.68, fallback.confidence),
    reasoning: truncateSummary(local.reasoning ?? "local-model triage"),
    localModelUsed: true,
  };
}
