/**
 * Tests for src/services/voice/speaker.ts — VoiceSpeaker
 *
 * Strategy:
 *   - Use vi.hoisted() to define mock functions before vi.mock() factory runs
 *   - Mock @discordjs/voice before imports (vi.mock is hoisted)
 *   - Stub global.fetch via vi.stubGlobal before the speaker import
 *   - Capture the AudioPlayerStatus.Idle callback to simulate playback completion
 *   - Use vi.fn() for all player/connection methods to assert interactions
 *
 * Coverage:
 *   - constructor: Idle event listener registration
 *   - feedText: sentence splitting, partial buffer carry-over, short fragment skipping
 *   - feedText: fetch call shape (URL, method, headers, body), queuing result
 *   - flush: sends remaining buffer, clears buffer, no-op on empty, re-entrant guard
 *   - stop: clears state, calls player.stop(true)
 *   - isBusy: false initially, true when queue has items, true when playing
 *   - playNext: creates resource + plays, skips when already playing, advances on Idle
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist mock factories so they're available when vi.mock runs ───────────────
// vi.mock() factories are hoisted to the TOP of the module by Vitest, which
// means any variables they reference must also be hoisted via vi.hoisted().

const { mockPlay, mockStop, mockCreateAudioResource } = vi.hoisted(() => ({
  mockPlay: vi.fn(),
  mockStop: vi.fn(),
  mockCreateAudioResource: vi.fn(() => ({ type: "audio-resource" })),
}));

// ── Mock @discordjs/voice ─────────────────────────────────────────────────────
vi.mock("@discordjs/voice", () => ({
  createAudioResource: mockCreateAudioResource,
  AudioPlayerStatus: { Idle: "idle", Playing: "playing" },
  StreamType: { Arbitrary: "arbitrary" },
}));

// ── Stub fetch BEFORE importing the module under test ────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Now safe to import the module under test ──────────────────────────────────
import { VoiceSpeaker } from "../src/services/voice/speaker.js";

// ── Shared test config ────────────────────────────────────────────────────────

const testConfig = {
  enabled: true,
  stt: { url: "http://localhost:7423" },
  tts: { url: "http://localhost:7422", voice: "test-voice", speed: 1.0 },
  vad: { silenceThresholdMs: 800, energyThreshold: 0.01 },
  conversation: {
    maxContextExchanges: 20,
    triggerMode: "keyword" as const,
    triggerWords: ["lobs"],
  },
};

// ── Shared mock player / connection ───────────────────────────────────────────

// idleCallback is captured fresh each time makeSpeaker() is called.
let idleCallback: (() => void) | null = null;

const mockPlayer = {
  on: vi.fn((event: string, cb: () => void) => {
    if (event === "idle") idleCallback = cb;
  }),
  play: mockPlay,
  stop: mockStop,
};

const mockConnection = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Successful fetch response returning `byteCount` bytes of audio. */
function okFetchResponse(byteCount = 1000) {
  return {
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(byteCount)),
  };
}

/** Failed fetch response. */
function errorFetchResponse(status = 500, statusText = "Internal Server Error") {
  return { ok: false, status, statusText };
}

