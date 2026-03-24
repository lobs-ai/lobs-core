/**
 * Full search pipeline: BM25 + vector + query expansion + reranking + MMR + temporal decay
 */

import { bm25Search, vectorSearch, getDb, searchByEntity } from "./db.js";
import { embed, embedQuery, checkEmbedderHealth } from "./embedder.js";

let embedderAvailable = false;
let lastEmbedderCheck = 0;
const EMBEDDER_CHECK_INTERVAL = 30_000;

async function isEmbedderUp(): Promise<boolean> {
  const now = Date.now();
  if (now - lastEmbedderCheck > EMBEDDER_CHECK_INTERVAL) {
    const health = await checkEmbedderHealth();
    embedderAvailable = health.available;
    lastEmbedderCheck = now;
  }
  return embedderAvailable;
}

export function resetEmbedderCache(): void {
  lastEmbedderCheck = 0;
  embedderAvailable = false;
}

import { rerankDocuments, isRerankerAvailable } from "./reranker.js";
import { extractSnippet, createCitation } from "./chunker.js";
import { expandQuery, initExpander } from "./expander.js";
import { readFileSync } from "node:fs";
import type { MemoryConfig, SearchRequest, SearchResponse, SearchResult, ScoredChunk, Collection } from "./types.js";
import { parseFile } from "./parsers.js";

let config: MemoryConfig | null = null;

// Simple LRU cache with TTL
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 100;
const searchCache = new Map<string, { result: SearchResponse; timestamp: number }>();

function getCacheKey(request: SearchRequest): string {
  return JSON.stringify({
    q: request.query, c: request.collections, m: request.maxResults, cc: request.conversationContext,
  });
}

