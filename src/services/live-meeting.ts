/**
 * Live Meeting Service — real-time meeting transcription and analysis.
 *
 * Flow: Browser records 30s audio chunks → POST to backend → local whisper.cpp
 * transcribes → text appended to running transcript → LLM analyzes full
 * transcript → frontend polls GET /api/meetings/live/:id for updates.
 *
 * Sessions are held in-memory. Only finalized meetings are persisted to the DB.
 */

import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { getLobsRoot } from "../config/lobs.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { meetings } from "../db/schema.js";
import { log } from "../util/logger.js";
import { getBotName, getOwnerName } from "../config/identity.js";
import { getModelForTier } from "../config/models.js";
import { createResilientClient, parseModelString } from "../runner/providers.js";
import { MeetingAnalysisService } from "./meeting-analysis.js";
import { loadWorkspaceContext } from "./workspace-loader.js";
import { VoiceSidecar } from "./voice/sidecar.js";
import { loadVoiceConfig } from "./voice/config.js";

// ── Constants ────────────────────────────────────────────────────────────

const LOBS_CORE_ROOT = resolve(new URL(import.meta.url).pathname, "../../..");

// ── Types ────────────────────────────────────────────────────────────────

export type SessionStatus = "recording" | "processing" | "completed" | "error";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface ChunkMeta {
  index: number;
  receivedAt: string;
  duration: number;
  text: string;
}

export interface Insight {
  type: "note" | "action" | "flag" | "context" | "question" | "research" | "suggestion";
  content: string;
  timestamp: string;
}

export interface ActionItem {
  description: string;
  assignee: string | null;
  priority: "high" | "medium" | "low";
}

export interface LiveSession {
  id: string;
  status: SessionStatus;
  title: string;
  participants: string[];
  meetingType: string;
  transcript: string;
  segments: TranscriptSegment[];
  chunks: ChunkMeta[];
  insights: Insight[];
  actionItems: ActionItem[];
  runningSummary: string;
  topics: string[];
  startedAt: string;
  stoppedAt: string | null;
  /** Accumulated raw audio buffers (webm fragments). Chunk 0 has the header. */
  audioBuffers: Buffer[];
  /** Pending research tasks spawned from transcript analysis */
  pendingResearch: Array<{ id: string; query: string; status: 'pending' | 'running' | 'done' }>;
  /** Fresh context loaded at session start — projects, recent memory, schedule */
  sessionContext: string;
}

// ── Meeting Context Loader ───────────────────────────────────────────────

const HOME = homedir();
const CONTEXT_DIR = join(getLobsRoot(), "agents", "main", "context");
const SHARED_MEMORY_DIR = join(HOME, "lobs-shared-memory");

/**
 * Safely read a file, returning null if it doesn't exist or fails.
 */
function safeRead(path: string, maxLen = 4000): string | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf-8").trim();
    return content.length > maxLen ? content.slice(0, maxLen) + "\n...(truncated)" : content;
  } catch { return null; }
}

/**
 * Get a date string in YYYY-MM-DD format for the given offset from today.
 */
