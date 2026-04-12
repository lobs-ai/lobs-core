/**
 * GSI Office Hours — Core Answer Engine
 *
 * Pipeline:
 *  1. Search lobs-memory across configured course collections
 *  2. Score/rank results by relevance
 *  3. Call LLM to synthesize answer with citations
 *  4. Compute confidence from retrieval scores + LLM self-assessment
 *  5. Decide: post directly (high confidence) or escalate to human TA
 */

import { log } from "../util/logger.js";
import { createClient, parseModelString } from "../runner/providers.js";
import { getModelForTier } from "../config/models.js";
import type { GsiCourseConfig } from "./gsi-config.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MEMORY_URL = "http://localhost:7420";
const MODEL = "anthropic/claude-haiku-4-5"; // Fast + cheap for high-volume student Qs
const MAX_CONTEXT_CHUNKS = 8;
const MIN_CHUNK_SCORE = 0.40; // discard low-relevance chunks

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GsiSearchResult {
  snippet: string;
  score: number;
  source?: string;
  collection?: string;
}

export interface GsiAnswer {
  /** The drafted answer text, ready to post */
  answer: string;
  /** Confidence 0–1; below course.confidenceThreshold → escalate */
  confidence: number;
  /** Source citations included in the answer */
  citations: string[];
  /** Whether this answer should be escalated to a human TA */
  shouldEscalate: boolean;
  /** Raw retrieval results for logging/debugging */
  retrievalResults: GsiSearchResult[];
  /** The original question */
  question: string;
}

export interface GsiEscalation {
  /** Who asked */
  askedBy: string;
  /** Channel where it was asked */
  channelId: string;
  /** The original question */
  question: string;
  /** The bot's draft answer (may be partial or low-confidence) */
  draftAnswer: string;
  /** Why it was escalated */
  reason: string;
  /** Confidence score */
  confidence: number;
}

// ── Vector Search ─────────────────────────────────────────────────────────────

