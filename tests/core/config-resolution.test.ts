import { describe, it, expect } from "bun:test";
import {
  resolveKey,
  resolveAll,
  CONFIG_SCHEMA as CONFIG_KEYS,
  resolveCast,
} from "../../src/core/config/schema-loader.ts";
import { getNested } from "../../src/utils/objects.ts";

describe("getNested", () => {
  it("returns top-level property", () => {
    expect(getNested({ url: "http://test" }, "url")).toBe("http://test");
  });

  it("returns nested property with dot path", () => {
    expect(getNested({ nested: { value: 42 } }, "nested.value")).toBe(42);
  });

  it("returns undefined for missing or null paths", () => {
    expect(getNested({ a: 1 }, "b.c")).toBeUndefined();
    expect(getNested({ a: null }, "a.b")).toBeUndefined();
    expect(getNested(null, "a.b")).toBeUndefined();
  });
});

// ── resolveKey ───────────────────────────────────────────────────────────

describe("resolveKey", () => {
  it("resolves from cli layer first", () => {
    const schema = {
      layers: [
        { source: "cli", key: "url" },
        { source: "config", key: "url" },
        { default: "http://default" },
      ],
    };
    const context = {
      cli: { url: "http://cli" },
      config: { url: "http://config" },
    };
    expect(resolveKey("url", schema, context)).toBe("http://cli");
  });

  it("falls through layers correctly", () => {
    const schema = {
      layers: [
        { source: "cli", key: "url" },
        { source: "config", key: "url" },
        { default: "http://default" },
      ],
    };
    // Config when cli is empty
    expect(resolveKey("url", schema, { cli: {}, config: { url: "http://config" } })).toBe("http://config");
    // Default when nothing
    expect(resolveKey("url", schema, { cli: {}, config: {} })).toBe("http://default");
  });

  it("uses function default", () => {
    const schema = {
      layers: [{ default: (ctx) => `dynamic-${ctx.profileName}` }],
    };
    expect(resolveKey("url", schema, { profileName: "test" })).toBe("dynamic-test");
  });

  it("skips layer when cast returns undefined", () => {
    const schema = {
      layers: [
        {
          source: "cli",
          key: "role",
          cast: (v) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined),
        },
        { default: "default role" },
      ],
    };
    expect(resolveKey("role", schema, { cli: { role: "   " } })).toBe("default role");
  });

  it("applies cast to resolved value", () => {
    const schema = {
      layers: [{ source: "cli", key: "name", cast: (v) => v.toUpperCase() }],
    };
    expect(resolveKey("name", schema, { cli: { name: "hello" } })).toBe("HELLO");
  });

  it("resolves from env source", () => {
    const schema = {
      layers: [
        { source: "env", key: "TEST_ENV_VAR" },
        { default: "default" },
      ],
    };
    process.env.TEST_ENV_VAR = "from-env";
    try {
      expect(resolveKey("key", schema, {})).toBe("from-env");
    } finally {
      delete process.env.TEST_ENV_VAR;
    }
  });

  it("skips null and empty string values", () => {
    const schema = {
      layers: [
        { source: "cli", key: "val" },
        { source: "config", key: "val" },
        { default: "fallback" },
      ],
    };
    expect(resolveKey("val", schema, { cli: { val: "" }, config: { val: "config-val" } })).toBe("config-val");
  });
});

describe("resolveAll", () => {
  it("resolves all keys from schema", () => {
    const schema = {
      key1: { layers: [{ source: "cli", key: "key1" }, { default: "default1" }] },
      key2: { layers: [{ source: "cli", key: "key2" }, { default: "default2" }] },
    };
    const result = resolveAll(schema, { cli: { key1: "value1" } });
    expect(result.key1).toBe("value1");
    expect(result.key2).toBe("default2");
  });
});

// ── CONFIG_KEYS schema ───────────────────────────────────────────────────

