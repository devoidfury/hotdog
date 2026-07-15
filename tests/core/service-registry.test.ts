import { describe, it, expect } from "bun:test";
import { ServiceRegistry, createServiceRegistry } from "../../src/core/extensions/service-registry.ts";

describe("ServiceRegistry", () => {
  it("createServiceRegistry returns a new instance", () => {
    const registry = createServiceRegistry();
    expect(registry).toBeInstanceOf(ServiceRegistry);
  });

  it("register and get a service", () => {
    const registry = new ServiceRegistry();
    registry.register("session", { sessionId: "abc" });
    const result = registry.get("session") as { sessionId: string };
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
    expect((registry.get("session") as { v: number }).v).toBe(2);
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
    expect((registry.get("handler") as () => string)()).toBe("callback");
    registry.register("value", 42);
    expect(registry.get("value")).toBe(42);
  });
});

describe("SERVICES_REGISTER hook integration", () => {
  it("SERVICES_REGISTER hook is defined in HOOKS", async () => {
    const { HOOKS } = await import("../../src/core/hooks.ts");
    expect(HOOKS.SERVICES_REGISTER).toBe("services:register");
  });

  it("ExtensionLoader fires SERVICES_REGISTER during load", async () => {
    const { createHooks } = await import("../../src/core/hooks.ts");
    const { createToolRegistry } = await import(
      "../../src/core/extensions/tool-registry.ts"
    );
    const { createServiceRegistry } = await import(
      "../../src/core/extensions/service-registry.ts"
    );
    const { createExtensionLoader } = await import(
      "../../src/core/extensions/extensions.ts"
    );
    const { createConfigRegistry } = await import(
      "../../src/core/extensions/config-registry.ts"
    );
    const { createSubcommandRegistry } = await import(
      "../../src/core/extensions/registries.ts"
    );
    const { HOOKS } = await import("../../src/core/hooks.ts");

    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const services = createServiceRegistry();
    const configRegistry = createConfigRegistry();
    const cliSubcommandRegistry = createSubcommandRegistry();

    const core = { hooks, toolRegistry, services, configRegistry, cliSubcommandRegistry };
    const loader = createExtensionLoader(core);

    // Create a mock extension that registers a service via the hook
    const mockExtension = {
      hooks: {
        [HOOKS.SERVICES_REGISTER]: (registry: ServiceRegistry) => {
          registry.register("test-service", {
            doSomething: () => "works",
          });
        },
      },
    };

    await loader.load("test-ext", mockExtension);

    expect(services.has("test-service")).toBe(true);
    expect((services.get("test-service") as { doSomething: () => string }).doSomething()).toBe("works");
  });

  it("services registered via hook are available to downstream extensions", async () => {
    const { createHooks } = await import("../../src/core/hooks.ts");
    const { createToolRegistry } = await import(
      "../../src/core/extensions/tool-registry.ts"
    );
    const { createServiceRegistry } = await import(
      "../../src/core/extensions/service-registry.ts"
    );
    const { createExtensionLoader } = await import(
        "../../src/core/extensions/extensions.ts"
    );
    const { createConfigRegistry } = await import(
      "../../src/core/extensions/config-registry.ts"
    );
    const { createSubcommandRegistry } = await import(
      "../../src/core/extensions/registries.ts"
    );
    const { HOOKS } = await import("../../src/core/hooks.ts");

    const hooks = createHooks();
    const toolRegistry = createToolRegistry();
    const services = createServiceRegistry();
    const configRegistry = createConfigRegistry();
    const cliSubcommandRegistry = createSubcommandRegistry();

    const core = { hooks, toolRegistry, services, configRegistry, cliSubcommandRegistry };
    const loader = createExtensionLoader(core);

    // Extension A provides a service
    const extA = {
      hooks: {
        [HOOKS.SERVICES_REGISTER]: (registry: ServiceRegistry) => {
          registry.register("session", {
            start: () => "started",
            stop: () => "stopped",
          });
        },
      },
    };

    // Extension B consumes the service — but since services are registered
    // synchronously during load, the service is available in core.services
    // by the time extension B's create() runs.
    let consumedService: { start: () => string } | null = null;
    const extB = {
      hooks: {},
    };

    // Load A first
    await loader.load("ext-a", extA);
    expect(services.has("session")).toBe(true);

    // At this point, core.services already has "session" available
    // for any subsequent extension that needs it.
    consumedService = services.get("session") as { start: () => string };
    expect(consumedService.start()).toBe("started");
  });
});