function dateString(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Load fresh context for a live meeting session.
 *
 * Uses the same workspace-loader that Nexus/Discord sessions use to load
 * SOUL.md, USER.md, MEMORY.md, TOOLS.md — the full identity. Then layers on
 * today's/yesterday's memory and shared learnings for recent context.
 *
 * The result: the meeting analysis LLM acts like the same Lobs Rafe talks to
 * everywhere else, not a generic meeting summarizer.
 */
function loadMeetingContext(): string {
  const sections: string[] = [];

  // 1. Core identity — SOUL.md, USER.md, MEMORY.md, TOOLS.md via workspace loader
  //    This is the same context the main agent gets in Nexus/Discord sessions.
  try {
    const workspaceCtx = loadWorkspaceContext("main");
    if (workspaceCtx) {
      sections.push(workspaceCtx);
    }
  } catch (e) {
    log().warn(`[LIVE_MEETING] Failed to load workspace context: ${e}`);
  }

  // 2. Today's memory — what was worked on, recent context
  const todayMem = safeRead(join(CONTEXT_DIR, "memory", `${dateString(0)}.md`));
  if (todayMem) {
    sections.push(`## Today's Activity (${dateString(0)})\n${todayMem}`);
  }

  // 3. Yesterday's memory — recent continuity
  const yesterdayMem = safeRead(join(CONTEXT_DIR, "memory", `${dateString(-1)}.md`), 2000);
  if (yesterdayMem) {
    sections.push(`## Yesterday's Activity (${dateString(-1)})\n${yesterdayMem}`);
  }

  // 4. Shared learnings — system-wide decisions and patterns
  const learnings = safeRead(join(SHARED_MEMORY_DIR, "learnings.md"), 2000);
  if (learnings) {
    sections.push(`## System Learnings\n${learnings}`);
  }

  if (sections.length === 0) {
    return "";
  }

  const ctx = sections.join("\n\n");
  log().info(`[LIVE_MEETING] Loaded session context: ${ctx.length} chars, ${sections.length} sections`);
  return ctx;
}

// ── Whisper transcription ────────────────────────────────────────────────

const WHISPER_URL = "http://127.0.0.1:7423/v1/audio/transcriptions";

async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audioBuffer)], { type: "audio/webm" }), "chunk.webm");
  form.append("response_format", "json");

  const res = await fetch(WHISPER_URL, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Whisper transcription failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { text: string };
  return data.text?.trim() ?? "";
}

// ── Direct LLM analysis ─────────────────────────────────────────────────

/**
 * Build the meeting system prompt, injecting session context when available.
 *
 * Uses the same identity context as Nexus/Discord sessions (SOUL.md, USER.md,
 * MEMORY.md, TOOLS.md) so the meeting analysis LLM is the same bot — same
 * personality, same knowledge, same awareness of projects and people.
 */
function buildMeetingSystemPrompt(sessionContext?: string): string {
  const meetingRole = `You are ${getBotName()}, sitting in on a live meeting with ${getOwnerName()}. You're the same ${getBotName()} he talks to on Nexus and Discord — same personality, same knowledge, same relationship. You're analyzing the meeting transcript in real-time to surface useful insights.

Session type: live meeting analysis

Your job: Extract structured insights from the transcript as it grows. You're not summarizing for a stranger — you're noting things that matter to ${getOwnerName()} based on what you know about his projects, schedule, and priorities.

Output format: Return ONLY valid JSON — no markdown, no code fences, no extra text.`;

  if (!sessionContext) return meetingRole;

  return `${sessionContext}

${meetingRole}

Current time: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "full", timeStyle: "short" })}`;
}

async function llmAnalyze(prompt: string, systemPrompt?: string): Promise<string> {
  const model = getModelForTier("small");
  const client = await createResilientClient(model, { sessionId: "live-meeting" });

  const response = await client.createMessage({
    model: parseModelString(model).modelId,
    system: systemPrompt ?? buildMeetingSystemPrompt(),
    messages: [{ role: "user", content: prompt }],
    tools: [],
    maxTokens: 4096,
  });

  const text = response.content
    ?.filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("") ?? "";

  if (!text) throw new Error("Empty response from LLM");
  return text;
}

