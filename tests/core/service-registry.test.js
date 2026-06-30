import { describe, it, expect } from "bun:test";
import { ServiceRegistry, createServiceRegistry } from "../../src/core/extensions/service-registry.js";

describe("ServiceRegistry", () => {
  it("createServiceRegistry returns a new instance", () => {
    const registry = createServiceRegistry();
    expect(registry).toBeInstanceOf(ServiceRegistry);
  });

  it("register and get a service", () => {
    const registry = new ServiceRegistry();
    registry.register("session", { sessionId: "abc" });
    const result = registry.get("session");
    expect(result.sessionId).toBe("abc");
  });

  it("get throws when service not registered", () => {
    const registry = new ServiceRegistry();
    expect(() => registry.get("nonexistent")).toThrow('Service "nonexistent" is not registered');
  });

  it("has returns true for registered service", () => {
    const registry = new ServiceRegistry();
    registry.register("session", {});
    expect(registry.has("session")).toBe(true);
  });

  it("has returns false for unregistered service", () => {
    const registry = new ServiceRegistry();
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("names returns all registered service names", () => {
    const registry = new ServiceRegistry();
    registry.register("session", {});
    registry.register("resourceLoader", {});
    expect(registry.names()).toContain("session");
    expect(registry.names()).toContain("resourceLoader");
    expect(registry.names()).toHaveLength(2);
  });

  it("names returns empty array when no services registered", () => {
    const registry = new ServiceRegistry();
    expect(registry.names()).toEqual([]);
  });

  it("register replaces existing implementation", () => {
    const registry = new ServiceRegistry();
    registry.register("session", { v: 1 });
    registry.register("session", { v: 2 });
    expect(registry.get("session").v).toBe(2);
  });

  it("checkContract returns valid when all methods present", () => {
    const registry = new ServiceRegistry();
    registry.register("session", {
      start: () => {},
      stop: () => {},
    });
    const result = registry.checkContract("session", ["start", "stop"]);
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("checkContract returns invalid with missing methods", () => {
    const registry = new ServiceRegistry();
    registry.register("session", { start: () => {} });
    const result = registry.checkContract("session", ["start", "stop", "reset"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["stop", "reset"]);
  });

  it("checkContract returns invalid when service not registered", () => {
    const registry = new ServiceRegistry();
    const result = registry.checkContract("nonexistent", ["start", "stop"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["start", "stop"]);
  });

  it("checkContract handles non-function properties", () => {
    const registry = new ServiceRegistry();
    registry.register("config", {
      name: "test",
      start: () => {},
    });
    const result = registry.checkContract("config", ["name", "start", "stop"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["name", "stop"]);
  });

  it("register accepts non-object implementations", () => {
    const registry = new ServiceRegistry();
    registry.register("handler", () => "callback");
    expect(registry.get("handler")()).toBe("callback");
    registry.register("value", 42);
    expect(registry.get("value")).toBe(42);
  });
});
