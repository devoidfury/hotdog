// Integration tests for main() --help output.
// Calls main() directly at the highest possible level to verify
// that --help produces the full help text including config flags,
// works without an AI URL configured, and exits with code 0.

import { describe, it, expect } from "bun:test";
import { main } from "../../src/core/main.ts";

import pkg from "../../package.json" with { type: "json" };

/**
 * Run main() with given CLI args, capturing stdout and stderr output.
 * Restores process.argv, console, and stream writes after each run.
 */
async function runMain(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

  // Override log target to stderr so logger output is captured
  process.env.HOTDOG_LOG_TARGET = "stderr";
  process.env.HOTDOG_LOG_LEVEL = "debug";

  process.argv = ["bun", "hotdog", ...args];

  // Capture stdout and stderr (logger writes to streams directly)
  let capturedStdout = "";
  let capturedStderr = "";
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;

  process.stdout.write = (chunk: string | Buffer): boolean => {
    if (typeof chunk === "string") capturedStdout += chunk;
    else capturedStdout += chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Buffer): boolean => {
    if (typeof chunk === "string") capturedStderr += chunk;
    else capturedStderr += chunk.toString();
    return true;
  };

  // Restore console.log so it writes to stdout (setup.ts suppresses it)
  const origConsoleLog = console.log;
  const origConsoleError = console.error;
  console.log = (...args: unknown[]) => {
    process.stdout.write(args.join(" ") + "\n");
  };
  console.error = (...args: unknown[]) => {
    process.stderr.write(args.join(" ") + "\n");
  };

  try {
    const exitCode = await main();
    return { exitCode, stdout: capturedStdout, stderr: capturedStderr };
  } finally {
    process.argv = origArgv;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origConsoleLog;
    console.error = origConsoleError;
    process.env = origEnv;
  }
}

