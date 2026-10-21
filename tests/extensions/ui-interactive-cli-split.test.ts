// Split-mode renderer integration tests (design note §2/§9/§10, stage 2b).
// Drives the OutputBridge against the core's in-memory Grid + FakeClock seams
// (no PTY, no mock.module -- note §11). Covers: the TTY mount rule, a scripted
// transcript commit, arbiter behavior on a mid-frame stderr write, teardown on
// quit and simulated SIGTERM (paired restore visible in the Grid mode log), and
// the non-TTY determinism golden for the legacy passthrough path.

import { describe, it, expect, afterAll } from "bun:test";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  shouldMountRenderer,
  installIoPatches,
  incompleteEscapeStart,
  processSignalHost,
  CaptureStream,
  mountSplitRenderer,
  OutputBridge,
  type IoPatchHost,
} from "@extensions/ui-interactive-cli/split-bridge.ts";
import { ClipboardPasteInterceptor } from "@extensions/ui-interactive-cli/clipboard-paste.ts";
import { CliOutputSink } from "@utils/cli/cli.ts";
import { applyFinalResponse } from "@utils/cli/colors.ts";
import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import { GridTerminal, FakeClock, MemoryKeySource } from "@utils/cli/renderer/index.ts";
import type { SignalHost } from "@utils/cli/renderer/index.ts";
import extensionMeta from "@extensions/ui-interactive-cli/extension.json" with { type: "json" };

describe("kill-switch config (DEFAULT legacy)", () => {
  const schema = extensionMeta.configSchema as unknown as {
    uiInteractiveCli: { properties: { renderer?: { type?: string; enum?: string[]; default?: string } } };
  };
  const renderer = schema.uiInteractiveCli.properties.renderer;

  it("defines uiInteractiveCli.renderer with enum legacy|split", () => {
    expect(renderer?.type).toBe("string");
    expect(renderer?.enum).toEqual(["legacy", "split"]);
  });

  it("defaults to legacy", () => {
    expect(renderer?.default).toBe("legacy");
  });

  it("mountSplitRenderer returns null and touches no global when the gate is shut", () => {
    const before = {
      out: process.stdout.write,
      err: process.stderr.write,
      pause: process.stdin.pause,
      log: console.log,
      error: console.error,
      warn: console.warn,
    };
    // bun test stdio is not a TTY; even knob=split must not mount or patch.
    expect(mountSplitRenderer({ knob: "split", stdinIsTTY: false, stdoutIsTTY: false })).toBeNull();
    expect(mountSplitRenderer({ knob: "legacy", stdinIsTTY: true, stdoutIsTTY: true })).toBeNull();
    expect(process.stdout.write).toBe(before.out);
    expect(process.stderr.write).toBe(before.err);
    expect(process.stdin.pause).toBe(before.pause);
    expect(console.log).toBe(before.log);
    expect(console.error).toBe(before.error);
    expect(console.warn).toBe(before.warn);
  });
});

describe("readline capture proxy (§2 stage-2 row)", () => {
  it("real node:readline paints prompt and typed echo into frame rows", () => {
    const painted: string[][] = [];
    const capture = new CaptureStream((rows) => painted.push(rows), 24, 80);
    const input = new Readable({ read() {} });
    (input as unknown as { isTTY: boolean }).isTTY = true;
    (input as unknown as { setRawMode: (m: boolean) => unknown }).setRawMode = () => input;
    const rl = readline.createInterface({
      input,
      output: capture as never,
      prompt: "(m)> ",
    });
    rl.prompt();
    input.emit("data", Buffer.from("hi"));
    rl.close();

    // The prompt and echo reached the frame, never the real stdout.
    expect(painted.length).toBeGreaterThan(0);
    expect(painted[painted.length - 1]!.join("|")).toContain("(m)> ");
    expect(painted.some((rows) => rows.join("").includes("hi"))).toBe(true);
  });
});

/** SignalHost double: records the separate SIGTERM/SIGHUP handlers + exits. */
class FakeSignalHost implements SignalHost {
  handlers: { SIGTERM: (() => void)[]; SIGHUP: (() => void)[] } = { SIGTERM: [], SIGHUP: [] };
  exits: number[] = [];
  on(signal: "SIGTERM" | "SIGHUP", cb: () => void): () => void {
    this.handlers[signal].push(cb);
    return () => {
      this.handlers[signal] = this.handlers[signal].filter((h) => h !== cb);
    };
  }
  exit(code: number): void {
    this.exits.push(code);
  }
}

function makeBridge(): { bridge: OutputBridge; term: GridTerminal; clock: FakeClock; sig: FakeSignalHost } {
  const term = new GridTerminal({ rows: 24, cols: 80 });
  const clock = new FakeClock();
  const sig = new FakeSignalHost();
  const bridge = new OutputBridge({ terminal: term, clock, signalHost: sig });
  return { bridge, term, clock, sig };
}

describe("mount rule (§9)", () => {
  it("mounts iff split knob AND stdin.isTTY AND stdout.isTTY", () => {
    expect(shouldMountRenderer("split", true, true)).toBe(true);
    // Every non-TTY combination is passthrough regardless of the knob.
    expect(shouldMountRenderer("split", false, true)).toBe(false);
    expect(shouldMountRenderer("split", true, false)).toBe(false);
    expect(shouldMountRenderer("split", false, false)).toBe(false);
    expect(shouldMountRenderer("split", null, true)).toBe(false);
    expect(shouldMountRenderer("split", undefined, undefined)).toBe(false);
  });

  it("legacy knob never mounts, even on a full TTY pair (byte-identity default)", () => {
    expect(shouldMountRenderer("legacy", true, true)).toBe(false);
    expect(shouldMountRenderer(undefined, true, true)).toBe(false);
    expect(shouldMountRenderer("", true, true)).toBe(false);
    // A typo'd value is not "split" either -- fail-safe to legacy.
    expect(shouldMountRenderer("SPLIT", true, true)).toBe(false);
  });
});

describe("incompleteEscapeStart (capture feed safety)", () => {
  it("holds a split CSI / OSC / lone ESC and lets complete sequences through", () => {
    expect(incompleteEscapeStart("hello")).toBe(-1);
    expect(incompleteEscapeStart("a\x1b[10;5fb")).toBe(-1); // complete SGR
    expect(incompleteEscapeStart("a\x1b[10;5")).toBe(1); // CSI still mid-params
    expect(incompleteEscapeStart("a\x1b")).toBe(1); // lone ESC
    expect(incompleteEscapeStart("\x1b]8;;http://x\x07rest")).toBe(-1); // OSC terminated
    expect(incompleteEscapeStart("\x1b]8;;http://x")).toBe(0); // OSC unterminated
  });
});

