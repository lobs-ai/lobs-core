/**
 * YouTube Ingestion Service — download, transcribe, chunk, summarize, reflect.
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { youtubeVideos } from "../db/schema.js";
import { log } from "../util/logger.js";
import { readFileSync } from "node:fs";

const INGESTER_PATH = `${process.env.HOME}/lobs-youtube-ingester/ingest.py`;
const PYTHON = `${process.env.HOME}/lobs-meeting-transcriber/.venv/bin/python3`;
const CHUNK_SIZE = 1500; // ~tokens per chunk

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
    model: "anthropic/claude-sonnet-4-6",
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
          // Skip short garbage responses ("OK", acknowledgments) — need substantive content
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

export class YouTubeService {
  /** Submit a URL for ingestion. Returns immediately, processing is async. */
  submit(url: string, projectId?: string): string {
    const db = getDb();
    const id = randomUUID();
    db.insert(youtubeVideos).values({
      id,
      videoUrl: url,
      status: "pending",
      projectId: projectId ?? null,
    }).run();

    // Fire and forget
    this.process(id).catch(e => log().error(`[YOUTUBE] Process failed for ${id}: ${e.message}`));
    return id;
  }

  /** Full ingestion pipeline. */
  async process(id: string): Promise<void> {
    const db = getDb();

    const updateStatus = (status: string, extra: Record<string, any> = {}) => {
      db.update(youtubeVideos)
        .set({ status, updatedAt: new Date().toISOString(), ...extra })
        .where(eq(youtubeVideos.id, id))
        .run();
    };

    try {
      const video = db.select().from(youtubeVideos).where(eq(youtubeVideos.id, id)).get();
      if (!video) return;

      // Step 1: Download + Transcribe
      updateStatus("downloading");
      log().info(`[YOUTUBE] Downloading + transcribing: ${video.videoUrl}`);

      const result = await new Promise<any>((resolve, reject) => {
        execFile(PYTHON, [INGESTER_PATH, video.videoUrl], {
          maxBuffer: 100 * 1024 * 1024,
          timeout: 600000, // 10 min for long videos
        }, (err, stdout, stderr) => {
          if (err) return reject(new Error(`Ingestion failed: ${err.message}\n${stderr}`));
          // Find the RESULT: line
          const lines = stdout.split("\n");
          const resultLine = lines.find(l => l.startsWith("RESULT:"));
          if (!resultLine) return reject(new Error("No RESULT line in output"));
          try { resolve(JSON.parse(resultLine.slice(7))); }
          catch (e) { reject(new Error("Failed to parse result JSON")); }
        });
      });

      updateStatus("transcribing", {
        videoId: result.video_id,
        title: result.title,
        channel: result.channel,
        publishDate: result.publish_date,
        thumbnail: result.thumbnail,
        description: result.description,
        language: result.language,
        durationSeconds: result.duration_seconds,
        transcript: result.transcript,
        segments: JSON.stringify(result.segments),
      });

      log().info(`[YOUTUBE] Transcribed "${result.title}" (${result.duration_seconds}s)`);

      // Step 2: Chunk
      const chunks = chunkTranscript(result.transcript);
      updateStatus("processing", { chunks: JSON.stringify(chunks) });

      // Step 3: Summarize chunks
      log().info(`[YOUTUBE] Summarizing ${chunks.length} chunks for "${result.title}"`);
      const chunkSummaries: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const summary = await spawnAndWait(
          `Summarize this transcript chunk (${i + 1}/${chunks.length}) from the video "${result.title}" by ${result.channel}. ` +
          `Extract key ideas, technical insights, and important statements. Be concise but thorough.\n\nCHUNK:\n${chunks[i]}`
        );
        chunkSummaries.push(summary);
      }
      db.update(youtubeVideos)
        .set({ chunkSummaries: JSON.stringify(chunkSummaries), updatedAt: new Date().toISOString() })
        .where(eq(youtubeVideos.id, id)).run();

      // Step 4: Video summary
      log().info(`[YOUTUBE] Generating video summary for "${result.title}"`);
      const videoSummary = await spawnAndWait(
        `Generate a comprehensive summary of this video.\n\n` +
        `Title: ${result.title}\nChannel: ${result.channel}\n\n` +
        `Structure your summary as:\n- Core topic\n- Key concepts and ideas\n- Important insights\n- Notable quotes or statements\n- Potential applications\n\n` +
        `CHUNK SUMMARIES:\n${chunkSummaries.join("\n\n---\n\n")}`
      );
      db.update(youtubeVideos)
        .set({ videoSummary, updatedAt: new Date().toISOString() })
        .where(eq(youtubeVideos.id, id)).run();

      // Step 5: Reflection
      log().info(`[YOUTUBE] Generating reflection for "${result.title}"`);
      const reflection = await spawnAndWait(
        `Reflect on this video and extract insights relevant to building AI agent systems, ` +
        `machine learning, system architecture, and software engineering.\n\n` +
        `Title: ${result.title}\nChannel: ${result.channel}\n\n` +
        `Consider:\n- Important ideas and their implications\n- Connections to AI agent architecture (multi-agent systems, orchestrators, tool use)\n` +
        `- Contradictions or debates worth noting\n- New research directions suggested\n- Questions worth exploring further\n- Practical applications\n\n` +
        `VIDEO SUMMARY:\n${videoSummary}\n\nKEY CHUNKS:\n${chunkSummaries.slice(0, 5).join("\n\n---\n\n")}`
      );

      updateStatus("ready", { reflection });
      log().info(`[YOUTUBE] ✅ Fully processed "${result.title}"`);

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
