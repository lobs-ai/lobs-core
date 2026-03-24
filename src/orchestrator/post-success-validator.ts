/**
 * Post-success artifact validation for the orchestrator.
 *
 * Called from `autoCloseSucceededTasks` before a task is marked completed.
 * Detects phantom completions: tasks that report succeeded=true but produced
 * no output (no commits, no files written). These are flagged for review
 * instead of being silently closed.
 *
 * Also flags fast completions (< FAST_THRESHOLD_MS) as suspicious even
 * when artifacts are present.
 *
 * Supported agent types:
 *   - programmer / reviewer / architect: check git commits + file mtimes in repo
 *   - writer: check .md file mtimes in known doc locations
 *   - others: skip validation (return "valid" to avoid false positives)
 *
 * Time window: uses the task's startedAt timestamp so that artifacts are
 * detected even if the auto-close check runs well after the task finished.
 * Falls back to FALLBACK_WINDOW_MINUTES if startedAt is unavailable.
 *
 * ## Concurrency Deduplication (bug c8cb6459 fix)
 *
 * When multiple tasks of the same agent type run concurrently, a simple
 * `.find()` on mtime-sorted sessions can pick the wrong session.
 *
 * Fix: `detectActualWorkingRepos` now accepts a `sessionKey` parameter
 * (the `child_session_key` from `worker_runs`) and uses it for exact
 * filename matching. If sessionKey is absent, it falls back to deterministic
 * disambiguation: smallest session ID (lexicographic) among all sessions
 * whose mtime falls within the expected window (NOT first mtime match).
 *
 * @see docs/decisions/designs/post-success-artifact-validation.md
 * @see docs/decisions/designs/orphaned-session-recovery.md
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { log } from "../util/logger.js";

/** Fallback: how far back to look if we don't have startedAt (10 minutes). */
const FALLBACK_WINDOW_MINUTES = 10;

/** Flag completions faster than this as suspicious (60 seconds). */
const FAST_THRESHOLD_MS = 60 * 1000;

/** How long after startedAt a session file could still be active (30 minutes). */
const SESSION_MATCH_WINDOW_MS = 30 * 60_000;

/**
 * Agent types that require artifact validation.
 * Others skip validation to avoid false positives on unknown task shapes.
 */
const VALIDATED_AGENTS = new Set(["programmer", "reviewer", "architect", "writer"]);

export type PostSuccessValidationResult =
  | { status: "valid" }                             // artifacts found, duration OK — safe to close
  | { status: "suspicious"; reason: string }        // fast but artifacts found — close with warning
  | { status: "no_artifacts"; reason: string };     // no artifacts — phantom completion

/**
 * Build the `--since` argument for git log and the `-newermt` argument for find
 * based on the task's startedAt time. Falls back to a relative window if unavailable.
 */
function buildTimeCutoff(startedAt: string | null): { gitSince: string; findNewer: string; label: string } {
  if (startedAt) {
    // Parse and subtract 1 minute buffer for clock skew
    const ts = new Date(new Date(startedAt).getTime() - 60_000);
    const isoStr = ts.toISOString();
    return {
      gitSince: isoStr,
      findNewer: isoStr,
      label: `since task start (${startedAt})`,
    };
  }
  // Fallback: relative window from now
  return {
    gitSince: `${FALLBACK_WINDOW_MINUTES} minutes ago`,
    findNewer: new Date(Date.now() - FALLBACK_WINDOW_MINUTES * 60_000).toISOString(),
    label: `last ${FALLBACK_WINDOW_MINUTES}min (fallback)`,
  };
}

/**
 * Validate that a succeeded task actually produced output.
 *
 * @param agentType         agent role ("programmer" | "writer" | etc.)
 * @param repoPath          project repo path (from projects.repo_path), may be null
 * @param durationMs        how long the last run took (ended_at - started_at in ms), null if unknown
 * @param expectedArtifacts parsed expected_artifacts from the task (ArtifactSpec[]), null to use heuristics
 * @param startedAt         ISO timestamp of when the task's last run started, null if unknown
 * @param sessionKey        child_session_key from worker_runs (hex filename stem), null if unknown
 */
