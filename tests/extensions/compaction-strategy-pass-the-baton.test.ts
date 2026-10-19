// Tests for the PassTheBatonStrategy compaction strategy (and its wiring
// into the compaction extension: CONTEXT hook, provider:error rescue,
// baton stash).
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  PassTheBatonStrategy,
  hasBatonNotice,
} from "@extensions/compaction/strategies/pass-the-baton.ts";
import { CompactionSettings } from "@extensions/compaction/strategies.ts";
import { BATON_NOTICE_PROMPT } from "@extensions/compaction/prompts.ts";
import { Message } from "@core/context/message.ts";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import { LlmError } from "@core/error.ts";
import { MessageLog } from "@core/context/message-log.ts";
import { ToolRegistry } from "@core/extensions/tool-registry.ts";
import { create as createCompactionExtension } from "@extensions/compaction/index.ts";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

// ── Strategy-level helpers ───────────────────────────────────────────────────

// 400 chars => exactly 100 estimated tokens (chars/4).
const BULK = "x".repeat(400);

function msg(role: string, content = BULK): Message {
  return new Message({ role, content });
}

function assistantCalls(): Message {
  return new Message({
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "call_1", type: "function", function: { name: "t", arguments: "{}" } } as any,
    ],
  });
}

function toolMsg(content = BULK): Message {
  return new Message({ role: "tool", content, toolCallId: "call_1" });
}

function batonNoticeMessage(text = BATON_NOTICE_PROMPT): Message {
  return new Message({
    role: "harness",
    source: "harness",
    content: [{ type: "system-notice", text }],
  });
}

const noopLlmChat = async (
  _messages: Array<{ role: string; content: string }>,
  _model: string,
): Promise<string> => {
  throw new Error("pass-the-baton must never call the LLM");
};

// contextLimit 1000, reserveTokens 300 => maxKeepTokens 700 => exactly
// seven 100-token messages fit.
const settings: CompactionSettings = {
  enabled: true,
  reserveTokens: 300,
  keepRecentMessages: 2,
  contextLimit: 1000,
};

// ── Strategy ─────────────────────────────────────────────────────────────────

