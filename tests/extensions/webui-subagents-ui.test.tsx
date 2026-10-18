// Streaming tests for the webui subagent feed: per-panel activity bodies
// (keyed appends, in-place merged-tail patches, cap eviction), coalesced
// invalidations, and clean unmounts.

import { describe, it, expect, afterEach } from "bun:test";
import { createChat, type ChatController } from "@extensions/webui/ui/chat.ts";
import { createActivityRegistry, formatElapsed, SubagentsStrip, TaskPanel, chipLabel, runDiscriminators, statusGlyph, MAX_STRIP_CHIPS, type ActivityRegistry } from "@extensions/webui/ui/subagents.tsx";
import { createCoalescer } from "@extensions/webui/ui/batch.ts";
import { mount, renderToString } from "@utils/jsx";
import type { TaskInfoWire } from "@extensions/websocket/protocol.ts";

// ── Coalescer ───────────────────────────────────────────────────────────────

describe("createCoalescer", () => {
  it("collapses repeated invalidations into one flush per scheduled task", () => {
    let flushes = 0;
    const pending: (() => void)[] = [];
    const invalidate = createCoalescer(() => flushes++, (fn) => pending.push(fn));
    for (let i = 0; i < 100; i++) invalidate();
    expect(pending).toHaveLength(1);
    pending.shift()!();
    expect(flushes).toBe(1);
    // A later invalidation queues a fresh task.
    invalidate();
    expect(pending).toHaveLength(1);
    pending.shift()!();
    expect(flushes).toBe(2);
  });

  it("defaults to animation frames when no scheduler is given", () => {
    // The default policy is rAF; absent under Bun, so stand one up rather
    // than let the fallback throw.
    const g = globalThis as { requestAnimationFrame?: (fn: () => void) => number };
    const saved = g.requestAnimationFrame;
    const frames: (() => void)[] = [];
    g.requestAnimationFrame = (fn) => {
      frames.push(fn);
      return frames.length;
    };
    try {
      let flushes = 0;
      const invalidate = createCoalescer(() => flushes++);
      invalidate();
      invalidate();
      expect(frames).toHaveLength(1);
      frames[0]!();
      expect(flushes).toBe(1);
    } finally {
      if (saved === undefined) delete g.requestAnimationFrame;
      else g.requestAnimationFrame = saved;
    }
  });
});

// ── Harness: real chat feed through a fake socket ───────────────────────────

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

function fakeEl(tag: string): HTMLElement {
  return document.createElement(tag) as unknown as HTMLElement;
}

function classes(el: Element): string {
  return el.getAttribute("class") ?? "";
}

const taskInfoWire: TaskInfoWire = {
  taskId: "t1",
  description: "worker",
  sessionId: "s1",
  status: "running",
  createdAt: 0,
  startedAt: null,
  endedAt: null,
};

// Ref callbacks take the runtime's structural DomElement; re-type for
// DOM-lib HTMLElements (same trick as domRef in app.tsx).
function bind(reg: ActivityRegistry, taskId: string): (el: HTMLElement | null) => void {
  return reg.ref(taskId) as unknown as (el: HTMLElement | null) => void;
}

