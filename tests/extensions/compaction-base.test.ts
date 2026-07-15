// Tests for CompactionStrategy base class and CompactionStrategyRegistry.
import { describe, it, expect } from "bun:test";
import {
  CompactionStrategy,
  CompactionStrategyRegistry,
  CompactionSettings,
} from "../../src/extensions/compaction/strategies.ts";

describe("CompactionStrategy", () => {
  it("has default name and description", () => {
    const strategy = new CompactionStrategy();
    expect(strategy.name).toBe("base");
    expect(strategy.description).toBe("Base compaction strategy.");
  });

  it("execute throws NotImplementedException", async () => {
    const strategy = new CompactionStrategy();
    const settings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecent: 0 };
    await expect(
      strategy.execute([], settings, async () => "", "model"),
    ).rejects.toThrow("execute() not implemented");
  });

  describe("canCompact", () => {
    it("returns false for too few messages", () => {
      const strategy = new CompactionStrategy();
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ];
      const settings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecent: 2 };
      expect(strategy.canCompact(messages, settings)).toBe(false);
    });

    it("returns true when messages exceed threshold", () => {
      const strategy = new CompactionStrategy();
      const messages = Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant", content: "x",
      }));
      const settings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecent: 1 };
      expect(strategy.canCompact(messages, settings)).toBe(true);
    });

    it("returns false for empty messages", () => {
      const settings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecent: 1 };
      expect(new CompactionStrategy().canCompact([], settings)).toBe(false);
    });

    it("handles keepRecent=0 (uses default 3)", () => {
      const strategy = new CompactionStrategy();
      const emptySettings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecent: 0 };
      expect(strategy.canCompact([], emptySettings)).toBe(false);
      const settings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecent: 0 };
      expect(strategy.canCompact(
        Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x" })),
        settings,
      )).toBe(true);
    });

    it("ignores system messages in count", () => {
      const strategy = new CompactionStrategy();
      const settings1: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecent: 3 };
      expect(strategy.canCompact(
        [{ role: "system", content: "p1" }, { role: "system", content: "p2" }],
        settings1,
      )).toBe(false);

      const settings2: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecent: 1 };
      expect(strategy.canCompact(
        [
          { role: "system", content: "prompt" },
          ...Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x" })),
        ],
        settings2,
      )).toBe(true);
    });

    it("boundary: exactly at threshold returns false, one above returns true", () => {
      const strategy = new CompactionStrategy();
      const four = Array.from({ length: 4 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x" }));
      const settings1: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecent: 2 };
      expect(strategy.canCompact(four, settings1)).toBe(false); // 4 > 4 => false
      const settings2: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecent: 2 };
      expect(strategy.canCompact([...four, { role: "user", content: "x" }], settings2)).toBe(true); // 5 > 4 => true
    });
  });

  describe("subclassing", () => {
    it("can be subclassed with custom properties", () => {
      class CustomStrategy extends CompactionStrategy {
        override name = "custom";
        override description = "A custom strategy";
        override async execute() {
          return { summary: "custom", messagesCompacted: 0, metadata: {} };
        }
      }
      const strategy = new CustomStrategy();
      expect(strategy.name).toBe("custom");
      expect(strategy.description).toBe("A custom strategy");
    });

    it("execute can be overridden", async () => {
      class TestStrategy extends CompactionStrategy {
        override name = "test";
        override async execute(_messages: any, _settings: any, _llmChat: any, _model: any) {
          return { summary: "test result", messagesCompacted: 5, metadata: { test: true } };
        }
      }
      const strategy = new TestStrategy();
      const settings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecent: 0 };
      const result = await strategy.execute([], settings, async () => "", "model");
      expect(result!.summary).toBe("test result");
      expect(result!.messagesCompacted).toBe(5);
    });

    it("canCompact can be overridden", () => {
      class TestStrategy extends CompactionStrategy {
        override name = "test";
        override canCompact(_messages: any, _settings: any) { return true; }
      }
      expect(new TestStrategy().canCompact([], { enabled: true, reserveTokens: 0, keepRecent: 0 })).toBe(true);
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
    const strategy = new (class extends CompactionStrategy {
      override name = "my-strategy";
      override async execute() { return null; }
    })();
    registry.register(strategy);
    expect(registry.get("my-strategy")).toBe(strategy);
    expect(registry.has("my-strategy")).toBe(true);
  });

  it("get returns undefined for unknown name", () => {
    expect(new CompactionStrategyRegistry().get("does-not-exist")).toBeUndefined();
  });

  it("getAll returns strategies in registration order", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register(new (class extends CompactionStrategy { override name = "a"; override async execute() { return null; } })());
    registry.register(new (class extends CompactionStrategy { override name = "b"; override async execute() { return null; } })());
    registry.register(new (class extends CompactionStrategy { override name = "c"; override async execute() { return null; } })());
    const all = registry.getAll();
    expect(all.map(s => s.name)).toEqual(["a", "b", "c"]);
  });

  it("register replaces strategy with same name", () => {
    const registry = new CompactionStrategyRegistry();
    const s1 = new (class extends CompactionStrategy { override name = "test"; override async execute() { return null; } })();
    const s2 = new (class extends CompactionStrategy { override name = "test"; override async execute() { return null; } })();
    (s2 as any).version = 2;
    registry.register(s1);
    registry.register(s2);
    expect(registry.get("test")).toBe(s2);
    expect(registry.getAll()).toHaveLength(1);
  });

  it("throws when registering strategy without name", () => {
    const registry = new CompactionStrategyRegistry();
    const noName = new (class extends CompactionStrategy {
      override name = "";
      override async execute() { return null; }
    })();
    expect(() => registry.register(noName)).toThrow(
      "Strategy must have a name property",
    );
  });

  it("getDefault returns summarize strategy when registered", () => {
    const registry = new CompactionStrategyRegistry();
    const summarizeStrategy = new (class extends CompactionStrategy {
      override name = "summarize";
      override description = "Summarize";
      override async execute() { return null; }
    })();
    registry.register(summarizeStrategy);
    expect(registry.getDefault()).toBe(summarizeStrategy);
  });
});
