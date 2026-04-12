/**
 * GSI Office Hours — Course Configuration
 *
 * Per-course config stored in ~/.lobs/gsi/<courseId>.json
 * Controls which Discord channels the bot watches, who to escalate to,
 * and what knowledge collections to search.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";

const HOME = os.homedir();
const GSI_CONFIG_DIR = resolve(HOME, ".lobs/gsi");

// ── Types ────────────────────────────────────────────────────────────────────

export interface GsiCourseConfig {
  /** Unique course identifier, e.g. "eecs281" */
  courseId: string;
  /** Human-readable course name */
  courseName: string;
  /** Discord guild ID where the bot operates */
  guildId: string;
  /**
   * Channel IDs where /ask is active.
   * If empty, /ask works in all channels of the guild.
   */
  channelIds: string[];
  /**
   * Discord user IDs who receive escalations (human TAs / instructors).
   * The bot will @-mention the first available one.
   */
  escalationUserIds: string[];
  /**
   * lobs-memory collection names that hold course materials.
   * e.g. ["eecs281-syllabus", "eecs281-lectures", "eecs281-past-answers"]
   */
  memoryCollections: string[];
  /**
   * Confidence threshold [0–1]. Below this, the bot drafts an answer
   * but flags it for human review rather than posting directly.
   */
  confidenceThreshold: number;
  /**
   * If true, low-confidence answers are DM'd to escalation users instead
   * of posted to the channel. If false, they're posted with a "needs review" flag.
   */
  dmEscalations: boolean;
  /** Optional channel ID to log all Q&A for TA review */
  logChannelId?: string;
  /** Whether this course config is active */
  enabled: boolean;
}

export interface GsiGlobalConfig {
  courses: GsiCourseConfig[];
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export function defaultCourseConfig(courseId: string): GsiCourseConfig {
  return {
    courseId,
    courseName: courseId.toUpperCase(),
    guildId: "",
    channelIds: [],
    escalationUserIds: [],
    memoryCollections: [`${courseId}-course`],
    confidenceThreshold: 0.65,
    dmEscalations: false,
    enabled: true,
  };
}

// ── Loader ───────────────────────────────────────────────────────────────────

export function loadAllCourseConfigs(): GsiCourseConfig[] {
  if (!existsSync(GSI_CONFIG_DIR)) return [];
  try {
    return readdirSync(GSI_CONFIG_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try {
          return JSON.parse(readFileSync(join(GSI_CONFIG_DIR, f), "utf8")) as GsiCourseConfig;
        } catch { return null; }
      })
      .filter((c): c is GsiCourseConfig => c !== null && c.enabled !== false);
  } catch { return []; }
}

export function loadCourseConfig(courseId: string): GsiCourseConfig | null {
  const path = join(GSI_CONFIG_DIR, `${courseId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as GsiCourseConfig;
  } catch { return null; }
}

export function saveCourseConfig(config: GsiCourseConfig): void {
  mkdirSync(GSI_CONFIG_DIR, { recursive: true });
  writeFileSync(
    join(GSI_CONFIG_DIR, `${config.courseId}.json`),
    JSON.stringify(config, null, 2),
    "utf8"
  );
}

/**
 * Find the course config for a given guild + channel.
 * Returns null if no matching course is configured.
 */
export function getCourseForChannel(guildId: string, channelId: string): GsiCourseConfig | null {
  const courses = loadAllCourseConfigs();
  for (const course of courses) {
    if (course.guildId !== guildId) continue;
    if (course.channelIds.length === 0) return course; // watches all channels
    if (course.channelIds.includes(channelId)) return course;
  }
  return null;
}

/**
 * Find the course config for a given guild (any channel match).
 */
export function getCourseForGuild(guildId: string): GsiCourseConfig | null {
  const courses = loadAllCourseConfigs();
  return courses.find(c => c.guildId === guildId) ?? null;
}
