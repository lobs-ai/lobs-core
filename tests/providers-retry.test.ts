import { describe, expect, test } from "vitest";
import { shouldRetryProviderError } from "../src/runner/providers.js";

describe("shouldRetryProviderError", () => {
  test("returns false when provider explicitly disables retries", () => {
    const err = {
      status: 500,
      headers: new Headers({ "x-should-retry": "false" }),
    };

    expect(shouldRetryProviderError(err)).toBe(false);
  });

  test("returns true when provider explicitly enables retries", () => {
    const err = {
      status: 500,
      headers: new Headers({ "x-should-retry": "true" }),
    };

    expect(shouldRetryProviderError(err)).toBe(true);
  });

  test("returns undefined when no retry directive is present", () => {
    const err = {
      status: 500,
      headers: new Headers(),
    };

    expect(shouldRetryProviderError(err)).toBeUndefined();
  });
});
