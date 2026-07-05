// Advanced tests for HookSystem — off(), clear(), edge cases.

import { describe, it, expect, beforeEach } from "bun:test";
import { HookSystem, createHooks, HOOKS } from "../../src/core/hooks.js";

describe("HookSystem.off()", () => {
  it("removes a specific handler by reference", () => {
    const hooks = createHooks();
    const handler = () => {};
    hooks.on("test", handler);
    expect(hooks.handlerCount("test")).toBe(1);
    expect(hooks.off("test", handler)).toBe(true);
    expect(hooks.handlerCount("test")).toBe(0);
  });

  it("returns false when handler not found", () => {
    const hooks = createHooks();
    const handler = () => {};
    expect(hooks.off("test", handler)).toBe(false);
  });

  it("returns false for non-existent hook", () => {
    const hooks = createHooks();
    expect(hooks.off("nonexistent", () => {})).toBe(false);
  });

  it("only removes the specific handler, not others", () => {
    const hooks = createHooks();
    const handler1 = () => {};
    const handler2 = () => {};
    hooks.on("test", handler1);
    hooks.on("test", handler2);
    expect(hooks.off("test", handler1)).toBe(true);
    expect(hooks.handlerCount("test")).toBe(1);
    // Verify handler2 is still registered
    hooks.notifyHooks("test", {});
  });

  it("can remove multiple handlers independently", () => {
    const hooks = createHooks();
    const h1 = () => {};
    const h2 = () => {};
    const h3 = () => {};
    hooks.on("test", h1);
    hooks.on("test", h2);
    hooks.on("test", h3);
    expect(hooks.off("test", h2)).toBe(true);
    expect(hooks.handlerCount("test")).toBe(2);
    expect(hooks.off("test", h1)).toBe(true);
    expect(hooks.handlerCount("test")).toBe(1);
  });
});

describe("HookSystem.clear()", () => {
  it("clears all handlers for a specific hook", () => {
    const hooks = createHooks();
    hooks.on("hook-a", () => {});
    hooks.on("hook-a", () => {});
    hooks.on("hook-b", () => {});
    hooks.clear("hook-a");
    expect(hooks.handlerCount("hook-a")).toBe(0);
    expect(hooks.handlerCount("hook-b")).toBe(1);
  });

  it("clears all handlers for all hooks when called without argument", () => {
    const hooks = createHooks();
    hooks.on("hook-a", () => {});
    hooks.on("hook-b", () => {});
    hooks.clear();
    expect(hooks.handlerCount("hook-a")).toBe(0);
    expect(hooks.handlerCount("hook-b")).toBe(0);
    expect(hooks.hookNames()).toEqual([]);
  });

  it("does nothing when clearing non-existent hook", () => {
    const hooks = createHooks();
    hooks.clear("nonexistent");
    expect(hooks.handlerCount("nonexistent")).toBe(0);
  });

  it("clear is idempotent", () => {
    const hooks = createHooks();
    hooks.on("test", () => {});
    hooks.clear("test");
    hooks.clear("test"); // Should not throw
    expect(hooks.handlerCount("test")).toBe(0);
  });
});

describe("HookSystem — removal function from on()", () => {
  it("returns a removal function", () => {
    const hooks = createHooks();
    const remove = hooks.on("test", () => {});
    expect(typeof remove).toBe("function");
    expect(hooks.handlerCount("test")).toBe(1);
    remove();
    expect(hooks.handlerCount("test")).toBe(0);
  });

  it("removal function is idempotent", () => {
    const hooks = createHooks();
    const remove = hooks.on("test", () => {});
    remove();
    remove(); // Should not throw
    expect(hooks.handlerCount("test")).toBe(0);
  });

  it("can register a new handler after removal", () => {
    const hooks = createHooks();
    const remove = hooks.on("test", () => {});
    remove();
    hooks.on("test", () => {});
    expect(hooks.handlerCount("test")).toBe(1);
  });

  it("removal function only removes the registered handler", () => {
    const hooks = createHooks();
    const remove = hooks.on("test", () => {});
    hooks.on("test", () => {});
    remove();
    expect(hooks.handlerCount("test")).toBe(1);
  });
});

describe("HookSystem — handler ID uniqueness", () => {
  it("assigns unique IDs to handlers", () => {
    const hooks = new HookSystem();
    hooks.on("test", () => {});
    hooks.on("test", () => {});
    const handlers = hooks._hooks.get("test");
    expect(handlers[0].id).not.toBe(handlers[1].id);
  });

  it("handler counter increments across different hooks", () => {
    const hooks = new HookSystem();
    hooks.on("hook-a", () => {});
    hooks.on("hook-b", () => {});
    const handlersA = hooks._hooks.get("hook-a");
    const handlersB = hooks._hooks.get("hook-b");
    expect(handlersB[0].id).toBeGreaterThan(handlersA[0].id);
  });
});

