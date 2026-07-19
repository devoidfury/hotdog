// Integration tests for main() --help output.
// Calls main() directly at the highest possible level to verify
// that --help produces the full help text including config flags,
// works without an AI URL configured, and exits with code 0.

import { describe, it, expect } from "bun:test";
import { main } from "../../src/core/main.ts";

import pkg from "../../package.json" with { type: "json" };

/**
 * Run main() with given CLI args, capturing console.log output.
 * Restores process.argv and console.log after each run.
 */
async function runMain(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string }> {
  const origArgv = process.argv;
  const origEnv = { ...process.env };

  // Apply env overrides (e.g., unset AI_URL)
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === "") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  process.argv = ["bun", "hotdog", ...args];

  // Capture console.log (stdout)
  let capturedStdout = "";
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    capturedStdout += args.join(" ") + "\n";
  };

  try {
    const exitCode = await main();
    return { exitCode, stdout: capturedStdout };
  } finally {
    process.argv = origArgv;
    console.log = originalLog;
    process.env = origEnv;
  }
}

describe("main --help", () => {
  it("prints full help text and exits with code 0 when no AI URL is configured", async () => {
    const { exitCode, stdout } = await runMain(["--help"], {
      AI_URL: "",
      HOTDOG_AI_URL: "",
    });

    expect(exitCode).toBe(0);

    // Help header
    expect(stdout).toContain("hotdog - AI agent harness with tool calling support");

    // Usage lines
    expect(stdout).toContain("Usage: hotdog [options] [prompt]");
    expect(stdout).toContain("hotdog info");
    expect(stdout).toContain("hotdog show-prompt");
    expect(stdout).toContain("hotdog sessions show");

    // Subcommands section
    expect(stdout).toContain("Subcommands:");
    expect(stdout).toContain("info");
    expect(stdout).toContain("cli");
    expect(stdout).toContain("prompt");
    expect(stdout).toContain("webui");

    // Options section — structural flags (from cli.ts)
    expect(stdout).toContain("--config");
    expect(stdout).toContain("--ai-url");
    expect(stdout).toContain("--api-key");
    expect(stdout).toContain("--model");
    expect(stdout).toContain("--profile");
    expect(stdout).toContain("--provider");
    expect(stdout).toContain("--loud");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("--version");
    expect(stdout).toContain("--help");

    // Options section — config flags from schema (via ConfigRegistry)
    expect(stdout).toContain("--thinker");
    expect(stdout).toContain("--toolfmt");
    expect(stdout).toContain("--tool-output-fmt");
    expect(stdout).toContain("--chat-timeout");
    expect(stdout).toContain("--embeddings-timeout");
    expect(stdout).toContain("--session-id");
    expect(stdout).toContain("--compact-debug");
    expect(stdout).toContain("--no-log");
    expect(stdout).toContain("--tokens");
    expect(stdout).toContain("--no-stream");
    expect(stdout).toContain("--show-tools");
    expect(stdout).toContain("--hide-thinking");
    expect(stdout).toContain("--colors");
    expect(stdout).toContain("--theme");
    expect(stdout).toContain("--role");
    expect(stdout).toContain("--max-iterations");
    expect(stdout).toContain("--hook-trace");

    // Options section — inverse flags (registered manually in main.ts)
    expect(stdout).toContain("--hide-tools");
    expect(stdout).toContain("--show-thinking");
    expect(stdout).toContain("--no-colors");

    // Options section — extension flags (from extension.json metadata)
    expect(stdout).toContain("--prompts-path");
    expect(stdout).toContain("--config-debug");
    expect(stdout).toContain("--shell-mode");
    expect(stdout).toContain("--prompt");
    expect(stdout).toContain("--tool-index");
    expect(stdout).toContain("--preload-skills");
    expect(stdout).toContain("--skills-path");

    // Should NOT contain placeholder tokens
    expect(stdout).not.toContain("<config_flags>");
    expect(stdout).not.toContain("<subcommands>");
  });

  it("works with --help and --ai-url combined", async () => {
    const { exitCode, stdout } = await runMain(["--help", "--ai-url", "http://test-url:8080"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("hotdog - AI agent harness with tool calling support");
    expect(stdout).toContain("--ai-url");
    // The warning may still appear because --ai-url isn't wired to the config schema,
    // but help must work regardless.
  });

  it("works with the minimal example config directory", async () => {
    const { exitCode, stdout } = await runMain([
      "--help",
      "--config-dir",
      "examples/minimal-config/config",
    ], {
      AI_URL: "",
      HOTDOG_AI_URL: "",
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("hotdog - AI agent harness with tool calling support");
    expect(stdout).toContain("--ai-url");
    expect(stdout).toContain("--model");
  });

  it("works with --version flag", async () => {
    const { exitCode, stdout } = await runMain(["--version"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("hotdog ");
    expect(stdout).toContain(pkg.version);
  });
});
