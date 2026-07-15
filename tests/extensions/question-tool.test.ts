// Tests for the question tool — non-interactive mode only.

import { describe, it, expect, beforeEach } from "bun:test";
import { QuestionTool, create } from "../../src/extensions/question-tool/index.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";

describe("QuestionTool", () => {
  let tool: QuestionTool;

  beforeEach(() => {
    tool = new QuestionTool();
  });

  describe("toToolDef", () => {
    it("has correct name and description", () => {
      const def = tool.toToolDef();
      expect(def.function.name).toBe("question");
      expect(def.function.description).toContain("Ask the user");
    });

    it("requires questions parameter", () => {
      const def = tool.toToolDef();
      expect(def.function.parameters.required).toContain("questions");
    });

    it("defines question item schema with key and prompt", () => {
      const def = tool.toToolDef();
      const questionsParam = (def.function.parameters.properties as Record<string, unknown>).questions as { items: { properties: Record<string, unknown> } };
      expect(questionsParam.items.properties.key).toBeDefined();
      expect(questionsParam.items.properties.prompt).toBeDefined();
      expect(questionsParam.items.properties.options).toBeDefined();
      expect(questionsParam.items.properties.required).toBeDefined();
      expect(questionsParam.items.properties.default).toBeDefined();
      expect(questionsParam.items.properties.allow_other).toBeDefined();
    });
  });

  describe("callDisplay", () => {
    it("shows question count", () => {
      const input = JSON.stringify({
        questions: [
          { key: "a", prompt: "Q1" },
          { key: "b", prompt: "Q2" },
        ],
      });
      expect(tool.callDisplay(input)).toBe("asking 2 question(s)...");
    });

    it("handles empty input with fallback", () => {
      expect(tool.callDisplay("")).toBe("asking questions...");
    });

    it("handles invalid JSON with fallback", () => {
      expect(tool.callDisplay("not json")).toBe("asking questions...");
    });
  });

  describe("execute - non-interactive (CI mode)", () => {
    const originalCI = process.env.CI;

    beforeEach(() => {
      process.env.CI = "1";
    });

    it("returns defaults for all questions", async () => {
      const input = JSON.stringify({
        questions: [
          { key: "name", prompt: "Name?", default: "Anonymous" },
          { key: "notes", prompt: "Notes?", default: "None" },
        ],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output);
      expect(output.name).toBe("Anonymous");
      expect(output.notes).toBe("None");
    });

    it("returns empty string when no default", async () => {
      const input = JSON.stringify({
        questions: [{ key: "color", prompt: "Pick a color" }],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output);
      expect(output.color).toBe("");
    });

    it("rejects empty questions array", async () => {
      const input = JSON.stringify({ questions: [] });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(false);
      expect(result.error).toContain("At least one question");
    });

    it("rejects invalid JSON", async () => {
      const result = await tool.execute("not json", null!);
      expect(result.success).toBe(false);
    });

    it("handles field alias: question -> prompt", async () => {
      const input = JSON.stringify({
        questions: [
          { key: "choice", question: "Which one?", choices: ["A", "B"] },
        ],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
    });

    it("generates key from prompt when missing", async () => {
      const input = JSON.stringify({
        questions: [{ prompt: "What is your name?" }],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output);
      expect("what_is_your_name" in output).toBe(true);
    });

    it("includes metadata entries", async () => {
      const input = JSON.stringify({
        questions: [{ key: "a", prompt: "Q?" }],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
      expect(result.metadata!.get("mode")).toBe("non-interactive");
      expect(result.metadata!.get("questions_asked")).toBe("1");
      expect(result.metadata!.get("questions_answered")).toBe("1");
    });

    it("rejects empty key", async () => {
      const input = JSON.stringify({
        questions: [{ key: "", prompt: "Q?" }],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(false);
      expect(result.error).toContain("key cannot be empty");
    });

    it("rejects missing prompt", async () => {
      const input = JSON.stringify({
        questions: [{ key: "a" }],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(false);
      expect(result.error).toContain("missing a prompt");
    });
  });
});

describe("QuestionTool create() extension", () => {
  it("returns extension with tools:register hook", async () => {
    const ext = create({} as CoreContext);
    expect(ext).toBeDefined();
    expect(ext.hooks).toBeDefined();
    expect(ext.hooks!['tools:register']).toBeDefined();
    expect(ext.QuestionTool).toBe(QuestionTool);
  });

  it("registers question tool via hook", async () => {
    const ext = create({} as CoreContext);
    const registry = { register: (name: string, tool: unknown) => { expect(name).toBe('question'); expect(tool).toBeInstanceOf(QuestionTool); }, getAll: () => [] };
    await (ext.hooks!['tools:register'] as Function)(registry);
  });
});
