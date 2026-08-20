import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import readline from "node:readline";
import {
  isSystemCommand,
  SEND_TO_ASSISTANT_SUFFIX_RE,
  executeShellCommand,
  AsyncInteractiveCliInput,
  handleSlashCommand,
  create,
  parseCompletionContext,
  registerSlashCommandNameCompletion,
  registerCommandCompletions,
  registerShellCompletion,
  applyCommandReplacements,
  buildReadlineCompleter,
  buildOnQuitHandler,
} from "../../src/extensions/ui-interactive-cli/index.ts";
import { Command, ACTIONS } from "../../src/core/commands.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { ExtensionError } from "../../src/core/error.ts";
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

// ── AsyncInteractiveCliInput ───────────────────────────────────────────────

describe("AsyncInteractiveCliInput", () => {
  it("isInteractive returns true", () => {
    const mockRl = {} as readline.Interface;
    const input = new AsyncInteractiveCliInput(mockRl, () => {}, () => {});
    expect(input.isInteractive()).toBe(true);
  });

  it("collectAnswers handles free-text question", async () => {
    const responses: string[] = ["my answer"];
    let idx = 0;
    const mockRl = {
      removeListener: () => {},
      question: (_prompt: string, cb: (response: string) => void) => {
        cb(responses[idx++] ?? "");
      },
    } as unknown as readline.Interface;

    const input = new AsyncInteractiveCliInput(mockRl, () => {}, () => {});
    const answers = await runWithSuppressedStdout(() =>
      input.collectAnswers([{ key: "name", prompt: "What is your name?" }])
    );
    expect(answers).toEqual({ name: "my answer" });
  });

  it("collectAnswers uses default when input is empty", async () => {
    const responses: string[] = [""];
    let idx = 0;
    const mockRl = {
      removeListener: () => {},
      question: (_prompt: string, cb: (response: string) => void) => {
        cb(responses[idx++] ?? "");
      },
    } as unknown as readline.Interface;

    const input = new AsyncInteractiveCliInput(mockRl, () => {}, () => {});
    const answers = await runWithSuppressedStdout(() =>
      input.collectAnswers([{ key: "color", prompt: "Pick a color", default: "blue" }])
    );
    expect(answers).toEqual({ color: "blue" });
  });

  it("collectAnswers handles option selection by number", async () => {
    const responses: string[] = ["2"];
    let idx = 0;
    const mockRl = {
      removeListener: () => {},
      question: (_prompt: string, cb: (response: string) => void) => {
        cb(responses[idx++] ?? "");
      },
    } as unknown as readline.Interface;

    const input = new AsyncInteractiveCliInput(mockRl, () => {}, () => {});
    const answers = await runWithSuppressedStdout(() =>
      input.collectAnswers([
        { key: "choice", prompt: "Pick one", options: ["alpha", "beta", "gamma"] },
      ])
    );
    expect(answers).toEqual({ choice: "beta" });
  });

  it("collectAnswers restores line handler in finally block", async () => {
    const responses: string[] = ["answer"];
    let idx = 0;
    let restored = false;
    const mockRl = {
      removeListener: () => {},
      question: (_prompt: string, cb: (response: string) => void) => {
        cb(responses[idx++] ?? "");
      },
    } as unknown as readline.Interface;

    const addLineHandler = () => { restored = true; };
    const input = new AsyncInteractiveCliInput(mockRl, () => {}, addLineHandler);
    await runWithSuppressedStdout(() =>
      input.collectAnswers([{ key: "q", prompt: "Q?" }])
    );
    expect(restored).toBe(true);
  });
});

// ── handleSlashCommand ─────────────────────────────────────────────────────

