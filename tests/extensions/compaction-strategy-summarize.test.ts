// Tests for SummarizeStrategy compaction strategy.
import { describe, it, expect, beforeEach } from "bun:test";
import { SummarizeStrategy } from "../../src/extensions/compaction/strategies/summarize.ts";
import { CompactionSettings } from "../../src/extensions/compaction/strategies.ts";
import { Message } from "../../src/core/context/message.ts";
import { AgentError } from "../../src/core/error.ts";

function msg(role: string, content: string) {
  return new Message({ role, content });
}

const defaultSettings: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentMessages: 2,
};

describe("SummarizeStrategy", () => {
  let strategy: SummarizeStrategy;

  beforeEach(() => {
    strategy = new SummarizeStrategy();
  });

  it("has correct name and description", () => {
    expect(strategy.name).toBe("summarize");
    expect(strategy.description).toContain("LLM-based summarization");
  });

  describe("canCompact", () => {
    it("returns false when not enough messages", () => {
      const messages = [msg("user", "hello"), msg("assistant", "hi")];
      expect(strategy.canCompact(messages, defaultSettings)).toBe(false);
    });

    it("returns true when enough messages exist", () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", "x"),
      );
      expect(strategy.canCompact(messages, defaultSettings)).toBe(true);
    });
  });

  describe("execute", () => {
    it("returns null when nothing to compact", async () => {
      const messages = [msg("user", "hello"), msg("assistant", "hi")];
      const result = await strategy.execute(
        messages,
        defaultSettings,
        async () => "summary",
        "model",
      );
      expect(result).toBeNull();
    });

    it("returns null when keepRecentMessages is 0", async () => {
      const messages = [msg("user", "hello"), msg("assistant", "hi")];
      const settings = { ...defaultSettings, keepRecentMessages: 0 };
      const result = await strategy.execute(
        messages,
        settings,
        async () => "summary",
        "model",
      );
      expect(result).toBeNull();
    });

    it("compacts messages and returns summary", async () => {
      const messages = [
        msg("user", "first message"),
        msg("assistant", "first response"),
        msg("user", "second message"),
        msg("assistant", "second response"),
        msg("user", "recent message"),
        msg("assistant", "recent response"),
      ];

      let capturedMessages: Array<{ role: string; content: string }> | null = null;
      let capturedModel: string | null = null;
      const mockLlmChat = async (msgs: Array<{ role: string; content: string }>, model: string) => {
        capturedMessages = msgs;
        capturedModel = model;
        return "This is the summary";
      };

      const result = await strategy.execute(
        messages,
        defaultSettings,
        mockLlmChat,
        "test-model",
      );

      expect(result).not.toBeNull();
      expect(result!.summary).toBe("This is the summary");
      expect(result!.messagesCompacted).toBeGreaterThan(0);
      expect(result!.metadata).toBeDefined();
      expect(result!.metadata!.strategyName).toBe("summarize");
      expect(typeof result!.metadata!.tokensBefore).toBe("number");
      expect(typeof result!.metadata!.tokensAfter).toBe("number");
      expect((result!.metadata!.tokensBefore as number) > (result!.metadata!.tokensAfter as number)).toBe(true);
    });

    it("calls llmChat with correct system prompt", async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", "x"),
      );

      let capturedSystemPrompt = "";
      const mockLlmChat = async (msgs: Array<{ role: string; content: string }>, _model: string) => {
        capturedSystemPrompt = msgs.find((m) => m.role === "system")!.content;
        return "summary";
      };

      await strategy.execute(messages, defaultSettings, mockLlmChat, "model");

      expect(capturedSystemPrompt).toContain("context summarization assistant");
      expect(capturedSystemPrompt).toContain("Do NOT continue the conversation");
    });

    it("calls llmChat with full user prompt template containing conversation", async () => {
      const messages = [
        msg("user", "What is the capital of France?"),
        msg("assistant", "Paris."),
        msg("user", "Tell me about Germany"),
        msg("assistant", "Germany is in Europe."),
        msg("user", "recent message 1"),
        msg("assistant", "recent response 1"),
        msg("user", "recent message 2"),
        msg("assistant", "recent response 2"),
      ];

      let capturedUserPrompt = "";
      const mockLlmChat = async (msgs: Array<{ role: string; content: string }>, _model: string) => {
        capturedUserPrompt = msgs.find((m) => m.role === "user")!.content;
        return "summary";
      };

      await strategy.execute(messages, defaultSettings, mockLlmChat, "model");

      expect(capturedUserPrompt).toContain("structured context checkpoint summary");
      expect(capturedUserPrompt).toContain("## Goal");
      expect(capturedUserPrompt).toContain("## Progress");
      expect(capturedUserPrompt).toContain("What is the capital of France?");
      expect(capturedUserPrompt).toContain("Paris.");
      expect(capturedUserPrompt).not.toContain("recent message 2");
    });

    it("does not interpret $-replacement patterns in conversation text", async () => {
      // $&, $' and $` are special in String.prototype.replace() replacement
      // strings; the conversation must land in the prompt verbatim.
      const marker = "replace $& with $' and keep $` intact";
      const messages = [
        msg("user", marker),
        msg("assistant", "done"),
        msg("user", "recent message 1"),
        msg("assistant", "recent response 1"),
        msg("user", "recent message 2"),
        msg("assistant", "recent response 2"),
      ];

      let capturedUserPrompt = "";
      const mockLlmChat = async (msgs: Array<{ role: string; content: string }>, _model: string) => {
        capturedUserPrompt = msgs.find((m) => m.role === "user")!.content;
        return "summary";
      };

      await strategy.execute(messages, defaultSettings, mockLlmChat, "model");

      expect(capturedUserPrompt).toContain(marker);
    });

    it("passes the model to llmChat", async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", "x"),
      );

      let capturedModel = "";
      const mockLlmChat = async (_msgs: Array<{ role: string; content: string }>, model: string) => {
        capturedModel = model;
        return "summary";
      };

      await strategy.execute(messages, defaultSettings, mockLlmChat, "custom-model");

      expect(capturedModel).toBe("custom-model");
    });

    it("throws AgentError when llmChat fails", async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", "x"),
      );

      const mockLlmChat = async () => {
        throw new Error("Network error");
      };

      await expect(
        strategy.execute(messages, defaultSettings, mockLlmChat, "model"),
      ).rejects.toThrow(AgentError);
      await expect(
        strategy.execute(messages, defaultSettings, mockLlmChat, "model"),
      ).rejects.toThrow("Summarization failed: Network error");
    });

    it("skips system messages when counting recent messages to keep", async () => {
      const messages = [
        msg("user", "old"),
        msg("assistant", "old"),
        msg("system", "system prompt"),
        msg("user", "recent"),
        msg("assistant", "recent"),
      ];

      const mockLlmChat = async () => "summary";
      const result = await strategy.execute(
        messages,
        defaultSettings,
        mockLlmChat,
        "model",
      );

      expect(result).not.toBeNull();
      expect(result!.messagesCompacted).toBeGreaterThan(0);
    });
  });
});
