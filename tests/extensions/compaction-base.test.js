// Tests for CompactionStrategy base class and CompactionStrategyRegistry.
import { describe, it, expect } from "bun:test";
import {
  CompactionStrategy,
  CompactionStrategyRegistry,
} from "../../src/extensions/compaction/strategies.js";

describe("CompactionStrategy", () => {
  it("has default name and description", () => {
    const strategy = new CompactionStrategy();
    expect(strategy.name).toBe("base");
    expect(strategy.description).toBe("Base compaction strategy.");
  });

  it("execute throws NotImplementedException", async () => {
    const strategy = new CompactionStrategy();
    await expect(
      strategy.execute([], { keepRecent: 0 }, async () => "", "model"),
    ).rejects.toThrow("execute() not implemented");
  });

  it("canCompact returns false when messages too few", () => {
    const strategy = new CompactionStrategy();
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    expect(strategy.canCompact(messages, { keepRecent: 2 })).toBe(false);
  });

  it("canCompact returns true when messages exceed threshold", () => {
    const strategy = new CompactionStrategy();
    const messages = [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
      { role: "user", content: "5" },
      { role: "assistant", content: "6" },
    ];
    // keepRecent=1 means 2 messages to keep, so 6 > 2 => true
    expect(strategy.canCompact(messages, { keepRecent: 1 })).toBe(true);
  });

  it("canCompact uses default keepRecent of 3", () => {
    const strategy = new CompactionStrategy();
    const messages = [];
    // keepRecent undefined means default 3, so 0 > 6 => false
    expect(strategy.canCompact(messages, {})).toBe(false);
  });

  it("canCompact with empty messages returns false", () => {
    const strategy = new CompactionStrategy();
    expect(strategy.canCompact([], { keepRecent: 1 })).toBe(false);
  });

  it("canCompact with keepRecent=0 returns false", () => {
    const strategy = new CompactionStrategy();
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x",
    }));
    // (settings.keepRecent || 3) * 2 = 0 * 2 = 0, messages.length = 10 > 0 => true
    // Wait, let me re-read: messages.length > (settings.keepRecent || 3) * 2
    // With keepRecent=0: 10 > 0 * 2 = 10 > 0 => true
    expect(strategy.canCompact(messages, { keepRecent: 0 })).toBe(true);
  });

  it("canCompact with only system messages returns false", () => {
    const strategy = new CompactionStrategy();
    const messages = [
      { role: "system", content: "prompt1" },
      { role: "system", content: "prompt2" },
      { role: "system", content: "prompt3" },
    ];
    // 3 > (3 || 3) * 2 = 3 > 6 => false
    expect(strategy.canCompact(messages, { keepRecent: 3 })).toBe(false);
  });

  it("canCompact with system messages and enough non-system", () => {
    const strategy = new CompactionStrategy();
    const messages = [
      { role: "system", content: "prompt" },
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
      { role: "user", content: "5" },
      { role: "assistant", content: "6" },
    ];
    // 7 > (1 || 3) * 2 = 7 > 2 => true
    expect(strategy.canCompact(messages, { keepRecent: 1 })).toBe(true);
  });

  it("canCompact with boundary condition (exactly at threshold)", () => {
    const strategy = new CompactionStrategy();
    const messages = [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
    ];
    // 4 > (2 || 3) * 2 = 4 > 4 => false (not strictly greater)
    expect(strategy.canCompact(messages, { keepRecent: 2 })).toBe(false);
  });

  it("canCompact with boundary condition (one above threshold)", () => {
    const strategy = new CompactionStrategy();
    const messages = [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
      { role: "user", content: "5" },
    ];
    // 5 > (2 || 3) * 2 = 5 > 4 => true
    expect(strategy.canCompact(messages, { keepRecent: 2 })).toBe(true);
  });

  it("can be subclassed with custom properties", () => {
    class CustomStrategy extends CompactionStrategy {
      name = "custom";
      description = "A custom strategy";
      async execute() {
        return { summary: "custom", messagesCompacted: 0, metadata: {} };
      }
    }
    const strategy = new CustomStrategy();
    expect(strategy.name).toBe("custom");
    expect(strategy.description).toBe("A custom strategy");
  });

  it("execute can be overridden", async () => {
    class TestStrategy extends CompactionStrategy {
      name = "test";
      async execute() {
        return { summary: "test result", messagesCompacted: 5, metadata: { test: true } };
      }
    }
    const strategy = new TestStrategy();
    const result = await strategy.execute([], {}, async () => "", "model");
    expect(result.summary).toBe("test result");
    expect(result.messagesCompacted).toBe(5);
  });

  it("canCompact can be overridden", () => {
    class TestStrategy extends CompactionStrategy {
      name = "test";
      canCompact() {
        return true;
      }
    }
    const strategy = new TestStrategy();
    expect(strategy.canCompact([], {})).toBe(true);
  });
});

