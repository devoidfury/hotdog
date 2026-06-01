// Tests for tool:call and tool:result hooks, and CONTEXT hook via emitAsyncSeq.

import { describe, test, expect } from "bun:test";
import { HookSystem, HOOKS } from "../../src/hooks.js";

describe("HookSystem.emitAsyncSeq", () => {
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

    const result = await hooks.emitAsyncSeq(HOOKS.CONTEXT, {
      messages: [],
      agent: null,
    });

    expect(order).toEqual([1, 2]);
    expect(result).toEqual({ messages: ["a", "b"] });
  });

  test("returns undefined when no handlers", async () => {
    const hooks = new HookSystem();
    const result = await hooks.emitAsyncSeq(HOOKS.CONTEXT, { messages: [] });
    expect(result).toBeUndefined();
  });

  test("handler can see prior transformations via data object", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, (data) => {
      data.messages.push("first");
      return { messages: data.messages };
    });
    hooks.on(HOOKS.CONTEXT, (data) => {
      // Second handler sees the accumulated messages
      data.messages.push("second");
      return { messages: data.messages };
    });

    const result = await hooks.emitAsyncSeq(HOOKS.CONTEXT, {
      messages: [],
      agent: null,
    });

    expect(result.messages).toEqual(["first", "second"]);
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

    const result = await hooks.emitAsyncSeq(HOOKS.CONTEXT, {
      messages: [],
      agent: null,
    });

    expect(order).toEqual([1, 2]);
    expect(result.messages).toEqual(["a", "b"]);
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

    const result = await hooks.emitAsyncSeq(HOOKS.CONTEXT, {
      messages: [],
      agent: null,
    });

    expect(order).toEqual([1, 3]);
    expect(result.messages).toEqual(["a", "b"]);
  });
});

describe("HookSystem.emitAsyncSeqUntil", () => {
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

    const result = await hooks.emitAsyncSeqUntil(
      HOOKS.INPUT,
      { text: "original" },
      (r) => r?.action === "handled",
    );

    expect(order).toEqual([1, 2]);
    expect(result.stopped).toBe(true);
    expect(result.data.text).toBe("transformed");
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

    const result = await hooks.emitAsyncSeqUntil(
      HOOKS.INPUT,
      { text: "original" },
      (r) => r?.action === "handled",
    );

    expect(order).toEqual([1, 2]);
    expect(result.stopped).toBe(false);
    expect(result.data.text).toBe("step2");
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

    const result = await hooks.emitAsyncSeqUntil(
      HOOKS.INPUT,
      { text: "test", counter: 0 },
      () => false,
    );

    expect(result.data.counter).toBe(2);
  });
});

describe("tool:call hook", () => {
  test("hook can block tool execution", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, ({ toolName, input }) => {
      if (toolName === "dangerous-tool") {
        return { action: "block", result: "Blocked for safety" };
      }
      return { action: "continue" };
    });

    // Test blocking
    const blockResult = await hooks.emitAsyncSeq(HOOKS.TOOL_CALL, {
      toolCallId: "1",
      toolName: "dangerous-tool",
      input: '{"cmd": "rm -rf /"}',
      agent: null,
    });
    expect(blockResult.action).toBe("block");
    expect(blockResult.result).toBe("Blocked for safety");

    // Test allowing
    const allowResult = await hooks.emitAsyncSeq(HOOKS.TOOL_CALL, {
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
        // Sanitize: add safety prefix
        args.command = `set -euo pipefail; ${args.command}`;
        return { action: "modify", input: JSON.stringify(args) };
      }
      return { action: "continue" };
    });

    const result = await hooks.emitAsyncSeq(HOOKS.TOOL_CALL, {
      toolCallId: "1",
      toolName: "bash",
      input: '{"command": "ls"}',
      agent: null,
    });

    expect(result.action).toBe("modify");
    const modifiedArgs = JSON.parse(result.input);
    expect(modifiedArgs.command).toBe("set -euo pipefail; ls");
  });

  test("multiple handlers can chain modifications via data mutation", async () => {
    const hooks = new HookSystem();

    // First handler: add cwd (mutate data.input in place for chaining)
    hooks.on(HOOKS.TOOL_CALL, (data) => {
      if (data.toolName === "read") {
        const args = JSON.parse(data.input);
        args.cwd = "/workspace";
        data.input = JSON.stringify(args);
      }
      return { action: "continue" };
    });

    // Second handler: validate path (sees the mutated input)
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
    await hooks.emitAsyncSeq(HOOKS.TOOL_CALL, data);

    // The data object was mutated by both handlers
    const finalArgs = JSON.parse(data.input);
    expect(finalArgs.cwd).toBe("/workspace");
    expect(finalArgs.path).toBe("/workspace/test.txt");
  });
});

