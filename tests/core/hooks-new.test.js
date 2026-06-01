// Tests for the new input and context hooks

import { describe, test, expect } from "bun:test";
import { createHooks, HOOKS } from "../../src/core/hooks.js";
import { Message } from "../../src/core/context/message.js";

describe("input hook", () => {
  test("handlers receive text, source, and agent", async () => {
    const hooks = createHooks();
    let received = null;

    hooks.on(HOOKS.INPUT, (data) => {
      received = data;
      return { action: "continue" };
    });

    // Simulate what message-bus does
    const handlers = hooks._hooks.get(HOOKS.INPUT) || [];
    for (const entry of handlers) {
      const result = entry.handler({
        text: "hello",
        source: "interactive",
        agent: { sessionId: "test" },
      });
      const resolved = result && typeof result.then === "function" ? await result : result;
      expect(resolved).toEqual({ action: "continue" });
    }

    expect(received).toBeTruthy();
    expect(received.text).toBe("hello");
    expect(received.source).toBe("interactive");
    expect(received.agent.sessionId).toBe("test");
  });

  test("transform action modifies text", async () => {
    const hooks = createHooks();

    hooks.on(HOOKS.INPUT, (data) => {
      return { action: "transform", text: `[transformed] ${data.text}` };
    });

    let currentText = "original";
    const handlers = hooks._hooks.get(HOOKS.INPUT) || [];
    for (const entry of handlers) {
      const result = entry.handler({ text: currentText, source: "interactive", agent: null });
      const resolved = result && typeof result.then === "function" ? await result : result;
      if (resolved?.action === "transform" && resolved.text !== undefined) {
        currentText = resolved.text;
      }
    }

    expect(currentText).toBe("[transformed] original");
  });

  test("handled action short-circuits remaining handlers", async () => {
    const hooks = createHooks();
    let secondCalled = false;

    hooks.on(HOOKS.INPUT, () => ({ action: "handled" }));
    hooks.on(HOOKS.INPUT, () => {
      secondCalled = true;
      return { action: "continue" };
    });

    let inputHandled = false;
    const handlers = hooks._hooks.get(HOOKS.INPUT) || [];
    for (const entry of handlers) {
      const result = entry.handler({ text: "test", source: "interactive", agent: null });
      const resolved = result && typeof result.then === "function" ? await result : result;
      if (resolved?.action === "handled") {
        inputHandled = true;
        break;
      }
    }

    expect(inputHandled).toBe(true);
    expect(secondCalled).toBe(false);
  });

  test("multiple transforms chain correctly", async () => {
    const hooks = createHooks();

    hooks.on(HOOKS.INPUT, (data) => ({ action: "transform", text: data.text.toUpperCase() }));
    hooks.on(HOOKS.INPUT, (data) => ({ action: "transform", text: `>>${data.text}<<` }));

    let currentText = "hello";
    const handlers = hooks._hooks.get(HOOKS.INPUT) || [];
    for (const entry of handlers) {
      const result = entry.handler({ text: currentText, source: "interactive", agent: null });
      const resolved = result && typeof result.then === "function" ? await result : result;
      if (resolved?.action === "transform" && resolved.text !== undefined) {
        currentText = resolved.text;
      }
    }

    expect(currentText).toBe(">>HELLO<<");
  });

  test("async handlers work correctly", async () => {
    const hooks = createHooks();

    hooks.on(HOOKS.INPUT, async (data) => {
      await new Promise((r) => setTimeout(r, 10));
      return { action: "transform", text: `async:${data.text}` };
    });

    let currentText = "test";
    const handlers = hooks._hooks.get(HOOKS.INPUT) || [];
    for (const entry of handlers) {
      const result = entry.handler({ text: currentText, source: "interactive", agent: null });
      const resolved = result && typeof result.then === "function" ? await result : result;
      if (resolved?.action === "transform" && resolved.text !== undefined) {
        currentText = resolved.text;
      }
    }

    expect(currentText).toBe("async:test");
  });

  test("handler errors are caught and logged", async () => {
    const hooks = createHooks();
    const errors = [];
    const originalError = console.error;
    console.error = (msg) => errors.push(msg);

    hooks.on(HOOKS.INPUT, () => { throw new Error("boom"); });
    hooks.on(HOOKS.INPUT, (data) => ({ action: "transform", text: data.text + "!"}));

    let currentText = "test";
    const handlers = hooks._hooks.get(HOOKS.INPUT) || [];
    for (const entry of handlers) {
      try {
        const result = entry.handler({ text: currentText, source: "interactive", agent: null });
        const resolved = result && typeof result.then === "function" ? await result : result;
        if (resolved?.action === "transform" && resolved.text !== undefined) {
          currentText = resolved.text;
        }
      } catch (e) {
        console.error(`[hook:${HOOKS.INPUT}] ${e.message}`);
      }
    }

    console.error = originalError;
    expect(errors.length).toBe(1);
    expect(currentText).toBe("test!"); // Second handler still ran
  });
});

