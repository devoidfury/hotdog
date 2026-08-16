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
  it("registers models from providers with defaults", async () => {
    const config = {
      providers: [
        { name: "openai", models: [{ name: "gpt-4", temperature: 0.7 }] },
      ],
    };
    const registry = await buildModelRegistry(config, 32000);
    expect(registry["openai/gpt-4"]).toEqual({
      name: "openai/gpt-4",
      temperature: 0.7,
      contextLimit: 32000,
      reasoningEffort: undefined,
      tags: [],
      capabilities: {},
      maxToolDifficulty: undefined,
    });
  });

  it("handles provider-level default model", async () => {
    const config = {
      providers: [{ name: "test", defaultModel: "gpt-3.5", temperature: 0.5, models: [] }],
    };
    const registry = await buildModelRegistry(config, 32000);
    expect(registry["test/gpt-3.5"]).toEqual({
      name: "test/gpt-3.5",
      temperature: 0.5,
      contextLimit: 32000,
      reasoningEffort: undefined,
      tags: [],
      capabilities: {},
      maxToolDifficulty: undefined,
    });
  });

  it("handles empty or multiple providers", async () => {
    expect(await buildModelRegistry({}, 32000)).toEqual({});
    const config = {
      providers: [
        { name: "a", models: [{ name: "m1" }] },
        { name: "b", models: [{ name: "m2" }] },
      ],
    };
    const registry = await buildModelRegistry(config, 32000);
    expect(registry["a/m1"]!.name).toBe("a/m1");
    expect(registry["b/m2"]!.name).toBe("b/m2");
  });

  it("extracts reasoning_effort from model entries", async () => {
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
    const registry = await buildModelRegistry(config, 32000);
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

// ── fetchModels (dynamic model loading) ─────────────────────────────────────

describe("buildModelRegistry with fetchModels", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches models from provider URL when fetchModels is true", async () => {
    globalThis.fetch = Object.assign(async () =>
      ({
        ok: true,
        json: async () => ({
          data: [
            { id: "remote-model-1", context_length: 8192 },
            { id: "remote-model-2", context_length: 16384, capabilities: { vision: true } },
          ],
        }),
      } as Response),
      { preconnect: async () => {} },
    );

    const config = {
      providers: [
        { name: "remote", url: "http://test.com", fetchModels: true, models: [] },
      ],
      baseUrl: "http://test.com",
    };
    const registry = await buildModelRegistry(config, 32000);
    expect(registry["remote/remote-model-1"]!.name).toBe("remote/remote-model-1");
    expect(registry["remote/remote-model-1"]!.contextLimit).toBe(8192);
    expect(registry["remote/remote-model-2"]!.name).toBe("remote/remote-model-2");
    expect(registry["remote/remote-model-2"]!.capabilities?.vision).toBe(true);
  });

  it("uses global baseUrl when provider has no URL", async () => {
    globalThis.fetch = Object.assign(async () =>
      ({
        ok: true,
        json: async () => ({
          data: [{ id: "inherited-url-model" }],
        }),
      } as Response),
      { preconnect: async () => {} },
    );

    const config = {
      providers: [
        { name: "ai365", fetchModels: true, models: [] },
      ],
      baseUrl: "http://global.com",
    };
    const registry = await buildModelRegistry(config, 32000);
    expect(registry["ai365/inherited-url-model"]!.name).toBe("ai365/inherited-url-model");
  });

  it("uses global apiKey when provider has no apiKey", async () => {
    let capturedAuth = "";
    globalThis.fetch = Object.assign(async (url: string | URL | RequestInfo, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization || "";
      return {
        ok: true,
        json: async () => ({ data: [{ id: "key-test" }] }),
      } as Response;
    }, { preconnect: async () => {} }) as typeof fetch;

    const config = {
      providers: [
        { name: "test", url: "http://test.com", fetchModels: true, models: [] },
      ],
      apiKey: "global-key-123",
    };
    await buildModelRegistry(config, 32000);
    expect(capturedAuth).toBe("Bearer global-key-123");
  });

  it("provider apiKey overrides global apiKey", async () => {
    let capturedAuth = "";
    globalThis.fetch = Object.assign(async (url: string | URL | RequestInfo, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization || "";
      return {
        ok: true,
        json: async () => ({ data: [{ id: "key-test" }] }),
      } as Response;
    }, { preconnect: async () => {} }) as typeof fetch;

    const config = {
      providers: [
        { name: "test", url: "http://test.com", apiKey: "provider-key-456", fetchModels: true, models: [] },
      ],
      apiKey: "global-key-123",
    };
    await buildModelRegistry(config, 32000);
    expect(capturedAuth).toBe("Bearer provider-key-456");
  });

  it("deep merges remote models with local ones, local takes priority but remote fills gaps", async () => {
    globalThis.fetch = Object.assign(async () =>
      ({
        ok: true,
        json: async () => ({
          data: [
            { id: "shared-model", context_length: 1000, tags: ["remote-tag"], capabilities: { vision: true } },
            { id: "remote-only", context_length: 2000 },
          ],
        }),
      } as Response),
      { preconnect: async () => {} },
    );

    const config = {
      providers: [
        {
          name: "test",
          url: "http://test.com",
          fetchModels: true,
          models: [{ name: "shared-model", contextLimit: 5000, temperature: 0.5, tags: ["local-tag"] }],
        },
      ],
    };
    const registry = await buildModelRegistry(config, 32000);
    // Local priority fields are kept
    expect(registry["test/shared-model"]!.contextLimit).toBe(5000);
    expect(registry["test/shared-model"]!.temperature).toBe(0.5);
    // Local tags overwrite remote tags
    expect(registry["test/shared-model"]!.tags).toEqual(["local-tag"]);
    // Remote-only model is added
    expect(registry["test/remote-only"]!.name).toBe("test/remote-only");
    expect(registry["test/remote-only"]!.contextLimit).toBe(2000);
  });

  it("handles fetch failure gracefully without crashing", async () => {
    globalThis.fetch = Object.assign(async () => {
      throw new Error("network error");
    }, { preconnect: async () => {} });

    const config = {
      providers: [
        { name: "test", url: "http://test.com", fetchModels: true, models: [{ name: "fallback" }] },
      ],
    };
    const registry = await buildModelRegistry(config, 32000);
    // Should still have local models
    expect(registry["test/fallback"]!.name).toBe("test/fallback");
  });

  it("expands aliases as separate model entries", async () => {
    globalThis.fetch = Object.assign(async () =>
      ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "base-model",
              meta: { llamaswap: { aliases: ["alias-1", "alias-2"] } },
            },
          ],
        }),
      } as Response),
      { preconnect: async () => {} },
    );

    const config = {
      providers: [
        { name: "test", url: "http://test.com", fetchModels: true, models: [] },
      ],
    };
    const registry = await buildModelRegistry(config, 32000);
    expect(registry["test/base-model"]!.name).toBe("test/base-model");
    expect(registry["test/alias-1"]!.name).toBe("test/alias-1");
    expect(registry["test/alias-2"]!.name).toBe("test/alias-2");
  });
});

