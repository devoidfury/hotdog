// B2 worker-question pins (owner rulings 2026-11-16, the RULED posture):
// worker questions run "wait" -- NO worker-facing timer, an inherited
// "cancel"/"default" coerces to "wait" loudly-but-harmlessly, the manager
// wakes and answers via the existing steer-lane machinery, and a cancelled
// manager releases held worker questions EVENT-DRIVEN as "answerer gone,
// proceed" (never ok-JSON defaults: the D10 marker renders mode
// "unanswered" in the question tool). Interactive rows stay byte-identical
// under every inherited strategy. R3: C2S.questionAnswer on a worker sid is
// REFUSED. House doctrine: no mock.module -- real servers, real bridges,
// real TaskManagers, mock agents/sockets only.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { QuestionTool } from "@extensions/question-tool/index.ts";
import { QUESTION_UNANSWERED, unansweredReason } from "@core/context/input.ts";
import { logger } from "@utils/logger.ts";
import { LlmError } from "@core/error.ts";
import type { AgentLike } from "@core/session/index.ts";
import type { TaskManager } from "@core/session/task-manager.ts";
import { TASK_STATUS } from "@core/session/task-types.ts";
import {
  createWsMockCore,
  createWsMockWs,
  makeWsMockAgent,
} from "../mocks/websocket.ts";
import { TMP_PARENT } from "../helpers.ts";

const SESSIONS_DIR = mkdtempSync(join(TMP_PARENT, "hotdog-sessions-worker-questions-"));

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  try {
    rmSync(SESSIONS_DIR, { recursive: true, force: true });
  } catch {}
});

type MockWs = ReturnType<typeof createWsMockWs>;
type WsServer = ReturnType<typeof createWsServer>;