function buildAnalysisPrompt(
  transcript: string,
  session: LiveSession,
): string {
  const priorInsightsJson = session.insights.length > 0
    ? `\n\nPRIOR INSIGHTS (do NOT repeat these — only produce NEW ones):\n${JSON.stringify(session.insights, null, 2)}`
    : "";

  const priorActionsJson = session.actionItems.length > 0
    ? `\n\nPRIOR ACTION ITEMS (do NOT repeat these — only produce NEW ones):\n${JSON.stringify(session.actionItems, null, 2)}`
    : "";

  const priorResearchJson = session.pendingResearch.length > 0
    ? `\n\nPRIOR RESEARCH QUERIES ALREADY SPAWNED (do NOT re-spawn these):\n${JSON.stringify(session.pendingResearch.map(r => r.query), null, 2)}`
    : "";

  const priorSummary = session.runningSummary
    ? `\n\nPRIOR RUNNING SUMMARY:\n${session.runningSummary}`
    : "";

  const currentMeta = `\n\nCURRENT MEETING METADATA:
- Title: "${session.title}"
- Participants: ${session.participants.length ? JSON.stringify(session.participants) : "unknown"}
- Meeting type: ${session.meetingType}`;

  return `You are ${getBotName()} — ${getOwnerName()}'s AI agent, an ACTIVE PARTICIPANT in this meeting, not a passive summarizer. Your job is to identify what you should DO right now to be genuinely useful.

Classify the transcript content into intents:

- **immediate_research**: Something was mentioned that you should go look up RIGHT NOW — a file, PR, codebase question, architecture detail, recent git history, etc. Include a specific, actionable \`query\` describing exactly what to look up. This triggers you to actually go do the work.
- **action_item**: A real commitment or deliverable someone said they would do AFTER the meeting. Only include things someone explicitly committed to. NOT things the system should do. NOT instructions for you.
- **insight**: A genuine analytical observation — something non-obvious, a risk, a connection between topics, a technical concern. NOT a description of what just happened. NOT "user wants to X" or "system should Y" — those are useless meta-commentary.
- **suggestion**: A proactive idea or recommendation you have based on what's being discussed.

CRITICAL RULES:
- NEVER produce insights like "User wants to test X" or "System should do Y" — those describe the meeting rather than adding value to it.
- If someone mentions a bug → spawn immediate_research to investigate it.
- If someone mentions a file → spawn immediate_research to read and summarize it.
- If architecture is discussed → spawn immediate_research to pull relevant context.
- action_item is ONLY for real human commitments ("I'll fix that by Friday") — NOT system tasks.
- insight must be genuinely analytical — a risk, a non-obvious connection, a concern.
- If there's nothing new or genuinely useful, return empty arrays. Do NOT fill space.

Return ONLY valid JSON (no markdown, no code fences):

{
  "suggested_title": "short descriptive title based on actual content",
  "participants": ["name1"],
  "meeting_type": "standup|planning|review|retrospective|one-on-one|brainstorm|interview|lecture|other",
  "intents": [
    {
      "type": "immediate_research",
      "query": "specific thing to look up — e.g. 'read src/services/live-meeting.ts and summarize the processChunk flow'",
      "reason": "why this is relevant to the conversation"
    },
    {
      "type": "action_item",
      "description": "specific deliverable someone committed to",
      "assignee": "person or null",
      "priority": "high|medium|low"
    },
    {
      "type": "insight",
      "content": "genuine analytical observation — non-obvious, useful",
      "subtype": "note|flag|context|question"
    },
    {
      "type": "suggestion",
      "content": "proactive recommendation from you"
    }
  ],
  "running_summary": "updated summary of the entire discussion so far",
  "topics": ["topic1", "topic2"]
}
${currentMeta}${priorInsightsJson}${priorActionsJson}${priorResearchJson}${priorSummary}

FULL TRANSCRIPT:
${transcript}`;
}

// ── Research execution ───────────────────────────────────────────────────

