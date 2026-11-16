// desktop: `hotdog desktop [https://url]` — the WebUI in a window.
//
// Two modes:
//  - LOCAL (no URL argument): this process hosts a private webui listener
//    — loopback, ephemeral port, random one-boot API key — mints a session
//    token through its own /login, and hands it to the window in the URL's
//    #tok= fragment (fragments never cross the wire; the window scrubs it
//    from history on boot). Closing the window drains the agent sessions
//    through the same commit-point drain the webui's SIGINT path uses, then
//    exits.
//  - REMOTE (one URL argument): no server here at all — a window on an
//    existing hotdog WebUI, whose own login screen owns authentication.
//    https only; plaintext http is accepted on loopback URLs only, which is
//    the `ssh -L` tunnel shape. There is deliberately no --allow-insecure
//    escape hatch: the webui token is a bearer credential over cleartext,
//    and a desktop launcher is the last place it should be normalized.
//
// The window itself is launcher.ts's problem (WebKitGTK shim compiled on
// demand -> browser app mode -> print the URL). The shim carries no
// native bridge by design, so a remote page holds exactly the power a
// browser tab holds.
//
// Known interactions, documented rather than special-cased: the live-config
// machinery is shared, so while a LOCAL desktop window is up, a
// `webui.port` write rebinds this listener to the stored port (the URL in
// the shim's address outlives it — reload is not possible in app mode, so
// restart the desktop app after moving the port), and a `webui.apiKey` write
// replaces the boot key the next login must present; tokens already issued —
// including the window's — survive to their TTL, which is auth.ts's carried-
// state contract, not a desktop loophole.

import { randomBytes } from "node:crypto";

import { HOOKS } from "@core/hooks.ts";
import { ConfigError, ExtensionError, formatError } from "@core/error.ts";
import { getExtensionConfig, type CoreContext, type ExtensionInstance } from "@core/extensions/types.ts";
import type { CliArgv } from "@core/config/index.ts";
import { logger } from "@utils/logger.ts";

import { buildModelRegistry, type ProviderDef } from "@core/config/providers.ts";
import { createWebuiServer, type WebuiConfig } from "@extensions/webui/server.ts";
import { markServingWebui } from "@extensions/webui/index.ts";
import { isLoopbackHost } from "@extensions/websocket/origin.ts";

import { createLauncher, type WindowHandle, type WindowLauncher } from "./launcher.ts";
import {
  acquireInstanceLock,
  releaseInstanceLock,
  updateInstanceLockPort,
} from "./lock.ts";

/**
 * The local desktop listener's config: the user's webui block with the
 * bind/key/proxy posture forced to the desktop contract. `sessionTokenTtlMin`
 * rides through from config unchanged.
 */
export function desktopServerConfig(base: WebuiConfig): WebuiConfig {
  return {
    ...base,
    // Loopback only: a double-click path must never expose a live agent on
    // the network. A webui.host set for browser serving stays untouched.
    host: "127.0.0.1",
    // Ephemeral: nothing guessable on a fixed port, and a desktop app can
    // never collide with a browser-mode `hotdog webui` on the same machine.
    port: 0,
    // One-boot random key: /login is satisfied from this same process, and a
    // configured real key never travels through the loopback handoff.
    apiKey: randomBytes(32).toString("hex"),
    // The loopback peer is the throttle key; believing x-forwarded-for here
    // could only be wrong.
    trustedProxy: "",
  };
}

export function localAppUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#tok=${encodeURIComponent(token)}`;
}

/**
 * Admit a remote URL: https anywhere; http only on a loopback name (the
 * ssh-tunnel shape). Rejects credentials (login belongs to the window) and
 * fragments (the token handoff is the local launcher's channel). Returns the
 * normalized href. Throws ConfigError -- expected-error class, so the
 * handler prints the message alone, no stack.
 */