describe("panel activity body", () => {
  const RealWebSocket = globalThis.WebSocket;
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.disconnect();
    // The activity store is module-level in chat.ts; without this, blocks
    // accumulate across tests and the block cap skews later assertions.
    chat?.clearTasks();
    chat = null;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
  });

  function makeChat(): { chat: ChatController; ws: FakeWebSocket; reg: ActivityRegistry } {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    chat = createChat({ token: null, host: "localhost", getMessageListContainer: () => null });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws.emit({ type: "taskList", tasks: [taskInfoWire] });
    const reg = createActivityRegistry((id) => chat!.getTaskActivity(id));
    return { chat, ws, reg };
  }

  const emitText = (ws: FakeWebSocket, text: string, taskId = "t1") =>
    ws.emit({ type: "taskActivity", taskId, activity: { kind: "text", content: text } });
  const emitTool = (ws: FakeWebSocket, name: string, taskId = "t1") =>
    ws.emit({ type: "taskActivity", taskId, activity: { kind: "tool_call", name, args: `cmd ${name}` } });

  it("shows the waiting placeholder while there are no blocks", () => {
    const { reg } = makeChat();
    const el = fakeEl("div");
    bind(reg, "t1")(el);
    expect(el.children).toHaveLength(1);
    expect(classes(el.children[0]!)).toContain("task-act-empty");
  });

  it("appends rows for new blocks and keeps earlier nodes untouched", () => {
    const { ws, reg } = makeChat();
    const el = fakeEl("div");
    bind(reg, "t1")(el);
    emitText(ws, "b0");
    reg.renderAll();
    expect(el.children).toHaveLength(1); // placeholder replaced by the row
    const first = el.children[0]!;
    expect(classes(first)).toContain("task-act-text");
    expect(first.textContent).toBe("b0");
    emitTool(ws, "a");
    reg.renderAll();
    expect(el.children).toHaveLength(2);
    expect(el.children[0]!).toBe(first);
    expect(classes(el.children[1]!)).toContain("task-act-tool");
  });

  it("patches merged text deltas in place (same node, patched text)", () => {
    const { ws, reg } = makeChat();
    const el = fakeEl("div");
    bind(reg, "t1")(el);
    emitText(ws, "hel");
    reg.renderAll();
    const first = el.children[0]!;
    // chat.ts merges consecutive deltas into the same block object.
    emitText(ws, "lo");
    reg.renderAll();
    expect(el.children).toHaveLength(1);
    expect(el.children[0]!).toBe(first);
    expect(first.textContent).toBe("hello");
  });

  it("drops evicted rows at the cap without rebuilding the survivors", () => {
    const { ws, reg } = makeChat();
    const el = fakeEl("div");
    bind(reg, "t1")(el);
    for (let i = 0; i < 200; i++) {
      emitTool(ws, `t${i}`);
      reg.renderAll();
    }
    const snapshot = Array.from(el.children);
    // One append past the cap: the oldest row goes, the rest keep identity.
    emitTool(ws, "t200");
    reg.renderAll();
    expect(el.children).toHaveLength(200);
    expect(el.children[0]!).toBe(snapshot[1]!);
    expect(el.children[198]!).toBe(snapshot[199]!);
    expect(el.children[199]!).not.toBe(snapshot[199]!);
    expect(el.children[199]!.textContent).toContain("t200");
  });

  it("renders tool_call and errored tool_result markup", () => {
    const { ws, reg } = makeChat();
    const el = fakeEl("div");
    bind(reg, "t1")(el);
    ws.emit({ type: "taskActivity", taskId: "t1", activity: { kind: "tool_call", name: "bash", args: "ls -la" } });
    ws.emit({ type: "taskActivity", taskId: "t1", activity: { kind: "tool_result", name: "bash", output: "", error: "boom" } });
    reg.renderAll();
    const call = el.children[0]!;
    const result = el.children[1]!;
    expect(classes(call)).toContain("task-act-tool");
    expect(call.textContent).toContain("bash");
    expect(call.textContent).toContain("ls -la");
    expect(classes(result)).toContain("error");
    expect(result.textContent).toContain("boom");
  });

  it("renders wire text as text, never as markup", () => {
    const { ws, reg } = makeChat();
    const el = fakeEl("div");
    bind(reg, "t1")(el);
    emitText(ws, "<img src=x onerror=alert(1)>");
    reg.renderAll();
    const row = el.children[0]!;
    expect(row.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(row.children).toHaveLength(0);
  });

  it("shows the placeholder again when the store resets (clearTasks)", () => {
    const { ws, reg } = makeChat();
    const el = fakeEl("div");
    bind(reg, "t1")(el);
    emitText(ws, "a");
    reg.renderAll();
    expect(el.children).toHaveLength(1);
    expect(classes(el.children[0]!)).not.toContain("task-act-empty");
    chat!.clearTasks();
    reg.renderAll();
    expect(el.children).toHaveLength(1);
    expect(classes(el.children[0]!)).toContain("task-act-empty");
  });

  // ── Teardown ──────────────────────────────────────────────────────────────
  it("unmounts on close; later flushes never render into a dead body", () => {
    const { ws, reg } = makeChat();
    const el = fakeEl("div");
    const ref = bind(reg, "t1");
    ref(el);
    emitText(ws, "x");
    reg.renderAll();
    expect(el.children).toHaveLength(1);
    ref(null);
    expect(el.children).toHaveLength(0);
    emitTool(ws, "after-close");
    reg.renderAll();
    expect(el.children).toHaveLength(0);
  });

  it("a rebind without a preceding null replaces the mount (no orphan)", () => {
    const { ws, reg } = makeChat();
    const el1 = fakeEl("div");
    const el2 = fakeEl("div");
    const ref = bind(reg, "t1");
    ref(el1);
    emitText(ws, "x");
    reg.renderAll();
    expect(el1.children).toHaveLength(1);
    // A bare set on a new element (no null) must not leave el1 rendering an
    // orphaned mount that no flush or unmount can ever reach.
    ref(el2);
    expect(el1.children).toHaveLength(0); // old mount torn down, not orphaned
    emitText(ws, "y");
    reg.renderAll();
    expect(el2.children).toHaveLength(1); // sole live body
    expect(el2.children[0]!.textContent).toBe("xy");
    ref(null);
    expect(el2.children).toHaveLength(0);
  });

  it("repeated open/close cycles re-mount cleanly on the same task", () => {
    const { ws, reg } = makeChat();
    const ref = bind(reg, "t1");
    for (let i = 0; i < 3; i++) {
      const el = fakeEl("div");
      ref(el);
      // Fresh mount shows whatever the store already holds (placeholder only
      // while there are no blocks).
      expect(el.children).toHaveLength(Math.max(1, i));
      emitTool(ws, `cycle${i}`);
      reg.renderAll();
      expect(el.children).toHaveLength(i + 1);
      ref(null);
      expect(el.children).toHaveLength(0);
    }
  });

  it("renders each open panel independently from one renderAll", () => {
    const { ws, reg } = makeChat();
    const task2: TaskInfoWire = {
      taskId: "t2",
      description: "other",
      sessionId: "s1",
      status: "running",
      createdAt: 0,
      startedAt: null,
      endedAt: null,
    };
    ws.emit({ type: "taskList", tasks: [task2] });
    const el1 = fakeEl("div");
    const el2 = fakeEl("div");
    bind(reg, "t1")(el1);
    bind(reg, "t2")(el2);
    emitTool(ws, "only-t1");
    reg.renderAll();
    expect(el1.children).toHaveLength(1);
    expect(classes(el1.children[0]!)).not.toContain("task-act-empty");
    expect(el2.children).toHaveLength(1);
    expect(classes(el2.children[0]!)).toContain("task-act-empty");
    // Closing t1 leaves t2 live.
    bind(reg, "t1")(null);
    expect(el1.children).toHaveLength(0);
    emitText(ws, "still streaming", "t2");
    reg.renderAll();
    expect(el2.children).toHaveLength(1);
    expect(el2.children[0]!.textContent).toBe("still streaming");
  });

  // ── Coalescing / constant work (the perf regression) ──────────────────────

  it("coalesces 1000 text deltas into one render and one block node", () => {
    const { chat, ws, reg } = makeChat();
    const el = fakeEl("div");
    bind(reg, "t1")(el);
    let flushes = 0;
    const pending: (() => void)[] = [];
    const invalidate = createCoalescer(() => {
      flushes++;
      reg.renderAll();
    }, (fn) => pending.push(fn));
    chat.activityVersionAtom.effect(invalidate);

    // Count element creations through the burst: the metric that grew with
    // accumulated blocks before the per-panel mount (~300k nodes per 1000
    // deltas when the body diffed inside the App tree).
    const doc = document as unknown as { createElement: (t: string) => unknown };
    const origCreate = doc.createElement.bind(doc);
    let created = 0;
    doc.createElement = ((tag: string) => {
      created++;
      return origCreate(tag);
    }) as typeof doc.createElement;
    try {
      for (let i = 0; i < 1000; i++) emitText(ws, "tok");
      while (pending.length > 0) pending.shift()!();
    } finally {
      doc.createElement = origCreate;
    }

    expect(flushes).toBe(1); // coalesced, not 1000
    expect(el.children).toHaveLength(1); // consecutive text merged into one block
    expect(el.children[0]!.textContent).toHaveLength(3000); // "tok" x1000
    expect(created).toBeLessThanOrEqual(2); // just the new block row (placeholder was reused->replaced)
  });

  it("keeps per-render DOM work constant once the window is at the cap", () => {
    const { chat, ws, reg } = makeChat();
    const el = fakeEl("div");
    bind(reg, "t1")(el);
    const pending: (() => void)[] = [];
    const invalidate = createCoalescer(() => reg.renderAll(), (fn) => pending.push(fn));
    chat.activityVersionAtom.effect(invalidate);

    // Fill the 200-block window (and then some).
    for (let i = 0; i < 260; i++) emitTool(ws, `x${i}`);
    while (pending.length > 0) pending.shift()!();
    expect(el.children).toHaveLength(200);
    const survivor = el.children[50]!;

    // Measure the next window's worth: nodes created per 200 deltas must not
    // scale with what is already rendered.
    const doc = document as unknown as { createElement: (t: string) => unknown };
    const origCreate = doc.createElement.bind(doc);
    let created = 0;
    doc.createElement = ((tag: string) => {
      created++;
      return origCreate(tag);
    }) as typeof doc.createElement;
    try {
      for (let i = 0; i < 50; i++) {
        emitTool(ws, `y${i}`);
        while (pending.length > 0) pending.shift()!();
      }
    } finally {
      doc.createElement = origCreate;
    }
    // 50 new tool_call rows = 3 elements each (div > span + pre); the 150
    // survivors keep their nodes, only the window slid.
    expect(created).toBeLessThanOrEqual(50 * 3);
    expect(el.children).toHaveLength(200);
    expect(el.children[0]!).toBe(survivor);
  });

  it("streams through a mounted TaskPanel; parent re-renders never touch the body", () => {
    const { ws, reg } = makeChat();
    const host = fakeEl("div");
    const panel = (now: number) => (
      <TaskPanel
        task={taskInfoWire}
        now={now}
        zBase={1}
        control={null}
        bodyRef={reg.ref("t1")}
        onClose={() => {}}
        onCancel={() => {}}
        onFollowup={() => {}}
      />
    );
    const app = mount(panel(0), host as unknown as Parameters<typeof mount>[1]);
    const body = host.querySelector(".task-overlay-body")!;
    emitText(ws, "live");
    reg.renderAll();
    expect(body.children).toHaveLength(1);
    const row = body.children[0]!;
    // Parent (App-style) re-render: the body div has no child slots, so the
    // streamed row survives untouched.
    app.render(panel(1000));
    expect(body.children[0]).toBe(row);
    expect(body.textContent).toBe("live");
    // Removing the panel from the tree fires ref(null): body content is gone.
    app.unmount();
    expect(body.children).toHaveLength(0);
  });
});

