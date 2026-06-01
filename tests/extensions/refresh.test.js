/**
 * Tests for the refresh extension.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { RefreshTool } from "../../extensions/refresh/refresh-tool.js";

describe("RefreshTool", () => {
  let tool;
  let mockCore;
  let mockExtensionLoader;
  let unloadCalls = [];
  let loadCalls = [];
  let reloadCalls = [];
  let reRegisterCalls = 0;

  beforeEach(() => {
    unloadCalls = [];
    loadCalls = [];
    reloadCalls = [];
    reRegisterCalls = 0;

    // Shared mock state that can be overridden by individual tests
    const mockState = {
      extensions: [["test-ext", { name: "test-ext" }]],
      entryPoints: new Map([["test-ext", "./path/to/test.js"]]),
    };

    mockExtensionLoader = {
      unload: (name) => {
        unloadCalls.push(name);
      },
      load: (name, mod) => {
        loadCalls.push({ name, mod });
      },
      reload: (name, entryPoint) => {
        reloadCalls.push({ name, entryPoint });
      },
      all: () => mockState.extensions,
      has: (name) => mockState.extensions.some(([n]) => n === name),
      entryPoints: () => mockState.entryPoints,
    };

    mockCore = {};

    tool = new RefreshTool({
      core: mockCore,
      extensionLoader: mockExtensionLoader,
      reRegisterTools: () => {
        reRegisterCalls++;
      },
    });

    // Allow tests to override mock state
    tool._mockState = mockState;
  });

  describe("constructor", () => {
    it("should create tool with extension loader reference", () => {
      expect(tool.extensionLoader).toBe(mockExtensionLoader);
    });
  });

  describe("toToolDef", () => {
    it("should return a valid tool definition", () => {
      const def = tool.toToolDef();
      expect(def).toBeDefined();
      expect(def.type).toBe("function");
      expect(def.function.name).toBe("refresh");
      expect(def.function.parameters).toBeDefined();
    });

    it("should include refresh action enum", () => {
      const def = tool.toToolDef();
      const actionProp = def.function.parameters.properties.action;
      expect(actionProp.enum).toContain("reload");
      expect(actionProp.enum).toContain("list");
      expect(actionProp.enum).toContain("cache-clear");
    });
  });

  describe("callDisplay", () => {
    it("should generate display string for reload action", () => {
      const display = tool.callDisplay(
        JSON.stringify({ action: "reload", target: "core-tools" }),
      );
      expect(display).toContain("refresh: reload core-tools");
    });

    it("should generate display string for list action", () => {
      const display = tool.callDisplay(
        JSON.stringify({ action: "list", target: "list" }),
      );
      expect(display).toContain("refresh: list");
    });

    it("should handle invalid input", () => {
      const display = tool.callDisplay("not json");
      expect(display).toBe("not json");
    });
  });

  describe("execute - list", () => {
    it("should return loaded extensions", async () => {
      const result = await tool.execute(
        JSON.stringify({ action: "list", target: "list" }),
        {},
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("## Loaded Extensions");
      expect(result.output).toContain("test-ext");
      expect(result.output).toContain("./path/to/test.js");
    });
  });

  describe("execute - reload", () => {
    it("should return error when target is empty", async () => {
      const result = await tool.execute(
        JSON.stringify({ action: "reload", target: "   " }),
        {},
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Target is required");
    });

    it("should return error for unloaded extension", async () => {
      const result = await tool.execute(
        JSON.stringify({ action: "reload", target: "nonexistent" }),
        {},
      );
      expect(result.success).toBe(true); // Returns ok with error info
      expect(result.output).toContain("not loaded");
    });

    it("should reload known extension via ExtensionLoader.reload", async () => {
      const result = await tool.execute(
        JSON.stringify({ action: "reload", target: "test-ext" }),
        {},
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("Reloaded: test-ext");
      expect(reloadCalls.length).toBe(1);
      expect(reloadCalls[0].name).toBe("test-ext");
      expect(reloadCalls[0].entryPoint).toBe("./path/to/test.js");
      expect(reRegisterCalls).toBe(1);
    });

    it("should reload all extensions", async () => {
      tool._mockState.extensions = [
        ["ext-a", { name: "ext-a" }],
        ["ext-b", { name: "ext-b" }],
      ];
      tool._mockState.entryPoints = new Map([
        ["ext-a", "./path/a.js"],
        ["ext-b", "./path/b.js"],
      ]);

      const result = await tool.execute(
        JSON.stringify({ action: "reload", target: "all" }),
        {},
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("Reloaded: ext-a");
      expect(result.output).toContain("Reloaded: ext-b");
      expect(result.output).toContain("Tools re-registered");
    });
  });
});
