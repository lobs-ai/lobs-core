/**
 * Query expansion — hybrid approach:
 * 1. Template-based expansion (instant, no LLM needed)
 * 2. Optional LLM expansion for complex queries (async, cached)
 */

import type { MemoryConfig } from "./types.js";

export interface ExpandedQuery {
  type: 'lex' | 'vec' | 'hyde';
  text: string;
}

let config: MemoryConfig | null = null;

const llmCache = new Map<string, ExpandedQuery[]>();
const MAX_CACHE_SIZE = 500;

export function initExpander(cfg: MemoryConfig): void {
  config = cfg;
}

export async function expandQuery(query: string): Promise<ExpandedQuery[]> {
  if (!config || !config.search.queryExpansion.enabled) return [];

  const expansions: ExpandedQuery[] = [];
  expansions.push(...templateExpand(query));

  if (shouldUseLLM(query)) {
    const hyde = await generateHyDE(query);
    if (hyde) expansions.push(hyde);
  }

  return expansions;
}

function templateExpand(query: string): ExpandedQuery[] {
  const results: ExpandedQuery[] = [];
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);

  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
    'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'it', 'its', 'my', 'your', 'his', 'her', 'our', 'their', 'me', 'him',
    'us', 'them', 'and', 'but', 'or', 'if', 'about', 'up', 'down',
  ]);

  const contentWords = words.filter(w => !stopWords.has(w) && w.length > 2);

  if (contentWords.length > 0 && contentWords.length < words.length) {
    results.push({ type: 'lex', text: contentWords.join(' ') });
  }

  const synonymExpansion = expandSynonyms(contentWords);
  if (synonymExpansion) {
    results.push({ type: 'lex', text: synonymExpansion });
  }

  return results;
}

function expandSynonyms(words: string[]): string | null {
  const synonymMap: Record<string, string[]> = {
    'pr': ['pull request', 'PR'],
    'prs': ['pull requests', 'PRs'],
    'ci': ['continuous integration', 'CI', 'github actions'],
    'cd': ['continuous deployment', 'CD'],
    'gsi': ['graduate student instructor', 'GSI', 'teaching assistant'],
    'auth': ['authentication', 'authorization', 'OAuth'],
    'oauth': ['OAuth', 'authentication', 'credentials', 'token'],
    'config': ['configuration', 'settings', 'setup'],
    'env': ['environment', 'environment variables'],
    'db': ['database', 'SQLite', 'DB'],
    'api': ['API', 'endpoint', 'REST'],
    'ui': ['user interface', 'UI', 'frontend'],
    'bot': ['agent', 'bot', 'assistant'],
    'lobs': ['Lobs', 'agent', 'assistant'],
    'virt': ['Virt', 'Marcus', 'bot'],
    'paw': ['PAW', 'Personal AI Workforce', 'orchestrator'],
    'nexus': ['Nexus', 'dashboard', 'web UI'],
    'discord': ['Discord', 'chat', 'messaging'],
    'cron': ['cron', 'scheduled', 'timer', 'heartbeat'],
    'deploy': ['deployment', 'deploy', 'Docker', 'release'],
    'timeout': ['timeout', 'time limit', 'max duration', 'killed'],
    'safety': ['safety', 'rules', 'constraints', 'guardrails'],
    'approval': ['approval', 'review', 'sign-off', 'tier'],
    'schedule': ['schedule', 'calendar', 'timetable', 'classes'],
    'worker': ['worker', 'agent', 'subagent', 'spawned'],
    'memory': ['memory', 'recall', 'notes', 'daily log'],
    'knowledge': ['knowledge', 'shared memory', 'docs', 'vault'],
  };

  const expanded: string[] = [...words];
  let didExpand = false;

  for (const word of words) {
    const synonyms = synonymMap[word];
    if (synonyms) {
      expanded.push(...synonyms.filter(s => !words.includes(s.toLowerCase())));
      didExpand = true;
    }
  }

  return didExpand ? expanded.join(' ') : null;
}

function shouldUseLLM(query: string): boolean {
  if (!config?.lmstudio?.chatModel) return false;
  const words = query.split(/\s+/);
  if (words.length <= 2) return false;
  if (query.includes('/') || query.includes('.') || query.includes('_')) return false;
  return true;
}

async function generateHyDE(query: string): Promise<ExpandedQuery | null> {
  if (!config) return null;

  const cached = llmCache.get(query);
  if (cached) {
    const hyde = cached.find(e => e.type === 'hyde');
    return hyde || null;
  }

  const url = `${config.lmstudio.baseUrl}/chat/completions`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.lmstudio.chatModel,
        messages: [
          { role: 'user', content: `/no_think\nWrite a 1-2 sentence document excerpt that answers: ${query}` },
          { role: 'assistant', content: 'Based on the notes:' },
        ],
        max_tokens: 60,
        temperature: 0.3,
        stop: ['\n\n', '\n'],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as any;
    const text = (data.choices?.[0]?.message?.content || '').trim();
    
    const cleaned = text
      .replace(/<\/?think>/g, '')
      .replace(/^based on the notes:\s*/i, '')
      .trim();

    if (cleaned.length < 10) return null;

    const expansion: ExpandedQuery = { type: 'hyde', text: 'Based on the notes: ' + cleaned };
    
    if (llmCache.size >= MAX_CACHE_SIZE) {
      const firstKey = llmCache.keys().next().value;
      if (firstKey !== undefined) llmCache.delete(firstKey);
    }
    llmCache.set(query, [expansion]);
    
    return expansion;
  } catch (err) {
    console.warn('[memory] HyDE generation failed:', err);
    return null;
  }
}

export function clearExpansionCache(): void {
  llmCache.clear();
}
