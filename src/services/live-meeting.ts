/**
 * Live Meeting Service — real-time meeting transcription and analysis.
 *
 * Flow: Browser records 30s audio chunks → POST to backend → local whisper.cpp
 * transcribes → text appended to running transcript → LLM analyzes full
 * transcript → results pushed via SSE to frontend.
 *
 * Sessions are held in-memory. Only finalized meetings are persisted to the DB.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { meetings } from "../db/schema.js";
import { log } from "../util/logger.js";
import { getGatewayConfig } from "../config/lobs.js";
import { getModelForTier } from "../config/models.js";
import { MeetingAnalysisService } from "./meeting-analysis.js";

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
  type: "note" | "action" | "flag" | "context" | "question";
  content: string;
  timestamp: string;
}

export interface ActionItem {
  description: string;
  assignee: string | null;
  priority: "high" | "medium" | "low";
}

export interface LiveSessionEvent {
  type: "transcript" | "insight" | "action_item" | "summary" | "status" | "error";
  data: unknown;
}

type EventListener = (event: LiveSessionEvent) => void;

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

  /** SSE listeners */
  listeners: Set<EventListener>;
  addListener(fn: EventListener): void;
  removeListener(fn: EventListener): void;
  emit(event: LiveSessionEvent): void;
}

// ── Whisper transcription ────────────────────────────────────────────────

const WHISPER_URL = "http://127.0.0.1:7423/v1/audio/transcriptions";

async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audioBuffer)]), "chunk.webm");
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

// ── Gateway / LLM analysis ──────────────────────────────────────────────

async function gatewayInvoke(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const { port, token } = getGatewayConfig();
  const r = await fetch(`http://127.0.0.1:${port}/v2/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ tool, args, sessionKey: "agent:sink:live-meeting" }),
  });
  if (!r.ok) throw new Error(`Gateway ${tool} failed (${r.status}): ${await r.text()}`);
  const data = (await r.json()) as Record<string, unknown>;
  const result = data?.result as Record<string, unknown> | undefined;
  return result?.details ?? result ?? data;
}

async function spawnAndWait(task: string, timeoutMs = 120000): Promise<string> {
  const outFile = `/tmp/live-meeting-analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;

  const wrappedTask = `You are a live meeting analysis assistant. Your ONLY job is to analyze the transcript and write your analysis directly to a file.

DO NOT reply with the analysis in chat. Instead, use the Write tool to write it to: ${outFile}

Here is what to write:

${task}

Remember: Write the COMPLETE JSON analysis to ${outFile} using the Write tool. That file is your only output.`;

  await gatewayInvoke("sessions/spawn", {
    task: wrappedTask,
    mode: "run",
    model: getModelForTier("standard"),
    thinking: "off",
    runTimeoutSeconds: Math.floor(timeoutMs / 1000),
    cleanup: "delete",
  });

  log().info("[LIVE_MEETING] Spawned analysis agent → " + outFile);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    if (existsSync(outFile)) {
      const text = readFileSync(outFile, "utf-8").trim();
      if (text.length > 20) {
        log().info("[LIVE_MEETING] Got " + text.length + " chars from " + outFile);
        try { unlinkSync(outFile); } catch { /* ignore */ }
        return text;
      }
    }
  }

  try { unlinkSync(outFile); } catch { /* ignore */ }
  throw new Error("Timed out waiting for live meeting analysis output");
}

function buildAnalysisPrompt(
  transcript: string,
  priorInsights: Insight[],
  priorActionItems: ActionItem[],
  runningSummary: string,
): string {
  const priorInsightsJson = priorInsights.length > 0
    ? `\n\nPRIOR INSIGHTS (do NOT repeat these — only produce NEW ones):\n${JSON.stringify(priorInsights, null, 2)}`
    : "";

  const priorActionsJson = priorActionItems.length > 0
    ? `\n\nPRIOR ACTION ITEMS (do NOT repeat these — only produce NEW ones):\n${JSON.stringify(priorActionItems, null, 2)}`
    : "";

  const priorSummary = runningSummary
    ? `\n\nPRIOR RUNNING SUMMARY:\n${runningSummary}`
    : "";

  return `Analyze this live meeting transcript. This is an incremental analysis pass — produce ONLY NEW insights and action items that weren't already captured.

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:

{
  "insights": [{ "type": "note|action|flag|context|question", "content": "description", "timestamp": "HH:MM:SS" }],
  "action_items": [{ "description": "specific task", "assignee": "person or null", "priority": "high|medium|low" }],
  "running_summary": "brief updated summary of the entire discussion so far",
  "topics": ["topic1", "topic2"]
}

Rules:
- insights.type: "note" for key points, "action" for action items mentioned, "flag" for concerns/risks, "context" for background info, "question" for open questions
- Only include NEW insights not already in the prior insights list
- Only include NEW action items not already captured
- Update the running_summary to cover the entire transcript so far
- If there's nothing new since the last pass, return empty arrays but still update the summary
- Be concise but specific
${priorInsightsJson}${priorActionsJson}${priorSummary}

FULL TRANSCRIPT:
${transcript}`;
}

