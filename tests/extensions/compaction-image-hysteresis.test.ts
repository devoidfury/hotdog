// 2026-11-18 follow-up batch on the image-rescue seam (survey run
// adhoc-20261118-image-compaction-survey, opencode model-request.ts /
// compaction.ts findings). Three rulings pinned here:
//
//  1. HYSTERESIS + CACHE STABILITY: the downgrade/reduction TARGET sits
//     meaningfully below the TRIGGER (target = 0.85 x budget), already-
//     downgraded messages are frozen (byte-stable across rescues, so the
//     prompt-cache prefix survives), and cuts only ever advance FORWARD
//     through the transcript -- a rescue that lands under target does not
//     refire on a small append; only new weight past the trigger does.
//
//  2. FRACTIONAL RE-AIM: when the provider STILL rejects after a rescue,
//     the next attempts aim at REAIM_SHRINK_STEPS fractions of the first
//     rejected request size (initial rescue aims at 0.85 of budget), hard
//     cap 3 re-aims after the initial rescue, and the monotonicity law:
//     no attempt may re-issue a context at the size just rejected.
//
//  3. PLACEHOLDER WORDING: anti-hallucination copy (removed / do not
//     describe from memory / re-attach or re-read the saved path).
//
// Deterministic, no network, no mock.module -- the established
// PROVIDER_ERROR / CONTEXT hook seam, exactly like the incident suite.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import { LlmError } from "@core/error.ts";
import { MessageLog } from "@core/context/message-log.ts";
import { Message, type ImageAttachment } from "@core/context/message.ts";
import { estimateContextTokens } from "@utils/token-estimate.ts";
import { create as createCompactionExtension, REAIM_SHRINK_STEPS } from "@extensions/compaction/index.ts";
import {
  IMAGE_OMITTED_NOTICE,
  downgradeOlderImages,
} from "@extensions/compaction/utils.ts";

// ── Constants mirror what the extension resolves ─────────────────────────────
const CONTEXT_LIMIT = 2_000;
const BUDGET = CONTEXT_LIMIT; // reserveTokens 0 in these tests
const TARGET = Math.floor(REAIM_SHRINK_STEPS[0]! * BUDGET); // the hysteresis target

const fakeB64 = (n: number): string => "A".repeat(n);
const img = (bytes: number): ImageAttachment => ({
  type: "image_url",
  mimeType: "image/png",
  data: fakeB64(bytes),
});

const overflowError = () =>
  LlmError.Api(
    'HTTP 400 (body: {"error":{"message":"prompt exceeds the available context, try reducing the conversation","type":"invalid_request_error","code":"context_length_exceeded"}})',
    400,
  );
const quotingError = () =>
  LlmError.Api(
    'HTTP 500 (body: {"error":{"message":"upstream rejected the request; see docs re: maximum context length limits","type":"server_error"}})',
    500,
  );

/** One browser-work exchange: assistant tool_call -> tool result with a screenshot. */
function shotBlock(i: number, imageChars = 240): Message[] {
  return [
    new Message({
      role: "assistant",
      content: "",
      toolCalls: [{ id: `c${i}`, type: "function", function: { name: "shot", arguments: "{}" } }],
      source: "model",
    }),
    new Message({
      role: "tool",
      content: `t`.repeat(40),
      toolCallId: `c${i}`,
      source: "tool",
      images: [img(imageChars)],
    }),
  ];
}

function createMockCore(contextLimit: number, config: Record<string, unknown> = {}) {
  return {
    hooks: new HookSystem(),
    config: {
      compaction: {
        enabled: true,
        reserveTokens: 0,
        keepRecentMessages: 3,
        strategy: "summarize",
        userTurnGuardPrompt: "Continue from the compressed conversation context above.",
        ...config,
      },
    },
    modelRegistry: {
      "test-model": { name: "test-model", temperature: null, contextLimit },
    },
    resolved: { contextLimit },
  } as any;
}

