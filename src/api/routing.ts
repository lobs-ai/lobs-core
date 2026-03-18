import type { IncomingMessage, ServerResponse } from "node:http";
import { triageIncomingItem, type IntakeKind } from "../services/intake-triage.js";
import { json, error, parseBody } from "./index.js";

function inferKind(value: unknown): IntakeKind {
  switch (value) {
    case "task":
    case "email":
    case "notification":
    case "message":
      return value;
    default:
      return "message";
  }
}

export async function handleRoutingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
  if ((!sub || sub === "policy") && req.method === "GET") {
    return json(res, {
      policy: "local-first intake triage",
      routes: {
        defer: "Routine or low-signal items stay out of the expensive model path.",
        local: "Small local model handles classification and lightweight summarization.",
        standard: "Escalate to the default cloud model for meaningful execution work.",
        strong: "Escalate to the strongest model for urgent, risky, or complex items.",
      },
      timestamp: new Date().toISOString(),
    });
  }

  if ((!sub || sub === "classify") && req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.title) return error(res, "title required");

    const triage = await triageIncomingItem({
      kind: inferKind(body.kind),
      title: body.title as string,
      content: (body.content as string) ?? "",
    });

    return json(res, triage);
  }

  return error(res, "Unknown routing endpoint", 404);
}