describe("transcript commit (§2 rubric 1)", () => {
  it("commits a scripted session transcript into scrollback above the frame", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    // A live frame with an echoed prompt, then three settled rows commit.
    bridge.setPrompt("(test-model)> ");
    bridge.capture.write("(test-model)> ");
    bridge.commitText("first answer\nsecond answer\nthird answer\n");
    clock.runAll();

    const snap = term.grid.snapshot();
    const all = [...snap.scrollback, ...snap.screen].join("\n");
    expect(all).toContain("first answer");
    expect(all).toContain("second answer");
    expect(all).toContain("third answer");
    // Rows are intact -- never a concatenation fragment.
    expect(all).not.toContain("first answersecond answer");
    // The prompt echo frame row survives the commits (it is the live frame,
    // not scrollback -- committed rows land above it).
    const frameRows = bridge.capture.frameRows();
    expect(frameRows.some((r) => r.includes("first answer"))).toBe(false);
  });

  it("a submitted line commits as prompt + text and resets the frame", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    bridge.setPrompt("(test-model)> ");
    bridge.capture.write("(test-model)> ");
    bridge.lineSubmitted("do a thing");
    clock.runAll();

    const all = [...term.grid.snapshot().scrollback, ...term.grid.snapshot().screen].join("\n");
    expect(all).toContain("(test-model)> do a thing");
    // The frame is now empty (capture reset after the submit row).
    expect(bridge.capture.frameRows().join("")).not.toContain("do a thing");
  });

  it("flushEcho pins a mid-typed echo line permanently (interrupt path)", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    bridge.capture.write("(m)> half-typed");
    bridge.flushEcho();
    clock.runAll();
    const all = [...term.grid.snapshot().scrollback, ...term.grid.snapshot().screen].join("\n");
    expect(all).toContain("(m)> half-typed");
    expect(bridge.capture.frameRows().length).toBe(0);
  });
});

describe("arbiter on a mid-frame stderr write (§2 rubric 3)", () => {
  it("lands the diagnostic as a clean permanent row, no fragment in the frame", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();

    // Live frame: the prompt is painted. A commit is already queued so the
    // frame is genuinely mid-sequence when the stderr diagnostic arrives.
    bridge.capture.write("LIVEPROMPT> ");
    bridge.commitText("answer line one\nanswer line two\n");
    // Foreign stderr write arrives while the frame is live.
    bridge.arbiteText("WARN disk almost full\n");
    clock.runAll();

    const snap = term.grid.snapshot();
    const all = [...snap.scrollback, ...snap.screen];
    const text = all.join("\n");
    // The diagnostic is its own intact row.
    expect(text).toContain("WARN disk almost full");
    // The committed answer rows are intact and in order.
    expect(text.indexOf("answer line one")).toBeLessThan(text.indexOf("answer line two"));
    // No fragment: the diagnostic never spliced into a frame/answer row.
    expect(all.some((r) => r.includes("WARN") && r.includes("answer line"))).toBe(false);
    // And the live frame content is unharmed.
    expect(text).toContain("LIVEPROMPT>");
    expect(all.some((r) => r.includes("LIVEPROMPT>") && r.includes("WARN"))).toBe(false);
  });

  it("flushes a pending stdout partial before an arbiter row (temporal order)", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    bridge.commitText("out-part-1");
    bridge.arbiteText("err-row\n"); // forces out partial to commit first
    clock.runAll();
    const text = [...term.grid.snapshot().scrollback, ...term.grid.snapshot().screen].join("\n");
    expect(text).toContain("out-part-1");
    expect(text).toContain("err-row");
    expect(text).not.toContain("out-part-1err-row");
  });
});

describe("teardown pairing (§10)", () => {
  it("shutdown runs the restore: paste-off, raw-off, cursor-on in order", () => {
    const { bridge, term } = makeBridge();
    bridge.mount();
    // The mode log recorded the mount enable pair; clear it so we assert the
    // teardown block alone.
    term.grid.modeLog.length = 0;

    bridge.shutdown();

    const log = term.grid.modeLog;
    expect(log).toContain("?2004l");
    expect(log).toContain("raw:off");
    expect(log).toContain("?25h");
    // Order matters (§10): paste off (step 4) precedes raw off (step 5)
    // precedes cursor-on (step 6).
    expect(log.indexOf("?2004l")).toBeLessThan(log.indexOf("raw:off"));
    expect(log.indexOf("raw:off")).toBeLessThan(log.indexOf("?25h"));
    expect(bridge.guard.fired).toBe(true);
  });

  it("mount enables the pair (raw:on then ?2004h) that teardown unwinds", () => {
    const { bridge, term } = makeBridge();
    bridge.mount();
    expect(term.grid.modeLog).toContain("raw:on");
    expect(term.grid.modeLog).toContain("?2004h");
  });

  it("simulated SIGTERM restores + exits 143; SIGHUP is a separate handler at 140", () => {
    const { bridge, term, sig } = makeBridge();
    bridge.mount();
    expect(sig.handlers.SIGTERM.length).toBe(1);
    expect(sig.handlers.SIGHUP.length).toBe(1);
    // Separate handler objects (Bun delivers no signal name to a shared one).
    expect(sig.handlers.SIGTERM[0]).not.toBe(sig.handlers.SIGHUP[0]);

    term.grid.modeLog.length = 0;
    sig.handlers.SIGTERM[0]!();

    expect(sig.exits).toEqual([128 + 15]);
    expect(term.grid.modeLog).toContain("?2004l");
    expect(term.grid.modeLog).toContain("raw:off");
    expect(term.grid.modeLog).toContain("?25h");
  });

  it("simulated SIGHUP exits 128+12", () => {
    const { bridge, sig } = makeBridge();
    bridge.mount();
    sig.handlers.SIGHUP[0]!();
    expect(sig.exits).toEqual([128 + 12]);
  });

  it("teardown is idempotent across onQuit then a signal (no double restore)", () => {
    const { bridge, sig } = makeBridge();
    bridge.mount();
    const termHandler = sig.handlers.SIGTERM[0]!;
    bridge.shutdown();
    // Step 7 removed the signal handlers (default behavior resumes).
    expect(sig.handlers.SIGTERM.length).toBe(0);
    expect(bridge.guard.fired).toBe(true);
    // A stale handler re-run fires the idempotent guard: no throw, no second
    // restore cycle needed, and the signal path still records its exit code.
    const exitsBefore = sig.exits.length;
    termHandler();
    expect(bridge.guard.fired).toBe(true);
    expect(sig.exits.length).toBe(exitsBefore + 1);
  });
});

describe("suspend/resume child handoff (§5)", () => {
  it("suspend commits the tail, unwinds modes in order, erases the frame, releases stdin listeners", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    bridge.capture.write("(m)> half-typed");
    clock.runAll();
    bridge.commitText("dangling tail"); // unterminated partial line
    const stdin = new EventEmitter();
    stdin.on("data", () => {}); // readline stand-in
    term.grid.modeLog.length = 0;

    bridge.suspend(stdin as never);
    clock.runAll();

    // The tail commits as a permanent row before the handoff (commit-or-drop).
    const snap = term.grid.snapshot();
    expect([...snap.scrollback, ...snap.screen].join("\n")).toContain("dangling tail");
    // Mode unwind in §5 order: ?2004l precedes raw:off.
    const log = term.grid.modeLog;
    expect(log.indexOf("?2004l")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("?2004l")).toBeLessThan(log.indexOf("raw:off"));
    // Input stops ONLY via listener release (pitfall 6) -- the child gets a
    // cooked, uncontended terminal.
    expect(stdin.listenerCount("data")).toBe(0);
    // Frame erased with the live geometry: no ghost of the echo.
    expect(term.grid.snapshot().screen.join("")).not.toContain("half-typed");
  });

  it("resume re-enables the mode pair, repaints the frame, re-attaches the same listeners", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    bridge.capture.write("(m)> still-typing");
    clock.runAll();
    const listener = () => {};
    const stdin = new EventEmitter();
    stdin.on("data", listener);

    const resume = bridge.suspend(stdin as never);
    clock.runAll();
    term.grid.modeLog.length = 0;

    resume();
    clock.runAll();

    const log = term.grid.modeLog;
    expect(log.indexOf("raw:on")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("raw:on")).toBeLessThan(log.indexOf("?2004h"));
    expect(stdin.listenerCount("data")).toBe(1);
    expect(stdin.rawListeners("data")[0]).toBe(listener);
    // The frame comes back with the echo it held before the child ran.
    expect(term.grid.snapshot().screen.join("\n")).toContain("still-typing");
  });

  it("double suspend is inert; the listener returns exactly once via the outer resume", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    const stdin = new EventEmitter();
    stdin.on("data", () => {});

    const outer = bridge.suspend(stdin as never);
    const inner = bridge.suspend(stdin as never);
    expect(stdin.listenerCount("data")).toBe(0);
    inner(); // no-op: the inner scope must not double-attach or restore early
    expect(stdin.listenerCount("data")).toBe(0);
    outer();
    clock.runAll();
    expect(stdin.listenerCount("data")).toBe(1);
  });
});

