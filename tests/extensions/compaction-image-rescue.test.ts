// 2026-11-18 incident (owner, live webui session 9acafaaf, ~12:20-13:35):
// every message yielded the compacted-and-retry notice followed by
// HTTP 400 "prompt exceeds the 262144-token context" while the footer gauge
// read 67k/262k. Ground truth from the durable log: 9.9 MB session, ~7.9 MB
// of it base64 images (26 agent_browser screenshots on tool results + 2
// user-pasted screenshots), ~2 MB of text. The chars/4 estimator and the
// provider-reported usage (promptTokens 136 + cachedTokens 66,433 = 66,569
// on the last call -- image-blind) both said "fits"; the provider billed the
// images and rejected. The rescue chain removed text-small messages, barely
// touched the bytes, and the retry 400'd again.
//
// These tests reconstruct the incident deterministically: the exact image
// byte sizes measured from the victim log, with generated fake base64
// payloads (never real megabytes inline), plus the real 400 body.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import { LlmError } from "@core/error.ts";
import { MessageLog } from "@core/context/message-log.ts";
import { Message, type ImageAttachment } from "@core/context/message.ts";
import {
  estimateMessageTokens,
  estimateContextTokens,
} from "@utils/token-estimate.ts";
import { create as createCompactionExtension } from "@extensions/compaction/index.ts";
import { replayEntriesIntoContext, LOG_SOURCE, type LogEntry } from "@core/session/session-log.ts";
import { ContextManager } from "@core/context/context-manager.ts";
import { ctxByIndex } from "@utils/session-turns.ts";
import { deriveCtxFromLog } from "@core/session/session-index.ts";

const IMAGE_TOKEN_CAP = 4096;
const CONTEXT_LIMIT = 262144;
const RESERVE_TOKENS = 16384;
const BUDGET = CONTEXT_LIMIT - RESERVE_TOKENS; // 245,760

// Exact base64 payload sizes measured from the victim session log
// (9acafaaf-c49c-48f1-a666-d2aa635ebbb6.jsonl): 26 tool-result images
// (agent_browser PNGs) and 2 user-pasted screenshots, 7,880,544 bytes total.
const TOOL_IMAGE_BYTES = [
  257512, 266088, 266044, 266104, 105204, 296052, 207752, 838348, 207548,
  219936, 276528, 336020, 286736, 285080, 309524, 306720, 306976, 307288,
  306976, 290576, 315360, 270892, 308552, 352452, 357776, 161496,
];
const INPUT_IMAGE_BYTES = [65636, 105368];

const fakeB64 = (n: number): string => "A".repeat(n);
const img = (bytes: number): ImageAttachment => ({
  type: "image_url",
  mimeType: "image/png",
  data: fakeB64(bytes),
});

// The owner-reported 400 body, verbatim.
const INCIDENT_400_BODY =
  '{"error":{"message":"prompt exceeds the 262144-token context; increase --context or shorten the conversation","type":"invalid_request_error","code":"context_length_exceeded"}}';
const incidentOverflowError = () =>
  LlmError.Api(`HTTP 400 (body: ${INCIDENT_400_BODY})`, 400);

/**
 * Incident-shaped transcript: browser work blocks (assistant tool_calls ->
 * tool result carrying a screenshot -> nothing) interleaved through the
 * session, closing with the owner's two pasted screenshots (the two NEWEST
 * images in the timeline). `textLen` is the char size of each prose/screenshot
 * text payload; the default reproduces the victim's ratio (text alone fits
 * the budget, text+images does not).
 */
function incidentTranscript(textLen = 12000): Message[] {
  const msgs: Message[] = [];
  msgs.push(new Message({ role: "user", content: "u".repeat(100), source: "user" }));
  TOOL_IMAGE_BYTES.forEach((bytes, i) => {
    msgs.push(
      new Message({
        role: "assistant",
        content: "a".repeat(textLen),
        toolCalls: [
          {
            id: `call_${i}`,
            type: "function",
            function: { name: "agent_browser", arguments: '{"action":"screenshot"}' },
          },
        ],
        source: "model",
      }),
    );
    msgs.push(
      new Message({
        role: "tool",
        content: `Screenshot of view "main": /home/agent/.cache/${i}.png ` + "s".repeat(textLen),
        toolCallId: `call_${i}`,
        source: "tool",
        images: [img(bytes)],
      }),
    );
  });
  // The owner's mid-incident messages (last two images in the timeline,
  // matching the log's final INPUT entries).
  msgs.push(
    new Message({
      role: "user",
      content: "I see a bug here. Doesn't look like it actually compacted but this should not have triggered",
      images: [img(INPUT_IMAGE_BYTES[0]!)],
      source: "user",
    }),
  );
  msgs.push(new Message({ role: "assistant", content: "a".repeat(1200), source: "model" }));
  msgs.push(
    new Message({
      role: "user",
      content: "The footer gauge says 67k/262k but the request 400s again.",
      images: [img(INPUT_IMAGE_BYTES[1]!)],
      source: "user",
    }),
  );
  return msgs;
}

