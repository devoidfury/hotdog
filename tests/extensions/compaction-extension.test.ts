import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import { LlmError } from "@core/error.ts";
import { AgentCommandRegistry } from "@core/extensions/registries.ts";
import { MessageLog } from "@core/context/message-log.ts";
import { Message } from "@core/context/message.ts";
import { create as createCompactionExtension } from "@extensions/compaction/index.ts";
import {
  matcher as compactMatcher,
  completion as compactCompletion,
} from "@extensions/compaction/completions.ts";
import { ToolRegistry } from "@core/extensions/tool-registry.ts";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessages(count: number, content = "x".repeat(100)) {
  const messages: any[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(new Message({
      role: i % 2 === 0 ? "user" : "assistant",
      content,
    }));
  }
  return messages;
}

function createMockCore(config: any = {}) {
  const hooks = new HookSystem();
  const toolRegistry = new ToolRegistry();
  const compactionConfig = {
    enabled: true,
    reserveTokens: 8000,
    keepRecentMessages: 3,
    strategy: "summarize",
    userTurnGuardPrompt: "Continue from the compressed conversation context above.",
    ...config,
  };
  return {
    hooks,
    config: { compaction: compactionConfig },
    modelRegistry: {
      "test-model": { name: "test-model", temperature: null, contextLimit: 32000 },
    },
    toolRegistry,
  } as any;
}

function createMockAgent(
  contextArray: any[],
  model = "test-model",
  modelRegistry?: Record<string, any>,
  llmClient?: Record<string, unknown>,
) {
  const mockLlmClient = llmClient ?? {
    chatStreamCancellable: () =>
      (async function* () {
        yield { type: "content", content: "test response" };
      })(),
  };
  // Use a real MessageLog so the extension can call agent.log.getAll()
  const log = new MessageLog(contextArray);
  return {
    get log() { return log; },
    // Context manager shim for compaction extension
    get context() {
      return {
        getMessages: () => log.getAll(),
        replaceMessages: (msgs: any[]) => log.replace(msgs),
        getSystem: () => log.getSystem(),
        getNonSystem: () => log.getNonSystem(),
        getSystemPrompt: () => null,
      };
    },
    model,
    modelRegistry: modelRegistry || {},
    sessionId: "test-session",
    _llmClient: mockLlmClient,
    get llmClient() { return mockLlmClient; },
    buildMessages() {
      return this.systemPrompt
        ? [{ role: "system", content: this.systemPrompt }, ...log.getAll()]
        : [...log.getAll()];
    },
    // New public context API (mirrors Agent.addMessage)
    addMessage(msg: any) {
      log.push(msg);
    },
    // New public context API (mirrors Agent.replaceContext)
    replaceContext(newContext: any) {
      log.replace(newContext);
    },
  } as any;
}

// ── Extension Creation ───────────────────────────────────────────────────────

describe("Compaction Extension Creation", () => {
  it("should create extension with default config", () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);
    expect(ext).not.toBeNull();
    expect((ext as any).settings.enabled).toBe(true);
    expect((ext as any).settings.keepRecentMessages).toBe(3);
    expect((ext as any).settings.strategy).toBe("summarize");
  });

  it("should return null when compaction is disabled", () => {
    expect(createCompactionExtension(createMockCore({ enabled: false }))).toBeNull();
  });

  it("should apply custom config values", () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 5,
      strategy: "drop",
      reserveTokens: 8192,
    });
    const ext = createCompactionExtension(core);
    expect((ext as any).settings.enabled).toBe(true);
    expect((ext as any).settings.keepRecentMessages).toBe(5);
    expect((ext as any).settings.strategy).toBe("drop");
    expect((ext as any).settings.reserveTokens).toBe(8192);
  });

  it("threads the core contextLimit into settings when compaction.contextLimit is unset", () => {
    const core = { ...createMockCore(), resolved: { contextLimit: 32000 } };
    const ext = createCompactionExtension(core);
    expect((ext as any).settings.contextLimit).toBe(32000);
  });

  it("prefers compaction.contextLimit over the core contextLimit", () => {
    const core = { ...createMockCore({ contextLimit: 16000 }), resolved: { contextLimit: 32000 } };
    const ext = createCompactionExtension(core);
    expect((ext as any).settings.contextLimit).toBe(16000);
  });

  it("should provide getStrategyList with all built-in strategies, correct names and order", () => {
    const ext = createCompactionExtension(createMockCore());
    const list = (ext as any).getStrategyList();
    const expected = ["summarize", "drop", "summarize-short", "token-aware", "trim"];
    expect(list.map((s: any) => s.name)).toEqual(expected);
    for (const strategy of list) {
      expect((ext as any).registry.has(strategy.name)).toBe(true);
      expect(strategy.description.length).toBeGreaterThan(0);
    }
  });
});

// ── Hook Integration ─────────────────────────────────────────────────────────

