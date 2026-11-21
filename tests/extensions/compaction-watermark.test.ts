// The WATERMARK ESTIMATOR. Measuring context with the local chars/4
// estimate alone is blind: the system prompt, tool schemas, tokenizer
// density and provider-side image billing are invisible to it, so a rescue
// ladder can aim "under budget" in estimate space while still exceeding
// the real window. The provider's billed prompt size (promptTokens +
// cachedTokens) sees all of it; a 400 carries no bill, so the number is
// anchored on every ACCEPTED response (the provider:response seam that
// clears the rescue episode) and carried as billedTotal + the image-aware
// local estimate of messages appended after the anchor -- until any
// shrink/replace or non-prefix mutation invalidates it and the loop falls
// back to the pure local estimate.
//
// Pins here:
//   1. Anchor set on accepted response; trigger bills max(watermark,
//      local, raw usage) -- an anchored over-real-window session fires the
//      CONTEXT trigger and the plausibility gate even when both raw
//      numbers say "fits".
//   2. Invalidation on shrink / rewrite (episode numbers byte-identical to
//      the no-anchor path); probes and the per-message prefix weights each
//      carry their own case.
//   3. Re-aim in watermarked space: an anchored session evicts differently
//      (less) than a pure-local aim would.
//   4. Image branch fires in max space (anchored over-budget strips stale
//      pixels where the pure-local measure would skip the downgrade).
//   5. billedTotal = net promptTokens + cachedTokens; the latest accepted
//      response replaces the anchor; a usage-less response does not kill it.
//   6. No anchor (fresh session / post-shrink / billed == local): every
//      benign path byte-identical to today.
//
// Deterministic, no network, no mock.module -- the established
// PROVIDER_ERROR / PROVIDER_RESPONSE / CONTEXT hook seams.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import { LlmError } from "@core/error.ts";
import { MessageLog } from "@core/context/message-log.ts";
import { Message } from "@core/context/message.ts";
import { estimateContextTokens } from "@utils/token-estimate.ts";
import {
  create as createCompactionExtension,
  RESCUE_KEEP_RECENT_IMAGES,
} from "@extensions/compaction/index.ts";
import { IMAGE_OMITTED_NOTICE } from "@extensions/compaction/utils.ts";

const overflowError = () =>
  LlmError.Api(
    'HTTP 400 (body: {"error":{"message":"prompt exceeds the available context, try reducing the conversation","type":"invalid_request_error","code":"context_length_exceeded"}})',
    400,
  );

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

