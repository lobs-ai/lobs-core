/**
 * group-message-command.ts
 *
 * TypeScript parser for the 'group message [person1] [person2]...' command syntax.
 *
 * Mirrors app/group_message_command.py in lobs-server.
 *
 * Handles natural-language variants:
 *   group message Alice Bob
 *   group message Alice, Bob, and Carol about Q2 roadmap
 *   group message @Alice @Bob re: launch planning
 *   start a group chat Alice and Bob
 *   create group channel Alice Bob
 *
 * Usage:
 *   import { isGroupMessageCommand, parseGroupMessageCommand, formatConfirmationPrompt }
 *     from './group-message-command.js';
 *
 *   if (isGroupMessageCommand(userText)) {
 *     const cmd = parseGroupMessageCommand(userText);
 *     if (!cmd.isValid) { reply(cmd.error); return; }
 *     reply(formatConfirmationPrompt(cmd));
 *   }
 */

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface GroupMessageCommand {
  /** List of recipient name strings (display names as typed by user). */
  recipients: string[];
  /** Optional topic extracted from "about ...", "re: ...", etc. */
  topic: string | null;
  /** Original unmodified input string. */
  raw: string;
  /** True when at least 2 recipients were found. */
  isValid: boolean;
  /** Human-readable error if isValid is false. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Trigger patterns
// ---------------------------------------------------------------------------

const COMMAND_PREFIXES = [
  "group\\s+message",
  "start\\s+(?:a\\s+)?group\\s+(?:chat|message|channel|thread)",
  "create\\s+(?:a\\s+)?group\\s+(?:chat|channel|thread)",
  "open\\s+(?:a\\s+)?group\\s+(?:chat|channel)",
  "set\\s+up\\s+(?:a\\s+)?group\\s+(?:chat|channel)",
  "message\\s+(?:everyone|the\\s+group)",
];

const PREFIX_PATTERN = new RegExp(
  `^\\s*(?:${COMMAND_PREFIXES.join("|")})\\s*`,
  "i",
);

const TOPIC_SEPARATORS = [
  "\\babout\\b",
  "\\bre:\\s*",
  "\\bregarding\\b",
  "\\bconcerning\\b",
  "\\bto\\s+(?:discuss|talk\\s+about|chat\\s+about)\\b",
  "\\bfor\\b",
];

const TOPIC_SEP_PATTERN = new RegExp(
  `\\s+(?:${TOPIC_SEPARATORS.join("|")})\\s+`,
  "i",
);

const CONJUNCTIONS = new Set(["and", "with", "also", "&"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return true if the input looks like a group message command.
 * Use this for a quick intent check before calling parseGroupMessageCommand.
 */
export function isGroupMessageCommand(text: string): boolean {
  return PREFIX_PATTERN.test(text.trim());
}

/**
 * Parse a natural-language group message command into structured data.
 *
 * Returns a GroupMessageCommand. If fewer than 2 recipients are found,
 * isValid=false and error explains why.
 */
export function parseGroupMessageCommand(text: string): GroupMessageCommand {
  const raw = text.trim();

  // 1. Strip command prefix
  let remainder = raw.replace(PREFIX_PATTERN, "").trim();

  if (!remainder) {
    return {
      recipients: [],
      topic: null,
      raw,
      isValid: false,
      error: "No recipients specified. Usage: group message [name1] [name2] ...",
    };
  }

  // 2. Split off topic (if present)
  let topic: string | null = null;
  const topicMatch = TOPIC_SEP_PATTERN.exec(remainder);
  if (topicMatch) {
    topic = remainder.slice(topicMatch.index + topicMatch[0].length).trim() || null;
    remainder = remainder.slice(0, topicMatch.index).trim();
  }

  // 3. Parse recipient names
  const recipients = parseRecipients(remainder);

  if (recipients.length === 0) {
    return {
      recipients: [],
      topic,
      raw,
      isValid: false,
      error: "No recipients found. Usage: group message Alice Bob [about topic]",
    };
  }

  if (recipients.length === 1) {
    return {
      recipients,
      topic,
      raw,
      isValid: false,
      error: `Group messages need at least 2 recipients. Found: '${recipients[0]}'. Add more names.`,
    };
  }

  return { recipients, topic, raw, isValid: true, error: null };
}

/**
 * Build a human-readable confirmation string for the agent to present before
 * creating a channel or sending a message.
 *
 * Example: "Create a group channel for Alice, Bob, and Carol about 'Q2 roadmap'?"
 */
export function formatConfirmationPrompt(cmd: GroupMessageCommand): string {
  const names = oxfordComma(cmd.recipients);
  if (cmd.topic) {
    return `Create a group channel for ${names} about '${cmd.topic}'?`;
  }
  return `Create a group channel for ${names}?`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseRecipients(text: string): string[] {
  // Replace commas with spaces then split on whitespace runs
  const tokens = text.replace(/,/g, " ").trim().split(/\s+/);

  const recipients: string[] = [];
  for (let token of tokens) {
    token = token.trim();
    if (!token) continue;
    // Strip leading @ (Discord mention style)
    token = token.replace(/^@/, "");
    // Drop conjunctions
    if (CONJUNCTIONS.has(token.toLowerCase())) continue;
    if (!token) continue;
    recipients.push(token);
  }

  // Deduplicate while preserving order
  const seen = new Set<string>();
  return recipients.filter(r => {
    const key = r.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function oxfordComma(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
