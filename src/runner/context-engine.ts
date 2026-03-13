/**
 * Context Engine — intelligent context assembly for agent runs.
 *
 * Pipeline:
 * 1. Task Classifier → { taskType, topic, project, intent }
 * 2. Token Budget Allocator → per-category token limits
 * 3. Multi-layer retrieval → scoped search across memory, project, session
 * 4. Scoring + dedup + budget enforcement
 * 5. Structured assembly → formatted context block
 *
 * This replaces static prompt assembly with intelligent knowledge management.
 * The model sees exactly the information needed for the current task.
 */

import { readFileSync, existsSync } from "node:fs";

// ── Types ────────────────────────────────────────────────────────────────────

export type TaskType =
  | "coding"          // write/fix/refactor code
  | "debugging"       // diagnose and fix bugs
  | "architecture"    // system design, ADRs, specs
  | "review"          // code review, quality checks
  | "research"        // investigate topics, compare options
  | "documentation"   // write docs, READMEs, guides
  | "devops"          // CI/CD, infra, deployment
  | "conversation"    // general chat, questions
  | "unknown";

export interface TaskClassification {
  taskType: TaskType;
  /** Primary topic/subject (e.g., "auth middleware", "handoff logic") */
  topic: string;
  /** Project ID if identifiable */
  project?: string;
  /** Key entities mentioned (file names, function names, people) */
  entities: string[];
  /** Confidence in classification (0-1) */
  confidence: number;
}

export interface TokenBudget {
  total: number;
  /** Token allocation per context category */
  allocations: {
    memory: number;       // decisions, preferences, learnings
    project: number;      // project docs, READMEs, ADRs
    code: number;         // source files, relevant code
    session: number;      // recent conversation context
    instructions: number; // system prompt, agent template
  };
}

export interface ContextLayer {
  category: "memory" | "project" | "code" | "session" | "instructions";
  /** Individual context chunks with metadata */
  chunks: ContextChunk[];
  /** Total tokens used by this layer */
  tokensUsed: number;
}

export interface ContextChunk {
  source: string;      // file path or "session" or "learning"
  content: string;     // the actual text
  score: number;       // relevance score (0-1)
  tokens: number;      // estimated token count
  category: string;    // which budget category
}

export interface AssembledContext {
  /** The complete context block to inject into the prompt */
  contextBlock: string;
  /** Breakdown of what was included */
  layers: ContextLayer[];
  /** Total tokens used */
  totalTokens: number;
  /** Task classification used */
  classification: TaskClassification;
  /** Budget allocated */
  budget: TokenBudget;
}

export interface ContextEngineConfig {
  /** lobs-memory search endpoint */
  memorySearchUrl: string;
  /** Maximum total context tokens */
  maxContextTokens: number;
  /** Project registry for scoping */
  projects: ProjectMapping[];
}

export interface ProjectMapping {
  id: string;
  name: string;
  repoPath: string;
  collections: string[];  // lobs-memory collection names to scope to
  keywords: string[];      // keywords that indicate this project
}

// ── Constants ────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4; // rough approximation

/** Token budget profiles by task type */
const BUDGET_PROFILES: Record<TaskType, {
  memory: number; project: number; code: number; session: number; instructions: number;
}> = {
  coding:        { memory: 0.10, project: 0.15, code: 0.50, session: 0.10, instructions: 0.15 },
  debugging:     { memory: 0.10, project: 0.10, code: 0.55, session: 0.10, instructions: 0.15 },
  architecture:  { memory: 0.25, project: 0.35, code: 0.10, session: 0.15, instructions: 0.15 },
  review:        { memory: 0.10, project: 0.15, code: 0.50, session: 0.10, instructions: 0.15 },
  research:      { memory: 0.20, project: 0.30, code: 0.05, session: 0.25, instructions: 0.20 },
  documentation: { memory: 0.15, project: 0.35, code: 0.20, session: 0.10, instructions: 0.20 },
  devops:        { memory: 0.10, project: 0.20, code: 0.40, session: 0.10, instructions: 0.20 },
  conversation:  { memory: 0.30, project: 0.15, code: 0.05, session: 0.35, instructions: 0.15 },
  unknown:       { memory: 0.20, project: 0.20, code: 0.20, session: 0.20, instructions: 0.20 },
};