/** Poll until fn() returns truthy; fails loudly on timeout. */
async function poll<T>(fn: () => T | null | undefined, what: string, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function frames(ws: MockWs): any[] {
  return ws.messages.map((m) => JSON.parse(m));
}

interface Harness {
  core: any;
  wsServer: WsServer;
  ws: MockWs;
  mgrSid: string;
  tm: TaskManager;
  /** Start a worker question through the server's REAL bridge seam (the
   *  AGENT_TOOL_CONTEXT hook), firing the bridge's onQuestionAsked ->
   *  TaskManager.onTaskQuestionAsked lane handoff. Returns the collect
   *  promise and a fresh-input getter (identity proves the dropSession). */
  askWorker: (
    workerAgent: AgentLike,
    questions?: Array<Record<string, unknown>>,
  ) => { pending: Promise<Record<string, unknown>>; inputIdentity: () => unknown };
  releaseWorkerAgent: () => void;
  interrupts: string[];
}

/** Full server with a hanging-until-abort (but releasable) task worker, an
 *  attached manager socket, and a spawned task delegated from it. */
async function makeHarness(opts: {
  questionStrategy?: string;
  questionTimeoutSecs?: number;
  workerSid?: string;
  taskId?: string;
} = {}): Promise<Harness> {
  const core = createWsMockCore();
  const workerSid = opts.workerSid ?? `worker-${Math.random().toString(36).slice(2, 8)}`;
  const releaseBox: { release?: () => void } = {};
  const buildAgent = async (config: { model?: string; sessionId?: string }): Promise<AgentLike> => {
    if (config.sessionId) {
      return makeWsMockAgent({ sessionId: config.sessionId, model: config.model || "test-model" });
    }
    const worker = makeWsMockAgent({
      sessionId: workerSid,
      model: config.model || "test-model",
      abortSignal: null,
      run: () =>
        new Promise<never>((res, rej) => {
          releaseBox.release = () => res(undefined as never);
          (worker as unknown as { abortSignal: AbortSignal }).abortSignal.addEventListener(
            "abort",
            () => rej(LlmError.Cancelled("aborted")),
            { once: true },
          );
        }),
    });
    return worker;
  };
  const wsServer = createWsServer(core, {
    buildAgent,
    ...(opts.questionStrategy !== undefined ? { questionStrategy: opts.questionStrategy } : {}),
    ...(opts.questionTimeoutSecs !== undefined
      ? { questionTimeoutSecs: opts.questionTimeoutSecs }
      : {}),
  });
  const ws = createWsMockWs();
  wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
  await poll(() => ws.messages.some((m) => JSON.parse(m).type === S2C.SESSION_CREATED), "attach");
  const mgrSid = (ws as unknown as any).activeSessionId as string;
  const tm = wsServer.sessionRegistry.getTaskManager()!;

  // Watch the private manager's interrupt (the bridge's cancel-strategy arm
  // lands there; a worker sid must NEVER show up in this list).
  const sm = wsServer.sessionRegistry.getSessionManager();
  const interrupts: string[] = [];
  const origInterrupt = sm.interrupt.bind(sm);
  (sm as any).interrupt = (id: string) => {
    interrupts.push(id);
    return (origInterrupt as (id: string) => unknown)(id);
  };

  const taskId = opts.taskId ?? `task-${Math.random().toString(36).slice(2, 8)}`;
  await tm.spawnTask(taskId, "work", {
    workerModel: "test-model",
    managerAgent: { sessionId: mgrSid },
  } as never);
  await poll(() => tm._test_tasks.get(taskId)!.agent, "worker agent build");

  function inputForAgent(agent: AgentLike): any {
    const handlers = core._registeredHooks["agent:toolContext"];
    expect(handlers).toHaveLength(1);
    const store: Record<string, unknown> = {};
    const toolCtx = {
      get: (k: string) => store[k],
      set: (k: string, v: unknown) => {
        store[k] = v;
      },
    };
    handlers[0]!({ toolCtx, toolName: "question", agent });
    const input = store["input"];
    expect(input).toBeDefined();
    return input;
  }

  return {
    core,
    wsServer,
    ws,
    mgrSid,
    tm,
    interrupts,
    releaseWorkerAgent: () => releaseBox.release?.(),
    askWorker(workerAgent, questions = [{ key: "q", prompt: "Q?" }]) {
      const input = inputForAgent(workerAgent);
      const pending = input.collectAnswers(questions);
      return { pending, inputIdentity: () => input };
    },
  };
}

function workerAgentOf(h: Harness, taskId?: string): AgentLike {
  const id = taskId ?? [...(h.tm as any)._test_tasks.keys()].pop()!;
  return (h.tm as any)._test_tasks.get(id)!.agent;
}

function taskUpdateFrames(ws: MockWs, taskId: string): any[] {
  return frames(ws).filter(
    (m) => m.type === S2C.TASK_UPDATE && m.task?.taskId === taskId,
  );
}

afterEach(() => {
  // Nothing to clean per-test: each harness tears down in its own finally.
});

// ── D2: the getPolicy coercion (loud, harmless, no timer, no interrupt) ─────

describe("worker getPolicy: inherited cancel/default coerce to wait", () => {
  it("host strategy cancel: worker answers wait, warns once per ask, NO interrupt fires, pending survives a tiny timeout", async () => {
    const h = await makeHarness({ questionStrategy: "cancel", questionTimeoutSecs: 0.02 });
    const warns: string[] = [];
    const origWarn = logger.warn;
    logger.warn = (message: string) => {
      warns.push(message);
    };
    try {
      const worker = workerAgentOf(h)!;
      const { pending } = h.askWorker(worker);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      // Past the armed-by-config 20ms deadline (x5): nothing resolved and the
      // cancel arm (sessionManager.interrupt) NEVER fired for the worker.
      await sleep(120);
      expect(settled).toBe(false);
      expect(h.interrupts).not.toContain((worker as any).sessionId);

      // Loud-but-harmless: the coercion names itself in a warn line.
      expect(warns.some((w) => w.includes("cancel") && w.includes('"wait"') && /coerced/.test(w))).toBe(true);

      // The parked question still answers for real through the manager lane.
      expect(h.tm.sendFollowUp([...(h.tm as any)._test_tasks.keys()].pop()!, "the answer")).toBe(true);
      expect(await pending).toEqual({ q: "the answer" });

      h.releaseWorkerAgent();
      await poll(() => {
        const s = h.tm.taskStatus([...(h.tm as any)._test_tasks.keys()].pop()!);
        return s === TASK_STATUS.COMPLETED ? s : null;
      }, "worker completes after answering");
    } finally {
      logger.warn = origWarn;
      h.wsServer.stopTaskManager();
      h.wsServer.stopCleanupLoop();
    }
  });

  it("host strategy default: same coercion, pending survives past the tiny timer", async () => {
    const h = await makeHarness({ questionStrategy: "default", questionTimeoutSecs: 0.02 });
    const warns: string[] = [];
    const origWarn = logger.warn;
    logger.warn = (message: string) => {
      warns.push(message);
    };
    try {
      const worker = workerAgentOf(h)!;
      const { pending } = h.askWorker(worker);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await sleep(120);
      expect(settled).toBe(false);
      expect(warns.some((w) => w.includes("default") && /coerced/.test(w))).toBe(true);

      h.tm.interruptTask([...(h.tm as any)._test_tasks.keys()].pop()!);
      await pending; // terminal release settles it; the worker never hung.
    } finally {
      logger.warn = origWarn;
      h.wsServer.stopTaskManager();
      h.wsServer.stopCleanupLoop();
    }
  });

  it("interactive rows under the SAME cancel/default host configs keep their byte-identical timer behavior", async () => {
    // cancel config on an INTERACTIVE sid: the timer interrupts and defaults
    // resolve -- the untouched normal-session policy (same shape and timing
    // the pre-B2 suites pin).
    const h = await makeHarness({ questionStrategy: "cancel", questionTimeoutSecs: 0.02 });
    try {
      const mgrAgent = h.wsServer.sessionRegistry.get(h.mgrSid)!.agent;
      const handlers = h.core._registeredHooks["agent:toolContext"];
      const store: Record<string, unknown> = {};
      const toolCtx = {
        get: (k: string) => store[k],
        set: (k: string, v: unknown) => {
          store[k] = v;
        },
      };
      handlers[0]!({ toolCtx, toolName: "question", agent: mgrAgent });
      const p = (store["input"] as any).collectAnswers([{ key: "iq", prompt: "I?" }]);
      await expect(p).resolves.toEqual({ iq: "" });
      expect(h.interrupts).toContain(h.mgrSid);
    } finally {
      h.wsServer.stopTaskManager();
      h.wsServer.stopCleanupLoop();
    }
  });
});

// ── Trace A via the ruled posture: eternal park, bus wake, follow-up answer ─

describe("parked worker question: no timer, manager wake, task_followup answers (D1/D9)", () => {
  it("parks past any questionTimeoutSecs value; the wake lands on the manager bus; the follow-up eats it as the answer", async () => {
    // Even a DEFAULT policy with a tiny timeout cannot arm anything for a
    // worker (the coercion above): the pending survives, the wake stands.
    const h = await makeHarness({ questionStrategy: "default", questionTimeoutSecs: 0.02 });
    const origWarn = logger.warn;
    logger.warn = () => {};
    try {
      const worker = workerAgentOf(h)!;
      const taskId = [...(h.tm as any)._test_tasks.keys()].pop()!;

      // Spy the manager's bus BEFORE the ask: the wake must ride it exactly
      // once, harness-sourced.
      const bus = h.wsServer.sessionRegistry.getSessionManager().getBus(h.mgrSid)!;
      expect(bus).toBeDefined();
      const wakes: Array<{ content: unknown; source?: string }> = [];
      const origEnqueue = bus.enqueue.bind(bus);
      (bus as any).enqueue = (content: unknown, opts?: { source?: string }) => {
        wakes.push({ content, source: opts?.source });
        return (origEnqueue as (c: unknown, o?: unknown) => unknown)(content, opts);
      };

      const steered: string[] = [];
      (worker as any).steer = (m: string) => steered.push(m);

      const { pending } = h.askWorker(worker);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await sleep(150);
      expect(settled).toBe(false);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.source).toBe("harness");
      expect(JSON.stringify(wakes[0]!.content)).toContain("[Task question]");
      expect(JSON.stringify(wakes[0]!.content)).toContain(taskId);

      // D9: the follow-up (the steer lane) CONSUMES the held question as the
      // answer -- it never queues as a steer.
      expect(h.tm.sendFollowUp(taskId, "use the ruled posture")).toBe(true);
      expect(await pending).toEqual({ q: "use the ruled posture" });
      expect(steered).toEqual([]);

      h.releaseWorkerAgent();
      await poll(
        () => (h.tm.taskStatus(taskId) === TASK_STATUS.COMPLETED ? true : null),
        "worker resumes and completes",
      );
    } finally {
      logger.warn = origWarn;
      h.wsServer.stopTaskManager();
      h.wsServer.stopCleanupLoop();
    }
  });
});

