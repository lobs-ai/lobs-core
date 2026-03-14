/**
 * Dashboard Insights API — GET /api/paw/dashboard/insights
 *
 * Returns personalized data for the dashboard:
 * - Agent identity (from IDENTITY.md, SOUL.md)
 * - User profile (from USER.md)
 * - Onboarding completeness
 * - System state (task counts, inbox, recent activity)
 * - Suggested next steps based on what's known / missing
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq, desc, gte, and, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, inboxItems, workerRuns, chatSessions } from "../db/schema.js";
import { json } from "./index.js";
import { getAgentMemoryDir } from "../config/lobs.js";

const WORKSPACE = join(process.env.HOME || "/Users/lobs", "apps");

// ─── File helpers ─────────────────────────────────────────────────────────────

async function readWorkspaceFile(filename: string): Promise<string | null> {
  try {
    return await readFile(join(WORKSPACE, filename), "utf-8");
  } catch {
    return null;
  }
}

function extractMarkdownField(content: string, field: string): string | null {
  const patterns = [
    new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, "im"),
    new RegExp(`- \\*\\*${field}:\\*\\*\\s*(.+)`, "im"),
    new RegExp(`^${field}:\\s*(.+)`, "im"),
  ];
  for (const p of patterns) {
    const m = content.match(p);
    if (m) {
      const val = m[1].trim();
      // Skip template placeholder text
      if (val.startsWith("_(") || val === "" || val === "—") continue;
      return val;
    }
  }
  return null;
}

// ─── Parse workspace files ────────────────────────────────────────────────────

interface AgentIdentity {
  name: string | null;
  emoji: string | null;
  vibe: string | null;
  creature: string | null;
  avatar: string | null;
  soulSummary: string | null;
}

interface UserProfile {
  name: string | null;
  callName: string | null;
  timezone: string | null;
  notes: string | null;
  contextRaw: string | null;
}

async function parseAgentIdentity(): Promise<AgentIdentity> {
  const [identity, soul] = await Promise.all([
    readWorkspaceFile("IDENTITY.md"),
    readWorkspaceFile("SOUL.md"),
  ]);

  const name = identity ? extractMarkdownField(identity, "Name") : null;
  const emoji = identity ? extractMarkdownField(identity, "Emoji") : null;
  const vibe = identity ? extractMarkdownField(identity, "Vibe") : null;
  const creature = identity ? extractMarkdownField(identity, "Creature") : null;
  const avatar = identity ? extractMarkdownField(identity, "Avatar") : null;

  let soulSummary: string | null = null;
  if (soul) {
    const lines = soul.split("\n").filter(l => l.trim() && !l.startsWith("#") && !l.startsWith("_") && !l.startsWith("-"));
    if (lines.length > 0) soulSummary = lines[0].replace(/^\*+\s*/, "").trim();
  }

  return { name, emoji, vibe, creature, avatar, soulSummary };
}

