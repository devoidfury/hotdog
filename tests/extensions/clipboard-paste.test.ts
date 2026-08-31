// The interceptor swaps the readline data listener; tests drive it with a fake
// TTY input stream (EventEmitter) and a fake readline Interface whose `line`,
// `cursor` and `_refreshLine` mirror Bun's runtime shape. The fake readline
// updates its buffer the way the real one does for plain characters and
// backspaces, so cursor state stays consistent across forwarded input.

import { describe, it, expect, mock, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import {
  ClipboardPasteInterceptor,
  type ClipboardPasteInterceptorOptions,
} from "../../src/extensions/ui-interactive-cli/clipboard-paste.ts";

// xterm bracketed paste (DECSET 2004) wire protocol, encoded independently of
// the implementation so a constant drift in clipboard-paste.ts fails these tests.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// single-line payloads at or above the 80-char threshold take the marker path
const L80 = "x".repeat(80);
const L79 = "x".repeat(79);

type MockFn = ReturnType<typeof mock>;

interface Rig {
  stdin: EventEmitter & { isTTY: boolean };
  stdout: { isTTY: boolean; write: MockFn };
  rl: readline.Interface & {
    line: string;
    cursor: number;
    _refreshLine: MockFn;
    input: EventEmitter & { isTTY: boolean };
    output: { isTTY: boolean; write: MockFn };
    on: MockFn;
  };
  /** chunks forwarded to readline (the captured original data listener) */
  forwarded: unknown[];
  interceptor: ClipboardPasteInterceptor;
}

function makeRig(
  options: { tty?: boolean; withDataListener?: boolean; paste?: ClipboardPasteInterceptorOptions } = {},
): Rig {
  const tty = options.tty !== false;
  const withDataListener = options.withDataListener !== false;
  const forwarded: unknown[] = [];

  const rlState = { line: "", cursor: 0 };
  const rl = {
    input: undefined as unknown as Rig["rl"]["input"],
    output: undefined as unknown as Rig["rl"]["output"],
    on: mock(() => {}),
    get line() {
      return rlState.line;
    },
    set line(v: string) {
      rlState.line = v;
    },
    get cursor() {
      return rlState.cursor;
    },
    set cursor(v: number) {
      rlState.cursor = v;
    },
    _refreshLine: mock(() => {}),
  };

  const orig = (chunk: unknown) => {
    forwarded.push(chunk);
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk as Buffer).toString("utf8");
    for (const ch of s) {
      if (ch === "\x7f" || ch === "\b") {
        if (rlState.cursor > 0) {
          rlState.line = rlState.line.slice(0, rlState.cursor - 1) + rlState.line.slice(rlState.cursor);
          rlState.cursor--;
        }
      } else {
        rlState.line = rlState.line.slice(0, rlState.cursor) + ch + rlState.line.slice(rlState.cursor);
        rlState.cursor++;
      }
    }
  };

  const stdin = new EventEmitter() as Rig["rl"]["input"];
  stdin.isTTY = tty;
  if (withDataListener) stdin.on("data", orig);

  const stdout = { isTTY: true, write: mock(() => true) };

  rl.input = stdin;
  rl.output = stdout;

  const interceptor = new ClipboardPasteInterceptor(rl as unknown as readline.Interface, options.paste ?? {
    pasteMarkerMinChars: 80,
  });
  return { stdin, stdout, rl: rl as unknown as Rig["rl"], forwarded, interceptor };
}

function feed(rig: Rig, ...chunks: (string | Buffer)[]): void {
  for (const chunk of chunks) rig.stdin.emit("data", chunk);
}

function forwardedText(rig: Rig): string {
  return rig.forwarded.map((c) => (typeof c === "string" ? c : Buffer.from(c as Buffer).toString("utf8"))).join("");
}