function createMockAgent(contextArray: Message[], contextLimit: number, sessionId?: string) {
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

/**
 * The provider ACCEPTED a request: core fires provider:response BEFORE
 * appending the assistant reply and BEFORE the TokenTracker records, then
 * the tracker holds the same raw numbers. Mirror both here: raw
 * prompt_tokens already contains cached_tokens (the tracker stores
 * net = raw - cached), and billedTotal is exactly net + cached == raw.
 */
function accept(ext: any, agent: any, promptTokens: number, cachedTokens = 0) {
  ext.hooks[HOOKS.PROVIDER_RESPONSE]({
    response: {
      finishReason: "stop",
      usage: { prompt_tokens: promptTokens, prompt_tokens_details: { cached_tokens: cachedTokens } },
    },
    modelConfig: {},
    agent,
  });
  agent.usageShim.promptTokens = promptTokens - cachedTokens;
  agent.usageShim.cachedTokens = cachedTokens;
}

const alternating = (count: number, chars: number): Message[] =>
  Array.from({ length: count }, (_, i) =>
    new Message({
      role: i % 2 === 0 ? "user" : "assistant",
      content: (i % 2 === 0 ? "u" : "a").repeat(chars),
      source: i % 2 === 0 ? "user" : "model",
    }),
  );

const serializeAll = (messages: Message[]): string[] => messages.map((m) => JSON.stringify(m.toJSON()));

let TMP: string;
beforeAll(() => {
  TMP = mkdtempSync(join(TMP_PARENT, "compaction-wm-"));
  process.env.HOTDOG_SESSIONS_DIR = TMP;
});
afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

// ── 1. The trigger bills the watermark ───────────────────────────────────────

describe("CONTEXT trigger with a live watermark (forensics §A second opinion)", () => {
  it("anchored over-budget: fires where the local estimate AND the raw usage both fit", async () => {
    // Window 10_000. Conversation locally 1000 tokens (40x25); the last
    // ACCEPTED response billed 9400 (net 3400 + cached 6000 -- the cached
    // half is the prompt+schema family chars/4 never sees). One 1250-token
    // append: local 2250 fits, the raw usage read 9400 fits, but the
    // watermark 9400 + 1250 = 10650 crosses the gate (raw usage alone
    // would stay quiet and the provider eats the 400).
    const agent = createMockAgent(alternating(40, 100), 10_000, "wm-trigger");
    const ext = createCompactionExtension(createMockCore(10_000, { strategy: "drop" })) as any;
    accept(ext, agent, 9400, 6000);

    // Anchor alone (no appends yet): watermark == billed == 9400 < gate --
    // no trigger (identical to the raw second opinion: the anchor must not
    // conjure growth that has not happened).
    expect(await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent })).toBeUndefined();

    agent.log.push(new Message({ role: "user", content: "u".repeat(5000), source: "user" }));
    const result = await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent });
    expect(result).toBeDefined();
    expect(agent.log.getAll().length).toBeLessThan(41); // drop ran
  });

  it("billedTotal includes the cached half: 9990 + a 60-token append trips the gate", async () => {
    // If the anchor stored the NET number (3990 with cached 6000) this
    // session would sit at 4050 and stay silent: the bill is
    // promptTokens + cachedTokens = raw prompt_tokens.
    const agent = createMockAgent(alternating(40, 100), 10_000, "wm-cached");
    const ext = createCompactionExtension(createMockCore(10_000, { strategy: "drop" })) as any;
    accept(ext, agent, 9990, 6000);
    agent.log.push(new Message({ role: "user", content: "u".repeat(240), source: "user" })); // 60 tokens
    expect(await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent })).toBeDefined();
  });

  it("no anchor (fresh session, same bytes): stays silent exactly as today", async () => {
    const agent = createMockAgent(alternating(40, 100), 10_000, "wm-noanchor");
    const ext = createCompactionExtension(createMockCore(10_000, { strategy: "drop" })) as any;
    agent.log.push(new Message({ role: "user", content: "u".repeat(5000), source: "user" }));
    // Local 2250, no usage: the no-anchor path stays quiet.
    expect(await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent })).toBeUndefined();
    expect(agent.log.getAll()).toHaveLength(41);
  });

  it("anchor under budget with the same append: quiet (the watermark is a floor, not a hair trigger)", async () => {
    const agent = createMockAgent(alternating(40, 100), 10_000, "wm-under");
    const ext = createCompactionExtension(createMockCore(10_000, { strategy: "drop" })) as any;
    accept(ext, agent, 5000);
    agent.log.push(new Message({ role: "user", content: "u".repeat(5000), source: "user" }));
    expect(await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent })).toBeUndefined();
    expect(agent.log.getAll()).toHaveLength(41);
  });

  it("the latest accepted response replaces the anchor; a usage-less response keeps it alive", async () => {
    const agent = createMockAgent(alternating(40, 100), 10_000, "wm-reanchor");
    const ext = createCompactionExtension(createMockCore(10_000, { strategy: "drop" })) as any;

    accept(ext, agent, 9400); // anchor 9400
    accept(ext, agent, 3000); // re-anchor at the grown accepted size: 3000
    agent.log.push(new Message({ role: "user", content: "u".repeat(5000), source: "user" }));
    // 3000 + 1250 = 4250 < gate: the stale 9400 must NOT ride (an anchor
    // that only ever grew would fire here).
    expect(await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent })).toBeUndefined();

    // A response with no usage (some streaming backends) leaves the live
    // 3000 anchor alone -- the tracker learned nothing either.
    ext.hooks[HOOKS.PROVIDER_RESPONSE]({ response: { finishReason: "stop" }, modelConfig: {}, agent });
    expect(await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent })).toBeUndefined();

    // A later billed acceptance re-anchors at the CURRENT context (the
    // 5000-char append is inside the billed prefix now): one more
    // 1250-token append puts 9400 + 1250 over the gate.
    accept(ext, agent, 9400);
    expect(await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent })).toBeUndefined();
    agent.log.push(new Message({ role: "user", content: "u".repeat(5000), source: "user" }));
    expect(await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent })).toBeDefined();
  });
});

