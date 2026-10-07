// Tests for the transcribe round trip in the websocket server:
// C2S transcribe -> transcribeAudio -> S2C transcript, including the
// disabled-config error path, the size cap, and the auth gate.

import { describe, it, expect, afterEach, afterAll, beforeEach } from "bun:test";
import { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { createWsMockCore, createWsMockAgentFactory, createWsMockWs } from "../mocks/websocket.ts";

type MockWs = ReturnType<typeof createWsMockWs>;

// ── Fake OpenAI-compatible transcriptions backend ───────────────────────────

let captured: { model: string | null; fileText: string; authHeader: string | null } | null = null;

const fakeStt = Bun.serve({
  port: 0,
  async fetch(req) {
    const form = await req.formData();
    const file = form.get("file");
    captured = {
      model: typeof form.get("model") === "string" ? (form.get("model") as string) : null,
      fileText: file instanceof File ? await file.text() : "",
      authHeader: req.headers.get("authorization"),
    };
    return Response.json({ text: "transcribed text" });
  },
});

afterAll(() => {
  fakeStt.stop(true);
});

beforeEach(() => {
  captured = null;
});

const sttUrl = () => `http://localhost:${fakeStt.port}/v1/audio/transcriptions`;

// Same polling helper as websocket-server.test.ts: deterministic on arrival.
async function waitForMessage(ws: MockWs, type: string, opts: { timeoutMs?: number; after?: number } = {}): Promise<any> {
  const { timeoutMs = 2000, after = 0 } = opts;
  const start = Date.now();
  for (;;) {
    const found = ws.messages
      .slice(after)
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .find((m) => m && m.type === type);
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${type} message`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let wsServer: ReturnType<typeof createWsServer> | null = null;

afterEach(() => {
  wsServer?.stopCleanupLoop();
  wsServer = null;
});

/** Build a server with an optional resolved sttUrl/sttModel, attach a session. */
async function connect(opts: { sttUrl?: string; sttModel?: string } = {}): Promise<MockWs> {
  const core = createWsMockCore();
  if (opts.sttUrl) core.resolved.sttUrl = opts.sttUrl;
  if (opts.sttModel) core.resolved.sttModel = opts.sttModel;
  wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

  const ws = createWsMockWs();
  wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
  await waitForMessage(ws, S2C.SESSION_CREATED);
  return ws;
}

describe("websocket transcribe", () => {
  it("round-trips a transcribe request into a transcript reply and forwards file + model", async () => {
    const ws = await connect({ sttUrl: sttUrl(), sttModel: "whisper-1" });

    wsServer!.onMessage(
      ws,
      JSON.stringify({
        type: C2S.TRANSCRIBE,
        id: "req-1",
        mimeType: "audio/webm",
        data: Buffer.from("FAKEAUDIO").toString("base64"),
      }),
    );

    const reply = await waitForMessage(ws, S2C.TRANSCRIPT);
    expect(reply).toMatchObject({ type: "transcript", id: "req-1", ok: true, text: "transcribed text" });
    expect(captured).toEqual({ model: "whisper-1", fileText: "FAKEAUDIO", authHeader: null });
  });

  it("replies ok:false when sttUrl is not configured (and advertises sttEnabled=false)", async () => {
    const ws = await connect(); // mock core has no sttUrl

    const created = ws.messages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .find((m) => m && m.type === S2C.SESSION_CREATED);
    expect(created).toBeDefined();
    expect(created!.sttEnabled).toBe(false);

    wsServer!.onMessage(
      ws,
      JSON.stringify({ type: C2S.TRANSCRIBE, id: "req-2", mimeType: "audio/webm", data: "aGk=" }),
    );

    const reply = await waitForMessage(ws, S2C.TRANSCRIPT);
    expect(reply.id).toBe("req-2");
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("not configured");
  });

  it("advertises sttEnabled=true on sessionCreated when sttUrl is configured", async () => {
    const ws = await connect({ sttUrl: sttUrl() });
    const created = ws.messages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .find((m) => m && m.type === S2C.SESSION_CREATED);
    expect(created!.sttEnabled).toBe(true);
  });

  it("rejects oversized audio before touching the backend", async () => {
    const ws = await connect({ sttUrl: sttUrl() });

    // 25MB raw audio cap -> base64 is ~4/3 of that; overshoot it.
    const oversized = "x".repeat(Math.ceil((25 * 1024 * 1024) / 3) * 4 + 4);
    wsServer!.onMessage(
      ws,
      JSON.stringify({ type: C2S.TRANSCRIBE, id: "req-3", mimeType: "audio/webm", data: oversized }),
    );

    const reply = await waitForMessage(ws, S2C.TRANSCRIPT);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("too large");
    expect(captured).toBeNull();
  });

  it("replies ok:false when the backend fails", async () => {
    // Point at a port with nothing listening (bind port 0 and release it).
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const deadUrl = `http://localhost:${closed.port}/v1/audio/transcriptions`;
    closed.stop(true);

    const ws = await connect({ sttUrl: deadUrl });
    wsServer!.onMessage(
      ws,
      JSON.stringify({ type: C2S.TRANSCRIBE, id: "req-4", mimeType: "audio/webm", data: "aGk=" }),
    );

    const reply = await waitForMessage(ws, S2C.TRANSCRIPT);
    expect(reply.id).toBe("req-4");
    expect(reply.ok).toBe(false);
    expect(typeof reply.error).toBe("string");
  });

  it("replies ok:false on missing audio data", async () => {
    const ws = await connect({ sttUrl: sttUrl() });
    wsServer!.onMessage(ws, JSON.stringify({ type: C2S.TRANSCRIBE, id: "req-5", mimeType: "audio/webm" }));

    const reply = await waitForMessage(ws, S2C.TRANSCRIPT);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("missing audio");
  });

  it("auto-detects an audio-capable registry model: enabled without sttUrl, provider URL + key used", async () => {
    const core = createWsMockCore();
    // The mock LlmClient follows resolved.baseUrl, so the fake backend is the provider.
    core.resolved.baseUrl = `http://localhost:${fakeStt.port}`;
    core.resolved.modelRegistry = {
      "prov/chat": { name: "chat-model", inputModalities: ["text"], outputModalities: ["text"] },
      "prov/asr": { name: "qwen3-asr", inputModalities: ["audio"], outputModalities: ["text"] },
    };
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    expect(created.sttEnabled).toBe(true);

    wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.TRANSCRIBE, id: "auto-1", mimeType: "audio/webm", data: "aGk=" }),
    );

    const reply = await waitForMessage(ws, S2C.TRANSCRIPT);
    expect(reply).toMatchObject({ id: "auto-1", ok: true, text: "transcribed text" });
    // Wire model name drops the provider prefix; transport key rides as Bearer.
    expect(captured).toEqual({ model: "qwen3-asr", fileText: "hi", authHeader: "Bearer test-key" });
  });

  it("gated behind auth like every other message", async () => {
    const core = createWsMockCore();
    core.resolved.sttUrl = sttUrl();
    wsServer = createWsServer(core, {
      buildAgent: createWsMockAgentFactory(),
      auth: { validateToken: (token: string) => token === "valid-token" } as never,
    });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.TRANSCRIBE, id: "gated", mimeType: "audio/webm", data: "aGk=" }),
    );

    const gate = await waitForMessage(ws, S2C.AUTH_ERROR);
    expect(gate.code).toBe("auth_required");
    // No transcript reply ever arrives.
    expect(
      ws.messages.some((m) => { try { return JSON.parse(m).type === S2C.TRANSCRIPT; } catch { return false; } }),
    ).toBe(false);
  });
});