/** The same transcript with every image payload removed (the text-only control). */
function textOnlyCopy(messages: Message[]): Message[] {
  return messages.map(
    (m) =>
      new Message({
        role: m.role,
        content: m.content,
        reasoningContent: m.reasoningContent,
        toolCalls: m.toolCalls,
        toolCallId: m.toolCallId,
        source: m.source,
      }),
  );
}

function createMockCore(config: any = {}) {
  return {
    hooks: new HookSystem(),
    config: {
      compaction: {
        enabled: true,
        reserveTokens: RESERVE_TOKENS,
        keepRecentMessages: 3,
        strategy: "summarize",
        userTurnGuardPrompt: "Continue from the compressed conversation context above.",
        ...config,
      },
    },
    modelRegistry: {
      "test-model": { name: "test-model", temperature: null, contextLimit: CONTEXT_LIMIT },
    },
    resolved: { contextLimit: CONTEXT_LIMIT },
  } as any;
}

function createMockAgent(contextArray: any[], usage?: { promptTokens: number; cachedTokens: number }) {
  const mockLlmClient = {
    chatStreamCancellable: () =>
      (async function* () {
        yield { type: "content", content: "test response" };
      })(),
  };
  const log = new MessageLog(contextArray);
  const usageShim = { promptTokens: usage?.promptTokens ?? 0, cachedTokens: usage?.cachedTokens ?? 0 };
  return {
    get log() {
      return log;
    },
    usageShim,
    get context() {
      return {
        getMessages: () => log.getAll(),
        replaceMessages: (msgs: any[]) => log.replace(msgs),
        getSystem: () => log.getSystem(),
        getNonSystem: () => log.getNonSystem(),
        getSystemPrompt: () => null,
        getTokenUsage: () => ({ ...usageShim }),
      };
    },
    model: "test-model",
    modelRegistry: { "test-model": { name: "test-model", temperature: null, contextLimit: CONTEXT_LIMIT } },
    sessionId: "test-session",
    cancelled: false,
    get llmClient() {
      return mockLlmClient;
    },
    buildMessages() {
      return [...log.getAll()];
    },
    addMessage(msg: any) {
      log.push(msg);
    },
    replaceContext(newContext: any) {
      log.replace(newContext);
    },
  } as any;
}

const countImages = (messages: Message[]): number =>
  messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);

let TMP: string;
beforeAll(() => {
  TMP = mkdtempSync(join(TMP_PARENT, "compaction-images-"));
  process.env.HOTDOG_SESSIONS_DIR = TMP;
});
afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

// ── 1. The estimator must see image payloads ────────────────────────────────

