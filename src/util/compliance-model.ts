/**
 * Compliance model classifier.
 *
 * Determines whether a given model identifier is a local (compliance-safe)
 * or cloud (non-compliant) model. Used to enforce the bifurcated memory
 * system: compliant memories may only be injected into local model sessions.
 *
 * "Local" = running on the user's machine; safe for FERPA, HIPAA, SOC 2 data.
 * "Cloud" = any third-party API; must NOT receive compliant memories.
 */

/** Model prefixes/substrings that indicate a local model. */
const LOCAL_MODEL_PREFIXES = [
  "local/",
  "ollama/",
  "ollama:",
  "llamacpp/",
  "llama.cpp/",
  "lmstudio/",
  "lm-studio/",
  "lm_studio/",
  "localai/",
  "local-ai/",
  "jan/",
  "kobold/",
  "text-generation-webui/",
];

/** Known cloud AI providers (lowercased). */
const CLOUD_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "deepmind",
  "mistral",
  "cohere",
  "azure",
  "aws",
  "bedrock",
  "groq",
  "together",
  "perplexity",
  "replicate",
  "fireworks",
  "deepseek",
  "xai",
  "x-ai",
]);

/**
 * Returns true if the model identifier refers to a local (on-device) model.
 * Local models are safe to receive compliant (sensitive) memory context.
 */
export function isLocalModel(model: string): boolean {
  const lower = model.toLowerCase();
  if (LOCAL_MODEL_PREFIXES.some(p => lower.startsWith(p))) return true;
  // "local" as standalone prefix (e.g., "local/llama3")
  if (lower === "local") return true;
  return false;
}

/**
 * Returns true if the model is a cloud-hosted API model.
 * Cloud models must NOT receive compliant memory context.
 */
export function isCloudModel(model: string): boolean {
  return !isLocalModel(model);
}

/**
 * Returns true if the model is an acceptable compliance model.
 * A compliance model is either:
 *  - A local model (by prefix), OR
 *  - The explicitly configured compliance model from orchestrator settings
 *
 * @param model                  Model identifier string
 * @param configuredCompliance   The 'compliance_model' setting value (optional)
 */
export function isComplianceModel(model: string, configuredCompliance?: string | null): boolean {
  if (isLocalModel(model)) return true;
  // Allow a configured compliance model only if it is NOT a known cloud provider.
  // This prevents accidentally designating an Anthropic/OpenAI/etc. model as
  // "compliance-safe" even when it is explicitly set in the config.
  if (configuredCompliance && model === configuredCompliance) {
    const provider = extractProvider(model);
    if (!isCloudProvider(provider)) return true;
  }
  return false;
}

/**
 * Extract the provider prefix from a model identifier.
 * E.g., "anthropic/claude-sonnet-4-6" → "anthropic"
 *       "ollama/llama3" → "ollama"
 *       "lmstudio/local" → "lmstudio"
 */
export function extractProvider(model: string): string {
  const slash = model.indexOf("/");
  if (slash > 0) return model.slice(0, slash).toLowerCase();
  return model.toLowerCase();
}

/**
 * Returns true if the provider is a known cloud provider.
 */
export function isCloudProvider(provider: string): boolean {
  return CLOUD_PROVIDERS.has(provider.toLowerCase());
}