describe("HookSystem — source tracking", () => {
  it("tracks source when provided", () => {
    const hooks = new HookSystem();
    hooks.on("test", () => {}, "my-extension");
    const handlers = hooks._hooks.get("test");
    expect(handlers[0].source).toBe("my-extension");
  });

  it("source is undefined when not provided", () => {
    const hooks = new HookSystem();
    hooks.on("test", () => {});
    const handlers = hooks._hooks.get("test");
    expect(handlers[0].source).toBeUndefined();
  });
});

describe("notifyHooks — trace mode", () => {
  let origStderr;

  beforeEach(() => {
    origStderr = process.stderr.write;
    process.stderr.write = () => true;
  });

  it("trace mode does not throw", () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("test", () => {});
    // Should not throw
    hooks.notifyHooks("test", {});
  });

  it("trace mode skips 'log' hook", () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("log", () => {});
    // Should not throw
    hooks.notifyHooks("log", { level: "info", message: "test" });
  });

  it("notifyHooks runs handlers in order", () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", () => calls.push(1));
    hooks.on("test", () => calls.push(2));
    hooks.on("test", () => calls.push(3));
    hooks.notifyHooks("test", {});
    expect(calls).toEqual([1, 2, 3]);
  });

  it("notifyHooks passes data to handlers", () => {
    const hooks = createHooks();
    let received = null;
    hooks.on("test", (data) => { received = data; });
    hooks.notifyHooks("test", { key: "value" });
    expect(received).toEqual({ key: "value" });
  });

  it("notifyHooks does nothing for unregistered hook", () => {
    const hooks = createHooks();
    // Should not throw
    hooks.notifyHooks("nonexistent", {});
  });
});

describe("runHookPipeline — shouldStop patterns", () => {
  it("stops on first matching result", async () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", () => {
      calls.push(1);
      return { action: "continue" };
    });
    hooks.on("test", () => {
      calls.push(2);
      return { action: "handled" };
    });
    hooks.on("test", () => {
      calls.push(3);
      return { action: "continue" };
    });

    const result = await hooks.runHookPipeline("test", {}, {
      shouldStop: (r) => r.action === "handled",
    });

    expect(calls).toEqual([1, 2]);
    expect(result.stopped).toBe(true);
  });

  it("does not stop when shouldStop returns false", async () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", () => { calls.push(1); return { action: "continue" }; });
    hooks.on("test", () => { calls.push(2); return { action: "continue" }; });

    const result = await hooks.runHookPipeline("test", {}, {
      shouldStop: (r) => r.action === "handled",
    });

    expect(calls).toEqual([1, 2]);
    expect(result.stopped).toBe(false);
  });

  it("data is mutable across handlers", async () => {
    const hooks = createHooks();
    const data = { count: 0 };
    hooks.on("test", (d) => { d.count++; });
    hooks.on("test", (d) => { d.count *= 2; });

    const result = await hooks.runHookPipeline("test", data);
    expect(data.count).toBe(2);
    expect(result.data).toBe(data);
  });

  it("lastResult is the last handler's return value", async () => {
    const hooks = createHooks();
    hooks.on("test", () => "first");
    hooks.on("test", () => "second");

    const result = await hooks.runHookPipeline("test", {});
    expect(result.lastResult).toBe("second");
  });

  it("lastResult is undefined when no handlers return values", async () => {
    const hooks = createHooks();
    hooks.on("test", () => {});
    hooks.on("test", () => {});

    const result = await hooks.runHookPipeline("test", {});
    expect(result.lastResult).toBeUndefined();
  });

  it("pipeline with shouldStop on first handler", async () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", () => {
      calls.push(1);
      return { action: "handled" };
    });
    hooks.on("test", () => {
      calls.push(2);
    });

    const result = await hooks.runHookPipeline("test", {}, {
      shouldStop: (r) => r.action === "handled",
    });

    expect(calls).toEqual([1]);
    expect(result.stopped).toBe(true);
  });
});

describe("runHookPipeline — trace mode", () => {
  let origStderr;

  beforeEach(() => {
    origStderr = process.stderr.write;
    process.stderr.write = () => true;
  });

  it("trace mode with pipeline does not throw", async () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("test", () => ({ action: "continue" }), "ext1");
    await hooks.runHookPipeline("test", {});
  });

  it("trace mode with stopped pipeline does not throw", async () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("test", () => ({ action: "handled" }), "ext1");
    await hooks.runHookPipeline("test", {}, {
      shouldStop: (r) => r.action === "handled",
    });
  });

  it("trace mode with error handler does not throw", async () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("test", () => { throw new Error("fail"); }, "ext1");
    hooks.on("test", () => "recovered", "ext2");
    await hooks.runHookPipeline("test", {});
  });
});