describe("main --help", () => {
  it("prints help text and exits with code 0 when no AI URL is configured", async () => {
    const { exitCode, stdout } = await runMain(["--help"], {
      AI_URL: "",
      HOTDOG_AI_URL: "",
    });

    expect(exitCode).toBe(0);

    // Help header
    expect(stdout).toContain("hotdog");
    expect(stdout).toContain("Usage:");

    // Subcommands section
    expect(stdout).toContain("Subcommands:");
    expect(stdout).toContain("info");
    expect(stdout).toContain("cli");

    // Options section -- core flags
    expect(stdout).toContain("--config");
    expect(stdout).toContain("--ai-url");
    expect(stdout).toContain("--api-key");
    expect(stdout).toContain("--model");
    expect(stdout).toContain("--profile");
    expect(stdout).toContain("--version");
    expect(stdout).toContain("--help");

    // Should NOT contain placeholder tokens
    expect(stdout).not.toContain("<config_flags>");
    expect(stdout).not.toContain("<subcommands>");
  });

  it("works with --help and --ai-url combined", async () => {
    const { exitCode, stdout } = await runMain(["--help", "--ai-url", "http://test-url:8080"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("hotdog");
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
    expect(stdout).toContain("hotdog");
  });

  it("works with --version flag", async () => {
    const { exitCode, stdout } = await runMain(["--version"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("hotdog ");
    expect(stdout).toContain(pkg.version);
  });
});

describe("main -- unknown subcommand", () => {
  it("suggests similar subcommand when one match exists", async () => {
    const { exitCode, stderr } = await runMain(["infoo"], {
      AI_URL: "",
      HOTDOG_AI_URL: "",
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown subcommand");
    expect(stderr).toContain("Did you mean: info");
  });

  it("lists available subcommands when no close match", async () => {
    const { exitCode, stderr } = await runMain(["zzzzz"], {
      AI_URL: "",
      HOTDOG_AI_URL: "",
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown subcommand");
    expect(stderr).toContain("Available subcommands");
    expect(stderr).toContain("-p or --prompt");
  });
});

describe("main -- subcommand dispatch", () => {
  it("dispatches to registered subcommand handler", async () => {
    const { exitCode, stdout } = await runMain(["info"], {
      AI_URL: "",
      HOTDOG_AI_URL: "",
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("hotdog");
  });

  it("handles subcommand with --help flag", async () => {
    const { exitCode } = await runMain(["info", "--help"], {
      AI_URL: "",
      HOTDOG_AI_URL: "",
    });
    expect(exitCode).toBe(0);
  });

  it("dispatches webui subcommand and handles SIGINT shutdown", async () => {
    // This test verifies the webui subcommand handler is wired up correctly.
    // We mock the server module to shut down quickly via SIGINT.
    const origArgv = process.argv;
    const origEnv = { ...process.env };
    const origStdoutWrite = process.stdout.write;
    const origStderrWrite = process.stderr.write;
    const origConsoleLog = console.log;
    const origConsoleError = console.error;

    process.env.HOTDOG_LOG_TARGET = "stderr";
    process.env.HOTDOG_LOG_LEVEL = "error";
    process.env.HOTDOG_AI_URL = "http://test:8000";
    process.env.HOTDOG_API_KEY = "test-key";
    process.env.HOTDOG_WEBUI_API_KEY = "webui-secret";
    process.argv = ["bun", "hotdog", "webui"];

    let capturedStdout = "";
    let capturedStderr = "";
    process.stdout.write = (chunk: string | Buffer): boolean => {
      if (typeof chunk === "string") capturedStdout += chunk;
      else capturedStdout += chunk.toString();
      return true;
    };
    process.stderr.write = (chunk: string | Buffer): boolean => {
      if (typeof chunk === "string") capturedStderr += chunk;
      else capturedStderr += chunk.toString();
      return true;
    };
    console.log = (...args: unknown[]) => process.stdout.write(args.join(" ") + "\n");
    console.error = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

    try {
      const { mock } = await import("bun:test");
      mock.module("../../src/extensions/webui/server.ts", () => ({
        createWebuiServer: mock(async () => {
          setTimeout(() => process.emit("SIGINT"), 100);
          return {
            server: { stop: () => {} },
            wsServer: { stopCleanupLoop: () => {} },
          };
        }),
      }));

      const { main: mainFresh } = await import("../../src/core/main.ts");
      const exitCode = await mainFresh();

      expect(exitCode).toBe(0);
    } finally {
      process.argv = origArgv;
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      console.log = origConsoleLog;
      console.error = origConsoleError;
      process.env = origEnv;
    }
  });

  it("dispatches webui subcommand and handles server startup error", async () => {
    const origArgv = process.argv;
    const origEnv = { ...process.env };
    const origStdoutWrite = process.stdout.write;
    const origStderrWrite = process.stderr.write;
    const origConsoleLog = console.log;
    const origConsoleError = console.error;

    process.env.HOTDOG_LOG_TARGET = "stderr";
    process.env.HOTDOG_LOG_LEVEL = "error";
    process.env.HOTDOG_AI_URL = "http://test:8000";
    process.env.HOTDOG_API_KEY = "test-key";
    process.env.HOTDOG_WEBUI_API_KEY = "webui-secret";
    process.argv = ["bun", "hotdog", "webui"];

    let capturedStderr = "";
    process.stdout.write = () => true;
    process.stderr.write = (chunk: string | Buffer): boolean => {
      if (typeof chunk === "string") capturedStderr += chunk;
      else capturedStderr += chunk.toString();
      return true;
    };
    console.log = () => {};
    console.error = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

    try {
      const { mock } = await import("bun:test");
      mock.module("../../src/extensions/webui/server.ts", () => ({
        createWebuiServer: mock(async () => {
          throw "non-error string";
        }),
      }));

      const { main: mainFresh } = await import("../../src/core/main.ts");
      const exitCode = await mainFresh();

      expect(exitCode).toBe(1);
      expect(capturedStderr).toContain("Failed to start server");
      expect(capturedStderr).toContain("non-error string");
    } finally {
      process.argv = origArgv;
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      console.log = origConsoleLog;
      console.error = origConsoleError;
      process.env = origEnv;
    }
  });
});
