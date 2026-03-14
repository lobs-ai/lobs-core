/**
 * Meeting Analysis — post-transcription processing.
 * Spawns a session to analyze transcript, extract summary + action items.
 * Results stored back in meetings DB.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { meetings, meetingActionItems, tasks, inboxItems } from "../db/schema.js";
import { log } from "../util/logger.js";
import { classifyApprovalTier } from "../util/approval-tier.js";
import { getModelForTier } from "../config/models.js";

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

async function spawnAndWait(task: string, timeoutMs = 300000): Promise<string> {
  const outFile = `/tmp/yt-ai-meeting-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;

  const wrappedTask = `You are a meeting analysis writer. Your ONLY job is to write your analysis directly to a file.

DO NOT reply with the analysis in chat. Instead, use the Write tool to write it to: ${outFile}

Here is what to write:

${task}

Remember: Write the COMPLETE analysis to ${outFile} using the Write tool. That file is your only output.`;

  const spawnResult = await gatewayInvoke("sessions_spawn", {
    task: wrappedTask,
    mode: "run",
    model: getModelForTier("standard"),
    thinking: "off",
    runTimeoutSeconds: Math.floor(timeoutMs / 1000),
    cleanup: "delete",
  });

  log().info("[MEETING_ANALYSIS] Spawned agent → " + outFile);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    if (existsSync(outFile)) {
      const text = readFileSync(outFile, "utf-8").trim();
      if (text.length > 50) {
        log().info("[MEETING_ANALYSIS] Got " + text.length + " chars from " + outFile);
        try { unlinkSync(outFile); } catch {}
        return text;
      }
    }
  }

  try { unlinkSync(outFile); } catch {}
  throw new Error("Timed out waiting for analysis output file");
}

const ANALYSIS_PROMPT = `You are analyzing a meeting transcript. Your job is to deeply understand what was discussed and produce a thorough analysis — not just extract what was explicitly said, but think about what should happen next.

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:

{
  "title": "short descriptive title for this meeting",
  "participants": ["lowercase first names of people speaking"],
  "summary": "Thorough summary covering: what was discussed, key points made by each participant, decisions reached, open questions, and overall tone/urgency. Be detailed — this is the permanent record of the meeting.",
  "decisions": ["list of key decisions made or conclusions reached"],
  "topics_discussed": ["list of major topics/themes covered"],
  "open_questions": ["unresolved questions or things that need follow-up discussion"],
  "action_items": [
    {
      "description": "specific, actionable task description",
      "assignee": "person's name (lowercase) or null if unassigned",
      "due_date": "YYYY-MM-DD or null if not mentioned",
      "priority": "high/medium/low",
      "source": "explicit or inferred"
    }
  ]
}

Rules for action items:
- Include EXPLICIT action items (things someone said they'd do or asked someone to do)
- Also include INFERRED action items — things that clearly need to happen based on the discussion but weren't formally assigned. Mark these with "source": "inferred"
- For bugs, issues, or problems discussed: create an action item to fix each one
- For feature ideas discussed positively: create an action item to implement or spec each one
- For decisions made: create action items for any follow-up work the decision requires
- Be specific: "Fix the drag-to-reorder bug in assessments" not "Fix bugs"
- Use lowercase first names for assignee: "rafe", "lobs", etc.
- Default assignee is "lobs" — most action items from meetings are work for the AI agent system
- Only assign to "rafe" if the item EXPLICITLY requires a human decision or human-only action (e.g., "Rafe will email the professor", "Rafe needs to decide on pricing")
- Implementation tasks, design tasks, research tasks, feature specs, bug fixes, documentation — ALL go to "lobs" even if Rafe discussed them
- If unclear who should do it, assign to "lobs" (not null)
- Prioritize: blocking bugs = high, features discussed enthusiastically = medium, nice-to-haves = low
- If the meeting is just a test with no real content, return empty arrays
- Do NOT duplicate items — if the same issue is mentioned multiple times, consolidate into one item

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

        // Only create PAW tasks for lobs (or unassigned) action items.
        // Other people (rafe, etc.) don't use Nexus so they use meeting notes directly.
        const isLobsItem = !item.assignee || item.assignee === "lobs";
        if (isLobsItem) {
          taskId = randomUUID();
          const agent = /redesign|architect|evaluat/i.test(item.description) ? "architect"
            : /research|scrape|documentation|investigate/i.test(item.description) ? "researcher"
            : "programmer";

          const notes = `## Problem\n${item.description}\n\n## Acceptance Criteria\n- [ ] Change implemented and working\n- [ ] Build passes\n\n## Context\nFrom meeting: ${meeting.title ?? meeting.filename}\nMeeting ID: ${meetingId}\nPriority: ${item.priority ?? "medium"}\nSource: ${item.source ?? "explicit"}`;

          // Use standard approval tier classification
          const tier = classifyApprovalTier(agent, notes);
          const status = tier === "C" ? "proposed" : "active";

          db.insert(tasks).values({
            id: taskId,
            title: item.description,
            status,
            owner: item.assignee ?? "lobs",
            agent,
            notes,
          }).run();

          // Tier C → inbox item for Rafe to review in Nexus
          if (tier === "C") {
            db.insert(inboxItems).values({
              id: randomUUID(),
              title: `Review: ${item.description.slice(0, 80)}`,
              content: `Meeting-generated task needs approval.\n\nTask: ${item.description}\nAgent: ${agent}\nMeeting: ${meeting.title ?? meeting.filename}\nPriority: ${item.priority ?? "medium"}\n\nApprove this task to start work.`,
              type: "action",
              requiresAction: true,
              actionStatus: "pending",
              sourceAgent: "meeting-analysis",
              isRead: false,
            }).run();
          }

          log().info(`[MEETING_ANALYSIS] Created ${tier}-tier task ${taskId} (${status}): ${item.description.slice(0, 60)}`);
        } else {
          log().info(`[MEETING_ANALYSIS] Skipping task creation for non-lobs assignee (${item.assignee}): ${item.description.slice(0, 60)}`);
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