async function executeResearch(sessionId: string, researchId: string, query: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Mark as running
  const task = session.pendingResearch.find(r => r.id === researchId);
  if (task) task.status = 'running';

  try {
    let context = '';

    // Detect what kind of research this is
    const fileMatch = query.match(/(?:read|check|look at|examine|inspect)\s+([^\s,]+\.[a-z]+)/i);
    const gitMatch = query.match(/(?:PR|pull request|commit|branch|git log|git status)/i);
    const dirMatch = query.match(/(?:list|show|find)\s+(?:files?\s+in\s+)?([^\s,]+\/)/i);

    if (fileMatch) {
      // Try to find and read the file
      const filePath = fileMatch[1];
      const candidates = [
        resolve(LOBS_CORE_ROOT, filePath),
        resolve(LOBS_CORE_ROOT, "src", filePath),
        resolve(process.env.HOME || "~", filePath),
      ];

      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          const content = readFileSync(candidate, "utf-8");
          // Truncate if too long
          context = content.length > 8000
            ? content.slice(0, 8000) + "\n... [truncated]"
            : content;
          context = `File: ${candidate}\n\n${context}`;
          break;
        }
      }

      if (!context) {
        // Try fd to find it
        try {
          const filename = filePath.split('/').pop() ?? filePath;
          const found = execSync(
            `fd "${filename}" "${LOBS_CORE_ROOT}" --max-results 3 2>/dev/null || true`,
            { encoding: 'utf-8', timeout: 5000 }
          ).trim();
          if (found) {
            const firstFile = found.split('\n')[0];
            const content = readFileSync(firstFile, "utf-8");
            context = content.length > 8000
              ? content.slice(0, 8000) + "\n... [truncated]"
              : content;
            context = `File: ${firstFile}\n\n${context}`;
          }
        } catch {
          // fd not available or file not found — continue to LLM fallback
        }
      }
    }

    if (gitMatch && !context) {
      try {
        const gitLog = execSync('git log --oneline -20', { encoding: 'utf-8', cwd: LOBS_CORE_ROOT, timeout: 5000 });
        const gitStatus = execSync('git status --short', { encoding: 'utf-8', cwd: LOBS_CORE_ROOT, timeout: 5000 });
        const gitBranch = execSync('git branch --show-current', { encoding: 'utf-8', cwd: LOBS_CORE_ROOT, timeout: 5000 });
        context = `Current branch: ${gitBranch.trim()}\n\nGit status:\n${gitStatus}\n\nRecent commits:\n${gitLog}`;
      } catch {
        // git not available or not a git repo
      }
    }

    if (dirMatch && !context) {
      try {
        const dir = dirMatch[1];
        const listing = execSync(
          `ls -la "${resolve(LOBS_CORE_ROOT, dir)}" 2>/dev/null || ls -la "${dir}" 2>/dev/null || true`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        context = `Directory listing for ${dir}:\n${listing}`;
      } catch {
        // directory not found
      }
    }

    // Ask LLM to synthesize a useful response — include session context if available
    const researchRole = `You are ${getBotName()}, doing background research during a live meeting with ${getOwnerName()}. Be direct and concrete — reference actual names, line numbers, patterns. Skip preamble. Just deliver the info. 2-4 sentences max.`;
    const researchSystem = session.sessionContext
      ? `${session.sessionContext}\n\n${researchRole}`
      : researchRole;

    const researchPrompt = context
      ? `Research task from a live meeting with ${getOwnerName()}:

"${query}"

Here's what was found:

${context}

Provide a concise, useful summary. Be specific — reference actual function names, line numbers, patterns you see.`
      : `Research task from a live meeting with ${getOwnerName()}:

"${query}"

Based on your knowledge of the lobs-core project (TypeScript, Node.js, AI agent platform with Discord bot, Nexus dashboard, meeting analysis, PAW hosting platform, etc.), provide a concise, useful response. If you don't have enough context to give a good answer, say so briefly.`;

    const result = await llmAnalyze(researchPrompt, researchSystem);

    // Add result as a research insight
    session.insights.push({
      type: "research",
      content: result,
      timestamp: new Date().toISOString(),
    });

    if (task) task.status = 'done';
    log().info(`[LIVE_MEETING] Research completed for ${sessionId}: "${query.slice(0, 60)}..."`);

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log().error(`[LIVE_MEETING] Research failed for ${sessionId}: ${msg}`);
    if (task) task.status = 'done';

    // Still surface that we tried
    session.insights.push({
      type: "research",
      content: `Tried to research "${query}" but hit an error: ${msg.slice(0, 100)}`,
      timestamp: new Date().toISOString(),
    });
  }
}

// ── In-memory session store ──────────────────────────────────────────────

const sessions = new Map<string, LiveSession>();

/** Lock to prevent concurrent LLM analysis for the same session */
const analysisLocks = new Map<string, boolean>();

