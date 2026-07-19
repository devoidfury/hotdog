// Tests for compaction/prompts.ts — verify prompt templates are well-formed.

import { describe, it, expect } from "bun:test";
import {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_USER_PROMPT_TEMPLATE,
  SUMMARIZATION_USER_PROMPT_SHORT,
} from "../../src/extensions/compaction/prompts.ts";

describe("SUMMARIZATION_SYSTEM_PROMPT", () => {
  it("is non-empty", () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("mentions summarization role", () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT.toLowerCase()).toContain("summarization");
  });

  it("instructs not to continue the conversation", () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT).toContain("Do NOT continue the conversation");
  });
});

describe("SUMMARIZATION_USER_PROMPT_TEMPLATE", () => {
  it("is non-empty", () => {
    expect(SUMMARIZATION_USER_PROMPT_TEMPLATE.length).toBeGreaterThan(0);
  });

  it("contains all required format sections", () => {
    const prompt = SUMMARIZATION_USER_PROMPT_TEMPLATE;
    expect(prompt).toContain("## Goal");
    expect(prompt).toContain("## Progress");
    expect(prompt).toContain("### Done");
    expect(prompt).toContain("### In Progress");
    expect(prompt).toContain("### Blocked");
    expect(prompt).toContain("## Key Decisions");
    expect(prompt).toContain("## Next Steps");
    expect(prompt).toContain("## Critical Context");
  });

  it("contains conversation placeholder", () => {
    expect(SUMMARIZATION_USER_PROMPT_TEMPLATE).toContain("{conversation}");
    expect(SUMMARIZATION_USER_PROMPT_TEMPLATE).toContain("<conversation>");
  });
});

describe("SUMMARIZATION_USER_PROMPT_SHORT", () => {
  it("is non-empty", () => {
    expect(SUMMARIZATION_USER_PROMPT_SHORT.length).toBeGreaterThan(0);
  });

  it("is shorter than the full template", () => {
    expect(SUMMARIZATION_USER_PROMPT_SHORT.length).toBeLessThan(
      SUMMARIZATION_USER_PROMPT_TEMPLATE.length,
    );
  });

  it("contains the same format sections", () => {
    const prompt = SUMMARIZATION_USER_PROMPT_SHORT;
    expect(prompt).toContain("## Goal");
    expect(prompt).toContain("## Progress");
    expect(prompt).toContain("### Done");
    expect(prompt).toContain("### In Progress");
    expect(prompt).toContain("## Key Decisions");
    expect(prompt).toContain("## Next Steps");
    expect(prompt).toContain("## Critical Context");
  });

  it("mentions concise/short output", () => {
    const prompt = SUMMARIZATION_USER_PROMPT_SHORT.toLowerCase();
    expect(prompt).toMatch(/concise|brief|short/);
  });

  it("contains conversation placeholder", () => {
    expect(SUMMARIZATION_USER_PROMPT_SHORT).toContain("{conversation}");
  });
});