describe("clipboard-paste absorption (no double bracketed-paste restore)", () => {
  it("rendererOwnsBracketedPaste suppresses the interceptor's ?2004h/l writes", () => {
    const writes: string[] = [];
    const stdin: {
      isTTY: boolean;
      _l: Record<string, unknown[]>;
      listeners(ev: string): unknown[];
      removeListener(ev: string, l: unknown): unknown;
      on(ev: string, l: unknown): unknown;
    } = {
      isTTY: true,
      _l: { data: [function origData() {}] },
      listeners(ev: string) {
        return this._l[ev] ?? [];
      },
      removeListener(ev: string, l: unknown) {
        this._l[ev] = (this._l[ev] ?? []).filter((x) => x !== l);
        return this;
      },
      on(ev: string, l: unknown) {
        (this._l[ev] ??= []).push(l);
        return this;
      },
    };
    const output = {
      isTTY: true,
      write(data: string) {
        writes.push(data);
        return true;
      },
    };
    const rl = {
      input: stdin,
      output,
      on() {
        return rl;
      },
    } as never;

    new ClipboardPasteInterceptor(rl, {
      pasteMarkerMinChars: 400,
      rendererOwnsBracketedPaste: true,
    });
    // No bracketed-paste enable written by the interceptor when the renderer owns it.
    expect(writes.join("")).not.toContain("?2004h");
  });
});

describe("installIoPatches routes + restores (§2 ownership)", () => {
  it("stdout routes to commit, stderr to arbiter, and restore returns the originals", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    const origOut = (chunk: unknown): boolean => {
      void chunk;
      return true;
    };
    const host: IoPatchHost = {
      stdout: { write: origOut as never },
      stderr: { write: ((c: unknown) => { void c; return true; }) as never },
      stdin: { pause: () => "paused" },
      console: {
        log: () => {},
        error: () => {},
        warn: () => {},
      },
    };
    const restore = installIoPatches(bridge, host);
    // stdin.pause is neutered while mounted (pitfall 6).
    expect(host.stdin.pause()).not.toBe("paused");
    host.stdout.write("patched-out\n");
    host.stderr.write("patched-err\n");
    clock.runAll();
    expect(bridge.transcriptLog).toContain("patched-out");
    expect(bridge.transcriptLog).toContain("patched-err");

    restore();
    expect(host.stdin.pause()).toBe("paused");
    expect(host.stdout.write).toBe(origOut as never);
  });
});

