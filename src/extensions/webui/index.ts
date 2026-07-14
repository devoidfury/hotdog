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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, "ui");

// ── Types ───────────────────────────────────────────────────────────────────

interface SubcommandCli {
  [key: string]: unknown;
}

interface SubcommandRegistry {
  register(
    name: string,
    definition: {
      description: string;
      handler: (cli: SubcommandCli, core: CoreContext) => Promise<void>;
    },
  ): void;
}

/**
 * Handle the "webui" subcommand: start the WebUI server.
 */
async function handleWebuiSubcommand(
  _cli: SubcommandCli,
  core: CoreContext,
): Promise<void> {
  const config = getExtensionConfig<{ port?: number; host?: string; apiKey?: string; sessionTokenTtlMin?: number; maxAgeSecs?: number }>(core, "webui");
  const { server } = await createWebuiServer(core, config, UI_DIR);
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
            registry: SubcommandRegistry,
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
