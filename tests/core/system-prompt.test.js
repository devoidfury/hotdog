import { describe, it, expect } from "bun:test";
import {
  buildSystemPrompt,
  loadSystemPromptTemplate,
} from "../../src/core/context/system-prompt.js";
import { loadAspects } from "../../src/utils/file-utils.js";

describe("loadAspects (utility)", () => {
  it("returns empty array for null/empty input", async () => {
    expect(await loadAspects(null)).toEqual([]);
    expect(await loadAspects([])).toEqual([]);
  });

  it("handles aspect file errors gracefully", async () => {
    const result = await loadAspects(["nonexistent-aspect"]);
    expect(result).toEqual([]);
  });
});

describe("buildSystemPrompt", () => {
  it("builds a system prompt with role and chunks", async () => {
    const result = await buildSystemPrompt({
      role: "You are a test assistant.",
      body: "Test body content",
      model: "qwen3.5-0.8b",
      profileName: "test",
      chunks: [
        {
          name: "test:chunk",
          priority: 100,
          content: "\n# Test Chunk\n\nTest content here",
        },
      ],
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("You are a test assistant.");
    expect(result).toContain("Test content here");
  });

  it("renders chunks in the order provided", async () => {
    const result = await buildSystemPrompt({
      role: "test",
      body: "",
      model: "test",
      profileName: "test",
      chunks: [
        { name: "a:first", priority: 100, content: "\n# First" },
        { name: "a:second", priority: 200, content: "\n# Second" },
      ],
    });
    const firstIdx = result.indexOf("# First");
    const secondIdx = result.indexOf("# Second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("handles empty chunks and inputs gracefully", async () => {
    const result = await buildSystemPrompt({
      role: "test",
      body: "",
      model: "test",
      profileName: "test",
      chunks: [],
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("test");
  });

  it("includes body when provided", async () => {
    const result = await buildSystemPrompt({
      role: "test",
      body: "Custom body text",
      model: "test",
      profileName: "test",
      chunks: [],
    });
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
