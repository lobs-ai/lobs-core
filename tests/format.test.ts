import { describe, it, expect } from "vitest";
import { formatBytes } from "../src/util/format.js";

describe("formatBytes", () => {
  it("formats zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes under 1 KB", () => {
    expect(formatBytes(500)).toBe("500.0 B");
  });

  it("formats exactly 1 KB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1048576)).toBe("1.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1073741824)).toBe("1.0 GB");
  });

  it("formats terabytes", () => {
    expect(formatBytes(1099511627776)).toBe("1.0 TB");
  });

  it("respects custom decimal places", () => {
    expect(formatBytes(1536, 2)).toBe("1.50 KB");
  });

  it("uses 0 decimals for negative decimal parameter", () => {
    expect(formatBytes(1536, -1)).toBe("2 KB");
  });

  it("throws on negative bytes", () => {
    expect(() => formatBytes(-1)).toThrow("bytes cannot be negative");
  });

  it("handles very large values", () => {
    const petabyte = Math.pow(1024, 5);
    expect(formatBytes(petabyte)).toBe("1.0 PB");
  });

  it("handles 1 byte", () => {
    expect(formatBytes(1)).toBe("1.0 B");
  });
});
