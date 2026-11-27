// Session-browser integration tests: row assembly (live+cold merge with the
// live row winning, worker rows absent, unattested columns omitted, cost
// omitted without pricing, pinned rows leading per the webui precedent), the
// [lastActivityAt, id] cursor walk, the pin store landing webui-compatible
// bytes with a fresh re-read, corpus rows reaching logs OUTSIDE the loaded
// window with snippet + match count + the "subagent of" label, the browser
// over the real bridge rig (keys to the picker, Esc restoring the draft
// byte-exact, Enter routed through the existing seams, the already-current
// row refused), and the legacy /sessions output pinned byte-identical with
// no browser installed.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { LOG_SOURCE } from "@core/session/session-log.ts";
import { closeSessionIndex, reconcileSessionIndex } from "@core/session/session-index.ts";
import type { SessionSearchMatch } from "@core/session/session-index.ts";
import { type OutputEvent } from "@core/context/output.ts";
import { Channel, type ChannelSessionManager } from "@core/channel.ts";
import {
  buildSessionRows,
  createSessionBrowser,
  defaultSearch,
  formatSessionStamp,
  scanCorpus,
  searchCorpusRows,
  type SessionBrowserDeps,
} from "@extensions/ui-interactive-cli/session-browser.ts";
import {
  closePinStore,
  isPinned,
  pinStorePath,
  reloadPins,
  setPinned,
} from "@extensions/websocket/pin-store.ts";
import { OutputBridge, type EditorInputHandlers } from "@extensions/ui-interactive-cli/split-bridge.ts";
import type { PickerRow } from "@utils/cli/renderer/list-picker.ts";
import { FakeClock, GridTerminal, MemoryKeySource } from "@utils/cli/renderer/index.ts";
import type { EditorView } from "@utils/cli/renderer/editor-view.ts";
import type { SignalHost } from "@utils/cli/renderer/seams.ts";
import type { KeyEvent } from "@utils/cli/renderer/keyevents.ts";

const dir = mkdtempSync(join(TMP_PARENT, "hotdog-session-browser-"));
let originalEnv: string | undefined;

beforeAll(() => {
  originalEnv = process.env.HOTDOG_SESSIONS_DIR;
  process.env.HOTDOG_SESSIONS_DIR = dir;
});

afterAll(() => {
  if (originalEnv === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
  else process.env.HOTDOG_SESSIONS_DIR = originalEnv;
  closeSessionIndex();
  closePinStore();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh session world per test: membership is disk-driven, and pins are
  // module-cached per store home.
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".jsonl") || f === "pinned-sessions.json") rmSync(join(dir, f), { force: true });
  }
  closePinStore();
});

// Fixed local timestamps (local Date -> ISO -> the index's local reads match).
const ts = (y: number, mo: number, d: number, h = 9, mi = 5): string =>
  new Date(y, mo - 1, d, h, mi).toISOString();