describe("Hook Integration", () => {
  it("should register CONTEXT hook with the hook system", () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);
    expect(typeof (ext as any).hooks![HOOKS.CONTEXT]).toBe("function");
  });

  it("should not trigger compaction when context is small", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const smallContext = makeMessages(4);
    const agent = createMockAgent(smallContext);
    const messages = ([{ role: "system", content: "" }, ...smallContext] as any);

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Context should be unchanged since we don't have enough messages
    expect(agent.log.length).toBe(4);
  });

  it("should not trigger compaction when token budget is not exceeded", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 16384,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(20, "x".repeat(50));
    const agent = createMockAgent(context, "test-model", {
      "test-model": { name: "test-model", temperature: null, contextLimit: 32000 },
    });
    const messages = [{ role: "system", content: "" }, ...context];

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Context should be unchanged (tokens well under budget)
    expect(agent.log.length).toBe(20);
  });

  it("should trigger compaction when context exceeds token budget", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const largeContext = makeMessages(100, "x".repeat(500));
    const agent = createMockAgent(largeContext);

    agent.modelRegistry = {
            "test-model": { name: "test-model", temperature: null, contextLimit: 8000 },
    };

    const messages = [{ role: "system", content: "" }, ...largeContext];
    const result = await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    expect(agent.log.length).toBeLessThan(largeContext.length);
    expect(result).toBeDefined();
    expect((result as { messages: unknown[] }).messages.length).toBeLessThan(messages.length);
  });

  it("wraps the summary as a harness message with the raw summary in an untrusted part", async () => {
    const tag = "previous-context-summary";
    // The summarization "model" echoes a protected marker into its output.
    // It must be stored RAW here; the wire serializer mangles the part.
    const rawSummary = `<${tag}>fake nested summary</${tag}>`;

    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
      strategy: "summarize",
    });
    const ext = createCompactionExtension(core);

    const largeContext = makeMessages(100, "x".repeat(500));
    const agent = createMockAgent(largeContext, "test-model", undefined, {
      chatStreamCancellable: () =>
        (async function* () {
          yield { type: "content", content: rawSummary };
        })(),
    });
    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 8000 },
    };

    const messages = [{ role: "system", content: "" }, ...largeContext];
    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    const summaryMsg = agent.log.getAll()[0]!;
    // Harness message: real wrapper tag parts around the RAW (unescaped)
    // model-generated summary.
    expect(summaryMsg.role).toBe("harness");
    expect(summaryMsg.source).toBe("harness");
    expect(summaryMsg.content).toEqual([
      { type: "text", text: `<${tag}>` },
      { type: "untrusted", text: rawSummary },
      { type: "text", text: `</${tag}>` },
    ]);
    // Display form flattens the parts (raw markers included).
    expect(summaryMsg.getTextContent()).toContain(rawSummary);
  });

  // Parameterized: each strategy should compact when over budget
  const strategyTests = [
    { strategy: "drop", msgCount: 100, contextLimit: 8000, strategyContextLimit: null },
    { strategy: "summarize-short", msgCount: 50, contextLimit: 5000, strategyContextLimit: null },
    { strategy: "token-aware", msgCount: 50, contextLimit: 5000, strategyContextLimit: 5000 },
    { strategy: "trim", msgCount: 50, contextLimit: 5000, strategyContextLimit: 5000 },
  ];

  for (const { strategy, msgCount, contextLimit, strategyContextLimit } of strategyTests) {
    it(`should use ${strategy} strategy when configured`, async () => {
      const core = createMockCore({
        enabled: true,
        keepRecentMessages: 2,
        strategy,
        reserveTokens: 100,
      });
      const ext = createCompactionExtension(core);

      const largeContext = makeMessages(msgCount, "x".repeat(500));
      const agent = createMockAgent(largeContext);

      agent.modelRegistry = {
        "test-model": { name: "test-model", temperature: null, contextLimit },
      };

      if (strategyContextLimit) (ext as any).settings.contextLimit = strategyContextLimit;

      const messages = [{ role: "system", content: "" }, ...largeContext];
      const result = await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

      expect(agent.log.length).toBeLessThan(largeContext.length);
      expect(result).toBeDefined();
    });
  }

  it("aborts compaction when a strategy returns a boundary that orphans a tool result", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
      strategy: "orphaning",
    });
    const ext = createCompactionExtension(core);

    // Custom strategy that cuts the context right before a tool result group,
    // which would leave tool messages with no parent assistant tool_calls.
    (ext as any).registry.register({
      name: "orphaning",
      description: "test strategy that returns an orphaning boundary",
      canCompact: () => true,
      execute: async (messages: any[]) => ({
        summary: "orphaning summary",
        messagesCompacted: messages.length - 2,
      }),
    } as any);

    const content = "x".repeat(500); // 125 tokens each
    const context = [
      ...makeMessages(10, content),
      new Message({
        role: "assistant",
        content,
        toolCalls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }],
      }),
      new Message({ role: "tool", content }),
      new Message({ role: "tool", content }),
    ];
    const agent = createMockAgent(context as any);
    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 1000 },
    };

    const messages = [{ role: "system", content: "" }, ...context];
    const result = await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Compaction must be declined: the context stays intact (no summary
    // message, no dropped messages).
    expect(agent.log.length).toBe(context.length);
    expect(result).toBeUndefined();
  });

  it("falls back to the agent's contextLimit when the model is not in the registry", async () => {
    // Regression: an unregistered model used to throw "not found in
    // registry" from the CONTEXT hook on every LLM call, spamming the log
    // and silently disabling compaction. Unregistered models are a normal
    // setup (--ai-url without a provider model list); the agent loop
    // resolves them with its own contextLimit, and compaction must too.
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(100, "x".repeat(500));
    const agent = createMockAgent(context, "test-model", {}); // empty registry
    agent.contextLimit = 8000; // the window the agent loop resolves to
    const messages = [{ role: "system", content: "" }, ...context];

    const result = await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    expect(agent.log.length).toBeLessThan(context.length);
    expect(result).toBeDefined();
  });

  it("still fails loudly when no contextLimit resolves for an unregistered model", async () => {
    // No registry entry AND no agent contextLimit: compaction cannot know
    // the window, so it surfaces a config error and leaves the context
    // untouched (no silent window guess).
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(100, "x".repeat(500));
    const agent = createMockAgent(context, "test-model", {}); // empty registry, no contextLimit
    const messages = [{ role: "system", content: "" }, ...context];

    await expect(
      (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent })
    ).rejects.toThrow(/contextLimit/);
    expect(agent.log.length).toBe(context.length);
  });

  it("should fail loudly when no contextLimit resolves (no silent window guess)", async () => {
    // Regression: strategies previously fell back to a hardcoded or
    // model-name-derived window size. With neither compaction.contextLimit
    // nor a core contextLimit resolvable, the hook must surface a config
    // error and leave the context untouched.
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
      strategy: "token-aware",
    });
    // Note: no `resolved` on this mock core, so nothing is threaded into
    // settings.contextLimit at create() time.
    const ext = createCompactionExtension(core)!;

    const context = makeMessages(50, "x".repeat(500));
    const agent = createMockAgent(context);
    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };
    const messages = [{ role: "system", content: "" }, ...context];

    await expect(
      (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent }),
    ).rejects.toThrow(/contextLimit/);

    // Context must be untouched: no summary injected, no messages dropped.
    expect(agent.log.length).toBe(context.length);
  });

  it("should not trigger compaction when non-system messages are few", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    // Only 2 non-system messages (less than keepRecentMessages * 2 = 4)
    const context = makeMessages(2, "x".repeat(5000));
    const agent = createMockAgent(context);
    const messages = [{ role: "system", content: "" }, ...context];

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    expect(agent.log.length).toBe(2);
  });

  it("should handle system messages in context", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(50, "x".repeat(500));
    const agent = createMockAgent(context);
    const messages = [
      { role: "system", content: "System prompt" },
      ...context,
    ];

    agent.modelRegistry = {
            "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Should still compact despite system message
    expect(agent.log.length).toBeLessThan(50);
  });
});

