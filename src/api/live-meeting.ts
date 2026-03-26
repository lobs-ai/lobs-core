/**
 * Live Meeting API — /api/meetings/live/*
 *
 * Real-time meeting transcription endpoints with SSE streaming.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseBody, parseQuery } from "./index.js";
import { LiveMeetingService } from "../services/live-meeting.js";
import { log } from "../util/logger.js";

const svc = new LiveMeetingService();

/**
 * Handle all /api/meetings/live/* requests.
 *
 * parts[0] = "meetings", parts[1] = "live", parts[2] = subpath/id, parts[3] = action
 *
 * Routes:
 *   POST /api/meetings/live/start        → start a live session
 *   POST /api/meetings/live/:id/chunk    → upload audio chunk
 *   POST /api/meetings/live/:id/stop     → finalize session
 *   GET  /api/meetings/live/:id          → get session state
 *   GET  /api/meetings/live/:id/stream   → SSE event stream
 *   GET  /api/meetings/live/sessions     → list active sessions
 */
export async function handleLiveMeetingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
): Promise<void> {
  // parts: ["meetings", "live", ...]
  const subPath = parts[2]; // "start", "sessions", or session ID
  const action = parts[3];  // "chunk", "stop", "stream", or undefined

  // POST /api/meetings/live/start
  if (subPath === "start" && req.method === "POST") {
    try {
      const body = (await parseBody(req)) as {
        title?: string;
        participants?: string[];
        meetingType?: string;
      };
      const result = svc.startSession({
        title: body.title,
        participants: body.participants,
        meetingType: body.meetingType,
      });
      return json(res, result, 201);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return error(res, msg, 500);
    }
  }

  // GET /api/meetings/live/sessions — list active sessions
  if (subPath === "sessions" && req.method === "GET") {
    return json(res, svc.listSessions());
  }

  // All remaining routes require a session ID
  const sessionId = subPath;
  if (!sessionId) {
    return error(res, "Session ID required", 400);
  }

  // POST /api/meetings/live/:id/chunk — upload audio chunk
  if (action === "chunk" && req.method === "POST") {
    try {
      // Read raw body as audio buffer
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const audioBuffer = Buffer.concat(chunks);

      if (audioBuffer.length === 0) {
        return error(res, "Empty audio chunk", 400);
      }

      log().info(`[LIVE_MEETING_API] Received chunk for ${sessionId}: ${audioBuffer.length} bytes`);

      const result = await svc.processChunk(sessionId, audioBuffer);
      return json(res, result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes("not found") ? 404 : msg.includes("not recording") ? 409 : 500;
      return error(res, msg, status);
    }
  }

  // POST /api/meetings/live/:id/stop — finalize session
  if (action === "stop" && req.method === "POST") {
    try {
      const meeting = await svc.stopSession(sessionId);
      return json(res, meeting);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes("not found") ? 404 : msg.includes("already completed") ? 409 : 500;
      return error(res, msg, status);
    }
  }

  // GET /api/meetings/live/:id/stream — SSE event stream
  if (action === "stream" && req.method === "GET") {
    const session = svc.getSession(sessionId);
    if (!session) {
      return error(res, "Session not found", 404);
    }

    // Set up SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    });

    // Send initial state as a "connected" event
    res.write(`event: status\ndata: ${JSON.stringify({
      status: session.status,
      sessionId: session.id,
      title: session.title,
      chunkCount: session.chunks.length,
      transcriptLength: session.transcript.length,
    })}\n\n`);

    // Send keepalive every 15s
    const keepalive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 15000);

    // Register listener for new events
    const listener = (event: { type: string; data: unknown }) => {
      try {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      } catch {
        // Connection may be closed
      }
    };

    session.addListener(listener);

    // Clean up on client disconnect
    req.on("close", () => {
      clearInterval(keepalive);
      session.removeListener(listener);
      log().info(`[LIVE_MEETING_API] SSE client disconnected from session ${sessionId}`);
    });

    return; // Keep connection open
  }

  // GET /api/meetings/live/:id — get session state
  if (!action && req.method === "GET") {
    const session = svc.getSession(sessionId);
    if (!session) {
      return error(res, "Session not found", 404);
    }

    const q = parseQuery(req.url ?? "");

    // Support ?insights_since= for polling
    const insights = q.insights_since
      ? svc.getInsights(sessionId, q.insights_since)
      : session.insights;

    return json(res, {
      id: session.id,
      status: session.status,
      title: session.title,
      participants: session.participants,
      meetingType: session.meetingType,
      transcript: session.transcript,
      segments: session.segments,
      chunks: session.chunks,
      insights,
      actionItems: session.actionItems,
      runningSummary: session.runningSummary,
      topics: session.topics,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
    });
  }

  return error(res, "Method not allowed", 405);
}
