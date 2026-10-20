// Tests for the pure token-pricing helper (opt-in `modelPricing` config key).

import { describe, it, expect } from "bun:test";
import {
  computeTokenCost,
  findModelPrice,
  isPricingConfigured,
  type ModelPrice,
} from "@core/token-pricing.ts";

const PRICE: ModelPrice = { input: 3, cachedInput: 0.3, output: 15 };

describe("isPricingConfigured", () => {
  it("is false when the key is absent, null, or not an object", () => {
    expect(isPricingConfigured(undefined)).toBe(false);
    expect(isPricingConfigured(null)).toBe(false);
    expect(isPricingConfigured("gpt=3")).toBe(false);
    expect(isPricingConfigured([{ model: "gpt", input: 3 }])).toBe(false);
  });

  it("is true for a map, even an empty one (configured means configured)", () => {
    expect(isPricingConfigured({})).toBe(true);
    expect(isPricingConfigured({ "vendor/model": PRICE })).toBe(true);
  });
});

describe("findModelPrice", () => {
  const table = {
    "openrouter/anthropic/claude-3.5-sonnet": { input: 3, cachedInput: 0.3, output: 15 },
    "ollama/qwen": { input: 0, output: 0 },
    "broken/entry": { input: "3", output: 15 },
    "missing/output": { input: 3 },
    "negative/rate": { input: -1, output: 15 },
  };

  it("returns the entry for an exactly-named model", () => {
    expect(findModelPrice(table, "openrouter/anthropic/claude-3.5-sonnet")).toEqual({
      input: 3,
      cachedInput: 0.3,
      output: 15,
    });
  });

  it("returns undefined for an unmapped model", () => {
    expect(findModelPrice(table, "someother/model")).toBeUndefined();
  });

  it("returns undefined when there is no table or no model", () => {
    expect(findModelPrice(undefined, "ollama/qwen")).toBeUndefined();
    expect(findModelPrice(null, "ollama/qwen")).toBeUndefined();
    expect(findModelPrice(table, undefined)).toBeUndefined();
    expect(findModelPrice(table, "")).toBeUndefined();
  });

  it("treats a free model (all-zero rates) as mapped", () => {
    expect(findModelPrice(table, "ollama/qwen")).toEqual({ input: 0, output: 0 });
  });

  it("treats malformed entries as unmapped rather than pricing on garbage", () => {
    expect(findModelPrice(table, "broken/entry")).toBeUndefined();
    expect(findModelPrice(table, "missing/output")).toBeUndefined();
    expect(findModelPrice(table, "negative/rate")).toBeUndefined();
    expect(findModelPrice({ "null/entry": null }, "null/entry")).toBeUndefined();
    expect(findModelPrice({ "bad/cached": { input: 1, output: 2, cachedInput: "free" } }, "bad/cached")).toBeUndefined();
  });

  it("ignores inherited properties (model named __proto__ cannot fake a rate)", () => {
    expect(findModelPrice({ "a": PRICE }, "__proto__")).toBeUndefined();
  });
});

describe("computeTokenCost", () => {
  it("prices net prompt, cached, and completion tokens per million", () => {
    const cost = computeTokenCost(
      { promptTokens: 1_000_000, cachedTokens: 1_000_000, completionTokens: 1_000_000 },
      PRICE,
    );
    expect(cost.input).toBeCloseTo(3, 10);
    expect(cost.cached).toBeCloseTo(0.3, 10);
    expect(cost.output).toBeCloseTo(15, 10);
    expect(cost.total).toBeCloseTo(18.3, 10);
  });

  it("does not double count: promptTokens is already net of cached", () => {
    // A call with 1000 raw prompt tokens of which 400 were cache hits lands in
    // the tracker as promptTokens 600 + cachedTokens 400.
    const cost = computeTokenCost(
      { promptTokens: 600, cachedTokens: 400, completionTokens: 100 },
      PRICE,
    );
    expect(cost.input).toBeCloseTo((600 / 1e6) * 3, 10);
    expect(cost.cached).toBeCloseTo((400 / 1e6) * 0.3, 10);
    expect(cost.output).toBeCloseTo((100 / 1e6) * 15, 10);
    // Raw 1000 would have billed 3e-3; net + cached bills strictly less.
    expect(cost.input + cost.cached).toBeLessThan(0.003);
  });

  it("defaults the cached rate to 0 when the entry omits it", () => {
    const unpricedCache: ModelPrice = { input: 3, output: 15 };
    const cost = computeTokenCost(
      { promptTokens: 1000, cachedTokens: 500_000, completionTokens: 1000 },
      unpricedCache,
    );
    expect(cost.cached).toBe(0);
    expect(cost.total).toBeCloseTo(0.003 + 0.015, 10);
  });

  it("honours an explicit cached rate, including a non-zero one", () => {
    const cost = computeTokenCost(
      { promptTokens: 0, cachedTokens: 1_000_000, completionTokens: 0 },
      { input: 3, cachedInput: 1, output: 15 },
    );
    expect(cost.cached).toBeCloseTo(1, 10);
  });

  it("returns all-zero breakdown for zero usage", () => {
    const cost = computeTokenCost(
      { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
      PRICE,
    );
    expect(cost).toEqual({ input: 0, cached: 0, output: 0, total: 0 });
  });
});
