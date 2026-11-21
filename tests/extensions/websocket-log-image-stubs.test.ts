// BYTE-HONEST LOG PAGES: replay/history frames (cold LOG_VIEWED, loadOlder
// pages, the windowed FULL attach replay) carry image STUBS
// { mimeType, omitted, bytes, entryIndex, imageIndex } instead of inline
// base64; text fields ride the plain wire unchanged. ONE additive
// requestId-correlated pair (C2S fetchImage / S2C fetchImageResult) re-reads
// the durable log and ships exactly ONE image (the existing
// MAX_WIRE_IMAGE_BASE64_BYTES cap applies), with honest refusals for
// absent / non-image coordinates. The coordinate is the FULL-LOG entry index
// (the same append-only space the reconnect cursor lives in) plus the slot in
// that entry's images array -- never a path.
//
// Fresh LIVE frames (OUTPUT_EVENT mapper) keep shipping images inline: the
// stub seam must not leak into the live path. The zero-base64 pins assert
// both the absence of `data` and a serialized-frame byte bound, so
// re-inlining payloads cannot pass them.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { routeMessage } from "@extensions/websocket/message-routing.ts";
import { attachResumedSession } from "@extensions/websocket/attach.ts";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import {
  C2S,
  S2C,
  wireImages,
  wireImageStubs,
  MAX_WIRE_IMAGE_BASE64_BYTES,
} from "@extensions/websocket/protocol.ts";
import { toS2CMessage } from "@extensions/websocket/wire-messages.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import { LOG_SOURCE } from "@core/session/session-log.ts";
import { closeSessionIndex } from "@core/session/session-index.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

const A = "A".repeat(60_000); // input image payload (base64-space chars)
const B = "B".repeat(50_000); // tool_result image #1
const LEGACY_DATA = "AAECAw".repeat(300); // 1800 chars behind a data: URL
const LEGACY = `data:image/jpeg;base64,${LEGACY_DATA}`;
const D = "DkQA".repeat(500); // 2000 chars, windowed-turn image
const HUGE = "H".repeat(9 * 1024 * 1024); // over MAX_WIRE_IMAGE_BASE64_BYTES

const SESSIONS_DIR = mkdtempSync(join(TMP_PARENT, "hotdog-img-stub-"));

const line = (id: string, source: string, content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: "2024-01-01T00:00:00Z", session_id: id, source, content, ...extra });

/** `pages`-shaped log (line numbers documented in the tests):
 *  0 session_start | 1 input q0 [A] | 2 llm a0 | 3 tool_result r0 [B, legacy]
 *  | 4..17 alternating input/llm (q1..q7); the q7 line (16) carries image D. */
function writePagesLog(id: string): string[] {
  const lines = [
    line(id, LOG_SOURCE.SESSION_START, ""),
    line(id, LOG_SOURCE.INPUT, "q0", { images: [{ type: "image_url", mimeType: "image/png", data: A }] }),
    line(id, LOG_SOURCE.LLM, "a0"),
    line(id, LOG_SOURCE.TOOL_RESULT, "r0", {
      tool_call_id: "c0",
      images: [{ type: "image_url", mimeType: "image/png", data: B }, { url: LEGACY }],
    }),
  ];
  for (let i = 1; i <= 7; i++) {
    const img = i === 7 ? { images: [{ type: "image_url", mimeType: "image/webp", data: D }] } : {};
    lines.push(line(id, LOG_SOURCE.INPUT, `q${i}`, img));
    lines.push(line(id, LOG_SOURCE.LLM, `a${i}`));
  }
  writeFileSync(join(SESSIONS_DIR, `${id}.jsonl`), lines.join("\n") + "\n");
  return lines;
}

/** 8 turns (input+llm), an image on the LAST input; entry 1 is the first turn. */
function writeAttachLog(id: string, imageAt: number): void {
  const lines = [line(id, LOG_SOURCE.SESSION_START, "")];
  for (let i = 0; i < 8; i++) {
    const img = i * 2 + 1 === imageAt
      ? { images: [{ type: "image_url", mimeType: "image/png", data: A }] }
      : {};
    lines.push(line(id, LOG_SOURCE.INPUT, `q${i}`, img));
    lines.push(line(id, LOG_SOURCE.LLM, `a${i}`));
  }
  writeFileSync(join(SESSIONS_DIR, `${id}.jsonl`), lines.join("\n") + "\n");
}

