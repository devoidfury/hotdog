// Tests for the PassTheBatonStrategy compaction strategy (and its wiring
// into the compaction extension: CONTEXT hook, provider:error rescue,
// baton stash/replay).
//
// The flow these pin (rewritten 2026-11-15 after the victim-session
// postmortem, session 356fd25b):
//   auto-trigger  -> NOTICE ONLY, nothing popped (narrate before clear)
//   ignored notice, still over budget -> DEGRADE POP (clean-exchange cut)
//   provider overflow -> POP IMMEDIATELY (batonPopNow)
//   handoff (TURN_END) -> stash the recent window BEFORE the clear, the
//     fresh session replans and the CONTEXT hook replays the stash verbatim.
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  PassTheBatonStrategy,
  hasBatonNotice,
  recentWindow,
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
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";

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

/**
 * A workflow-worker transcript: user task first, then ONLY assistant turns
 * with tool_calls and tool results -- no plain-text exchange anywhere. This
 * is the shape that made the old per-message popback descend to keepCount=1
 * and pop ~100% of the session while reporting success.
 */
function toolOnlySession(pairs: number): Message[] {
  const messages = [msg("user")];
  for (let i = 0; i < pairs; i++) {
    messages.push(assistantCalls(), toolMsg());
  }
  return messages;
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

// The pop directive the PROVIDER_ERROR rescue and the manual /compact
// command inject at runtime (never a config key): pop immediately even
// without a notice in context.
const popSettings: CompactionSettings = { ...settings, batonPopNow: true };

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

    it("does NOT lock out when a baton notice is present (R4: degrade must stay possible)", () => {
      // The notice's presence flips the strategy from notice-only to
      // degrade-pop; it never disables compaction. A session that grew
      // back over budget with the notice still in it MUST be able to pop.
      const messages = [
        ...Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user")),
        batonNoticeMessage(),
      ];
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

    it("matches a harness message with string content equal to the notice", () => {
      const messages = [
        new Message({ role: "harness", source: "harness", content: BATON_NOTICE_PROMPT }),
      ];
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

  describe("execute: notice-first (auto trigger, nothing popped)", () => {
    it("appends the notice and pops NOTHING on a tool-only session", async () => {
      // The victim shape: worker transcript, every assistant turn tool_calls.
      // The old flow popped ~100% here; the new flow only appends the
      // notice -- the narrating model keeps every recent turn in view.
      const messages = toolOnlySession(12); // 25 msgs, well over the 700 budget
      const result = await strategy.execute(messages, settings, noopLlmChat, "m");

      expect(result).not.toBeNull();
      expect(result!.messagesCompacted).toBe(0);
      expect(result!.keepFrom).toBe("tail");
      expect(result!.appendNotice).toBe(BATON_NOTICE_PROMPT);
      expect(result!.metadata!.poppedCount).toBe(0);
      expect(result!.metadata!.noticeOnly).toBe(true);
      expect(result!.metadata!.tokensAfter).toBe(result!.metadata!.tokensBefore);
    });

    it("stashes the current recent window with the notice-only result", async () => {
      const messages = toolOnlySession(12);
      const result = await strategy.execute(messages, settings, noopLlmChat, "m");

      const stash = result!.batonStash!;
      expect(stash.length).toBeGreaterThan(0);
      expect(stash.length).toBeLessThan(messages.length);
      // The stash ENDS on the newest messages of the session.
      expect(stash[stash.length - 1]).toBe(messages[messages.length - 1]);
      // It never starts on an orphaned tool result.
      expect(stash[0]!.role).not.toBe("tool");
      // And it fits the keep budget.
      let tokens = 0;
      for (const m of stash) tokens += Math.ceil(JSON.stringify(m.content ?? "").length / 4) + 1;
      expect(tokens).toBeLessThanOrEqual(700);
    });

    it("supports custom notice text", async () => {
      const messages = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user"));
      const r = await strategy.execute(
        messages,
        { ...settings, batonNoticePrompt: "Wrap it up." },
        noopLlmChat,
        "m",
      );
      expect(r!.appendNotice).toBe("Wrap it up.");
      expect(r!.messagesCompacted).toBe(0);
    });

    it("never calls the LLM", async () => {
      const messages = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user"));
      // noopLlmChat throws if called; a resolved result proves it did not.
      const result = await strategy.execute(messages, settings, noopLlmChat, "m");
      expect(result).not.toBeNull();
    });

    it("returns null for an empty message list", async () => {
      expect(await strategy.execute([], settings, noopLlmChat, "m")).toBeNull();
    });

    it("returns null when everything already fits", async () => {
      const messages = Array.from({ length: 5 }, (_, i) => msg(i % 2 ? "assistant" : "user"));
      expect(await strategy.execute(messages, settings, noopLlmChat, "m")).toBeNull();
    });
  });

  describe("execute: pop path (degrade with a notice, rescue with batonPopNow)", () => {
    it("R1: returns NULL for a tool-only session -- no clean exchange boundary exists", async () => {
      // The exact victim shape. The naive cut lands inside the tool run,
      // and NO rewind target exists (no assistant turn without tool_calls
      // anywhere). Returning a 1-message kept window (or popping ~100%)
      // is forbidden: null lets the rescue chain degrade onward to
      // trim/drop instead.
      const messages = toolOnlySession(12);
      expect(await strategy.execute(messages, popSettings, noopLlmChat, "m")).toBeNull();

      // Same answer with the notice present (degrade mode).
      expect(
        await strategy.execute(
          [...messages, batonNoticeMessage()],
          settings,
          noopLlmChat,
          "m",
        ),
      ).toBeNull();
    });

    it("pops the NEWEST messages, keeping the oldest fitting prefix", async () => {
      // 10 x 100t, budget 700 => keep 7, pop 3.
      const messages = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user"));

      const result = await strategy.execute(messages, popSettings, noopLlmChat, "m");

      expect(result).not.toBeNull();
      expect(result!.keepFrom).toBe("tail");
      expect(result!.summary).toBeNull();
      expect(result!.messagesCompacted).toBe(3);
      // The kept window (messages[0..6]) must be the SAME objects: a strict
      // byte-prefix of the previous prompt is the whole cache premise.
      const kept = messages.slice(0, messages.length - result!.messagesCompacted);
      kept.forEach((m, i) => expect(m).toBe(messages[i]!));
    });

    it("rewinds the cut to the last window-closing boundary, never one message at a time", async () => {
      // budget 550: five exchanges (500t) fit, the assistant-with-tool_calls
      // (1t) fits too but its results fall in the tail -- a dangling
      // parent. The old loop popped back over tool turns ONE BY ONE, which
      // on a tool-only transcript descended past everything; the new rule
      // jumps to the last message that closes the window (the user turn at
      // index 4) and drops the whole open tool run with it.
      const messages = [
        msg("user"), msg("assistant"), msg("user"), msg("assistant"), msg("user"), // 500t
        assistantCalls(),                                                            //   1t
        toolMsg(),                                                                   // 100t (does not fit)
        msg("user"),
      ];
      const s = { ...popSettings, reserveTokens: 450 }; // maxKeep 550

      const result = await strategy.execute(messages, s, noopLlmChat, "m");

      expect(result).not.toBeNull();
      expect(result!.messagesCompacted).toBe(3); // pops asst(tool_calls) + tool + user
      // Kept window (0..4) ends on a window-closing message; no dangling
      // tool_calls survives inside it.
      const kept = messages.slice(0, messages.length - 3);
      expect(kept.some((m) => (m as any).toolCalls?.length)).toBe(false);
    });

    it("rewinds past a boundary tool result to the last clean boundary", async () => {
      // budget 650: the tool result FITS, but sitting at the window edge it
      // may hold only part of its parent's results -- the run and its
      // parent go, the cut lands back on the user turn at index 4.
      const messages = [
        msg("user"), msg("assistant"), msg("user"), msg("assistant"), msg("user"), // 500t
        assistantCalls(),                                                            //   1t
        toolMsg(),                                                                   // 100t (fits: 601 <= 650)
        msg("user"),                                                                 // 701 > 650 stop
      ];
      const s = { ...popSettings, reserveTokens: 350 }; // maxKeep 650

      const result = await strategy.execute(messages, s, noopLlmChat, "m");

      expect(result).not.toBeNull();
      expect(result!.messagesCompacted).toBe(3);
    });

    it("returns null when the kept prefix would hold no assistant turn (system + task only)", async () => {
      // The victim's "success": kept = [system prompt, task message] and a
      // popped-everything stash. With the clean-exchange rewind this prefix
      // has no closed exchange in it -- it must NOT be returned as a
      // successful compaction.
      const messages = [msg("system", "x".repeat(40)), msg("user"), ...toolOnlySession(8).slice(1)];
      expect(await strategy.execute(messages, popSettings, noopLlmChat, "m")).toBeNull();
    });

    it("returns null when the rewind would leave a single message", async () => {
      const messages = [msg("user"), assistantCalls(), toolMsg(), assistantCalls(), toolMsg()];
      const s = { ...popSettings, reserveTokens: 850 }; // maxKeep 150
      expect(await strategy.execute(messages, s, noopLlmChat, "m")).toBeNull();
    });

    it("returns null when the only thing to pop is the notice itself (no churn)", async () => {
      // 6 plain exchanges (600t) + the notice, budget 600: the context is
      // "over budget" only by the notice's own tokens. Popping just the
      // notice and re-appending it every call is pure churn.
      const messages = [
        ...Array.from({ length: 6 }, (_, i) => msg(i % 2 ? "assistant" : "user")),
        batonNoticeMessage(),
      ];
      const s = { ...settings, reserveTokens: 400 }; // maxKeep 600
      expect(await strategy.execute(messages, s, noopLlmChat, "m")).toBeNull();
    });

    it("with a notice present, degrades to a pop and re-appends the notice (single copy)", async () => {
      const messages = [
        ...Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user")),
        batonNoticeMessage(),
      ];
      const result = await strategy.execute(messages, settings, noopLlmChat, "m");

      expect(result).not.toBeNull();
      expect(result!.appendNotice).toBe(BATON_NOTICE_PROMPT);
      // Pops m7, m8, m9 AND the old notice (11 - 7 kept); the extension
      // re-appends a fresh notice copy.
      expect(result!.messagesCompacted).toBe(4);
      // The stash must NOT carry the old notice into the continuation.
      expect(result!.batonStash).toHaveLength(3);
      expect(result!.batonStash![2]).toBe(messages[9]);
      for (const m of result!.batonStash!) {
        expect(hasBatonNotice([m], BATON_NOTICE_PROMPT)).toBe(false);
      }
    });

    it("reports accurate metadata on the pop path", async () => {
      const messages = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user"));

      const result = await strategy.execute(messages, popSettings, noopLlmChat, "m");

      expect(result!.metadata!.strategyName).toBe("pass-the-baton");
      expect(result!.metadata!.tokensBefore).toBe(1000);
      expect(result!.metadata!.tokensAfter).toBe(700);
      expect(result!.metadata!.poppedCount).toBe(result!.messagesCompacted);
      expect(result!.metadata!.maxKeepTokens).toBe(700);
    });
  });

  describe("recentWindow", () => {
    it("walks the start back over orphaned tool results to the parent assistant turn", () => {
      const messages = toolOnlySession(6); // ends on a tool result
      // A window cut purely by token budget can start on a tool result;
      // the parent assistant tool_calls turn must ride along (strict
      // backends 400 on an orphaned tool message at the window start).
      const win = recentWindow(messages, undefined, 700, BATON_NOTICE_PROMPT);
      expect(win.length).toBeGreaterThan(0);
      expect(win[0]!.role).not.toBe("tool");
    });

    it("drops the baton notice from the window", () => {
      const messages = [...Array.from({ length: 4 }, (_, i) => msg(i % 2 ? "assistant" : "user")), batonNoticeMessage()];
      const win = recentWindow(messages, undefined, 10000, BATON_NOTICE_PROMPT);
      expect(win).toHaveLength(4);
    });
  });
});

// ── Extension wiring ─────────────────────────────────────────────────────────

const TMP = mkdtempSync(join(TMP_PARENT, "hotdog-baton-test-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.HOTDOG_SESSIONS_DIR;
});

function makeMessages(count: number, content = BULK): Message[] {
  return Array.from({ length: count }, (_, i) =>
    new Message({ role: i % 2 === 0 ? "user" : "assistant", content }),
  );
}

function toolOnlyMessages(pairs: number): Message[] {
  const messages: Message[] = [new Message({ role: "user", content: BULK })];
  for (let i = 0; i < pairs; i++) {
    messages.push(
      new Message({
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", type: "function", function: { name: "t", arguments: "{}" } } as any,
        ],
      }),
      new Message({ role: "tool", content: BULK, toolCallId: "call_1" }),
    );
  }
  return messages;
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

  it("auto-trigger on a TOOL-ONLY session appends the notice with NOTHING popped; recent work stays in the window", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "ctx-notice-first");
    const original = toolOnlyMessages(12); // 25 msgs x ~100t, way over the 700 budget
    const agent = createMockAgent(original);
    const ext = createCompactionExtension(createMockCore()) as any;

    const result = await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });

    const after = agent.log.getAll();
    expect(after).toHaveLength(original.length + 1);
    // NOTHING popped: every original message is still there, SAME objects
    // (byte-identical prefix), the newest work included.
    for (let i = 0; i < original.length; i++) expect(after[i]).toBe(original[i]);
    expect(isBatonNotice(after[after.length - 1]!)).toBe(true);
    expect(result).toBeDefined();
    expect(result.messages).toHaveLength(original.length + 1);
  });

  it("degrade: an ignored notice with the context still over budget pops the tail, cut on a clean exchange", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "ctx-degrade");
    const original = makeMessages(10); // 10 x 100t > 700 budget
    const agent = createMockAgent(original);
    const ext = createCompactionExtension(createMockCore()) as any;

    // Trigger 1: notice only, nothing popped.
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    expect(agent.log.getAll()).toHaveLength(11);

    // The model ignores the notice and keeps running (context unchanged,
    // still over budget). Trigger 2: DEGRADE POP.
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });

    const after = agent.log.getAll();
    // 7 kept + 1 notice; the kept window is the original objects (cache).
    expect(after).toHaveLength(8);
    for (let i = 0; i < 7; i++) expect(after[i]).toBe(original[i]);
    expect(after.filter(isBatonNotice)).toHaveLength(1); // single notice copy
    // The last kept message closes an exchange (never a tool turn).
    expect(after[6]!.role).not.toBe("tool");
  });

  it("degrade is stable: once the context fits under the notice no further pops happen", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "ctx-degrade-stable");
    const agent = createMockAgent(makeMessages(10));
    const ext = createCompactionExtension(createMockCore()) as any;

    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent }); // notice
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent }); // pop
    const snapshot = agent.log.getAll();
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });

    const after = agent.log.getAll();
    expect(after).toHaveLength(snapshot.length);
    expect(after.every((m: Message, i: number) => m === snapshot[i])).toBe(true);
    expect(after.filter(isBatonNotice)).toHaveLength(1);
  });

  it("the notice no longer permanently locks future compaction (R4)", async () => {
    // Pre-fix, hasBatonNotice made canCompact false forever: the victim
    // session ground for 10+ minutes off the 8k base and the next real
    // overflow skipped baton entirely (falling through to cache-nuking
    // trim/drop). Now: notice present + over budget => the baton still
    // runs, degrading to a pop.
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "ctx-no-lockout");
    const agent = createMockAgent(makeMessages(10));
    const ext = createCompactionExtension(createMockCore()) as any;

    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    expect(agent.log.getAll()).toHaveLength(11); // notice-only, no pop

    // Grow the session back over budget while the notice stays in context.
    const extra = makeMessages(6, "y".repeat(400));
    for (const m of extra) agent.log.push(m);
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });

    const after = agent.log.getAll();
    // The baton FIRED (popped the tail) instead of standing down; ends on
    // exactly one notice.
    expect(after.length).toBeLessThan(17);
    expect(after.filter(isBatonNotice)).toHaveLength(1);
    expect(after[0]).not.toBeUndefined();
    // Kept window is the oldest fitting prefix, cut clean.
    const lastKept = after[after.length - 2]!;
    expect(lastKept.role).not.toBe("tool");
    expect(lastKept.toolCalls ?? (lastKept as any).tool_calls).toBeUndefined();
  });

  it("stash: a pop persists its tail to <session-id>.baton.json; the notice append persists the recent window", async () => {
    const dir = join(TMP, "stash");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const original = makeMessages(10);
    const agent = createMockAgent(original);
    const ext = createCompactionExtension(createMockCore()) as any;
    const file = join(dir, "baton-test-session.baton.json");

    // Append trigger: stash file already exists with the recent window.
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    expect(existsSync(file)).toBe(true);
    const appended = JSON.parse(readFileSync(file, "utf8"));
    expect(appended.session_id).toBe("baton-test-session");
    expect(appended.messages.length).toBeGreaterThan(0);
    expect(appended.messages.length).toBeLessThan(10);

    // Degrade pop overwrites the snapshot with the MERGED stash window:
    // the popped tail (m7..m9) deduped against the append snapshot -- the
    // newest work, capped to the keep budget.
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    const popped = JSON.parse(readFileSync(file, "utf8"));
    expect(popped.messages.length).toBeGreaterThanOrEqual(3);
    expect(popped.messages.length).toBeLessThanOrEqual(7); // budget-capped
    // The window ENDS with the newest messages, in original order.
    expect(popped.messages[popped.messages.length - 1].content).toBe(BULK);
    expect(popped.messages[0].role).toBe("assistant");
  });

  it("stash: concurrent sessions write to separate files without clobbering", async () => {
    const dir = join(TMP, "stash-isolation");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const ext = createCompactionExtension(createMockCore()) as any;
    const a = createMockAgent(makeMessages(10));
    a.sessionId = "session-alpha";
    const b = createMockAgent(makeMessages(10));
    b.sessionId = "session-beta";

    // Two triggers each (notice, then degrade pop).
    await ext.hooks[HOOKS.CONTEXT]!({ messages: a.context.getMessages(), agent: a });
    await ext.hooks[HOOKS.CONTEXT]!({ messages: b.context.getMessages(), agent: b });
    await ext.hooks[HOOKS.CONTEXT]!({ messages: a.context.getMessages(), agent: a });
    await ext.hooks[HOOKS.CONTEXT]!({ messages: b.context.getMessages(), agent: b });

    const alpha = JSON.parse(readFileSync(join(dir, "session-alpha.baton.json"), "utf8"));
    const beta = JSON.parse(readFileSync(join(dir, "session-beta.baton.json"), "utf8"));
    expect(alpha.session_id).toBe("session-alpha");
    expect(beta.session_id).toBe("session-beta");
    // Merged+deduped window (append snapshot ∪ popped tail), budget-capped.
    expect(alpha.messages.length).toBeGreaterThanOrEqual(3);
    expect(alpha.messages.length).toBeLessThanOrEqual(7);
    expect(beta.messages.length).toBeGreaterThanOrEqual(3);
    expect(beta.messages.length).toBeLessThanOrEqual(7);
  });

  it("stash: a crafted session id skips the file mirror, replay still works in-process", async () => {
    const dir = join(TMP, "stash-unsafe");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const ext = createCompactionExtension(createMockCore()) as any;
    const original = makeMessages(10);
    const agent = createMockAgent(original);
    // Same shape a hostile resume payload could carry: join() would place
    // the file OUTSIDE the sessions dir. The id guard must refuse the mirror.
    agent.sessionId = "../escape";

    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });

    expect(existsSync(join(dir, "../escape.baton.json"))).toBe(false);
    expect(existsSync(join(TMP, "escape.baton.json"))).toBe(false);
    // Nothing landed in the sessions dir either (the mirror never opened it).
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);

    // The live map is unaffected: path B handoff still replays a window.
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
    const after = agent.log.getAll();
    expect(after.length).toBeGreaterThan(1); // plan + stashed window
    expect(String(after[0]!.content)).toContain("# Baton handoff");
  });

  it("provider:error rescue POPS IMMEDIATELY (no notice-first) and shrinks the failed request", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "rescue");
    // 40 x 26t = 1040 > 1000: over a 1000-token window with reserve 0.
    const original = makeMessages(40, "x".repeat(104));
    const agent = createMockAgent(original);
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
    // Rescue was LLM-free (the client would have thrown), popped the tail,
    // and ended on the notice -- WITHOUT a first append-only round.
    const after = agent.log.getAll();
    expect(after.length).toBeLessThan(40);
    expect(isBatonNotice(after[after.length - 1]!)).toBe(true);
    expect(params.messages.length).toBe(after.length);
    expect(systemMessages).toHaveLength(1);
    // Kept window = byte-prefix of what failed.
    expect(after[0]).toBe(original[0]);
  });

  it("provider:error rescue with a notice present degrades to a pop (no lockout into trim)", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "rescue2");
    const original = makeMessages(10);
    // Over budget AND already carrying a notice: baton STILL runs (pop),
    // it does not stand down and hand the session to front-cutting trim.
    const agent = createMockAgent([...original, batonNoticeMessage()]);
    const ext = createCompactionExtension(createMockCore()) as any;
    agent.sink = { emit: () => {} };

    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]!({
      error: LlmError.Api("HTTP 500 (body: exceeds the available context size)", 500),
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });

    expect(result).toEqual({ retry: true });
    const after = agent.log.getAll();
    // BATON cut (kept the OLDEST prefix byte-identical), not trim's
    // front-cut: after[0..4] are the original objects. (The rescue aims
    // at the 0.85 hysteresis target, so the kept window is the largest
    // prefix under 595, not under 700.)
    expect(after.filter(isBatonNotice)).toHaveLength(1);
    expect(after.length).toBeLessThan(11);
    expect(after[0]).toBe(original[0]);
    expect(after[4]).toBe(original[4]);
  });

  it("provider:error rescue on a tool-only session falls through to trim (R1 null floor)", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "rescue3");
    // Tool-only: baton returns null (no clean exchange boundary anywhere),
    // the rescue chain must degrade onward to trim, which cuts from the
    // FRONT and keeps the newest work.
    const original = toolOnlyMessages(20);
    const agent = createMockAgent(original);
    const ext = createCompactionExtension(createMockCore({ reserveTokens: 0 })) as any;
    agent.sink = { emit: () => {} };

    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]!({
      error: LlmError.Api('HTTP 500 (body: {"error":"exceeds the available context size"})', 500),
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });

    expect(result).toEqual({ retry: true });
    const after = agent.log.getAll();
    expect(after.length).toBeLessThan(original.length);
    // Trim cut from the front: the first original message is gone, and no
    // baton notice was appended.
    expect(after[0]).not.toBe(original[0]);
    expect(after.filter(isBatonNotice)).toHaveLength(0);
  });
});