export function validatePostSuccessArtifacts(
  agentType: string | null,
  repoPath: string | null,
  durationMs: number | null,
  expectedArtifacts: unknown = null,
  startedAt: string | null = null,
  sessionKey: string | null = null,
): PostSuccessValidationResult {
  const agent = agentType ?? "unknown";

  // Skip validation for agent types we don't have heuristics for.
  // Better to miss a phantom than to falsely block a valid completion.
  if (!VALIDATED_AGENTS.has(agent)) {
    return { status: "valid" };
  }

  const cutoff = buildTimeCutoff(startedAt);
  let hasArtifacts = false;
  let artifactDetail = "";

  if (agent === "programmer" || agent === "reviewer" || agent === "architect") {
    // Check the project repo first
    const result = checkRepoArtifacts(repoPath, cutoff);
    hasArtifacts = result.found;
    artifactDetail = result.detail;

    // If no artifacts in project repo, check repos the agent actually worked in.
    // Agents often work in a different repo than the project's declared repo_path
    // (e.g., a task filed under PAW might fix code in lobs-core).
    if (!hasArtifacts) {
      const sessionResult = detectActualWorkingRepos(agent, startedAt, sessionKey);
      const actualRepos = sessionResult.repos;
      for (const actualRepo of actualRepos) {
        // Skip if same as project repo (already checked)
        if (actualRepo === repoPath?.replace(/^~/, process.env["HOME"] ?? "")) continue;
        const altResult = checkRepoArtifacts(actualRepo, cutoff);
        if (altResult.found) {
          hasArtifacts = true;
          artifactDetail = `${altResult.detail} (in ${actualRepo}, not project repo ${repoPath})`;
          break;
        }
      }
      // WARNING: session was found and had activity patterns, but we still found no artifacts
      // in any of the repos it referenced. This suggests a phantom completion or a session
      // matching problem — the repos may have been checked on the wrong branch, or the
      // session was already rolled back.
      if (!hasArtifacts && sessionResult.sessionStem !== null && sessionResult.hadActivityPatterns) {
        log().warn(
          `[psv:artifact-check:warn] agent=${agent} ` +
          `NO_ARTIFACTS_IN_SESSION_REPOS: session=${sessionResult.sessionStem} ` +
          `had activity patterns (gitCmds/writeEdits detected) ` +
          `but no artifacts found in any referenced repo ` +
          `[${actualRepos.join(", ") || "none"}]. ` +
          `projectRepo=${repoPath ?? "none"} startedAt=${startedAt ?? "unknown"} — ` +
          `possible phantom completion or wrong session matched.`,
        );
      }
    }
  } else if (agent === "writer") {
    // If the task declared expected_artifacts, verify those specific paths exist.
    // This catches false-success reports where git push failed (file may not be on remote,
    // but more importantly it didn't end up in the expected location at all).
    const specPaths = extractExpectedPaths(expectedArtifacts);
    if (specPaths.length > 0) {
      const result = checkExpectedArtifactPaths(specPaths);
      hasArtifacts = result.found;
      artifactDetail = result.detail;
    } else {
      const result = checkWriterArtifacts(cutoff);
      hasArtifacts = result.found;
      artifactDetail = result.detail;
    }
  }

  if (!hasArtifacts) {
    return {
      status: "no_artifacts",
      reason:
        `No output artifacts detected ${cutoff.label} for ` +
        `${agent} task (duration=${durationMs != null ? Math.round(durationMs / 1000) + "s" : "unknown"}, ` +
        `repo=${repoPath ?? "none"})`,
    };
  }

  // Artifacts found — check if completion was suspiciously fast
  if (durationMs != null && durationMs < FAST_THRESHOLD_MS) {
    return {
      status: "suspicious",
      reason:
        `Fast completion: ${Math.round(durationMs / 1000)}s < ${FAST_THRESHOLD_MS / 1000}s threshold. ` +
        `Artifacts found (${artifactDetail}) but duration is suspicious.`,
    };
  }

  return { status: "valid" };
}

