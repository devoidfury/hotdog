// Split-mode renderer integration tests (design note §2/§9/§10, stage 2b).
// Drives the OutputBridge against the core's in-memory Grid + FakeClock seams
// (no PTY, no mock.module -- note §11). Covers: the TTY mount rule, a scripted
// transcript commit, arbiter behavior on a mid-frame stderr write, teardown on
// quit and simulated SIGTERM (paired restore visible in the Grid mode log), and
// the non-TTY determinism golden for the legacy passthrough path.

import { describe, it, expect } from "bun:test";
import readline from "node:readline";
import { Readable } from "node:stream";
import {
  shouldMountRenderer,
  installIoPatches,
  incompleteEscapeStart,
  CaptureStream,
  mountSplitRenderer,
  OutputBridge,
  type IoPatchHost,
} from "@extensions/ui-interactive-cli/split-bridge.ts";
import { ClipboardPasteInterceptor } from "@extensions/ui-interactive-cli/clipboard-paste.ts";
import { CliOutputSink } from "@utils/cli/cli.ts";
import { applyFinalResponse } from "@utils/cli/colors.ts";
import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import { GridTerminal, FakeClock } from "@utils/cli/renderer/index.ts";
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
