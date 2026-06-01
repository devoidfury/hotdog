import { test, expect, describe, beforeEach } from "bun:test";
import { HookSystem, createHooks, HOOKS } from "../../src/hooks.js";
import { Agent } from "../../src/core/agent.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockHooks() {
  return createHooks();
}

function createMockRegistry() {
  const registry = new ToolRegistry({
    cwdBoundary: process.cwd(),
    workspaceRoot: process.cwd(),
  });
  return registry;
}

function createMockLlmClient() {
  return {
    chatStreamCancellable: async function* () {
      yield { type: "content", content: "Done" };
      return { fullText: "Done", finalToolCalls: null, usage: null };
    },
  };
}

/**
 * Create a minimal agent for testing.
 */
function createTestAgent(options = {}) {
  const hooks = options.hooks || createMockHooks();
  const registry = options.registry || createMockRegistry();

  return new Agent({
    hooks,
    toolRegistry: registry,
    llmClient: createMockLlmClient(),
    model: "test-model",
    ...options,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("HOOKS.AGENT_TOOL_CONTEXT", () => {
  test("hook is emitted with toolCtx containing agent and isSessionRestoring", async () => {
    const hooks = createMockHooks();
    let capturedCtx = null;

    hooks.on(HOOKS.AGENT_TOOL_CONTEXT, ({ toolCtx, toolName }) => {
      capturedCtx = toolCtx;
      expect(toolName).toBe("test-tool");
    });

    const agent = createTestAgent({ hooks });
    agent._isRestoring = false;

    // Simulate what _executeTools does
    await hooks.emitAsync(HOOKS.AGENT_TOOL_CONTEXT, {
      toolCtx: {
        agent,
        isSessionRestoring: agent._isRestoring,
      },
      toolName: "test-tool",
      agent,
    });

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx.agent).toBe(agent);
    expect(capturedCtx.isSessionRestoring).toBe(false);
  });

  test("hook is emitted with isSessionRestoring=true during restoration", async () => {
    const hooks = createMockHooks();
    let capturedRestoring = null;

    hooks.on(HOOKS.AGENT_TOOL_CONTEXT, ({ toolCtx }) => {
      capturedRestoring = toolCtx.isSessionRestoring;
    });

    const agent = createTestAgent({ hooks });
    agent._isRestoring = true;

    await hooks.emitAsync(HOOKS.AGENT_TOOL_CONTEXT, {
      toolCtx: {
        agent,
        isSessionRestoring: agent._isRestoring,
      },
      toolName: "test-tool",
      agent,
    });

    expect(capturedRestoring).toBe(true);
  });
});

describe("HOOKS.SESSION_RESTORE_ACTIVE", () => {
  test("hook is emitted when isRestoring changes", async () => {
    const hooks = createMockHooks();
    const events = [];

    hooks.on(HOOKS.SESSION_RESTORE_ACTIVE, ({ isRestoring }) => {
      events.push(isRestoring);
    });

    const agent = createTestAgent({ hooks });

    // Initial state
    expect(agent.isRestoring).toBe(false);

    // Set to true
    agent.isRestoring = true;
    expect(events).toEqual([true]);

    // Set back to false
    agent.isRestoring = false;
    expect(events).toEqual([true, false]);

    // Setting to same value should not emit
    agent.isRestoring = false;
    expect(events).toEqual([true, false]); // no new event
  });

  test("hook is not emitted on initial construction", async () => {
    const hooks = createMockHooks();
    const events = [];

    hooks.on(HOOKS.SESSION_RESTORE_ACTIVE, ({ isRestoring }) => {
      events.push(isRestoring);
    });

    // Creating agent should not emit
    createTestAgent({ hooks });
    expect(events).toEqual([]);
  });
});

describe("Integration: toolContext enrichment flow", () => {
  test("extensions can enrich toolCtx via agent:toolContext hook", async () => {
    const hooks = createMockHooks();
    const enrichmentData = [];

    // Simulate skills extension enriching context
    hooks.on(HOOKS.AGENT_TOOL_CONTEXT, ({ toolCtx }) => {
      toolCtx.skillsLoader = {
        allSkills: () => [{ name: "test-skill" }],
        activateSkill: () => {},
      };
      enrichmentData.push("skills");
    });

    // Simulate another extension enriching context
    hooks.on(HOOKS.AGENT_TOOL_CONTEXT, ({ toolCtx }) => {
      toolCtx.customExtension = { key: "value" };
      enrichmentData.push("custom");
    });

    const agent = createTestAgent({ hooks });

    // Build and emit tool context
    const toolCtx = {
      agent,
      isSessionRestoring: false,
    };
    await hooks.emitAsync(HOOKS.AGENT_TOOL_CONTEXT, {
      toolCtx,
      toolName: "any-tool",
      agent,
    });

    expect(enrichmentData).toEqual(["skills", "custom"]);
    expect(toolCtx.skillsLoader).toBeDefined();
    expect(toolCtx.customExtension).toEqual({ key: "value" });
  });
});
