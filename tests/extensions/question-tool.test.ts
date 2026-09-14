// Tests for the question tool — non-interactive mode only.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { QuestionTool, create } from "@extensions/question-tool/index.ts";
import type { CoreContext, ToolContext } from "@core/extensions/types.ts";

describe("QuestionTool", () => {
  let tool: QuestionTool;

  beforeEach(() => {
    tool = new QuestionTool();
  });

  describe("toToolDef", () => {
    it("has correct name and description", () => {
      const def = tool.toToolDef();
      expect(def.function.name).toBe("question");
      expect(def.function.description).toContain("Ask the user");
    });

    it("requires questions parameter", () => {
      const def = tool.toToolDef();
      expect(def.function.parameters.required).toContain("questions");
    });

    it("defines question item schema with key and prompt", () => {
      const def = tool.toToolDef();
      const questionsParam = (def.function.parameters.properties as Record<string, unknown>).questions as { items: { properties: Record<string, { type: string }>; required: string[] } };
      const props = questionsParam.items.properties;
      expect(props.key).toEqual(expect.objectContaining({ type: "string" }));
      expect(props.prompt).toEqual(expect.objectContaining({ type: "string" }));
      expect(props.options).toEqual(expect.objectContaining({ type: "array" }));
      expect(props.required).toEqual(expect.objectContaining({ type: "boolean" }));
      expect(props.default).toEqual(expect.objectContaining({ type: "string" }));
      expect(props.allow_other).toEqual(expect.objectContaining({ type: "boolean" }));
      expect(questionsParam.items.required).toEqual(["key", "prompt"]);
    });
  });

  describe("callDisplay", () => {
    it("shows question count", () => {
      const input = JSON.stringify({
        questions: [
          { key: "a", prompt: "Q1" },
          { key: "b", prompt: "Q2" },
        ],
      });
      expect(tool.callDisplay(input)).toBe("asking 2 question(s)...");
    });

    it("handles empty input with fallback", () => {
      expect(tool.callDisplay("")).toBe("asking questions...");
    });

    it("handles invalid JSON with fallback", () => {
      expect(tool.callDisplay("not json")).toBe("asking questions...");
    });
  });

  describe("execute - non-interactive (CI mode)", () => {
    const originalCI = process.env.CI;

    beforeEach(() => {
      process.env.CI = "1";
    });

    afterEach(() => {
      process.env.CI = originalCI;
    });

    it("returns defaults for all questions", async () => {
      const input = JSON.stringify({
        questions: [
          { key: "name", prompt: "Name?", default: "Anonymous" },
          { key: "notes", prompt: "Notes?", default: "None" },
        ],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output);
      expect(output.name).toBe("Anonymous");
      expect(output.notes).toBe("None");
    });

    it("returns empty string when no default", async () => {
      const input = JSON.stringify({
        questions: [{ key: "color", prompt: "Pick a color" }],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output);
      expect(output.color).toBe("");
    });

    it("rejects empty questions array", async () => {
      const input = JSON.stringify({ questions: [] });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(false);
      expect(result.error).toContain("At least one question");
    });

    it("rejects invalid JSON", async () => {
      const result = await tool.execute("not json", null!);
      expect(result.success).toBe(false);
    });

    it("handles field alias: question -> prompt", async () => {
      const input = JSON.stringify({
        questions: [
          { key: "choice", question: "Which one?", choices: ["A", "B"] },
        ],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
    });

    it("generates key from prompt when missing", async () => {
      const input = JSON.stringify({
        questions: [{ prompt: "What is your name?" }],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output);
      expect("what_is_your_name" in output).toBe(true);
    });

    it("includes metadata entries", async () => {
      const input = JSON.stringify({
        questions: [{ key: "a", prompt: "Q?" }],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
      expect(result.metadata!.get("mode")).toBe("non-interactive");
      expect(result.metadata!.get("questions_asked")).toBe("1");
      expect(result.metadata!.get("questions_answered")).toBe("1");
    });

    it("rejects empty key", async () => {
      const input = JSON.stringify({
        questions: [{ key: "", prompt: "Q?" }],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(false);
      expect(result.error).toContain("key cannot be empty");
    });

    it("rejects missing prompt", async () => {
      const input = JSON.stringify({
        questions: [{ key: "a" }],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(false);
      expect(result.error).toContain("missing a prompt");
    });
  });
});

// ── execute - run cancellation (abort during a pending prompt) ─────────────

describe("execute - run cancellation", () => {
  let tool: QuestionTool;

  const payload = JSON.stringify({ questions: [{ key: "a", prompt: "Q?" }] });

  beforeEach(() => {
    tool = new QuestionTool();
  });

  /** Poll a condition until true (deterministic replacement for fixed sleeps). */
  async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Fake interactive input whose collectAnswers never resolves on its own. */
  function makeHangingInput() {
    let resolveCollect: (a: Record<string, string>) => void = () => {};
    const collectPromise = new Promise<Record<string, string>>((r) => {
      resolveCollect = r;
    });
    let calls = 0;
    let lastSignal: AbortSignal | null | undefined;
    const input = {
      isInteractive: () => true,
      collectAnswers: (_q: unknown, signal?: AbortSignal | null) => {
        calls++;
        lastSignal = signal;
        return collectPromise;
      },
    };
    return {
      input,
      collectPromise,
      resolveCollect,
      get calls() { return calls; },
      get lastSignal() { return lastSignal; },
    };
  }

  function makeCtx(agent: Record<string, unknown> | null, input: unknown): ToolContext {
    const values: Record<string, unknown> = {};
    if (agent) values.agent = agent;
    if (input) values.input = input;
    return { get: (key: string) => values[key] } as unknown as ToolContext;
  }

  it("returns a cancelled error when the run aborts during collectAnswers", async () => {
    const controller = new AbortController();
    const hanging = makeHangingInput();
    const agent = { emitOutput: () => {}, runAbortController: controller };

    const pending = tool.execute(payload, makeCtx(agent, hanging.input));
    // Abort only after the prompt is actually pending (not before it).
    await waitFor(() => hanging.calls > 0);
    controller.abort();

    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain("cancelled");
    // The run's signal must reach the input: it is what makes the
    // interactive input bail out of its prompt loop and release readline.
    expect(hanging.lastSignal).toBe(controller.signal);

    // A late answer must not surface: resolve the dangling prompt and let
    // microtasks drain; nothing may throw (it is swallowed fire-and-forget).
    hanging.resolveCollect({ a: "late answer" });
    await new Promise((r) => setTimeout(r, 10));
  });

  it("removes the abort listener when the prompt resolves normally", async () => {
    const abortListeners: Array<() => void> = [];
    const signal = {
      aborted: false,
      addEventListener: (_t: string, cb: () => void) => { abortListeners.push(cb); },
      removeEventListener: (_t: string, cb: () => void) => {
        const i = abortListeners.indexOf(cb);
        if (i >= 0) abortListeners.splice(i, 1);
      },
    };
    const input = {
      isInteractive: () => true,
      collectAnswers: async () => ({ a: "yes" }),
    };
    const agent = { emitOutput: () => {}, runAbortController: { signal } };

    const result = await tool.execute(payload, makeCtx(agent, input));
    expect(result.success).toBe(true);
    const output = JSON.parse(result.output);
    expect(output.a).toBe("yes");
    expect(result.metadata!.get("mode")).toBe("interactive");
    // The listener must be gone in finally, or it would fire on the NEXT run.
    expect(abortListeners.length).toBe(0);
  });

  it("removes the abort listener and drops the late answer on cancellation", async () => {
    const abortListeners: Array<() => void> = [];
    const signal = {
      aborted: false,
      addEventListener: (_t: string, cb: () => void) => { abortListeners.push(cb); },
      removeEventListener: (_t: string, cb: () => void) => {
        const i = abortListeners.indexOf(cb);
        if (i >= 0) abortListeners.splice(i, 1);
      },
    };
    const hanging = makeHangingInput();
    const agent = { emitOutput: () => {}, runAbortController: { signal } };

    const pending = tool.execute(payload, makeCtx(agent, hanging.input));
    await waitFor(() => hanging.calls > 0);
    for (const cb of [...abortListeners]) cb();
    signal.aborted = true;

    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain("cancelled");
    expect(abortListeners.length).toBe(0);

    hanging.resolveCollect({ a: "late" });
    await new Promise((r) => setTimeout(r, 10));
  });

  it("cancels immediately when the run is already aborted before the prompt", async () => {
    const controller = new AbortController();
    controller.abort();
    const hanging = makeHangingInput();
    const agent = { emitOutput: () => {}, runAbortController: controller };

    const result = await tool.execute(payload, makeCtx(agent, hanging.input));
    expect(result.success).toBe(false);
    expect(result.error).toContain("cancelled");
    expect(hanging.calls).toBe(0); // the prompt never started
  });

  it("still returns answers when the run signal never aborts", async () => {
    const controller = new AbortController();
    const input = {
      isInteractive: () => true,
      collectAnswers: async () => ({ a: "yes" }),
    };
    const agent = { emitOutput: () => {}, runAbortController: controller };

    const result = await tool.execute(payload, makeCtx(agent, input));
    expect(result.success).toBe(true);
    const output = JSON.parse(result.output);
    expect(output.a).toBe("yes");
    expect(result.metadata!.get("mode")).toBe("interactive");
  });

  it("ignores a missing agent (standalone callers) and keeps the old path", async () => {
    const hanging = makeHangingInput();
    const pending = tool.execute(payload, makeCtx(null, hanging.input));
    // No agent, no signal: the promise is awaited normally.
    hanging.resolveCollect({ a: "no-agent" });
    const result = await pending;
    expect(result.success).toBe(true);
    const output = JSON.parse(result.output);
    expect(output.a).toBe("no-agent");
    // No agent, no signal: the input gets null (its legacy path).
    expect(hanging.lastSignal).toBeNull();
  });
});

describe("QuestionTool create() extension", () => {
  it("returns extension with tools:register hook", async () => {
    const ext = create({} as CoreContext);
    expect(ext).toBeDefined();
    expect(ext.hooks).toBeDefined();
    expect(ext.hooks!['tools:register']).toBeDefined();
    expect(ext.QuestionTool).toBe(QuestionTool);
  });

  it("registers question tool via hook", async () => {
    const ext = create({} as CoreContext);
    const registry = { register: (name: string, tool: unknown) => { expect(name).toBe('question'); expect(tool).toBeInstanceOf(QuestionTool); }, getAll: () => [] };
    await (ext.hooks!['tools:register'] as Function)(registry);
  });
});
