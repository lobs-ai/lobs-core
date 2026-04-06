/**
 * DeferredActionQueue — captures action items during live meetings
 * that should be processed after the meeting ends, not immediately.
 *
 * The queue lives in-memory for the duration of a voice session.
 * On session end, items are drained and merged with the post-hoc
 * meeting analysis to produce deduplicated tasks and inbox items.
 *
 * @see docs/decisions/ADR-realtime-action-judgment.md
 */

export interface DeferredAction {
  /** Clear, actionable description of what needs to be done */
  description: string;
  /** Category of the action */
  actionType:
    | "investigate"
    | "implement"
    | "write_doc"
    | "review_pr"
    | "research"
    | "fix_bug"
    | "other";
  /** Urgency level */
  priority: "high" | "medium" | "low";
  /** Who should handle this (default: "the bot") */
  assignee: string;
  /** Brief context from the discussion that prompted this */
  context?: string;
  /** When the action was captured (epoch ms) */
  timestamp: number;
}

export class DeferredActionQueue {
  private actions: DeferredAction[] = [];
  private meetingId: string | null = null;

  /** Associate this queue with a meeting ID (set when recording starts) */
  setMeetingId(id: string): void {
    this.meetingId = id;
  }

  /** Get the associated meeting ID */
  getMeetingId(): string | null {
    return this.meetingId;
  }

  /** Add an action to the deferred queue */
  add(action: DeferredAction): void {
    this.actions.push(action);
    console.log(
      `[deferred-queue] Added action (${action.priority}): ${action.description.slice(0, 80)} [${this.actions.length} total]`,
    );
  }

  /**
   * Drain all actions from the queue (empties it).
   * Typically called when the meeting/voice session ends.
   */
  drain(): DeferredAction[] {
    const items = [...this.actions];
    this.actions = [];
    if (items.length > 0) {
      console.log(
        `[deferred-queue] Drained ${items.length} deferred action(s) for meeting ${this.meetingId ?? "unknown"}`,
      );
    }
    return items;
  }

  /** Peek at all actions without draining */
  peek(): readonly DeferredAction[] {
    return this.actions;
  }

  /** Number of deferred actions currently in the queue */
  get length(): number {
    return this.actions.length;
  }

  /** Check if the queue is empty */
  get isEmpty(): boolean {
    return this.actions.length === 0;
  }
}

/**
 * Simple token-overlap deduplication.
 *
 * Returns true if two action descriptions are "close enough" to be
 * considered duplicates. Uses word-level Jaccard similarity.
 */
export function isDuplicateAction(a: string, b: string, threshold = 0.5): boolean {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 || tokensB.size === 0) return false;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union > 0 ? intersection / union : 0;

  return jaccard >= threshold;
}
