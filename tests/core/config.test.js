import { describe, it, expect } from "bun:test";
import { buildModelRegistry } from "../../src/core/config/providers.js";
import { normalizeConfigKeys } from "../../src/core/config/index.js";
import { parseFrontMatter } from "../../src/utils/file-utils.js";

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
    const registry = buildModelRegistry(config);
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
    const registry = buildModelRegistry(config);
    expect(registry["test/gpt-3.5"]).toBeDefined();
    expect(registry["test/gpt-3.5"].temperature).toBe(0.5);
  });

  it("handles empty or multiple providers", () => {
    expect(buildModelRegistry({})).toEqual({});
    const config = {
      providers: [
        { name: "a", models: [{ name: "m1" }] },
        { name: "b", models: [{ name: "m2" }] },
      ],
    };
    const registry = buildModelRegistry(config);
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
    const registry = buildModelRegistry(config);
    expect(registry["ai365/dsv4"].reasoningEffort).toBe("max");
    expect(registry["ai365/qwen"].reasoningEffort).toBe("high");
    expect(registry["ai365/basic"].reasoningEffort).toBeUndefined();
  });
});

describe("normalizeConfigKeys", () => {
  it("converts snake_case keys to camelCase recursively", () => {
    const input = {
      default_model: "test",
      hide_tools: true,
      profiles: {
        default: { blacklist_tools: ["patch"] },
      },
      mcp_servers: [
        { enabled: true, name: "test-server", blacklist_tools: ["dangerous"] },
      ],
    };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({
      defaultModel: "test",
      hideTools: true,
      profiles: {
        default: { blacklistTools: ["patch"] },
      },
      mcpServers: [
        { enabled: true, name: "test-server", blacklistTools: ["dangerous"] },
      ],
    });
  });

  it("leaves camelCase keys unchanged", () => {
    const input = { defaultModel: "test", hideTools: true };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({ defaultModel: "test", hideTools: true });
  });

  it("handles deeply nested structures", () => {
    const input = {
      providers: [
        {
          name: "test",
          models: [
            { name: "model-1", context_limit: 1000, parallel_tool_calling: true },
          ],
        },
      ],
    };
    const result = normalizeConfigKeys(input);
    expect(result.providers[0].models[0]).toEqual({
      name: "model-1",
      contextLimit: 1000,
      parallelToolCalling: true,
    });
  });

  it("handles null, primitives, and empty values", () => {
    expect(normalizeConfigKeys(null)).toBeNull();
    expect(normalizeConfigKeys("string")).toBe("string");
    expect(normalizeConfigKeys(42)).toBe(42);
    expect(normalizeConfigKeys({})).toEqual({});
    expect(normalizeConfigKeys([])).toEqual([]);
  });

  it("converts kebab-case keys to camelCase as well", () => {
    const input = { "kebab-case": "value", snake_case: "other" };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({ kebabCase: "value", snakeCase: "other" });
  });

  it("handles real-world config structure", () => {
    const input = {
      default_model: "ai365/qwen3.6-27b",
      hide_tools: true,
      show_token_use: true,
      skills_path: "/skills",
      extension_paths: ["builtins"],
      extension_autoload: true,
      default_subcommand: "cli",
      chat_timeout_secs: 900,
      profiles: {
        default: { blacklist_tools: ["patch", "explore"] },
        explorer: { model: "ai365/lfm2.5-8b-a1b", blacklist_tools: ["patch", "write"] },
      },
      mcp_servers: [
        { enabled: true, name: "bun-docs-mcp", url: "https://bun.com/docs/mcp" },
      ],
      providers: [
        {
          name: "ai365",
          url: "http://localhost:9292",
          api_key: "test-key",
          models: [{ name: "qwen3.5-4b", context_limit: 262144, tags: ["general", "fast"] }],
        },
      ],
    };
    const result = normalizeConfigKeys(input);
    expect(result.defaultModel).toBe("ai365/qwen3.6-27b");
    expect(result.hideTools).toBe(true);
    expect(result.profiles.default.blacklistTools).toEqual(["patch", "explore"]);
    expect(result.providers[0].apiKey).toBe("test-key");
    expect(result.providers[0].models[0].contextLimit).toBe(262144);
  });
});
