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

  describe("canCompact", () => {
    it("returns false for too few messages", () => {
      const strategy = new CompactionStrategy();
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ];
      expect(strategy.canCompact(messages, { keepRecent: 2 })).toBe(false);
    });

    it("returns true when messages exceed threshold", () => {
      const strategy = new CompactionStrategy();
      const messages = Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant", content: "x",
      }));
      expect(strategy.canCompact(messages, { keepRecent: 1 })).toBe(true);
    });

    it("returns false for empty messages", () => {
      expect(new CompactionStrategy().canCompact([], { keepRecent: 1 })).toBe(false);
    });

    it("handles keepRecent=0 (uses default 3)", () => {
      const strategy = new CompactionStrategy();
      expect(strategy.canCompact([], {})).toBe(false);
      expect(strategy.canCompact(
        Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x" })),
        { keepRecent: 0 },
      )).toBe(true);
    });

    it("ignores system messages in count", () => {
      const strategy = new CompactionStrategy();
      expect(strategy.canCompact(
        [{ role: "system", content: "p1" }, { role: "system", content: "p2" }],
        { keepRecent: 3 },
      )).toBe(false);

      expect(strategy.canCompact(
        [
          { role: "system", content: "prompt" },
          ...Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x" })),
        ],
        { keepRecent: 1 },
      )).toBe(true);
    });

    it("boundary: exactly at threshold returns false, one above returns true", () => {
      const strategy = new CompactionStrategy();
      const four = Array.from({ length: 4 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x" }));
      expect(strategy.canCompact(four, { keepRecent: 2 })).toBe(false); // 4 > 4 => false
      expect(strategy.canCompact([...four, { role: "user", content: "x" }], { keepRecent: 2 })).toBe(true); // 5 > 4 => true
    });
  });

  describe("subclassing", () => {
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
        canCompact() { return true; }
      }
      expect(new TestStrategy().canCompact([], {})).toBe(true);
    });
  });
});

describe("CompactionStrategyRegistry", () => {
  it("starts empty", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.getAll()).toEqual([]);
    expect(registry.has("anything")).toBe(false);
    expect(registry.getDefault()).toBeUndefined();
  });

  it("registers and retrieves strategies", () => {
    const registry = new CompactionStrategyRegistry();
    const strategy = { name: "my-strategy", execute: async () => null };
    registry.register(strategy);
    expect(registry.get("my-strategy")).toBe(strategy);
    expect(registry.has("my-strategy")).toBe(true);
  });

  it("get returns undefined for unknown name", () => {
    expect(new CompactionStrategyRegistry().get("does-not-exist")).toBeUndefined();
  });

  it("getAll returns strategies in registration order", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register({ name: "a", execute: async () => null });
    registry.register({ name: "b", execute: async () => null });
    registry.register({ name: "c", execute: async () => null });
    const all = registry.getAll();
    expect(all.map(s => s.name)).toEqual(["a", "b", "c"]);
  });

  it("register replaces strategy with same name", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register({ name: "test", version: 1, execute: async () => null });
    registry.register({ name: "test", version: 2, execute: async () => null });
    expect(registry.get("test").version).toBe(2);
    expect(registry.getAll()).toHaveLength(1);
  });

  it("throws when registering strategy without name", () => {
    const registry = new CompactionStrategyRegistry();
    expect(() => registry.register({ name: "", description: "test" })).toThrow(
      "Strategy must have a name property",
    );
    expect(() => registry.register({ name: null })).toThrow(
      "Strategy must have a name property",
    );
    expect(() => registry.register({ name: undefined })).toThrow(
      "Strategy must have a name property",
    );
  });

  it("getDefault returns summarize strategy when registered", () => {
    const registry = new CompactionStrategyRegistry();
    const summarizeStrategy = {
      name: "summarize", description: "Summarize", execute: async () => null,
    };
    registry.register(summarizeStrategy);
    expect(registry.getDefault()).toBe(summarizeStrategy);
  });
});