describe("PassTheBatonStrategy", () => {
  let strategy: PassTheBatonStrategy;

  beforeEach(() => {
    strategy = new PassTheBatonStrategy();
  });

  it("has correct name and description", () => {
    expect(strategy.name).toBe("pass-the-baton");
    expect(strategy.description).toContain("prefix");
    expect(strategy.description).toContain("handoff");
  });

  describe("canCompact", () => {
    it("throws without a resolvable contextLimit", () => {
      const messages = [msg("user"), msg("assistant")];
      const { contextLimit: _omit, ...noLimit } = settings;
      expect(() => strategy.canCompact(messages, noLimit)).toThrow("contextLimit");
    });

    it("returns false when the context fits under the budget", () => {
      // 5 x 100t = 500 <= 700
      const messages = Array.from({ length: 5 }, (_, i) => msg(i % 2 ? "assistant" : "user"));
      expect(strategy.canCompact(messages, settings)).toBe(false);
    });

    it("returns true when the context exceeds the budget", () => {
      // 10 x 100t = 1000 > 700
      const messages = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user"));
      expect(strategy.canCompact(messages, settings)).toBe(true);
    });

    it("returns false when a baton notice is already present (idempotency gate)", () => {
      const messages = [
        ...Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user")),
        batonNoticeMessage(),
      ];
      expect(strategy.canCompact(messages, settings)).toBe(false);
    });

    it("detects a custom-configured notice text too", () => {
      const custom = "Custom wrap-up text.";
      const messages = [
        ...Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user")),
        batonNoticeMessage(custom),
      ];
      expect(
        strategy.canCompact(messages, { ...settings, batonNoticePrompt: custom }),
      ).toBe(false);
      // A notice carrying DIFFERENT text does not suppress compaction.
      expect(strategy.canCompact(messages, settings)).toBe(true);
    });

    it("counts system messages (they occupy the kept prefix)", () => {
      // 7 x 100t = 700 == budget (not over), adding one system message tips it.
      const fitting = Array.from({ length: 7 }, (_, i) => msg(i % 2 ? "assistant" : "user"));
      expect(strategy.canCompact(fitting, settings)).toBe(false);
      expect(
        strategy.canCompact([msg("system", "x".repeat(4)), ...fitting], settings),
      ).toBe(true);
    });
  });

  describe("hasBatonNotice", () => {
    it("ignores user text merely repeating the notice", () => {
      const messages = [new Message({ role: "user", content: BATON_NOTICE_PROMPT })];
      expect(hasBatonNotice(messages, BATON_NOTICE_PROMPT)).toBe(false);
    });

    it("ignores a harness-role message with a different part type", () => {
      const messages = [
        new Message({ role: "harness", source: "harness", content: BATON_NOTICE_PROMPT }),
      ];
      // String content equal to the notice DOES count (same producer shape).
      expect(hasBatonNotice(messages, BATON_NOTICE_PROMPT)).toBe(true);
    });

    it("requires harness provenance", () => {
      const smuggled = new Message({
        role: "harness",
        source: "user",
        content: [{ type: "system-notice", text: BATON_NOTICE_PROMPT }],
      } as any);
      expect(hasBatonNotice([smuggled], BATON_NOTICE_PROMPT)).toBe(false);
    });
  });

  describe("execute", () => {
    it("returns null for an empty message list", async () => {
      expect(await strategy.execute([], settings, noopLlmChat, "m")).toBeNull();
    });

    it("returns null when everything already fits", async () => {
      const messages = Array.from({ length: 5 }, (_, i) => msg(i % 2 ? "assistant" : "user"));
      expect(await strategy.execute(messages, settings, noopLlmChat, "m")).toBeNull();
    });

    it("returns null when a notice is already present (no repeated pops)", async () => {
      const messages = [
        ...Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user")),
        batonNoticeMessage(),
      ];
      expect(await strategy.execute(messages, settings, noopLlmChat, "m")).toBeNull();
    });

    it("pops the NEWEST messages, keeping the oldest fitting prefix", async () => {
      // 10 x 100t, budget 700 => keep 7, pop 3.
      const messages = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user"));

      const result = await strategy.execute(messages, settings, noopLlmChat, "m");

      expect(result).not.toBeNull();
      expect(result!.keepFrom).toBe("tail");
      expect(result!.summary).toBeNull();
      expect(result!.messagesCompacted).toBe(3);
      // The kept window (messages[0..6]) must be the SAME objects: a strict
      // byte-prefix of the previous prompt is the whole cache premise.
      const kept = messages.slice(0, messages.length - result!.messagesCompacted);
      kept.forEach((m, i) => expect(m).toBe(messages[i]!));
    });

    it("appends the baton notice (default and custom text)", async () => {
      const messages = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user"));

      const r1 = await strategy.execute(messages, settings, noopLlmChat, "m");
      expect(r1!.appendNotice).toBe(BATON_NOTICE_PROMPT);

      const r2 = await strategy.execute(
        messages,
        { ...settings, batonNoticePrompt: "Wrap it up." },
        noopLlmChat,
        "m",
      );
      expect(r2!.appendNotice).toBe("Wrap it up.");
    });

    it("never calls the LLM", async () => {
      const messages = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user"));
      // noopLlmChat throws if called; a resolved result proves it did not.
      const result = await strategy.execute(messages, settings, noopLlmChat, "m");
      expect(result).not.toBeNull();
    });

    it("backs the boundary off a dangling assistant tool_calls turn", async () => {
      // budget 550: five user turns (500t) + assistant-with-tool_calls (1t)
      // fit, the following tool result does not. The assistant's results all
      // fall in the popped tail, so the assistant must be popped too.
      const messages = [
        msg("user"), msg("assistant"), msg("user"), msg("assistant"), msg("user"), // 500t
        assistantCalls(),                                                            //   1t
        toolMsg(),                                                                   // 100t (does not fit)
        msg("user"),
      ];
      const s = { ...settings, reserveTokens: 450 }; // maxKeep 550

      const result = await strategy.execute(messages, s, noopLlmChat, "m");

      expect(result).not.toBeNull();
      expect(result!.messagesCompacted).toBe(3); // pops assistant + tool + user
    });

    it("backs the boundary off a boundary tool result (conservative exchange completeness)", async () => {
      // budget 650: the tool result FITS, but sitting at the window edge it
      // may hold only part of its parent's results — pop it and the parent.
      const messages = [
        msg("user"), msg("assistant"), msg("user"), msg("assistant"), msg("user"), // 500t
        assistantCalls(),                                                            //   1t
        toolMsg(),                                                                   // 100t (fits: 601 <= 650)
        msg("user"),                                                                 // 701 > 650 stop
      ];
      const s = { ...settings, reserveTokens: 350 }; // maxKeep 650

      const result = await strategy.execute(messages, s, noopLlmChat, "m");

      expect(result).not.toBeNull();
      expect(result!.messagesCompacted).toBe(3);
    });

    it("returns null when the rewind would empty the window entirely", async () => {
      const messages = [assistantCalls(), msg("user")];
      const s = { ...settings, reserveTokens: 999 }; // maxKeep 1t
      expect(await strategy.execute(messages, s, noopLlmChat, "m")).toBeNull();
    });

    it("reports accurate metadata", async () => {
      const messages = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user"));

      const result = await strategy.execute(messages, settings, noopLlmChat, "m");

      expect(result!.metadata!.strategyName).toBe("pass-the-baton");
      expect(result!.metadata!.tokensBefore).toBe(1000);
      expect(result!.metadata!.tokensAfter).toBe(700);
      expect(result!.metadata!.poppedCount).toBe(result!.messagesCompacted);
      expect(result!.metadata!.maxKeepTokens).toBe(700);
    });
  });
});

