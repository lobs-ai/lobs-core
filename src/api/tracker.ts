import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "./index.js";

// Tracker is a stub — MC uses it for activity tracking
export async function handleTrackerRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  _parts: string[] = [],
): Promise<void> {
  return json(res, { items: [], timestamp: new Date().toISOString() });
}
