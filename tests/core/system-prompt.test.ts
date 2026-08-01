import { describe, it, expect } from "bun:test";
import {
  buildSystemPrompt,
  loadSystemPromptTemplate,
  SystemPromptBuilder,
  createSystemPromptBuilder,
  collectSystemPromptChunks,
} from "../../src/core/context/system-prompt.ts";

describe("buildSystemPrompt", () => {
  it("builds a system prompt with role and chunks", async () => {
    const result = await buildSystemPrompt(
      "You are a test assistant.",
      "Test body content",
      "qwen3.5-0.8b",
      "test",
      [
        {
          name: "test:chunk",
          priority: 100,
          content: "\n# Test Chunk\n\nTest content here",
        },
      ],
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("You are a test assistant.");
    expect(result).toContain("Test content here");
  });

  it("renders chunks in the order provided", async () => {
    const result = await buildSystemPrompt(
      "test",
      "",
      "test",
      "test",
      [
        { name: "a:first", priority: 100, content: "\n# First" },
        { name: "a:second", priority: 200, content: "\n# Second" },
      ],
    );
    const firstIdx = result.indexOf("# First");
    const secondIdx = result.indexOf("# Second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("handles empty chunks and inputs gracefully", async () => {
    const result = await buildSystemPrompt(
      "test",
      "",
      "test",
      "test",
      [],
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("test");
  });

  it("includes body when provided", async () => {
    const result = await buildSystemPrompt(
      "test",
      "Custom body text",
      "test",
      "test",
      [],
    );
    expect(result).toContain("Custom body text");
  });
});

describe("loadSystemPromptTemplate", () => {
  it("returns and caches the template string", async () => {
    const template1 = await loadSystemPromptTemplate();
    const template2 = await loadSystemPromptTemplate();
    expect(typeof template1).toBe("string");
    expect(template1.length).toBeGreaterThan(0);
    expect(template1).toBe(template2);
  });
});

describe("collectSystemPromptChunks", () => {
  it("collects chunks from hook results", () => {
    const results = [
      { result: { name: "chunk1", priority: 100, content: "content1" }, source: "ext1" },
      { result: { name: "chunk2", priority: 50, content: "content2" }, source: null },
    ];
    const chunks = collectSystemPromptChunks(results);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.name).toBe("chunk2"); // lower priority first
    expect(chunks[1]!.name).toBe("ext1:chunk1");
  });

  it("handles arrays of chunks from a single result", () => {
    const results = [
      {
        result: [
          { name: "a", priority: 10, content: "A" },
          { name: "b", priority: 20, content: "B" },
        ],
        source: "ext",
      },
    ];
    const chunks = collectSystemPromptChunks(results);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.name).toBe("ext:a");
    expect(chunks[1]!.name).toBe("ext:b");
  });

  it("ignores invalid items", () => {
    const results = [
      { result: { name: "valid", priority: 10, content: "ok" }, source: null },
      { result: { name: "no-content", priority: 10 }, source: null },
      { result: null, source: null },
      { result: {}, source: null },
    ];
    const chunks = collectSystemPromptChunks(results);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.name).toBe("valid");
  });
});

describe("SystemPromptBuilder", () => {
  const mockHooks = {
    runHookPipeline: async (_name: string, _data: unknown) => ({
      results: [
        {
          result: { name: "test-chunk", priority: 100, content: "\n# Test" },
          source: "test",
        },
      ],
    }),
  };

  const mockConfig = {
    role: "Test role",
    profileBody: "Test body",
    model: "test-model",
    profileName: "test-profile",
  };

  it("starts with no cached prompt", () => {
    const builder = new SystemPromptBuilder();
    expect(builder.getPrompt()).toBeNull();
    expect(builder.isBuilt()).toBe(false);
  });

  it("builds and caches the system prompt", async () => {
    const builder = new SystemPromptBuilder();
    const prompt = await builder.build(mockHooks, {}, mockConfig);
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("Test role");
    expect(builder.getPrompt()).toBe(prompt);
    expect(builder.isBuilt()).toBe(true);
  });

  it("ensureBuilt returns cached prompt without rebuilding", async () => {
    const builder = new SystemPromptBuilder();
    const first = await builder.ensureBuilt(mockHooks, {}, mockConfig);
    const second = await builder.ensureBuilt(mockHooks, {}, mockConfig);
    expect(first).toBe(second);
  });

  it("clear removes the cached prompt", async () => {
    const builder = new SystemPromptBuilder();
    await builder.build(mockHooks, {}, mockConfig);
    expect(builder.isBuilt()).toBe(true);
    builder.clear();
    expect(builder.getPrompt()).toBeNull();
    expect(builder.isBuilt()).toBe(false);
  });

  it("uses default values for missing config fields", async () => {
    const builder = new SystemPromptBuilder();
    const prompt = await builder.build(mockHooks, {}, {
      role: undefined,
      profileBody: undefined,
      model: "fallback-model",
      profileName: undefined,
    });
    expect(typeof prompt).toBe("string");
  });
});

describe("createSystemPromptBuilder", () => {
  it("creates a new SystemPromptBuilder instance", () => {
    const builder = createSystemPromptBuilder();
    expect(builder).toBeInstanceOf(SystemPromptBuilder);
    expect(builder.getPrompt()).toBeNull();
  });
});