// ── harness ─────────────────────────────────────────────────────────────────

const bridgeStub = {
  peek: () => null,
  cancel: () => {},
  answer: () => false,
  clear: () => {},
} as unknown as WebSocketQuestionBridge;
const coreStub = { completion: undefined } as unknown as CoreContext;

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function send(msg: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const ws = createWsMockWs();
  await routeMessage(ws, msg as never, stubRegistry(), undefined, bridgeStub, coreStub);
  await flush();
  return ws.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
}

function stubRegistry(): SessionRegistry {
  return {
    get: () => undefined,
    list: () => [],
    size: 0,
    createChannel: () => ({}),
    removeChannel: () => {},
    sendTaskSnapshot: () => {},
    broadcast: () => {},
    broadcastExcept: () => {},
    getSessionManager: () => ({ isSessionRunning: () => false }),
    getTaskManager: () => null,
    sttEnabled: false,
    toolExecLabel: () => "inline",
  } as unknown as SessionRegistry;
}

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
  closeSessionIndex();
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  closeSessionIndex();
  try { rmSync(SESSIONS_DIR, { recursive: true, force: true }); } catch {}
});

// ── the stub seam on the cold page (viewLog) ────────────────────────────────

describe("LOG_VIEWED ships image stubs, zero base64", () => {
  const lines = writePagesLog("pages");

  it("the windowed page carries the image as a stub with the full-log coordinate", async () => {
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "pages" });
    expect(viewed!.type).toBe(S2C.LOG_VIEWED);
    expect(viewed!.hasOlder).toBe(true);
    const entries = viewed!.entries as Array<Record<string, unknown>>;
    const withImg = entries.filter((e) => e.images !== undefined);
    expect(withImg).toHaveLength(1);
    // q7 rides epoch-relative index 12; the log's FULL index is 16. The stub
    // coordinate is the FULL-log space (fetch re-reads the full log).
    const stub = (withImg[0]!.images as Array<Record<string, unknown>>)[0]!;
    expect(stub).toEqual({
      mimeType: "image/webp",
      omitted: true,
      bytes: D.length,
      entryIndex: 16,
      imageIndex: 0,
    });
  });

  it("the frame carries ZERO base64 payload bytes (mutation guard: re-inline reddens)", async () => {
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "pages" });
    const wire = JSON.stringify(viewed)!;
    expect(wire).not.toContain('"data"');
    expect(wire).not.toContain(A.slice(0, 64));
    expect(wire).not.toContain(D.slice(0, 64));
    // The raw payloads alone are ~62 KB in this window; the honest page is a
    // text page (a re-inlined build blows this bound by orders of magnitude).
    expect(wire.length).toBeLessThan(20_000);
  });

  it("text fields are byte-identical to the log for an imageless window", async () => {
    const imgless = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .map((e) => {
        delete e.images;
        return e;
      });
    writeFileSync(join(SESSIONS_DIR, "plain.jsonl"), imgless.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "plain" });
    const entries = viewed!.entries as Array<Record<string, unknown>>;
    // The window is lines 13..17 of the same shape (the 5th-from-last
    // message); compare each shipped entry byte-for-byte against the raw
    // parsed line at its full-log index.
    const start = (viewed!.oldestIndex as number) ?? 0;
    const raw = imgless.slice(start);
    expect(entries.map((e) => JSON.stringify(e))).toEqual(raw.map((e) => JSON.stringify(e)));
  });
});

// ── the stub seam on older pages (loadOlder) ────────────────────────────────

