import { parentPort, workerData } from "node:worker_threads";
import { initDb, closeDb } from "./db.js";
import { initEmbedder } from "./embedder.js";
import { startIndexer, stopIndexer, reindexAll, pauseIndexing, resumeIndexing, getIndexerStatus } from "./indexer.js";
import type { MemoryConfig } from "./types.js";

interface WorkerInput {
  config: MemoryConfig;
  dbPath: string;
}

interface WorkerCommand {
  requestId: number;
  type: "pause" | "resume" | "reindex" | "status" | "shutdown";
}

const { config, dbPath } = workerData as WorkerInput;

if (!parentPort) {
  throw new Error("Indexer worker must be started as a worker thread");
}

let statusTimer: ReturnType<typeof setInterval> | null = null;

function postStatus(): void {
  parentPort?.postMessage({
    type: "status",
    status: getIndexerStatus(),
  });
}

async function handleCommand(command: WorkerCommand): Promise<void> {
  try {
    switch (command.type) {
      case "pause":
        pauseIndexing();
        break;
      case "resume":
        await resumeIndexing();
        break;
      case "reindex":
        await reindexAll();
        break;
      case "status":
        break;
      case "shutdown":
        if (statusTimer) {
          clearInterval(statusTimer);
          statusTimer = null;
        }
        await stopIndexer();
        closeDb();
        break;
      default: {
        const _exhaustive: never = command.type;
        throw new Error(`Unsupported command: ${_exhaustive}`);
      }
    }

    postStatus();
    parentPort?.postMessage({ type: "response", requestId: command.requestId, ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ type: "error", error: message });
    parentPort?.postMessage({ type: "response", requestId: command.requestId, ok: false, error: message });
  }
}

async function main(): Promise<void> {
  initDb(dbPath);
  initEmbedder(config);

  parentPort?.on("message", (command: WorkerCommand) => {
    void handleCommand(command);
  });

  statusTimer = setInterval(postStatus, 5000);

  try {
    await startIndexer(config);
    postStatus();
    parentPort?.postMessage({ type: "ready" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ type: "error", error: message });
    throw err;
  }
}

void main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  parentPort?.postMessage({ type: "error", error: message });
  process.exitCode = 1;
});
