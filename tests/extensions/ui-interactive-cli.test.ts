import { describe, it, expect, spyOn } from "bun:test";
import readline from "node:readline";
import {
  isSystemCommand,
  SEND_TO_ASSISTANT_SUFFIX_RE,
  executeShellCommand,
  handleSlashCommand,
  parseCompletionContext,
  registerSlashCommandNameCompletion,
  registerCommandCompletions,
  registerShellCompletion,
  applyCommandReplacements,
  buildReadlineCompleter,
  buildOnQuitHandler,
} from "../../src/extensions/ui-interactive-cli/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { LlmClient } from "../../src/core/llm-client/client.ts";
import { runInteractiveSession } from "../../src/extensions/ui-interactive-cli/index.ts";
import { runWithSuppressedStdout } from "../test-helpers.ts";


// ── SEND_TO_ASSISTANT_SUFFIX_RE ────────────────────────────────────────────

describe("SEND_TO_ASSISTANT_SUFFIX_RE", () => {
  const shouldMatch = [
    "ls -la |@",
    "ls -la | @",
    "ls -la |   @",
    "ls -la|\t@",
    "ls -la | @ ",
    "ls -la | @  ",
    "ls -la |@   ",
    "ls -la |   @   ",
    "ls -la|\t@\t",
    "git diff |@",
    "git diff | @",
    "echo hello | @",
    "|@",
    "| @",
    "ls -la ||@",
    // With notes (space required after @)
    "ls -la | @ show me the permissions",
    "ls -la |@ foo",
    "git diff | @ what changed?",
    "echo hello | @   multiple spaces",
  ];

  const shouldNotMatch = [
    "ls -la",
    "ls -la |",
    "ls -la | something",
    "ls -la | foo",
    "ls -la | bar@",
    "ls -la | @@ ",
    "ls -la | @note",
    "ls -la @",
    "ls -la ||",
    "",
    "   ",
    "|",
    "@",
  ];

  for (const cmd of shouldMatch) {
    it(`matches "${cmd}"`, () => {
      expect(SEND_TO_ASSISTANT_SUFFIX_RE.test(cmd)).toBe(true);
    });
  }

  for (const cmd of shouldNotMatch) {
    it(`does not match "${cmd}"`, () => {
      expect(SEND_TO_ASSISTANT_SUFFIX_RE.test(cmd)).toBe(false);
    });
  }

  // Note extraction tests
  describe("note extraction", () => {
    it("extracts note when present", () => {
      const match = "ls -la | @ show me the permissions".match(
        SEND_TO_ASSISTANT_SUFFIX_RE,
      );
      expect(match).not.toBeNull();
      expect((match![1] || "").trim()).toBe("show me the permissions");
    });

    it("returns empty note when no note provided", () => {
      const match = "ls -la | @".match(SEND_TO_ASSISTANT_SUFFIX_RE);
      expect(match).not.toBeNull();
      expect((match![1] || "").trim()).toBe("");
    });

    it("returns empty note for trailing whitespace only", () => {
      const match = "ls -la | @   ".match(SEND_TO_ASSISTANT_SUFFIX_RE);
      expect(match).not.toBeNull();
      expect((match![1] || "").trim()).toBe("");
    });

    it("extracts note with multiple spaces after @", () => {
      const match = "echo hello | @   what is this".match(
        SEND_TO_ASSISTANT_SUFFIX_RE,
      );
      expect(match).not.toBeNull();
      expect((match![1] || "").trim()).toBe("what is this");
    });

    it("strips suffix to get command", () => {
      const cmd = "ls -la | @ show me".replace(
        SEND_TO_ASSISTANT_SUFFIX_RE,
        "",
      );
      expect(cmd.trim()).toBe("ls -la");
    });
  });
});

// ── parseCompletionContext ─────────────────────────────────────────────────

