// Tests for cli.js parseArgs() and generateHelpText().

import { describe, it, expect } from "bun:test";
import { parseArgs, generateHelpText } from "../../src/core/cli.ts";

function withArgs(args, fn) {
  const origArgv = process.argv;
  process.argv = ["bun", "hotdog", ...args];
  try {
    fn();
  } finally {
    process.argv = origArgv;
  }
}

describe("parseArgs", () => {
  const flagTests = [
    { long: "--config", short: "-f", resultKey: "config", value: "/path/to/config.json" },
    { long: "--model", short: "-m", resultKey: "model", value: "gpt-4" },
    { long: "--ai-url", short: null, resultKey: "aiUrl", value: "http://localhost:8080" },
    { long: "--api-key", short: null, resultKey: "apiKey", value: "secret-key" },
    { long: "--profile", short: "-p", resultKey: "profile", value: "explorer" },
    { long: "--provider", short: null, resultKey: "provider", value: "openai" },
  ];

  for (const { long, short, resultKey, value } of flagTests) {
    it(`parses ${long} flag`, () => {
      withArgs([long, value], () => {
        expect(parseArgs()[resultKey]).toBe(value);
      });
    });

    if (short) {
      it(`parses ${short} short flag for ${long}`, () => {
        withArgs([short, value], () => {
          expect(parseArgs()[resultKey]).toBe(value);
        });
      });
    }
  }

  it("parses boolean flags", () => {
    withArgs(["--loud", "--json", "--version"], () => {
      const result = parseArgs();
      expect(result.loud).toBe(true);
      expect(result.wantsJson).toBe(true);
      expect(result.version).toBe(true);
    });
  });

  it("parses subcommand", () => {
    withArgs(["info"], () => {
      expect(parseArgs().subcommand).toBe("info");
    });
  });

  it("parses show-prompt subcommand", () => {
    withArgs(["show-prompt"], () => {
      expect(parseArgs().subcommand).toBe("show-prompt");
    });
  });

  it("parses positional args after subcommand", () => {
    withArgs(["review", "--session-id", "abc123"], () => {
      expect(parseArgs().subcommand).toBe("review");
    });
  });

  it("throws on unknown subcommand", () => {
    withArgs(["unknown-subcommand"], () => {
      expect(() => parseArgs()).toThrow(/Unknown subcommand/);
    });
  });

  it("throws when flag with value is missing value", () => {
    withArgs(["--model"], () => {
      expect(() => parseArgs()).toThrow(/requires a value/);
    });
  });

  it("parses multiple flags together", () => {
    withArgs(["-m", "gpt-4", "-p", "default", "--loud"], () => {
      const result = parseArgs();
      expect(result.model).toBe("gpt-4");
      expect(result.profile).toBe("default");
      expect(result.loud).toBe(true);
    });
  });

  it("handles known subcommands parameter", () => {
    withArgs(["custom-cmd", "arg1", "arg2"], () => {
      const result = parseArgs(null, ["custom-cmd"]);
      expect(result.subcommand).toBe("custom-cmd");
      expect(result.args).toEqual(["arg1", "arg2"]);
    });
  });

  it("handles empty args", () => {
    withArgs([], () => {
      const result = parseArgs();
      expect(result.subcommand).toBeNull();
      expect(result.model).toBeNull();
      expect(result.args).toEqual([]);
    });
  });
});

describe("generateHelpText", () => {
  it("returns help text without config flags when no registry", () => {
    const help = generateHelpText(null);
    expect(help).toContain("hotdog - AI agent harness with tool calling support");
    expect(help).toContain("<subcommands>");
  });

  it("replaces config_flags placeholder with registry help", () => {
    const mockRegistry = {
      getCliHelpText: () => "  --custom-flag   Custom flag\n",
    };
    const help = generateHelpText(mockRegistry);
    expect(help).toContain("--custom-flag");
    expect(help).not.toContain("<config_flags>");
  });

  it("removes config_flags placeholder when registry returns empty", () => {
    const mockRegistry = {
      getCliHelpText: () => null,
    };
    const help = generateHelpText(mockRegistry);
    expect(help).not.toContain("<config_flags>");
  });
});
