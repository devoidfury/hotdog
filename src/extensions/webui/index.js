// WebUI Extension
// Provides a full web interface for agent interaction using the websocket extension.
// Registers the "webui" subcommand which starts Bun.serve() with static files,
// login endpoint, and WebSocket upgrade.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOKS } from "../../core/hooks.js";
import { createWebuiServer } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, "ui");

/**
 * Handle the "webui" subcommand: start the WebUI server.
 */
async function handleWebuiSubcommand(cli, core) {
  const config = core.config?.webui || {};
  const { server } = await createWebuiServer(core, config, UI_DIR);
}

/**
 * Create the webui extension.
 * Depends on the websocket extension for createWsServer and createAuthMiddleware.
 *
 * @param {Object} core - The core object with hooks, config, etc.
 * @returns {Object} Extension instance
 */
export function create(core) {
  return {
    hooks: core.hooks
      ? {
          // Register the "webui" subcommand
          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
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