async function parseUserProfile(): Promise<UserProfile> {
  const userMd = await readWorkspaceFile("USER.md");
  if (!userMd) return { name: null, callName: null, timezone: null, notes: null, contextRaw: null };

  const name = extractMarkdownField(userMd, "Name");
  const callName = extractMarkdownField(userMd, "What to call them");
  const timezone = extractMarkdownField(userMd, "Timezone");
  const notes = extractMarkdownField(userMd, "Notes");

  const contextMatch = userMd.match(/## Context\s*\n([\s\S]*?)(\n##|$)/i);
  let contextRaw: string | null = null;
  if (contextMatch) {
    const raw = contextMatch[1].trim();
    if (raw && !raw.startsWith("_(")) contextRaw = raw;
  }

  return { name, callName, timezone, notes, contextRaw };
}

async function countMemoryFiles(): Promise<number> {
  let count = 0;
  const agents = ["programmer", "writer", "researcher", "reviewer"];
  for (const agent of agents) {
    const memDir = getAgentMemoryDir(agent);
    if (existsSync(memDir)) {
      try {
        count += readdirSync(memDir).filter(f => f.endsWith(".md") || f.endsWith(".txt")).length;
      } catch {}
    }
  }
  const appsMemDir = join(WORKSPACE, "memory");
  if (existsSync(appsMemDir)) {
    try {
      count += readdirSync(appsMemDir).filter(f => f.endsWith(".md") || f.endsWith(".txt")).length;
    } catch {}
  }
  return count;
}

interface OnboardingStatus {
  agentNamed: boolean;
  userNamed: boolean;
  userTimezone: boolean;
  userContext: boolean;
  hasMemories: boolean;
  completeness: number;
  missing: string[];
}

function computeOnboarding(identity: AgentIdentity, user: UserProfile, memoryCount: number): OnboardingStatus {
  const checks = [
    { done: Boolean(identity.name), label: "Name your agent" },
    { done: Boolean(user.name || user.callName), label: "Tell the agent your name" },
    { done: Boolean(user.timezone), label: "Set your timezone" },
    { done: Boolean(user.contextRaw || user.notes), label: "Share some context about yourself" },
    { done: memoryCount > 0, label: "Have a conversation so the agent can learn" },
  ];
  const done = checks.filter(c => c.done).length;
  const missing = checks.filter(c => !c.done).map(c => c.label);
  return {
    agentNamed: checks[0].done,
    userNamed: checks[1].done,
    userTimezone: checks[2].done,
    userContext: checks[3].done,
    hasMemories: checks[4].done,
    completeness: Math.round((done / checks.length) * 100),
    missing,
  };
}

function getGreeting(name: string | null): string {
  const hour = new Date().getHours();
  const timeWord = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return `Good ${timeWord}, ${name || "there"}`;
}

function buildSuggestions(
  onboarding: OnboardingStatus,
  taskCounts: { active: number; queued: number; blocked: number },
  inboxCount: number,
): Array<{ icon: string; text: string; action?: string }> {
  const out: Array<{ icon: string; text: string; action?: string }> = [];

  if (!onboarding.agentNamed) out.push({ icon: "✨", text: "Give your agent a name — make it yours", action: "settings" });
  if (!onboarding.userNamed) out.push({ icon: "👋", text: "Tell your agent your name", action: "chat" });
  if (!onboarding.userContext) out.push({ icon: "🧠", text: "Share your work and goals with your agent", action: "chat" });
  if (!onboarding.userTimezone) out.push({ icon: "🌍", text: "Set your timezone for better scheduling", action: "chat" });
  if (!onboarding.hasMemories) out.push({ icon: "💬", text: "Start a conversation to build shared memory", action: "chat" });

  if (inboxCount > 0) out.push({ icon: "📬", text: `You have ${inboxCount} item${inboxCount === 1 ? "" : "s"} in your inbox`, action: "inbox" });
  if (taskCounts.blocked > 0) out.push({ icon: "🚧", text: `${taskCounts.blocked} task${taskCounts.blocked === 1 ? " is" : "s are"} blocked`, action: "tasks" });
  if (taskCounts.active === 0 && taskCounts.queued === 0 && onboarding.completeness === 100) {
    out.push({ icon: "🎯", text: "No active tasks — chat with your agent to start something", action: "chat" });
  }

  if (out.length === 0) {
    out.push({ icon: "💬", text: "Tell your agent about your schedule", action: "chat" });
    out.push({ icon: "📁", text: "Set up a project to track ongoing work", action: "projects" });
  }

  return out.slice(0, 5);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleDashboardRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
  if (sub !== "insights") {
    json(res, { error: "Not found" }, 404);
    return;
  }

  const db = getDb();

  const [identity, user, memoryCount] = await Promise.all([
    parseAgentIdentity(),
    parseUserProfile(),
    countMemoryFiles(),
  ]);

  // Task counts using workState (the canonical state for agents)
  const allTasks = db.select({
    id: tasks.id,
    workState: tasks.workState,
    finishedAt: tasks.finishedAt,
  }).from(tasks).all();

  const taskCounts = {
    active:  allTasks.filter(t => t.workState === "active").length,
    queued:  allTasks.filter(t => t.workState === "queued").length,
    done:    allTasks.filter(t => t.workState === "done").length,
    blocked: allTasks.filter(t => t.workState === "blocked").length,
  };

  // Tasks finished in last 24h
  const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
  const completedRecently = allTasks.filter(
    t => (t.workState === "done") && t.finishedAt && t.finishedAt >= yesterday
  ).length;

  // Inbox unread count
  let inboxCount = 0;
  try {
    inboxCount = db.select({ id: inboxItems.id })
      .from(inboxItems)
      .where(eq(inboxItems.isRead, false))
      .all().length;
  } catch {}

  // Recent chat sessions
  let recentSessions: Array<{ id: string; label: string | null; lastMessageAt: string | null }> = [];
  try {
    recentSessions = db.select({
      id: chatSessions.id,
      label: chatSessions.label,
      lastMessageAt: chatSessions.lastMessageAt,
    })
      .from(chatSessions)
      .orderBy(desc(chatSessions.lastMessageAt))
      .limit(5)
      .all();
  } catch {}

  // Last worker heartbeat
  let lastWorkerRun: string | null = null;
  try {
    const lastRun = db.select({ startedAt: workerRuns.startedAt })
      .from(workerRuns)
      .orderBy(desc(workerRuns.startedAt))
      .limit(1)
      .get();
    lastWorkerRun = lastRun?.startedAt ?? null;
  } catch {}

  const onboarding = computeOnboarding(identity, user, memoryCount);
  const greeting = getGreeting(user.callName || user.name);
  const suggestions = buildSuggestions(onboarding, taskCounts, inboxCount);

  // Status messages
  const agentDisplayName = identity.name || "Your agent";
  const statusMessages: string[] = [];
  if (taskCounts.active > 0) {
    statusMessages.push(`${agentDisplayName} is working on ${taskCounts.active} active task${taskCounts.active === 1 ? "" : "s"}`);
  } else {
    statusMessages.push(`${agentDisplayName} is standing by — ready when you are`);
  }
  if (completedRecently > 0) {
    statusMessages.push(`${completedRecently} task${completedRecently === 1 ? "" : "s"} completed in the last 24 hours`);
  }
  if (inboxCount > 0) {
    statusMessages.push(`${inboxCount} unread item${inboxCount === 1 ? "" : "s"} waiting in your inbox`);
  }
  if (taskCounts.queued > 0) {
    statusMessages.push(`${taskCounts.queued} task${taskCounts.queued === 1 ? "" : "s"} queued and ready to run`);
  }

  // Facts the agent knows about the user
  const knownFacts: Array<{ label: string; value: string }> = [];
  if (user.name || user.callName) {
    knownFacts.push({ label: "Name", value: user.callName || user.name! });
  }
  if (user.timezone) {
    knownFacts.push({ label: "Timezone", value: user.timezone });
  }
  if (user.contextRaw) {
    const firstLine = user.contextRaw.split("\n")[0].replace(/^[-*]\s*/, "").trim();
    if (firstLine) knownFacts.push({ label: "Context", value: firstLine });
  }
  if (memoryCount > 0) {
    knownFacts.push({ label: "Memory", value: `${memoryCount} file${memoryCount === 1 ? "" : "s"} learned` });
  }

  json(res, {
    greeting,
    agent: {
      name: identity.name,
      emoji: identity.emoji || "🐾",
      vibe: identity.vibe,
      creature: identity.creature,
      avatar: identity.avatar,
      soulSummary: identity.soulSummary,
      status: taskCounts.active > 0 ? "working" : "idle",
      lastActive: lastWorkerRun,
    },
    user: {
      name: user.name,
      callName: user.callName,
      timezone: user.timezone,
      hasContext: Boolean(user.contextRaw || user.notes),
    },
    onboarding: {
      completeness: onboarding.completeness,
      missing: onboarding.missing,
      complete: onboarding.completeness === 100,
    },
    tasks: {
      ...taskCounts,
      completedRecently,
    },
    inbox: { unread: inboxCount },
    recentSessions: recentSessions.map(s => ({
      id: s.id,
      label: s.label || "Untitled chat",
      lastMessageAt: s.lastMessageAt,
    })),
    statusMessages,
    suggestions,
    knownFacts,
    generatedAt: new Date().toISOString(),
  });
}