// ── D1 closure: manager RUN CANCELLED while a worker question is held ──────

describe("manager run cancelled with a held worker question (event-driven closure)", () => {
  it("resolves immediately unanswered; the worker task is NOT interrupted; the lane settles; no orphan pending", async () => {
    const h = await makeHarness({ questionStrategy: "wait" });
    const origWarn = logger.warn;
    logger.warn = () => {};
    try {
      const worker = workerAgentOf(h)!;
      const taskId = [...(h.tm as any)._test_tasks.keys()].pop()!;
      const { pending } = h.askWorker(worker);
      let answer: Record<string, unknown> | null = null;
      let resolveCount = 0;
      pending.then((a) => {
        resolveCount++;
        answer = a;
      });
      await poll(() => (h.tm.listTasks().find((t) => t.taskId === taskId)?.questionPending ? true : null), "ask lands");

      // Esc on the manager: the manager's run is cancelled.
      const before = Date.now();
      await h.wsServer.onMessage(h.ws, JSON.stringify({ type: C2S.CANCEL, sessionId: h.mgrSid }));

      // IMMEDIATE resolution (no timer anywhere): the collect promise settles
      // within a beat, marked unanswered with the honest reason.
      const settledAnswer = await poll(() => answer, "worker question resolves on manager cancel");
      expect(Date.now() - before).toBeLessThan(1000);
      expect(settledAnswer).toEqual({ q: "" });
      expect(unansweredReason(settledAnswer)).toContain("cancelled");

      // Resolved EXACTLY once (delete-first: no double-resolve), and the
      // pending is gone from the bridge (the settle hook flipped the entry).
      await sleep(30);
      expect(resolveCount).toBe(1);
      expect(h.tm.listTasks().find((t) => t.taskId === taskId)!.questionPending).toBe(false);

      // THE WORKER TASK IS NOT INTERRUPTED by its manager's cancel: it stays
      // RUNNING and finishes its turn honestly.
      expect(h.tm.taskStatus(taskId)).toBe(TASK_STATUS.RUNNING);
      expect(h.interrupts).not.toContain((worker as any).sessionId);
      h.releaseWorkerAgent();
      await poll(() => (h.tm.taskStatus(taskId) === TASK_STATUS.COMPLETED ? true : null), "worker completes on its own");
      // No orphan pending survives the completion either.
      await sleep(30);
      expect(resolveCount).toBe(1);
    } finally {
      logger.warn = origWarn;
      h.wsServer.stopTaskManager();
      h.wsServer.stopCleanupLoop();
    }
  });

  it("the question tool renders the manager-gone release as mode unanswered + honest text, never ok-JSON defaults", async () => {
    const h = await makeHarness({ questionStrategy: "wait" });
    const origWarn = logger.warn;
    logger.warn = () => {};
    try {
      const worker = workerAgentOf(h)!;
      const questions = [{ key: "q", prompt: "Which path?", default: "fallback" }];
      const handlers = h.core._registeredHooks["agent:toolContext"];
      const store: Record<string, unknown> = {};
      const toolCtx = {
        get: (k: string) => store[k],
        set: (k: string, v: unknown) => {
          store[k] = v;
        },
      };
      handlers[0]!({ toolCtx, toolName: "question", agent: worker });
      const tool = new QuestionTool();
      const emitted: unknown[] = [];
      (worker as any).emitOutput = (type: string, data: unknown) => emitted.push({ type, data });
      const run = tool.execute({ questions }, { get: (k: string) => (k === "agent" ? worker : store[k]) } as never);
      await sleep(10);
      await h.wsServer.onMessage(h.ws, JSON.stringify({ type: C2S.CANCEL, sessionId: h.mgrSid }));
      const result = await run;
      expect(result.error).toBeNull();
      expect(result.success).toBe(true);
      expect(result.output).toContain("the question was not answered");
      expect(result.output).toContain("proceed without an answer");
      expect(result.output).not.toContain("fallback");
      expect(result.metadata?.get("mode")).toBe("unanswered");
    } finally {
      logger.warn = origWarn;
      h.releaseWorkerAgent();
      h.wsServer.stopTaskManager();
      h.wsServer.stopCleanupLoop();
    }
  });
});

