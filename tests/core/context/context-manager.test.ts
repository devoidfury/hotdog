// Tests for core/context/context-manager.ts — the thin facade over
// MessageLog, TokenTracker, and SystemPromptBuilder.

import { describe, it, expect } from "bun:test";
import { ContextManager, createContextManager } from "../../../src/core/context/context-manager.ts";
import { Message } from "../../../src/core/context/message.ts";

describe("ContextManager", () => {
  it("createContextManager returns a ContextManager", () => {
    expect(createContextManager()).toBeInstanceOf(ContextManager);
  });

  it("addMessage/getMessages/length track messages", () => {
    const cm = new ContextManager();
    cm.addMessage(new Message({ role: "system", content: "sys" }));
    cm.addMessage(new Message({ role: "user", content: "hi" }));
    expect(cm.length).toBe(2);
    expect(cm.getMessages().map((m) => m.getTextContent())).toEqual(["sys", "hi"]);
  });

  it("getSystem and getNonSystem split messages by role", () => {
    const cm = new ContextManager();
    cm.addMessage(new Message({ role: "system", content: "sys" }));
    cm.addMessage(new Message({ role: "user", content: "hi" }));
    expect(cm.getSystem().map((m) => m.getTextContent())).toEqual(["sys"]);
    expect(cm.getNonSystem().map((m) => m.getTextContent())).toEqual(["hi"]);
  });

  it("replaceMessages swaps out the whole log", () => {
    const cm = new ContextManager();
    cm.addMessage(new Message({ role: "user", content: "a" }));
    cm.addMessage(new Message({ role: "user", content: "b" }));
    cm.replaceMessages([new Message({ role: "user", content: "c" })]);
    expect(cm.length).toBe(1);
    expect(cm.getMessages().at(0)?.getTextContent()).toBe("c");
  });

  it("clear empties the message log", () => {
    const cm = new ContextManager();
    cm.addMessage(new Message({ role: "user", content: "a" }));
    cm.clear();
    expect(cm.length).toBe(0);
  });

  it("estimateTokens uses the chars/4 heuristic on the log or an explicit list", () => {
    const cm = new ContextManager();
    cm.addMessage(new Message({ role: "user", content: "x".repeat(40) }));
    const fromLog = cm.estimateTokens();
    expect(fromLog).toBeGreaterThan(0);
    const explicit = cm.estimateTokens([new Message({ role: "user", content: "y".repeat(160) })]);
    expect(explicit).toBeGreaterThan(fromLog);
  });
});
