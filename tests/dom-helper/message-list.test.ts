/// <reference lib="dom.iterable" />
// Tests for webui/ui/message-list.ts against the minimal DOM from
// tests/dom-helper (installed as a preload via bunfig.toml).
// Spreading querySelectorAll()/children results needs dom.iterable.

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { createMessageList, type MessageListManager } from "@extensions/webui/ui/message-list.ts";

let container: HTMLElement;
let ml: MessageListManager;

function setup(opts?: Parameters<typeof createMessageList>[1]): void {
  container = document.createElement("div");
  // Fixed viewport so scrollBottom() math is deterministic.
  (container as unknown as { clientHeight: number }).clientHeight = 500;
  ml = createMessageList(container, opts);
}

beforeEach(() => setup());

function texts(sel: string): string[] {
  return [...container.querySelectorAll(sel)].map((e) => e.textContent ?? "");
}

/** The generic result box collapses to a summary line; auto-expand (owner
 *  ruling 2026-11-05) already opens short bodies, so only click when the
 *  body is not in the DOM yet. */
function openResult(block: Element): void {
  const summary = block.querySelector(".tool-result-box .tool-box-summary");
  if (summary && !block.querySelector(".tool-result-pre")) (summary as HTMLElement).click();
}

describe("user / assistant messages", () => {
  it("renders a user bubble with escaped-by-textContent content", () => {
    ml.handleUserMessage({ content: "hi <script>alert(1)</script>" });
    const el = container.querySelector(".message.user")!;
    expect(el.querySelector(".content")!.textContent).toContain("<script>");
    expect(container.innerHTML).not.toContain("<script>alert");
  });

  it("renders user-message attachments as collapsible boxes inline, content escaped", () => {
    ml.handleUserMessage({
      content: "look at this",
      files: [
        { path: "evil.txt", content: "<script>alert(1)</script>" },
        { path: "ok.md", content: "# heading" },
      ],
    });
    const bubble = container.querySelector(".message.user .bubble")!;
    expect(bubble.querySelector(".content")!.textContent).toBe("look at this");
    const boxes = bubble.querySelectorAll(".attachment-box");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.tagName.toLowerCase()).toBe("details");
    expect(boxes[0]!.querySelector("summary")!.textContent).toBe("evil.txt");
    expect(boxes[0]!.querySelector(".attachment-content")!.textContent).toContain("<script>alert(1)</script>");
    // Escaped, never injected, and never shown as a JSON object in chat.
    expect(container.innerHTML).not.toContain("<script>alert");
    expect(container.innerHTML).not.toContain('{"path"');
  });

  it("renders assistant markdown", () => {
    ml.handleAssistantMessage({ content: "# Title\n\nSome **bold** text" });
    const el = container.querySelector(".message.assistant .content")!;
    expect(el.querySelector("h1")!.textContent).toBe("Title");
    expect(el.querySelector("strong")!.textContent).toBe("bold");
  });

  it("skips empty assistant messages", () => {
    ml.handleAssistantMessage({ content: "   " });
    expect(container.children).toHaveLength(0);
  });

  it("a user message finalizes an in-flight streaming assistant element", () => {
    ml.handleStreamingChunk({ content: "partial" });
    ml.handleUserMessage({ content: "next turn" });
    // Stale streaming element closed and kept (it has content).
    const assistants = container.querySelectorAll(".message.assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.classList.contains("streaming")).toBe(false);
  });
});