// ── Task Classifier ──────────────────────────────────────────────────────────

/** Keywords/patterns that indicate task types */
const TASK_TYPE_PATTERNS: Array<{ type: TaskType; patterns: RegExp[]; weight: number }> = [
  {
    type: "debugging",
    patterns: [
      /\b(bug|error|fix|crash|broken|fails?|failing|debug|issue|wrong|unexpected|stacktrace|traceback)\b/i,
      /\b(not working|doesn't work|won't|can't|cannot)\b/i,
    ],
    weight: 1.5,
  },
  {
    type: "architecture",
    patterns: [
      /\b(design|architect|ADR|spec|proposal|system design|trade-?offs?|diagram|schema)\b/i,
      /\b(should we|how should|approach|strategy|pattern|abstraction)\b/i,
    ],
    weight: 1.3,
  },
  {
    type: "review",
    patterns: [
      /\b(review|audit|check|inspect|quality|feedback|approve|PR|pull request|diff)\b/i,
    ],
    weight: 1.2,
  },
  {
    type: "research",
    patterns: [
      /\b(research|investigate|compare|evaluate|analyze|explore|options|alternatives|benchmark)\b/i,
      /\b(what is|how does|explain|understand|learn about)\b/i,
    ],
    weight: 1.0,
  },
  {
    type: "documentation",
    patterns: [
      /\b(document|write-?up|README|guide|tutorial|explain|docs?|documentation)\b/i,
    ],
    weight: 1.0,
  },
  {
    type: "devops",
    patterns: [
      /\b(deploy|CI|CD|docker|container|infra|pipeline|terraform|nginx|server|SSL|DNS)\b/i,
    ],
    weight: 1.2,
  },
  {
    type: "coding",
    patterns: [
      /\b(implement|build|create|write|add|feature|refactor|function|class|endpoint|API|test)\b/i,
      /\b(code|module|component|service|handler|middleware|route)\b/i,
    ],
    weight: 1.0,
  },
];

/** File extension patterns */
const CODE_FILE_PATTERN = /\b[\w-]+\.(ts|tsx|js|jsx|py|swift|go|rs|java|rb|css|html|sql|yaml|yml|json|toml)\b/gi;
const PROJECT_KEYWORDS_PATTERN = /\b(paw|lobs|nexus|flock|openclaw|ship-?api|sail)\b/gi;

/** Direct mapping from agent type to task type */
const AGENT_TYPE_MAP: Record<string, TaskType> = {
  programmer: "coding",
  reviewer: "review",
  architect: "architecture",
  researcher: "research",
  writer: "documentation",
};

/**
 * Classify a task/prompt to determine what kind of context to load.
 *
 * Priority:
 * 1. Agent type mapping (if agentType provided) — instant, authoritative
 * 2. Regex pattern matching — fast, no LLM call
 * 3. LLM classification via classifyTaskWithLLM() — for ambiguous cases (called externally)
 */
export function classifyTask(
  text: string,
  projects?: ProjectMapping[],
  agentType?: string,
): TaskClassification {
  // If agent type is known, use direct mapping for task type
  const agentTaskType = agentType ? AGENT_TYPE_MAP[agentType] : undefined;
  // Score each task type
  const scores: Record<TaskType, number> = {
    coding: 0, debugging: 0, architecture: 0, review: 0,
    research: 0, documentation: 0, devops: 0, conversation: 0, unknown: 0,
  };

  for (const { type, patterns, weight } of TASK_TYPE_PATTERNS) {
    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        scores[type] += matches.length * weight;
      }
    }
  }

  // Find the highest scoring type
  let bestType: TaskType = "unknown";
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestType = type as TaskType;
    }
  }

  // If no strong signal, default to conversation
  if (bestScore < 1) bestType = "conversation";

  // Agent type takes priority over regex when available
  if (agentTaskType) {
    bestType = agentTaskType;
    bestScore = 5; // high confidence
  }

  // Extract entities (file names, etc.)
  const entities: string[] = [];
  const fileMatches = text.match(CODE_FILE_PATTERN);
  if (fileMatches) entities.push(...Array.from(new Set(fileMatches)));

  // Detect project
  let project: string | undefined;
  const projectMatches = text.match(PROJECT_KEYWORDS_PATTERN);
  if (projectMatches && projects) {
    const mentioned = projectMatches[0].toLowerCase();
    const match = projects.find(p =>
      p.keywords.some(k => k.toLowerCase() === mentioned) ||
      p.name.toLowerCase() === mentioned
    );
    if (match) project = match.id;
  }

  // Extract topic — first noun phrase or key concept
  const topic = extractTopic(text);

  const confidence = Math.min(bestScore / 5, 1.0);

  return { taskType: bestType, topic, project, entities, confidence };
}