export function validateRemoteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      `Invalid server URL "${raw}": pass a full URL, e.g. https://hotdog.example.com (the scheme is required).`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(
      `Unsupported scheme "${url.protocol}" -- https:// only (http:// is accepted for loopback tunnels).`,
    );
  }
  if (url.protocol === "http:" && !isLoopbackHost(host)) {
    throw new ConfigError(
      `Plaintext http refused for non-loopback server "${host}": webui tokens are bearer credentials over cleartext. ` +
        `Use https://, or tunnel to loopback (e.g. ssh -L 8420:127.0.0.1:3000 ${host}) and pass http://127.0.0.1:8420.`,
    );
  }
  if (url.username || url.password) {
    throw new ConfigError(
      "URL credentials are not accepted; log in through the window.",
    );
  }
  if (url.hash) {
    throw new ConfigError(
      "Remove the #... fragment from the server URL -- the token handoff belongs to the local launcher only.",
    );
  }
  return url.href;
}

/**
 * Wait for the window to close, or for SIGINT/SIGTERM to close it. The child
 * shares our process group (Ctrl+C reaches it directly); an external SIGTERM
 * does not propagate, so the signal path terminates it explicitly. Detaches
 * both once decided: a second Ctrl+C must reach the default kill.
 */
export interface WindowExit {
  /** True when SIGINT/SIGTERM closed the window (an intended app quit). */
  viaSignal: boolean;
  /** The child's exit code (128+N when killed by signal N); null on the
   *  signal path, where we stopped the child ourselves. */
  code: number | null;
}

export function waitForWindowClose(win: WindowHandle): Promise<WindowExit> {
  return new Promise((resolve) => {
    let decided = false;
    // Ref'd hold timer: signal listeners are unref'd and the print handle's
    // exited never settles, so without this the remote/print fallback would
    // exit 0 the moment it prints (field-confirmed: bun idles out with no
    // server handle to hold the loop). Max int32 ms; the reset churn of a
    // desktop session outliving 24 days is not worth a cheaper design.
    const hold = setInterval(() => {}, 2_147_483_647);
    const onSignal = () => {
      if (decided) return;
      decided = true;
      detach();
      win.close();
      // Do not await win.exited: a wedged child must not outlive Ctrl+C.
      clearInterval(hold);
      resolve({ viaSignal: true, code: null });
    };
    const detach = () => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    win.exited.then(
      (code) => {
        if (decided) return;
        decided = true;
        detach();
        clearInterval(hold);
        resolve({ viaSignal: false, code });
      },
      () => onSignal(),
    );
  });
}

/**
 * A window that dies on its own is news: a crashed shim aborting (code
 * 134 = SIGABRT, e.g. glibc) used to look identical to a clean close.
 * The signal path stays quiet -- Ctrl+C is the intended quit.
 */
function reportWindowExit(exit: WindowExit): number {
  if (exit.viaSignal || exit.code === 0) return 0;
  const how = exit.code !== null && exit.code > 128 ? `${exit.code} (signal ${exit.code - 128})` : `${exit.code}`;
  logger.error(
    `[desktop] the window exited unexpectedly (code ${how}). Any message the shim ` +
      `printed above is the diagnosis; it recompiles automatically when its source changes.`,
  );
  return 1;
}

async function loginToSelf(port: number, apiKey: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    throw ExtensionError.ConfigFailed(
      "desktop",
      `Self-login to the local desktop server failed (HTTP ${res.status}). ` +
        `This should be impossible -- the server was started by this process with the key it was handed.`,
    );
  }
  const { token } = (await res.json()) as { token?: string };
  if (!token) {
    throw ExtensionError.ConfigFailed("desktop", "Self-login returned no token.");
  }
  return token;
}

/**
 * Re-run the model-catalog fetch the boot skipped (extension.json declares
 * skipRemoteModelFetch so a REMOTE window opens instantly, offline or not)
 * and publish it where the webui reads it: core.resolved.modelRegistry --
 * captured by the ws server at construction and carried forward by live
 * config generations. buildModelRegistry never throws (a dead provider logs
 * and keeps its static models), so hydration cannot fail the boot.
 */
