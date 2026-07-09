// Tests for cli.js parseArgs() and generateHelpText().

import { describe, it, expect } from "bun:test";
import { parseArgs, generateHelpText } from "../../src/core/cli.js";

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
  it("parses --config flag", () => {
    withArgs(["--config", "/path/to/config.json"], () => {
      expect(parseArgs().config).toBe("/path/to/config.json");
    });
  });

  it("parses -f short flag for --config", () => {
    withArgs(["-f", "/path/to/config.json"], () => {
      expect(parseArgs().config).toBe("/path/to/config.json");
    });
  });

  it("parses --model flag", () => {
    withArgs(["--model", "gpt-4"], () => {
      expect(parseArgs().model).toBe("gpt-4");
    });
  });

  it("parses -m short flag for --model", () => {
    withArgs(["-m", "gpt-4"], () => {
      expect(parseArgs().model).toBe("gpt-4");
    });
  });

  it("parses --ai-url flag", () => {
    withArgs(["--ai-url", "http://localhost:8080"], () => {
      expect(parseArgs().aiUrl).toBe("http://localhost:8080");
    });
  });

  it("parses --api-key flag", () => {
    withArgs(["--api-key", "secret-key"], () => {
      expect(parseArgs().apiKey).toBe("secret-key");
    });
  });

  it("parses --profile flag", () => {
    withArgs(["--profile", "explorer"], () => {
      expect(parseArgs().profile).toBe("explorer");
    });
  });

  it("parses --provider flag", () => {
    withArgs(["--provider", "openai"], () => {
      expect(parseArgs().provider).toBe("openai");
    });
  });

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
