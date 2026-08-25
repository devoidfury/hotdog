// Tests for CompactionStrategy base class and CompactionStrategyRegistry.
import { describe, it, expect } from "bun:test";
import {
  CompactionStrategy,
  CompactionStrategyRegistry,
  CompactionSettings,
} from "../../src/extensions/compaction/strategies.ts";
import { Message } from "../../src/core/context/message.ts";

function msg(role: string, content: string) {
  return new Message({ role, content });
}

describe("CompactionStrategy", () => {
  it("has default name and description", () => {
    const strategy = new CompactionStrategy();
    expect(strategy.name).toBe("base");
    expect(strategy.description).toBe("Base compaction strategy.");
  });

  it("execute throws NotImplementedException", async () => {
    const strategy = new CompactionStrategy();
    const settings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecentMessages: 0 };
    await expect(
      strategy.execute([], settings, async () => "", "model"),
    ).rejects.toThrow("execute() not implemented");
  });

  describe("canCompact", () => {
    it("returns false for too few messages", () => {
      const strategy = new CompactionStrategy();
      const messages = [
        msg("user", "hello"),
        msg("assistant", "hi"),
      ];
      const settings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecentMessages: 2 };
      expect(strategy.canCompact(messages, settings)).toBe(false);
    });

    it("returns true when messages exceed threshold", () => {
      const strategy = new CompactionStrategy();
      const messages = Array.from({ length: 6 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", "x"),
      );
      const settings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecentMessages: 1 };
      expect(strategy.canCompact(messages, settings)).toBe(true);
    });

    it("returns false for empty messages", () => {
      const settings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecentMessages: 1 };
      expect(new CompactionStrategy().canCompact([], settings)).toBe(false);
    });

    it("treats keepRecentMessages=0 as a zero threshold", () => {
      const strategy = new CompactionStrategy();
      const settings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecentMessages: 0 };
      expect(strategy.canCompact([], settings)).toBe(false);
      expect(strategy.canCompact([msg("user", "x")], settings)).toBe(true);
    });

    it("counts all messages, including system (no filtering in the base class)", () => {
      const strategy = new CompactionStrategy();
      // With a zero threshold, system-only messages still count -- DropStrategy
      // overrides canCompact to exclude them, so this pins the base behavior.
      const settings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecentMessages: 0 };
      expect(strategy.canCompact([msg("system", "p1"), msg("system", "p2")], settings)).toBe(true);
    });

    it("boundary: exactly at threshold returns false, one above returns true", () => {
      const strategy = new CompactionStrategy();
      const four = Array.from({ length: 4 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", "x"));
      const settings1: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecentMessages: 2 };
      expect(strategy.canCompact(four, settings1)).toBe(false); // 4 > 4 => false
      const settings2: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecentMessages: 2 };
      expect(strategy.canCompact([...four, msg("user", "x")], settings2)).toBe(true); // 5 > 4 => true
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