describe("non-TTY determinism golden (§9, legacy passthrough)", () => {
  // Cursor-control = the motion/private-mode sequences only the renderer
  // emits (CUU/CUD/CUF/CUB, ED/EL, CUP, SCI/DL, ?2026/?2004/?25). SGR (m)
  // styles content and predates the renderer; the golden strips SGR and then
  // demands NO escape byte survives. With NO_COLOR even SGR must be absent
  // from event output (only reset()'s housekeeping ESC[0m may remain).
  async function runLegacySink(noColor: boolean): Promise<string> {
    const outBuf: string[] = [];
    const fakeOut = { write: (s: string) => (outBuf.push(s), true) } as never as NodeJS.WriteStream;
    const saved = process.env.NO_COLOR;
    if (noColor) process.env.NO_COLOR = "1";
    else delete process.env.NO_COLOR;
    try {
      const palette = await CliOutputSink.resolve(false, "dark", null);
      const sink = new CliOutputSink({ palette, hideUserMessage: true });
      sink.outStream = fakeOut;
      sink.altStream = fakeOut;
      sink.emit({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "plain answer" } as OutputEvent);
      sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: " stream tail" } as OutputEvent);
      sink.emit({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: "ls" } as OutputEvent);
      sink.reset();
      return outBuf.join("");
    } finally {
      if (saved === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = saved;
    }
  }

  it("piped output: zero cursor-control bytes, content intact", async () => {
    const out = await runLegacySink(false);
    expect(out).toContain("plain answer");
    expect(out).toContain("stream tail");
    // Strip SGR styling; nothing else may wear an escape.
    expect(out.replace(/\x1b\[[0-9;]*m/g, "")).not.toContain("\x1b");
  });

  it("NO_COLOR: event output carries no ANSI at all (deterministic golden)", async () => {
    const out = await runLegacySink(true);
    expect(out.replace(/\x1b\[0m/g, "")).not.toContain("\x1b"); // only reset()'s SGR reset
    expect(out).toContain("plain answer");
  });

  it("NO_COLOR takes precedence over explicit colors-on resolve", async () => {
    const saved = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const palette = await CliOutputSink.resolve(true, "dark", null);
      expect(palette.use_colors).toBe(false);
      expect(applyFinalResponse("hello", palette)).toBe("hello");
    } finally {
      if (saved === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = saved;
    }
  });
});

// ── Bun readline wire compatibility (regression: duplicated prompt, dead cursor) ──
// Bun's readline repaints an edited line as `\x1b[1G` + `\x1b[0J` + text +
// `\x1b[<n>G` (measured against a real TTY on bun 1.x). Line editing needs a
// real TTY stdin -- a fake Readable only raw-echoes -- so the edit refresh is
// fed as the measured byte sequence rather than driven through key events.
// (This is also why the older capture test above passed throughout: raw echo
// renders identically to a refresh, and never exercised the edit path.)

describe("capture: bun readline refresh + cursor projection", () => {
  it("an edit refresh leaves one prompt copy; cursor() reports readline's position", () => {
    const painted: string[][] = [];
    const capture = new CaptureStream((rows) => painted.push(rows), 24, 80);
    const input = new Readable({ read() {} });
    (input as unknown as { isTTY: boolean }).isTTY = true;
    (input as unknown as { setRawMode: (m: boolean) => unknown }).setRawMode = () => input;
    const rl = readline.createInterface({
      input,
      output: capture as never,
      prompt: "(m)> ",
    });
    rl.prompt();
    input.emit("data", Buffer.from("hello")); // raw echo path
    // The exact bytes readline writes when the line becomes "hell" (measured):
    capture.write("\x1b[1G\x1b[0J(m)> hell\x1b[10G");
    const rows = capture.frameRows();
    rl.close();

    // Exactly one prompt copy survives, minus the deleted char.
    expect(rows).toEqual(["(m)> hell"]);
    // The capture tracks where readline believes the cursor is, so the
    // renderer can put the PHYSICAL cursor there.
    expect(capture.cursor()).toEqual({ row: 0, col: 9 });
  });

  it("submit at the screen bottom keeps the submitted row intact", () => {
    // Regression: Enter at bottom-of-screen -> cursor jumped a row and the
    // streaming rows overwrote the submitted line. The submit echo (a bare
    // `\r\n`, measured on a real PTY) line-feeds the capture cursor below
    // the frame; placement beyond the frame clamped at the screen bottom,
    // desyncing the parkOffset the next anchor restore depends on.
    const term = new GridTerminal({ rows: 5, cols: 20 });
    const clock = new FakeClock();
    const sig: SignalHost = { on: () => () => {}, exit: () => {} };
    const bridge = new OutputBridge({ terminal: term, clock, signalHost: sig });
    bridge.setPrompt("(m)> ");
    bridge.mount();
    clock.runAll();
    // Fill the screen so the frame anchor sits at the LAST screen row --
    // the position where a phantom down() gets clamped by the terminal.
    bridge.commitText("l1\nl2\nl3\nl4\n");
    clock.runAll();
    expect(term.grid.cursorRow).toBe(4);
    bridge.capture.write("(m)> hello");
    clock.runAll();
    // Measured submit path: readline's Enter echo, then the bridge handler,
    // then the synchronous commit drain.
    bridge.capture.write("\r\n");
    bridge.lineSubmitted("hello");
    bridge.core.drainCommitsSync();
    clock.runAll();
    bridge.capture.write("(m)> ");
    clock.runAll();
    bridge.commitText("stream-1\nstream-2\n");
    clock.runAll();

    const screen = term.grid.snapshot().screen;
    expect(screen.filter((r) => r === "l4").length).toBe(1);
    expect(screen.filter((r) => r === "(m)> hello").length).toBe(1); // survived
    expect(screen.filter((r) => r === "stream-1").length).toBe(1);
    expect(screen.filter((r) => r === "stream-2").length).toBe(1);
    expect(screen[screen.length - 1]).toBe("(m)>"); // frame pinned at the bottom
    const rows = ["l4", "(m)> hello", "stream-1", "stream-2", "(m)>"];
    expect(screen.map((r) => r)).toEqual(rows);
  });
});

// ── Turn-boundary newline assembly (regression: phantom blank rows) ──────
// Legacy stdout+stderr share one byte stream, so a lone "\n" written while a
// line is unterminated terminates that line -- it never prints a blank. The
// split channels would otherwise commit such separators (the sink's _flushNl
// lands on the OTHER stream; TURN_END's log("") closes the unterminated
// token-usage line; the interrupt notice's leading "\n" follows a pinned
// echo) as empty scrollback rows.

describe("newline assembly: terminators are not blank rows", () => {
  it("a separator written to the other channel terminates the open row", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    // Streaming content (stdout, unterminated), the sink's "\n" separator to
    // stderr, the token line (unterminated), TURN_END's sink.log("") -> "\n".
    bridge.commitText("the answer");
    bridge.arbiteText("\n");
    bridge.arbiteText("Token usage: 1234");
    bridge.commitText("\n"); // sink.log("") on TURN_END
    clock.runAll();
    // Neither separator committed a blank row.
    expect(bridge.transcriptLog).toEqual(["the answer", "Token usage: 1234"]);
  });

  it("a blank row at column 0 is still a real blank row", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    bridge.commitText("a\n"); // terminated: nothing open
    bridge.commitText("\nb\n"); // leading "\n" on a closed stream: genuine blank
    clock.runAll();
    expect(bridge.transcriptLog).toEqual(["a", "", "b"]);
  });

  it('terminator + blank ("\n\n" over an open row) keeps exactly the one blank', () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    bridge.commitText("out line");
    bridge.arbiteText("\n\n"); // first eats the open row, second is the blank
    bridge.arbiteText("warn\n");
    clock.runAll();
    expect(bridge.transcriptLog).toEqual(["out line", "", "warn"]);
  });

  it("the interrupt notice prints directly under the pinned echo", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    bridge.capture.write("(m)> half-typed");
    bridge.flushEcho();
    // sink.log("\nInterrupted ...") -- logRouter appends the trailing "\n".
    bridge.commitText("\nInterrupted (/quit, /exit, or ctrl-d to exit)\n");
    clock.runAll();
    expect(bridge.transcriptLog).toEqual([
      "(m)> half-typed",
      "Interrupted (/quit, /exit, or ctrl-d to exit)",
    ]);
  });

  it("a full sink turn (streaming + token usage + TURN_END nudge) commits no blanks", async () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    const saved = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const palette = await CliOutputSink.resolve(false, "dark", null);
      const sink = new CliOutputSink({ palette, hideUserMessage: true });
      // The split wiring in miniature: the io patches route the sink's
      // streams into the bridge channels, logRouter into the commit channel.
      sink.outStream = { write: (s: string) => (bridge.commitText(s), true) } as never;
      sink.altStream = { write: (s: string) => (bridge.arbiteText(s), true) } as never;
      sink.logRouter = (m: string) => bridge.commitText(m + "\n");

      sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "the answer\n" } as OutputEvent);
      sink.emit({
        type: OUTPUT_EVENT.TOKEN_USAGE,
        sessionPromptTokens: 1,
        sessionCachedTokens: 0,
        sessionCompletionTokens: 2,
        sessionTotalTokens: 3,
        turns: 1,
        promptTokens: 1,
        cachedTokens: 0,
        completionTokens: 2,
        totalTokens: 3,
        contextWindow: 100,
      } as OutputEvent);
      sink.log(""); // the TURN_END re-prompt nudge
      clock.runAll();

      expect(bridge.transcriptLog).toEqual([
        "the answer",
        "Token usage: 0 cached, 1 processed, 2 generated. (3/100)",
      ]);
    } finally {
      if (saved === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = saved;
    }
  });
});

// ── Viewport plumbing: capture geometry + the mount resize subscription ──
// §6: on a resize the core erases with the OLD geometry (core.handleResize)
// and the capture model re-wraps at the new width; readline is told to repaint
// via the capture's own "resize" event.

describe("capture geometry + resize wiring (§6 viewport change)", () => {
  it("columns/rows report the capture geometry; setGeometry rebuilds and tells readline", () => {
    const painted: string[][] = [];
    const capture = new CaptureStream((rows) => painted.push(rows), 12, 40);
    expect([capture.columns, capture.rows]).toEqual([40, 12]);

    capture.write("wide line\n");
    let resizes = 0;
    capture.on("resize", () => {
      resizes++;
    });
    capture.setGeometry(8, 30);

    expect([capture.columns, capture.rows]).toEqual([30, 8]);
    expect(resizes).toBe(1); // readline repaint signal
    expect(capture.frameRows()).toEqual([]); // the old wrap is gone
    expect(painted[painted.length - 1]).toEqual([]); // and the core was told
  });

  it("mount subscribes to terminal resize so the capture follows the viewport", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    bridge.capture.write("(m)> typing into a wide viewport");
    clock.runAll();
    expect(bridge.capture.frameRows().join("")).toContain("typing");

    term.resize(40, 10); // cols, rows -- GridTerminal fires onResize like stdout
    expect([bridge.capture.columns, bridge.capture.rows]).toEqual([40, 10]);
    expect(bridge.capture.frameRows()).toEqual([]);
    clock.runAll();
  });
});

