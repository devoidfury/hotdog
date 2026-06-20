import { describe, it, expect } from "bun:test";
import {
  resolveKey,
  resolveAll,
} from "../../src/core/config/resolver.js";
import { CONFIG_SCHEMA as CONFIG_KEYS } from "../../src/core/config/schema.js";
import { resolveCast } from "../../src/core/config/schema-loader.js";
import { getNested } from "../../src/utils/objects.js";

describe("getNested", () => {
  it("returns top-level property", () => {
    expect(getNested({ url: "http://test" }, "url")).toBe("http://test");
  });

  it("returns nested property with dot path", () => {
    expect(getNested({ nested: { value: 42 } }, "nested.value")).toBe(42);
  });

  it("returns undefined for missing path", () => {
    expect(getNested({ a: 1 }, "b.c")).toBeUndefined();
  });

  it("returns undefined when intermediate is null", () => {
    expect(getNested({ a: null }, "a.b")).toBeUndefined();
  });

  it("returns undefined for null object", () => {
    expect(getNested(null, "a.b")).toBeUndefined();
  });

  it("returns undefined for empty path", () => {
    expect(getNested({ a: 1 }, "")).toBeUndefined();
  });
});

// ── Cast Builtins ────────────────────────────────────────────────────────

describe("resolveCast", () => {
  describe("truthy", () => {
    const cast = resolveCast("truthy");

    it("passes boolean true through", () => {
      expect(cast(true)).toBe(true);
    });

    it("passes boolean false through", () => {
      expect(cast(false)).toBe(false);
    });

    it("casts number 0 to false", () => {
      expect(cast(0)).toBe(false);
    });

    it("casts non-zero number to true", () => {
      expect(cast(1)).toBe(true);
      expect(cast(-1)).toBe(true);
    });

    it("casts 'true' string to true", () => {
      expect(cast("true")).toBe(true);
      expect(cast("True")).toBe(true);
      expect(cast("TRUE")).toBe(true);
    });

    it("casts 'false' string to false", () => {
      expect(cast("false")).toBe(false);
      expect(cast("False")).toBe(false);
    });

    it("casts 'on' to true", () => {
      expect(cast("on")).toBe(true);
      expect(cast("ON")).toBe(true);
    });

    it("casts 'off' to false", () => {
      expect(cast("off")).toBe(false);
      expect(cast("OFF")).toBe(false);
    });

    it("casts '1' to true", () => {
      expect(cast("1")).toBe(true);
    });

    it("casts '0' to false", () => {
      expect(cast("0")).toBe(false);
    });

    it("returns undefined for unrecognizable strings", () => {
      expect(cast("maybe")).toBeUndefined();
      expect(cast("yes")).toBeUndefined();
      expect(cast("no")).toBeUndefined();
    });

    it("returns undefined for non-string non-boolean non-number", () => {
      expect(cast(null)).toBeUndefined();
      expect(cast({})).toBeUndefined();
      expect(cast([])).toBeUndefined();
    });
  });

  describe("falsy", () => {
    const cast = resolveCast("falsy");

    it("negates boolean true", () => {
      expect(cast(true)).toBe(false);
    });

    it("negates boolean false", () => {
      expect(cast(false)).toBe(true);
    });

    it("negates 'true' string", () => {
      expect(cast("true")).toBe(false);
    });

    it("negates 'false' string", () => {
      expect(cast("false")).toBe(true);
    });

    it("negates '1'", () => {
      expect(cast("1")).toBe(false);
    });

    it("negates '0'", () => {
      expect(cast("0")).toBe(true);
    });

    it("negates 'on'/'off'", () => {
      expect(cast("on")).toBe(false);
      expect(cast("off")).toBe(true);
    });

    it("returns undefined for unrecognizable strings", () => {
      expect(cast("maybe")).toBeUndefined();
    });
  });

  describe("number", () => {
    const cast = resolveCast("number");

    it("passes number through", () => {
      expect(cast(42)).toBe(42);
      expect(cast(0)).toBe(0);
      expect(cast(-3.14)).toBe(-3.14);
    });

    it("casts numeric strings", () => {
      expect(cast("42")).toBe(42);
      expect(cast("  3.14  ")).toBe(3.14);
      expect(cast("-10")).toBe(-10);
    });

    it("returns undefined for non-numeric strings", () => {
      expect(cast("hello")).toBeUndefined();
      expect(cast("")).toBeUndefined();
    });
  });

  describe("string", () => {
    const cast = resolveCast("string");

    it("trims and returns non-empty strings", () => {
      expect(cast("  hello  ")).toBe("hello");
      expect(cast("world")).toBe("world");
    });

    it("returns undefined for empty/whitespace strings", () => {
      expect(cast("")).toBeUndefined();
      expect(cast("   ")).toBeUndefined();
    });

    it("returns undefined for non-strings", () => {
      expect(cast(42)).toBeUndefined();
      expect(cast(true)).toBeUndefined();
    });
  });

  describe("any", () => {
    const cast = resolveCast("any");

    it("passes any value through", () => {
      expect(cast(true)).toBe(true);
      expect(cast(false)).toBe(false);
      expect(cast(0)).toBe(0);
      expect(cast("hello")).toBe("hello");
      expect(cast(null)).toBe(null);
      expect(cast({})).toEqual({});
    });
  });

  describe("nonemptyArray", () => {
    const cast = resolveCast("nonemptyArray");

    it("passes non-empty arrays through", () => {
      expect(cast(["a"])).toEqual(["a"]);
      expect(cast([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("returns undefined for empty arrays", () => {
      expect(cast([])).toBeUndefined();
    });

    it("returns undefined for non-arrays", () => {
      expect(cast("hello")).toBeUndefined();
      expect(cast({})).toBeUndefined();
    });
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

  it("falls through to config when cli is undefined", () => {
    const schema = {
      layers: [
        { source: "cli", key: "url" },
        { source: "config", key: "url" },
        { default: "http://default" },
      ],
    };
    const context = {
      cli: {},
      config: { url: "http://config" },
    };
    expect(resolveKey("url", schema, context)).toBe("http://config");
  });

  it("falls through to default when no layer matches", () => {
    const schema = {
      layers: [
        { source: "cli", key: "url" },
        { source: "config", key: "url" },
        { default: "http://default" },
      ],
    };
    const context = {
      cli: {},
      config: {},
    };
    expect(resolveKey("url", schema, context)).toBe("http://default");
  });

  it("uses function default", () => {
    const schema = {
      layers: [{ default: (ctx) => `dynamic-${ctx.profileName}` }],
    };
    const context = { profileName: "test" };
    expect(resolveKey("url", schema, context)).toBe("dynamic-test");
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
    const context = { cli: { role: "   " } };
    expect(resolveKey("role", schema, context)).toBe("default role");
  });

  it("applies cast to resolved value", () => {
    const schema = {
      layers: [
        { source: "cli", key: "name", cast: (v) => v.toUpperCase() },
      ],
    };
    const context = { cli: { name: "hello" } };
    expect(resolveKey("name", schema, context)).toBe("HELLO");
  });

  it("applies cast that negates (falsy-like)", () => {
    const schema = {
      layers: [
        { source: "cli", key: "noStream", cast: (v) => !v },
        { default: true },
      ],
    };
    const context = { cli: { noStream: true } };
    expect(resolveKey("stream", schema, context)).toBe(false);
  });

  it("resolves from provider source with nested path", () => {
    const schema = {
      layers: [
        { source: "provider", path: "url" },
        { default: "http://default" },
      ],
    };
    const context = { provider: { url: "http://provider" } };
    expect(resolveKey("url", schema, context)).toBe("http://provider");
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
    const context = { cli: { val: "" }, config: { val: "config-val" } };
    expect(resolveKey("val", schema, context)).toBe("config-val");
  });
});

describe("resolveAll", () => {
  it("resolves all keys from schema", () => {
    const schema = {
      key1: {
        layers: [
          { source: "cli", key: "key1" },
          { default: "default1" },
        ],
      },
      key2: {
        layers: [
          { source: "cli", key: "key2" },
          { default: "default2" },
        ],
      },
    };
    const context = { cli: { key1: "value1" } };
    const result = resolveAll(schema, context);

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

  it("baseUrl resolves with correct priority", () => {
    // Provider wins
    let context = {
      ...baseContext,
      provider: { url: "http://provider" },
      cli: { url: "http://cli" },
      config: { aiUrl: "http://config" },
    };
    expect(resolveKey("baseUrl", CONFIG_KEYS.baseUrl, context)).toBe(
      "http://provider",
    );

    // CLI wins when no provider
    context = { ...baseContext, cli: { url: "http://cli" } };
    expect(resolveKey("baseUrl", CONFIG_KEYS.baseUrl, context)).toBe(
      "http://cli",
    );

    // Config wins when no provider or cli
    context = { ...baseContext, config: { aiUrl: "http://config" } };
    expect(resolveKey("baseUrl", CONFIG_KEYS.baseUrl, context)).toBe(
      "http://config",
    );

    // Default when nothing
    expect(resolveKey("baseUrl", CONFIG_KEYS.baseUrl, baseContext)).toBe(null);
  });

  it("apiKey resolves with correct priority including env", () => {
    process.env.AI_API_KEY = "env-key";
    try {
      // Provider wins
      let context = {
        ...baseContext,
        provider: { apiKey: "provider-key" },
        cli: { apiKey: "cli-key" },
        config: { apiKey: "config-key" },
      };
      expect(resolveKey("apiKey", CONFIG_KEYS.apiKey, context)).toBe(
        "provider-key",
      );

      // Env as fallback
      context = { ...baseContext };
      expect(resolveKey("apiKey", CONFIG_KEYS.apiKey, context)).toBe("env-key");
    } finally {
      delete process.env.AI_API_KEY;
    }
  });

  it("stream inverts noStream cli flag", () => {
    let context = { ...baseContext, cli: { noStream: true } };
    expect(resolveKey("stream", CONFIG_KEYS.stream, context)).toBe(false);

    context = { ...baseContext, cli: { noStream: false } };
    expect(resolveKey("stream", CONFIG_KEYS.stream, context)).toBe(true);

    context = { ...baseContext };
    expect(resolveKey("stream", CONFIG_KEYS.stream, context)).toBe(true);
  });

  it("hideTools respects cli flag (showTools falsy, hideTools any)", () => {
    // --show-tools sets showTools=true -> cast falsy -> hideTools=false
    let context = { ...baseContext, cli: { showTools: true } };
    expect(resolveKey("hideTools", CONFIG_KEYS.hideTools, context)).toBe(false);

    // --hide-tools sets hideTools=true -> direct
    context = { ...baseContext, cli: { hideTools: true } };
    expect(resolveKey("hideTools", CONFIG_KEYS.hideTools, context)).toBe(true);

    // CLI hideTools=false (explicit)
    context = { ...baseContext, cli: { hideTools: false } };
    expect(resolveKey("hideTools", CONFIG_KEYS.hideTools, context)).toBe(false);

    // CLI wins over config
    context = { ...baseContext, cli: { hideTools: true }, config: { hideTools: false } };
    expect(resolveKey("hideTools", CONFIG_KEYS.hideTools, context)).toBe(true);

    // Default when nothing
    context = { ...baseContext };
    expect(resolveKey("hideTools", CONFIG_KEYS.hideTools, context)).toBe(true);
  });

  it("showTokenUse returns true when cli.tokens is set", () => {
    let context = { ...baseContext, cli: { tokens: true } };
    expect(resolveKey("showTokenUse", CONFIG_KEYS.showTokenUse, context)).toBe(
      true,
    );

    // Config false should be respected
    context = { ...baseContext, config: { showTokenUse: false } };
    expect(resolveKey("showTokenUse", CONFIG_KEYS.showTokenUse, context)).toBe(
      false,
    );

    // Config true should be respected
    context = { ...baseContext, config: { showTokenUse: true } };
    expect(resolveKey("showTokenUse", CONFIG_KEYS.showTokenUse, context)).toBe(
      true,
    );

    // Default is true when no cli or config
    context = { ...baseContext };
    expect(resolveKey("showTokenUse", CONFIG_KEYS.showTokenUse, context)).toBe(
      true,
    );

    // CLI --tokens (true) overrides config false
    context = {
      ...baseContext,
      cli: { tokens: true },
      config: { showTokenUse: false },
    };
    expect(resolveKey("showTokenUse", CONFIG_KEYS.showTokenUse, context)).toBe(
      true,
    );

    // CLI tokens=false is a valid boolean — cast: truthy passes it through as false
    context = {
      ...baseContext,
      cli: { tokens: false },
      config: { showTokenUse: true },
    };
    expect(resolveKey("showTokenUse", CONFIG_KEYS.showTokenUse, context)).toBe(
      false,
    );
  });

  it("format strings resolve with correct fallback", () => {
    let context = { ...baseContext, cli: { thinker: "custom thinker" } };
    expect(
      resolveKey("thinkerFormat", CONFIG_KEYS.thinkerFormat, context),
    ).toBe("custom thinker");

    context = { ...baseContext, config: { thinker: "config thinker" } };
    expect(
      resolveKey("thinkerFormat", CONFIG_KEYS.thinkerFormat, context),
    ).toBe("config thinker");

    context = { ...baseContext };
    expect(
      resolveKey("thinkerFormat", CONFIG_KEYS.thinkerFormat, context),
    ).toBe("[Thinking: {}]");
  });

  it("chatTimeout and embeddingsTimeout resolve correctly", () => {
    let context = { ...baseContext, cli: { chatTimeout: 300 } };
    expect(
      resolveKey("chatTimeout", CONFIG_KEYS.chatTimeout, context),
    ).toBe(300);

    context = { ...baseContext, config: { chatTimeoutSecs: 900 } };
    expect(
      resolveKey("chatTimeout", CONFIG_KEYS.chatTimeout, context),
    ).toBe(900);

    context = { ...baseContext };
    expect(resolveKey("chatTimeout", CONFIG_KEYS.chatTimeout, context)).toBe(
      600,
    );
  });

  it("sessionId defaults to null", () => {
    let context = { ...baseContext };
    expect(resolveKey("sessionId", CONFIG_KEYS.sessionId, context)).toBe(null);

    context = { ...baseContext, cli: { sessionId: "abc123" } };
    expect(resolveKey("sessionId", CONFIG_KEYS.sessionId, context)).toBe(
      "abc123",
    );
  });

  it("paths resolve with correct fallback", () => {
    let context = { ...baseContext };
    expect(resolveKey("skillsPath", CONFIG_KEYS.skillsPath, context)).toBe(
      "/skills",
    );
    expect(resolveKey("promptsPath", CONFIG_KEYS.promptsPath, context)).toBe(
      "./config/prompts",
    );

    context = { ...baseContext, cli: { skillsPath: "/custom/skills" } };
    expect(resolveKey("skillsPath", CONFIG_KEYS.skillsPath, context)).toBe(
      "/custom/skills",
    );
  });

  it("compactDebug resolves as boolean", () => {
    let context = { ...baseContext };
    expect(
      resolveKey("compactDebug", CONFIG_KEYS.compactDebug, context),
    ).toBe(false);

    context = { ...baseContext, cli: { compactDebug: true } };
    expect(
      resolveKey("compactDebug", CONFIG_KEYS.compactDebug, context),
    ).toBe(true);

    context = { ...baseContext, config: { compactDebug: true } };
    expect(
      resolveKey("compactDebug", CONFIG_KEYS.compactDebug, context),
    ).toBe(true);
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
    it("defaults to 'dark'", () => {
      expect(resolveKey("theme", CONFIG_KEYS.theme, baseContext)).toBe("dark");
    });

    it("resolves from cli with trim", () => {
      const context = { ...baseContext, cli: { theme: "  light  " } };
      expect(resolveKey("theme", CONFIG_KEYS.theme, context)).toBe("light");
    });

    it("falls through empty cli to config", () => {
      const context = {
        ...baseContext,
        cli: { theme: "  " },
        config: { theme: "nord" },
      };
      expect(resolveKey("theme", CONFIG_KEYS.theme, context)).toBe("nord");
    });

    it("falls through empty string to default", () => {
      const context = {
        ...baseContext,
        config: { theme: "" },
      };
      expect(resolveKey("theme", CONFIG_KEYS.theme, context)).toBe("dark");
    });
  });

  describe("role", () => {
    it("defaults to fallback string", () => {
      expect(resolveKey("role", CONFIG_KEYS.role, baseContext)).toBe(
        "You are an AI coding assistant. Use the instructions below and the tools available to you to assist the user.",
      );
    });

    it("resolves from cli with trim", () => {
      const context = {
        ...baseContext,
        cli: { role: "  You are a Python expert.  " },
      };
      expect(resolveKey("role", CONFIG_KEYS.role, context)).toBe(
        "You are a Python expert.",
      );
    });

    it("falls through empty cli to config", () => {
      const context = {
        ...baseContext,
        cli: { role: "   " },
        config: { role: "Config role." },
      };
      expect(resolveKey("role", CONFIG_KEYS.role, context)).toBe("Config role.");
    });

    it("falls through config to profile", () => {
      const context = {
        ...baseContext,
        config: {},
        profile: { role: "Profile role." },
      };
      expect(resolveKey("role", CONFIG_KEYS.role, context)).toBe(
        "Profile role.",
      );
    });
  });

  describe("noLog", () => {
    it("defaults to false", () => {
      expect(resolveKey("noLog", CONFIG_KEYS.noLog, baseContext)).toBe(false);
    });

    it("resolves true from cli noLog flag", () => {
      const context = { ...baseContext, cli: { noLog: true } };
      expect(resolveKey("noLog", CONFIG_KEYS.noLog, context)).toBe(true);
    });

    it("cli noLog=false is accepted as valid boolean (not skipped)", () => {
      const context = {
        ...baseContext,
        cli: { noLog: false },
        config: { noLog: true },
      };
      // cast: truthy passes boolean false through — doesn't skip
      expect(resolveKey("noLog", CONFIG_KEYS.noLog, context)).toBe(false);
    });

    it("resolves from OA_AGENT_LOG=false env (falsy cast)", () => {
      process.env.OA_AGENT_LOG = "false";
      try {
        // OA_AGENT_LOG=false -> cast falsy -> true
        expect(resolveKey("noLog", CONFIG_KEYS.noLog, baseContext)).toBe(true);
      } finally {
        delete process.env.OA_AGENT_LOG;
      }
    });

    it("resolves from OA_AGENT_LOG=true env (falsy cast)", () => {
      process.env.OA_AGENT_LOG = "true";
      try {
        // OA_AGENT_LOG=true -> cast falsy -> false
        expect(resolveKey("noLog", CONFIG_KEYS.noLog, baseContext)).toBe(false);
      } finally {
        delete process.env.OA_AGENT_LOG;
      }
    });

    it("resolves from OA_AGENT_LOG=1 env (falsy cast)", () => {
      process.env.OA_AGENT_LOG = "1";
      try {
        // OA_AGENT_LOG=1 -> cast falsy -> false
        expect(resolveKey("noLog", CONFIG_KEYS.noLog, baseContext)).toBe(false);
      } finally {
        delete process.env.OA_AGENT_LOG;
      }
    });

    it("resolves from OA_AGENT_LOG=on env (falsy cast)", () => {
      process.env.OA_AGENT_LOG = "on";
      try {
        // OA_AGENT_LOG=on -> cast falsy -> false
        expect(resolveKey("noLog", CONFIG_KEYS.noLog, baseContext)).toBe(false);
      } finally {
        delete process.env.OA_AGENT_LOG;
      }
    });

    it("resolves from OA_AGENT_NO_LOG=1 env", () => {
      process.env.OA_AGENT_NO_LOG = "1";
      try {
        expect(resolveKey("noLog", CONFIG_KEYS.noLog, baseContext)).toBe(true);
      } finally {
        delete process.env.OA_AGENT_NO_LOG;
      }
    });
  });

  describe("hideThinking", () => {
    it("defaults to false", () => {
      expect(
        resolveKey("hideThinking", CONFIG_KEYS.hideThinking, baseContext),
      ).toBe(false);
    });

    it("resolves true when cli.hideThinking === true", () => {
      const context = { ...baseContext, cli: { hideThinking: true } };
      expect(
        resolveKey("hideThinking", CONFIG_KEYS.hideThinking, context),
      ).toBe(true);
    });

    it("resolves false when cli.hideThinking === false", () => {
      const context = { ...baseContext, cli: { hideThinking: false } };
      expect(
        resolveKey("hideThinking", CONFIG_KEYS.hideThinking, context),
      ).toBe(false);
    });

    it("falls through undefined cli to config hideThinking=false", () => {
      const context = { ...baseContext, config: { hideThinking: false } };
      expect(
        resolveKey("hideThinking", CONFIG_KEYS.hideThinking, context),
      ).toBe(false);
    });

    it("falls through config.hideThinking=true to default false", () => {
      const context = { ...baseContext, config: { hideThinking: true } };
      expect(
        resolveKey("hideThinking", CONFIG_KEYS.hideThinking, context),
      ).toBe(true);
    });
  });

  describe("useColors", () => {
    it("defaults to true", () => {
      expect(
        resolveKey("useColors", CONFIG_KEYS.useColors, baseContext),
      ).toBe(true);
    });

    it("resolves false when cli.noColors is true", () => {
      const context = { ...baseContext, cli: { noColors: true } };
      expect(
        resolveKey("useColors", CONFIG_KEYS.useColors, context),
      ).toBe(false);
    });

    it("resolves from cli.colors", () => {
      const context = { ...baseContext, cli: { colors: false } };
      expect(
        resolveKey("useColors", CONFIG_KEYS.useColors, context),
      ).toBe(false);
    });

    it("passes color palette object through from config (cast: any)", () => {
      const context = {
        ...baseContext,
        config: { colors: { thinking: "cyan", tool_call: "green" } },
      };
      expect(
        resolveKey("useColors", CONFIG_KEYS.useColors, context),
      ).toEqual({ thinking: "cyan", tool_call: "green" });
    });

    it("resolves boolean from config.colors", () => {
      const context = { ...baseContext, config: { colors: false } };
      expect(
        resolveKey("useColors", CONFIG_KEYS.useColors, context),
      ).toBe(false);
    });
  });

  describe("aspects", () => {
    it("defaults to empty array", () => {
      expect(resolveKey("aspects", CONFIG_KEYS.aspects, baseContext)).toEqual(
        [],
      );
    });

    it("respects from profile with aspects", () => {
      const context = {
        ...baseContext,
        profile: { aspects: ["coding", "testing"] },
      };
      expect(resolveKey("aspects", CONFIG_KEYS.aspects, context)).toEqual([
        "coding",
        "testing",
      ]);
    });

    it("falls through empty aspects to default", () => {
      const context = { ...baseContext, profile: { aspects: [] } };
      expect(resolveKey("aspects", CONFIG_KEYS.aspects, context)).toEqual([]);
    });
  });
});

describe("integration: resolveAll with CONFIG_KEYS", () => {
  it("produces complete resolved object", () => {
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
        skillsPath: "/my/skills",
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
        skillsPath: "/config/skills",
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
      profile: {
        role: "Profile role",
        aspects: ["coding"],
      },
      profileName: "default",
      profilesPath: "./config/profiles",
    };

    const result = resolveAll(CONFIG_KEYS, context);

    // Provider wins for baseUrl and apiKey
    expect(result.baseUrl).toBe("http://provider-url");
    expect(result.apiKey).toBe("provider-key");

    // CLI wins for format strings and flags
    expect(result.thinkerFormat).toBe("custom");
    expect(result.toolFormat).toBe("config-tool"); // from config, not cli
    expect(result.toolOutputFmt).toBe("config-output");
    expect(result.stream).toBe(true);
    expect(result.hideTools).toBe(false);
    expect(result.showTokenUse).toBe(true);
    expect(result.compactDebug).toBe(true);

    // CLI wins for timeouts and paths
    expect(result.chatTimeout).toBe(300);
    expect(result.embeddingsTimeout).toBe(60); // from config
    expect(result.sessionId).toBe("test-session");
    expect(result.skillsPath).toBe("/my/skills");
    expect(result.promptsPath).toBe("/config/prompts"); // from config

    // Phase 2: Complex values
    expect(result.theme).toBe("light"); // CLI with trim
    expect(result.role).toBe("CLI role"); // CLI with trim
    expect(result.noLog).toBe(true); // CLI
    expect(result.hideThinking).toBe(false); // CLI explicit false
    expect(result.useColors).toBe(false); // CLI noColors=true
    expect(result.aspects).toEqual(["coding"]); // from profile
  });

  it("respects phase 2 defaults when no values provided", () => {
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
    expect(result.role).toBe(
      "You are an AI coding assistant. Use the instructions below and the tools available to you to assist the user.",
    );
    expect(result.noLog).toBe(false);
    expect(result.hideThinking).toBe(false);
    expect(result.useColors).toBe(true);
    expect(result.aspects).toEqual([]);
  });
});
