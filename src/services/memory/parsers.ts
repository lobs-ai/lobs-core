/**
 * Specialized parsers for non-markdown content (JSONL session files, etc.)
 */

import { basename } from "node:path";

export interface ParsedContent {
  text: string;
  format: "markdown" | "text";
}

export function parseSessionJSONL(content: string, filepath: string): ParsedContent {
  const lines = content.split("\n").filter(line => line.trim().length > 0);
  const filename = basename(filepath);
  
  const output: string[] = [`[Session: ${filename}]`, ""];
  
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      
      if (record.type !== "message" || !record.message) continue;
      
      const msg = record.message;
      const role = msg.role;
      
      if (!role || (role !== "user" && role !== "assistant")) continue;
      
      let msgContent = "";
      
      if (typeof msg.content === "string") {
        msgContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((p: any) => p.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text);
        msgContent = textParts.join("\n");
      }
      
      if (!msgContent || msgContent.trim().length === 0) continue;
      if (msgContent.startsWith("data:image/") || msgContent.startsWith("[Image:")) continue;
      
      if (msgContent.length > 500) {
        msgContent = msgContent.slice(0, 497) + "...";
      }
      
      const label = role === "user" ? "User" : "Assistant";
      output.push(`**${label}:** ${msgContent}`, "");
      
    } catch {
      continue;
    }
  }
  
  return { text: output.join("\n"), format: "markdown" };
}

export function parseFile(content: string, filepath: string): ParsedContent {
  if (filepath.endsWith(".jsonl")) {
    return parseSessionJSONL(content, filepath);
  }
  return { text: content, format: "markdown" };
}
