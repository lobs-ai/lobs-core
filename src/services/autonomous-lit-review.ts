import * as fs from "fs";
import * as path from "path";
import { discordService } from "./discord.js";
import { getResearchRadarService } from "./research-radar.js";
import { runLiteratureReview } from "./literature-review.js";
import { findAndPopulateGaps } from "./research-gap-finder.js";
import type { ResearchRadarItem } from "./research-radar.js";
import type { LiteratureReview } from "./literature-review.js";

const ALERTS_CHANNEL = "1466921249421660415";

export interface AutonomousLitReviewResult {
  itemsReviewed: number;
  itemsSkipped: number;
  discordPosted: boolean;
  summaries: Array<{ itemId: string; title: string; papersFound: number; topGaps: string[] }>;
}

function isStale(item: ResearchRadarItem): boolean {
  if (!item.lastAnalyzedAt) return true;
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  return new Date(item.lastAnalyzedAt) < sevenDaysAgo;
}

async function saveReviewToFile(itemId: string, markdown: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(process.env.HOME ?? "/Users/lobs", ".lobs", "lit-reviews");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${itemId}-${today}.md`);
  fs.writeFileSync(filePath, markdown, "utf-8");
}

function buildDiscordDigest(
  date: string,
  summaries: Array<{ itemId: string; title: string; papersFound: number; topGaps: string[] }>,
): string {
  const header = `📚 **Autonomous Literature Review** — ${date}\n\n`;
  const items = summaries.map((s) => {
    const gapsStr = s.topGaps.length > 0 ? `**Key gaps:** ${s.topGaps.slice(0, 3).join(" · ")}` : "_No significant gaps found_";
    return `**${s.title}**\n📄 ${s.papersFound} papers · 🔍 ${s.topGaps.length} gaps found\n${gapsStr}`;
  }).join("\n\n");

  const footer = "\n\n_Run `lobs review` for full reports_";
  return header + items + footer;
}

export async function runAutonomousLitReview(): Promise<AutonomousLitReviewResult> {
  const radar = getResearchRadarService();
  const allItems = radar.getActiveIdeas();

  // Filter to stale items
  const staleItems = allItems.filter(isStale);

  // Sort: oldest lastAnalyzedAt first, then by composite score descending
  staleItems.sort((a, b) => {
    const aTime = a.lastAnalyzedAt ? new Date(a.lastAnalyzedAt).getTime() : 0;
    const bTime = b.lastAnalyzedAt ? new Date(b.lastAnalyzedAt).getTime() : 0;
    if (aTime !== bTime) return aTime - bTime; // oldest first
    const aScore = (a.noveltyScore + a.impactScore) / 2;
    const bScore = (b.noveltyScore + b.impactScore) / 2;
    return bScore - aScore;
  });

  const selected = staleItems.slice(0, 2);
  const skipped = Math.max(0, staleItems.length - selected.length);

  const summaries: AutonomousLitReviewResult["summaries"] = [];
  let itemsReviewed = 0;

  for (const item of selected) {
    try {
      const question = `${item.thesis} — recent advances and open problems in ${item.researchArea}`;
      const review: LiteratureReview = await runLiteratureReview({
        question,
        seedCount: 8,
        expansionDepth: 1,
        maxPapers: 20,
        tier: "small",
      });

      // Fire findAndPopulateGaps async (don't await)
      void findAndPopulateGaps(review);

      // Mark as analyzed
      radar.markAnalyzed(item.id);

      // Save review to file
      await saveReviewToFile(item.id, review.markdown);

      summaries.push({
        itemId: item.id,
        title: item.title,
        papersFound: review.papersAnalyzed,
        topGaps: review.gaps.slice(0, 3),
      });

      itemsReviewed++;
    } catch (err) {
      console.error(`[autonomous-lit-review] Failed to review item ${item.id} (${item.title}):`, err);
    }
  }

  // Build and post Discord digest
  let discordPosted = false;
  if (summaries.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const digest = buildDiscordDigest(today, summaries);

    // Split if over 1900 chars to respect Discord 2000 limit
    if (digest.length > 1900) {
      const midpoint = digest.slice(0, 1900).lastIndexOf("\n\n");
      const part1 = digest.slice(0, midpoint);
      const part2 = digest.slice(midpoint + 2);
      await discordService.send(ALERTS_CHANNEL, part1);
      await discordService.send(ALERTS_CHANNEL, part2);
    } else {
      await discordService.send(ALERTS_CHANNEL, digest);
    }
    discordPosted = true;
  }

  return { itemsReviewed, itemsSkipped: skipped, discordPosted, summaries };
}