describe("streaming markdown", () => {
  it("builds blocks incrementally and indexes them", () => {
    ml.handleStreamingChunk({ content: "Hello " });
    ml.handleStreamingChunk({ content: "world\n\n## Head" });
    const content = container.querySelector(".message.assistant .content")!;
    expect(content.textContent).toContain("Hello world");
    expect(content.querySelector("h2")!.textContent).toBe("Head");
    const blocks = [...content.children];
    expect(blocks.map((b) => b.getAttribute("data-block-index"))).toEqual(["0", "1"]);
  });

  it("leaves the stable prefix DOM untouched across chunks", () => {
    ml.handleStreamingChunk({ content: "first paragraph\n\n" });
    const first = container.querySelector("[data-block-index='0']")!;
    ml.handleStreamingChunk({ content: "second paragraph" });
    // Same node object survived the second feed.
    expect(container.querySelector("[data-block-index='0']")).toBe(first);
  });

  it("re-renders when an unclosed block shrinks (code fence closes)", () => {
    ml.handleStreamingChunk({ content: "para\n\n```js\nconst a=1;" });
    const before = container.querySelectorAll("[data-block-index]").length;
    ml.handleStreamingChunk({ content: "\n```\n" });
    const after = [...container.querySelectorAll("[data-block-index]")];
    expect(before).toBeGreaterThanOrEqual(1);
    // Final tree: paragraph + code block, indices contiguous from 0.
    expect(after.map((b) => b.getAttribute("data-block-index"))).toEqual(["0", "1"]);
    expect(container.querySelector("pre code")!.textContent).toContain("const a=1;");
  });

  it("streams reasoning into a thinking block", () => {
    ml.handleStreamingReasoningChunk({ content: "think*ing*" });
    const think = container.querySelector(".thinking-block")!;
    expect(think.textContent).toContain("thinking");
  });

  it("drops empty assistant and thinking elements on finalize", () => {
    ml.handleStreamingChunk({ content: "" });
    ml.finalizeAssistant();
    expect(container.children).toHaveLength(0);
  });

  it("finalize drops a whitespace-only thinking element but keeps one with content", () => {
    ml.handleStreamingReasoningChunk({ content: "   " });
    ml.finalizeAssistant();
    expect(container.querySelectorAll(".thinking-block")).toHaveLength(0);

    ml.handleStreamingReasoningChunk({ content: "kept" });
    ml.finalizeAssistant();
    expect(container.querySelectorAll(".thinking-block")).toHaveLength(1);
  });

  it("tool calls then a new chunk start a fresh assistant element", () => {
    ml.handleStreamingChunk({ content: "before" });
    ml.handleToolCall({ name: "bash", args: "{}" });
    ml.handleStreamingChunk({ content: "after" });
    const assistants = container.querySelectorAll(".message.assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]!.textContent).toContain("before");
    expect(assistants[1]!.textContent).toContain("after");
  });
});

describe("stream reset (mid-stream provider-failure retry)", () => {
  it("drops the in-flight assistant AND thinking accumulators; the retry renders alone, fragment-free", () => {
    ml.handleStreamingReasoningChunk({ content: "DEAD-THINK" });
    ml.handleStreamingChunk({ content: "DEAD" });
    // Sanity: the dead attempt is live on screen before the reset.
    expect(container.textContent).toContain("DEAD");

    ml.handleStreamReset();

    expect(container.textContent).not.toContain("DEAD");
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(0);
    expect(container.querySelectorAll(".thinking-block")).toHaveLength(0);

    ml.handleStreamingChunk({ content: "clean " });
    ml.handleStreamingChunk({ content: "answer" });
    ml.handleStreamingReasoningChunk({ content: "live think" });
    expect(container.querySelector(".message.assistant .content")!.textContent).toContain("clean answer");
    expect(container.querySelector(".thinking-block")!.textContent).toContain("live think");
    // Nothing dead leaks into what the browser finally shows.
    expect(container.textContent).not.toContain("DEAD");
  });

  it("unlike finalizeAssistant, dead content is removed, never kept as a message", () => {
    ml.handleStreamingChunk({ content: "DEAD" });
    ml.handleStreamReset();
    // finalizeAssistant would KEEP a content-bearing element; a reset must
    // not leave a committed message behind.
    expect(container.children).toHaveLength(0);
  });

  it("committed messages survive a reset; only in-flight state is dropped", () => {
    ml.handleAssistantMessage({ content: "earlier turn" });
    ml.handleStreamingChunk({ content: "DEAD" });
    ml.handleStreamReset();
    const assistants = container.querySelectorAll(".message.assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.textContent).toContain("earlier turn");
    expect(container.textContent).not.toContain("DEAD");
  });

  it("post-reset chunks keep flowing through the sanitizer path (escaped, no raw markup)", () => {
    ml.handleStreamingChunk({ content: "DEAD" });
    ml.handleStreamReset();
    // Same ingestion as before the reset: markdown parser + escaped render.
    ml.handleStreamingChunk({ content: "<script>alert(1)</script>" });
    expect(container.innerHTML).not.toContain("<script>alert");
    expect(container.querySelector(".message.assistant .content")!.textContent).toContain("<script>alert(1)</script>");
  });

  it("reset with nothing in flight is a no-op", () => {
    expect(() => ml.handleStreamReset()).not.toThrow();
    expect(container.children).toHaveLength(0);
  });

  it("retracts the in-flight attempt only; committed rows stay (write-once)", () => {
    // A committed row (text finalized by a tool call, which really ran) is
    // history and survives -- mid-stream failures never emit TOOL_CALL, so
    // the dead attempt's rows are always still in flight. Only in-flight
    // state is retracted here, mirroring the TUI scrollback ceiling.
    ml.handleStreamingChunk({ content: "kept" });
    ml.handleToolCall({ name: "bash", args: "{}" });
    ml.handleStreamingChunk({ content: "DEAD" });
    ml.handleStreamReset();
    expect(container.textContent).toContain("kept");
    expect(container.textContent).not.toContain("DEAD");

    // And the retry renders into one fresh assistant element.
    ml.handleStreamingChunk({ content: "retry" });
    const assistants = container.querySelectorAll(".message.assistant");
    expect(assistants).toHaveLength(2); // kept history + the live retry
    expect(assistants[1]!.textContent).toContain("retry");
  });
});

describe("thinking", () => {
  it("renders markdown thinking blocks", () => {
    ml.handleThinking({ content: "reasoning **hard**" });
    expect(container.querySelector(".thinking-block strong")!.textContent).toBe("hard");
  });

  it("hideThinking session state toggles the hidden class", () => {
    ml.handleThinking({ content: "secret" });
    ml.handleSessionState({ key: "hideThinking", value: true });
    expect(container.querySelector(".thinking-block")!.classList.contains("hidden")).toBe(true);
    ml.handleSessionState({ key: "hideThinking", value: false });
    expect(container.querySelector(".thinking-block")!.classList.contains("hidden")).toBe(false);
  });

  it("honors hideThinking option for new blocks", () => {
    setup({ hideThinking: true });
    ml.handleStreamingReasoningChunk({ content: "sneaky" });
    expect(container.querySelector(".thinking-block")!.classList.contains("hidden")).toBe(true);
  });

  it("setHideThinking sweeps committed blocks too, not just the in-flight row", () => {
    // Two finalized blocks (a thinking row is committed by the assistant
    // message that follows it) plus one still streaming.
    ml.handleThinking({ content: "one" });
    ml.handleAssistantMessage({ content: "a" });
    ml.handleThinking({ content: "two" });
    ml.handleAssistantMessage({ content: "b" });
    ml.handleStreamingReasoningChunk({ content: "live" });
    const hidden = () =>
      [...container.querySelectorAll(".thinking-block")].map((b) => b.classList.contains("hidden"));
    expect(hidden()).toEqual([false, false, false]);

    ml.setHideThinking(true);
    expect(hidden()).toEqual([true, true, true]);
    ml.setHideThinking(false);
    expect(hidden()).toEqual([false, false, false]);

    // Late arrivals keep honoring the creation-time value (ensureThinkingEl).
    ml.setHideThinking(true);
    ml.handleAssistantMessage({ content: "c" });
    ml.handleThinking({ content: "three" });
    expect(hidden()).toEqual([true, true, true, true]);
  });
});

describe("tool calls and results", () => {
  it("renders a static tool header and attaches matching results", () => {
    ml.handleToolCall({ name: "read", args: '{"path":"a.ts"}', toolCallId: "t1" });
    const block = container.querySelector(".tool-call-block")!;
    expect(block.querySelector(".tool-call-name")!.textContent).toContain("read");
    expect(block.querySelector(".tool-call-display")!.textContent).toBe("a.ts");
    // The header is static: no args box exists below it.
    expect(block.querySelector(".tool-call-body")).toBeNull();

    ml.handleToolResult({ name: "read", output: "x".repeat(2500), toolCallId: "t1" });
    // The result rides a collapsed generic box: open it for the preview.
    openResult(block);
    const pre = block.querySelector(".tool-result-pre")!;
    expect(pre.textContent).toContain("500 more chars");

    // "show full result" swaps in the full output.
    block.querySelector<HTMLElement>(".tool-result-box .tool-raw-toggle")!.click();
    expect(block.querySelector(".tool-result-pre")!.textContent).toHaveLength(2500);
  });


  it("falls back to a compact summary when no argsSummary is sent", () => {
    ml.handleToolCall({ name: "weird", args: '{"alpha":"beta","gamma":{"deep":1}}' });
    const header = container.querySelector(".tool-call-header")!;
    expect(header.querySelector(".tool-call-display")!.textContent).toBe("beta");
    // The header is a summary, not the raw JSON line.
    expect(header.textContent).not.toContain('{"alpha"');
  });

  it("pairs results by tool-call id, not name", () => {
    ml.handleToolCall({ name: "bash", args: '{"command":"ls"}', toolCallId: "a" });
    ml.handleToolCall({ name: "bash", args: '{"command":"pwd"}', toolCallId: "b" });
    // Results arrive newest-first: name-based pairing would hit the wrong call.
    ml.handleToolResult({ name: "bash", output: "RESULT-B", toolCallId: "b" });
    const blocks = container.querySelectorAll(".tool-call-block");
    expect(blocks[0]!.querySelector(".tool-result-box")).toBeNull();
    openResult(blocks[1]!);
    expect(blocks[1]!.querySelector(".tool-result-pre")!.textContent).toBe("RESULT-B");
    ml.handleToolResult({ name: "bash", output: "RESULT-A", toolCallId: "a" });
    openResult(blocks[0]!);
    expect(blocks[0]!.querySelector(".tool-result-pre")!.textContent).toBe("RESULT-A");
  });

  it("falls back to oldest-unresolved same-name pairing without ids", () => {
    ml.handleToolCall({ name: "bash", args: '{"command":"ls"}' });
    ml.handleToolCall({ name: "bash", args: '{"command":"pwd"}' });
    ml.handleToolResult({ name: "bash", output: "FIRST" });
    const blocks = container.querySelectorAll(".tool-call-block");
    openResult(blocks[0]!);
    expect(blocks[0]!.querySelector(".tool-result-pre")!.textContent).toBe("FIRST");
    expect(blocks[1]!.querySelector(".tool-result-box")).toBeNull();
  });

  it("renders error results and ignores results with no matching call", () => {
    ml.handleToolResult({ name: "ghost", output: "nope" });
    expect(container.children).toHaveLength(0);
    ml.handleToolCall({ name: "bash", args: "ls" });
    ml.handleToolResult({ name: "bash", error: "boom" });
    const block = container.querySelector(".tool-call-block")!;
    expect(block.className).toContain("status-error");
    // Error posture: the box is open by default, tinted, naming the error.
    const box = block.querySelector(".tool-result-box")!;
    expect(box.className).toContain("tool-result-error");
    expect(box.textContent).toContain("error — boom");
    expect(box.querySelector(".tool-result-pre")!.textContent).toContain("Error: boom");
  });

  it("renders spec-declared diff parts inline once the result lands", () => {
    // Spec-keyed, never name-keyed: the diff comes from the frame's display
    // array (ToolDisplayWire), and pending calls render nothing inline yet.
    ml.handleToolCall({
      name: "edit",
      display: [{ kind: "diff", oldArg: "oldString", newArg: "newString" }],
      args: JSON.stringify({ path: "a.ts", oldString: "one\ntwo\nthree", newString: "one\nTWO\nthree" }),
    });
    const block = container.querySelector(".tool-call-block")!;
    expect(block.querySelector(".tool-diff")).toBeNull();
    ml.handleToolResult({ name: "edit", output: "ok", toolCallId: undefined });
    // No expand click needed: the diff is the primary inline content.
    expect(block.querySelector(".diff-del")!.textContent).toContain("two");
    expect(block.querySelector(".diff-add")!.textContent).toContain("TWO");
    const rows = block.querySelectorAll(".diff-row");
    expect(rows[0]!.classList.contains("diff-ctx")).toBe(true);
    expect(rows[rows.length - 1]!.classList.contains("diff-ctx")).toBe(true);
    // The diff consumed the result: no generic box alongside it.
    expect(block.querySelector(".tool-result-box")).toBeNull();
  });

  it("threads frame display parts into the block (file summary)", () => {
    ml.handleToolCall({
      name: "read",
      display: [{ kind: "file", pathArg: "path" }],
      args: JSON.stringify({ path: "/a/b/c.txt" }),
    });
    ml.handleToolResult({ name: "read", output: "L1\nL2" });
    const block = container.querySelector(".tool-call-block")!;
    // The declared-path file part renders the GitHub header row: the verbatim
    // path (muted dir + primary basename) with the size meta on the right.
    const head = block.querySelector(".tool-file .part-head")!;
    expect(head.querySelector(".part-path-dir")!.textContent).toBe("/a/b/");
    expect(head.querySelector(".part-path-base")!.textContent).toBe("c.txt");
    expect(head.querySelector(".part-meta")!.textContent).toBe("2 lines · 5 chars");
    // No display on the frame -> generic posture only, no file box.
    ml.handleToolCall({ name: "read", args: JSON.stringify({ path: "/a/b/d.txt" }) });
    ml.handleToolResult({ name: "read", output: "L1\nL2" });
    const plain = container.querySelectorAll(".tool-call-block")[1]!;
    expect(plain.querySelector(".tool-file")).toBeNull();
    openResult(plain);
    expect(plain.querySelector(".tool-result-pre")!.textContent).toBe("L1\nL2");
  });

  it("sanitizes tool names in headers", () => {
    ml.handleToolCall({ name: "<img src=x>", args: "" });
    expect(container.innerHTML).not.toContain("<img src=x>");
    expect(container.querySelector(".tool-call-header")!.textContent).toContain("<img src=x>");
  });
});

describe("misc message kinds", () => {
  it("compacting, command result, token usage (silent), compaction result, system", () => {
    ml.handleCompacting({ message: "summarizing" });
    expect(texts(".message.compacting .bubble")[0]).toContain("summarizing");
    ml.handleCommandResult({ content: "ok: 3 files" });
    expect(container.querySelector(".message.command-result .content")!.textContent).toBe("ok: 3 files");
    // The legacy token-usage bubble is retired: the frame adds NOTHING to
    // the transcript (its numbers fold into the next footer's ctx segment).
    ml.handleTokenUsage({ promptTokens: 10, cachedTokens: 2, completionTokens: 5, totalTokens: 15, ctxUsed: 15 });
    expect(container.querySelector(".token-usage")).toBeNull();
    expect(container.querySelectorAll(".message")).toHaveLength(2);
    ml.handleCompactionResult({ summary: "s", messagesCompacted: 4 });
    expect(texts(".compaction-result .bubble")[0]).toContain("Compacted 4 messages");
    ml.addSystemMessage("coder");
    expect(container.querySelector(".system-message")!.textContent).toContain("coder");
  });

  it("plain system messages render as a paragraph, never an attachment box", () => {
    ml.handleSystemMessage({ content: "a quiet notice" });
    expect(container.querySelector(".system-message p")!.textContent).toBe("a quiet notice");
    expect(container.querySelector(".attachment-box")).toBeNull();
  });

  it("errors finalize streaming and render an error bubble", () => {
    ml.handleStreamingChunk({ content: "half a" });
    ml.handleError({ message: "kaboom" });
    expect(texts(".message.error .content")[0]).toBe("Error: kaboom");
    expect(container.querySelector(".message.assistant.streaming")).toBeNull();
  });

  it("task progress updates in place per task id", () => {
    ml.handleTaskProgress({ taskId: "t1", status: "running" });
    ml.handleTaskProgress({ taskId: "t1", status: "done", message: "all good" });
    ml.handleTaskProgress({ taskId: "t2", status: "running" });
    const t1 = container.querySelectorAll('[data-task-id="t1"]');
    expect(t1).toHaveLength(1);
    expect(t1[0]!.textContent).toContain("done: all good");
  });
});

describe("questions", () => {
  it("renders a read-only card without an answer callback", () => {
    ml.handleQuestion({ questions: [{ prompt: "Pick", options: ["a", "b"] }] });
    const content = container.querySelector(".message.question .content")!;
    expect(content.textContent).toContain("Pick");
    expect(content.querySelector("button")).toBeNull();
  });

  it("renders an interactive card, validates required answers, and submits", () => {
    const submitted: Record<string, string>[] = [];
    setup({ onQuestionAnswer: (a) => submitted.push(a) });
    ml.handleQuestion({
      questions: [
        { key: "color", prompt: "Color?", options: ["red", "blue"], default: "blue" },
        { key: "name", prompt: "Name?", required: true, options: [] },
      ],
    });
    const card = container.querySelector(".question-card")!;
    const submit = card.querySelector(".q-submit") as HTMLElement;

    // Missing required answer -> error shown, nothing submitted.
    submit.click();
    expect(submitted).toHaveLength(0);
    const errors = [...card.querySelectorAll(".q-error")].map((e) => e.textContent ?? "");
    expect(errors.join("|")).toContain("required");

    // Option click + free text fills the form.
    (card.querySelectorAll(".q-option")[0] as HTMLElement).click();
    const inputs = card.querySelectorAll("input.q-text");
    (inputs[1] as HTMLInputElement).value = "Zed";
    (inputs[1] as HTMLInputElement).dispatchEvent(new Event("input"));
    submit.click();
    expect(submitted).toEqual([{ color: "red", name: "Zed" }]);

    // Card is locked after submit.
    expect(card.classList.contains("answered")).toBe(true);
    expect((card.querySelector(".q-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(card.querySelector(".q-answers")!.textContent).toContain("color: red");
  });

  it("option selection pre-selects the default and clears on typing", () => {
    setup({ onQuestionAnswer: () => {} });
    ml.handleQuestion({ questions: [{ key: "k", prompt: "p", options: ["x", "y"], default: "y" }] });
    const card = container.querySelector(".question-card")!;
    const opts = card.querySelectorAll(".q-option");
    expect(opts[1]!.classList.contains("selected")).toBe(true);
    const input = card.querySelector("input.q-text") as HTMLInputElement;
    input.value = "custom";
    input.dispatchEvent(new Event("input"));
    expect(opts[1]!.classList.contains("selected")).toBe(false);
  });

  it("questionAnswered locks pending cards (multi-tab sync)", () => {
    setup({ onQuestionAnswer: () => {} });
    ml.handleQuestion({ questions: [{ key: "k", prompt: "p", options: [] }] });
    const card = container.querySelector(".question-card")!;
    ml.handleQuestionAnswered({ answers: { k: "remote" } });
    expect(card.classList.contains("answered")).toBe(true);
    expect(card.querySelector(".q-answers")!.textContent).toContain("k: remote");
  });
});

describe("session log replay", () => {
  it("maps log entry sources onto the renderers", () => {
    ml.renderLogEntries([
      { source: "input", content: "hello" },
      { source: "prompt", content: "sys prompt" },
      {
        source: "llm",
        content: "answer",
        reasoning_content: "because",
        tool_calls: [
          { id: "1", name: "grep", arguments: '{"q":"x"}' },
          { id: "2", name: "bash", args: { cmd: "ls" } },
        ] as unknown as Array<{ id: string; name: string; args: Record<string, unknown> }>,
      },
      { source: "tool_result", content: '{"name":"grep","out":"hit"}' },
      { source: "tool_result", content: "bash: did it" },
      { source: "compaction", content: "compressed" },
      { source: "unknown_kind", content: "ignored" },
    ]);
    expect(container.querySelectorAll(".message.user")).toHaveLength(2);
    expect(container.querySelector(".thinking-block")!.textContent).toContain("because");
    expect(container.querySelectorAll(".tool-call-block")).toHaveLength(2);
    // Entries carry no tool_call_id: the grep result pairs by name to the
    // grep block (the only pending "grep" call).
    const blocks = container.querySelectorAll(".tool-call-block");
    openResult(blocks[0]!);
    openResult(blocks[1]!);
    expect(blocks[0]!.querySelector(".tool-result-pre")!.textContent).toContain("hit");
    expect(blocks[1]!.querySelector(".tool-result-pre")!.textContent).toContain("did it");
    expect(container.querySelector(".message.assistant .content")!.textContent).toContain("answer");
    expect(texts(".compacting .bubble")[0]).toContain("compressed");
  });

  it("flattens content-part arrays and handles null content", () => {
    ml.renderLogEntries([
      { source: "input", content: [{ type: "text", text: "part one" }, { type: "image" }, { type: "text", text: "part two" }] },
      { source: "input", content: null as unknown as string },
    ]);
    expect(container.querySelector(".message.user .content")!.textContent).toBe("part one\npart two");
  });

  it("tolerates bookkeeping entries with plain-object content (old cold logs)", () => {
    // VIEW_LOG ships raw entries; bookkeeping sources carry object content.
    // renderLogEntries flattens content before the source switch, so this
    // must not throw (regression: "content is not iterable").
    expect(() =>
      ml.renderLogEntries([
        { source: "session_start", content: { sessionId: "abc", profile: "default" } as unknown as string },
        { source: "llm", content: "after the bookkeeping entry" },
      ]),
    ).not.toThrow();
    expect(container.querySelector(".message.assistant .content")!.textContent).toContain("after the bookkeeping entry");
  });

  it("log replay renders stored file-include parts as inline attachment boxes", () => {
    ml.renderLogEntries([
      {
        source: "input",
        content: [
          { type: "untrusted", text: "look" },
          { type: "file-include", path: "note.md", content: "BODY" },
        ],
      },
    ]);
    const bubble = container.querySelector(".message.user .bubble")!;
    expect(bubble.querySelector(".content")!.textContent).toBe("look");
    const box = bubble.querySelector(".attachment-box")!;
    expect(box.querySelector("summary")!.textContent).toBe("note.md");
    expect(box.querySelector(".attachment-content")!.textContent).toBe("BODY");
    // The at-rest JSON never reaches the chat surface.
    expect(container.innerHTML).not.toContain('{"type":"file-include"');
  });

  it("extractToolName falls back to prefix then 'tool'", () => {
    ml.renderLogEntries([
      { source: "llm", content: "", tool_calls: [{ id: "1", name: "read", args: { p: 1 } }] },
      { source: "tool_result", content: "not json at all" },
    ]);
    // extractToolName returns "tool"; no pending call has that name, so the
    // result is silently dropped and the block keeps no result section.
    expect(container.querySelector(".tool-call-block .tool-result-box")).toBeNull();
  });

  it("a stored tool-result part names its own tool and flattens for display", () => {
    ml.renderLogEntries([
      { source: "llm", content: "", tool_calls: [{ id: "1", name: "read", args: { p: "a" } }] },
      {
        source: "tool_result",
        content: [
          { type: "text", text: "harness text is not the tool name" },
          {
            type: "tool-result",
            tool: "read",
            status: "failure",
            meta: [["exit_code", "1"]],
            error: "boom",
            hint: "check the path",
            output: "partial",
          },
        ],
      },
    ]);
    // The entry carries no tool_name: the stored part names the tool, which
    // matches the pending call. The opened body shows the flattened fields,
    // not markup or at-rest JSON.
    openResult(container.querySelector(".tool-call-block")!);
    const pre = container.querySelector(".tool-result-pre")!;
    expect(pre.textContent).toContain("partial");
    expect(pre.textContent).toContain("Error: boom");
    expect(pre.textContent).toContain("HINT: check the path");
    expect(pre.textContent).toContain('META: {"exit_code":"1"}');
  });

  it("reads wire-shaped tool_calls from the file log ({function:{name,arguments}})", () => {
    // The at-rest llm record stores the provider wire object, not the live
    // SSE-flattened {name,args} shape (see the gold log: every tool_calls
    // entry nests under `function` with `arguments` as a JSON string).
    // Regression: the cold renderer read the flat fields, so every call
    // row rendered as "unknown" with args "{}".
    ml.renderLogEntries([
      { source: "input", content: "do it" },
      {
        source: "llm",
        content: "",
        tool_calls: [
          {
            id: "call_f6xnpk6vdz7fadf86quh",
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls -la"}' },
          },
        ],
      } as any,
      {
        source: "tool_result",
        content: "RESULT-OUT",
        tool_call_id: "call_f6xnpk6vdz7fadf86quh",
        tool_name: "bash",
      },
    ]);
    const block = container.querySelector(".tool-call-block")!;
    expect(block.querySelector(".tool-call-name")!.textContent).toContain("bash");
    expect(block.textContent).not.toContain("unknown");
    // The header fold reads the nested arguments string (the bug showed an
    // empty fold over literal "{}" args).
    expect(block.querySelector(".tool-call-display")!.textContent).toBe("ls -la");
    // The result pairs by tool_call_id onto the named call (box opened).
    openResult(block);
    expect(block.querySelector(".tool-result-pre")!.textContent).toBe("RESULT-OUT");
  });

  it("annotated display parts reach the block: a browsed edit renders the DIFF", () => {
    // The cold log-view carries the registry-resolved parts per tool_call
    // (handlers-logs.ts), so a browsed log hits the SAME posture code as a
    // live TOOL_CALL frame: the diff renders inline and consumes the result.
    ml.renderLogEntries([
      {
        source: "llm",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "edit",
              arguments: JSON.stringify({ path: "a.ts", oldString: "one\ntwo\nthree", newString: "one\nTWO\nthree" }),
            },
            display: [{ kind: "diff", oldArg: "oldString", newArg: "newString" }],
          },
        ],
      } as any,
      { source: "tool_result", content: "ok", tool_call_id: "c1", tool_name: "edit" },
    ]);
    const block = container.querySelector(".tool-call-block")!;
    expect(block.querySelector(".diff-del")!.textContent).toContain("two");
    expect(block.querySelector(".diff-add")!.textContent).toContain("TWO");
    // Consumed by the diff: no generic result box anywhere in the block.
    expect(block.querySelector(".tool-result-box")).toBeNull();
  });

  it("an entry with NO display stays generic (the pre-fix cold posture)", () => {
    // Same call, same result, no annotated parts: the generic box is all the
    // client can build. This is the shape old servers (and hintless tools)
    // keep sending -- and the exact complaint the cold path used to cause.
    ml.renderLogEntries([
      {
        source: "llm",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "edit",
              arguments: JSON.stringify({ path: "a.ts", oldString: "one", newString: "two" }),
            },
          },
        ],
      } as any,
      { source: "tool_result", content: "edited 1 line", tool_call_id: "c1", tool_name: "edit" },
    ]);
    const block = container.querySelector(".tool-call-block")!;
    // The tool NAME never decides the posture (spec-keyed doctrine).
    expect(block.querySelector(".tool-diff")).toBeNull();
    openResult(block);
    expect(block.querySelector(".tool-result-pre")!.textContent).toBe("edited 1 line");
  });

  it("an args-sourced all-add diff renders from a cold append entry, envelope in the footer", () => {
    ml.renderLogEntries([
      {
        source: "llm",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "append", arguments: JSON.stringify({ path: "/srv/notes.md", content: "line one\nline two" }) },
            display: [{ kind: "diff", source: "args", arg: "content", pathArg: "path" }],
          },
        ],
      } as any,
      { source: "tool_result", content: '{"path":"/srv/notes.md","bytes_appended":17}', tool_call_id: "c1", tool_name: "append" },
    ]);
    const block = container.querySelector(".tool-call-block")!;
    // Cold replay wears exactly what the live frame would (owner ruling
    // 20261105-0435: writes render as all-add diffs): the written lines as
    // adds with blank rails (append declares no addStart), the path header
    // with its +2 stat (no −0 side), and the envelope as the quiet footer
    // line -- consumed, so no second generic box alongside.
    const diff = block.querySelector(".tool-diff")!;
    expect(block.querySelector(".tool-file")).toBeNull();
    expect(diff.querySelector(".part-path-dir")!.textContent).toBe("/srv/");
    expect(diff.querySelector(".part-path-base")!.textContent).toBe("notes.md");
    expect(diff.querySelector(".diff-stat-add")!.textContent).toBe("+2");
    expect(diff.querySelector(".diff-stat-del")).toBeNull();
    expect(diff.querySelectorAll(".diff-row")).toHaveLength(2);
    expect(block.querySelector(".tool-result-box")).toBeNull();
    expect(block.querySelector(".tool-diff .tool-file-meta")!.textContent).toContain("bytes_appended");
    // The diff header is NOT a fold (inline primary content): replayed
    // bytes can never be stranded behind a click.
    (diff.querySelector(".part-head") as HTMLElement).click();
    expect(diff.querySelectorAll(".diff-row")).toHaveLength(2);
  });
});

