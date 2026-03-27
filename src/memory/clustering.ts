/**
 * Episode clustering — group raw events into coherent clusters for extraction.
 *
 * Deterministic (no LLM). Clusters are formed by session, time proximity,
 * project affinity, and entity overlap. Priority is assigned based on
 * signal characteristics of the included events.
 */

import { createHash } from "node:crypto";
import type { MemoryEvent } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Gaps above this (ms) force a cluster split even within the same session */
const FORCE_SPLIT_GAP_MS = 30 * 60 * 1000; // 30 minutes

/** Gap above this triggers a new cluster on user_input events */
const USER_INPUT_GAP_MS = 5 * 60 * 1000; // 5 minutes

/** Intra-project gap below this allows merging into the same cluster */
const PROJECT_MERGE_GAP_MS = 10 * 60 * 1000; // 10 minutes

/** Minimum shared entity count to trigger entity-overlap merge */
const ENTITY_OVERLAP_THRESHOLD = 2;

// ── Public types ─────────────────────────────────────────────────────────────

export interface EventCluster {
  /** Deterministic hash of member event IDs */
  id: string;
  /** Events in this cluster (chronological order) */
  events: MemoryEvent[];
  sessionId: string | null;
  projectId: string | null;
  priority: "high" | "medium" | "skip";
  reason: string;
}

// ── Entity extraction ────────────────────────────────────────────────────────

/**
 * Extract a small set of "entities" from event content for overlap detection.
 *
 * Entities are: file paths, URL hostnames, tool names, keywords in metadata.
 * Kept intentionally lightweight — no NLP, just pattern matching.
 */
function extractEntities(event: MemoryEvent): Set<string> {
  const entities = new Set<string>();

  // File paths (e.g., src/memory/db.ts)
  const pathMatches = event.content.match(/[\w./\\-]+\.\w{1,6}/g) ?? [];
  for (const p of pathMatches) {
    if (p.length > 3) entities.add(p.toLowerCase());
  }

  // Metadata-based entities
  if (event.metadata) {
    try {
      const meta = JSON.parse(event.metadata) as Record<string, unknown>;
      if (typeof meta.tool === "string") entities.add(`tool:${meta.tool}`);
      if (typeof meta.path === "string") entities.add(meta.path.toLowerCase());
      if (typeof meta.command === "string") {
        // First token of a command is often meaningful (git, npm, tsc, etc.)
        const firstToken = meta.command.trim().split(/\s+/)[0];
        if (firstToken) entities.add(`cmd:${firstToken}`);
      }
    } catch {
      // ignore malformed JSON
    }
  }

  // Keywords ≥ 6 chars from content (rough lexical entities)
  const words = event.content.match(/\b[a-zA-Z_][\w-]{5,}\b/g) ?? [];
  for (const w of words.slice(0, 10)) {
    entities.add(w.toLowerCase());
  }

  return entities;
}

/**
 * Count shared entities between two sets.
 */
function entityOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const e of a) {
    if (b.has(e)) count++;
  }
  return count;
}

// ── Cluster priority ─────────────────────────────────────────────────────────

function classifyPriority(events: MemoryEvent[]): { priority: EventCluster["priority"]; reason: string } {
  // High-priority signals
  const hasError = events.some((e) => e.event_type === "error");
  const hasDecision = events.some((e) => e.event_type === "decision");
  const hasUserInput = events.some((e) => e.event_type === "user_input");
  const hasCorrection = events.some((e) =>
    /\b(wrong|incorrect|mistake|fix|undo|revert|actually|wait|no,)\b/i.test(e.content),
  );
  const hasRepeatedToolFailure = (() => {
    const failures = events.filter((e) => {
      if (e.metadata) {
        try {
          const m = JSON.parse(e.metadata) as Record<string, unknown>;
          return m.isError === true;
        } catch {
          return false;
        }
      }
      return false;
    });
    return failures.length >= 2;
  })();

  if (hasError || hasDecision || hasCorrection || hasRepeatedToolFailure) {
    const reasons: string[] = [];
    if (hasError) reasons.push("contains errors");
    if (hasDecision) reasons.push("contains decisions");
    if (hasCorrection) reasons.push("user correction detected");
    if (hasRepeatedToolFailure) reasons.push("repeated tool failures");
    return { priority: "high", reason: reasons.join(", ") };
  }

  // Medium-priority signals
  const isLong = events.length > 50;
  const hasMeaningfulObservations = events.some((e) => e.signal_score >= 0.7);

  if (isLong || (hasUserInput && hasMeaningfulObservations)) {
    const reasons: string[] = [];
    if (isLong) reasons.push(`long session (${events.length} events)`);
    if (hasMeaningfulObservations) reasons.push("meaningful observations present");
    return { priority: "medium", reason: reasons.join(", ") };
  }

  // Skip if all events are low-signal
  const allLowSignal = events.every((e) => e.signal_score < 0.5);
  if (allLowSignal) {
    return { priority: "skip", reason: "all events low-signal (< 0.5)" };
  }

  // Default medium
  return { priority: "medium", reason: "standard activity cluster" };
}