// ── Extension wiring ─────────────────────────────────────────────────────────

const TMP = mkdtempSync(join(os.tmpdir(), "hotdog-baton-test-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.HOTDOG_SESSIONS_DIR;
});

function makeMessages(count: number, content = BULK): Message[] {
  return Array.from({ length: count }, (_, i) =>
    new Message({ role: i % 2 === 0 ? "user" : "assistant", content }),
  );
}

function createMockCore(config: Record<string, unknown> = {}) {
  return {
    hooks: new HookSystem(),
    config: {
      compaction: {
        enabled: true,
        reserveTokens: 300,
        keepRecentMessages: 2,
        strategy: "pass-the-baton",
        userTurnGuardPrompt: "Continue from the compressed conversation context above.",
        batonNoticePrompt: BATON_NOTICE_PROMPT,
        ...config,
      },
    },
    modelRegistry: {
      "test-model": { name: "test-model", temperature: null, contextLimit: 1000 },
    },
    toolRegistry: new ToolRegistry(),
    resolved: { contextLimit: 1000 },
  } as any;
}

function createMockAgent(contextArray: Message[], llmClient?: Record<string, unknown>) {
  const log = new MessageLog(contextArray);
  const client = llmClient ?? {
    chatStreamCancellable: () => {
      throw new Error("pass-the-baton must never call the LLM");
    },
  };
  return {
    get log() { return log; },
    get context() {
      return {
        getMessages: () => log.getAll(),
        getSystem: () => log.getSystem(),
        getNonSystem: () => log.getNonSystem(),
      };
    },
    model: "test-model",
    modelRegistry: { "test-model": { name: "test-model", temperature: null, contextLimit: 1000 } },
    sessionId: "baton-test-session",
    cancelled: false,
    clearedCount: 0,
    get llmClient() { return client; },
    buildMessages() { return [...log.getAll()]; },
    replaceContext(newContext: Message[]) { log.replace(newContext); },
    async clearContext() {
      this.clearedCount++;
      log.replace([]);
    },
    async ensureSystemPrompt() {},
    // The continuation seam: a real host wires this when the agent is
    // attached to a draining bus (session/index.ts). Path B checks for it
    // before clearing context; the mock's enqueue plays the bus side.
    enqueueCallback: (_content: unknown, _opts?: unknown) => {},
    enqueue(content: string, opts?: { source?: string }) {
      log.push(new Message({ role: "user", content, source: (opts?.source as any) ?? "user" }));
    },
  } as any;
}

function isBatonNotice(m: Message): boolean {
  if (m.role !== "harness" || m.source !== "harness") return false;
  const content = m.content;
  if (typeof content === "string") return content === BATON_NOTICE_PROMPT;
  return (
    Array.isArray(content) &&
    content.some(
      (p: any) => p?.type === "system-notice" && p?.text === BATON_NOTICE_PROMPT,
    )
  );
}

