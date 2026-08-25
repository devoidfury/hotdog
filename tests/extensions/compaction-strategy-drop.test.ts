// Tests for DropStrategy compaction strategy.
import { describe, it, expect, beforeEach } from "bun:test";
import { DropStrategy } from "../../src/extensions/compaction/strategies/drop.ts";
import { CompactionSettings } from "../../src/extensions/compaction/strategies.ts";
import { Message } from "../../src/core/context/message.ts";

function msg(role: string, content: string) {
  return new Message({ role, content });
}

const noopLlmChat = async (_messages: Array<{ role: string; content: string }>, _model: string): Promise<string> => "";

const defaultSettings: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentMessages: 2,
};

describe("DropStrategy", () => {
  let strategy: DropStrategy;

  beforeEach(() => {
    strategy = new DropStrategy();
  });

  it("has correct name and description", () => {
    expect(strategy.name).toBe("drop");
    expect(strategy.description).toContain("Keep the last N messages");
    expect(strategy.description).toContain("remove older messages without summarizing");
  });

  describe("canCompact", () => {
    it("returns false when not enough non-system messages", () => {
      const messages = [msg("user", "hello"), msg("assistant", "hi")];
      expect(strategy.canCompact(messages, defaultSettings)).toBe(false);
    });

    it("returns true when enough non-system messages exist", () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", "x"),
      );
      expect(strategy.canCompact(messages, defaultSettings)).toBe(true);
    });

    it("ignores system messages in count", () => {
      const messages = [
        msg("system", "prompt 1"),
        msg("system", "prompt 2"),
        msg("user", "hello"),
        msg("assistant", "hi"),
        msg("user", "next"),
        msg("assistant", "response"),
      ];
      expect(strategy.canCompact(messages, defaultSettings)).toBe(false);
    });

    it("counts correctly with mixed system and non-system messages", () => {
      const messages = [
        msg("system", "prompt"),
        ...Array.from({ length: 8 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", "x")),
      ];
      expect(strategy.canCompact(messages, defaultSettings)).toBe(true);
    });

    it("boundary: exactly at threshold returns false", () => {
      const messages = [
        msg("user", "m1"),
        msg("assistant", "a1"),
        msg("user", "m2"),
        msg("assistant", "a2"),
      ];
      const settings = { ...defaultSettings, keepRecentMessages: 2 };
      expect(strategy.canCompact(messages, settings)).toBe(false);
    });

    it("boundary: one above threshold returns true", () => {
      const messages = [
        msg("user", "m1"),
        msg("assistant", "a1"),
        msg("user", "m2"),
        msg("assistant", "a2"),
        msg("user", "m3"),
      ];
      const settings = { ...defaultSettings, keepRecentMessages: 2 };
      expect(strategy.canCompact(messages, settings)).toBe(true);
    });

    it("scales the threshold with keepRecentMessages", () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", "x"),
      );
      // threshold = keepRecent * 2: 10 > 6, but 10 < 12
      expect(strategy.canCompact(messages, { ...defaultSettings, keepRecentMessages: 3 })).toBe(true);
      expect(strategy.canCompact(messages, { ...defaultSettings, keepRecentMessages: 6 })).toBe(false);
    });

    it("treats keepRecentMessages=0 as a zero threshold", () => {
      const messages = [msg("user", "hello")];
      expect(strategy.canCompact(messages, { ...defaultSettings, keepRecentMessages: 0 })).toBe(true);
      expect(strategy.canCompact([], { ...defaultSettings, keepRecentMessages: 0 })).toBe(false);
    });
  });

  describe("execute", () => {
    it("returns null when nothing to compact", async () => {
      const messages = [msg("user", "hello"), msg("assistant", "hi")];
      const result = await strategy.execute(messages, defaultSettings, noopLlmChat, "model");
      expect(result).toBeNull();
    });

    it("returns null when keepRecentMessages is 0", async () => {
      const messages = [msg("user", "hello"), msg("assistant", "hi")];
      const settings = { ...defaultSettings, keepRecentMessages: 0 };
      const result = await strategy.execute(messages, settings, noopLlmChat, "model");
      expect(result).toBeNull();
    });

    it("drops old messages without summarizing", async () => {
      const messages = [
        msg("user", "first message"),
        msg("assistant", "first response"),
        msg("user", "second message"),
        msg("assistant", "second response"),
        msg("user", "recent message"),
        msg("assistant", "recent response"),
      ];

      const result = await strategy.execute(messages, defaultSettings, noopLlmChat, "model");

      expect(result).not.toBeNull();
      expect(result!.summary).toBeNull();
      expect(result!.messagesCompacted).toBeGreaterThan(0);
      expect(result!.metadata).toBeDefined();
      expect(result!.metadata!.strategyName).toBe("drop");
      expect(typeof result!.metadata!.tokensBefore).toBe("number");
      expect(typeof result!.metadata!.tokensAfter).toBe("number");
    });

    it("does not call llmChat (no summarization needed)", async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", "x"),
      );

      let llmCalled = false;
      const mockLlmChat = async () => {
        llmCalled = true;
        return "summary";
      };

      await strategy.execute(messages, defaultSettings, mockLlmChat, "model");

      expect(llmCalled).toBe(false);
    });

    it("skips system messages when counting recent messages to keep", async () => {
      const messages = [
        msg("user", "old"),
        msg("assistant", "old"),
        msg("system", "system prompt"),
        msg("user", "recent"),
        msg("assistant", "recent"),
      ];

      const result = await strategy.execute(messages, defaultSettings, noopLlmChat, "model");

      expect(result).not.toBeNull();
      expect(result!.messagesCompacted).toBeGreaterThan(0);
    });

    it("keeps exactly the last keepRecentMessages*2 non-system messages", async () => {
      const messages = Array.from({ length: 20 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", "x"),
      );

      const result = await strategy.execute(messages, { ...defaultSettings, keepRecentMessages: 5 }, noopLlmChat, "model");

      // keep 5*2 = 10 messages (indices 10-19), compact the first 11
      expect(result).not.toBeNull();
      expect(result!.messagesCompacted).toBe(11);
    });

    it("reports token savings in metadata", async () => {
      const content = "x".repeat(2000);
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", content),
      );

      const result = await strategy.execute(messages, defaultSettings, noopLlmChat, "model");

      const before = result!.metadata!.tokensBefore as number;
      const after = result!.metadata!.tokensAfter as number;
      expect(before).toBeGreaterThan(0);
      expect(after).toBeGreaterThan(0);
      expect(after).toBeLessThan(before);
    });

    it("returns null when all messages are system messages", async () => {
      const messages = [msg("system", "prompt 1"), msg("system", "prompt 2")];
      const result = await strategy.execute(messages, defaultSettings, noopLlmChat, "model");
      expect(result).toBeNull();
    });

    it("returns null for an empty message list", async () => {
      const result = await strategy.execute([], defaultSettings, noopLlmChat, "model");
      expect(result).toBeNull();
    });
  });
});
