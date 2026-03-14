/**
 * BERT-small ONNX worker thread for compliance scanning.
 *
 * This module runs as a worker_thread (spawned by compliance-scanner.ts).
 * It loads the gravitee-io/bert-small-pii-detection ONNX model from the
 * local model cache and performs token classification (NER) inference.
 *
 * Model location (resolved in order):
 *   1. SAIL_BERT_MODEL_PATH env variable
 *   2. ~/.lobs/models/bert-small-pii/model.onnx
 *   3. /opt/sail/models/bert-small-pii/model.onnx  (Docker path)
 *
 * If the model file is missing, the worker sends { sensitive: false, error }
 * and exits cleanly — the caller falls back to Presidio-only mode.
 *
 * Build note: This file is compiled to dist/util/compliance-scanner-worker.js
 * and loaded via worker_threads from compliance-scanner.js at runtime.
 *
 * @see src/util/compliance-scanner.ts
 * @see https://huggingface.co/gravitee-io/bert-small-pii-detection
 * @see https://www.npmjs.com/package/onnxruntime-node
 */

import { workerData, parentPort } from "node:worker_threads";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface WorkerInput {
  text: string;
}

interface WorkerOutput {
  sensitive: boolean;
  entities: string[];
  confidence: number;
  error?: string;
}

/** BERT NER label map (IOB2 format). */
const LABEL_MAP: Record<number, string> = {
  0: "O",           // Outside — not an entity
  1: "B-PERSON",
  2: "I-PERSON",
  3: "B-CREDIT_CARD",
  4: "I-CREDIT_CARD",
  5: "B-EMAIL_ADDRESS",
  6: "I-EMAIL_ADDRESS",
  7: "B-PHONE_NUMBER",
  8: "I-PHONE_NUMBER",
  9: "B-US_SSN",
  10: "I-US_SSN",
  11: "B-US_BANK_NUMBER",
  12: "I-US_BANK_NUMBER",
  13: "B-IBAN_CODE",
  14: "I-IBAN_CODE",
  15: "B-IP_ADDRESS",
  16: "I-IP_ADDRESS",
  17: "B-MEDICAL_LICENSE",
  18: "I-MEDICAL_LICENSE",
};

/** Confidence threshold above which a token is considered an entity. */
const CONFIDENCE_THRESHOLD = 0.75;

