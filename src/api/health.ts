import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { json } from "./index.js";

const HOME = process.env.HOME ?? "";
const PID_FILE = resolve(HOME, ".lobs/lobs.pid");

async function checkMemoryServer(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:7420/health", { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkLmStudio(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function checkDb(): boolean {
  const dbPath = resolve(HOME, ".lobs/lobs.db");
  return existsSync(dbPath);
}

function getPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export async function handleHealthRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [memoryServer, lmStudio] = await Promise.all([
    checkMemoryServer(),
    checkLmStudio(),
  ]);

  const db = checkDb();
  const pid = getPid();

  const status = db ? "healthy" : "unhealthy";

  json(res, {
    status,
    uptime: process.uptime(),
    pid: pid ?? process.pid,
    db: db ? "ok" : "error",
    memory_server: memoryServer ? "ok" : "down",
    lm_studio: lmStudio ? "ok" : "down",
  });
}
