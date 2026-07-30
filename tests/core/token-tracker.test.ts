// Tests for the TokenTracker class.

import { TokenTracker } from "../../src/core/token-tracker.ts";
import { describe, it, expect } from "bun:test";

describe("TokenTracker", () => {
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

  it("ignores null and undefined usage", () => {
    const tracker = new TokenTracker();
    tracker.record(null);
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

  it("does not invoke callback on double-count guard", () => {
    const tracker = new TokenTracker();
    let callCount = 0;
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    tracker.record(usage, () => { callCount++; });
    tracker.record(usage, () => { callCount++; });
    expect(callCount).toBe(1);
  });

  it("returns a defensive copy that cannot mutate internal state", () => {
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

    usage1.promptTokens = 9999;
    expect(tracker.getUsage().promptTokens).toBe(100);
  });

  it("clear resets all counters and allows recording again", () => {
    const tracker = new TokenTracker();
    tracker.record({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    tracker.clear();
    expect(tracker.getUsage().turns).toBe(0);

    tracker.record({
      prompt_tokens: 200,
      completion_tokens: 100,
      total_tokens: 300,
    });
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(200);
    expect(usage.turns).toBe(1);
  });

  it("handles all cached tokens", () => {
    const tracker = new TokenTracker();
    tracker.record({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens: 50, total_tokens: 150 });
    expect(tracker.getUsage().promptTokens).toBe(0);
    expect(tracker.getUsage().cachedTokens).toBe(100);
  });

  it("accumulates cached tokens across calls", () => {
    const tracker = new TokenTracker();
    tracker.record({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens: 50, total_tokens: 150 });
    tracker.record({ prompt_tokens: 200, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens: 100, total_tokens: 300 });
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(160); // (100-40) + (200-100)
    expect(usage.cachedTokens).toBe(140); // 40 + 100
  });
});
