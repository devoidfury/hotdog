// Tests for the webui upload path: base64 files on a C2S `send` message are
// parsed server-side (./websocket uploads), enqueued with harness
// provenance so file-include parts survive the MessageBus queue boundary,
// and oversize uploads are rejected with a visible S2C error.

import { describe, it, expect, afterEach } from "bun:test";
import { parseUploadedFiles } from "@extensions/websocket/uploads.ts";
import { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import type { AgentLike } from "@core/session/index.ts";
import {
  createWsMockCore,
  createWsMockAgentFactory,
  createWsMockWs,
  makeWsMockAgent,
} from "../mocks/websocket.ts";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

// ── parseUploadedFiles (unit) ───────────────────────────────────────────────

describe("parseUploadedFiles", () => {
  const limits = { maxFileSize: 1024, maxFiles: 3, vision: true };

  it("turns a text file into a file-include part", () => {
    const { parts, images, errors } = parseUploadedFiles(
      [{ name: "notes.md", mimeType: "text/markdown", data: b64("hello upload") }],
      limits,
    );
    expect(errors).toEqual([]);
    expect(images).toEqual([]);
    expect(parts).toEqual([{ type: "file-include", path: "notes.md", content: "hello upload" }]);
  });

  it("treats a missing mimeType as a non-image file", () => {
    const { parts, images, errors } = parseUploadedFiles(
      [{ name: "data.bin", data: b64("x") }],
      limits,
    );
    expect(errors).toEqual([]);
    expect(images).toEqual([]);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("file-include");
  });

  it("turns an image file into a Message image attachment (vision model)", () => {
    const { parts, images, errors } = parseUploadedFiles(
      [{ name: "shot.png", mimeType: "image/png", data: b64("PNGDATA") }],
      limits,
    );
    expect(errors).toEqual([]);
    expect(parts).toEqual([]);
    expect(images).toEqual([{ type: "image_url", mimeType: "image/png", data: b64("PNGDATA") }]);
  });

  it("rejects images when the model has no vision (fails closed)", () => {
    const { parts, images, errors } = parseUploadedFiles(
      [{ name: "shot.png", mimeType: "image/png", data: b64("PNGDATA") }],
      { ...limits, vision: false },
    );
    expect(parts).toEqual([]);
    expect(images).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("does not accept image input");
  });

  it("rejects a file whose base64 text blows past the cheap ceiling without decoding", () => {
    const big = "A".repeat(4 * Math.ceil(limits.maxFileSize / 3) + 4);
    const { parts, images, errors } = parseUploadedFiles(
      [{ name: "big.txt", mimeType: "text/plain", data: big }],
      limits,
    );
    expect(parts).toEqual([]);
    expect(images).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("big.txt");
    expect(errors[0]).toContain("too large");
  });

  it("rejects a file that decodes just over maxFileSize", () => {
    // maxFileSize=4: the text ceiling allows 8 b64 chars; "AAAAAAA=" rides
    // that ceiling and decodes to 5 bytes.
    const { parts, errors } = parseUploadedFiles(
      [{ name: "edge.txt", mimeType: "text/plain", data: "AAAAAAA=" }],
      { ...limits, maxFileSize: 4 },
    );
    expect(parts).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("too large");
  });

  it("rejects more files than maxFiles without parsing any", () => {
    const files = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.txt`, data: b64("x") }));
    const { parts, errors } = parseUploadedFiles(files, limits);
    expect(parts).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("file limit");
  });

  it("rejects entries missing a name or data", () => {
    const { errors } = parseUploadedFiles(
      [{ name: "", data: b64("x") }, { data: b64("y") }, { name: "ok.txt" }],
      limits,
    );
    expect(errors).toHaveLength(3);
  });

  it("rejects invalid base64 payloads", () => {
    const { parts, images, errors } = parseUploadedFiles(
      [{ name: "bad.bin", mimeType: "image/png", data: "!!!" }],
      limits,
    );
    expect(parts).toEqual([]);
    expect(images).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not valid base64");
  });

  it("returns empty results for non-array or empty input", () => {
    for (const bad of [undefined, null, "nope", {}, []]) {
      const { parts, images, errors } = parseUploadedFiles(bad, limits);
      expect(parts).toEqual([]);
      expect(images).toEqual([]);
      expect(errors).toEqual([]);
    }
  });

  it("keeps arrival order across mixed text files and images", () => {
    const { parts, images, errors } = parseUploadedFiles(
      [
        { name: "a.txt", mimeType: "text/plain", data: b64("a") },
        { name: "b.png", mimeType: "image/png", data: b64("B") },
        { name: "c.txt", mimeType: "text/plain", data: b64("c") },
      ],
      limits,
    );
    expect(errors).toEqual([]);
    expect(parts.map((p) => p.path)).toEqual(["a.txt", "c.txt"]);
    expect(images).toHaveLength(1);
  });
});

// ── SEND with files over the websocket ──────────────────────────────────────

describe("C2S SEND with uploads", () => {
  let wsServer: ReturnType<typeof createWsServer> | null = null;

  afterEach(() => {
    wsServer?.stopCleanupLoop();
    wsServer = null;
  });

  async function connect(opts: {
    core?: any;
    buildAgent?: (config: { model?: string; sessionId?: string }) => Promise<AgentLike>;
  } = {}): Promise<ReturnType<typeof createWsMockWs>> {
    const core = opts.core ?? createWsMockCore();
    wsServer = createWsServer(core, {
      buildAgent: opts.buildAgent ?? createWsMockAgentFactory(),
    });
    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    // Wait for the auto-created session.
    const start = Date.now();
    for (;;) {
      const created = ws.messages
        .map((m) => { try { return JSON.parse(m); } catch { return null; } })
        .find((m) => m && m.type === S2C.SESSION_CREATED);
      if (created) break;
      if (Date.now() - start > 2000) throw new Error("Timed out waiting for sessionCreated");
      await new Promise((r) => setTimeout(r, 5));
    }
    return ws;
  }

  function visionAgent(): (config: { model?: string; sessionId?: string }) => Promise<AgentLike> {
    return async (config) =>
      ({
        ...makeWsMockAgent({ sessionId: config.sessionId || "test", model: "test-model" }),
        modelRegistry: { "test-model": { capabilities: { vision: true } } },
      }) as unknown as AgentLike;
  }

  /** Replace sessionManager.enqueue with a recorder; returns the recording. */
  function spyOnEnqueue(): Array<{ sid: string; content: unknown; opts?: Record<string, unknown> }> {
    const sessionManager = wsServer!.sessionRegistry.getSessionManager();
    const original = sessionManager.enqueue.bind(sessionManager);
    const calls: Array<{ sid: string; content: unknown; opts?: Record<string, unknown> }> = [];
    sessionManager.enqueue = ((sid: string, content: unknown, opts?: Record<string, unknown>) => {
      calls.push({ sid, content, opts });
    }) as typeof original;
    return calls;
  }

  it("enqueues uploaded text files as harness file-include parts", async () => {
    const ws = await connect();
    const sessionId = ws.activeSessionId!;
    const calls = spyOnEnqueue();

    wsServer!.onMessage(ws, JSON.stringify({
      type: C2S.SEND,
      sessionId,
      content: "look at this",
      files: [{ name: "notes.md", mimeType: "text/markdown", data: b64("# hi") }],
    }));
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toHaveLength(1);
    const { sid, content, opts } = calls[0]!;
    expect(sid).toBe(sessionId);
    // Provenance: the server (harness-authoritative side) marks the enqueue,
    // so the file-include part survives the queue boundary (not flattened).
    expect(opts).toEqual({ source: "harness" });
    expect(content).toEqual([
      { type: "untrusted", text: "look at this" },
      { type: "file-include", path: "notes.md", content: "# hi" },
    ]);
  });

  it("routes uploaded images to the images field, gated on vision", async () => {
    const ws = await connect({ buildAgent: visionAgent() });
    const sessionId = ws.activeSessionId!;
    const calls = spyOnEnqueue();

    wsServer!.onMessage(ws, JSON.stringify({
      type: C2S.SEND,
      sessionId,
      content: "",
      files: [{ name: "shot.png", mimeType: "image/png", data: b64("PNG") }],
    }));
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.content).toEqual([]);
    expect(calls[0]!.opts).toEqual({ source: "harness", images: [
      { type: "image_url", mimeType: "image/png", data: b64("PNG") },
    ] });
  });

  it("rejects an image upload with a visible error on a non-vision model", async () => {
    const ws = await connect(); // default mock agent: no modelRegistry -> fails closed
    const sessionId = ws.activeSessionId!;
    const calls = spyOnEnqueue();
    const before = ws.messages.length;

    wsServer!.onMessage(ws, JSON.stringify({
      type: C2S.SEND,
      sessionId,
      content: "see image",
      files: [{ name: "shot.png", mimeType: "image/png", data: b64("PNG") }],
    }));
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toEqual([]);
    const errors = ws.messages.slice(before)
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m && m.type === S2C.ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Upload rejected");
    expect(errors[0]!.message).toContain("does not accept image input");
  });

  it("rejects an oversized upload with a visible error and enqueues nothing", async () => {
    const core = createWsMockCore();
    core.config.fileAttachment = { maxFileSize: 64, maxFiles: 2 };
    const ws = await connect({ core });
    const sessionId = ws.activeSessionId!;
    const calls = spyOnEnqueue();
    const before = ws.messages.length;

    wsServer!.onMessage(ws, JSON.stringify({
      type: C2S.SEND,
      sessionId,
      content: "big one",
      files: [{ name: "huge.txt", mimeType: "text/plain", data: "A".repeat(4 * Math.ceil(64 / 3) + 4) }],
    }));
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toEqual([]);
    const errors = ws.messages.slice(before)
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m && m.type === S2C.ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Upload rejected");
    expect(errors[0]!.message).toContain("huge.txt");
    expect(errors[0]!.message).toContain("too large");
  });

  it("honors the fileAttachment maxFiles limit", async () => {
    const core = createWsMockCore();
    core.config.fileAttachment = { maxFileSize: 1024, maxFiles: 1 };
    const ws = await connect({ core });
    const sessionId = ws.activeSessionId!;
    const calls = spyOnEnqueue();

    wsServer!.onMessage(ws, JSON.stringify({
      type: C2S.SEND,
      sessionId,
      content: "two files",
      files: [
        { name: "a.txt", mimeType: "text/plain", data: b64("a") },
        { name: "b.txt", mimeType: "text/plain", data: b64("b") },
      ],
    }));
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toEqual([]);
    const last = JSON.parse(ws.messages[ws.messages.length - 1]!);
    expect(last.type).toBe(S2C.ERROR);
    expect(last.message).toContain("file limit");
  });

  it("keeps plain-text sends unchanged (no files, no harness source)", async () => {
    const ws = await connect();
    const sessionId = ws.activeSessionId!;
    const calls = spyOnEnqueue();

    wsServer!.onMessage(ws, JSON.stringify({ type: C2S.SEND, sessionId, content: "hi" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toEqual([{ sid: sessionId, content: "hi", opts: undefined }]);
  });
});
