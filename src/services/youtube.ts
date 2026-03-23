/**
 * YouTube Ingestion Service — download, transcribe, chunk, summarize, reflect.
 * 
 * Architecture: crash-resilient pipeline.
 * - Download+transcribe runs as a detached process writing to /tmp/yt-ingest-{id}.json
 * - A recovery loop (every 30s) picks up completed result files and resumes processing
 * - Each stage checks DB state and resumes from where it left off
 * - Gateway restarts don't lose progress — detached processes survive, results persist on disk
 */

import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { youtubeVideos } from "../db/schema.js";
import { log } from "../util/logger.js";
import { readFileSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { excludeSessionFromCircuitBreaker } from "../hooks/circuit-breaker.js";
import { getGatewayConfig } from "../config/lobs.js";

const INGESTER_PATH = `${process.env.HOME}/lobs-youtube-ingester/ingest.py`;
const PYTHON = `${process.env.HOME}/lobs-meeting-transcriber/.venv/bin/python3`;
const CHUNK_SIZE = 1500;

function resultPath(id: string) { return `/tmp/yt-ingest-${id}.json`; }
function resultTmpPath(id: string) { return `/tmp/yt-ingest-${id}.json.tmp`; }
function errPath(id: string) { return `/tmp/yt-ingest-${id}.err`; }

async function gatewayInvoke(tool: string, args: Record<string, unknown>, timeoutMs = 900000): Promise<any> {
  const { port, token } = getGatewayConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${port}/v2/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ tool, args, sessionKey: "agent:sink:paw-orchestrator-v2" }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error(`Gateway ${tool} failed (${r.status}): ${await r.text()}`);
  const data = (await r.json()) as any;
  return data?.result?.details ?? data?.result ?? data;
}

