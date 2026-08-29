import { HOOKS } from "../../core/hooks.ts";
import { createWebuiServer, type WebuiConfig } from "./server.ts";
import { CoreContext, ExtensionInstance, getExtensionConfig } from "../../core/extensions/types.ts";
import { CliArgv } from "../../core/config/index.ts";

async function handleWebuiSubcommand(_cliArgs: CliArgv, core: CoreContext): Promise<number> {
  try {
    const config = getExtensionConfig<WebuiConfig>(core, "webui");
    const { server, wsServer, authMiddleware } = await createWebuiServer(core, config);

    await new Promise<void>((resolve) => {
      const shutdown = () => {
        server.stop();
        wsServer.stopCleanupLoop();
        authMiddleware.stopCleanup();
        resolve();
      };

      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[webui] Failed to start server: ${message}`);
    return 1;
  }
}

export function create(_core: CoreContext): ExtensionInstance {
  return {
    hooks: {
      [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
        registry.register("webui", {
          description: "Start the WebUI server (HTTP + WebSocket + frontend)",
          handler: handleWebuiSubcommand,
        });
      },
    },
  };
}