describe("CONFIG_KEYS schema", () => {
  const baseContext = {
    cli: {},
    config: {},
    provider: null,
    profile: {},
    profileName: "default",
    profilesPath: "./config/profiles",
  };

  it("baseUrl resolves with correct priority: provider > cli > config > env > default", () => {
    // Provider wins
    let context = {
      ...baseContext,
      provider: { url: "http://provider" },
      cli: { aiUrl: "http://cli" },
      config: { aiUrl: "http://config" },
    };
    expect(resolveKey("baseUrl", CONFIG_KEYS.baseUrl, context)).toBe("http://provider");

    // CLI when no provider
    context = { ...baseContext, cli: { aiUrl: "http://cli" } };
    expect(resolveKey("baseUrl", CONFIG_KEYS.baseUrl, context)).toBe("http://cli");

    // Config when no provider or cli
    context = { ...baseContext, config: { aiUrl: "http://config" } };
    expect(resolveKey("baseUrl", CONFIG_KEYS.baseUrl, context)).toBe("http://config");
  });

  it("apiKey resolves with correct priority including env fallback", () => {
    process.env.AI_API_KEY = "env-key";
    try {
      // Provider wins
      let context = {
        ...baseContext,
        provider: { apiKey: "provider-key" },
        cli: { apiKey: "cli-key" },
        config: { apiKey: "config-key" },
      };
      expect(resolveKey("apiKey", CONFIG_KEYS.apiKey, context)).toBe("provider-key");

      // Env as fallback
      context = { ...baseContext };
      expect(resolveKey("apiKey", CONFIG_KEYS.apiKey, context)).toBe("env-key");
    } finally {
      delete process.env.AI_API_KEY;
    }
  });

  it("stream inverts noStream cli flag", () => {
    expect(resolveKey("stream", CONFIG_KEYS.stream, { ...baseContext, cli: { noStream: true } })).toBe(false);
    expect(resolveKey("stream", CONFIG_KEYS.stream, { ...baseContext, cli: { noStream: false } })).toBe(true);
    expect(resolveKey("stream", CONFIG_KEYS.stream, baseContext)).toBe(true);
  });

  it("hideTools respects cli and config flags", () => {
    // --show-tools sets showTools=true -> cast falsy -> hideTools=false
    expect(resolveKey("hideTools", CONFIG_KEYS.hideTools, { ...baseContext, cli: { showTools: true } })).toBe(false);
    // --hide-tools sets hideTools=true
    expect(resolveKey("hideTools", CONFIG_KEYS.hideTools, { ...baseContext, cli: { hideTools: true } })).toBe(true);
    // CLI wins over config
    expect(resolveKey("hideTools", CONFIG_KEYS.hideTools, { ...baseContext, cli: { hideTools: true }, config: { hideTools: false } })).toBe(true);
  });

  it("showTokenUse respects cli.tokens and config", () => {
    expect(resolveKey("showTokenUse", CONFIG_KEYS.showTokenUse, { ...baseContext, cli: { tokens: true } })).toBe(true);
    expect(resolveKey("showTokenUse", CONFIG_KEYS.showTokenUse, { ...baseContext, config: { showTokenUse: true } })).toBe(true);
    // CLI overrides config
    expect(resolveKey("showTokenUse", CONFIG_KEYS.showTokenUse, {
      ...baseContext,
      cli: { tokens: true },
      config: { showTokenUse: false },
    })).toBe(true);
  });

  it("format strings resolve with correct fallback", () => {
    expect(resolveKey("thinkerFormat", CONFIG_KEYS.thinkerFormat, { ...baseContext, cli: { thinker: "custom" } })).toBe("custom");
    expect(resolveKey("thinkerFormat", CONFIG_KEYS.thinkerFormat, baseContext)).toBe("[Thinking: {}]");
  });

  it("timeouts resolve with correct fallback", () => {
    expect(resolveKey("chatTimeout", CONFIG_KEYS.chatTimeout, { ...baseContext, cli: { chatTimeout: 300 } })).toBe(300);
    expect(resolveKey("chatTimeout", CONFIG_KEYS.chatTimeout, { ...baseContext, config: { chatTimeoutSecs: 900 } })).toBe(900);
    expect(resolveKey("chatTimeout", CONFIG_KEYS.chatTimeout, baseContext)).toBe(600);
  });

});

