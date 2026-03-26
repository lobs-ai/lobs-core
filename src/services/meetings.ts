/**
 * Meetings Service — transcribe audio and store meeting transcripts.
 * Calls ~/lobs-meeting-transcriber/transcribe.py via child_process.
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { meetings } from "../db/schema.js";
import { log } from "../util/logger.js";
import { MeetingAnalysisService } from "./meeting-analysis.js";

const TRANSCRIBER_PATH = `${process.env.HOME}/lobs-meeting-transcriber/transcribe.py`;
const PYTHON = `${process.env.HOME}/lobs-meeting-transcriber/.venv/bin/python3.12`;

interface TranscribeOptions {
  title?: string;
  projectId?: string;
  participants?: string[];
  meetingType?: string;
  skipAnalysis?: boolean;
}

interface TranscriptResult {
  id: string;
  timestamp: string;
  filename: string;
  language: string;
  duration_seconds: number;
  transcript: string;
  segments: Array<{ start: number; end: number; text: string; speaker: string }>;
}

export class MeetingsService {
  /**
   * Transcribe an audio file and store the result.
   */
  async transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<typeof meetings.$inferSelect> {
    log().info(`[MEETINGS] Transcribing ${audioPath}`);

    const result = await new Promise<TranscriptResult>((resolve, reject) => {
      const args = [TRANSCRIBER_PATH, audioPath];
      // Pass HF_TOKEN for speaker diarization if available
      if (process.env.HF_TOKEN) {
        args.push("--hf-token", process.env.HF_TOKEN);
      }
      execFile(PYTHON, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          log().error(`[MEETINGS] Transcription failed: ${err.message}\n${stderr}`);
          return reject(err);
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`Failed to parse transcriber output: ${stdout.slice(0, 200)}`));
        }
      });
    });

    const db = getDb();
    const id = randomUUID();
    const record = {
      id,
      title: opts.title ?? result.filename,
      filename: result.filename,
      language: result.language,
      durationSeconds: result.duration_seconds,
      transcript: result.transcript,
      segments: JSON.stringify(result.segments),
      participants: opts.participants ? JSON.stringify(opts.participants) : null,
      projectId: opts.projectId ?? null,
      meetingType: opts.meetingType ?? "general",
    };

    db.insert(meetings).values(record).run();
    log().info(`[MEETINGS] Stored meeting ${id} (${result.duration_seconds}s, ${result.language})`);

    // Set analysisStatus to 'skipped' if requested
    if (opts.skipAnalysis) {
      db.update(meetings).set({ analysisStatus: 'skipped' }).where(eq(meetings.id, id)).run();
    }

    const stored = db.select().from(meetings).where(eq(meetings.id, id)).get()!;

    if (!opts.skipAnalysis) {
      // Fire-and-forget analysis
      const analysis = new MeetingAnalysisService();
      analysis.analyze(id).catch(e => log().error(`[MEETINGS] Analysis trigger failed: ${e.message}`));
    }

    return stored;
  }

  /** List meetings, newest first. */
  list(opts: { projectId?: string; meetingType?: string; limit?: number } = {}) {
    const db = getDb();
    const q = db.select().from(meetings).orderBy(desc(meetings.createdAt));
    // Filtering done post-query for simplicity (small dataset)
    const rows = q.all();
    let filtered = rows;
    if (opts.projectId) filtered = filtered.filter(r => r.projectId === opts.projectId);
    if (opts.meetingType) filtered = filtered.filter(r => r.meetingType === opts.meetingType);
    return filtered.slice(0, opts.limit ?? 50);
  }

  /** Get a single meeting by ID. */
  get(id: string) {
    const db = getDb();
    return db.select().from(meetings).where(eq(meetings.id, id)).get();
  }

  /** Delete a meeting. */
  delete(id: string) {
    const db = getDb();
    db.delete(meetings).where(eq(meetings.id, id)).run();
  }

  /** Update meeting metadata (title, meetingType). */
  update(id: string, updates: { title?: string; meetingType?: string }) {
    const db = getDb();
    const allowed: any = { updatedAt: new Date().toISOString() };
    if (updates.title !== undefined) allowed.title = updates.title;
    if (updates.meetingType !== undefined) allowed.meetingType = updates.meetingType;
    db.update(meetings).set(allowed).where(eq(meetings.id, id)).run();
  }
}
