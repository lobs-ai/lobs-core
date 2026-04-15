/**
 * Worker Outcome Classifier
 *
 * Distinguishes between "worker finished" and "worker crashed" using:
 * - Session file mtime (unchanged = stalled/crashed)
 * - worker_run.ended_at (set by worker = finished; NULL = crashed)
 * - Session transcript (presence of final turn + response)
 * - Exit status (if captured)
 *
 * @see docs/designs/main-agent-proactive-health-monitor.md
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SessionTranscript } from "../runner/session-transcript.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type WorkerOutcome =
  | "finish" // Worker completed successfully
  | "failure" // Worker completed but failed (ended_at set, succeeded=0)
  | "hard_crash" // Worker died before first turn
  | "partial_crash" // Worker ran 1+ turns then died
  | "running"; // Worker still active

export interface WorkerOutcomeAnalysis {
  outcome: WorkerOutcome;
  confidence: number; // 0.0-1.0
  signals: {
    hasEndedAt: boolean;
    sessionMtimeRecent: boolean;
    sessionMtimeAge: number; // ms
    transcriptTurns: number;
    hasResponse: boolean;
    succeeded: boolean;
    timeoutReason?: string;
  };
  reasoning: string;
}

// ─── Main Classification Function ──────────────────────────────────────────

/**
 * Determine a worker's outcome by analyzing its state
 *
 * @param workerRun — Database row from worker_runs table
 * @param sessionMtimeMs — Session file's mtime in ms (null if file not found)
 * @param transcriptTurns — Number of turns in session transcript
 * @param hasResponse — Whether the last turn has an LLM response
 * @param succeeded — Value of worker_run.succeeded
 * @param timeoutReason — Value of worker_run.timeout_reason
 */
export function classifyOutcome(options: {
  endedAt: string | null;
  createdAt: string;
  sessionMtimeMs: number | null;
  transcriptTurns: number;
  hasResponse: boolean;
  succeeded: boolean;
  timeoutReason?: string;
}): WorkerOutcomeAnalysis {
  const {
    endedAt,
    createdAt,
    sessionMtimeMs,
    transcriptTurns,
    hasResponse,
    succeeded,
    timeoutReason,
  } = options;

  const createdMs = new Date(createdAt).getTime();
  const now = Date.now();
  const graceMs = 30 * 1000; // 30 seconds

  // ─── Decision Tree ─────────────────────────────────────────────────────

  // If already marked ended, use that
  if (endedAt) {
    const reasoning = succeeded
      ? `Worker marked ended at ${endedAt} with succeeded=true`
      : `Worker marked ended at ${endedAt} with succeeded=false (timeout_reason: ${timeoutReason})`;

    return {
      outcome: succeeded ? "finish" : "failure",
      confidence: 0.95, // High confidence — DB is authoritative
      signals: {
        hasEndedAt: true,
        sessionMtimeRecent: sessionMtimeMs ? now - sessionMtimeMs < graceMs : false,
        sessionMtimeAge: sessionMtimeMs ? now - sessionMtimeMs : -1,
        transcriptTurns,
        hasResponse,
        succeeded,
        timeoutReason,
      },
      reasoning,
    };
  }

  // Session not updated since spawn → hard crash
  if (
    sessionMtimeMs === null ||
    (sessionMtimeMs && sessionMtimeMs <= createdMs)
  ) {
    const reasoning =
      sessionMtimeMs === null
        ? "Session file not found (worker never spawned successfully)"
        : `Session mtime (${new Date(sessionMtimeMs).toISOString()}) <= created_at (${new Date(
            createdMs
          ).toISOString()}) — never updated`;

    return {
      outcome: "hard_crash",
      confidence: 0.9,
      signals: {
        hasEndedAt: false,
        sessionMtimeRecent: false,
        sessionMtimeAge: sessionMtimeMs ? sessionMtimeMs - createdMs : -1,
        transcriptTurns: 0,
        hasResponse: false,
        succeeded: false,
        timeoutReason,
      },
      reasoning,
    };
  }

  // Session recently updated → still running
  const mtimeAgeMs = now - sessionMtimeMs;
  if (mtimeAgeMs < graceMs) {
    const reasoning = `Session mtime is recent (${Math.round(
      mtimeAgeMs / 1000
    )}s old < ${graceMs / 1000}s grace)`;

    return {
      outcome: "running",
      confidence: 0.85, // Moderate confidence — could be busy or stalled
      signals: {
        hasEndedAt: false,
        sessionMtimeRecent: true,
        sessionMtimeAge: mtimeAgeMs,
        transcriptTurns,
        hasResponse,
        succeeded: false,
        timeoutReason,
      },
      reasoning,
    };
  }

  // Session has turns but no response → partial crash
  if (transcriptTurns > 0 && !hasResponse) {
    const reasoning = `Session has ${transcriptTurns} turn(s) but last turn has no response — died between turns`;

    return {
      outcome: "partial_crash",
      confidence: 0.85,
      signals: {
        hasEndedAt: false,
        sessionMtimeRecent: false,
        sessionMtimeAge: mtimeAgeMs,
        transcriptTurns,
        hasResponse: false,
        succeeded: false,
        timeoutReason,
      },
      reasoning,
    };
  }

  // Default → crash (conservative)
  const reasoning = `Session stale (${Math.round(mtimeAgeMs / 1000)}s old) and no ended_at — conservatively classified as crash`;
  return {
    outcome: "hard_crash",
    confidence: 0.7, // Lower confidence — could be slow worker or stalled
    signals: {
      hasEndedAt: false,
      sessionMtimeRecent: false,
      sessionMtimeAge: mtimeAgeMs,
      transcriptTurns,
      hasResponse,
      succeeded: false,
      timeoutReason,
    },
    reasoning,
  };
}

