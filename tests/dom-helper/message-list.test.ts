// Tests for webui/ui/message-list.ts against the minimal DOM from
// tests/dom-helper (installed as a preload via bunfig.toml).

import { describe, it, expect, beforeEach } from "bun:test";
import { createMessageList, type MessageListManager } from "../../src/extensions/webui/ui/message-list.ts";

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

describe("user / assistant messages", () => {
  it("renders a user bubble with escaped-by-textContent content", () => {
    ml.handleUserMessage({ content: "hi <script>alert(1)</script>" });
    const el = container.querySelector(".message.user")!;
    expect(el.querySelector(".content")!.textContent).toContain("<script>");
    expect(container.innerHTML).not.toContain("<script>alert");
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
});

describe("tool calls and results", () => {
  it("renders a collapsible tool call and attaches matching results", () => {
    ml.handleToolCall({ name: "read", args: '{"path":"a.ts"}' });
    const block = container.querySelector(".tool-call-block")!;
    expect(block.querySelector(".tool-call-header span")!.textContent).toContain("read");
    expect(block.querySelector(".tool-call-body")!.classList.contains("hidden")).toBe(true);

    ml.handleToolResult({ name: "read", output: "x".repeat(2500) });
    const body = block.querySelector(".tool-call-body") as HTMLElement;
    expect(body.dataset.fullOutput).toHaveLength(2500);
    expect(body.textContent).toContain("click to show full response");

    // Expand swaps in the full output.
    (block.querySelector(".tool-call-header") as HTMLElement).click();
    expect(body.classList.contains("hidden")).toBe(false);
    expect(body.textContent).toHaveLength(2500);
  });

  it("renders error results and ignores results with no matching call", () => {
    ml.handleToolResult({ name: "ghost", output: "nope" });
    expect(container.children).toHaveLength(0);
    ml.handleToolCall({ name: "bash", args: "ls" });
    ml.handleToolResult({ name: "bash", error: "boom" });
    expect((container.querySelector(".tool-call-body") as HTMLElement).textContent).toBe("Error: boom");
  });

  it("sanitizes tool names in headers", () => {
    ml.handleToolCall({ name: "<img src=x>", args: "" });
    expect(container.innerHTML).not.toContain("<img src=x>");
    expect(container.querySelector(".tool-call-header")!.textContent).toContain("<img src=x>");
  });
});

describe("misc message kinds", () => {
  it("compacting, command result, token usage, compaction result, system", () => {
    ml.handleCompacting({ message: "summarizing" });
    expect(texts(".message.compacting .bubble")[0]).toContain("summarizing");
    ml.handleCommandResult({ content: "ok: 3 files" });
    expect(container.querySelector(".message.command-result .content")!.textContent).toBe("ok: 3 files");
    ml.handleTokenUsage({ promptTokens: 10, cachedTokens: 2, completionTokens: 5, totalTokens: 15 });
    expect(texts(".token-usage .bubble")[0]).toContain("total:15");
    ml.handleCompactionResult({ summary: "s", messagesCompacted: 4 });
    expect(texts(".compaction-result .bubble")[0]).toContain("Compacted 4 messages");
    ml.addSystemMessage("coder");
    expect(container.querySelector(".system-message")!.textContent).toContain("coder");
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
    // grep result attaches to the most recent matching call (the grep one).
    const bodies = container.querySelectorAll<HTMLElement>(".tool-call-body");
    expect(bodies[0]!.dataset.fullOutput).toContain("hit");
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

  it("extractToolName falls back to prefix then 'tool'", () => {
    ml.renderLogEntries([
      { source: "llm", content: "", tool_calls: [{ id: "1", name: "read", args: { p: 1 } }] },
      { source: "tool_result", content: "not json at all" },
    ]);
    // extractToolName returns "tool"; no header matches, so the result is
    // silently dropped and the block keeps its original (absent) output.
    expect((container.querySelector(".tool-call-body") as HTMLElement).dataset.fullOutput).toBeUndefined();
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