// ── Manager session DELETE: existing cascade, no orphan, no double-resolve ──

describe("manager session deleted with a held worker question", () => {
  it("keeps the interrupt cascade, settles the held question exactly once, and drops the bridge entry", async () => {
    const h = await makeHarness({ questionStrategy: "wait" });
    const origWarn = logger.warn;
    logger.warn = () => {};
    try {
      const worker = workerAgentOf(h)!;
      const taskId = [...(h.tm as any)._test_tasks.keys()].pop()!;
      const { pending, inputIdentity } = h.askWorker(worker);
      let answer: Record<string, unknown> | null = null;
      let resolveCount = 0;
      pending.then((a) => {
        resolveCount++;
        answer = a;
      });
      await poll(() => (h.tm.listTasks().find((t) => t.taskId === taskId)?.questionPending ? true : null), "ask lands");

      await h.wsServer.onMessage(h.ws, JSON.stringify({ type: C2S.DELETE_SESSION, sessionId: h.mgrSid }));

      // The existing cascade: the manager's delegated tasks are interrupted.
      await poll(() => (h.tm.taskStatus(taskId) === TASK_STATUS.CANCELLED ? true : null), "cascade cancels the task");

      // The held question settles EXACTLY ONCE (terminal release; the
      // bridge's delete-first idiom means the cascade and the release can
      // never both resolve it), marked unanswered with the honest reason.
      const settledAnswer = await poll(() => answer, "held question settles once");
      expect(settledAnswer).toEqual({ q: "" });
      expect(unansweredReason(settledAnswer)).toContain("cancelled");
      await sleep(30);
      expect(resolveCount).toBe(1);
      // NEVER STALE (delete-cascade order too): the terminal TASK_UPDATE and
      // every later snapshot carry questionPending false, and the late settle
      // cannot re-arm anything.
      const lastFrame = taskUpdateFrames(h.ws, taskId).at(-1)!;
      expect(lastFrame.task.status).toBe(TASK_STATUS.CANCELLED);
      expect(lastFrame.task.questionPending).toBe(false);
      expect(h.tm.listTasks().find((t) => t.taskId === taskId)!.questionPending).toBe(false);

      // No orphan: the terminal release ran dropSession, so the bridge hands
      // out a FRESH input object for the worker sid (leak-gone identity).
      const fresh = (() => {
        const handlers = h.core._registeredHooks["agent:toolContext"];
        const s: Record<string, unknown> = {};
        handlers[0]!({ toolCtx: { get: (k: string) => s[k], set: (k: string, v: unknown) => { s[k] = v; } }, toolName: "question", agent: worker });
        return s["input"];
      })();
      expect(fresh).not.toBe(inputIdentity());
      expect(h.wsServer.sessionRegistry.get(h.mgrSid)).toBeNull();
    } finally {
      logger.warn = origWarn;
      h.wsServer.stopTaskManager();
      h.wsServer.stopCleanupLoop();
    }
  });
});