// ── R2: keep budget follows the effective model window ───────────────────────

describe("Compaction Extension — R2 keep budget uses the effective model window", () => {
  // 4000 chars => 1000 estimated tokens each.
  const HEAVY = "x".repeat(4000);

  function bigSetup(compactionConfig: Record<string, unknown> = {}) {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "r2-" + Math.random().toString(36).slice(2));
    // CORE knob at the 128000 default; the effective MODEL window is the
    // victim's 262144. Absent an explicit compaction.contextLimit, the
    // strategy budget must be 262144 - reserveTokens.
    const core = createMockCore({ reserveTokens: 4096, ...compactionConfig });
    core.resolved = { contextLimit: 128000 };
    const agent = createMockAgent(makeMessages(400, HEAVY)); // 400k estimated tokens
    agent.modelRegistry = { "test-model": { name: "test-model", temperature: null, contextLimit: 262144 } };
    agent.sink = { emit: () => {} };
    return { core, agent };
  }

  const overflow = LlmError.Api(
    'HTTP 500 (body: {"error":"the request exceeds the available context size, try increasing it"})',
    500,
  );

  it("keeps to 262144 - reserveTokens (not the core 128000 default)", async () => {
    const { core, agent } = bigSetup();
    const ext = createCompactionExtension(core) as any;

    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]!({
      error: overflow,
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });

    expect(result).toEqual({ retry: true });
    const after = agent.log.getAll().filter((m: Message) => !isBatonNotice(m));
    // Budget 262144 - 4096 = 258048 => ~258 kept. The old core-knob budget
    // (128000 - 4096 = 123904) would keep ~123. Pin the middle.
    expect(after.length).toBeGreaterThan(200);
    expect(after.length).toBeLessThanOrEqual(259);
  });

  it("an explicit compaction.contextLimit still overrides the model window", async () => {
    const { core, agent } = bigSetup({ contextLimit: 128000 });
    const ext = createCompactionExtension(core) as any;

    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]!({
      error: overflow,
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });

    expect(result).toEqual({ retry: true });
    const after = agent.log.getAll().filter((m: Message) => !isBatonNotice(m));
    // Explicit 128000 - 4096 = 123904 => ~123 kept.
    expect(after.length).toBeLessThan(130);
    expect(after.length).toBeGreaterThan(100);
  });
});

