// Unit tests for searchableEntryText -- the corpus rule for full-text session
// search: user messages (input/prompt) + assistant response text (llm content)
// only. Tool results, tool-call records, reasoning and image blobs are out.

import { describe, it, expect } from "bun:test";
import { searchableEntryText, LOG_SOURCE, type LogEntry } from "@core/session/session-log.ts";

const entry = (over: Partial<LogEntry>): LogEntry =>
  ({
    ts: "2026-10-20T00:00:00.000Z",
    session_id: "s",
    source: LOG_SOURCE.INPUT,
    content: "",
    ...over,
  }) as LogEntry;

describe("searchableEntryText", () => {
  it("indexes user input and prompt text", () => {
    expect(searchableEntryText(entry({ source: LOG_SOURCE.INPUT, content: "hello there" }))).toBe("hello there");
    expect(searchableEntryText(entry({ source: LOG_SOURCE.PROMPT, content: "one-shot prompt" }))).toBe("one-shot prompt");
  });

  it("indexes assistant content text", () => {
    expect(searchableEntryText(entry({ source: LOG_SOURCE.LLM, content: "the answer" }))).toBe("the answer");
  });

  it("joins text parts of a structured content array, ignoring non-text parts", () => {
    const e = entry({
      source: LOG_SOURCE.LLM,
      content: [
        { type: "text", text: "first" },
        { type: "image_url", image_url: { url: "data:..." } },
        { type: "text", text: "second" },
      ],
    });
    expect(searchableEntryText(e)).toBe("first\nsecond");
  });

  it("never indexes reasoning_content, even on an llm entry", () => {
    const e = entry({ source: LOG_SOURCE.LLM, content: "visible", reasoning_content: "hidden needle" });
    expect(searchableEntryText(e)).toBe("visible");
    expect(searchableEntryText(e)).not.toContain("needle");
  });

  it("never indexes tool-call args or the tool result channel", () => {
    const call = entry({
      source: LOG_SOURCE.LLM,
      content: "",
      tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: `{"p":"needle"}` } }],
    });
    expect(searchableEntryText(call)).toBe("");
    const result = entry({ source: LOG_SOURCE.TOOL_RESULT, content: "needle in tool output" });
    expect(searchableEntryText(result)).toBe("");
  });

  it("yields nothing for bookkeeping / durability sources", () => {
    for (const source of [
      LOG_SOURCE.SYSTEM_PROMPT,
      LOG_SOURCE.TOOL_STARTED,
      LOG_SOURCE.QUESTION_ASKED,
      LOG_SOURCE.RESUME_ATTEMPT,
      LOG_SOURCE.TOKEN_USAGE,
      LOG_SOURCE.SESSION_START,
      LOG_SOURCE.RESET,
    ]) {
      expect(searchableEntryText(entry({ source, content: "needle" }))).toBe("");
    }
  });

  it("degrades plain-object content to empty (bookkeeping, never a message)", () => {
    expect(searchableEntryText(entry({ source: LOG_SOURCE.LLM, content: { status: "ok" } as never }))).toBe("");
  });

  it("never yields image payloads, whatever source carries them", () => {
    // Persisted tool-result images ride the entry's sidecar array; the search
    // corpus reads only text surfaces, so base64 can never leak into a hit.
    const img = [{ type: "image_url", mimeType: "image/png", data: "aGVsbG8=" }];
    const result = entry({ source: LOG_SOURCE.TOOL_RESULT, content: "Image: photo.png", images: img });
    expect(searchableEntryText(result)).toBe("");
    // An INPUT entry with images still yields only its text.
    const input = entry({ source: LOG_SOURCE.INPUT, content: "look", images: img });
    expect(searchableEntryText(input)).toBe("look");
    expect(searchableEntryText(input)).not.toContain("aGVsbG8=");
  });
});
