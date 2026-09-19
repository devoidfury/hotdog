// Tests for tool:call and tool:result hooks, and CONTEXT hook via runHookPipeline.
// Note: General runHookPipeline behavior is tested in core-hooks.test.ts.
// This file focuses on tool-specific hook patterns.

import { describe, test, expect } from "bun:test";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import type { Agent } from "@core/agent.ts";
import type { HookPayloads } from "@core/extensions/types.ts";
import { Message } from "@core/context/message.ts";

const mockAgent = {} as Agent;

// Pipeline payloads: adoption writes the handler's returned fields onto them.
type CallPayload = HookPayloads["tool:call"];
type ResultPayload = HookPayloads["tool:result"];
type ContextPayload = HookPayloads["context"];

describe("tool:call hook", () => {
  test("hook can block tool execution", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, (({ toolName }: { toolName: string }) => {
      if (toolName === "dangerous-tool") {
        return { action: "block", result: "Blocked for safety" };
      }
      return { action: "continue" };
    }) as (data: unknown) => unknown);

    const blockPayload: CallPayload = {
      toolCallId: "1",
      toolName: "dangerous-tool",
      input: '{"cmd": "rm -rf /"}',
      agent: mockAgent,
    };
    await hooks.runHookPipeline(HOOKS.TOOL_CALL, blockPayload);
    expect(blockPayload.action).toBe("block");

    const allowPayload: CallPayload = {
      toolCallId: "2",
      toolName: "safe-tool",
      input: '{"path": "/tmp/test"}',
      agent: mockAgent,
    };
    await hooks.runHookPipeline(HOOKS.TOOL_CALL, allowPayload);
    expect(allowPayload.action).toBe("continue");
  });

  test("hook can modify tool input", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, (({ toolName, input }: { toolName: string; input: string }) => {
      if (toolName === "bash") {
        const args = JSON.parse(input);
        args.command = `set -euo pipefail; ${args.command}`;
        return { action: "modify", input: JSON.stringify(args) };
      }
      return { action: "continue" };
    }) as (data: unknown) => unknown);

    const patched: CallPayload = {
      toolCallId: "1",
      toolName: "bash",
      input: '{"command": "ls"}',
      agent: mockAgent,
    };
    await hooks.runHookPipeline(HOOKS.TOOL_CALL, patched);

    expect(patched.action).toBe("modify");
    expect(JSON.parse(patched.input).command).toBe("set -euo pipefail; ls");
  });

  test("multiple handlers can chain modifications via data mutation", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, ((data: { toolName: string; input: string }) => {
      if (data.toolName === "read") {
        const args = JSON.parse(data.input);
        args.cwd = "/workspace";
        data.input = JSON.stringify(args);
      }
      return { action: "continue" };
    }) as (data: unknown) => unknown);

    hooks.on(HOOKS.TOOL_CALL, ((data: { toolName: string; input: string }) => {
      if (data.toolName === "read") {
        const args = JSON.parse(data.input);
        args.path = args.path.startsWith("/") ? args.path : `${args.cwd}/${args.path}`;
        data.input = JSON.stringify(args);
      }
      return { action: "continue" };
    }) as (data: unknown) => unknown);

    const data = {
      toolCallId: "1",
      toolName: "read",
      input: '{"path": "test.txt"}',
      agent: mockAgent,
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

    hooks.on(HOOKS.TOOL_RESULT, (({ result }: { result: string }) => {
      if (typeof result === "string" && result.includes("sk-")) {
        return { result: result.replace(/sk-[a-zA-Z0-9]+/g, "[REDACTED]") };
      }
      return { result };
    }) as (data: unknown) => unknown);

    const patched: ResultPayload = {
      toolCallId: "1",
      toolName: "bash",
      result: "API key is sk-abc123def456",
      input: '{"command": "cat .env"}',
      success: true,
      agent: mockAgent,
    };
    await hooks.runHookPipeline(HOOKS.TOOL_RESULT, patched);

    expect(patched.result).toBe("API key is [REDACTED]");
  });

  test("hook can truncate large results", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_RESULT, (({ result }: { result: string }) => {
      if (typeof result === "string") {
        const lines = result.split("\n");
        if (lines.length > 100) {
          return {
            result: lines.slice(0, 100).join("\n") + `\n... [${lines.length - 100} more lines]`,
          };
        }
      }
      return { result };
    }) as (data: unknown) => unknown);

    const bigResult = Array(200).fill("line").join("\n");
    const patched: ResultPayload = {
      toolCallId: "1",
      toolName: "bash",
      result: bigResult,
      input: "{}",
      success: true,
      agent: mockAgent,
    };
    await hooks.runHookPipeline(HOOKS.TOOL_RESULT, patched);

    expect(patched.result).toContain("[100 more lines]");
    expect((patched.result as string).split("\n").length).toBe(101);
  });
});

describe("CONTEXT hook via runHookPipeline", () => {
  test("handlers can filter messages", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, (({ messages }: { messages: { content: string }[] }) => ({
      messages: messages.filter((m: { content: string }) => m.content?.length > 0),
    })) as (data: unknown) => unknown);

    const patched: ContextPayload = {
      messages: [
        new Message({ role: "user", content: "hello" }),
        new Message({ role: "assistant", content: "" }),
        new Message({ role: "user", content: "world" }),
      ],
      agent: mockAgent,
    };
    await hooks.runHookPipeline(HOOKS.CONTEXT, patched);

    expect(patched.messages).toHaveLength(2);
    expect(patched.messages[0]?.content).toBe("hello");
    expect(patched.messages[1]?.content).toBe("world");
  });

  test("handlers can inject messages", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, (({ messages }: { messages: { role: string; content: string }[] }) => ({
      messages: [{ role: "system", content: "You are helpful." }, ...messages],
    })) as (data: unknown) => unknown);

    const patched: ContextPayload = {
      messages: [new Message({ role: "user", content: "hi" })],
      agent: mockAgent,
    };
    await hooks.runHookPipeline(HOOKS.CONTEXT, patched);

    expect(patched.messages).toHaveLength(2);
    expect(patched.messages[0]?.role).toBe("system");
    expect(patched.messages[1]?.content).toBe("hi");
  });

  test("a replaced { messages } threads: later handlers see earlier replacements", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, (({ messages }: { messages: unknown[] }) => ({
      messages: [...messages, { role: "user", content: "one" }],
    })) as (data: unknown) => unknown);
    hooks.on(HOOKS.CONTEXT, (({ messages }: { messages: unknown[] }) => ({
      messages: [...messages, { role: "user", content: "two" }],
    })) as (data: unknown) => unknown);

    const patched: ContextPayload = {
      messages: [new Message({ role: "user", content: "seed" })],
      agent: mockAgent,
    };
    await hooks.runHookPipeline(HOOKS.CONTEXT, patched);

    expect(patched.messages.map((m) => m.content)).toEqual([
      "seed",
      "one",
      "two",
    ]);
  });
});