// ── TaskPanel contract ──────────────────────────────────────────────────────

describe("TaskPanel", () => {
  const task = taskInfoWire;

  it("leaves the activity body to the per-panel mount (no JSX block children)", () => {
    const html = renderToString(
      <TaskPanel
        task={task}
        now={0}
        zBase={1}
        control={null}
        bodyRef={() => {}}
        onClose={() => {}}
        onCancel={() => {}}
        onFollowup={() => {}}
      />,
    );
    expect(html).toContain('class="task-overlay-body"');
    // Blocks must never be part of the App tree's JSX output: that is what
    // made every streaming delta diff hundreds of nodes.
    expect(html).not.toContain("task-act");
  });

  it("renders control feedback notes, ok and error variants", () => {
    const panel = (control: { ok: boolean; text: string }) => (
      <TaskPanel
        task={task}
        now={0}
        zBase={1}
        control={control}
        bodyRef={() => {}}
        onClose={() => {}}
        onCancel={() => {}}
        onFollowup={() => {}}
      />
    );
    const ok = renderToString(panel({ ok: true, text: "steered" }));
    expect(ok).toContain('class="task-control-note"');
    expect(ok).toContain("steered");
    const err = renderToString(panel({ ok: false, text: "no such task" }));
    expect(err).toContain('class="task-control-note error"');
    expect(err).toContain("no such task");
  });

  it("submits the steering draft, clears the input, and ignores blank drafts", () => {
    const steered: [string, string][] = [];
    const host = fakeEl("div");
    mount(
      <TaskPanel
        task={{ ...task, taskId: "steer-1" }}
        now={0}
        zBase={1}
        control={null}
        bodyRef={() => {}}
        onClose={() => {}}
        onCancel={() => {}}
        onFollowup={(id, m) => steered.push([id, m])}
      />,
      host as unknown as Parameters<typeof mount>[1],
    );
    const form = host.querySelector(".task-followup-form")!;
    const input = host.querySelector(".task-followup-input") as HTMLInputElement;
    input.value = "  keep going  ";
    // dispatchEvent returns !defaultPrevented: proves the handler cancels the
    // native navigation.
    expect(form.dispatchEvent(new Event("submit"))).toBe(false);
    expect(steered).toEqual([["steer-1", "keep going"]]);
    expect(input.value).toBe("");
    // A blank draft is dropped (still prevented, nothing sent).
    input.value = "   ";
    expect(form.dispatchEvent(new Event("submit"))).toBe(false);
    expect(steered).toHaveLength(1);
  });
});

