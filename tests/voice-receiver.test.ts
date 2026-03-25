/**
 * Tests for src/services/voice/receiver.ts — VoiceReceiver class
 *
 * External dependencies (@discordjs/voice, @discordjs/opus) are fully mocked.
 * The mock audio stream is a lightweight EventEmitter so we can simulate
 * "data" / "end" / "error" events without touching real Discord sockets.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Mocks (must precede imports) ──────────────────────────────────────────────

vi.mock("@discordjs/voice", () => {
  return {
    EndBehaviorType: { AfterSilence: "AfterSilence" },
    // VoiceConnection is only used as a type — no runtime class needed
  };
});

vi.mock("@discordjs/opus", () => {
  return {
    OpusEncoder: vi.fn().mockImplementation(() => ({
      decode: vi.fn((buf: Buffer) => {
        // Return a stereo 48kHz PCM stub (12 stereo samples = 48 bytes)
        return Buffer.alloc(48, 0);
      }),
    })),
  };
});

// VAD is real code but we stub it so unit tests don't depend on signal maths
vi.mock("../src/services/voice/vad.js", () => {
  return {
    VADProcessor: vi.fn().mockImplementation(() => ({
      process: vi.fn(() => false),
      isSpeaking: false,
      reset: vi.fn(),
      onSpeechStart: null,
      onSpeechEnd: null,
    })),
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { EndBehaviorType } from "@discordjs/voice";
import { VoiceReceiver } from "../src/services/voice/receiver.js";
import type { VoiceConfig, Transcription } from "../src/services/voice/types.js";
import { DEFAULT_VOICE_CONFIG } from "../src/services/voice/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal mock audio stream — behaves like a Readable with EventEmitter. */
function makeMockStream() {
  return new EventEmitter() as EventEmitter & {
    on: (event: string, listener: (...args: unknown[]) => void) => EventEmitter;
  };
}

/** Build a mock VoiceConnection whose receiver.subscribe returns the given stream. */
function makeMockConnection(stream = makeMockStream()) {
  const subscribe = vi.fn(() => stream);
  return {
    receiver: { subscribe },
    _stream: stream, // convenience handle for tests
  };
}

