/**
 * Tests for src/services/voice/vad.ts
 *
 * Covers calculateRMS (pure math) and VADProcessor (state machine):
 * transitions, callbacks, silence tolerance, duration calculation, reset, edge cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { calculateRMS, VADProcessor } from "../src/services/voice/vad.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a PCM16-LE Buffer from an array of int16 sample values. */
function makePCM(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

/** PCM buffer where every sample is the given value. */
function makeFlatPCM(value: number, sampleCount: number): Buffer {
  return makePCM(Array(sampleCount).fill(value));
}

/** High-energy buffer that will exceed any reasonable threshold (<0.5). */
const LOUD = makeFlatPCM(20000, 160);
/** Silent buffer — all zeros. */
const SILENT = makeFlatPCM(0, 160);

/** Default VAD config used by most tests. */
const DEFAULT_CONFIG = { silenceThresholdMs: 300, energyThreshold: 0.01 };

// ── calculateRMS ──────────────────────────────────────────────────────────────

describe("calculateRMS", () => {
  it("returns 0 for empty buffer", () => {
    expect(calculateRMS(Buffer.alloc(0))).toBe(0);
  });

  it("returns 0 for single-byte buffer (less than one int16 sample)", () => {
    expect(calculateRMS(Buffer.from([0x01]))).toBe(0);
  });

  it("returns 0 for all-zero samples (silence)", () => {
    expect(calculateRMS(makeFlatPCM(0, 100))).toBe(0);
  });

  it("returns ~1.0 for max-amplitude positive samples (32767)", () => {
    const rms = calculateRMS(makeFlatPCM(32767, 100));
    // 32767 / 32768 ≈ 0.99997
    expect(rms).toBeCloseTo(32767 / 32768, 4);
  });

  it("returns ~1.0 for max-amplitude negative samples (-32768)", () => {
    // int16 min is -32768; RMS should be 1.0
    const rms = calculateRMS(makeFlatPCM(-32768, 100));
    expect(rms).toBeCloseTo(1.0, 4);
  });

  it("returns identical value for positive and negative samples of same magnitude", () => {
    const pos = calculateRMS(makeFlatPCM(16000, 200));
    const neg = calculateRMS(makeFlatPCM(-16000, 200));
    expect(pos).toBeCloseTo(neg, 10);
  });

  it("computes RMS correctly for a known single sample", () => {
    // Single sample = 16384. RMS = 16384 / 32768 = 0.5
    const rms = calculateRMS(makePCM([16384]));
    expect(rms).toBeCloseTo(0.5, 5);
  });

  it("computes RMS correctly for two known samples", () => {
    // samples: 0 and 32768 clamped to 32767 — use 0 and 16384
    // RMS = sqrt((0^2 + 16384^2) / 2) / 32768
    //      = sqrt(16384^2 / 2) / 32768
    //      = (16384 / sqrt(2)) / 32768
    const expected = (16384 / Math.sqrt(2)) / 32768;
    expect(calculateRMS(makePCM([0, 16384]))).toBeCloseTo(expected, 5);
  });

  it("ignores odd trailing byte (floors to whole samples)", () => {
    // 5 bytes → 2 int16 samples (floor(5/2) = 2), last byte ignored
    const buf = Buffer.alloc(5);
    buf.writeInt16LE(16384, 0);
    buf.writeInt16LE(16384, 2);
    buf[4] = 0xff; // trailing noise byte — must not affect result
    const clean = calculateRMS(makePCM([16384, 16384]));
    expect(calculateRMS(buf)).toBeCloseTo(clean, 10);
  });

  it("handles a mixed-amplitude buffer without NaN or Infinity", () => {
    const samples = [-30000, -10000, 0, 10000, 30000];
    const rms = calculateRMS(makePCM(samples));
    expect(Number.isFinite(rms)).toBe(true);
    expect(rms).toBeGreaterThan(0);
    expect(rms).toBeLessThanOrEqual(1);
  });
});

// ── VADProcessor — initial state ──────────────────────────────────────────────

describe("VADProcessor — initial state", () => {
  it("starts with isSpeaking = false", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    expect(vad.isSpeaking).toBe(false);
  });

  it("returns false on first silent frame", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    expect(vad.process(SILENT, 0)).toBe(false);
  });
});

// ── VADProcessor — speech start ───────────────────────────────────────────────

