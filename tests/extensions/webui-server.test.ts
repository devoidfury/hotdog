// Tests for webui/server.ts — WebUI server creation and configuration.

import { describe, it, expect } from "bun:test";
import { createWebuiServer } from "../../src/extensions/webui/server.ts";

function createMockCore(config: Record<string, unknown> = {}) {
  return {
    hooks: {
      notifyHooks: () => {},
      notifyHooksAsync: async () => {},
    },
    config: {
      websocket: {
        sessionTimeoutMin: 30,
        questionTimeoutSecs: 300,
        questionStrategy: "wait",
      },
      webui: {
        maxAgeSecs: 3600,
      },
      ...config,
    },
    resolved: {
      baseUrl: "http://localhost:8000",
      apiKey: "test-key",
      model: "test-model",
      stream: true,
      chatTimeout: 30,
      maxRetries: 3,
      maxIterations: 100,
      contextLimit: 128000,
      hideTools: false,
      hideThinking: true,
      showTokenUse: true,
      profileName: "default",
      modelRegistry: {},
    },
    toolRegistry: {
      getAll: () => [],
      get: () => null,
      register: () => {},
    },
    extensions: {
      cleanup: async () => {},
    },
  } as any;
}

describe("createWebuiServer", () => {
  describe("validation", () => {
    it("throws when no API key is configured", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 3000 }, "/tmp/ui"),
      ).rejects.toThrow("No API key configured");
    });

    it("throws when apiKey is empty string", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 3000, apiKey: "" }, "/tmp/ui"),
      ).rejects.toThrow("No API key configured");
    });

    it("throws when apiKey is null", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 3000, apiKey: null }, "/tmp/ui"),
      ).rejects.toThrow("No API key configured");
    });

    it("throws when apiKey is undefined", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 3000, apiKey: undefined }, "/tmp/ui"),
      ).rejects.toThrow("No API key configured");
    });

    it("throws when maxAgeSecs is missing from webui config", async () => {
      const core = createMockCore({ webui: {} });
      await expect(
        createWebuiServer(core, { port: 3000, apiKey: "test-key" }, "/tmp/ui"),
      ).rejects.toThrow("missing required webui.maxAgeSecs");
    });

    it("throws when maxAgeSecs is 0", async () => {
      const core = createMockCore({ webui: { maxAgeSecs: 0 } });
      await expect(
        createWebuiServer(core, { port: 3000, apiKey: "test-key" }, "/tmp/ui"),
      ).rejects.toThrow("missing required webui.maxAgeSecs");
    });

    it("throws when maxAgeSecs is null", async () => {
      const core = createMockCore({ webui: { maxAgeSecs: null } });
      await expect(
        createWebuiServer(core, { port: 3000, apiKey: "test-key" }, "/tmp/ui"),
      ).rejects.toThrow("missing required webui.maxAgeSecs");
    });
  });

  describe("server creation", () => {
    it("passes config validation with valid settings", async () => {
      const core = createMockCore();
      try {
        await createWebuiServer(core, {
          port: 3000,
          host: "localhost",
          apiKey: "test-key",
          sessionTokenTtlMin: 60,
        }, "/tmp/ui");
      } catch (e: unknown) {
        // Expected to fail at Bun.serve, not at config validation
        const message = (e as Error).message;
        expect(message).not.toContain("No API key configured");
        expect(message).not.toContain("missing required webui.maxAgeSecs");
      }
    });

    it("respects custom webui.maxAgeSecs", async () => {
      const core = createMockCore({ webui: { maxAgeSecs: 7200 } });
      try {
        await createWebuiServer(core, { port: 3000, apiKey: "test-key" }, "/tmp/ui");
      } catch (e: unknown) {
        const message = (e as Error).message;
        expect(message).not.toContain("missing required webui.maxAgeSecs");
      }
    });
  });
});