// ── Baton replay lifecycle (handoff detection → fresh-context replay) ───────

describe("Compaction Extension — baton replay lifecycle", () => {
  /**
   * Fire the CONTEXT hook through the new lifecycle on the standard
   * 10 x 100t fixture: trigger 1 appends the notice (nothing popped,
   * 11 messages), trigger 2 -- the model ignored it, context still over
   * budget -- degrade-pops to 7 kept + 1 notice and stashes the 3-message
   * tail.
   */
  async function fireBaton(ext: any, agent: any) {
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    expect(agent.log.getAll()).toHaveLength(11); // notice only
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    expect(agent.log.getAll()).toHaveLength(8); // 7 kept + 1 notice
  }

  it("path B: narrated handoff stashes the recent window BEFORE the clear; continuation gets plan + verbatim tail", async () => {
    const dir = join(TMP, "replayB");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const original = makeMessages(10);
    const agent = createMockAgent(original);
    const ext = createCompactionExtension(createMockCore()) as any;
    await fireBaton(ext, agent);

    // Work done AFTER the stash pop (post-pop the model kept going, under
    // the re-trigger threshold): the handoff clear must capture it into
    // the replay window as well -- the plan text promises verbatim recents.
    const w1 = new Message({ role: "assistant", content: "still working" });
    agent.log.push(w1);

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
    // The stash file was rewritten BEFORE the clear with the merged window.
    const stashed = JSON.parse(readFileSync(join(dir, "baton-test-session.baton.json"), "utf8"));
    expect(stashed.messages.length).toBeGreaterThanOrEqual(3);

    // First LLM call of the fresh session: tail replayed after the plan.
    const ctxResult = await ext.hooks[HOOKS.CONTEXT]!({
      messages: agent.context.getMessages(),
      agent,
    });
    const after = agent.log.getAll();
    expect(after.length).toBeGreaterThanOrEqual(4); // plan + >=3 stashed
    expect(after[0]).toBe(mid[0]); // plan stays first
    // The replayed tail ends with the newest captured work, verbatim
    // objects, and never starts on an orphaned tool result.
    expect(after[after.length - 1]).toBe(w1);
    expect(after[1]!.role).not.toBe("tool");
    // The notice itself is NOT resurrected into the continuation.
    expect(after.filter(isBatonNotice)).toHaveLength(0);
    expect(ctxResult.messages.length).toBe(after.length);

    // Stash file consumed alongside the live map.
    expect(existsSync(join(dir, "baton-test-session.baton.json"))).toBe(false);
  });

  it("path B without any prior pop: the append-time snapshot plus post-notice work replays", async () => {
    const dir = join(TMP, "replayB-nopop");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const original = toolOnlyMessages(12); // 25 msgs over budget
    const agent = createMockAgent(original);
    const ext = createCompactionExtension(createMockCore()) as any;

    // Trigger 1: notice only (tool-only session, nothing popped ever).
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    expect(agent.log.getAll()).toHaveLength(26);

    // The model takes the notice to heart THIS turn and narrates a wrap-up.
    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "Worker wrap-up: files edited, tests green.",
      claimTurn: () => true,
      agent,
    });
    expect(agent.clearedCount).toBe(1);

    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    const after = agent.log.getAll();
    expect(String(after[0]!.content)).toContain("Worker wrap-up");
    // The continuation gets a real verbatim window of the worker's recent
    // tool turns (snapshot from the append), not an empty replay.
    expect(after.length).toBeGreaterThan(1);
    expect(after[after.length - 1]).toBe(original[original.length - 1]);
    expect(after.filter(isBatonNotice)).toHaveLength(0);
  });

  it("path A: a handoff tool call replays the stash onto the plan it left behind", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "replayA");
    const original = makeMessages(10);
    const agent = createMockAgent(original);
    const ext = createCompactionExtension(createMockCore()) as any;
    await fireBaton(ext, agent);

    // Simulate the handoff-tool extension (it ran at higher TURN_END
    // priority): it cleared the context and enqueued its own plan. It
    // clears BEFORE this hook runs, so path A replays the last known
    // stash (the degrade pop's tail).
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
    // plan + merged stash window (append snapshot m3..m9 deduped with the
    // popped tail -- the newest work, budget-capped to 7).
    expect(after).toHaveLength(8);
    expect(String(after[0]!.content)).toContain("handoff-tool plan");
    for (let i = 0; i < 7; i++) expect(after[i + 1]).toBe(original[i + 3]);
    expect(ctxResult.messages).toHaveLength(8);
  });

  it("cancelled endings drop the baton (no hijack of the next turn)", async () => {
    const dir = join(TMP, "replayC");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const agent = createMockAgent(makeMessages(10));
    const ext = createCompactionExtension(createMockCore()) as any;
    await fireBaton(ext, agent);

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
    await fireBaton(ext, agent);

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
    await fireBaton(ext, agent);

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
    await fireBaton(ext, agent);

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
    // The next CONTEXT must not re-append the tail. (The over-budget
    // context with notice re-triggers the baton, but the only thing left
    // past the fitting prefix is the notice itself -> no churn pop, the
    // context is stable.)
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    const after = agent.log.getAll();
    expect(after).toHaveLength(8); // no tail re-appended, no notice churn
    expect(after.filter(isBatonNotice)).toHaveLength(1);

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
    await fireBaton(ext, agent);

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
    await fireBaton(ext, agent);
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
  // between the two would break notice handling for every session relying
  // on the default. Keep them pinned together.
  it("extension.json default matches BATON_NOTICE_PROMPT verbatim", () => {
    const extJson = JSON.parse(
      readFileSync(join(import.meta.dir, "../../src/extensions/compaction/extension.json"), "utf8"),
    );
    expect(extJson.configSchema.compaction.properties.batonNoticePrompt.default).toBe(
      BATON_NOTICE_PROMPT,
    );
  });
});

