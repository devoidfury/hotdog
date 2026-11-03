// The webui header-strip fence control at the transport level: C2S execFence
// through the real server (createWsServer + mock sockets), the apply landing on
// the PER-SESSION store (getExecFencePolicy keyed by the toggled id), the
// posture push riding the existing sessionState frame (key "toolExec") through
// broadcastScoped -- and the isolation negative: a client attached to a
// DIFFERENT session never receives a strip change.
//
// Module-state discipline (same contract as tests/core/tool-exec-fence-toggle):
// every session id is process-unique and afterAll resets the override map, so
// the sequential shared process sees exactly what it sees today.

import { describe, it, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import {
  ToolExecBroker,
  getExecFencePolicy,
  resetExecFenceOverridesForTesting,
} from "@core/tool-exec-broker.ts";
import { FENCE_OFF_NOTICE } from "@extensions/ui-interactive-cli/fence-command.ts";
import { createWsMockCore, createWsMockAgentFactory, createWsMockWs } from "../mocks/websocket.ts";
import type { AgentLike } from "@core/session/index.ts";
import { TMP_PARENT } from "../mocks/io.ts";
type MockWs = ReturnType<typeof createWsMockWs>;

// Isolated sessions dir: the live-attach path reads logs off disk; never
// touch the real one from a unit test.
const SESSIONS_DIR = mkdtempSync(join(TMP_PARENT, "hotdog-sessions-execfence-"));
beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
});
afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  try { rmSync(SESSIONS_DIR, { recursive: true, force: true }); } catch {}
});

async function waitForMessage(ws: MockWs, pred: (m: any) => boolean, what: string, timeoutMs = 2000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const found = ws.messages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .find((m) => m && pred(m));
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 25));

const stripPushes = (ws: MockWs) =>
  ws.messages
    .map((m) => { try { return JSON.parse(m); } catch { return null; } })
    .filter((m) => m && m.type === S2C.SESSION_STATE && m.key === "toolExec");

/**
 * A server whose resolved posture is a worker plane (the strip is clickable
 * there), one live session per connect. `workerPlane: false` builds the inline
 * refusal host.
 */
let wsServer: ReturnType<typeof createWsServer> | null = null;
afterEach(() => {
  wsServer?.stopCleanupLoop();
  wsServer = null;
});
afterAll(resetExecFenceOverridesForTesting);

function workerCore() {
  const core = createWsMockCore();
  Object.assign(core.resolved, { toolExec: "worker", execFence: "probe" });
  return core;
}

async function connectWithSession(
  core: any = workerCore(),
): Promise<{ ws: MockWs; sessionId: string }> {
  wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });
  const ws = createWsMockWs();
  wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
  const created = await waitForMessage(ws, (m) => m.type === S2C.SESSION_CREATED, "sessionCreated");
  return { ws, sessionId: created.sessionId as string };
}

/** Spy on the broker instance setter: the ONLY door to the live override map. */
function spySetter(): { calls: unknown[][]; restore: () => void } {
  const proto = ToolExecBroker.prototype as unknown as Record<string, unknown>;
  const original = proto.setSessionFencePolicy as (...a: unknown[]) => unknown;
  const calls: unknown[][] = [];
  proto.setSessionFencePolicy = function (this: unknown, ...args: unknown[]) {
    calls.push(args);
    return original.apply(this, args);
  };
  return { calls, restore: () => { proto.setSessionFencePolicy = original; } };
}

