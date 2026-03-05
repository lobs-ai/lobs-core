/**
 * Meetings API — /api/meetings
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseBody, parseQuery } from "./index.js";
import { MeetingsService } from "../services/meetings.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const svc = new MeetingsService();

export async function handleMeetingsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id: string | undefined,
  parts: string[],
): Promise<void> {

  // POST /api/meetings/transcribe
  if (id === "transcribe" && req.method === "POST") {
    const body = (await parseBody(req)) as any;
    if (!body?.audioPath) return error(res, "audioPath required", 400);
    try {
      const meeting = await svc.transcribe(body.audioPath, {
        title: body.title,
        projectId: body.projectId,
        participants: body.participants,
        meetingType: body.meetingType,
      });
      return json(res, meeting, 201);
    } catch (e: any) {
      return error(res, e.message, 500);
    }
  }

  // POST /api/meetings/upload — multipart audio upload
  if (id === "upload" && req.method === "POST") {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);

      const contentType = req.headers["content-type"] ?? "";
      let audioPath: string;
      let metadata: any = {};

      if (contentType.includes("multipart/form-data")) {
        const boundary = contentType.split("boundary=")[1];
        if (!boundary) return error(res, "Missing boundary in multipart", 400);
        const { file, fields } = parseMultipart(raw, boundary);
        if (!file) return error(res, "No audio file in upload", 400);
        const dir = join(tmpdir(), "paw-meetings");
        mkdirSync(dir, { recursive: true });
        audioPath = join(dir, `${randomUUID()}${file.ext}`);
        writeFileSync(audioPath, file.data);
        metadata = fields;
      } else {
        const dir = join(tmpdir(), "paw-meetings");
        mkdirSync(dir, { recursive: true });
        audioPath = join(dir, `${randomUUID()}.webm`);
        writeFileSync(audioPath, raw);
      }

      const meeting = await svc.transcribe(audioPath, {
        title: metadata.title,
        projectId: metadata.projectId,
        participants: metadata.participants ? JSON.parse(metadata.participants) : undefined,
        meetingType: metadata.meetingType,
      });
      return json(res, meeting, 201);
    } catch (e: any) {
      return error(res, e.message, 500);
    }
  }

  // GET /api/meetings
  if (!id && req.method === "GET") {
    const q = parseQuery(req.url ?? "");
    const rows = svc.list({
      projectId: q.projectId,
      meetingType: q.meetingType,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return json(res, rows);
  }

  // Action items sub-routes (must be before GET /:id)
  if (id === "action-items" || parts[2] === "action-items") {
    return handleMeetingActionItemsRequest(req, res, id, parts);
  }

  // GET /api/meetings/:id
  if (id && req.method === "GET") {
    const meeting = svc.get(id);
    if (!meeting) return error(res, "Meeting not found", 404);
    return json(res, meeting);
  }

  // DELETE /api/meetings/:id
  if (id && req.method === "DELETE") {
    svc.delete(id);
    return json(res, { ok: true });
  }

  // POST /api/meetings/:id/share — send summary to Discord
  if (id && parts[2] === "share" && req.method === "POST") {
    const meeting = svc.get(id);
    if (!meeting) return error(res, "Meeting not found", 404);

    const db = getDb();
    const items = db.select().from(meetingActionItems)
      .where(eq(meetingActionItems.meetingId, id)).all();

    let msg = `📋 **${meeting.title || 'Meeting'}** — ${new Date(meeting.createdAt).toLocaleString()}
`;
    if (meeting.summary) msg += `
${meeting.summary}
`;
    if (items.length > 0) {
      const grouped: Record<string, typeof items> = {};
      items.forEach(i => {
        const k = i.assignee || 'unassigned';
        if (!grouped[k]) grouped[k] = [];
        grouped[k].push(i);
      });
      msg += `
**Action Items:**`;
      Object.entries(grouped).forEach(([assignee, group]) => {
        msg += `
@${assignee}:`;
        group.forEach(i => { msg += `
  • ${i.description}`; });
      });
    }

    // Send via gateway message tool
    try {
      const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
      const { readFileSync } = await import("node:fs");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      const port = cfg?.gateway?.port ?? 18789;
      const token = cfg?.gateway?.auth?.token ?? "";

      const r = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          tool: "message",
          args: { action: "send", channel: "discord", target: "user:644578016298795010", message: msg },
          sessionKey: "agent:sink:paw-orchestrator-v2",
        }),
      });
      if (!r.ok) throw new Error(`Discord send failed: ${r.status}`);
      return json(res, { ok: true, sent: "discord" });
    } catch (e: any) {
      return error(res, e.message, 500);
    }
  }

  // POST /api/meetings/:id/analyze — trigger (re-)analysis
  if (id && parts[2] === "analyze" && req.method === "POST") {
    const { MeetingAnalysisService } = await import("../services/meeting-analysis.js");
    const analysisSvc = new MeetingAnalysisService();
    analysisSvc.analyze(id).catch(() => {});
    return json(res, { ok: true, status: "processing" });
  }

  return error(res, "Method not allowed", 405);
}

function parseMultipart(raw: Buffer, boundary: string): { file: { data: Buffer; ext: string } | null; fields: Record<string, string> } {
  const sep = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let start = 0;
  while (true) {
    const idx = raw.indexOf(sep, start);
    if (idx === -1) break;
    if (start > 0) parts.push(raw.subarray(start, idx - 2));
    start = idx + sep.length + 2;
  }

  let file: { data: Buffer; ext: string } | null = null;
  const fields: Record<string, string> = {};

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const header = part.subarray(0, headerEnd).toString();
    const body = part.subarray(headerEnd + 4);

    const nameMatch = header.match(/name="([^"]+)"/);
    const filenameMatch = header.match(/filename="([^"]+)"/);

    if (filenameMatch) {
      const ext = filenameMatch[1].includes(".") ? "." + filenameMatch[1].split(".").pop() : ".webm";
      file = { data: body, ext };
    } else if (nameMatch) {
      fields[nameMatch[1]] = body.toString().trim();
    }
  }

  return { file, fields };
}

// ── Action Items endpoints ──────────────────────────────────────────────

import { eq, desc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { meetingActionItems, meetings as meetingsTable } from "../db/schema.js";

export async function handleMeetingActionItemsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  meetingId: string | undefined,
  parts: string[],
): Promise<void> {
  const db = getDb();

  // GET /api/meetings/action-items?assignee=rafe — all action items across meetings
  if (meetingId === "action-items" && req.method === "GET") {
    const q = parseQuery(req.url ?? "");
    let rows = db.select().from(meetingActionItems).orderBy(desc(meetingActionItems.createdAt)).all();
    if (q.assignee) rows = rows.filter(r => r.assignee === q.assignee);
    if (q.status) rows = rows.filter(r => r.status === q.status);
    return json(res, rows);
  }

  // GET /api/meetings/:id/action-items — action items for a specific meeting
  if (meetingId && parts[2] === "action-items" && req.method === "GET") {
    const rows = db.select().from(meetingActionItems)
      .where(eq(meetingActionItems.meetingId, meetingId))
      .orderBy(desc(meetingActionItems.createdAt))
      .all();
    return json(res, rows);
  }

  // PATCH /api/meetings/action-items/:itemId — update status
  if (meetingId === "action-items" && parts[2] && req.method === "PATCH") {
    const body = (await parseBody(req)) as any;
    const updates: any = { updatedAt: new Date().toISOString() };
    if (body.status) updates.status = body.status;
    if (body.assignee !== undefined) updates.assignee = body.assignee;
    db.update(meetingActionItems).set(updates).where(eq(meetingActionItems.id, parts[2])).run();
    return json(res, { ok: true });
  }

  return error(res, "Not found", 404);
}
