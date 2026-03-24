/**
 * Knowledge graph: entity relationships extracted from text
 */

export interface Relationship {
  entity1: string;
  entity1Type: string;
  relation: string;
  entity2: string;
  entity2Type: string;
  sourceChunkId: number;
  confidence: number;
}

const RELATION_PATTERNS = [
  {
    regex: /(\w+)\s+(teaches|works on|owns|uses|deployed on|manages|created|built|maintains|develops)\s+(.+)/gi,
    extract: (match: RegExpMatchArray, chunkId: number): Relationship | null => {
      const entity1 = match[1].trim();
      const relation = match[2].toLowerCase().trim();
      const entity2 = match[3].trim().split(/[,;.]/)[0].trim();
      if (entity2.length < 2 || entity2.length > 50) return null;
      return {
        entity1, entity1Type: guessEntityType(entity1),
        relation,
        entity2, entity2Type: guessEntityType(entity2),
        sourceChunkId: chunkId, confidence: 0.7,
      };
    },
  },
  {
    regex: /(\b\w[\w\s-]{0,30}\w)\s*→\s*(\w[\w\s-]{0,30}\w)/gi,
    extract: (match: RegExpMatchArray, chunkId: number): Relationship | null => {
      const entity1 = match[1].trim();
      const entity2 = match[2].trim();
      const type1 = guessEntityType(entity1);
      const type2 = guessEntityType(entity2);
      if (type1 === "concept" && type2 === "concept") return null;
      return {
        entity1, entity1Type: type1,
        relation: "connects-to",
        entity2, entity2Type: type2,
        sourceChunkId: chunkId, confidence: 0.5,
      };
    },
  },
  {
    regex: /(\w+)\s+is\s+(\w+)'s\s+(.+)/gi,
    extract: (match: RegExpMatchArray, chunkId: number): Relationship | null => {
      const entity1 = match[1].trim();
      const entity2 = match[2].trim();
      const relation = match[3].trim().split(/[,;.]/)[0].trim();
      if (relation.length > 30) return null;
      return {
        entity1, entity1Type: guessEntityType(entity1),
        relation,
        entity2, entity2Type: guessEntityType(entity2),
        sourceChunkId: chunkId, confidence: 0.7,
      };
    },
  },
];

export function extractRelationships(text: string, chunkId: number): Relationship[] {
  const relationships: Relationship[] = [];
  const seen = new Set<string>();

  for (const pattern of RELATION_PATTERNS) {
    const matches = Array.from(text.matchAll(pattern.regex));
    
    for (const match of matches) {
      const rel = pattern.extract(match, chunkId);
      if (!rel) continue;

      const key = `${rel.entity1.toLowerCase()}:${rel.relation}:${rel.entity2.toLowerCase()}`;
      if (seen.has(key)) continue;

      relationships.push(rel);
      seen.add(key);
      if (relationships.length >= 20) break;
    }
  }

  return relationships;
}

function guessEntityType(entity: string): string {
  const lower = entity.toLowerCase();

  if (["rafe", "marcus", "virt", "lobs", "andrea"].includes(lower)) return "person";
  if (["paw", "nexus", "lobs-memory", "lobs-core", "flock", "bot-shared",
       "paw-hub", "paw-portal", "ship-api", "lobs-sail", "lobs-sets-sail"].includes(lower)) return "project";
  if (["lobs", "lm studio", "docker", "tailscale", "github", "discord",
       "cloudflare", "sqlite", "bun", "vite", "react"].includes(lower)) return "tool";

  if (entity.match(/^[A-Z][a-z]+$/)) return "person";
  if (entity.match(/^[a-z-]+$/)) return "project";
  if (entity.match(/[A-Z]{2,}/)) return "tool";

  return "concept";
}
