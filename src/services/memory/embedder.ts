/**
 * Embedding via LM Studio OpenAI-compatible API
 */

import type { MemoryConfig } from "./types.js";

interface EmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

let config: MemoryConfig | null = null;

export function initEmbedder(cfg: MemoryConfig): void {
  config = cfg;
  console.log(`[memory] Embedder initialized: ${cfg.lmstudio.baseUrl} (${cfg.lmstudio.embeddingModel})`);
}

const QUERY_INSTRUCTION = "Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ";

function isInstructionAware(): boolean {
  return config?.lmstudio.embeddingModel?.toLowerCase().includes("qwen3-embedding") ?? false;
}

export async function embed(text: string): Promise<Float32Array> {
  if (!config) throw new Error("Embedder not initialized");
  const results = await embedBatch([text]);
  return results[0];
}

export async function embedQuery(query: string): Promise<Float32Array> {
  if (!config) throw new Error("Embedder not initialized");
  const text = isInstructionAware() ? `${QUERY_INSTRUCTION}${query}` : query;
  const results = await embedBatch([text]);
  return results[0];
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (!config) throw new Error("Embedder not initialized");
  if (texts.length === 0) return [];

  const url = `${config.lmstudio.baseUrl}/embeddings`;
  const payload = {
    model: config.lmstudio.embeddingModel,
    input: texts,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LM Studio API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as EmbeddingResponse;
    const embeddings: Float32Array[] = new Array(texts.length);
    for (const item of data.data) {
      embeddings[item.index] = new Float32Array(item.embedding);
    }
    return embeddings;
  } catch (err) {
    if (err instanceof Error && err.message.includes("fetch")) {
      throw new Error(`Could not connect to LM Studio at ${config.lmstudio.baseUrl}. Is it running?`);
    }
    throw err;
  }
}

export async function checkEmbedderHealth(): Promise<{ available: boolean; error?: string }> {
  if (!config) return { available: false, error: "Embedder not initialized" };
  try {
    await embed("test");
    return { available: true };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}
