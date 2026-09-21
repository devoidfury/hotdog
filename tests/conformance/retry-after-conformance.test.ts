// RFC 9110 section 10.2.3 (Retry-After) conformance for parseRetryAfterMs
// (src/core/llm-client/retry.ts). Oracle: the vendored RFC text
// (retry-after-10.2.3.txt); both example field values are read from it, not
// hardcoded here.
//
// Hotdog policy assertions (NOT RFC requirements) are named as such: the
// [0, MAX_RETRY_AFTER_MS] clamp is ours -- the RFC mandates no ceiling.

import { describe, it, expect } from "bun:test";
import { parseRetryAfterMs, MAX_RETRY_AFTER_MS } from "@core/llm-client/retry.ts";
import { loadTextFixture } from "./helpers.ts";

const { text: rfc } = await loadTextFixture("rfc9110/retry-after-10.2.3.txt");

// The two example lines from the RFC prose ("Two examples of its use are").
const examples = [...rfc.matchAll(/Retry-After: (.+)/g)].map((m) => (m[1] ?? "").trim());
expect(examples).toHaveLength(2);
const [dateExample, secondsExample] = examples as [string, string];

describe("Retry-After conformance (RFC 9110 10.2.3)", () => {
  it("RFC 9110 10.2.3: delay-seconds example value is seconds", () => {
    expect(secondsExample).toBe("120");
    // The RFC example (2 min) is above hotdog's 60s policy ceiling; below
    // the ceiling the seconds semantics hold exactly.
    expect(parseRetryAfterMs("45")).toBe(45_000);
    expect(parseRetryAfterMs(secondsExample)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("RFC 9110 10.2.3: HTTP-date (IMF-fixdate) example parses", () => {
    expect(dateExample).toBe("Fri, 31 Dec 1999 23:59:59 GMT");
    // A past date is a non-negative wait of zero (clamp policy below).
    expect(parseRetryAfterMs(dateExample)).toBe(0);
  });

  it("RFC 9110 10.2.3: HTTP-date in the future yields its remaining delay", () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(20_000);
    expect(ms!).toBeLessThanOrEqual(30_000);
  });

  it("RFC 9110 10.2.3 grammar: delay-seconds = 1*DIGIT (zero and leading zeros are valid)", () => {
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("0045")).toBe(45_000);
  });

  it("RFC 9110 10.2.3 grammar: values outside delay-seconds/HTTP-date do not parse", () => {
    for (const bad of ["", "   ", "-5", "12.5", "1e3", "soon", "tomorrow", "1_000"]) {
      expect(parseRetryAfterMs(bad), `Retry-After: ${bad}`).toBeNull();
    }
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });

  it("hotdog policy: parsed delay clamps to [0, MAX_RETRY_AFTER_MS] (RFC sets no ceiling)", () => {
    expect(MAX_RETRY_AFTER_MS).toBe(60_000);
    expect(parseRetryAfterMs("3600")).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfterMs("86400")).toBe(MAX_RETRY_AFTER_MS);
    // A far-future HTTP-date hits the same ceiling.
    expect(parseRetryAfterMs(new Date(Date.now() + 3_600_000).toUTCString())).toBe(
      MAX_RETRY_AFTER_MS,
    );
  });
});
