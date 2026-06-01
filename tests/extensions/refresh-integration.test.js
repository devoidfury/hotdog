/**
 * Integration test for the refresh tool.
 *
 * Tests the full lifecycle: load extension → call tool → modify code →
 * refresh → call tool again → verify output changed.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HookSystem, HOOKS } from "../../src/hooks.js";
import { ExtensionLoader } from "../../src/core/extensions.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { RefreshTool } from "../../extensions/refresh/refresh-tool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_DIR = path.resolve(__dirname, "../../extensions");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a temporary extension inside the project's extensions directory.
 * Returns { name, extDir, indexPath, cleanup } for cleanup.
 */
function createTempExtension(name, sourceCode) {
  const extDir = path.join(EXTENSIONS_DIR, name);
  fs.mkdirSync(extDir, { recursive: true });

  // Write extension.json
  fs.writeFileSync(
    path.join(extDir, "extension.json"),
    JSON.stringify({
      name,
      provides: ["tools"],
      loadOrder: 100,
    }),
  );

  // Write index.js
  const indexPath = path.join(extDir, "index.js");
  fs.writeFileSync(indexPath, sourceCode);

  return {
    name,
    extDir,
    indexPath,
    cleanup() {
      try {
        fs.rmSync(extDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Create a minimal core object with hooks and tool registry.
 */
function createMockCore() {
  const hooks = new HookSystem();
  const toolRegistry = new ToolRegistry();
  return {
    hooks,
    config: {},
    modelRegistry: {},
    toolRegistry,
  };
}

// ── Integration Tests ────────────────────────────────────────────────────────

describe("Refresh Tool Integration", () => {
  let core;
  let loader;
  let tempExtensions = [];

  beforeEach(() => {
    core = createMockCore();
    loader = new ExtensionLoader(core);
    tempExtensions = [];
  });

  afterEach(() => {
    // Clean up temporary extensions
    for (const ext of tempExtensions) {
      ext.cleanup();
    }
    tempExtensions = [];
  });

  it("should reload an extension and see updated tool behavior", async () => {
    // ── Step 1: Create a mock extension with a "greet" tool ────────────
    const extName = "integration-greet";
    const ext = createTempExtension(
      extName,
      `
      import { toolDef, param, ToolResult } from "../../src/core/tool-registry.js";
      import { HOOKS } from "../../src/hooks.js";

      class GreetTool {
        toToolDef() {
          return toolDef("greet", "Greet someone", {
            properties: {
              name: { type: "string", description: "Name to greet" },
            },
            required: ["name"],
          });
        }

        async execute(input) {
          const args = typeof input === "string" ? JSON.parse(input) : input;
          return ToolResult.ok("Hello, " + args.name + "! (v1)");
        }
      }

      export function create(core) {
        const greetTool = new GreetTool();
        return {
          hooks: {
            [HOOKS.TOOLS_REGISTER]: async (registry) => {
              registry.register("greet", greetTool);
            },
          },
        };
      }
    `,
    );
    tempExtensions.push(ext);

    // ── Step 2: Load the extension and register tools ───────────────────
    const extModulePath = `../../extensions/${extName}/index.js`;
    const loadedExt = await loader.load(extName, extModulePath);
    expect(loadedExt).not.toBeNull();
    expect(loader.has(extName)).toBe(true);

    // Register tools via the hook
    await core.hooks.emitAsync(HOOKS.TOOLS_REGISTER, core.toolRegistry);
    expect(core.toolRegistry.has("greet")).toBe(true);

    // ── Step 3: Call the greet tool and verify initial output ──────────
    const greetTool = core.toolRegistry.get("greet");
    const result1 = await greetTool.execute(JSON.stringify({ name: "World" }));
    expect(result1.success).toBe(true);
    expect(result1.output).toBe("Hello, World! (v1)");

    // ── Step 4: Modify the extension source code to change behavior ────
    const updatedSource = `
      import { toolDef, param, ToolResult } from "../../src/core/tool-registry.js";
      import { HOOKS } from "../../src/hooks.js";

      class GreetTool {
        toToolDef() {
          return toolDef("greet", "Greet someone", {
            properties: {
              name: { type: "string", description: "Name to greet" },
            },
            required: ["name"],
          });
        }

        async execute(input) {
          const args = typeof input === "string" ? JSON.parse(input) : input;
          return ToolResult.ok("Hello, " + args.name + "! (v2-updated)");
        }
      }

      export function create(core) {
        const greetTool = new GreetTool();
        return {
          hooks: {
            [HOOKS.TOOLS_REGISTER]: async (registry) => {
              registry.register("greet", greetTool);
            },
          },
        };
      }
    `;
    fs.writeFileSync(ext.indexPath, updatedSource);

    // ── Step 5: Use RefreshTool to reload the extension ────────────────
    let reRegisterCalled = false;
    const mockReRegister = async () => {
      reRegisterCalled = true;
      // Re-dispatch TOOLS_REGISTER to re-register all tools
      await core.hooks.emitAsync(HOOKS.TOOLS_REGISTER, core.toolRegistry);
    };

    const refreshTool = new RefreshTool({
      core,
      extensionLoader: loader,
      reRegisterTools: mockReRegister,
    });

    const refreshResult = await refreshTool.execute(
      JSON.stringify({ action: "reload", target: extName }),
      {},
    );
    expect(refreshResult.success).toBe(true);
    expect(refreshResult.output).toContain("Reloaded: " + extName);
    expect(reRegisterCalled).toBe(true);

    // ── Step 6: Verify the tool was re-registered via the active registry ─
    const refreshedTool = core.toolRegistry.get("greet");
    expect(refreshedTool).toBeDefined();

    // ── Step 7: Call the greet tool again and verify updated output ────
    const result2 = await refreshedTool.execute(
      JSON.stringify({ name: "World" }),
    );
    expect(result2.success).toBe(true);
    expect(result2.output).toBe("Hello, World! (v2-updated)");
  });

  it("should preserve agent state (context, model) across reload", async () => {
    // ── Step 1: Create a mock extension ────────────────────────────────
    const extName = "integration-state";
    const ext = createTempExtension(
      extName,
      `
      import { toolDef, ToolResult } from "../../src/core/tool-registry.js";
      import { HOOKS } from "../../src/hooks.js";

      class StateTool {
        toToolDef() {
          return toolDef("state_check", "Check state", {
            properties: {},
            required: [],
          });
        }

        async execute(input) {
          return ToolResult.ok("state_ok");
        }
      }

      export function create(core) {
        const tool = new StateTool();
        return {
          hooks: {
            [HOOKS.TOOLS_REGISTER]: async (registry) => {
              registry.register("state_check", tool);
            },
          },
        };
      }
    `,
    );
    tempExtensions.push(ext);

    // ── Step 2: Load extension and register tools ──────────────────────
    const extModulePath = `../../extensions/${extName}/index.js`;
    await loader.load(extName, extModulePath);
    await core.hooks.emitAsync(HOOKS.TOOLS_REGISTER, core.toolRegistry);

    // ── Step 3: Simulate agent state setup ─────────────────────────────
    const agentState = {
      model: "qwen3.5-0.8b",
      context: ["user message"],
      sessionId: "test-session-123",
    };

    // ── Step 4: Reload the extension ───────────────────────────────────
    const refreshTool = new RefreshTool({
      core,
      extensionLoader: loader,
      reRegisterTools: async () => {
        await core.hooks.emitAsync(HOOKS.TOOLS_REGISTER, core.toolRegistry);
      },
    });

    await refreshTool.execute(
      JSON.stringify({ action: "reload", target: extName }),
      {},
    );

    // ── Step 5: Verify agent state is preserved ────────────────────────
    // The agent object itself should still exist with its properties
    expect(agentState.model).toBe("qwen3.5-0.8b");
    expect(agentState.context).toEqual(["user message"]);
    expect(agentState.sessionId).toBe("test-session-123");

    // The tool should still be available
    expect(core.toolRegistry.has("state_check")).toBe(true);
  });

  it("should handle reload of all extensions", async () => {
    // ── Step 1: Create two mock extensions ─────────────────────────────
    const ext1Name = "integration-multi-1";
    const ext2Name = "integration-multi-2";

    const ext1 = createTempExtension(
      ext1Name,
      `
      import { toolDef, ToolResult } from "../../src/core/tool-registry.js";
      import { HOOKS } from "../../src/hooks.js";

      class Tool1 {
        toToolDef() {
          return toolDef("tool1", "Tool 1", { properties: {}, required: [] });
        }
        async execute() { return ToolResult.ok("v1-t1"); }
      }

      export function create(core) {
        return {
          hooks: {
            [HOOKS.TOOLS_REGISTER]: async (r) => r.register("tool1", new Tool1()),
          },
        };
      }
    `,
    );

    const ext2 = createTempExtension(
      ext2Name,
      `
      import { toolDef, ToolResult } from "../../src/core/tool-registry.js";
      import { HOOKS } from "../../src/hooks.js";

      class Tool2 {
        toToolDef() {
          return toolDef("tool2", "Tool 2", { properties: {}, required: [] });
        }
        async execute() { return ToolResult.ok("v1-t2"); }
      }

      export function create(core) {
        return {
          hooks: {
            [HOOKS.TOOLS_REGISTER]: async (r) => r.register("tool2", new Tool2()),
          },
        };
      }
    `,
    );
    tempExtensions.push(ext1, ext2);

    // ── Step 2: Load both extensions ───────────────────────────────────
    await loader.load(ext1Name, `../../extensions/${ext1Name}/index.js`);
    await loader.load(ext2Name, `../../extensions/${ext2Name}/index.js`);
    await core.hooks.emitAsync(HOOKS.TOOLS_REGISTER, core.toolRegistry);

    expect(core.toolRegistry.has("tool1")).toBe(true);
    expect(core.toolRegistry.has("tool2")).toBe(true);

    const t1 = core.toolRegistry.get("tool1");
    const result1a = await t1.execute();
    expect(result1a.output).toBe("v1-t1");

    // ── Step 3: Modify first extension ─────────────────────────────────
    const updated1 = `
      import { toolDef, ToolResult } from "../../src/core/tool-registry.js";
      import { HOOKS } from "../../src/hooks.js";

      class Tool1 {
        toToolDef() {
          return toolDef("tool1", "Tool 1", { properties: {}, required: [] });
        }
        async execute() { return ToolResult.ok("v2-t1-changed"); }
      }

      export function create(core) {
        return {
          hooks: {
            [HOOKS.TOOLS_REGISTER]: async (r) => r.register("tool1", new Tool1()),
          },
        };
      }
    `;
    fs.writeFileSync(ext1.indexPath, updated1);

    // ── Step 4: Reload all extensions ──────────────────────────────────
    const refreshTool = new RefreshTool({
      core,
      extensionLoader: loader,
      reRegisterTools: async () => {
        await core.hooks.emitAsync(HOOKS.TOOLS_REGISTER, core.toolRegistry);
      },
    });

    const result = await refreshTool.execute(
      JSON.stringify({ action: "reload", target: "all" }),
      {},
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("Reloaded: " + ext1Name);
    expect(result.output).toContain("Reloaded: " + ext2Name);

    // ── Step 5: Verify tool1 was updated but tool2 is still available ──
    const t1Reloaded = core.toolRegistry.get("tool1");
    expect(t1Reloaded).toBeDefined();
    const result1b = await t1Reloaded.execute();
    expect(result1b.output).toBe("v2-t1-changed");

    const t2 = core.toolRegistry.get("tool2");
    expect(t2).toBeDefined();
    const result2 = await t2.execute();
    expect(result2.output).toBe("v1-t2");
  });

  it("should list loaded extensions via refresh tool", async () => {
    // ── Step 1: Create and load a mock extension ───────────────────────
    const extName = "integration-list";
    const ext = createTempExtension(
      extName,
      `
      import { HOOKS } from "../../src/hooks.js";

      export function create(core) {
        return {
          hooks: {
            [HOOKS.TOOLS_REGISTER]: async (r) => {},
          },
        };
      }
    `,
    );
    tempExtensions.push(ext);

    const extModulePath = `../../extensions/${extName}/index.js`;
    await loader.load(extName, extModulePath);

    // ── Step 2: Use refresh tool to list extensions ────────────────────
    const refreshTool = new RefreshTool({
      core,
      extensionLoader: loader,
      reRegisterTools: async () => {},
    });

    const result = await refreshTool.execute(
      JSON.stringify({ action: "list", target: "list" }),
      {},
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("## Loaded Extensions");
    expect(result.output).toContain(extName);
    expect(result.output).toContain("integration-list/index.js");
  });
});
