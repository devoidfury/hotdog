// Markdown prose highlighting on the split surface: the sink passes Default-mode
// prose raw (and reports mode edges), the bridge paints committed prose rows
// with the markdown tokenizer while every other row stays byte-identical, row
// provenance survives mode changes that strand a line mid-stream, and stream
// resets restart the fence document. Rig follows the split-renderer tests:
// in-memory Grid + FakeClock, no PTY, no mock.module.

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { OutputBridge } from "@extensions/ui-interactive-cli/split-bridge.ts";
import { CliOutputSink, Modes } from "@utils/cli/cli.ts";
import { ColorPalette, applyMarkdown } from "@utils/cli/colors.ts";
import { tokenizeMarkdownLine, tokenizeMarkdownLive, newMdStreamState } from "@utils/syntax/markdown.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import { GridTerminal, FakeClock } from "@utils/cli/renderer/index.ts";
import type { SignalHost } from "@utils/cli/renderer/index.ts";
import type { ArgDisplay } from "@core/extensions/tool-registry.ts";

const palette = new ColorPalette(); // dark theme, colors on
const BASH_HINTS: Record<string, ArgDisplay> = { command: { preview: "first-line", syntax: "shell" } };

function makeBridge(): { bridge: OutputBridge; term: GridTerminal; clock: FakeClock } {
  const term = new GridTerminal({ rows: 24, cols: 80 });
  const clock = new FakeClock();
  const sig: SignalHost = { on: () => () => {}, exit: () => {} };
  return { bridge: new OutputBridge({ terminal: term, clock, signalHost: sig }), term, clock };
}

/** Whole-line paint reference for the same line/state the bridge must produce. */
const paint = (line: string): string =>
  applyMarkdown(tokenizeMarkdownLine(line, newMdStreamState()), palette);

describe("bridge prose commits", () => {
  it("paints prose rows and leaves non-prose rows byte-identical", () => {
    const { bridge } = makeBridge();
    bridge.enableProseMarkdown(palette);
    bridge.setProseMode(true);
    bridge.commitText("# Title\nbody **x**\n");
    expect(bridge.transcriptLog.slice(0, 2)).toEqual([paint("# Title"), paint("body **x**")]);
    bridge.setProseMode(false);
    bridge.commitText("a plain row\n");
    expect(bridge.transcriptLog.at(-1)).toBe("a plain row");
    // Colors present on the prose rows only.
    expect(bridge.transcriptLog[0]).toContain("\x1b[");
    expect(bridge.transcriptLog.at(-1)).not.toContain("\x1b[");
  });

  it("converges: a line streamed in pieces commits the whole-line paint once", () => {
    const { bridge } = makeBridge();
    bridge.enableProseMarkdown(palette);
    bridge.setProseMode(true);
    bridge.commitText("**bo");
    expect(bridge.transcriptLog.length).toBe(0); // nothing terminated yet
    bridge.commitText("ld**\n");
    expect(bridge.transcriptLog).toEqual([paint("**bold**")]);
    // The committed bytes are one clean strong wrap, not two stitched pieces.
    expect(bridge.transcriptLog[0]).toBe("\x1b[1;31m**bold**\x1b[0m");
  });

  it("row provenance survives a mode change that strands the prose line", () => {
    const { bridge } = makeBridge();
    bridge.enableProseMarkdown(palette);
    bridge.setProseMode(true);
    bridge.commitText("prose tail"); // unterminated when the mode flips
    bridge.setProseMode(false);
    bridge.commitText("\n🔧 tool row\n"); // the separator terminates the prose row
    expect(bridge.transcriptLog[0]).toBe(paint("prose tail"));
    expect(bridge.transcriptLog[1]).toBe("🔧 tool row");
    expect(bridge.transcriptLog[0]).toContain("\x1b[");
    expect(bridge.transcriptLog[1]).not.toContain("\x1b[");
  });

  it("fences advance only at commits; shell fences reuse the shell classes", () => {
    const { bridge } = makeBridge();
    bridge.enableProseMarkdown(palette);
    bridge.setProseMode(true);
    bridge.commitText("```sh\n");
    bridge.commitText("ls -la | cat\n");
    bridge.commitText("```\n");
    const [open, code, close] = bridge.transcriptLog;
    expect(open).toBe("\x1b[90m```sh\x1b[0m"); // md_fence
    expect(code).toContain("\x1b[36mls\x1b[0m"); // shell_command
    expect(code).toContain("\x1b[90m|\x1b[0m"); // shell_operator
    expect(close).toBe("\x1b[90m```\x1b[0m");
    // After the close, block markdown resumes.
    bridge.commitText("# back\n");
    expect(bridge.transcriptLog.at(-1)).toBe("\x1b[38;5;208m# back\x1b[0m");
  });

  it("resetStream restarts the fence document (a dead attempt's open fence is gone)", () => {
    const { bridge } = makeBridge();
    bridge.enableProseMarkdown(palette);
    bridge.setProseMode(true);
    bridge.commitText("```\nopen fence tail");
    bridge.resetStream();
    // The retry's heading must read as a heading, not as fence content.
    bridge.commitText("# H\n");
    expect(bridge.transcriptLog.at(-1)).toBe("\x1b[38;5;208m# H\x1b[0m");
  });

  it("live repaint is deterministic and agrees byte-for-byte with the commit", () => {
    const { bridge, term, clock } = makeBridge();
    bridge.mount();
    bridge.enableProseMarkdown(palette);
    bridge.setProseMode(true);
    const screen = () => term.grid.snapshot().screen.map((r) => r.replace(/\s+$/, "")).join("\n");

    bridge.commitText("a **bo");
    clock.runAll();
    const first = screen();
    expect(first).toContain("a **bo");
    // Same partial, another repaint cycle: identical rows (the live pass is
    // pure, so nothing churns without new input -- no #lastStreamKey flap).
    clock.runAll();
    expect(screen()).toBe(first);

    // Byte-level commit-vs-inflight agreement: the live classification of the
    // closed line paints exactly what the commit paints (the live pass and a
    // fresh committed pass over the same state produce identical runs).
    const s = newMdStreamState();
    expect(applyMarkdown(tokenizeMarkdownLive("a **bold**", s), palette)).toBe(paint("a **bold**"));

    bridge.commitText("ld**\n");
    clock.runAll();
    expect(bridge.transcriptLog).toEqual([paint("a **bold**")]);
  });

  it("without enableProseMarkdown the path is byte-identical to before", () => {
    const { bridge } = makeBridge();
    bridge.commitText("# Title\n**x**\n");
    expect(bridge.transcriptLog).toEqual(["# Title", "**x**"]);
  });
});