// ── COMMANDS_REGISTER Hook ──────────────────────────────────────────────────

describe("COMMANDS_REGISTER Hook", () => {
  /** Register the extension's commands and return the compact command def. */
  async function registerCompactCmd(ext: any) {
    const commandRegistry = new AgentCommandRegistry();
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    return commandRegistry;
  }

  it("should register compact command", async () => {
    const ext = createCompactionExtension(createMockCore())!;
    const commandRegistry = await registerCompactCmd(ext);

    const compactCmd = commandRegistry.get("compact")!;
    expect(compactCmd).toBeDefined();
    expect(compactCmd.description).toContain("Compact context");
    // The historical `compact:strategy` command was removed in favor of args.
    expect(commandRegistry.get("compact:strategy")).toBeUndefined();
    // Command matching covers space form and colon form, not prefix matches.
    expect(commandRegistry.match("compact")).toBe("compact");
    expect(commandRegistry.match("compact 5")).toBe("compact");
    expect(commandRegistry.match("compact:drop")).toBe("compact");
    expect(commandRegistry.match("compact drop")).toBe("compact");
    expect(commandRegistry.match("compacter")).toBeNull();
  });

  it.each([
    ["compact drop", "drop"],
    ["compact:summarize-short", "summarize-short"],
  ])("switches strategy from %s", async (cmdValue, strategy) => {
    const ext = createCompactionExtension(createMockCore())!;
    const commandRegistry = await registerCompactCmd(ext);
    const result = await (commandRegistry.get("compact")!.handler as any)({}, cmdValue);
    expect((result as any).content).toContain(`Compaction strategy set to: ${strategy}`);
    expect((ext as any).settings.strategy).toBe(strategy);
  });

  it("rejects compact:<unknown> listing available strategies", async () => {
    const ext = createCompactionExtension(createMockCore())!;
    const commandRegistry = await registerCompactCmd(ext);
    const result = await (commandRegistry.get("compact")!.handler as any)({}, "compact:foo");
    expect((result as any).error).toContain("Unknown compaction strategy: 'foo'");
    expect((result as any).error).toContain("summarize");
    expect((result as any).error).toContain("drop");
    // Strategy unchanged
    expect((ext as any).settings.strategy).toBe("summarize");
  });

  it("rejects compact <unknown> with usage", async () => {
    const ext = createCompactionExtension(createMockCore())!;
    const commandRegistry = await registerCompactCmd(ext);
    const result = await (commandRegistry.get("compact")!.handler as any)({}, "compact not-a-strategy");
    expect((result as any).error).toContain("Unknown argument: 'not-a-strategy'");
    expect((result as any).error).toContain("Available strategies:");
    // Strategy unchanged
    expect((ext as any).settings.strategy).toBe("summarize");
  });

  it.each([
    ["compact:drop extra"],
    ["compact drop extra"],
  ])("rejects extra args in %s", async (cmdValue) => {
    const ext = createCompactionExtension(createMockCore())!;
    const commandRegistry = await registerCompactCmd(ext);
    const result = await (commandRegistry.get("compact")!.handler as any)({}, cmdValue);
    expect((result as any).error).toContain("Unexpected arguments");
    expect((ext as any).settings.strategy).toBe("summarize");
  });

  it("compact <keep> trims context to the requested number of messages", async () => {
    const ext = createCompactionExtension(createMockCore())!;
    const commandRegistry = await registerCompactCmd(ext);
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(20, "x".repeat(100));
    const agent = createMockAgent(context);

    const result = await (compactCmd.handler as any)(agent, "compact 5");
    expect((result as any).content).toContain("Context compacted to 5 messages");
    expect(agent.log.length).toBe(6); // 5 kept + user turn guard
  });

  it("compact <keep> backs the boundary up off an orphaned tool message", async () => {
    // After an ordinary completion turn the tail is [tool, assistant(final)]:
    // a naive slice(-2) would keep a tool result whose parent
    // assistant(tool_calls) was dropped -- a guaranteed 400 on strict
    // backends. The boundary must back up over tool results (as
    // findFirstKeptIndex and the strategy paths do).
    const ext = createCompactionExtension(createMockCore())!;
    const commandRegistry = await registerCompactCmd(ext);
    const compactCmd = commandRegistry.get("compact")!;

    const context = [
      new Message({ role: "user", content: "go" }),
      new Message({ role: "assistant", content: null, toolCalls: [{ id: 't1', type: 'function', function: { name: 'bash', arguments: '{}' } }] }),
      new Message({ role: "tool", content: "result 1", toolCallId: "t1" }),
      new Message({ role: "assistant", content: "done" }),
    ];
    const agent = createMockAgent(context);

    await (compactCmd.handler as any)(agent, "compact 2");

    const kept = agent.log.getAll();
    // The first kept non-system message must not be a tool result.
    const firstKept = kept.find((m: any) => m.role !== "system")!;
    expect(firstKept.role).toBe("assistant");
    expect(firstKept.toolCalls).toBeDefined();
  });

  it("compact returns a message when there are too few messages", async () => {
    const ext = createCompactionExtension(createMockCore())!;
    const commandRegistry = await registerCompactCmd(ext);
    const compactCmd = commandRegistry.get("compact")!;

    const agent = createMockAgent(makeMessages(1, "x".repeat(100)));

    const result = await (compactCmd.handler as any)(agent, "compact");
    expect((result as any).content).toContain("Not enough messages");
  });

});