// ── M-26: the stash requires a real sessionId; the notice append does not ───

describe("Compaction Extension -- stash requires a real sessionId", () => {
  it("an agent without a sessionId still gets the notice, but no stash and no pop", async () => {
    const dir = join(TMP, "nosid");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    // A bare factory-built worker / embed: no sessionId at all.
    const agent = createMockAgent(makeMessages(10));
    delete agent.sessionId;
    const ext = createCompactionExtension(createMockCore()) as any;

    const result = await ext.hooks[HOOKS.CONTEXT]!({
      messages: agent.context.getMessages(),
      agent,
    });

    // The notice-first append costs nothing to lose and cannot orphan
    // anything: it happens. Nothing is popped, nothing can be stashed.
    expect(result).toBeDefined();
    const after = agent.log.getAll();
    expect(after).toHaveLength(11);
    expect(after.filter(isBatonNotice)).toHaveLength(1);
    expect(existsSync(dir)).toBe(false);

    // The degrade pop that WOULD lose the tail is declined outright: the
    // next trigger leaves the context untouched (the overflow rescue
    // chains to trim/drop instead).
    await ext.hooks[HOOKS.CONTEXT]!({ messages: agent.context.getMessages(), agent });
    expect(agent.log.getAll()).toHaveLength(11);
    expect(existsSync(dir)).toBe(false);
  });

  it("a no-sessionId overflow rescue falls through to the next strategy", async () => {
    const dir = join(TMP, "nosid-rescue");
    process.env.HOTDOG_SESSIONS_DIR = dir;
    const agent = createMockAgent(makeMessages(10));
    delete agent.sessionId;
    const ext = createCompactionExtension(createMockCore()) as any;

    const overflow = LlmError.Api(
      'HTTP 500 (body: {"error":"the request exceeds the available context size, try increasing it"})',
      500,
    );
    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]!({
      error: overflow,
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });

    // The rescue happened: the baton declined (no session to stash under),
    // trim compacted instead, and a retry is ordered.
    expect(result).toMatchObject({ retry: true });
    expect(agent.log.getAll().length).toBeLessThan(10);
    expect(existsSync(dir)).toBe(false);
  });

  it("two sessionId'd agents never see each other's baton", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(TMP, "two-agents");
    const ext = createCompactionExtension(createMockCore()) as any;

    const aOriginal = makeMessages(10);
    const a = createMockAgent(aOriginal);
    a.sessionId = "session-alpha";
    const bOriginal = makeMessages(10);
    const b = createMockAgent(bOriginal);
    b.sessionId = "session-beta";

    // Notice, then degrade pop, on each session.
    await ext.hooks[HOOKS.CONTEXT]!({ messages: a.context.getMessages(), agent: a });
    await ext.hooks[HOOKS.CONTEXT]!({ messages: b.context.getMessages(), agent: b });
    await ext.hooks[HOOKS.CONTEXT]!({ messages: a.context.getMessages(), agent: a });
    await ext.hooks[HOOKS.CONTEXT]!({ messages: b.context.getMessages(), agent: b });

    // Both sessions now hold their OWN stashed tail (3 newest each).
    // A hands off first (narrated completion).
    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "A hands off.",
      claimTurn: () => true,
      agent: a,
    });
    expect(a.clearedCount).toBe(1);

    // A replays its OWN stash window verbatim (merged snapshot+tail,
    // budget-capped to the 7 newest)...
    await ext.hooks[HOOKS.CONTEXT]!({ messages: a.context.getMessages(), agent: a });
    const afterA = a.log.getAll();
    expect(afterA).toHaveLength(8); // plan + A's window (m3..m9)
    expect(String(afterA[0]!.content)).toContain("# Baton handoff");
    for (let i = 0; i < 7; i++) expect(afterA[i + 1]).toBe(aOriginal[i + 3]);

    // B then completes: its handoff runs off B's OWN baton, and B's replay
    // lands B's window.
    await ext.hooks[HOOKS.TURN_END]!({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "B wraps up.",
      claimTurn: () => true,
      agent: b,
    });
    expect(b.clearedCount).toBe(1);
    await ext.hooks[HOOKS.CONTEXT]!({ messages: b.context.getMessages(), agent: b });
    const afterB = b.log.getAll();
    expect(afterB).toHaveLength(8);
    expect(String(afterB[0]!.content)).toContain("B wraps up");
    for (let i = 0; i < 7; i++) expect(afterB[i + 1]).toBe(bOriginal[i + 3]);

    // A's replay consumed nothing of B's. A full-budget replay window
    // leaves the continuation itself over budget (plan + window on top of
    // the system prompt), so the NEXT trigger notices it -- the normal
    // self-limiting lifecycle from here (notice -> degrade pop if it is
    // ignored), and nothing of A's leaked into B's stash at any point.
    await ext.hooks[HOOKS.CONTEXT]!({ messages: b.context.getMessages(), agent: b });
    const afterB2 = b.log.getAll();
    expect(afterB2).toHaveLength(9); // + the next notice
    expect(afterB2.filter(isBatonNotice)).toHaveLength(1);
    expect(afterB2[0]).toBe(afterB[0]); // B's own plan untouched
  });
});