describe("Phase 2: Complex values", () => {
  const baseContext = {
    cli: {},
    config: {},
    provider: null,
    profile: {},
    profileName: "default",
    profilesPath: "./config/profiles",
  };

  describe("theme", () => {
    it("defaults to 'dark' and resolves with trim", () => {
      expect(resolveKey("theme", CONFIG_KEYS.theme, baseContext)).toBe("dark");
      expect(resolveKey("theme", CONFIG_KEYS.theme, { ...baseContext, cli: { theme: "  light  " } })).toBe("light");
    });

    it("falls through empty values to next layer", () => {
      expect(resolveKey("theme", CONFIG_KEYS.theme, {
        ...baseContext,
        cli: { theme: "  " },
        config: { theme: "nord" },
      })).toBe("nord");
    });
  });

  describe("role", () => {
    it("defaults to fallback and resolves with trim", () => {
      expect(resolveKey("role", CONFIG_KEYS.role, baseContext)).toContain("AI coding assistant");
      expect(resolveKey("role", CONFIG_KEYS.role, { ...baseContext, cli: { role: "  Custom role  " } })).toBe("Custom role");
    });

    it("falls through config to profile", () => {
      expect(resolveKey("role", CONFIG_KEYS.role, {
        ...baseContext,
        config: {},
        profile: { role: "Profile role." },
      })).toBe("Profile role.");
    });
  });

  describe("noLog", () => {
    it("defaults to false and respects cli flag", () => {
      expect(resolveKey("noLog", CONFIG_KEYS.noLog, baseContext)).toBe(false);
      expect(resolveKey("noLog", CONFIG_KEYS.noLog, { ...baseContext, cli: { noLog: true } })).toBe(true);
    });

    it("resolves from HOTDOG_LOG env with falsy cast", () => {
      process.env.HOTDOG_LOG = "false";
      try {
        expect(resolveKey("noLog", CONFIG_KEYS.noLog, baseContext)).toBe(true);
      } finally {
        delete process.env.HOTDOG_LOG;
      }

      process.env.HOTDOG_LOG = "true";
      try {
        expect(resolveKey("noLog", CONFIG_KEYS.noLog, baseContext)).toBe(false);
      } finally {
        delete process.env.HOTDOG_LOG;
      }
    });

    it("resolves from HOTDOG_NO_LOG env", () => {
      process.env.HOTDOG_NO_LOG = "1";
      try {
        expect(resolveKey("noLog", CONFIG_KEYS.noLog, baseContext)).toBe(true);
      } finally {
        delete process.env.HOTDOG_NO_LOG;
      }
    });
  });

  describe("hideThinking", () => {
    it("defaults to false and respects cli/config", () => {
      expect(resolveKey("hideThinking", CONFIG_KEYS.hideThinking, baseContext)).toBe(false);
      expect(resolveKey("hideThinking", CONFIG_KEYS.hideThinking, { ...baseContext, cli: { hideThinking: true } })).toBe(true);
      expect(resolveKey("hideThinking", CONFIG_KEYS.hideThinking, { ...baseContext, config: { hideThinking: true } })).toBe(true);
    });
  });

  describe("useColors", () => {
    it("defaults to true and respects noColors/colors flags", () => {
      expect(resolveKey("useColors", CONFIG_KEYS.useColors, baseContext)).toBe(true);
      expect(resolveKey("useColors", CONFIG_KEYS.useColors, { ...baseContext, cli: { noColors: true } })).toBe(false);
      expect(resolveKey("useColors", CONFIG_KEYS.useColors, { ...baseContext, cli: { colors: false } })).toBe(false);
    });

    it("passes color palette object through from config", () => {
      const context = { ...baseContext, config: { colors: { thinking: "cyan" } } };
      expect(resolveKey("useColors", CONFIG_KEYS.useColors, context)).toEqual({ thinking: "cyan" });
    });
  });

  describe("aspects", () => {
    it("defaults to empty array and respects profile", () => {
      expect(resolveKey("aspects", CONFIG_KEYS.aspects, baseContext)).toEqual([]);
      expect(resolveKey("aspects", CONFIG_KEYS.aspects, { ...baseContext, profile: { aspects: ["coding"] } })).toEqual(["coding"]);
    });
  });
});

describe("integration: resolveAll with CONFIG_KEYS", () => {
  it("produces complete resolved object with correct priorities", () => {
    const context = {
      cli: {
        url: "http://cli-url",
        apiKey: "cli-key",
        thinker: "custom",
        noStream: false,
        hideTools: false,
        tokens: true,
        chatTimeout: 300,
        sessionId: "test-session",
        compactDebug: true,
        theme: "  light  ",
        role: "  CLI role  ",
        noLog: true,
        hideThinking: false,
        noColors: true,
      },
      config: {
        aiUrl: "http://config-url",
        apiKey: "config-key",
        thinker: "config-thinker",
        toolfmt: "config-tool",
        toolOutputFmt: "config-output",
        chatTimeoutSecs: 900,
        embeddingsTimeoutSecs: 60,
        promptsPath: "/config/prompts",
        compactDebug: false,
        hideTools: false,
        showTokenUse: false,
        theme: "nord",
        role: "Config role",
        noLog: false,
        hideThinking: true,
        colors: { thinking: "cyan" },
      },
      provider: { url: "http://provider-url", apiKey: "provider-key" },
      profile: { role: "Profile role", aspects: ["coding"] },
      profileName: "default",
      profilesPath: "./config/profiles",
    };

    const result = resolveAll(CONFIG_KEYS, context);

    // Provider wins for baseUrl and apiKey
    expect(result.baseUrl).toBe("http://provider-url");
    expect(result.apiKey).toBe("provider-key");

    // CLI wins for flags
    expect(result.stream).toBe(true);
    expect(result.hideTools).toBe(false);
    expect(result.showTokenUse).toBe(true);
    expect(result.compactDebug).toBe(true);

    // CLI wins for timeouts and paths
    expect(result.chatTimeout).toBe(300);
    expect(result.sessionId).toBe("test-session");

    // Phase 2: Complex values
    expect(result.theme).toBe("light");
    expect(result.role).toBe("CLI role");
    expect(result.noLog).toBe(true);
    expect(result.hideThinking).toBe(false);
    expect(result.useColors).toBe(false);
    expect(result.aspects).toEqual(["coding"]);
  });

  it("respects defaults when no values provided", () => {
    const context = {
      cli: {},
      config: {},
      provider: null,
      profile: {},
      profileName: "default",
      profilesPath: "./config/profiles",
    };

    const result = resolveAll(CONFIG_KEYS, context);

    expect(result.theme).toBe("dark");
    expect(result.role).toContain("AI coding assistant");
    expect(result.noLog).toBe(false);
    expect(result.hideThinking).toBe(false);
    expect(result.useColors).toBe(true);
    expect(result.aspects).toEqual([]);
  });
});