describe("Compaction Extension — pass-the-baton wiring", () => {
  it("registers the strategy and lists it", () => {
    const ext = createCompactionExtension(createMockCore()) as any;
    expect(ext.registry.has("pass-the-baton")).toBe(true);
    const names = ext.getStrategyList().map((s: { name: string }) => s.name);
    expect(names).toContain("pass-the-baton");
  });

  it("CONTEXT hook: pops the tail, preserves the prefix byte-identical, ends with the notice", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "ctx");
    const original = makeMessages(10); // 10 x 100t > 700 budget
    const agent = createMockAgent(original);
    const ext = createCompactionExtension(createMockCore()) as any;

    const result = await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });

    const after = agent.log.getAll();
    // 7 kept + 1 notice.
    expect(after).toHaveLength(8);
    // The kept window is the ORIGINAL objects — nothing rewritten, the
    // prefix cache on the runner still matches.
    for (let i = 0; i < 7; i++) expect(after[i]).toBe(original[i]);
    expect(isBatonNotice(after[7]!)).toBe(true);
    // No user-turn guard after a harness notice.
    expect(after.filter(isBatonNotice)).toHaveLength(1);
    // The hook hands the rebuilt context back to the loop.
    expect(result).toBeDefined();
    expect(result.messages).toHaveLength(8);
  });

  it("CONTEXT hook is idempotent: the wrap-up turns do not shave more tail", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "idem");
    const agent = createMockAgent(makeMessages(10));
    const ext = createCompactionExtension(createMockCore()) as any;

    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    const snapshot = agent.log.getAll();
    // Context is STILL over budget (700t + notice) — the guard must catch it.
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });

    const after = agent.log.getAll();
    expect(after).toHaveLength(snapshot.length);
    expect(after.filter(isBatonNotice)).toHaveLength(1);
  });

  it("stash: popped tail is persisted to <session-id>.baton.json for the fresh session", async () => {
    const dir = join(TMP, "stash");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const agent = createMockAgent(makeMessages(10));
    const ext = createCompactionExtension(createMockCore()) as any;

    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });

    const file = join(dir, "baton-test-session.baton.json");
    expect(existsSync(file)).toBe(true);
    const stashed = JSON.parse(readFileSync(file, "utf8"));
    expect(stashed.session_id).toBe("baton-test-session");
    expect(stashed.messages).toHaveLength(3);
    // The popped messages are the NEWEST ones, in original order.
    expect(stashed.messages[2].content).toBe(BULK);
    expect(stashed.messages[0].role).toBe("assistant");
  });

  it("stash: concurrent sessions pop to separate files without clobbering", async () => {
    const dir = join(TMP, "stash-isolation");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const ext = createCompactionExtension(createMockCore()) as any;
    const a = createMockAgent(makeMessages(10));
    a.sessionId = "session-alpha";
    const b = createMockAgent(makeMessages(10));
    b.sessionId = "session-beta";

    await ext.hooks[HOOKS.CONTEXT]!({ messages: a.context.getMessages(), agent: a });
    await ext.hooks[HOOKS.CONTEXT]!({ messages: b.context.getMessages(), agent: b });

    // One file per session; each carries its own stash.
    const alpha = JSON.parse(readFileSync(join(dir, "session-alpha.baton.json"), "utf8"));
    const beta = JSON.parse(readFileSync(join(dir, "session-beta.baton.json"), "utf8"));
    expect(alpha.session_id).toBe("session-alpha");
    expect(beta.session_id).toBe("session-beta");
    expect(alpha.messages).toHaveLength(3);
    expect(beta.messages).toHaveLength(3);
  });

  it("stash: a crafted session id skips the file mirror, replay still works in-process", async () => {
    const dir = join(TMP, "stash-unsafe");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const ext = createCompactionExtension(createMockCore()) as any;
    const agent = createMockAgent(makeMessages(10));
    // Same shape a hostile resume payload could carry: join() would place
    // the file OUTSIDE the sessions dir. The id guard must refuse the mirror.
    agent.sessionId = "../escape";

    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });

    expect(existsSync(join(dir, "../escape.baton.json"))).toBe(false);
    expect(existsSync(join(TMP, "escape.baton.json"))).toBe(false);
    // Nothing landed in the sessions dir either (the mirror never opened it).
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);

    // The live map is unaffected: path B handoff still replays the tail.
    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "Handoff summary.",
      claimTurn: () => true,
      agent,
    });
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    expect(agent.log.getAll()).toHaveLength(4); // plan + 3 popped
  });

  it("provider:error rescue prefers pass-the-baton over trim/drop (cache-safe rescue)", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "rescue");
    // 40 x 26t = 1040 > 1000: over a 1000-token window with reserve 0.
    const agent = createMockAgent(makeMessages(40, "x".repeat(104)));
    const ext = createCompactionExtension(createMockCore({ reserveTokens: 0 })) as any;
    const systemMessages: string[] = [];
    agent.sink = {
      emit: (e: { type: number; content?: string }) => {
        if (e.type === 15 /* SYSTEM_MESSAGE */) systemMessages.push(e.content!);
      },
    };

    const params: any = { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] };
    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]!({
      error: LlmError.Api(
        'HTTP 500 (body: {"error":"the request exceeds the available context size, try increasing it"})',
        500,
      ),
      params,
      agent,
      retry: false,
    });

    expect(result).toEqual({ retry: true });
    // Rescue was LLM-free (the client would have thrown) and ended on the notice.
    const after = agent.log.getAll();
    expect(after.length).toBeLessThan(40);
    expect(isBatonNotice(after[after.length - 1]!)).toBe(true);
    expect(params.messages.length).toBe(after.length);
    expect(systemMessages).toHaveLength(1);
  });

  it("provider:error rescue falls through to trim when a baton notice already fired", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "rescue2");
    // Over budget AND already carrying a notice: baton declines, trim takes it.
    const messages = [...makeMessages(10), batonNoticeMessage()];
    const agent = createMockAgent(messages);
    const ext = createCompactionExtension(createMockCore()) as any;
    agent.sink = { emit: () => {} };

    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]!({
      error: LlmError.Api("HTTP 500 (body: exceeds the available context size)", 500),
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });

    expect(result).toEqual({ retry: true });
    // trim cut from the FRONT: the oldest user message is gone, no new notice.
    const after = agent.log.getAll();
    expect(after.filter(isBatonNotice)).toHaveLength(1);
    expect(after.length).toBeLessThan(11);
  });
});

