import { describe, it, expect } from "bun:test";
import { buildModelRegistry } from "../../src/core/config.js";
import { parseFrontMatter } from "../../src/core/utils.js";

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