function createMockAgent(contextArray: Message[], contextLimit: number, sessionId = "hysteresis-test") {
  const mockLlmClient = {
    chatStreamCancellable: () =>
      (async function* () {
        yield { type: "content", content: "test response" };
      })(),
  };
  const log = new MessageLog(contextArray);
  const usageShim = { promptTokens: 0, cachedTokens: 0 };
  return {
    get log() {
      return log;
    },
    usageShim,
    get context() {
      return {
        getMessages: () => log.getAll(),
        replaceMessages: (msgs: Message[]) => log.replace(msgs),
        getSystem: () => log.getSystem(),
        getNonSystem: () => log.getNonSystem(),
        getSystemPrompt: () => null,
        getTokenUsage: () => ({ ...usageShim }),
      };
    },
    model: "test-model",
    modelRegistry: { "test-model": { name: "test-model", temperature: null, contextLimit } },
    sessionId,
    cancelled: false,
    get llmClient() {
      return mockLlmClient;
    },
    buildMessages() {
      return [...log.getAll()];
    },
    replaceContext(newContext: Message[]) {
      log.replace(newContext);
    },
    sink: { emit: (_e: unknown) => {} },
  } as any;
}

const countImages = (messages: Message[]): number =>
  messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
const hasPlaceholder = (m: Message): boolean =>
  (m.getTextContent?.() ?? "").includes(IMAGE_OMITTED_NOTICE);
const serializeAll = (messages: Message[]): string[] => messages.map((m) => JSON.stringify(m.toJSON()));

/** Screenshot transcript: tiny text, image-heavy weight (the incident family). */
function imageTranscript(blocks: number, startIdx = 0, imageChars = 240): Message[] {
  const msgs: Message[] = [new Message({ role: "user", content: "u".repeat(40), source: "user" })];
  for (let i = 0; i < blocks; i++) msgs.push(...shotBlock(startIdx + i, imageChars));
  return msgs;
}

let TMP: string;
beforeAll(() => {
  TMP = mkdtempSync(join(TMP_PARENT, "compaction-hyst-"));
  process.env.HOTDOG_SESSIONS_DIR = TMP;
});
afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

// ── 1. Hysteresis band + monotonic, cache-stable downgrade ───────────────────