// ── 2. Re-aim aims in watermarked space ─────────────────────────────────────

describe("fractional re-aim in watermarked space (forensics §A root cause 3)", () => {
  it("firstRejected carries the watermark, so re-aim evicts less than pure-local would", async () => {
    // Window 10_000, reserve 200 -> budget 9_800. At the accepted response
    // the provider billed 9_800 against a context the local lens puts at
    // 8_550 (the 1_250 gap is the system-prompt family chars/4 loses). One
    // 450-token append: local 9_000 (fits!), watermark 10_250 (over).
    //
    // Rescue 1 (step 0) aims at 0.85 x BUDGET -- identical in both spaces;
    // trim drops 2 -> 8_100 issued. The anchor dies with the prefix trim
    // (correct), but the EPISODE keeps firstRejected = 10_250.
    //
    // Rescue 2 (step 1) aims at 0.7 x firstRejected:
    //   watermarked:  floor(0.7 x 10_250) = 7_175 -> trim keeps 15 msgs = 6_750
    //   forced-local: floor(0.7 x  9_000) = 6_300 -> trim keeps 14 msgs = 6_300
    // A pure-local re-aim lands different weights (below): it over-evicts
    // (or under-reduces) against a size the provider never saw.
    const agent = createMockAgent(alternating(19, 1800), 10_000); // sessionId undefined: the baton pop is declined
    const ext = createCompactionExtension(createMockCore(10_000, { reserveTokens: 200 })) as any;
    const notices: string[] = [];
    agent.sink = { emit: (e: { type: number; content?: string }) => {
      if (e.type === 15) notices.push(e.content!);
    } };
    accept(ext, agent, 9_800);
    agent.log.push(new Message({ role: "user", content: "u".repeat(1800), source: "user" }));
    expect(estimateContextTokens(agent.log.getAll())).toBe(9_000);

    const issued: number[] = [];
    const reject = async () => {
      const params: any = { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] };
      const r = await ext.hooks[HOOKS.PROVIDER_ERROR]({
        error: overflowError(),
        params,
        agent,
        retry: false,
      });
      if (r !== undefined) issued.push(estimateContextTokens(params.messages));
      return r;
    };

    // Rescue 1: same aim in both spaces (0.85 x budget = 8_330 clamps the
    // watermarked rejection down); trim drops the 2 oldest -> 8_100.
    expect(await reject()).toEqual({ retry: true });
    expect(issued[0]).toBe(8_100);

    // Rescue 2: 0.7 x 10_250 = 7_175 aim -> 15 kept = 6_750
    // (pure-local re-aim would evict to 14 = 6_300).
    expect(await reject()).toEqual({ retry: true });
    expect(issued[1]).toBe(6_750);

    // Rescue 3: 0.5 x 10_250 = 5_125 -> 11 kept = 4_950 (pure-local: 4_500).
    expect(await reject()).toEqual({ retry: true });
    expect(issued[2]).toBe(4_950);

    // The law holds in watermark space: strictly smaller every rung, then
    // the honest stop -- rung 4 (0.35 x 10_250 = 3_587 -> 3_150), then cap.
    expect(await reject()).toEqual({ retry: true });
    expect(issued[3]).toBe(3_150);
    expect(await reject()).toBeUndefined();
    for (let i = 0; i < issued.length; i++) {
      const before = i === 0 ? 10_250 : issued[i - 1]!;
      expect(issued[i]!).toBeLessThan(before);
    }
    expect(notices[notices.length - 1]).toContain("surfacing the error");
  });

  it("an external shrink invalidates the anchor: the rescue is byte-identical to the no-anchor path", async () => {
    // Same window (8_000, reserve 100 -> budget 7_900). Anchor billed 7_950
    // over a 20-message local-8_000 context; then something OUTSIDE this
    // seam (a manual /compact) cuts 5 messages -> local 6_000 and the
    // prefix is gone. A stale watermark (7_950) would inflate firstRejected
    // and relax the aim clamp -- trim would call 6_000 "fits" (aim 6_715)
    // and the chain would degrade to drop, shredding to the keep window.
    // Correct invalidation: firstRejected = 6_000 (local), aim clamps to
    // 5_999, trim drops exactly 1 -> 5_600, byte-for-byte the control.
    const transcript = alternating(20, 1600); // 20 x 400 = 8_000
    const core = () => createMockCore(8_000, { reserveTokens: 100 });

    const anchored = createMockAgent(transcript, 8_000);
    const extA = createCompactionExtension(core()) as any;
    accept(extA, anchored, 7_950);
    anchored.replaceContext(transcript.slice(5)); // 15 x 400 = 6_000, prefix gone

    const control = createMockAgent(transcript.slice(5), 8_000);
    control.usageShim.promptTokens = 7_950; // same stale tracker, never anchored
    const extC = createCompactionExtension(core()) as any;

    const paramsA: any = { messages: [...anchored.log.getAll()], modelConfig: {}, toolDefs: [] };
    const paramsC: any = { messages: [...control.log.getAll()], modelConfig: {}, toolDefs: [] };
    const rA = await extA.hooks[HOOKS.PROVIDER_ERROR]({ error: overflowError(), params: paramsA, agent: anchored, retry: false });
    const rC = await extC.hooks[HOOKS.PROVIDER_ERROR]({ error: overflowError(), params: paramsC, agent: control, retry: false });

    expect(rA).toEqual({ retry: true });
    expect(rC).toEqual({ retry: true });
    // Trim dropped exactly 1 (5_999 aim + the harness guard on an
    // assistant-ending tail): well above any shred (the stale-watermark
    // variant relaxes the aim, trim says "fits", and the count-gated drop
    // cuts to ~2k), and byte-for-byte the unanchored control.
    const wA = estimateContextTokens(paramsA.messages);
    expect(wA).toBeGreaterThan(5_000);
    expect(wA).toBeLessThan(6_000);
    expect(serializeAll(anchored.log.getAll())).toEqual(serializeAll(control.log.getAll()));
  });

  it("a rewrite at a probed index dies on the identity probe; the same rewrite at an unprobed index dies on the prefix weights", async () => {
    // 66 messages x 150 tokens = 9_900 local; gate 10_000; anchor 9_990.
    // Probes sample every 8th message (indices 0,8,16,...,64 + 65). The
    // context then grows by one 60-token append: alive -> 9_990 + 60 >
    // gate (fires); dead -> local 9_960 / raw 9_990 both fit (stays quiet).
    const build = () => alternating(66, 600);
    const mk = async () => {
      const agent = createMockAgent(build(), 10_000, "wm-probe");
      const ext = createCompactionExtension(createMockCore(10_000, { strategy: "drop" })) as any;
      accept(ext, agent, 9_990);
      return { agent, ext };
    };

    // (a) PROBED index (8): same weight, fresh object -- the weights alone
    // would not catch it; the object-identity probe does.
    {
      const { agent, ext } = await mk();
      const live = agent.log.getAll();
      const rewritten = [...live];
      rewritten[8] = new Message({ role: live[8]!.role as "user", content: "y".repeat(600), source: "model" });
      agent.replaceContext(rewritten);
      agent.log.push(new Message({ role: "user", content: "u".repeat(240), source: "user" }));
      expect(await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent })).toBeUndefined();
    }

    // (b) UNPROBED index (3): the rewrite drops the message weight (150 ->
    // 0), so identity probes (which do not sample 3) cannot see it -- the
    // per-message prefix weights do.
    {
      const { agent, ext } = await mk();
      const live = agent.log.getAll();
      const rewritten = [...live];
      rewritten[3] = new Message({ role: live[3]!.role as "assistant", content: "", source: "model" });
      agent.replaceContext(rewritten); // local now 9_751: 1 empty + 65 x 150
      agent.log.push(new Message({ role: "user", content: "u".repeat(240), source: "user" }));
      // Dead anchor: 9_811 local, 9_990 raw, gate 10_000 -- quiet. A
      // probe-only check would keep the watermark at 9_990 + 60 and FIRE.
      expect(await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent })).toBeUndefined();
      expect(agent.log.getAll()).toHaveLength(67);
    }
  });
});

