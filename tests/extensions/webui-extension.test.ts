// Tests for webui/index.ts — WebUI extension creation, subcommand
// registration, and the subcommand handler's run/shutdown lifecycle.

import { describe, it, expect } from "bun:test";
import { create } from "../../src/extensions/webui/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { logger } from "../../src/core/logger.ts";
import { createMockCore, createMockRegistry } from "../test-helpers.ts";

describe("WebUI Extension", () => {
  it("registers the 'webui' subcommand with correct metadata", async () => {
    const core = createMockCore() as any;
    const ext = create(core);

    const registry = createMockRegistry() as any;
    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(registry);

    expect(registry.registeredName).toBe("webui");
    expect(registry.registeredOpts!.description).toContain("WebUI");
    expect(registry.registeredOpts!.description).toContain("WebSocket");
    expect(typeof registry.registeredOpts!.handler).toBe("function");
  });

  describe("handleWebuiSubcommand", () => {
    // Exercises the real createWebuiServer (no module mocks): the success
    // path binds a real port and is ended with a synthetic SIGTERM.
    function makeCore(webui: Record<string, unknown>) {
      return {
        hooks: { notifyHooks: () => {}, notifyHooksAsync: async () => {} },
        config: { webui },
        resolved: { profileManager: { getProfilesForSwitch: () => ({}) } },
        toolRegistry: { getAll: () => [], get: () => null, register: () => {} },
        extensions: { cleanup: async () => {} },
        createLlmClient: () => ({}),
      } as never;
    }

    async function getHandler(webui: Record<string, unknown>) {
      const core = makeCore(webui);
      const ext = create(core);
      const registry = createMockRegistry() as any;
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(registry);
      return {
        core,
        handler: registry.registeredOpts.handler as (
          args: unknown,
          c: unknown,
        ) => Promise<number>,
      };
    }

    async function waitForPort(port: number, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          // Any response (even 401) means the server is listening.
          await fetch(`http://127.0.0.1:${port}/verify`);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      throw new Error(`webui server did not start on port ${port}`);
    }

    async function waitForPortClosed(port: number, timeoutMs = 3000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          await fetch(`http://127.0.0.1:${port}/verify`);
        } catch {
          return; // connection refused: server is down
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`webui server still listening on port ${port}`);
    }

    it("starts the real server and shuts it down on SIGTERM, returning 0", async () => {
      // port: 0 lets Bun pick a free port, so concurrent test runs never
      // fight over a fixed one. The bound port is read back from the
      // "listening on" log line.
      const logLines: string[] = [];
      const origInfo = (logger as unknown as { info: (msg: string) => void }).info;
      (logger as unknown as { info: (msg: string) => void }).info = (msg: string) => {
        logLines.push(msg);
        origInfo(msg);
      };

      try {
        const { core, handler } = await getHandler({
          port: 0,
          host: "127.0.0.1",
          apiKey: "test-key",
          maxAgeSecs: 3600,
        });

        const done = handler({}, core);

        // Wait for the listening log line, then derive the real port.
        const deadline = Date.now() + 5000;
        let listeningLine = "";
        while (!listeningLine && Date.now() < deadline) {
          listeningLine = logLines.find((l) => l.includes("listening on")) || "";
          if (!listeningLine) await new Promise((r) => setTimeout(r, 25));
        }
        expect(listeningLine).not.toBe("");
        const port = Number(listeningLine.split(":").pop());
        expect(Number.isInteger(port)).toBe(true);

        await waitForPort(port);
        // The SIGTERM listener is registered right after the server starts.
        process.emit("SIGTERM");
        expect(await done).toBe(0);
        await waitForPortClosed(port);
      } finally {
        (logger as unknown as { info: (msg: string) => void }).info = origInfo;
      }
    });

    it("returns 1 when the server fails to start", async () => {
      // Missing apiKey makes createWebuiServer throw before anything binds.
      const { core, handler } = await getHandler({
        port: 0,
        maxAgeSecs: 3600,
      });
      expect(await handler({}, core)).toBe(1);
    });
  });
});
