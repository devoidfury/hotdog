// The PURE hot-exit stash store, driven directly (no DOM, no wire): the
// per-path trailing debounce (one write of the final text, never per
// keystroke), immediate and zero-traffic clears, renames, the LIVE record
// read with its shape gate, two-tab key isolation, and the quota contract
// (mark ONCE, never throw, never block). The app wiring -- restore overlay,
// conflict doors, the foot-bar indicator -- is pinned in app.test.tsx's
// hot-exit section.
import { describe, expect, it } from "bun:test";
import {
  createEditorStash,
  STASH_DEBOUNCE_MS,
  STASH_KEY_PREFIX,
  STASH_TAB_ID_KEY,
  type EditorStash,
  type StashStorage,
} from "@extensions/webui/ui/editor-stash.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Map-backed storage with a write counter (reads are free to hammer). */
function memStorage(opts: { writesFail?: boolean; readsFail?: boolean } = {}): {
  storage: StashStorage;
  map: Map<string, string>;
  writeCount: () => number;
} {
  const map = new Map<string, string>();
  let writes = 0;
  return {
    map,
    writeCount: () => writes,
    storage: {
      getItem: (k: string) => {
        if (opts.readsFail) throw new Error("blocked");
        return map.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (opts.writesFail) throw new Error("QuotaExceeded: too many unsaved edits");
        writes++;
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        writes++;
        map.delete(k);
      },
    },
  };
}

const recKey = (id: string) => STASH_KEY_PREFIX + id;
const readRec = (map: Map<string, string>, id: string): Record<string, { text: string; baseMtimeMs: number; stashedAt: number }> =>
  JSON.parse(map.get(recKey(id)) ?? "{}") as ReturnType<typeof readRec>;

/** A store over memStorage with everything deterministic except the map. */
function makeStore(m: ReturnType<typeof memStorage>, over: Partial<Parameters<typeof createEditorStash>[0]> = {}): EditorStash {
  return createEditorStash({
    storage: () => m.storage,
    now: () => 4242,
    debounceMs: 20,
    newTabId: () => "TAB-1",
    ...over,
  });
}