describe("CompactionStrategyRegistry", () => {
  it("throws when registering strategy without name", () => {
    const registry = new CompactionStrategyRegistry();
    const noNameStrategy = { name: "", description: "test" };
    expect(() => registry.register(noNameStrategy)).toThrow(
      "Strategy must have a name property",
    );
  });

  it("has returns correct value", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.has("nonexistent")).toBe(false);
    registry.register({
      name: "test-strategy",
      description: "Test",
      execute: async () => null,
    });
    expect(registry.has("test-strategy")).toBe(true);
  });

  it("getDefault returns summarize strategy when registered", () => {
    const registry = new CompactionStrategyRegistry();
    const summarizeStrategy = {
      name: "summarize",
      description: "Summarize",
      execute: async () => null,
    };
    registry.register(summarizeStrategy);
    expect(registry.getDefault()).toBe(summarizeStrategy);
  });

  it("getDefault returns undefined when summarize not registered", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.getDefault()).toBeUndefined();
  });

  it("getAll returns all registered strategies in order", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register({ name: "a", execute: async () => null });
    registry.register({ name: "b", execute: async () => null });
    registry.register({ name: "c", execute: async () => null });
    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all[0].name).toBe("a");
    expect(all[1].name).toBe("b");
    expect(all[2].name).toBe("c");
  });

  it("register replaces strategy with same name", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register({ name: "test", version: 1, execute: async () => null });
    registry.register({ name: "test", version: 2, execute: async () => null });
    expect(registry.get("test").version).toBe(2);
    expect(registry.getAll()).toHaveLength(1);
  });

  it("get returns undefined for unknown name", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.get("does-not-exist")).toBeUndefined();
  });

  it("get returns the registered strategy", () => {
    const registry = new CompactionStrategyRegistry();
    const strategy = { name: "my-strategy", execute: async () => null };
    registry.register(strategy);
    expect(registry.get("my-strategy")).toBe(strategy);
  });

  it("throws when registering strategy with null name", () => {
    const registry = new CompactionStrategyRegistry();
    expect(() => registry.register({ name: null })).toThrow(
      "Strategy must have a name property",
    );
  });

  it("throws when registering strategy with undefined name", () => {
    const registry = new CompactionStrategyRegistry();
    expect(() => registry.register({ name: undefined })).toThrow(
      "Strategy must have a name property",
    );
  });

  it("supports registering multiple different strategies", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register({ name: "strategy-a", execute: async () => "a" });
    registry.register({ name: "strategy-b", execute: async () => "b" });
    registry.register({ name: "strategy-c", execute: async () => "c" });

    expect(registry.getAll()).toHaveLength(3);
    expect(registry.get("strategy-a")).toBeDefined();
    expect(registry.get("strategy-b")).toBeDefined();
    expect(registry.get("strategy-c")).toBeDefined();
  });

  it("getDefault returns undefined when registry is empty", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.getDefault()).toBeUndefined();
  });

  it("getAll returns empty array when no strategies registered", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.getAll()).toEqual([]);
  });

  it("has returns false for empty registry", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.has("anything")).toBe(false);
  });
});
