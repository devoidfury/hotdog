// Tests for the TokenTracker class.

import { TokenTracker, createTokenTracker } from "../../src/core/token-tracker.ts";
import { describe, it, expect } from "bun:test";

describe("TokenTracker — construction", () => {
  it("creates with zeroed counters", () => {
    const tracker = new TokenTracker();
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(0);
    expect(usage.cachedTokens).toBe(0);
    expect(usage.completionTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
    expect(usage.turns).toBe(0);
    expect(usage.lastPromptTokens).toBe(0);
    expect(usage.lastCachedTokens).toBe(0);
    expect(usage.lastCompletionTokens).toBe(0);
    expect(usage.lastTotalTokens).toBe(0);
  });

  it("factory function creates instance", () => {
    const tracker = createTokenTracker();
    expect(tracker).toBeInstanceOf(TokenTracker);
    expect(tracker.getUsage().turns).toBe(0);
  });
});

describe("TokenTracker — record()", () => {
  it("accumulates basic usage", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(50);
    expect(usage.totalTokens).toBe(150);
    expect(usage.turns).toBe(1);
  });

  it("subtracts cached tokens from prompt tokens", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens: 50,
      total_tokens: 150,
    });
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(60); // 100 - 40
    expect(usage.cachedTokens).toBe(40);
  });

  it("accumulates across multiple calls", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    tracker.record({
      prompt_tokens: 200,
      completion_tokens: 100,
      total_tokens: 300,
    });
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(300);
    expect(usage.completionTokens).toBe(150);
    expect(usage.totalTokens).toBe(450);
    expect(usage.turns).toBe(2);
  });

  it("saves last-reported values", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    tracker.record({
      prompt_tokens: 200,
      completion_tokens: 100,
      total_tokens: 300,
    });
    const usage = tracker.getUsage();
    expect(usage.lastPromptTokens).toBe(200);
    expect(usage.lastCompletionTokens).toBe(100);
    expect(usage.lastTotalTokens).toBe(300);
  });

  it("handles missing fields gracefully", () => {
    const tracker = new TokenTracker();
    tracker.record({});
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(0);
    expect(usage.completionTokens).toBe(0);
    expect(usage.turns).toBe(1);
  });

  it("ignores null usage", () => {
    const tracker = new TokenTracker();
    tracker.record(null);
    const usage = tracker.getUsage();
    expect(usage.turns).toBe(0);
  });

  it("ignores undefined usage", () => {
    const tracker = new TokenTracker();
    tracker.record(undefined);
    const usage = tracker.getUsage();
    expect(usage.turns).toBe(0);
  });

  it("prevents double-counting with the same object", () => {
    const tracker = new TokenTracker();
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    };
    tracker.record(usage);
    tracker.record(usage); // should be ignored
    const result = tracker.getUsage();
    expect(result.turns).toBe(1);
    expect(result.promptTokens).toBe(100);
  });

  it("invokes onRecorded callback", () => {
    const tracker = new TokenTracker();
    const callbacks: unknown[] = [];
    tracker.record(
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      (usage) => callbacks.push(usage),
    );
    expect(callbacks).toHaveLength(1);
    expect((callbacks[0] as { promptTokens: number }).promptTokens).toBe(100);
  });

  it("does not invoke callback when usage is null", () => {
    const tracker = new TokenTracker();
    let called = false;
    tracker.record(null, () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  it("does not invoke callback on double-count guard", () => {
    const tracker = new TokenTracker();
    let callCount = 0;
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    tracker.record(usage, () => {
      callCount++;
    });
    tracker.record(usage, () => {
      callCount++;
    });
    expect(callCount).toBe(1);
  });
});

describe("TokenTracker — getUsage()", () => {
  it("returns a defensive copy", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    const usage1 = tracker.getUsage();
    const usage2 = tracker.getUsage();
    expect(usage1).not.toBe(usage2);
    expect(usage1).toEqual(usage2);
  });

  it("mutations to returned object do not affect internal state", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    const usage = tracker.getUsage();
    usage.promptTokens = 9999;
    const usage2 = tracker.getUsage();
    expect(usage2.promptTokens).toBe(100);
  });
});

describe("TokenTracker — clear()", () => {
  it("resets all counters to zero", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    tracker.clear();
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(0);
    expect(usage.cachedTokens).toBe(0);
    expect(usage.completionTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
    expect(usage.turns).toBe(0);
    expect(usage.lastPromptTokens).toBe(0);
    expect(usage.lastCachedTokens).toBe(0);
    expect(usage.lastCompletionTokens).toBe(0);
    expect(usage.lastTotalTokens).toBe(0);
  });

  it("can record again after clear", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    tracker.clear();
    tracker.record({
      prompt_tokens: 200,
      completion_tokens: 100,
      total_tokens: 300,
    });
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(200);
    expect(usage.turns).toBe(1);
  });

  it("clear is idempotent", () => {
    const tracker = new TokenTracker();
    tracker.clear();
    tracker.clear();
    const usage = tracker.getUsage();
    expect(usage.turns).toBe(0);
  });
});

describe("TokenTracker — cached token edge cases", () => {
  it("handles missing prompt_tokens_details", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(100);
    expect(usage.cachedTokens).toBe(0);
  });

  it("handles zero cached tokens", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens: 50,
      total_tokens: 150,
    });
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(100);
    expect(usage.cachedTokens).toBe(0);
  });

  it("handles all cached (prompt equals cached)", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 100 },
      completion_tokens: 50,
      total_tokens: 150,
    });
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(0);
    expect(usage.cachedTokens).toBe(100);
  });

  it("accumulates cached tokens across calls", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens: 50,
      total_tokens: 150,
    });
    tracker.record({
      prompt_tokens: 200,
      prompt_tokens_details: { cached_tokens: 100 },
      completion_tokens: 100,
      total_tokens: 300,
    });
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(160); // (100-40) + (200-100)
    expect(usage.cachedTokens).toBe(140); // 40 + 100
  });
});
