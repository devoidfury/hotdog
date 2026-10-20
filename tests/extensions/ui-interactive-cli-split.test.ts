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