describe("parseCompletionContext", () => {
  it("returns undefined command for non-slash input", () => {
    const mockAgent = {} as never;
    const ctx = parseCompletionContext("hello world", 11, mockAgent);
    expect(ctx.command).toBeUndefined();
    expect(ctx.commandArg).toBeUndefined();
  });

  it("parses slash command name (no space)", () => {
    const mockAgent = {} as never;
    const ctx = parseCompletionContext("/model", 6, mockAgent);
    expect(ctx.command).toBe("model");
    expect(ctx.commandArg).toBe("");
  });

  it("parses slash command with argument", () => {
    const mockAgent = {} as never;
    const ctx = parseCompletionContext("/model gpt-4", 12, mockAgent);
    expect(ctx.command).toBe("model");
    expect(ctx.commandArg).toBe("gpt-4");
  });

  it("handles colon syntax in command (e.g., /prompt:name)", () => {
    const mockAgent = {} as never;
    const ctx = parseCompletionContext("/prompt:deploy", 14, mockAgent);
    expect(ctx.command).toBe("prompt:deploy");
    expect(ctx.commandArg).toBe("");
  });

  it("handles just slash", () => {
    const mockAgent = {} as never;
    const ctx = parseCompletionContext("/", 1, mockAgent);
    expect(ctx.command).toBe("");
    expect(ctx.commandArg).toBe("");
  });
});

// ── applyCommandReplacements ───────────────────────────────────────────────

describe("applyCommandReplacements", () => {
  it("adds --color=always to bare ls", () => {
    expect(applyCommandReplacements("ls")).toBe("ls --color=always");
  });

  it("adds --color=always to ls with args", () => {
    expect(applyCommandReplacements("ls -la")).toBe("ls --color=always -la");
  });

  it("does not add --color when already specified", () => {
    expect(applyCommandReplacements("ls --color=never")).toBe("ls --color=never");
    expect(applyCommandReplacements("ls --color=always")).toBe("ls --color=always");
    expect(applyCommandReplacements("ls --color")).toBe("ls --color");
  });

  it("does not modify non-ls commands", () => {
    expect(applyCommandReplacements("lsyncd")).toBe("lsyncd");
    expect(applyCommandReplacements("echo hello")).toBe("echo hello");
  });
});

// ── registerSlashCommandNameCompletion ─────────────────────────────────────

describe("registerSlashCommandNameCompletion", () => {
  it("registers slash command name completion provider", () => {
    const registeredProviders: string[] = [];
    const mockCompletionService = {
      register: (_matcher: unknown, _provider: unknown, name: string) => {
        registeredProviders.push(name);
      },
    } as never;

    registerSlashCommandNameCompletion(mockCompletionService);

    expect(registeredProviders).toContain("ui-interactive-cli:slash-commands");
  });
});

// ── registerCommandCompletions ─────────────────────────────────────────────

describe("registerCommandCompletions", () => {
  it("registers completions from command definitions", () => {
    const registeredProviders: Array<{ name: string; matcher: (ctx: unknown) => boolean }> = [];
    const mockCompletionService = {
      register: (matcher: (ctx: unknown) => boolean, _provider: unknown, name: string) => {
        registeredProviders.push({ name, matcher });
      },
    } as never;

    const mockRegistry = {
      all: () => new Map([
        ["model", { completion: () => [] }],
        ["skill", { completion: () => [] }],
        ["compact", {}], // no completion
      ]),
    };

    registerCommandCompletions(mockCompletionService, mockRegistry as never, "test-ext");

    expect(registeredProviders).toHaveLength(2);
    expect(registeredProviders.map((p) => p.name)).toContain("test-ext:model");
    expect(registeredProviders.map((p) => p.name)).toContain("test-ext:skill");
    expect(registeredProviders.map((p) => p.name)).not.toContain("test-ext:compact");
  });

  it("matcher matches exact command name", () => {
    const registeredProviders: Array<{ name: string; matcher: (ctx: unknown) => boolean }> = [];
    const mockCompletionService = {
      register: (matcher: (ctx: unknown) => boolean, _provider: unknown, name: string) => {
        registeredProviders.push({ name, matcher });
      },
    } as never;

    const mockRegistry = {
      all: () => new Map([["model", { completion: () => [] }]]),
    };

    registerCommandCompletions(mockCompletionService, mockRegistry as never, "test-ext");
    const matcher = registeredProviders[0]!.matcher;

    expect(matcher({ command: "model", commandArg: "" })).toBe(true);
    expect(matcher({ command: "other", commandArg: "" })).toBe(false);
    expect(matcher({ command: undefined, commandArg: "" })).toBe(false);
  });

  it("matcher matches colon-prefixed command variants", () => {
    const registeredProviders: Array<{ name: string; matcher: (ctx: unknown) => boolean }> = [];
    const mockCompletionService = {
      register: (matcher: (ctx: unknown) => boolean, _provider: unknown, name: string) => {
        registeredProviders.push({ name, matcher });
      },
    } as never;

    const mockRegistry = {
      all: () => new Map([["example", { completion: () => [] }]]),
    };

    registerCommandCompletions(mockCompletionService, mockRegistry as never, "test-ext");
    const matcher = registeredProviders[0]!.matcher;

    expect(matcher({ command: "example", commandArg: "" })).toBe(true);
    expect(matcher({ command: "example:sub", commandArg: "" })).toBe(true);
    expect(matcher({ command: "other", commandArg: "" })).toBe(false);
  });
});

