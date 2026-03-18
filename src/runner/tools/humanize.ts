/**
 * humanize tool — Detect and fix AI writing patterns.
 *
 * Self-contained implementation of the analyzer + humanizer logic used by the
 * runner tool. No external repo or runtime dependency is required.
 *
 * Actions:
 *   - score: Quick 0-100 AI score (higher = more AI-like)
 *   - analyze: Full analysis with pattern matches, stats, and category breakdown
 *   - humanize: Prioritized rewrite suggestions + optional auto-fix
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { ToolDefinition } from "../types.js";
import { resolveToCwd } from "./path-utils.js";

type Confidence = "high" | "medium" | "low";
type Category = "content" | "language" | "style" | "communication" | "filler";

interface PatternMatch {
  match: string;
  index: number;
  line: number;
  column: number;
  suggestion: string;
  confidence: Confidence;
}

interface PatternFinding {
  patternId: number;
  patternName: string;
  category: Category;
  description: string;
  weight: number;
  matchCount: number;
  matches: PatternMatch[];
  truncated: boolean;
}

interface CategoryScore {
  matches: number;
  weightedScore: number;
  patterns: string[];
}

interface AnalysisStats {
  wordCount: number;
  uniqueWordCount: number;
  sentenceCount: number;
  paragraphCount: number;
  avgWordLength: number;
  avgSentenceLength: number;
  sentenceLengthStdDev: number;
  sentenceLengthVariation: number;
  burstiness: number;
  typeTokenRatio: number;
  functionWordRatio: number;
  trigramRepetition: number;
  avgParagraphLength: number;
  fleschKincaid: number;
  sentenceLengths: number[];
}

interface AnalysisResult {
  score: number;
  patternScore: number;
  uniformityScore: number;
  totalMatches: number;
  wordCount: number;
  stats: AnalysisStats | null;
  categories: Record<
    Category,
    { label: string; matches: number; weightedScore: number; patternsDetected: string[] }
  >;
  findings: PatternFinding[];
  summary: string;
}

interface HumanizeSuggestion {
  pattern: string;
  patternId: number;
  category: Category;
  weight: number;
  text: string;
  line: number;
  column: number;
  suggestion: string;
  confidence: Confidence;
}

interface StyleTip {
  metric: string;
  value: number | null;
  tip: string;
}

interface HumanizeResult {
  score: number;
  patternScore: number;
  uniformityScore: number;
  wordCount: number;
  totalIssues: number;
  stats: AnalysisStats | null;
  critical: HumanizeSuggestion[];
  important: HumanizeSuggestion[];
  minor: HumanizeSuggestion[];
  autofix: { text: string; fixes: string[] } | null;
  guidance: string[];
  styleTips: StyleTip[];
}

interface PhrasePattern {
  pattern: RegExp;
  tier: 1 | 2 | 3;
  fix: string;
}

interface PatternDefinition {
  id: number;
  name: string;
  category: Category;
  description: string;
  weight: number;
  detect: (text: string) => PatternMatch[];
}

const CATEGORY_LABELS: Record<Category, string> = {
  content: "Content patterns",
  language: "Language & grammar",
  style: "Style patterns",
  communication: "Communication artifacts",
  filler: "Filler & hedging",
};

const HIDDEN_UNICODE_CHARS = /(?:\u200B|\u200C|\u200D|\u2060|\uFEFF|\u00AD)/;
const HIDDEN_UNICODE_CHARS_GLOBAL = /(?:\u200B|\u200C|\u200D|\u2060|\uFEFF|\u00AD)/g;
const NON_BREAKING_SPACES = /(?:\u00A0|\u202F)/;
const NON_BREAKING_SPACES_GLOBAL = /(?:\u00A0|\u202F)/g;

const TIER_1 = [
  "delve",
  "delving",
  "delved",
  "delves",
  "tapestry",
  "vibrant",
  "crucial",
  "comprehensive",
  "intricate",
  "intricacies",
  "pivotal",
  "testament",
  "landscape",
  "bustling",
  "nestled",
  "realm",
  "meticulous",
  "meticulously",
  "complexities",
  "embark",
  "embarking",
  "embarked",
  "robust",
  "showcasing",
  "showcase",
  "showcased",
  "showcases",
  "underscores",
  "underscoring",
  "underscored",
  "fostering",
  "foster",
  "fostered",
  "fosters",
  "seamless",
  "seamlessly",
  "groundbreaking",
  "renowned",
  "synergy",
  "synergies",
  "leverage",
  "leveraging",
  "leveraged",
  "garner",
  "garnered",
  "garnering",
  "interplay",
  "enduring",
  "enhance",
  "enhanced",
  "enhancing",
  "enhancement",
  "tapestry",
  "testament",
  "additionally",
  "daunting",
  "ever-evolving",
  "game changer",
  "game-changing",
  "game-changer",
  "underscore",
  "unpack",
  "unpacking",
  "unpacked",
  "unraveling",
  "unravel",
  "deep dive",
  "deep-dive",
  "at its core",
  "holistic",
  "holistically",
  "synergistic",
  "actionable",
  "impactful",
  "learnings",
  "cadence",
  "bandwidth",
  "net-net",
  "value-add",
  "best practices",
  "best-practices",
  "best practice",
  "thought leader",
  "thought leadership",
] as const;

const TIER_2 = [
  "furthermore",
  "moreover",
  "notably",
  "consequently",
  "subsequently",
  "accordingly",
  "nonetheless",
  "henceforth",
  "indeed",
  "specifically",
  "essentially",
  "ultimately",
  "arguably",
  "fundamentally",
  "inherently",
  "profoundly",
  "encompassing",
  "encompasses",
  "encompassed",
  "endeavour",
  "endeavor",
  "endeavoring",
  "elevate",
  "elevated",
  "elevating",
  "alleviate",
  "alleviating",
  "streamline",
  "streamlined",
  "streamlining",
  "harness",
  "harnessing",
  "harnessed",
  "unleash",
  "unleashing",
  "unleashed",
  "revolutionize",
  "revolutionizing",
  "revolutionized",
  "transformative",
  "transformation",
  "paramount",
  "multifaceted",
  "spearhead",
  "spearheading",
  "spearheaded",
  "bolster",
  "bolstering",
  "bolstered",
  "catalyze",
  "catalyst",
  "catalyzed",
  "cornerstone",
  "reimagine",
  "reimagining",
  "reimagined",
  "empower",
  "empowering",
  "empowerment",
  "empowered",
  "navigate",
  "navigating",
  "navigated",
  "poised",
  "myriad",
  "nuanced",
  "nuance",
  "nuances",
  "paradigm",
  "paradigms",
  "paradigm-shifting",
  "holistic",
  "holistically",
  "utilize",
  "utilizing",
  "utilization",
  "utilized",
  "facilitate",
  "facilitated",
  "facilitating",
  "facilitation",
  "elucidate",
  "elucidating",
  "illuminate",
  "illuminating",
  "illuminated",
  "invaluable",
  "cutting-edge",
  "innovative",
  "innovation",
  "align",
  "aligns",
  "aligning",
  "alignment",
  "dynamic",
  "dynamics",
  "impactful",
  "agile",
  "scalable",
  "scalability",
  "proactive",
  "proactively",
  "synergistic",
  "optimize",
  "optimizing",
  "optimization",
  "resonate",
  "resonating",
  "resonated",
  "resonates",
  "underscore",
  "underscored",
  "cultivate",
  "cultivating",
  "cultivated",
  "galvanize",
  "galvanizing",
  "invigorate",
  "invigorating",
  "juxtapose",
  "juxtaposing",
  "juxtaposition",
  "underscore",
  "bolster",
  "augment",
  "augmenting",
  "augmented",
  "proliferate",
  "proliferating",
  "proliferation",
  "burgeoning",
  "nascent",
  "ubiquitous",
  "plethora",
  "myriad",
  "quintessential",
  "eclectic",
  "indelible",
  "overarching",
  "underpinning",
  "underpinnings",
] as const;

const TIER_3 = [
  "significant",
  "significantly",
  "important",
  "importantly",
  "effective",
  "effectively",
  "efficient",
  "efficiently",
  "diverse",
  "diversity",
  "unique",
  "uniquely",
  "key",
  "vital",
  "vitally",
  "critical",
  "critically",
  "essential",
  "essentially",
  "valuable",
  "notable",
  "remarkable",
  "remarkably",
  "substantial",
  "substantially",
  "considerable",
  "considerably",
  "noteworthy",
  "prominent",
  "prominently",
  "influential",
  "thoughtful",
  "thoughtfully",
  "insightful",
  "insightfully",
  "meaningful",
  "meaningfully",
  "purposeful",
  "purposefully",
  "deliberate",
  "deliberately",
  "strategic",
  "strategically",
  "integral",
  "indispensable",
  "instrumental",
  "imperative",
  "exemplary",
  "commendable",
  "praiseworthy",
  "sophisticated",
  "profound",
  "compelling",
  "captivating",
  "exquisite",
  "impeccable",
  "formidable",
  "stellar",
  "exceptional",
  "exceptionally",
  "extraordinary",
  "unparalleled",
  "unprecedented",
  "monumental",
  "groundbreaking",
  "trailblazing",
  "visionary",
  "world-class",
  "state-of-the-art",
  "best-in-class",
] as const;

const AI_PHRASES: PhrasePattern[] = [
  { pattern: /\bin today'?s (digital age|fast-paced world|rapidly evolving|ever-changing|modern|interconnected)\b/gi, tier: 1, fix: "(remove or be specific about what changed)" },
  { pattern: /\bin today'?s world\b/gi, tier: 2, fix: "(remove or be specific)" },
  { pattern: /\bit is (worth|important to|essential to|crucial to) not(e|ing) that\b/gi, tier: 1, fix: "(remove — just state the fact)" },
  { pattern: /\bit should be noted that\b/gi, tier: 1, fix: "(remove — just state the fact)" },
  { pattern: /\bit bears mentioning that\b/gi, tier: 1, fix: "(remove — just state the fact)" },
  { pattern: /\bpave the way (for|to)\b/gi, tier: 1, fix: "enable / allow / lead to" },
  { pattern: /\bat the forefront of\b/gi, tier: 1, fix: "leading / first in" },
  { pattern: /\bnavigate the (complexities|challenges|landscape)\b/gi, tier: 1, fix: "handle / deal with / work through" },
  { pattern: /\bharness the (power|potential|capabilities) of\b/gi, tier: 1, fix: "use" },
  { pattern: /\bembark on a journey\b/gi, tier: 1, fix: "start / begin" },
  { pattern: /\bpush the boundaries\b/gi, tier: 1, fix: "(be specific about what changed)" },
  { pattern: /\bfoster a (culture|environment|atmosphere|sense) of\b/gi, tier: 1, fix: "build / create / encourage" },
  { pattern: /\bunlock the (potential|power|full|true)\b/gi, tier: 1, fix: "enable / use / improve" },
  { pattern: /\bserves as a testament\b/gi, tier: 1, fix: "shows / proves / demonstrates" },
  { pattern: /\bplays a (crucial|pivotal|vital|key|significant|important|critical) role\b/gi, tier: 1, fix: "matters for / helps / is important to" },
  { pattern: /\bin the realm of\b/gi, tier: 1, fix: "in" },
  { pattern: /\bdelve into\b/gi, tier: 1, fix: "explore / examine / look at" },
  { pattern: /\bthe landscape of\b/gi, tier: 1, fix: "(be specific — what part of the field?)" },
  { pattern: /\bnestled (in|within|among)\b/gi, tier: 1, fix: "located in / in / near" },
  { pattern: /\brise to the (occasion|challenge)\b/gi, tier: 2, fix: "handle / face / tackle" },
  { pattern: /\bstand at the (crossroads|intersection)\b/gi, tier: 2, fix: "(be specific about the choice)" },
  { pattern: /\bshape the (future|trajectory|direction)\b/gi, tier: 2, fix: "(be specific about how)" },
  { pattern: /\btip of the iceberg\b/gi, tier: 2, fix: "one example / a small part" },
  { pattern: /\bdouble-edged sword\b/gi, tier: 2, fix: "has tradeoffs / cuts both ways" },
  { pattern: /\ba testament to\b/gi, tier: 1, fix: "shows / proves" },
  { pattern: /\bthe dawn of\b/gi, tier: 2, fix: "the start of / the beginning of" },
  { pattern: /\bthe fabric of\b/gi, tier: 1, fix: "(be concrete)" },
  { pattern: /\bthe tapestry of\b/gi, tier: 1, fix: "(be concrete)" },
  { pattern: /\bcould potentially\b/gi, tier: 1, fix: "could / might" },
  { pattern: /\bmight possibly\b/gi, tier: 1, fix: "might" },
  { pattern: /\bcould possibly\b/gi, tier: 1, fix: "could" },
  { pattern: /\bperhaps potentially\b/gi, tier: 1, fix: "perhaps / maybe" },
  { pattern: /\bmay potentially\b/gi, tier: 1, fix: "may" },
  { pattern: /\bcould conceivably\b/gi, tier: 1, fix: "could" },
  { pattern: /\bI hope this helps\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\blet me know if (you|there)\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\bwould you like me to\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\bfeel free to\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\bdon'?t hesitate to\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\bhappy to help\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\bhere is (a |an |the )?(comprehensive |brief |quick )?(overview|summary|breakdown|list|guide|explanation|look)\b/gi, tier: 1, fix: "(remove — start with the content)" },
  { pattern: /\bI'?d be happy to\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\bis there anything else\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\bgreat question\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\bexcellent (question|point|observation)\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\bthat'?s a (great|excellent|wonderful|fantastic|good|insightful|thoughtful) (question|point|observation)\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\byou'?re absolutely right\b/gi, tier: 1, fix: "(remove or address the substance)" },
  { pattern: /\byou raise a (great|good|excellent|valid|important) point\b/gi, tier: 1, fix: "(remove or address the substance)" },
  { pattern: /\bas of (my|this) (last|latest|most recent) (training|update|knowledge)\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\bwhile (specific )?details are (limited|scarce|not available)\b/gi, tier: 1, fix: "(remove — research it or omit the claim)" },
  { pattern: /\bbased on (available|my|current) (information|knowledge|understanding|data)\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\bup to my (last )?training\b/gi, tier: 1, fix: "(remove)" },
  { pattern: /\bthe future (looks|is|remains) bright\b/gi, tier: 1, fix: "(end with a specific fact or plan)" },
  { pattern: /\bexciting times (lie|lay|are) ahead\b/gi, tier: 1, fix: "(end with a specific fact or plan)" },
  { pattern: /\bcontinue (this|their|our|the) journey\b/gi, tier: 1, fix: "(be specific about what happens next)" },
  { pattern: /\bjourney toward(s)? (excellence|success|greatness)\b/gi, tier: 1, fix: "(be specific)" },
  { pattern: /\bstep in the right direction\b/gi, tier: 1, fix: "(be specific about the outcome)" },
  { pattern: /\bonly time will tell\b/gi, tier: 1, fix: "(end with what you actually know)" },
  { pattern: /\bthe possibilities are (endless|limitless|infinite)\b/gi, tier: 1, fix: "(be specific about what's possible)" },
  { pattern: /\bpoised for (growth|success|greatness|expansion)\b/gi, tier: 1, fix: "(cite evidence or remove)" },
  { pattern: /\bwatch this space\b/gi, tier: 2, fix: "(end with something concrete)" },
  { pattern: /\bstay tuned\b/gi, tier: 2, fix: "(end with something concrete)" },
  { pattern: /\bremains to be seen\b/gi, tier: 2, fix: "(state what you do know)" },
  { pattern: /\bin order to\b/gi, tier: 2, fix: "to" },
  { pattern: /\bdue to the fact that\b/gi, tier: 1, fix: "because" },
  { pattern: /\bat this point in time\b/gi, tier: 1, fix: "now" },
  { pattern: /\bin the event that\b/gi, tier: 1, fix: "if" },
  { pattern: /\bhas the ability to\b/gi, tier: 1, fix: "can" },
  { pattern: /\bfor the purpose of\b/gi, tier: 1, fix: "to / for" },
  { pattern: /\bin light of the fact that\b/gi, tier: 1, fix: "because / since" },
  { pattern: /\bfirst and foremost\b/gi, tier: 2, fix: "first" },
  { pattern: /\blast but not least\b/gi, tier: 2, fix: "finally" },
  { pattern: /\bat the end of the day\b/gi, tier: 2, fix: "(remove or be specific)" },
  { pattern: /\bwhen it comes to\b/gi, tier: 2, fix: "for / regarding" },
  { pattern: /\bthe fact of the matter is\b/gi, tier: 1, fix: "(remove — just state it)" },
  { pattern: /\bin terms of\b/gi, tier: 3, fix: "for / about / regarding" },
  { pattern: /\bat its core\b/gi, tier: 2, fix: "(remove or be specific)" },
  { pattern: /\bit goes without saying\b/gi, tier: 2, fix: "(if it goes without saying, don't say it)" },
  { pattern: /\bneedless to say\b/gi, tier: 2, fix: "(if needless to say, don't say it)" },
  { pattern: /\blet'?s dive in\b/gi, tier: 1, fix: "(just start)" },
  { pattern: /\blet'?s (break this|break it) down\b/gi, tier: 1, fix: "(just explain)" },
  { pattern: /\bhere'?s the thing\b/gi, tier: 2, fix: "(just say it)" },
  { pattern: /\bthe reality is\b/gi, tier: 2, fix: "(state the fact)" },
  { pattern: /\bmoving forward\b/gi, tier: 2, fix: "next / from now on" },
  { pattern: /\bcircle back\b/gi, tier: 1, fix: "return to / revisit" },
  { pattern: /\btouch base\b/gi, tier: 1, fix: "talk / check in" },
  { pattern: /\bgoing forward\b/gi, tier: 2, fix: "from now on" },
  { pattern: /\bkey takeaway(s)?\b/gi, tier: 1, fix: "main point(s)" },
  { pattern: /\bvalue proposition\b/gi, tier: 2, fix: "benefit / value" },
  { pattern: /\bcore competenc(y|ies)\b/gi, tier: 2, fix: "strength(s)" },
  { pattern: /\bbest-in-class\b/gi, tier: 1, fix: "excellent / (be specific)" },
  { pattern: /\bworld-class\b/gi, tier: 1, fix: "(be specific)" },
  { pattern: /\bcutting-edge\b/gi, tier: 1, fix: "(be specific)" },
  { pattern: /\bstate-of-the-art\b/gi, tier: 1, fix: "(be specific or cite)" },
  { pattern: /\bgold standard\b/gi, tier: 2, fix: "(cite the standard)" },
  { pattern: /\blow-hanging fruit\b/gi, tier: 1, fix: "easy wins / quick wins" },
  { pattern: /\bpain point(s)?\b/gi, tier: 1, fix: "problem(s)" },
  { pattern: /\bdeep dive\b/gi, tier: 1, fix: "detailed look / analysis" },
  { pattern: /\bparadigm shift\b/gi, tier: 1, fix: "major change" },
  { pattern: /\bdouble-click (on)?\b/gi, tier: 1, fix: "examine / look closer at" },
  { pattern: /\bloop (you |me |them )in\b/gi, tier: 2, fix: "include / inform" },
  { pattern: /\btable this\b/gi, tier: 2, fix: "postpone / set aside" },
  { pattern: /\bpivot to\b/gi, tier: 2, fix: "switch to / change to" },
  { pattern: /\bsync(h)? (up )?(on|about)\b/gi, tier: 2, fix: "discuss / align on" },
  { pattern: /\brun it up the flagpole\b/gi, tier: 1, fix: "propose / suggest" },
  { pattern: /\bboil the ocean\b/gi, tier: 1, fix: "attempt too much" },
  { pattern: /\bmove the needle\b/gi, tier: 1, fix: "make progress / have impact" },
  { pattern: /\bopen the kimono\b/gi, tier: 1, fix: "share / be transparent" },
  { pattern: /\bdrink the Kool-Aid\b/gi, tier: 2, fix: "believe / accept" },
];

const FUNCTION_WORDS = [
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "I", "it", "for", "not", "on",
  "with", "he", "as", "you", "do", "at", "this", "but", "his", "by", "from", "they", "we",
  "say", "her", "she", "or", "an", "will", "my", "one", "all", "would", "there", "their",
  "what", "so", "up", "out", "if", "about", "who", "get", "which", "go", "me", "when", "make",
  "can", "like", "time", "no", "just", "him", "know", "take", "people", "into", "year", "your",
  "good", "some", "could", "them", "see", "other", "than", "then", "now", "look", "only",
  "come", "its", "over", "think", "also", "back", "after", "use", "two", "how", "our", "work",
  "first", "well", "way", "even", "new", "want", "because", "any", "these", "give", "day",
  "most", "us",
] as const;

const SIGNIFICANCE_PHRASES = [
  /marking a pivotal/gi, /pivotal moment/gi, /pivotal role/gi, /key role/gi, /crucial role/gi,
  /vital role/gi, /significant role/gi, /is a testament/gi, /stands as a testament/gi,
  /serves as a testament/gi, /serves as a reminder/gi, /reflects broader/gi, /broader trends/gi,
  /broader movement/gi, /evolving landscape/gi, /evolving world/gi, /setting the stage for/gi,
  /marking a shift/gi, /key turning point/gi, /indelible mark/gi, /deeply rooted/gi, /focal point/gi,
  /symbolizing its ongoing/gi, /enduring legacy/gi, /lasting impact/gi, /contributing to the/gi,
  /underscores the importance/gi, /highlights the significance/gi, /represents a shift/gi,
  /shaping the future/gi, /the evolution of/gi, /rich tapestry/gi, /rich heritage/gi,
  /stands as a beacon/gi, /marks a milestone/gi, /paving the way/gi, /charting a course/gi,
] as const;

const PROMOTIONAL_WORDS = [
  /\bnestled\b/gi, /\bin the heart of\b/gi, /\bbreathtaking\b/gi, /\bmust-visit\b/gi,
  /\bstunning\b/gi, /\brenowned\b/gi, /\bnatural beauty\b/gi, /\brich cultural heritage\b/gi,
  /\brich history\b/gi, /\bcommitment to\b/gi, /\bexemplifies\b/gi, /\bworld-class\b/gi,
  /\bstate-of-the-art\b/gi, /\bgame-changing\b/gi, /\bgame changer\b/gi, /\bunparalleled\b/gi,
  /\bprofound\b/gi, /\bbest-in-class\b/gi, /\btrailblazing\b/gi, /\bvisionary\b/gi,
  /\bcutting-edge\b/gi, /\bworldwide recognition\b/gi,
] as const;

const VAGUE_ATTRIBUTION_PHRASES = [
  /\bexperts (believe|argue|say|suggest|note|agree|contend|have noted)\b/gi,
  /\bindustry (reports|observers|experts|analysts|leaders|insiders)\b/gi,
  /\bobservers have (cited|noted|pointed out)\b/gi,
  /\bsome critics argue\b/gi,
  /\bsome experts (say|believe|suggest)\b/gi,
  /\bseveral sources\b/gi,
  /\baccording to reports\b/gi,
  /\bwidely (regarded|considered|recognized|acknowledged)\b/gi,
  /\bit is widely (known|believed|accepted)\b/gi,
  /\bmany (experts|scholars|researchers|analysts) (believe|argue|suggest)\b/gi,
  /\bstudies (show|suggest|indicate|have shown)\b/gi,
  /\bresearch (shows|suggests|indicates|has shown)\b/gi,
  /\bsources close to\b/gi,
  /\bpeople familiar with\b/gi,
] as const;

const CHALLENGES_PHRASES = [
  /despite (its|these|the|their) (challenges|setbacks|obstacles|difficulties|limitations)/gi,
  /faces (several|many|numerous|various) challenges/gi,
  /continues to thrive/gi,
  /continues to grow/gi,
  /future (outlook|prospects) (remain|look|appear)/gi,
  /challenges and (future|legacy|opportunities)/gi,
  /despite these (challenges|hurdles|obstacles)/gi,
  /overcoming (obstacles|challenges|adversity)/gi,
  /weather(ing|ed) the storm/gi,
] as const;

const COPULA_AVOIDANCE = [
  /\bserves as( a)?\b/gi, /\bstands as( a)?\b/gi, /\bmarks a\b/gi, /\brepresents a\b/gi,
  /\bboasts (a|an|over|more)\b/gi, /\bfeatures (a|an|over|more)\b/gi, /\boffers (a|an)\b/gi,
  /\bfunctions as\b/gi, /\bacts as( a)?\b/gi, /\boperates as( a)?\b/gi,
] as const;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function emptyStats(): AnalysisStats {
  return {
    wordCount: 0,
    uniqueWordCount: 0,
    sentenceCount: 0,
    paragraphCount: 0,
    avgWordLength: 0,
    avgSentenceLength: 0,
    sentenceLengthStdDev: 0,
    sentenceLengthVariation: 0,
    burstiness: 0,
    typeTokenRatio: 0,
    functionWordRatio: 0,
    trigramRepetition: 0,
    avgParagraphLength: 0,
    fleschKincaid: 0,
    sentenceLengths: [],
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function splitSentences(text: string): string[] {
  const cleaned = text
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|etc|vs|approx|dept|est|vol)\./gi, "$1\u2024")
    .replace(/\b([A-Z])\./g, "$1\u2024")
    .replace(/\b(\d+)\./g, "$1\u2024");

  return cleaned
    .split(/(?<=[.!?])\s+(?=[A-Z"'\u201C])|(?<=[.!?])$/)
    .map((s) => s.replace(/\u2024/g, ".").trim())
    .filter((s) => s.length > 0);
}

function computeNgramRepetition(words: string[], n: number): number {
  if (words.length < n) return 0;
  const ngrams = new Map<string, number>();
  for (let i = 0; i <= words.length - n; i++) {
    const gram = words.slice(i, i + n).join(" ");
    ngrams.set(gram, (ngrams.get(gram) ?? 0) + 1);
  }
  const total = ngrams.size;
  if (total === 0) return 0;
  const repeated = Array.from(ngrams.values()).filter((count) => count > 1).length;
  return repeated / total;
}

function estimateSyllables(word: string): number {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
  if (cleaned.length <= 3) return 1;
  const vowelGroups = cleaned.match(/[aeiouy]+/g);
  let count = vowelGroups ? vowelGroups.length : 1;
  if (cleaned.endsWith("e") && !cleaned.endsWith("le")) count--;
  if (cleaned.endsWith("ed") && cleaned.length > 3 && !/[aeiouy]ed$/.test(cleaned)) count--;
  return Math.max(count, 1);
}

function computeStats(text: string): AnalysisStats {
  if (!text || text.trim().length === 0) return emptyStats();

  const words = tokenize(text);
  const sentences = splitSentences(text);
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  if (words.length === 0) return emptyStats();

  const totalWords = words.length;
  const uniqueWords = new Set(words);
  const typeTokenRatio = uniqueWords.size / totalWords;
  const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / totalWords;

  const sentenceLengths = sentences.map((s) => tokenize(s).length).filter((n) => n > 0);
  const sentenceCount = sentenceLengths.length;

  let avgSentenceLength = 0;
  let sentenceLengthStdDev = 0;
  let sentenceLengthVariation = 0;
  let burstiness = 0;

  if (sentenceCount > 1) {
    avgSentenceLength = sentenceLengths.reduce((a, b) => a + b, 0) / sentenceCount;
    const variance =
      sentenceLengths.reduce((sum, len) => sum + Math.pow(len - avgSentenceLength, 2), 0) /
      sentenceCount;
    sentenceLengthStdDev = Math.sqrt(variance);
    sentenceLengthVariation = avgSentenceLength > 0 ? sentenceLengthStdDev / avgSentenceLength : 0;

    let consecutiveDiffSum = 0;
    for (let i = 1; i < sentenceLengths.length; i++) {
      consecutiveDiffSum += Math.abs(sentenceLengths[i] - sentenceLengths[i - 1]);
    }
    const avgConsecutiveDiff = consecutiveDiffSum / (sentenceLengths.length - 1);
    burstiness = avgSentenceLength > 0 ? avgConsecutiveDiff / avgSentenceLength : 0;
  } else if (sentenceCount === 1) {
    avgSentenceLength = sentenceLengths[0] ?? 0;
  }

  const functionWordSet = new Set(FUNCTION_WORDS.map((word) => word.toLowerCase()));
  const functionWordCount = words.filter((w) => functionWordSet.has(w)).length;
  const paragraphCount = paragraphs.length;
  const avgParagraphLength =
    paragraphCount > 0
      ? paragraphs.reduce((sum, p) => sum + tokenize(p).length, 0) / paragraphCount
      : 0;
  const trigramRepetition = computeNgramRepetition(words, 3);
  const syllableCount = words.reduce((sum, w) => sum + estimateSyllables(w), 0);
  const fleschKincaid =
    sentenceCount > 0
      ? 0.39 * (totalWords / sentenceCount) + 11.8 * (syllableCount / totalWords) - 15.59
      : 0;

  return {
    wordCount: totalWords,
    uniqueWordCount: uniqueWords.size,
    sentenceCount,
    paragraphCount,
    avgWordLength: round(avgWordLength),
    avgSentenceLength: round(avgSentenceLength),
    sentenceLengthStdDev: round(sentenceLengthStdDev),
    sentenceLengthVariation: round(sentenceLengthVariation),
    burstiness: round(burstiness),
    typeTokenRatio: round(typeTokenRatio),
    functionWordRatio: round(functionWordCount / totalWords),
    trigramRepetition: round(trigramRepetition),
    avgParagraphLength: round(avgParagraphLength),
    fleschKincaid: round(fleschKincaid),
    sentenceLengths,
  };
}

function computeUniformityScore(stats: AnalysisStats): number {
  if (stats.wordCount === 0) return 0;
  let score = 0;
  if (stats.burstiness < 0.2) score += 25;
  else if (stats.burstiness < 0.35) score += 18;
  else if (stats.burstiness < 0.5) score += 10;
  else if (stats.burstiness < 0.65) score += 5;

  if (stats.sentenceLengthVariation < 0.2) score += 25;
  else if (stats.sentenceLengthVariation < 0.35) score += 18;
  else if (stats.sentenceLengthVariation < 0.5) score += 10;
  else if (stats.sentenceLengthVariation < 0.65) score += 5;

  if (stats.wordCount > 100) {
    if (stats.typeTokenRatio < 0.35) score += 20;
    else if (stats.typeTokenRatio < 0.45) score += 12;
    else if (stats.typeTokenRatio < 0.55) score += 5;
  }

  if (stats.trigramRepetition > 0.15) score += 15;
  else if (stats.trigramRepetition > 0.1) score += 10;
  else if (stats.trigramRepetition > 0.05) score += 5;

  if (stats.paragraphCount >= 3 && stats.sentenceCount > 5) {
    if (stats.sentenceLengthStdDev < 3 && stats.avgSentenceLength > 10) score += 15;
  }

  return Math.min(score, 100);
}

function emptyAnalysis(): AnalysisResult {
  return {
    score: 0,
    patternScore: 0,
    uniformityScore: 0,
    totalMatches: 0,
    wordCount: 0,
    stats: null,
    categories: {
      content: { label: CATEGORY_LABELS.content, matches: 0, weightedScore: 0, patternsDetected: [] },
      language: { label: CATEGORY_LABELS.language, matches: 0, weightedScore: 0, patternsDetected: [] },
      style: { label: CATEGORY_LABELS.style, matches: 0, weightedScore: 0, patternsDetected: [] },
      communication: { label: CATEGORY_LABELS.communication, matches: 0, weightedScore: 0, patternsDetected: [] },
      filler: { label: CATEGORY_LABELS.filler, matches: 0, weightedScore: 0, patternsDetected: [] },
    },
    findings: [],
    summary: "No significant AI writing patterns detected. The text looks human-written.",
  };
}

function findMatches(
  text: string,
  regex: RegExp,
  suggestion: string | ((match: string) => string),
  confidence: Confidence = "high",
): PatternMatch[] {
  const results: PatternMatch[] = [];
  const lines = text.split("\n");
  let offset = 0;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]!;
    const lineRegex = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = lineRegex.exec(line)) !== null) {
      results.push({
        match: match[0],
        index: offset + match.index,
        line: lineNum + 1,
        column: match.index + 1,
        suggestion: typeof suggestion === "function" ? suggestion(match[0]) : suggestion,
        confidence,
      });
    }
    offset += line.length + 1;
  }

  return results;
}

function countMatches(text: string, regex: RegExp): number {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function wordRegex(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "gi");
}

function scanWordList(
  text: string,
  wordList: readonly string[],
  suggestionPrefix: string,
  confidence: Confidence = "high",
): PatternMatch[] {
  const results: PatternMatch[] = [];
  for (const word of wordList) {
    const regex = wordRegex(word);
    results.push(
      ...findMatches(
        text,
        regex,
        `${suggestionPrefix}: "${word}". Use a simpler, more specific alternative.`,
        confidence,
      ),
    );
  }
  return results;
}

function scanPhrases(text: string, phrases: PhrasePattern[], tierFilter: 1 | 2 | 3 | null = null): PatternMatch[] {
  const results: PatternMatch[] = [];
  for (const { pattern, tier, fix } of phrases) {
    if (tierFilter !== null && tier !== tierFilter) continue;
    results.push(
      ...findMatches(
        text,
        pattern,
        fix.startsWith("(") ? fix : `Replace with: ${fix}`,
        tier === 1 ? "high" : tier === 2 ? "medium" : "low",
      ),
    );
  }
  return results;
}

const patterns: PatternDefinition[] = [
  {
    id: 1,
    name: "Significance inflation",
    category: "content",
    description: "Inflated claims about significance, legacy, or broader trends.",
    weight: 4,
    detect(text) {
      return SIGNIFICANCE_PHRASES.flatMap((regex) =>
        findMatches(text, regex, "Remove inflated significance claim. State concrete facts instead.", "high"),
      );
    },
  },
  {
    id: 2,
    name: "Notability name-dropping",
    category: "content",
    description: "Listing outlets or sources to imply notability without specifics.",
    weight: 3,
    detect(text) {
      const mediaList =
        /\b(cited|featured|covered|mentioned|reported|published|recognized|highlighted) (in|by) .{0,20}(The New York Times|BBC|CNN|The Washington Post|The Guardian|Wired|Forbes|Reuters|Bloomberg|Financial Times|The Verge|TechCrunch|The Hindu|Al Jazeera|Time|Newsweek|The Economist|Nature|Science).{0,100}(,\s*(and\s+)?(The New York Times|BBC|CNN|The Washington Post|The Guardian|Wired|Forbes|Reuters|Bloomberg|Financial Times|The Verge|TechCrunch|The Hindu|Al Jazeera|Time|Newsweek|The Economist|Nature|Science))+/gi;
      return [
        ...findMatches(text, mediaList, "Instead of listing outlets, cite one specific claim from one source.", "high"),
        ...findMatches(text, /\bactive social media presence\b/gi, "Remove — not meaningful without specific context.", "high"),
        ...findMatches(text, /\bwritten by a leading expert\b/gi, "Name the expert and their specific credential.", "medium"),
        ...findMatches(text, /\bhas been (featured|recognized|acknowledged) (by|in)\b/gi, "Cite the specific feature with a concrete claim.", "medium"),
      ];
    },
  },
  {
    id: 3,
    name: "Superficial -ing analyses",
    category: "content",
    description: "Tacking on trailing participial phrases to fake depth.",
    weight: 4,
    detect(text) {
      return findMatches(
        text,
        /,\s*(highlighting|underscoring|emphasizing|ensuring|reflecting|symbolizing|contributing to|cultivating|fostering|encompassing|showcasing|demonstrating|illustrating|representing|signaling|indicating|solidifying|reinforcing|cementing|underscoring|bolstering|reaffirming|illuminating|epitomizing)\b[^.]{5,}/gi,
        "Remove trailing -ing phrase. If the point matters, give it its own sentence with specifics.",
        "high",
      );
    },
  },
  {
    id: 4,
    name: "Promotional language",
    category: "content",
    description: "Ad-copy language that reads like a press release.",
    weight: 3,
    detect(text) {
      return PROMOTIONAL_WORDS.flatMap((regex) =>
        findMatches(text, regex, "Replace promotional language with neutral, factual description.", "high"),
      );
    },
  },
  {
    id: 5,
    name: "Vague attributions",
    category: "content",
    description: "Claims attributed to unnamed experts, reports, or authorities.",
    weight: 4,
    detect(text) {
      return VAGUE_ATTRIBUTION_PHRASES.flatMap((regex) =>
        findMatches(text, regex, "Name the specific source, study, or person. If you can't, remove the claim.", "high"),
      );
    },
  },
  {
    id: 6,
    name: "Formulaic challenges",
    category: "content",
    description: "Boilerplate despite-challenges language.",
    weight: 3,
    detect(text) {
      return CHALLENGES_PHRASES.flatMap((regex) =>
        findMatches(text, regex, "Replace with specific challenges and concrete outcomes.", "high"),
      );
    },
  },
  {
    id: 7,
    name: "AI vocabulary",
    category: "language",
    description: "Vocabulary and phrase choices that cluster in AI-generated text.",
    weight: 5,
    detect(text) {
      const results: PatternMatch[] = [];
      const words = wordCount(text);
      results.push(...scanWordList(text, TIER_1, "Tier 1 AI word", "high"));

      const tier2Matches = scanWordList(text, TIER_2, "Tier 2 AI word", "medium");
      if (tier2Matches.length >= 2) results.push(...tier2Matches);

      if (words > 50) {
        const tier3Count = TIER_3.reduce((count, word) => count + countMatches(text, wordRegex(word)), 0);
        if (tier3Count / words > 0.03) {
          results.push(...scanWordList(text, TIER_3, "Tier 3 AI word (high density)", "low"));
        }
      }

      results.push(
        ...scanPhrases(
          text,
          AI_PHRASES.filter(
            (phrase) =>
              phrase.fix &&
              !phrase.fix.startsWith("(") &&
              !["to", "because", "now", "if", "can", "first", "finally"].includes(phrase.fix),
          ),
        ),
      );

      return results;
    },
  },
  {
    id: 8,
    name: "Copula avoidance",
    category: "language",
    description: "Using ornate substitutes for simple is/has wording.",
    weight: 3,
    detect(text) {
      return COPULA_AVOIDANCE.flatMap((regex) =>
        findMatches(text, regex, 'Use simple "is", "are", or "has" instead.', "high"),
      );
    },
  },
  {
    id: 9,
    name: "Negative parallelisms",
    category: "language",
    description: 'Overused "not only" / "not just X, it is Y" frames.',
    weight: 3,
    detect(text) {
      return [
        ...findMatches(
          text,
          /\b(it'?s|this is) not (just|merely|only|simply) .{3,60}(,|;|—)\s*(it'?s|this is|but)\b/gi,
          'Rewrite directly. State what the thing is, not what it "isn\'t just".',
          "high",
        ),
        ...findMatches(text, /\bnot only .{3,60} but (also )?\b/gi, 'Simplify. Remove the "not only...but also" frame.', "medium"),
      ];
    },
  },
  {
    id: 10,
    name: "Rule of three",
    category: "language",
    description: "Forced triads of abstract nouns or buzzy adjectives.",
    weight: 2,
    detect(text) {
      const results = findMatches(
        text,
        /\b(\w+tion|\w+ity|\w+ment|\w+ness|\w+ance|\w+ence),\s+(\w+tion|\w+ity|\w+ment|\w+ness|\w+ance|\w+ence),\s+and\s+(\w+tion|\w+ity|\w+ment|\w+ness|\w+ance|\w+ence)\b/gi,
        "Rule of three with abstract nouns. Pick the one or two that actually matter.",
        "medium",
      );
      const buzzAdj = [
        "seamless", "intuitive", "powerful", "innovative", "dynamic", "robust", "comprehensive",
        "cutting-edge", "scalable", "agile", "efficient", "effective", "engaging", "impactful",
        "meaningful", "transformative", "sustainable", "resilient", "inclusive", "accessible",
      ];
      const adjPattern = buzzAdj.join("|");
      const adjTriad = new RegExp(`\\b(${adjPattern}),\\s+(${adjPattern}),\\s+and\\s+(${adjPattern})\\b`, "gi");
      results.push(...findMatches(text, adjTriad, "Buzzy adjective triad. Pick one and make it specific.", "medium"));
      return results;
    },
  },
  {
    id: 11,
    name: "Synonym cycling",
    category: "language",
    description: "Rotating synonyms across nearby sentences to avoid repetition.",
    weight: 2,
    detect(text) {
      const synonymSets = [
        ["protagonist", "main character", "central figure", "hero", "lead character", "lead"],
        ["company", "firm", "organization", "enterprise", "corporation", "establishment", "entity"],
        ["city", "metropolis", "urban center", "municipality", "locale", "township"],
        ["building", "structure", "edifice", "facility", "complex", "establishment"],
        ["tool", "instrument", "mechanism", "apparatus", "device", "utility"],
        ["country", "nation", "state", "republic", "sovereign state"],
        ["problem", "challenge", "issue", "obstacle", "hurdle", "difficulty"],
        ["solution", "approach", "methodology", "framework", "strategy", "paradigm"],
      ];
      const results: PatternMatch[] = [];
      const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);

      for (const synonyms of synonymSets) {
        for (let i = 0; i < sentences.length - 1; i++) {
          const found: string[] = [];
          for (let j = i; j < Math.min(i + 4, sentences.length); j++) {
            const lower = sentences[j]!.toLowerCase();
            for (const synonym of synonyms) {
              if (lower.includes(synonym) && !found.includes(synonym)) found.push(synonym);
            }
          }
          if (found.length >= 3) {
            const anchor = text.indexOf(sentences[i]!);
            results.push({
              match: `Synonym cycling: ${found.join(" -> ")}`,
              index: anchor,
              line: text.substring(0, anchor).split("\n").length,
              column: 1,
              suggestion: `Pick one term and stick with it. Found "${found.join('", "')}" used as synonyms in nearby sentences.`,
              confidence: "medium",
            });
            break;
          }
        }
      }
      return results;
    },
  },
  {
    id: 12,
    name: "False ranges",
    category: "language",
    description: 'Overbroad "from X to Y" constructions without a real scale.',
    weight: 2,
    detect(text) {
      return [
        ...findMatches(
          text,
          /\bfrom .{3,40} to .{3,40},\s*from .{3,40} to .{3,40}/gi,
          "False range — X and Y probably aren't on a meaningful scale. Just list the topics.",
          "high",
        ),
        ...findMatches(
          text,
          /\bfrom (the )?(dawn|birth|inception|beginning|advent|emergence|rise|earliest) .{3,60} to (the )?(modern|current|present|contemporary|latest|cutting-edge|digital|future)/gi,
          "Unnecessarily broad range. Be specific about what you're actually covering.",
          "medium",
        ),
      ];
    },
  },
  {
    id: 13,
    name: "Em dash overuse",
    category: "style",
    description: "High em dash density.",
    weight: 2,
    detect(text) {
      const emDashes = text.match(/—/g) || [];
      const words = wordCount(text);
      const ratio = words > 0 ? emDashes.length / (words / 100) : 0;
      if (ratio > 1.0 && emDashes.length >= 2) {
        return findMatches(
          text,
          /—/g,
          `High em dash density (${emDashes.length} in ${words} words). Replace most with commas, periods, or parentheses.`,
          "medium",
        );
      }
      return [];
    },
  },
  {
    id: 14,
    name: "Boldface overuse",
    category: "style",
    description: "Mechanical bold formatting used as a crutch.",
    weight: 2,
    detect(text) {
      const boldMatches = text.match(/\*\*[^*]+\*\*/g) || [];
      return boldMatches.length >= 3
        ? findMatches(text, /\*\*[^*]+\*\*/g, "Excessive boldface. Remove emphasis — let the writing carry the weight.", "medium")
        : [];
    },
  },
  {
    id: 15,
    name: "Inline-header lists",
    category: "style",
    description: "Bullet lists with bolded inline headers.",
    weight: 3,
    detect(text) {
      const inlineHeaders = /^[*-]\s+\*\*[^*]+:\*\*\s/gm;
      const matches = text.match(inlineHeaders) || [];
      return matches.length >= 2
        ? findMatches(text, inlineHeaders, "Inline-header list pattern. Convert to a paragraph or use a simpler list.", "high")
        : [];
    },
  },
  {
    id: 16,
    name: "Title Case headings",
    category: "style",
    description: "Capitalizing Every Major Word In Headings.",
    weight: 1,
    detect(text) {
      const headingRegex = /^#{1,6}\s+(.+)$/gm;
      const results: PatternMatch[] = [];
      let match: RegExpExecArray | null;
      while ((match = headingRegex.exec(text)) !== null) {
        const heading = match[1]!.trim();
        const words = heading.split(/\s+/);
        if (words.length < 3) continue;
        const skipWords = /^(I|AI|API|CLI|URL|HTML|CSS|JS|TS|NPM|NYC|USA|UK|EU|LLM|GPT|SaaS|IoT|CEO|CTO|VP|PR|HR|IT|UI|UX)\b/;
        const capitalizedCount = words.filter((word) => /^[A-Z]/.test(word) && !skipWords.test(word)).length;
        if (capitalizedCount / words.length > 0.7) {
          results.push({
            match: match[0],
            index: match.index,
            line: text.substring(0, match.index).split("\n").length,
            column: 1,
            suggestion: "Use sentence case for headings (only capitalize first word and proper nouns).",
            confidence: "medium",
          });
        }
      }
      return results;
    },
  },
  {
    id: 17,
    name: "Emoji overuse",
    category: "style",
    description: "Decorative emojis in professional or technical text.",
    weight: 2,
    detect(text) {
      const emojiCount = countMatches(text, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/gu);
      return emojiCount >= 3
        ? findMatches(text, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}]/gu, "Remove emoji decoration from professional text.", "high")
        : [];
    },
  },
  {
    id: 18,
    name: "Curly quotes",
    category: "style",
    description: "Unicode curly quotes instead of straight quotes.",
    weight: 1,
    detect(text) {
      return findMatches(text, /[\u201C\u201D\u2018\u2019]/g, "Replace curly quotes with straight quotes.", "high");
    },
  },
  {
    id: 19,
    name: "Chatbot artifacts",
    category: "communication",
    description: 'Leftover assistant framing like "I hope this helps" or "Here is an overview".',
    weight: 5,
    detect(text) {
      return scanPhrases(text, AI_PHRASES.filter((phrase) => phrase.fix === "(remove)" || phrase.fix === "(remove — start with the content)"));
    },
  },
  {
    id: 20,
    name: "Cutoff disclaimers",
    category: "communication",
    description: "Knowledge-cutoff or information-availability disclaimers.",
    weight: 4,
    detect(text) {
      return scanPhrases(
        text,
        AI_PHRASES.filter(
          (phrase) =>
            phrase.fix === "(remove)" &&
            (phrase.pattern.source.includes("training") || phrase.pattern.source.includes("details are") || phrase.pattern.source.includes("available")),
        ),
      );
    },
  },
  {
    id: 21,
    name: "Sycophantic tone",
    category: "communication",
    description: 'People-pleasing phrases like "Great question!" or "You are absolutely right".',
    weight: 4,
    detect(text) {
      return scanPhrases(
        text,
        AI_PHRASES.filter(
          (phrase) =>
            phrase.fix &&
            (phrase.fix.includes("(remove)") || phrase.fix.includes("address the substance")) &&
            (phrase.pattern.source.includes("question") ||
              phrase.pattern.source.includes("point") ||
              phrase.pattern.source.includes("right") ||
              phrase.pattern.source.includes("observation")),
        ),
      );
    },
  },
  {
    id: 22,
    name: "Filler phrases",
    category: "filler",
    description: "Wordy filler that has shorter equivalents.",
    weight: 3,
    detect(text) {
      return scanPhrases(
        text,
        AI_PHRASES.filter(
          (phrase) =>
            phrase.fix &&
            !phrase.fix.startsWith("(") &&
            ["to", "because", "now", "if", "can", "to / for", "first", "finally", "for / regarding", "because / since"].includes(phrase.fix),
        ),
      );
    },
  },
  {
    id: 23,
    name: "Excessive hedging",
    category: "filler",
    description: "Stacked qualifiers and hedging verbs.",
    weight: 3,
    detect(text) {
      return scanPhrases(
        text,
        AI_PHRASES.filter(
          (phrase) =>
            phrase.fix &&
            (phrase.fix.includes("could") || phrase.fix.includes("might") || phrase.fix.includes("may") || phrase.fix.includes("perhaps") || phrase.fix.includes("maybe")),
        ),
      );
    },
  },
  {
    id: 24,
    name: "Generic conclusions",
    category: "filler",
    description: "Vague upbeat endings with little information.",
    weight: 3,
    detect(text) {
      return scanPhrases(
        text,
        AI_PHRASES.filter(
          (phrase) =>
            phrase.fix &&
            (phrase.fix.includes("specific fact") ||
              phrase.fix.includes("concrete") ||
              phrase.fix.includes("cite evidence") ||
              phrase.fix.includes("what you do know") ||
              phrase.fix.includes("what happens next")),
        ),
      );
    },
  },
  {
    id: 25,
    name: "Reasoning chain artifacts",
    category: "communication",
    description: "Exposed step-by-step reasoning scaffolding.",
    weight: 4,
    detect(text) {
      const reasoningPatterns = [
        /\blet me think( about this| through this| step by step)?\b/gi,
        /\blet's (think|reason|work) (about|through|this out)\b/gi,
        /\bbreaking (this|it) down\b/gi,
        /\bto approach this (systematically|methodically|logically)\b/gi,
        /\breasoning through (this|the problem|it)\b/gi,
        /\bworking through the logic\b/gi,
        /\bstep ([1-9]|one|two|three|four|five):/gi,
        /\bfirst,? let'?s consider\b/gi,
        /\bthinking about this (carefully|logically|systematically)\b/gi,
        /\bhere'?s my (thought process|reasoning|thinking)\b/gi,
      ];
      return reasoningPatterns.flatMap((regex) =>
        findMatches(text, regex, 'Hide reasoning or make it natural: "Here\'s my take:" instead of "Let me think step by step:"'),
      );
    },
  },
  {
    id: 26,
    name: "Excessive structure",
    category: "style",
    description: "Too many headers or list items for short content.",
    weight: 3,
    detect(text) {
      const results: PatternMatch[] = [];
      const words = wordCount(text);
      const headers = (text.match(/^#{1,6}\s+.+$/gm) || []).length;
      const bullets = (text.match(/^[\s]*[-*+]\s+/gm) || []).length;
      const numbered = (text.match(/^[\s]*\d+\.\s+/gm) || []).length;

      if (words < 300 && headers >= 3) {
        results.push({ match: `${headers} headers in ${words} words`, index: 0, line: 1, column: 1, suggestion: "Too many headers for short content. Use prose instead.", confidence: "medium" });
      }
      if (words < 200 && bullets + numbered >= 8) {
        results.push({ match: `${bullets + numbered} list items in ${words} words`, index: 0, line: 1, column: 1, suggestion: "Excessive lists. Could this be a paragraph instead?", confidence: "medium" });
      }
      results.push(
        ...findMatches(
          text,
          /^#+\s*(overview|key (points|takeaways)|summary|conclusion|introduction|background)\s*:?\s*$/gim,
          "Formulaic structure. Let content flow naturally.",
          "medium",
        ),
      );
      return results;
    },
  },
  {
    id: 27,
    name: "Confidence calibration",
    category: "communication",
    description: "Artificially hedged or overconfident prefacing.",
    weight: 3,
    detect(text) {
      const calibrationPatterns = [
        { regex: /\bI'?m confident (that|in)\b/gi, fix: "State the fact without prefacing confidence" },
        { regex: /\bit'?s worth (noting|mentioning|pointing out) that\b/gi, fix: "Just say it" },
        { regex: /\binterestingly (enough)?,?\b/gi, fix: "Let reader decide if interesting" },
        { regex: /\bsurprisingly,?\s/gi, fix: "State the fact; surprise is implied" },
        { regex: /\bimportantly,?\s/gi, fix: "Let reader judge importance" },
        { regex: /\bsignificantly,?\s/gi, fix: "Be specific about the significance" },
        { regex: /\bnotably,?\s/gi, fix: "Just state the notable thing" },
        { regex: /\bcertainly,?\s/gi, fix: "Remove or state with evidence" },
        { regex: /\bundoubtedly,?\s/gi, fix: "Remove or cite evidence" },
        { regex: /\bwithout (a )?doubt,?\s/gi, fix: "Remove or cite evidence" },
      ];
      return calibrationPatterns.flatMap(({ regex, fix }) => findMatches(text, regex, fix));
    },
  },
  {
    id: 28,
    name: "Acknowledgment loops",
    category: "communication",
    description: "Restating the user question before answering it.",
    weight: 4,
    detect(text) {
      const acknowledgmentPatterns = [
        /\byou'?re asking (about|whether|if|how|why|what)\b/gi,
        /\bthe question of (whether|how|why|what)\b/gi,
        /\bwhen it comes to your question\b/gi,
        /\bin (terms of|response to|answer to) your question\b/gi,
        /\bto (answer|address) your question\b/gi,
        /\byour question (about|regarding|concerning)\b/gi,
        /\bthat'?s a (great|good|interesting) question\. (the|it|so)\b/gi,
        /\bI understand you'?re (asking|wondering|curious)\b/gi,
      ];
      return acknowledgmentPatterns.flatMap((regex) =>
        findMatches(text, regex, "Just answer. Don't restate the question."),
      );
    },
  },
  {
    id: 29,
    name: "Invisible unicode obfuscation",
    category: "style",
    description: "Hidden unicode characters that distort or game text.",
    weight: 4,
    detect(text) {
      const results = findMatches(
        text,
        HIDDEN_UNICODE_CHARS_GLOBAL,
        "Remove hidden unicode characters. Some tools insert these to game detectors.",
        "high",
      );
      const nbspMatches = findMatches(
        text,
        NON_BREAKING_SPACES_GLOBAL,
        "Replace non-breaking spaces with regular spaces unless formatting requires them.",
        "medium",
      );
      if (nbspMatches.length >= 2) results.push(...nbspMatches);
      return results;
    },
  },
];

function calculatePatternScore(findings: PatternFinding[], words: number): number {
  if (words === 0 || findings.length === 0) return 0;

  let weightedTotal = 0;
  for (const finding of findings) weightedTotal += finding.matchCount * finding.weight;

  const density = (weightedTotal / words) * 100;
  const densityScore = Math.min(Math.log2(density + 1) * 13, 65);
  const breadthBonus = Math.min(findings.length * 2, 20);
  const categoriesHit = new Set(findings.map((finding) => finding.category)).size;
  const categoryBonus = Math.min(categoriesHit * 3, 15);
  return Math.min(Math.round(densityScore + breadthBonus + categoryBonus), 100);
}

function calculateCompositeScore(patternScore: number, uniformityScore: number, findings: PatternFinding[]): number {
  if (patternScore === 0 && uniformityScore === 0) return 0;
  if (findings.length === 0) return Math.min(Math.round(uniformityScore * 0.15), 15);
  return Math.min(Math.round(patternScore * 0.7 + uniformityScore * 0.3), 100);
}

function buildSummary(
  finalScore: number,
  totalMatches: number,
  findings: PatternFinding[],
  words: number,
  stats: AnalysisStats | null,
): string {
  if (totalMatches === 0 && finalScore < 10) {
    return "No significant AI writing patterns detected. The text looks human-written.";
  }

  const level =
    finalScore >= 70
      ? "heavily AI-generated"
      : finalScore >= 45
        ? "moderately AI-influenced"
        : finalScore >= 20
          ? "lightly AI-touched"
          : "mostly human-sounding";

  const topPatterns = [...findings]
    .sort((a, b) => b.matchCount * b.weight - a.matchCount * a.weight)
    .slice(0, 3)
    .map((finding) => finding.patternName);

  let summary = `Score: ${finalScore}/100 (${level}). Found ${totalMatches} matches across ${findings.length} pattern types in ${words} words.`;
  if (topPatterns.length > 0) summary += ` Top issues: ${topPatterns.join(", ")}.`;

  if (stats && stats.sentenceCount > 3) {
    if (stats.burstiness < 0.25) summary += " Sentence rhythm is very uniform (low burstiness) — typical of AI text.";
    if (stats.typeTokenRatio < 0.4 && words > 100) summary += " Vocabulary diversity is low.";
  }

  return summary;
}

function analyze(text: string, opts: { verbose?: boolean; patternsToCheck?: number[] | null; includeStats?: boolean } = {}): AnalysisResult {
  const { verbose = false, patternsToCheck = null, includeStats = true } = opts;
  if (!text || typeof text !== "string") return emptyAnalysis();
  const trimmed = text.trim();
  if (trimmed.length === 0) return emptyAnalysis();

  const words = wordCount(trimmed);
  const stats = includeStats ? computeStats(trimmed) : null;
  const uniformityScore =
    stats && stats.wordCount >= 20 && stats.sentenceCount >= 3 ? computeUniformityScore(stats) : 0;

  const findings: PatternFinding[] = [];
  const categoryScores: Record<Category, CategoryScore> = {
    content: { matches: 0, weightedScore: 0, patterns: [] },
    language: { matches: 0, weightedScore: 0, patterns: [] },
    style: { matches: 0, weightedScore: 0, patterns: [] },
    communication: { matches: 0, weightedScore: 0, patterns: [] },
    filler: { matches: 0, weightedScore: 0, patterns: [] },
  };

  const activePatterns = patternsToCheck ? patterns.filter((pattern) => patternsToCheck.includes(pattern.id)) : patterns;
  for (const pattern of activePatterns) {
    const matches = pattern.detect(trimmed);
    if (matches.length === 0) continue;
    findings.push({
      patternId: pattern.id,
      patternName: pattern.name,
      category: pattern.category,
      description: pattern.description,
      weight: pattern.weight,
      matchCount: matches.length,
      matches: verbose ? matches : matches.slice(0, 5),
      truncated: !verbose && matches.length > 5,
    });
    categoryScores[pattern.category].matches += matches.length;
    categoryScores[pattern.category].weightedScore += matches.length * pattern.weight;
    categoryScores[pattern.category].patterns.push(pattern.name);
  }

  const patternScore = calculatePatternScore(findings, words);
  const score = calculateCompositeScore(patternScore, uniformityScore, findings);
  const categories = {
    content: {
      label: CATEGORY_LABELS.content,
      matches: categoryScores.content.matches,
      weightedScore: categoryScores.content.weightedScore,
      patternsDetected: categoryScores.content.patterns,
    },
    language: {
      label: CATEGORY_LABELS.language,
      matches: categoryScores.language.matches,
      weightedScore: categoryScores.language.weightedScore,
      patternsDetected: categoryScores.language.patterns,
    },
    style: {
      label: CATEGORY_LABELS.style,
      matches: categoryScores.style.matches,
      weightedScore: categoryScores.style.weightedScore,
      patternsDetected: categoryScores.style.patterns,
    },
    communication: {
      label: CATEGORY_LABELS.communication,
      matches: categoryScores.communication.matches,
      weightedScore: categoryScores.communication.weightedScore,
      patternsDetected: categoryScores.communication.patterns,
    },
    filler: {
      label: CATEGORY_LABELS.filler,
      matches: categoryScores.filler.matches,
      weightedScore: categoryScores.filler.weightedScore,
      patternsDetected: categoryScores.filler.patterns,
    },
  };

  const totalMatches = findings.reduce((sum, finding) => sum + finding.matchCount, 0);
  return {
    score,
    patternScore,
    uniformityScore,
    totalMatches,
    wordCount: words,
    stats,
    categories,
    findings,
    summary: buildSummary(score, totalMatches, findings, words, stats),
  };
}

function autoFix(text: string): { text: string; fixes: string[] } {
  let result = text;
  const fixes: string[] = [];

  if (/[\u201C\u201D]/.test(result)) {
    result = result.replace(/[\u201C\u201D]/g, '"');
    fixes.push("Replaced curly double quotes with straight quotes");
  }
  if (/[\u2018\u2019]/.test(result)) {
    result = result.replace(/[\u2018\u2019]/g, "'");
    fixes.push("Replaced curly single quotes with straight quotes");
  }
  if (HIDDEN_UNICODE_CHARS.test(result)) {
    result = result.replace(HIDDEN_UNICODE_CHARS_GLOBAL, "");
    fixes.push("Removed hidden unicode characters (zero-width/soft hyphen)");
  }
  if (NON_BREAKING_SPACES.test(result)) {
    result = result.replace(NON_BREAKING_SPACES_GLOBAL, " ");
    fixes.push("Normalized non-breaking spaces to regular spaces");
  }

  const safeFills = [
    { from: /\bin order to\b/gi, to: "to", label: '"in order to" -> "to"' },
    { from: /\bdue to the fact that\b/gi, to: "because", label: '"due to the fact that" -> "because"' },
    { from: /\bat this point in time\b/gi, to: "now", label: '"at this point in time" -> "now"' },
    { from: /\bin the event that\b/gi, to: "if", label: '"in the event that" -> "if"' },
    { from: /\bhas the ability to\b/gi, to: "can", label: '"has the ability to" -> "can"' },
    { from: /\bfor the purpose of\b/gi, to: "to", label: '"for the purpose of" -> "to"' },
    { from: /\bfirst and foremost\b/gi, to: "first", label: '"first and foremost" -> "first"' },
    { from: /\bin light of the fact that\b/gi, to: "because", label: '"in light of the fact that" -> "because"' },
    { from: /\bin the realm of\b/gi, to: "in", label: '"in the realm of" -> "in"' },
    { from: /\butilize\b/gi, to: "use", label: '"utilize" -> "use"' },
    { from: /\butilizing\b/gi, to: "using", label: '"utilizing" -> "using"' },
    { from: /\butilization\b/gi, to: "use", label: '"utilization" -> "use"' },
  ];

  for (const { from, to, label } of safeFills) {
    if (from.test(result)) {
      result = result.replace(from, to);
      fixes.push(label);
    }
  }

  const chatbotStart = [
    /^(Here is|Here's) (a |an |the )?(comprehensive |brief |quick )?(overview|summary|breakdown|list|guide|explanation|look)[^.]*\.\s*/i,
    /^(Of course|Certainly|Absolutely|Sure)!\s*/i,
    /^(Great|Excellent|Good|Wonderful|Fantastic) question!\s*/i,
    /^(That's|That is) a (great|excellent|good|wonderful|fantastic) (question|point)!\s*/i,
  ];
  for (const regex of chatbotStart) {
    if (regex.test(result)) {
      result = result.replace(regex, "");
      fixes.push("Removed chatbot opening artifact");
    }
  }

  const chatbotEnd = [
    /\s*(I hope this helps|Let me know if you('d| would) like|Feel free to|Don't hesitate to|Is there anything else)[^.]*[.!]\s*$/i,
    /\s*Happy to help[.!]?\s*$/i,
  ];
  for (const regex of chatbotEnd) {
    if (regex.test(result)) {
      result = result.replace(regex, "");
      fixes.push("Removed chatbot closing artifact");
    }
  }

  return { text: result.trim(), fixes };
}

function buildGuidance(analysis: AnalysisResult): string[] {
  const tips: string[] = [];
  const ids = new Set(analysis.findings.map((finding) => finding.patternId));

  if (ids.has(1) || ids.has(4)) tips.push("Replace inflated or promotional language with concrete facts. Use dates, names, numbers, and direct claims.");
  if (ids.has(3)) tips.push("Cut trailing -ing phrases. If the point matters, give it its own sentence.");
  if (ids.has(5)) tips.push('Name your sources. "Experts say" is empty unless you say who, when, and where.');
  if (ids.has(6)) tips.push('Replace formulaic "despite challenges" language with specific problems and outcomes.');
  if (ids.has(7)) tips.push('Swap AI-coded vocabulary for plainer words. Prefer exact wording over elevated synonyms.');
  if (ids.has(8)) tips.push('Use "is" and "has" freely. "Serves as" and "boasts" are usually worse.');
  if (ids.has(9)) tips.push('Drop "not just X, it is Y" frames. Just say what the thing is.');
  if (ids.has(10)) tips.push("Break up triads. You do not need three items every time.");
  if (ids.has(13)) tips.push("Do not use em dashes. Replace every em dash with a period, comma, colon, semicolon, or parentheses.");
  if (ids.has(14) || ids.has(15)) tips.push("Strip mechanical bold formatting and inline-header lists. Let the prose do the work.");
  if (ids.has(17)) tips.push("Remove emojis from professional text. They read like chatbot decoration.");
  if (ids.has(19) || ids.has(21)) tips.push('Remove chatbot filler like "I hope this helps" and "Great question".');
  if (ids.has(20)) tips.push("Delete knowledge-cutoff disclaimers. Research the claim or leave it out.");
  if (ids.has(22) || ids.has(23)) tips.push('Trim filler and hedging. "In order to" becomes "to"; one qualifier per claim is enough.');
  if (ids.has(24)) tips.push('Cut generic conclusions. End on a concrete fact instead of "the future looks bright".');
  if (ids.has(29)) tips.push("Remove hidden unicode characters. They hurt readability and look like detector-gaming.");
  if (analysis.score >= 50) tips.push("Consider rewriting from scratch. When the patterns are dense, the structure itself usually needs to change.");

  return tips;
}

function buildStyleTips(stats: AnalysisStats): StyleTip[] {
  const tips: StyleTip[] = [];
  if (stats.burstiness < 0.25 && stats.sentenceCount > 4) {
    tips.push({
      metric: "burstiness",
      value: stats.burstiness,
      tip: "Sentence rhythm is very uniform. Mix short punchy sentences with longer ones.",
    });
  }
  if (stats.sentenceLengthVariation < 0.3 && stats.sentenceCount > 4) {
    tips.push({
      metric: "sentenceLengthVariation",
      value: stats.sentenceLengthVariation,
      tip: `Sentences are all roughly ${Math.round(stats.avgSentenceLength)} words. Vary the rhythm.`,
    });
  }
  if (stats.avgSentenceLength > 28) {
    tips.push({
      metric: "avgSentenceLength",
      value: stats.avgSentenceLength,
      tip: "Average sentence length is high. Break some into shorter lines.",
    });
  }
  if (stats.typeTokenRatio < 0.4 && stats.wordCount > 100) {
    tips.push({
      metric: "typeTokenRatio",
      value: stats.typeTokenRatio,
      tip: "Vocabulary is repetitive. Use more variety, but avoid obvious synonym cycling.",
    });
  }
  if (stats.trigramRepetition > 0.1 && stats.wordCount > 100) {
    tips.push({
      metric: "trigramRepetition",
      value: stats.trigramRepetition,
      tip: "Repeated three-word phrases suggest repetitive structure. Vary sentence construction.",
    });
  }
  if (tips.length >= 2) {
    tips.push({ metric: "general", value: null, tip: "Read it out loud. If it sounds robotic, rewrite until it sounds like something you would actually say." });
    tips.push({ metric: "general", value: null, tip: 'Add point of view where appropriate: "I found", "we noticed", "in my experience".' });
  }
  return tips;
}

function humanize(text: string, opts: { autofix?: boolean; includeStats?: boolean } = {}): HumanizeResult {
  const { autofix: applyAutofix = false, includeStats = true } = opts;
  const analysis = analyze(text, { verbose: true, includeStats });

  const critical: HumanizeSuggestion[] = [];
  const important: HumanizeSuggestion[] = [];
  const minor: HumanizeSuggestion[] = [];

  for (const finding of analysis.findings) {
    const suggestions = finding.matches.map((match) => ({
      pattern: finding.patternName,
      patternId: finding.patternId,
      category: finding.category,
      weight: finding.weight,
      text: match.match,
      line: match.line,
      column: match.column,
      suggestion: match.suggestion,
      confidence: match.confidence,
    }));

    if (finding.weight >= 4) critical.push(...suggestions);
    else if (finding.weight >= 2) important.push(...suggestions);
    else minor.push(...suggestions);
  }

  const autofixResult = applyAutofix ? autoFix(text) : null;

  return {
    score: analysis.score,
    patternScore: analysis.patternScore,
    uniformityScore: analysis.uniformityScore,
    wordCount: analysis.wordCount,
    totalIssues: analysis.totalMatches,
    stats: analysis.stats,
    critical,
    important,
    minor,
    autofix: applyAutofix ? autofixResult : null,
    guidance: buildGuidance(analysis),
    styleTips: includeStats && analysis.stats ? buildStyleTips(analysis.stats) : [],
  };
}

export const humanizeToolDefinition: ToolDefinition = {
  name: "humanize",
  description:
    "Inspect text for AI-writing patterns and return one unified report: score, analysis, findings, and revision instructions. " +
    "This tool is diagnostic by default: it reports issues in the provided text and does not update files or mutate the source text in place. " +
    "If autofix=true, it returns a suggested cleaned-up text in the tool output only; you must still apply any edits separately. " +
    "Accepts raw text directly or a file path. HTML/XML-like content is converted to plain text before analysis.",
  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to inspect. HTML in pasted text is stripped before analysis. Provide this or `path`.",
      },
      path: {
        type: "string",
        description: "Path to a text-like file to inspect. HTML/XML-like files are converted to plain text first. Provide this or `text`.",
      },
      autofix: {
        type: "boolean",
        description:
          "Apply safe mechanical fixes (curly quotes, filler phrases, chatbot artifacts). " +
          "Returns suggested fixed text alongside the issue report; it does not modify files or the original input. Default: false.",
      },
    },
    required: [],
  },
};

const MARKUP_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".xml",
  ".svg",
]);

const MAX_INPUT_FILE_BYTES = 200 * 1024;

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: "\"",
      apos: "'",
      nbsp: " ",
      ndash: "-",
      mdash: "-",
      hellip: "...",
      rsquo: "'",
      lsquo: "'",
      rdquo: "\"",
      ldquo: "\"",
    };

    if (normalized in named) return named[normalized];
    if (normalized.startsWith("#x")) {
      const code = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (normalized.startsWith("#")) {
      const code = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function stripMarkup(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(?:br|\/p|\/div|\/section|\/article|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  );
}

function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function looksLikeMarkup(input: string): boolean {
  return /<[a-z!/][^>]*>/i.test(input);
}

function preprocessHumanizeText(input: string): string {
  const normalized = looksLikeMarkup(input) ? stripMarkup(input) : decodeHtmlEntities(input);
  return normalizeWhitespace(normalized);
}

function loadHumanizeInput(params: Record<string, unknown>, cwd: string): string {
  const text = typeof params.text === "string" ? params.text : "";
  const filePath = typeof params.path === "string" ? params.path : "";

  if (!text && !filePath) {
    throw new Error("Provide either text or path");
  }
  if (text) {
    const textContent = preprocessHumanizeText(text);
    if (!textContent) {
      throw new Error("No analyzable text found in text input");
    }
    return textContent;
  }

  const resolved = resolveToCwd(filePath, cwd);
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    throw new Error(`${filePath} is a directory, not a file`);
  }
  if (stat.size > MAX_INPUT_FILE_BYTES) {
    throw new Error(
      `File too large for humanize (${stat.size} bytes). Limit is ${MAX_INPUT_FILE_BYTES} bytes.`,
    );
  }

  const raw = readFileSync(resolved, "utf-8");
  const extension = extname(resolved).toLowerCase();
  const textContent = MARKUP_EXTENSIONS.has(extension)
    ? preprocessHumanizeText(raw)
    : normalizeWhitespace(raw);

  if (!textContent) {
    throw new Error(`No analyzable text found in ${filePath}`);
  }

  return textContent;
}

export async function humanizeTool(params: Record<string, unknown>, cwd = process.cwd()): Promise<string> {
  const autofix = params.autofix === true;
  const text = loadHumanizeInput(params, cwd);
  return formatUnifiedHumanize(text, autofix);
}

function scoreLabel(score: number): string {
  if (score >= 76) return "🔴 Heavily AI-generated";
  if (score >= 51) return "🟠 Moderately AI-influenced";
  if (score >= 26) return "🟡 Lightly AI-touched";
  return "🟢 Mostly human-sounding";
}

function appendRevisionInstructions(
  lines: string[],
  guidance: string[],
  styleTips: StyleTip[] = [],
  options: { includeAutofixNote?: boolean } = {},
): void {
  lines.push("Revision instructions:");
  lines.push("  - This tool reports issues in the text. It does not update files or change the source input for you.");
  if (options.includeAutofixNote) {
    lines.push("  - If fixed text is returned above, treat it as a suggestion only. You still need to apply any edits separately.");
  }
  lines.push("  - Do not use em dashes at all. Replace them with a period, comma, colon, semicolon, or parentheses.");
  lines.push("  - Prefer direct, specific wording over inflated, generic, or formulaic phrasing.");
  lines.push("  - After revising, run the tool again on the updated text.");

  if (guidance.length > 0) {
    lines.push("");
    lines.push("Targeted guidance:");
    for (const tip of guidance) lines.push(`  - ${tip}`);
  }

  if (styleTips.length > 0) {
    lines.push("");
    lines.push("Style tips:");
    for (const tip of styleTips) lines.push(`  - ${tip.tip}`);
  }
}

function appendAnalysisSection(lines: string[], result: AnalysisResult): void {
  lines.push(`Score: ${result.score}/100 ${scoreLabel(result.score)}`);
  lines.push(`Pattern: ${result.patternScore} | Uniformity: ${result.uniformityScore} | Matches: ${result.totalMatches} | Words: ${result.wordCount}`);
  lines.push("");

  if (result.stats) {
    const stats = result.stats;
    lines.push("Statistics:");
    lines.push(`  Burstiness: ${stats.burstiness} (${stats.burstiness >= 0.45 ? "human-like" : stats.burstiness >= 0.25 ? "moderate" : "AI-like uniformity"})`);
    lines.push(`  Vocabulary diversity (TTR): ${stats.typeTokenRatio}`);
    lines.push(`  Avg sentence length: ${stats.avgSentenceLength} words`);
    lines.push(`  Trigram repetition: ${stats.trigramRepetition}`);
    lines.push(`  Readability (FK grade): ${stats.fleschKincaid}`);
    lines.push("");
  }

  const activeCategories = Object.entries(result.categories).filter(([, data]) => data.matches > 0);
  if (activeCategories.length > 0) {
    lines.push("Categories:");
    for (const [, data] of activeCategories) {
      lines.push(`  ${data.label}: ${data.matches} matches (${data.patternsDetected.join(", ")})`);
    }
    lines.push("");
  }

  if (result.findings.length > 0) {
    lines.push("Findings:");
    for (const finding of result.findings) {
      lines.push(`  [${finding.patternId}] ${finding.patternName} (x${finding.matchCount}, weight ${finding.weight})`);
      for (const match of finding.matches.slice(0, 3)) {
        lines.push(`    "${match.match.slice(0, 80)}"${match.suggestion ? ` -> ${match.suggestion}` : ""}`);
      }
      if (finding.matchCount > 3) lines.push(`    ... and ${finding.matchCount - 3} more`);
    }
    lines.push("");
  }

  lines.push("Summary:");
  lines.push(result.summary);
}

function appendHumanizeSection(lines: string[], result: HumanizeResult, autofix: boolean): void {
  lines.push("");
  lines.push(`AI Score: ${result.score}/100 ${scoreLabel(result.score)}`);
  lines.push(`Issues: ${result.totalIssues} | Pattern: ${result.patternScore} | Uniformity: ${result.uniformityScore}`);
  lines.push("");

  if (result.critical.length > 0) {
    lines.push("CRITICAL (dead giveaways):");
    for (const suggestion of result.critical.slice(0, 10)) {
      lines.push(`  [${suggestion.pattern}] "${suggestion.text.slice(0, 60)}"`);
      if (suggestion.suggestion) lines.push(`    -> ${suggestion.suggestion}`);
    }
    if (result.critical.length > 10) lines.push(`  ... and ${result.critical.length - 10} more`);
    lines.push("");
  }

  if (result.important.length > 0) {
    lines.push("IMPORTANT (noticeable patterns):");
    for (const suggestion of result.important.slice(0, 10)) {
      lines.push(`  [${suggestion.pattern}] "${suggestion.text.slice(0, 60)}"`);
      if (suggestion.suggestion) lines.push(`    -> ${suggestion.suggestion}`);
    }
    if (result.important.length > 10) lines.push(`  ... and ${result.important.length - 10} more`);
    lines.push("");
  }

  if (result.minor.length > 0) {
    lines.push(`MINOR: ${result.minor.length} subtle tells`);
    lines.push("");
  }

  if (result.autofix && result.autofix.fixes.length > 0) {
    lines.push("AUTO-FIX SUGGESTIONS:");
    for (const fix of result.autofix.fixes) lines.push(`  ✓ ${fix}`);
    lines.push("");
    lines.push("Suggested fixed text:");
    lines.push(result.autofix.text);
    lines.push("");
  }

  appendRevisionInstructions(lines, result.guidance, result.styleTips, { includeAutofixNote: autofix });
}

function formatUnifiedHumanize(text: string, autofix: boolean): string {
  const result = analyze(text, { verbose: false, includeStats: true });
  const lines: string[] = [];
  const humanized = humanize(text, { autofix, includeStats: true });

  appendAnalysisSection(lines, result);
  appendHumanizeSection(lines, humanized, autofix);
  return lines.join("\n");
}