describe("ClipboardPasteInterceptor", () => {
  let lastRig: Rig | null = null;
  afterEach(() => {
    lastRig?.interceptor.dispose();
    lastRig = null;
  });

  it("is disabled when the input stream is not a TTY", () => {
    const rig = makeRig({ tty: false });
    lastRig = rig;
    expect(rig.interceptor.enabled).toBe(false);
    feed(rig, `${PASTE_START}x${PASTE_END}`);
    expect(forwardedText(rig)).toBe(`${PASTE_START}x${PASTE_END}`);
    expect(rig.stdout.write).not.toHaveBeenCalled();
    expect(rig.interceptor.normalize("a[b]")).toBe("a[b]");
  });

  it("is disabled when readline registered no data listener", () => {
    const rig = makeRig({ withDataListener: false });
    lastRig = rig;
    expect(rig.interceptor.enabled).toBe(false);
    feed(rig, "hi");
    expect(rig.forwarded).toHaveLength(0);
  });

  it("replaces a pasted payload with a marker and restores content on normalize", () => {
    const rig = makeRig();
    lastRig = rig;
    expect(rig.interceptor.enabled).toBe(true);
    expect(rig.stdout.write).toHaveBeenCalledWith("\x1b[?2004h");

    feed(rig, Buffer.from(`${PASTE_START}line one\nline two\nline three${PASTE_END}`));
    expect(forwardedText(rig)).toBe("[Paste #1 - 3 lines]");
    expect(rig.rl.line).toBe("[Paste #1 - 3 lines]");

    expect(rig.interceptor.normalize(rig.rl.line)).toBe("line one\nline two\nline three");
    expect(rig.interceptor.normalize("[Paste #1 - 3 lines]")).toBe("[Paste #1 - 3 lines]");
  });

  it("marks long single-line pastes as '1 line'", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    expect(forwardedText(rig)).toBe("[Paste #1 - 1 line]");
    rig.rl.line = "[Paste #1 - 1 line]";
    expect(rig.interceptor.normalize(rig.rl.line)).toBe(L80);
  });

  it("forwards short single-line pastes as raw text instead of a marker", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}short pasted text${PASTE_END}`);
    expect(forwardedText(rig)).toBe("short pasted text");
    expect(rig.rl.line).toBe("short pasted text");
    // nothing was recorded, so normalize is a no-op
    expect(rig.interceptor.normalize(rig.rl.line)).toBe(rig.rl.line);
  });

  it("uses the raw path below 80 characters and the marker at exactly 80", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L79}${PASTE_END}`);
    expect(forwardedText(rig)).toBe(L79);
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    // the raw paste did not consume a marker number, so this is #1
    expect(rig.rl.line).toBe(L79 + "[Paste #1 - 1 line]");
    expect(rig.interceptor.normalize(rig.rl.line)).toBe(L79 + L80);
  });

  it("honors a custom pasteMarkerMinChars threshold", () => {
    const rig = makeRig({ paste: { pasteMarkerMinChars: 5 } });
    lastRig = rig;
    feed(rig, `${PASTE_START}four${PASTE_END}`); // 4 < 5: raw
    expect(forwardedText(rig)).toBe("four");
    feed(rig, `${PASTE_START}fives${PASTE_END}`); // 5: marker
    expect(rig.rl.line).toBe("four[Paste #1 - 1 line]");
    expect(rig.interceptor.normalize(rig.rl.line)).toBe("fourfives");
  });

  it("treats a threshold of 0 as always-marker", () => {
    const rig = makeRig({ paste: { pasteMarkerMinChars: 0 } });
    lastRig = rig;
    feed(rig, `${PASTE_START}a${PASTE_END}`);
    expect(forwardedText(rig)).toBe("[Paste #1 - 1 line]");
    rig.rl.line = "[Paste #1 - 1 line]";
    expect(rig.interceptor.normalize(rig.rl.line)).toBe("a");
  });

  it("fails when pasteMarkerMinChars is missing or invalid", () => {
    expect(() => makeRig({ paste: {} as ClipboardPasteInterceptorOptions })).toThrow(
      "pasteMarkerMinChars must be a non-negative number",
    );
    expect(() => makeRig({ paste: { pasteMarkerMinChars: -1 } })).toThrow(
      "pasteMarkerMinChars must be a non-negative number",
    );
  });

  it("ignores empty pastes", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${PASTE_END}`);
    expect(rig.forwarded).toHaveLength(0);
    expect(rig.interceptor.normalize("x")).toBe("x");
  });

  it("counts a lone newline paste as one line", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}\n${PASTE_END}`);
    expect(forwardedText(rig)).toBe("[Paste #1 - 1 line]");
    rig.rl.line = "[Paste #1 - 1 line]";
    expect(rig.interceptor.normalize(rig.rl.line)).toBe("\n");
  });

  it("forwards surrounding text in the same chunk around a paste", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `a${PASTE_START}${L80}${PASTE_END}b`);
    expect(rig.forwarded.join("")).toBe(`a[Paste #1 - 1 line]b`);
  });

  it("keeps paste content that contains END-delimiter prefix bytes", () => {
    const rig = makeRig();
    lastRig = rig;
    // content itself ends with a prefix of the END delimiter; the terminal
    // still appends a complete END delimiter after it
    const content = `data \x1b[2${"x".repeat(75)}`;
    feed(rig, `${PASTE_START}${content}`);
    feed(rig, PASTE_END);
    expect(forwardedText(rig)).toBe("[Paste #1 - 1 line]");
    rig.rl.line = "[Paste #1 - 1 line]";
    expect(rig.interceptor.normalize(rig.rl.line)).toBe(content);
  });

  it("handles a paste END delimiter split across chunks", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L80}\x1b[20`);
    expect(rig.forwarded).toHaveLength(0);
    feed(rig, `1~`);
    expect(forwardedText(rig)).toBe("[Paste #1 - 1 line]");
    rig.rl.line = "[Paste #1 - 1 line]";
    expect(rig.interceptor.normalize(rig.rl.line)).toBe(L80);
  });

  it("handles a paste START delimiter split across chunks", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, "\x1b[20");
    expect(rig.forwarded).toHaveLength(0);
    feed(rig, "0~abc\n");
    expect(rig.forwarded).toHaveLength(0);
    feed(rig, PASTE_END);
    expect(forwardedText(rig)).toBe("[Paste #1 - 1 line]");
    rig.rl.line = "[Paste #1 - 1 line]";
    expect(rig.interceptor.normalize(rig.rl.line)).toBe("abc\n");
  });

  it("forwards held escape bytes when they do not complete a paste START delimiter", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, "\x1b[2");
    expect(rig.forwarded).toHaveLength(0);
    feed(rig, "x"); // "x" is not "0", so the held prefix was not a paste start and flushes
    expect(forwardedText(rig)).toBe("\x1b[2x");
  });

  it("numbers pastes sequentially and renders each marker's own content", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${"f".repeat(80)}${PASTE_END}`);
    feed(rig, `${PASTE_START}${"s".repeat(80)}${PASTE_END}`);
    expect(forwardedText(rig)).toBe("[Paste #1 - 1 line][Paste #2 - 1 line]");

    rig.rl.line = "[Paste #1 - 1 line][Paste #2 - 1 line]";
    expect(rig.interceptor.normalize(rig.rl.line)).toBe("f".repeat(80) + "s".repeat(80));
  });

  it("inserts a marker's content at most once even if it repeats in one line", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${"a".repeat(80)}${PASTE_END}`);
    const line = `[Paste #1 - 1 line] and again [Paste #1 - 1 line]`;
    // first occurrence renders the content, the second stays as text
    expect(rig.interceptor.normalize(line)).toBe(`${"a".repeat(80)} and again [Paste #1 - 1 line]`);
    // second call: the marker was already rendered (e.g., recalled from
    // history), so nothing is substituted
    expect(rig.interceptor.normalize(line)).toBe(line);
  });

  it("drops an orphaned marker when a submitted line no longer contains it", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    // simulate ctrl-U: the line event fires without the marker
    expect(rig.interceptor.normalize("typed after ctrl-u")).toBe("typed after ctrl-u");
    expect(rig.interceptor.normalize("[Paste #1 - 1 line]")).toBe("[Paste #1 - 1 line]");
  });

  it("deletes the whole marker with one backspace at the marker end", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    rig.rl.line = "pre[Paste #1 - 1 line]";
    rig.rl.cursor = 22; // "pre" (3) + 19-char marker, at the end of it

    feed(rig, "\x7f");

    expect(rig.rl._refreshLine).toHaveBeenCalledTimes(1);
    expect(rig.rl.line).toBe("pre");
    expect(rig.rl.cursor).toBe(3);
    // the \x7f was consumed, not forwarded to readline
    expect(rig.forwarded).toEqual(["[Paste #1 - 1 line]"]);
    expect(rig.interceptor.normalize("pre")).toBe("pre");
  });

  it("deletes a marker with backspace when the cursor is inside the marker", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    rig.rl.line = "ab[Paste #1 - 1 line]cd";
    rig.rl.cursor = 8; // mid-marker (marker spans indexes 2..20)

    feed(rig, "\b"); // 0x08 variant
    expect(rig.rl.line).toBe("abcd");
    expect(rig.rl.cursor).toBe(2);
    expect(rig.forwarded).toEqual(["[Paste #1 - 1 line]"]);
  });

  it("deletes only the marker under the cursor when several markers are present", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${"f".repeat(80)}${PASTE_END}`);
    feed(rig, `${PASTE_START}${"s".repeat(80)}${PASTE_END}`);
    rig.rl.line = "[Paste #1 - 1 line][Paste #2 - 1 line]";
    rig.rl.cursor = 38; // end of the second marker

    feed(rig, "\x7f");
    expect(rig.rl.line).toBe("[Paste #1 - 1 line]");
    expect(rig.rl.cursor).toBe(19);
    expect(rig.interceptor.normalize(rig.rl.line)).toBe("f".repeat(80));
  });

  it("is not atomic on a marker whose content was already rendered", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    expect(rig.interceptor.normalize(rig.rl.line)).toBe(L80);
    // marker already rendered; a recalled-from-history copy is plain text now
    rig.rl.line = "x[Paste #1 - 1 line]";
    rig.rl.cursor = 1;

    feed(rig, "\x7f");

    expect(rig.rl.line).toBe("[Paste #1 - 1 line]");
    expect(rig.rl.cursor).toBe(0);
    expect(rig.rl._refreshLine).not.toHaveBeenCalled();
  });

  it("forwards backspace when no marker is touched", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    rig.rl.line = "[Paste #1 - 1 line]xy";
    rig.rl.cursor = 21; // at the end, on 'y'

    // 2 delete "xy", 1 atomically deletes the marker, 19 hit cursor 0
    feed(rig, "\x7f".repeat(22));
    expect(rig.forwarded.filter((c) => c === "\x7f")).toHaveLength(21);
    expect(rig.rl.line).toBe("");
    expect(rig.rl.cursor).toBe(0);
  });

  it("deletes the whole marker with the Delete key at the marker start", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    rig.rl.line = "[Paste #1 - 1 line]post";
    rig.rl.cursor = 0; // at the marker start

    feed(rig, "\x1b[3~");

    expect(rig.rl._refreshLine).toHaveBeenCalledTimes(1);
    expect(rig.rl.line).toBe("post");
    expect(rig.rl.cursor).toBe(0);
    // the keypress was consumed, not forwarded to readline
    expect(rig.forwarded).toEqual(["[Paste #1 - 1 line]"]);
    expect(rig.interceptor.normalize("post")).toBe("post");
  });

  it("deletes the whole marker with the Delete key when the cursor is inside the marker", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    rig.rl.line = "ab[Paste #1 - 1 line]cd";
    rig.rl.cursor = 5; // mid-marker (marker spans indexes 2..20)

    feed(rig, "\x1b[3~");
    expect(rig.rl.line).toBe("abcd");
    expect(rig.rl.cursor).toBe(2);
  });

  it("forwards the Delete key when the cursor is just past the marker", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    rig.rl.line = "[Paste #1 - 1 line]xy";
    rig.rl.cursor = 19; // on 'x', not part of the marker

    feed(rig, "\x1b[3~");
    expect(rig.forwarded).toEqual(["[Paste #1 - 1 line]", "\x1b[3~"]);
  });

  it("handles a Delete key sequence split across chunks", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    rig.rl.line = "[Paste #1 - 1 line]";
    rig.rl.cursor = 0;

    feed(rig, "\x1b[3"); // held back as a possible Delete prefix
    expect(rig.rl.line).toBe("[Paste #1 - 1 line]");
    feed(rig, "~");
    expect(rig.rl.line).toBe("");
    expect(rig.rl.cursor).toBe(0);
  });

  it("forwards a held escape sequence when it does not complete the Delete key", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, "\x1b[3"); // genuine prefix of the Delete sequence: fully held back
    expect(rig.forwarded).toHaveLength(0);
    feed(rig, "4"); // not "~", so it is not a Delete keypress
    expect(forwardedText(rig)).toBe("\x1b[34");
  });

  it("forwards plain text unchanged, including multibyte characters", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, "héllo wörld 🚀");
    expect(forwardedText(rig)).toBe("héllo wörld 🚀");
    expect(rig.rl.line).toBe("héllo wörld 🚀");
  });

  it("keeps backspace bytes inside a paste as content, not editor keys", () => {
    const rig = makeRig();
    lastRig = rig;
    // 80-char single-line paste so it takes the marker path
    const content = `x\x7f${"y".repeat(78)}`;
    feed(rig, "ab");
    feed(rig, `${PASTE_START}${content}${PASTE_END}`);
    expect(forwardedText(rig)).toBe("ab[Paste #1 - 1 line]");
    expect(rig.interceptor.normalize(rig.rl.line)).toBe(`ab${content}`);
  });

  it("forwards ctrl-C mid-paste to readline and drops the in-flight payload", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}partial`);
    feed(rig, "\x03");
    expect(rig.forwarded).toContain("\x03");
    // simulate the app interrupt
    rig.interceptor.onInterrupt();
    // rest of the payload plus END arrives; it must be dropped
    feed(rig, `more${PASTE_END}`);
    expect(forwardedText(rig)).not.toContain("Paste");
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    expect(forwardedText(rig)).toContain("[Paste #1 - 1 line]");
  });

  it("drops recorded markers on interrupt", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}${L80}${PASTE_END}`);
    rig.interceptor.onInterrupt();
    // app clears the line; a later typed line must not inherit old content
    expect(rig.interceptor.normalize("[Paste #1 - 1 line]")).toBe("[Paste #1 - 1 line]");
  });

  it("preserves pasted content verbatim including surrounding newlines", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}\n  indented\n\ttabbed${PASTE_END}`);
    expect(forwardedText(rig)).toBe("[Paste #1 - 3 lines]");
    rig.rl.line = "[Paste #1 - 3 lines]";
    expect(rig.interceptor.normalize(rig.rl.line)).toBe("\n  indented\n\ttabbed");
  });

  it("counts and restores lines when the TTY delivered pasted newlines as \\r (ICRNL)", () => {
    const rig = makeRig();
    lastRig = rig;
    // a 5-line paste (one blank) whose \n line endings the TTY layer turned into \r
    feed(rig, `${PASTE_START}line one\rline two\r\rline four\rline five${PASTE_END}`);
    expect(forwardedText(rig)).toBe("[Paste #1 - 5 lines]");
    rig.rl.line = "[Paste #1 - 5 lines]";
    expect(rig.interceptor.normalize(rig.rl.line)).toBe("line one\nline two\n\nline four\nline five");
  });

  it("normalizes CRLF pastes to \\n", () => {
    const rig = makeRig();
    lastRig = rig;
    feed(rig, `${PASTE_START}a\r\nb${PASTE_END}`);
    expect(forwardedText(rig)).toBe("[Paste #1 - 2 lines]");
    rig.rl.line = "[Paste #1 - 2 lines]";
    expect(rig.interceptor.normalize(rig.rl.line)).toBe("a\nb");
  });

  it("dispose writes the disable escape and stops consuming input", () => {
    const rig = makeRig();
    lastRig = rig;
    rig.interceptor.dispose();
    expect(rig.stdout.write).toHaveBeenCalledWith("\x1b[?2004l");
    feed(rig, "after-dispose");
    expect(rig.forwarded).toHaveLength(0);
    // dispose is idempotent
    rig.interceptor.dispose();
  });

  // Guards the wire protocol against a real readline, not a fake: a terminal
  // emitting standard DECSET 2004 delimiters must produce a marker (no
  // auto-submit on pasted newlines), and the disable sequence must be the
  // standard one on dispose.
  it("intercepts a real paste against a real readline Interface", () => {
    class FakeTTY extends EventEmitter {
      isTTY = true;
      columns = 80;
      rows = 24;
      written: string[] = [];
      write = (d: string | Buffer): boolean => {
        this.written.push(typeof d === "string" ? d : d.toString("utf8"));
        return true;
      };
      resume = (): void => {};
      pause = (): void => {};
    }
    const input = new FakeTTY();
    const output = new FakeTTY();
    const rl = readline.createInterface({
      input: input as unknown as NodeJS.ReadableStream,
      output: output as unknown as NodeJS.WritableStream,
      terminal: true,
    });
    const interceptor = new ClipboardPasteInterceptor(rl, { pasteMarkerMinChars: 80 });
    try {
      expect(interceptor.enabled).toBe(true);
      const lines: string[] = [];
      rl.on("line", (l) => lines.push(l));
      input.emit("data", Buffer.from(`${PASTE_START}line one\nline two${PASTE_END}`));
      expect(lines).toHaveLength(0);
      expect(rl.line).toBe("[Paste #1 - 2 lines]");
      input.emit("data", Buffer.from("\r"));
      expect(lines).toEqual(["[Paste #1 - 2 lines]"]);
      expect(interceptor.normalize(lines[0]!)).toBe("line one\nline two");
    } finally {
      interceptor.dispose();
      rl.close();
    }
    expect(output.written).toContain("\x1b[?2004h");
    expect(output.written).toContain("\x1b[?2004l");
  });
});