describe("scroll follow and lifecycle", () => {
  it("pins to bottom until the user scrolls up", () => {
    const c = container as unknown as { scrollTop: number; scrollHeight: number; clientHeight: number };
    ml.handleUserMessage({ content: "a" });
    expect(c.scrollTop).toBe(c.scrollHeight);

    // Scroll far from bottom -> unfollow.
    c.scrollHeight = 5000;
    c.scrollTop = 100; // dist = 5000-100-500 = 4400 > 150
    container.dispatchEvent(new Event("scroll"));
    ml.handleUserMessage({ content: "b" });
    expect(c.scrollTop).toBe(100);

    // Back within threshold -> follow again.
    c.scrollTop = c.scrollHeight - 500 - 50;
    container.dispatchEvent(new Event("scroll"));
    ml.handleUserMessage({ content: "c" });
    expect(c.scrollTop).toBe(c.scrollHeight);
  });

  it("clear empties the container and resets streaming state", () => {
    ml.handleStreamingChunk({ content: "streaming" });
    ml.clear();
    expect(container.innerHTML).toBe("");
    // Streaming restarts from scratch.
    ml.handleStreamingChunk({ content: "fresh" });
    const content = container.querySelector(".message.assistant .content")!;
    expect(content.textContent).toBe("fresh");
    expect(content.children[0]!.getAttribute("data-block-index")).toBe("0");
  });

  it("destroy detaches the scroll listener", () => {
    ml.destroy();
    const c = container as unknown as { scrollTop: number; scrollHeight: number };
    // Scroll far from bottom; with the listener gone, followBottom stays
    // pinned at its initial true and a later append would still move scrollTop.
    c.scrollHeight = 5000;
    c.scrollTop = 100;
    container.dispatchEvent(new Event("scroll"));
    expect(c.scrollTop).toBe(100); // listener removed: follow state unchanged
  });
});