/** Create a fresh VoiceSpeaker and reset all mocks/captured state. */
function makeSpeaker() {
  idleCallback = null;
  mockPlay.mockClear();
  mockStop.mockClear();
  mockPlayer.on.mockClear();
  mockCreateAudioResource.mockClear();
  mockFetch.mockClear();

  return new VoiceSpeaker(
    testConfig,
    mockPlayer as never,
    mockConnection as never,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// constructor
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceSpeaker — constructor", () => {
  it("registers an Idle listener on the player", () => {
    makeSpeaker();
    expect(mockPlayer.on).toHaveBeenCalledOnce();
    expect(mockPlayer.on).toHaveBeenCalledWith("idle", expect.any(Function));
  });

  it("captures idle callback so playback chain can be triggered", () => {
    makeSpeaker();
    expect(idleCallback).toBeTypeOf("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// feedText — sentence splitting / buffering
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceSpeaker — feedText sentence splitting", () => {
  it("does NOT trigger TTS when the buffer has no sentence boundary", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello there, I am still speaking");

    // Allow micro-tasks to settle
    await Promise.resolve();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("triggers TTS for a complete sentence ending with a period", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello world. ");

    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("triggers TTS for sentences ending with ! and ?", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Is this working? Yes it is! ");

    await Promise.resolve();
    await Promise.resolve(); // two sentences may queue two micro-tasks

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("splits multiple sentences and queues each separately", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("First sentence. Second sentence. Third is still partial");

    await Promise.resolve();
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("carries over the incomplete tail into the buffer", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    // "Hello world." is complete, "Still going" is the incomplete tail
    await speaker.feedText("Hello world. Still going");

    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Now complete the buffered tail — trailing space triggers the boundary split
    mockFetch.mockClear();
    await speaker.feedText(" and now it ends. ");

    await Promise.resolve();

    // "Still going and now it ends." should be sent as a complete sentence
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toBe("Still going and now it ends.");
  });

  it("skips fragments shorter than MIN_SENTENCE_LENGTH (10 chars)", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    // "Hi." is only 3 chars — below the 10-char threshold
    await speaker.feedText("Hi. ");

    await Promise.resolve();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("processes a sentence that is exactly at the minimum length threshold", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    // "123456789." is exactly 10 chars — at the threshold (>= 10 passes)
    await speaker.feedText("123456789. ");

    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// feedText — TTS synthesis (fetch shape)
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceSpeaker — feedText TTS fetch", () => {
  it("calls fetch with the correct TTS URL", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello there friend. ");
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:7422/v1/audio/speech",
      expect.any(Object),
    );
  });

  it("uses POST method", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello there friend. ");
    await Promise.resolve();

    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe("POST");
  });

  it("sends Content-Type: application/json header", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello there friend. ");
    await Promise.resolve();

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  it("sends correct JSON body with model, input, voice, format, speed", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello there friend. ");
    await Promise.resolve();

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.model).toBe("chatterbox");
    expect(body.input).toBe("Hello there friend.");
    expect(body.voice).toBe("test-voice");
    expect(body.response_format).toBe("wav");
    expect(body.speed).toBe(1.0);
  });

  it("defaults voice to 'default' and speed to 1.0 when not configured", async () => {
    idleCallback = null;
    mockFetch.mockClear();
    mockPlayer.on.mockClear();

    const configNoExtras = {
      ...testConfig,
      tts: { url: "http://localhost:7422" }, // no voice or speed
    };
    const speaker = new VoiceSpeaker(
      configNoExtras as never,
      mockPlayer as never,
      mockConnection as never,
    );
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello there friend. ");
    await Promise.resolve();

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.voice).toBe("default");
    expect(body.speed).toBe(1.0);
  });

  it("queues the audio buffer and makes isBusy true after generation", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse(2048));

    await speaker.feedText("Hello there friend. ");
    // Wait for generateAndQueue to fully resolve through the fetch promise
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(speaker.isBusy).toBe(true);
  });

  it("logs an error but does not throw when fetch returns a non-ok response", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(errorFetchResponse(503, "Service Unavailable"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // feedText fires-and-forgets generateAndQueue — must not propagate
    await expect(speaker.feedText("Hello there friend. ")).resolves.toBeUndefined();

    // Let the async chain settle
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[voice:speaker] TTS generation failed:"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// flush
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceSpeaker — flush", () => {
  it("sends remaining buffer text to TTS", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("This sentence has no boundary");
    await speaker.flush();

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toBe("This sentence has no boundary");
  });

  it("clears the textBuffer so a subsequent flush is a no-op", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Some leftover text");
    await speaker.flush();

    mockFetch.mockClear();
    await speaker.flush();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("is a no-op when the buffer is empty", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.flush();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("re-entrant guard: concurrent flush calls only send one TTS request", async () => {
    const speaker = makeSpeaker();

    // Make fetch hang so the first flush doesn't complete immediately
    let resolveFetch!: (v: unknown) => void;
    const hangingFetch = new Promise(r => { resolveFetch = r; });
    mockFetch.mockReturnValue(hangingFetch);

    await speaker.feedText("Something to flush");

    // Kick off first flush (hangs on fetch)
    const flush1 = speaker.flush();

    // Second concurrent flush should hit the isFlushing guard and return early
    const flush2 = speaker.flush();

    // Unblock the fetch
    resolveFetch({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });

    await Promise.all([flush1, flush2]);

    // Only one fetch call, not two
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("logs an error but does not throw when TTS fails during flush", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(errorFetchResponse(500, "Server Error"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await speaker.feedText("Some text");
    await expect(speaker.flush()).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[voice:speaker] TTS flush failed:"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("trims whitespace from the remaining buffer before sending", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("  Padded text  ");
    await speaker.flush();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toBe("Padded text");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stop
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceSpeaker — stop", () => {
  it("calls player.stop(true)", () => {
    const speaker = makeSpeaker();
    speaker.stop();
    expect(mockStop).toHaveBeenCalledWith(true);
  });

  it("clears the textBuffer so subsequent flush sends nothing", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Partial sentence without ending");
    speaker.stop();

    mockFetch.mockClear();
    await speaker.flush();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("clears the audioQueue so isBusy becomes false", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello there friend. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    speaker.stop();

    expect(speaker.isBusy).toBe(false);
  });

  it("sets isPlaying to false", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello there friend. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(speaker.isBusy).toBe(true);

    speaker.stop();

    expect(speaker.isBusy).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isBusy
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceSpeaker — isBusy", () => {
  it("returns false on a fresh instance", () => {
    const speaker = makeSpeaker();
    expect(speaker.isBusy).toBe(false);
  });

  it("returns true while audio is playing (isPlaying=true)", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello there friend. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    // Idle has not fired — isPlaying is still true
    expect(speaker.isBusy).toBe(true);
  });

  it("returns true while audioQueue has pending items", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    // First item starts playing; second goes into the queue
    await speaker.feedText("Hello there friend. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    await speaker.feedText("Another sentence follows. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(speaker.isBusy).toBe(true);
  });

  it("returns false after stop() clears everything", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello there friend. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    speaker.stop();

    expect(speaker.isBusy).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// playNext / audio resource creation
// ─────────────────────────────────────────────────────────────────────────────

describe("VoiceSpeaker — playNext", () => {
  it("calls createAudioResource with Arbitrary stream type", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello there friend. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockCreateAudioResource).toHaveBeenCalledOnce();
    expect(mockCreateAudioResource).toHaveBeenCalledWith(
      expect.any(Object), // Readable stream
      { inputType: "arbitrary" },
    );
  });

  it("calls player.play() with the created resource", async () => {
    const speaker = makeSpeaker();
    const fakeResource = { type: "custom-resource" };
    mockCreateAudioResource.mockReturnValueOnce(fakeResource);
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Hello there friend. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockPlay).toHaveBeenCalledOnce();
    expect(mockPlay).toHaveBeenCalledWith(fakeResource);
  });

  it("does not call play() again while already playing (isPlaying guard)", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    // First sentence starts playing
    await speaker.feedText("Hello there friend. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    const countAfterFirst = mockPlay.mock.calls.length;
    expect(countAfterFirst).toBe(1);

    // Second sentence is queued — but Idle has not fired, so play must NOT be called again
    await speaker.feedText("Second sentence follows. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockPlay.mock.calls.length).toBe(countAfterFirst);
  });

  it("plays the next queued item when Idle callback fires", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    // Queue two sentences back-to-back
    await speaker.feedText("First sentence here. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    await speaker.feedText("Second sentence here. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockPlay).toHaveBeenCalledTimes(1);

    // Simulate Discord player signalling Idle (current track finished)
    expect(idleCallback).not.toBeNull();
    idleCallback!();

    expect(mockPlay).toHaveBeenCalledTimes(2);
  });

  it("does not call player.play() when queue is empty after Idle fires", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Only one sentence. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockPlay).toHaveBeenCalledTimes(1);

    // Idle fires with an empty queue
    idleCallback!();

    // No additional play call
    expect(mockPlay).toHaveBeenCalledTimes(1);
  });

  it("sets isBusy to false once queue drains and Idle fires", async () => {
    const speaker = makeSpeaker();
    mockFetch.mockResolvedValue(okFetchResponse());

    await speaker.feedText("Just one sentence. ");
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(speaker.isBusy).toBe(true);

    idleCallback!();

    expect(speaker.isBusy).toBe(false);
  });
});