describe("question takeover (§8 prompt suppression)", () => {
  it("lineSubmitted commits the bare answer while question mode is on", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    bridge.setPrompt("(m)> ");
    bridge.setQuestionMode(true);
    bridge.lineSubmitted("blue"); // the answer is not the main prompt's line
    bridge.setQuestionMode(false);
    bridge.lineSubmitted("next turn");
    clock.runAll();
    expect(bridge.transcriptLog).toEqual(["blue", "(m)> next turn"]);
  });
});

describe("console routing through the io patches (Bun bypasses stdout)", () => {
  function fakeHost(): IoPatchHost {
    return {
      stdout: { write: () => true },
      stderr: { write: () => true },
      stdin: { pause: () => "paused" },
      console: { log: () => {}, error: () => {}, warn: () => {} },
    };
  }

  it("console.log commits, console.error/warn arbitrate, non-strings stringify", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    const host = fakeHost();
    installIoPatches(bridge, host);

    host.console.log("count", 7, { a: 1 });
    host.console.error("bad", null);
    host.console.warn("meh", true);
    clock.runAll();

    expect(bridge.transcriptLog).toEqual([
      "count 7 [object Object]",
      "bad null",
      "meh true",
    ]);
  });

  it("the write callback fires whichever positional slot carries it", () => {
    const { bridge } = makeBridge();
    bridge.mount();
    const host = fakeHost();
    installIoPatches(bridge, host);

    let cbErr: unknown = "uncalled";
    const accepted = host.stdout.write("cb-line\n", (err?: Error | null) => {
      cbErr = err;
    });
    expect(accepted).toBe(true);
    expect(cbErr).toBe(null);

    let cbErr2: unknown = "uncalled";
    host.stderr.write("cb-err\n", "utf8", (err?: Error | null) => {
      cbErr2 = err;
    });
    expect(cbErr2).toBe(null);
    expect(bridge.transcriptLog).toEqual(["cb-line", "cb-err"]);
  });
});

describe("processSignalHost (the real SignalHost seam)", () => {
  it("registers on the live process and hands back a working unsubscribe", () => {
    const before = process.listenerCount("SIGTERM");
    const off = processSignalHost.on("SIGTERM", () => {});
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    off();
    expect(process.listenerCount("SIGTERM")).toBe(before);
    expect(() => off()).not.toThrow(); // unsubscribing twice is inert
  });
});

// ── mountSplitRenderer against the real process ─────────────────────────
// bun test's stdio is piped, so the §9 gate can only open by declaration.
// The probe fixture mounts for real (patching ITS stdout/stderr/console) and
// the parent reads the mounted session's bytes off the pipe -- including the
// exit code processSignalHost.exit produces, which nothing in-process may
// touch.

describe("mountSplitRenderer real-process probe", () => {
  const PROBE = join(import.meta.dir, "../fixtures/split-mount-probe.ts");

  async function runProbe(env: Record<string, string> = {}): Promise<{ out: string; err: string; code: number }> {
    const proc = Bun.spawn(["bun", PROBE], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOTDOG_LOG_TARGET: "none", ...env },
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { out, err, code: await proc.exited };
  }

  it("routes stdio + console into the frame, restores on shutdown, exits on command", async () => {
    const { out, err, code } = await runProbe();

    // The seam's exit() is the process exit code -- 7 came from the probe.
    expect(code).toBe(7);
    // Enable pair landed before any content; the unwind after the last row.
    const enable = out.indexOf("\x1b[?2004h");
    const disable = out.indexOf("\x1b[?2004l");
    expect(enable).toBeGreaterThanOrEqual(0);
    expect(disable).toBeGreaterThan(enable);
    expect(out).toContain("console-routed-line");
    expect(out).toContain("stdout-routed-line");
    expect(out).toContain("stderr-routed-line");
    expect(out.indexOf("console-routed-line")).toBeGreaterThan(enable);
    expect(out.indexOf("stderr-routed-line")).toBeLessThan(disable);
    // The renderer was the only writer: nothing reached the real stderr.
    expect(err).toBe("");
    // Bytes after the restore are plain again (the router is gone): the
    // goodbye line is the last thing on the stream, newline included.
    const tail = out.slice(out.indexOf("after-restore") + "after-restore".length);
    expect(tail).toBe("\n");
  }, 20000);

  it("the process.on(exit) last-chance restore unwinds when nobody calls shutdown", async () => {
    const { out, code } = await runProbe({ PROBE_MODE: "exit-handler" });
    expect(code).toBe(0);
    expect(out).toContain("stdout-routed-line"); // queued commits drained
    expect(out).toContain("\x1b[?2004h");
    expect(out).toContain("\x1b[?2004l"); // the exit hook restored the modes
  }, 20000);
});