describe("image payload weight in the token estimate", () => {
  it("counts Message.images payloads at base64 chars/4, capped per image", () => {
    // Text-only regression: unchanged chars/4.
    expect(estimateMessageTokens({ role: "user", content: "x".repeat(80) })).toBe(20);

    // 16,000 base64 chars -> 4,000 tokens (under the cap).
    const small = new Message({ role: "user", content: "", images: [img(16000)] });
    expect(estimateMessageTokens(small)).toBe(4000);

    // A 257,512-char screenshot bills at the cap, NOT 64,378: measured
    // vision encoders charge ~10^3-4x10^3 tokens per image regardless of
    // payload bytes (see token-estimate.ts for the rationale).
    const big = new Message({ role: "tool", content: "", toolCallId: "c", images: [img(257512)] });
    expect(estimateMessageTokens(big)).toBe(IMAGE_TOKEN_CAP);
  });

  it("weights inline data-URL image parts; plain URLs stay weightless", () => {
    const url = `data:image/png;base64,${fakeB64(16000)}`;
    const msg = { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url } }] };
    expect(estimateMessageTokens(msg)).toBe(1 + Math.ceil(url.length / 4));

    // A plain http reference is a few text tokens on the wire, not image
    // weight (existing flatten contract: contentToText drops it).
    const ref = { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "https://example.com/x.png" } }] };
    expect(estimateMessageTokens(ref)).toBe(1);
  });

  it("estimates the incident transcript OVER budget with images, UNDER without", () => {
    const messages = incidentTranscript();
    const textOnly = estimateContextTokens(textOnlyCopy(messages));
    const withImages = estimateContextTokens(messages);

    // The estimator lie (pre-fix): text alone fits, so shouldCompact said
    // "fits" and the gauge read low while the provider billed 7.9 MB of
    // base64 and 400'd.
    expect(textOnly).toBeLessThan(BUDGET);
    expect(withImages).toBeGreaterThan(BUDGET);
    // Every payload is >= 16,384 base64 chars, so all 28 images bill at the
    // cap: the delta is pinned to the documented weight.
    expect(withImages - textOnly).toBe(28 * IMAGE_TOKEN_CAP);
  });
});

// ── 2. The overflow rescue must heal an image-dominated context ─────────────

describe("overflow rescue heals image-dominated contexts", () => {
  it("strips old images, keeps the recent ones, and the retry fits the budget", async () => {
    const agent = createMockAgent(incidentTranscript(), {
      // The victim's last reported input: image-blind, comfortably "under".
      promptTokens: 136,
      cachedTokens: 66433,
    });
    const systemMessages: string[] = [];
    agent.sink = {
      emit: (e: { type: number; content?: string }) => {
        if (e.type === 15 /* SYSTEM_MESSAGE */) systemMessages.push(e.content!);
      },
    };
    const ext = createCompactionExtension(createMockCore()) as any;
    const params: any = { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] };
    const before = estimateContextTokens(agent.log.getAll());
    expect(before).toBeGreaterThan(BUDGET);

    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: incidentOverflowError(),
      params,
      agent,
      retry: false,
    });

    // The rescue must run (pre-fix the plausibility gate REFUSED: both the
    // image-blind estimate and the image-blind provider number said "fits")
    // and must converge below the billed budget.
    expect(result).toEqual({ retry: true });
    const after: Message[] = agent.log.getAll();
    expect(estimateContextTokens(after)).toBeLessThanOrEqual(BUDGET);

    // Aggressive on the rescue path: image payloads survive only on the two
    // NEWEST images (the owner's pasted screenshots), never the 26 old
    // browser screenshots.
    const survivors = after.filter((m) => (m.images?.length ?? 0) > 0);
    expect(countImages(after)).toBe(2);
    expect(survivors.flatMap((m) => m.images!).map((a) => a.data.length).sort((a, b) => a - b))
      .toEqual([...INPUT_IMAGE_BYTES].sort((a, b) => a - b));

    // Stripped tool results keep their text (the on-disk screenshot path the
    // model can still read) and record the omission in place.
    const strippedTool = after.find((m) => m.role === "tool")!;
    expect(strippedTool.images ?? []).toHaveLength(0);
    expect(strippedTool.getTextContent()).toContain("Screenshot of view");
    expect(strippedTool.getTextContent()).toContain("[image removed by compaction - do not describe or make claims about its contents from memory");

    // The retry sends the compacted context, and the notice fires.
    expect(params.messages.length).toBe(agent.buildMessages().length);
    expect(estimateContextTokens(params.messages)).toBeLessThanOrEqual(BUDGET);
    expect(systemMessages.join(" ")).toContain("Context overflow");
  });

  it("still converges via the text chain when stripping images alone cannot clear the budget", async () => {
    // Same shape with heavier text: text-only still fits the estimator
    // (the pre-fix lie), and after every old image is gone the residual is
    // still over budget -- the message-dropping chain must finish the job.
    const agent = createMockAgent(incidentTranscript(18512), {
      promptTokens: 136,
      cachedTokens: 66433,
    });
    const textOnly = estimateContextTokens(textOnlyCopy(agent.log.getAll()));
    expect(textOnly).toBeLessThan(BUDGET);
    const ext = createCompactionExtension(createMockCore()) as any;
    const params: any = { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] };

    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: incidentOverflowError(),
      params,
      agent,
      retry: false,
    });

    expect(result).toEqual({ retry: true });
    const after: Message[] = agent.log.getAll();
    expect(estimateContextTokens(after)).toBeLessThanOrEqual(BUDGET);
    expect(countImages(after)).toBeLessThanOrEqual(2);
    // The chain removed real context (the strip alone left this transcript
    // over budget), and old screenshot payloads are gone.
    const strippedTool = after.find((m) => m.role === "tool")!;
    expect(strippedTool.images ?? []).toHaveLength(0);
    expect(after.length).toBeLessThanOrEqual(56); // pop + harness guard keep it capped
  });

  it("the plausibility gate still refuses an overflow-quoted error on a session that genuinely fits WITH images", async () => {
    // A small session carrying one modest screenshot: the image-aware
    // estimate and the provider number both stay under the billed budget,
    // so a transient error body quoting an overflow phrase must not route
    // it into the chain (the gate's morning purpose, image edition).
    const agent = createMockAgent(
      [
        new Message({ role: "user", content: "what is in this?", source: "user", images: [img(2048)] }),
        new Message({ role: "assistant", content: "a cat.", source: "model" }),
      ],
      { promptTokens: 12, cachedTokens: 508 }, // provider "52%" of a small window
    );
    // Shrink the window so the provider ratio is meaningful: budget 1000.
    agent.modelRegistry = { "test-model": { name: "test-model", temperature: null, contextLimit: 1000 } };
    const core = {
      ...createMockCore({ reserveTokens: 0 }),
      modelRegistry: { "test-model": { name: "test-model", temperature: null, contextLimit: 1000 } },
      resolved: { contextLimit: 1000 },
    };
    const systemMessages: string[] = [];
    agent.sink = {
      emit: (e: { type: number; content?: string }) => {
        if (e.type === 15 /* SYSTEM_MESSAGE */) systemMessages.push(e.content!);
      },
    };
    const ext = createCompactionExtension(core) as any;
    const params: any = { messages: [...agent.log.getAll()], modelConfig: {}, toolDefs: [] };

    const result = await ext.hooks[HOOKS.PROVIDER_ERROR]({
      error: LlmError.Api(
        'HTTP 500 (body: {"error":{"message":"upstream rejected the request; see docs re: maximum context length limits","type":"server_error"}})',
        500,
      ),
      params,
      agent,
      retry: false,
    });

    expect(result).toBeUndefined();
    expect(agent.log.getAll()).toHaveLength(2);
    expect(agent.log.getAll()[0]!.images).toHaveLength(1);
    expect(params.messages).toHaveLength(2);
    expect(systemMessages).toEqual([]);
  });
});

