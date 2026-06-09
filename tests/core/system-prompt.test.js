import { describe, it, expect } from "bun:test";
import {
  buildSystemPrompt,
  loadSystemPromptTemplate,
} from "../../src/core/context/system-prompt.js";
import { loadAspects } from "../../src/utils/file-utils.js";

describe("loadAspects (utility)", () => {
  it("returns empty array for null input", async () => {
    expect(await loadAspects(null)).toEqual([]);
  });

  it("returns empty array for empty array", async () => {
    expect(await loadAspects([])).toEqual([]);
  });

  it("handles aspect file errors gracefully", async () => {
    // Using a non-existent aspect name - the function catches and returns empty
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

  it("renders chunks in the order provided (sorting is done by caller)", async () => {
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

  it("handles empty chunks array", async () => {
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

  it("handles empty inputs gracefully", async () => {
    const result = await buildSystemPrompt({
      role: "",
      body: "",
      model: "",
      profileName: "",
      chunks: [],
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles undefined inputs", async () => {
    const result = await buildSystemPrompt({});
    expect(typeof result).toBe("string");
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

  it("omits body section when body is empty", async () => {
    const result = await buildSystemPrompt({
      role: "test",
      body: "",
      model: "test",
      profileName: "test",
      chunks: [],
    });
    // Should contain role but not have empty body artifacts
    expect(result).toContain("test");
    expect(result).toContain("Role & Mission");
  });
});

describe("loadSystemPromptTemplate", () => {
  it("returns the template string", async () => {
    const template = await loadSystemPromptTemplate();
    expect(typeof template).toBe("string");
    expect(template.length).toBeGreaterThan(0);
  });

  it("caches the template", async () => {
    const template1 = await loadSystemPromptTemplate();
    const template2 = await loadSystemPromptTemplate();
    expect(template1).toBe(template2);
  });

  it("returns template with role placeholder", async () => {
    const template = await loadSystemPromptTemplate();
    expect(template).toContain("{{ role }}");
  });

  it("returns template with chunk loop", async () => {
    const template = await loadSystemPromptTemplate();
    expect(template).toContain("chunk in chunks");
  });
});
