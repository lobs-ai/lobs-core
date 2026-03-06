/**
 * Memories API
 *
 * Provides read/write access to agent memory files, including:
 * - Basic CRUD stubs for legacy MC compatibility
 * - Compliance tagging: update frontmatter `compliance_required` flag
 * - Compliance moving: move files between `memory/` and `memory-compliant/`
 *
 * Part of the bifurcated memory compliance system.
 * @see docs/decisions/ADR-bifurcated-memory-compliance.md
 * @see src/api/memories-fs.ts (read-only FS access + compliance summary)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { json, error, parseBody, parseQuery } from "./index.js";
import { parseMemoryFrontmatter, stripFrontmatter } from "../util/memory-frontmatter.js";
import { scanNow } from "../services/memory-scanner.js";
import { log } from "../util/logger.js";

const WORKSPACE_BASE = join(process.env.HOME || "/Users/lobs", ".openclaw");
const VALID_AGENTS = new Set(["programmer", "writer", "researcher", "reviewer", "architect"]);
type MemDir = "memory" | "memory-compliant";

/** Validate agent name */
function validateAgent(agent: unknown): agent is string {
  return typeof agent === "string" && VALID_AGENTS.has(agent);
}

/** Validate directory name */
function validateDir(dir: unknown): dir is MemDir {
  return dir === "memory" || dir === "memory-compliant";
}

/** Safe filename: no path traversal */
function validateFilename(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.includes("/") || name.includes("..")) return false;
  return name.endsWith(".md") || name.endsWith(".txt");
}

/**
 * Update a memory file's frontmatter to set/clear `compliance_required`.
 * Rewrites the file in-place; triggers a scanner refresh.
 *
 * POST /api/memories/tag
 * Body: { agent, filename, directory, complianceRequired: boolean }
 */
async function handleTag(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return error(res, "Method not allowed", 405);

  const body = await parseBody(req) as Record<string, unknown>;
  const { agent, filename, directory = "memory", complianceRequired } = body;

  if (!validateAgent(agent)) return error(res, "Invalid agent", 400);
  if (!validateFilename(filename)) return error(res, "Invalid filename", 400);
  if (!validateDir(directory)) return error(res, "Invalid directory (must be 'memory' or 'memory-compliant')", 400);
  if (typeof complianceRequired !== "boolean") return error(res, "complianceRequired must be boolean", 400);

  const filePath = join(WORKSPACE_BASE, `workspace-${agent}`, directory as string, filename as string);

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return error(res, `Memory file not found: ${agent}/${directory}/${filename}`, 404);
  }

  // Strip existing frontmatter and rebuild
  const bodyContent = stripFrontmatter(content).trimStart();
  const { tags } = parseMemoryFrontmatter(content);

  const tagList = tags.length > 0 ? `[${tags.join(", ")}]` : "[]";
  const newFrontmatter = `---\ncompliance_required: ${complianceRequired}\ntags: ${tagList}\n---\n`;
  const newContent = newFrontmatter + bodyContent;

  try {
    await writeFile(filePath, newContent, "utf-8");
  } catch (err) {
    return error(res, `Failed to write file: ${String(err)}`, 500);
  }

  // Re-scan so the index reflects the change
  scanNow().catch(e => log().warn?.(`[memories/tag] Scanner refresh failed: ${e}`));

  log().info?.(`[memories] Tagged ${agent}/${directory}/${filename} compliance_required=${complianceRequired}`);
  return json(res, {
    ok: true,
    agent,
    filename,
    directory,
    complianceRequired,
    message: `compliance_required set to ${complianceRequired}`,
  });
}

/**
 * Move a memory file between `memory/` and `memory-compliant/`.
 * Triggers a scanner refresh.
 *
 * POST /api/memories/move
 * Body: { agent, filename, fromDir, toDir }
 */