describe("editor stash (pure)", () => {
  it("schedule debounces to ONE trailing write per path of the final text", async () => {
    const m = memStorage();
    m.map.set(STASH_TAB_ID_KEY, "T1"); // keep the tab id deterministic
    const s = makeStore(m);
    s.schedule("/a.ts", "one", 7);
    s.schedule("/a.ts", "two", 7); // same path, mid-window: coalesce
    expect(m.writeCount()).toBe(0); // the debounce window writes nothing
    expect(m.map.size).toBe(1); // ...and nothing exists yet at all
    await sleep(40);
    expect(m.writeCount()).toBe(1); // ONE write lands
    expect(readRec(m.map, "T1")).toEqual({ "/a.ts": { text: "two", baseMtimeMs: 7, stashedAt: 4242 } });
  });

  it("mint the tab-instance id once and keep it; a second store rides the same id", async () => {
    const m = memStorage();
    const s = makeStore(m);
    s.schedule("/a.ts", "x", 1);
    s.flush();
    expect(m.map.get(STASH_TAB_ID_KEY)).toBe("TAB-1");
    expect(readRec(m.map, "TAB-1")["/a.ts"]?.text).toBe("x");
    // A new page of the SAME browser tab re-reads the minted id (never mints
    // a second one): its writes land under TAB-1.
    const s2 = makeStore(m, { newTabId: () => "SHOULD-NOT-APPEAR" });
    expect(s2.entryFor("/a.ts")?.text).toBe("x");
    s2.schedule("/b.ts", "y", 2);
    s2.flush();
    expect(m.map.get(STASH_TAB_ID_KEY)).toBe("TAB-1");
    expect(Object.keys(readRec(m.map, "TAB-1")).sort()).toEqual(["/a.ts", "/b.ts"]);
  });

  it("clear is immediate, cancels a pending schedule, and is silent when nothing was stashed", async () => {
    const m = memStorage();
    m.map.set(STASH_TAB_ID_KEY, "T1");
    const s = makeStore(m);
    s.clear("/never.ts"); // zero-traffic: no read-modify-write of nothing
    expect(m.writeCount()).toBe(0);
    s.schedule("/a.ts", "x", 1);
    s.clear("/a.ts"); // the debounce dies with the fact it was mirroring
    await sleep(40);
    expect(m.writeCount()).toBe(0);
    s.schedule("/a.ts", "x", 1);
    s.flush();
    expect(readRec(m.map, "T1")["/a.ts"]).toBeDefined();
    const before = m.writeCount();
    s.clear("/a.ts"); // immediate: NO sleep needed
    expect(m.writeCount()).toBe(before + 1);
    expect(m.map.has(recKey("T1"))).toBe(false); // last path out drops the key
  });

  it("flush lands every pending path in ONE write; an empty flush is silent", () => {
    const m = memStorage();
    m.map.set(STASH_TAB_ID_KEY, "T1");
    const s = makeStore(m);
    s.flush(); // nothing pending: zero traffic
    expect(m.writeCount()).toBe(0);
    s.schedule("/a.ts", "one", 1);
    s.schedule("/b.ts", "two", 2);
    s.flush();
    expect(m.writeCount()).toBe(1);
    expect(readRec(m.map, "T1")).toEqual({
      "/a.ts": { text: "one", baseMtimeMs: 1, stashedAt: 4242 },
      "/b.ts": { text: "two", baseMtimeMs: 2, stashedAt: 4242 },
    });
  });

  it("move follows renames (a pending write rides too) and stays silent when there is nothing to move", async () => {
    const m = memStorage();
    m.map.set(STASH_TAB_ID_KEY, "T1");
    const s = makeStore(m);
    s.move("/nope.ts", "/x.ts");
    expect(m.writeCount()).toBe(0);
    // Pending-only rename: the old path's timer must not resurrect it.
    s.schedule("/a.ts", "kept", 3);
    s.move("/a.ts", "/b.ts");
    await sleep(40);
    expect(readRec(m.map, "T1")).toEqual({ "/b.ts": { text: "kept", baseMtimeMs: 3, stashedAt: 4242 } });
    // Persisted rename: immediate, and a record already at the target LOSES.
    s.schedule("/b.ts", "kept", 3);
    s.flush();
    const before = m.writeCount();
    s.move("/b.ts", "/c.ts");
    expect(m.writeCount()).toBe(before + 1); // no sleep: NOW
    expect(readRec(m.map, "T1")).toEqual({ "/c.ts": { text: "kept", baseMtimeMs: 3, stashedAt: 4242 } });
  });

  it("entryFor reads storage LIVE (a record seeded after creation is seen) and shape-gates garbage", () => {
    const m = memStorage();
    m.map.set(STASH_TAB_ID_KEY, "T1");
    const s = makeStore(m);
    expect(s.entryFor("/a.ts")).toBeNull();
    m.map.set(recKey("T1"), JSON.stringify({ "/a.ts": { text: "from the previous page", baseMtimeMs: 9, stashedAt: 1 } }));
    const got = s.entryFor("/a.ts"); // no re-creation, no "loaded once" blindness
    expect(got).toEqual({ text: "from the previous page", baseMtimeMs: 9, stashedAt: 1 });
    got!.text = "mutated"; // the store hands out copies
    expect(s.entryFor("/a.ts")?.text).toBe("from the previous page");
    for (const garbage of ["not json", "[]", "{}", '{"a":1}', '{"a":{"text":1}}', '{"a":{"text":"t"}}']) {
      m.map.set(recKey("T1"), garbage);
      expect(s.entryFor("/a.ts")).toBeNull();
    }
    // A VALID entry living next to garbage fields survives; the bad fields drop.
    m.map.set(recKey("T1"), JSON.stringify({ "/a.ts": { text: "t", baseMtimeMs: 1, stashedAt: 2 }, "/bad.ts": { text: 5 } }));
    expect(s.entryFor("/a.ts")?.text).toBe("t");
    expect(s.entryFor("/bad.ts")).toBeNull();
  });

  it("a clear deletes a record it never wrote (the conflict-Cancel door)", () => {
    const m = memStorage();
    m.map.set(STASH_TAB_ID_KEY, "T1");
    const s = makeStore(m);
    // The previous page left the offer; this page's Cancel must consume it
    // even though THIS store never saw the path through schedule.
    m.map.set(recKey("T1"), JSON.stringify({ "/a.ts": { text: "preserved", baseMtimeMs: 9, stashedAt: 1 } }));
    expect(s.entryFor("/a.ts")?.text).toBe("preserved");
    s.clear("/a.ts");
    expect(s.entryFor("/a.ts")).toBeNull();
    expect(m.map.has(recKey("T1"))).toBe(false);
  });

  it("two browser tabs never cross-restore or cross-clear (sessionStorage is per-tab)", () => {
    // Faithful model: each browser tab has its OWN sessionStorage (the tab
    // id lives inside it), and the record key carries that id explicitly.
    const a = memStorage();
    const b = memStorage();
    const sa = makeStore(a, { newTabId: () => "TA" });
    const sb = makeStore(b, { newTabId: () => "TB" });
    sa.schedule("/a.ts", "tab A work", 1);
    sa.flush();
    expect(a.map.has(recKey("TA"))).toBe(true); // the key spells the tab id
    expect(sb.entryFor("/a.ts")).toBeNull(); // tab B sees nothing of tab A
    sb.clear("/a.ts"); // B clearing the same path is zero-traffic over there
    expect(sa.entryFor("/a.ts")?.text).toBe("tab A work"); // A survives
    sb.schedule("/a.ts", "tab B work", 2);
    sb.flush();
    expect(readRec(a.map, "TA")["/a.ts"]?.text).toBe("tab A work");
    expect(readRec(b.map, "TB")["/a.ts"]?.text).toBe("tab B work");
    expect(sb.entryFor("/a.ts")?.text).toBe("tab B work");
  });

  it("quota: the first failed write marks ONCE, nothing throws, ops keep working", () => {
    const m = memStorage({ writesFail: true });
    m.map.set(STASH_TAB_ID_KEY, "T1"); // id already minted before storage filled
    let notices = 0;
    const s = makeStore(m, { onQuota: () => notices++ });
    expect(s.quotaFailed()).toBe(false);
    s.schedule("/a.ts", "x", 1);
    s.flush(); // the write fails...
    expect(s.quotaFailed()).toBe(true);
    expect(notices).toBe(1);
    s.schedule("/b.ts", "y", 2); // ...and EVERYTHING after it still runs
    s.flush();
    s.clear("/b.ts");
    s.move("/a.ts", "/c.ts");
    expect(s.entryFor("/a.ts")).toBeNull();
    expect(s.quotaFailed()).toBe(true);
    expect(notices).toBe(1); // ONCE, however many writes fail
  });

  it("fully blocked storage (reads throw too) swallows everything and never marks quota", async () => {
    const m = memStorage({ readsFail: true });
    let notices = 0;
    const s = makeStore(m, { onQuota: () => notices++ });
    s.schedule("/a.ts", "x", 1);
    await sleep(40); // the debounce lands into the void
    s.flush();
    expect(s.entryFor("/a.ts")).toBeNull();
    s.clear("/a.ts");
    s.move("/a.ts", "/b.ts");
    expect(s.quotaFailed()).toBe(false); // a READ swallow is not a quota event
    expect(notices).toBe(0);
  });

  it("storage is resolved PER CALL: null is a no-op, and a late-appearing storage just works", () => {
    const m = memStorage();
    let live = false;
    let notices = 0;
    const s = createEditorStash({
      storage: () => (live ? m.storage : null),
      now: () => 7,
      debounceMs: STASH_DEBOUNCE_MS,
      newTabId: () => "LATE",
      onQuota: () => notices++,
    });
    s.schedule("/a.ts", "x", 1); // no storage: no throw, no record
    s.flush();
    s.clear("/a.ts");
    expect(s.entryFor("/a.ts")).toBeNull();
    expect(m.writeCount()).toBe(0);
    // Storage answers later (the dom-helper stub-install reality): reads and
    // writes resume without re-creating anything.
    live = true;
    m.map.set(STASH_TAB_ID_KEY, "SEED");
    m.map.set(recKey("SEED"), JSON.stringify({ "/z.ts": { text: "seeded", baseMtimeMs: 5, stashedAt: 1 } }));
    expect(s.entryFor("/z.ts")?.text).toBe("seeded"); // rides the SEEDED id, not the lost LATE mint
    s.schedule("/a.ts", "x", 1);
    s.flush();
    expect(readRec(m.map, "SEED")["/a.ts"]?.text).toBe("x");
    expect(notices).toBe(0);
  });
});

