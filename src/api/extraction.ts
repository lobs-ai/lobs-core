import type { IncomingMessage, ServerResponse } from "node:http";
import {
  extractStructuredData,
  type DataTransformSpec,
  type ExtractionFieldSpec,
} from "../services/data-extraction.js";
import { error, json, parseBody } from "./index.js";

function isSchemaRecord(value: unknown): value is Record<string, ExtractionFieldSpec> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) return false;
    const type = (field as Record<string, unknown>).type;
    return ["string", "number", "boolean", "array", "object"].includes(String(type));
  });
}

function isTransformSpec(value: unknown): value is DataTransformSpec {
  return !value || typeof value === "object";
}

export async function handleExtractionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sub?: string,
): Promise<void> {
  if ((!sub || sub === "policy") && req.method === "GET") {
    return json(res, {
      policy: "schema-driven local extraction with optional deterministic transforms",
      purpose: "Pull structured fields from unstructured text without taking follow-up actions.",
      timestamp: new Date().toISOString(),
    });
  }

  if ((!sub || sub === "structured") && req.method === "POST") {
    const body = await parseBody(req) as Record<string, unknown>;
    if (typeof body.text !== "string" || !body.text.trim()) return error(res, "text required");
    if (!isSchemaRecord(body.schema)) return error(res, "valid schema required");
    if (!isTransformSpec(body.transform)) return error(res, "invalid transform");

    const result = await extractStructuredData<Record<string, unknown>>({
      text: body.text,
      schema: body.schema,
      instructions: typeof body.instructions === "string" ? body.instructions : undefined,
      transform: body.transform as DataTransformSpec | undefined,
    });

    if (!result.data) {
      const status = result.error === "local model unavailable" ? 503 : 422;
      return error(res, result.error ?? "extraction failed", status);
    }

    return json(res, {
      data: result.data,
      localModelUsed: result.localModelUsed,
    });
  }

  return error(res, "Unknown extraction endpoint", 404);
}
