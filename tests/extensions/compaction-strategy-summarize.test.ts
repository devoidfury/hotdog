// Tests for the LLM summarization strategies: SummarizeStrategy and
// SummarizeShortStrategy. The two classes are identical except for the user
// prompt template they use, so they are tested together in a single
// parameterized suite against their respective templates.
import { describe, it, expect } from "bun:test";
import { SummarizeStrategy } from "../../src/extensions/compaction/strategies/summarize.ts";
import { SummarizeShortStrategy } from "../../src/extensions/compaction/strategies/summarize-short.ts";
import { CompactionSettings } from "../../src/extensions/compaction/strategies.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../src/extensions/compaction/prompts.ts";
import { Message } from "../../src/core/context/message.ts";
import { AgentError } from "../../src/core/error.ts";

function msg(role: string, content: string) {
  return new Message({ role, content });
}

const strategies = [
  {
    name: "summarize",
    Ctor: SummarizeStrategy,
    descriptionMarker: "LLM-based summarization",
    userPromptMarker: "structured context checkpoint summary",
  },
  {
    name: "summarize-short",
    Ctor: SummarizeShortStrategy,
    descriptionMarker: "Aggressive LLM summarization",
    userPromptMarker: "CONCISE structured summary",
  },
] as const;

const defaultSettings: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentMessages: 2,
};

for (const s of strategies) {
  describe(`${s.name} strategy`, () => {
    it("has correct name and description", () => {
      const strategy = new s.Ctor();
      expect(strategy.name).toBe(s.name);
      expect(strategy.description).toContain(s.descriptionMarker);
    });

    it("canCompact returns false when not enough messages", () => {
      const messages = [msg("user", "hello"), msg("assistant", "hi")];
      expect(new s.Ctor().canCompact(messages, defaultSettings)).toBe(false);
    });

    it("canCompact returns true when enough messages exist", () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        msg(i % 2 === 0 ? "user" : "assistant", "x"),
      );
      expect(new s.Ctor().canCompact(messages, defaultSettings)).toBe(true);
    });

    it("returns null when nothing to compact", async () => {
      const messages = [msg("user", "hello"), msg("assistant", "hi")];
      const result = await new s.Ctor().execute(messages, defaultSettings, async () => "summary", "model");
      expect(result).toBeNull();
    });

    it("returns null when keepRecentMessages is 0", async () => {
      const messages = [msg("user", "hello"), msg("assistant", "hi")];
      const result = await new s.Ctor().execute(
        messages,
        { ...defaultSettings, keepRecentMessages: 0 },
        async () => "summary",
        "model",
      );
      expect(result).toBeNull();
    });

    it("returns null when all messages are system messages", async () => {
      const messages = [msg("system", "prompt 1"), msg("system", "prompt 2")];
      const result = await new s.Ctor().execute(messages, defaultSettings, async () => "summary", "model");
      expect(result).toBeNull();
    });

    it("returns null for an empty message list", async () => {
      const result = await new s.Ctor().execute([], defaultSettings, async () => "summary", "model");
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
      const mockLlmChat = async (msgs: Array<{ role: string; content: string }>, _model: string) => {
        capturedMessages = msgs;
        return "This is the summary";
      };

      const result = await new s.Ctor().execute(messages, defaultSettings, mockLlmChat, "test-model");

      expect(result).not.toBeNull();
      expect(result!.summary).toBe("This is the summary");
      expect(result!.messagesCompacted).toBeGreaterThan(0);
      // The recent messages are kept, so the compaction must start before them.
      expect(result!.messagesCompacted).toBeLessThan(4);
      expect(capturedMessages).not.toBeNull();
      // Both strategies share the same system prompt.
      expect(capturedMessages![0]!.role).toBe("system");
      expect(capturedMessages![0]!.content).toBe(SUMMARIZATION_SYSTEM_PROMPT);
      expect(capturedMessages![1]!.role).toBe("user");
      expect(result!.metadata!.strategyName).toBe(s.name);
      expect(typeof result!.metadata!.tokensBefore).toBe("number");
      expect(typeof result!.metadata!.tokensAfter).toBe("number");
      expect((result!.metadata!.tokensBefore as number) > (result!.metadata!.tokensAfter as number)).toBe(true);
    });

    it("uses its own user prompt template containing only the compacted conversation", async () => {
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

      await new s.Ctor().execute(messages, defaultSettings, mockLlmChat, "model");

      expect(capturedUserPrompt).toContain(s.userPromptMarker);
      // Compacted messages are included...
      expect(capturedUserPrompt).toContain("What is the capital of France?");
      expect(capturedUserPrompt).toContain("Paris.");
      // ...recent ones are not.
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

      await new s.Ctor().execute(messages, defaultSettings, mockLlmChat, "model");

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

      await new s.Ctor().execute(messages, defaultSettings, mockLlmChat, "custom-model");

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
        new s.Ctor().execute(messages, defaultSettings, mockLlmChat, "model"),
      ).rejects.toThrow(AgentError);
      await expect(
        new s.Ctor().execute(messages, defaultSettings, mockLlmChat, "model"),
      ).rejects.toThrow("Summarization failed: Network error");
    });

  });
}