describe("notifyHooksAsync — trace mode", () => {
  let origStderr;

  beforeEach(() => {
    origStderr = process.stderr.write;
    process.stderr.write = () => true;
  });

  it("trace mode with async notify does not throw", async () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("test", async () => {}, "ext1");
    await hooks.notifyHooksAsync("test", {});
  });

  it("trace mode with sync handler in async notify does not throw", async () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("test", () => {}, "ext1");
    await hooks.notifyHooksAsync("test", {});
  });

  it("trace mode skips 'log' hook in async notify", async () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("log", () => {});
    await hooks.notifyHooksAsync("log", { level: "info", message: "test" });
  });

  it("async notify with multiple handlers", async () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", async () => { calls.push(1); });
    hooks.on("test", async () => { calls.push(2); });
    await hooks.notifyHooksAsync("test", {});
    expect(calls).toContain(1);
    expect(calls).toContain(2);
  });
});

describe("HOOKS constants", () => {
  it("has all expected hook names", () => {
    expect(HOOKS.SESSION_CREATE).toBe("session:create");
    expect(HOOKS.SESSION_SWAP).toBe("session:swap");
    expect(HOOKS.AGENT_TOOL_CONTEXT).toBe("agent:toolContext");
    expect(HOOKS.MODEL_CHANGE).toBe("model:change");
    expect(HOOKS.TOOLS_REGISTER).toBe("tools:register");
    expect(HOOKS.SERVICES_REGISTER).toBe("services:register");
    expect(HOOKS.COMMANDS_REGISTER).toBe("commands:register");
    expect(HOOKS.SHUTDOWN_CLEANUP).toBe("shutdown:cleanup");
    expect(HOOKS.CLI_SUBCOMMANDS_REGISTER).toBe("cli:subcommandsRegister");
    expect(HOOKS.CLI_ARGS_PARSED).toBe("cli:argsParsed");
    expect(HOOKS.INPUT).toBe("input");
    expect(HOOKS.CONTEXT).toBe("context");
    expect(HOOKS.TOOL_CALL).toBe("tool:call");
    expect(HOOKS.TOOL_RESULT).toBe("tool:result");
    expect(HOOKS.PROVIDER_REQUEST).toBe("provider:request");
    expect(HOOKS.PROVIDER_RESPONSE).toBe("provider:response");
    expect(HOOKS.TURN_START).toBe("turn:start");
    expect(HOOKS.TURN_END).toBe("turn:end");
    expect(HOOKS.LOG).toBe("log");
    expect(HOOKS.CONTEXT_MESSAGE).toBe("context:message");
    expect(HOOKS.CONTEXT_REPLACED).toBe("context:replaced");
    expect(HOOKS.SYSTEM_PROMPT_BUILD).toBe("systemPrompt:build");
    expect(HOOKS.OUTPUT_EVENT).toBe("output:event");
    expect(HOOKS.TOOL_BEFORE_EXECUTE).toBe("tool:beforeExecute");
    expect(HOOKS.TOOL_AFTER_EXECUTE).toBe("tool:afterExecute");
    expect(HOOKS.LOOP_DETECTED).toBe("loop:detected");
    expect(HOOKS.COMMAND_DISPATCH).toBe("command:dispatch");
    expect(HOOKS.MESSAGES_AFTER_LLM).toBe("messages:afterLLM");
    expect(HOOKS.SESSION_SERIALIZE).toBe("session:serialize");
    expect(HOOKS.SESSION_DESERIALIZE).toBe("session:deserialize");
    expect(HOOKS.SESSION_RESTORE_ACTIVE).toBe("session:restoreActive");
  });
});

describe("EXTENSION_PROVIDES constants", () => {
  it("has expected capability names", () => {
    expect(EXTENSION_PROVIDES.CLI_SUBCOMMANDS).toBe("cli:subcommands");
    expect(EXTENSION_PROVIDES.TOOLS).toBe("tools");
  });
});

describe("createHooks", () => {
  it("returns a HookSystem instance", () => {
    const hooks = createHooks();
    expect(hooks).toBeInstanceOf(HookSystem);
  });

  it("each call returns a new instance", () => {
    const hooks1 = createHooks();
    const hooks2 = createHooks();
    expect(hooks1).not.toBe(hooks2);
    hooks1.on("test", () => {});
    expect(hooks2.handlerCount("test")).toBe(0);
  });
});

import { EXTENSION_PROVIDES } from "../../src/core/hooks.js";
