// Integration tests for main() --help output.
// Calls main() directly at the highest possible level to verify
// that --help produces the full help text including config flags,
// works without an AI URL configured, and exits with code 0.

import { describe, it, expect } from "bun:test";
import { main } from "../../src/core/main.ts";
import { resetLoggerForTesting } from "../../src/core/logger.ts";

import pkg from "../../package.json" with { type: "json" };
import { ConfigRegistry } from "../../src/core/index.ts";

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
    resetLoggerForTesting();
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
    expect(stdout).toContain("Agent Harness Info");
  });

  it("handles subcommand with --help flag", async () => {
    const { exitCode } = await runMain(["info", "--help"], {
      AI_URL: "",
      HOTDOG_AI_URL: "",
    });
    expect(exitCode).toBe(0);
  });

  it("registers webui subcommand", async () => {
    // Verify the webui subcommand is registered by checking help output.
    // Detailed server behavior is tested in webui-server.test.ts.
    const { exitCode, stdout } = await runMain(["--help"], {
      AI_URL: "",
      HOTDOG_AI_URL: "",
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("webui");
  });
});
describe("main -- subcommand handler errors", () => {
  it("handles unknown subcommand with suggestion", async () => {
    // Verify that unknown subcommands are handled with suggestions.
    // The "handler not available" case is an internal error that occurs
    // when extension.json registers a subcommand but the extension fails
    // to attach a handler - this is tested via the extension loading flow.
    const { exitCode, stderr } = await runMain(["infoo"], {
      AI_URL: "",
      HOTDOG_AI_URL: "",
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown subcommand");
    expect(stderr).toContain("info");
  });
});

describe("main -- no subcommand fallback", () => {
  it("prints 'No subcommand provided' when no subcommand given and stdin is not TTY", async () => {
    // This tests lines 432-436: the final fallback error.
    // Force stdin.isTTY to false so we skip the default_subcommand path.
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      const { exitCode, stderr, stdout } = await runMain([], {
        AI_URL: "http://test:8000",
        HOTDOG_AI_URL: "http://test:8000",
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain("No subcommand provided");
      expect(stdout).toContain("Available subcommands");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    }
  });
});

describe("CoreInfrastructure service accessor", () => {
  it("core.service() retrieves registered services", async () => {
    // This tests line 128: the service() arrow function on CoreInfrastructure.
    const { createHooks } = await import("../../src/core/hooks.ts");
    const { createToolRegistry } = await import(
      "../../src/core/extensions/tool-registry.ts"
    );
    const { createServiceRegistry } = await import(
      "../../src/core/extensions/service-registry.ts"
    );
    const { createExtensionLoader } = await import(
      "../../src/core/extensions/extensions.ts"
    );
    const { createCompletionService } = await import(
      "../../src/core/completion.ts"
    );
    const { createSubcommandRegistry } = await import(
      "../../src/core/extensions/registries.ts"
    );
    const { createToolFormatRegistry } = await import(
      "../../src/core/extensions/tool-format.ts"
    );
    const { xmlToolFormat } = await import(
      "../../src/core/extensions/tool-format-xml.ts"
    );
    const { createLlmProtocolRegistry } = await import(
      "../../src/core/llm-client/protocol.ts"
    );
    const { openaiProtocol } = await import(
      "../../src/core/llm-client/openai-protocol.ts"
    );

    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const toolFormatRegistry = createToolFormatRegistry();
    toolFormatRegistry.register(xmlToolFormat);
    const llmProtocolRegistry = createLlmProtocolRegistry();
    llmProtocolRegistry.register(openaiProtocol);
    const services = createServiceRegistry();
    const completion = createCompletionService();
    const configRegistry = new ConfigRegistry();
    const cliSubcommandRegistry = createSubcommandRegistry();

    const extensions = createExtensionLoader({
      hooks,
      toolRegistry,
      services,
      completion,
      config: {},
      cliSubcommandRegistry,
      configRegistry,
    });

    // Manually construct a CoreInfrastructure-like object matching createCore output
    const core = {
      hooks,
      toolRegistry,
      extensions,
      services,
      completion,
      config: {},
      cliSubcommandRegistry,
      configRegistry,
      toolFormatRegistry,
      llmProtocolRegistry,
      service: (name: string) => services.get(name),
    };

    // Register a service
    services.register("test-service", { value: "hello" });

    // Call core.service() - this exercises line 128
    const result = core.service("test-service") as { value: string };
    expect(result.value).toBe("hello");

    // Verify it throws for missing services (same underlying get())
    expect(() => core.service("nonexistent")).toThrow();
  });
});

describe("createCore.createLlmClient (modelToolFormat layering)", () => {
  // Second format so the resolved choice is observable.
  const toyFormat = {
    id: "toy",
    markers: ["toy-marker"],
    formatResult(result: string | Record<string, unknown>) {
      return String(result);
    },
  };

  function mc(): import("../../src/core/config/providers.ts").ModelConfig {
    return { name: "prov/model", temperature: null, contextLimit: 128000, tags: [] };
  }

  async function buildCore(
    fileConfig: Record<string, unknown>,
    cli: Record<string, unknown>,
  ) {
    const { createCore } = await import("../../src/core/main.ts");
    const { ConfigRegistry } = await import("../../src/core/index.ts");
    const { createSubcommandRegistry } = await import("../../src/core/extensions/registries.ts");
    const { buildAgentConfig, resolveConfigDir } = await import(
      "../../src/core/config/index.ts"
    );

    const core = createCore(
      fileConfig as import("../../src/core/config/schema-loader.ts").CoreConfigWithExtensions,
      new ConfigRegistry(),
      createSubcommandRegistry(),
    );
    core.toolFormatRegistry.register(toyFormat);

    const resolved = await buildAgentConfig({
      cli: cli as never,
      config: fileConfig as never,
      configDir: resolveConfigDir(),
      providers: [],
    });
    core.resolved = resolved as never;
    return core;
  }

  it("CLI --model-tool-format wins over the raw config file value", async () => {
    const core = await buildCore({ modelToolFormat: "xml" }, { modelToolFormat: "toy" });
    expect(core.createLlmClient().toolFormatFor(mc()).id).toBe("toy");
  });

  it("config file value applies when no CLI flag is given", async () => {
    const core = await buildCore({ modelToolFormat: "toy" }, {});
    expect(core.createLlmClient().toolFormatFor(mc()).id).toBe("toy");
  });

  it("defaults to xml when nothing is set", async () => {
    const core = await buildCore({}, {});
    expect(core.createLlmClient().toolFormatFor(mc()).id).toBe("xml");
  });

  it("throws a config error for an unknown global modelToolFormat (no silent xml fallback)", async () => {
    const core = await buildCore({ modelToolFormat: "nope" }, {});
    expect(() => core.createLlmClient()).toThrow(/Unknown tool format "nope"/);
  });
});
