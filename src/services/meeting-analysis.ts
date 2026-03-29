/**
 * Meeting Analysis — post-transcription processing.
 * Uses direct Anthropic API calls to analyze transcript and extract action items.
 * Results stored back in meetings DB.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { meetings, meetingActionItems, tasks, inboxItems } from "../db/schema.js";
import { log } from "../util/logger.js";
import { classifyApprovalTier } from "../util/approval-tier.js";
import { getModelForTier } from "../config/models.js";
import { createResilientClient, parseModelString } from "../runner/providers.js";
import { isDuplicateAction, type DeferredAction } from "./voice/deferred-action-queue.js";

async function llmAnalyze(prompt: string): Promise<string> {
  const model = getModelForTier("standard");
  const client = createResilientClient(model, { sessionId: "meeting-analysis" });

  const response = await client.createMessage({
    model: parseModelString(model).modelId,
    system: `You are Lobs, Rafe's personal AI agent. Rafe is a grad student (MS CSE) at the University of Michigan, GSI for EECS 281/291, varsity Rocket League player, and interning at Microsoft this summer. You and Rafe are building an AI agent platform together (lobs-core, Nexus dashboard, PAW hosting platform with Marcus). You know Rafe well — he values directness, correctness, and momentum over perfection. When analyzing meetings, write as yourself (Lobs) with full context of who everyone is and what you're all working on. Return ONLY valid JSON — no markdown, no code fences, no extra text.`,
    messages: [{ role: "user", content: prompt }],
    tools: [],
    maxTokens: 4096,
  });

  // Extract text from response
  const text = response.content
    ?.filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("") ?? "";

  if (!text) throw new Error("Empty response from LLM");
  return text;
}

const ANALYSIS_PROMPT = `Analyze this meeting transcript. You're Lobs — you know the people, the projects, and the context. Deeply understand what was discussed and produce a thorough analysis — not just extract what was explicitly said, but think about what should happen next based on everything you know.

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
      const responseText = await llmAnalyze(prompt);

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

  /**
   * Analyze a meeting AND merge in deferred action items captured during the live session.
   * Runs the normal transcript analysis first, then creates tasks/items for deferred
   * actions that weren't already captured by the analysis (deduplication).
   */
  async analyzeWithDeferred(meetingId: string, deferredActions: DeferredAction[]): Promise<void> {
    // 1. Run standard analysis first
    await this.analyze(meetingId);

    if (deferredActions.length === 0) return;

    const db = getDb();
    const meeting = db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
    if (!meeting) return;

    // 2. Get existing action items from the analysis
    const existingItems = db
      .select()
      .from(meetingActionItems)
      .where(eq(meetingActionItems.meetingId, meetingId))
      .all();

    const existingDescriptions = existingItems.map((item) => item.description);

    // 3. For each deferred action, check if it's already covered by analysis
    let addedCount = 0;
    for (const action of deferredActions) {
      const isDuplicate = existingDescriptions.some((desc) =>
        isDuplicateAction(action.description, desc),
      );

      if (isDuplicate) {
        log().info(
          `[MEETING_ANALYSIS] Skipping duplicate deferred action: ${action.description.slice(0, 60)}`,
        );
        continue;
      }

      // Create action item + task for non-duplicate deferred actions
      this.createActionItemFromDeferred(meetingId, meeting.title ?? "Untitled Meeting", action);
      addedCount++;
    }

    log().info(
      `[MEETING_ANALYSIS] Merged ${addedCount} deferred action(s) (${deferredActions.length - addedCount} duplicates skipped) for meeting ${meetingId}`,
    );
  }

  /**
   * Create tasks/inbox items directly from deferred actions when no meeting ID is available.
   * Used when a voice session captured deferred items but no meeting recording was active.
   */
  async createTasksFromDeferred(deferredActions: DeferredAction[]): Promise<void> {
    for (const action of deferredActions) {
      this.createActionItemFromDeferred(null, "Voice Session", action);
    }
    log().info(
      `[MEETING_ANALYSIS] Created ${deferredActions.length} task(s) from deferred actions (no meeting)`,
    );
  }

  /**
   * Create a meeting action item and optionally a PAW task from a deferred action.
   */
  private createActionItemFromDeferred(
    meetingId: string | null,
    meetingTitle: string,
    action: DeferredAction,
  ): void {
    const db = getDb();
    const itemId = randomUUID();
    let taskId: string | null = null;

    const isLobsItem = !action.assignee || action.assignee === "lobs";

    if (isLobsItem) {
      taskId = randomUUID();
      const agent =
        action.actionType === "write_doc" || action.actionType === "research"
          ? action.actionType === "write_doc"
            ? "writer"
            : "researcher"
          : action.actionType === "review_pr"
            ? "reviewer"
            : "programmer";

      const notes = [
        `## Problem`,
        action.description,
        "",
        `## Acceptance Criteria`,
        `- [ ] Change implemented and working`,
        `- [ ] Build passes`,
        "",
        `## Context`,
        `From: ${meetingTitle}${meetingId ? ` (Meeting ID: ${meetingId})` : ""}`,
        `Priority: ${action.priority}`,
        `Source: deferred (captured during live meeting)`,
        action.context ? `Discussion context: ${action.context}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const tier = classifyApprovalTier(agent, notes);
      const status = tier === "C" ? "proposed" : "active";

      db.insert(tasks)
        .values({
          id: taskId,
          title: action.description,
          status,
          owner: action.assignee || "lobs",
          agent,
          notes,
        })
        .run();

      // Tier C → inbox item for Rafe to review
      if (tier === "C") {
        db.insert(inboxItems)
          .values({
            id: randomUUID(),
            title: `Review: ${action.description.slice(0, 80)}`,
            content: `Deferred action from live meeting needs approval.\n\nTask: ${action.description}\nAgent: ${agent}\nFrom: ${meetingTitle}\nPriority: ${action.priority}\n\nApprove this task to start work.`,
            type: "action",
            requiresAction: true,
            actionStatus: "pending",
            sourceAgent: "meeting-analysis",
            isRead: false,
          })
          .run();
      }

      log().info(
        `[MEETING_ANALYSIS] Created ${tier}-tier task from deferred action: ${action.description.slice(0, 60)}`,
      );
    } else {
      log().info(
        `[MEETING_ANALYSIS] Skipping task creation for non-lobs deferred action (${action.assignee}): ${action.description.slice(0, 60)}`,
      );
    }

    // Create meeting action item if we have a meeting ID
    if (meetingId) {
      db.insert(meetingActionItems)
        .values({
          id: itemId,
          meetingId,
          description: action.description,
          assignee: action.assignee || null,
          dueDate: null,
          taskId,
        })
        .run();
    }
  }
}