describe("images in messages", () => {
  const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg==";

  it("renders a tool-result image as a data-URL <img> with escaped markup", () => {
    ml.handleToolCall({ name: "read", args: '{"path":"photo.png"}' });
    ml.handleToolResult({
      name: "read",
      output: "Image: photo.png (image/png, 1.0KB)",
      images: [{ mimeType: "image/png", data: PNG_B64 }],
    });
    const img = container.querySelector(".tool-call-block .message-images img")!;
    expect(img.getAttribute("src")).toBe(`data:image/png;base64,${PNG_B64}`);
    // innerHTML serializes attributes escaped: no raw quote injection.
    expect(container.innerHTML).toContain(`src="data:image/png;base64,${PNG_B64}"`);
    expect(container.innerHTML).not.toContain("<script");
  });

  it("click toggles full size on a thumbnail", () => {
    ml.handleToolCall({ name: "read", args: "{}" });
    ml.handleToolResult({ name: "read", output: "ok", images: [{ mimeType: "image/png", data: PNG_B64 }] });
    const img = container.querySelector("img.message-image") as HTMLElement;
    img.click();
    expect(img.classList.contains("fullsize")).toBe(true);
    img.click();
    expect(img.classList.contains("fullsize")).toBe(false);
  });

  it("renders images attached to a user message", () => {
    ml.handleUserMessage({ content: "look at this", images: [{ mimeType: "image/webp", data: "AAA" }] });
    const img = container.querySelector(".message.user img")!;
    expect(img.getAttribute("src")).toBe("data:image/webp;base64,AAA");
  });

  it("skipped (oversized) images render a note, never an <img>", () => {
    ml.handleToolCall({ name: "read", args: "{}" });
    ml.handleToolResult({
      name: "read",
      output: "ok",
      images: [{ mimeType: "image/png", skipped: true, note: "image too large to display (9.0MB base64 > 8MB cap)" }],
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".image-skipped")!.textContent).toContain("too large");
  });

  it("rejects non-image mimeTypes on the wire", () => {
    ml.handleUserMessage({ content: "hi", images: [{ mimeType: "text/html", data: "PHNjcmlwdD4=" }] });
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("<script");
    expect(container.querySelector(".image-skipped")!.textContent).toContain("unsupported");
  });

  it("log replay renders entry images", () => {
    ml.renderLogEntries([
      { source: "tool_result", tool_name: "read", content: "Image: x.png", images: [{ mimeType: "image/png", data: PNG_B64 }] },
    ] as any);
    // No preceding tool call block: images only attach to a matched block,
    // so nothing renders (matches existing no-match behavior).
    expect(container.querySelector("img")).toBeNull();
    ml.renderLogEntries([
      { source: "llm", content: "", tool_calls: [{ id: "t1", name: "read", arguments: "{}" }] },
      { source: "tool_result", tool_name: "read", content: "Image: x.png", images: [{ mimeType: "image/png", data: PNG_B64 }] },
    ] as any);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(`data:image/png;base64,${PNG_B64}`);
  });
});

