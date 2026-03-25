/**
 * Voice conversation transcript — rolling context for Claude prompts
 *
 * Maintains a bounded list of who said what in the voice call,
 * formatted for inclusion in Claude system/user messages.
 */

import type { TranscriptEntry, TriggerMode } from "./types.js";

export class VoiceTranscript {
  private entries: TranscriptEntry[] = [];
  private maxExchanges: number;
  private triggerMode: TriggerMode;
  private triggerWords: string[];

  /** Map of user IDs to display names (populated as users speak) */
  private userNames = new Map<string, string>();

  constructor(maxExchanges: number, triggerMode: TriggerMode, triggerWords: string[]) {
    this.maxExchanges = maxExchanges;
    this.triggerMode = triggerMode;
    this.triggerWords = triggerWords.map(w => w.toLowerCase());
  }

  /** Add a user utterance to the transcript */
  addUserUtterance(userId: string, displayName: string, text: string): void {
    this.userNames.set(userId, displayName);
    this.entries.push({
      role: "user",
      userId,
      displayName,
      text,
      timestamp: Date.now(),
    });
    this.trim();
  }

  /** Add Lobs's response to the transcript */
  addAssistantResponse(text: string): void {
    this.entries.push({
      role: "assistant",
      text,
      timestamp: Date.now(),
    });
    this.trim();
  }

  /**
   * Check if text contains a trigger word.
   * Returns the text with the trigger word stripped if found, or null if no trigger.
   */
  checkTrigger(text: string): string | null {
    if (this.triggerMode === "always") {
      return text;
    }

    const lower = text.toLowerCase().trim();

    for (const trigger of this.triggerWords) {
      // Check if utterance starts with trigger word
      if (lower.startsWith(trigger)) {
        const remainder = text.slice(trigger.length).trim();
        // If just the trigger word alone, still trigger (user will say more)
        return remainder || "(listening)";
      }

      // Check if trigger word appears anywhere in the text
      const idx = lower.indexOf(trigger);
      if (idx !== -1) {
        // Remove the trigger word and return the rest
        const before = text.slice(0, idx).trim();
        const after = text.slice(idx + trigger.length).trim();
        return [before, after].filter(Boolean).join(" ") || "(listening)";
      }
    }

    return null; // No trigger found
  }

  /** Format transcript as context for Claude */
  toContext(): string {
    if (this.entries.length === 0) return "";

    const lines = this.entries.map(entry => {
      if (entry.role === "user") {
        return `${entry.displayName}: ${entry.text}`;
      }
      return `Lobs: ${entry.text}`;
    });

    return lines.join("\n");
  }

  /** Format as system prompt context about the voice conversation */
  toSystemContext(): string {
    const users = Array.from(this.userNames.entries())
      .map(([id, name]) => `${name} (${id})`)
      .join(", ");

    let context = "You are in a Discord voice call.";
    if (users) {
      context += ` Users present: ${users}.`;
    }
    context += " Respond naturally and concisely — you're speaking out loud, not writing.";
    context += " Keep responses short (1-3 sentences) unless asked to elaborate.";
    context += " Don't use markdown, bullet points, or formatting — this will be spoken aloud.";

    if (this.entries.length > 0) {
      context += "\n\nRecent conversation:\n" + this.toContext();
    }

    return context;
  }

  /** Get the number of entries */
  get length(): number {
    return this.entries.length;
  }

  /** Set trigger mode */
  setTriggerMode(mode: TriggerMode): void {
    this.triggerMode = mode;
  }

  /** Clear transcript */
  clear(): void {
    this.entries = [];
  }

  private trim(): void {
    // Keep last N exchanges (user + assistant pairs count as 1 exchange)
    const maxEntries = this.maxExchanges * 2;
    if (this.entries.length > maxEntries) {
      this.entries = this.entries.slice(-maxEntries);
    }
  }
}