describe("VADProcessor — speech start", () => {
  it("transitions to speaking when energy exceeds threshold", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    vad.process(LOUD, 0);
    expect(vad.isSpeaking).toBe(true);
  });

  it("process() returns true on the frame that starts speech", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    expect(vad.process(LOUD, 0)).toBe(true);
  });

  it("fires onSpeechStart callback exactly once on transition", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    const onStart = vi.fn();
    vad.onSpeechStart = onStart;
    vad.process(LOUD, 0);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onSpeechStart for subsequent loud frames", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    const onStart = vi.fn();
    vad.onSpeechStart = onStart;
    vad.process(LOUD, 0);
    vad.process(LOUD, 20);
    vad.process(LOUD, 40);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("stays in speaking state during continuous high-energy frames", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    for (let t = 0; t < 500; t += 20) {
      expect(vad.process(LOUD, t)).toBe(true);
    }
    expect(vad.isSpeaking).toBe(true);
  });
});

// ── VADProcessor — silence tolerance ─────────────────────────────────────────

describe("VADProcessor — silence tolerance", () => {
  it("stays speaking when silence is shorter than silenceThresholdMs", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG); // threshold = 300 ms
    vad.process(LOUD, 0);    // start speech
    vad.process(SILENT, 20); // 20 ms silence — under threshold
    expect(vad.isSpeaking).toBe(true);
  });

  it("does NOT fire onSpeechEnd during short silence gap", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    const onEnd = vi.fn();
    vad.onSpeechEnd = onEnd;
    vad.process(LOUD, 0);
    vad.process(SILENT, 50);
    vad.process(SILENT, 100);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("stays speaking when speech resumes before silence threshold expires", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG); // 300 ms threshold
    vad.process(LOUD, 0);     // start speech at 0
    vad.process(SILENT, 100); // silence starts
    vad.process(SILENT, 200); // still under 300 ms
    vad.process(LOUD, 250);   // speech resumes before 300 ms — silence cancelled
    expect(vad.isSpeaking).toBe(true);
  });

  it("does not fire onSpeechEnd when silence is interrupted before threshold", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    const onEnd = vi.fn();
    vad.onSpeechEnd = onEnd;
    vad.process(LOUD, 0);
    vad.process(SILENT, 100);
    vad.process(LOUD, 250); // interrupt before 300 ms threshold
    vad.process(LOUD, 300);
    expect(onEnd).not.toHaveBeenCalled();
  });
});

// ── VADProcessor — speech end ─────────────────────────────────────────────────

describe("VADProcessor — speech end", () => {
  it("ends speech when silence exceeds silenceThresholdMs", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG); // 300 ms
    vad.process(LOUD, 0);     // speech starts
    vad.process(SILENT, 100); // silence starts at 100
    vad.process(SILENT, 200);
    vad.process(SILENT, 400); // 400 - 100 = 300 ms ≥ threshold
    expect(vad.isSpeaking).toBe(false);
  });

  it("fires onSpeechEnd when silence threshold is crossed", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    const onEnd = vi.fn();
    vad.onSpeechEnd = onEnd;
    vad.process(LOUD, 0);
    vad.process(SILENT, 50);
    vad.process(SILENT, 350); // 350 - 50 = 300 ms ≥ threshold
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("process() returns false on the frame that ends speech", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    vad.process(LOUD, 0);
    vad.process(SILENT, 50);
    const result = vad.process(SILENT, 350);
    expect(result).toBe(false);
  });

  it("onSpeechEnd receives correct duration (silenceStart − speechStart)", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    const onEnd = vi.fn();
    vad.onSpeechEnd = onEnd;

    // speechStart = 0, silenceStart = 500 → duration = 500 ms
    vad.process(LOUD, 0);
    vad.process(LOUD, 250);
    vad.process(LOUD, 400);
    vad.process(SILENT, 500); // silenceStart = 500
    vad.process(SILENT, 800); // 800 - 500 = 300 ms ≥ threshold

    expect(onEnd).toHaveBeenCalledWith(500); // silenceStart(500) - speechStart(0)
  });

  it("resets to not-speaking after speech ends", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    vad.process(LOUD, 0);
    vad.process(SILENT, 50);
    vad.process(SILENT, 360);
    expect(vad.isSpeaking).toBe(false);
  });
});

// ── VADProcessor — reset ──────────────────────────────────────────────────────