// ── 3. Resume replay hits image-aware compaction before the provider ────────

describe("resume replay triggers image-aware compaction before the request", () => {
  // Log-entry sizes mirror the victim log's shape (16 inputs incl. the two
  // screenshots, 264 llm tool-call turns, 264 tool results incl. 26 with
  // images) scaled so that text+system fits the budget and ONLY the replayed
  // input images push it over. (Verified against the code: TOOL_RESULT
  // entries persist their images but replayEntriesIntoContext deliberately
  // does NOT hand them back -- display-only -- so a resumed context re-
  // inflates through INPUT images; the live-session blowup was the tool-side
  // accumulation the rescue chain then could not touch.)
  function victimLogEntries(): LogEntry[] {
    const entries: LogEntry[] = [];
    const base = { ts: "2026-11-18T12:20:00.000Z", session_id: "incident", v: 2 };
    for (let i = 0; i < 16; i++) {
      entries.push({
        ...base,
        source: LOG_SOURCE.INPUT,
        content: "u".repeat(1000),
        origin: "user",
        ...(i === 14 ? { images: [img(INPUT_IMAGE_BYTES[0]!)] } : {}),
        ...(i === 15 ? { images: [img(INPUT_IMAGE_BYTES[1]!)] } : {}),
      });
    }
    for (let i = 0; i < 264; i++) {
      entries.push({
        ...base,
        source: LOG_SOURCE.LLM,
        content: "a".repeat(100),
        tool_calls: [
          { id: `c${i}`, type: "function", function: { name: "agent_browser", arguments: "{}" } },
        ],
        origin: "model",
      });
      entries.push({
        ...base,
        source: LOG_SOURCE.TOOL_RESULT,
        content: "s".repeat(1800),
        tool_call_id: `c${i}`,
        tool_name: "agent_browser",
        origin: "tool",
        ...(i % 10 === 0 && i / 10 < TOOL_IMAGE_BYTES.length
          ? { images: [img(TOOL_IMAGE_BYTES[i / 10]!)] }
          : {}),
      });
    }
    return entries;
  }

  it("compacts the replayed over-budget context instead of sending it", async () => {
    const agent = createMockAgent([]);
    const { replayed } = replayEntriesIntoContext(agent, victimLogEntries());
    expect(replayed).toBeGreaterThan(500);

    // The regenerated system prompt rides every request (the CONTEXT hook
    // bills the FULL window). Sized to the victim's ~404 KB prompt family.
    const system = new Message({ role: "system", content: "p".repeat(440000), source: "system" });
    const hookMessages = [system, ...agent.log.getAll()];

    // The image-blind lie: text-only (incl. system prompt) fits the budget.
    const textOnly = estimateContextTokens([
      system,
      ...agent.log.getAll().map((m: Message) => new Message({ role: m.role, content: m.content })),
    ]);
    expect(textOnly).toBeLessThan(BUDGET);
    // Image-aware: the two replayed INPUT screenshots push it over.
    expect(estimateContextTokens(hookMessages)).toBeGreaterThan(BUDGET);

    const ext = createCompactionExtension(createMockCore({ strategy: "drop" })) as any;
    const result = await ext.hooks[HOOKS.CONTEXT]({ messages: hookMessages, agent });

    // Pre-fix (image-blind estimate) the trigger stayed silent and the
    // provider ate the whole context on the very first resumed request.
    expect(result).toBeDefined();
    expect(agent.log.length).toBeLessThan(replayed);
    const nextRequest = estimateContextTokens([system, ...agent.buildMessages()]);
    expect(nextRequest).toBeLessThanOrEqual(BUDGET);
  });
});

