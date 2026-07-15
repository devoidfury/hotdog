import { test, expect, describe } from "bun:test";
import { createHooks, HOOKS } from "../../src/core/hooks.ts";
import { Agent } from "../../src/core/agent.ts";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.ts";
import { MockLLMClient } from "../helpers.ts";
import type { LlmClient } from "../../src/core/llm-client/client.ts";
import type { HookSystem } from "../../src/core/hooks.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockRegistry() {
  return new ToolRegistry();
}

/**
 * Create a minimal agent for testing.
 */
function createTestAgent(options: { hooks?: HookSystem; registry?: ToolRegistry } = {}) {
  const hooks = options.hooks || createHooks();
  const registry = options.registry || createMockRegistry();

  return new Agent({
    hooks,
    toolRegistry: registry,
    llmClient: new MockLLMClient() as unknown as LlmClient,
    model: "test-model",
    maxIterations: 100,
    maxTokens: 4096,
    ...options,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("HOOKS.AGENT_TOOL_CONTEXT", () => {
  test("hook is emitted with toolCtx containing agent and isSessionRestoring", async () => {
    const hooks = createHooks();
    let capturedCtx: { agent: Agent; isSessionRestoring: boolean } | null = null;

    hooks.on(HOOKS.AGENT_TOOL_CONTEXT, (({ toolCtx, toolName }: { toolCtx: { agent: Agent; isSessionRestoring: boolean }; toolName: string }) => {
      capturedCtx = toolCtx;
      expect(toolName).toBe("test-tool");
    }) as (data: unknown) => void);

    const agent = createTestAgent({ hooks });
    agent.isRestoring = false;

    // Simulate what _executeTools does
    await hooks.notifyHooksAsync(HOOKS.AGENT_TOOL_CONTEXT, {
      toolCtx: {
        agent,
        isSessionRestoring: agent.isRestoring,
      },
      toolName: "test-tool",
      agent,
    });

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.agent).toBe(agent);
    expect(capturedCtx!.isSessionRestoring).toBe(false);
  });

  test("hook is emitted with isSessionRestoring=true during restoration", async () => {
    const hooks = createHooks();
    let capturedRestoring: boolean | null = null;

    hooks.on(HOOKS.AGENT_TOOL_CONTEXT, (({ toolCtx }: { toolCtx: { isSessionRestoring: boolean } }) => {
      capturedRestoring = toolCtx.isSessionRestoring;
    }) as (data: unknown) => void);

    const agent = createTestAgent({ hooks });
    agent.isRestoring = true;

    await hooks.notifyHooksAsync(HOOKS.AGENT_TOOL_CONTEXT, {
      toolCtx: {
        agent,
        isSessionRestoring: agent.isRestoring,
      },
      toolName: "test-tool",
      agent,
    });

    expect(capturedRestoring as unknown as boolean).toBe(true);
  });
});

describe("HOOKS.SESSION_RESTORE_ACTIVE", () => {
  test("hook is emitted when isRestoring changes", async () => {
    const hooks = createHooks();
    const events: boolean[] = [];

    hooks.on(HOOKS.SESSION_RESTORE_ACTIVE, (({ isRestoring }: { isRestoring: boolean }) => {
      events.push(isRestoring);
    }) as (data: unknown) => void);

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
    const hooks = createHooks();
    const events: boolean[] = [];

    hooks.on(HOOKS.SESSION_RESTORE_ACTIVE, (({ isRestoring }: { isRestoring: boolean }) => {
      events.push(isRestoring);
    }) as (data: unknown) => void);

    // Creating agent should not emit
    createTestAgent({ hooks });
    expect(events).toEqual([]);
  });
});

describe("Integration: toolContext enrichment flow", () => {
  test("extensions can enrich toolCtx via agent:toolContext hook", async () => {
    const hooks = createHooks();
    const enrichmentData: string[] = [];

    // Simulate skills extension enriching context
    hooks.on(HOOKS.AGENT_TOOL_CONTEXT, (({ toolCtx }: { toolCtx: Record<string, unknown> }) => {
      toolCtx.skillsLoader = {
        allSkills: () => [{ name: "test-skill" }],
        activateSkill: () => {},
      };
      enrichmentData.push("skills");
    }) as (data: unknown) => void);

    // Simulate another extension enriching context
    hooks.on(HOOKS.AGENT_TOOL_CONTEXT, (({ toolCtx }: { toolCtx: Record<string, unknown> }) => {
      toolCtx.customExtension = { key: "value" };
      enrichmentData.push("custom");
    }) as (data: unknown) => void);

    const agent = createTestAgent({ hooks });

    // Build and emit tool context
    const toolCtx: Record<string, unknown> = {
      agent,
      isSessionRestoring: false,
    };
    await hooks.notifyHooksAsync(HOOKS.AGENT_TOOL_CONTEXT, {
      toolCtx,
      toolName: "any-tool",
      agent,
    });

    expect(enrichmentData).toEqual(["skills", "custom"]);
    expect(toolCtx.skillsLoader).toBeDefined();
    expect(toolCtx.customExtension).toEqual({ key: "value" });
  });
});
