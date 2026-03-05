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
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";

const INGESTER_PATH = `${process.env.HOME}/lobs-youtube-ingester/ingest.py`;
const PYTHON = `${process.env.HOME}/lobs-meeting-transcriber/.venv/bin/python3`;
const CHUNK_SIZE = 1500;

function resultPath(id: string) { return `/tmp/yt-ingest-${id}.json`; }
function resultTmpPath(id: string) { return `/tmp/yt-ingest-${id}.json.tmp`; }
function errPath(id: string) { return `/tmp/yt-ingest-${id}.err`; }

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

async function spawnAndWait(task: string, timeoutMs = 180000): Promise<string> {
  const spawnResult = await gatewayInvoke("sessions_spawn", {
    task,
    mode: "run",
    model: "openai-codex/gpt-5.3-codex",
    runTimeoutSeconds: Math.floor(timeoutMs / 1000),
    cleanup: "keep",
  });
  const sessionKey = spawnResult.childSessionKey;
  if (!sessionKey) throw new Error("No session key from spawn");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const history = await gatewayInvoke("sessions_history", { sessionKey, limit: 5, includeTools: false });
      const messages = history?.messages ?? history ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
          const text = typeof msg.content === "string" ? msg.content
            : Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
            : "";
          if (text.trim() && text.trim().length > 50 && msg.stopReason === "stop") return text;
        }
      }
    } catch {}
  }
  throw new Error("Session timed out");
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
            const age = Date.now() - new Date(video.updatedAt ?? video.createdAt).getTime();
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

      // 2. Check "processing" videos that have transcript but no summary (stuck)
      const processing = db.select().from(youtubeVideos)
        .where(eq(youtubeVideos.status, "processing")).all();
      for (const video of processing) {
        if (video.transcript && video.transcript.length > 10 && !video.videoSummary && !aiProcessingSet.has(video.id)) {
          const age = Date.now() - new Date(video.updatedAt ?? video.createdAt).getTime();
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

  /** Run AI summarization pipeline (resumable). */
  async processAI(id: string): Promise<void> {
    const db = getDb();
    const video = db.select().from(youtubeVideos).where(eq(youtubeVideos.id, id)).get();
    if (!video || !video.transcript) throw new Error("No transcript found");

    const title = video.title ?? "Unknown";
    const channel = video.channel ?? "Unknown";
    const chunks: string[] = video.chunks ? JSON.parse(video.chunks as string) : chunkTranscript(video.transcript);

    // Resume chunk summaries from where we left off
    let chunkSummaries: string[] = [];
    if (video.chunkSummaries) {
      try { chunkSummaries = JSON.parse(video.chunkSummaries as string); } catch {}
    }

    for (let i = chunkSummaries.length; i < chunks.length; i++) {
      log().info(`[YOUTUBE] Summarizing chunk ${i + 1}/${chunks.length} for "${title}"`);
      const summary = await spawnAndWait(
        `Summarize this transcript chunk (${i + 1}/${chunks.length}) from the video "${title}" by ${channel}. ` +
        `Extract key ideas, technical insights, and important statements. Be concise but thorough.\n\nCHUNK:\n${chunks[i]}`
      );
      chunkSummaries.push(summary);
      // Save after each chunk for crash resilience
      db.update(youtubeVideos)
        .set({ chunkSummaries: JSON.stringify(chunkSummaries), updatedAt: new Date().toISOString() })
        .where(eq(youtubeVideos.id, id)).run();
    }

    // Video summary
    let videoSummary = video.videoSummary ?? "";
    if (!videoSummary) {
      log().info(`[YOUTUBE] Generating video summary for "${title}"`);
      videoSummary = await spawnAndWait(
        `Generate a comprehensive summary of this video.\n\nTitle: ${title}\nChannel: ${channel}\n\n` +
        `Structure: Core topic, Key concepts, Important insights, Notable quotes, Potential applications.\n\n` +
        `CHUNK SUMMARIES:\n${chunkSummaries.join("\n\n---\n\n")}`
      );
      db.update(youtubeVideos)
        .set({ videoSummary, updatedAt: new Date().toISOString() })
        .where(eq(youtubeVideos.id, id)).run();
    }

    // Reflection
    let reflection = video.reflection ?? "";
    if (!reflection) {
      log().info(`[YOUTUBE] Generating reflection for "${title}"`);
      reflection = await spawnAndWait(
        `Reflect on this video and extract insights for building AI agent systems.\n\n` +
        `Title: ${title}\nChannel: ${channel}\n\n` +
        `Consider: implications, connections to multi-agent architecture, debates, research directions, practical applications.\n\n` +
        `VIDEO SUMMARY:\n${videoSummary}\n\nKEY CHUNKS:\n${chunkSummaries.slice(0, 5).join("\n\n---\n\n")}`
      );
    }

    db.update(youtubeVideos)
      .set({ status: "ready", reflection, updatedAt: new Date().toISOString() })
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