// ── 4. The ctx gauge stops lying ─────────────────────────────────────────────

describe("ctx gauge honesty (image-inclusive estimate vs image-blind provider)", () => {
  it("ContextManager.estimateRequestTokens sees image payloads in the outgoing context", () => {
    const ctx = new ContextManager();
    ctx.addMessage(new Message({ role: "user", content: "look", images: [img(257512)] }));
    expect(ctx.estimateRequestTokens()).toBe(1 + IMAGE_TOKEN_CAP);

    const plain = new ContextManager();
    plain.addMessage(new Message({ role: "user", content: "x".repeat(80) }));
    expect(plain.estimateRequestTokens()).toBe(20);
  });

  it("ctxByIndex (cold-log footers) maxes the pair per record", () => {
    const entries = [
      { source: "llm" },
      {
        source: "token_usage",
        totalTokens: 67503,
        contextWindow: CONTEXT_LIMIT,
        estimatedContextTokens: 273214,
      },
    ];
    expect(ctxByIndex(entries as any)[0]).toMatchObject({ used: 273214, total: CONTEXT_LIMIT });
    // No estimate on the record -> unchanged behavior.
    expect(ctxByIndex([{ source: "llm" }, { source: "token_usage", totalTokens: 67503 }] as any)[0])
      .toMatchObject({ used: 67503 });
  });

  it("deriveCtxFromLog (session rows) maxes the pair per record", () => {
    const mk = (extra: Record<string, unknown>) =>
      ({ ts: "x", session_id: "s", source: LOG_SOURCE.TOKEN_USAGE, content: "", ...extra }) as LogEntry;
    expect(deriveCtxFromLog([mk({ totalTokens: 67503, contextWindow: CONTEXT_LIMIT, estimatedContextTokens: 273214 })]))
      .toEqual({ ctxUsed: 273214, ctxTotal: CONTEXT_LIMIT });
    expect(deriveCtxFromLog([mk({ totalTokens: 67503, contextWindow: CONTEXT_LIMIT })]))
      .toEqual({ ctxUsed: 67503, ctxTotal: CONTEXT_LIMIT });
    expect(deriveCtxFromLog([mk({ estimatedContextTokens: 9000, contextWindow: CONTEXT_LIMIT })]))
      .toEqual({ ctxUsed: 9000, ctxTotal: CONTEXT_LIMIT });
  });
});
