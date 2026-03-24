/**
 * Entity extraction from text chunks
 * Two-phase approach: pattern-based (instant) + LLM-based (future)
 */

export interface Entity {
  type: "person" | "project" | "decision" | "todo" | "date" | "tool" | "concept";
  value: string;
  confidence: number;
}

const KNOWN_PEOPLE = ["Rafe", "Marcus", "Virt", "Lobs", "Andrea"];
const KNOWN_PROJECTS = [
  "PAW", "Nexus", "lobs-memory", "lobs-core", "Flock", "bot-shared",
  "paw-hub", "paw-portal", "ship-api", "lobs-sail", "lobs-sets-sail"
];
const KNOWN_TOOLS = [
  "lobs", "LM Studio", "Docker", "Tailscale", "GitHub", "Discord",
  "Cloudflare", "SQLite", "Bun", "Vite", "React"
];

const DECISION_PATTERNS = [
  /decision:/i, /\bdecided\b/i, /\bchose\b/i, /\bswitched to\b/i,
  /\bwent with\b/i, /\bgoing with\b/i, /\bpicked\b/i, /\bselected\b/i,
];

const TODO_PATTERNS = [
  /- \[ \]/, /\bTODO\b/, /\bFIXME\b/, /\bWIP\b/, /\bto-do\b/i,
];

const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
  /\b(tomorrow|today|yesterday)\b/i,
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
];

export function patternExtract(text: string): Entity[] {
  const entities: Entity[] = [];
  const seen = new Set<string>();

  for (const person of KNOWN_PEOPLE) {
    const regex = new RegExp(`\\b${person}\\b`, "gi");
    if (regex.test(text)) {
      const key = `person:${person.toLowerCase()}`;
      if (!seen.has(key)) {
        entities.push({ type: "person", value: person, confidence: 0.9 });
        seen.add(key);
      }
    }
  }

  for (const project of KNOWN_PROJECTS) {
    const regex = new RegExp(`\\b${project}\\b`, "gi");
    if (regex.test(text)) {
      const key = `project:${project.toLowerCase()}`;
      if (!seen.has(key)) {
        entities.push({ type: "project", value: project, confidence: 0.9 });
        seen.add(key);
      }
    }
  }

  for (const tool of KNOWN_TOOLS) {
    const regex = new RegExp(`\\b${tool}\\b`, "gi");
    if (regex.test(text)) {
      const key = `tool:${tool.toLowerCase()}`;
      if (!seen.has(key)) {
        entities.push({ type: "tool", value: tool, confidence: 0.85 });
        seen.add(key);
      }
    }
  }

  const lines = text.split("\n");
  for (const line of lines) {
    for (const pattern of DECISION_PATTERNS) {
      if (pattern.test(line)) {
        const key = `decision:${line.slice(0, 50).toLowerCase()}`;
        if (!seen.has(key)) {
          entities.push({ type: "decision", value: line.trim().slice(0, 100), confidence: 0.7 });
          seen.add(key);
        }
        break;
      }
    }
  }

  for (const line of lines) {
    for (const pattern of TODO_PATTERNS) {
      if (pattern.test(line)) {
        const key = `todo:${line.slice(0, 50).toLowerCase()}`;
        if (!seen.has(key)) {
          entities.push({ type: "todo", value: line.trim().slice(0, 100), confidence: 0.8 });
          seen.add(key);
        }
        break;
      }
    }
  }

  for (const pattern of DATE_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (const match of matches) {
        const key = `date:${match.toLowerCase()}`;
        if (!seen.has(key)) {
          entities.push({ type: "date", value: match, confidence: 0.9 });
          seen.add(key);
          if (entities.filter(e => e.type === "date").length >= 5) break;
        }
      }
    }
  }

  return entities;
}