async function spawnAndWait(task: string, timeoutMs = 600000, agentId = "main"): Promise<string> {
  const outFile = `/tmp/yt-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;

  // The agent's SOLE task is to write analysis to a file.
  // This bypasses the gateway's 4000-char tool result truncation.
  const wrappedTask = `You are a video analysis writer. Your ONLY job is to write your analysis directly to a file.

DO NOT reply with the analysis in chat. Instead, use the Write tool to write it to: ${outFile}

Here is what to write:

${task}

Remember: Write the COMPLETE analysis to ${outFile} using the Write tool. That file is your only output.`;

  const spawnResult = await gatewayInvoke("sessions/spawn", {
    task: wrappedTask,
    mode: "run",
    agentId,
    thinking: "off",
    runTimeoutSeconds: Math.floor(timeoutMs / 1000),
    cleanup: "delete",
  });

  // Exclude this session from circuit breaker tracking — YouTube agents write
  // output to files via the Write tool, so their chat response is intentionally
  // empty/short. Without exclusion the CB misclassifies them as empty_output failures.
  const childSessionKey = (spawnResult as Record<string, unknown>)?.childSessionKey as string | undefined;
  if (childSessionKey) {
    excludeSessionFromCircuitBreaker(childSessionKey);
    log().info("[YOUTUBE] Excluded session from CB: " + childSessionKey);
  }

  log().info("[YOUTUBE] Spawned agent → " + outFile);

  // Poll for the output file
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    if (existsSync(outFile)) {
      const text = readFileSync(outFile, "utf-8").trim();
      if (text.length > 100) {
        log().info("[YOUTUBE] Got " + text.length + " chars from " + outFile);
        try { unlinkSync(outFile); } catch {}
        return text;
      }
    }
  }

  // Cleanup and fail
  try { unlinkSync(outFile); } catch {}
  throw new Error("Timed out waiting for output file: " + outFile);
}


function chunkTranscript(transcript: string): string[] {
  const words = transcript.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += CHUNK_SIZE) {
    chunks.push(words.slice(i, i + CHUNK_SIZE).join(" "));
  }
  return chunks;
}

// ─── Recovery lock ───
let recoveryRunning = false;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
// Track which videos are currently being AI-processed to avoid double-processing
const aiProcessingSet = new Set<string>();

export class YouTubeService {

  /** Start the recovery loop — call once on plugin init. */
  startRecoveryLoop() {
    if (recoveryTimer) return;
    setTimeout(() => this.recoverIncomplete(), 15000);
    recoveryTimer = setInterval(() => this.recoverIncomplete(), 30000);
    log().info("[YOUTUBE] Recovery loop started (30s interval)");
  }

  stopRecoveryLoop() {
    if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = null; }
  }

  /** Check for videos that need attention and resume them. */
  async recoverIncomplete() {
    if (recoveryRunning) return;
    recoveryRunning = true;
    try {
      const db = getDb();

      // 1. Check "downloading" videos for completed result files
      const downloading = db.select().from(youtubeVideos)
        .where(eq(youtubeVideos.status, "downloading")).all();
      for (const video of downloading) {
        const outFile = resultPath(video.id);
        if (existsSync(outFile)) {
          log().info(`[YOUTUBE] Recovery: found completed result for "${video.title || video.id.slice(0,8)}"`);
          try {
            this.ingestResultFile(video.id, outFile);
            // Don't await AI processing here — let it run async
            if (!aiProcessingSet.has(video.id)) {
              aiProcessingSet.add(video.id);
              this.processAI(video.id)
                .catch(e => {
                  log().error(`[YOUTUBE] AI processing failed for ${video.id}: ${e.message}`);
                  db.update(youtubeVideos)
                    .set({ status: "failed", error: e.message, updatedAt: new Date().toISOString() })
                    .where(eq(youtubeVideos.id, video.id)).run();
                })
                .finally(() => aiProcessingSet.delete(video.id));
            }
          } catch (e: any) {
            log().error(`[YOUTUBE] Recovery ingest failed for ${video.id}: ${e.message}`);
            db.update(youtubeVideos)
              .set({ status: "failed", error: e.message, updatedAt: new Date().toISOString() })
              .where(eq(youtubeVideos.id, video.id)).run();
          }
        } else {
          const tmpFile = resultTmpPath(video.id);
          const ef = errPath(video.id);
          if (!existsSync(tmpFile) && !existsSync(ef)) {
            const age = Date.now() - new Date((video.updatedAt ?? video.createdAt) + 'Z').getTime();
            if (age > 120000) {
              log().info(`[YOUTUBE] Recovery: restarting stale download for ${video.id.slice(0,8)}`);
              this.spawnIngester(video.id, video.videoUrl);
            }
          } else if (existsSync(ef) && !existsSync(tmpFile)) {
            const errContent = readFileSync(ef, "utf-8").trim();
            if (errContent) {
              log().error(`[YOUTUBE] Recovery: ingester crashed for ${video.id.slice(0,8)}: ${errContent.slice(0,200)}`);
              db.update(youtubeVideos)
                .set({ status: "failed", error: errContent, updatedAt: new Date().toISOString() })
                .where(eq(youtubeVideos.id, video.id)).run();
              try { unlinkSync(ef); } catch {}
            }
          }
        }
      }

      // 2. Check "processing" videos OR "ready" videos missing reflection
      const processing = db.select().from(youtubeVideos)
        .where(eq(youtubeVideos.status, "processing")).all();
      for (const v of processing) { const age = Date.now() - new Date((v.updatedAt ?? v.createdAt) + 'Z').getTime(); log().info("[YOUTUBE] Recovery check: " + v.id.slice(0,8) + " tx=" + (v.transcript?.length ?? 0) + " sum=" + (v.videoSummary?.length ?? 0) + " aiSet=" + aiProcessingSet.has(v.id) + " age=" + Math.round(age/1000) + "s"); }
      const needsReflection = db.select().from(youtubeVideos)
        .where(eq(youtubeVideos.status, "ready")).all()
        .filter(v => v.transcript && (!v.reflection || v.reflection === "No reflection generated."));
      for (const video of [...processing, ...needsReflection]) {
        if (video.transcript && video.transcript.length > 10 && (!video.videoSummary || !video.reflection || video.reflection === "No reflection generated.") && !aiProcessingSet.has(video.id)) {
          const age = Date.now() - new Date((video.updatedAt ?? video.createdAt) + 'Z').getTime();
          if (age > 120000) {
            log().info(`[YOUTUBE] Recovery: resuming AI for "${video.title || video.id.slice(0,8)}"`);
            aiProcessingSet.add(video.id);
            this.processAI(video.id)
              .catch(e => {
                log().error(`[YOUTUBE] AI recovery failed for ${video.id}: ${e.message}`);
                getDb().update(youtubeVideos)
                  .set({ status: "failed", error: e.message, updatedAt: new Date().toISOString() })
                  .where(eq(youtubeVideos.id, video.id)).run();
              })
              .finally(() => aiProcessingSet.delete(video.id));
          }
        }
      }

      // 3. Start pending videos (one at a time)
      const activeCount = downloading.length + processing.filter(v => aiProcessingSet.has(v.id)).length;
      if (activeCount === 0) {
        const pending = db.select().from(youtubeVideos)
          .where(eq(youtubeVideos.status, "pending")).all();
        if (pending.length > 0) {
          const video = pending[0];
          log().info(`[YOUTUBE] Recovery: starting pending video ${video.id.slice(0,8)}`);
          this.process(video.id).catch(e =>
            log().error(`[YOUTUBE] Process failed for ${video.id}: ${e.message}`)
          );
        }
      }
    } catch (e: any) {
      log().error(`[YOUTUBE] Recovery loop error: ${e.message}`);
    } finally {
      recoveryRunning = false;
    }
  }

  /** Spawn the detached ingester process. */
  private spawnIngester(id: string, url: string) {
    const db = getDb();
    const outFile = resultPath(id);
    const ef = errPath(id);
    const safeUrl = url.replace(/'/g, "'\\''");

    db.update(youtubeVideos)
      .set({ status: "downloading", updatedAt: new Date().toISOString() })
      .where(eq(youtubeVideos.id, id)).run();

    const child = spawn("/bin/sh", ["-c",
      `${PYTHON} ${INGESTER_PATH} '${safeUrl}' > '${outFile}.tmp' 2>'${ef}' && mv '${outFile}.tmp' '${outFile}'`
    ], { detached: true, stdio: "ignore" });
    child.unref();
    log().info(`[YOUTUBE] Spawned detached ingester pid=${child.pid} for ${id.slice(0,8)}`);
  }

  /** Read a completed result file and write metadata + transcript to DB. */
  private ingestResultFile(id: string, outFile: string) {
    const db = getDb();
    const rawOut = readFileSync(outFile, "utf-8");
    const resultLine = rawOut.split("\n").find((l: string) => l.startsWith("RESULT:"));
    if (!resultLine) throw new Error(`No RESULT line in output: ${rawOut.slice(0, 200)}`);

    let result: any;
    try { result = JSON.parse(resultLine.slice(7)); }
    catch { throw new Error("Failed to parse result JSON"); }

    const transcript = result.transcript;
    const chunks = chunkTranscript(transcript);

    db.update(youtubeVideos)
      .set({
        status: "processing",
        videoId: result.video_id,
        title: result.title,
        channel: result.channel,
        publishDate: result.publish_date,
        thumbnail: result.thumbnail,
        description: result.description,
        language: result.language,
        durationSeconds: result.duration_seconds,
        transcript,
        segments: JSON.stringify(result.segments),
        chunks: JSON.stringify(chunks),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(youtubeVideos.id, id)).run();

    log().info(`[YOUTUBE] Ingested "${result.title}" (${result.duration_seconds}s, ${transcript.length} chars, ${chunks.length} chunks)`);
    try { unlinkSync(outFile); } catch {}
    try { unlinkSync(errPath(id)); } catch {}
  }

  /** Run AI analysis: two main-agent sessions (summary + reflection). */
  async processAI(id: string): Promise<void> {
    const db = getDb();
    const video = db.select().from(youtubeVideos).where(eq(youtubeVideos.id, id)).get();
    if (!video || !video.transcript) throw new Error("No transcript found");

    const title = video.title ?? "Unknown";
    const channel = video.channel ?? "Unknown";
    const transcript = video.transcript;
    const duration = video.durationSeconds ? Math.round(video.durationSeconds / 60) + " min" : "unknown";

    // Step 1: Summary (skip if already done)
    let videoSummary = video.videoSummary ?? "";
    if (!videoSummary || videoSummary.length < 100) {
      log().info(`[YOUTUBE] Spawning main agent for summary of "${title}"`);
      videoSummary = await spawnAndWait(
        `Write a natural, conversational summary of this YouTube video. Cover what it's about, the key ideas and insights, notable claims or quotes, and why it matters. Be thorough — don't cut corners.

Title: ${title}
Channel: ${channel}
Duration: ${duration}

TRANSCRIPT:
${transcript.slice(0, 80000)}`,
        900000, "main"
      );
      // Save immediately for crash resilience
      db.update(youtubeVideos)
        .set({ videoSummary, updatedAt: new Date().toISOString() })
        .where(eq(youtubeVideos.id, id)).run();
      log().info(`[YOUTUBE] Summary done for "${title}" (${videoSummary.length} chars)`);
    }

    // Step 2: Reflection (skip if already done)
    let reflection = video.reflection ?? "";
    if (!reflection || reflection === "No reflection generated.") {
      log().info(`[YOUTUBE] Spawning main agent for reflection on "${title}"`);
      reflection = await spawnAndWait(
        `Write a thoughtful, opinionated reflection on what this video means for our AI agent setup — the PAW orchestrator, multi-agent architecture, workflow automation, and building the best personal AI agent. Be specific about what we should learn, adopt, or ignore. Don't hold back.

Title: ${title}
Channel: ${channel}
Duration: ${duration}

VIDEO SUMMARY:
${videoSummary}`,
        900000, "main"
      );
      log().info(`[YOUTUBE] Reflection done for "${title}" (${reflection.length} chars)`);
    }

    db.update(youtubeVideos)
      .set({
        status: "ready",
        videoSummary,
        reflection,
        chunkSummaries: JSON.stringify(["single-pass"]),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(youtubeVideos.id, id)).run();
    log().info(`[YOUTUBE] ✅ Fully processed "${title}"`);
  }


  /** Submit a URL for ingestion. */
  submit(url: string, projectId?: string): string {
    const db = getDb();
    const id = randomUUID();
    db.insert(youtubeVideos).values({
      id, videoUrl: url, status: "pending", projectId: projectId ?? null,
    }).run();
    // Recovery loop will pick it up, but also fire immediately
    this.process(id).catch(e => log().error(`[YOUTUBE] Process failed for ${id}: ${e.message}`));
    return id;
  }

  /** Full ingestion pipeline. */
  async process(id: string): Promise<void> {
    const db = getDb();
    const video = db.select().from(youtubeVideos).where(eq(youtubeVideos.id, id)).get();
    if (!video) return;

    try {
      const transcript = video.transcript ?? "";
      if (transcript && transcript.length > 10) {
        // Reprocess: skip download, just re-run AI
        log().info(`[YOUTUBE] Reprocessing "${video.title}" — skipping download/transcribe`);
        db.update(youtubeVideos)
          .set({ status: "processing", updatedAt: new Date().toISOString() })
          .where(eq(youtubeVideos.id, id)).run();
        if (!video.chunks) {
          const chunks = chunkTranscript(transcript);
          db.update(youtubeVideos)
            .set({ chunks: JSON.stringify(chunks), updatedAt: new Date().toISOString() })
            .where(eq(youtubeVideos.id, id)).run();
        }
        await this.processAI(id);
      } else {
        // Fresh: spawn detached ingester, recovery loop handles the rest
        this.spawnIngester(id, video.videoUrl);
      }
    } catch (e: any) {
      log().error(`[YOUTUBE] Failed for ${id}: ${e.message}`);
      db.update(youtubeVideos)
        .set({ status: "failed", error: e.message, updatedAt: new Date().toISOString() })
        .where(eq(youtubeVideos.id, id)).run();
    }
  }

  list(opts: { status?: string; limit?: number } = {}) {
    const db = getDb();
    let rows = db.select().from(youtubeVideos).orderBy(desc(youtubeVideos.createdAt)).all();
    if (opts.status) rows = rows.filter(r => r.status === opts.status);
    return rows.slice(0, opts.limit ?? 50);
  }

  get(id: string) {
    return getDb().select().from(youtubeVideos).where(eq(youtubeVideos.id, id)).get();
  }

  delete(id: string) {
    getDb().delete(youtubeVideos).where(eq(youtubeVideos.id, id)).run();
  }
}