async function handleMove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return error(res, "Method not allowed", 405);

  const body = await parseBody(req) as Record<string, unknown>;
  const { agent, filename, fromDir, toDir } = body;

  if (!validateAgent(agent)) return error(res, "Invalid agent", 400);
  if (!validateFilename(filename)) return error(res, "Invalid filename", 400);
  if (!validateDir(fromDir)) return error(res, "Invalid fromDir", 400);
  if (!validateDir(toDir)) return error(res, "Invalid toDir", 400);
  if (fromDir === toDir) return error(res, "fromDir and toDir must be different", 400);

  const srcPath = join(WORKSPACE_BASE, `workspace-${agent}`, fromDir as string, filename as string);
  const dstPath = join(WORKSPACE_BASE, `workspace-${agent}`, toDir as string, filename as string);

  // Verify source exists
  try {
    await stat(srcPath);
  } catch {
    return error(res, `Source file not found: ${agent}/${fromDir}/${filename}`, 404);
  }

  try {
    await rename(srcPath, dstPath);
  } catch (err) {
    return error(res, `Failed to move file: ${String(err)}`, 500);
  }

  // Re-scan so the index reflects the change
  scanNow().catch(e => log().warn?.(`[memories/move] Scanner refresh failed: ${e}`));

  log().info?.(`[memories] Moved ${agent}/${fromDir}/${filename} → ${toDir}`);
  return json(res, {
    ok: true,
    agent,
    filename,
    fromDir,
    toDir,
    message: `Moved to ${toDir}/${filename}`,
  });
}

/**
 * PATCH /api/memories/:agent/:filename/compliance
 * Body: { complianceRequired: boolean }
 *
 * Convenience endpoint: update frontmatter compliance flag by agent + filename.
 * Scans both `memory/` and `memory-compliant/` to find the file.
 */
async function handlePatchCompliance(
  req: IncomingMessage,
  res: ServerResponse,
  agent: string,
  filename: string,
): Promise<void> {
  if (req.method !== "PATCH") return error(res, "Method not allowed", 405);

  if (!validateAgent(agent)) return error(res, "Invalid agent", 400);
  if (!validateFilename(filename)) return error(res, "Invalid filename", 400);

  const body = await parseBody(req) as Record<string, unknown>;
  const { complianceRequired } = body;
  if (typeof complianceRequired !== "boolean") return error(res, "complianceRequired must be boolean", 400);

  // Find the file in either directory
  let foundPath: string | null = null;
  let foundDir: MemDir | null = null;
  for (const dir of ["memory", "memory-compliant"] as MemDir[]) {
    const p = join(WORKSPACE_BASE, `workspace-${agent}`, dir, filename);
    try {
      await stat(p);
      foundPath = p;
      foundDir = dir;
      break;
    } catch {}
  }

  if (!foundPath || !foundDir) {
    return error(res, `Memory file not found for agent '${agent}': ${filename}`, 404);
  }

  let content: string;
  try {
    content = await readFile(foundPath, "utf-8");
  } catch {
    return error(res, "Failed to read memory file", 500);
  }

  const bodyContent = stripFrontmatter(content).trimStart();
  const { tags } = parseMemoryFrontmatter(content);
  const tagList = tags.length > 0 ? `[${tags.join(", ")}]` : "[]";
  const newFrontmatter = `---\ncompliance_required: ${complianceRequired}\ntags: ${tagList}\n---\n`;

  try {
    await writeFile(foundPath, newFrontmatter + bodyContent, "utf-8");
  } catch (err) {
    return error(res, `Failed to write file: ${String(err)}`, 500);
  }

  scanNow().catch(e => log().warn?.(`[memories/compliance] Scanner refresh failed: ${e}`));
  log().info?.(`[memories] PATCH compliance ${agent}/${foundDir}/${filename} → ${complianceRequired}`);

  return json(res, {
    ok: true,
    agent,
    filename,
    directory: foundDir,
    complianceRequired,
  });
}

export async function handleMemoriesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  parts: string[] = [],
): Promise<void> {
  const sub = id; // /api/memories/:sub

  // ── Compliance tagging ──────────────────────────────────────────────
  if (sub === "tag") return handleTag(req, res);
  if (sub === "move") return handleMove(req, res);

  // ── PATCH /api/memories/:agent/:filename/compliance ─────────────────
  // parts = ["memories", agent, filename, "compliance"]
  if (parts.length >= 4 && parts[3] === "compliance") {
    const agent = parts[1];
    const filename = parts[2];
    if (validateAgent(agent) && validateFilename(filename)) {
      return handlePatchCompliance(req, res, agent, filename);
    }
  }

  // ── Legacy stubs ────────────────────────────────────────────────────
  if (sub === "search") {
    const q = parseQuery(req.url ?? "");
    return json(res, { results: [], query: q.q ?? "" });
  }

  if (sub === "agents") {
    return json(res, { agents: Array.from(VALID_AGENTS) });
  }

  if (sub === "capture" && req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    return json(res, { captured: true, id: `mem_${Date.now()}`, content: body.content ?? null });
  }

  if (sub) {
    return json(res, { id: sub, content: null });
  }

  if (req.method === "GET") {
    return json(res, []);
  }

  return error(res, "Method not allowed", 405);
}
