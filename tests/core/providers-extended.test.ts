// Tests for providers.js resolveProvider() and initSystemPromptTemplate().

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  resolveProvider,
  initSystemPromptTemplate,
  resetSystemPromptCache,
} from "../../src/core/config/providers.ts";
import { writeFileSync, unlinkSync } from "node:fs";

describe("resolveProvider", () => {
  it("returns null when no provider name is given", () => {
    expect(resolveProvider({}, { providers: [] })).toBeNull();
    expect(resolveProvider({ provider: null }, { providers: [] })).toBeNull();
    expect(resolveProvider({}, {})).toBeNull();
  });

  it("returns null when no defaultProvider is set", () => {
    expect(resolveProvider({}, { defaultProvider: null, providers: [] })).toBeNull();
    expect(resolveProvider({}, { providers: [] })).toBeNull();
  });

  it("returns provider when CLI provider matches", () => {
    const config = {
      providers: [
        { name: "openai", url: "http://openai.com" },
        { name: "anthropic", url: "http://anthropic.com" },
      ],
    };
    const result = resolveProvider({ provider: "openai" }, config);
    expect(result.name).toBe("openai");
    expect(result.url).toBe("http://openai.com");
  });

  it("returns provider when config defaultProvider matches", () => {
    const config = {
      defaultProvider: "anthropic",
      providers: [
        { name: "openai", url: "http://openai.com" },
        { name: "anthropic", url: "http://anthropic.com" },
      ],
    };
    const result = resolveProvider({}, config);
    expect(result.name).toBe("anthropic");
  });

  it("CLI provider overrides config defaultProvider", () => {
    const config = {
      defaultProvider: "anthropic",
      providers: [
        { name: "openai", url: "http://openai.com" },
        { name: "anthropic", url: "http://anthropic.com" },
      ],
    };
    const result = resolveProvider({ provider: "openai" }, config);
    expect(result.name).toBe("openai");
  });

  it("returns null when provider name not found in providers list", () => {
    const config = {
      providers: [{ name: "openai" }],
    };
    expect(resolveProvider({ provider: "nonexistent" }, config)).toBeNull();
  });

  it("returns null when config has no providers array", () => {
    expect(resolveProvider({ provider: "test" }, {})).toBeNull();
  });
});

describe("initSystemPromptTemplate", () => {
  beforeEach(() => {
    resetSystemPromptCache();
  });

  afterEach(() => {
    resetSystemPromptCache();
  });

  it("loads template from explicit path", async () => {
    const tmpFile = "/tmp/test-system-prompt.md";
    writeFileSync(tmpFile, "This is a test template {{ role }}");

    try {
      const template = await initSystemPromptTemplate(tmpFile, null, null);
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
      const template1 = await initSystemPromptTemplate(tmpFile, null, null);
      expect(template1).toBe("Template v1");

      // Change the file content (should not matter due to caching)
      writeFileSync(tmpFile, "Template v2");

      const template2 = await initSystemPromptTemplate(tmpFile, null, null);
      expect(template2).toBe("Template v1"); // cached
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  });

  it("falls back to default template when file not found", async () => {
    const template = await initSystemPromptTemplate("/nonexistent/path.md", null, null);
    expect(template).toContain("{{ role }}");
    expect(template).toContain("{{ body }}");
  });

  it("falls back to config directory when no explicit path", async () => {
    // This will try to load from ./config/system_prompt.md in the workspace
    // which exists, so it should return the real template
    const template = await initSystemPromptTemplate(null, null, () => "./config");
    expect(template.length).toBeGreaterThan(0);
    expect(typeof template).toBe("string");
  });

  it("resetSystemPromptCache clears the cache", async () => {
    const tmpFile = "/tmp/test-system-prompt3.md";
    writeFileSync(tmpFile, "Template before reset");

    try {
      const template1 = await initSystemPromptTemplate(tmpFile, null, null);
      expect(template1).toBe("Template before reset");

      resetSystemPromptCache();
      writeFileSync(tmpFile, "Template after reset");

      const template2 = await initSystemPromptTemplate(tmpFile, null, null);
      expect(template2).toBe("Template after reset");
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  });
});
