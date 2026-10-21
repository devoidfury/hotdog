// ProcessTerminal + StdinKeySource: the process-backed halves of the §11
// seams. Plumbing only (no frame/escape policy), so the doubles here are bare
// EventEmitters -- what gets pinned is pass-through fidelity: writes forward,
// TTY geometry falls back to 80x24, raw mode reaches stdin, and both
// subscriptions stop exactly when their unsubscribe thunk is called.

import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { ProcessTerminal, StdinKeySource } from "@utils/cli/renderer/terminal.ts";
import type { KeyChunk } from "@utils/cli/renderer/seams.ts";

class FakeStdout extends EventEmitter {
  isTTY: boolean | null = true;
  columns = 120;
  rows = 40;
  readonly writes: string[] = [];

  write(s: string): boolean {
    this.writes.push(s);
    return true;
  }
}

class FakeStdin extends EventEmitter {
  readonly rawModes: boolean[] = [];

  setRawMode(on: boolean): this {
    this.rawModes.push(on);
    return this;
  }
}

describe("ProcessTerminal (Terminal seam)", () => {
  it("forwards every byte to stdout untouched", () => {
    const out = new FakeStdout();
    const term = new ProcessTerminal(out, new FakeStdin());
    term.write("frame row one\n");
    term.write("frame row two\n");
    expect(out.writes).toEqual(["frame row one\n", "frame row two\n"]);
  });

  it("isTTY is true only when stdout reports a TTY", () => {
    const out = new FakeStdout();
    const term = new ProcessTerminal(out, new FakeStdin());
    expect(term.isTTY).toBe(true);
    out.isTTY = false;
    expect(term.isTTY).toBe(false);
    out.isTTY = null;
    expect(term.isTTY).toBe(false);
    delete (out as { isTTY?: boolean | null }).isTTY;
    expect(term.isTTY).toBe(false);
  });

  it("geometry falls back to 80x24 when the stream has no size", () => {
    const sized = new FakeStdout();
    const term = new ProcessTerminal(sized, new FakeStdin());
    expect([term.columns, term.rows]).toEqual([120, 40]);

    const headless = new FakeStdout() as unknown as {
      isTTY?: boolean | null;
      columns?: number;
      rows?: number;
    };
    delete headless.columns;
    delete headless.rows;
    const fallback = new ProcessTerminal(headless as never, new FakeStdin());
    expect([fallback.columns, fallback.rows]).toEqual([80, 24]);
  });

  it("setRawMode reaches stdin on both edges", () => {
    const stdin = new FakeStdin();
    const term = new ProcessTerminal(new FakeStdout(), stdin);
    term.setRawMode(true);
    term.setRawMode(false);
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it("setRawMode is a no-op when stdin cannot do raw mode (piped)", () => {
    const term = new ProcessTerminal(new FakeStdout(), new EventEmitter());
    expect(() => term.setRawMode(true)).not.toThrow();
  });

  it("onResize delivers resize; the unsubscribe thunk detaches it", () => {
    const out = new FakeStdout();
    const term = new ProcessTerminal(out, new FakeStdin());
    let resizes = 0;
    const off = term.onResize(() => {
      resizes++;
    });
    out.emit("resize");
    expect(resizes).toBe(1);
    off();
    out.emit("resize");
    expect(resizes).toBe(1);
    expect(() => off()).not.toThrow(); // idempotent
  });

  it("defaults to the real process streams when constructed bare", () => {
    const term = new ProcessTerminal();
    expect(term.isTTY).toBe(process.stdout.isTTY === true);
  });
});

describe("StdinKeySource (KeySource seam)", () => {
  it("delivers raw chunks -- Buffers stay undecoded, strings pass through", () => {
    const stdin = new FakeStdin();
    const source = new StdinKeySource(stdin);
    const got: KeyChunk[] = [];
    source.onData((chunk) => got.push(chunk));

    // Bytes are handed over untouched: the StdinBuffer's incremental decoder
    // owns bytes->text, so a split multi-byte sequence must survive here.
    const bytes = Buffer.from([0xc3, 0xa9]);
    stdin.emit("data", bytes);
    stdin.emit("data", "\x1b[A");
    expect(got.length).toBe(2);
    expect(Buffer.isBuffer(got[0]) && (got[0] as Buffer).equals(bytes)).toBe(true);
    expect(got[1]).toBe("\x1b[A");
  });

  it("unsubscribing stops delivery and is the only way input stops", () => {
    const stdin = new FakeStdin();
    const source = new StdinKeySource(stdin);
    const got: string[] = [];
    const off = source.onData((chunk) => got.push(String(chunk)));
    stdin.emit("data", "a");
    off();
    stdin.emit("data", "b");
    off(); // double unsubscribe is a no-op
    expect(got).toEqual(["a"]);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("each subscriber gets its own detach", () => {
    const stdin = new FakeStdin();
    const source = new StdinKeySource(stdin);
    const a: string[] = [];
    const b: string[] = [];
    const offA = source.onData((c) => a.push(String(c)));
    source.onData((c) => b.push(String(c)));
    offA();
    stdin.emit("data", "x");
    expect(a).toEqual([]);
    expect(b).toEqual(["x"]);
  });
});