describe("image downgrade: hysteresis band and cache-stable cuts", () => {
  it("(a) a rescue landing under target does not refire on an append past the target but under the trigger", async () => {
    const agent = createMockAgent(imageTranscript(15, 0, 800), CONTEXT_LIMIT);
    const systemMessages: string[] = [];
    agent.sink = { emit: (e: { type: number; content?: string }) => {
      if (e.type === 15) systemMessages.push(e.content!);
    } };
    const ext = createCompactionExtension(createMockCore(CONTEXT_LIMIT)) as any;
    const params: any = { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] };
    expect(estimateContextTokens(agent.log.getAll())).toBeGreaterThan(BUDGET);

    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params,
      agent,
      retry: false,
    });

    expect(result).toEqual({ retry: true });
    const after: Message[] = agent.log.getAll();
    // BAND: the reduction lands at/below the TARGET (0.85 x budget), not
    // merely under the trigger, so a following append needs real new
    // weight (past the TRIGGER) before the next reduction.
    expect(estimateContextTokens(after)).toBeLessThanOrEqual(TARGET);
    // Every message survives (image downgrade only).
    expect(after.filter(hasPlaceholder).length).toBeGreaterThan(0);

    // The hysteresis pin: an append that crosses TARGET but stays under
    // the TRIGGER must NOT re-fire the auto trigger -- only new weight
    // past the trigger fires the next reduction.
    agent.log.push(new Message({ role: "user", content: "u".repeat(2_800), source: "user" }));
    const grown = agent.log.getAll();
    const grownWeight = estimateContextTokens(grown);
    expect(grownWeight).toBeGreaterThan(TARGET);
    expect(grownWeight).toBeLessThan(BUDGET);
    const ctxResult = await ext.hooks[HOOKS.CONTEXT]({ messages: grown, agent });
    expect(ctxResult).toBeUndefined();
    expect(agent.log.getAll()).toHaveLength(grown.length);
  });

  it("(b) growth past the trigger fires again and downgrades only images past the previous cut line", async () => {
    // Same agent across two rescues -- the episode and the cut line persist.
    const agent = createMockAgent(imageTranscript(15, 0, 800), CONTEXT_LIMIT);
    const ext = createCompactionExtension(createMockCore(CONTEXT_LIMIT)) as any;

    const first = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(first).toEqual({ retry: true });
    const after1: Message[] = agent.log.getAll();
    const after1Bytes = serializeAll(after1);
    const survivorIdx1 = after1
      .map((m, i) => ((m.images?.length ?? 0) > 0 ? i : -1))
      .filter((i) => i >= 0);
    expect(survivorIdx1).toHaveLength(2); // the newest two payloads survive intact
    const frozenIdx1 = after1Bytes
      .map((s, i) => (s.includes(IMAGE_OMITTED_NOTICE) ? i : -1))
      .filter((i) => i >= 0);
    expect(frozenIdx1.length).toBeGreaterThan(0);

    // Growth: fresh screenshot blocks push the weight past the TRIGGER.
    for (const m of imageTranscript(12, 100, 800)) agent.log.push(m);
    const grown: Message[] = agent.log.getAll();
    expect(estimateContextTokens(grown)).toBeGreaterThan(BUDGET);

    const params2: any = { messages: [...grown], modelConfig: {}, toolDefs: [] };
    const second = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: params2,
      agent,
      retry: false,
    });
    expect(second).toEqual({ retry: true });
    const after2: Message[] = agent.log.getAll();

    // (c) CACHE-PREFIX PROOF: every already-placeholder message keeps its
    // exact bytes across the second rescue (identical serialization).
    for (const i of frozenIdx1) {
      expect(JSON.stringify(after2[i]!.toJSON())).toBe(after1Bytes[i]!);
    }
    // The cut advanced FORWARD: the rescue-1 survivor sits past the old cut
    // line and is now itself downgraded (a frozen message is never re-touched).
    for (const i of survivorIdx1) {
      expect(after2[i]!.images ?? []).toHaveLength(0);
      expect(hasPlaceholder(after2[i]!)).toBe(true);
    }
    // The only surviving payloads are the NEWEST images of this transcript.
    const survivors = after2.filter((m) => (m.images?.length ?? 0) > 0);
    const keptSizes = survivors.flatMap((m) => m.images!.map((a) => a.data.length));
    expect(keptSizes).toHaveLength(2);
    const totalImages = countImages(grown);
    expect(totalImages - keptSizes.length).toBeGreaterThan(0);
    for (const m of survivors) {
      const idx = after2.indexOf(m);
      expect(idx).toBeGreaterThan(Math.max(...survivorIdx1)); // strictly newer
    }
  });

  it("(c) a placeholder message is frozen: byte-identical, never double-noticed, by later downgrades", () => {
    // Direct seam: a multi-image message gets a partial downgrade, then a
    // harsher later pass must NOT re-touch it (cache-prefix stability wins
    // over squeezing its kept payload).
    const multi = new Message({ role: "user", content: "look", images: [img(1000), img(1000)] });
    const newer = new Message({ role: "user", content: "new", images: [img(500)] });

    const first = downgradeOlderImages([multi, newer], 2);
    expect(first.strippedImages).toBe(1);
    const frozen = first.messages[0]!;
    expect(frozen.images).toHaveLength(1);
    expect(hasPlaceholder(frozen)).toBe(true);

    const second = downgradeOlderImages(first.messages, 0); // keep NOTHING: frozen stays frozen
    expect(second.messages[0]).toBe(frozen); // identity: byte-stable prefix
    expect(second.messages[0]!.images).toHaveLength(1);
    expect(
      (second.messages[0]!.getTextContent()?.split(IMAGE_OMITTED_NOTICE).length ?? 0) - 1,
    ).toBe(1); // exactly one notice, never doubled
    expect(second.strippedImages).toBe(1); // the non-frozen message WAS stripped
    expect(second.messages[1]!.images ?? []).toHaveLength(0);
  });
});

// ── 2. Fractional re-aim on repeated overflow rejections ─────────────────────