// ── Exported service ─────────────────────────────────────────────────────

export class LiveMeetingService {
  /**
   * Start a new live meeting session.
   */
  startSession(opts: {
    title?: string;
    participants?: string[];
    meetingType?: string;
  } = {}): { sessionId: string; status: SessionStatus } {
    // Load fresh context at session start — projects, memory, schedule, learnings
    const sessionContext = loadMeetingContext();

    const session: LiveSession = {
      id: randomUUID(),
      status: "recording",
      title: opts.title ?? "Live Meeting",
      participants: opts.participants ?? [],
      meetingType: opts.meetingType ?? "general",
      transcript: "",
      segments: [],
      chunks: [],
      insights: [],
      actionItems: [],
      runningSummary: "",
      topics: [],
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      audioBuffers: [],
      pendingResearch: [],
      sessionContext,
    };

    sessions.set(session.id, session);
    log().info(`[LIVE_MEETING] Started session ${session.id}: "${session.title}" (context: ${sessionContext.length} chars)`);

    // Ensure whisper STT is running — it may not be if voice mode is "realtime"
    // (the voice manager only auto-starts the sidecar in sidecar mode).
    this.ensureSTTRunning().catch(e => {
      log().warn(`[LIVE_MEETING] STT auto-start failed: ${e}`);
    });

    return { sessionId: session.id, status: session.status };
  }