function getCached(request: SearchRequest): SearchResponse | null {
  const key = getCacheKey(request);
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(request: SearchRequest, result: SearchResponse): void {
  const key = getCacheKey(request);
  searchCache.set(key, { result, timestamp: Date.now() });
  if (searchCache.size > CACHE_MAX_SIZE) {
    const oldest = searchCache.keys().next().value;
    if (oldest) searchCache.delete(oldest);
  }
}

export function invalidateSearchCache(): void {
  searchCache.clear();
}

export function initSearch(cfg: MemoryConfig): void {
  config = cfg;
  initExpander(cfg);
}

export async function search(request: SearchRequest): Promise<SearchResponse> {
  if (!config) throw new Error("Search not initialized");

  const cached = getCached(request);
  if (cached) {
    const ts = new Date().toISOString().replace("T", " ").split(".")[0];
    console.log(`[${ts}] SEARCH (cached): "${request.query.substring(0, 60)}"`);
    return cached;
  }

  const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];
  const startTime = Date.now();
  const timings: SearchResponse["timings"] = { totalMs: 0, bm25Ms: 0, vectorMs: 0 };

  const maxResults = request.maxResults || config.search.maxResults;
  const candidateCount = maxResults * config.search.candidateMultiplier;

  // Resolve collection aliases
  let resolvedCollections: string[] | undefined;
  if (request.collections && request.collections.length > 0) {
    const systemCollections = new Set(["workspace", "knowledge", "sessions"]);
    const projectCollections = config.collections
      .map((c: Collection) => c.name)
      .filter((n: string) => !systemCollections.has(n));

    const expanded = new Set<string>();
    for (const c of request.collections) {
      if (c === "projects") {
        projectCollections.forEach((pc: string) => expanded.add(pc));
      } else {
        expanded.add(c);
      }
    }
    resolvedCollections = Array.from(expanded);
  }

  // Step 1: BM25 + vector search
  const bm25Start = Date.now();
  const bm25Results = bm25Search(request.query, candidateCount, resolvedCollections);
  timings.bm25Ms = Date.now() - bm25Start;

  const canVector = await isEmbedderUp();
  let vectorResults: Array<{ chunkId: number; distance: number }> = [];
  if (canVector) {
    try {
      const vectorStart = Date.now();
      const queryEmbedding = await embedQuery(request.query);
      vectorResults = vectorSearch(queryEmbedding, candidateCount, resolvedCollections);
      timings.vectorMs = Date.now() - vectorStart;
    } catch {
      embedderAvailable = false;
      lastEmbedderCheck = Date.now();
    }
  }

  let candidates = mergeCandidates(bm25Results, vectorResults);

  // Conversation context biasing
  if (request.conversationContext && canVector && vectorResults.length > 0) {
    try {
      const contextStart = Date.now();
      const contextEmbedding = await embed(request.conversationContext);
      
      candidates = candidates.map(chunk => {
        const db = getDb();
        const embRow = db.prepare("SELECT embedding FROM chunk_embeddings WHERE chunk_id = ?")
          .get(chunk.id!) as { embedding: Buffer } | undefined;
        
        if (embRow) {
          const chunkEmbedding = new Float32Array(embRow.embedding.buffer, embRow.embedding.byteOffset, embRow.embedding.byteLength / 4);
          const contextSim = cosineSimilarity(contextEmbedding, chunkEmbedding);
          const contextScore = (1 - ((1 - contextSim) / 2));
          chunk.score = 0.7 * chunk.score + 0.3 * contextScore;
        }
        return chunk;
      });
      
      candidates.sort((a, b) => b.score - a.score);
      timings.vectorMs += Date.now() - contextStart;
    } catch {
      // Context biasing failed, continue without it
    }
  }

  // Step 2: Query expansion
  let expandedQueries: string[] | undefined;
  if (config.search.queryExpansion.enabled) {
    const expansionStart = Date.now();
    const expansions = await expandQuery(request.query);
    timings.expansionMs = Date.now() - expansionStart;

    if (expansions.length > 0) {
      expandedQueries = expansions.map(e => `${e.type}:${e.text}`);
      expansions.forEach(exp => {
        console.log(`  ${exp.type}: "${exp.text}"`);
      });

      for (const expansion of expansions) {
        if (expansion.type === 'lex') {
          const lexResults = bm25Search(expansion.text, candidateCount, resolvedCollections);
          mergeAdditionalBM25(candidates, lexResults, 0.5);
        } else if (canVector) {
          try {
            const vecStart = Date.now();
            const expEmbedding = await embed(expansion.text);
            const expResults = vectorSearch(expEmbedding, candidateCount, resolvedCollections);
            mergeAdditionalVector(candidates, expResults, 0.5);
            timings.vectorMs += Date.now() - vecStart;
          } catch {
            // Embedder failed, skip
          }
        }
      }
      candidates.sort((a, b) => b.score - a.score);
    }
  }

  // Step 3: Entity filter
  if (request.entityFilter) {
    const matchingChunkIds = new Set(
      searchByEntity(request.entityFilter.type, request.entityFilter.value)
        .map(r => r.chunkId)
    );
    candidates = candidates.filter(c => matchingChunkIds.has(c.id!));
  }

  // Step 4: Collection filter safety net
  if (resolvedCollections && resolvedCollections.length > 0) {
    const collectionSet = new Set(resolvedCollections);
    candidates = candidates.filter(c => collectionSet.has(c.collection));
  }

  // Step 5: Reranking
  if (config.search.reranking.enabled && isRerankerAvailable()) {
    const topCandidates = candidates.slice(0, config.search.reranking.candidateCount);
    const scoreDiff = topCandidates.length >= 2
      ? topCandidates[0].score - topCandidates[1].score
      : 1;
    if (scoreDiff < 0.08) {
      const rerankStart = Date.now();
      candidates = await rerankCandidates(request.query, topCandidates);
      timings.rerankMs = Date.now() - rerankStart;
    } else {
      console.log(`  Reranking skipped (top score dominant: ${topCandidates[0].score.toFixed(3)} vs ${topCandidates[1]?.score.toFixed(3)}, gap=${scoreDiff.toFixed(3)})`);
    }
  }

  // Step 6: Temporal decay
  if (config.search.temporalDecay.enabled) {
    candidates = applyTemporalDecay(candidates);
  }

  // Step 7: MMR diversity
  let results: ScoredChunk[];
  if (config.search.mmr.enabled) {
    results = applyMMR(candidates, maxResults);
  } else {
    results = candidates.slice(0, maxResults);
  }

  // Step 8: Normalize scores
  if (results.length > 0) {
    const maxScore = results[0].score;
    if (maxScore > 1) {
      results = results.map(r => ({ ...r, score: r.score / maxScore }));
    }
  }

  // Step 9: Min score filter
  if (request.minScore !== undefined) {
    results = results.filter(r => r.score >= request.minScore!);
  }

  // Step 10: Build response
  const searchResults: SearchResult[] = results.map(chunk => {
    const fileContent = readFileContent(chunk.path);
    const snippet = extractSnippet(fileContent, chunk.startLine, chunk.endLine);
    const citation = createCitation(chunk.path, chunk.startLine, chunk.endLine);
    return {
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score: chunk.score,
      snippet,
      source: chunk.collection,
      citation,
    };
  });

  timings.totalMs = Date.now() - startTime;

  const parts = [`bm25:${timings.bm25Ms}ms`, `vec:${timings.vectorMs}ms`];
  if (timings.expansionMs !== undefined) parts.push(`expand:${timings.expansionMs}ms`);
  if (timings.rerankMs !== undefined) parts.push(`rerank:${timings.rerankMs}ms`);
  const scopeLabel = resolvedCollections ? ` [${resolvedCollections.join(',')}]` : '';
  console.log(`[${timestamp}] SEARCH "${request.query}"${scopeLabel} → ${searchResults.length} results in ${timings.totalMs}ms (${parts.join(' ')})`);
  searchResults.slice(0, 5).forEach((r, i) => {
    console.log(`  #${i + 1} [${r.score.toFixed(3)}] ${r.citation}`);
  });

  const response: SearchResponse = { results: searchResults, query: request.query, expandedQueries, timings };
  setCache(request, response);
  return response;
}