// ── Deterministic cluster ID ─────────────────────────────────────────────────

function clusterIdFrom(events: MemoryEvent[]): string {
  const ids = events.map((e) => String(e.id)).join(",");
  return createHash("sha1").update(ids).digest("hex").slice(0, 16);
}

// ── Internal cluster builder ─────────────────────────────────────────────────

interface MutableCluster {
  events: MemoryEvent[];
  sessionId: string | null;
  projectId: string | null;
  entitySets: Set<string>[]; // one per event, for overlap checks
}

function newCluster(event: MemoryEvent, entities: Set<string>): MutableCluster {
  return {
    events: [event],
    sessionId: event.session_id,
    projectId: event.project_id,
    entitySets: [entities],
  };
}

function clusterEntities(cluster: MutableCluster): Set<string> {
  const all = new Set<string>();
  for (const s of cluster.entitySets) {
    for (const e of s) all.add(e);
  }
  return all;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Cluster a list of events into coherent episodes.
 *
 * Events should be sorted chronologically (ascending timestamp) before calling.
 * The function sorts them internally to be safe.
 */
export function clusterEvents(events: MemoryEvent[]): EventCluster[] {
  if (events.length === 0) return [];

  // Sort chronologically
  const sorted = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Pre-extract entities for all events
  const entitySets = sorted.map(extractEntities);

  const clusters: MutableCluster[] = [];
  let current: MutableCluster = newCluster(sorted[0], entitySets[0]);

  for (let i = 1; i < sorted.length; i++) {
    const event = sorted[i];
    const entities = entitySets[i];

    const prevEvent = sorted[i - 1];
    const prevTime = new Date(prevEvent.timestamp).getTime();
    const curTime = new Date(event.timestamp).getTime();
    const gapMs = curTime - prevTime;

    // ── Split rules (checked first) ──

    // Force split on large time gap
    if (gapMs > FORCE_SPLIT_GAP_MS) {
      clusters.push(current);
      current = newCluster(event, entities);
      continue;
    }

    // New user_input after meaningful gap → new cluster (likely new intent)
    if (event.event_type === "user_input" && gapMs > USER_INPUT_GAP_MS) {
      clusters.push(current);
      current = newCluster(event, entities);
      continue;
    }

    // ── Merge rules ──

    // Rule 1: Same session_id → always same cluster
    if (
      event.session_id !== null &&
      current.sessionId !== null &&
      event.session_id === current.sessionId
    ) {
      current.events.push(event);
      current.entitySets.push(entities);
      continue;
    }

    // Rule 2: Same project_id + gap < 10 min → same cluster
    if (
      event.project_id !== null &&
      current.projectId !== null &&
      event.project_id === current.projectId &&
      gapMs < PROJECT_MERGE_GAP_MS
    ) {
      current.events.push(event);
      current.entitySets.push(entities);
      continue;
    }

    // Rule 3: Strong entity overlap (≥ 2 shared) → merge
    const clusterEntitySet = clusterEntities(current);
    if (entityOverlap(clusterEntitySet, entities) >= ENTITY_OVERLAP_THRESHOLD) {
      current.events.push(event);
      current.entitySets.push(entities);
      continue;
    }

    // No merge rule matched → start new cluster
    clusters.push(current);
    current = newCluster(event, entities);
  }

  clusters.push(current);

  // Convert MutableCluster → EventCluster
  return clusters.map((c): EventCluster => {
    const { priority, reason } = classifyPriority(c.events);
    return {
      id: clusterIdFrom(c.events),
      events: c.events,
      sessionId: c.sessionId,
      projectId: c.projectId,
      priority,
      reason,
    };
  });
}
