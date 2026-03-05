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

async function gatewaySpawn(task: string): Promise<string> {
  const { port, token } = gatewayCfg();
  const r = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({
      tool: "sessions_spawn",
      args: {
        task,
        mode: "run",
        model: "anthropic/claude-sonnet-4-6",
        runTimeoutSeconds: 120,
        cleanup: "keep",
      },
      sessionKey: "agent:sink:paw-orchestrator-v2",
    }),
  });
  if (!r.ok) throw new Error(`Gateway spawn failed (${r.status}): ${await r.text()}`);
  const data = (await r.json()) as any;
  return data?.result?.details?.text ?? data?.result?.text ?? JSON.stringify(data);
}

const ANALYSIS_PROMPT = `You are analyzing a meeting transcript. Return ONLY valid JSON (no markdown, no code fences) with this exact structure:

{
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
- For assignee, use lowercase first names: "rafe", "lobs", "alex", etc.
- If an action item is for the AI assistant / Lobs, use "lobs"
- If unclear who should do it, set assignee to null
- Be specific in action item descriptions
- Only include actual commitments/tasks, not discussion points

TRANSCRIPT:
`;

export class MeetingAnalysisService {
  /**
   * Analyze a meeting transcript and store results.
   */
  async analyze(meetingId: string): Promise<void> {
    const db = getDb();
    const meeting = db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
    if (!meeting) {
      log().error(`[MEETING_ANALYSIS] Meeting ${meetingId} not found`);
      return;
    }

    // Mark as processing
    db.update(meetings)
      .set({ analysisStatus: "processing", updatedAt: new Date().toISOString() })
      .where(eq(meetings.id, meetingId))
      .run();

    try {
      const prompt = ANALYSIS_PROMPT + meeting.transcript;
      const responseText = await gatewaySpawn(prompt);

      // Parse JSON from response (handle potential markdown wrapping)
      let jsonStr = responseText;
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) jsonStr = jsonMatch[0];

      const analysis = JSON.parse(jsonStr);

      // Store summary
      db.update(meetings)
        .set({
          summary: analysis.summary,
          analysisStatus: "completed",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(meetings.id, meetingId))
        .run();

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

      log().info(`[MEETING_ANALYSIS] Completed analysis for meeting ${meetingId}: ${(analysis.action_items ?? []).length} action items`);

    } catch (e: any) {
      log().error(`[MEETING_ANALYSIS] Failed for meeting ${meetingId}: ${e.message}`);
      db.update(meetings)
        .set({ analysisStatus: "failed", updatedAt: new Date().toISOString() })
        .where(eq(meetings.id, meetingId))
        .run();
    }
  }
}