// ============================================================================
// Candidate merging
// ============================================================================

function mergeCandidates(
  bm25Results: Array<{ id: number; rank: number }>,
  vectorResults: Array<{ chunkId: number; distance: number }>
): ScoredChunk[] {
  if (!config) throw new Error("Search not initialized");

  const db = getDb();
  const candidateMap = new Map<number, ScoredChunk>();

  for (const result of bm25Results) {
    const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.id) as any;
    if (!chunk) continue;
    const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
    if (!doc) continue;

    const bm25Score = Math.exp(result.rank / 10);
    candidateMap.set(result.id, {
      id: result.id, docId: chunk.doc_id, text: chunk.text,
      startLine: chunk.start_line, endLine: chunk.end_line,
      tokenCount: chunk.token_count, path: doc.path,
      collection: doc.collection,
      score: config.search.textWeight * bm25Score, bm25Score,
    });
  }

  for (const result of vectorResults) {
    const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.chunkId) as any;
    if (!chunk) continue;
    const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
    if (!doc) continue;

    const vectorScore = 1 - result.distance / 2;
    const existing = candidateMap.get(result.chunkId);
    if (existing) {
      existing.score += config.search.vectorWeight * vectorScore;
      existing.vectorScore = vectorScore;
    } else {
      candidateMap.set(result.chunkId, {
        id: result.chunkId, docId: chunk.doc_id, text: chunk.text,
        startLine: chunk.start_line, endLine: chunk.end_line,
        tokenCount: chunk.token_count, path: doc.path,
        collection: doc.collection,
        score: config.search.vectorWeight * vectorScore, vectorScore,
      });
    }
  }

  const candidates = Array.from(candidateMap.values());
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function mergeAdditionalBM25(
  candidates: ScoredChunk[],
  bm25Results: Array<{ id: number; rank: number }>,
  weight: number
): void {
  if (!config) return;
  const db = getDb();
  const existingMap = new Map(candidates.map(c => [c.id, c]));

  for (const result of bm25Results) {
    const bm25Score = Math.exp(result.rank / 10);
    const addScore = config.search.textWeight * bm25Score * weight;

    const existing = existingMap.get(result.id);
    if (existing) {
      existing.score += addScore;
    } else {
      const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.id) as any;
      if (!chunk) continue;
      const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
      if (!doc) continue;

      const newChunk: ScoredChunk = {
        id: result.id, docId: chunk.doc_id, text: chunk.text,
        startLine: chunk.start_line, endLine: chunk.end_line,
        tokenCount: chunk.token_count, path: doc.path,
        collection: doc.collection, score: addScore, bm25Score,
      };
      candidates.push(newChunk);
      existingMap.set(result.id, newChunk);
    }
  }
}