  /**
   * Ensure the whisper STT sidecar is running. Called at session start so the
   * live meeting feature works regardless of which voice mode is configured.
   */
  private async ensureSTTRunning(): Promise<void> {
    // Quick health check first — if it's already up, do nothing
    try {
      const res = await fetch(`${WHISPER_URL.replace("/v1/audio/transcriptions", "/health")}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return; // Already healthy
    } catch {
      // Not running — fall through to start it
    }

    log().info("[LIVE_MEETING] Whisper STT not running — starting sidecar...");
    const config = loadVoiceConfig();
    const sidecar = new VoiceSidecar(config);
    const result = await sidecar.startSTTOnly();
    if (result.healthy) {
      log().info("[LIVE_MEETING] Whisper STT started successfully");
    } else {
      log().warn(`[LIVE_MEETING] Whisper STT failed to start: ${result.error ?? "unknown"}`);
    }
  }

  /**
   * Process an audio chunk. Transcribes via whisper.cpp, appends to transcript,
   * fires LLM analysis in the background. Returns transcription immediately.
   */
  async processChunk(
    sessionId: string,
    audioBuffer: Buffer,
  ): Promise<{ text: string; chunkIndex: number }> {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.status !== "recording") {
      throw new Error(`Session ${sessionId} is not recording (status: ${session.status})`);
    }

    const chunkIndex = session.chunks.length;
    log().info(`[LIVE_MEETING] Processing chunk ${chunkIndex} for session ${sessionId} (${audioBuffer.length} bytes)`);

    // Accumulate raw audio data — webm chunks after the first are continuation
    // fragments without headers, so we must concat all and transcribe the full buffer.
    session.audioBuffers.push(audioBuffer);
    const fullAudioBuffer = Buffer.concat(session.audioBuffers);

    // Get previous transcript length so we can extract only the new text
    const previousTranscriptLength = session.transcript.length;

    // Transcribe the FULL accumulated audio via whisper.cpp
    let fullText: string;
    try {
      fullText = await transcribeAudio(fullAudioBuffer);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log().error(`[LIVE_MEETING] Transcription failed for chunk ${chunkIndex}: ${msg}`);
      throw e;
    }

    // Extract only the new portion of the transcript
    const text = fullText.length > previousTranscriptLength
      ? fullText.slice(previousTranscriptLength).trim()
      : fullText.trim();

    // Calculate approximate timing based on chunk index (30s per chunk)
    const chunkDuration = 30;
    const startTime = chunkIndex * chunkDuration;
    const endTime = startTime + chunkDuration;

    // Append to session
    const chunk: ChunkMeta = {
      index: chunkIndex,
      receivedAt: new Date().toISOString(),
      duration: chunkDuration,
      text,
    };
    session.chunks.push(chunk);

    // Use the full whisper output as authoritative transcript
    session.transcript = fullText;

    if (text) {
      session.segments.push({
        start: startTime,
        end: endTime,
        text,
      });
    }

    // Fire LLM analysis in background (don't await — return transcription immediately)
    this.runAnalysis(sessionId).catch(e => {
      log().error(`[LIVE_MEETING] Background analysis failed: ${e}`);
    });

    return { text, chunkIndex };
  }

  /**
   * Run LLM analysis on the current transcript. Uses a lock to prevent
   * concurrent analysis for the same session.
   */
  private async runAnalysis(sessionId: string): Promise<void> {
    // Skip if already running for this session
    if (analysisLocks.get(sessionId)) {
      log().info(`[LIVE_MEETING] Analysis already running for ${sessionId}, skipping`);
      return;
    }

    const session = sessions.get(sessionId);
    if (!session || !session.transcript.trim()) return;

    analysisLocks.set(sessionId, true);
    try {
      const prompt = buildAnalysisPrompt(session.transcript, session);

      // Use session-specific system prompt with loaded context
      const systemPrompt = buildMeetingSystemPrompt(session.sessionContext || undefined);
      const responseText = await llmAnalyze(prompt, systemPrompt);

      // Parse JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log().warn("[LIVE_MEETING] No JSON found in analysis response");
        return;
      }

      const analysis = JSON.parse(jsonMatch[0]) as {
        suggested_title?: string;
        participants?: string[];
        meeting_type?: string;
        intents?: Array<{
          type: 'immediate_research' | 'action_item' | 'insight' | 'suggestion';
          // immediate_research
          query?: string;
          reason?: string;
          // action_item
          description?: string;
          assignee?: string | null;
          priority?: 'high' | 'medium' | 'low';
          // insight
          content?: string;
          subtype?: 'note' | 'flag' | 'context' | 'question';
        }>;
        running_summary?: string;
        topics?: string[];
      };

      // Update meeting metadata from LLM analysis
      if (analysis.suggested_title && analysis.suggested_title.length > 2) {
        const oldTitle = session.title;
        session.title = analysis.suggested_title;
        if (oldTitle !== session.title) {
          log().info(`[LIVE_MEETING] Title updated: "${oldTitle}" → "${session.title}"`);
        }
      }

      if (analysis.participants?.length) {
        // Merge with existing — union of all detected participants
        const existing = new Set(session.participants.map(p => p.toLowerCase()));
        for (const p of analysis.participants) {
          if (p && !existing.has(p.toLowerCase())) {
            session.participants.push(p);
            existing.add(p.toLowerCase());
          }
        }
        log().info(`[LIVE_MEETING] Participants: [${session.participants.join(", ")}]`);
      }

      if (analysis.meeting_type && analysis.meeting_type !== session.meetingType) {
        log().info(`[LIVE_MEETING] Meeting type: ${session.meetingType} → ${analysis.meeting_type}`);
        session.meetingType = analysis.meeting_type;
      }

      // Process intents
      if (analysis.intents?.length) {
        for (const intent of analysis.intents) {
          switch (intent.type) {
            case 'immediate_research': {
              if (!intent.query) break;
              const id = randomUUID();
              session.pendingResearch.push({ id, query: intent.query, status: 'pending' });
              // Fire and forget — research runs independently of analysis lock
              executeResearch(sessionId, id, intent.query).catch(e => {
                log().error(`[LIVE_MEETING] Research execution error: ${e}`);
              });
              log().info(`[LIVE_MEETING] Spawned research: "${intent.query.slice(0, 60)}..."`);
              break;
            }
            case 'action_item': {
              if (!intent.description) break;
              session.actionItems.push({
                description: intent.description,
                assignee: intent.assignee ?? null,
                priority: intent.priority ?? 'medium',
              });
              break;
            }
            case 'insight': {
              if (!intent.content) break;
              session.insights.push({
                type: intent.subtype ?? 'note',
                content: intent.content,
                timestamp: new Date().toISOString(),
              });
              break;
            }
            case 'suggestion': {
              if (!intent.content) break;
              session.insights.push({
                type: 'suggestion',
                content: intent.content,
                timestamp: new Date().toISOString(),
              });
              break;
            }
          }
        }
        log().info(`[LIVE_MEETING] Processed ${analysis.intents.length} intents for ${sessionId}`);
      }

      // Update running summary
      if (analysis.running_summary) {
        session.runningSummary = analysis.running_summary;
      }

      // Update topics
      if (analysis.topics?.length) {
        session.topics = analysis.topics;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log().error(`[LIVE_MEETING] Analysis error for ${sessionId}: ${msg}`);
    } finally {
      analysisLocks.delete(sessionId);
    }
  }

  /**
   * Stop and finalize a live meeting session.
   * Creates a DB record and triggers full MeetingAnalysisService.
   */
  async stopSession(sessionId: string): Promise<typeof meetings.$inferSelect> {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.status === "completed") {
      throw new Error(`Session ${sessionId} is already completed`);
    }

    session.status = "processing";
    session.stoppedAt = new Date().toISOString();

    log().info(`[LIVE_MEETING] Stopping session ${sessionId}, ${session.chunks.length} chunks, ${session.transcript.length} chars`);

    // Calculate total duration
    const durationSeconds = session.chunks.length * 30;

    // Insert into meetings DB
    const db = getDb();
    const meetingId = randomUUID();

    // Combine live-session insights + action items into a single persisted array
    const allInsights = [
      ...session.insights,
      ...session.actionItems.map(a => ({
        type: 'action' as const,
        content: a.description,
        assignee: a.assignee,
        priority: a.priority,
        timestamp: new Date().toISOString(),
      })),
    ];

    const record = {
      id: meetingId,
      title: session.title,
      filename: `live-${sessionId}.webm`,
      language: "en",
      durationSeconds,
      transcript: session.transcript,
      segments: JSON.stringify(session.segments),
      participants: session.participants.length
        ? JSON.stringify(session.participants)
        : null,
      projectId: null,
      meetingType: session.meetingType,
      summary: session.runningSummary || null,
      analysisStatus: "pending",
      insights: allInsights.length > 0 ? JSON.stringify(allInsights) : null,
      topics: session.topics.length > 0 ? JSON.stringify(session.topics) : null,
    };

    db.insert(meetings).values(record).run();
    log().info(`[LIVE_MEETING] Created meeting record ${meetingId} from live session ${sessionId}`);

    // Mark session as completed
    session.status = "completed";

    // Trigger full analysis via MeetingAnalysisService (fire-and-forget)
    const analysisSvc = new MeetingAnalysisService();
    analysisSvc.analyze(meetingId).catch(e => {
      log().error(`[LIVE_MEETING] Post-session analysis failed for ${meetingId}: ${e}`);
    });

    // Get the stored record
    const stored = db.select().from(meetings).where(eq(meetings.id, meetingId)).get()!;

    // Clean up session after a delay (allow a few more polls to pick up final state)
    setTimeout(() => {
      sessions.delete(sessionId);
      analysisLocks.delete(sessionId);
      log().info(`[LIVE_MEETING] Cleaned up session ${sessionId}`);
    }, 60000);

    return stored;
  }

  /**
   * Get current session state.
   */
  getSession(sessionId: string): LiveSession | undefined {
    return sessions.get(sessionId);
  }

  /**
   * List all active sessions.
   */
  listSessions(): Array<{
    id: string;
    status: SessionStatus;
    title: string;
    startedAt: string;
    chunkCount: number;
    transcriptLength: number;
  }> {
    return Array.from(sessions.values()).map(s => ({
      id: s.id,
      status: s.status,
      title: s.title,
      startedAt: s.startedAt,
      chunkCount: s.chunks.length,
      transcriptLength: s.transcript.length,
    }));
  }
}
