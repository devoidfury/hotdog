// History (§4 steal 12): dedupe, bounded size, draft-slot walk, and the
// corrupt-file tolerance matrix. Persistence is the injected save() -- no fs
// here, per the inverted-dependency rule; 3b owns the config-dir file.

import { describe, it, expect } from "bun:test";
import { History, HISTORY_MAX, HISTORY_LINE_MAX } from "@utils/cli/renderer/history.ts";

describe("History -- append + dedupe", () => {
  it("blank entries never enter; consecutive duplicates are skipped", () => {
    const h = new History();
    h.append("first");
    h.append("first"); // consecutive dup: dropped
    h.append("");
    h.append("second");
    h.append("first"); // non-consecutive dup: KEPT (dedupe is consecutive-only)
    expect(h.list()).toEqual(["first", "second", "first"]);
  });

  it("bounded at HISTORY_MAX (default) and a custom max; oldest evicted", () => {
    const h = new History({ max: 3 });
    for (const t of ["a", "b", "c", "d", "e"]) h.append(t);
    expect(h.list()).toEqual(["c", "d", "e"]);
    expect(HISTORY_MAX).toBe(1000);
    const big = new History();
    for (let i = 0; i < HISTORY_MAX + 25; i++) big.append(`cmd-${i}`);
    expect(big.size).toBe(HISTORY_MAX);
    expect(big.list()[0]).toBe("cmd-25"); // oldest 25 evicted
    expect(big.list()[HISTORY_MAX - 1]).toBe(`cmd-${HISTORY_MAX + 24}`);
  });

  it("the injected save receives the serialized list on every accepted append", () => {
    const saved: string[] = [];
    const h = new History({ save: (s) => saved.push(s) });
    h.append("one");
    h.append("one"); // deduped: nothing saved
    h.append("two");
    expect(saved).toEqual(["one\n", "one\ntwo\n"]);
  });

  it("no save injected = pure in-memory (core has no fs anyway)", () => {
    const h = new History();
    expect(() => h.append("x")).not.toThrow();
  });
});

describe("History -- navigation walk with draft slot", () => {
  it("beginWalk stashes the draft; prev/next walk; takeDraft restores at newest", () => {
    const h = new History();
    h.append("alpha");
    h.append("beta");
    expect(h.walkActive).toBe(false);
    h.beginWalk("typed-me");
    expect(h.walkActive).toBe(true);
    expect(h.prev()).toBe("beta");
    expect(h.prev()).toBe("alpha");
    expect(h.prev()).toBe(null); // oldest end: position stays
    expect(h.prev()).toBe(null);
    expect(h.next()).toBe("beta");
    expect(h.next()).toBe(null); // newest end: caller restores the draft
    expect(h.takeDraft()).toBe("typed-me");
    expect(h.walkActive).toBe(false);
  });

  it("an interrupt-saved draft outranks a later beginWalk stash (§4)", () => {
    const h = new History();
    h.append("cmd");
    h.saveDraft("half-typed-then-esc"); // interrupt stash
    h.beginWalk(""); // fresh navigation must NOT clobber it
    expect(h.prev()).toBe("cmd");
    expect(h.next()).toBe(null);
    expect(h.takeDraft()).toBe("half-typed-then-esc");
  });

  it("append during a walk resets navigation (§4: submit clears the draft)", () => {
    const h = new History();
    h.append("a");
    h.beginWalk("draft");
    h.append("submitted");
    expect(h.walkActive).toBe(false);
    h.beginWalk("fresh");
    expect(h.prev()).toBe("submitted");
  });

  it("serialize round-trips through load", () => {
    const src = new History();
    src.append("multi word  entry");
    src.append("next");
    const dst = new History();
    dst.load(src.serialize());
    expect(dst.list()).toEqual(["multi word  entry", "next"]);
  });

  it("multi-line and backslash entries survive the round-trip (escaped \\n, \\\\)", () => {
    const src = new History();
    src.append("line1");
    src.append("multi\nline"); // pasted multi-line submit -- one entry
    src.append("a\\b"); // literal backslash
    src.append("5 \\n 3"); // backslash-n typed by hand, NOT an escape
    const serialized = src.serialize();
    // one PHYSICAL line per entry: an unescaped \n would have split "multi\nline"
    expect(serialized.split("\n").filter((l) => l !== "")).toHaveLength(4);
    const dst = new History();
    dst.load(serialized);
    expect(dst.list()).toEqual(["line1", "multi\nline", "a\\b", "5 \\n 3"]);
  });
});

describe("History -- corrupt-file tolerance (never throws)", () => {
  it("missing/empty content loads as empty", () => {
    const h = new History();
    h.append("had-something");
    h.load("");
    expect(h.list()).toEqual([]);
  });

  it("binary garbage without newlines reads as empty (over-long single line)", () => {
    const h = new History();
    h.load("\x00\x01\x02\xff\xfe".repeat(1000));
    expect(h.list()).toEqual([]);
  });

  it("control-character lines are skipped, clean neighbors survive", () => {
    const h = new History();
    h.load("clean-1\nbad\x00line\nbad\x07bell\n\x01start\nclean-2\n");
    expect(h.list()).toEqual(["clean-1", "clean-2"]);
  });

  it("tabs inside a line survive (tab is legitimate content)", () => {
    const h = new History();
    h.load("col1\tcol2\n");
    expect(h.list()).toEqual(["col1\tcol2"]);
  });

  it("mid-line CR is debris (lone-Mac endings cannot round-trip): entry skipped", () => {
    const h = new History();
    h.load("clean-1\none\rtwo\nclean-2\r\n");
    expect(h.list()).toEqual(["clean-1", "clean-2"]);
  });

  it("over-long lines are skipped at HISTORY_LINE_MAX", () => {
    const h = new History();
    h.load("x".repeat(HISTORY_LINE_MAX + 1) + "\nok\n");
    expect(h.list()).toEqual(["ok"]);
  });

  it("a huge file keeps only the newest HISTORY_MAX lines", () => {
    const h = new History();
    const lines = Array.from({ length: HISTORY_MAX + 500 }, (_, i) => `line-${i}`);
    h.load(lines.join("\n"));
    expect(h.size).toBe(HISTORY_MAX);
    expect(h.list()[0]).toBe("line-500");
    expect(h.list()[HISTORY_MAX - 1]).toBe(`line-${HISTORY_MAX + 499}`);
  });

  it("CRLF line endings are normalized on load", () => {
    const h = new History();
    h.load("one\r\ntwo\r\n");
    expect(h.list()).toEqual(["one", "two"]);
  });
});
