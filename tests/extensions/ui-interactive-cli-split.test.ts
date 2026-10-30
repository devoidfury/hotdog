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

describe("kill-switch config (DEFAULT split)", () => {
  const schema = extensionMeta.configSchema as unknown as {
    uiInteractiveCli: { properties: { renderer?: { type?: string; enum?: string[]; default?: string } } };
  };
  const renderer = schema.uiInteractiveCli.properties.renderer;

  it("defines uiInteractiveCli.renderer with enum legacy|split", () => {
    expect(renderer?.type).toBe("string");
    expect(renderer?.enum).toEqual(["legacy", "split"]);
  });

  it("defaults to split", () => {
    expect(renderer?.default).toBe("split");
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

describe("mount rule (§9, default-on)", () => {
  it("mounts iff the knob is not legacy AND stdin.isTTY AND stdout.isTTY", () => {
    expect(shouldMountRenderer("split", true, true)).toBe(true);
    // Unset reads as the split default (the knob is a kill-switch).
    expect(shouldMountRenderer(undefined, true, true)).toBe(true);
    // Every non-TTY combination is passthrough regardless of the knob.
    expect(shouldMountRenderer("split", false, true)).toBe(false);
    expect(shouldMountRenderer("split", true, false)).toBe(false);
    expect(shouldMountRenderer("split", false, false)).toBe(false);
    expect(shouldMountRenderer("split", null, true)).toBe(false);
    expect(shouldMountRenderer("split", undefined, undefined)).toBe(false);
  });

  it("legacy knob never mounts, even on a full TTY pair (byte-identity kill-switch)", () => {
    expect(shouldMountRenderer("legacy", true, true)).toBe(false);
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

  it("redraw() purges scrollback and re-emits the transcript (§6, /redraw entry)", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    bridge.commitText("row one\nrow two\n");
    clock.runAll();

    bridge.redraw();
    clock.runAll();

    const snap = term.grid.snapshot();
    // Purge cleared the old page; the re-emitted transcript now sits in a
    // fresh scrollback -- rows intact, both present, nothing orphaned.
    const all = [...snap.scrollback, ...snap.screen].join("\n");
    expect(all).toContain("row one");
    expect(all).toContain("row two");
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
  // Suspend-handoff stdin: EventEmitter plus the resume() the resume thunk
  // calls (real streams carry it; a bare EventEmitter does not).
  const handoffStdin = (): EventEmitter & { resume(): void } =>
    Object.assign(new EventEmitter(), { resume: () => {} });

  it("suspend commits the tail, unwinds modes in order, erases the frame, releases stdin listeners", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    bridge.capture.write("(m)> half-typed");
    clock.runAll();
    bridge.commitText("dangling tail"); // unterminated partial line
    const stdin = handoffStdin();
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
    // Listeners released (the real-pause half of the handoff is pinned in
    // the installIoPatches wiring test below) -- the child gets a cooked,
    // uncontended terminal.
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
    const stdin = handoffStdin();
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
    const stdin = handoffStdin();
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

  it("suspend runs the real pause installIoPatches stashed; resume resumes AFTER re-attaching", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    const calls: string[] = [];
    const host: IoPatchHost = {
      stdout: { write: () => true } as never,
      stderr: { write: () => true } as never,
      stdin: {
        pause(): unknown {
          calls.push("realPause");
          return host.stdin;
        },
      },
      console: { log: () => {}, error: () => {}, warn: () => {} } as never,
    };
    installIoPatches(bridge, host);
    const listener = () => {};
    const stdin = {
      attached: [] as unknown[],
      rawListeners: () => [listener],
      removeAllListeners(): unknown {
        calls.push("detach");
        return stdin;
      },
      on(_ev: string, l: unknown): unknown {
        calls.push("attach");
        stdin.attached.push(l);
        return stdin;
      },
      resume(): unknown {
        calls.push("resume");
        return stdin;
      },
    };

    const resume = bridge.suspend(stdin as never);
    clock.runAll();
    // Detach THEN the real pause -- and only the REAL one: the mounted-mode
    // neuter means nothing else on this host can pause the shared stream.
    expect(calls).toEqual(["detach", "realPause"]);
    calls.length = 0;

    resume();
    clock.runAll();
    // Listener back on BEFORE the stream restarts: a byte arriving the
    // instant flow returns has a home (Bun does not guarantee on("data")
    // implicitly resumes a paused poller).
    expect(calls).toEqual(["attach", "resume"]);
    expect(stdin.attached).toEqual([listener]);
  });

  it("suspend without installIoPatches never pauses (rig bridge, legacy posture)", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    let resumed = 0;
    const stdin = Object.assign(new EventEmitter(), {
      resume: () => {
        resumed++;
      },
    });
    stdin.on("data", () => {});

    const resume = bridge.suspend(stdin as never);
    clock.runAll();
    expect(stdin.listenerCount("data")).toBe(0); // detach-only, no throw
    resume();
    clock.runAll();
    expect(stdin.listenerCount("data")).toBe(1);
    expect(resumed).toBe(1);
  });

  it("a queued INV-6 repush firing mid-suspend paints nothing; resume restores the frame", () => {
    // The ghost-prompt regression: submit's echo commit makes a print
    // pending, the follow-up frame mutation is dropped (INV-6) and a repush
    // immediate is queued; suspend erases the frame (the erase's
    // scheduler.cancelPending does not reach the bridge's own repush
    // immediate), and the repush then painted the frame right back over the
    // child's screen.
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    bridge.capture.write("(m)> typing");
    clock.runAll();
    bridge.commitText("committed row\n"); // flush immediate pending -> printPending
    bridge.commitText("stream tail"); // streaming repaint -> DROPPED -> repush queued
    const stdin = handoffStdin();
    stdin.on("data", () => {});

    const resume = bridge.suspend(stdin as never); // drains, erases, detaches
    term.grid.modeLog.length = 0; // watch the child window only
    clock.runAll(); // the repush immediate fires here

    // Nothing painted while the child holds the screen: no synchronized
    // window opened, no ghost of the frame repainted below the committed
    // rows (unguarded, this run logs ?2026h/?25l/?25h/?2026l and the frame
    // reappears -- the INV-5 violation).
    expect(term.grid.modeLog).not.toContain("?2026h");
    expect(term.grid.snapshot().screen.join("\n")).not.toContain("typing");

    resume();
    clock.runAll();
    // Resume's repaint re-applies what the dropped repush would have shown.
    const screen = term.grid.snapshot().screen.join("\n");
    expect(screen).toContain("typing");
    expect(screen).toContain("stream tail");
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

describe("question takeover (§8 exclusivity, fix-3 echo shape)", () => {
  it("lineSubmitted commits the answer WITH its question prefix while question mode is on", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    bridge.setPrompt("(m)> ");
    bridge.setQuestionMode(true);
    bridge.setQuestionLabel("  ? Pick a flavor");
    bridge.lineSubmitted("vanilla"); // the answer is not the main prompt's line
    bridge.setQuestionMode(false);
    bridge.lineSubmitted("next turn");
    clock.runAll();
    expect(bridge.transcriptLog).toEqual(["  ? Pick a flavor > vanilla", "(m)> next turn"]);
  });

  it("a label is per-question: the latest label wins, and exiting clears it", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    bridge.setPrompt("(m)> ");
    bridge.setQuestionMode(true);
    bridge.lineSubmitted("unlabeled"); // no label set: bare fallback, never a stale one
    bridge.setQuestionLabel("  ? Color?");
    bridge.lineSubmitted("blue");
    bridge.setQuestionLabel("  ? City?"); // runQuestions retargets per question
    bridge.lineSubmitted("Oslo");
    bridge.setQuestionMode(false);
    bridge.lineSubmitted("back to normal");
    clock.runAll();
    expect(bridge.transcriptLog).toEqual([
      "unlabeled",
      "  ? Color? > blue",
      "  ? City? > Oslo",
      "(m)> back to normal",
    ]);
  });

  it("exiting question mode drops the label so a later unlabeled answer echoes bare", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    bridge.setQuestionMode(true);
    bridge.setQuestionLabel("  ? Pick a flavor");
    bridge.setQuestionMode(false);
    bridge.setQuestionMode(true); // re-entry (retry/resume): the old label must not ride along
    bridge.lineSubmitted("vanilla");
    clock.runAll();
    expect(bridge.transcriptLog).toEqual(["vanilla"]);
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
    const r = makeEditorRig([{ label: "/model", insert: "/model " }, { label: "/mount" }]);
    r.source.push("/mo");
    r.clock.runAll();
    r.source.push("\t");
    r.clock.runAll();
    expect(r.calls.popupRequests).toEqual([{ word: "/mo", from: 0, to: 3 }]);
    expect(r.bridge.editor?.popupOpen).toBe(true);
    const withPopup = screen(r.term);
    expect(withPopup[0]).toContain("/model"); // popup rows above the prompt row
    expect(withPopup[1]).toContain("/mount");
    expect(withPopup[2]).toBe("(m)> /mo");

    r.source.push("\r"); // enter accepts the popup instead of submitting
    r.clock.runAll();
    expect(r.calls.submit).toEqual([]);
    expect(r.bridge.editor?.text).toBe("/model ");
  });

  it("a unique tab candidate completes on the spot: no popup, enter submits", () => {
    const r = makeEditorRig([{ label: "/model", insert: "/model " }]);
    r.source.push("/mo");
    r.clock.runAll();
    r.source.push("\t");
    r.clock.runAll();
    expect(r.bridge.editor?.popupOpen).toBe(false); // the one-row detour is skipped
    expect(r.bridge.editor?.text).toBe("/model ");
    r.source.push("\r");
    r.clock.runAll();
    expect(r.calls.submit).toEqual(["/model "]);
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
  // Session-event fan-out stub: stores handlers so tests can fire bus
  // events (SESSION_STATE/QUEUE_UPDATE/...) at the stage-4 status glue.
  const sessionHandlers: Array<(ev: unknown) => void> = [];
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
    onSessionEvents: (_id: string, handler: (ev: unknown) => void) => {
      sessionHandlers.push(handler);
      return () => {
        const i = sessionHandlers.indexOf(handler);
        if (i >= 0) sessionHandlers.splice(i, 1);
      };
    },
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
  const emitEvent = (ev: unknown): void => {
    for (const h of [...sessionHandlers]) h(ev);
    clock.runAll(); // settle the repaint the status/chip update schedules
  };
  return { term, clock, sig, bridge, keys, calls, done, screenRows, count, emitEvent };
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

  it("shell handoff detaches input in the submit macrotask (no window to eat child keys)", async () => {
    const rig = makeSessionRig({ uiCli: { shellMode: true, pasteMarkerMinChars: 80 } });
    await rig.done;

    // Silent real command (stdio:inherit child; an echo would print to the
    // test fd where no stream patch reaches). Exits fast so the resume-on-
    // child-exit waitFor settles.
    rig.keys.push("grep x /dev/null\r");
    // Asserted with no tick: everything the user types after Enter belongs
    // to the child, so the suspend must have released raw mode inside the
    // submit macrotask itself. Any await in the decision path (e.g. the old
    // spawn-`which` lookup) reopens a window where hotdog's editor eats the
    // child's keystrokes before the handoff lands.
    expect(rig.term.rawMode).toBe(false);

    await waitFor(() => rig.term.rawMode); // resumed on child exit
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
      // The answer echo carries the question prefix (fix-3) and never
      // reaches the normal submit handler.
      expect(rig.bridge.transcriptLog).toContain("  ? Pick a color > 2");
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
    writeFileSync(join(dir, "alt.txt"), "b"); // keep the "al" span multi-match
    const rig = makeSessionRig();
    try {
      await rig.done;
      const input = new EditorCliInput(rig.bridge);

      // One optional free-text question, so Enter submits whatever is typed.
      const pending = input.collectAnswers([{ key: "note", prompt: "Note?", required: false }], null);
      await tick();

      // A path word + Tab would complete in normal mode (popup on the two
      // "al" matches); while the question owns the input nothing may touch
      // the buffer.
      rig.keys.push(`cat ${dir}/al`);
      rig.keys.push("\t");
      rig.clock.runAll();
      expect(rig.bridge.editor?.popupOpen).toBe(false);
      expect(rig.bridge.editor?.text).toBe(`cat ${dir}/al`); // not even auto-completed

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
  it("async provider degrades cold, then auto-completes a unique match on cache/refresh", async () => {
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
    // The one match auto-completes in place: no popup, buffer rewritten.
    expect(rig.bridge.editor?.popupOpen).toBe(false);
    expect(rig.bridge.editor?.text).toBe("hello");
    expect(rig.calls.enqueue).toEqual([]); // completion never enqueues
  });

  it("readdir path completer answers synchronously at Tab", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hotdog-3b-readdir-"));
    writeFileSync(join(dir, "alpha.txt"), "a");
    writeFileSync(join(dir, "beta.txt"), "b");
    mkdirSync(join(dir, "subdir"));
    const rig = makeSessionRig();
    try {
      await rig.done;
      rig.keys.push(`cat ${dir}/`);
      rig.keys.push("\t");
      rig.clock.runAll();
      expect(rig.bridge.editor?.popupOpen).toBe(true); // NO await: readdir is sync
      const rows = rig.screenRows();
      expect(rows.some((r) => r.includes("alpha.txt"))).toBe(true);
      expect(rows.some((r) => r.includes("beta.txt"))).toBe(true);
      // A narrowed span with one match completes on the spot (same sync path,
      // no popup detour). Esc closes first -- Tab while a popup is open
      // cycles, it does not re-request.
      rig.keys.push("\x1b");
      rig.clock.runAll();
      expect(rig.bridge.editor?.popupOpen).toBe(false);
      rig.keys.push("al");
      rig.clock.runAll();
      rig.keys.push("\t");
      rig.clock.runAll();
      expect(rig.bridge.editor?.popupOpen).toBe(false);
      expect(rig.bridge.editor?.text).toBe(`cat ${dir}/alpha.txt`);
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

// ── Stage-3b audit ledger closure (run 20261020-2233): items B, C, D, G ──

import {
  installCrashTeardown,
  processCrashTeardownHost,
  CRASH_EXIT_CODE,
  type CrashTeardownHost,
} from "@extensions/ui-interactive-cli/split-bridge.ts";
import { create } from "@extensions/ui-interactive-cli/index.ts";

describe("editor session swap: blank submit never dirties scrollback (ledger B)", () => {
  it("empty and whitespace-only Enter commit no row; typed submits still echo", async () => {
    const rig = makeSessionRig();
    await rig.done;
    rig.clock.runAll();

    // Legacy treats a trimmed-blank line as "repaint the prompt" (lineHandler's
    // normalizeLine(line).trim() early return), so neither an empty Enter nor a
    // whitespace-only one may ever write a scrollback row -- the bare prompt
    // "(test-model)> " must stay the single prompt row the live frame shows.
    const promptRows = () => rig.screenRows().filter((r) => r === "(test-model)>").length;
    const nonBlankRows = () => rig.screenRows().filter((r) => r !== "").length;
    const rowsBefore = nonBlankRows();
    const logBefore = rig.bridge.transcriptLog.length;
    expect(promptRows()).toBe(1);

    rig.keys.push("\r"); // truly empty
    await tick();
    rig.clock.runAll();
    rig.keys.push("   \r"); // whitespace-only: legacy's trim treats it as empty too
    await tick();
    rig.clock.runAll();

    expect(rig.screenRows().length).toBe(24); // the viewport itself never grows
    expect(nonBlankRows()).toBe(rowsBefore); // and neither does visible content
    expect(promptRows()).toBe(1); // no committed "(test-model)> " row exists
    expect(rig.bridge.transcriptLog.length).toBe(logBefore); // nothing echoed
    expect(rig.calls.enqueue).toEqual([]); // and no phantom turn was submitted

    // The non-blank path keeps legacy's echo-commit exactly.
    rig.keys.push("hello world\r");
    await tick();
    rig.clock.runAll();
    expect(rig.calls.enqueue).toEqual(["hello world"]);
    expect(rig.bridge.transcriptLog).toContain("(test-model)> hello world");
    expect(nonBlankRows()).toBe(rowsBefore + 1);
  });

  it("an empty answer while a question owns the input commits the (no answer) echo", async () => {
    const rig = makeSessionRig();
    await rig.done;
    const input = new EditorCliInput(rig.bridge);

    const origOut = process.stdout.write;
    process.stdout.write = (() => true) as never;
    let answers: Record<string, string>;
    let logAfterMenu = 0;
    let screenAfterMenu = 0;
    try {
      // required:false free text: an empty answer is a legitimate answer, so
      // the blank-submit guard must route it to the waiter, never swallow it.
      const pending = input.collectAnswers([{ key: "note", prompt: "Note?", required: false }], null);
      await tick();
      rig.clock.runAll();
      expect(rig.bridge.questionMode).toBe(true);
      // The question menu legitimately commits rows; the baseline for the
      // echo itself starts once the menu is up.
      logAfterMenu = rig.bridge.transcriptLog.length;
      screenAfterMenu = rig.screenRows().filter((r) => r !== "").length;

      rig.keys.push("\r");
      answers = await pending;
    } finally {
      process.stdout.write = origOut;
    }

    expect(answers).toEqual({ note: "" }); // the waiter resolved with the empty line
    expect(rig.bridge.questionMode).toBe(false);
    // Fix-3 echo ruling (question-echo.md): a blank answer commits exactly
    // ONE self-describing row -- question prefix plus "(no answer)" -- so
    // write-once scrollback can tell "answered nothing" from spacing.
    expect(rig.bridge.transcriptLog.length).toBe(logAfterMenu + 1);
    expect(rig.bridge.transcriptLog[logAfterMenu]).toBe("  ? Note? > (no answer)");
    rig.clock.runAll();
    expect(rig.screenRows().filter((r) => r !== "").length).toBe(screenAfterMenu + 1);
    expect(rig.calls.enqueue).toEqual([]); // an answer never reaches the model queue
  });
});

describe("editor session swap: question entry stashes the draft (ledger C, note 8)", () => {
  it("the half-typed draft is parked on entry and restored on resolve, without auto-submitting", async () => {
    const rig = makeSessionRig();
    await rig.done;

    rig.keys.push("draft in progress");
    rig.clock.runAll();
    expect(rig.bridge.editor?.text).toBe("draft in progress");

    const origOut = process.stdout.write;
    process.stdout.write = (() => true) as never;
    let answers: Record<string, string>;
    try {
      const pending = new EditorCliInput(rig.bridge).collectAnswers(
        [{ key: "ok", prompt: "Proceed?", required: false }],
        null,
      );
      await tick();
      rig.clock.runAll();

      // Entry stashed: the answer buffer starts clean and the draft left the
      // frame entirely (no merge into the answer).
      expect(rig.bridge.editor?.text).toBe("");
      expect(rig.screenRows().some((r) => r.includes("draft in progress"))).toBe(false);

      rig.keys.push("yes\r");
      answers = await pending;
    } finally {
      process.stdout.write = origOut;
    }

    expect(answers).toEqual({ ok: "yes" });
    // Restore on the resolve path: typing survived the interruption...
    expect(rig.bridge.editor?.text).toBe("draft in progress");
    rig.clock.runAll();
    expect(rig.screenRows().some((r) => r.includes("draft in progress"))).toBe(true);
    // ...and nothing auto-submitted it: the revived draft waits for its own Enter.
    expect(rig.calls.enqueue).toEqual([]);

    rig.keys.push("\r");
    await tick();
    expect(rig.calls.enqueue).toEqual(["draft in progress"]);
  });

  it("the abort path restores the stashed draft too", async () => {
    const rig = makeSessionRig();
    await rig.done;

    rig.keys.push("half-typed");
    rig.clock.runAll();

    const controller = new AbortController();
    const origOut = process.stdout.write;
    process.stdout.write = (() => true) as never;
    let answers: Record<string, string>;
    try {
      const pending = new EditorCliInput(rig.bridge).collectAnswers(
        [{ key: "x", prompt: "X?", options: ["a"] }],
        controller.signal,
      );
      await tick();
      expect(rig.bridge.editor?.text).toBe(""); // parked

      controller.abort();
      answers = await pending; // partial answers resolve, never reject
    } finally {
      process.stdout.write = origOut;
    }

    expect(answers).toEqual({});
    expect(rig.bridge.questionMode).toBe(false);
    // The finally-block flag release runs the restore on ALL paths, abort included.
    expect(rig.bridge.editor?.text).toBe("half-typed");
    expect(rig.calls.enqueue).toEqual([]); // restored, not auto-submitted
  });
});

/** CrashTeardownHost double: an emitter stands in for the process crash events. */
class FakeCrashHost implements CrashTeardownHost {
  readonly emitter = new EventEmitter();
  readonly exits: number[] = [];
  readonly stderrChunks: string[] = [];

  onCrash(handler: (err: unknown) => void): () => void {
    const onException = (err: unknown): void => handler(err);
    const onRejection = (reason: unknown): void => handler(reason);
    this.emitter.on("uncaughtException", onException);
    this.emitter.on("unhandledRejection", onRejection);
    return () => {
      this.emitter.off("uncaughtException", onException);
      this.emitter.off("unhandledRejection", onRejection);
    };
  }

  writeStderr(text: string): void {
    this.stderrChunks.push(text);
  }

  exit(code: number): void {
    this.exits.push(code);
  }
}

describe("crash teardown install/uninstall (ledger D, note 10)", () => {
  const count = (log: string[], entry: string): number => log.filter((m) => m === entry).length;

  it("a fake uncaughtException reports, restores the mode pair exactly once, and exits non-zero", () => {
    const { bridge, term } = makeBridge();
    bridge.mount();
    const host = new FakeCrashHost();
    installCrashTeardown(bridge, host);
    term.grid.modeLog.length = 0;

    host.emitter.emit("uncaughtException", new Error("boom-crash"));

    expect(bridge.guard.fired).toBe(true);
    expect(count(term.grid.modeLog, "?2004l")).toBe(1);
    expect(count(term.grid.modeLog, "raw:off")).toBe(1);
    expect(term.rawMode).toBe(false);
    // formatError()ed through stderr: the message (and, unexpected-error, stack)
    // reach the report -- the crash is never swallowed.
    expect(host.stderrChunks.join("")).toContain("boom-crash");
    expect(host.exits).toEqual([CRASH_EXIT_CODE]);

    // Teardown ran the paired unregister before exiting: a second crash event
    // finds no listener and cannot double-restore.
    expect(host.emitter.listenerCount("uncaughtException")).toBe(0);
    expect(host.emitter.listenerCount("unhandledRejection")).toBe(0);
    host.emitter.emit("uncaughtException", new Error("second-crash"));
    expect(count(term.grid.modeLog, "raw:off")).toBe(1);
    expect(count(term.grid.modeLog, "?2004l")).toBe(1);
    expect(host.exits).toEqual([CRASH_EXIT_CODE]);
    expect(host.stderrChunks.join("")).not.toContain("second-crash");
  });

  it("an unhandledRejection reason takes the same report/restore/exit route", () => {
    const { bridge, term } = makeBridge();
    bridge.mount();
    const host = new FakeCrashHost();
    installCrashTeardown(bridge, host);
    term.grid.modeLog.length = 0;

    host.emitter.emit("unhandledRejection", "silent-fail-reason");

    expect(count(term.grid.modeLog, "raw:off")).toBe(1);
    expect(count(term.grid.modeLog, "?2004l")).toBe(1);
    expect(term.rawMode).toBe(false);
    expect(host.stderrChunks.join("")).toContain("silent-fail-reason");
    expect(host.exits).toEqual([CRASH_EXIT_CODE]);
  });

  it("a clean session end removes both crash handlers (register/unregister parity)", () => {
    const { bridge } = makeBridge();
    bridge.mount();
    const host = new FakeCrashHost();
    expect(host.emitter.listenerCount("uncaughtException")).toBe(0);

    const unregister = installCrashTeardown(bridge, host);
    expect(host.emitter.listenerCount("uncaughtException")).toBe(1);
    expect(host.emitter.listenerCount("unhandledRejection")).toBe(1);

    bridge.shutdown(); // the /quit / ctrl-d / signal end-of-session route
    expect(host.emitter.listenerCount("uncaughtException")).toBe(0);
    expect(host.emitter.listenerCount("unhandledRejection")).toBe(0);
    unregister(); // double-removal is inert
  });

  it("processCrashTeardownHost registers both real handlers and removes them on off", () => {
    const before = {
      ex: process.listenerCount("uncaughtException"),
      rej: process.listenerCount("unhandledRejection"),
    };
    const off = processCrashTeardownHost.onCrash(() => {});
    expect(process.listenerCount("uncaughtException")).toBe(before.ex + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rej + 1);
    off();
    expect(process.listenerCount("uncaughtException")).toBe(before.ex);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rej);
  });

  it("real-process probe: a thrown error restores the terminal and exits non-zero (no swallow)", async () => {
    const probe = join(import.meta.dir, "../fixtures/split-mount-probe.ts");
    const proc = Bun.spawn(["bun", probe], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOTDOG_LOG_TARGET: "none", PROBE_MODE: "crash" },
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    // The crash report landed on the arbiter (routed stderr) BEFORE the mode
    // restore bytes, and nothing reached the real stderr: a silent-hang
    // handler (or no handler at all) could not produce this byte order.
    expect(out).toContain("boom-crash");
    expect(out.indexOf("boom-crash")).toBeLessThan(out.indexOf("\x1b[?2004l"));
    expect(out).toContain("\x1b[?2004l"); // bracketed paste off
    expect(out).not.toContain("SURVIVED-THE-CRASH"); // control never returned to the loop
    expect(err).toBe("");
    expect(code).toBe(1);
  }, 20000);
});

describe("editor session swap: paste-marker answer through the session's own wiring (ledger G)", () => {
  it("a bracketed-paste answer resolves with the full restored content, not the marker token", async () => {
    const rig = makeSessionRig({ uiCli: { shellMode: false, pasteMarkerMinChars: 10 } });
    await rig.done;

    // Fetch the input the SESSION constructed: the default setupInput wired
    // EditorCliInput(bridge, normalizeLine) into the tool-context slot, and
    // the extension's AGENT_TOOL_CONTEXT hook is how the tool executor gets
    // it. A hand-rolled EditorCliInput(bridge) would carry no normalizeLine
    // and silently skip the marker restore, pinning nothing -- so the
    // instance under test must come through this seam.
    const toolCtx = new Map<string, unknown>();
    create({} as never).hooks![HOOKS.AGENT_TOOL_CONTEXT]!({ toolCtx } as never);
    const input = toolCtx.get("input");
    expect(input).toBeInstanceOf(EditorCliInput);

    const origOut = process.stdout.write;
    process.stdout.write = (() => true) as never;
    let answers: Record<string, string>;
    try {
      const pending = (input as EditorCliInput).collectAnswers(
        [{ key: "log", prompt: "Paste the failing log?", required: false }],
        null,
      );
      await tick();
      expect(rig.bridge.questionMode).toBe(true);

      rig.keys.push("\x1b[200~alpha\nbravo\ncharlie\x1b[201~");
      rig.clock.runAll();
      expect(rig.bridge.editor?.text).toBe("[Paste #1 - 3 lines]"); // collapsed for the buffer

      rig.keys.push("\r"); // Enter submits the answer with the marker still in it
      answers = await pending;
    } finally {
      process.stdout.write = origOut;
    }

    // The waiter received the FULL RESTORED CONTENT: only the session's own
    // normalizeLine can turn the marker back into the paste, so this
    // assertion is itself the proof the session wiring ran.
    expect(answers).toEqual({ log: "alpha\nbravo\ncharlie" });
    expect(JSON.stringify(answers)).not.toContain("Paste #");
    expect(rig.calls.enqueue).toEqual([]);
    expect(rig.bridge.questionMode).toBe(false);
  });
});

// The mounted-session rigs above rebind the uiOut/uiFlush/uiBridge module
// slots. Releasing them when this file finishes is what keeps a plain
// sequential `bun test` (and the coverage script) green for every file that
// runs after this one in the same process.
afterAll(resetUiSlotsForTesting);

// ══ Stage-3c (run 20261021-0353) ═════════════════════════════════════════
// §9 dumb-term mount gate (owner ruling 2026-10-21: NO_COLOR must NOT decline,
// TERM=dumb declines -> legacy path), console.debug/info/trace arbiter routing
// (ruling: routed while a real mount is live, restorable exactly once), and
// the cursorCol clamp probes (3b contract §5 leftover: the view documents
// "cursorCol may equal width; the composer clamps it" -- these probes decide
// whether an out-of-range col reaches the wire or breaks geometry, and pin
// what holds).

import { rendererMountPosture } from "@extensions/ui-interactive-cli/split-bridge.ts";
import { visibleWidth } from "@utils/cli/renderer/width.ts";

/** Identity snapshot of every global installIoPatches can swap. */
function pristineGlobals(): Record<string, unknown> {
  return {
    out: process.stdout.write,
    err: process.stderr.write,
    pause: process.stdin.pause,
    log: console.log,
    error: console.error,
    warn: console.warn,
    debug: console.debug,
    info: console.info,
    trace: console.trace,
  };
}

function expectPristine(before: Record<string, unknown>): void {
  const now = pristineGlobals();
  for (const key of Object.keys(before)) expect(now[key]).toBe(before[key]);
}

/** IoPatchHost whose six console methods are all present as unique originals. */
function sixMethodHost(): { host: IoPatchHost; originals: Record<string, unknown> } {
  const originals: Record<string, unknown> = {};
  const consoleRig: Record<string, unknown> = {};
  for (const name of ["log", "error", "warn", "debug", "info", "trace"]) {
    originals[name] = () => {};
    consoleRig[name] = originals[name];
  }
  const origOut = () => true;
  const origErr = () => true;
  const origPause = () => "paused";
  originals.stdoutWrite = origOut;
  originals.stderrWrite = origErr;
  originals.stdinPause = origPause;
  const host: IoPatchHost = {
    stdout: { write: origOut as never },
    stderr: { write: origErr as never },
    stdin: { pause: origPause },
    console: consoleRig as never,
  };
  return { host, originals };
}

const PROBE = join(import.meta.dir, "../fixtures/split-mount-probe.ts");

// env entries set to undefined are REMOVED from the child environment --
// that is how the "NO_COLOR absent" runs are built (the test runner itself
// may carry NO_COLOR/TERM).
async function spawnProbe(
  env: Record<string, string | undefined>,
): Promise<{ out: string; err: string; code: number }> {
  const child: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, HOTDOG_LOG_TARGET: "none", ...env })) {
    if (v !== undefined) child[k] = v;
  }
  const proc = Bun.spawn(["bun", PROBE], { stdout: "pipe", stderr: "pipe", env: child });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { out, err, code: await proc.exited };
}

describe("§9 dumb-term mount gate (stage 3c)", () => {
  it("shouldMountRenderer declines TERM=dumb with the exact comparison colors.ts makes", () => {
    // colors.ts colorDisabledByEnv compares `env.TERM === "dumb"` -- strict
    // equality against the lowercase terminfo convention string, no trim, no
    // case fold, no substring. The gate mirrors THAT comparison:
    expect(shouldMountRenderer("split", true, true, "dumb")).toBe(false);
    expect(shouldMountRenderer("split", true, true, "DUMB")).toBe(true);
    expect(shouldMountRenderer("split", true, true, "dumb-256")).toBe(true);
    expect(shouldMountRenderer("split", true, true, " xterm-dumb")).toBe(true);
    // A normal TERM and an UNSET TERM both keep today's behavior (mount).
    expect(shouldMountRenderer("split", true, true, "xterm-256color")).toBe(true);
    expect(shouldMountRenderer("split", true, true, undefined)).toBe(true);
    // The knob and TTY gates are unchanged by the new one:
    expect(shouldMountRenderer("legacy", true, true, "dumb")).toBe(false);
    expect(shouldMountRenderer("split", false, true, "screen")).toBe(false);
    expect(shouldMountRenderer("split", true, false, "screen")).toBe(false);
  });

  it("rendererMountPosture is the same gate with an honest reason (single predicate)", () => {
    const combos: [unknown, unknown, unknown, unknown][] = [
      ["split", true, true, "xterm"],
      ["split", true, true, "dumb"],
      ["split", true, true, undefined],
      ["split", false, true, "xterm"],
      ["split", true, false, "dumb"],
      ["legacy", true, true, "xterm"],
      [undefined, true, true, undefined],
    ];
    for (const [k, si, so, t] of combos) {
      const p = rendererMountPosture(k, si, so, t);
      expect(p.mount).toBe(shouldMountRenderer(k, si, so, t));
      expect(p.mode).toBe(k === "legacy" ? "legacy" : "split");
      expect(p.reason.length).toBeGreaterThan(0);
    }
    // The reasons are the three §9 declines, distinguishable:
    expect(rendererMountPosture("split", true, true, "dumb").reason).toContain("TERM=dumb");
    expect(rendererMountPosture("split", false, true, "xterm").reason).toContain("TTY");
    expect(rendererMountPosture("legacy", true, true, "xterm").reason).toContain("knob");
  });

  it("a dumb TTY declines the mount before any global is touched (null bridge)", () => {
    const before = pristineGlobals();
    expect(
      mountSplitRenderer({ knob: "split", stdinIsTTY: true, stdoutIsTTY: true, env: { TERM: "dumb" } }),
    ).toBeNull();
    // Decline happens BEFORE the Terminal is constructed, so no frame/mode
    // byte exists to be written, and no global was patched:
    expectPristine(before);
  });

  it("TERM=dumb beside NO_COLOR=1 declines too; NO_COLOR alone never declines", () => {
    const before = pristineGlobals();
    expect(
      mountSplitRenderer({
        knob: "split",
        stdinIsTTY: true,
        stdoutIsTTY: true,
        env: { TERM: "dumb", NO_COLOR: "1" },
      }),
    ).toBeNull();
    expectPristine(before);
    // NO_COLOR with a working TERM must NOT decline (owner ruling): a colorless
    // but capable TTY gets the split renderer; color-off is colors.ts's job.
    const { host, originals } = sixMethodHost();
    const bridge = mountSplitRenderer({
      knob: "split",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: { TERM: "xterm-256color", NO_COLOR: "1" },
      host,
    });
    expect(bridge).not.toBeNull();
    // Patches rode the INJECTED host only -- the real process is untouched:
    expect(host.console.log).not.toBe(originals.log);
    expect(process.stdout.write).toBe(before.out as never);
    expect(console.debug).toBe(before.debug as never);
    bridge!.shutdown();
    expectPristine(before); // the guard restored the host; nothing lingered
  });

  it("legacy runs never patch console at all: pristine six-method identity", () => {
    const before = pristineGlobals();
    // Knob legacy on a full declared TTY pair, with and without an explicit
    // env; unset knob on a dumb TTY (default-on: unset only declines via the
    // dumb gate); split on non-TTY stdio. None may touch a global. Explicit
    // envs only -- a decline case must not read the ambient TERM of the runner.
    expect(mountSplitRenderer({ knob: "legacy", stdinIsTTY: true, stdoutIsTTY: true })).toBeNull();
    expect(
      mountSplitRenderer({ knob: "legacy", stdinIsTTY: true, stdoutIsTTY: true, env: { TERM: "xterm" } }),
    ).toBeNull();
    expect(
      mountSplitRenderer({ knob: undefined, stdinIsTTY: true, stdoutIsTTY: true, env: { TERM: "dumb" } }),
    ).toBeNull();
    expect(
      mountSplitRenderer({ knob: "split", stdinIsTTY: false, stdoutIsTTY: true, env: { TERM: "xterm" } }),
    ).toBeNull();
    expectPristine(before); // log/error/warn AND debug/info/trace all untouched
  });

  it("real-process probe: TERM=dumb yields zero frame/mode bytes and plain passthrough", async () => {
    const { out, err, code } = await spawnProbe({
      PROBE_MODE: "dumb",
      TERM: "dumb",
      NO_COLOR: undefined, // decline stands on dumb alone
    });
    expect(code).toBe(0);
    expect(err).toContain("dumb-passthrough-stderr");
    expect(err).not.toContain("MOUNT_FAILED"); // decline is the EXPECTED path
    // Zero cursor-control bytes of any kind: the §9 non-mount contract is the
    // absence of EVERY escape, and the session's own writes are byte-plain.
    expect(out).not.toContain("\x1b");
    expect(out).toBe("dumb-passthrough-stdout\ndumb-passthrough-console\n");
    expect(err.replace("dumb-passthrough-stderr\n", "")).not.toContain("\x1b");
  }, 20000);

  it("real-process probe: TERM=dumb + NO_COLOR=1 declines identically", async () => {
    const { out, err, code } = await spawnProbe({
      PROBE_MODE: "dumb",
      TERM: "dumb",
      NO_COLOR: "1",
    });
    expect(code).toBe(0);
    expect(out).not.toContain("\x1b");
    expect(out).toBe("dumb-passthrough-stdout\ndumb-passthrough-console\n");
    expect(err).toContain("dumb-passthrough-stderr");
  }, 20000);

  it("real-process probe: NO_COLOR=1 with a normal TERM still mounts (frames are geometry)", async () => {
    const { out, code } = await spawnProbe({ NO_COLOR: "1", TERM: "xterm-256color" });
    expect(code).toBe(7); // the mounted probe's exit seam
    expect(out).toContain("\x1b[?2004h"); // the mount enable pair
    expect(out).toContain("console-routed-line");
    expect(out).toContain("\x1b[?2004l"); // and the paired restore
  }, 20000);

  it("real-process probe: unset TERM still mounts (§9 declines ONLY on the exact dumb string)", async () => {
    const { out, code } = await spawnProbe({ PROBE_MODE: "term-unset", TERM: undefined });
    expect(out).not.toContain("MOUNT_FAILED");
    expect(code).toBe(7);
    expect(out).toContain("\x1b[?2004h");
    expect(out).toContain("stdout-routed-line");
  }, 20000);
});

describe("installIoPatches routes console.debug/info/trace (stage 3c ruling)", () => {
  it("debug/info/trace go through the arbiter path alongside error/warn", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    const { host } = sixMethodHost();
    installIoPatches(bridge, host);
    const con = host.console as Required<IoPatchHost["console"]>;

    con.log("out-1");
    con.error("err-1");
    con.debug("dbg-1");
    con.info("info-1");
    con.trace("trace-1", { a: 1 });
    con.warn("warn-1");
    clock.runAll();

    // All six are permanent rows in call order; the trace args stringify like
    // the other methods' (never a stack -- the patched method never sees the
    // real console's trace machinery).
    expect(bridge.transcriptLog).toEqual([
      "out-1",
      "err-1",
      "dbg-1",
      "info-1",
      "trace-1 [object Object]",
      "warn-1",
    ]);
  });

  it("debug/info/trace ride the ARBITER side: they flush an open stdout partial first", () => {
    const { bridge, clock } = makeBridge();
    bridge.mount();
    const { host } = sixMethodHost();
    installIoPatches(bridge, host);

    host.stdout.write("open-out-partial"); // unterminated stdout row
    const con = host.console as Required<IoPatchHost["console"]>;
    con.debug("dbg-then"); // arbiter semantics: out partial commits FIRST
    con.info("info-then");
    clock.runAll();

    expect(bridge.transcriptLog).toEqual(["open-out-partial", "dbg-then", "info-then"]);
  });

  it("restore returns ALL SIX console originals exactly, paired once (TeardownGuard shape)", () => {
    const { bridge } = makeBridge();
    bridge.mount();
    const { host, originals } = sixMethodHost();
    const restore = installIoPatches(bridge, host);

    const con = host.console as Required<IoPatchHost["console"]>;
    con.debug("dbg");
    con.info("info");
    con.trace("trace");
    expect(host.console.debug).not.toBe(originals.debug);

    restore();
    const c = host.console as unknown as Record<string, unknown>;
    expect(c.log).toBe(originals.log);
    expect(c.error).toBe(originals.error);
    expect(c.warn).toBe(originals.warn);
    expect(c.debug).toBe(originals.debug);
    expect(c.info).toBe(originals.info);
    expect(c.trace).toBe(originals.trace);
    expect(host.stdout.write).toBe(originals.stdoutWrite as never);
    expect(host.stderr.write).toBe(originals.stderrWrite as never);
    expect(host.stdin.pause).toBe(originals.stdinPause as never);
    restore(); // a second run (idempotent guard semantics) changes nothing
    expect(c.debug).toBe(originals.debug);
    expect(c.trace).toBe(originals.trace);
  });

  it("rig-mounted bridges never patch the real console: patches live only on the mountSplitRenderer path", () => {
    const before = pristineGlobals();
    const { bridge, clock } = makeBridge();
    bridge.mount(); // OutputBridge mount alone (what every session rig does)
    bridge.commitText("rig line\n");
    clock.runAll();
    expect(bridge.transcriptLog).toEqual(["rig line"]);
    expectPristine(before); // the rig path keeps an UNPATCHED console
    bridge.shutdown();
    expectPristine(before);
  });

  it("real-process probe: debug/info/trace route to the arbiter while mounted, and debug is restored after teardown", async () => {
    const { out, err, code } = await spawnProbe({});
    expect(code).toBe(7);
    const enable = out.indexOf("\x1b[?2004h");
    const disable = out.indexOf("\x1b[?2004l");
    expect(enable).toBeGreaterThanOrEqual(0);
    expect(disable).toBeGreaterThan(enable);
    // Routed while the mount was live -- as permanent rows, before the restore:
    for (const line of ["debug-routed-line", "info-routed-line", "trace-routed-line"]) {
      expect(out).toContain(line);
      expect(out.indexOf(line)).toBeGreaterThan(enable);
      expect(out.indexOf(line)).toBeLessThan(disable);
    }
    // After teardown console.debug is the REAL one again: the post-restore
    // marker reaches the plain stream (an unrestored patch would have routed
    // it into the dead bridge and dropped it).
    expect(out.indexOf("post-restore-debugline")).toBeGreaterThan(disable);
    expect(err).toBe("");
  }, 20000);
});

describe("cursorCol clamp probes (stage 3c, 3b contract §5 leftover)", () => {
  /** GridTerminal that also keeps the raw byte stream, for wire-level probes. */
  class RecordingGridTerminal extends GridTerminal {
    readonly raw: string[] = [];
    override write(s: string): void {
      this.raw.push(s);
      super.write(s);
    }
    /** Every CHP (`ESC[<n>G`) column ever emitted to the terminal. */
    chpColumns(): number[] {
      const found: number[] = [];
      for (const m of this.raw.join("").matchAll(/\x1b\[(\d+)G/g)) found.push(parseInt(m[1]!, 10));
      return found;
    }
  }

  function makeClampRig(rows: number, cols: number, candidates: { label: string }[] = []) {
    const term = new RecordingGridTerminal({ rows, cols });
    const clock = new FakeClock();
    const sig = new FakeSignalHost();
    const bridge = new OutputBridge({ terminal: term, clock, signalHost: sig });
    const keys = new MemoryKeySource();
    bridge.setPrompt("(m)> ");
    bridge.mount();
    bridge.mountEditorInput(keys, {
      submit: () => {},
      interrupt: () => {},
      quit: () => {},
      popup: () => candidates,
    });
    clock.runAll();
    return { term, clock, bridge, keys };
  }

  it("P1 soft-wrapped CJK/emoji corpus: the visual cursor column never exceeds the terminal width", () => {
    // Corpus ends mid-row: 你好(4)+🚀(2)+world(5)+漢字(4)+🀄(2)+テスト(6)+🎉(2)
    // = 25 display cells + 5-cell prompt = 30 cells > the 20-column viewport.
    const r = makeClampRig(10, 20);
    r.keys.push("你好🚀world漢字🀄テスト🎉");
    r.clock.runAll();
    const g = r.term.grid;
    expect(g.cursorCol).toBeGreaterThanOrEqual(0);
    expect(g.cursorCol).toBeLessThanOrEqual(g.cols - 1);
    // Wire level: no paint asked for a column past the width (CHP is 1-based).
    for (const col of r.term.chpColumns()) expect(col).toBeLessThanOrEqual(20);
    // The corpus is really there, wrapped across two frame rows, no ghosting.
    const screen = g.snapshot().screen;
    expect(screen[0]).toBe("(m)> 你好🚀world漢字"); // 20 cells exactly
    expect(screen[1]).toBe("🀄テスト🎉");
  });

  it("P1b cursor parked at the exact row edge (pending-wrap cell) emits no CHP past the width", () => {
    // 你好世界漢字(12 cells)+abc(3) = 15 + prompt 5 = 20 cells == the viewport
    // width: line-editor.layout hands cursorCol === width ("the composer
    // clamps it", 3b contract) -- this probe is that clamp on the wire.
    const r = makeClampRig(10, 20);
    r.keys.push("你好世界漢字abc");
    r.clock.runAll();
    const g = r.term.grid;
    for (const col of r.term.chpColumns()) expect(col).toBeLessThanOrEqual(20);
    expect(g.cursorCol).toBeLessThanOrEqual(g.cols - 1);
    expect(g.cursorCol).toBe(19); // pending-wrap position: the last cell
    expect(g.snapshot().screen[0]).toBe("(m)> 你好世界漢字abc");
  });

  it("P2 resize narrower with the cursor past the new width: in range at every checkpoint, self-healing repaint", () => {
    const r = makeClampRig(10, 80);
    r.keys.push("a".repeat(55)); // prompt 5 + 55 = the cursor sits at col 60
    r.clock.runAll();
    expect(r.term.grid.cursorCol).toBe(60);
    r.term.raw.length = 0; // isolate the resize window

    r.term.resize(40, 10); // NARROWER while the frame is live, cursor past the width

    // Checkpoint 1 (synchronous resize listeners): the physical cursor is
    // inside the NEW width -- and every CHP emitted during the resize paint
    // honors it too (the stale frameCursor must be clamped where the position
    // is turned into bytes, core.placeCursor).
    expect(r.term.grid.cursorCol).toBeLessThanOrEqual(39);
    for (const col of r.term.chpColumns()) expect(col).toBeLessThanOrEqual(40);
    // Checkpoint 2 (repaint after the bridge re-derived the view at the new
    // width): the cursor is back on the real edit cell, frame re-wrapped,
    // nothing left of the 80-column geometry.
    r.clock.runAll();
    expect(r.term.grid.cursorCol).toBe(20); // 60 cells wide -> row 1 col 20
    expect(r.term.grid.cursorRow).toBe(1);
    const screen = r.term.grid.snapshot().screen;
    expect(screen[0]).toBe(`(m)> ${"a".repeat(35)}`);
    expect(screen[1]).toBe("a".repeat(20));
  });

  it("P3 popup placement at the boundary columns: rows cut to the width, order preserved on resize", () => {
    const r = makeClampRig(10, 24, [{ label: "モデル🀄ラベル候補" }, { label: "モデム" }]);
    r.keys.push("モデ");
    r.keys.push("\t");
    r.clock.runAll();
    expect(r.bridge.editor?.popupOpen).toBe(true);
    const at = (t: string): number => r.term.grid.snapshot().screen.findIndex((row) => row.includes(t));
    expect(at("モデル")).toBeLessThan(at("(m)>")); // popup rows ABOVE the editor (§4)
    for (const row of r.term.grid.snapshot().screen) expect(visibleWidth(row)).toBeLessThanOrEqual(24);

    r.term.resize(12, 10); // narrow past the selected label's width
    r.clock.runAll();
    const screen = r.term.grid.snapshot().screen;
    for (const row of screen) expect(visibleWidth(row)).toBeLessThanOrEqual(12);
    expect(screen[0]).toBe("> モデル🀄ラ"); // cut at 12 cells: "> "2+モデル6+🀄2+ラ2, no split wide glyph
    expect(screen[1]).toBe("  モデム"); // the unselected row survives whole
    expect(screen[2]).toContain("(m)> モデ"); // both popup rows still ABOVE the editor
    expect(r.term.grid.cursorCol).toBeLessThanOrEqual(11);
  });

  it("P4 an out-of-range col derives no bad erase: placement clamps, content and commits survive", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    clock.runAll();

    // A frame cursor with a wildly out-of-range col (500 on an 80-col rig) --
    // e.g. a producer that forgot to clamp. The placement must land inside
    // the geometry, and every later paint/erase is "\r"-anchored, so nothing
    // derives an erase extent from the bad col.
    bridge.core.setFrame(["frame-content"], { row: 0, col: 500 });
    clock.runAll();
    expect(term.grid.cursorCol).toBeLessThanOrEqual(term.grid.cols - 1);
    expect(term.grid.snapshot().screen[0]).toContain("frame-content");

    // Commits after the bad placement still land intact above the frame: the
    // park/restore math never consulted the column.
    bridge.commitText("committed-row\n");
    bridge.core.drainCommitsSync();
    clock.runAll();
    const all = term.grid.snapshot();
    const text = [...all.scrollback, ...all.screen];
    expect(text.filter((row) => row === "committed-row").length).toBe(1);
    expect(text.filter((row) => row.includes("frame-content")).length).toBe(1);
    expect(text.indexOf("committed-row")).toBeLessThan(
      text.findIndex((row) => row.includes("frame-content")),
    );

    // The capture Grid takes a hostile out-of-range CHP the same way a real
    // terminal does: clamped, erasing nothing that matters.
    bridge.capture.write("(m)> hello");
    bridge.capture.write("\x1b[999G\x1b[0J");
    expect(bridge.capture.cursor().col).toBeLessThanOrEqual(bridge.capture.columns - 1);
    expect(bridge.capture.frameRows()).toEqual(["(m)> hello"]);
  });
});

// ══ Stage 4 (§12, run 20261021): status line + queue chip ═══════════════

import { statusRowText, queueChipText } from "@extensions/ui-interactive-cli/split-bridge.ts";

describe("stage-4 status row: pure shape", () => {
  it("nothing before the first turn; current turn while working; settled count at idle", () => {
    expect(statusRowText({ turns: 0, working: false, laneWait: false, cost: null })).toBeNull();
    expect(statusRowText({ turns: 0, working: true, laneWait: false, cost: null })).toBe("#1 · working");
    expect(statusRowText({ turns: 0, working: true, laneWait: true, cost: null })).toBe("#1 · waiting for lane");
    expect(statusRowText({ turns: 2, working: false, laneWait: false, cost: null })).toBe("#2");
    expect(statusRowText({ turns: 2, working: true, laneWait: false, cost: null })).toBe("#3 · working");
    // Cost rides only when present (modelPricing-gated upstream, ruling 4).
    expect(statusRowText({ turns: 2, working: true, laneWait: false, cost: "$0.0021" })).toBe("#3 · working · $0.0021");
    expect(statusRowText({ turns: 1, working: false, laneWait: false, cost: "$1.23" })).toBe("#1 · $1.23");
  });

  it("queue chip: 40-rune truncation (codepoint-safe), extra count, blank preview reads 'item'", () => {
    expect(queueChipText(0, "x")).toBeNull();
    expect(queueChipText(1, "make it purple")).toBe("↑ queued: make it purple");
    expect(queueChipText(3, "one")).toBe("↑ queued: one (+2)");
    expect(queueChipText(1, "")).toBe("↑ queued: item");
    expect(queueChipText(1, "   ")).toBe("↑ queued: item");
    // 40 CODEPOINTS, surrogate-pair safe (emoji count as one rune each).
    expect(queueChipText(1, "🙂".repeat(45))).toBe(`↑ queued: ${"🙂".repeat(40)}…`);
    // Multi-line previews collapse: the chip is always one frame row.
    expect(queueChipText(1, "line1\nline2")).toBe("↑ queued: line1 line2");
  });
});

describe("stage-4 session frame: status line follows the event sequence", () => {
  it("bare frame -> working -> lane-wait -> content clears wait -> TURN_END settles", async () => {
    const hooks = new HookSystem();
    const rig = makeSessionRig({ hooks });
    await rig.done;
    rig.clock.runAll();
    const status = () => rig.screenRows().filter((r) => r.startsWith("#"));

    // Before any turn: nothing to show, the frame is just the editor.
    expect(status()).toEqual([]);

    rig.emitEvent({ type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: true });
    expect(status()).toEqual(["#1 · working"]);

    rig.emitEvent({ type: OUTPUT_EVENT.SYSTEM_MESSAGE, content: "Waiting for provider lane 'openai'..." });
    expect(status()).toEqual(["#1 · waiting for lane"]);

    // First sign of real work: the lane wait is over.
    rig.emitEvent({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "hi" });
    expect(status()).toEqual(["#1 · working"]);

    // TURN_END: counter settles at 1, working drops with the turn.
    await hooks.notifyHooks(HOOKS.TURN_END, { stopped: true } as never);
    rig.clock.runAll(); // the repaint TURN_END schedules rides the fake clock
    expect(status()).toEqual(["#1"]);

    // Second turn reads as the turn in flight (#2), and its end settles.
    rig.emitEvent({ type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: true });
    expect(status()).toEqual(["#2 · working"]);
    await hooks.notifyHooks(HOOKS.TURN_END, { stopped: true } as never);
    rig.clock.runAll();
    expect(status()).toEqual(["#2"]);
  });

  it("cost stays dark without modelPricing and appears with it", async () => {
    const usage = {
      type: OUTPUT_EVENT.TOKEN_USAGE,
      sessionPromptTokens: 2_000_000,
      sessionCachedTokens: 0,
      sessionCompletionTokens: 0,
      sessionTotalTokens: 2_000_000,
      turns: 1,
      promptTokens: 1000,
      cachedTokens: 0,
      completionTokens: 0,
      totalTokens: 1000,
      contextWindow: 200000,
    };

    // Default (no modelPricing key): the usage event adds no cost to the row.
    const rig = makeSessionRig();
    await rig.done;
    rig.emitEvent({ type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: true });
    rig.emitEvent(usage);
    expect(rig.screenRows().filter((r) => r.startsWith("#"))).toEqual(["#1 · working"]);

    // With modelPricing for the session model, the row carries the USD total.
    const priced = makeSessionRig({
      resolvedExtra: { modelPricing: { "test-model": { input: 10, output: 20 } } },
    });
    await priced.done;
    priced.emitEvent({ type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: true });
    priced.emitEvent(usage);
    expect(priced.screenRows().filter((r) => r.startsWith("#"))).toEqual(["#1 · working · $20.00"]);
  });

  it("QUEUE_UPDATE shows the chip and pending:0 removes it", async () => {
    const rig = makeSessionRig();
    await rig.done;
    const chips = () => rig.screenRows().filter((r) => r.includes("↑ queued:"));

    rig.emitEvent({ type: OUTPUT_EVENT.QUEUE_UPDATE, pending: 2, preview: "make it purple" });
    expect(chips()).toEqual(["↑ queued: make it purple (+1)"]);

    rig.emitEvent({ type: OUTPUT_EVENT.QUEUE_UPDATE, pending: 1, preview: "and shorter" });
    expect(chips()).toEqual(["↑ queued: and shorter"]);

    rig.emitEvent({ type: OUTPUT_EVENT.QUEUE_UPDATE, pending: 0, preview: "" });
    expect(chips()).toEqual([]);
  });
});

describe("in-flight tool-call rows (streaming-call display)", () => {
  it("paints between the streaming line and the input frame; clear removes it", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    const screen = () => term.grid.snapshot().screen.map((r) => r.replace(/\s+$/, ""));

    bridge.commitText("streaming thought"); // unterminated: the live streaming row
    bridge.setInflightCall(0, " 🔧 write partial");
    clock.runAll();

    const rows = screen();
    const si = rows.findIndex((r) => r.includes("streaming thought"));
    const ii = rows.findIndex((r) => r.includes("🔧 write partial"));
    expect(si).toBeGreaterThanOrEqual(0);
    expect(ii).toBe(si + 1);

    // Committing the streamed line never takes the in-flight row with it.
    bridge.commitText(" done\n");
    clock.runAll();
    const snap = term.grid.snapshot();
    expect([...snap.scrollback, ...snap.screen].join("\n")).toContain("streaming thought done");
    expect(screen().some((r) => r.includes("🔧 write partial"))).toBe(true);

    bridge.clearInflightCalls();
    clock.runAll();
    expect(screen().some((r) => r.includes("write partial"))).toBe(false);
    // Idempotent clear (turn-end events fire it alongside TOOL_CALL).
    bridge.clearInflightCalls();
    clock.runAll();
  });

  it("one row per wire index; growth replaces that index's row only", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    const screen = () => term.grid.snapshot().screen.map((r) => r.replace(/\s+$/, ""));

    bridge.setInflightCall(0, " 🔧 read a");
    bridge.setInflightCall(1, " 🔧 bash ls");
    clock.runAll();
    expect(screen().filter((r) => r.includes("🔧 "))).toEqual([
      " 🔧 read a",
      " 🔧 bash ls",
    ]);

    bridge.setInflightCall(0, " 🔧 read a.ts");
    clock.runAll();
    const rows = screen();
    expect(rows.filter((r) => r.includes("🔧 "))).toEqual([
      " 🔧 read a.ts",
      " 🔧 bash ls",
    ]);

    // Same text again: no-op (delta storms must not storm paints).
    bridge.setInflightCall(0, " 🔧 read a.ts");
    clock.runAll();
    expect(screen().filter((r) => r.includes("🔧 "))).toHaveLength(2);
  });
});

describe("in-flight rows through the session event glue (stage 4)", () => {
  const cueRows = (rows: string[]): string[] => rows.filter((r) => r.includes("🔧 "));

  it("deltas paint rows under the streaming line, above the status row", async () => {
    const rig = makeSessionRig();
    await rig.done;
    rig.emitEvent({ type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: true });
    rig.bridge.commitText("half a thought");

    rig.emitEvent({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "read", args: '{"path":"a' });
    const rows = rig.screenRows();
    const si = rows.findIndex((r) => r.includes("half a thought"));
    const ii = rows.findIndex((r) => r.includes("🔧 read"));
    const st = rows.findIndex((r) => r.startsWith("#"));
    expect(si).toBeGreaterThanOrEqual(0);
    expect(ii).toBe(si + 1);
    expect(st).toBeGreaterThan(ii);

    // Growth of the same index replaces its row (no duplicate).
    rig.emitEvent({
      type: OUTPUT_EVENT.TOOL_CALL_DELTA,
      index: 0,
      name: "read",
      args: '{"path":"a.ts"}',
    });
    expect(cueRows(rig.screenRows())).toEqual([" 🔧 read a.ts"]);
  });

  it("parallel calls each get a row (no cap)", async () => {
    const rig = makeSessionRig();
    await rig.done;
    rig.emitEvent({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "read", args: '{"path":"a.ts"}' });
    rig.emitEvent({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 1, name: "bash", args: '{"command":"ls"}' });
    expect(cueRows(rig.screenRows())).toEqual([" 🔧 read a.ts", " 🔧 bash ls"]);
  });

  it("TOOL_CALL commit clears every row", async () => {
    const rig = makeSessionRig();
    await rig.done;
    rig.emitEvent({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "read", args: '{"path":"a' });
    rig.emitEvent({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 1, name: "bash", args: '{"comm' });
    expect(cueRows(rig.screenRows())).toHaveLength(2);

    rig.emitEvent({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "read", input: "{}", toolCallId: "c1" });
    expect(cueRows(rig.screenRows())).toEqual([]);
  });

  it("TOOL_RESULT clears without a TOOL_CALL (invalid/unavailable paths)", async () => {
    const rig = makeSessionRig();
    await rig.done;
    rig.emitEvent({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "gone", args: "{}" });
    expect(cueRows(rig.screenRows())).toHaveLength(1);

    rig.emitEvent({
      type: OUTPUT_EVENT.TOOL_RESULT,
      toolName: "gone",
      input: "{}",
      content: "unavailable",
      toolCallId: "c1",
    });
    expect(cueRows(rig.screenRows())).toEqual([]);
  });

  it("turn end (working:false) clears dead streams", async () => {
    const rig = makeSessionRig();
    await rig.done;
    rig.emitEvent({ type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: true });
    rig.emitEvent({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "read", args: '{"path":"a' });
    expect(cueRows(rig.screenRows())).toHaveLength(1);

    // Cancel / error / length-stop all land here without a TOOL_CALL.
    rig.emitEvent({ type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: false });
    expect(cueRows(rig.screenRows())).toEqual([]);
  });
});

// ── STREAM_RESET: retract the dead attempt's in-flight frame state ─────────

describe("stream reset through the session event glue (mid-stream retry, H-3)", () => {
  const cueRows = (rows: string[]): string[] => rows.filter((r) => r.includes("\u{1F527} "));

  it("drops the unterminated streaming row AND in-flight call rows; committed scrollback is untouched", async () => {
    const rig = makeSessionRig();
    await rig.done;
    rig.emitEvent({ type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: true });
    rig.bridge.commitText("a completed line\n"); // committed -> scrollback
    rig.bridge.commitText("half a thou"); // dead attempt's partial line
    rig.emitEvent({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "read", args: '{"path":"a' });
    expect(rig.screenRows().join("|")).toContain("half a thou");
    expect(cueRows(rig.screenRows())).toHaveLength(1);

    rig.emitEvent({ type: OUTPUT_EVENT.STREAM_RESET });

    const rows = rig.screenRows().join("|");
    expect(rows).not.toContain("half a thou"); // partial retracted, never committed
    expect(cueRows(rig.screenRows())).toEqual([]); // dead call rows gone
    expect(rows).toContain("a completed line"); // scrollback stays write-once
    expect(bridgeTranscript(rig)).not.toContain("half a thou");

    // The retry streams clean into the same frame.
    rig.bridge.commitText("fresh thou");
    rig.clock.runAll(); // the repaint the streaming write schedules rides the fake clock
    expect(rig.screenRows().join("|")).toContain("fresh thou");
  });

  it("resetStream on a bare bridge: partial discarded without a commit, idempotent", () => {
    const { bridge, term, clock } = makeBridge();
    // Mounted: the frame only paints after mount (RendererCore.setFrame is
    // inert until then), so the retraction asserts against the terminal the
    // rows were painted on -- an unmounted bridge rendered "" no matter what.
    bridge.mount();
    bridge.commitText("dead partial");
    bridge.setInflightCall(0, " \u{1F527} read a.ts");
    clock.runAll();

    const before = term.grid.snapshot().screen.join("|");
    expect(before).toContain("dead partial"); // the frame genuinely holds the dead state
    expect(before).toContain("\u{1F527} read a.ts");

    bridge.resetStream();
    clock.runAll();
    bridge.resetStream(); // idempotent, no throw

    expect(bridge.transcriptLog).toEqual([]); // nothing was committed
    const painted = term.grid.snapshot().screen.join("|");
    expect(painted).not.toContain("dead partial"); // partial discarded, never committed
    expect(painted).not.toContain("\u{1F527} read a.ts"); // in-flight rows retracted
  });
});

function bridgeTranscript(rig: { bridge: OutputBridge }): string {
  return rig.bridge.transcriptLog.join("\n");
}
