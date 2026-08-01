// Tests for DropStrategy compaction strategy.
import { describe, it, expect, beforeEach } from "bun:test";
import { DropStrategy } from "../../src/extensions/compaction/strategies/drop.ts";
import { CompactionSettings } from "../../src/extensions/compaction/strategies.ts";
import { Message } from "../../src/core/context/message.ts";

function msg(role: string, content: string) {
  return new Message({ role, content });
}

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
  });

  describe("execute", () => {
    it("returns null when nothing to compact", async () => {
      const messages = [msg("user", "hello"), msg("assistant", "hi")];
      const result = await strategy.execute(messages, defaultSettings);
      expect(result).toBeNull();
    });

    it("returns null when keepRecentMessages is 0", async () => {
      const messages = [msg("user", "hello"), msg("assistant", "hi")];
      const settings = { ...defaultSettings, keepRecentMessages: 0 };
      const result = await strategy.execute(messages, settings);
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

      const result = await strategy.execute(messages, defaultSettings);

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

      const result = await strategy.execute(messages, defaultSettings);

      expect(result).not.toBeNull();
      expect(result!.messagesCompacted).toBeGreaterThan(0);
    });
  });
});