describe("loadOlder pages ship image stubs too", () => {
  it("the older page stubs every image and ships zero base64", async () => {
    writePagesLog("pages"); // rewrite (the describe above is read-only usage)
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "pages" });
    // The 5-message window opens at a5 (index 13; its slice carries q7's
    // stub). Eleven countable messages remain below, so the DEFAULT
    // 5-message page would cut q0's image out; ask for 11 and the whole
    // older range ships (the <= K short-circuit to index 0), A stub and
    // legacy data-URL included.
    const [page] = await send({
      type: C2S.LOAD_OLDER, requestId: 7, logId: "pages", olderThan: viewed!.oldestIndex, pageSize: 11,
    });
    expect(page!.type).toBe(S2C.LOAD_OLDER_RESULT);
    const wire = JSON.stringify(page)!;
    expect(wire).not.toContain('"data"');
    expect(wire).not.toContain(A.slice(0, 64));
    expect(wire).not.toContain(B.slice(0, 64));
    expect(wire).not.toContain(LEGACY_DATA.slice(0, 64));
    expect(wire.length).toBeLessThan(20_000);

    const entries = page!.entries as Array<Record<string, unknown>>;
    const imgEntries = entries.filter((e) => e.images !== undefined);
    expect(imgEntries).toHaveLength(2);
    expect(imgEntries[0]!.images).toEqual([
      { mimeType: "image/png", omitted: true, bytes: A.length, entryIndex: 1, imageIndex: 0 },
    ]);
    // Legacy data-URL form normalizes through the same grammar; the slot
    // index addresses the RAW images array (the fetch re-reads that array).
    expect(imgEntries[1]!.images).toEqual([
      { mimeType: "image/png", omitted: true, bytes: B.length, entryIndex: 3, imageIndex: 0 },
      { mimeType: "image/jpeg", omitted: true, bytes: LEGACY_DATA.length, entryIndex: 3, imageIndex: 1 },
    ]);
  });
});

// ── the fetch pair: one image per request ───────────────────────────────────