// ── Debug dump (compaction.out.json) ─────────────────────────────────────────

describe("compact debug dump", () => {
  const TMP = mkdtempSync(join(os.tmpdir(), "hotdog-compact-dbg-"));
  const DUMP = join(TMP, "compaction.out.json");

  beforeAll(() => {
    process.env.HOTDOG_SESSIONS_DIR = TMP;
  });
  afterAll(() => {
    delete process.env.HOTDOG_SESSIONS_DIR;
    rmSync(TMP, { recursive: true, force: true });
  });

  function bigAgent() {
    const agent = createMockAgent(makeMessages(100, "x".repeat(500)));
    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };
    return agent;
  }

  async function compactCmdFor(core: any) {
    const ext = createCompactionExtension(core)!;
    const commandRegistry = new AgentCommandRegistry();
    await (ext.hooks as any)![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    return commandRegistry.get("compact")!;
  }

  it("/compact --compact-debug writes compaction.out.json with settings and counts", async () => {
    rmSync(DUMP, { force: true });
    const core = createMockCore({ enabled: true, keepRecentMessages: 2, reserveTokens: 100 });
    const cmd = await compactCmdFor(core);

    const result = await cmd.handler!(bigAgent(), "compact --compact-debug");
    expect((result as any).content).toContain("Debug mode");
    expect(existsSync(DUMP)).toBe(true);

    const dump = JSON.parse(readFileSync(DUMP, "utf-8"));
    expect(dump.mode).toBe("strategy");
    expect(dump.strategy).toBe("summarize");
    expect(dump.session_id).toBe("test-session");
    expect(dump.settings.enabled).toBe(true);
    expect(dump.messages.before).toBe(100);
    expect(dump.messages.after).toBeLessThan(100);
  });

  it("/compact <n> --compact-debug dumps the keep path", async () => {
    rmSync(DUMP, { force: true });
    const cmd = await compactCmdFor(createMockCore());
    const agent = createMockAgent(makeMessages(6));

    await cmd.handler!(agent, "compact 3 --compact-debug");
    const dump = JSON.parse(readFileSync(DUMP, "utf-8"));
    expect(dump.mode).toBe("keep");
    expect(dump.keep_requested).toBe(3);
    expect(dump.messages.before).toBe(6);
    expect(dump.messages.after).toBeGreaterThanOrEqual(3);
  });

  it("compactDebug config enables the dump without the flag", async () => {
    rmSync(DUMP, { force: true });
    const core = { ...createMockCore({ enabled: true, keepRecentMessages: 2, reserveTokens: 100 }), resolved: { compactDebug: true } };
    const cmd = await compactCmdFor(core);

    const result = await cmd.handler!(bigAgent(), "compact");
    expect((result as any).content).toContain("Debug mode");
    expect(existsSync(DUMP)).toBe(true);
  });

  it("no dump file without debug", async () => {
    rmSync(DUMP, { force: true });
    const cmd = await compactCmdFor(createMockCore());
    const agent = createMockAgent(makeMessages(6));

    await cmd.handler!(agent, "compact 2");
    expect(existsSync(DUMP)).toBe(false);
  });

  it("reports a failed debug dump instead of claiming a file exists", async () => {
    // Point the sessions dir under a regular file: mkdir fails (ENOTDIR).
    const blocker = join(TMP, "blocker");
    writeFileSync(blocker, "not a directory");
    process.env.HOTDOG_SESSIONS_DIR = join(blocker, "sessions");
    try {
      const core = createMockCore({ enabled: true, keepRecentMessages: 2, reserveTokens: 100 });
      const cmd = await compactCmdFor(core);

      const strategyResult = await cmd.handler!(bigAgent(), "compact --compact-debug");
      expect((strategyResult as any).content).toContain("Debug dump failed");
      expect((strategyResult as any).content).not.toContain("Debug file written");

      const keepResult = await cmd.handler!(createMockAgent(makeMessages(6)), "compact 3 --compact-debug");
      expect((keepResult as any).content).not.toContain("Debug file written");
    } finally {
      process.env.HOTDOG_SESSIONS_DIR = TMP;
      rmSync(blocker, { force: true });
    }
  });
});