describe("C2S execFence: validation and session binding", () => {
  it("a garbage policy is rejected: no store touch, no push, an in-band error", async () => {
    const { ws, sessionId } = await connectWithSession();
    const spy = spySetter();
    try {
      ws.messages.length = 0;
      for (const bad of ["sideways", "OFF", "on", "", null, 0, "probe ", { v: "off" }]) {
        wsServer!.onMessage(ws, JSON.stringify({ type: C2S.EXEC_FENCE, sessionId, policy: bad }));
      }
      await settle();
      // The policy literal is exact: nothing coerced its way into the store.
      expect(spy.calls).toHaveLength(0);
      expect(getExecFencePolicy(sessionId)).toBeNull();
      const errs = ws.messages
        .map((m) => JSON.parse(m))
        .filter((m) => m.type === S2C.ERROR);
      expect(errs.length).toBe(8);
      expect(errs[0]!.message).toContain('"off" or "probe"');
      // And no posture push went out for a rejected frame.
      expect(stripPushes(ws)).toHaveLength(0);
    } finally {
      spy.restore();
    }
  });

  it("a foreign sessionId is rejected by the session-existence binding (the rule cancel shares)", async () => {
    const { ws } = await connectWithSession();
    const spy = spySetter();
    try {
      ws.messages.length = 0;
      wsServer!.onMessage(ws, JSON.stringify({ type: C2S.EXEC_FENCE, sessionId: "no-such-session", policy: "off" }));
      await settle();
      // Same law as CANCEL: the frame may only act on a session this server
      // hosts (the SessionManager/registry lookup; a foreign id never moves
      // state). execFence says the refusal out loud instead of going silent.
      expect(spy.calls).toHaveLength(0);
      expect(getExecFencePolicy("no-such-session")).toBeNull();
      const err = await waitForMessage(ws, (m) => m.type === S2C.ERROR, "Session not found");
      expect(err.message).toContain("not found");
    } finally {
      spy.restore();
    }
  });

  it("an inline plane refuses the toggle: clear reason, store untouched", async () => {
    // The default mock core resolves inline -- there is no pool to fence.
    const { ws, sessionId } = await connectWithSession(createWsMockCore()); // inline host
    const spy = spySetter();
    try {
      ws.messages.length = 0;
      wsServer!.onMessage(ws, JSON.stringify({ type: C2S.EXEC_FENCE, sessionId, policy: "off" }));
      await settle();
      expect(spy.calls).toHaveLength(0);
      expect(getExecFencePolicy(sessionId)).toBeNull();
      const err = await waitForMessage(ws, (m) => m.type === S2C.ERROR, "inline refusal");
      expect(err.message).toContain("inline");
      expect(err.message).toContain("Nothing changed");
    } finally {
      spy.restore();
    }
  });
});

describe("C2S execFence: per-session apply + scoped posture push", () => {
  it("a valid toggle applies to THAT session id and pushes toolExec to its clients only", async () => {
    const { ws: ws1, sessionId: sid1 } = await connectWithSession();
    // A second live session on a second socket: its strip must never move.
    const second = await wsServer!.sessionRegistry.create({});
    const sid2 = second.sessionId;
    const ws2 = createWsMockWs();
    wsServer!.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws2);
    // ws2 attaches to the most-recent session; steer it explicitly to sid2.
    wsServer!.onMessage(ws2, JSON.stringify({ type: C2S.SWITCH_SESSION, sessionId: sid2 }));
    await waitForMessage(ws2, (m) => m.type === S2C.SESSION_CREATED && m.sessionId === sid2, "ws2 attach to sid2");

    // Record the notice on the TOGGLED session's agent only.
    const mgr = wsServer!.sessionRegistry.getSessionManager();
    const added1: any[] = [];
    const added2: any[] = [];
    (mgr.getAgentBySessionId(sid1) as AgentLike).addMessage = (m: any) => { added1.push(m); };
    (mgr.getAgentBySessionId(sid2) as AgentLike).addMessage = (m: any) => { added2.push(m); };

    ws1.messages.length = 0;
    ws2.messages.length = 0;
    wsServer!.onMessage(ws1, JSON.stringify({ type: C2S.EXEC_FENCE, sessionId: sid1, policy: "off" }));

    // The push rides the existing sessionState frame on the existing field.
    const push = await waitForMessage(
      ws1,
      (m) => m.type === S2C.SESSION_STATE && m.key === "toolExec",
      "toolExec posture push",
    );
    expect(push.sessionId).toBe(sid1);
    expect(push.value).toBe("worker (fence: off)"); // the per-session live posture

    // The store moved for sid1 only.
    expect(getExecFencePolicy(sid1)).toBe("off");
    expect(getExecFencePolicy(sid2)).toBeNull();

    // The audit notice landed on the toggled session's transcript (and only
    // there): the same wording /fence writes.
    expect(added1).toHaveLength(1);
    expect(added2).toHaveLength(0);
    const notice = added1[0] as { role: string; content: Array<{ type: string; text: string }> };
    expect(notice.role).toBe("harness");
    expect(notice.content[0]!.text).toBe(FENCE_OFF_NOTICE);

    // Transport-level isolation negative: the client attached to sid2 got no
    // strip change at all (broadcastScoped never crossed sessions).
    await settle();
    expect(stripPushes(ws2)).toHaveLength(0);

    // Flip back to probe for sid1 through the same control: push reflects it.
    ws1.messages.length = 0;
    wsServer!.onMessage(ws1, JSON.stringify({ type: C2S.EXEC_FENCE, sessionId: sid1, policy: "probe" }));
    const back = await waitForMessage(
      ws1,
      (m) => m.type === S2C.SESSION_STATE && m.key === "toolExec",
      "toolExec probe push",
    );
    expect(back.value).toMatch(/^worker \(fence: (bwrap|seatbelt|none -- probe failed)\)$/);
    expect(getExecFencePolicy(sid1)).toBe("probe");
    await settle();
    expect(stripPushes(ws2)).toHaveLength(0);

    // The socket that ASKED for the toggle receives it too (it is attached),
    // and sid2 stayed untouched through the whole exchange.
    expect(getExecFencePolicy(sid2)).toBeNull();
  });
});