describe("fetchImage round-trips a persisted image", () => {
  it("honest success: correlated frame with the exact stored payload", async () => {
    writePagesLog("pages");
    const cases: Array<[number, number, string, string]> = [
      [1, 0, "image/png", A],
      [3, 0, "image/png", B],
      [3, 1, "image/jpeg", LEGACY_DATA], // legacy data: URL normalized on read
      [16, 0, "image/webp", D],
    ];
    for (const [entryIndex, imageIndex, mimeType, data] of cases) {
      const [reply] = await send({ type: C2S.FETCH_IMAGE, requestId: 41, logId: "pages", entryIndex, imageIndex });
      expect(reply!.type).toBe(S2C.FETCH_IMAGE_RESULT);
      expect(reply!.requestId).toBe(41);
      expect(reply!.logId).toBe("pages");
      expect(reply!.entryIndex).toBe(entryIndex);
      expect(reply!.imageIndex).toBe(imageIndex);
      expect(reply!.error).toBeUndefined();
      expect(reply!.image).toEqual({ mimeType, data });
    }
  });

  it("the over-cap image rides the skipped+note posture, never the bytes", async () => {
    const lines = [
      line("bigcap", LOG_SOURCE.INPUT, "look", {
        images: [{ type: "image_url", mimeType: "image/png", data: HUGE }],
      }),
    ];
    writeFileSync(join(SESSIONS_DIR, "bigcap.jsonl"), lines.join("\n") + "\n");
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "bigcap" });
    const stub = (viewed!.entries as Array<Record<string, unknown>>)[0]!.images as Array<Record<string, unknown>>;
    expect(stub[0]).toEqual({
      mimeType: "image/png", omitted: true, bytes: HUGE.length, entryIndex: 0, imageIndex: 0,
    });
    const [reply] = await send({ type: C2S.FETCH_IMAGE, requestId: 1, logId: "bigcap", entryIndex: 0, imageIndex: 0 });
    const img = reply!.image as Record<string, unknown>;
    expect(img.skipped).toBe(true);
    expect(typeof img.note).toBe("string");
    expect(img.data).toBeUndefined();
    expect(HUGE.length).toBeGreaterThan(MAX_WIRE_IMAGE_BASE64_BYTES);
  });

  it("honest refusals for a fake coordinate: absent entry, non-image entry, bad slot", async () => {
    writePagesLog("pages");
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ entryIndex: 9999, imageIndex: 0 }, "beyond"],
      [{ entryIndex: 2, imageIndex: 0 }, "carries no images"],
      [{ entryIndex: 0, imageIndex: 0 }, "carries no images"],
      [{ entryIndex: 1, imageIndex: 5 }, "out of range"],
      [{ entryIndex: "x", imageIndex: 0 }, "entryIndex"],
      [{ entryIndex: -1, imageIndex: 0 }, "entryIndex"],
      [{ entryIndex: 1, imageIndex: "x" }, "imageIndex"],
    ];
    let req = 100;
    for (const [coord, needle] of refusals) {
      const [reply] = await send({ type: C2S.FETCH_IMAGE, requestId: req, logId: "pages", ...coord });
      expect(reply!.type).toBe(S2C.FETCH_IMAGE_RESULT);
      expect(reply!.requestId).toBe(req);
      expect(reply!.image).toBeUndefined();
      expect(typeof reply!.error).toBe("string");
      expect(String(reply!.error)).toContain(needle);
      req++;
    }
    // Unknown log + missing id still answer correlated.
    const unknown = await send({ type: C2S.FETCH_IMAGE, requestId: 200, logId: "no-such-log", entryIndex: 0, imageIndex: 0 });
    expect(unknown[0]!.requestId).toBe(200);
    expect(unknown[0]!.error).toBeDefined();
    const noId = await send({ type: C2S.FETCH_IMAGE, requestId: 201, entryIndex: 0, imageIndex: 0 });
    expect(noId[0]!.requestId).toBe(201);
    expect(noId[0]!.error).toBeDefined();
  });

  it("a sessionId names the same coordinate space (live-id grammar)", async () => {
    writePagesLog("pages");
    const [reply] = await send({ type: C2S.FETCH_IMAGE, requestId: 3, sessionId: "pages", entryIndex: 1, imageIndex: 0 });
    expect(reply!.error).toBeUndefined();
    expect((reply!.image as Record<string, unknown>).data).toBe(A);
  });

  it("stub coordinates are FULL-LOG indexes, not epoch-relative (RESET offset)", async () => {
    // [0] input old-img, [1] RESET, then 8 turns (q_i at full index 2 + 2i);
    const lines = [
      line("epochy", LOG_SOURCE.INPUT, "old", { images: [{ type: "image_url", mimeType: "image/png", data: B }] }),
      line("epochy", LOG_SOURCE.RESET, ""),
    ];
    for (let i = 0; i < 8; i++) {
      const img = i === 7 ? { images: [{ type: "image_url", mimeType: "image/png", data: D }] } : {};
      lines.push(line("epochy", LOG_SOURCE.INPUT, `q${i}`, img));
      lines.push(line("epochy", LOG_SOURCE.LLM, `a${i}`));
    }
    writeFileSync(join(SESSIONS_DIR, "epochy.jsonl"), lines.join("\n") + "\n");
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "epochy" });
    expect(viewed!.epochToken).toBe(2); // the epoch really moved
    const withImg = (viewed!.entries as Array<Record<string, unknown>>).filter((e) => e.images !== undefined);
    expect(withImg).toHaveLength(1);
    const stub = (withImg[0]!.images as Array<Record<string, unknown>>)[0]!;
    expect(stub.entryIndex).toBe(16); // FULL-log (epochStart 2 + slice), not epoch-relative
    const [reply] = await send({ type: C2S.FETCH_IMAGE, requestId: 5, logId: "epochy", entryIndex: 16, imageIndex: 0 });
    expect(reply!.error).toBeUndefined();
    expect((reply!.image as Record<string, unknown>).data).toBe(D);
  });
});

// ── attach replay: the windowed FULL replay stubs; a delta keeps inline ─────