/** Extract the main topic from text — simple heuristic */
function extractTopic(text: string): string {
  // Try to find "about X", "for X", "the X"
  const aboutMatch = text.match(/(?:about|regarding|for|the)\s+([a-zA-Z][\w\s-]{2,30}?)(?:\.|,|$|\s+(?:in|to|from|with))/i);
  if (aboutMatch) return aboutMatch[1].trim();

  // Fall back to first significant phrase (skip common words)
  const words = text.split(/\s+/).filter(w =>
    w.length > 3 && !["this", "that", "with", "from", "have", "will", "should", "could", "would", "make", "want"].includes(w.toLowerCase())
  );
  return words.slice(0, 5).join(" ") || "general";
}

// ── LLM-based Task Classifier ────────────────────────────────────────────────

/** Cache for LLM classification results */
const llmClassifyCache = new Map<string, TaskType>();

/**
 * Classify a task using a small local LLM (for ambiguous cases).
 * Only called when regex confidence is low (< 0.3).
 * Uses lmstudio/qwen2.5-1.5b-instruct-mlx for fast, free classification.
 */
export async function classifyTaskWithLLM(text: string): Promise<TaskType | null> {
  // Check cache first
  const cacheKey = text.slice(0, 200);
  if (llmClassifyCache.has(cacheKey)) return llmClassifyCache.get(cacheKey)!;

  try {
    // Use local classifier for fast, free categorization
    const { classify } = await import("./local-classifier.js");
    const validTypes: TaskType[] = ["coding", "debugging", "architecture", "review", "research", "documentation", "devops"];
    const result = await classify(text.slice(0, 500), [...validTypes]);

    if (result.confidence > 0.3) {
      const matched = result.category as TaskType;
      llmClassifyCache.set(cacheKey, matched);
      return matched;
    }

    return null;
  } catch {
    return null; // Timeout or error — fall back to regex
  }
}

// ── Token Budget Allocator ───────────────────────────────────────────────────

/**
 * Allocate token budget based on task type.
 */
export function allocateBudget(
  taskType: TaskType,
  maxTokens: number = 8000,
): TokenBudget {
  const profile = BUDGET_PROFILES[taskType] ?? BUDGET_PROFILES.unknown;

  return {
    total: maxTokens,
    allocations: {
      memory: Math.floor(maxTokens * profile.memory),
      project: Math.floor(maxTokens * profile.project),
      code: Math.floor(maxTokens * profile.code),
      session: Math.floor(maxTokens * profile.session),
      instructions: Math.floor(maxTokens * profile.instructions),
    },
  };
}

// ── Multi-Layer Retrieval ────────────────────────────────────────────────────

interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
}

/**
 * Search lobs-memory with scoping.
 */