export async function hydrateModelRegistry(core: CoreContext): Promise<void> {
  const resolved = core.resolved as
    | { baseUrl?: string; apiKey?: string; contextLimit?: number; modelRegistry?: unknown }
    | undefined;
  if (!resolved) return;
  const providers =
    ((core.config as Record<string, unknown> | undefined)?.providers as ProviderDef[] | undefined) ?? [];
  resolved.modelRegistry = await buildModelRegistry(
    { providers, baseUrl: resolved.baseUrl, apiKey: resolved.apiKey },
    resolved.contextLimit as number,
  );
}

async function runLocalMode(
  core: CoreContext,
  launcher: WindowLauncher,
): Promise<number> {
  markServingWebui();
  const config = desktopServerConfig(getExtensionConfig<WebuiConfig>(core, "webui"));

  const lock = await acquireInstanceLock();
  if (!lock.ok) {
    logger.info(
      `[desktop] already running (pid ${lock.running.pid}, port ${lock.running.port ?? "?"}) ` +
        `-- a second local desktop server would duplicate the agent over shared state. ` +
        `Stop that process first, or pass a URL to connect to a remote WebUI.`,
    );
    return 1;
  }

  // Local mode DOES serve models; hydrate after the lock (a refused
  // double-launch must not pay a catalog timeout) and before the server
  // captures the registry.
  await hydrateModelRegistry(core);

  let webui: Awaited<ReturnType<typeof createWebuiServer>> | null = null;
  try {
    webui = await createWebuiServer(core, config);
    const port = webui.server.port;
    if (typeof port !== "number") {
      throw ExtensionError.ConfigFailed(
        "desktop",
        "The local desktop listener did not report a TCP port.",
      );
    }
    await updateInstanceLockPort(port);
    const win = await launcher.open(localAppUrl(port, await loginToSelf(port, String(config.apiKey))));
    if (win.kind === "shim") {
      logger.info(`[desktop] window open on port ${port} (shim; close the window to quit)`);
    } else if (win.kind !== "print") {
      // The browser fallback carries the token in argv and the dedicated
      // profile's storage. Not a remote leak, but the operator should know.
      logger.info(
        `[desktop] window open on port ${port} via ${win.kind} app mode ` +
          `(the fallback passes the URL -- token included -- as a process argument)`,
      );
    }
    const exit = await waitForWindowClose(win);
    return reportWindowExit(exit);
  } finally {
    if (webui) {
      // Commit-point drain, then teardown: the exact sequence the webui's
      // own SIGINT path runs (see @extensions/webui/index.ts).
      webui.wsServer.stopCleanupLoop();
      await webui.wsServer.drainSessions();
      webui.dispose();
      webui.wsServer.stopTaskManager();
    }
    await releaseInstanceLock();
  }
}

async function runRemoteMode(rawUrl: string, launcher: WindowLauncher): Promise<number> {
  const url = validateRemoteUrl(rawUrl);
  logger.info(`[desktop] connecting to ${url} (no local server)`);
  const win = await launcher.open(url);
  const exit = await waitForWindowClose(win);
  return reportWindowExit(exit);
}

/** The `desktop` subcommand body, launcher-injectable for tests. */
export async function handleDesktopSubcommand(
  cliArgs: CliArgv,
  core: CoreContext,
  launcher: WindowLauncher = createLauncher(),
): Promise<number> {
  const positional = Array.isArray(cliArgs.args) ? (cliArgs.args as string[]) : [];
  try {
    if (positional.length > 1) {
      throw new ConfigError(
        `Expected at most one server URL, got ${positional.length}: ${positional.join(" ")}`,
      );
    }
    const urlArg = positional.length === 1 ? positional[0] : undefined;
    return urlArg !== undefined
      ? await runRemoteMode(urlArg, launcher)
      : await runLocalMode(core, launcher);
  } catch (err) {
    logger.error(`[desktop] ${formatError(err)}`);
    return 1;
  }
}

export function create(_core: CoreContext): ExtensionInstance {
  return {
    hooks: {
      [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
        registry.register("desktop", {
          description:
            "Open hotdog as a desktop window (local app server by default; pass https://URL to connect to a remote WebUI)",
          handler: handleDesktopSubcommand,
        });
      },
    },
  };
}