describe("lazy schedule text (thunk)", () => {
  it("the thunk resolves when the debounce lands -- never while pending", async () => {
    const m = memStorage();
    m.map.set(STASH_TAB_ID_KEY, "T1");
    const s = makeStore(m);
    let calls = 0;
    s.schedule("/a.ts", () => {
      calls++;
      return "materialized";
    }, 7);
    expect(calls).toBe(0); // the keystroke path joins nothing
    expect(m.writeCount()).toBe(0);
    await sleep(40);
    expect(calls).toBe(1);
    expect(readRec(m.map, "T1")).toEqual({ "/a.ts": { text: "materialized", baseMtimeMs: 7, stashedAt: 4242 } });
  });

  it("coalescing drops intermediate thunks: only the final one resolves", async () => {
    const m = memStorage();
    m.map.set(STASH_TAB_ID_KEY, "T1");
    const s = makeStore(m);
    const calls: number[] = [];
    s.schedule("/a.ts", () => {
      calls.push(1);
      return "one";
    }, 7);
    s.schedule("/a.ts", () => {
      calls.push(2);
      return "two";
    }, 7);
    await sleep(40);
    expect(calls).toEqual([2]); // the superseded thunk never runs
    expect(readRec(m.map, "T1")["/a.ts"]?.text).toBe("two");
  });

  it("a clear before the window ends NEVER resolves the thunk", async () => {
    const m = memStorage();
    m.map.set(STASH_TAB_ID_KEY, "T1");
    const s = makeStore(m);
    let calls = 0;
    s.schedule("/a.ts", () => {
      calls++;
      return "gone";
    }, 7);
    s.clear("/a.ts"); // the buffer went clean inside the window
    await sleep(40);
    expect(calls).toBe(0);
    expect(m.writeCount()).toBe(0);
  });

  it("flush and move resolve thunks to their exact bytes", () => {
    const m = memStorage();
    m.map.set(STASH_TAB_ID_KEY, "T1");
    const s = makeStore(m);
    s.schedule("/a.ts", () => "flushed", 3);
    s.flush();
    expect(readRec(m.map, "T1")["/a.ts"]?.text).toBe("flushed");
    s.schedule("/b.ts", () => "moved", 4);
    s.move("/b.ts", "/c.ts");
    expect(readRec(m.map, "T1")).toEqual({
      "/a.ts": { text: "flushed", baseMtimeMs: 3, stashedAt: 4242 },
      "/c.ts": { text: "moved", baseMtimeMs: 4, stashedAt: 4242 },
    });
    expect(s.entryFor("/b.ts")).toBeNull();
  });

  it("plain string scheduling keeps its exact historical semantics", async () => {
    const m = memStorage();
    m.map.set(STASH_TAB_ID_KEY, "T1");
    const s = makeStore(m);
    s.schedule("/a.ts", "eager", 9);
    await sleep(40);
    expect(readRec(m.map, "T1")).toEqual({ "/a.ts": { text: "eager", baseMtimeMs: 9, stashedAt: 4242 } });
  });
});