describe("sink markdown seam", () => {
  it("Default-mode prose rides raw and mode edges are reported", () => {
    const modes: string[] = [];
    const sink = new CliOutputSink({
      palette: new ColorPalette({ use_colors: true }),
      markdownHighlight: true,
      onOutputMode: (m: string) => modes.push(m),
      argDisplay: () => BASH_HINTS,
    });
    const writes: string[] = [];
    spyOn(process.stdout, "write").mockImplementation((s: string) => {
      writes.push(s);
      return true;
    });
    sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "# head **bold**" });
    expect(writes.join("")).toBe("# head **bold**"); // no final_response wash
    expect(modes).toEqual([Modes.Default]);

    // Tool rows keep their existing colored pipeline.
    sink.emit({
      type: OUTPUT_EVENT.TOOL_CALL,
      toolName: "bash",
      input: '{"command":"ls -la"}',
      toolCallId: "c1",
    });
    expect(writes.slice(1).join("")).toContain("\x1b[");
    expect(modes.at(-1)).toBe(Modes.ToolCall);
  });

  it("Default-mode prose is spoof-neutralized at the flush seam, benign text untouched", () => {
    const sink = new CliOutputSink({
      palette: new ColorPalette({ use_colors: true }),
      markdownHighlight: true,
    });
    const writes: string[] = [];
    spyOn(process.stdout, "write").mockImplementation((s: string) => {
      writes.push(s);
      return true;
    });
    sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "a\u202eb \x1b[31mx \u200bc" });
    const out = writes.join("");
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\u202e");
    expect(out).not.toContain("\u200b");
    expect(out).toContain("[U+202E]");
    expect(out).toContain("[U+001B]");
    expect(out).toContain("[U+200B]");
    // Benign prose still rides byte-identical (idempotent pass-through).
    sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "plain prose" });
    expect(writes.at(-1)).toBe("plain prose");
  });

  it("thinking keeps its wash while markdown is on", () => {
    const sink = new CliOutputSink({
      palette: new ColorPalette({ use_colors: true }),
      markdownHighlight: true,
    });
    const errs: string[] = [];
    spyOn(process.stderr, "write").mockImplementation((s: string) => {
      errs.push(s);
      return true;
    });
    sink.emit({ type: OUTPUT_EVENT.THINKING, content: "ponder" });
    expect(errs.join("")).toContain("\x1b[36m"); // thinking cyan, untouched
  });

  afterEach(() => {
    (process.stdout.write as { mockRestore?: () => void }).mockRestore?.();
    (process.stderr.write as { mockRestore?: () => void }).mockRestore?.();
  });
});
