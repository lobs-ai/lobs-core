/**
 * Live Meeting API — /api/meetings/live/*
 *
 * Real-time meeting transcription endpoints. Frontend polls for updates.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseBody } from "./index.js";
import { LiveMeetingService } from "../services/live-meeting.js";
import { log } from "../util/logger.js";

const svc = new LiveMeetingService();

/**
 * Handle all /api/meetings/live/* requests.
 *
 * Routes:
 *   POST /api/meetings/live/start        → start a live session
 *   POST /api/meetings/live/:id/chunk    → upload audio chunk (raw body)
 *   POST /api/meetings/live/:id/stop     → finalize session
 *   GET  /api/meetings/live/:id          → get full session state (for polling)
 *   GET  /api/meetings/live/sessions     → list active sessions
 */
export async function handleLiveMeetingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
): Promise<void> {
  const subPath = parts[2]; // "start", "sessions", or session ID
  const action = parts[3];  // "chunk", "stop", or undefined

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

  // GET /api/meetings/live/sessions
  if (subPath === "sessions" && req.method === "GET") {
    return json(res, svc.listSessions());
  }

  const sessionId = subPath;
  if (!sessionId) {
    return error(res, "Session ID required", 400);
  }

  // POST /api/meetings/live/:id/chunk — raw audio body (not multipart)
  if (action === "chunk" && req.method === "POST") {
    try {
      const buffers: Buffer[] = [];
      for await (const chunk of req) {
        buffers.push(chunk as Buffer);
      }
      const audioBuffer = Buffer.concat(buffers);

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

  // POST /api/meetings/live/:id/stop
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

  // GET /api/meetings/live/:id — full session state for polling
  if (!action && req.method === "GET") {
    const session = svc.getSession(sessionId);
    if (!session) {
      return error(res, "Session not found", 404);
    }

    return json(res, {
      id: session.id,
      status: session.status,
      title: session.title,
      participants: session.participants,
      meetingType: session.meetingType,
      transcript: session.transcript,
      segments: session.segments,
      chunks: session.chunks,
      insights: session.insights,
      actionItems: session.actionItems,
      runningSummary: session.runningSummary,
      topics: session.topics,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
    });
  }

  return error(res, "Method not allowed", 405);
}
