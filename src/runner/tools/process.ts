/**
 * Process tool — background exec management.
 * 
 * Lets agents start long-running commands in the background, poll for completion,
 * read logs, write stdin, and kill processes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../types.js";

interface BackgroundProcess {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  output: string[];         // Line-buffered output
  lastPollOffset: number;   // Track where last poll ended
  maxOutputLines: number;
  process: ChildProcess | null;
  timedOut: boolean;
  timeoutTimer: NodeJS.Timeout | null;
}

const processes = new Map<string, BackgroundProcess>();
const MAX_PROCESSES = 10;
const MAX_OUTPUT_LINES = 5000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const CLEANUP_AGE_MS = 10 * 60 * 1000; // Remove processes that exited >10min ago

// Auto-cleanup old processes
setInterval(() => {
  const now = Date.now();
  for (const [id, proc] of processes.entries()) {
    if (proc.exitCode !== null && now - proc.startedAt > CLEANUP_AGE_MS) {
      processes.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);

export const processToolDefinition: ToolDefinition = {
  name: "process",
  description: `Manage background exec sessions. Use to run long commands (builds, tests, servers) without blocking.

Actions:
- start: Start a command in the background. Returns sessionId.
- poll: Check if a process completed. Returns new output since last poll.
- log: Read output lines (supports offset/limit for large outputs).
- write: Write data to a process's stdin.
- kill: Terminate a background process.
- list: List all active background processes.`,
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "poll", "log", "write", "kill", "list"],
        description: "Action to perform",
      },
      command: {
        type: "string",
        description: "Shell command (for start)",
      },
      cwd: {
        type: "string",
        description: "Working directory (for start)",
      },
      sessionId: {
        type: "string",
        description: "Background process session ID (for poll/log/write/kill)",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds for start (default 1800 = 30min)",
      },
      data: {
        type: "string",
        description: "Data to write to stdin (for write)",
      },
      offset: {
        type: "number",
        description: "Line offset for log (0-indexed, default 0)",
      },
      limit: {
        type: "number",
        description: "Max lines to return for log (default 50)",
      },
    },
    required: ["action"],
  },
};

export async function processTool(
  params: Record<string, unknown>,
  defaultCwd: string,
): Promise<string> {
  const action = params.action as string;

  switch (action) {
    case "start":
      return startProcess(params, defaultCwd);
    case "poll":
      return pollProcess(params);
    case "log":
      return logProcess(params);
    case "write":
      return writeProcess(params);
    case "kill":
      return killProcess(params);
    case "list":
      return listProcesses();
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function startProcess(params: Record<string, unknown>, defaultCwd: string): string {
  const command = params.command as string;
  if (!command || typeof command !== "string") {
    throw new Error("command is required and must be a string");
  }

  // Check process limit (only count running processes)
  const runningCount = Array.from(processes.values()).filter(p => p.exitCode === null).length;
  if (runningCount >= MAX_PROCESSES) {
    throw new Error(`Process limit reached (${MAX_PROCESSES}). Kill or wait for processes to complete.`);
  }

  const cwd = (params.cwd as string) || defaultCwd;
  const timeoutSec = typeof params.timeout === "number" ? params.timeout : 1800;
  const timeoutMs = timeoutSec * 1000;

  const sessionId = randomUUID();
  const bgProc: BackgroundProcess = {
    id: sessionId,
    command,
    cwd,
    startedAt: Date.now(),
    pid: null,
    exitCode: null,
    signal: null,
    output: [],
    lastPollOffset: 0,
    maxOutputLines: MAX_OUTPUT_LINES,
    process: null,
    timedOut: false,
    timeoutTimer: null,
  };

  try {
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    bgProc.process = child;
    bgProc.pid = child.pid ?? null;

    // Set up timeout
    bgProc.timeoutTimer = setTimeout(() => {
      bgProc.timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 200); // 200ms grace before SIGKILL
    }, timeoutMs);

    // Capture output line-buffered
    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (bgProc.output.length < bgProc.maxOutputLines) {
          bgProc.output.push(`[stdout] ${line}`);
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderrBuffer += data.toString();
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() || "";

      for (const line of lines) {
        if (bgProc.output.length < bgProc.maxOutputLines) {
          bgProc.output.push(`[stderr] ${line}`);
        }
      }
    });

    // exit fires immediately when process terminates (before stdio closes)
    child.on("exit", (code, signal) => {
      bgProc.exitCode = code;
      bgProc.signal = signal;
      if (bgProc.timeoutTimer) {
        clearTimeout(bgProc.timeoutTimer);
        bgProc.timeoutTimer = null;
      }
    });

    child.on("close", () => {
      // Flush remaining buffers after stdio streams close
      if (stdoutBuffer && bgProc.output.length < bgProc.maxOutputLines) {
        bgProc.output.push(`[stdout] ${stdoutBuffer}`);
      }
      if (stderrBuffer && bgProc.output.length < bgProc.maxOutputLines) {
        bgProc.output.push(`[stderr] ${stderrBuffer}`);
      }
    });

    child.on("error", (err) => {
      bgProc.output.push(`[error] ${err.message}`);
      bgProc.exitCode = -1;
      if (bgProc.timeoutTimer) {
        clearTimeout(bgProc.timeoutTimer);
        bgProc.timeoutTimer = null;
      }
    });

    processes.set(sessionId, bgProc);

    return JSON.stringify({
      sessionId,
      pid: bgProc.pid,
      status: "running",
      command,
      timeout: timeoutSec,
    }, null, 2);
  } catch (error) {
    throw new Error(`Failed to start process: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pollProcess(params: Record<string, unknown>): string {
  const sessionId = params.sessionId as string;
  if (!sessionId) {
    throw new Error("sessionId is required for poll");
  }

  const bgProc = processes.get(sessionId);
  if (!bgProc) {
    throw new Error(`Process not found: ${sessionId}`);
  }

  const status = bgProc.exitCode !== null ? "exited" : "running";
  const newOutput = bgProc.output.slice(bgProc.lastPollOffset);
  bgProc.lastPollOffset = bgProc.output.length;

  const result: Record<string, unknown> = {
    sessionId,
    status,
    pid: bgProc.pid,
  };

  if (status === "exited") {
    result.exitCode = bgProc.exitCode;
    result.signal = bgProc.signal;
    result.timedOut = bgProc.timedOut;
  }

  if (newOutput.length > 0) {
    result.newOutput = newOutput.join("\n");
  } else {
    result.newOutput = "(no new output)";
  }

  if (bgProc.output.length >= bgProc.maxOutputLines) {
    result.note = `Output buffer full (${bgProc.maxOutputLines} lines). Older lines may be lost.`;
  }

  return JSON.stringify(result, null, 2);
}

function logProcess(params: Record<string, unknown>): string {
  const sessionId = params.sessionId as string;
  if (!sessionId) {
    throw new Error("sessionId is required for log");
  }

  const bgProc = processes.get(sessionId);
  if (!bgProc) {
    throw new Error(`Process not found: ${sessionId}`);
  }

  const offset = typeof params.offset === "number" ? params.offset : 0;
  const limit = typeof params.limit === "number" ? params.limit : 50;

  let lines: string[];
  if (offset < 0) {
    // Negative offset = from end
    lines = bgProc.output.slice(offset);
  } else {
    lines = bgProc.output.slice(offset, offset + limit);
  }

  return JSON.stringify({
    sessionId,
    totalLines: bgProc.output.length,
    offset,
    limit,
    lines,
  }, null, 2);
}

function writeProcess(params: Record<string, unknown>): string {
  const sessionId = params.sessionId as string;
  const data = params.data as string;

  if (!sessionId) {
    throw new Error("sessionId is required for write");
  }
  if (!data) {
    throw new Error("data is required for write");
  }

  const bgProc = processes.get(sessionId);
  if (!bgProc) {
    throw new Error(`Process not found: ${sessionId}`);
  }

  if (bgProc.exitCode !== null) {
    throw new Error("Cannot write to a process that has exited");
  }

  if (!bgProc.process || !bgProc.process.stdin) {
    throw new Error("Process stdin not available");
  }

  try {
    bgProc.process.stdin.write(data);
    return JSON.stringify({
      sessionId,
      status: "success",
      bytesWritten: data.length,
    }, null, 2);
  } catch (error) {
    throw new Error(`Failed to write to stdin: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function killProcess(params: Record<string, unknown>): Promise<string> {
  const sessionId = params.sessionId as string;
  if (!sessionId) {
    throw new Error("sessionId is required for kill");
  }

  const bgProc = processes.get(sessionId);
  if (!bgProc) {
    throw new Error(`Process not found: ${sessionId}`);
  }

  if (bgProc.exitCode !== null) {
    return JSON.stringify({
      sessionId,
      status: "already_exited",
      exitCode: bgProc.exitCode,
    }, null, 2);
  }

  if (!bgProc.process) {
    throw new Error("Process not available");
  }

  // Send SIGTERM, wait 200ms, then SIGKILL if still alive
  bgProc.process.kill("SIGTERM");

  return new Promise<string>((resolve) => {
    const killTimer = setTimeout(() => {
      if (bgProc.process && bgProc.exitCode === null) {
        bgProc.process.kill("SIGKILL");
      }
    }, 200);

    // Wait for process to exit
    const checkInterval = setInterval(() => {
      if (bgProc.exitCode !== null) {
        clearInterval(checkInterval);
        clearTimeout(killTimer);
        resolve(JSON.stringify({
          sessionId,
          status: "killed",
          exitCode: bgProc.exitCode,
          signal: bgProc.signal,
        }, null, 2));
      }
    }, 20);

    // Give up after 500ms — process should have exited by then
    setTimeout(() => {
      clearInterval(checkInterval);
      clearTimeout(killTimer);
      resolve(JSON.stringify({
        sessionId,
        status: "kill_sent",
        note: "Process may still be terminating",
      }, null, 2));
    }, 500);
  });
}

function listProcesses(): string {
  const procs = Array.from(processes.values()).map(p => ({
    sessionId: p.id,
    command: p.command.length > 60 ? p.command.slice(0, 60) + "..." : p.command,
    pid: p.pid,
    status: p.exitCode !== null ? "exited" : "running",
    exitCode: p.exitCode,
    startedAt: new Date(p.startedAt).toISOString(),
    outputLines: p.output.length,
  }));

  return JSON.stringify({
    count: procs.length,
    maxProcesses: MAX_PROCESSES,
    processes: procs,
  }, null, 2);
}
