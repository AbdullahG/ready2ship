import { describe, expect, it } from "vitest";
import { isRetryable } from "@/lib/jobs/errors";
import { InvalidKeyError, MissingKeyError, QuotaError } from "@/lib/ai/errors";

const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("isRetryable (U-09)", () => {
  it.each([400, 401, 404, 410, 422])("doesNotRetryGitHub %i", (s) => expect(isRetryable(http(s))).toBe(false));
  it.each([403, 409, 429, 500, 502, 503])("retriesGitHub %i (403 is the secondary rate limit)", (s) =>
    expect(isRetryable(http(s))).toBe(true)
  );
  it("doesNotRetryKeyProblems", () => {
    expect(isRetryable(new InvalidKeyError("x"))).toBe(false);
    expect(isRetryable(new MissingKeyError())).toBe(false);
  });
  it("retriesQuotaMalformedOutputAndNetworkErrors", () => {
    expect(isRetryable(new QuotaError("x"))).toBe(true);
    expect(isRetryable(new SyntaxError("bad json"))).toBe(true);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
  });
});
