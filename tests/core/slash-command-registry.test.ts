import { describe, it, expect } from "bun:test";
import {
  AgentCommandRegistry,
  CliSubcommandRegistry,
  createCommandRegistry,
  createSubcommandRegistry,
} from "../../src/core/extensions/registries.ts";

// ── Agent Command Registry ───────────────────────────────────────────────────

describe("AgentCommandRegistry", () => {
  it("creates an empty registry", () => {
    const registry = createCommandRegistry();
    expect(registry).toBeInstanceOf(AgentCommandRegistry);
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
    expect(registry.get("test")!.description).toBe("Test command");
  });

  it("overwrites existing commands with warning", () => {
    const registry = createCommandRegistry();
    registry.register("test", { description: "First" });
    registry.register("test", { description: "Second" });
    expect(registry.get("test")!.description).toBe("Second");
  });

  it("stores command definitions without isUiCommand", () => {
    const registry = createCommandRegistry();
    registry.register("ui-cmd", { description: "UI command" });
    registry.register("agent-cmd", { description: "Agent command" });
    expect(registry.get("ui-cmd")!.description).toBe("UI command");
    expect(registry.get("agent-cmd")!.description).toBe("Agent command");
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

describe("AgentCommandRegistry with custom matches", () => {
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
    expect(registry.match(null as any)).toBeNull();
    expect(registry.match(undefined as any)).toBeNull();
  });
});

// ── CLI Subcommand Registry ──────────────────────────────────────────────────

describe("CliSubcommandRegistry", () => {
  it("creates an empty registry", () => {
    const registry = createSubcommandRegistry();
    expect(registry).toBeInstanceOf(CliSubcommandRegistry);
    expect(registry.names()).toEqual([]);
    expect(registry.has("test")).toBe(false);
    expect(registry.get("test")).toBeUndefined();
  });

  it("registers and retrieves subcommands", () => {
    const registry = createSubcommandRegistry();
    registry.register("info", {
      description: "Show system info",
      handler: async () => 0,
    });
    expect(registry.has("info")).toBe(true);
    expect(registry.names()).toContain("info");
    expect(registry.get("info")!.description).toBe("Show system info");
  });

  it("overwrites existing subcommands with warning", () => {
    const registry = createSubcommandRegistry();
    registry.register("test", { description: "First" });
    registry.register("test", { description: "Second" });
    expect(registry.get("test")!.description).toBe("Second");
  });

  it("merges handler with existing metadata placeholder", () => {
    const registry = createSubcommandRegistry();
    // Simulate metadata pre-registration from extension.json
    registry.register("review", {
      description: "Review sessions",
      options: [{ name: "--session-id" }] as unknown as Record<string, unknown>,
    });
    // Simulate hook attaching handler
    registry.register("review", {
      handler: async () => 0,
    });
    const def = registry.get("review")!;
    expect(def.handler).toBeDefined();
    expect(def.description).toBe("Review sessions");
    expect(def.options).toEqual([{ name: "--session-id" }] as unknown as Record<string, unknown>);
  });

  it("generates help text without / prefix", () => {
    const registry = createSubcommandRegistry();
    registry.register("info", { description: "Show system info" });
    registry.register("review", { description: "Review sessions" });
    const help = registry.generateHelpText();
    expect(help).toContain("  info");
    expect(help).toContain("  review");
    expect(help).not.toContain("/info");
    expect(help).not.toContain("/review");
  });

  it("returns all registered subcommands", () => {
    const registry = createSubcommandRegistry();
    registry.register("a", { description: "A" });
    registry.register("b", { description: "B" });
    const all = registry.all();
    expect(all.size).toBe(2);
    expect(all.has("a")).toBe(true);
    expect(all.has("b")).toBe(true);
  });
});

// ── Backward Compatibility ───────────────────────────────────────────────────

describe("Backward compatibility", () => {
  it("createCommandRegistry returns AgentCommandRegistry", () => {
    const registry = createCommandRegistry();
    expect(registry).toBeInstanceOf(AgentCommandRegistry);
    expect(typeof registry.match).toBe("function");
  });

  it("createSubcommandRegistry returns CliSubcommandRegistry", () => {
    const registry = createSubcommandRegistry();
    expect(registry).toBeInstanceOf(CliSubcommandRegistry);
    expect("match" in registry).toBe(false);
  });
});
