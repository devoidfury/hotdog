// Tests for providers.ts — buildModelRegistry, resolveProvider, initSystemPromptTemplate.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  buildModelRegistry,
  resolveProvider,
  initSystemPromptTemplate,
  resetSystemPromptCache,
} from "../../src/core/config/providers.ts";
import { writeFileSync, unlinkSync } from "node:fs";

// ── buildModelRegistry ──────────────────────────────────────────────────────

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
      contextLimit: 32000,
      reasoningEffort: undefined,
      tags: [],
    });
  });

  it("handles provider-level default model", () => {
    const config = {
      providers: [{ name: "test", defaultModel: "gpt-3.5", temperature: 0.5, models: [] }],
    };
    const registry = buildModelRegistry(config, 32000);
    expect(registry["test/gpt-3.5"]).toBeDefined();
    expect(registry["test/gpt-3.5"]!.temperature).toBe(0.5);
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
    expect(registry["ai365/dsv4"]!.reasoningEffort).toBe("max");
    expect(registry["ai365/qwen"]!.reasoningEffort).toBe("high");
    expect(registry["ai365/basic"]!.reasoningEffort).toBeUndefined();
  });
});

// ── resolveProvider ─────────────────────────────────────────────────────────

describe("resolveProvider", () => {
  it("returns null when no provider name or default is given", () => {
    expect(resolveProvider({}, { providers: [] })).toBeNull();
    expect(resolveProvider({ provider: undefined }, { providers: [] })).toBeNull();
    expect(resolveProvider({}, {})).toBeNull();
  });

  it("returns provider when CLI provider matches", () => {
    const config = {
      providers: [
        { name: "openai", url: "http://openai.com" },
        { name: "anthropic", url: "http://anthropic.com" },
      ],
    } as any;
    const result = resolveProvider({ provider: "openai" }, config);
    expect(result!.name).toBe("openai");
    expect((result as any).url).toBe("http://openai.com");
  });

  it("returns provider when config defaultProvider matches", () => {
    const config = {
      defaultProvider: "anthropic",
      providers: [
        { name: "openai", url: "http://openai.com" },
        { name: "anthropic", url: "http://anthropic.com" },
      ],
    } as any;
    const result = resolveProvider({}, config);
    expect(result!.name).toBe("anthropic");
  });

  it("CLI provider overrides config defaultProvider", () => {
    const config = {
      defaultProvider: "anthropic",
      providers: [
        { name: "openai", url: "http://openai.com" },
        { name: "anthropic", url: "http://anthropic.com" },
      ],
    } as any;
    const result = resolveProvider({ provider: "openai" }, config);
    expect(result!.name).toBe("openai");
  });

  it("returns null when provider name not found", () => {
    expect(resolveProvider({ provider: "nonexistent" }, { providers: [{ name: "openai" }] as any })).toBeNull();
    expect(resolveProvider({ provider: "test" }, {})).toBeNull();
  });
});

// ── initSystemPromptTemplate ────────────────────────────────────────────────

describe("initSystemPromptTemplate", () => {
  beforeEach(() => { resetSystemPromptCache(); });
  afterEach(() => { resetSystemPromptCache(); });

  it("loads template from explicit path", async () => {
    const tmpFile = "/tmp/test-system-prompt.md";
    writeFileSync(tmpFile, "This is a test template {{ role }}");

    try {
      const template = await initSystemPromptTemplate(tmpFile, undefined, undefined);
      expect(template).toContain("This is a test template");
      expect(template).toContain("{{ role }}");
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  });

  it("returns cached template on second call", async () => {
    const tmpFile = "/tmp/test-system-prompt2.md";
    writeFileSync(tmpFile, "Template v1");

    try {
      const template1 = await initSystemPromptTemplate(tmpFile, undefined, undefined);
      expect(template1).toBe("Template v1");

      writeFileSync(tmpFile, "Template v2");
      const template2 = await initSystemPromptTemplate(tmpFile, undefined, undefined);
      expect(template2).toBe("Template v1"); // cached
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  });

  it("falls back to default template when file not found", async () => {
    const template = await initSystemPromptTemplate("/nonexistent/path.md", undefined, undefined);
    expect(template).toContain("{{ role }}");
    expect(template).toContain("{{ body }}");
  });

  it("falls back to config directory when no explicit path", async () => {
    const template = await initSystemPromptTemplate(undefined, undefined, () => "./config");
    expect(template.length).toBeGreaterThan(0);
  });

  it("resetSystemPromptCache clears the cache", async () => {
    const tmpFile = "/tmp/test-system-prompt3.md";
    writeFileSync(tmpFile, "Template before reset");

    try {
      const template1 = await initSystemPromptTemplate(tmpFile, undefined, undefined);
      expect(template1).toBe("Template before reset");

      resetSystemPromptCache();
      writeFileSync(tmpFile, "Template after reset");

      const template2 = await initSystemPromptTemplate(tmpFile, undefined, undefined);
      expect(template2).toBe("Template after reset");
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  });
});