describe("VADProcessor — reset()", () => {
  it("clears isSpeaking to false", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    vad.process(LOUD, 0);
    expect(vad.isSpeaking).toBe(true);
    vad.reset();
    expect(vad.isSpeaking).toBe(false);
  });

  it("clears speech in progress — loud frame after reset fires onSpeechStart again", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    const onStart = vi.fn();
    vad.onSpeechStart = onStart;
    vad.process(LOUD, 0);
    vad.reset();
    vad.process(LOUD, 1000);
    // First call: pre-reset. Second call: after reset — should fire again.
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it("after reset, silence does not trigger onSpeechEnd", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    const onEnd = vi.fn();
    vad.onSpeechEnd = onEnd;
    vad.process(LOUD, 0);
    vad.reset();
    vad.process(SILENT, 100);
    vad.process(SILENT, 500);
    expect(onEnd).not.toHaveBeenCalled();
  });
});

// ── VADProcessor — multiple cycles ───────────────────────────────────────────

describe("VADProcessor — multiple speech/silence cycles", () => {
  it("handles two complete speech segments back-to-back", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    const onStart = vi.fn();
    const onEnd = vi.fn();
    vad.onSpeechStart = onStart;
    vad.onSpeechEnd = onEnd;

    // Segment 1: 0–200 ms speech, silence 200–500 (300 ms gap)
    vad.process(LOUD, 0);
    vad.process(LOUD, 100);
    vad.process(SILENT, 200); // silenceStart = 200
    vad.process(SILENT, 500); // 300 ms → end segment 1

    // Segment 2: 600–800 ms speech, silence 800–1100 ms (300 ms gap)
    vad.process(LOUD, 600);
    vad.process(LOUD, 700);
    vad.process(SILENT, 800); // silenceStart = 800
    vad.process(SILENT, 1100); // 300 ms → end segment 2

    expect(onStart).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it("correctly tracks duration across multiple cycles", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    const durations: number[] = [];
    vad.onSpeechEnd = (d) => durations.push(d);

    // Segment 1: speech 0–300, silence 300–600 (300 ms gap) → duration 300
    vad.process(LOUD, 0);
    vad.process(SILENT, 300);
    vad.process(SILENT, 600);

    // Segment 2: speech 700–900, silence 900–1200 (300 ms gap) → duration 200
    vad.process(LOUD, 700);
    vad.process(LOUD, 800);
    vad.process(SILENT, 900);
    vad.process(SILENT, 1200);

    expect(durations).toEqual([300, 200]);
  });
});

// ── VADProcessor — no callbacks set ──────────────────────────────────────────

describe("VADProcessor — no callbacks set", () => {
  it("does not crash when onSpeechStart is undefined", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    expect(() => vad.process(LOUD, 0)).not.toThrow();
  });

  it("does not crash when onSpeechEnd is undefined", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    expect(() => {
      vad.process(LOUD, 0);
      vad.process(SILENT, 50);
      vad.process(SILENT, 360);
    }).not.toThrow();
  });
});

// ── VADProcessor — energy threshold boundary ──────────────────────────────────

describe("VADProcessor — energy threshold boundary", () => {
  it("does not start speech when energy exactly equals threshold (> required)", () => {
    // calculateRMS(makeFlatPCM(x, n)) = x / 32768
    // For threshold = 0.5, we need a sample whose RMS = exactly 0.5 → 16384
    const vad = new VADProcessor({ silenceThresholdMs: 300, energyThreshold: 0.5 });
    const atThreshold = makeFlatPCM(16384, 160); // RMS = 16384/32768 = 0.5 exactly
    vad.process(atThreshold, 0);
    // energy (0.5) is NOT > threshold (0.5), so speech should NOT start
    expect(vad.isSpeaking).toBe(false);
  });

  it("starts speech when energy is just above threshold", () => {
    const vad = new VADProcessor({ silenceThresholdMs: 300, energyThreshold: 0.5 });
    const aboveThreshold = makeFlatPCM(16385, 160); // RMS slightly above 0.5
    vad.process(aboveThreshold, 0);
    expect(vad.isSpeaking).toBe(true);
  });
});

// ── VADProcessor — timestamp defaults ────────────────────────────────────────

describe("VADProcessor — default timestamp", () => {
  it("uses Date.now() when no timestamp is provided", () => {
    const vad = new VADProcessor(DEFAULT_CONFIG);
    const onStart = vi.fn();
    vad.onSpeechStart = onStart;
    // Should not throw and should fire the callback
    expect(() => vad.process(LOUD)).not.toThrow();
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
