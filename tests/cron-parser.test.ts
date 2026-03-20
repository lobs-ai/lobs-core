import { describe, it, expect } from "vitest";
import { parseCronExpression } from "../src/services/cron.js";

describe("parseCronExpression", () => {
  it("parses wildcard expression", () => {
    const result = parseCronExpression("* * * * *");
    expect(result.minute).toHaveLength(60);
    expect(result.hour).toHaveLength(24);
    expect(result.dayOfMonth).toHaveLength(31);
    expect(result.month).toHaveLength(12);
    expect(result.dayOfWeek).toHaveLength(7);
  });

  it("parses specific values", () => {
    const result = parseCronExpression("30 14 1 6 3");
    expect(result.minute).toEqual([30]);
    expect(result.hour).toEqual([14]);
    expect(result.dayOfMonth).toEqual([1]);
    expect(result.month).toEqual([6]);
    expect(result.dayOfWeek).toEqual([3]);
  });

  it("parses ranges", () => {
    const result = parseCronExpression("0-5 9-17 * * *");
    expect(result.minute).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("parses step values", () => {
    const result = parseCronExpression("*/15 */6 * * *");
    expect(result.minute).toEqual([0, 15, 30, 45]);
    expect(result.hour).toEqual([0, 6, 12, 18]);
  });

  it("parses comma-separated values", () => {
    const result = parseCronExpression("0,30 9,12,18 * * *");
    expect(result.minute).toEqual([0, 30]);
    expect(result.hour).toEqual([9, 12, 18]);
  });

  it("parses range with step", () => {
    const result = parseCronExpression("0-30/10 * * * *");
    expect(result.minute).toEqual([0, 10, 20, 30]);
  });

  it("parses common patterns: hourly", () => {
    const result = parseCronExpression("0 * * * *");
    expect(result.minute).toEqual([0]);
    expect(result.hour).toHaveLength(24);
  });

  it("parses common patterns: daily at midnight", () => {
    const result = parseCronExpression("0 0 * * *");
    expect(result.minute).toEqual([0]);
    expect(result.hour).toEqual([0]);
  });

  it("parses common patterns: weekdays only", () => {
    const result = parseCronExpression("0 9 * * 1-5");
    expect(result.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("throws on invalid expression (too few fields)", () => {
    expect(() => parseCronExpression("* *")).toThrow("Invalid cron expression");
  });

  it("handles mixed comma and range", () => {
    const result = parseCronExpression("0,15,30-35 * * * *");
    expect(result.minute).toEqual([0, 15, 30, 31, 32, 33, 34, 35]);
  });
});
