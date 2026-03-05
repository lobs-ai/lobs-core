/**
 * Meeting Analysis — post-transcription processing.
 * Spawns a session to analyze transcript, extract summary + action items.
 * Results stored back in meetings DB.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { meetings, meetingActionItems, tasks } from "../db/schema.js";
import { log } from "../util/logger.js";
import { readFileSync } from "node:fs";

function gatewayCfg(): { port: number; token: string } {
  const cfgPath = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    return { port: cfg?.gateway?.port ?? 18789, token: cfg?.gateway?.auth?.token ?? "" };
  } catch { return { port: 18789, token: "" }; }
}

async function gatewayInvoke(tool: string, args: Record<string, unknown>): Promise<any> {
  const { port, token } = gatewayCfg();
  const r = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ tool, args, sessionKey: "agent:sink:paw-orchestrator-v2" }),
  });
  if (!r.ok) throw new Error(`Gateway ${tool} failed (${r.status}): ${await r.text()}`);
  const data = (await r.json()) as any;
  return data?.result?.details ?? data?.result ?? data;
}

async function spawnAndWait(task: string, timeoutMs = 120000): Promise<string> {
  // Spawn the session
  const spawnResult = await gatewayInvoke("sessions_spawn", {
    task,
    mode: "run",
    model: "anthropic/claude-sonnet-4-6",
    runTimeoutSeconds: Math.floor(timeoutMs / 1000),
    cleanup: "keep",
  });

  const sessionKey = spawnResult.childSessionKey;
  if (!sessionKey) throw new Error("No session key from spawn: " + JSON.stringify(spawnResult));

  // Poll for completion
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));

    try {
      const history = await gatewayInvoke("sessions_history", {
        sessionKey,
        limit: 5,
        includeTools: false,
      });

      const messages = history?.messages ?? history ?? [];
      // Look for the last assistant message
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
          const text = typeof msg.content === "string" ? msg.content
            : Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
            : "";
          if (text.trim()) return text;
        }
      }
    } catch (e) {
      log().debug?.(`[MEETING_ANALYSIS] Poll error: ${e}`);
    }
  }

  throw new Error("Analysis session timed out");
}

const ANALYSIS_PROMPT = `You are analyzing a meeting transcript. Return ONLY valid JSON (no markdown, no code fences) with this exact structure:

{
  "title": "short descriptive title for this meeting",
  "participants": ["lowercase first names of people speaking"],
  "summary": "2-4 sentence summary of the meeting",
  "decisions": ["list of key decisions made"],
  "action_items": [
    {
      "description": "what needs to be done",
      "assignee": "person's name (lowercase) or null if unassigned",
      "due_date": "YYYY-MM-DD or null if not mentioned"
    }
  ]
}

Rules:
- Infer the meeting title from the content discussed
- Identify participants from speaker patterns and names mentioned
- For assignee, use lowercase first names: "rafe", "lobs", "alex", etc.
- If an action item is for the AI assistant / Lobs, use "lobs"
- If unclear who should do it, set assignee to null
- Be specific in action item descriptions
- Only include actual commitments/tasks, not discussion points
- If the meeting is just a test with no real content, return empty arrays

TRANSCRIPT:
`;

export class MeetingAnalysisService {
  async analyze(meetingId: string): Promise<void> {
    const db = getDb();
    const meeting = db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
    if (!meeting) {
      log().error(`[MEETING_ANALYSIS] Meeting ${meetingId} not found`);
      return;
    }

    db.update(meetings)
      .set({ analysisStatus: "processing", updatedAt: new Date().toISOString() })
      .where(eq(meetings.id, meetingId))
      .run();

    try {
      const prompt = ANALYSIS_PROMPT + meeting.transcript;
      const responseText = await spawnAndWait(prompt);

      // Parse JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in response: " + responseText.slice(0, 200));
      const analysis = JSON.parse(jsonMatch[0]);

      // Store summary, title, participants (from AI analysis)
      const updates: Record<string, any> = {
        summary: analysis.summary,
        analysisStatus: "completed",
        updatedAt: new Date().toISOString(),
      };
      // Auto-fill title if it was untitled
      if (analysis.title && (!meeting.title || meeting.title === "Untitled Meeting" || meeting.title?.endsWith(".webm"))) {
        updates.title = analysis.title;
      }
      // Auto-fill participants if empty
      if (analysis.participants?.length && !meeting.participants) {
        updates.participants = JSON.stringify(analysis.participants);
      }
      db.update(meetings).set(updates).where(eq(meetings.id, meetingId)).run();

      // Store action items
      for (const item of analysis.action_items ?? []) {
        const itemId = randomUUID();
        let taskId: string | null = null;

        // Auto-create PAW task for lobs action items
        if (item.assignee === "lobs") {
          taskId = randomUUID();
          db.insert(tasks).values({
            id: taskId,
            title: item.description,
            status: "active",
            owner: "lobs",
            agent: "programmer",
            notes: `From meeting: ${meeting.title ?? meeting.filename}\nMeeting ID: ${meetingId}`,
          }).run();
          log().info(`[MEETING_ANALYSIS] Created task ${taskId} for Lobs: ${item.description}`);
        }

        db.insert(meetingActionItems).values({
          id: itemId,
          meetingId,
          description: item.description,
          assignee: item.assignee ?? null,
          dueDate: item.due_date ?? null,
          taskId,
        }).run();
      }

      log().info(`[MEETING_ANALYSIS] Completed analysis for meeting ${meetingId}: ${(analysis.action_items ?? []).length} action items, summary: ${(analysis.summary ?? "").slice(0, 80)}`);

    } catch (e: any) {
      log().error(`[MEETING_ANALYSIS] Failed for meeting ${meetingId}: ${e.message}`);
      db.update(meetings)
        .set({ analysisStatus: "failed", updatedAt: new Date().toISOString() })
        .where(eq(meetings.id, meetingId))
        .run();
    }
  }
}