describe("compact summary stream reset", () => {
  it("drops the failed attempt's partial output when the stream resets", async () => {
    const llmClient = {
      chatStreamCancellable: () =>
        (async function* () {
          yield { type: "content", content: "PARTIAL " };
          yield { type: "reset" };
          yield { type: "content", content: "FINAL" };
        })(),
    };

    const core = createMockCore({ enabled: true, keepRecentMessages: 2, reserveTokens: 100 });
    const ext = createCompactionExtension(core)!;
    const commandRegistry = new AgentCommandRegistry();
    await (ext.hooks as any)![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const cmd = commandRegistry.get("compact")!;

    const agent = createMockAgent(makeMessages(100, "x".repeat(500)), "test-model", {
      "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    }, llmClient);

    const result = await cmd.handler!(agent, "compact");
    expect((result as any).content).toContain("compacted");

    const all = agent.log.getAll().map((m: any) => {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((p: any) => p?.text ?? "").join("");
      return "";
    }).join("\n");
    expect(all).toContain("FINAL");
    expect(all).not.toContain("PARTIAL");
  });
});

// ── Edge Cases ───────────────────────────────────────────────────────────────

describe("Edge Cases", () => {
  it("should handle empty messages array in hook", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const agent = createMockAgent([]);
    const messages: any[] = [];

    const result = await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // No compaction: no replacement returned.
    expect(result).toBeUndefined();
  });

  it("should handle messages with only system messages", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const agent = createMockAgent([]);
    const messages = [
      { role: "system", content: "System prompt 1" },
      { role: "system", content: "System prompt 2" },
    ];

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Should not crash, no compaction needed
    expect(agent.log.length).toBe(0);
  });

  it("should trigger compaction with very large reserveTokens", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 999999999,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(10, "x".repeat(100));
    const agent = createMockAgent(context, "test-model", {
      "test-model": { name: "test-model", temperature: null, contextLimit: 128000 },
    });
    const messages = [{ role: "system", content: "" }, ...context];

    // With huge reserve, effectiveMax = 128000 - 999999999 = very negative
    // estimatedTokens (250) > very_negative => compaction triggers
    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Compaction should have occurred (dropping or summarizing)
    // The exact result depends on the strategy, but log length should change
    expect(agent.log.length).not.toBe(10);
  });

  it("should handle context with mixed message types", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = [
      new Message({ role: "user", content: "x".repeat(500) }),
      new Message({ role: "assistant", content: "y".repeat(500), reasoningContent: "z".repeat(500) }),
      new Message({ role: "user", content: "a".repeat(500) }),
      new Message({ role: "assistant", content: "b".repeat(500), toolCalls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: '{"cmd": "ls"}' } }] }),
      new Message({ role: "tool", content: "result".repeat(200) }),
    ];
    const agent = createMockAgent(context);
    const messages = [{ role: "system", content: "" }, ...context];

    agent.modelRegistry = {
            "test-model": { name: "test-model", temperature: null, contextLimit: 2000 },
    };

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Should handle mixed message types without crashing or corrupting context
    expect(agent.log.length).toBe(5);
  });

  it("should handle abortSignal that is already aborted", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(50, "x".repeat(500));
    const abortController = new AbortController();
    abortController.abort(); // Already aborted

    // Like the real LlmClient, reject when the signal is already aborted
    // (the default mock stream ignores it, which would let compaction succeed).
    const failingLlmClient = {
      chatStreamCancellable: (_msgs: unknown, _cfg: unknown, _t: unknown, signal: AbortSignal) => {
        if (signal.aborted) throw new Error("aborted");
        return (async function* () {})();
      },
    };

    const agent = createMockAgent(context, "test-model", undefined, failingLlmClient);
    (agent as any).abortSignal = abortController.signal;

    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    const messages = [{ role: "system", content: "" }, ...context];

    // Should not throw: compaction failure is non-fatal and context stays intact
    await expect(
      (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent })
    ).resolves.toBeUndefined();
    expect(agent.log.length).toBe(50);
  });

  it("should not leak abort listeners on the agent's long-lived signal", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(50, "x".repeat(500));
    const abortController = new AbortController();
    const signal = abortController.signal;

    // Track every listener the compaction forwarder wires onto the signal.
    // The mock chatStreamCancellable is a plain async generator, so the only
    // add/remove on this signal comes from compaction's llmChat.
    let added = 0;
    let removed = 0;
    const origAdd = signal.addEventListener.bind(signal);
    const origRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean) => {
      if (type === "abort") added++;
      return origAdd(type, fn, opts);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: EventListenerOptions | boolean) => {
      if (type === "abort") removed++;
      return origRemove(type, fn, opts);
    }) as typeof signal.removeEventListener;

    const agent = createMockAgent(context);
    (agent as any).abortSignal = signal;
    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    const messages = [{ role: "system", content: "" }, ...context];

    // First run triggers compaction; second may or may not, either way
    // every listener attached must be detached (no accumulation).
    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });
    expect(added).toBeGreaterThan(0); // forwarder was actually attached
    expect(removed).toBe(added);

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: agent.buildMessages() as any, agent });
    expect(removed).toBe(added);
  });

  it("should remove the abort listener when the summarization call throws", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(50, "x".repeat(500));
    const abortController = new AbortController();
    const signal = abortController.signal;
    let added = 0;
    let removed = 0;
    const origAdd = signal.addEventListener.bind(signal);
    const origRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean) => {
      if (type === "abort") added++;
      return origAdd(type, fn, opts);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: EventListenerOptions | boolean) => {
      if (type === "abort") removed++;
      return origRemove(type, fn, opts);
    }) as typeof signal.removeEventListener;

    const mockLlmClient = {
      chatStreamCancellable: () =>
        (async function* () {
          throw new Error("LLM error during compaction");
        })(),
    };

    const agent = createMockAgent(context, "test-model", undefined, mockLlmClient);
    (agent as any).abortSignal = signal;
    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    const messages = [{ role: "system", content: "" }, ...context];

    await expect(
      (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent })
    ).resolves.toBeUndefined();
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });

  it("should handle cancellation during streaming (agent.cancelled)", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(50, "x".repeat(500));

    // Create an agent that is cancelled
    const mockLlmClient = {
      chatStreamCancellable: () =>
        (async function* () {
          // Simulate checking cancelled flag
          yield { type: "content", content: "partial" };
        })(),
    };
    const log = new MessageLog(context);
    const agent = {
      get log() { return log; },
      context: {
        getMessages: () => log.getAll(),
        replaceMessages: (msgs: any[]) => log.replace(msgs),
        getSystem: () => log.getSystem(),
        getNonSystem: () => log.getNonSystem(),
        getSystemPrompt: () => null,
      },
      model: "test-model",
      sessionId: "test-session",
      cancelled: true, // Agent is cancelled
      _llmClient: mockLlmClient,
      get llmClient() { return mockLlmClient; },
      buildMessages() {
        return [{ role: "system", content: "" }, ...log.getAll()];
      },
      addMessage(msg: any) { log.push(msg); },
      replaceContext(newContext: any) { log.replace(newContext); },
    } as any;

    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    const messages = [{ role: "system", content: "" }, ...context];

    // Should handle cancellation gracefully without throwing
    await expect(
      (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent })
    ).resolves.toBeUndefined();
    // Cancellation aborts the summarization, so context is left untouched
    expect(agent.log.length).toBe(context.length);
  });

  it("should handle compaction error gracefully", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
      strategy: "summarize",
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(50, "x".repeat(500));

    // Create an LLM client that throws
    const mockLlmClient = {
      chatStreamCancellable: () =>
        (async function* () {
          throw new Error("LLM error during compaction");
        })(),
    };
    const log = new MessageLog(context);
    const agent = {
      get log() { return log; },
      context: {
        getMessages: () => log.getAll(),
        replaceMessages: (msgs: any[]) => log.replace(msgs),
        getSystem: () => log.getSystem(),
        getNonSystem: () => log.getNonSystem(),
        getSystemPrompt: () => null,
      },
      model: "test-model",
      sessionId: "test-session",
      cancelled: false,
      _llmClient: mockLlmClient,
      get llmClient() { return mockLlmClient; },
      buildMessages() {
        return [{ role: "system", content: "" }, ...log.getAll()];
      },
      addMessage(msg: any) { log.push(msg); },
      replaceContext(newContext: any) { log.replace(newContext); },
    } as any;

    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    const messages = [{ role: "system", content: "" }, ...context];

    // Should handle error gracefully without throwing
    await expect(
      (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent })
    ).resolves.toBeUndefined();
    // Failed summarization must not corrupt the context
    expect(agent.log.length).toBe(context.length);
  });
});

