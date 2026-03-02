import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error } from "./index.js";

export async function handleRoutingRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
  if (!sub || sub === "policy") {
    // Stub routing policy
    return json(res, {
      policy: "round-robin",
      providers: ["anthropic", "openai"],
      fallback_enabled: true,
      timestamp: new Date().toISOString(),
    });
  }
  return error(res, "Unknown routing endpoint", 404);
}