describe("tool:result hook", () => {
  test("hook can modify tool result", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_RESULT, ({ toolName, result }) => {
      if (typeof result === "string" && result.includes("sk-")) {
        return { result: result.replace(/sk-[a-zA-Z0-9]+/g, "[REDACTED]") };
      }
      return { result };
    });

    const result = await hooks.emitAsyncSeq(HOOKS.TOOL_RESULT, {
      toolCallId: "1",
      toolName: "bash",
      result: "API key is sk-abc123def456",
      input: '{"command": "cat .env"}',
      agent: null,
    });

    expect(result.result).toBe("API key is [REDACTED]");
  });

  test("hook can truncate large results", async () => {
    const hooks = new HookSystem();
    const MAX_LINES = 100;

    hooks.on(HOOKS.TOOL_RESULT, ({ result }) => {
      if (typeof result === "string") {
        const lines = result.split("\n");
        if (lines.length > MAX_LINES) {
          return {
            result: lines.slice(0, MAX_LINES).join("\n") + `\n... [${lines.length - MAX_LINES} more lines]`,
          };
        }
      }
      return { result };
    });

    const bigResult = Array(200).fill("line").join("\n");
    const result = await hooks.emitAsyncSeq(HOOKS.TOOL_RESULT, {
      toolCallId: "1",
      toolName: "bash",
      result: bigResult,
      input: "{}",
      agent: null,
    });

    expect(result.result).toContain("[100 more lines]");
    expect(result.result.split("\n").length).toBe(MAX_LINES + 1);
  });

  test("hook can replace result with ToolResult-like object", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_RESULT, ({ toolName, result }) => {
      // Wrap in structured format
      return {
        result: {
          output: result,
          metadata: { tool: toolName, timestamp: Date.now() },
        },
      };
    });

    const result = await hooks.emitAsyncSeq(HOOKS.TOOL_RESULT, {
      toolCallId: "1",
      toolName: "read",
      result: "file contents",
      input: '{"path": "test.txt"}',
      agent: null,
    });

    expect(result.result.output).toBe("file contents");
    expect(result.result.metadata.tool).toBe("read");
  });
});

describe("CONTEXT hook via emitAsyncSeq", () => {
  test("handlers can filter messages", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, ({ messages }) => {
      // Filter out empty messages
      return { messages: messages.filter((m) => m.content?.length > 0) };
    });

    const result = await hooks.emitAsyncSeq(HOOKS.CONTEXT, {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "" },
        { role: "user", content: "world" },
      ],
      agent: null,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toBe("hello");
    expect(result.messages[1].content).toBe("world");
  });

  test("handlers can inject messages", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, ({ messages, agent }) => {
      // Add context injection
      const injected = [
        { role: "system", content: "You are helpful." },
        ...messages,
      ];
      return { messages: injected };
    });

    const result = await hooks.emitAsyncSeq(HOOKS.CONTEXT, {
      messages: [{ role: "user", content: "hi" }],
      agent: null,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[1].content).toBe("hi");
  });
});