async function searchMemory(
  query: string,
  collections?: string[],
  maxResults: number = 10,
  baseUrl: string = "http://localhost:7420",
): Promise<MemorySearchResult[]> {
  try {
    const body: Record<string, unknown> = { query, maxResults };
    if (collections?.length) body.collections = collections;

    const response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return [];

    const data = (await response.json()) as { results?: MemorySearchResult[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}

/**
 * Map a search result to a budget category based on its source path.
 */
function categorizeResult(result: MemorySearchResult): ContextChunk["category"] {
  const path = result.path.toLowerCase();

  // Session transcripts
  if (path.includes("/sessions/") || path.endsWith(".jsonl")) return "session";

  // Memory files (learnings, decisions, daily notes)
  if (path.includes("memory/") || path.includes("memory.md") || path.includes("learnings")) return "memory";
  if (path.includes("lobs-shared-memory/")) return "memory";

  // Project docs
  if (path.includes("readme") || path.includes("design") || path.includes("adr") || path.includes("architecture")) return "project";

  // Code
  if (path.match(/\.(ts|tsx|js|jsx|py|swift|go|rs)$/)) return "code";

  // Default to project
  return "project";
}

// ── Context Assembly ─────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Assemble context for an agent run.
 *
 * This is the main entry point. Given a task description, it:
 * 1. Classifies the task
 * 2. Allocates token budget
 * 3. Retrieves relevant context from lobs-memory
 * 4. Scores, deduplicates, and fits to budget
 * 5. Returns a formatted context block
 */
export async function assembleContext(params: {
  task: string;
  agentType: string;
  projectId?: string;
  contextRefs?: string[];
  config?: Partial<ContextEngineConfig>;
}): Promise<AssembledContext> {
  const memoryUrl = params.config?.memorySearchUrl ?? "http://localhost:7420";
  const maxTokens = params.config?.maxContextTokens ?? 8000;
  const projects = params.config?.projects ?? DEFAULT_PROJECTS;

  // 1. Classify the task
  const classification = classifyTask(params.task, projects, params.agentType);

  // Override project if explicitly provided
  if (params.projectId) {
    classification.project = params.projectId;
  }

  // Override task type based on agent type
  if (params.agentType === "reviewer") classification.taskType = "review";
  if (params.agentType === "architect") classification.taskType = "architecture";
  if (params.agentType === "researcher") classification.taskType = "research";
  if (params.agentType === "writer") classification.taskType = "documentation";

  // 2. Allocate token budget
  const budget = allocateBudget(classification.taskType, maxTokens);

  // 3. Multi-layer retrieval
  const layers: ContextLayer[] = [];

  // Determine collection scoping
  const project = projects.find(p => p.id === classification.project);
  const projectCollections = project?.collections;

  // Search queries — the main task + extracted entities
  const queries = [params.task];
  if (classification.topic && classification.topic !== "general") {
    queries.push(classification.topic);
  }

  // Memory layer — decisions, learnings, preferences
  const memoryResults = await searchMemory(
    queries[0],
    ["workspace", "knowledge"],
    8,
    memoryUrl,
  );

  const memoryChunks: ContextChunk[] = memoryResults
    .filter(r => categorizeResult(r) === "memory")
    .map(r => ({
      source: r.path,
      content: r.snippet,
      score: r.score,
      tokens: estimateTokens(r.snippet),
      category: "memory",
    }));

  layers.push(fillLayer("memory", memoryChunks, budget.allocations.memory));

  // Project layer — docs, READMEs, ADRs
  const projectResults = await searchMemory(
    queries[0],
    projectCollections ?? ["projects", "knowledge"],
    8,
    memoryUrl,
  );

  const projectChunks: ContextChunk[] = projectResults
    .filter(r => {
      const cat = categorizeResult(r);
      return cat === "project" || cat === "code";
    })
    .map(r => ({
      source: r.path,
      content: r.snippet,
      score: r.score,
      tokens: estimateTokens(r.snippet),
      category: categorizeResult(r) === "code" ? "code" : "project",
    }));

  // Split into project docs vs code
  const docChunks = projectChunks.filter(c => c.category === "project");
  const codeChunks = projectChunks.filter(c => c.category === "code");

  layers.push(fillLayer("project", docChunks, budget.allocations.project));
  layers.push(fillLayer("code", codeChunks, budget.allocations.code));

  // Session layer — recent conversation context
  const sessionResults = await searchMemory(
    queries[0],
    ["sessions"],
    5,
    memoryUrl,
  );

  const sessionChunks: ContextChunk[] = sessionResults.map(r => ({
    source: r.path,
    content: r.snippet,
    score: r.score,
    tokens: estimateTokens(r.snippet),
    category: "session",
  }));

  layers.push(fillLayer("session", sessionChunks, budget.allocations.session));

  // Context refs — explicit file references (loaded directly, not from search)
  if (params.contextRefs?.length) {
    const refChunks: ContextChunk[] = [];
    for (const refPath of params.contextRefs) {
      const resolved = refPath.replace(/^~/, process.env.HOME ?? "");
      if (!existsSync(resolved)) continue;
      try {
        const content = readFileSync(resolved, "utf-8").trim();
        if (content.length > 0) {
          const truncated = content.slice(0, budget.allocations.project * CHARS_PER_TOKEN);
          refChunks.push({
            source: refPath,
            content: truncated,
            score: 1.0, // explicit refs get max score
            tokens: estimateTokens(truncated),
            category: "project",
          });
        }
      } catch { /* skip */ }
    }

    // Add ref chunks to project layer (they take priority)
    if (refChunks.length > 0) {
      const projectLayer = layers.find(l => l.category === "project");
      if (projectLayer) {
        // Prepend refs (highest priority)
        projectLayer.chunks = [...refChunks, ...projectLayer.chunks];
        projectLayer.tokensUsed = projectLayer.chunks.reduce((sum, c) => sum + c.tokens, 0);
      }
    }
  }

  // Learnings injection
  const learnings = loadLearnings(params.agentType, classification.taskType);
  if (learnings) {
    const memoryLayer = layers.find(l => l.category === "memory");
    if (memoryLayer) {
      memoryLayer.chunks.unshift({
        source: "learnings",
        content: learnings,
        score: 0.9,
        tokens: estimateTokens(learnings),
        category: "memory",
      });
      memoryLayer.tokensUsed += estimateTokens(learnings);
    }
  }

  // 5. Assemble the final context block
  const contextBlock = formatContextBlock(layers, classification);
  const totalTokens = layers.reduce((sum, l) => sum + l.tokensUsed, 0);

  return {
    contextBlock,
    layers,
    totalTokens,
    classification,
    budget,
  };
}

/**
 * Fill a context layer up to the token budget.
 * Chunks are already sorted by score (from search). Takes the top ones that fit.
 */
function fillLayer(
  category: ContextLayer["category"],
  chunks: ContextChunk[],
  tokenBudget: number,
): ContextLayer {
  const selected: ContextChunk[] = [];
  let tokensUsed = 0;

  // Sort by score descending
  const sorted = [...chunks].sort((a, b) => b.score - a.score);

  // Deduplicate by source path
  const seen = new Set<string>();

  for (const chunk of sorted) {
    if (seen.has(chunk.source)) continue;
    if (tokensUsed + chunk.tokens > tokenBudget) continue;

    selected.push(chunk);
    tokensUsed += chunk.tokens;
    seen.add(chunk.source);
  }

  return { category, chunks: selected, tokensUsed };
}

/**
 * Format the assembled context layers into a structured text block.
 */
function formatContextBlock(layers: ContextLayer[], classification: TaskClassification): string {
  const sections: string[] = [];

  // Memory section — decisions, learnings
  const memoryLayer = layers.find(l => l.category === "memory");
  if (memoryLayer && memoryLayer.chunks.length > 0) {
    const memoryText = memoryLayer.chunks
      .map(c => c.source === "learnings"
        ? `## Learnings\n${c.content}`
        : `[${c.source}]\n${c.content}`)
      .join("\n\n");
    sections.push(`# Context: Memory & Decisions\n${memoryText}`);
  }

  // Project docs section
  const projectLayer = layers.find(l => l.category === "project");
  if (projectLayer && projectLayer.chunks.length > 0) {
    const projectText = projectLayer.chunks
      .map(c => `### ${c.source}\n${c.content}`)
      .join("\n\n");
    sections.push(`# Context: Project Documentation\n${projectText}`);
  }

  // Code section
  const codeLayer = layers.find(l => l.category === "code");
  if (codeLayer && codeLayer.chunks.length > 0) {
    const codeText = codeLayer.chunks
      .map(c => `### ${c.source}\n\`\`\`\n${c.content}\n\`\`\``)
      .join("\n\n");
    sections.push(`# Context: Relevant Code\n${codeText}`);
  }

  // Session history section
  const sessionLayer = layers.find(l => l.category === "session");
  if (sessionLayer && sessionLayer.chunks.length > 0) {
    const sessionText = sessionLayer.chunks
      .map(c => c.content)
      .join("\n\n---\n\n");
    sections.push(`# Context: Recent Session History\n${sessionText}`);
  }

  if (sections.length === 0) return "";

  // Add classification metadata as a header comment
  const header = `<!-- context-engine: type=${classification.taskType} topic="${classification.topic}" project=${classification.project ?? "none"} -->`;

  return `${header}\n\n${sections.join("\n\n")}`;
}

// ── Learnings ────────────────────────────────────────────────────────────────

/**
 * Load relevant learnings for an agent type and task category.
 * Returns formatted text or undefined if no relevant learnings.
 */
function loadLearnings(agentType: string, taskType: TaskType): string | undefined {
  const learningsPath = `${process.env.HOME}/lobs-shared-memory/learnings.md`;
  if (!existsSync(learningsPath)) return undefined;

  try {
    const content = readFileSync(learningsPath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim().length > 0);

    // Filter learnings relevant to this agent type
    const relevant = lines.filter(line => {
      const lower = line.toLowerCase();
      // Match agent type
      if (lower.includes(agentType)) return true;
      // Match task type
      if (lower.includes(taskType)) return true;
      // General learnings (no specific agent/task marker)
      if (!lower.match(/\b(programmer|writer|researcher|reviewer|architect)\b/)) return true;
      return false;
    });

    if (relevant.length === 0) return undefined;

    // Take last 10 relevant learnings (most recent)
    const selected = relevant.slice(-10);
    return "REMINDER — Learnings from prior runs:\n" + selected.join("\n");
  } catch {
    return undefined;
  }
}

// ── Default Project Registry ─────────────────────────────────────────────────

const DEFAULT_PROJECTS: ProjectMapping[] = [
  {
    id: "lobs-core",
    name: "Lobs Core",
    repoPath: "~/lobs/lobs-core",
    collections: ["projects"],
    keywords: ["lobs", "lobs-core", "plugin", "orchestrator", "paw"],
  },
  {
    id: "lobs-memory",
    name: "Lobs Memory",
    repoPath: "~/lobs-memory",
    collections: ["projects"],
    keywords: ["lobs-memory", "memory", "search", "vector", "embedding"],
  },
  {
    id: "lobs-nexus",
    name: "Lobs Nexus",
    repoPath: "~/lobs/lobs-nexus",
    collections: ["projects"],
    keywords: ["nexus", "dashboard", "web", "react"],
  },
  {
    id: "paw-hub",
    name: "PAW Hub",
    repoPath: "~/paw-hub",
    collections: ["projects"],
    keywords: ["paw", "hub", "paw-hub", "portal", "website"],
  },
  {
    id: "lobs-mobile",
    name: "Lobs Mobile",
    repoPath: "~/lobs-mobile",
    collections: ["projects"],
    keywords: ["mobile", "ios", "swift", "app"],
  },
];

// ── Session Compaction ───────────────────────────────────────────────────────

/** Structured session compression output */
export interface CompactedSession {
  decisionsMade: string[];
  failedApproaches: string[];
  keyFindings: string[];
  currentState: string[];
  remainingWork: string[];
}

/** Pattern matchers for extracting structured information */
const DECISION_PATTERNS = [
  /(?:decided|choosing|going with|opted for|selected|picked)\s+(.+?)(?:\.|$)/gi,
  /(?:will use|using|implemented with)\s+(.+?)(?:\.|$)/gi,
];

const FAILURE_PATTERNS = [
  /(?:error|failed|didn't work|doesn't work|won't work|broken|issue)\s*:?\s*(.+?)(?:\.|$)/gi,
  /(?:reverted|rolled back|abandoned|discarded)\s+(.+?)(?:\.|$)/gi,
  /(?:tried .+ but)\s+(.+?)(?:\.|$)/gi,
];

const FINDING_PATTERNS = [
  /(?:found|discovered|learned|realized)\s+(?:that\s+)?(.+?)(?:\.|$)/gi,
  /(?:turns out|it appears)\s+(?:that\s+)?(.+?)(?:\.|$)/gi,
];

const STATE_PATTERNS = [
  /(?:currently|now|at this point)\s+(.+?)(?:\.|$)/gi,
  /(?:have|has)\s+(?:been|successfully)\s+(.+?)(?:\.|$)/gi,
];

const REMAINING_PATTERNS = [
  /(?:need to|needs to|must|should|todo|remaining)\s+(.+?)(?:\.|$)/gi,
  /(?:still need|haven't yet|not yet)\s+(.+?)(?:\.|$)/gi,
];

/**
 * Compact a session (conversation messages) into structured compression.
 * 
 * Instead of vague summaries, extracts specific categories:
 * - Decisions made
 * - Failed approaches
 * - Key findings
 * - Current state
 * - Remaining work
 * 
 * @param messages - Array of conversation messages (role + content)
 * @returns Structured compression
 */
export function compactSession(messages: Array<{ role: string; content: string }>): CompactedSession {
  const result: CompactedSession = {
    decisionsMade: [],
    failedApproaches: [],
    keyFindings: [],
    currentState: [],
    remainingWork: [],
  };

  // Combine all text content
  const allText = messages
    .map(m => typeof m.content === "string" ? m.content : "")
    .join("\n");

  // Extract decisions
  for (const pattern of DECISION_PATTERNS) {
    const matches = Array.from(allText.matchAll(pattern));
    for (const match of matches) {
      if (match[1] && match[1].trim().length > 10) {
        const cleaned = match[1].trim();
        if (!result.decisionsMade.some(d => d.includes(cleaned.slice(0, 30)))) {
          result.decisionsMade.push(cleaned);
        }
      }
    }
  }

  // Extract failures
  for (const pattern of FAILURE_PATTERNS) {
    const matches = Array.from(allText.matchAll(pattern));
    for (const match of matches) {
      if (match[1] && match[1].trim().length > 10) {
        const cleaned = match[1].trim();
        if (!result.failedApproaches.some(f => f.includes(cleaned.slice(0, 30)))) {
          result.failedApproaches.push(cleaned);
        }
      }
    }
  }

  // Extract findings
  for (const pattern of FINDING_PATTERNS) {
    const matches = Array.from(allText.matchAll(pattern));
    for (const match of matches) {
      if (match[1] && match[1].trim().length > 10) {
        const cleaned = match[1].trim();
        if (!result.keyFindings.some(f => f.includes(cleaned.slice(0, 30)))) {
          result.keyFindings.push(cleaned);
        }
      }
    }
  }

  // Extract current state
  for (const pattern of STATE_PATTERNS) {
    const matches = Array.from(allText.matchAll(pattern));
    for (const match of matches) {
      if (match[1] && match[1].trim().length > 10) {
        const cleaned = match[1].trim();
        if (!result.currentState.some(s => s.includes(cleaned.slice(0, 30)))) {
          result.currentState.push(cleaned);
        }
      }
    }
  }

  // Extract remaining work
  for (const pattern of REMAINING_PATTERNS) {
    const matches = Array.from(allText.matchAll(pattern));
    for (const match of matches) {
      if (match[1] && match[1].trim().length > 10) {
        const cleaned = match[1].trim();
        if (!result.remainingWork.some(r => r.includes(cleaned.slice(0, 30)))) {
          result.remainingWork.push(cleaned);
        }
      }
    }
  }

  // Limit each category to top 10 items (most relevant)
  result.decisionsMade = result.decisionsMade.slice(0, 10);
  result.failedApproaches = result.failedApproaches.slice(0, 10);
  result.keyFindings = result.keyFindings.slice(0, 10);
  result.currentState = result.currentState.slice(0, 10);
  result.remainingWork = result.remainingWork.slice(0, 10);

  return result;
}

/**
 * Format a compacted session into a readable text summary.
 */
export function formatCompactedSession(compacted: CompactedSession): string {
  const sections: string[] = [];

  if (compacted.decisionsMade.length > 0) {
    sections.push("DECISIONS MADE:\n" + compacted.decisionsMade.map(d => `- ${d}`).join("\n"));
  }

  if (compacted.failedApproaches.length > 0) {
    sections.push("FAILED APPROACHES:\n" + compacted.failedApproaches.map(f => `- ${f}`).join("\n"));
  }

  if (compacted.keyFindings.length > 0) {
    sections.push("KEY FINDINGS:\n" + compacted.keyFindings.map(f => `- ${f}`).join("\n"));
  }

  if (compacted.currentState.length > 0) {
    sections.push("CURRENT STATE:\n" + compacted.currentState.map(s => `- ${s}`).join("\n"));
  }

  if (compacted.remainingWork.length > 0) {
    sections.push("REMAINING WORK:\n" + compacted.remainingWork.map(r => `- ${r}`).join("\n"));
  }

  return sections.join("\n\n");
}