function mergeAdditionalVector(
  candidates: ScoredChunk[],
  vectorResults: Array<{ chunkId: number; distance: number }>,
  weight: number
): void {
  if (!config) return;
  const db = getDb();
  const existingMap = new Map(candidates.map(c => [c.id, c]));

  for (const result of vectorResults) {
    const vectorScore = 1 - result.distance / 2;
    const addScore = config.search.vectorWeight * vectorScore * weight;

    const existing = existingMap.get(result.chunkId);
    if (existing) {
      existing.score += addScore;
    } else {
      const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.chunkId) as any;
      if (!chunk) continue;
      const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
      if (!doc) continue;

      const newChunk: ScoredChunk = {
        id: result.chunkId, docId: chunk.doc_id, text: chunk.text,
        startLine: chunk.start_line, endLine: chunk.end_line,
        tokenCount: chunk.token_count, path: doc.path,
        collection: doc.collection, score: addScore, vectorScore,
      };
      candidates.push(newChunk);
      existingMap.set(result.chunkId, newChunk);
    }
  }
}

// ============================================================================
// Post-processing
// ============================================================================

async function rerankCandidates(query: string, candidates: ScoredChunk[]): Promise<ScoredChunk[]> {
  const documents = candidates.map(c => c.text);
  const result = await rerankDocuments(query, documents);

  if (!result) {
    console.log("  Reranker unavailable, skipping");
    return candidates;
  }

  const { scores: rerankScores } = result;
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  const normalizedScores = rerankScores.map(s => sigmoid(s));

  const reranked = candidates.map((chunk, i) => ({
    ...chunk,
    rerankScore: normalizedScores[i],
    score: 0.6 * normalizedScores[i] + 0.4 * chunk.score,
  }));

  reranked.sort((a, b) => b.score - a.score);
  return reranked;
}

function applyTemporalDecay(candidates: ScoredChunk[]): ScoredChunk[] {
  if (!config) throw new Error("Search not initialized");

  const halfLifeDays = config.search.temporalDecay.halfLifeDays;
  const lambda = Math.log(2) / halfLifeDays;
  const now = Date.now();

  return candidates.map(chunk => {
    const dateMatch = chunk.path.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return chunk;

    const fileDate = new Date(dateMatch[1]);
    const ageInDays = (now - fileDate.getTime()) / (1000 * 60 * 60 * 24);
    const decayFactor = Math.exp(-lambda * ageInDays);
    return { ...chunk, score: chunk.score * decayFactor };
  });
}

function applyMMR(candidates: ScoredChunk[], k: number): ScoredChunk[] {
  if (!config) throw new Error("Search not initialized");

  const lambda = config.search.mmr.lambda;
  const selected: ScoredChunk[] = [];
  const remaining = [...candidates];

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevance = candidate.score;

      let maxSimilarity = 0;
      for (const sel of selected) {
        const similarity = jaccardSimilarity(candidate.text, sel.text);
        maxSimilarity = Math.max(maxSimilarity, similarity);
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

function jaccardSimilarity(text1: string, text2: string): number {
  const tokens1 = new Set(text1.toLowerCase().split(/\s+/));
  const tokens2 = new Set(text2.toLowerCase().split(/\s+/));
  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);
  return intersection.size / union.size;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ============================================================================
// File cache
// ============================================================================

const fileCache = new Map<string, string>();

function readFileContent(path: string): string {
  if (fileCache.has(path)) return fileCache.get(path)!;
  try {
    const raw = readFileSync(path, "utf-8");
    let content = raw;
    if (path.endsWith(".jsonl")) {
      content = parseFile(raw, path).text;
    }
    fileCache.set(path, content);
    return content;
  } catch {
    return "";
  }
}

export function clearFileCache(path?: string): void {
  if (path) fileCache.delete(path);
  else fileCache.clear();
}
