import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error } from "./index.js";

// Tiles are a UI concept — stub responses
export async function handleTilesRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId?: string,
  parts: string[] = [],
): Promise<void> {
  const tileId = parts[2];

  if (!projectId) return error(res, "projectId required", 400);

  if (tileId) {
    return json(res, { id: tileId, project_id: projectId, type: "stub", data: {} });
  }

  return json(res, { tiles: [], project_id: projectId });
}
