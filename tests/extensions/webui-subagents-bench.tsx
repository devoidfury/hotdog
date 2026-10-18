/// <reference lib="dom" />
// Bench (excluded from `bun test`): streams synthetic taskActivity deltas
// through the real chat handler chain and measures the panel body's per-flush
// cost, wired exactly like app.tsx (activityVersionAtom -> coalescer ->
// per-panel render).
//
// Run: bun --preload ./tests/dom-helper/index.ts tests/extensions/webui-subagents-bench.tsx

import { createChat } from "@extensions/webui/ui/chat.ts";
import { createActivityRegistry, type ActivityRegistry } from "@extensions/webui/ui/subagents.tsx";
import type { TaskInfoWire } from "@extensions/websocket/protocol.ts";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function taskInfo(taskId: string): TaskInfoWire {
  return {
    taskId,
    description: "worker",
    sessionId: "s1",
    status: "running",
    createdAt: 0,
    startedAt: null,
    endedAt: null,
    activeMs: 0,
    inRun: true,
    turnStartedAt: Date.now(),
  };
}

// Node-creation counter (createElement + createTextNode).
function counting(on: boolean): () => number {
  const doc = document as unknown as Record<string, unknown>;
  const origCreate = doc.createElement as (t: string) => unknown;
  const origText = doc.createTextNode as (t: string) => unknown;
  let created = 0;
  if (on) {
    doc.createElement = ((tag: string) => (created++, origCreate(tag))) as typeof origCreate;
    doc.createTextNode = ((t: string) => (created++, origText(t))) as typeof origText;
  }
  return () => {
    doc.createElement = origCreate;
    doc.createTextNode = origText;
    return created;
  };
}

interface Run {
  growthUsPerFlush: number; // flushes 1..200 (window filling toward the cap)
  capUsPerFlush: number; // flushes 201..1000 (steady state at the 200-block cap)
  coalescedUs: number; // 1000 deltas arriving between frames -> one flush
  coalescedNodes: number; // nodes created by that single coalesced flush
  totalNodes: number; // nodes created across the whole run
  appRenders: number; // must stay 0: activity must never render the App tree
}

function run(nPanels: number, toolCall: boolean): Run {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  FakeWebSocket.instances = [];
  const chat = createChat({
    token: null,
    host: "localhost",
    getMessageListContainer: () => null,
  });
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  const ids: string[] = [];
  for (let p = 0; p < nPanels; p++) {
    const id = `t${p}`;
    ws.emit({ type: "taskList", tasks: [taskInfo(id)] });
    ids.push(id);
  }

  // App-render sentinel: wired like app.tsx's render effect on one of the
  // atoms it watches. taskActivity deltas must never flip these.
  let appRenders = 0;
  const stopAppSpy = chat.workingAtom.effect(() => appRenders++);

  // Panels + coalescer, mirroring app.tsx wiring: ref-set mounts each panel
  // body, renderAll is the coalesced flush, ref(null) tears it down.
  const mkRegistry = (): [ActivityRegistry, HTMLElement[]] => {
    const reg = createActivityRegistry((tid) => chat.getTaskActivity(tid));
    const set = reg.ref as unknown as (id: string) => (el: HTMLElement | null) => void;
    const els = ids.map((id) => {
      const el = document.createElement("div");
      set(id)(el);
      return el;
    });
    return [reg, els];
  };
  const [reg1] = mkRegistry();
  const flush = () => reg1.renderAll();

  const emit = (i: number) => {
    for (const id of ids) {
      ws.emit(
        toolCall
          ? { type: "taskActivity", taskId: id, activity: { kind: "tool_call", name: "bash", args: `cmd${i}` } }
          : { type: "taskActivity", taskId: id, activity: { kind: "text", content: "tok" } },
      );
    }
  };

  const stopCount = counting(true);
  let growthTotal = 0;
  let capTotal = 0;
  const N = 1000;
  for (let i = 0; i < N; i++) {
    emit(i);
    const t0 = Bun.nanoseconds();
    flush(); // worst case: one flush per delta (rAF coalescing caps this at ~60/s)
    const dt = Bun.nanoseconds() - t0;
    if (i < 200) growthTotal += dt;
    else capTotal += dt;
  }
  const totalNodes = stopCount();

  // Realistic worst burst: 1000 deltas between two frames, one coalesced
  // flush on a freshly mounted (empty) panel.
  ids.forEach((id) => reg1.ref(id)(null as never));
  chat.clearTasks();
  const [reg2] = mkRegistry();
  for (let i = 0; i < N; i++) emit(i);
  const stop2 = counting(true);
  const c0 = Bun.nanoseconds();
  reg2.renderAll();
  const coalescedUs = (Bun.nanoseconds() - c0) / 1000;
  const coalescedNodes = stop2();
  ids.forEach((id) => reg2.ref(id)(null as never));

  stopAppSpy();
  chat.disconnect();
  chat.clearTasks();
  return {
    growthUsPerFlush: growthTotal / 1000 / 200,
    capUsPerFlush: capTotal / 1000 / 800,
    coalescedUs,
    coalescedNodes,
    totalNodes,
    appRenders,
  };
}

function report(label: string, r: Run): void {
  console.log(
    `${label.padEnd(28)} growth ${r.growthUsPerFlush.toFixed(1)} us/flush | ` +
      `at cap ${r.capUsPerFlush.toFixed(1)} us/flush | ` +
      `1000-delta burst -> 1 flush: ${r.coalescedUs.toFixed(1)} us, ${r.coalescedNodes} nodes | ` +
      `total nodes/1000 deltas: ${r.totalNodes} | App renders: ${r.appRenders}`,
  );
}

// Warm up (JIT), then measure.
run(1, true);
report("1 panel, tool_call deltas", run(1, true));
report("2 panels, tool_call deltas", run(2, true));
report("1 panel, text deltas", run(1, false));
