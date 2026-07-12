// Tests for tool:call and tool:result hooks, and CONTEXT hook via emitAsyncSeq.

import { describe, test, expect } from "bun:test";
import { HookSystem, HOOKS } from "../../src/core/hooks.ts";

describe("HookSystem.runHookPipeline", () => {
  test("runs handlers sequentially and returns last result", async () => {
    const hooks = new HookSystem();
    const order = [];

    hooks.on(HOOKS.CONTEXT, () => {
      order.push(1);
      return { messages: ["a"] };
    });
    hooks.on(HOOKS.CONTEXT, () => {
      order.push(2);
      return { messages: ["a", "b"] };
    });

    const { lastResult } = await hooks.runHookPipeline(HOOKS.CONTEXT, {
      messages: [],
      agent: null,
    });

    expect(order).toEqual([1, 2]);
    expect(lastResult).toEqual({ messages: ["a", "b"] });
  });

  test("lastResult is undefined when no handlers", async () => {
    const hooks = new HookSystem();
    const { lastResult } = await hooks.runHookPipeline(HOOKS.CONTEXT, { messages: [] });
    expect(lastResult).toBeUndefined();
  });

  test("handler can see prior transformations via data object", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, (data) => {
      data.messages.push("first");
      return { messages: data.messages };
    });
    hooks.on(HOOKS.CONTEXT, (data) => {
      data.messages.push("second");
      return { messages: data.messages };
    });

    const { lastResult } = await hooks.runHookPipeline(HOOKS.CONTEXT, {
      messages: [],
      agent: null,
    });

    expect(lastResult.messages).toEqual(["first", "second"]);
  });

  test("async handlers are awaited in order", async () => {
    const hooks = new HookSystem();
    const order = [];

    hooks.on(HOOKS.CONTEXT, async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
      return { messages: ["a"] };
    });
    hooks.on(HOOKS.CONTEXT, async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(2);
      return { messages: ["a", "b"] };
    });

    const { lastResult } = await hooks.runHookPipeline(HOOKS.CONTEXT, {
      messages: [],
      agent: null,
    });

    expect(order).toEqual([1, 2]);
    expect(lastResult.messages).toEqual(["a", "b"]);
  });

  test("errors in handlers are caught and logged", async () => {
    const hooks = new HookSystem();
    const order = [];

    hooks.on(HOOKS.CONTEXT, () => {
      order.push(1);
      return { messages: ["a"] };
    });
    hooks.on(HOOKS.CONTEXT, () => {
      throw new Error("boom");
    });
    hooks.on(HOOKS.CONTEXT, () => {
      order.push(3);
      return { messages: ["a", "b"] };
    });

    const { lastResult } = await hooks.runHookPipeline(HOOKS.CONTEXT, {
      messages: [],
      agent: null,
    });

    expect(order).toEqual([1, 3]);
    expect(lastResult.messages).toEqual(["a", "b"]);
  });
});

describe("HookSystem.runHookPipeline with shouldStop", () => {
  test("stops early when shouldStop returns true", async () => {
    const hooks = new HookSystem();
    const order = [];

    hooks.on(HOOKS.INPUT, (data) => {
      order.push(1);
      data.text = "transformed";
      return { action: "continue" };
    });
    hooks.on(HOOKS.INPUT, (data) => {
      order.push(2);
      return { action: "handled" };
    });
    hooks.on(HOOKS.INPUT, (data) => {
      order.push(3);
      return { action: "continue" };
    });

    const { stopped, data } = await hooks.runHookPipeline(
      HOOKS.INPUT,
      { text: "original" },
      { shouldStop: (r) => r?.action === "handled" },
    );

    expect(order).toEqual([1, 2]);
    expect(stopped).toBe(true);
    expect(data.text).toBe("transformed");
  });

  test("runs all handlers when shouldStop never returns true", async () => {
    const hooks = new HookSystem();
    const order = [];

    hooks.on(HOOKS.INPUT, (data) => {
      order.push(1);
      data.text = "step1";
      return { action: "transform", text: data.text };
    });
    hooks.on(HOOKS.INPUT, (data) => {
      order.push(2);
      data.text = "step2";
      return { action: "transform", text: data.text };
    });

    const { stopped, data } = await hooks.runHookPipeline(
      HOOKS.INPUT,
      { text: "original" },
      { shouldStop: (r) => r?.action === "handled" },
    );

    expect(order).toEqual([1, 2]);
    expect(stopped).toBe(false);
    expect(data.text).toBe("step2");
  });

  test("mutable data is shared between handlers", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.INPUT, (data) => {
      data.counter = (data.counter || 0) + 1;
      return { action: "continue" };
    });
    hooks.on(HOOKS.INPUT, (data) => {
      data.counter = (data.counter || 0) + 1;
      return { action: "continue" };
    });

    const { data } = await hooks.runHookPipeline(
      HOOKS.INPUT,
      { text: "test", counter: 0 },
      { shouldStop: () => false },
    );

    expect(data.counter).toBe(2);
  });
});

