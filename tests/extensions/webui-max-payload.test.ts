// Transport frame bound on the webui's Bun.serve surface. Bun's default
// maxPayloadLength (16 MiB) says nothing about hotdog's own caps: the largest
// legitimate frame is a C2S send carrying one 10 MB image upload, which rides
// base64-in-JSON (~4/3 expansion). The bound must sit just above that so the
// app-level parser (uploads.ts) stays the last line of defense instead of the
// transport silently eating 10-16 MiB frames, and so oversized frames die at
// the socket instead of paying JSON parse + base64 decode first.

import { describe, it, expect, afterEach } from "bun:test";
import { createWebuiServer } from "@extensions/webui/server.ts";
import type { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { LlmClient } from "@core/llm-client/client.ts";
import { createMockCore as createBaseMockCore } from "../test-helpers.ts";
import { createRoleMappingRegistry } from "@core/extensions/role-mapping.ts";
import {
  systemFirstRoleMapping,
  developerRoleMapping,
} from "@extensions/role-mapping-default/index.ts";

// The root uploadLimits.maxImageSize schema default (10MB), mirrored as a
// plain literal -- tests hand the resolved value, not a DEFAULT_ import.
const MAX_IMAGE_SIZE = 10485760;

const testRoleReg = createRoleMappingRegistry();
testRoleReg.register(systemFirstRoleMapping);
testRoleReg.register(developerRoleMapping);

function createMockCore() {
  return createBaseMockCore({
    config: {
      websocket: { sessionTimeoutMin: 30, questionTimeoutSecs: 300, questionStrategy: "wait" },
      webui: {},
    },
    resolved: {
      profilesPath: "./config/profiles",
      maxToolCallsPerIteration: 10,
      toolRetryDelay: 1,
      // Root uploadLimits (schema defaults as plain literals): the transport
      // frame bound and the upload caps both read it from the resolved bag.
      uploadLimits: { maxFileSize: 102400, maxImageSize: MAX_IMAGE_SIZE, maxFiles: 10 },
    },
    createLlmClient: ((overrides?: Record<string, unknown>) =>
      new LlmClient({
        roleMapping: "system-first",
        roleMappingRegistry: testRoleReg,
        baseUrl: "http://localhost:8000",
        apiKey: "test-key",
        chatTimeoutSecs: 30,
        maxRetries: 3,
        ...overrides,
      })) as never,
  }) as never;
}

// Vision-capable inert agent: the upload's vision gate reads the registry.
function visionBuildAgent(): (config: {
  model?: string;
  sessionId?: string;
  profileName?: string;
}) => Promise<never> {
  let seq = 0;
  return async (config) =>
    ({
      sessionId: config.sessionId || `payload-test-${++seq}`,
      model: "test-model",
      profileName: "default",
      modelRegistry: { "test-model": { capabilities: { vision: true } } },
      hooks: {
        notifyHooks: () => {},
        runHookPipeline: async () => undefined,
        registerHook: () => {},
        unregisterHook: () => {},
      },
      getMessages: () => [],
      run: async () => ({ type: "completion", content: "ok" }),
      cancel: () => {},
      resetCancel: () => {},
      clearContext: async () => {},
      executeCommand: async () => null,
      addMessage: () => {},
      serialize: () => ({}),
      applyProfile: () => {},
      sink: null,
      enqueueCallback: null,
      toolWhitelist: null,
      profileBody: undefined,
      notifyCompletion: () => {},
    }) as never;
}

describe("webui ws maxPayloadLength", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let wsServer: ReturnType<typeof createWsServer> | null = null;

  afterEach(async () => {
    if (server) {
      server.stop(true);
      server = null;
    }
    if (wsServer) {
      wsServer.stopCleanupLoop();
      wsServer = null;
    }
  });

  interface Session {
    ws: WebSocket;
    sessionId: string;
    received: Array<Record<string, unknown>>;
    closed: number[];
  }

  async function authedSession(): Promise<Session> {
    const result = await createWebuiServer(createMockCore(), {
      port: 0,
      host: "127.0.0.1",
      apiKey: "test-secret",
    }, { buildAgent: visionBuildAgent() });
    server = result.server;
    wsServer = result.wsServer;
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const login = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "test-secret" }),
    });
    const { token } = await login.json();

    // The /ws origin gate wants a same-origin Origin; Bun's client sends none.
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
      headers: { Origin: baseUrl },
    } as never);
    const received: Array<Record<string, unknown>> = [];
    const closed: number[] = [];
    ws.onmessage = (event) => received.push(JSON.parse(event.data as string));
    ws.onclose = (ev) => closed.push(ev.code);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws connect failed"));
    });
    ws.send(JSON.stringify({ type: C2S.AUTH, token }));
    await waitFor(received, (m) => m.type === S2C.AUTH_OK);
    ws.send(JSON.stringify({ type: C2S.CREATE_SESSION }));
    const created = await waitFor(received, (m) => m.type === S2C.SESSION_CREATED);
    return { ws, sessionId: created.sessionId as string, received, closed };
  }

  async function waitFor(
    messages: Array<Record<string, unknown>>,
    predicate: (m: Record<string, unknown>) => boolean,
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = messages.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`timed out; got ${JSON.stringify(messages.map((m) => m.type))}`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** base64 upload frame for nRawBytes of image data, as the webui sends it. */
  function imageFrameWithId(sessionId: string, nRawBytes: number): string {
    const data = Buffer.alloc(nRawBytes, 7).toString("base64");
    return JSON.stringify({
      type: C2S.SEND,
      sessionId,
      content: "",
      files: [{ name: "big.png", mimeType: "image/png", data }],
    });
  }

  it("a legitimate 10 MB image upload passes end to end", async () => {
    const { ws, sessionId, received } = await authedSession();
    const sessionManager = wsServer!.sessionRegistry.getSessionManager();
    const enqueued: Array<Record<string, unknown>> = [];
    sessionManager.enqueue = ((sid: string, content: unknown, opts?: unknown) => {
      enqueued.push({ sid, content, opts });
    }) as never;

    ws.send(imageFrameWithId(sessionId, MAX_IMAGE_SIZE));
    // The transport bound must not close the socket first. Wait for the
    // enqueue (parse+decode of 10 MiB lands well inside the deadline), then
    // a short settle so a late ERROR frame or socket close would arrive.
    const deadline = Date.now() + 20_000;
    while (enqueued.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 150));

    expect(enqueued).toHaveLength(1);
    const opts = enqueued[0]!.opts as { images: Array<{ data: string }> };
    expect(opts.images[0]!.data).toHaveLength(4 * Math.ceil(MAX_IMAGE_SIZE / 3));
    expect(received.some((m) => m.type === S2C.ERROR)).toBe(false);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  }, 30000);

  it("a frame over the aligned bound is refused at the transport, not parsed", async () => {
    const { ws, sessionId, received, closed } = await authedSession();

    // Raw size still under Bun's 16 MiB default but over the aligned bound
    // (the app-level image cap expanded + envelope headroom): the frame must
    // die at the transport. Pre-bound, this arrived and the app parser
    // answered "Upload rejected ... too large" on a live socket.
    const overBound = Math.ceil(MAX_IMAGE_SIZE * 1.16);
    ws.send(imageFrameWithId(sessionId, overBound));

    const deadline = Date.now() + 5000;
    while (closed.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(closed.length).toBe(1);
    // Bun terminates the connection on an over-cap frame (1006 abnormal
    // closure, "Received too big message" server-side); the exact code is
    // Bun's business -- the contract is: closed, and no app-level reply.
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    // A transport-dropped frame never reaches the app parser: no reply.
    expect(received.some((m) => m.type === S2C.ERROR)).toBe(false);
  }, 30000);
});
