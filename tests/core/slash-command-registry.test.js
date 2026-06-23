import { describe, it, expect } from "bun:test";
import { createCommandRegistry } from "../../src/core/extensions/registries.js";

describe("CommandRegistry", () => {
  it("creates an empty registry", () => {
    const registry = createCommandRegistry();
    expect(registry.names()).toEqual([]);
    expect(registry.has("test")).toBe(false);
    expect(registry.get("test")).toBeUndefined();
    expect(registry.match("test")).toBeNull();
  });

  it("registers and retrieves commands", () => {
    const registry = createCommandRegistry();
    registry.register("test", {
      description: "Test command",
    });
    expect(registry.has("test")).toBe(true);
    expect(registry.names()).toContain("test");
    expect(registry.get("test").description).toBe("Test command");
  });

  it("overwrites existing commands with warning", () => {
    const registry = createCommandRegistry();
    registry.register("test", { description: "First" });
    registry.register("test", { description: "Second" });
    expect(registry.get("test").description).toBe("Second");
  });

  it("checks if raw command matches registered command", () => {
    const registry = createCommandRegistry();
    registry.register("greet", {
      description: "Greet someone",
      matches: (cmd) => cmd.startsWith("greet "),
    });
    expect(registry.match("greet world")).toBe("greet");
    expect(registry.match("hello")).toBeNull();
  });

  it("generates help text with / prefix for slash command UI", () => {
    const registry = createCommandRegistry();
    registry.register("help", { description: "Show help" });
    registry.register("status", { description: "Check status" });
    const help = registry.generateHelpText();
    expect(help).toContain("/help");
    expect(help).toContain("/status");
  });

  it("returns all registered commands", () => {
    const registry = createCommandRegistry();
    registry.register("a", { description: "A" });
    registry.register("b", { description: "B" });
    const all = registry.all();
    expect(all.size).toBe(2);
    expect(all.has("a")).toBe(true);
    expect(all.has("b")).toBe(true);
  });
});

describe("CommandRegistry with custom matches", () => {
  it("matches multi-word patterns", () => {
    const registry = createCommandRegistry();
    registry.register("my-cmd", {
      description: "My custom command",
      matches: (cmd) => cmd.startsWith("my-cmd sub "),
    });
    expect(registry.match("my-cmd sub action")).toBe("my-cmd");
    expect(registry.match("my-cmd other")).toBeNull();
  });

  it("returns null for empty commands", () => {
    const registry = createCommandRegistry();
    registry.register("test", {
      matches: () => true,
    });
    expect(registry.match("")).toBeNull();
    expect(registry.match(null)).toBeNull();
    expect(registry.match(undefined)).toBeNull();
  });
});
