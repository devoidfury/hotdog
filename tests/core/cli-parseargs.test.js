// Tests for cli.js parseArgs() and generateHelpText().

import { describe, it, expect } from "bun:test";
import { parseArgs, generateHelpText } from "../../src/core/cli.js";

describe("parseArgs", () => {
  it("parses --config flag", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "--config", "/path/to/config.json"];
    try {
      const result = parseArgs();
      expect(result.config).toBe("/path/to/config.json");
    } finally {
      process.argv = origArgv;
    }
  });

  it("parses -f short flag for --config", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "-f", "/path/to/config.json"];
    try {
      const result = parseArgs();
      expect(result.config).toBe("/path/to/config.json");
    } finally {
      process.argv = origArgv;
    }
  });

  it("parses --model flag", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "--model", "gpt-4"];
    try {
      const result = parseArgs();
      expect(result.model).toBe("gpt-4");
    } finally {
      process.argv = origArgv;
    }
  });

  it("parses -m short flag for --model", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "-m", "gpt-4"];
    try {
      const result = parseArgs();
      expect(result.model).toBe("gpt-4");
    } finally {
      process.argv = origArgv;
    }
  });

  it("parses --ai-url flag", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "--ai-url", "http://localhost:8080"];
    try {
      const result = parseArgs();
      expect(result.aiUrl).toBe("http://localhost:8080");
    } finally {
      process.argv = origArgv;
    }
  });

  it("parses --api-key flag", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "--api-key", "secret-key"];
    try {
      const result = parseArgs();
      expect(result.apiKey).toBe("secret-key");
    } finally {
      process.argv = origArgv;
    }
  });

  it("parses --profile flag", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "--profile", "explorer"];
    try {
      const result = parseArgs();
      expect(result.profile).toBe("explorer");
    } finally {
      process.argv = origArgv;
    }
  });

  it("parses --provider flag", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "--provider", "openai"];
    try {
      const result = parseArgs();
      expect(result.provider).toBe("openai");
    } finally {
      process.argv = origArgv;
    }
  });

  it("parses boolean flags", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "--loud", "--json", "--version"];
    try {
      const result = parseArgs();
      expect(result.loud).toBe(true);
      expect(result.wantsJson).toBe(true);
      expect(result.version).toBe(true);
    } finally {
      process.argv = origArgv;
    }
  });

  it("parses subcommand", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "info"];
    try {
      const result = parseArgs();
      expect(result.subcommand).toBe("info");
    } finally {
      process.argv = origArgv;
    }
  });

  it("parses show-prompt subcommand", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "show-prompt"];
    try {
      const result = parseArgs();
      expect(result.subcommand).toBe("show-prompt");
    } finally {
      process.argv = origArgv;
    }
  });

  it("parses positional args after subcommand", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "review", "--session-id", "abc123"];
    try {
      const result = parseArgs();
      expect(result.subcommand).toBe("review");
    } finally {
      process.argv = origArgv;
    }
  });

  it("throws on unknown subcommand", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "unknown-subcommand"];
    try {
      expect(() => parseArgs()).toThrow(/Unknown subcommand/);
    } finally {
      process.argv = origArgv;
    }
  });

  it("throws when flag with value is missing value", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "--model"];
    try {
      expect(() => parseArgs()).toThrow(/requires a value/);
    } finally {
      process.argv = origArgv;
    }
  });

  it("parses multiple flags together", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "-m", "gpt-4", "-p", "default", "--loud"];
    try {
      const result = parseArgs();
      expect(result.model).toBe("gpt-4");
      expect(result.profile).toBe("default");
      expect(result.loud).toBe(true);
    } finally {
      process.argv = origArgv;
    }
  });

  it("handles known subcommands parameter", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog", "custom-cmd", "arg1", "arg2"];
    try {
      const result = parseArgs(null, ["custom-cmd"]);
      expect(result.subcommand).toBe("custom-cmd");
      expect(result.args).toEqual(["arg1", "arg2"]);
    } finally {
      process.argv = origArgv;
    }
  });

  it("handles empty args", () => {
    const origArgv = process.argv;
    process.argv = ["bun", "hotdog"];
    try {
      const result = parseArgs();
      expect(result.subcommand).toBeNull();
      expect(result.model).toBeNull();
      expect(result.args).toEqual([]);
    } finally {
      process.argv = origArgv;
    }
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