describe("fractional re-aim on repeated provider rejections", () => {
  it("the rejection loop converges through strictly smaller steps and stops at the cap", async () => {
    // 100 plain messages x 200 tokens = 20,000 estimated against a 10,000
    // budget: the chain can only reduce in ~200-token steps, so each
    // rejection must produce a strictly smaller re-issue until the ladder
    // is spent -- then an honest stop, never an identical retry.
    const agent = createMockAgent(
      Array.from({ length: 100 }, (_, i) =>
        new Message({
          role: i % 2 === 0 ? "user" : "assistant",
          content: "x".repeat(800),
          source: i % 2 === 0 ? "user" : "model",
        }),
      ),
      10_000,
    );
    const systemMessages: string[] = [];
    agent.sink = { emit: (e: { type: number; content?: string }) => {
      if (e.type === 15) systemMessages.push(e.content!);
    } };
    const ext = createCompactionExtension(createMockCore(10_000)) as any;

    const issuedSizes: number[] = [];
    let lastResult: unknown = undefined;
    // Drive the seam the way core does: rejection -> hook -> re-issue ->
    // STILL over budget -> rejection -> ... (no acceptance in this test).
    for (let i = 0; i < 6; i++) {
      const params: any = { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] };
      lastResult = await ext.hooks[HOOKS.PROVIDER_ERROR]({
        error: overflowError(),
        params,
        agent,
        retry: false,
      });
      if (lastResult === undefined) break;
      issuedSizes.push(estimateContextTokens(params.messages));
    }

    // Initial rescue + hard cap of 3 re-aims = 4 retries, then the stop.
    expect(lastResult).toBeUndefined();
    expect(issuedSizes).toHaveLength(4);
    // Monotonicity law: every attempt is STRICTLY smaller than the
    // previous rejection's size (the first one included).
    const previousSizes = [20_000, ...issuedSizes];
    for (let i = 0; i < issuedSizes.length; i++) {
      expect(issuedSizes[i]!).toBeLessThan(previousSizes[i]!);
    }
    // The first rescue lands at/below the 0.85 target; the ladder then
    // keeps shrinking rather than 400-looping at one size.
    expect(issuedSizes[0]!).toBeLessThanOrEqual(Math.floor(0.85 * 10_000));
    // The stop is honest: the surfaced notice never claims a compaction
    // happened on the capped attempt.
    const finalNotice = systemMessages[systemMessages.length - 1]!;
    expect(finalNotice).toContain("surfacing the error");
    expect(finalNotice).not.toContain("compacted the conversation");
  });

  it("a transcript with no eligible reduction stops after the first refusal (no identical retry)", async () => {
    // Tool-heavy transcript where every strategy's safe cut lands nowhere:
    // the FIRST rejection gets the existing "nothing eligible" notice and
    // no retry, and a second rejection on the unchanged context stays a
    // refusal (the monotonicity law allows no identical re-issue).
    const messages = [
      new Message({ role: "user", content: "start" }),
      ...Array.from({ length: 20 }, (_, i) =>
        new Message({ role: "tool", content: "y".repeat(400), toolCallId: `call_${i}` })),
      new Message({ role: "assistant", content: "a1" }),
      new Message({ role: "user", content: "u1" }),
      new Message({ role: "assistant", content: "a2" }),
      new Message({ role: "user", content: "u2" }),
      new Message({ role: "assistant", content: "a3" }),
      new Message({ role: "user", content: "u3" }),
    ];
    const agent = createMockAgent(messages, 1_000);
    const systemMessages: string[] = [];
    agent.sink = { emit: (e: { type: number; content?: string }) => {
      if (e.type === 15) systemMessages.push(e.content!);
    } };
    const ext = createCompactionExtension(createMockCore(1_000)) as any;

    const first = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(first).toBeUndefined();
    expect(agent.log.getAll()).toHaveLength(27);
    expect(systemMessages.join(" ")).toContain("nothing eligible to compact");

    const second = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(second).toBeUndefined();
    expect(agent.log.getAll()).toHaveLength(27);
  });

  it("a quoting-overflow 5xx MID-episode surfaces untouched and keeps the episode alive", async () => {
    // Reviewer repro of the gate-bypass defect: gateway flapping lands the
    // morning-incident body (a 500 merely QUOTING "maximum context length")
    // between two genuine rejections, on the UNCHANGED post-rescue context.
    // It must not touch the context, must not emit a notice, and must not
    // consume a ladder rung -- and the NEXT genuine (4xx) rejection must
    // still continue the ladder.
    const agent = createMockAgent(
      [
        new Message({ role: "user", content: "u".repeat(200), source: "user" }), // heavy head: a real reduction exists
        ...imageTranscript(15, 0, 800).slice(1),
      ],
      CONTEXT_LIMIT,
    );
    const systemMessages: string[] = [];
    agent.sink = { emit: (e: { type: number; content?: string }) => {
      if (e.type === 15) systemMessages.push(e.content!);
    } };
    const ext = createCompactionExtension(createMockCore(CONTEXT_LIMIT)) as any;

    const first = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(), // genuine 400 (context_length_exceeded body)
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(first).toEqual({ retry: true });
    const after1: Message[] = agent.log.getAll();
    const after1Bytes = serializeAll(after1);
    const est1 = estimateContextTokens(after1);
    expect(est1).toBeLessThan(BUDGET); // the rescue landed; the context FITS
    expect(systemMessages).toHaveLength(1);

    // The transient gateway hiccup, mid-episode, same context.
    const mid = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: quotingError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(mid).toBeUndefined();
    const after2: Message[] = agent.log.getAll();
    expect(serializeAll(after2)).toEqual(after1Bytes); // ZERO mutation, byte-for-byte
    expect(systemMessages).toHaveLength(1); // no notice, no claim

    // The episode stayed ALIVE: the next genuine rejection continues the
    // ladder (rung 1: strictly smaller re-issue below the fits-anyway size).
    const params3: any = { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] };
    const third = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: params3,
      agent,
      retry: false,
    });
    expect(third).toEqual({ retry: true });
    expect(estimateContextTokens(params3.messages)).toBeLessThan(est1);
  });

  it("a strategy rewrite that is not a smaller request is rolled back (no phantom compaction, no false notice)", async () => {
    // The reduced-false-after-replaceContext shape: a genuine mid-episode
    // rejection whose only available move pops a tail message SMALLER than
    // the notice it appends -- a weight GROWTH. The rescue must not re-issue
    // it, must not leave the rewrite in place, and must not call that
    // "nothing eligible to compact".
    const transcript: Message[] = [
      new Message({ role: "user", content: "u".repeat(40), source: "user" }),
      ...imageTranscript(14, 0, 800).slice(1), // 14 screenshot blocks
      new Message({ role: "assistant", content: "a".repeat(8), source: "model" }), // closes an exchange
      new Message({ role: "user", content: "u".repeat(32), source: "user" }), // tiny tail
    ];
    const agent = createMockAgent(transcript, CONTEXT_LIMIT);
    const systemMessages: string[] = [];
    agent.sink = { emit: (e: { type: number; content?: string }) => {
      if (e.type === 15) systemMessages.push(e.content!);
    } };
    const ext = createCompactionExtension(createMockCore(CONTEXT_LIMIT)) as any;

    const first = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(first).toEqual({ retry: true });
    const after1: Message[] = agent.log.getAll();
    const after1Bytes = serializeAll(after1);

    // Genuine 4xx rejection on the (now fitting) context: the ladder acts,
    // the baton pops the tiny tail, the notice outweighs it -- refusal.
    const second = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(second).toBeUndefined();
    const after2: Message[] = agent.log.getAll();
    // Rolled back byte-for-byte: no phantom pop, no appended notice.
    expect(serializeAll(after2)).toEqual(after1Bytes);
    const finalNotice = systemMessages[systemMessages.length - 1]!;
    expect(finalNotice).toContain("left unchanged");
    expect(finalNotice).not.toContain("nothing eligible");
    expect(finalNotice).not.toContain("compacted");
  });

  it("the law's second arm: strictly FEWER messages at strictly GREATER weight is no reduction (rollback, no re-issue)", async () => {
    // The arm the equal-length rollback shape above cannot reach: here the
    // baton pop's clean-exchange rewind drops a whole OPEN exchange
    // (assistant tool_calls + its tool result, ~2 tokens together) -- the
    // rewrite SHORTENS the transcript yet GROWS its measured weight (the
    // re-appended notice outweighs the popped pair). The `reduced` gate's
    // weight guard must call that NOT-reduced: byte-for-byte rollback, the
    // "left unchanged" notice, and NO retry re-issue. Delete the
    // `weightAfter <= estimated` guard from the second branch and this
    // pin goes red: a fewer-but-heavier request would re-issue, violating
    // the law's own copy (increased weight never re-issues).
    const transcript: Message[] = [
      new Message({ role: "user", content: "u".repeat(40), source: "user" }),
      ...imageTranscript(14, 0, 800).slice(1), // 14 screenshot blocks
      new Message({ role: "user", content: "u".repeat(24), source: "user" }), // closes the exchange
      new Message({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c99", type: "function", function: { name: "go", arguments: "{}" } }],
        source: "model",
      }), // tiny OPEN exchange:
      new Message({ role: "tool", content: "t", toolCallId: "c99", source: "tool" }), // both popped together
    ];
    const agent = createMockAgent(transcript, CONTEXT_LIMIT, "fewer-heavier-test");
    const systemMessages: string[] = [];
    agent.sink = { emit: (e: { type: number; content?: string }) => {
      if (e.type === 15) systemMessages.push(e.content!);
    } };
    const ext = createCompactionExtension(createMockCore(CONTEXT_LIMIT)) as any;

    const first = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(first).toEqual({ retry: true });
    const after1: Message[] = agent.log.getAll();
    const after1Bytes = serializeAll(after1);
    const est1 = estimateContextTokens(after1);

    // Watch the rewrites on their way through: the second entry's pop is
    // transient -- the honesty gate must undo it, so only a spy can prove
    // the rewrite really was the fewer-AND-heavier arm (not, say, the
    // equal-length shape the other rollback pin covers).
    const rewrites: Message[][] = [];
    const replaceOriginal = agent.replaceContext.bind(agent);
    agent.replaceContext = (msgs: Message[]) => {
      rewrites.push([...msgs]);
      replaceOriginal(msgs);
    };

    const second = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    // NOT-reduced: no retry re-issue.
    expect(second).toBeUndefined();

    // The arm, proven on the transient rewrite: strictly fewer messages
    // (the open pair popped, one notice back) at strictly GREATER weight.
    expect(rewrites.length).toBe(2); // the pop, then the rollback restore
    const [rewritten, restored] = [rewrites[0]!, rewrites[1]!];
    expect(rewritten.length).toBeLessThan(after1.length);
    expect(estimateContextTokens(rewritten)).toBeGreaterThan(est1);
    // The restore is the byte-for-byte context the rejection arrived at.
    expect(serializeAll(restored)).toEqual(after1Bytes);
    expect(serializeAll(agent.log.getAll())).toEqual(after1Bytes);

    const finalNotice = systemMessages[systemMessages.length - 1]!;
    expect(finalNotice).toContain("left unchanged");
    expect(finalNotice).not.toContain("nothing eligible");
    expect(finalNotice).not.toContain("compacted");
  });

  it("a rolled-back pop drops its baton stash (no stale file to duplicate the tail on a later replay)", async () => {
    // Same refusal shape as the rollback pin (the popped tiny tail weighs
    // less than the notice re-appended), asserted on the STASH instead of
    // the bytes: the pop mirrors the tail to <sid>.baton.json BEFORE the
    // honesty gate undoes the rewrite, and the popped tail rides back into
    // the live context -- so a surviving stash would merge "ahead of any
    // older stash" on the next pop, letting a later handoff replay
    // duplicate the tail. Dedicated sessionId: the only stash file this
    // session can ever have is the one the rollback must remove.
    const sid = "rollback-stash-test";
    const stashFile = join(TMP, `${sid}.baton.json`);
    const transcript: Message[] = [
      new Message({ role: "user", content: "u".repeat(40), source: "user" }),
      ...imageTranscript(14, 0, 800).slice(1), // 14 screenshot blocks
      new Message({ role: "assistant", content: "a".repeat(8), source: "model" }), // closes an exchange
      new Message({ role: "user", content: "u".repeat(32), source: "user" }), // tiny tail
    ];
    const agent = createMockAgent(transcript, CONTEXT_LIMIT, sid);
    const systemMessages: string[] = [];
    agent.sink = { emit: (e: { type: number; content?: string }) => {
      if (e.type === 15) systemMessages.push(e.content!);
    } };
    const ext = createCompactionExtension(createMockCore(CONTEXT_LIMIT)) as any;

    const first = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(first).toEqual({ retry: true });
    expect(existsSync(stashFile)).toBe(false); // the strip-only rescue stashes nothing

    const second = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(second).toBeUndefined();
    // The "left unchanged" notice only follows a REWRITE: the pop really
    // stashed the tail on its way through -- and the rollback dropped it.
    const finalNotice = systemMessages[systemMessages.length - 1]!;
    expect(finalNotice).toContain("left unchanged");
    expect(existsSync(stashFile)).toBe(false);
  });

  it("an accepted request clears the episode; the plausibility gate re-arms", async () => {
    const agent = createMockAgent(
      Array.from({ length: 60 }, (_, i) =>
        new Message({
          role: i % 2 === 0 ? "user" : "assistant",
          content: "x".repeat(800),
          source: i % 2 === 0 ? "user" : "model",
        }),
      ),
      10_000,
    );
    const systemMessages: string[] = [];
    agent.sink = { emit: (e: { type: number; content?: string }) => {
      if (e.type === 15) systemMessages.push(e.content!);
    } };
    const ext = createCompactionExtension(createMockCore(10_000)) as any;

    const rescue = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(rescue).toEqual({ retry: true });
    const rescued: Message[] = agent.log.getAll();
    expect(estimateContextTokens(rescued)).toBeLessThan(10_000);

    // The re-issued request was ACCEPTED: the provider response seam ends
    // the episode.
    ext.hooks[HOOKS.PROVIDER_RESPONSE]({ response: { finishReason: "stop" }, modelConfig: {}, agent });

    // A later transient 5xx merely QUOTING an overflow phrase now hits the
    // plausibility gate again (both sources under budget) and must not
    // touch the context or run the ladder.
    const noticesBefore = systemMessages.length;
    const refused = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: quotingError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(refused).toBeUndefined();
    expect(agent.log.getAll()).toHaveLength(rescued.length);
    expect(systemMessages.slice(noticesBefore)).toEqual([]);
  });
});

