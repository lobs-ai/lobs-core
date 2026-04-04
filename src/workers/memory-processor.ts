/**
 * Memory Processor Worker
 *
 * Local-only memory maintenance:
 * - Summarizes yesterday's daily memory into stable bullets
 * - Auto-tags daily files in frontmatter for downstream retrieval
 * - Produces weekly rollups from the last 7 daily summaries
 * - Compresses older daily files into compact snapshots
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../util/logger.js";
import {
  BaseWorker,
  callLocalModel,
  callLocalModelJSON,
  type WorkerConfig,
  type WorkerContext,
  type WorkerResult,
  type WorkerArtifact,
} from "./base-worker.js";
import {
  parseMemoryFrontmatter,
  stripFrontmatter,
  upsertMemoryFrontmatter,
} from "../util/memory-frontmatter.js";

const HOME = process.env.HOME ?? "";
const MEMORY_DIR = resolve(HOME, ".lobs/agents/main/context/memory");
const WEEKLY_DIR = resolve(MEMORY_DIR, "weekly");
const DAILY_SUMMARY_MARKER = "## Auto-Summary";
const DAILY_TAGS_MARKER = "## Auto-Tags";
const COMPRESSED_MARKER = "[COMPRESSED]";

interface DailyAnalysis {
  summaryBullets: string[];
  tags: string[];
  carryForward: string[];
}

export class MemoryProcessorWorker extends BaseWorker {
  readonly config: WorkerConfig = {
    id: "memory-processor",
    name: "Memory Processor",
    description: "Summarizes, tags, and compresses memory files with local models",
    schedule: "0 2 * * *",
    enabled: true,
    maxTokens: 2048,
    timeoutMs: 60_000,
  };

  async execute(ctx: WorkerContext): Promise<WorkerResult> {
    const artifacts: WorkerArtifact[] = [];
    const alerts: WorkerResult["alerts"] = [];
    let totalTokens = 0;

    const yesterday = this.getDateString(-1);
    const yesterdayFile = resolve(MEMORY_DIR, `${yesterday}.md`);

    if (existsSync(yesterdayFile)) {
      const content = readFileSync(yesterdayFile, "utf-8");
      if (this.hasMeaningfulBody(content)) {
        try {
          const { analysis, tokensUsed } = await this.analyzeDaily(content, yesterday, ctx);
          totalTokens += tokensUsed;

          const updated = applyDailyAnalysisToContent(content, analysis);
          if (updated !== content) {
            writeFileSync(yesterdayFile, updated, "utf-8");
          }

          artifacts.push({
            type: "memory",
            path: yesterdayFile,
            content: analysis.summaryBullets.join("\n"),
            metadata: { date: yesterday, action: "daily-summary", tags: analysis.tags },
          });
        } catch (err) {
          log().warn(`[memory-processor] Failed to summarize ${yesterday}: ${err}`);
        }
      }
    }

    if (new Date().getDay() === 0) {
      try {
        const { summary, tokensUsed } = await this.generateWeeklySummary(ctx);
        totalTokens += tokensUsed;

        if (summary) {
          const weekId = this.getWeekId();
          const weeklyFile = resolve(WEEKLY_DIR, `${weekId}.md`);
          mkdirSync(WEEKLY_DIR, { recursive: true });
          writeFileSync(weeklyFile, summary, "utf-8");

          artifacts.push({
            type: "file",
            path: weeklyFile,
            content: summary,
            metadata: { weekId, action: "weekly-summary" },
          });
        }
      } catch (err) {
        log().warn(`[memory-processor] Failed to generate weekly summary: ${err}`);
      }
    }

    try {
      const { compressed, tokensUsed } = await this.compressOldFiles(ctx);
      totalTokens += tokensUsed;
      if (compressed > 0) {
        artifacts.push({
          type: "memory",
          content: `Compressed ${compressed} old memory files`,
          metadata: { action: "compress", count: compressed },
        });
      }
    } catch (err) {
      log().warn(`[memory-processor] Failed to compress old files: ${err}`);
    }

    return {
      success: true,
      artifacts,
      alerts,
      tokensUsed: totalTokens,
      durationMs: 0,
      summary: `Processed memory locally: ${artifacts.length} artifact(s), ${totalTokens} tokens used`,
    };
  }

  private async analyzeDaily(
    content: string,
    date: string,
    ctx: WorkerContext,
  ): Promise<{ analysis: DailyAnalysis; tokensUsed: number }> {
    const prompt = `Analyze this daily memory file and return strict JSON with:
{
  "summaryBullets": ["3-8 concrete markdown bullet strings"],
  "tags": ["up to 8 lowercase kebab-case topical tags"],
  "carryForward": ["0-5 bullets for unresolved follow-up items"]
}

Rules:
- Focus on decisions, code changes, incidents, milestones, blockers, and notable learnings.
- Tags should be retrieval-friendly topics like project names, systems, or workstreams.
- Do not invent details that are not present in the file.
- Summary bullets must start with "- ".
- carryForward items must also start with "- ".
- Return JSON only.

Date: ${date}

Memory file contents:
${stripFrontmatter(content)}`;

    // forceLocal: memory files may contain conversation snippets — never send to free cloud models
    const { data, tokensUsed } = await callLocalModelJSON<DailyAnalysis>(prompt, {
      model: ctx.model,
      baseUrl: ctx.baseUrl,
      maxTokens: 700,
      temperature: 0.1,
      systemPrompt: "You maintain agent memory files. Produce compact factual summaries and topical tags for retrieval.",
      forceLocal: true,
    });

    return {
      analysis: normalizeDailyAnalysis(data),
      tokensUsed,
    };
  }

  private async generateWeeklySummary(
    ctx: WorkerContext,
  ): Promise<{ summary: string | null; tokensUsed: number }> {
    const dailyContents: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const date = this.getDateString(-i);
      const file = resolve(MEMORY_DIR, `${date}.md`);
      if (!existsSync(file)) continue;

      const content = readFileSync(file, "utf-8");
      const section = extractSection(content, DAILY_SUMMARY_MARKER);
      const source = section || stripFrontmatter(content);
      if (source.trim().length > 50) {
        dailyContents.push(`### ${date}\n${source.trim()}`);
      }
    }

    if (dailyContents.length === 0) {
      return { summary: null, tokensUsed: 0 };
    }

    const weekId = this.getWeekId();
    const prompt = `Generate a weekly summary in markdown using these daily summaries.

Structure:
# Week of ${weekId}

## Highlights
- ...

## Projects
- ...

## Decisions
- ...

## Learnings
- ...

## Carry Forward
- ...

Source material:
${dailyContents.join("\n\n---\n\n")}`;

    // forceLocal: weekly summaries derive from memory files with potential conversation data
    const { text, tokensUsed } = await callLocalModel(prompt, {
      model: ctx.model,
      baseUrl: ctx.baseUrl,
      maxTokens: 1200,
      temperature: 0.2,
      systemPrompt: "You write concise weekly operational summaries for an AI agent system. Prefer stable facts over narrative.",
      forceLocal: true,
    });

    return { summary: text.trim(), tokensUsed };
  }

  private async compressOldFiles(
    ctx: WorkerContext,
  ): Promise<{ compressed: number; tokensUsed: number }> {
    if (!existsSync(MEMORY_DIR)) return { compressed: 0, tokensUsed: 0 };

    const files = readdirSync(MEMORY_DIR)
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file))
      .sort();

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 14);
    const cutoffStr = cutoffDate.toISOString().split("T")[0];

    let compressed = 0;
    let totalTokens = 0;

    for (const file of files) {
      const dateStr = file.replace(".md", "");
      if (dateStr >= cutoffStr) continue;

      const fullPath = resolve(MEMORY_DIR, file);
      const content = readFileSync(fullPath, "utf-8");
      if (content.includes(COMPRESSED_MARKER) || stripFrontmatter(content).trim().length < 120) continue;

      try {
        const tags = parseMemoryFrontmatter(content).tags;
        const { text, tokensUsed } = await callLocalModel(
          `Compress this older daily memory file into a short markdown snapshot.

Required structure:
${COMPRESSED_MARKER}
# ${dateStr} Memory Snapshot
## Key Facts
- ...
## Carry Forward
- ... (omit section if nothing unresolved)

Rules:
- Preserve decisions, code changes, incidents, key findings, and blockers.
- Remove chatter, redundancy, and stale status updates.
- Keep it under 220 words.

Content:
${stripFrontmatter(content)}`,
          {
            model: ctx.model,
            baseUrl: ctx.baseUrl,
            maxTokens: 500,
            temperature: 0.1,
            systemPrompt: "Compress operational memory without losing durable facts.",
            forceLocal: true,  // memory content may contain conversation data
          },
        );
        totalTokens += tokensUsed;

        const normalized = upsertMemoryFrontmatter(text.trim(), { tags });
        if (normalized.length < content.length * 0.9) {
          writeFileSync(fullPath, normalized + "\n", "utf-8");
          compressed++;
        }
      } catch {
        continue;
      }

      if (compressed >= 5) break;
    }

    return { compressed, tokensUsed: totalTokens };
  }

  private hasMeaningfulBody(content: string): boolean {
    return stripFrontmatter(content).trim().length > 200;
  }

  private getDateString(offsetDays: number): string {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().split("T")[0];
  }

  private getWeekId(): string {
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - now.getDay() + 1);
    return monday.toISOString().split("T")[0];
  }
}

function normalizeDailyAnalysis(raw: DailyAnalysis): DailyAnalysis {
  return {
    summaryBullets: normalizeBullets(raw.summaryBullets, 8),
    tags: Array.from(new Set((raw.tags ?? []).map(normalizeTag).filter(Boolean))).slice(0, 8),
    carryForward: normalizeBullets(raw.carryForward, 5),
  };
}

function normalizeBullets(items: unknown, maxItems: number): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .map((item) => (item.startsWith("- ") ? item : `- ${item.replace(/^-+\s*/, "")}`))
    .slice(0, maxItems);
}

function normalizeTag(tag: unknown): string {
  return String(tag ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function replaceOrAppendSection(content: string, heading: string, bodyLines: string[]): string {
  const body = bodyLines.join("\n").trim();
  if (!body) return content;

  const section = `${heading}\n${body}\n`;
  const escapedHeading = escapeRegExp(heading);
  const regex = new RegExp(`\\n${escapedHeading}\\n[\\s\\S]*?(?=\\n## |$)`, "m");

  if (regex.test(content)) {
    return content.replace(regex, `\n${section}`);
  }

  const trimmed = content.trimEnd();
  return `${trimmed}\n\n${section}`;
}

function extractSection(content: string, heading: string): string {
  const escapedHeading = escapeRegExp(heading);
  const regex = new RegExp(`${escapedHeading}\\n([\\s\\S]*?)(?=\\n## |$)`, "m");
  const match = regex.exec(content);
  return match?.[1]?.trim() ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyDailyAnalysisToContent(content: string, analysis: DailyAnalysis): string {
  const existing = parseMemoryFrontmatter(content);
  const mergedTags = Array.from(new Set([...existing.tags, ...analysis.tags])).sort();

  let updated = upsertMemoryFrontmatter(content, { tags: mergedTags });
  updated = replaceOrAppendSection(updated, DAILY_SUMMARY_MARKER, analysis.summaryBullets);

  const tagLines = mergedTags.length > 0 ? [mergedTags.map((tag) => `\`${tag}\``).join(" ")] : ["None"];
  updated = replaceOrAppendSection(updated, DAILY_TAGS_MARKER, tagLines);

  if (analysis.carryForward.length > 0) {
    updated = replaceOrAppendSection(updated, "## Carry Forward", analysis.carryForward);
  }

  return updated.endsWith("\n") ? updated : `${updated}\n`;
}
