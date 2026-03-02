import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error } from "./index.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";

// Documents live in lobs-control state/reports and state/research
const REPORTS_DIR = join(homedir(), "lobs-control", "state", "reports");
const DOCS_DIRS = [
  join(homedir(), "lobs-control", "state", "reports", "delivered"),
  join(homedir(), "lobs-control", "state", "reports", "pending"),
];

function listDocs() {
  const docs: Array<{ id: string; title: string; path: string; type: string; modified_at: string }> = [];
  for (const dir of DOCS_DIRS) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md") && !file.endsWith(".txt")) continue;
      const fullPath = join(dir, file);
      const stat = statSync(fullPath);
      docs.push({
        id: Buffer.from(fullPath).toString("base64url"),
        title: file.replace(/\.(md|txt)$/, ""),
        path: fullPath,
        type: "report",
        modified_at: stat.mtime.toISOString(),
      });
    }
  }
  return docs;
}

export async function handleDocumentsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  parts: string[] = [],
): Promise<void> {
  const sub = parts[2];

  if (id) {
    if (sub === "archive") {
      // Stub: acknowledge
      return json(res, { archived: true, id });
    }
    // Decode id and return content
    try {
      const path = Buffer.from(id, "base64url").toString("utf-8");
      if (existsSync(path)) {
        return json(res, { id, content: readFileSync(path, "utf-8"), path });
      }
    } catch {}
    return error(res, "Not found", 404);
  }

  return json(res, listDocs());
}