// ── Baton replay lifecycle (handoff detection → fresh-context replay) ───────

describe("Compaction Extension — baton replay lifecycle", () => {
  /** Fire the CONTEXT hook until the baton pops (returns the originals). */
  async function fireBaton(ext: any, agent: any, original: Message[]) {
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    // 7 kept + 1 notice for the 10 x 100t context on a 700-token budget.
    expect(agent.log.getAll()).toHaveLength(8);
    return original;
  }

  it("path B: narrated final summary with stop is treated as the handoff", async () => {
    const dir = join(TMP, "replayB");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const original = makeMessages(10);
    const agent = createMockAgent(original);
    const ext = createCompactionExtension(createMockCore()) as any;
    await fireBaton(ext, agent, original);

    // The model writes its handoff as the final message and stops.
    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "Handoff: task X done through step 2, next is step 3.",
      claimTurn: () => true,
      agent,
    });

    // Context cleared once, summary restarted the session as the plan.
    expect(agent.clearedCount).toBe(1);
    const mid = agent.log.getAll();
    expect(mid).toHaveLength(1);
    expect(String(mid[0]!.content)).toContain("# Baton handoff");
    expect(String(mid[0]!.content)).toContain("Handoff: task X done through step 2");

    // First LLM call of the fresh session: tail replayed after the plan.
    const ctxResult = await ext.hooks[HOOKS.CONTEXT]!({
      messages: agent.context.getMessages(),
      agent,
    });
    const after = agent.log.getAll();
    expect(after).toHaveLength(4); // plan + 3 popped
    expect(after[0]).toBe(mid[0]); // plan stays first
    // The popped tail is the ORIGINAL objects, verbatim, in order.
    expect(after[1]).toBe(original[7]);
    expect(after[2]).toBe(original[8]);
    expect(after[3]).toBe(original[9]);
    expect(ctxResult.messages).toHaveLength(4);

    // Stash file consumed alongside the live map.
    expect(existsSync(join(dir, "baton-test-session.baton.json"))).toBe(false);
  });

  it("path A: a handoff tool call replays the tail onto the plan it left behind", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "replayA");
    const original = makeMessages(10);
    const agent = createMockAgent(original);
    const ext = createCompactionExtension(createMockCore()) as any;
    await fireBaton(ext, agent, original);

    // Simulate the handoff-tool extension (it ran at higher TURN_END
    // priority): it cleared the context and enqueued its own plan.
    await agent.clearContext();
    agent.enqueue("## Plan\nhandoff-tool plan", { source: "model" });

    await ext.hooks[HOOKS.TURN_END]!({
      reason: "tool_return",
      cancelled: false,
      stopped: true,
      toolResults: [{ toolName: "handoff" }],
      claimTurn: () => true,
      agent,
    });

    // Compaction must NOT clear again — the handoff extension owns that.
    expect(agent.clearedCount).toBe(1);
    expect(agent.log.getAll()).toHaveLength(1);

    const ctxResult = await ext.hooks[HOOKS.CONTEXT]!({
      messages: agent.context.getMessages(),
      agent,
    });
    const after = agent.log.getAll();
    expect(after).toHaveLength(4);
    expect(String(after[0]!.content)).toContain("handoff-tool plan");
    expect(after[1]).toBe(original[7]);
    expect(after[2]).toBe(original[8]);
    expect(after[3]).toBe(original[9]);
    expect(ctxResult.messages).toHaveLength(4);
  });

  it("cancelled endings drop the baton (no hijack of the next turn)", async () => {
    const dir = join(TMP, "replayC");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const agent = createMockAgent(makeMessages(10));
    const ext = createCompactionExtension(createMockCore()) as any;
    await fireBaton(ext, agent, agent.log.getAll());
    expect(existsSync(join(dir, "baton-test-session.baton.json"))).toBe(true);

    await ext.hooks[HOOKS.TURN_END]!({
      reason: "cancelled",
      cancelled: true,
      stopped: true,
      toolResults: [],
      claimTurn: () => true,
      agent,
    });
    expect(agent.clearedCount).toBe(0);
    // Dropped for good: the mirror file goes with the live entry.
    expect(existsSync(join(dir, "baton-test-session.baton.json"))).toBe(false);

    // A later completion must not handoff off a dead baton.
    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "unrelated",
      claimTurn: () => true,
      agent,
    });
    expect(agent.clearedCount).toBe(0);
    expect(agent.log.getAll()).toHaveLength(8); // untouched: 7 kept + notice
  });

  it("completion with the notice gone (context rewritten) drops the baton", async () => {
    const dir = join(TMP, "replayD");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const agent = createMockAgent(makeMessages(10));
    const ext = createCompactionExtension(createMockCore()) as any;
    await fireBaton(ext, agent, agent.log.getAll());

    // Something else rewrote the context (rewind, manual /compact keep...).
    agent.log.replace([new Message({ role: "user", content: "fresh start" })]);

    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "unrelated completion",
      claimTurn: () => true,
      agent,
    });
    expect(agent.clearedCount).toBe(0);
    expect(agent.log.getAll()).toHaveLength(1);
    // Dead stash file unlinked, not left behind in the sessions dir.
    expect(existsSync(join(dir, "baton-test-session.baton.json"))).toBe(false);

    // And no replay lingers: the next CONTEXT leaves the context alone.
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    expect(agent.log.getAll()).toHaveLength(1);
  });

  it("a failed turn claim defers: the handoff retries on the next completion", async () => {
    const dir = join(TMP, "replayE");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const agent = createMockAgent(makeMessages(10));
    const ext = createCompactionExtension(createMockCore()) as any;
    await fireBaton(ext, agent, agent.log.getAll());

    // Another handler owns this turn's continuation.
    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "ignored",
      claimTurn: () => false,
      agent,
    });
    expect(agent.clearedCount).toBe(0);
    expect(agent.log.getAll()).toHaveLength(8);
    // Deferred, not dropped: the stash file must survive for the retry.
    expect(existsSync(join(dir, "baton-test-session.baton.json"))).toBe(true);

    // Next completion: the baton is still pending and takes it.
    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "retry summary",
      claimTurn: () => true,
      agent,
    });
    expect(agent.clearedCount).toBe(1);
    expect(String(agent.log.getAll()[0]!.content)).toContain("retry summary");
  });

  it("a failed handoff call (context not cleared) does not arm the replay", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "replayG");
    const agent = createMockAgent(makeMessages(10));
    const ext = createCompactionExtension(createMockCore()) as any;
    await fireBaton(ext, agent, agent.log.getAll());

    // The model calls handoff with invalid input: the tool returns
    // ToolResult.err and the handoff extension never clears the context,
    // but toolResults still carries a "handoff" entry. Our notice is still
    // in the context — replaying the tail into that live, over-budget
    // session would undo the pop.
    await ext.hooks[HOOKS.TURN_END]!({
      reason: "tool_return",
      cancelled: false,
      stopped: true,
      toolResults: [{ toolName: "handoff", content: "Handoff requires a non-empty 'content' field" }],
      claimTurn: () => true,
      agent,
    });
    expect(agent.clearedCount).toBe(0);
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    expect(agent.log.getAll()).toHaveLength(8); // no tail re-appended

    // The stash survived: a narrated wrap-up on a later completion still
    // takes the baton (path B).
    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "Wrapped up; next step is 3.",
      claimTurn: () => true,
      agent,
    });
    expect(agent.clearedCount).toBe(1);
    expect(String(agent.log.getAll()[0]!.content)).toContain("Wrapped up; next step is 3.");
  });

  it("a worker agent without the continuation seam drops the baton (path B)", async () => {
    const dir = join(TMP, "replayH");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const agent = createMockAgent(makeMessages(10));
    // Factory-built task/subagent workers never get an enqueueCallback:
    // enqueue() is a silent no-op there, so clearing would leave the
    // worker with nothing but the system prompt.
    delete agent.enqueueCallback;
    const ext = createCompactionExtension(createMockCore()) as any;
    await fireBaton(ext, agent, agent.log.getAll());

    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "Worker wrap-up summary.",
      claimTurn: () => true,
      agent,
    });
    expect(agent.clearedCount).toBe(0);
    expect(agent.log.getAll()).toHaveLength(8);
    // Final drop: no stash file left behind for a worker that can never replay.
    expect(existsSync(join(dir, "baton-test-session.baton.json"))).toBe(false);

    // The drop is final: a later completion does not revisit it.
    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "again",
      claimTurn: () => true,
      agent,
    });
    expect(agent.clearedCount).toBe(0);
  });

  it("a failed handoff (clearContext throws) drops the baton and unlinks its file", async () => {
    const dir = join(TMP, "replayI");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const agent = createMockAgent(makeMessages(10));
    const ext = createCompactionExtension(createMockCore()) as any;
    await fireBaton(ext, agent, agent.log.getAll());
    expect(existsSync(join(dir, "baton-test-session.baton.json"))).toBe(true);

    agent.clearContext = async () => {
      throw new Error("boom");
    };

    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "summary",
      claimTurn: () => true,
      agent,
    });
    expect(existsSync(join(dir, "baton-test-session.baton.json"))).toBe(false);

    // No replay lingers: the next CONTEXT leaves the context alone.
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    expect(agent.log.getAll()).toHaveLength(8);
  });

  it("turn ends without a baton (plain completion) never touch the session", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "replayF");
    const agent = createMockAgent(makeMessages(4, "short"));
    const ext = createCompactionExtension(createMockCore()) as any;

    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "just an ordinary answer",
      claimTurn: () => true,
      agent,
    });
    expect(agent.clearedCount).toBe(0);
    expect(agent.log.getAll()).toHaveLength(4);
  });
});

// ── Default-text drift guard ─────────────────────────────────────────────────

describe("baton notice prompt default", () => {
  // The extension.json schema default is what real sessions see (the
  // resolver merges it into settings); BATON_NOTICE_PROMPT is the code-side
  // fallback. hasBatonNotice compares by exact text, so a silent drift
  // between the two would break the idempotency gate for every session
  // relying on the default. Keep them pinned together.
  it("extension.json default matches BATON_NOTICE_PROMPT verbatim", () => {
    const extJson = JSON.parse(
      readFileSync(join(import.meta.dir, "../../src/extensions/compaction/extension.json"), "utf8"),
    );
    expect(extJson.configSchema.compaction.properties.batonNoticePrompt.default).toBe(
      BATON_NOTICE_PROMPT,
    );
  });
});
