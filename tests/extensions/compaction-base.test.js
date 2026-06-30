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
});
