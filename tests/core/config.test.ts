import { describe, it, expect } from "bun:test";
import { buildModelRegistry } from "../../src/core/config/providers.ts";
import { parseFrontMatter } from "../../src/utils/file-utils.ts";

describe("parseFrontMatter", () => {
  it("parses front matter and body", () => {
    const input = `---
title: Hello
description: A test
---
Body content`;
    const result = parseFrontMatter(input);
    expect(result).toEqual({
      frontMatter: { title: "Hello", description: "A test" },
      body: "Body content",
    });
  });

  it("handles booleans, numbers, and arrays", () => {
    const input = `---
active: true
count: 42
tags: [a, b, c]
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter).toEqual({ active: true, count: 42, tags: ["a", "b", "c"] });
  });

  it("returns null when no front matter", () => {
    expect(parseFrontMatter("just plain text")).toBeNull();
  });

  it("handles empty body and missing trailing newline", () => {
    expect(parseFrontMatter("---\ntitle: test\n---")).toEqual({ frontMatter: { title: "test" }, body: "" });
    expect(parseFrontMatter("---\nname: test\n---\nBody")).toEqual({ frontMatter: { name: "test" }, body: "Body" });
  });
});

describe("buildModelRegistry", () => {
  it("registers models from providers with defaults", () => {
    const config = {
      providers: [
        { name: "openai", models: [{ name: "gpt-4", temperature: 0.7 }] },
      ],
    };
    const registry = buildModelRegistry(config, 32000);
    expect(registry["openai/gpt-4"]).toEqual({
      name: "openai/gpt-4",
      temperature: 0.7,
      maxTokens: 32000,
      reasoningEffort: undefined,
      tags: [],
    });
  });

  it("handles provider-level default model", () => {
    const config = {
      providers: [{ name: "test", defaultModel: "gpt-3.5", temperature: 0.5 }],
    };
    const registry = buildModelRegistry(config, 32000);
    expect(registry["test/gpt-3.5"]).toBeDefined();
    expect(registry["test/gpt-3.5"].temperature).toBe(0.5);
  });

  it("handles empty or multiple providers", () => {
    expect(buildModelRegistry({}, 32000)).toEqual({});
    const config = {
      providers: [
        { name: "a", models: [{ name: "m1" }] },
        { name: "b", models: [{ name: "m2" }] },
      ],
    };
    const registry = buildModelRegistry(config, 32000);
    expect(registry["a/m1"]).toBeDefined();
    expect(registry["b/m2"]).toBeDefined();
  });

  it("extracts reasoning_effort from model entries", () => {
    const config = {
      providers: [
        {
          name: "ai365",
          models: [
            { name: "dsv4", reasoning_effort: "max" },
            { name: "qwen", reasoning_effort: "high" },
            { name: "basic" },
          ],
        },
      ],
    };
    const registry = buildModelRegistry(config, 32000);
    expect(registry["ai365/dsv4"].reasoningEffort).toBe("max");
    expect(registry["ai365/qwen"].reasoningEffort).toBe("high");
    expect(registry["ai365/basic"].reasoningEffort).toBeUndefined();
  });
});
