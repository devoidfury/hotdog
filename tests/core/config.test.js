import { describe, it, expect } from "bun:test";
import { buildModelRegistry } from "../../src/core/config/providers.js";
import { normalizeConfigKeys } from "../../src/core/config/index.js";
import { parseFrontMatter } from "../../src/utils/file-utils.js";

describe("parseFrontMatter", () => {
  it("parses simple front matter", () => {
    const input = `---
title: Hello
---
Body content`;
    const result = parseFrontMatter(input);
    expect(result).toEqual({
      frontMatter: { title: "Hello" },
      body: "Body content",
    });
  });

  it("parses front matter without trailing newline", () => {
    const input = `---
name: test
---
Body`;
    const result = parseFrontMatter(input);
    expect(result).toEqual({ frontMatter: { name: "test" }, body: "Body" });
  });

  it("handles empty body after front matter", () => {
    const input = `---
title: test
---`;
    const result = parseFrontMatter(input);
    expect(result).toEqual({ frontMatter: { title: "test" }, body: "" });
  });

  it("returns null when no front matter", () => {
    expect(parseFrontMatter("just plain text")).toBeNull();
  });

  it("parses multiple fields", () => {
    const input = `---
title: Hello
description: A test
author: John
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter).toEqual({
      title: "Hello",
      description: "A test",
      author: "John",
    });
  });

  it("parses booleans", () => {
    const input = `---
active: true
hidden: false
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter).toEqual({ active: true, hidden: false });
  });

  it("parses numbers", () => {
    const input = `---
count: 42
negative: -7
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter).toEqual({ count: 42, negative: -7 });
  });

  it("parses arrays", () => {
    const input = `---
tags: ["a", "b", "c"]
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter.tags).toEqual(["a", "b", "c"]);
  });

  it("parses arrays without quotes", () => {
    const input = `---
tags: [a, b, c]
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter.tags).toEqual(["a", "b", "c"]);
  });

  it("skips comments and blank lines in front matter", () => {
    const input = `---
# comment
title: Hello

---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter).toEqual({ title: "Hello" });
  });

  it("strips quotes from string values", () => {
    const input = `---
title: "Hello World"
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter.title).toBe("Hello World");
  });
});

describe("buildModelRegistry", () => {
  it("registers models from providers", () => {
    const config = {
      providers: [
        {
          name: "openai",
          models: [{ name: "gpt-4", temperature: 0.7 }],
        },
      ],
    };
    const registry = buildModelRegistry(config);
    expect(registry["openai/gpt-4"]).toEqual({
      name: "openai/gpt-4",
      temperature: 0.7,
      maxTokens: 32000,
    });
  });

  it("uses default max tokens when not specified", () => {
    const config = {
      providers: [{ name: "test", models: [{ name: "model" }] }],
    };
    const registry = buildModelRegistry(config);
    expect(registry["test/model"].maxTokens).toBe(32000);
  });

  it("handles provider-level default model", () => {
    const config = {
      providers: [{ name: "test", defaultModel: "gpt-3.5", temperature: 0.5 }],
    };
    const registry = buildModelRegistry(config);
    expect(registry["test/gpt-3.5"]).toEqual({
      name: "test/gpt-3.5",
      temperature: 0.5,
      maxTokens: 32000,
    });
  });

  it("handles empty providers", () => {
    expect(buildModelRegistry({})).toEqual({});
  });

  it("handles multiple providers", () => {
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
});

describe("normalizeConfigKeys", () => {
  it("converts simple snake_case keys to camelCase", () => {
    const input = { default_model: "test", hide_tools: true };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({ defaultModel: "test", hideTools: true });
  });

  it("leaves already camelCase keys unchanged", () => {
    const input = { defaultModel: "test", hideTools: true };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({ defaultModel: "test", hideTools: true });
  });

  it("handles mixed snake_case and camelCase keys", () => {
    const input = { default_model: "test", alreadyCamel: true, show_token_use: false };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({ defaultModel: "test", alreadyCamel: true, showTokenUse: false });
  });

  it("handles nested objects", () => {
    const input = {
      profiles: {
        default: {
          blacklist_tools: ["patch"],
          model: "test",
        },
      },
    };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({
      profiles: {
        default: {
          blacklistTools: ["patch"],
          model: "test",
        },
      },
    });
  });

  it("handles arrays of objects", () => {
    const input = {
      mcp_servers: [
        {
          enabled: true,
          name: "test-server",
          blacklist_tools: ["dangerous"],
        },
      ],
    };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({
      mcpServers: [
        {
          enabled: true,
          name: "test-server",
          blacklistTools: ["dangerous"],
        },
      ],
    });
  });

  it("handles deeply nested structures", () => {
    const input = {
      providers: [
        {
          name: "test",
          models: [
            {
              name: "model-1",
              context_limit: 1000,
              parallel_tool_calling: true,
            },
          ],
        },
      ],
    };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({
      providers: [
        {
          name: "test",
          models: [
            {
              name: "model-1",
              contextLimit: 1000,
              parallelToolCalling: true,
            },
          ],
        },
      ],
    });
  });

  it("handles null values", () => {
    const input = { default_model: null, hide_tools: true };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({ defaultModel: null, hideTools: true });
  });

  it("handles null object", () => {
    expect(normalizeConfigKeys(null)).toBeNull();
  });

  it("handles primitive values", () => {
    expect(normalizeConfigKeys("string")).toBe("string");
    expect(normalizeConfigKeys(42)).toBe(42);
    expect(normalizeConfigKeys(true)).toBe(true);
  });

  it("handles empty arrays", () => {
    expect(normalizeConfigKeys([])).toEqual([]);
  });

  it("handles empty objects", () => {
    expect(normalizeConfigKeys({})).toEqual({});
  });

  it("handles arrays with primitive values", () => {
    const input = { extension_paths: ["builtins", "custom"] };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({ extensionPaths: ["builtins", "custom"] });
  });

  it("handles keys with multiple underscores", () => {
    const input = { some_very_long_key: "value" };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({ someVeryLongKey: "value" });
  });

  it("preserves non-snake_case keys like kebab-case", () => {
    const input = { "kebab-case": "value", snake_case: "other" };
    const result = normalizeConfigKeys(input);
    expect(result).toEqual({ "kebab-case": "value", snakeCase: "other" });
  });

  it("handles real-world config structure from defaults.json", () => {
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
        default: {
          blacklist_tools: ["patch", "explore"],
        },
        explorer: {
          model: "ai365/lfm2.5-8b-a1b",
          blacklist_tools: ["patch", "write"],
        },
      },
      mcp_servers: [
        {
          enabled: true,
          name: "bun-docs-mcp",
          url: "https://bun.com/docs/mcp",
        },
      ],
      providers: [
        {
          name: "ai365",
          url: "http://localhost:9292",
          api_key: "test-key",
          models: [
            {
              name: "qwen3.5-4b",
              context_limit: 262144,
              tags: ["general", "fast"],
            },
          ],
        },
      ],
    };

    const result = normalizeConfigKeys(input);

    expect(result.defaultModel).toBe("ai365/qwen3.6-27b");
    expect(result.hideTools).toBe(true);
    expect(result.showTokenUse).toBe(true);
    expect(result.skillsPath).toBe("/skills");
    expect(result.extensionPaths).toEqual(["builtins"]);
    expect(result.extensionAutoload).toBe(true);
    expect(result.defaultSubcommand).toBe("cli");
    expect(result.chatTimeoutSecs).toBe(900);
    expect(result.profiles.default.blacklistTools).toEqual(["patch", "explore"]);
    expect(result.profiles.explorer.blacklistTools).toEqual(["patch", "write"]);
    expect(result.mcpServers[0].enabled).toBe(true);
    expect(result.mcpServers[0].name).toBe("bun-docs-mcp");
    expect(result.providers[0].apiKey).toBe("test-key");
    expect(result.providers[0].models[0].contextLimit).toBe(262144);
  });
});