describe("attach FULL replay ships stubs; a delta replay stays inline", () => {
  function liveRegistry(): SessionRegistry {
    return new SessionRegistry({
      buildAgent: async (config: { sessionId?: string }) =>
        makeWsMockAgent({ sessionId: config.sessionId || "fresh-1" }),
      toolExecResolved: { toolExec: "inline", execFence: "probe" },
    });
  }

  it("FULL attach: windowed replay frames carry stubs with full-log coordinates", async () => {
    writeAttachLog("att-full", 15); // image on input q7 (full-log index 15)
    const ws = createWsMockWs();
    await attachResumedSession(ws, liveRegistry(), bridgeStub, "att-full", 0, false);
    const frames = ws.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
    const created = frames.find((f) => f.type === S2C.SESSION_CREATED)!;
    expect(created.hasOlder).toBe(true);
    expect(created.oldestIndex).toBe(12); // the 5th-from-last message (llm a5): 16 messages, K=5
    const withImg = frames.filter((f) => f.images !== undefined);
    expect(withImg.length).toBeGreaterThan(0);
    for (const f of withImg) {
      const imgs = f.images as Array<Record<string, unknown>>;
      for (const im of imgs) {
        expect(im.omitted).toBe(true);
        expect(im.bytes).toBe(A.length);
        expect(im.entryIndex).toBe(15); // FULL-log index, replay-slice-relative no
        expect(im.imageIndex).toBe(0);
        expect(im.data).toBeUndefined();
      }
    }
    const wire = JSON.stringify(frames)!;
    expect(wire).not.toContain('"data"');
    expect(wire).not.toContain(A.slice(0, 64));
  });

  it("delta attach (cursor>0): the exact tail keeps images inline, byte-honest", async () => {
    writeAttachLog("att-delta", 15);
    const ws = createWsMockWs();
    // cursor 12 (before the image entry): the client holds the prefix, so the
    // tail is fresh-to-the-client content -- the pre-windowing wire (inline).
    await attachResumedSession(ws, liveRegistry(), bridgeStub, "att-delta", 12, false);
    const frames = ws.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
    const created = frames.find((f) => f.type === S2C.SESSION_CREATED)!;
    expect(created.replayDelta).toBe(true);
    const withImg = frames.filter((f) => f.images !== undefined);
    expect(withImg).toHaveLength(1);
    expect((withImg[0]!.images as Array<Record<string, unknown>>)[0]).toEqual({
      mimeType: "image/png",
      data: A,
    });
  });
});

// ── the live path keeps shipping inline pixels ──────────────────────────────

describe("live frames are untouched by the stub seam", () => {
  it("OUTPUT_EVENT userMessage/toolResult still inline the image data", () => {
    const img = [{ type: "image_url", mimeType: "image/png", data: "aGVsbG8=" }];
    const user = toS2CMessage(
      { type: OUTPUT_EVENT.USER_MESSAGE, content: "hi", images: img } as never,
      "s1",
    )!;
    expect(user.images).toEqual([{ mimeType: "image/png", data: "aGVsbG8=" }]);
    const res = toS2CMessage(
      { type: OUTPUT_EVENT.TOOL_RESULT, toolName: "read", content: "ok", images: img } as never,
      "s1",
    )!;
    expect(res.images).toEqual([{ mimeType: "image/png", data: "aGVsbG8=" }]);
  });

  it("wireImages on raw attachments is unchanged (no omitted fields invented)", () => {
    expect(wireImages([{ mimeType: "image/png", data: "QUJD" }])).toEqual([
      { mimeType: "image/png", data: "QUJD" },
    ]);
  });

  it("wireImages passes a well-formed stub through and drops a malformed one", () => {
    const stub = { mimeType: "image/png", omitted: true, bytes: 60, entryIndex: 4, imageIndex: 0 };
    expect(wireImages([stub])).toEqual([stub]);
    expect(wireImages([{ mimeType: "image/png", omitted: true }])).toBeUndefined();
    expect(wireImages([{ mimeType: "image/png", omitted: true, bytes: 60, entryIndex: 4, imageIndex: 1.5 }])).toBeUndefined();
  });

  it("wireImageStubs normalizes legacy data-URL entries and skips junk", () => {
    const stubs = wireImageStubs(
      [{ url: LEGACY }, null, { mimeType: "image/png" }, { mimeType: "image/gif", data: "R0lGOD" }],
      9,
    )!;
    expect(stubs).toEqual([
      { mimeType: "image/jpeg", omitted: true, bytes: LEGACY_DATA.length, entryIndex: 9, imageIndex: 0 },
      { mimeType: "image/gif", omitted: true, bytes: 6, entryIndex: 9, imageIndex: 3 },
    ]);
    expect(wireImageStubs(undefined, 9)).toBeUndefined();
    expect(wireImageStubs([], 9)).toBeUndefined();
  });
});