// ── Loop close (once, subprocess): webui C2S -> store -> next planned fence ─
//
// The shared broker is process-global, so the end-to-end observation (the
// toggled session's NEXT planned fence actually changes on the SAME broker the
// C2S handler writes) runs virgin in a fixture child. It reuses the prior
// batch's seam pin (recordingPlanner -- a FENCE_GEN env tag proves fenced vs
// unfenced spawns; the sibling's spawn proves boot "probe" survived).

const LOOP_CHILD = join(import.meta.dir, "../fixtures/webui-fence-loop-child.ts");

describe("loop close: webui toggle -> per-session store -> next planned fence", () => {
  it("an execFence C2S off removes the toggled session's fence from its next plan; the sibling stays fenced", async () => {
    // stderr piped (not ignored) and both streams drained concurrently: a
    // crashed child otherwise surfaces here as missing STEP lines with no
    // cause (and a full stderr pipe buffer could stall the child before it
    // exits). expect message argument = house pattern, prints on failure.
    const proc = Bun.spawn([process.execPath, LOOP_CHILD], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    expect(code, `webui-fence-loop-child exited ${code}; child stderr:\n${err}`).toBe(0);
    const steps = new Map<string, Record<string, unknown>>();
    for (const line of out.split("\n")) {
      if (line.startsWith("STEP:")) {
        const j = JSON.parse(line.slice(5)) as { step: string; value: Record<string, unknown> };
        steps.set(j.step, j.value);
      }
    }

    // Born fenced through the seam (gen 91), no override yet.
    expect(String(steps.get("before")!.loop)).toContain("gen=[91]");
    expect(String(steps.get("before")!.sib)).toContain("gen=[91]");
    expect(steps.get("before")!.policy).toBeNull();

    // The push rode the existing sessionState frame/field, scoped to the
    // toggled session; the store moved for it alone.
    const push = steps.get("push")!;
    const pushes = push.pushes as Array<Record<string, unknown>>;
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.key).toBe("toolExec");
    expect(pushes[0]!.value).toBe("worker (fence: off)");
    expect(push.policy).toBe("off");
    expect(push.sibPolicy).toBeNull();

    // NEXT planned fence: GONE for the toggled session (plain spawn, entry
    // replaced -- new runner pid), byte-identical plan for the sibling.
    const after = steps.get("after")!;
    expect(String(after.loop)).toContain("gen=[absent]");
    expect(String(after.sib)).toContain("gen=[91]");
    expect(after.loopPidChanged).toBe(true);
  }, 30_000);
});