// ── Assistant message footer ────────────────────────────────────────────────

/** Local-wall-clock ts: formatClock renders local time, so build the Date
 *  from local components instead of an ISO string. */
function localTs(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

describe("assistant message footer", () => {
  it("renders a muted meta row with timestamp + copy button under a completed assistant message", () => {
    ml.handleAssistantMessage({ content: "all done", ts: localTs(2026, 5, 4, 1, 35) });
    const footer = container.querySelector(".message-assistant-footer")!;
    expect(footer.querySelector(".footer-time")!.textContent).toBe("1:35 AM");
    const btn = footer.querySelector(".footer-copy")!;
    expect(btn.getAttribute("title")).toBe("Copy message");
    expect(btn.querySelector("svg")).not.toBeNull();
    // No turn data on this frame: the worked segment is omitted, never invented.
    expect(footer.querySelector(".footer-worked")).toBeNull();
    // The footer is its own row after the message, not part of the bubble.
    expect(container.querySelector(".message.assistant .footer-copy")).toBeNull();
  });

  it("user messages, tool results and system notices never get a footer", () => {
    ml.handleUserMessage({ content: "hi" });
    ml.handleCommandResult({ content: "cmd out" });
    ml.handleSystemMessage({ content: "note" });
    expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(0);
  });

  it("midnight and noon format as 12 AM / 12 PM", () => {
    ml.handleAssistantMessage({ content: "a", ts: localTs(2026, 1, 1, 0, 5) });
    ml.handleAssistantMessage({ content: "b", ts: localTs(2026, 1, 1, 12, 0) });
    const times = [...container.querySelectorAll(".footer-time")].map((e) => e.textContent);
    expect(times).toEqual(["12:05 AM", "12:00 PM"]);
  });

  it("long durations pad the worked segment to h/m/s", () => {
    ml.handleAssistantMessage({ content: "a", ts: localTs(2026, 5, 4, 3, 0), durationMs: 3_909_000 });
    ml.handleAssistantMessage({ content: "b", ts: localTs(2026, 5, 4, 3, 1), durationMs: 61_000 });
    ml.handleAssistantMessage({ content: "c", ts: localTs(2026, 5, 4, 3, 2), durationMs: 900 });
    const worked = [...container.querySelectorAll(".footer-worked")].map((e) => e.textContent);
    expect(worked).toEqual(["Worked for 1h 05m 09s", "Worked for 1m 01s", "Worked for 1s"]);
  });

  it("copy click writes the RAW markdown to the clipboard and flashes the confirmed state", async () => {
    const copied: string[] = [];
    const prev = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: {
          writeText: async (t: string) => {
            copied.push(t);
          },
        },
      },
      configurable: true,
    });
    try {
      const raw = "# keep **me** raw\n\n<html-looking text> stays verbatim";
      ml.handleAssistantMessage({ content: raw, ts: localTs(2026, 5, 4, 9, 0) });
      const btn = container.querySelector(".footer-copy") as HTMLElement;
      btn.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(copied).toEqual([raw]);
      expect(btn.classList.contains("copied")).toBe(true);
    } finally {
      if (prev) Object.defineProperty(globalThis, "navigator", prev);
      else delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  it("in-flight row shows no footer; turn end completes it with timestamp + measured duration", () => {
    let fakeNow = localTs(2026, 5, 4, 13, 5); // 1:05 PM
    const nowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      // Attach reports idle first (the baseline); only edges after it clock.
      ml.noteWorking(false);
      ml.noteWorking(true); // observed idle->working edge starts the clock
      ml.handleStreamingChunk({ content: "work" });
      ml.handleToolCall({ name: "bash", args: "{}" });
      // The mid-turn row committed (log-replay parity), but the turn duration
      // is unknowable while the turn runs: no worked segment yet.
      const midFooters = container.querySelectorAll(".message-assistant-footer");
      expect(midFooters).toHaveLength(1);
      expect(midFooters[0]!.querySelector(".footer-worked")).toBeNull();
      expect(midFooters[0]!.querySelector(".footer-time")!.textContent).toBe("1:05 PM");

      ml.handleStreamingChunk({ content: "done" });
      // In flight again: no new footer while chunks flow.
      expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(1);

      fakeNow = localTs(2026, 5, 4, 13, 21) + 21_000; // +16m21s from 1:05 PM
      ml.noteWorking(false);
      const footers = container.querySelectorAll(".message-assistant-footer");
      expect(footers).toHaveLength(2);
      expect(footers[1]!.querySelector(".footer-time")!.textContent).toBe("1:21 PM");
      expect(footers[1]!.querySelector(".footer-worked")!.textContent).toBe("Worked for 16m 21s");
      // The completed row is no longer marked streaming, and the copy button
      // hands out this row's raw text only.
      const rows = container.querySelectorAll(".message.assistant");
      expect(rows[rows.length - 1]!.classList.contains("streaming")).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("turn end without an observed start (attach baseline) omits the duration segment", () => {
    let fakeNow = localTs(2026, 5, 4, 9, 0);
    const nowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      // A view attaching mid-turn gets the working state BEFORE any edge it
      // could clock: the real start is unknown, so no duration is printed.
      ml.noteWorking(true);
      ml.handleStreamingChunk({ content: "partial" });
      fakeNow += 5000;
      ml.noteWorking(false);
      const footer = container.querySelector(".message-assistant-footer")!;
      expect(footer.querySelector(".footer-time")!.textContent).toBe("9:00 AM");
      expect(footer.querySelector(".footer-worked")).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("an interrupted row (next user message / error) commits WITHOUT a footer", () => {
    ml.handleStreamingChunk({ content: "cut short" });
    ml.handleUserMessage({ content: "new thought" });
    expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(0);
    ml.handleStreamingChunk({ content: "then failed" });
    ml.handleError({ message: "boom" });
    expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(0);
  });
});

describe("assistant message footer (cold-log replay)", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const entry = (over: Record<string, unknown>) => over;

  it("renders footers from entry timestamps and turn-marker durations", () => {
    const t0 = localTs(2026, 5, 4, 1, 5);
    const t1 = t0 + (16 * 60 + 21) * 1000;
    ml.renderLogEntries([
      entry({ source: "turn_started", ts: iso(t0), content: { kind: "input" } }),
      entry({ source: "input", ts: iso(t0 + 10), content: "go" }),
      entry({ source: "llm", ts: iso(t1), content: "done" }),
      entry({ source: "turn_end", ts: iso(t1 + 250), content: { status: "completed" } }),
    ] as any);
    // Only the assistant message gets a footer (user / markers do not).
    const footers = container.querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(1);
    expect(footers[0]!.querySelector(".footer-time")!.textContent).toBe("1:21 AM");
    expect(footers[0]!.querySelector(".footer-worked")!.textContent).toBe("Worked for 16m 21s");
  });

  it("timestamp-less legacy entries render NO footer at all (pinned degradation)", () => {
    ml.renderLogEntries([
      entry({ source: "input", content: "old question" }),
      entry({ source: "llm", content: "old answer" }),
    ] as any);
    expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(0);
    // The message itself still renders -- the omission is only the meta row.
    expect(container.querySelector(".message.assistant .content")!.textContent).toContain("old answer");
  });

  it("a corrupt ts degrades like no ts", () => {
    ml.renderLogEntries([entry({ source: "llm", ts: "not-a-date", content: "x" })] as any);
    expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(0);
  });

  it("ts without turn markers gives timestamp-only; an open turn likewise drops the duration", () => {
    const t0 = localTs(2026, 5, 4, 1, 0);
    ml.renderLogEntries([
      entry({ source: "llm", ts: iso(t0), content: "v1 style" }),
      entry({ source: "turn_started", ts: iso(t0 + 1000), content: { kind: "input" } }),
      entry({ source: "llm", ts: iso(t0 + 2000), content: "crash before turn_end" }),
    ] as any);
    const footers = container.querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(2);
    expect(footers[0]!.querySelector(".footer-time")!.textContent).toBe("1:00 AM");
    expect(footers[0]!.querySelector(".footer-worked")).toBeNull();
    expect(footers[1]!.querySelector(".footer-time")!.textContent).toBe("1:00 AM");
    expect(footers[1]!.querySelector(".footer-worked")).toBeNull();
  });

  it("a multi-round turn: the turn total rides ONLY the turn-final bar", () => {
    const t0 = localTs(2026, 5, 4, 1, 5);
    ml.renderLogEntries([
      // ONE bracket spans the whole turn (turn_started lands on the run's
      // first iteration, turn_end when it stops), so a naive per-entry stamp
      // printed the same total under every round's bar.
      entry({ source: "turn_started", ts: iso(t0), content: { kind: "input" } }),
      entry({ source: "input", ts: iso(t0 + 10), content: "go" }),
      entry({
        source: "llm",
        ts: iso(t0 + 5000),
        content: "checking",
        tool_calls: [{ id: "t1", name: "bash", arguments: "{}" }],
      }),
      entry({ source: "tool_result", ts: iso(t0 + 5100), content: "ok" }),
      entry({ source: "llm", ts: iso(t0 + 9000), content: "done" }),
      entry({ source: "turn_end", ts: iso(t0 + 9000), content: { status: "completed" } }),
    ] as any);
    const footers = container.querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(2);
    expect(footers[0]!.querySelector(".footer-worked")).toBeNull();
    expect(footers[1]!.querySelector(".footer-worked")!.textContent).toBe("Worked for 9s");
  });
});

// ── Footer ctx gauge segment + hover breakdown ──────────────────────────────
// The legacy token-usage bubble is gone; its numbers ride the footer as a
// `used/total` segment (the exact pair the sidebar gauge shows) with the
// per-call breakdown on hover. Segments are honest per render path: absent
// data omits the segment, and an unattested tooltip line drops its line.

describe("assistant footer ctx segment (live path)", () => {
  /** TOKEN_USAGE frame shaped like s2cTokenUsage emits (ctx pair included). */
  function frame(over: Record<string, unknown> = {}) {
    return {
      promptTokens: 26112,
      cachedTokens: 98304,
      completionTokens: 1408,
      totalTokens: 125824,
      contextWindow: 262144,
      ctxUsed: 125824,
      ctxTotal: 262144,
      ...over,
    };
  }

  /** Drive one streamed turn with an optional usage frame; return its footer. */
  function liveTurn(withUsage: boolean): Element {
    ml.noteWorking(false); // baseline
    ml.noteWorking(true); // observed edge clocks the turn
    ml.handleStreamingChunk({ content: "answer" });
    if (withUsage) ml.handleTokenUsage(frame() as never);
    ml.noteWorking(false);
    const footers = container.querySelectorAll(".message-assistant-footer");
    return footers[footers.length - 1]!;
  }

  it("full line order: ts, gauge, worked, copy button", () => {
    const before = localTs(2026, 5, 4, 20, 52); // 8:52 PM
    const nowSpy = spyOn(Date, "now").mockImplementation(() => before);
    try {
      const footer = liveTurn(true);
      expect([...footer.children].map((c) => c.className)).toEqual([
        "footer-time",
        "footer-ctx",
        "footer-worked",
        "footer-copy",
      ]);
      expect(footer.querySelector(".footer-time")!.textContent).toBe("8:52 PM");
      expect(footer.querySelector(".footer-ctx")!.textContent).toBe("126k/262k");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("hover tooltip carries the full breakdown in compact house format", () => {
    liveTurn(true);
    const gauge = container.querySelector(".footer-ctx")!;
    expect(gauge.getAttribute("title")).toBe(
      "cached 98k\nprompt 26k\ncompletion 1.4k\ntotal 126k",
    );
    // Focusable so keyboard focus surfaces the title like the copy button.
    expect(gauge.getAttribute("tabindex")).toBe("0");
  });

  it("no usage frame this turn: ts + worked render, the gauge does not", () => {
    const footer = liveTurn(false);
    expect(footer.querySelector(".footer-time")).not.toBeNull();
    expect(footer.querySelector(".footer-worked")).not.toBeNull();
    // No gauge span means nothing hoverable exists either.
    expect(footer.querySelector(".footer-ctx")).toBeNull();
  });

  it("a frame without the ctx pair attests nothing: no gauge", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleStreamingChunk({ content: "answer" });
    // Legacy-shaped frame (pre-ctx-pair server): totalTokens alone does not
    // stamp a gauge -- the footer echoes the ctx pair, it re-derives nothing.
    ml.handleTokenUsage({ promptTokens: 950, cachedTokens: 2, completionTokens: 5, totalTokens: 957 });
    ml.noteWorking(false);
    expect(container.querySelector(".footer-ctx")).toBeNull();
    expect(container.querySelector(".token-usage")).toBeNull();
  });

  it("used without an attested window renders the bare number, no denominator", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleStreamingChunk({ content: "answer" });
    ml.handleTokenUsage(frame({ ctxTotal: undefined }) as never);
    ml.noteWorking(false);
    expect(container.querySelector(".footer-ctx")!.textContent).toBe("126k");
  });

  it("a prior turn's gauge never leaks into the next turn", () => {
    liveTurn(true); // turn 1 attests usage
    // Turn 2 produces no usage: the segment is this turn's or nothing.
    ml.noteWorking(true);
    ml.handleStreamingChunk({ content: "again" });
    ml.noteWorking(false);
    const footers = container.querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(2);
    expect(footers[0]!.querySelector(".footer-ctx")).not.toBeNull();
    expect(footers[1]!.querySelector(".footer-ctx")).toBeNull();
  });

  it("tool-boundary commit carries the gauge (usage precedes the tool frame in the sink)", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleStreamingChunk({ content: "let me check" });
    ml.handleTokenUsage(frame() as never);
    ml.handleToolCall({ name: "bash", args: "{}" });
    // Mid-turn row: duration stays omitted (turn open), ctx is attested.
    const footer = container.querySelector(".message-assistant-footer")!;
    expect(footer.querySelector(".footer-ctx")!.textContent).toBe("126k/262k");
    expect(footer.querySelector(".footer-worked")).toBeNull();
  });

  it("question-boundary commit carries the gauge too", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleStreamingChunk({ content: "one question" });
    ml.handleTokenUsage(frame() as never);
    ml.handleQuestion({ questions: [{ prompt: "which?" }] });
    const footer = container.querySelector(".message-assistant-footer")!;
    expect(footer.querySelector(".footer-ctx")!.textContent).toBe("126k/262k");
    expect(footer.querySelector(".footer-worked")).toBeNull();
  });
});

describe("assistant footer ctx segment (cold-log replay)", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const t0 = localTs(2026, 5, 4, 1, 5);

  it("gauge + tooltip derive from the token_usage record at the message's position", () => {
    ml.renderLogEntries([
      { source: "turn_started", ts: iso(t0), content: { kind: "input" } },
      { source: "input", ts: iso(t0 + 10), content: "go" },
      { source: "llm", ts: iso(t0 + 981_200), content: "done" },
      {
        source: "token_usage",
        ts: iso(t0 + 981_210),
        content: "",
        totalTokens: 125824,
        contextWindow: 262144,
        cachedTokens: 98304,
        promptTokens: 26112,
        completionTokens: 1408,
      },
      { source: "turn_end", ts: iso(t0 + 981_450), content: { status: "completed" } },
    ] as never);
    // The usage record renders NO transcript node of its own; the record's
    // data lands on the message footer (and stays in the log for every
    // other consumer: session index, resume gauge, replay frames).
    expect(container.querySelector(".token-usage")).toBeNull();
    const footers = container.querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(1);
    // The record predates the durationMs field, so the per-call segment is a
    // DERIVED log-gap value (input t0+10 -> llm t0+981200): it sits adjacent
    // to the gauge, before the turn-total. turn-total/ts/copy unchanged.
    expect([...footers[0]!.children].map((c) => c.className)).toEqual([
      "footer-time",
      "footer-ctx",
      "footer-call",
      "footer-worked",
      "footer-copy",
    ]);
    expect(footers[0]!.querySelector(".footer-ctx")!.textContent).toBe("126k/262k");
    expect(footers[0]!.querySelector(".footer-ctx")!.getAttribute("title")).toBe(
      "cached 98k\nprompt 26k\ncompletion 1.4k\ntotal 126k\ncall ~16m 21s (derived from log gap)",
    );
    expect(footers[0]!.querySelector(".footer-worked")!.textContent).toBe("Worked for 16m 21s");
  });

  it("logs predating usage records render ts+worked but no gauge (pinned omission)", () => {
    ml.renderLogEntries([
      { source: "turn_started", ts: iso(t0), content: { kind: "input" } },
      { source: "llm", ts: iso(t0 + 5000), content: "old style" },
      { source: "turn_end", ts: iso(t0 + 9000), content: { status: "completed" } },
    ] as never);
    const footer = container.querySelector(".message-assistant-footer")!;
    expect(footer.querySelector(".footer-worked")).not.toBeNull();
    expect(footer.querySelector(".footer-ctx")).toBeNull();
  });

  it("a record attributes to its own llm entry only", () => {
    ml.renderLogEntries([
      {
        source: "llm",
        ts: iso(t0),
        content: "first",
      },
      { source: "token_usage", ts: iso(t0 + 5), content: "", totalTokens: 960 },
      { source: "llm", ts: iso(t0 + 60_000), content: "second" },
    ] as never);
    const footers = container.querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(2);
    // The record follows (and belongs to) the first response; the second
    // response has no record of its own, so it borrows nothing.
    expect(footers[0]!.querySelector(".footer-ctx")!.textContent).toBe("960");
    expect(footers[1]!.querySelector(".footer-ctx")).toBeNull();
  });

  it("partial breakdown omits the missing tooltip lines, never zeros them", () => {
    ml.renderLogEntries([
      { source: "llm", ts: iso(t0), content: "done" },
      { source: "token_usage", ts: iso(t0 + 5), content: "", totalTokens: 960, contextWindow: 200000 },
    ] as never);
    const gauge = container.querySelector(".footer-ctx")!;
    expect(gauge.textContent).toBe("960/200k");
    // Record carries no cached/prompt/completion fields: total is all it
    // attests, so the tooltip says exactly that.
    expect(gauge.getAttribute("title")).toBe("total 960");
  });

  it("a zero attested on the wire keeps its tooltip line (0 is a number, not an absence)", () => {
    ml.renderLogEntries([
      { source: "llm", ts: iso(t0), content: "done" },
      { source: "token_usage", ts: iso(t0 + 5), content: "", totalTokens: 960, cachedTokens: 0, completionTokens: 0 },
    ] as never);
    const gauge = container.querySelector(".footer-ctx")!;
    expect(gauge.getAttribute("title")).toBe("cached 0\ncompletion 0\ntotal 960");
  });

  it("legacy entries without ts still get NO footer even when usage exists", () => {
    ml.renderLogEntries([
      { source: "llm", content: "undated answer" },
      { source: "token_usage", content: "", totalTokens: 1200 },
    ] as never);
    expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(0);
  });
});

// ── One bar per response, text-less responses included ──────────────────────
// Every completed LLM response gets exactly one footer bar with its own ctx
// gauge, on every render path -- including responses that streamed no text
// (tool calls and/or reasoning only). The copy button is the action for
// text: a text-less bar has none. The TOKEN_USAGE frame is the per-response
// marker on the live path (providers that report no usage honestly have no
// text-less bar); TOOL_RESULT clears the marker so a replayed usage record
// (which lands before the NEXT entry's tool frames in log order) can never
// stamp a later response.

describe("assistant bar per response (text-less responses)", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const t0 = localTs(2026, 5, 4, 1, 5);

  function frame(over: Record<string, unknown> = {}) {
    return {
      promptTokens: 26112,
      cachedTokens: 98304,
      completionTokens: 1408,
      totalTokens: 125824,
      contextWindow: 262144,
      ctxUsed: 125824,
      ctxTotal: 262144,
      ...over,
    };
  }

  it("live tool-only response: one bar with gauge, no copy button, no bubble", () => {
    ml.noteWorking(false); // baseline
    ml.noteWorking(true);
    ml.handleTokenUsage(frame() as never);
    ml.handleToolCall({ name: "bash", args: "{}" });
    const footers = container.querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(1);
    expect(footers[0]!.querySelector(".footer-ctx")!.textContent).toBe("126k/262k");
    expect(footers[0]!.querySelector(".footer-copy")).toBeNull();
    expect(footers[0]!.querySelector(".footer-worked")).toBeNull(); // turn still open
    // The response itself rendered no assistant bubble -- only the bar.
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(0);
  });

  it("parallel tool calls in one response stay ONE bar", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleTokenUsage(frame() as never);
    ml.handleToolCall({ name: "bash", args: "{}", toolCallId: "c1" });
    ml.handleToolCall({ name: "read", args: "{}", toolCallId: "c2" });
    expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(1);
  });

  it("one bar per round: text round keeps its copy button, tool-only round gets none", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleStreamingChunk({ content: "let me check" });
    ml.handleTokenUsage(frame() as never);
    ml.handleToolCall({ name: "bash", args: "{}", toolCallId: "c1" });
    ml.handleToolResult({ name: "bash", output: "ok", toolCallId: "c1" });
    // Round 2: no text streamed, its own usage frame, then tools.
    ml.handleTokenUsage(frame({ ctxUsed: 130000 }) as never);
    ml.handleToolCall({ name: "bash", args: "{}", toolCallId: "c2" });
    const footers = container.querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(2);
    expect(footers[0]!.querySelector(".footer-copy")).not.toBeNull();
    expect(footers[1]!.querySelector(".footer-copy")).toBeNull();
    expect(footers[1]!.querySelector(".footer-ctx")!.textContent).toBe("130k/262k");
  });

  it("live reasoning-only response: bar lands once, thinking block stays rendered", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleStreamingReasoningChunk({ content: "pondering" });
    ml.handleTokenUsage(frame() as never);
    ml.handleToolCall({ name: "bash", args: "{}" });
    expect(container.querySelectorAll(".thinking-block")).toHaveLength(1);
    const footers = container.querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(1);
    expect(footers[0]!.querySelector(".footer-copy")).toBeNull();
  });

  it("silent final response: turn end gives it ts + gauge + worked, no copy", () => {
    let fakeNow = localTs(2026, 5, 4, 9, 0);
    const nowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      ml.noteWorking(false); // baseline
      ml.noteWorking(true);
      ml.handleTokenUsage(frame() as never);
      fakeNow += 65_000;
      ml.noteWorking(false);
      const footers = container.querySelectorAll(".message-assistant-footer");
      expect(footers).toHaveLength(1);
      expect(footers[0]!.querySelector(".footer-copy")).toBeNull();
      expect(footers[0]!.querySelector(".footer-ctx")).not.toBeNull();
      expect(footers[0]!.querySelector(".footer-worked")!.textContent).toBe("Worked for 1m 05s");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("stop after a tool round attaches the turn total to the round's bar", () => {
    let fakeNow = localTs(2026, 5, 4, 9, 0);
    const nowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      ml.noteWorking(false); // baseline (clocked turn starts now)
      ml.noteWorking(true);
      ml.handleTokenUsage(frame() as never);
      ml.handleToolCall({ name: "bash", args: "{}", toolCallId: "c1" });
      const footer = container.querySelector(".message-assistant-footer")!;
      expect(footer.querySelector(".footer-worked")).toBeNull(); // open turn
      ml.handleToolResult({ name: "bash", output: "ok", toolCallId: "c1" });
      fakeNow += 30_000;
      ml.noteWorking(false); // stopped: no further response
      // Still the one bar -- now carrying the turn total.
      expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(1);
      expect(footer.querySelector(".footer-worked")!.textContent).toBe("Worked for 30s");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("cancel after a round: the cut-off stream row still gets no footer, the round's bar keeps its honest total", () => {
    let fakeNow = localTs(2026, 5, 4, 9, 0);
    const nowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      ml.noteWorking(false); // baseline
      ml.noteWorking(true);
      ml.handleTokenUsage(frame() as never);
      ml.handleToolCall({ name: "bash", args: "{}", toolCallId: "c1" });
      fakeNow += 10_000;
      // A new response starts streaming, then a new user ask cuts it off: the
      // interrupted row is NOT a completed response, so it gets no bar.
      ml.handleStreamingChunk({ content: "half a thought" });
      ml.handleUserMessage({ content: "stop, do this instead" });
      ml.noteWorking(false); // cancelled turn closes
      const footers = container.querySelectorAll(".message-assistant-footer");
      expect(footers).toHaveLength(1);
      expect(footers[0]!.querySelector(".footer-worked")!.textContent).toBe("Worked for 10s");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("a usage record cleared by a tool result never stamps the next response", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleTokenUsage(frame() as never);
    ml.handleToolResult({ name: "read", output: "x" }); // closes the record's response
    ml.handleToolCall({ name: "bash", args: "{}" }); // later response, no usage yet
    expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(0);
  });

  it("provider with no usage frame: text-less response honestly renders no bar", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleToolCall({ name: "bash", args: "{}" });
    expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(0);
  });

  it("empty-content frame with ts renders the bar only (replay path)", () => {
    ml.handleAssistantMessage({ content: "", ts: localTs(2026, 5, 4, 2, 30), ctx: { used: 960 } });
    const footers = container.querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(1);
    expect(footers[0]!.querySelector(".footer-time")!.textContent).toBe("2:30 AM");
    expect(footers[0]!.querySelector(".footer-ctx")!.textContent).toBe("960");
    expect(footers[0]!.querySelector(".footer-copy")).toBeNull();
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(0);
  });

  it("empty-content frame without ts renders nothing (legacy omission)", () => {
    ml.handleAssistantMessage({ content: "" });
    expect(container.children).toHaveLength(0);
  });

  it("cold log: text-less llm entry gets bar + gauge from its usage record, no copy", () => {
    ml.renderLogEntries([
      { source: "turn_started", ts: iso(t0), content: { kind: "input" } },
      { source: "llm", ts: iso(t0 + 5000), content: "", tool_calls: [{ id: "t1", name: "bash", arguments: "{}" }] },
      { source: "token_usage", ts: iso(t0 + 5005), content: "", totalTokens: 125824, contextWindow: 262144 },
      { source: "turn_end", ts: iso(t0 + 9000), content: { status: "completed" } },
    ] as never);
    const footers = container.querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(1);
    expect(footers[0]!.querySelector(".footer-ctx")!.textContent).toBe("126k/262k");
    expect(footers[0]!.querySelector(".footer-worked")!.textContent).toBe("Worked for 9s");
    expect(footers[0]!.querySelector(".footer-copy")).toBeNull();
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(0);
  });

  it("cold log: legacy text-less entry without ts renders nothing", () => {
    ml.renderLogEntries([
      { source: "llm", content: "", tool_calls: [{ id: "t1", name: "bash", arguments: "{}" }] },
      { source: "token_usage", content: "", totalTokens: 1200 },
    ] as never);
    expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(0);
  });
});


// ── Footer per-call duration segment (callMs) ───────────────────────────────
// The producing LLM call's own wall time renders as its own compact segment
// adjacent to the ctx gauge, on every render path, independently of the gauge
// and the turn-total. Recorded values come from the token_usage durationMs;
// derived ones from the strict-adjacency log gap and carry honest phrasing.

describe("assistant footer per-call duration segment", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const t0 = localTs(2026, 5, 4, 1, 5);

  it("live turn: the call segment renders from the TOKEN_USAGE durationMs", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleStreamingChunk({ content: "answer" });
    // A frame that attests both the gauge and this call's measured span.
    ml.handleTokenUsage({
      promptTokens: 26112,
      cachedTokens: 98304,
      completionTokens: 1408,
      totalTokens: 125824,
      contextWindow: 262144,
      ctxUsed: 125824,
      ctxTotal: 262144,
      durationMs: 4200,
    } as never);
    ml.noteWorking(false);
    const footer = container.querySelector(".message-assistant-footer")!;
    // Order: ts, gauge, call (adjacent to the gauge), worked, copy.
    expect([...footer.children].map((c) => c.className)).toEqual([
      "footer-time",
      "footer-ctx",
      "footer-call",
      "footer-worked",
      "footer-copy",
    ]);
    expect(footer.querySelector(".footer-call")!.textContent).toBe("4.2s");
  });

  it("live call segment keeps a tenth below 10s and reads sub-second", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleStreamingChunk({ content: "x" });
    ml.handleTokenUsage({ totalTokens: 50, ctxUsed: 50, durationMs: 900 } as never);
    ml.noteWorking(false);
    expect(container.querySelector(".footer-call")!.textContent).toBe("0.9s");
  });

  it("no duration on the frame: no call segment (omitted, never invented)", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleStreamingChunk({ content: "x" });
    ml.handleTokenUsage({ totalTokens: 50, ctxUsed: 50, ctxTotal: 100 } as never);
    ml.noteWorking(false);
    // The gauge is attested, the call duration is not.
    expect(container.querySelector(".footer-ctx")).not.toBeNull();
    expect(container.querySelector(".footer-call")).toBeNull();
  });

  it("a frame with duration but no usable ctx still stamps the call (independent segments)", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleStreamingChunk({ content: "x" });
    ml.handleTokenUsage({
      promptTokens: 10,
      cachedTokens: 0,
      completionTokens: 5,
      totalTokens: 0,
      durationMs: 3300,
    } as never);
    ml.noteWorking(false);
    // No gauge (totalTokens 0), but the measured span still renders.
    expect(container.querySelector(".footer-ctx")).toBeNull();
    expect(container.querySelector(".footer-call")!.textContent).toBe("3.3s");
  });

  it("the gauge tooltip gains a `call` line beside the breakdown", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleStreamingChunk({ content: "x" });
    ml.handleTokenUsage({
      promptTokens: 26112,
      cachedTokens: 98304,
      completionTokens: 1408,
      totalTokens: 125824,
      ctxUsed: 125824,
      ctxTotal: 262144,
      durationMs: 4200,
    } as never);
    ml.noteWorking(false);
    const gauge = container.querySelector(".footer-ctx")!;
    expect(gauge.getAttribute("title")).toBe(
      "cached 98k\nprompt 26k\ncompletion 1.4k\ntotal 126k\ncall 4.2s",
    );
  });

  it("a derived replay value phrases the tooltip call line with ~ and 'derived from log gap'", () => {
    // Cold-log render, token_usage record WITHOUT durationMs + a clean gap:
    // the call is DERIVED and the tooltip must never present it as recorded.
    ml.renderLogEntries([
      { source: "input", ts: iso(t0), content: "go" },
      { source: "llm", ts: iso(t0 + 4200), content: "done" },
      { source: "token_usage", ts: iso(t0 + 4210), content: "", totalTokens: 1200, contextWindow: 8000 },
    ] as never);
    const gauge = container.querySelector(".footer-ctx")!;
    expect(gauge.getAttribute("title")).toContain("call ~4.2s (derived from log gap)");
    const call = container.querySelector(".footer-call")!;
    expect(call.textContent).toBe("4.2s");
    // With a gauge present the derivation note lives on the gauge tooltip;
    // the segment itself carries no title.
    expect(call.getAttribute("title")).toBeNull();
  });

  it("a recorded replay value phrases the tooltip call line plainly (no ~, no derived note)", () => {
    ml.renderLogEntries([
      { source: "input", ts: iso(t0), content: "go" },
      { source: "llm", ts: iso(t0 + 9000), content: "done" },
      { source: "token_usage", ts: iso(t0 + 9010), content: "", totalTokens: 1200, contextWindow: 8000, durationMs: 4200 },
    ] as never);
    const gauge = container.querySelector(".footer-ctx")!;
    expect(gauge.getAttribute("title")).toContain("call 4.2s");
    expect(gauge.getAttribute("title")).not.toContain("derived");
    // The recorded value (4.2s) wins over the wider input->llm gap (9s).
    expect(container.querySelector(".footer-call")!.textContent).toBe("4.2s");
  });

  it("derived value with NO gauge states its derivation on the segment itself", () => {
    // Provider kept usage private (no attested tokens -> no gauge), but the
    // gap derives. Nothing is hoverable except the call segment, so it must
    // carry the derivation note itself.
    ml.renderLogEntries([
      { source: "input", ts: iso(t0), content: "go" },
      { source: "llm", ts: iso(t0 + 5100), content: "done" },
    ] as never);
    expect(container.querySelector(".footer-ctx")).toBeNull();
    const call = container.querySelector(".footer-call")!;
    expect(call.textContent).toBe("5.1s");
    expect(call.getAttribute("title")).toBe("~ derived from log gap");
    expect(call.getAttribute("tabindex")).toBe("0");
  });

  it("handleAssistantMessage renders/omits the call segment per frame", () => {
    ml.handleAssistantMessage({ content: "a", ts: t0, callMs: 2500 });
    ml.handleAssistantMessage({ content: "b", ts: t0 + 1000 });
    const footers = container.querySelectorAll(".message-assistant-footer");
    expect(footers[0]!.querySelector(".footer-call")!.textContent).toBe("2.5s");
    expect(footers[1]!.querySelector(".footer-call")).toBeNull();
  });

  it("call-only and turn-total+call are both valid rows (segments independent)", () => {
    ml.handleAssistantMessage({ content: "only call", ts: t0, callMs: 1234 });
    ml.handleAssistantMessage({ content: "call + turn", ts: t0 + 5000, callMs: 800, durationMs: 60000 });
    const footers = container.querySelectorAll(".message-assistant-footer");
    // call-only: no gauge, no worked.
    expect([...footers[0]!.children].map((c) => c.className)).toEqual([
      "footer-time", "footer-call", "footer-copy",
    ]);
    // turn-total + call: worked present, call present, no gauge.
    expect([...footers[1]!.children].map((c) => c.className)).toEqual([
      "footer-time", "footer-call", "footer-worked", "footer-copy",
    ]);
    expect(footers[1]!.querySelector(".footer-worked")!.textContent).toBe("Worked for 1m 00s");
  });

  it("a non-finite callMs on the frame is omitted, not rendered NaN", () => {
    ml.handleAssistantMessage({ content: "a", ts: t0, callMs: NaN });
    expect(container.querySelector(".footer-call")).toBeNull();
  });

  it("tool-boundary commit carries the call duration the same ordered sink stamps the gauge", () => {
    ml.noteWorking(false);
    ml.noteWorking(true);
    ml.handleStreamingChunk({ content: "let me check" });
    ml.handleTokenUsage({ totalTokens: 120, ctxUsed: 120, ctxTotal: 1000, durationMs: 2600 } as never);
    ml.handleToolCall({ name: "bash", args: "{}" });
    const footer = container.querySelector(".message-assistant-footer")!;
    expect(footer.querySelector(".footer-ctx")).not.toBeNull();
    expect(footer.querySelector(".footer-call")!.textContent).toBe("2.6s");
    // Turn is still open mid-turn: no worked segment, but the call is attested.
    expect(footer.querySelector(".footer-worked")).toBeNull();
  });
});