async function searchCourseKnowledge(
  question: string,
  collections: string[],
  limit = MAX_CONTEXT_CHUNKS
): Promise<GsiSearchResult[]> {
  const body = JSON.stringify({
    query: question,
    maxResults: limit,
    collections,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(`${MEMORY_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      log().warn(`[gsi] Memory search failed: ${res.status}`);
      return [];
    }

    const data = await res.json() as {
      results?: Array<{ text?: string; snippet?: string; score?: number; source?: string; collection?: string }>;
    };

    return (data.results ?? [])
      .map(r => ({
        snippet: String(r.text ?? r.snippet ?? ""),
        score: r.score ?? 0,
        source: r.source,
        collection: r.collection,
      }))
      .filter(r => r.score >= MIN_CHUNK_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name !== "AbortError") {
      log().warn(`[gsi] Vector search error: ${err.message}`);
    }
    return [];
  }
}

// ── LLM Answer Generation ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a knowledgeable teaching assistant for a university computer science course. Your job is to help students by answering their questions accurately and clearly.

You have access to course materials including the syllabus, lecture notes, and past Q&A. Use ONLY the provided context to answer questions — do not invent information.

Rules:
1. Be helpful, clear, and pedagogically sound. Explain concepts, don't just give answers.
2. Cite your sources using [Source: <name>] inline.
3. If the context doesn't have enough information to answer confidently, say so honestly.
4. Keep answers concise but complete — typically 2-5 paragraphs.
5. For programming questions, include code examples when helpful.
6. At the end of your answer, include a JSON block on its own line with this exact format:
   {"confidence": 0.85, "reason": "brief explanation of confidence level"}
   - confidence 0.9+: you have strong, direct source material  
   - confidence 0.7-0.9: you have relevant material but may be extrapolating slightly
   - confidence 0.5-0.7: material is related but question may need human judgment
   - confidence <0.5: insufficient course-specific material to answer well`;

interface LLMAnswerResult {
  answerText: string;
  confidence: number;
  confidenceReason: string;
}

async function generateAnswer(
  question: string,
  context: GsiSearchResult[],
  courseName: string
): Promise<LLMAnswerResult> {
  const contextBlocks = context.map((r, i) => {
    const src = r.source ? ` (${r.source})` : "";
    return `[Context ${i + 1}${src}]\n${r.snippet}`;
  }).join("\n\n");

  const userMessage = `Course: ${courseName}

Course Materials Context:
${contextBlocks || "(No relevant course materials found)"}

Student Question:
${question}

Please answer the student's question using the course materials above. Remember to end with the JSON confidence block.`;

  try {
    const modelStr = MODEL;
    const parsed = parseModelString(modelStr);
    const client = createClient(parsed, "gsi-agent");

    const response = await client.createMessage({
      model: parsed.modelId,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
      tools: [],
      maxTokens: 1500,
    });

    const rawText = response.content
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join("");

    return parseAnswerWithConfidence(rawText);
  } catch (err) {
    log().error(`[gsi] LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      answerText: "I'm having trouble generating an answer right now. Please ask a TA directly.",
      confidence: 0,
      confidenceReason: "LLM error",
    };
  }
}

function parseAnswerWithConfidence(rawText: string): LLMAnswerResult {
  // Extract the JSON confidence block from end of response
  const jsonMatch = rawText.match(/\{"\s*confidence"\s*:\s*([0-9.]+)\s*,\s*"reason"\s*:\s*"([^"]+)"\s*\}/);

  let confidence = 0.5;
  let confidenceReason = "unknown";
  let answerText = rawText.trim();

  if (jsonMatch) {
    confidence = Math.min(1, Math.max(0, parseFloat(jsonMatch[1])));
    confidenceReason = jsonMatch[2];
    // Remove the JSON block from the displayed answer
    answerText = rawText.replace(jsonMatch[0], "").trim();
  }

  return { answerText, confidence, confidenceReason };
}

// ── Citation Extraction ───────────────────────────────────────────────────────

function extractCitations(answerText: string, results: GsiSearchResult[]): string[] {
  const citations = new Set<string>();

  // Extract inline citations from answer text [Source: ...]
  const inlineCites = answerText.matchAll(/\[Source:\s*([^\]]+)\]/gi);
  for (const match of inlineCites) {
    citations.add(match[1].trim());
  }

  // Add source names from top-scoring retrieval results
  for (const r of results.slice(0, 3)) {
    if (r.source) citations.add(r.source);
  }

  return [...citations];
}

// ── Confidence Boost from Retrieval ──────────────────────────────────────────

/**
 * Adjust LLM-reported confidence based on retrieval quality.
 * If we have high-scoring chunks, we can trust the answer more.
 * If we have no chunks, we should be very skeptical.
 */
function blendConfidence(llmConfidence: number, results: GsiSearchResult[]): number {
  if (results.length === 0) return Math.min(llmConfidence, 0.3);

  const topScore = results[0].score;
  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;

  // Retrieval quality modifier: 0.0 to 0.2 bonus based on chunk scores
  const retrievalBonus = (topScore * 0.6 + avgScore * 0.4) * 0.2;

  // Penalty if very few results
  const coveragePenalty = results.length < 2 ? 0.1 : 0;

  return Math.min(1, Math.max(0, llmConfidence + retrievalBonus - coveragePenalty));
}

// ── Main Answer Function ──────────────────────────────────────────────────────

export async function answerStudentQuestion(
  question: string,
  course: GsiCourseConfig
): Promise<GsiAnswer> {
  log().info(`[gsi] Answering question for ${course.courseId}: "${question.slice(0, 80)}..."`);

  // 1. Retrieve relevant course material
  const results = await searchCourseKnowledge(question, course.memoryCollections);

  // 2. Generate answer with LLM
  const { answerText, confidence: llmConfidence, confidenceReason } =
    await generateAnswer(question, results, course.courseName);

  // 3. Blend confidence with retrieval quality
  const confidence = blendConfidence(llmConfidence, results);

  // 4. Extract citations
  const citations = extractCitations(answerText, results);

  // 5. Decide escalation
  const shouldEscalate = confidence < course.confidenceThreshold;

  log().info(`[gsi] Answer generated: confidence=${confidence.toFixed(2)}, escalate=${shouldEscalate}, reason="${confidenceReason}"`);

  return {
    answer: answerText,
    confidence,
    citations,
    shouldEscalate,
    retrievalResults: results,
    question,
  };
}

// ── Format for Discord ────────────────────────────────────────────────────────

/**
 * Format a high-confidence answer for direct Discord posting.
 */
export function formatAnswerForDiscord(answer: GsiAnswer, courseName: string): string {
  const confidence_pct = Math.round(answer.confidence * 100);
  const bar = confidenceBar(answer.confidence);

  const lines: string[] = [
    `📚 **${courseName} — Course Assistant**`,
    "",
    answer.answer,
  ];

  if (answer.citations.length > 0) {
    lines.push("", `📎 **Sources:** ${answer.citations.join(", ")}`);
  }

  lines.push("", `${bar} *Confidence: ${confidence_pct}% — Answer generated from course materials*`);

  return lines.join("\n");
}

/**
 * Format an escalation message for the human TA.
 * Includes the question, draft answer, and confidence info.
 */
export function formatEscalationDM(escalation: GsiEscalation): string {
  const confidence_pct = Math.round(escalation.confidence * 100);
  const lines: string[] = [
    `🎓 **GSI Escalation — Review Needed**`,
    `**Course Channel:** <#${escalation.channelId}>`,
    `**Student:** ${escalation.askedBy}`,
    `**Confidence:** ${confidence_pct}% (below threshold)`,
    `**Reason:** ${escalation.reason}`,
    "",
    `**Question:**`,
    `> ${escalation.question}`,
    "",
    `**Draft Answer (needs review):**`,
    escalation.draftAnswer,
    "",
    `*Reply here to post your answer, or answer directly in the channel.*`,
  ];
  return lines.join("\n");
}

/**
 * Format the "escalated" reply posted to channel to let the student know.
 */
export function formatEscalationChannelReply(askedBy: string, courseName: string): string {
  return [
    `📚 **${courseName} — Course Assistant**`,
    "",
    `Hey ${askedBy}, that's a great question! I'm not fully confident in my answer for this one, so I've flagged it for your TA to review. You should hear back soon!`,
    "",
    `*In the meantime, check the course Piazza or office hours schedule.*`,
  ].join("\n");
}

function confidenceBar(confidence: number): string {
  if (confidence >= 0.85) return "🟢";
  if (confidence >= 0.65) return "🟡";
  return "🔴";
}
