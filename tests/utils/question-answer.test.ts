// Tests for @utils/question-answer.ts — the shared question-answer resolver
// used by both the interactive CLI prompt loop and the WebUI question card.

import { describe, it, expect } from "bun:test";
import { resolveQuestionAnswer } from "@utils/question-answer.ts";

describe("resolveQuestionAnswer", () => {
  const noSel = { text: "", selectedOption: null as string | null };

  it("uses free text over option selection", () => {
    const q = { key: "k", options: ["a", "b"] };
    const res = resolveQuestionAnswer(q, { text: "custom", selectedOption: "a" });
    expect(res).toEqual({ value: "custom", error: null });
  });

  it("uses selected option when no text", () => {
    const q = { key: "k", options: ["a", "b"] };
    const res = resolveQuestionAnswer(q, { text: "", selectedOption: "b" });
    expect(res).toEqual({ value: "b", error: null });
  });

  it("falls back to default when nothing selected and default is an option", () => {
    const q = { key: "k", options: ["a", "b"], default: "a" };
    const res = resolveQuestionAnswer(q, noSel);
    expect(res).toEqual({ value: "a", error: null });
  });

  it("free text without options", () => {
    const q = { key: "k" };
    const res = resolveQuestionAnswer(q, { text: "hello", selectedOption: null });
    expect(res).toEqual({ value: "hello", error: null });
  });

  it("default without options", () => {
    const q = { key: "k", default: "fallback" };
    const res = resolveQuestionAnswer(q, noSel);
    expect(res).toEqual({ value: "fallback", error: null });
  });

  it("required rejects empty value", () => {
    const q = { key: "k", required: true };
    const res = resolveQuestionAnswer(q, noSel);
    expect(res.error).toBe("This question is required.");
    expect(res.value).toBe("");
  });

  it("optional question allows empty value", () => {
    const q = { key: "k", required: false, default: "" };
    const res = resolveQuestionAnswer(q, noSel);
    expect(res).toEqual({ value: "", error: null });
  });

  it("strict options (allowOther=false) rejects non-matching text", () => {
    const q = { key: "k", options: ["a", "b"], allowOther: false };
    const res = resolveQuestionAnswer(q, { text: "zzz", selectedOption: null });
    expect(res.error).toBe("Must be one of: a, b");
  });

  it("strict options accepts text that matches an option", () => {
    const q = { key: "k", options: ["a", "b"], allowOther: false };
    const res = resolveQuestionAnswer(q, { text: "a", selectedOption: null });
    expect(res).toEqual({ value: "a", error: null });
  });

  it("strict options falls back to default when it is an option", () => {
    const q = { key: "k", options: ["a", "b"], default: "b", allowOther: false };
    const res = resolveQuestionAnswer(q, noSel);
    expect(res).toEqual({ value: "b", error: null });
  });

  it("strict options does not apply a default outside the options", () => {
    const q = { key: "k", options: ["a", "b"], default: "zzz", allowOther: false };
    const res = resolveQuestionAnswer(q, noSel);
    expect(res.error).toBe("This question is required.");
  });

  it("trims whitespace from text", () => {
    const q = { key: "k" };
    const res = resolveQuestionAnswer(q, { text: "  padded  ", selectedOption: null });
    expect(res).toEqual({ value: "padded", error: null });
  });

  it("empty text with selected option in allowOther mode", () => {
    const q = { key: "k", options: ["x", "y"] };
    const res = resolveQuestionAnswer(q, { text: "   ", selectedOption: "y" });
    expect(res).toEqual({ value: "y", error: null });
  });
});