describe("context hook", () => {
  test("handlers receive messages and agent", async () => {
    const hooks = createHooks();
    let received = null;

    const mockAgent = { sessionId: "test", _context: [] };
    const messages = [new Message({ role: "user", content: "hello" })];

    hooks.on(HOOKS.CONTEXT, (data) => {
      received = data;
      return { messages };
    });

    // Simulate what agent.js does
    let currentMessages = [...messages];
    const handlers = hooks._hooks.get(HOOKS.CONTEXT) || [];
    for (const entry of handlers) {
      const result = entry.handler({ messages: currentMessages, agent: mockAgent });
      const resolved = result && typeof result.then === "function" ? await result : result;
      if (resolved?.messages) {
        currentMessages = resolved.messages;
      }
    }

    expect(received).toBeTruthy();
    expect(received.messages).toHaveLength(1);
    expect(received.agent).toBe(mockAgent);
  });

  test("handler can filter messages", async () => {
    const hooks = createHooks();

    hooks.on(HOOKS.CONTEXT, ({ messages }) => {
      // Filter out tool messages
      const filtered = messages.filter((m) => m.role !== "tool");
      return { messages: filtered };
    });

    const messages = [
      new Message({ role: "user", content: "hello" }),
      new Message({ role: "tool", content: "result", toolCallId: "1" }),
      new Message({ role: "assistant", content: "response" }),
    ];

    let currentMessages = [...messages];
    const handlers = hooks._hooks.get(HOOKS.CONTEXT) || [];
    for (const entry of handlers) {
      const result = entry.handler({ messages: currentMessages, agent: null });
      const resolved = result && typeof result.then === "function" ? await result : result;
      if (resolved?.messages) {
        currentMessages = resolved.messages;
      }
    }

    expect(currentMessages).toHaveLength(2);
    expect(currentMessages.every((m) => m.role !== "tool")).toBe(true);
  });

  test("handler can inject messages", async () => {
    const hooks = createHooks();

    hooks.on(HOOKS.CONTEXT, ({ messages }) => {
      const injected = new Message({ role: "user", content: "[injected context]" });
      return { messages: [injected, ...messages] };
    });

    const messages = [new Message({ role: "user", content: "hello" })];

    let currentMessages = [...messages];
    const handlers = hooks._hooks.get(HOOKS.CONTEXT) || [];
    for (const entry of handlers) {
      const result = entry.handler({ messages: currentMessages, agent: null });
      const resolved = result && typeof result.then === "function" ? await result : result;
      if (resolved?.messages) {
        currentMessages = resolved.messages;
      }
    }

    expect(currentMessages).toHaveLength(2);
    expect(currentMessages[0].content).toBe("[injected context]");
  });

  test("multiple handlers chain transformations", async () => {
    const hooks = createHooks();

    // First handler: add prefix to all messages
    hooks.on(HOOKS.CONTEXT, ({ messages }) => ({
      messages: messages.map((m) => new Message({ ...m.toJSON(), content: `[1]${m.content}` })),
    }));

    // Second handler: add suffix (sees first handler's output)
    hooks.on(HOOKS.CONTEXT, ({ messages }) => ({
      messages: messages.map((m) => new Message({ ...m.toJSON(), content: `${m.content}[2]` })),
    }));

    const messages = [new Message({ role: "user", content: "hello" })];

    let currentMessages = [...messages];
    const handlers = hooks._hooks.get(HOOKS.CONTEXT) || [];
    for (const entry of handlers) {
      const result = entry.handler({ messages: currentMessages, agent: null });
      const resolved = result && typeof result.then === "function" ? await result : result;
      if (resolved?.messages) {
        currentMessages = resolved.messages;
      }
    }

    expect(currentMessages[0].content).toBe("[1]hello[2]");
  });

  test("handler returning undefined keeps messages unchanged", async () => {
    const hooks = createHooks();

    hooks.on(HOOKS.CONTEXT, () => {
      // Return nothing — should not modify messages
    });

    const messages = [new Message({ role: "user", content: "hello" })];

    let currentMessages = [...messages];
    const handlers = hooks._hooks.get(HOOKS.CONTEXT) || [];
    for (const entry of handlers) {
      const result = entry.handler({ messages: currentMessages, agent: null });
      const resolved = result && typeof result.then === "function" ? await result : result;
      if (resolved?.messages) {
        currentMessages = resolved.messages;
      }
    }

    expect(currentMessages[0].content).toBe("hello");
  });

  test("async context handlers work correctly", async () => {
    const hooks = createHooks();

    hooks.on(HOOKS.CONTEXT, async ({ messages }) => {
      await new Promise((r) => setTimeout(r, 10));
      return {
        messages: messages.map((m) =>
          new Message({ ...m.toJSON(), content: `async:${m.content}` })
        ),
      };
    });

    const messages = [new Message({ role: "user", content: "test" })];

    let currentMessages = [...messages];
    const handlers = hooks._hooks.get(HOOKS.CONTEXT) || [];
    for (const entry of handlers) {
      const result = entry.handler({ messages: currentMessages, agent: null });
      const resolved = result && typeof result.then === "function" ? await result : result;
      if (resolved?.messages) {
        currentMessages = resolved.messages;
      }
    }

    expect(currentMessages[0].content).toBe("async:test");
  });
});

describe("hook constants", () => {
  test("INPUT hook constant exists", () => {
    expect(HOOKS.INPUT).toBe("input");
  });

  test("CONTEXT hook constant exists", () => {
    expect(HOOKS.CONTEXT).toBe("context");
  });
});