// ── 3. The image downgrade reads the max-based number ────────────────────────

describe("image branch bills the watermark", () => {
  it("anchored over-aim strips stale pixels where the pure-local estimate would skip the downgrade", async () => {
    // Window 8_000. Tiny text + three 240-char screenshots: local 1_420
    // (append included), watermark 7_000 + 1_200 = 8_200 over the budget.
    // Step 0 aims at 6_800: measured (8_200) is over the aim, so the
    // stale-pixel rule fires and the rescue is a strip, not a shredding.
    // Pure-local (1_420 < 6_800) would skip the downgrade and let the
    // count-gated DROP shred instead, leaving the images intact.
    const agent = createMockAgent(
      [
        new Message({ role: "user", content: "u".repeat(12), source: "user" }),
        ...[0, 1, 2].flatMap((i) => [
          new Message({
            role: "assistant",
            content: "",
            toolCalls: [{ id: `c${i}`, type: "function", function: { name: "shot", arguments: "{}" } }],
            source: "model",
          }),
          new Message({
            role: "tool",
            content: "t".repeat(40),
            toolCallId: `c${i}`,
            source: "tool",
            images: [{ type: "image_url", mimeType: "image/png", data: "A".repeat(240) }],
          }),
        ]),
      ],
      8_000,
    );
    const ext = createCompactionExtension(createMockCore(8_000)) as any;
    accept(ext, agent, 7_000);
    agent.log.push(new Message({ role: "user", content: "u".repeat(4800), source: "user" })); // +1_200

    const params: any = { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] };
    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]({ error: overflowError(), params, agent, retry: false });

    expect(result).toEqual({ retry: true });
    const after: Message[] = agent.log.getAll();
    const survivors = after.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    expect(survivors).toBe(RESCUE_KEEP_RECENT_IMAGES); // strip ran: oldest payload -> placeholder
    const stripped = after.find(
      (m) => m.role === "tool" && (m.images?.length ?? 0) === 0 && m.getTextContent().includes(IMAGE_OMITTED_NOTICE),
    );
    expect(stripped).toBeDefined(); // the oldest screenshot's payload is gone, its text stays

    // The strip was a REWRITE: the anchor died with it, so a modest append
    // afterwards must not re-fire on the stale 7_000 -- local (2_110) and
    // raw (7_000) both sit under the 8_000 gate.
    const before = after.length;
    agent.log.push(new Message({ role: "user", content: "u".repeat(3000), source: "user" }));
    expect(await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent })).toBeUndefined();
    expect(agent.log.getAll()).toHaveLength(before + 1);
  });
});