// ── /compact Command Tests ───────────────────────────────────────────────────

describe("/compact Command", () => {
  it("handles /compact with keep=0 (slice(-0) keeps all)", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
    });
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(10, "x".repeat(100));
    const agent = createMockAgent(context);

    const result = await (compactCmd!.handler as any)(agent, "compact 0");

    // slice(-0) returns the full array, so all messages are kept
    expect((result as any).content).toContain("Context compacted");
    expect(agent.log.getNonSystem().length).toBeGreaterThanOrEqual(10);
  });

  it("handles /compact with nonexistent strategy (falls back to default)", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      strategy: "nonexistent-strategy",
    });
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(20, "x".repeat(100));
    const agent = createMockAgent(context, "test-model", {
      "test-model": { name: "test-model", temperature: null, contextLimit: 32000, tags: [] },
    });

    const result = await (compactCmd!.handler as any)(agent, "compact");

    // Falls back to default strategy (summarize)
    expect((result as any).content).toContain("Context compacted");
  });

  it("handles /compact when strategy.canCompact returns false", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 100, // Very high keepRecent, so canCompact will return false
      strategy: "drop",
    });
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(10, "x".repeat(100));
    const agent = createMockAgent(context);

    const result = await (compactCmd!.handler as any)(agent, "compact");

    expect((result as any).content).toContain("Compaction not applicable");
  });
});