// ── R3 refusal: C2S.questionAnswer on a worker sid ──────────────────────────

describe("R3: worker-sid questionAnswer refused; the manager lane is the ONE answer path", () => {
  it("refuses with the honest error, leaves the pending and the wake alone, and fires no QUESTION_ANSWERED broadcast", async () => {
    const h = await makeHarness({ questionStrategy: "wait" });
    const origWarn = logger.warn;
    logger.warn = () => {};
    try {
      const worker = workerAgentOf(h)!;
      const workerSid = (worker as any).sessionId as string;
      const taskId = [...(h.tm as any)._test_tasks.keys()].pop()!;
      const { pending } = h.askWorker(worker);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await poll(() => (h.tm.listTasks().find((t) => t.taskId === taskId)?.questionPending ? true : null), "ask lands");
      const beforeCount = h.ws.messages.length;

      await h.wsServer.onMessage(
        h.ws,
        JSON.stringify({ type: C2S.QUESTION_ANSWER, sessionId: workerSid, answers: { q: "client bypass" } }),
      );

      // Honest error, no silent drop...
      const newFrames = frames(h.ws).slice(beforeCount);
      const errFrame = newFrames.find((m) => m.type === S2C.ERROR);
      expect(errFrame).toBeDefined();
      expect(errFrame.message).toContain("task_followup");
      // ...the pending is UNTOUCHED, no answer broadcast anywhere...
      await sleep(30);
      expect(settled).toBe(false);
      expect(frames(h.ws).some((m) => m.type === S2C.QUESTION_ANSWERED)).toBe(false);
      // ...and the manager's answer lane still works: the follow-up eats it.
      expect(h.tm.sendFollowUp(taskId, "manager answers")).toBe(true);
      expect(await pending).toEqual({ q: "manager answers" });
      expect(frames(h.ws).slice(beforeCount).some((m) => m.type === S2C.QUESTION_ANSWERED)).toBe(false);

      h.releaseWorkerAgent();
      await poll(() => (h.tm.taskStatus(taskId) === TASK_STATUS.COMPLETED ? true : null), "completion");
    } finally {
      logger.warn = origWarn;
      h.wsServer.stopTaskManager();
      h.wsServer.stopCleanupLoop();
    }
  });

  it("interactive-sid questionAnswer is unchanged (answered + QUESTION_ANSWERED broadcast)", async () => {
    const h = await makeHarness({ questionStrategy: "wait" });
    try {
      const mgrAgent = h.wsServer.sessionRegistry.get(h.mgrSid)!.agent;
      const handlers = h.core._registeredHooks["agent:toolContext"];
      const store: Record<string, unknown> = {};
      handlers[0]!({ toolCtx: { get: (k: string) => store[k], set: (k: string, v: unknown) => { store[k] = v; } }, toolName: "question", agent: mgrAgent });
      const p = (store["input"] as any).collectAnswers([{ key: "iq", prompt: "I?" }]);
      await h.wsServer.onMessage(
        h.ws,
        JSON.stringify({ type: C2S.QUESTION_ANSWER, sessionId: h.mgrSid, answers: { iq: "human" } }),
      );
      await expect(p).resolves.toEqual({ iq: "human" });
      expect(frames(h.ws).some((m) => m.type === S2C.QUESTION_ANSWERED && m.sessionId === h.mgrSid)).toBe(true);
    } finally {
      h.wsServer.stopTaskManager();
      h.wsServer.stopCleanupLoop();
    }
  });
});