// ── 4. The honesty law keeps its teeth with a live watermark ─────────────────

describe("anchored session keeps every benign rescue path byte-identical (billed == local)", () => {
  it("the phantom-rewrite rollback behaves exactly as the unanchored pin", async () => {
    // The hysteresis phantom shape (pop a tiny tail, re-append a heavier
    // notice) with an anchor whose billedTotal EQUALS the local estimate:
    // every measured number degenerates to today's, so the anchored run
    // must rescue, refuse, and roll back BYTE-FOR-BYTE like the
    // unanchored control. A watermark-loosened honesty gate (pure
    // maxAfter < maxBefore) would re-issue the locally-grown rewrite here.
    const transcript = () => [
      new Message({ role: "user", content: "u".repeat(40), source: "user" }),
      ...Array.from({ length: 14 }, (_, i) => [
        new Message({
          role: "assistant",
          content: "",
          toolCalls: [{ id: `c${i}`, type: "function", function: { name: "shot", arguments: "{}" } }],
          source: "model",
        }),
        new Message({
          role: "tool",
          content: "t".repeat(40),
          toolCallId: `c${i}`,
          source: "tool",
          images: [{ type: "image_url", mimeType: "image/png", data: "A".repeat(800) }],
        }),
      ]).flat(),
      new Message({ role: "assistant", content: "a".repeat(8), source: "model" }), // closes an exchange
      new Message({ role: "user", content: "u".repeat(32), source: "user" }), // tiny tail
    ];

    const anchored = createMockAgent(transcript(), 2_000, "wm-phantom-anchor");
    const control = createMockAgent(transcript(), 2_000, "wm-phantom-control");
    const core = () => createMockCore(2_000);
    const extA = createCompactionExtension(core()) as any;
    const extC = createCompactionExtension(core()) as any;
    accept(extA, anchored, estimateContextTokens(anchored.log.getAll()));

    const noticesA: string[] = [];
    anchored.sink = { emit: (e: { type: number; content?: string }) => {
      if (e.type === 15) noticesA.push(e.content!);
    } };

    const rA1 = await extA.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent: anchored,
      retry: false,
    });
    const rC1 = await extC.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent: control,
      retry: false,
    });
    expect(rA1).toEqual({ retry: true });
    expect(rC1).toEqual({ retry: true });
    expect(serializeAll(anchored.log.getAll())).toEqual(serializeAll(control.log.getAll()));

    // Second rejection: the only move grows the request -- refusal with the
    // byte-for-byte rollback, identical in both worlds.
    const rA2 = await extA.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent: anchored,
      retry: false,
    });
    const rC2 = await extC.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent: control,
      retry: false,
    });
    expect(rA2).toBeUndefined();
    expect(rC2).toBeUndefined();
    expect(serializeAll(anchored.log.getAll())).toEqual(serializeAll(control.log.getAll()));
    expect(noticesA[noticesA.length - 1]).toContain("left unchanged");
  });

  it("an accepted re-issue clears the episode and re-anchors the post-rescue size", async () => {
    // The provider:response seam keeps both jobs on one hook: the ladder
    // dies, and the NEW accepted request's bill (the post-rescue context
    // plus the system family) is the fresh ground truth.
    // No sessionId: the rescue chains straight to trim (the baton pop is
    // declined for stashless agents), keeping the arithmetic clean.
    const agent = createMockAgent(alternating(60, 800), 10_000);
    const ext = createCompactionExtension(createMockCore(10_000)) as any;
    const rescue = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: overflowError(),
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(rescue).toEqual({ retry: true });
    const rescuedSize = estimateContextTokens(agent.log.getAll());
    expect(rescuedSize).toBeLessThan(10_000);

    // The re-issue was ACCEPTED (billed: the rescued context + a 1_400-
    // token system family the local lens still cannot see). The episode
    // is gone: a transient 5xx merely quoting an overflow phrase now hits
    // the re-armed plausibility gate (both sources under the 10_000
    // budget) and must not touch the context -- the pre-rescue ladder
    // (first rejected ~12_000) is dead memory.
    accept(ext, agent, rescuedSize + 1_400);
    const quoting = LlmError.Api(
      'HTTP 500 (body: {"error":{"message":"upstream rejected the request; see docs re: maximum context length limits","type":"server_error"}})',
      500,
    );
    const before = serializeAll(agent.log.getAll());
    const refused = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: quoting,
      params: { messages: [], modelConfig: {}, toolDefs: [] },
      agent,
      retry: false,
    });
    expect(refused).toBeUndefined();
    expect(serializeAll(agent.log.getAll())).toEqual(before);

    // The fresh anchor does its job: a 200-token append puts the billed
    // number over the gate while the local estimate still fits -- the
    // trigger fires on the max, not on the blind chars/4.
    agent.log.push(new Message({ role: "user", content: "u".repeat(800), source: "user" })); // 200 tokens
    const grown = estimateContextTokens(agent.log.getAll());
    expect(grown).toBeLessThan(10_000);
    expect(rescuedSize + 1_400 + 200).toBeGreaterThan(10_000);
    const ctx = await ext.hooks[HOOKS.CONTEXT]({ messages: agent.log.getAll(), agent });
    expect(ctx).toBeDefined();
  });
});
