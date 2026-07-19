// WebUI Extension
// Provides a full web interface for agent interaction using the websocket extension.
// Registers the "webui" subcommand which starts server.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOKS } from "../../core/hooks.ts";
import { createWebuiServer } from "./server.ts";
import {
  CoreContext,
  ExtensionInstance,
  getExtensionConfig,
} from "../../core/extensions/types.ts";
import type { CliSubcommandRegistry } from "../../core/extensions/registries.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, "ui");

/**
 * Handle the "webui" subcommand: start the WebUI server.
 * Blocks until the server is shut down (SIGINT/SIGTERM).
 */
async function handleWebuiSubcommand(
  _cliArgs: unknown,
  _core: unknown,
): Promise<number | undefined> {
  try {
    const core = _core as CoreContext;
    const config = getExtensionConfig<{ port?: number; host?: string; apiKey?: string; sessionTokenTtlMin?: number; maxAgeSecs?: number }>(core, "webui");
    const { server, wsServer } = await createWebuiServer(core, config, UI_DIR);

    // Keep the process alive until the server is stopped
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        server.stop();
        wsServer.stopCleanupLoop();
        resolve();
      };

      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[webui] Failed to start server: ${message}`);
    return 1;
  }
}

/**
 * Create the webui extension.
 * Depends on the websocket extension for createWsServer and createAuthMiddleware.
 */
export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: core.hooks
      ? {
          // Register the "webui" subcommand
          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (
            registry: CliSubcommandRegistry,
          ) => {
            registry.register("webui", {
              description:
                "Start the WebUI server (HTTP + WebSocket + frontend)",
              handler: handleWebuiSubcommand,
            });
          },
        }
      : undefined,
  };
}