// ── registerShellCompletion ────────────────────────────────────────────────

describe("registerShellCompletion", () => {
  it("does not register when shellModeEnabled is false", () => {
    const registeredProviders: string[] = [];
    const mockCompletionService = {
      register: (_matcher: unknown, _provider: unknown, name: string) => {
        registeredProviders.push(name);
      },
    } as never;

    registerShellCompletion(mockCompletionService, false);
    expect(registeredProviders).toHaveLength(0);
  });

  it("registers shell completion provider when enabled", () => {
    const registeredProviders: string[] = [];
    const mockCompletionService = {
      register: (_matcher: unknown, _provider: unknown, name: string) => {
        registeredProviders.push(name);
      },
    } as never;

    registerShellCompletion(mockCompletionService, true);
    expect(registeredProviders).toContain("ui-interactive-cli:shell");
  });
});

// ── isSystemCommand ────────────────────────────────────────────────────────

describe("isSystemCommand", () => {
  it("returns true for existing system command", async () => {
    expect(await isSystemCommand("echo")).toBe(true);
  });

  it("returns false for non-existent command", async () => {
    expect(await isSystemCommand("nonexistent_cmd_xyz_12345")).toBe(false);
  });

  it("handles spawn error for non-existent shell", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/completely/nonexistent";
    try {
      expect(await isSystemCommand("anycommand")).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// ── executeShellCommand ────────────────────────────────────────────────────

describe("executeShellCommand", () => {

  it("runs command without capture returns empty content", async () => {
    const result = await runWithSuppressedStdout(() => executeShellCommand("true"));
    expect(result.content).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("runs command with capture returns output", async () => {
    const result = await runWithSuppressedStdout(() =>
      executeShellCommand("echo 'test output'", { captureOutput: true })
    );
    expect(result.content).toContain("test output");
    expect(result.exitCode).toBe(0);
  });

  it("returns non-zero exit code for failing command", async () => {
    const result = await runWithSuppressedStdout(() => executeShellCommand("exit 42"));
    expect(result.exitCode).toBe(42);
  });

  it("returns error when spawn fails (non-capture mode)", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent/path";
    try {
      const result = await runWithSuppressedStdout(() => executeShellCommand("echo hello"));
      expect(result.error).toBeDefined();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("returns error when spawn fails (capture mode)", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent/path";
    try {
      const result = await runWithSuppressedStdout(() =>
        executeShellCommand("echo hello", { captureOutput: true })
      );
      expect(result.error).toBeDefined();
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// AsyncInteractiveCliInput, handleSlashCommand and subcommand registration are
// covered in interactive-cli-input.test.ts and interactive-cli-extended.test.ts.

// ── buildReadlineCompleter ─────────────────────────────────────────────────

type Completer = (line: string, cb: (err: Error | null, result: [string[], string]) => void) => void;

/** Invoke the completer and resolve with the (async) callback result. */
function invokeCompleter(completer: Completer, line: string): Promise<[string[], string]> {
  return new Promise((resolve) => {
    completer(line, (err, result) => {
      expect(err).toBeNull();
      resolve(result);
    });
  });
}

describe("buildReadlineCompleter", () => {
  const mockAgent = { commandRegistry: { names: () => ["help"] }, modelRegistry: {} };
  const mockCore = { completion: { request: async () => [] } };

  it("handles no agent available", async () => {
    const mockSessionManager = { getAgent: () => null } as never;
    const completer = buildReadlineCompleter(mockSessionManager, mockCore as never, false);

    await expect(invokeCompleter(completer, "test-line")).resolves.toEqual([[], "test-line"]);
  });

  it("handles slash command name completion", async () => {
    const mockSessionManager = { getAgent: () => mockAgent } as never;
    const coreWithResults = { completion: { request: async () => [{ value: "/help" }] } };
    const completer = buildReadlineCompleter(mockSessionManager, coreWithResults as never, false);

    const [matches, prefix] = await invokeCompleter(completer, "/hel");
    expect(prefix).toBe("/hel");
    expect(matches).toEqual(["/help"]);
  });

  it("handles colon syntax prefix", async () => {
    const mockSessionManager = { getAgent: () => mockAgent } as never;
    const completer = buildReadlineCompleter(mockSessionManager, mockCore as never, false);

    const [, prefix] = await invokeCompleter(completer, "/prompt:dep");
    expect(prefix).toBe("dep");
  });

  it("handles shell mode prefix", async () => {
    const mockSessionManager = { getAgent: () => mockAgent } as never;
    const completer = buildReadlineCompleter(mockSessionManager, mockCore as never, true);

    const [, prefix] = await invokeCompleter(completer, "ls fil");
    expect(prefix).toBe("fil");
  });

  it("handles completion request error gracefully", async () => {
    const mockSessionManager = { getAgent: () => mockAgent } as never;
    const failingCore = { completion: { request: async () => { throw new Error("fail"); } } };
    const completer = buildReadlineCompleter(mockSessionManager, failingCore as never, false);

    await expect(invokeCompleter(completer, "/test")).resolves.toEqual([[], "/test"]);
  });
});

// ── buildOnQuitHandler ─────────────────────────────────────────────────────

describe("buildOnQuitHandler", () => {
  /** Run a quit handler with console.log captured and process.exit stubbed. */
  function runQuitHandler(sessionId: string | null): { logCalls: string[]; exitCalled: boolean } {
    const logCalls: string[] = [];
    const restoreLog = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logCalls.push(args.map(String).join(" "));
    });
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = (() => { exitCalled = true; }) as never;

    try {
      const handler = buildOnQuitHandler(
        { sessionId: () => sessionId } as never,
        { cleanup: () => {} } as never,
      );
      handler();
    } finally {
      restoreLog.mockRestore();
      process.exit = originalExit;
    }

    return { logCalls, exitCalled };
  }

  it("logs goodbye and session ID", () => {
    const { logCalls, exitCalled } = runQuitHandler("test-session-123");
    expect(logCalls.some((c) => c.includes("Goodbye"))).toBe(true);
    expect(logCalls.some((c) => c.includes("test-session-123"))).toBe(true);
    expect(exitCalled).toBe(true);
  });

  it("handles null session ID gracefully", () => {
    const { logCalls, exitCalled } = runQuitHandler(null);
    expect(logCalls.some((c) => c.includes("Goodbye"))).toBe(true);
    expect(logCalls.some((c) => c.includes("Session:"))).toBe(false);
    expect(exitCalled).toBe(true);
  });
});

// ── runInteractiveSession integration tests ────────────────────────────────
// NOTE: "throws when resolved config is missing" is covered in
// interactive-cli-session.test.ts. The completer's prefix behavior (slash,
// colon, shell mode) is covered by the buildReadlineCompleter unit tests above;
// the integration tests below only verify that runInteractiveSession wires the
// completer and handlers into readline.

const createMockSessionManager = (
  agent: Record<string, unknown> | null,
  shouldBusResolve = false,
) => ({
  getAgent: () => agent,
  sessionId: () => "test-session",
  getBus: () => ({
    run: async () => {
      if (shouldBusResolve) return;
      return new Promise(() => {});
    },
  }),
  getTaskManager: () => null,
  executeCommand: async () => undefined,
  onSessionEvents: (_sessionId: string, _handler: unknown) => () => {},
  interrupt: () => {},
});

function createMockCore(overrides: Record<string, unknown> = {}): never {
  const { resolved, config, ...rest } = overrides;
  return {
    resolved: {
      model: "test-model",
      theme: "dark",
      apiKey: "test-key",
      baseUrl: "http://test",
      stream: true,
      chatTimeout: 60,
      maxRetries: 3,
      maxIterations: 100,
      profileName: "test",
      hideTools: false,
      hideThinking: false,
      showTokenUse: false,
      role: undefined,
      profileBody: undefined,
      taskProfile: "task-default",
      taskDefaultRole: "",
      modelRegistry: {},
      ...(resolved as Record<string, unknown> ?? {}),
    },
    config: {
      providers: [],
      ...(config as Record<string, unknown> ?? {}),
    },
    hooks: {
      on: () => {},
      notifyHooks: () => {},
    },
    toolRegistry: {
      names: () => [],
      get: () => undefined,
      getAll: () => [],
      isEmpty: () => true,
    },
    extensions: {
      get: () => undefined,
      getAll: () => [],
      cleanup: () => {},
    },
    completion: {
      register: () => {},
      request: async () => [],
    },
    createLlmClient: (o?: Record<string, unknown>) =>
      new LlmClient({ baseUrl: "http://test", apiKey: "test-key", stream: true,
        chatTimeoutSecs: 60, maxRetries: 3, ...o }),
    ...rest,
  } as never;
}

const createMockRl = () =>
  ({
    on: () => {},
    removeListener: () => {},
    question: () => {},
    prompt: () => {},
    pause: () => {},
    resume: () => {},
    setPrompt: () => {},
    close: () => {},
  }) as unknown as readline.Interface;

/** Run `fn` with SessionManager.create stubbed; always restores the original. */
async function withMockSessionManager(
  createFn: () => Promise<unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  const { SessionManager: SM } = await import("../../src/core/session/index.ts");
  const original = SM.create;
  (SM as unknown as { create: unknown }).create = createFn;
  try {
    await fn();
  } finally {
    (SM as unknown as { create: unknown }).create = original;
  }
}

describe("runInteractiveSession integration", () => {
  it("wires the completer into readline options", async () => {
    let capturedCompleter: Completer | null = null;
    let resolveRlCreated: () => void;
    const rlCreated = new Promise<void>((resolve) => { resolveRlCreated = resolve; });

    await withMockSessionManager(
      async () => createMockSessionManager(null),
      async () => {
        runInteractiveSession({}, createMockCore(), {
          createReadline: (opts: Record<string, unknown>) => {
            capturedCompleter = opts.completer as Completer;
            resolveRlCreated();
            return createMockRl();
          },
          onClose: () => {},
          onSIGINT: () => {},
          setupInput: () => {},
        });
        await rlCreated;
      },
    );

    expect(capturedCompleter).not.toBeNull();
    // No agent: the wired completer degrades to empty completions.
    await expect(invokeCompleter(capturedCompleter!, "test-line")).resolves.toEqual([[], "test-line"]);
  });

  const mockAgent = { commandRegistry: { names: () => ["test"] }, modelRegistry: {} };

  /** Readline mock that records handlers per event. */
  function captureRl() {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const rl = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        (handlers[event] ||= []).push(handler);
        return rl;
      },
      removeListener: () => rl,
      question: () => rl,
      prompt: () => rl,
      pause: () => rl,
      resume: () => rl,
      setPrompt: () => rl,
      close: () => {},
      line: "",
      cursor: 0,
    } as unknown as readline.Interface;
    return { rl, get: (event: string) => handlers[event] ?? [] };
  }

  it("uses custom onSIGINT handler when provided", async () => {
    let customSigintCalled = false;
    const { rl, get } = captureRl();

    await withMockSessionManager(
      async () => createMockSessionManager(mockAgent, true),
      async () => {
        await runInteractiveSession({}, createMockCore(), {
          createReadline: () => rl,
          onClose: () => {},
          onSIGINT: () => { customSigintCalled = true; },
          setupInput: () => {},
        });
      },
    );

    const [sigint] = get("SIGINT");
    expect(get("SIGINT")).toHaveLength(1);
    sigint!();
    expect(customSigintCalled).toBe(true);
  });

  it("uses default SIGINT handler when not provided", async () => {
    const { rl, get } = captureRl();
    const consoleLogCalls: string[] = [];

    await withMockSessionManager(
      async () => createMockSessionManager(mockAgent, true),
      async () => {
        const restoreLog = spyOn(console, "log").mockImplementation((msg: string) => {
          consoleLogCalls.push(msg);
        });
        try {
          await runInteractiveSession({}, createMockCore(), {
            createReadline: () => rl,
            onClose: () => {},
            setupInput: () => {},
          });

          // Invoke while the console spy is still active.
          expect(get("SIGINT")).toHaveLength(1);
          get("SIGINT")[0]!();
          expect(consoleLogCalls.some((c) => c.includes("Interrupted"))).toBe(true);
        } finally {
          restoreLog.mockRestore();
        }
      },
    );
  });

  it("uses custom setupInput when provided", async () => {
    let customSetupCalled = false;

    await withMockSessionManager(
      async () => createMockSessionManager(mockAgent, true),
      async () => {
        await runInteractiveSession({}, createMockCore(), {
          createReadline: () => createMockRl(),
          onClose: () => {},
          onSIGINT: () => {},
          setupInput: () => { customSetupCalled = true; },
        });
      },
    );

    expect(customSetupCalled).toBe(true);
  });

  it("shell mode line handler executes system command", async () => {
    const { rl, get } = captureRl();

    await withMockSessionManager(
      async () => createMockSessionManager(mockAgent, true),
      async () => {
        await runInteractiveSession({}, createMockCore({ config: { uiInteractiveCli: { shellMode: true } } }), {
          createReadline: () => rl,
          onClose: () => {},
          onSIGINT: () => {},
          setupInput: () => {},
        });
      },
    );

    const lineHandlers = get("line") as Array<(line: string) => Promise<void>>;
    expect(lineHandlers.length).toBeGreaterThan(0);
    await runWithSuppressedStdout(() => lineHandlers[0]!("echo hello from shellmode"));
  });
});

describe("runInteractiveSession defaults", () => {
  const mockAgent = { commandRegistry: { names: () => ["test"] }, modelRegistry: {} };

  it("falls back to default setupInput when not provided", async () => {
    let rlCreated = false;

    await withMockSessionManager(
      async () => createMockSessionManager(mockAgent, true),
      async () => {
        await runInteractiveSession({}, createMockCore(), {
          createReadline: () => { rlCreated = true; return createMockRl(); },
          onClose: () => {},
          onSIGINT: () => {},
          // No setupInput - the default (AsyncInteractiveCliInput) must run.
        });
      },
    );

    // Session completed and readline was set up, so the default input
    // construction did not throw.
    expect(rlCreated).toBe(true);
  });

  it("wires command argument completions fired during initial SessionManager.create", async () => {
    // Regression: buildInteractiveAgent fires COMMANDS_REGISTER inside
    // SessionManager.create, so the completion listener must be registered
    // before create. Otherwise initial-agent argument completions
    // (e.g. /reasoning <levels>) are never wired up.
    const { createCompletionService } = await import("../../src/core/completion.ts");
    const { HookSystem } = await import("../../src/core/hooks.ts");

    const completion = createCompletionService();
    const hooks = new HookSystem();

    const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "unset"];
    const commandRegistry = {
      all: () =>
        new Map([
          [
            "reasoning",
            {
              completion: (ctx: { commandArg?: string }) =>
                levels
                  .filter((l) => l.startsWith((ctx.commandArg ?? "").toLowerCase()))
                  .map((l) => ({ value: l })),
            },
          ],
        ]),
      names: () => ["reasoning"],
    };
    const reasoningAgent = { commandRegistry, modelRegistry: {} };

    await withMockSessionManager(
      async () => {
        // Mimics buildInteractiveAgent: the hook fires during create.
        hooks.notifyHooks(HOOKS.COMMANDS_REGISTER, {
          registry: commandRegistry as never,
          agent: reasoningAgent as never,
        });
        return createMockSessionManager(reasoningAgent, true);
      },
      async () => {
        await runInteractiveSession(
          {},
          createMockCore({ hooks, completion }),
          {
            createReadline: () => createMockRl(),
            onClose: () => {},
            onSIGINT: () => {},
            setupInput: () => {},
          },
        );
      },
    );

    // Tab after "/reasoning " should offer all levels.
    const line = "/reasoning ";
    const ctx = parseCompletionContext(line, line.length, reasoningAgent as never);
    const options = await completion.request(ctx, 200);
    expect(options.map((o) => o.value).sort()).toEqual([...levels].sort());

    // Tab after a partial level should filter.
    const partial = "/reasoning med";
    const ctx2 = parseCompletionContext(partial, partial.length, reasoningAgent as never);
    const options2 = await completion.request(ctx2, 200);
    expect(options2.map((o) => o.value)).toEqual(["medium"]);
  });
});

// ── buildInteractiveAgent ──────────────────────────────────────────────────

describe("buildInteractiveAgent", () => {
  const defaultResolved = {
    model: "test-model",
    maxIterations: 50,
    profileName: "test-profile",
    hideTools: true,
    hideThinking: false,
    showTokenUse: true,
    modelRegistry: {},
    maxToolCallsPerIteration: 10,
    maxRetries: 5,
    toolRetryDelay: 1,
  };

  async function buildAgent(agentConfig: Record<string, unknown> = {}, core: Record<string, unknown> = {}) {
    const { buildInteractiveAgent } = await import(
      "../../src/extensions/ui-interactive-cli/index.ts"
    );
    return buildInteractiveAgent(
      agentConfig as never,
      {
        hooks: { on: () => {}, notifyHooks: () => {} },
        toolRegistry: {
          names: () => [],
          get: () => undefined,
          getAll: () => [],
          isEmpty: () => true,
        },
        ...core,
      } as never,
      defaultResolved as never,
      { providers: [] },
      {} as never,
      {},
    );
  }

  it("creates agent with default config values", async () => {
    const agent = await buildAgent();

    expect(agent).toBeDefined();
    expect(agent.model).toBe("test-model");
  });

  it("uses agentConfig overrides when provided", async () => {
    const agent = await buildAgent({
      model: "override-model",
      llmClient: {} as never,
      hideTools: false,
      stream: true,
    });

    expect(agent.model).toBe("override-model");
  });

  it("notifies COMMANDS_REGISTER hook", async () => {
    const notifyHooksCalls: unknown[] = [];
    await buildAgent({}, {
      hooks: {
        on: () => {},
        notifyHooks: (...args: unknown[]) => { notifyHooksCalls.push(args); },
      },
    });

    expect((notifyHooksCalls as [string, unknown][]).some((c) => c[0] === HOOKS.COMMANDS_REGISTER)).toBe(true);
  });
});

describe("handleSlashCommand error handling", () => {
  it("recovers from executeCommand rejection without crashing", async () => {
    const consoleLogCalls: string[] = [];
    const restoreLog = spyOn(console, "log").mockImplementation((msg: string) => {
      consoleLogCalls.push(msg);
    });
    const mockRl = { prompt: () => {}, close: () => {} } as never;
    let prompted = false;
    (mockRl as { prompt: () => void }).prompt = () => { prompted = true; };

    const mockSessionManager = {
      sessionId: () => "test",
      executeCommand: () => Promise.reject(new Error("command failed")),
    } as never;

    handleSlashCommand("bad-command", mockSessionManager, {} as never, mockRl);
    // The rejection lands in the .then handler one microtask later.
    await Promise.resolve();

    restoreLog.mockRestore();
    expect(prompted).toBe(true);
    expect(consoleLogCalls).toContain("");
  });
});

describe("registerShellCompletion provider", () => {
  it("shell completion provider returns empty for short commands", () => {
    const registeredProviders: Array<{
      matcher: (ctx: unknown) => boolean;
      provider: (ctx: unknown) => Promise<Array<{ value: string }>>;
      name: string;
    }> = [];

    const mockCompletionService = {
      register: (
        matcher: (ctx: unknown) => boolean,
        provider: (ctx: unknown) => Promise<Array<{ value: string }>>,
        name: string,
      ) => {
        registeredProviders.push({ matcher, provider, name });
      },
    } as never;

    registerShellCompletion(mockCompletionService, true);

    const shellProvider = registeredProviders.find(
      (p) => p.name === "ui-interactive-cli:shell",
    );
    expect(shellProvider).toBeDefined();

    // Test with short command (< MIN_CMD_LEN = 2)
    const matches = shellProvider!.provider({
      line: "a",
      cursorPos: 1,
    });
    expect(matches).resolves.toEqual([]);
  });

  it("shell completion matcher only matches in shell mode", () => {
    const registeredProviders: Array<{
      matcher: (ctx: unknown) => boolean;
      name: string;
    }> = [];

    const mockCompletionService = {
      register: (
        matcher: (ctx: unknown) => boolean,
        _provider: unknown,
        name: string,
      ) => {
        registeredProviders.push({ matcher, name });
      },
    } as never;

    registerShellCompletion(mockCompletionService, true);

    const shellProvider = registeredProviders.find(
      (p) => p.name === "ui-interactive-cli:shell",
    );

    // Should not match slash commands
    expect(shellProvider!.matcher({ line: "/help", cursorPos: 5 })).toBe(false);

    // Should match non-slash input
    expect(shellProvider!.matcher({ line: "ls -la", cursorPos: 6 })).toBe(true);
  });
});