// ── resolveModelConfig fallback ──────────────────────────────────────────────

import { findModelEntry, resolveModelConfig } from "../../src/core/config/providers.ts";

// ── findModelEntry ────────────────────────────────────────────────────────────

describe("findModelEntry", () => {
  const registry = {
    "laguna/laguna": { name: "laguna/laguna", temperature: null, contextLimit: 350000, tags: [] },
    "openai/gpt-4": { name: "openai/gpt-4", temperature: 0.5, contextLimit: 128000, tags: [] },
  };

  it("returns the entry on direct key match", () => {
    expect(findModelEntry("openai/gpt-4", registry)).toBe(registry["openai/gpt-4"]);
  });

  it("falls back to provider/modelName suffix match for bare names", () => {
    expect(findModelEntry("laguna", registry)).toBe(registry["laguna/laguna"]);
  });

  it("returns undefined when no key matches", () => {
    expect(findModelEntry("unknown", registry)).toBeUndefined();
  });

  it("does not suffix-match names that already contain a slash", () => {
    const deep = { "p/a/b": { name: "p/a/b", temperature: null, contextLimit: 1, tags: [] } };
    expect(findModelEntry("a/b", deep)).toBeUndefined();
  });
});

describe("resolveModelConfig fallback lookup", () => {
  type ModelEntry = { name: string; temperature: number | null; contextLimit: number; tags: string[] };

  it("falls back to provider/modelName when direct lookup fails", () => {
    const registry: Record<string, ModelEntry> = {
      "laguna/laguna": { name: "laguna/laguna", temperature: null, contextLimit: 350000, tags: [] },
    };
    const config = resolveModelConfig("laguna", registry, 128000, undefined);
    expect(config.contextLimit).toBe(350000);
    expect(config.name).toBe("laguna/laguna");
  });

  it("uses direct lookup and registry values when model name contains '/'", () => {
    const registry: Record<string, ModelEntry> = {
      "openai/gpt-4": { name: "openai/gpt-4", temperature: 0.5, contextLimit: 128000, tags: [] },
    };
    const config = resolveModelConfig("openai/gpt-4", registry, 32000, undefined);
    expect(config.contextLimit).toBe(128000);
  });

  it("falls back to default contextLimit when model not found at all", () => {
    const registry: Record<string, ModelEntry> = {
      "other/model": { name: "other/model", temperature: null, contextLimit: 64000, tags: [] },
    };
    const config = resolveModelConfig("unknown", registry, 128000, undefined);
    expect(config.contextLimit).toBe(128000);
    expect(config.name).toBe("unknown");
  });

  it("does not fallback for names with multiple slashes but works with full path", () => {
    const registry: Record<string, ModelEntry> = {
      "provider/some/deep/model": { name: "provider/some/deep/model", temperature: null, contextLimit: 200000, tags: [] },
    };
    expect(resolveModelConfig("some/deep/model", registry, 128000, undefined).contextLimit).toBe(128000);
    expect(resolveModelConfig("provider/some/deep/model", registry, 128000, undefined).contextLimit).toBe(200000);
  });
});
