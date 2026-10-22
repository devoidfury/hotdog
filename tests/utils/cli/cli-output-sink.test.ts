import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  CliOutputSink,
  inflightCallText,
} from "@utils/cli/cli.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import { ColorPalette } from "@utils/cli/colors.ts";

describe("CliOutputSink", () => {
  let sink: CliOutputSink;
  let stdoutWrites: string[] = [];
  let stderrWrites: string[] = [];

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    spyOn(process.stdout, "write").mockImplementation((s: string) => {
      stdoutWrites.push(s);
      return true;
    });
    spyOn(process.stderr, "write").mockImplementation((s: string) => {
      stderrWrites.push(s);
      return true;
    });
    sink = new CliOutputSink({
      palette: new ColorPalette({ use_colors: false }),
      showTokenUse: true,
      toolCallDisplayFormat: "  → {} {}",
      toolOutputFmt: "----\n{}\n----",
    });
  });

  afterEach(() => {
    (process.stdout.write as any).mockRestore();
    (process.stderr.write as any).mockRestore();
  });

  it("emitUserMessage writes to stdout", () => {
    sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE, content: "hello" });
    expect(stdoutWrites.some((w) => w.includes("hello"))).toBe(true);
  });

  it("emitUserMessage is suppressed when hideUserMessage is true", () => {
    sink.hideUserMessage = true;
    sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE, content: "hello" });
    expect(stdoutWrites).toHaveLength(0);
  });

  it("emitAssistantMessage writes to stdout", () => {
    sink.emit({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "answer" });
    expect(stdoutWrites.some((w) => w.includes("answer"))).toBe(true);
  });

  it("emitThinking writes to stderr", () => {
    sink.emit({ type: OUTPUT_EVENT.THINKING, content: "thinking..." });
    expect(stderrWrites.some((w) => w.includes("thinking"))).toBe(true);
  });

  it("emitThinking is suppressed when hideThinking is true", () => {
    sink.hideThinking = true;
    sink.emit({ type: OUTPUT_EVENT.THINKING, content: "thinking..." });
    expect(stderrWrites).toHaveLength(0);
  });

  it("emitToolCall writes to stdout", () => {
    sink.emit({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: '{"cmd":"ls"}', toolCallId: "1" });
    expect(stdoutWrites.some((w) => w.includes("bash"))).toBe(true);
  });

  describe("emitToolCall display precedence", () => {
    it("uses the event display when no template is configured", () => {
      const plain = new CliOutputSink({ palette: new ColorPalette({ use_colors: false }) });
      plain.emit({
        type: OUTPUT_EVENT.TOOL_CALL,
        toolName: "read",
        input: '{"path":"src/a.ts","offset":200,"limit":202}',
        toolCallId: "1",
        display: "src/a.ts (lines 200-402)",
      });
      const written = stdoutWrites.join("");
      // Arrow cue retained even without a template.
      expect(written).toContain("→ src/a.ts (lines 200-402)");
      // Raw args JSON never reaches the header when display is present.
      expect(written).not.toContain('"path"');
    });

    it("explicit toolCallDisplayFormat wins over display", () => {
      sink.emit({
        type: OUTPUT_EVENT.TOOL_CALL,
        toolName: "bash",
        input: '{"command":"ls"}',
        toolCallId: "1",
        display: "bash: ls",
      });
      const written = stdoutWrites.join("");
      expect(written).toContain("→ bash");
      // Template wins the layout; the args slot carries the human summary,
      // never raw JSON, and the tool's display header is not consulted.
      expect(written).toContain("bash ls");
      expect(written).not.toContain('"command"');
      expect(written).not.toContain("bash: ls");
    });

    it("falls back to the default template when display is absent", () => {
      const plain = new CliOutputSink({ palette: new ColorPalette({ use_colors: false }) });
      plain.emit({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: '{"command":"ls"}', toolCallId: "1" });
      expect(stdoutWrites.join("")).toContain("→ bash ls");
    });

    it("colors the args segment grey and re-opens the tool color after it", () => {
      const bright = new CliOutputSink({
        palette: new ColorPalette({ use_colors: true, tool_call: "yellow" }),
        toolCallDisplayFormat: " 🔧 {} {}",
      });
      bright.emit({
        type: OUTPUT_EVENT.TOOL_CALL,
        toolName: "bash",
        input: '{"command":"ls"}',
        toolCallId: "1",
      });
      const written = stdoutWrites.join("");
      // Whole line rides the tool_call yellow; args print in the terminal
      // default (the yellow re-opens after the segment so template postfixes
      // stay yellow). bash args are a shell command, so the command word
      // lights red inside the default text.
      expect(written).toContain(
        "\x1b[33m 🔧 bash \x1b[0m\x1b[31mls\x1b[0m\x1b[33m\x1b[0m",
      );
    });

    it("shell-highlights bash args: commands red, operators default, quotes untouched", () => {
      const bright = new CliOutputSink({
        palette: new ColorPalette({ use_colors: true, tool_call: "yellow" }),
        toolCallDisplayFormat: " 🔧 {} {}",
      });
      bright.emit({
        type: OUTPUT_EVENT.TOOL_CALL,
        toolName: "bash",
        input: JSON.stringify({ command: 'cd /tmp && grep -rn "a|b" src | head -3' }),
        toolCallId: "1",
      });
      expect(stdoutWrites.join("")).toContain(
        "\x1b[33m 🔧 bash \x1b[0m" +
          '\x1b[31mcd\x1b[0m /tmp \x1b[35m&&\x1b[0m \x1b[31mgrep\x1b[0m -rn "a|b" src \x1b[35m|\x1b[0m \x1b[31mhead\x1b[0m -3' +
          "\x1b[33m\x1b[0m",
      );
    });

    it("multi-key bash: cyan key labels coexist with the shell-lit command value", () => {
      const bright = new CliOutputSink({
        palette: new ColorPalette({ use_colors: true, tool_call: "yellow" }),
        toolCallDisplayFormat: " 🔧 {} {}",
      });
      bright.emit({
        type: OUTPUT_EVENT.TOOL_CALL,
        toolName: "bash",
        input: JSON.stringify({ command: "ls -l && echo hi", timeoutMs: 5000 }),
        toolCallId: "1",
      });
      const written = stdoutWrites.join("");
      // Regression (owner screenshot 2026-10-22): the shell pass used to run
      // over the assembled summary, lighting `command:` red as a command
      // word and leaving the real command plain. Labels read cyan like every
      // other tool's; only the value carries shell color.
      expect(written).toContain(
        "\x1b[33m 🔧 bash \x1b[0m" +
          "\x1b[36mcommand:\x1b[0m \x1b[31mls\x1b[0m -l \x1b[35m&&\x1b[0m \x1b[31mecho\x1b[0m hi · \x1b[36mtimeoutMs:\x1b[0m 5000" +
          "\x1b[33m\x1b[0m",
      );
      expect(written).not.toContain("\x1b[31mcommand");
      expect(written).not.toContain("\x1b[31mtimeoutMs");
    });

    it("multi-line bash command: the collapse stub rides plain, not shell-lit", () => {
      const bright = new CliOutputSink({
        palette: new ColorPalette({ use_colors: true, tool_call: "yellow" }),
        toolCallDisplayFormat: " 🔧 {} {}",
      });
      bright.emit({
        type: OUTPUT_EVENT.TOOL_CALL,
        toolName: "bash",
        input: JSON.stringify({ command: "a\nb\nc", timeoutMs: 5000 }),
        toolCallId: "1",
      });
      const written = stdoutWrites.join("");
      expect(written).toContain(
        "\x1b[33m 🔧 bash \x1b[0m\x1b[36mcommand:\x1b[0m 3 lines, 5 chars · \x1b[36mtimeoutMs:\x1b[0m 5000\x1b[33m\x1b[0m",
      );
      // `5` at command position would have been a red shell word.
      expect(written).not.toContain("\x1b[31m");
    });

    it("unparseable bash args pass through plain (raw JSON chrome is not shell)", () => {
      const bright = new CliOutputSink({
        palette: new ColorPalette({ use_colors: true, tool_call: "yellow" }),
        toolCallDisplayFormat: " 🔧 {} {}",
      });
      bright.emit({
        type: OUTPUT_EVENT.TOOL_CALL,
        toolName: "bash",
        input: '{"command":"ls',
        toolCallId: "1",
      });
      const written = stdoutWrites.join("");
      expect(written).toContain('\x1b[33m 🔧 bash \x1b[0m{"command":"ls\x1b[33m\x1b[0m');
      expect(written).not.toContain("\x1b[31m");
    });

    it("non-bash args light key labels cyan inside the grey segment", () => {
      const bright = new CliOutputSink({
        palette: new ColorPalette({ use_colors: true, tool_call: "yellow" }),
        toolCallDisplayFormat: " 🔧 {} {}",
      });
      bright.emit({
        type: OUTPUT_EVENT.TOOL_CALL,
        toolName: "read",
        input: '{"path":"a.ts","limit":10}',
        toolCallId: "1",
      });
      const written = stdoutWrites.join("");
      expect(written).toContain(
        "\x1b[33m 🔧 read \x1b[0m\x1b[36mpath:\x1b[0m a.ts · \x1b[36mlimit:\x1b[0m 10\x1b[33m\x1b[0m",
      );
      // Shell highlighting stays bash-only.
      expect(written).not.toContain("\x1b[31m");
    });

    it("display is never run through a template (brace-safe)", () => {
      const plain = new CliOutputSink({ palette: new ColorPalette({ use_colors: false }) });
      plain.emit({
        type: OUTPUT_EVENT.TOOL_CALL,
        toolName: "edit",
        input: "{}",
        toolCallId: "1",
        display: "a.ts: '{}' → '{}'",
      });
      expect(stdoutWrites.join("")).toContain("a.ts: '{}' → '{}'");
    });
  });

  it("emitToolResult writes to stdout", () => {
    sink.emit({ type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", input: "{}", content: "output", toolCallId: "1" });
    expect(stdoutWrites.some((w) => w.includes("output"))).toBe(true);
  });

  it("emitToolResult renders a stored tool-result part for the terminal", () => {
    // The event carries the PART; the sink decides the presentation.
    sink.emit({
      type: OUTPUT_EVENT.TOOL_RESULT,
      toolName: "bash",
      input: "{}",
      content: [
        {
          type: "tool-result",
          tool: "bash",
          status: "failure",
          meta: [],
          error: "boom",
          hint: "check the path",
          output: "partial output",
        },
      ],
      toolCallId: "1",
    });
    const written = stdoutWrites.join("");
    expect(written).toContain("partial output");
    expect(written).toContain("Error: boom");
    expect(written).toContain("HINT: check the path");
    // No model-facing markup leaks into the terminal.
    expect(written).not.toContain("<");
  });

  it("emitToolResult is suppressed when hideTools is true", () => {
    sink.hideTools = true;
    sink.emit({ type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", input: "{}", content: "output", toolCallId: "1" });
    expect(stdoutWrites).toHaveLength(0);
  });

  it("emitCompacting writes to stderr", () => {
    sink.emit({ type: OUTPUT_EVENT.COMPACTING, message: "Compacting messages" });
    expect(stderrWrites.some((w) => w.includes("Compacting"))).toBe(true);
  });

  it("emitCommandResult writes to stderr", () => {
    sink.emit({ type: OUTPUT_EVENT.COMMAND_RESULT, content: "command done" });
    expect(stderrWrites.some((w) => w.includes("command done"))).toBe(true);
  });

  it("emitQuestion writes questions to stdout", () => {
    sink.emit({
      type: OUTPUT_EVENT.QUESTION,
      questions: [{ prompt: "What is your name?", key: "name" }],
    });
    expect(stdoutWrites.some((w) => w.includes("What is your name?"))).toBe(true);
  });

  it("emitQuestion with options writes option list", () => {
    sink.emit({
      type: OUTPUT_EVENT.QUESTION,
      questions: [{
        prompt: "Choose",
        key: "choice",
        options: ["a", "b"],
        allowOther: true,
      }],
    });
    const allOutput = stdoutWrites.join("");
    expect(allOutput).toContain("[1] a");
    expect(allOutput).toContain("[2] b");
    expect(allOutput).toContain("[Other]");
  });

  it("emitQuestion without allowOther shows strict options", () => {
    sink.emit({
      type: OUTPUT_EVENT.QUESTION,
      questions: [{
        prompt: "Choose",
        key: "choice",
        options: ["a", "b"],
        allowOther: false,
      }],
    });
    const allOutput = stdoutWrites.join("");
    expect(allOutput).toContain("Choose a number");
  });

  it("emitQuestion with default value shows default", () => {
    sink.emit({
      type: OUTPUT_EVENT.QUESTION,
      questions: [{
        prompt: "Name?",
        key: "name",
        default: "Alice",
      }],
    });
    const allOutput = stdoutWrites.join("");
    expect(allOutput).toContain("default: Alice");
  });

  it("emitStreamingChunk writes to stdout", () => {
    sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "chunk" });
    expect(stdoutWrites.some((w) => w.includes("chunk"))).toBe(true);
  });

  it("emitStreamingReasoningChunk writes to stderr", () => {
    sink.emit({ type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "reasoning" });
    expect(stderrWrites.some((w) => w.includes("reasoning"))).toBe(true);
  });

  it("emitStreamingReasoningChunk suppressed when hideThinking true", () => {
    sink.hideThinking = true;
    sink.emit({ type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "reasoning" });
    expect(stderrWrites).toHaveLength(0);
  });

  it("emitTaskProgress writes progress to stderr", () => {
    sink.emit({ type: OUTPUT_EVENT.TASK_PROGRESS, taskId: "task-1", status: "running", message: "2/5 tasks" });
    expect(stderrWrites.some((w) => w.includes("task"))).toBe(true);
  });

  it("emitTaskProgress suppressed when no active tasks", () => {
    sink.emit({ type: OUTPUT_EVENT.TASK_PROGRESS, taskId: "task-1", status: "done", message: "completed" });
    expect(stdoutWrites).toHaveLength(0);
  });

  it("emitTokenUsage writes to stderr", () => {
    sink.emit({
      type: OUTPUT_EVENT.TOKEN_USAGE,
      sessionPromptTokens: 100,
      sessionCachedTokens: 50,
      sessionCompletionTokens: 200,
      sessionTotalTokens: 350,
      turns: 1,
      promptTokens: 100,
      cachedTokens: 50,
      completionTokens: 200,
      totalTokens: 350,
      contextWindow: 128000,
    });
    expect(stderrWrites.some((w) => w.includes("Token usage"))).toBe(true);
  });

  it("emitSessionState updates hideTools", () => {
    expect(sink.hideTools).toBeUndefined();
    sink.emit({ type: OUTPUT_EVENT.SESSION_STATE, key: "hideTools", value: true });
    expect(sink.hideTools).toBe(true);
  });

  it("emitSessionState updates hideThinking", () => {
    expect(sink.hideThinking).toBeUndefined();
    sink.emit({ type: OUTPUT_EVENT.SESSION_STATE, key: "hideThinking", value: true });
    expect(sink.hideThinking).toBe(true);
  });

  it("emitUserMessage renders content but never attachment file bodies", () => {
    sink.emit({
      type: OUTPUT_EVENT.USER_MESSAGE,
      content: "look at this",
      files: [{ path: "src/a.ts", content: "SECRET-FILE-CONTENT\nline two" }],
    });
    const out = stdoutWrites.join("") + stderrWrites.join("");
    expect(out).toContain("look at this");
    expect(out).not.toContain("SECRET-FILE-CONTENT");
  });

  it("reset writes reset code to stdout", () => {
    sink.reset();
    expect(stdoutWrites.some((w) => w.includes("\x1b[0m"))).toBe(true);
  });

  it("setPalette updates the palette", () => {
    const palette = new ColorPalette({ thinking: "red", use_colors: false });
    sink.setPalette(palette);
    expect(sink.palette).toBe(palette);
  });

  it("static resolve returns palette", async () => {
    const palette = await CliOutputSink.resolve(false, null, null);
    expect(palette.use_colors).toBe(false);
  });

  it("static resolve honors NO_COLOR and TERM=dumb", async () => {
    const savedNoColor = process.env.NO_COLOR;
    const savedTerm = process.env.TERM;
    try {
      delete process.env.NO_COLOR;
      process.env.TERM = "xterm-256color";
      expect((await CliOutputSink.resolve(true, null, null)).use_colors).toBe(true);

      process.env.NO_COLOR = "1";
      expect((await CliOutputSink.resolve(true, null, null)).use_colors).toBe(false);

      delete process.env.NO_COLOR;
      process.env.TERM = "dumb";
      expect((await CliOutputSink.resolve(true, null, null)).use_colors).toBe(false);
    } finally {
      if (savedNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = savedNoColor;
      if (savedTerm === undefined) delete process.env.TERM;
      else process.env.TERM = savedTerm;
    }
  });
});

describe("CliOutputSink spoof neutralization (SPF-1)", () => {
  let sink: CliOutputSink;
  let stdoutWrites: string[];

  beforeEach(() => {
    stdoutWrites = [];
    spyOn(process.stdout, "write").mockImplementation((s: string) => {
      stdoutWrites.push(s);
      return true;
    });
    sink = new CliOutputSink({
      palette: new ColorPalette({ use_colors: false }),
      toolCallDisplayFormat: "  -> {} {}",
    });
  });

  afterEach(() => {
    (process.stdout.write as any).mockRestore();
  });

  it("emitToolCall renders bidi/zero-width/ANSI in the input as visible tokens", () => {
    sink.emit({
      type: OUTPUT_EVENT.TOOL_CALL,
      toolName: "bash",
      input: '{"command":"rm -rf /\u200b* \u202e"}',
      toolCallId: "1",
    });
    const out = stdoutWrites.join("");
    expect(out).toContain("[U+200B]");
    expect(out).toContain("[U+202E]");
    expect(out).not.toContain("\u200b");
    expect(out).not.toContain("\u202e");
  });

  it("emitQuestion neutralizes model-supplied prompt, options and default", () => {
    sink.emit({
      type: OUTPUT_EVENT.QUESTION,
      questions: [
        {
          key: "k",
          prompt: "ok\u202e?",
          options: ["a\u001b[31mb"],
          default: "c\ufeffd",
        },
      ],
    });
    const out = stdoutWrites.join("");
    expect(out).toContain("[U+202E]");
    expect(out).toContain("[U+001B]");
    expect(out).toContain("[U+FEFF]");
    expect(out).not.toContain("\u202e");
  });
});

describe("inflightCallText (in-flight frame row)", () => {
  const plain = new ColorPalette({ use_colors: false });
  const bright = new ColorPalette({ use_colors: true, tool_call: "yellow" });

  it("complete args take the committed line's summarizer shape (single key bares)", () => {
    expect(inflightCallText("read", '{"path":"a.ts"}', plain)).toBe("  \u2192 read a.ts");
  });

  it("multi-key non-bash summarizes k: v", () => {
    expect(inflightCallText("read", '{"path":"a.ts","offset":1}', plain)).toBe(
      "  \u2192 read path: a.ts · offset: 1",
    );
  });

  it("multi-key bash: cyan labels plus shell-lit command (same seams as the committed line)", () => {
    expect(inflightCallText("bash", '{"command":"ls -l","timeoutMs":5000}', bright)).toBe(
      "\x1b[33m  \u2192 bash \x1b[0m\x1b[36mcommand:\x1b[0m \x1b[31mls\x1b[0m -l · \x1b[36mtimeoutMs:\x1b[0m 5000\x1b[33m\x1b[0m",
    );
  });

  it("partial (unparseable) args fold to one line: newlines collapse to spaces", () => {
    expect(inflightCallText("write", '{"path":"src/a.ts","content":"a\nb', plain)).toBe(
      '  \u2192 write {"path":"src/a.ts","content":"a b',
    );
  });

  it("the raw preview is rune-capped with an ellipsis", () => {
    const out = inflightCallText("write", '{"a":"' + "x".repeat(200), plain);
    const preview = out.slice("  \u2192 write ".length);
    expect(preview).toHaveLength(81); // 80 runes + ellipsis
    expect(preview).toBe('{"a":"' + "x".repeat(74) + "\u2026");
  });

  it("empty args render the name alone (no trailing space)", () => {
    expect(inflightCallText("now", "", plain)).toBe("  \u2192 now");
  });

  it("spoof lands before any ANSI: ESC-laden name/args never emit raw escapes", () => {
    const out = inflightCallText("ba\x1b[31msh", 'a\x1b]0;pwn', plain);
    expect(out).not.toContain("\x1b");
    expect(out).toContain("[U+001B]");
  });

  it("colors follow the palette only: use_colors false emits zero escapes", () => {
    const out = inflightCallText("bash", '{"command":"ls && echo hi"}', plain);
    expect(out).toBe("  \u2192 bash ls && echo hi");
    expect(out).not.toContain("\x1b");
  });

  it("base sink ignores TOOL_CALL_DELTA (frame-only event, byte identity)", () => {
    const writes: string[] = [];
    const out = spyOn(process.stdout, "write").mockImplementation((s: string) => {
      writes.push(s);
      return true;
    });
    const err = spyOn(process.stderr, "write").mockImplementation((s: string) => {
      writes.push(s);
      return true;
    });
    try {
      const sink2 = new CliOutputSink({ palette: new ColorPalette({ use_colors: false }) });
      sink2.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: '{"command":"ls' });
      sink2.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: '{"command":"ls"}' });
      expect(writes.join("")).toBe("");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
