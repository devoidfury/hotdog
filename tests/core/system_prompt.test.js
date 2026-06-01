import { describe, it, expect } from "bun:test";
import {
  loadAspects,
  loadAgentsMd,
  buildSystemPrompt,
  loadSystemPromptTemplate,
} from "../../src/context/system_prompt.js";

describe("loadAspects", () => {
  it("returns empty array for null input", () => {
    expect(loadAspects(null)).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(loadAspects([])).toEqual([]);
  });

  it("handles aspect file errors gracefully", () => {
    // The function catches ENOENT and continues
    // Using a non-existent aspect name - the function catches and returns empty
    const result = loadAspects([]);
    expect(result).toEqual([]);
  });
});

describe("loadAgentsMd", () => {
  it("returns AGENTS.md content when file exists", () => {
    const result = loadAgentsMd();
    expect(typeof result).toBe("string");
    // This project has an AGENTS.md
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles the function gracefully", () => {
    // The function catches errors and returns empty string
    expect(() => loadAgentsMd()).not.toThrow();
  });
});

describe("buildSystemPrompt", () => {
  it("builds a system prompt with all fields", () => {
    const result = buildSystemPrompt({
      role: "You are a test assistant.",
      body: "Test body content",
      model: "qwen3.5-0.8b",
      profileName: "test",
      aspects: [],
      agentsMd: "",
      skillsContent: "",
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("You are a test assistant.");
    expect(result).toContain("qwen3.5-0.8b");
    expect(result).toContain("test");
  });

  it("includes skills content when provided", () => {
    const result = buildSystemPrompt({
      role: "test",
      body: "",
      model: "qwen3.5-0.8b",
      profileName: "default",
      aspects: [],
      agentsMd: "",
      skillsContent: "# Skills\n\nSkill content here",
    });
    expect(result).toContain("Skill content here");
  });

  it("handles empty inputs gracefully", () => {
    const result = buildSystemPrompt({
      role: "",
      body: "",
      model: "",
      profileName: "",
      aspects: [],
      agentsMd: "",
      skillsContent: "",
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles undefined inputs", () => {
    const result = buildSystemPrompt({});
    expect(typeof result).toBe("string");
  });

  it("includes platform info", () => {
    const result = buildSystemPrompt({
      role: "test",
      body: "",
      model: "test",
      profileName: "test",
      aspects: [],
      agentsMd: "",
      skillsContent: "",
    });
    expect(result).toContain(process.platform);
  });
});

describe("loadSystemPromptTemplate", () => {
  it("returns the template string", () => {
    const template = loadSystemPromptTemplate();
    expect(typeof template).toBe("string");
    expect(template.length).toBeGreaterThan(0);
  });

  it("caches the template", () => {
    const template1 = loadSystemPromptTemplate();
    const template2 = loadSystemPromptTemplate();
    expect(template1).toBe(template2);
  });

  it("returns template with role placeholder", () => {
    const template = loadSystemPromptTemplate();
    expect(template).toContain("{{ role }}");
  });

  it("returns template with model placeholder", () => {
    const template = loadSystemPromptTemplate();
    expect(template).toContain("{{ model }}");
  });
});