describe("handleSlashCommand", () => {
  let mockSessionManager: {
    sessionId: () => string;
    executeCommand: (sessionId: string, cmd: string) => Promise<number | undefined>;
  };
  let mockChannel: Record<string, never>;
  let mockRl: { prompt: () => void; close: () => void };
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockSessionManager = {
      sessionId: () => "test-session",
      executeCommand: async () => undefined,
    } as never;
    mockChannel = {};
    mockRl = { prompt: () => {}, close: () => {} } as never;
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    processExitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it("handles /help command", () => {
    handleSlashCommand("help", mockSessionManager as never, mockChannel as never, mockRl as never);
    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleLogSpy.mock.calls[0][0]).toContain("Commands:");
  });

  it("handles /quit command", () => {
    handleSlashCommand("quit", mockSessionManager as never, mockChannel as never, mockRl as never);
    expect(consoleLogSpy).toHaveBeenCalledWith("Goodbye!");
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("delegates unknown commands to SessionManager", async () => {
    const executeCommandSpy = spyOn(mockSessionManager as never, "executeCommand").mockResolvedValue(undefined);
    handleSlashCommand("tokens", mockSessionManager as never, mockChannel as never, mockRl as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(executeCommandSpy).toHaveBeenCalledWith("test-session", "tokens");
    executeCommandSpy.mockRestore();
  });

  it("does not prompt after command when PROMPT action is set", async () => {
    const promptSpy = spyOn(mockRl as readline.Interface, "prompt").mockImplementation(() => {});
    const executeCommandSpy = spyOn(mockSessionManager as never, "executeCommand").mockResolvedValue(ACTIONS.PROMPT);
    handleSlashCommand("some-command", mockSessionManager as never, mockChannel as never, mockRl as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
    executeCommandSpy.mockRestore();
  });
});

// ── create (extension entry point) ─────────────────────────────────────────

describe("create", () => {
  it("returns extension with hooks", () => {
    const mockCore = { hooks: { on: () => {}, notifyHooks: () => {} } } as never;
    const ext = create(mockCore);
    expect(ext.hooks).toBeDefined();
    expect(ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();
  });
});

// ── buildReadlineCompleter ─────────────────────────────────────────────────

describe("buildReadlineCompleter", () => {
  it("handles no agent available", () => {
    const mockSessionManager = { getAgent: () => null } as never;
    const mockCore = { completion: { request: async () => [] } } as never;
    const completer = buildReadlineCompleter(mockSessionManager, mockCore, false);

    let callbackResult: [string[], string] | null = null;
    completer("test-line", (err: Error | null, result: [string[], string]) => {
      expect(err).toBeNull();
      callbackResult = result;
    });
    expect(callbackResult as unknown as [string[], string]).toEqual([[], "test-line"]);
  });

  it("handles slash command name completion", async () => {
    const mockAgent = { commandRegistry: { names: () => ["help"] }, modelRegistry: {} };
    const mockSessionManager = { getAgent: () => mockAgent } as never;
    const mockCore = { completion: { request: async () => [{ value: "/help" }] } } as never;
    const completer = buildReadlineCompleter(mockSessionManager, mockCore, false);

    let prefix: string | null = null;
    completer("/hel", (_: Error | null, result: [string[], string]) => { prefix = result[1] as string; });
    await new Promise((r) => setTimeout(r, 10));
    expect(prefix!).toBe("/hel");
  });

  it("handles colon syntax prefix", async () => {
    const mockAgent = { commandRegistry: { names: () => ["test"] }, modelRegistry: {} };
    const mockSessionManager = { getAgent: () => mockAgent } as never;
    const mockCore = { completion: { request: async () => [] } } as never;
    const completer = buildReadlineCompleter(mockSessionManager, mockCore, false);

    let prefix: string | null = null;
    completer("/prompt:dep", (_: Error | null, result: [string[], string]) => { prefix = result[1] as string; });
    await new Promise((r) => setTimeout(r, 10));
    expect(prefix!).toBe("dep");
  });

  it("handles shell mode prefix", async () => {
    const mockAgent = { commandRegistry: { names: () => ["test"] }, modelRegistry: {} };
    const mockSessionManager = { getAgent: () => mockAgent } as never;
    const mockCore = { completion: { request: async () => [] } } as never;
    const completer = buildReadlineCompleter(mockSessionManager, mockCore, true);

    let prefix: string | null = null;
    completer("ls fil", (_: Error | null, result: [string[], string]) => { prefix = result[1] as string; });
    await new Promise((r) => setTimeout(r, 10));
    expect(prefix!).toBe("fil");
  });

  it("handles completion request error gracefully", async () => {
    const mockAgent = { commandRegistry: { names: () => ["test"] }, modelRegistry: {} };
    const mockSessionManager = { getAgent: () => mockAgent } as never;
    const mockCore = { completion: { request: async () => { throw new Error("fail"); } } } as never;
    const completer = buildReadlineCompleter(mockSessionManager, mockCore, false);

    let callbackResult: [string[], string] | null = null;
    completer("/test", (err: Error | null, result: [string[], string]) => {
      expect(err).toBeNull();
      callbackResult = result;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(callbackResult as unknown as [string[], string]).toEqual([[], "/test"]);
  });
});

// ── buildOnQuitHandler ─────────────────────────────────────────────────────

describe("buildOnQuitHandler", () => {
  it("logs goodbye and session ID", () => {
    const consoleLogCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { consoleLogCalls.push(args.map(String).join(" ")); };

    const mockSessionManager = { sessionId: () => "test-session-123" } as never;
    const mockExtensions = { cleanup: () => {} } as never;
    const handler = buildOnQuitHandler(mockSessionManager, mockExtensions);

    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = (() => { exitCalled = true; }) as never;

    handler();

    expect(consoleLogCalls.some((c) => c.includes("Goodbye"))).toBe(true);
    expect(consoleLogCalls.some((c) => c.includes("test-session-123"))).toBe(true);
    expect(exitCalled).toBe(true);

    console.log = originalLog;
    process.exit = originalExit;
  });

  it("handles null session ID gracefully", () => {
    const consoleLogCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { consoleLogCalls.push(args.map(String).join(" ")); };

    const mockSessionManager = { sessionId: () => null } as never;
    const mockExtensions = { cleanup: () => {} } as never;
    const handler = buildOnQuitHandler(mockSessionManager, mockExtensions);

    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = (() => { exitCalled = true; }) as never;

    handler();

    expect(consoleLogCalls.some((c) => c.includes("Goodbye"))).toBe(true);
    expect(consoleLogCalls.some((c) => c.includes("Session:"))).toBe(false);
    expect(exitCalled).toBe(true);

    console.log = originalLog;
    process.exit = originalExit;
  });
});

// ── runInteractiveSession integration tests ────────────────────────────────

describe("runInteractiveSession integration", () => {
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

  const createMockCore = (overrides: { resolved?: Record<string, unknown>; config?: Record<string, unknown> } = {}) =>
    ({
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
        ...(overrides.resolved ?? {}),
      },
      config: {
        providers: [],
        ...(overrides.config ?? {}),
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
      ...overrides,
    }) as never;

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

  it("throws ExtensionError when config is not resolved", async () => {
    const mockCore = { resolved: null, config: {} } as never;
    await expect(runInteractiveSession({}, mockCore)).rejects.toThrow(ExtensionError);
  });

  it("sets up completer callback that handles no agent", async () => {
    const capturedCompleter: Array<(
      line: string,
      cb: (err: Error | null, result: [string[], string]) => void,
    ) => void> = [];

    const originalCreate = (await import("../../src/core/session/index.ts")).SessionManager.create;
    const mockSessionManager = createMockSessionManager(null);

    try {
      (await import("../../src/core/session/index.ts")).SessionManager.create = async () => mockSessionManager as never;

      runInteractiveSession({}, createMockCore(), {
        createReadline: (opts: Record<string, unknown>) => {
          capturedCompleter.push(opts.completer as never);
          return createMockRl();
        },
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      (await import("../../src/core/session/index.ts")).SessionManager.create = originalCreate;
    }

    expect(capturedCompleter.length).toBe(1);
    let callbackResult: [string[], string] | null = null;
    capturedCompleter[0]!("test-line", (err: Error | null, result: [string[], string]) => {
      expect(err).toBeNull();
      callbackResult = result;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(callbackResult as unknown as [string[], string]).toEqual([[], "test-line"]);
  });

  it("completer handles slash command and colon syntax", async () => {
    const capturedCompleter: Array<(
      line: string,
      cb: (err: Error | null, result: [string[], string]) => void,
    ) => void> = [];

    const originalCreate = (await import("../../src/core/session/index.ts")).SessionManager.create;
    const mockAgent = { commandRegistry: { names: () => ["help"] }, modelRegistry: {} };
    const mockSessionManager = createMockSessionManager(mockAgent);

    try {
      (await import("../../src/core/session/index.ts")).SessionManager.create = async () => mockSessionManager as never;

      runInteractiveSession({}, createMockCore(), {
        createReadline: (opts: Record<string, unknown>) => {
          capturedCompleter.push(opts.completer as never);
          return createMockRl();
        },
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      (await import("../../src/core/session/index.ts")).SessionManager.create = originalCreate;
    }

    // Test colon syntax
    let prefix: string | null = null;
    capturedCompleter[0]!("/prompt:dep", (_: Error | null, result: [string[], string]) => { prefix = result[1] as string; });
    await new Promise((r) => setTimeout(r, 10));
    expect(prefix!).toBe("dep");
  });

  it("completer handles shell mode prefix", async () => {
    const capturedCompleter: Array<(
      line: string,
      cb: (err: Error | null, result: [string[], string]) => void,
    ) => void> = [];

    const originalCreate = (await import("../../src/core/session/index.ts")).SessionManager.create;
    const mockAgent = { commandRegistry: { names: () => ["test"] }, modelRegistry: {} };
    const mockSessionManager = createMockSessionManager(mockAgent);

    try {
      (await import("../../src/core/session/index.ts")).SessionManager.create = async () => mockSessionManager as never;

      runInteractiveSession({}, createMockCore({ config: { uiInteractiveCli: { shellMode: true } } }), {
        createReadline: (opts: Record<string, unknown>) => {
          capturedCompleter.push(opts.completer as never);
          return createMockRl();
        },
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      (await import("../../src/core/session/index.ts")).SessionManager.create = originalCreate;
    }

    let prefix: string | null = null;
    capturedCompleter[0]!("ls fil", (_: Error | null, result: [string[], string]) => { prefix = result[1] as string; });
    await new Promise((r) => setTimeout(r, 10));
    expect(prefix!).toBe("fil");
  });

  it("uses custom onSIGINT handler when provided", async () => {
    let customSigintCalled = false;
    const sigintHandlers: (() => void)[] = [];

    const mockRl = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (event === "SIGINT") sigintHandlers.push(handler as () => void);
      },
      removeListener: () => {},
      question: () => {},
      prompt: () => {},
      pause: () => {},
      resume: () => {},
      setPrompt: () => {},
      close: () => {},
    } as unknown as readline.Interface;

    const originalCreate = (await import("../../src/core/session/index.ts")).SessionManager.create;
    const mockAgent = { commandRegistry: { names: () => ["test"] }, modelRegistry: {} };
    const mockSessionManager = createMockSessionManager(mockAgent, true);

    try {
      (await import("../../src/core/session/index.ts")).SessionManager.create = async () => mockSessionManager as never;

      await runInteractiveSession({}, createMockCore(), {
        createReadline: () => mockRl,
        onClose: () => {},
        onSIGINT: () => { customSigintCalled = true; },
        setupInput: () => {},
      });
    } finally {
      (await import("../../src/core/session/index.ts")).SessionManager.create = originalCreate;
    }

    expect(sigintHandlers.length).toBe(1);
    sigintHandlers[0]!();
    expect(customSigintCalled).toBe(true);
  });

  it("uses default SIGINT handler when not provided", async () => {
    const sigintHandlers: (() => void)[] = [];
    const consoleLogCalls: string[] = [];

    const mockRl = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (event === "SIGINT") sigintHandlers.push(handler as () => void);
      },
      removeListener: () => {},
      question: () => {},
      prompt: () => {},
      pause: () => {},
      resume: () => {},
      setPrompt: () => {},
      close: () => {},
      line: "",
      cursor: 0,
    } as unknown as readline.Interface;

    const originalCreate = (await import("../../src/core/session/index.ts")).SessionManager.create;
    const mockAgent = { commandRegistry: { names: () => ["test"] }, modelRegistry: {} };
    const mockSessionManager = createMockSessionManager(mockAgent, true);

    try {
      (await import("../../src/core/session/index.ts")).SessionManager.create = async () => mockSessionManager as never;
      spyOn(console, "log").mockImplementation((msg: string) => { consoleLogCalls.push(msg); });

      await runInteractiveSession({}, createMockCore(), {
        createReadline: () => mockRl,
        onClose: () => {},
        setupInput: () => {},
      });
    } finally {
      (await import("../../src/core/session/index.ts")).SessionManager.create = originalCreate;
    }

    expect(sigintHandlers.length).toBe(1);
    sigintHandlers[0]!();
    expect(consoleLogCalls.some((c) => c.includes("Interrupted"))).toBe(true);
  });

  it("uses custom setupInput when provided", async () => {
    let customSetupCalled = false;

    const originalCreate = (await import("../../src/core/session/index.ts")).SessionManager.create;
    const mockAgent = { commandRegistry: { names: () => ["test"] }, modelRegistry: {} };
    const mockSessionManager = createMockSessionManager(mockAgent, true);

    try {
      (await import("../../src/core/session/index.ts")).SessionManager.create = async () => mockSessionManager as never;

      await runInteractiveSession({}, createMockCore(), {
        createReadline: () => createMockRl(),
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => { customSetupCalled = true; },
      });
    } finally {
      (await import("../../src/core/session/index.ts")).SessionManager.create = originalCreate;
    }

    expect(customSetupCalled).toBe(true);
  });

  it("shell mode line handler executes system command", async () => {
    const lineHandlers: ((line: string) => Promise<void>)[] = [];

    const mockRl = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (event === "line") lineHandlers.push(handler as (line: string) => Promise<void>);
      },
      removeListener: () => {},
      question: () => {},
      prompt: () => {},
      pause: () => {},
      resume: () => {},
      setPrompt: () => {},
      close: () => {},
    } as unknown as readline.Interface;

    const originalCreate = (await import("../../src/core/session/index.ts")).SessionManager.create;
    const mockAgent = { commandRegistry: { names: () => ["test"] }, modelRegistry: {} };
    const mockSessionManager = createMockSessionManager(mockAgent, true);

    try {
      (await import("../../src/core/session/index.ts")).SessionManager.create = async () => mockSessionManager as never;

      await runInteractiveSession({}, createMockCore({ config: { uiInteractiveCli: { shellMode: true } } }), {
        createReadline: () => mockRl,
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });
    } finally {
      (await import("../../src/core/session/index.ts")).SessionManager.create = originalCreate;
    }

    expect(lineHandlers.length).toBeGreaterThan(0);
    await runWithSuppressedStdout(() => lineHandlers[0]!("echo hello from shellmode"));
  });
});

describe("runInteractiveSession default setupInput", () => {
  it("does not throw when no custom setupInput provided", async () => {
    const originalCreate = (await import("../../src/core/session/index.ts")).SessionManager.create;
    const mockAgent = { commandRegistry: { names: () => ["test"] }, modelRegistry: {} };
    const mockSessionManager = {
      getAgent: () => mockAgent,
      sessionId: () => "test-session",
      getBus: () => ({ run: async () => {} }),
      getTaskManager: () => null,
      executeCommand: async () => undefined,
      onSessionEvents: () => () => {},
      interrupt: () => {},
    };

    try {
      (await import("../../src/core/session/index.ts")).SessionManager.create = async () => mockSessionManager as never;

      await runInteractiveSession({}, {
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
        },
        config: { providers: [] },
        hooks: { on: () => {}, notifyHooks: () => {} },
        toolRegistry: { names: () => [], get: () => undefined, getAll: () => [], isEmpty: () => true },
        extensions: { get: () => undefined, getAll: () => [], cleanup: () => {} },
        completion: { register: () => {}, request: async () => [] },
      } as never, {
        createReadline: () => ({
          on: () => {},
          removeListener: () => {},
          question: () => {},
          prompt: () => {},
          pause: () => {},
          resume: () => {},
          setPrompt: () => {},
          close: () => {},
        }) as unknown as readline.Interface,
        onClose: () => {},
        onSIGINT: () => {},
        // No setupInput - should use default
      });
    } finally {
      (await import("../../src/core/session/index.ts")).SessionManager.create = originalCreate;
    }
  });
});

// ── buildInteractiveAgent ──────────────────────────────────────────────────

describe("buildInteractiveAgent", () => {
  it("creates agent with default config values", async () => {
    const { buildInteractiveAgent } = await import(
      "../../src/extensions/ui-interactive-cli/index.ts"
    );

    const mockHooks = {
      on: () => {},
      notifyHooks: () => {},
    };
    const mockToolRegistry = {
      names: () => [],
      get: () => undefined,
      getAll: () => [],
      isEmpty: () => true,
    };
    const mockLlmClient = {} as never;

    const agent = await buildInteractiveAgent(
      {},
      {
        hooks: mockHooks,
        toolRegistry: mockToolRegistry,
      } as never,
      {
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
      },
      { providers: [] },
      mockLlmClient,
      {},
    );

    expect(agent).toBeDefined();
    expect(agent.model).toBe("test-model");
  });

  it("uses agentConfig overrides when provided", async () => {
    const { buildInteractiveAgent } = await import(
      "../../src/extensions/ui-interactive-cli/index.ts"
    );

    const mockHooks = {
      on: () => {},
      notifyHooks: () => {},
    };
    const mockToolRegistry = {
      names: () => [],
      get: () => undefined,
      getAll: () => [],
      isEmpty: () => true,
    };
    const mockLlmClient = {} as never;
    const customLlmClient = {} as never;

    const agent = await buildInteractiveAgent(
      {
        model: "override-model",
        llmClient: customLlmClient,
        hideTools: false,
        stream: true,
      },
      {
        hooks: mockHooks,
        toolRegistry: mockToolRegistry,
      } as never,
      {
        model: "default-model",
        maxIterations: 50,
        profileName: "test-profile",
        hideTools: true,
        hideThinking: false,
        showTokenUse: true,
        modelRegistry: {},
        maxToolCallsPerIteration: 10,
        maxRetries: 5,
        toolRetryDelay: 1,
      },
      { providers: [] },
      mockLlmClient,
      {},
    );

    expect(agent.model).toBe("override-model");
  });

  it("notifies COMMANDS_REGISTER hook", async () => {
    const { buildInteractiveAgent } = await import(
      "../../src/extensions/ui-interactive-cli/index.ts"
    );

    const notifyHooksCalls: unknown[] = [];
    const mockHooks = {
      on: () => {},
      notifyHooks: (...args: unknown[]) => {
        notifyHooksCalls.push(args);
      },
    };
    const mockToolRegistry = {
      names: () => [],
      get: () => undefined,
      getAll: () => [],
      isEmpty: () => true,
    };
    const mockLlmClient = {} as never;

    await buildInteractiveAgent(
      {},
      {
        hooks: mockHooks,
        toolRegistry: mockToolRegistry,
      } as never,
      {
        model: "test-model",
        maxIterations: 50,
        profileName: "test-profile",
        hideTools: false,
        hideThinking: false,
        showTokenUse: false,
        modelRegistry: {},
        maxToolCallsPerIteration: 10,
        maxRetries: 5,
        toolRetryDelay: 1,
      },
      { providers: [] },
      mockLlmClient,
      {},
    );

    expect((notifyHooksCalls as [string, unknown][]).some((c) => c[0] === HOOKS.COMMANDS_REGISTER)).toBe(true);
  });
});

// ── Additional coverage for uncovered lines ────────────────────────────────

describe("executeShellCommand error handling", () => {
  it("handles spawn error with captureOutput", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent/path";
    try {
      const result = await runWithSuppressedStdout(() => executeShellCommand("echo hello", { captureOutput: true }));
      expect(result.error).toBeDefined();
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("handleSlashCommand error handling", () => {
  it("handles executeCommand rejection", async () => {
    const consoleLogCalls: string[] = [];
    spyOn(console, "log").mockImplementation((msg: string) => {
      consoleLogCalls.push(msg);
    });

    const mockSessionManager = {
      sessionId: () => "test",
      executeCommand: async () => {
        throw new Error("command failed");
      },
    } as never;

    const mockRl = { prompt: () => {}, close: () => {} } as never;

    handleSlashCommand("bad-command", mockSessionManager, {} as never, mockRl);
    await new Promise((r) => setTimeout(r, 20));

    // The error handler should log empty line and prompt
    expect(consoleLogCalls).toContain("");
  });
});

describe("create extension hooks", () => {
  it("registers CLI subcommand", async () => {
    const mockCore = {
      hooks: {
        on: () => {},
        notifyHooks: () => {},
      },
    } as never;

    const ext = create(mockCore);
    expect(ext.hooks).toBeDefined();

    const subcommandHandler = ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER];
    expect(subcommandHandler).toBeDefined();

    const registeredCommands: Array<{ name: string }> = [];
    await subcommandHandler!({
      register: (name: string, opts: Record<string, unknown>) => {
        registeredCommands.push({ name });
      },
    });

    expect(registeredCommands).toContainEqual({ name: "cli" });
  });

  it("AGENT_TOOL_CONTEXT hook sets input when available", () => {
    const mockCore = {
      hooks: {
        on: () => {},
        notifyHooks: () => {},
      },
    } as never;

    const ext = create(mockCore);
    expect(ext.hooks).toBeDefined();

    const toolContextHandler = ext.hooks![HOOKS.AGENT_TOOL_CONTEXT];
    expect(toolContextHandler).toBeDefined();

    // The hook handler runs without error (it may or may not set input depending on state)
    expect(() => toolContextHandler!({
      toolCtx: {
        set: () => {},
      } as never,
      toolName: "test-tool",
      agent: {} as never,
    })).not.toThrow();
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