// ─── Utility: Analyze Worker from Database ─────────────────────────────────

export function analyzeWorkerOutcomeFromDb(options: {
  workerRunId: number;
  taskId: string;
  agentType: string;
  createdAt: string;
  endedAt: string | null;
  succeeded: boolean;
  timeoutReason?: string;
}): WorkerOutcomeAnalysis {
  const { taskId, agentType, createdAt, endedAt, succeeded, timeoutReason } = options;

  const HOME = process.env.HOME ?? "";
  let sessionMtimeMs: number | null = null;
  const transcriptTurns = 0;
  const hasResponse = false;

  // Try to stat session file
  try {
    const sessionPath = resolve(HOME, ".lobs", "agents", agentType, "sessions", `${taskId}.jsonl`);
    if (existsSync(sessionPath)) {
      const stat = statSync(sessionPath);
      sessionMtimeMs = stat.mtimeMs;

      // Try to parse transcript line count (rough estimate of turns)
      try {
        // TODO: implement parseSessionTranscript when SessionTranscript utility is ready
        // const transcript = SessionTranscript.load(agentType, taskId);
        // transcriptTurns = transcript.turns.length;
        // hasResponse = transcript.turns.some(t => t.response !== undefined);
      } catch (e) {
        // Ignore parse errors
      }
    }
  } catch (e) {
    // Ignore stat errors
  }

  return classifyOutcome({
    endedAt,
    createdAt,
    sessionMtimeMs,
    transcriptTurns,
    hasResponse,
    succeeded,
    timeoutReason,
  });
}

// ─── Utility: Describe Outcome for Humans ──────────────────────────────────

export function describeOutcome(analysis: WorkerOutcomeAnalysis): string {
  const baseMessage = `Worker outcome: ${analysis.outcome} (confidence ${Math.round(
    analysis.confidence * 100
  )}%)`;

  const signals: string[] = [];
  if (analysis.signals.hasEndedAt) {
    signals.push(`ended_at=${analysis.signals.succeeded ? "success" : "failure"}`);
  }
  if (analysis.signals.sessionMtimeRecent) {
    signals.push(`session mtime recent (${Math.round(analysis.signals.sessionMtimeAge / 1000)}s)`);
  }
  if (analysis.signals.transcriptTurns > 0) {
    signals.push(`${analysis.signals.transcriptTurns} turns`);
  }
  if (analysis.signals.hasResponse) {
    signals.push("has response");
  }

  const signalLine = signals.length > 0 ? ` [${signals.join(", ")}]` : "";
  return `${baseMessage}${signalLine} — ${analysis.reasoning}`;
}