interface TimeCutoff {
  gitSince: string;
  findNewer: string;
  label: string;
}

/** Check a git repo for recent commits or file modifications. */
function checkRepoArtifacts(repoPath: string | null, cutoff: TimeCutoff): { found: boolean; detail: string } {
  if (!repoPath) {
    // No repo path: can't check git. Fall through to broader check.
    return checkAnyRecentFiles(null, cutoff);
  }

  const resolved = repoPath.replace(/^~/, process.env["HOME"] ?? "");
  if (!existsSync(resolved)) {
    return { found: false, detail: `repo not found: ${repoPath}` };
  }

  // 1. Recent git commits (most reliable signal)
  try {
    const commits = execSync(
      `git log --oneline --since="${cutoff.gitSince}" 2>/dev/null`,
      { cwd: resolved, timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (commits.length > 0) {
      const count = commits.split("\n").length;
      return { found: true, detail: `${count} commit(s) ${cutoff.label}` };
    }
  } catch { /* git not available or not a git repo */ }

  // 2. Uncommitted tracked changes (git add but not committed, or dirty working tree)
  //    This check is time-independent — any uncommitted changes count as artifacts
  try {
    const dirty = execSync(
      `git status --porcelain 2>/dev/null`,
      { cwd: resolved, timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (dirty.length > 0) {
      const lineCount = dirty.split("\n").length;
      return { found: true, detail: `${lineCount} uncommitted change(s) in repo` };
    }
  } catch { /* ignore */ }

  // 3. File mtime check: any file touched since the task started
  try {
    const recent = execSync(
      `find . -newermt "${cutoff.findNewer}" -type f -not -path './.git/*' 2>/dev/null | head -5`,
      { cwd: resolved, timeout: 5000, encoding: "utf-8" },
    ).trim();
    if (recent.length > 0) {
      const count = recent.split("\n").length;
      return { found: true, detail: `${count} file(s) modified ${cutoff.label}` };
    }
  } catch { /* ignore */ }

  return { found: false, detail: "no recent git activity or file changes" };
}

/** Check for recently written .md files for writer agents. */
function checkWriterArtifacts(cutoff: TimeCutoff): { found: boolean; detail: string } {
  const home = process.env["HOME"] ?? "";
  const searchPaths = [
    `${home}/lobs-shared-memory/docs`,
    `${home}/lobs-shared-memory`,
    `${home}/apps`,
  ].filter(p => existsSync(p));

  for (const searchPath of searchPaths) {
    try {
      const recent = execSync(
        `find "${searchPath}" -name "*.md" -newermt "${cutoff.findNewer}" -type f 2>/dev/null | head -5`,
        { timeout: 5000, encoding: "utf-8" },
      ).trim();
      if (recent.length > 0) {
        const count = recent.split("\n").length;
        return { found: true, detail: `${count} .md file(s) written in ${searchPath}` };
      }
    } catch { /* ignore */ }
  }

  return { found: false, detail: `no .md files written ${cutoff.label}` };
}

/** Fallback: check for any recently modified files (no specific repo). */
function checkAnyRecentFiles(baseDir: string | null, cutoff: TimeCutoff): { found: boolean; detail: string } {
  const home = process.env["HOME"] ?? "";
  
  // If baseDir is provided, use it directly
  if (baseDir) {
    if (!existsSync(baseDir)) return { found: false, detail: `search dir not found: ${baseDir}` };
    try {
      const recent = execSync(
        `find "${baseDir}" -newermt "${cutoff.findNewer}" -type f -not -path '*/.git/*' 2>/dev/null | head -5`,
        { timeout: 5000, encoding: "utf-8" },
      ).trim();
      if (recent.length > 0) {
        const count = recent.split("\n").length;
        return { found: true, detail: `${count} file(s) modified ${cutoff.label}` };
      }
    } catch { /* ignore */ }
    return { found: false, detail: "no recent file activity found" };
  }

  // No baseDir provided: try a list of known dev directories in order
  const searchDirs = [
    `${home}/lobs`,
    `${home}/paw`,
    `${home}/apps`,
  ].filter(p => existsSync(p));

  for (const searchDir of searchDirs) {
    try {
      const recent = execSync(
        `find "${searchDir}" -newermt "${cutoff.findNewer}" -type f -not -path '*/.git/*' 2>/dev/null | head -5`,
        { timeout: 5000, encoding: "utf-8" },
      ).trim();
      if (recent.length > 0) {
        const count = recent.split("\n").length;
        return { found: true, detail: `${count} file(s) modified ${cutoff.label} (in ${searchDir})` };
      }
    } catch { /* ignore */ }
  }

  return { found: false, detail: `no recent file activity found in known dev directories (${searchDirs.join(", ") || "none found"})` };
}

/**
 * Extract path strings from an expected_artifacts spec (ArtifactSpec[]).
 * Returns empty array if the input is not a valid spec array.
 */
function extractExpectedPaths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const paths: string[] = [];
  for (const spec of raw) {
    if (spec && typeof spec === "object" && typeof (spec as Record<string, unknown>)["path"] === "string") {
      paths.push((spec as Record<string, unknown>)["path"] as string);
    }
  }
  return paths;
}

/**
 * Check that specific expected artifact paths exist on disk.
 * Used for writer tasks that declare expected_artifacts in the task spec.
 */
function checkExpectedArtifactPaths(paths: string[]): { found: boolean; detail: string } {
  const home = process.env["HOME"] ?? "";
  const present: string[] = [];
  const missing: string[] = [];

  for (const p of paths) {
    const resolved = p.replace(/^~/, home);
    if (existsSync(resolved)) {
      present.push(p);
    } else {
      missing.push(p);
    }
  }

  if (missing.length > 0 && present.length === 0) {
    return { found: false, detail: `expected artifacts missing: ${missing.join(", ")}` };
  }
  if (missing.length > 0) {
    // Some present, some missing — treat as found but note partial
    return { found: true, detail: `${present.length}/${paths.length} expected artifacts present; missing: ${missing.join(", ")}` };
  }
  return { found: true, detail: `all ${paths.length} expected artifact(s) present: ${present.join(", ")}` };
}

/**
 * Detect the repos an agent actually worked in by scanning recent session transcripts.
 *
 * Looks at the most recent session for the given agent type, extracts git repo paths
 * from exec commands (git commit, git add, etc.) and Write/Edit tool paths.
 * Returns unique repo root directories.
 *
 * ## Concurrency Deduplication (bug c8cb6459 fix)
 *
 * When multiple tasks run concurrently for the same agent type, a simple
 * `.find()` on mtime-sorted sessions can pick the wrong one. This function uses
 * the following priority order for session selection:
 *
 *  1. **Exact match** — if `sessionKey` is provided (from `worker_runs.child_session_key`),
 *     use that specific file directly. This is the most reliable path.
 *  2. **Deterministic window match** — if multiple sessions fall within the
 *     startedAt ± SESSION_MATCH_WINDOW_MS window, pick the one with the
 *     **smallest session ID** (lexicographic hex sort), not the most-recent mtime.
 *     This is deterministic and avoids race conditions.
 *  3. **Fallback** — use the most-recent session file if nothing else matches.
 *
 * Structured log lines (debug level) document which sessions were considered
 * and why one was chosen, to aid post-mortem diagnosis.
 *
 * WARNING-level logs are emitted for conditions that indicate a possible
 * session matching bug or phantom completion:
 *  - Multiple sessions fall within the time window (concurrency ambiguity)
 *  - Picked session contains no recognisable work patterns (no git commands)
 */
function detectActualWorkingRepos(
  agentType: string,
  startedAt: string | null,
  sessionKey: string | null = null,
): { repos: string[]; sessionStem: string | null; hadActivityPatterns: boolean } {
  const home = process.env["HOME"] ?? "";
  const sessionsDir = `${home}/.lobs/agents/${agentType}/sessions`;
  const prefix = `[psv:session-match] agent=${agentType}`;
  const dbg = (msg: string) => log().debug?.(msg);
  const warn = (msg: string) => log().warn(msg);

  if (!existsSync(sessionsDir)) {
    dbg(`${prefix} sessionsDir not found — skipping: ${sessionsDir}`);
    return { repos: [], sessionStem: null, hadActivityPatterns: false };
  }

  try {
    // Enumerate all .jsonl session files with mtime metadata
    const allFiles = readdirSync(sessionsDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => ({
        name: f,
        stem: f.replace(/\.jsonl$/, ""),
        path: `${sessionsDir}/${f}`,
        mtime: statSync(`${sessionsDir}/${f}`).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime); // most-recent first (for fallback only)

    if (allFiles.length === 0) {
      dbg(`${prefix} no session files found`);
      return { repos: [], sessionStem: null, hadActivityPatterns: false };
    }

    dbg(
      `${prefix} found ${allFiles.length} session file(s). ` +
      `sessionKey=${sessionKey ?? "none"} startedAt=${startedAt ?? "none"}`,
    );
    // Log each candidate with its mtime for post-mortem tracing
    for (const f of allFiles) {
      dbg(`${prefix}   candidate session=${f.stem} mtime=${new Date(f.mtime).toISOString()}`);
    }

    let targetFile: typeof allFiles[0] | undefined;
    let selectionReason = "unset";

    // ── Priority 1: Exact match via sessionKey ─────────────────────────────
    if (sessionKey) {
      const exactMatch = allFiles.find(f => f.stem === sessionKey);
      if (exactMatch) {
        targetFile = exactMatch;
        selectionReason = `exact sessionKey match (${sessionKey}) mtime=${new Date(exactMatch.mtime).toISOString()}`;
      } else {
        dbg(`${prefix} sessionKey=${sessionKey} not found among ${allFiles.length} files — falling back to window match`);
      }
    }

    // ── Priority 2: Deterministic window match ─────────────────────────────
    if (!targetFile && startedAt) {
      const startMs = new Date(startedAt).getTime();
      const windowEnd = startMs + SESSION_MATCH_WINDOW_MS;

      // Collect all sessions whose mtime falls within the expected window
      const windowMatches = allFiles.filter(
        f => f.mtime >= startMs && f.mtime <= windowEnd,
      );

      dbg(
        `${prefix} window [${new Date(startMs).toISOString()} → ${new Date(windowEnd).toISOString()}]: ` +
        `${windowMatches.length} match(es) — [${windowMatches.map(f => f.stem).join(", ")}]`,
      );

      if (windowMatches.length === 1) {
        targetFile = windowMatches[0];
        selectionReason = `sole window match (mtime=${new Date(targetFile.mtime).toISOString()})`;
      } else if (windowMatches.length > 1) {
        // Deterministic tie-break: smallest session ID (lexicographic hex sort).
        // This is stable across concurrent tasks and avoids the race that caused c8cb6459.
        // We do NOT pick the most-recent mtime because that can select a different concurrent task.
        const sorted = [...windowMatches].sort((a, b) => a.stem.localeCompare(b.stem));
        targetFile = sorted[0];
        selectionReason =
          `smallest session ID among ${windowMatches.length} window match(es) ` +
          `(chosen=${targetFile.stem}, others=[${sorted.slice(1).map(f => f.stem).join(", ")}])`;
        // WARNING: multiple sessions in the window is a strong signal of concurrent task ambiguity.
        // If no sessionKey was available to disambiguate, this heuristic may pick the wrong session.
        warn(
          `[psv:session-match:warn] agent=${agentType} ` +
          `MULTIPLE_WINDOW_MATCHES: ${windowMatches.length} sessions in time window — ` +
          `concurrent task ambiguity detected. ` +
          `chosen=${targetFile.stem} (smallest ID, deterministic) ` +
          `discarded=[${sorted.slice(1).map(f => f.stem).join(", ")}] ` +
          `window=[${new Date(startMs).toISOString()} → ${new Date(windowEnd).toISOString()}] ` +
          `sessionKey=${sessionKey ?? "none (provide sessionKey for exact match)"}`,
        );
      }
    }

    // ── Priority 3: Fallback — most recent session ─────────────────────────
    if (!targetFile) {
      targetFile = allFiles[0];
      selectionReason = `fallback (most recent, mtime=${new Date(targetFile.mtime).toISOString()})`;
      if (allFiles.length > 1) {
        dbg(
          `${prefix} using fallback most-recent session (${allFiles.length} candidates). ` +
          `This may be inaccurate for concurrent tasks — provide sessionKey for exact matching.`,
        );
      }
    }

    dbg(`${prefix} selected session=${targetFile.stem} reason=${selectionReason ?? "unknown"}`);

    // Read the session and extract repo paths from tool calls
    const content = readFileSync(targetFile.path, "utf-8");
    const repoPaths = new Set<string>();
    let gitCommandsSeen = 0;
    let writeEditCallsSeen = 0;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = record.toolCalls ?? [];
        for (const tc of toolCalls) {
          // Extract paths from exec commands that reference git
          if (tc.name === "exec" && typeof tc.input?.["command"] === "string") {
            const cmd = tc.input["command"] as string;
            if (cmd.includes("git ")) {
              gitCommandsSeen++;
              // Look for cd /path && git ... or git -C /path ...
              const cdMatch = cmd.match(/cd\s+(\/\S+|~\/\S+)/);
              if (cdMatch) {
                const p = cdMatch[1].replace(/^~/, home);
                repoPaths.add(p);
              }
            }
          }
          // Extract paths from Write/Edit tool calls
          if ((tc.name === "write" || tc.name === "Write" || tc.name === "edit" || tc.name === "Edit")
              && typeof tc.input?.["path"] === "string") {
            writeEditCallsSeen++;
            const filePath = (tc.input["path"] as string).replace(/^~/, home);
            // Walk up to find git root
            try {
              const repoRoot = execSync(`git -C "${filePath.replace(/\/[^/]+$/, "")}" rev-parse --show-toplevel 2>/dev/null`, {
                timeout: 2000,
                encoding: "utf-8",
              }).trim();
              if (repoRoot) repoPaths.add(repoRoot);
            } catch { /* not a git repo */ }
          }
        }
      } catch { /* skip unparseable lines */ }
    }

    const hadActivityPatterns = gitCommandsSeen > 0 || writeEditCallsSeen > 0;

    dbg(
      `${prefix} session=${targetFile.stem} content analysis: ` +
      `gitCmds=${gitCommandsSeen} writeEditCalls=${writeEditCallsSeen} ` +
      `reposFound=${repoPaths.size}`,
    );

    if (repoPaths.size > 0) {
      dbg(`${prefix} repos detected from session ${targetFile.stem}: [${[...repoPaths].join(", ")}]`);
    } else {
      dbg(`${prefix} no repos detected from session ${targetFile.stem}`);
    }

    // WARNING: if the selected session has no recognisable work patterns, the session
    // matching may have picked the wrong file (e.g., a stale session from a prior run).
    if (!hadActivityPatterns) {
      warn(
        `[psv:session-match:warn] agent=${agentType} ` +
        `NO_ACTIVITY_PATTERNS in session=${targetFile.stem} ` +
        `(gitCmds=0, writeEditCalls=0, mtime=${new Date(targetFile.mtime).toISOString()}) — ` +
        `session may be empty or wrong session was selected. ` +
        `selectionReason=${selectionReason ?? "unknown"}`,
      );
    }

    return { repos: [...repoPaths], sessionStem: targetFile.stem, hadActivityPatterns };
  } catch (err) {
    dbg(`${prefix} error scanning sessions: ${err}`);
    return { repos: [], sessionStem: null, hadActivityPatterns: false };
  }
}