// ── getModelConfig fallback lookup ──────────────────────────────────────────

describe("getModelConfig fallback lookup", () => {
  it("finds model config via provider/modelName fallback", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      strategy: "drop",
    });
    const registry = {
      "laguna/laguna": {
        name: "laguna/laguna",
        temperature: null,
        contextLimit: 350000,
        tags: [],
      },
    };

    const ext = createCompactionExtension(core);
    expect(ext).not.toBeNull();

    const commandRegistry = new AgentCommandRegistry();
    (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(20, "x".repeat(100));
    // Agent uses unprefixed model name (as happens when resolveModel can't find local entry)
    const agent = createMockAgent(context, "laguna", registry);

    const result = await compactCmd.handler!(agent, "compact");
    // Should succeed without error — means getModelConfig found the config
    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("compacts via the agent's contextLimit when the model is not in the registry", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      strategy: "drop",
    });
    const registry = {
      "other/model": {
        name: "other/model",
        temperature: null,
        contextLimit: 64000,
        tags: [],
      },
    };

    const ext = createCompactionExtension(core);
    const commandRegistry = new AgentCommandRegistry();
    (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(20, "x".repeat(100));
    // Agent uses a model name not in the registry; its contextLimit is the
    // fallback window (same resolution as the agent loop).
    const agent = createMockAgent(context, "unknown-model", registry);
    agent.contextLimit = 400;

    const result = await compactCmd.handler!(agent, "compact");
    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
    expect((result as any).content).toContain("Context compacted");
  });

  it("errors when the model is not in the registry and no contextLimit resolves", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      strategy: "drop",
    });
    const registry = {
      "other/model": {
        name: "other/model",
        temperature: null,
        contextLimit: 64000,
        tags: [],
      },
    };

    const ext = createCompactionExtension(core);
    const commandRegistry = new AgentCommandRegistry();
    (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(20, "x".repeat(100));
    // Agent uses a model name not in the registry, and has no contextLimit
    // either: the window cannot be resolved, so /compact fails loudly
    // (config error) instead of guessing.
    const agent = createMockAgent(context, "unknown-model", registry);

    await expect(compactCmd.handler!(agent, "compact")).rejects.toThrow("contextLimit");
  });

  it("prefers direct lookup over fallback when model name contains '/'", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      strategy: "drop",
    });
    const registry = {
      "provider/model-x": {
        name: "provider/model-x",
        temperature: null,
        contextLimit: 999999,
        tags: [],
      },
    };

    const ext = createCompactionExtension(core);
    const commandRegistry = new AgentCommandRegistry();
    (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(20, "x".repeat(100));
    // Agent uses prefixed model name — direct lookup should work
    const agent = createMockAgent(context, "provider/model-x", registry);

    const result = await compactCmd.handler!(agent, "compact");
    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
  });
});

