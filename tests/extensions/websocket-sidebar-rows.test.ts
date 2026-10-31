// Sidebar row payload on the SESSIONS wire: the live row grammar's ctx
// numbers (last token_usage snapshot cached in the registry) and their
// omission until the session's first usage. Existing LIST_SESSIONS pins in
// websocket-server.test.ts stay untouched; this file adds the new fields.

import { describe, it, expect } from "bun:test";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { routeMessage } from "@extensions/websocket/message-routing.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import type { AgentLike } from "@core/session/index.ts";
import type { AuthMiddleware } from "@extensions/websocket/auth.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";

const authStub = undefined as unknown as AuthMiddleware;
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

function makeRegistry(agent: AgentLike): SessionRegistry {
  return new SessionRegistry({
    buildAgent: async () => agent,
  });
}

/** Drive a full token_usage event through the session's event bus. */
function emitUsage(registry: SessionRegistry, sessionId: string, totalTokens: number, contextWindow: number): void {
  registry
    .getSessionManager()
    .emitToChannels(sessionId, {
      type: OUTPUT_EVENT.TOKEN_USAGE,
      sessionPromptTokens: 10,
      sessionCachedTokens: 0,
      sessionCompletionTokens: 2,
      sessionTotalTokens: totalTokens,
      turns: 1,
      promptTokens: totalTokens - 2,
      cachedTokens: 0,
      completionTokens: 2,
      totalTokens,
      contextWindow,
    } as never);
}

async function listSessionsViaWire(registry: SessionRegistry): Promise<Array<Record<string, unknown>>> {
  const ws = createWsMockWs();
  await routeMessage(ws, { type: C2S.LIST_SESSIONS } as never, registry, authStub, bridgeStub, coreStub);
  await flush();
  const msg = JSON.parse(ws.messages[ws.messages.length - 1]!) as {
    type: string;
    sessions: Array<Record<string, unknown>>;
  };
  expect(msg.type).toBe(S2C.SESSIONS);
  return msg.sessions;
}

describe("SESSIONS rows: sidebar ctx payload", () => {
  it("carries ctxUsed/ctxTotal once a token_usage event lands", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "ctx-live" }));
    await registry.create({ profile: "manager" });

    emitUsage(registry, "ctx-live", 69000, 262144);

    const rows = await listSessionsViaWire(registry);
    const row = rows.find((r) => r.id === "ctx-live")!;
    expect(row.ctxUsed).toBe(69000);
    expect(row.ctxTotal).toBe(262144);
    // The grammar's other live slots stay on the wire unchanged.
    expect(row.profile).toBe("manager");
    expect(row.connectedClients).toBe(0);
    expect(row.userMessageCount).toBe(0);
  });

  it("later usage events replace the snapshot (last usage wins)", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "ctx-two" }));
    await registry.create();

    emitUsage(registry, "ctx-two", 1000, 131072);
    emitUsage(registry, "ctx-two", 2222, 262144);

    const row = (await listSessionsViaWire(registry)).find((r) => r.id === "ctx-two")!;
    expect(row.ctxUsed).toBe(2222);
    expect(row.ctxTotal).toBe(262144);
  });

  it("sessions with no usage yet omit the ctx fields outright", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "ctx-none" }));
    await registry.create();

    const row = (await listSessionsViaWire(registry)).find((r) => r.id === "ctx-none")!;
    expect("ctxUsed" in row).toBe(false);
    expect("ctxTotal" in row).toBe(false);
  });

  it("registry.list() exposes the same fields (the SESSIONS builders share it)", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "ctx-direct" }));
    await registry.create();
    emitUsage(registry, "ctx-direct", 4242, 8192);

    const entry = registry.list().find((s) => s.id === "ctx-direct")!;
    expect(entry.ctxUsed).toBe(4242);
    expect(entry.ctxTotal).toBe(8192);

    registry.delete("ctx-direct");
    expect(registry.list().find((s) => s.id === "ctx-direct")).toBeUndefined();
  });
});