describe("editor input mount (stage 3b)", () => {
  function makeEditorRig(candidates: { label: string; insert?: string }[] = []) {
    const { bridge, term, clock } = makeBridge();
    const source = new MemoryKeySource();
    const calls = {
      submit: [] as string[],
      interrupt: 0,
      quit: 0,
      unhandled: [] as string[],
      popupRequests: [] as { word: string; from: number; to: number }[],
    };
    bridge.setPrompt("(m)> ");
    bridge.mount();
    clock.runAll();
    const detach = bridge.mountEditorInput(source, {
      submit: (line) => calls.submit.push(line),
      interrupt: () => calls.interrupt++,
      quit: () => calls.quit++,
      unhandled: (key) => calls.unhandled.push(key),
      popup: (word, from, to) => {
        calls.popupRequests.push({ word, from, to });
        return candidates;
      },
    });
    clock.runAll();
    return { bridge, term, clock, source, calls, detach };
  }

  const screen = (term: GridTerminal): string[] =>
    term.grid.snapshot().screen.map((r) => r.replace(/\s+$/, ""));

  it("typing renders prompt + buffer into the frame; submit commits and resets", () => {
    const r = makeEditorRig();
    r.source.push("hi");
    r.clock.runAll();
    expect(screen(r.term)[0]).toBe("(m)> hi");

    r.source.push("\r");
    r.clock.runAll();
    expect(r.calls.submit).toEqual(["hi"]);
    expect(r.bridge.transcriptLog).toEqual(["(m)> hi"]);
    // Frame shows a fresh prompt; the submitted line lives in the transcript.
    expect(screen(r.term)[0]).toBe("(m)> hi"); // pinned transcript row is row 0
    expect(screen(r.term).filter((l) => l === "(m)>").length).toBe(1); // trailing space trimmed

    // History up recalls through the bridge frame (no bridge-internal hooks).
    r.source.push("\x1b[A");
    r.clock.runAll();
    expect(screen(r.term)).toContain("(m)> hi");
    expect(r.bridge.editor?.text).toBe("hi");
  });

  it("ctrl-c commits the echo, fires interrupt, and the notice leads without a blank row", () => {
    const r = makeEditorRig();
    r.source.push("abc");
    r.clock.runAll();
    r.source.push("\x03"); // pure interrupt (Decisions 2)
    r.clock.runAll();
    expect(r.calls.interrupt).toBe(1);
    expect(r.bridge.transcriptLog).toEqual(["(m)> abc"]);
    expect(r.bridge.editor?.text).toBe(""); // stashed to draft, not destroyed

    r.bridge.commitText("\nInterrupted\n");
    r.clock.runAll();
    const rows = screen(r.term);
    // Echo row directly above the notice: the notice's "\n" was the echo's
    // terminator (#eatTerminator), not a phantom blank row.
    expect(rows[0]).toBe("(m)> abc");
    expect(rows[1]).toBe("Interrupted");
  });

  it("ctrl-d on the empty buffer quits; with text it deletes forward instead", () => {
    const r = makeEditorRig();
    r.source.push("\x04");
    expect(r.calls.quit).toBe(1);
  });

  it("tab requests a popup, provider rows paint above the editor, enter accepts", () => {
    const r = makeEditorRig([{ label: "/model", insert: "/model " }]);
    r.source.push("/mo");
    r.clock.runAll();
    r.source.push("\t");
    r.clock.runAll();
    expect(r.calls.popupRequests).toEqual([{ word: "/mo", from: 0, to: 3 }]);
    expect(r.bridge.editor?.popupOpen).toBe(true);
    const withPopup = screen(r.term);
    expect(withPopup[0]).toContain("/model"); // popup row above the prompt row
    expect(withPopup[1]).toBe("(m)> /mo");

    r.source.push("\r"); // enter accepts the popup instead of submitting
    r.clock.runAll();
    expect(r.calls.submit).toEqual([]);
    expect(r.bridge.editor?.text).toBe("/model ");
  });

  it("ctrl-l purge-and-reprints the transcript; ctrl-x surfaces as unhandled", () => {
    const r = makeEditorRig();
    r.bridge.commitText("persisted line\n");
    r.clock.runAll();
    r.source.push("\x0c"); // ctrl-l -> redraw -> purge-and-reprint (§6)
    r.clock.runAll();
    const rows = screen(r.term);
    expect(rows[0]).toBe("persisted line");

    r.source.push("\x18"); // ctrl-x: deliberately unhandled in 3a (dictation binds it)
    expect(r.calls.unhandled).toEqual(["ctrl-x"]);
  });

  it("detach stops input; re-mount is allowed", () => {
    const r = makeEditorRig();
    r.detach();
    expect(r.bridge.editor).toBeNull();
    r.source.push("ghost");
    r.clock.runAll();
    expect(r.calls.submit).toEqual([]);
    expect(r.bridge.transcriptLog).toEqual([]);
    // The seam released its listener (pitfall 6 posture: detach, never pause).
    expect(r.source.listenerCount).toBe(0);
    expect(r.bridge.mountEditorInput(r.source, {
      submit: () => {}, interrupt: () => {}, quit: () => {},
    })).toBeTypeOf("function");
  });
});

// ── Stage-3b swap: the editor path IS the session ─────────────────────────
// runInteractiveSession driven end-to-end on the editor input path with an
// injected mounted bridge (Grid + FakeClock + MemoryKeySource; note §11, no
// PTY). node:readline is never constructed on this path, so every behavior
// readline used to provide (submit routing, interrupt, quit, paste markers,
// dictation, questions, prompt retarget, completion popup, teardown pairing)
// gets its own rig-driven test here. Legacy readline tests in
// ui-interactive-cli.test.ts stay untouched as the byte-identity proof.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import { createCompletionService } from "@core/completion.ts";
import {
  runInteractiveSession,
  EditorCliInput,
  buildOnQuitHandler,
  resetUiSlotsForTesting,
} from "@extensions/ui-interactive-cli/index.ts";
import type { CaptureFactory } from "@extensions/ui-interactive-cli/dictation.ts";

/** One macrotask: drains the promise chains the async handlers run on. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Real-time wait for paths that cross child processes (which/bash spawns). */
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Stub SessionManager.create (same seam the legacy integration tests use). */
async function withStubbedSessionManager(sm: unknown, fn: () => Promise<void>): Promise<void> {
  const { SessionManager: SM } = await import("@core/session/index.ts");
  const original = SM.create;
  (SM as unknown as { create: unknown }).create = async () => sm;
  try {
    await fn();
  } finally {
    (SM as unknown as { create: unknown }).create = original;
  }
}

interface SessionRigOptions {
  uiCli?: Record<string, unknown>;
  resolvedExtra?: Record<string, unknown>;
  completion?: ReturnType<typeof createCompletionService>;
  hooks?: unknown;
  dictation?: { capture?: CaptureFactory; transcribe?: (audio: Uint8Array) => Promise<string> };
}

function makeSessionRig(opts: SessionRigOptions = {}) {
  const term = new GridTerminal({ rows: 24, cols: 80 });
  const clock = new FakeClock();
  const sig = new FakeSignalHost();
  const bridge = new OutputBridge({ terminal: term, clock, signalHost: sig });
  // mountSplitRenderer mounts before the session starts; injected rigs do
  // the same (mountEditorInput would refuse input on an unmounted bridge
  // modes, and the exit-pairing counts start from the mount enable).
  bridge.mount();
  const keys = new MemoryKeySource();

  const calls = {
    enqueue: [] as string[],
    execute: [] as string[],
    interrupt: 0,
  };
  const agent = {
    sessionId: "test-session",
    commandRegistry: { names: () => ["test"] },
    modelRegistry: {},
  };
  const sm = {
    getAgent: () => agent,
    sessionId: () => "test-session",
    getBus: () => ({ run: async () => {} }),
    getTaskManager: () => null,
    executeCommand: async (_id: string, cmdText: string) => {
      calls.execute.push(cmdText);
      return undefined;
    },
    onSessionEvents: () => () => {},
    interrupt: () => {
      calls.interrupt++;
    },
    cancel: () => {},
    enqueue: (_id: string, text: string) => {
      calls.enqueue.push(text);
    },
    sessionIds: () => ["test-session"],
    getSessionInfo: (id: string) => ({ id, model: "test-model" }),
  };

  const core = {
    resolved: {
      model: "test-model",
      theme: "dark",
      profileName: "test",
      modelRegistry: {},
      ...(opts.resolvedExtra ?? {}),
    },
    config: {
      uiInteractiveCli: { shellMode: false, pasteMarkerMinChars: 80, renderer: "split", ...(opts.uiCli ?? {}) },
    },
    hooks: opts.hooks ?? { on: () => {}, notifyHooks: () => {} },
    completion: opts.completion ?? { register: () => () => {}, request: async () => [] },
    extensions: { get: () => undefined, getAll: () => [], cleanup: () => {} },
    createLlmClient: () => ({ resolveProviderSettings: () => ({ url: "http://test", apiKey: null }) }),
  };

  const done = withStubbedSessionManager(sm, async () => {
    await runInteractiveSession({}, core as never, { bridge, keySource: keys, dictation: opts.dictation });
  });

  const screenRows = (): string[] => term.grid.snapshot().screen.map((r) => r.replace(/\s+$/, ""));
  const count = (log: string[], entry: string): number => log.filter((m) => m === entry).length;
  return { term, clock, sig, bridge, keys, calls, done, screenRows, count };
}