describe("tool:call hook", () => {
  test("hook can block tool execution", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, ({ toolName }) => {
      if (toolName === "dangerous-tool") {
        return { action: "block", result: "Blocked for safety" };
      }
      return { action: "continue" };
    });

    const { lastResult: blockResult } = await hooks.runHookPipeline(HOOKS.TOOL_CALL, {
      toolCallId: "1",
      toolName: "dangerous-tool",
      input: '{"cmd": "rm -rf /"}',
      agent: null,
    });
    expect(blockResult.action).toBe("block");

    const { lastResult: allowResult } = await hooks.runHookPipeline(HOOKS.TOOL_CALL, {
      toolCallId: "2",
      toolName: "safe-tool",
      input: '{"path": "/tmp/test"}',
      agent: null,
    });
    expect(allowResult.action).toBe("continue");
  });

  test("hook can modify tool input", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, ({ toolName, input }) => {
      if (toolName === "bash") {
        const args = JSON.parse(input);
        args.command = `set -euo pipefail; ${args.command}`;
        return { action: "modify", input: JSON.stringify(args) };
      }
      return { action: "continue" };
    });

    const { lastResult } = await hooks.runHookPipeline(HOOKS.TOOL_CALL, {
      toolCallId: "1",
      toolName: "bash",
      input: '{"command": "ls"}',
      agent: null,
    });

    expect(lastResult.action).toBe("modify");
    expect(JSON.parse(lastResult.input).command).toBe("set -euo pipefail; ls");
  });

  test("multiple handlers can chain modifications via data mutation", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, (data) => {
      if (data.toolName === "read") {
        const args = JSON.parse(data.input);
        args.cwd = "/workspace";
        data.input = JSON.stringify(args);
      }
      return { action: "continue" };
    });

    hooks.on(HOOKS.TOOL_CALL, (data) => {
      if (data.toolName === "read") {
        const args = JSON.parse(data.input);
        args.path = args.path.startsWith("/") ? args.path : `${args.cwd}/${args.path}`;
        data.input = JSON.stringify(args);
      }
      return { action: "continue" };
    });

    const data = {
      toolCallId: "1",
      toolName: "read",
      input: '{"path": "test.txt"}',
      agent: null,
    };
    await hooks.runHookPipeline(HOOKS.TOOL_CALL, data);

    const finalArgs = JSON.parse(data.input);
    expect(finalArgs.cwd).toBe("/workspace");
    expect(finalArgs.path).toBe("/workspace/test.txt");
  });
});

describe("tool:result hook", () => {
  test("hook can redact sensitive data in results", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_RESULT, ({ result }) => {
      if (typeof result === "string" && result.includes("sk-")) {
        return { result: result.replace(/sk-[a-zA-Z0-9]+/g, "[REDACTED]") };
      }
      return { result };
    });

    const { lastResult } = await hooks.runHookPipeline(HOOKS.TOOL_RESULT, {
      toolCallId: "1",
      toolName: "bash",
      result: "API key is sk-abc123def456",
      input: '{"command": "cat .env"}',
      agent: null,
    });

    expect(lastResult.result).toBe("API key is [REDACTED]");
  });

  test("hook can truncate large results", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_RESULT, ({ result }) => {
      if (typeof result === "string") {
        const lines = result.split("\n");
        if (lines.length > 100) {
          return {
            result: lines.slice(0, 100).join("\n") + `\n... [${lines.length - 100} more lines]`,
          };
        }
      }
      return { result };
    });

    const bigResult = Array(200).fill("line").join("\n");
    const { lastResult } = await hooks.runHookPipeline(HOOKS.TOOL_RESULT, {
      toolCallId: "1",
      toolName: "bash",
      result: bigResult,
      input: "{}",
      agent: null,
    });

    expect(lastResult.result).toContain("[100 more lines]");
    expect(lastResult.result.split("\n").length).toBe(101);
  });
});

describe("CONTEXT hook via runHookPipeline", () => {
  test("handlers can filter messages", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, ({ messages }) => {
      return { messages: messages.filter((m) => m.content?.length > 0) };
    });

    const { lastResult } = await hooks.runHookPipeline(HOOKS.CONTEXT, {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "" },
        { role: "user", content: "world" },
      ],
      agent: null,
    });

    expect(lastResult.messages).toHaveLength(2);
    expect(lastResult.messages[0].content).toBe("hello");
    expect(lastResult.messages[1].content).toBe("world");
  });

  test("handlers can inject messages", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, ({ messages }) => {
      return {
        messages: [
          { role: "system", content: "You are helpful." },
          ...messages,
        ],
      };
    });

    const { lastResult } = await hooks.runHookPipeline(HOOKS.CONTEXT, {
      messages: [{ role: "user", content: "hi" }],
      agent: null,
    });

    expect(lastResult.messages).toHaveLength(2);
    expect(lastResult.messages[0].role).toBe("system");
    expect(lastResult.messages[1].content).toBe("hi");
  });
});
