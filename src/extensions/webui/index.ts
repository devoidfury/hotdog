import { HOOKS } from "@core/hooks.ts";
import { createWebuiServer, type WebuiConfig } from "./server.ts";
import { CoreContext, ExtensionInstance, getExtensionConfig } from "@core/extensions/types.ts";
import { CliArgv } from "@core/config/index.ts";
import { formatError } from "@core/error.ts";

async function handleWebuiSubcommand(_cliArgs: CliArgv, core: CoreContext): Promise<number> {
  try {
    const config = getExtensionConfig<WebuiConfig>(core, "webui");
    const { server, wsServer, authMiddleware } = await createWebuiServer(core, config);

    await new Promise<void>((resolve) => {
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        wsServer.stopCleanupLoop();
        // Commit-point drain (SIGTERM and SIGINT alike): let in-flight turns
        // reach their next fsynced commit point (bounded at 10s), then
        // interrupt stragglers, so a planned restart never exits mid-write.
        await wsServer.drainSessions();
        server.stop();
        wsServer.stopTaskManager();
        authMiddleware.stopCleanup();
        resolve();
      };

      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });

    return 0;
  } catch (err) {
    console.error(`[webui] Failed to start server: ${formatError(err)}`);
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
