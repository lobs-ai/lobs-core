import { extract, isLocalModelAvailable } from "../runner/local-classifier.js";

export interface ExtractionFieldSpec {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  required?: boolean;
  enum?: string[];
}

export interface DataTransformSpec {
  rename?: Record<string, string>;
  defaults?: Record<string, unknown>;
  trimStrings?: boolean;
  dropEmptyStrings?: boolean;
}

export interface StructuredExtractionRequest {
  text: string;
  schema: Record<string, ExtractionFieldSpec>;
  instructions?: string;
  transform?: DataTransformSpec;
}

export interface StructuredExtractionResult<T> {
  data: T | null;
  localModelUsed: boolean;
  error?: string;
}

interface ExtractionDeps {
  extractor: typeof extract;
  isAvailable: typeof isLocalModelAvailable;
}

const DEFAULT_DEPS: ExtractionDeps = {
  extractor: extract,
  isAvailable: isLocalModelAvailable,
};

function describeField(name: string, spec: ExtractionFieldSpec): string {
  const parts: string[] = [spec.type];
  if (spec.required) parts.push("required");
  if (spec.enum?.length) parts.push(`allowed: ${spec.enum.join(" | ")}`);
  if (spec.description) parts.push(spec.description);
  return `"${name}": ${parts.join(", ")}`;
}

export function buildExtractionSchemaPrompt(schema: Record<string, ExtractionFieldSpec>): string {
  return `{
${Object.entries(schema).map(([name, spec]) => `  ${describeField(name, spec)}`).join(",\n")}
}`;
}

export function applyDataTransform<T extends object>(
  data: T,
  transform?: DataTransformSpec,
): T {
  if (!transform) return { ...data };

  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const nextKey = transform.rename?.[key] ?? key;
    renamed[nextKey] = value;
  }

  if (transform.defaults) {
    for (const [key, value] of Object.entries(transform.defaults)) {
      if (!(key in renamed) || renamed[key] === null || renamed[key] === undefined) {
        renamed[key] = value;
      }
    }
  }

  if (transform.trimStrings || transform.dropEmptyStrings) {
    for (const [key, value] of Object.entries(renamed)) {
      if (typeof value !== "string") continue;
      const nextValue = transform.trimStrings ? value.trim() : value;
      if (transform.dropEmptyStrings && nextValue === "") {
        delete renamed[key];
        continue;
      }
      renamed[key] = nextValue;
    }
  }

  return renamed as T;
}

export async function extractStructuredData<T extends object>(
  request: StructuredExtractionRequest,
  deps: Partial<ExtractionDeps> = {},
): Promise<StructuredExtractionResult<T>> {
  const resolved: ExtractionDeps = {
    extractor: deps.extractor ?? DEFAULT_DEPS.extractor,
    isAvailable: deps.isAvailable ?? DEFAULT_DEPS.isAvailable,
  };

  if (!request.text.trim()) {
    return { data: null, localModelUsed: false, error: "text required" };
  }

  if (!Object.keys(request.schema).length) {
    return { data: null, localModelUsed: false, error: "schema required" };
  }

  if (!await resolved.isAvailable()) {
    return { data: null, localModelUsed: false, error: "local model unavailable" };
  }

  const schemaPrompt = buildExtractionSchemaPrompt(request.schema);
  const instructions = request.instructions?.trim()
    ? `${request.instructions.trim()}\n\n`
    : "";

  const extracted = await resolved.extractor<Record<string, unknown>>(
    `${instructions}Extract only the fields defined in the schema. Omit unsupported guesses.\n\n${request.text}`,
    schemaPrompt,
  );

  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) {
    return { data: null, localModelUsed: true, error: "extraction failed" };
  }

  return {
    data: applyDataTransform(extracted as T, request.transform),
    localModelUsed: true,
  };
}