/** Run fn with process.exit stubbed (same pattern as the legacy suite). */
async function withStubbedExit(fn: (exitCalls: number[]) => Promise<void>): Promise<void> {
  const original = process.exit;
  const exitCalls: number[] = [];
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
    return undefined as never;
  }) as never;
  try {
    await fn(exitCalls);
  } finally {
    process.exit = original;
  }
}

describe("editor session swap: submit routing (stage 3b)", () => {
  it("plain line goes through channel.send and pins the prompt echo", async () => {
    const rig = makeSessionRig();
    await rig.done;

    rig.keys.push("hello there\r");
    await tick();

    expect(rig.calls.enqueue).toEqual(["hello there"]);
    expect(rig.bridge.transcriptLog).toContain("(test-model)> hello there");
  });

  it("slash lines route to sessionManager.executeCommand, never to the model queue", async () => {
    const rig = makeSessionRig();
    await rig.done;

    rig.keys.push("/tokens\r");
    await tick();

    expect(rig.calls.execute).toEqual(["tokens"]);
    expect(rig.calls.enqueue).toEqual([]);
  });

  it("shell mode executes system commands and sends non-commands to the model", async () => {
    const rig = makeSessionRig({ uiCli: { shellMode: true, pasteMarkerMinChars: 80 } });
    await rig.done;

    // "grep x /dev/null" is a real system command that exits 1 silently:
    // the exec result row proves the editor path ran it through the bridge
    // suspend/resume bracket instead of enqueueing. "please respond" is not
    // a command, so it goes to the model. Both decisions cross child
    // processes (which/bash), so wait on real time rather than macrotasks.
    rig.keys.push("grep x /dev/null\r");
    await waitFor(() => rig.bridge.transcriptLog.join("\n").includes("[exec: exit code 1]"));
    expect(rig.calls.enqueue).toEqual([]);

    rig.keys.push("please respond\r");
    await waitFor(() => rig.calls.enqueue.length === 1);
    expect(rig.calls.enqueue).toEqual(["please respond"]);
  });
});

describe("editor session swap: interrupt / quit / exit pairing (§10 suite-6)", () => {
  it("ctrl-c interrupts once and pins the echo exactly once", async () => {
    const rig = makeSessionRig();
    await rig.done;

    rig.keys.push("abc");
    await tick();
    rig.keys.push("\x03");
    await tick();

    expect(rig.calls.interrupt).toBe(1);
    const echo = rig.bridge.transcriptLog.filter((r) => r === "(test-model)> abc");
    expect(echo.length).toBe(1); // no double flushEcho: the handler must not re-pin
    const notice = rig.bridge.transcriptLog.filter((r) =>
      r.startsWith("Interrupted (/quit, /exit, or ctrl-d to exit)"),
    );
    expect(notice.length).toBe(1);
  });

  it("ctrl-d quit leaves raw mode and bracketed paste restored exactly once", async () => {
    const rig = makeSessionRig();
    await rig.done;

    await withStubbedExit(async (exitCalls) => {
      rig.keys.push("\x04");
      await tick();
      expect(exitCalls).toEqual([0]);
    });

    const log = rig.term.grid.modeLog;
    // ?25h rides every frame paint; the pairing that must land exactly once
    // per exit is the raw-mode + bracketed-paste pair (§10 steps 4-5).
    expect(rig.count(log, "?2004l")).toBe(1);
    expect(rig.count(log, "raw:off")).toBe(1);
    expect(rig.term.rawMode).toBe(false);
    // The last-chance hook (process exit / repeat quit) is idempotent.
    rig.bridge.shutdown();
    expect(rig.count(rig.term.grid.modeLog, "?2004l")).toBe(1);
    expect(rig.count(rig.term.grid.modeLog, "raw:off")).toBe(1);
  });

  it("/quit slash tears down exactly once", async () => {
    const rig = makeSessionRig();
    await rig.done;

    await withStubbedExit(async (exitCalls) => {
      rig.keys.push("/quit\r");
      await tick();
      expect(exitCalls).toEqual([0]);
    });

    const log = rig.term.grid.modeLog;
    expect(rig.count(log, "?2004l")).toBe(1);
    expect(rig.count(log, "raw:off")).toBe(1);
  });

  it("SIGTERM restores once and exits 128+15; handlers were separate", async () => {
    const rig = makeSessionRig();
    await rig.done;
    expect(rig.sig.handlers.SIGTERM.length).toBe(1);
    expect(rig.sig.handlers.SIGHUP.length).toBe(1);

    rig.sig.handlers.SIGTERM[0]!();

    expect(rig.sig.exits).toEqual([128 + 15]);
    const log = rig.term.grid.modeLog;
    expect(rig.count(log, "?2004l")).toBe(1);
    expect(rig.count(log, "raw:off")).toBe(1);
  });
});

describe("editor session swap: paste markers over buffer text", () => {
  it("multi-line paste collapses to a marker and restores content at submit", async () => {
    const rig = makeSessionRig({ uiCli: { shellMode: false, pasteMarkerMinChars: 10 } });
    await rig.done;

    rig.keys.push("\x1b[200~multi\nline\ncontent\x1b[201~");
    rig.clock.runAll();
    expect(rig.bridge.editor?.text).toBe("[Paste #1 - 3 lines]");

    rig.keys.push(" explain\r");
    await tick();
    expect(rig.calls.enqueue).toEqual(["multi\nline\ncontent explain"]);
  });

  it("min-chars boundary: short single-line inserts as-is, at/over gets a marker", async () => {
    const rig = makeSessionRig({ uiCli: { shellMode: false, pasteMarkerMinChars: 10 } });
    await rig.done;

    rig.keys.push("\x1b[200~123456789\x1b[201~"); // 9 < 10: inline
    rig.clock.runAll();
    expect(rig.bridge.editor?.text).toBe("123456789");

    rig.keys.push("\x1b[200~1234567890\x1b[201~"); // exactly 10: marker (seq only counts markers)
    rig.clock.runAll();
    expect(rig.bridge.editor?.text).toBe("123456789[Paste #1 - 1 line]");

    rig.keys.push("\r");
    await tick();
    expect(rig.calls.enqueue).toEqual(["1234567891234567890"]);
  });
});

describe("editor session swap: ctrl-x dictation over unhandled keys", () => {
  it("inserts the transcript at the cursor and never auto-sends", async () => {
    let cancelled = 0;
    const capture: CaptureFactory = () => ({
      stop: async () => new Uint8Array([1, 2, 3]),
      cancel: () => {
        cancelled++;
      },
    });
    const rig = makeSessionRig({
      resolvedExtra: { sttUrl: "http://stt.test" },
      dictation: { capture, transcribe: async () => "voice transcript" },
    });
    await rig.done;

    rig.keys.push("note: ");
    rig.keys.push("\x18"); // start recording
    await tick();
    rig.keys.push("\x18"); // stop -> transcribe -> insert at cursor
    await tick();

    expect(rig.bridge.editor?.text).toBe("note: voice transcript");
    expect(rig.calls.enqueue).toEqual([]); // insert only; sending stays the user's call
    expect(rig.bridge.transcriptLog).toContain("● Recording… press Ctrl+X to stop");

    rig.keys.push("\r");
    await tick();
    expect(rig.calls.enqueue).toEqual(["note: voice transcript"]);
  });

  it("interrupt cancels an in-flight recording", async () => {
    let cancelled = 0;
    const capture: CaptureFactory = () => ({
      stop: async () => new Uint8Array([1]),
      cancel: () => {
        cancelled++;
      },
    });
    const rig = makeSessionRig({
      resolvedExtra: { sttUrl: "http://stt.test" },
      dictation: { capture, transcribe: async () => "never" },
    });
    await rig.done;

    rig.keys.push("\x18"); // recording
    await tick();
    rig.keys.push("\x03"); // interrupt drops the recording
    await tick();
    expect(cancelled).toBe(1);
  });
});