// ── Terminal release honesty + the questionPending badge round-trip ────────

describe("task wire: questionPending badge and terminal honesty", () => {
  it("ask flips questionPending true on the manager-scoped TASK_UPDATE; settle flips it back; the fresh-attach snapshot carries it", async () => {
    const h = await makeHarness({ questionStrategy: "wait" });
    const origWarn = logger.warn;
    logger.warn = () => {};
    try {
      const worker = workerAgentOf(h)!;
      const taskId = [...(h.tm as any)._test_tasks.keys()].pop()!;
      // Snapshot grammar: the spawn frame carries the flag as false while
      // nothing is held (never stale, never absent-on-flip).
      const spawnFrame = taskUpdateFrames(h.ws, taskId)[0];
      expect(spawnFrame?.task.questionPending).toBe(false);

      const { pending } = h.askWorker(worker);
      await poll(() => (h.tm.listTasks().find((t) => t.taskId === taskId)?.questionPending ? true : null), "ask lands");
      const flipsOn = taskUpdateFrames(h.ws, taskId).filter((m) => m.task.questionPending === true);
      expect(flipsOn.length).toBeGreaterThanOrEqual(1);

      // A socket attaching NOW gets the badge on the snapshot too.
      const ws2 = createWsMockWs();
      h.wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws2);
      await poll(() => ws2.messages.some((m) => JSON.parse(m).type === S2C.TASK_LIST), "snapshot");
      const snap = JSON.parse(ws2.messages.find((m) => JSON.parse(m).type === S2C.TASK_LIST)!);
      expect(snap.tasks.find((t: any) => t.taskId === taskId)?.questionPending).toBe(true);

      // Settle (answer) flips it back on the manager-scoped TASK_UPDATE.
      expect(h.tm.sendFollowUp(taskId, "done")).toBe(true);
      await pending;
      const flipsOff = taskUpdateFrames(h.ws, taskId).filter((m) => m.task.questionPending === false);
      expect(flipsOff.length).toBeGreaterThanOrEqual(1);
      expect(h.tm.listTasks().find((t) => t.taskId === taskId)!.questionPending).toBe(false);

      h.releaseWorkerAgent();
      await poll(() => (h.tm.taskStatus(taskId) === TASK_STATUS.COMPLETED ? true : null), "completion");
      // The terminal snapshot never carries a stale badge.
      const final = taskUpdateFrames(h.ws, taskId).at(-1)!;
      expect(final.task.questionPending).toBe(false);
      expect(final.task.status).toBe(TASK_STATUS.COMPLETED);
    } finally {
      logger.warn = origWarn;
      h.wsServer.stopTaskManager();
      h.wsServer.stopCleanupLoop();
    }
  });

  it("terminal (interrupt) with a held question: resolveUnanswered marker + dropSession, no leak", async () => {
    const h = await makeHarness({ questionStrategy: "wait" });
    const origWarn = logger.warn;
    logger.warn = () => {};
    try {
      const worker = workerAgentOf(h)!;
      const taskId = [...(h.tm as any)._test_tasks.keys()].pop()!;
      const { pending, inputIdentity } = h.askWorker(worker);
      let answer: Record<string, unknown> | null = null;
      pending.then((a) => {
        answer = a;
      });
      await poll(() => (h.tm.listTasks().find((t) => t.taskId === taskId)?.questionPending ? true : null), "ask lands");

      expect(h.tm.interruptTask(taskId)).toBe(true);
      await poll(() => (h.tm.taskStatus(taskId) === TASK_STATUS.CANCELLED ? true : null), "terminal");
      const settledAnswer = await poll(() => answer, "release settles");
      expect(unansweredReason(settledAnswer)).toContain("cancelled");
      // NEVER STALE (terminal-while-held order): the terminal TASK_UPDATE and
      // every later snapshot carry questionPending false -- the terminal
      // transition owns the badge clear, not the settle that can no longer
      // match the (non-RUNNING) entry.
      const lastFrame = taskUpdateFrames(h.ws, taskId).at(-1)!;
      expect(lastFrame.task.status).toBe(TASK_STATUS.CANCELLED);
      expect(lastFrame.task.questionPending).toBe(false);
      expect(h.tm.listTasks().find((t) => t.taskId === taskId)!.questionPending).toBe(false);
      // dropSession cleared the #inputs entry (fresh-object identity).
      const handlers = h.core._registeredHooks["agent:toolContext"];
      const s: Record<string, unknown> = {};
      handlers[0]!({ toolCtx: { get: (k: string) => s[k], set: (k: string, v: unknown) => { s[k] = v; } }, toolName: "question", agent: worker });
      expect(s["input"]).not.toBe(inputIdentity());
    } finally {
      logger.warn = origWarn;
      h.wsServer.stopTaskManager();
      h.wsServer.stopCleanupLoop();
    }
  });
});

// ── The marker is invisible to every ordinary consumer ─────────────────────

describe("D10 marker hygiene (Symbol-keyed, non-enumerable)", () => {
  it("rides no JSON, no keys, no spread; only unansweredReason reads it", () => {
    const answers: Record<string, unknown> = { q: "" };
    Object.defineProperty(answers, QUESTION_UNANSWERED, {
      value: "the delegating manager's run was cancelled",
      enumerable: false,
    });
    expect(JSON.stringify(answers)).toBe('{"q":""}');
    expect(Object.keys(answers)).toEqual(["q"]);
    expect({ ...answers }).toEqual({ q: "" });
    expect(unansweredReason(answers)).toContain("cancelled");
    expect(unansweredReason({ q: "" })).toBeNull();
    expect(unansweredReason(null)).toBeNull();
  });
});