/** A valid VoiceConfig suitable for unit-test construction. */
const TEST_CONFIG: VoiceConfig = {
  ...DEFAULT_VOICE_CONFIG,
  enabled: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Constructor
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceReceiver — constructor", () => {
  it("constructs without throwing", () => {
    const conn = makeMockConnection();
    expect(
      () => new VoiceReceiver(conn as never, TEST_CONFIG, vi.fn()),
    ).not.toThrow();
  });

  it("stores the onTranscription callback internally", () => {
    const onT = vi.fn();
    const conn = makeMockConnection();
    // Construction itself doesn't invoke the callback
    new VoiceReceiver(conn as never, TEST_CONFIG, onT);
    expect(onT).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// subscribeUser
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceReceiver — subscribeUser", () => {
  let conn: ReturnType<typeof makeMockConnection>;
  let receiver: VoiceReceiver;

  beforeEach(() => {
    conn = makeMockConnection();
    receiver = new VoiceReceiver(conn as never, TEST_CONFIG, vi.fn());
  });

  it("calls connection.receiver.subscribe with the given userId", () => {
    receiver.subscribeUser("user-1");
    expect(conn.receiver.subscribe).toHaveBeenCalledWith("user-1", {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 2000,
      },
    });
  });

  it("registers data, end, and error listeners on the audio stream", () => {
    const stream = makeMockStream();
    conn.receiver.subscribe.mockReturnValue(stream);
    const onSpy = vi.spyOn(stream, "on");

    receiver.subscribeUser("user-2");

    const events = onSpy.mock.calls.map(([evt]) => evt);
    expect(events).toContain("data");
    expect(events).toContain("end");
    expect(events).toContain("error");
  });

  it("is idempotent — subscribing the same user twice only calls subscribe once", () => {
    receiver.subscribeUser("user-3");
    receiver.subscribeUser("user-3");
    expect(conn.receiver.subscribe).toHaveBeenCalledTimes(1);
  });

  it("subscribes two different users independently", () => {
    receiver.subscribeUser("user-A");
    receiver.subscribeUser("user-B");
    expect(conn.receiver.subscribe).toHaveBeenCalledTimes(2);
    expect(conn.receiver.subscribe).toHaveBeenCalledWith("user-A", expect.any(Object));
    expect(conn.receiver.subscribe).toHaveBeenCalledWith("user-B", expect.any(Object));
  });

  it("does not invoke onTranscription during subscription setup", () => {
    const onT = vi.fn();
    const vr = new VoiceReceiver(conn as never, TEST_CONFIG, onT);
    vr.subscribeUser("user-4");
    expect(onT).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream event wiring
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceReceiver — audio stream events", () => {
  it("emitting 'data' on the stream does not throw", () => {
    const stream = makeMockStream();
    const conn = makeMockConnection(stream);
    const vr = new VoiceReceiver(conn as never, TEST_CONFIG, vi.fn());
    vr.subscribeUser("user-5");

    expect(() => {
      stream.emit("data", Buffer.alloc(80, 0));
    }).not.toThrow();
  });

  it("emitting 'end' on the stream does not throw", () => {
    const stream = makeMockStream();
    const conn = makeMockConnection(stream);
    const vr = new VoiceReceiver(conn as never, TEST_CONFIG, vi.fn());
    vr.subscribeUser("user-6");

    expect(() => {
      stream.emit("end");
    }).not.toThrow();
  });

  it("emitting 'error' on the stream does not throw", () => {
    const stream = makeMockStream();
    const conn = makeMockConnection(stream);
    const vr = new VoiceReceiver(conn as never, TEST_CONFIG, vi.fn());
    vr.subscribeUser("user-7");

    expect(() => {
      stream.emit("error", new Error("simulated stream error"));
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// unsubscribeUser
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceReceiver — unsubscribeUser", () => {
  it("silently does nothing when user was never subscribed", () => {
    const conn = makeMockConnection();
    const vr = new VoiceReceiver(conn as never, TEST_CONFIG, vi.fn());
    expect(() => vr.unsubscribeUser("ghost-user")).not.toThrow();
  });

  it("allows re-subscribing after unsubscribe", () => {
    const conn = makeMockConnection();
    const vr = new VoiceReceiver(conn as never, TEST_CONFIG, vi.fn());

    vr.subscribeUser("user-8");
    vr.unsubscribeUser("user-8");

    // subscribe should be callable again now
    vr.subscribeUser("user-8");
    expect(conn.receiver.subscribe).toHaveBeenCalledTimes(2);
  });

  it("does not affect other subscribed users when one is removed", () => {
    const conn = makeMockConnection();
    const vr = new VoiceReceiver(conn as never, TEST_CONFIG, vi.fn());

    vr.subscribeUser("user-A");
    vr.subscribeUser("user-B");
    vr.unsubscribeUser("user-A");

    // user-B should still be active — re-subscribing user-A triggers subscribe
    // only once more (user-B slot is occupied, so it won't fire)
    vr.subscribeUser("user-A");
    expect(conn.receiver.subscribe).toHaveBeenCalledTimes(3); // A, B, A again
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// destroy
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceReceiver — destroy", () => {
  it("does not throw when no users are subscribed", () => {
    const conn = makeMockConnection();
    const vr = new VoiceReceiver(conn as never, TEST_CONFIG, vi.fn());
    expect(() => vr.destroy()).not.toThrow();
  });

  it("does not throw with multiple subscribed users", () => {
    const conn = makeMockConnection();
    const vr = new VoiceReceiver(conn as never, TEST_CONFIG, vi.fn());
    vr.subscribeUser("u1");
    vr.subscribeUser("u2");
    vr.subscribeUser("u3");
    expect(() => vr.destroy()).not.toThrow();
  });

  it("clears all receivers so re-subscribing after destroy works", () => {
    const conn = makeMockConnection();
    const vr = new VoiceReceiver(conn as never, TEST_CONFIG, vi.fn());

    vr.subscribeUser("user-X");
    vr.destroy();

    // After destroy the internal map is cleared, so subscribeUser fires subscribe again
    vr.subscribeUser("user-X");
    expect(conn.receiver.subscribe).toHaveBeenCalledTimes(2);
  });

  it("is idempotent — calling destroy twice does not throw", () => {
    const conn = makeMockConnection();
    const vr = new VoiceReceiver(conn as never, TEST_CONFIG, vi.fn());
    vr.subscribeUser("user-Y");
    expect(() => {
      vr.destroy();
      vr.destroy();
    }).not.toThrow();
  });
});