// ─────────────────────────────────────────────────────────────────────────────
// Model path resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveModelPath(): string | null {
  const candidates = [
    process.env.SAIL_BERT_MODEL_PATH,
    join(process.env.HOME ?? "/root", ".lobs", "models", "bert-small-pii", "model.onnx"),
    "/opt/sail/models/bert-small-pii/model.onnx",
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveVocabPath(modelPath: string): string | null {
  const vocabPath = modelPath.replace(/model\.onnx$/, "vocab.txt");
  return existsSync(vocabPath) ? vocabPath : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal BERT tokenizer (whitespace + basic WordPiece stubs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Very minimal BERT tokenizer for the purpose of PII detection.
 * Uses character-level splitting on punctuation + whitespace, which is
 * sufficient for entity boundary detection in English text.
 *
 * For production accuracy, replace with the full WordPiece tokenizer
 * using the model's vocab.txt, or use @huggingface/transformers pipeline.
 */
function tokenize(text: string, vocab: Map<string, number>): {
  inputIds: number[];
  attentionMask: number[];
  tokenTypeIds: number[];
} {
  const CLS = vocab.get("[CLS]") ?? 101;
  const SEP = vocab.get("[SEP]") ?? 102;
  const UNK = vocab.get("[UNK]") ?? 100;
  const PAD = vocab.get("[PAD]") ?? 0;
  const MAX_LEN = 128;

  // Basic whitespace + punctuation split
  const rawTokens = text
    .toLowerCase()
    .split(/(\s+|[^\w\s])/)
    .map(t => t.trim())
    .filter(t => t.length > 0);

  const wordpieceTokens: number[] = [CLS];
  for (const token of rawTokens) {
    if (wordpieceTokens.length >= MAX_LEN - 1) break;
    wordpieceTokens.push(vocab.get(token) ?? UNK);
  }
  wordpieceTokens.push(SEP);

  // Pad to MAX_LEN
  const inputIds = [...wordpieceTokens];
  const attentionMask = new Array<number>(inputIds.length).fill(1);
  while (inputIds.length < MAX_LEN) {
    inputIds.push(PAD);
    attentionMask.push(0);
  }
  const tokenTypeIds = new Array<number>(MAX_LEN).fill(0);

  return { inputIds, attentionMask, tokenTypeIds };
}

/**
 * Load vocab.txt into a Map<token, id>.
 * Falls back to empty map (all tokens → UNK) if vocab is missing.
 */
async function loadVocab(vocabPath: string | null): Promise<Map<string, number>> {
  if (!vocabPath) return new Map();
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(vocabPath, "utf-8");
  const vocab = new Map<string, number>();
  raw.split("\n").forEach((line, idx) => {
    const token = line.trim();
    if (token) vocab.set(token, idx);
  });
  return vocab;
}

// ─────────────────────────────────────────────────────────────────────────────
// ONNX inference
// ─────────────────────────────────────────────────────────────────────────────

async function runInference(text: string, modelPath: string): Promise<WorkerOutput> {
  // Dynamic import — allows the worker to fail gracefully if onnxruntime-node
  // is not installed, instead of crashing the entire Node.js process.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ort: any;
  try {
    // @ts-ignore — onnxruntime-node is an optional peer dep; may not be installed
    ort = await import("onnxruntime-node");
  } catch {
    return {
      sensitive: false,
      entities: [],
      confidence: 1.0,
      error: "onnxruntime-node not installed — BERT tier unavailable",
    };
  }

  const vocabPath = resolveVocabPath(modelPath);
  const vocab = await loadVocab(vocabPath);

  const { inputIds, attentionMask, tokenTypeIds } = tokenize(text, vocab);
  const MAX_LEN = 128;

  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });

  // Build input tensors (BigInt64Array for token IDs as required by BERT)
  const toTensor = (arr: number[], name: string) =>
    new ort.Tensor("int64", BigInt64Array.from(arr.map(BigInt)), [1, MAX_LEN]);

  const inputs = {
    input_ids:      toTensor(inputIds, "input_ids"),
    attention_mask: toTensor(attentionMask, "attention_mask"),
    token_type_ids: toTensor(tokenTypeIds, "token_type_ids"),
  };

  const output = await session.run(inputs);

  // Logits shape: [1, seq_len, num_labels]
  // Apply softmax per position; extract argmax label + confidence
  const logitsTensor = output["logits"] ?? Object.values(output)[0];
  const logits = logitsTensor.data as Float32Array;
  const numLabels = Object.keys(LABEL_MAP).length;
  const seqLen = MAX_LEN;

  const detectedEntities = new Set<string>();
  let maxEntityConf = 0;

  for (let pos = 0; pos < seqLen; pos++) {
    const attMask = attentionMask[pos];
    if (!attMask) continue; // skip padding

    const offset = pos * numLabels;
    const posLogits = Array.from(logits.slice(offset, offset + numLabels));

    // Softmax
    const maxLogit = Math.max(...posLogits);
    const exps = posLogits.map(l => Math.exp(l - maxLogit));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map(e => e / sumExps);

    const predLabel = probs.indexOf(Math.max(...probs));
    const conf = probs[predLabel];

    if (predLabel !== 0 && conf >= CONFIDENCE_THRESHOLD) {
      // Strip B-/I- prefix to get entity type
      const rawLabel = LABEL_MAP[predLabel] ?? "UNKNOWN";
      const entityType = rawLabel.replace(/^[BI]-/, "");
      detectedEntities.add(entityType);
      if (conf > maxEntityConf) maxEntityConf = conf;
    }
  }

  const entities = Array.from(detectedEntities) as WorkerOutput["entities"];
  return {
    sensitive: entities.length > 0,
    entities,
    confidence: entities.length > 0 ? maxEntityConf : 1.0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!parentPort) {
    console.error("[BERT worker] No parentPort — must be run as worker_thread");
    process.exit(1);
  }

  const { text } = (workerData as WorkerInput);

  const modelPath = resolveModelPath();
  if (!modelPath) {
    parentPort.postMessage({
      sensitive: false,
      entities: [],
      confidence: 1.0,
      error: "BERT model not found — set SAIL_BERT_MODEL_PATH or download to ~/.lobs/models/bert-small-pii/model.onnx",
    } satisfies WorkerOutput);
    return;
  }

  try {
    const result = await runInference(text, modelPath);
    parentPort.postMessage(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parentPort.postMessage({
      sensitive: false,
      entities: [],
      confidence: 1.0,
      error: `BERT inference error: ${msg}`,
    } satisfies WorkerOutput);
  }
}

void main();