// ── Completions ──────────────────────────────────────────────────────────────

describe("compaction completions", () => {
  const fakeAgent: any = {
    compactionRegistry: {
      getAll: () =>
        ["summarize", "drop", "summarize-short", "token-aware", "trim"].map(
          (name) => ({ name, description: "" }),
        ),
    },
  };

  const makeCtx = (command: string | undefined, commandArg = "", agent: any = fakeAgent) =>
    ({ line: "", cursorPos: 0, command, commandArg, agent }) as any;

  it("matcher matches space-form and colon-form compact commands", () => {
    expect(compactMatcher(makeCtx("compact"))).toBe(true);
    expect(compactMatcher(makeCtx("compact:sum"))).toBe(true);
    expect(compactMatcher(makeCtx("model"))).toBe(false);
    expect(compactMatcher(makeCtx(undefined))).toBe(false);
  });

  it("completes strategy names for space form using commandArg prefix", () => {
    const options = compactCompletion(makeCtx("compact", "su"));
    expect(options.map((o) => o.value)).toEqual(["summarize", "summarize-short"]);
  });

  it("completes strategy names for colon form using the typed suffix as prefix", () => {
    const options = compactCompletion(makeCtx("compact:sum"));
    expect(options.map((o) => o.value)).toEqual(["summarize", "summarize-short"]);
  });

  it("returns all strategies when no prefix typed", () => {
    const options = compactCompletion(makeCtx("compact:"));
    expect(options.map((o) => o.value)).toEqual([
      "summarize",
      "drop",
      "summarize-short",
      "token-aware",
      "trim",
    ]);
  });

  it("returns no options when agent has no compaction registry", () => {
    expect(compactCompletion(makeCtx("compact", "", {}))).toEqual([]);
  });
});

// ── Context-overflow rescue (provider:error) ────────────────────────────────

describe("Compaction Extension — context-overflow rescue", () => {
  function makeAgent(reserveTokens: number) {
    // 40 messages, ~25 tokens each (100 chars / 4): over a 1000-token window.
    const agent = createMockAgent(makeMessages(40), "test-model", {
      "test-model": { name: "test-model", temperature: null, contextLimit: 1000 },
    });
    agent.cancelled = false;
    return { agent, core: { ...createMockCore({ reserveTokens }), resolved: { contextLimit: 1000 } } };
  }

  const overflowError = () =>
    LlmError.Api(
      'HTTP 500 (body: {"error":"the request exceeds the available context size, try increasing it"})',
      500,
    );

  it("compacts and asks for the one retry on an overflow error", async () => {
    const { agent, core } = makeAgent(0);
    const ext = createCompactionExtension(core) as any;
    const systemMessages: string[] = [];
    agent.sink = { emit: (e: { type: number; content?: string }) => {
      if (e.type === 15 /* SYSTEM_MESSAGE */) systemMessages.push(e.content!);
    } };

    const params = { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] };
    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params,
      agent,
      retry: false,
    });

    expect(result).toEqual({ retry: true });
    expect(agent.log.getAll().length).toBeLessThan(40);
    // The retry carries the compacted context, not the captured oversized one.
    expect(params.messages).not.toHaveLength(40);
    expect(params.messages.length).toBe(agent.buildMessages().length);
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]).toContain("Context overflow");
  });

  it("does not fire for non-overflow errors", async () => {
    const { agent, core } = makeAgent(0);
    const ext = createCompactionExtension(core) as any;
    const params = { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] };

    const err = LlmError.Api("HTTP 500 (body: internal error)", 500);
    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]({ error: err, params, agent, retry: false });

    expect(result).toBeUndefined();
    expect(agent.log.getAll().length).toBe(40);
  });

  it("does not fire for a cancelled agent", async () => {
    const { agent, core } = makeAgent(0);
    agent.cancelled = true;
    const ext = createCompactionExtension(core) as any;
    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(result).toBeUndefined();
  });

  it("does not rewrite a young comfortably-fitting session (drop gate vs misclassification)", async () => {
    // A generic error body that merely QUOTES an overflow phrase (e.g. echoes
    // prompt text) still classifies as overflow; the drop fallback must not
    // silently destroy history from a session that is nowhere near compactable.
    const agent = createMockAgent(makeMessages(6, "short message"), "test-model", {
      "test-model": { name: "test-model", temperature: null, contextLimit: 32000 },
    });
    const core = {
      ...createMockCore({ reserveTokens: 0 }),
      resolved: { contextLimit: 32000 },
    };
    const ext = createCompactionExtension(core) as any;
    const params = { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] };

    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: LlmError.Api(
        'HTTP 400 (body: invalid request, echoed text: "this model\'s maximum context length is 32000")',
        400,
      ),
      params,
      agent,
      retry: false,
    });

    expect(result).toBeUndefined();
    expect(agent.log.getAll().length).toBe(6);
    expect(params.messages).toHaveLength(6);
  });
});
