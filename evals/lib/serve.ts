// Background webapp for serve tasks: spawn before the agent, wait for the
// ready URL, kill (whole process group) before the checks run.

import { closeSync, openSync } from "node:fs";
import type { ServeSpec } from "./types.ts";

export interface ServeHandle {
  stop(): void;
}

const READY_POLL_MS = 250;

/**
 * Spawn `serve.cmd` (bash -lc, detached into its own process group) with the
 * workspace as cwd, logging stdout/stderr into logDir. Throws if the server
 * does not answer ready_url within its timeout, or exits early.
 *
 * The server runs on the host, NOT inside bwrap: it is part of the grading
 * apparatus, not the agent. It shares the network namespace, so the agent can
 * reach it, but it inherits the runner's environment minus the forced
 * NO_COLOR/TERM (which keep its logs plain).
 */
export async function startServe(
  serve: ServeSpec,
  workspace: string,
  logDir: string,
): Promise<ServeHandle> {
  const out = openSync(`${logDir}/serve-stdout.txt`, "a");
  const err = openSync(`${logDir}/serve-stderr.txt`, "a");
  const proc = Bun.spawn(["bash", "-lc", serve.cmd], {
    cwd: workspace,
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    detached: process.platform !== "win32",
    stdout: out,
    stderr: err,
  });

  const timeoutMs = (serve.ready_timeout_secs ?? 15) * 1000;
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    // Any HTTP response (even 404/500) means the listener is up.
    try {
      await fetch(serve.ready_url, { signal: AbortSignal.timeout(1000) });
      ready = true;
      break;
    } catch {
      // not up yet — but an exited server will never come up
      // (exitCode is null while running)
      if ((proc as { exitCode: number | null }).exitCode !== null) break;
      await Bun.sleep(READY_POLL_MS);
    }
  }
  if (!ready) {
    stop(proc, [out, err]);
    throw new Error(
      `serve: "${serve.cmd}" never became ready at ${serve.ready_url} within ${String(timeoutMs / 1000)}s ` +
        `(see ${logDir}/serve-stderr.txt)`,
    );
  }
  return { stop: () => stop(proc, [out, err]) };
}

function stop(proc: ReturnType<typeof Bun.spawn>, logFds: number[]): void {
  // The child holds its own dup of the log fds; closing ours is safe and
  // keeps repeated serve runs from leaking two descriptors each.
  for (const fd of logFds) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
  try {
    // Own process group, so the kill reaches the server's children too.
    Bun.spawnSync(["/bin/bash", "-c", `kill -TERM -${proc.pid} 2>/dev/null; sleep 0.2; kill -KILL -${proc.pid} 2>/dev/null`]);
  } catch {
    // pgid kill unavailable; fall back to the direct child
  }
  try {
    proc.kill(9);
  } catch {
    // already exited
  }
}