// ── SubagentsStrip ──────────────────────────────────────────────────────────

describe("SubagentsStrip", () => {
  const wire = (
    taskId: string,
    status: string,
    createdAt: number,
    description: string = taskId,
    endedAt: number | null = null,
  ): TaskInfoWire => ({ taskId, description, sessionId: "s1", status, createdAt, startedAt: null, endedAt });

  it("renders nothing when there are no tasks", () => {
    const host = fakeEl("div");
    mount(
      <SubagentsStrip tasks={[]} now={0} openTaskIds={[]} onOpen={() => {}} />,
      host as unknown as Parameters<typeof mount>[1],
    );
    // No #id support in the dom-helper selector grammar; absence of any
    // rendered element is the assertion.
    expect(host.children).toHaveLength(0);
  });

  it("lists live tasks first (newest first), marks open chips, and opens on click", () => {
    const opened: string[] = [];
    const host = fakeEl("div");
    mount(
      <SubagentsStrip
        tasks={[
          wire("done-old", "completed", 1000),
          wire("done-new", "completed", 2000, "", 9000),
          wire("run", "running", 0),
          wire("wait", "queued", 500),
        ]}
        now={4000}
        openTaskIds={["run"]}
        onOpen={(id) => opened.push(id)}
      />,
      host as unknown as Parameters<typeof mount>[1],
    );
    const chips = host.querySelectorAll(".subagent-chip");
    // Live (queued 500, running 0) before settled (2000, 1000), each group
    // newest-before-oldest. The tooltip carries full id, description, status.
    expect([...chips].map((c) => c.getAttribute("title"))).toEqual([
      "wait: wait \u2014 queued",
      "run: run \u2014 running",
      "done-new: (no description) \u2014 completed",
      "done-old: done-old \u2014 completed",
    ]);
    expect(chips[1]!.getAttribute("class")).toContain("status-running");
    expect(chips[1]!.getAttribute("class")).toContain(" open");
    expect(chips[0]!.getAttribute("class")).not.toContain(" open");
    // Elapsed: live tasks count to `now`, settled ones to endedAt.
    expect(chips[0]!.querySelector(".subagent-elapsed")!.textContent).toBe("3s");
    expect(chips[2]!.querySelector(".subagent-elapsed")!.textContent).toBe("7s");
    (chips[0] as unknown as HTMLElement).click();
    (chips[3] as unknown as HTMLElement).click();
    expect(opened).toEqual(["wait", "done-old"]);
  });

  it("chip labels use the task_id step suffix, glyphs not badge text", () => {
    const host = fakeEl("div");
    mount(
      <SubagentsStrip
        tasks={[wire("20261017-1848-hotdog-archeology:report-review#2", "completed", 1, "Workflow 'hotdog-archeology' step review", 2000)]}
        now={2000}
        openTaskIds={[]}
        onOpen={() => {}}
      />,
      host as unknown as Parameters<typeof mount>[1],
    );
    const chip = host.querySelector(".subagent-chip")!;
    // Suffix after the last ':'; single run -> NO run discriminator.
    expect(chip.querySelector(".subagent-id")!.textContent).toBe("report-review#2");
    expect(chip.querySelector(".subagent-glyph")!.textContent).toBe("\u2713");
    // Status badge text is gone; the full id lives in the tooltip.
    expect(chip.textContent).not.toContain("COMPLETED");
    expect(chip.getAttribute("title")).toContain("20261017-1848-hotdog-archeology:report-review#2");
  });

  it("falls back to the first words of the description for colon-less ids", () => {
    expect(chipLabel(wire("plain-id", "queued", 0, "review the three report sections carefully now"))).toBe(
      "review the three report sections",
    );
    expect(chipLabel(wire("run:a", "queued", 0, "desc"))).toBe("a");
    expect(chipLabel(wire("run:", "queued", 0, ""))).toBe("run:");
  });

  it("adds run discriminators only when 2+ runs share the strip", () => {
    const one = runDiscriminators([wire("runX:step#1", "completed", 0)]);
    expect(one.size).toBe(0);

    const tasks = [
      wire("20261017-1848-hotdog-archeology:report-review#2", "completed", 0),
      wire("20261017-1848-hotdog-archeology:synthesis#1", "completed", 0),
      wire("20261016-0900-other-run:dig#3", "completed", 0),
    ];
    const discs = runDiscriminators(tasks);
    // Shortest distinguishing trailing segment group per run.
    expect(discs.get("20261017-1848-hotdog-archeology:report-review#2")).toBe("archeology");
    expect(discs.get("20261016-0900-other-run:dig#3")).toBe("run");

    const host = fakeEl("div");
    mount(
      <SubagentsStrip tasks={tasks} now={0} openTaskIds={[]} onOpen={() => {}} />,
      host as unknown as Parameters<typeof mount>[1],
    );
    const ids = [...host.querySelectorAll(".subagent-id")].map((e) => e.textContent);
    expect(ids).toContain("archeology:report-review#2");
    expect(ids).toContain("run:dig#3");
  });

  it("collapses past MAX_STRIP_CHIPS behind a +N chip that expands the strip", () => {
    const many = Array.from({ length: 11 }, (_, i) => wire(`r:step#${i}`, "completed", i));
    const host = fakeEl("div");
    let expanded = false;
    const render = () =>
      mount(
        <SubagentsStrip
          tasks={many}
          now={0}
          openTaskIds={[]}
          onOpen={() => {}}
          expanded={expanded}
          onToggleExpanded={() => {
            expanded = !expanded;
          }}
        />,
        host as unknown as Parameters<typeof mount>[1],
      );
    const m = render();
    let chips = host.querySelectorAll(".subagent-chip");
    expect(chips).toHaveLength(MAX_STRIP_CHIPS + 1); // capped + the overflow chip
    const more = chips[8]!;
    expect(more.getAttribute("class")).toContain("subagent-more");
    expect(more.textContent).toBe("+3");
    (more as unknown as HTMLElement).click();
    expect(expanded).toBe(true);
    m.render(
      <SubagentsStrip
        tasks={many}
        now={0}
        openTaskIds={[]}
        onOpen={() => {}}
        expanded={expanded}
        onToggleExpanded={() => {
          expanded = !expanded;
        }}
      />,
    );
    chips = host.querySelectorAll(".subagent-chip");
    expect(chips).toHaveLength(11 + 1); // every task + collapse chip
    expect(host.children[0]!.getAttribute("class")).toContain("expanded");
  });

  it("statusGlyph maps known statuses and dots the unknown", () => {
    expect(statusGlyph("completed")).toBe("\u2713");
    expect(statusGlyph("failed")).toBe("\u2717");
    expect(statusGlyph("cancelled")).toBe("\u2298");
    expect(statusGlyph("running")).toBe("\u25d0");
    expect(statusGlyph("queued")).toBe("\u25cb");
    expect(statusGlyph("weird")).toBe("\u2022");
  });
});

// ── formatElapsed ───────────────────────────────────────────────────────────

describe("formatElapsed", () => {
  it("formats minute and hour ranges from the start fallback and endedAt", () => {
    const base: TaskInfoWire = { ...taskInfoWire, startedAt: null, endedAt: null };
    expect(formatElapsed(base, 65_000)).toBe("1m 5s");
    expect(formatElapsed(base, 3_720_000)).toBe("1h 2m");
    expect(formatElapsed({ ...base, endedAt: 125_000 }, 9_999_999)).toBe("2m 5s");
  });
});