describe("editor session swap: question focus (§8)", () => {
  it("menu answers resolve, abort mid-question resolves partial, lines return to the normal handler", async () => {
    const rig = makeSessionRig();
    await rig.done;
    const input = new EditorCliInput(rig.bridge);
    const controller = new AbortController();

    const captured: string[] = [];
    const origOut = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as never;
    try {
      const pending = input.collectAnswers(
        [
          { key: "color", prompt: "Pick a color", options: ["red", "green", "blue"] },
          { key: "city", prompt: "Pick a city", options: ["Oslo", "Lima"] },
        ],
        controller.signal,
      );
      expect(rig.bridge.questionMode).toBe(true);
      await tick();

      rig.keys.push("2\r"); // menu index -> green
      await tick();
      // The answer echo commits bare (no prompt prefix) and never reaches
      // the normal submit handler.
      expect(rig.bridge.transcriptLog).toContain("2");
      expect(rig.calls.enqueue).toEqual([]);

      controller.abort();
      const answers = await pending; // resolves partial; never rejects
      expect(answers).toEqual({ color: "green" });
      expect(rig.bridge.questionMode).toBe(false);

      // Focus released: the next line is a normal submit again.
      rig.keys.push("back to normal\r");
      await tick();
      expect(rig.calls.enqueue).toEqual(["back to normal"]);

      const printed = captured.join("");
      expect(printed).toContain("Pick a color");
      expect(printed).toContain("[2] green");
    } finally {
      process.stdout.write = origOut;
    }
  });

  it("the completion popup is suppressed while a question owns the input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hotdog-3b-qpopup-"));
    writeFileSync(join(dir, "alpha.txt"), "a");
    const rig = makeSessionRig();
    try {
      await rig.done;
      const input = new EditorCliInput(rig.bridge);

      // One optional free-text question, so Enter submits whatever is typed.
      const pending = input.collectAnswers([{ key: "note", prompt: "Note?", required: false }], null);
      await tick();

      // A path word + Tab opens the SYNCHRONOUS readdir popup in normal
      // mode; while the question owns the input it must not appear.
      rig.keys.push(`cat ${dir}/al`);
      rig.keys.push("\t");
      rig.clock.runAll();
      expect(rig.bridge.editor?.popupOpen).toBe(false);

      rig.keys.push("\r"); // the typed text goes to the question as free text
      const answers = await pending;
      expect(answers).toEqual({ note: `cat ${dir}/al` });
      expect(rig.bridge.questionMode).toBe(false);

      // Back in normal mode the same Tab opens the popup right away.
      rig.keys.push(`cat ${dir}/al`);
      rig.keys.push("\t");
      rig.clock.runAll();
      expect(rig.bridge.editor?.popupOpen).toBe(true);
      expect(rig.screenRows().some((r) => r.includes("alpha.txt"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("editor session swap: MODEL_CHANGE retargets the mounted prompt", () => {
  it("frame shows the new model prompt", async () => {
    const hooks = new HookSystem();
    const rig = makeSessionRig({ hooks });
    await rig.done;
    rig.clock.runAll(); // drain the paint the mount scheduled on the fake clock
    const committed = () => rig.screenRows().join("\n");
    expect(committed()).toContain("(test-model)>");

    await hooks.notifyHooks(HOOKS.MODEL_CHANGE, {
      agent: { model: "gpt-new" } as never,
      oldModel: "test-model",
      newModel: "gpt-new",
    });
    rig.clock.runAll();

    expect(committed()).toContain("(gpt-new)>");
    // The live frame row is the only prompt copy; it carries the new model.
    expect(committed().includes("(test-model)>")).toBe(false);
  });
});

describe("editor session swap: completion popup sources", () => {
  it("async provider degrades cold, then opens (and accepts) on cache/refresh", async () => {
    const completion = createCompletionService();
    completion.register(
      (ctx) => ctx.line.slice(0, ctx.cursorPos).startsWith("hel"),
      () => [{ value: "hello" }],
      "test:hel",
    );
    const rig = makeSessionRig({ completion });
    await rig.done;

    rig.keys.push("hel");
    rig.keys.push("\t");
    rig.clock.runAll();
    // Cold cache: the provider is async, so the key-time answer is empty.
    expect(rig.bridge.editor?.popupOpen).toBe(false);

    await tick(); // the provider round resolves and refreshes the open span
    rig.clock.runAll();
    expect(rig.bridge.editor?.popupOpen).toBe(true);

    rig.keys.push("\r"); // enter accepts the popup instead of submitting
    rig.clock.runAll();
    expect(rig.bridge.editor?.text).toBe("hello");
    expect(rig.calls.enqueue).toEqual([]);
  });

  it("readdir path completer answers synchronously at Tab", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hotdog-3b-readdir-"));
    writeFileSync(join(dir, "alpha.txt"), "a");
    writeFileSync(join(dir, "beta.txt"), "b");
    mkdirSync(join(dir, "subdir"));
    const rig = makeSessionRig();
    try {
      await rig.done;
      rig.keys.push(`cat ${dir}/al`);
      rig.keys.push("\t");
      rig.clock.runAll();
      expect(rig.bridge.editor?.popupOpen).toBe(true); // NO await: readdir is sync
      const rows = rig.screenRows();
      expect(rows.some((r) => r.includes("alpha.txt"))).toBe(true);
      expect(rows.some((r) => r.includes("beta.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("module-slot release after mounted sessions (sequential-process hygiene)", () => {
  it("console spies stay blind while a session holds the slots and see output again once released", async () => {
    const rig = makeSessionRig();
    await rig.done;

    // Call the shared quit handler with console.log captured. buildOnQuitHandler
    // prints through the uiOut module slot, so where its bytes land proves
    // which printer the slot currently points at.
    const sayGoodbye = async (): Promise<string[]> => {
      const lines: string[] = [];
      await withStubbedExit(async () => {
        const original = console.log;
        console.log = (...args: unknown[]) => {
          lines.push(args.join(" "));
        };
        try {
          buildOnQuitHandler(
            { sessionId: () => "slot-test", getTaskManager: () => null } as never,
            { cleanup: () => {} } as never,
          )();
        } finally {
          console.log = original;
        }
      });
      return lines;
    };

    // Slots still bound to the rig's sink: the commit router sends the bytes
    // into the GridTerminal, and the console spy captures nothing.
    expect(await sayGoodbye()).toEqual([]);

    resetUiSlotsForTesting();

    const after = await sayGoodbye();
    expect(after.join("\n")).toContain("Goodbye!");
    expect(after.join("\n")).toContain("slot-test");
  });
});

// The mounted-session rigs above rebind the uiOut/uiFlush/uiBridge module
// slots. Releasing them when this file finishes is what keeps a plain
// sequential `bun test` (and the coverage script) green for every file that
// runs after this one in the same process.
afterAll(resetUiSlotsForTesting);