async function writeSession(
  id: string,
  opts: { model?: string; first?: string; at: string; corpus?: string[] },
): Promise<void> {
  const entries = [
    ...(opts.model
      ? [{ ts: opts.at, session_id: id, source: LOG_SOURCE.SESSION_START, content: "", model: opts.model }]
      : []),
    { ts: opts.at, session_id: id, source: LOG_SOURCE.INPUT, content: opts.first ?? `hello ${id}` },
    ...(opts.corpus ?? []).map((c) => ({
      ts: opts.at,
      session_id: id,
      source: LOG_SOURCE.INPUT,
      content: c,
    })),
    { ts: opts.at, session_id: id, source: LOG_SOURCE.LLM, content: `answer ${id}` },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await reconcileSessionIndex();
}

function rowIds(rows: PickerRow[]): string[] {
  return rows.map((r) => r.id);
}

describe("formatSessionStamp (webui current-year idiom)", () => {
  const now = new Date(2026, 10, 25, 12, 0).getTime();
  it("omits the year in the current year, names it otherwise", () => {
    expect(formatSessionStamp(new Date(2026, 10, 25, 9, 5).getTime(), now)).toBe("11-25 09:05");
    expect(formatSessionStamp(new Date(2024, 0, 5, 8, 30).getTime(), now)).toBe("2024-01-05 08:30");
  });
});

describe("buildSessionRows", () => {
  const now = () => new Date(2026, 10, 25, 12, 0).getTime();

  function deps(over: Partial<SessionBrowserDeps> = {}): SessionBrowserDeps {
    return {
      liveSessions: () => [],
      currentId: () => null,
      joinedWorkers: async () => new Set<string>(),
      taskDescriptions: async () => new Map(),
      search: async () => [],
      resumeCold: async () => {},
      activator: {
        isLive: () => false,
        isAttached: () => false,
        attach: async () => {},
        switchTo: async () => {},
      },
      clock: new FakeClock(),
      output: () => {},
      editor: () => null,
      paintRows: () => {},
      repaint: () => {},
      now,
      ...over,
    };
  }

  it("merges live + cold newest-first, live wins the duplicate, worker rows never appear", async () => {
    await writeSession("sbm-live", { model: "logged-model", at: ts(2026, 11, 20) });
    await writeSession("sbm-cold-new", { model: "cold-model", at: ts(2026, 11, 24) });
    await writeSession("sbm-cold-old", { at: ts(2026, 11, 1) });
    await writeSession("sbm-worker", { at: ts(2026, 11, 23), corpus: ["worker secret needle"] });

    const built = await buildSessionRows(
      deps({
        liveSessions: () => [{ id: "sbm-live", model: "atlas-live", profile: "dev" }],
        currentId: () => "sbm-live",
        joinedWorkers: async () => new Set(["sbm-worker"]),
      }),
    );
    const ids = rowIds(built.rows);
    expect(ids).toEqual(["sbm-cold-new", "sbm-live", "sbm-cold-old"]);
    const live = built.rows.find((r) => r.id === "sbm-live")!;
    // LIVE wins the duplicate: the registry model shows, and the row appears ONCE.
    expect(live.label).toContain("atlas-live");
    expect(live.label).not.toContain("logged-model");
    expect(live.label).toContain("(current)");
    expect(ids.filter((id) => id === "sbm-live").length).toBe(1);
    expect(ids.filter((id) => id === "sbm-worker").length).toBe(0); // worker-attested stays hidden
  });

  it("omits unattested columns; shows index-attested state, model, count and title", async () => {
    await writeSession("sbc-bare", { at: ts(2026, 11, 2) });
    await writeSession("sbc-attested", { model: "atlas-pro", first: "Fix the broker leak please", at: ts(2026, 11, 3) });

    const built = await buildSessionRows(deps());
    const bare = built.rows.find((r) => r.id === "sbc-bare")!;
    expect(bare.label).toContain("11-02");
    expect(bare.label).toContain("2 msgs");
    // no model/profile/title attestation on the bare row: nothing invented
    expect(bare.label).not.toContain("atlas");
    const attested = built.rows.find((r) => r.id === "sbc-attested")!;
    expect(attested.label).toContain("atlas-pro");
    expect(attested.label).toContain("Fix the broker leak"); // derived title (webui list() chain)
  });

  it("cost rides only on an attested number: omitted without pricing", async () => {
    await writeSession("sbcost-a", { at: ts(2026, 11, 4) });
    await writeSession("sbcost-b", { at: ts(2026, 11, 5) });

    const unpriced = await buildSessionRows(deps());
    expect(unpriced.rows.every((r) => !r.label.includes("$"))).toBe(true);

    const priced = await buildSessionRows(
      deps({ costOf: (id) => (id === "sbcost-a" ? "$0.42" : null) }),
    );
    expect(priced.rows.find((r) => r.id === "sbcost-a")!.label).toContain("$0.42");
    expect(priced.rows.find((r) => r.id === "sbcost-b")!.label).not.toContain("$");
  });

  it("pages through the [lastActivityAt, id] cursor: no skip, no repeat, honest end", async () => {
    for (let i = 0; i < 5; i++) await writeSession(`sbp-${i}`, { at: ts(2026, 11, 1 + i) });
    const d = deps();
    const p1 = await buildSessionRows(d, { windowSize: 2 });
    expect(rowIds(p1.rows)).toEqual(["sbp-4", "sbp-3"]);
    expect(p1.hasMore).toBe(true);
    const p2 = await buildSessionRows(d, { windowSize: 2, olderThan: p1.cursor });
    expect(rowIds(p2.rows)).toEqual(["sbp-2", "sbp-1"]);
    expect(p2.hasMore).toBe(true);
    const p3 = await buildSessionRows(d, { windowSize: 2, olderThan: p2.cursor });
    expect(rowIds(p3.rows)).toEqual(["sbp-0"]);
    expect(p3.hasMore).toBe(false);
    const union = [...rowIds(p1.rows), ...rowIds(p2.rows), ...rowIds(p3.rows)];
    expect(new Set(union).size).toBe(5);
  });

  it("live rows are never paged out, even an unlogged fresh session", async () => {
    // The fresh live session has stamped no log yet (lastActivityAt 0), so a
    // window that cut it off would page away the row the browser exists to
    // reach -- and a cursor page that re-emitted it would duplicate it.
    for (let i = 0; i < 3; i++) await writeSession(`sbl-${i}`, { at: ts(2026, 11, 10 + i) });
    const d = deps({
      liveSessions: () => [{ id: "sbl-fresh", model: "atlas-live" }],
      currentId: () => "sbl-fresh",
    });
    const p1 = await buildSessionRows(d, { windowSize: 1 });
    expect(rowIds(p1.rows)).toEqual(["sbl-2", "sbl-fresh"]);
    expect(p1.hasMore).toBe(true);
    const p2 = await buildSessionRows(d, { windowSize: 1, olderThan: p1.cursor });
    expect(rowIds(p2.rows)).toEqual(["sbl-1"]);
    const union = [...rowIds(p1.rows), ...rowIds(p2.rows)];
    expect(union.filter((id) => id === "sbl-fresh").length).toBe(1);
  });

  it("pinned rows lead the list (webui sortPinned precedent)", async () => {    await writeSession("sbd-a", { at: ts(2026, 11, 10) });
    await writeSession("sbd-b", { at: ts(2026, 11, 11) });
    await writeSession("sbd-pin", { at: ts(2026, 10, 1) });
    setPinned("sbd-pin", true);
    const built = await buildSessionRows(deps());
    expect(built.rows[0]!.id).toBe("sbd-pin");
    expect(built.rows[0]!.label).toContain("pinned");
    expect(rowIds(built.rows).slice(1)).toEqual(["sbd-b", "sbd-a"]);
    expect(built.rows[1]!.label).not.toContain("pinned");
  });
});

describe("searchCorpusRows and scanCorpus", () => {
  const now = () => new Date(2026, 10, 25, 12, 0).getTime();
  const match = (over: Partial<SessionSearchMatch>): SessionSearchMatch => ({
    sessionId: "sc-x",
    profile: null,
    model: null,
    lastActivityAt: new Date(2026, 2, 2, 8, 0).getTime(),
    text: "",
    ...over,
  });

  it("counts literal matches and cuts a snippet window around the first", () => {
    const text = "prefix chatter about the broker pool and more words here to push past the context window; the broker came back later";
    const { count, snippet } = scanCorpus(text, "broker");
    expect(count).toBe(2);
    expect(snippet).toContain("broker");
    expect(snippet!.length).toBeLessThan(text.length); // a window, not the corpus
  });

  it("`%` stays literal in the corpus scan too (no LIKE semantics)", () => {
    expect(scanCorpus("50% coverage note", "%").count).toBe(1);
    expect(scanCorpus("50% coverage note", "5%d").count).toBe(0);
  });

  it("labels worker-attested hits 'subagent of <desc>' only where attested", () => {
    const matches = [
      match({ sessionId: "sc-worker", text: "we fixed the broker" }),
      match({ sessionId: "sc-worker-nodesc", text: "we fixed the broker" }),
      match({ sessionId: "sc-user", text: "we fixed the broker" }),
    ];
    const { rows } = searchCorpusRows(matches, "broker", {
      cap: 50,
      joined: new Set(["sc-worker", "sc-worker-nodesc"]),
      descriptions: new Map([["sc-worker", "fix the broker pool"]]),
      now,
    });
    expect(rows.find((r) => r.id === "sc-worker")!.label).toContain("subagent of fix the broker pool");
    expect(rows.find((r) => r.id === "sc-worker-nodesc")!.label).not.toContain("subagent");
    expect(rows.find((r) => r.id === "sc-user")!.label).not.toContain("subagent");
    expect(rows.find((r) => r.id === "sc-user")!.label).toContain("03-02 08:00");
    expect(rows.find((r) => r.id === "sc-user")!.label).toContain("1 match");
  });

  it("caps honestly: rows beyond the cap drop and `capped` surfaces", () => {
    const matches = [1, 2, 3].map((i) => match({ sessionId: `sc-${i}`, text: `broker ${i}` }));
    const { rows, capped } = searchCorpusRows(matches, "broker", {
      cap: 2,
      joined: new Set(),
      descriptions: new Map(),
      now,
    });
    expect(rows.length).toBe(2);
    expect(capped).toBe(true);
  });
});

describe("corpus search reaches logs outside the loaded window", () => {
  it("finds a needle only present in an old, unloaded session", async () => {
    for (let i = 0; i < 4; i++) await writeSession(`sbw-${i}`, { at: ts(2026, 11, 1 + i) });
    await writeSession("sbw-needle", {
      at: ts(2025, 6, 1),
      corpus: ["we fixed the broker pool entry leak in the restart path"],
    });
    const built = await buildSessionRows(depsLocal(), { windowSize: 1 });
    expect(rowIds(built.rows)).toEqual(["sbw-3"]); // the needle's row is NOT loaded
    expect(built.hasMore).toBe(true);
    const hits = await defaultSearch("fixed the broker pool");
    expect(hits.some((h) => h.sessionId === "sbw-needle")).toBe(true);
    const corpusBuilt = searchCorpusRows(hits, "fixed the broker pool", {
      cap: 50,
      joined: new Set(),
      descriptions: new Map(),
      now: () => Date.now(),
    });
    const hit = corpusBuilt.rows.find((r) => r.id === "sbw-needle")!;
    expect(hit.label).toContain("1 match");
    expect(hit.detail).toContain("broker pool entry leak");
  });

  function depsLocal(): SessionBrowserDeps {
    return {
      liveSessions: () => [],
      currentId: () => null,
      joinedWorkers: async () => new Set<string>(),
      taskDescriptions: async () => new Map(),
      search: async () => [],
      resumeCold: async () => {},
      activator: { isLive: () => false, isAttached: () => false, attach: async () => {}, switchTo: async () => {} },
      clock: new FakeClock(),
      output: () => {},
      editor: () => null,
      paintRows: () => {},
      repaint: () => {},
      now: () => Date.now(),
    };
  }
});

describe("pin store: webui-compatible bytes and a fresh re-read", () => {
  it("a flip lands as a plain JSON id array and reloadPins sees an external writer", async () => {
    await writeSession("sbp-file", { at: ts(2026, 11, 8) });
    setPinned("sbp-file", true);
    // Byte-compatible with the webui's pin-store file format.
    expect(JSON.parse(readFileSync(pinStorePath(), "utf8"))).toEqual(["sbp-file"]);
    expect(isPinned("sbp-file")).toBe(true);

    // A sibling process (the webui daemon) flips a pin: the cache keeps
    // serving the stale set until reloadPins() -- the picker's open/flip
    // re-read.
    writeFileSync(pinStorePath(), JSON.stringify(["sbp-other"]));
    expect(isPinned("sbp-other")).toBe(false); // cached, stale
    reloadPins();
    expect(isPinned("sbp-other")).toBe(true); // fresh off disk
  });
});

// ── Browser wiring: fake-deps control flow + the real bridge rig ───────────

interface FakeView {
  overlay: ((e: KeyEvent) => void) | null;
}

function fakeBridge() {
  const term = new GridTerminal({ rows: 24, cols: 80 });
  const clock = new FakeClock();
  const sig: SignalHost = { on: () => () => {}, exit: () => {} };
  const bridge = new OutputBridge({ terminal: term, clock, signalHost: sig });
  bridge.mount();
  const handlers: EditorInputHandlers = { submit: () => {}, interrupt: () => {}, quit: () => {} };
  const keys = new MemoryKeySource();
  bridge.mountEditorInput(keys, handlers);
  clock.runAll();
  return { bridge, term, clock, keys };
}

describe("createSessionBrowser control flow", () => {
  function harness(over: Partial<SessionBrowserDeps> = {}) {
    const outputs: string[] = [];
    const view: FakeView = { overlay: null };
    const painted: Array<((w: number) => string[]) | null> = [];
    let repaints = 0;
    const act = fakeActivatorWith(over);
    const resumed: string[] = [];
    const clock = new FakeClock();
    const deps: SessionBrowserDeps = {
      liveSessions: () => [],
      currentId: () => act.current.id,
      joinedWorkers: async () => new Set<string>(),
      taskDescriptions: async () => new Map(),
      search: async () => [],
      resumeCold: async (id) => {
        resumed.push(id);
      },
      activator: act.activator,
      clock,
      output: (t) => outputs.push(t),
      editor: () => view as unknown as EditorView,
      paintRows: (s) => painted.push(s),
      repaint: () => repaints++,
      now: () => Date.now(),
      ...over,
    };
    return { deps, outputs, view, painted, act, resumed, clock, repaintCount: () => repaints };
  }

  function fakeActivatorWith(over: Partial<SessionBrowserDeps>) {
    const calls: string[] = [];
    const live = new Set(over.liveSessions?.() ? over.liveSessions().map((s) => s.id) : []);
    const attached = new Set<string>();
    const current = { id: over.currentId?.() ?? null };
    return {
      calls,
      live,
      attached,
      current,
      activator: {
        isLive: (id: string) => live.has(id),
        isAttached: (id: string) => attached.has(id),
        attach: async (id: string) => {
          calls.push(`attach:${id}`);
          attached.add(id);
        },
        switchTo: async (id: string) => {
          calls.push(`switch:${id}`);
        },
      },
    };
  }

  it("declines without a mounted editor (plain-text fallback stays)", async () => {
    const open = createSessionBrowser({
      ...harness().deps,
      editor: () => null,
    });
    expect(await open()).toBe(false);
  });

  it("an open-time failure declines with a word, and the next /sessions works", async () => {
    // The failure path must not leave a session half-mounted: a stuck
    // `session` would answer every later /sessions with "already open" on a
    // screen showing nothing.
    let boom = true;
    const h = harness({
      joinedWorkers: async () => {
        if (boom) throw new Error("sidecar unreadable");
        return new Set<string>();
      },
    });
    const open = createSessionBrowser(h.deps);
    expect(await open()).toBe(false); // Channel's plain-text list still prints
    expect(h.outputs.join("\n")).toContain("Session browser unavailable");
    expect(h.outputs.join("\n")).toContain("sidecar unreadable");
    expect(h.painted.length).toBe(0); // nothing was ever installed
    expect(h.view.overlay).toBeNull();

    boom = false;
    expect(await open()).toBe(true);
    expect(h.view.overlay).not.toBeNull();
  });

  it("a failure loading the first page tears the half-built browser down", async () => {
    let boom = true;
    const h = harness({
      taskDescriptions: async () => {
        if (boom) throw new Error("task registry unreadable");
        return new Map();
      },
    });
    const open = createSessionBrowser(h.deps);
    expect(await open()).toBe(false);
    expect(h.outputs.join("\n")).toContain("task registry unreadable");
    boom = false;
    expect(await open()).toBe(true); // the retry opens clean, no "already open"
  });

  it("Enter on a cold log is refused while this session is running", async () => {
    // A cold resume swaps the session, and swap has no running guard: the
    // abandoned turn would keep running with nobody subscribed to it.
    await writeSession("sbrun-target", { at: ts(2026, 11, 16) });
    const h = harness({ currentRunning: () => true });
    await createSessionBrowser(h.deps)();
    h.view.overlay!({ kind: "key", name: "enter" } as KeyEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.resumed).toEqual([]);
    expect(h.outputs.join("\n")).toContain("Cannot resume sbrun-target");
    expect(h.outputs.join("\n")).toContain("still running");
    // Refused, not closed: the list is still up for the next move.
    expect(h.view.overlay).not.toBeNull();
  });

  it("a live attach is NOT refused while this session runs (typed /switch always allowed it)", async () => {
    const h = harness({
      liveSessions: () => [{ id: "sb-live-run" }],
      currentId: () => "other",
      currentRunning: () => true,
    });
    await createSessionBrowser(h.deps)();
    h.view.overlay!({ kind: "key", name: "enter" } as KeyEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.act.calls).toEqual(["attach:sb-live-run", "switch:sb-live-run"]);
  });

  it("opens over the view: overlay installed, rows painted, keys land on the picker", async () => {
    await writeSession("sbb-row", { at: ts(2026, 11, 12) });
    const h = harness();
    const open = createSessionBrowser(h.deps);
    expect(await open()).toBe(true);
    expect(h.view.overlay).not.toBeNull();
    expect(h.painted.at(-1)).not.toBeNull();
    const rows = h.painted.at(-1)!(80);
    expect(rows[0]).toContain("sessions");
    expect(rows.some((r) => r.includes("sbb-row"))).toBe(true);
    h.view.overlay!({ kind: "text", text: "sbb" } as KeyEvent);
    expect(h.painted.at(-1)!(80)[0]).toContain("q: sbb");
    // Esc closes: overlay cleared, paint source cleared, repaint ran.
    h.view.overlay!({ kind: "key", name: "esc" } as KeyEvent);
    expect(h.view.overlay).toBeNull();
    expect(h.painted.at(-1)).toBeNull();
    expect(h.repaintCount()).toBeGreaterThan(0);
  });

  it("Enter on the already-current row: refused no-op, plain text, seams untouched", async () => {
    const h = harness({
      liveSessions: () => [{ id: "sbb-current", model: "m" }],
      currentId: () => "sbb-current",
    });
    const open = createSessionBrowser(h.deps);
    await open();
    h.view.overlay!({ kind: "key", name: "enter" } as KeyEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.outputs.join("\n")).toContain("Already on session sbb-current");
    expect(h.act.calls).toEqual([]);
    expect(h.resumed).toEqual([]);
    expect(h.view.overlay).toBeNull(); // closed
  });

  it("Enter on a live row attaches when needed, then switches through the /switch path", async () => {
    const h = harness({ liveSessions: () => [{ id: "sbb-live" }], currentId: () => "other" });
    await createSessionBrowser(h.deps)();
    h.view.overlay!({ kind: "key", name: "enter" } as KeyEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.act.calls).toEqual(["attach:sbb-live", "switch:sbb-live"]);
  });

  it("Enter on an attached live row only runs the /switch path", async () => {
    const h = harness({ liveSessions: () => [{ id: "sbb-live" }], currentId: () => "other" });
    await createSessionBrowser(h.deps)();
    h.view.overlay!({ kind: "key", name: "enter" } as KeyEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.act.calls).toEqual(["attach:sbb-live", "switch:sbb-live"]);
    // The row is attached now: a fresh browser must switch, never re-attach.
    await createSessionBrowser(h.deps)();
    h.view.overlay!({ kind: "key", name: "enter" } as KeyEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.act.calls).toEqual(["attach:sbb-live", "switch:sbb-live", "switch:sbb-live"]);
  });

  it("Enter on a cold log runs the cold resume with the row id; a refusal is reported, not thrown", async () => {
    await writeSession("sbc-resume-target", { at: ts(2026, 11, 15) });
    const h = harness();
    await createSessionBrowser(h.deps)();
    h.view.overlay!({ kind: "key", name: "enter" } as KeyEvent); // top row is the cold log
    await new Promise((r) => setTimeout(r, 0));
    expect(h.resumed).toEqual(["sbc-resume-target"]);

    const failing = harness({
      resumeCold: async () => {
        throw new Error("parked after 10 auto-resumes");
      },
    });
    await createSessionBrowser(failing.deps)();
    failing.view.overlay!({ kind: "key", name: "enter" } as KeyEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(failing.outputs.join("\n")).toContain("parked after 10 auto-resumes");
  });

  it("p pins the selected row into the store; worker-attested rows are refused honestly", async () => {
    await writeSession("sbb-pin", { at: ts(2026, 11, 13) });
    const h = harness();
    await createSessionBrowser(h.deps)();
    h.view.overlay!({ kind: "text", text: "p" } as KeyEvent);
    expect(isPinned("sbb-pin")).toBe(true);
    expect(JSON.parse(readFileSync(pinStorePath(), "utf8"))).toEqual(["sbb-pin"]);

    // A worker-attested log is hidden from the primary rows; its corpus hit
    // (reachable by search -- the list hides, the log stays addressable)
    // refuses the pin: the webui prunes such pins on its next list, so
    // silently accepting one would be a claim that dies later.
    rmSync(join(dir, "pinned-sessions.json"), { force: true });
    closePinStore();
    const worker = harness({
      joinedWorkers: async () => new Set(["sbb-pin"]),
      search: async () => [
        {
          sessionId: "sbb-pin",
          profile: null,
          model: null,
          lastActivityAt: new Date(2026, 10, 13, 9, 5).getTime(),
          text: "hello sbb-pin answer sbb-pin",
        },
      ],
    });
    await createSessionBrowser(worker.deps)();
    worker.view.overlay!({ kind: "text", text: "sbb-pin" } as KeyEvent);
    worker.clock.advance(150); // debounced corpus request
    await new Promise((r) => setTimeout(r, 0)); // the search stub settles
    worker.view.overlay!({ kind: "key", name: "alt-p" } as KeyEvent);
    expect(worker.outputs.join("\n")).toContain("Pin refused");
    expect(isPinned("sbb-pin")).toBe(false);
  });

  it("a pin whose rebuild fails reports on the transcript, never an unhandled rejection", async () => {
    // The flip lands in the store; the rebuild that re-attests the rows reads
    // the log list and can fail after that. The rejection must be reported
    // like every other async path here, or a pin that took looks ignored.
    await writeSession("sbb-pinfail", { at: ts(2026, 11, 14) });
    let failBuilds = false;
    const h = harness({
      liveSessions: () => {
        if (failBuilds) throw new Error("index unreadable");
        return [];
      },
    });
    const unhandled: string[] = [];
    const note = (reason: unknown) => {
      unhandled.push(String(reason));
    };
    process.on("unhandledRejection", note);
    try {
      await createSessionBrowser(h.deps)();
      failBuilds = true; // the pin flip's rebuild is the read that fails
      h.view.overlay!({ kind: "text", text: "p" } as KeyEvent);
      await new Promise((r) => setTimeout(r, 0));
      expect(isPinned("sbb-pinfail")).toBe(true); // the store took the flip
      expect(h.outputs.join("\n")).toContain("index unreadable");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", note);
    }
  });

  it("page append keeps the pinned row exactly once and walks to an honest end", async () => {
    // Review defect 1: the pinned head block rode EVERY page buildSessionRows
    // returned, so each onNeedMore pull re-appended the pinned row.
    for (let i = 1; i <= 5; i++) await writeSession(`pbx${i}`, { at: ts(2026, 11, i) });
    setPinned("pbx1", true);
    const settle = async () => {
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const h = harness({ windowSize: 2 });
    await createSessionBrowser(h.deps)();
    let frame = h.painted.at(-1)!(80);
    expect(frame.filter((r) => r.includes("pbx1")).length).toBe(1);
    expect(frame.some((r) => r.includes("keep pressing down"))).toBe(true);
    // Walk off the loaded tail: one page pull, then the walk is complete
    // (4 unpinned, window 2) even with the pinned row in front.
    h.view.overlay!({ kind: "key", name: "down" } as KeyEvent);
    h.view.overlay!({ kind: "key", name: "down" } as KeyEvent);
    h.view.overlay!({ kind: "key", name: "down" } as KeyEvent); // steps off the tail
    await settle();
    frame = h.painted.at(-1)!(80);
    for (const id of ["pbx1", "pbx2", "pbx3", "pbx4", "pbx5"]) {
      expect(frame.filter((r) => r.includes(id)).length).toBe(1);
    }
    // Exhausted with a pinned row present: honest end, hint cleared, nothing
    // re-appended by the extra Downs.
    h.view.overlay!({ kind: "key", name: "down" } as KeyEvent);
    h.view.overlay!({ kind: "key", name: "down" } as KeyEvent);
    await settle();
    frame = h.painted.at(-1)!(80);
    expect(frame.some((r) => r.includes("keep pressing down"))).toBe(false);
    for (const id of ["pbx1", "pbx2", "pbx3", "pbx4", "pbx5"]) {
      expect(frame.filter((r) => r.includes(id)).length).toBe(1);
    }
  });

  it("a superseded corpus reply writes nothing: rows, footer and repaints unmoved", async () => {
    // Review defect 2: the glue wrote the cap/failure footer UNCONDITIONALLY
    // after applyCorpus, so a stale reply repainted and could claim
    // "more matches" under a query with zero matches.
    interface Settled {
      resolve(m: SessionSearchMatch[]): void;
      reject(e: Error): void;
    }
    const pending: Settled[] = [];
    const h = harness({
      search: () => new Promise<SessionSearchMatch[]>((resolve, reject) => pending.push({ resolve, reject })),
    });
    const settle = async () => {
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    };
    await createSessionBrowser(h.deps)();
    h.view.overlay!({ kind: "text", text: "al" } as KeyEvent);
    h.clock.advance(150); // seq 1 fires for "al"
    h.view.overlay!({ kind: "text", text: "p" } as KeyEvent); // query becomes "alp"
    h.clock.advance(150); // seq 2 fires for "alp"
    expect(pending.length).toBe(2);
    const sixty: SessionSearchMatch[] = Array.from({ length: 60 }, (_, i) => ({
      sessionId: `sbx60-${i}`,
      profile: null,
      model: null,
      lastActivityAt: new Date(2026, 2, 2, 8, 0).getTime(),
      text: `alpha ${i} chatter with alpha inside`,
    }));
    pending[1]!.resolve([]); // the CURRENT query settles: zero matches
    await settle();
    const before = h.painted.at(-1)!(80).join("\n");
    expect(before).toContain('no match for "alp"');
    const repaints = h.repaintCount();
    pending[0]!.resolve(sixty); // stale, capped reply for the superseded query
    await settle();
    expect(h.painted.at(-1)!(80).join("\n")).toBe(before);
    expect(h.repaintCount()).toBe(repaints);
  });

  it("a superseded failed search writes nothing either (the reject path)", async () => {
    interface Settled {
      resolve(m: SessionSearchMatch[]): void;
      reject(e: Error): void;
    }
    const pending: Settled[] = [];
    const h = harness({
      search: () => new Promise<SessionSearchMatch[]>((resolve, reject) => pending.push({ resolve, reject })),
    });
    const settle = async () => {
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    };
    await createSessionBrowser(h.deps)();
    h.view.overlay!({ kind: "text", text: "al" } as KeyEvent);
    h.clock.advance(150); // seq 1: "al"
    h.view.overlay!({ kind: "text", text: "x" } as KeyEvent); // query "alx"
    h.clock.advance(150); // seq 2: "alx"
    expect(pending.length).toBe(2);
    pending[1]!.resolve([]);
    await settle();
    const before = h.painted.at(-1)!(80).join("\n");
    const repaints = h.repaintCount();
    pending[0]!.reject(new Error("index vanished")); // stale failure
    await settle();
    expect(h.painted.at(-1)!(80).join("\n")).toBe(before);
    expect(h.repaintCount()).toBe(repaints);
  });
});

describe("bridge rig: keys to the picker, draft restored byte-exact", () => {
  it("typing while the picker is open never touches the line buffer; Esc reopens it", async () => {
    await writeSession("sbr-row", { at: ts(2026, 11, 14) });
    const { bridge, term, clock } = fakeBridge();
    const view = bridge.editor!;
    view.setText("half-typed draft");
    let repaints = 0;
    const open = createSessionBrowser({
      liveSessions: () => [],
      currentId: () => null,
      joinedWorkers: async () => new Set<string>(),
      taskDescriptions: async () => new Map(),
      search: async () => [],
      resumeCold: async () => {},
      activator: { isLive: () => false, isAttached: () => false, attach: async () => {}, switchTo: async () => {} },
      clock: new FakeClock(),
      output: () => {},
      editor: () => bridge.editor,
      paintRows: (s) => bridge.setListPicker(s),
      repaint: () => {
        repaints++;
        bridge.repaintFrame();
      },
      now: () => Date.now(),
    });
    expect(await open()).toBe(true);
    // The picker owns no terminal modes: raw + bracketed paste were mounted
    // once by bridge.mount(), and the picker cycle adds no new pair bytes
    // (repaints ride the bridge's ?25 cursor chrome like every other frame
    // update -- the popup contract).
    const modesBefore = term.grid.modeLog.filter((m) => m.startsWith("raw:") || m.startsWith("?2004")).length;
    clock.runAll(); // flush the frame scheduler into the Grid
    // Keys go to the picker, NOT the line editor.
    view.feedKey({ kind: "text", text: "sbr" } as KeyEvent);
    expect(view.text).toBe("half-typed draft"); // buffer untouched
    clock.runAll();
    const frame = term.grid.snapshot().screen.join("\n");
    expect(frame).toContain("q: sbr"); // the picker painted, holding the query
    expect(frame).toContain("half-typed draft"); // the editor block rides on, unedited
    view.feedKey({ kind: "key", name: "esc" } as KeyEvent);
    clock.runAll();
    expect(view.overlay).toBeNull();
    expect(term.grid.snapshot().screen.join("\n")).not.toContain("q: sbr"); // picker rows gone
    expect(term.grid.modeLog.filter((m) => m.startsWith("raw:") || m.startsWith("?2004")).length)
      .toBe(modesBefore); // the mode pair stays bridge-owned, untouched by the picker
    expect(view.text).toBe("half-typed draft"); // restored byte-exact (it was never moved)
    expect(repaints).toBeGreaterThan(0);
  });
});

describe("legacy /sessions: byte-identical plain text with no browser", () => {
  class ProbeChannel extends Channel {
    writes: OutputEvent[] = [];
    protected write(event: OutputEvent): void {
      this.writes.push(event);
    }
    async *read(): AsyncIterable<string> {}
    protected _cleanup(): void {}
  }

  function manager(): ChannelSessionManager {
    const infos: Record<string, { id: string; model?: string; profile?: string }> = {
      "ch-alpha": { id: "ch-alpha", model: "atlas-9", profile: "dev" },
      "ch-beta": { id: "ch-beta" },
    };
    return {
      enqueue: () => {},
      cancel: () => {},
      interrupt: () => {},
      executeCommand: async () => undefined,
      onSessionEvents: () => () => {},
      sessionIds: () => ["ch-alpha", "ch-beta"],
      getSessionInfo: (id) => infos[id] ?? null,
    };
  }

  const GOLDEN = ["Available sessions:", "  ch-alpha [atlas-9] (dev) (current)", "  ch-beta"].join("\n");

  it("defaults to NO browser (WebSocketChannel/OneShotChannel/legacy keep the plain list)", () => {
    const ch = new ProbeChannel({ sessionManager: manager() });
    expect(ch.sessionBrowser).toBeNull();
  });

  it("prints the exact plain-text bytes when no browser is installed", async () => {
    const ch = new ProbeChannel({ sessionManager: manager() });
    ch.attach("ch-alpha");
    await ch.handleSessions();
    expect(ch.writes.length).toBe(1);
    expect((ch.writes[0] as { content: string }).content).toBe(GOLDEN);
  });

  it("a browser that declines falls through to the same exact bytes", async () => {
    const ch = new ProbeChannel({ sessionManager: manager() });
    let asked = 0;
    ch.sessionBrowser = async () => {
      asked++;
      return false;
    };
    ch.attach("ch-alpha");
    await ch.handleSessions();
    expect(asked).toBe(1);
    expect((ch.writes[0] as { content: string }).content).toBe(GOLDEN);
  });

  it("a browser that accepts suppresses the plain list entirely", async () => {
    const ch = new ProbeChannel({ sessionManager: manager() });
    ch.sessionBrowser = async () => true;
    ch.attach("ch-alpha");
    await ch.handleSessions();
    expect(ch.writes.length).toBe(0);
  });
});
