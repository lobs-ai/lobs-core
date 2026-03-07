/**
 * Tests for group-message-command.ts
 *
 * Mirrors test coverage in lobs-server/test_group_message_command.py
 */

import { describe, it, expect } from "vitest";
import {
  isGroupMessageCommand,
  parseGroupMessageCommand,
  formatConfirmationPrompt,
} from "../src/util/group-message-command.js";

// ---------------------------------------------------------------------------
// isGroupMessageCommand
// ---------------------------------------------------------------------------

describe("isGroupMessageCommand", () => {
  it("detects 'group message ...'", () => {
    expect(isGroupMessageCommand("group message Alice Bob")).toBe(true);
  });

  it("detects 'start a group chat ...'", () => {
    expect(isGroupMessageCommand("start a group chat Alice and Bob")).toBe(true);
  });

  it("detects 'create group channel ...'", () => {
    expect(isGroupMessageCommand("create group channel Alice Bob")).toBe(true);
  });

  it("detects 'open group chat ...'", () => {
    expect(isGroupMessageCommand("open group chat Alice Bob")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isGroupMessageCommand("Group Message Alice")).toBe(true);
    expect(isGroupMessageCommand("GROUP MESSAGE Alice")).toBe(true);
  });

  it("does NOT match unrelated text", () => {
    expect(isGroupMessageCommand("send email to Alice")).toBe(false);
    expect(isGroupMessageCommand("message Alice directly")).toBe(false);
    expect(isGroupMessageCommand("what's the weather?")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseGroupMessageCommand — valid cases
// ---------------------------------------------------------------------------

describe("parseGroupMessageCommand — valid", () => {
  it("parses two names", () => {
    const cmd = parseGroupMessageCommand("group message Alice Bob");
    expect(cmd.isValid).toBe(true);
    expect(cmd.recipients).toEqual(["Alice", "Bob"]);
    expect(cmd.topic).toBeNull();
    expect(cmd.error).toBeNull();
  });

  it("parses three names", () => {
    const cmd = parseGroupMessageCommand("group message Alice Bob Carol");
    expect(cmd.isValid).toBe(true);
    expect(cmd.recipients).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("strips conjunctions (and, with, &)", () => {
    const cmd = parseGroupMessageCommand("group message Alice and Bob");
    expect(cmd.recipients).toEqual(["Alice", "Bob"]);
  });

  it("handles comma-separated names", () => {
    const cmd = parseGroupMessageCommand("group message Alice, Bob, and Carol");
    expect(cmd.isValid).toBe(true);
    expect(cmd.recipients).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("strips @ prefixes", () => {
    const cmd = parseGroupMessageCommand("group message @Alice @Bob");
    expect(cmd.recipients).toEqual(["Alice", "Bob"]);
  });

  it("extracts topic after 'about'", () => {
    const cmd = parseGroupMessageCommand("group message Alice Bob about Q2 roadmap");
    expect(cmd.isValid).toBe(true);
    expect(cmd.recipients).toEqual(["Alice", "Bob"]);
    expect(cmd.topic).toBe("Q2 roadmap");
  });

  it("extracts topic after 're:'", () => {
    const cmd = parseGroupMessageCommand("group message Alice Bob re: launch planning");
    expect(cmd.topic).toBe("launch planning");
  });

  it("extracts topic after 'regarding'", () => {
    const cmd = parseGroupMessageCommand("group message Alice Bob regarding the meeting");
    expect(cmd.topic).toBe("the meeting");
  });

  it("handles 'start a group chat' prefix", () => {
    const cmd = parseGroupMessageCommand("start a group chat Alice and Bob");
    expect(cmd.isValid).toBe(true);
    expect(cmd.recipients).toEqual(["Alice", "Bob"]);
  });

  it("deduplicates recipients", () => {
    const cmd = parseGroupMessageCommand("group message Alice Bob Alice");
    expect(cmd.recipients).toEqual(["Alice", "Bob"]);
  });

  it("preserves raw input", () => {
    const input = "group message Alice and Bob about Q2";
    const cmd = parseGroupMessageCommand(input);
    expect(cmd.raw).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// parseGroupMessageCommand — invalid cases
// ---------------------------------------------------------------------------

describe("parseGroupMessageCommand — invalid", () => {
  it("returns error when no recipients", () => {
    const cmd = parseGroupMessageCommand("group message");
    expect(cmd.isValid).toBe(false);
    expect(cmd.error).toBeTruthy();
    expect(cmd.recipients).toHaveLength(0);
  });

  it("returns error when only one recipient", () => {
    const cmd = parseGroupMessageCommand("group message Alice");
    expect(cmd.isValid).toBe(false);
    expect(cmd.error).toContain("at least 2");
    expect(cmd.recipients).toEqual(["Alice"]);
  });

  it("error for single recipient includes the name", () => {
    const cmd = parseGroupMessageCommand("group message Bob");
    expect(cmd.error).toContain("Bob");
  });
});

// ---------------------------------------------------------------------------
// formatConfirmationPrompt
// ---------------------------------------------------------------------------

describe("formatConfirmationPrompt", () => {
  it("formats two recipients without topic", () => {
    const cmd = parseGroupMessageCommand("group message Alice Bob");
    expect(formatConfirmationPrompt(cmd)).toBe(
      "Create a group channel for Alice and Bob?"
    );
  });

  it("formats three recipients with Oxford comma", () => {
    const cmd = parseGroupMessageCommand("group message Alice Bob Carol");
    expect(formatConfirmationPrompt(cmd)).toBe(
      "Create a group channel for Alice, Bob, and Carol?"
    );
  });

  it("includes topic when present", () => {
    const cmd = parseGroupMessageCommand("group message Alice Bob about Q2 roadmap");
    expect(formatConfirmationPrompt(cmd)).toBe(
      "Create a group channel for Alice and Bob about 'Q2 roadmap'?"
    );
  });

  it("formats two recipients with topic", () => {
    const cmd = parseGroupMessageCommand("group message @Alice @Bob re: launch");
    expect(formatConfirmationPrompt(cmd)).toBe(
      "Create a group channel for Alice and Bob about 'launch'?"
    );
  });
});