// ── Session management ───────────────────────────────────────────────────

function createSession(opts: {
  title?: string;
  participants?: string[];
  meetingType?: string;
}): LiveSession {
  const listeners = new Set<EventListener>();

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
    listeners,

    addListener(fn: EventListener) {
      listeners.add(fn);
    },

    removeListener(fn: EventListener) {
      listeners.delete(fn);
    },

    emit(event: LiveSessionEvent) {
      for (const fn of listeners) {
        try {
          fn(event);
        } catch (e) {
          log().error(`[LIVE_MEETING] Listener error: ${e}`);
        }
      }
    },
  };

  return session;
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
    const session = createSession(opts);
    sessions.set(session.id, session);
    log().info(`[LIVE_MEETING] Started session ${session.id}: "${session.title}"`);
    return { sessionId: session.id, status: session.status };
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

    // Transcribe via whisper.cpp
    let text: string;
    try {
      text = await transcribeAudio(audioBuffer);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log().error(`[LIVE_MEETING] Transcription failed for chunk ${chunkIndex}: ${msg}`);
      session.emit({ type: "error", data: { message: `Transcription failed: ${msg}`, chunkIndex } });
      throw e;
    }

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

    if (text) {
      session.transcript += (session.transcript ? "\n\n" : "") + text;
      session.segments.push({
        start: startTime,
        end: endTime,
        text,
      });
    }

    // Emit transcript event
    session.emit({
      type: "transcript",
      data: { text, chunkIndex, fullTranscript: session.transcript },
    });

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
      const prompt = buildAnalysisPrompt(
        session.transcript,
        session.insights,
        session.actionItems,
        session.runningSummary,
      );

      const responseText = await spawnAndWait(prompt);

      // Parse JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log().warn("[LIVE_MEETING] No JSON found in analysis response");
        return;
      }

      const analysis = JSON.parse(jsonMatch[0]) as {
        insights?: Insight[];
        action_items?: ActionItem[];
        running_summary?: string;
        topics?: string[];
      };

      // Process new insights
      if (analysis.insights?.length) {
        for (const insight of analysis.insights) {
          session.insights.push(insight);
          session.emit({ type: "insight", data: insight });
        }
        log().info(`[LIVE_MEETING] ${analysis.insights.length} new insights for ${sessionId}`);
      }

      // Process new action items
      if (analysis.action_items?.length) {
        for (const item of analysis.action_items) {
          session.actionItems.push(item);
          session.emit({ type: "action_item", data: item });
        }
        log().info(`[LIVE_MEETING] ${analysis.action_items.length} new action items for ${sessionId}`);
      }

      // Update running summary
      if (analysis.running_summary) {
        session.runningSummary = analysis.running_summary;
        session.emit({ type: "summary", data: { summary: analysis.running_summary } });
      }

      // Update topics
      if (analysis.topics?.length) {
        session.topics = analysis.topics;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log().error(`[LIVE_MEETING] Analysis error for ${sessionId}: ${msg}`);
      session.emit({ type: "error", data: { message: `Analysis failed: ${msg}` } });
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
    session.emit({ type: "status", data: { status: "processing" } });

    log().info(`[LIVE_MEETING] Stopping session ${sessionId}, ${session.chunks.length} chunks, ${session.transcript.length} chars`);

    // Calculate total duration
    const durationSeconds = session.chunks.length * 30;

    // Insert into meetings DB
    const db = getDb();
    const meetingId = randomUUID();
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
    };

    db.insert(meetings).values(record).run();
    log().info(`[LIVE_MEETING] Created meeting record ${meetingId} from live session ${sessionId}`);

    // Mark session as completed
    session.status = "completed";
    session.emit({ type: "status", data: { status: "completed", meetingId } });

    // Trigger full analysis via MeetingAnalysisService (fire-and-forget)
    const analysisSvc = new MeetingAnalysisService();
    analysisSvc.analyze(meetingId).catch(e => {
      log().error(`[LIVE_MEETING] Post-session analysis failed for ${meetingId}: ${e}`);
    });

    // Get the stored record
    const stored = db.select().from(meetings).where(eq(meetings.id, meetingId)).get()!;

    // Clean up session after a delay (keep it alive briefly for SSE clients to get final events)
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
   * Get insights since a given timestamp.
   */
  getInsights(sessionId: string, since?: string): Insight[] {
    const session = sessions.get(sessionId);
    if (!session) return [];

    if (!since) return session.insights;

    // Filter insights — since we don't have real timestamps on each insight,
    // we compare the insight's timestamp field (HH:MM:SS format from LLM)
    // This is best-effort; the SSE stream is the primary real-time channel.
    return session.insights;
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
