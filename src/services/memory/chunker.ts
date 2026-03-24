/**
 * Header-aware semantic chunking for markdown
 * Preserves heading context and splits intelligently at section/paragraph boundaries
 */

import type { ChunkingConfig } from "./types.js";

export interface ChunkResult {
  text: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

interface Section {
  heading: string;
  headingLevel: number;
  lines: string[];
  startLine: number;
  endLine: number;
}

function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  return Math.ceil(words.length * 0.75);
}

function parseMarkdownSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let currentSection: Section | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      if (currentSection) {
        currentSection.endLine = i;
        sections.push(currentSection);
      }
      currentSection = {
        heading: line,
        headingLevel: headingMatch[1].length,
        lines: [],
        startLine: i + 1,
        endLine: i + 1,
      };
    } else if (currentSection) {
      currentSection.lines.push(line);
    } else {
      if (sections.length === 0 || sections[sections.length - 1].heading !== "") {
        currentSection = {
          heading: "",
          headingLevel: 0,
          lines: [line],
          startLine: i + 1,
          endLine: i + 1,
        };
      } else {
        sections[sections.length - 1].lines.push(line);
      }
    }
  }

  if (currentSection) {
    currentSection.endLine = lines.length;
    sections.push(currentSection);
  }

  return sections;
}

function buildHeadingContext(sections: Section[], index: number, filename: string): string {
  const current = sections[index];
  if (!current.heading) return "";

  const hierarchy: string[] = [];
  
  for (let i = index; i >= 0; i--) {
    const section = sections[i];
    if (!section.heading) continue;

    if (hierarchy.length === 0 || section.headingLevel < sections[index].headingLevel) {
      const headingText = section.heading.replace(/^#+\s+/, '');
      hierarchy.unshift(headingText);
      if (section.headingLevel === 1) break;
    }
  }

  if (hierarchy.length > 0) {
    const fileBaseName = filename.split('/').pop() || filename;
    hierarchy.unshift(fileBaseName);
  }

  return hierarchy.length > 0 ? `[${hierarchy.join(' > ')}]\n` : '';
}

function splitAtParagraphs(lines: string[], targetTokens: number): string[][] {
  const paragraphs: string[][] = [];
  let currentParagraph: string[] = [];

  for (const line of lines) {
    if (line.trim() === "") {
      if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph);
        currentParagraph = [];
      }
      paragraphs.push([line]);
    } else {
      currentParagraph.push(line);
    }
  }

  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph);
  }

  const groups: string[][] = [];
  let currentGroup: string[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraText = para.join("\n");
    const paraTokens = estimateTokens(paraText);

    if (currentTokens + paraTokens > targetTokens && currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [...para];
      currentTokens = paraTokens;
    } else {
      currentGroup.push(...para);
      currentTokens += paraTokens;
    }
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups.length > 0 ? groups : [lines];
}

export function chunkMarkdown(text: string, config: ChunkingConfig, filename = ""): ChunkResult[] {
  const sections = parseMarkdownSections(text);
  const chunks: ChunkResult[] = [];
  const minTokens = 80;
  const maxTokens = 600;

  if (sections.length === 0 || sections.every(s => !s.heading)) {
    return chunkByParagraphs(text, config);
  }

  let i = 0;
  while (i < sections.length) {
    const section = sections[i];
    const sectionText = section.lines.join("\n");
    const sectionTokens = estimateTokens(sectionText);
    const contextPrefix = buildHeadingContext(sections, i, filename);

    if (sectionTokens < minTokens && i < sections.length - 1) {
      const nextSection = sections[i + 1];
      const mergedText = contextPrefix + sectionText + "\n" + nextSection.lines.join("\n");
      const mergedTokens = estimateTokens(mergedText);

      chunks.push({
        text: mergedText,
        startLine: section.startLine,
        endLine: nextSection.endLine,
        tokenCount: mergedTokens,
      });
      i += 2;
    } else if (sectionTokens > maxTokens) {
      const groups = splitAtParagraphs(section.lines, config.targetTokens);
      
      for (let j = 0; j < groups.length; j++) {
        const groupText = contextPrefix + groups[j].join("\n");
        const groupTokens = estimateTokens(groupText);
        const linesBeforeGroup = groups.slice(0, j).reduce((sum, g) => sum + g.length, 0);
        const startLine = section.startLine + linesBeforeGroup;
        const endLine = startLine + groups[j].length - 1;

        chunks.push({ text: groupText, startLine, endLine, tokenCount: groupTokens });
      }
      i++;
    } else {
      chunks.push({
        text: contextPrefix + sectionText,
        startLine: section.startLine,
        endLine: section.endLine,
        tokenCount: estimateTokens(contextPrefix + sectionText),
      });
      i++;
    }
  }

  return chunks;
}

function chunkByParagraphs(text: string, config: ChunkingConfig): ChunkResult[] {
  const lines = text.split("\n");
  const chunks: ChunkResult[] = [];
  
  const groups = splitAtParagraphs(lines, config.targetTokens);
  let currentLine = 1;

  for (const group of groups) {
    const groupText = group.join("\n");
    const tokenCount = estimateTokens(groupText);

    chunks.push({
      text: groupText,
      startLine: currentLine,
      endLine: currentLine + group.length - 1,
      tokenCount,
    });
    currentLine += group.length;
  }

  return chunks;
}

export function extractSnippet(text: string, startLine: number, endLine: number, maxLength = 200): string {
  const lines = text.split("\n").slice(startLine - 1, endLine);
  let snippet = lines.join(" ").replace(/\s+/g, " ").trim();

  const contextMatch = snippet.match(/^\[([^\]]+)\]/);
  let context = "";
  
  if (contextMatch) {
    context = contextMatch[1] + ": ";
    snippet = snippet.slice(contextMatch[0].length).trim();
  }

  if (context.length + snippet.length > maxLength) {
    const availableLength = maxLength - context.length - 3;
    snippet = snippet.slice(0, availableLength) + "...";
  }

  return context + snippet;
}

export function createCitation(path: string, startLine: number, endLine: number): string {
  if (startLine === endLine) return `${path}:${startLine}`;
  return `${path}:${startLine}-${endLine}`;
}