// ── 3. Placeholder wording (anti-hallucination, opencode idiom) ──────────────

describe("image placeholder wording", () => {
  it("states removal, forbids memory claims, and points at re-attach / re-read -- one line", () => {
    const lower = IMAGE_OMITTED_NOTICE.toLowerCase();
    expect(IMAGE_OMITTED_NOTICE).not.toContain("[image omitted by compaction]");
    expect(lower).toContain("removed");
    expect(lower).toContain("do not describe");
    expect(lower).toContain("memory");
    expect(lower).toContain("re-attach");
    expect(lower).toContain("re-read");
    // The path pointer is HEDGED: inline pasted base64 has no on-disk path,
    // and an unqualified one would be confabulation-bait itself.
    expect(lower).toContain("if the tool recorded one");
    expect(IMAGE_OMITTED_NOTICE.split("\n")).toHaveLength(1);
  });

  it("rides stripped tool results in place (rescue end-to-end)", async () => {
    const agent = createMockAgent(imageTranscript(30), CONTEXT_LIMIT);
    const ext = createCompactionExtension(createMockCore(CONTEXT_LIMIT)) as any;
    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(result).toEqual({ retry: true });
    const afterW: Message[] = agent.log.getAll();
    const stripped = afterW.filter((m) => m.role === "tool" && hasPlaceholder(m));
    expect(stripped.length).toBeGreaterThan(0);
    expect(stripped[0]!.getTextContent()).toContain(IMAGE_OMITTED_NOTICE);
  });
});
