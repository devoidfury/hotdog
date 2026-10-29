// The jail's only door out: TCP accept on the jail loopback, piped to the
// policy proxy's unix socket. This is the kernel-hardened egress lane
// (fetchPolicy.hardEgress): the child's netns has no route to anything else,
// so ignoring the injected proxy env stops meaning "open network" and starts
// meaning "no network". Raw sockets, --noproxy, curl --resolve tricks -- all
// dead in an empty netns. The policy decision (ask/allow/deny, per origin)
// happens on the other side of the unix socket, in the fetch-policy proxy.
//
// Two hosts:
//  - the pooled runner (in-process: the runner IS inside the entry's netns;
//    the bridge lives and dies with it, no orphan possible).
//  - stdio MCP servers (no runner): the netns shim spawns THIS file as a
//    child with --pdeathsig so the bridge dies with the server process.
//
// Plain byte piping only: the policy proxy speaks the same HTTP-proxy
// protocol over unix as over TCP (absolute-form requests + CONNECT), so the
// bridge is a wire with no protocol knowledge.

import net from "node:net";
import { dlopen, FFIType } from "bun:ffi";
import { fileURLToPath } from "node:url";

/** Path to this file, for spawners (the netns shim) that must name it. */
export const BRIDGE_ENTRY_PATH = fileURLToPath(import.meta.url);

export const EGRESS_PROXY_PORT = 18080;

export interface EgressBridge {
  port: number;
  stop(): Promise<void>;
}

/**
 * Best-effort PR_SET_PDEATHSIG(SIGTERM): when the bridge runs as a child of
 * the sandboxed target (the MCP case), the kernel signals us if the parent
 * dies. Failure to install is not fatal -- group-kill teardown still covers
 * the process group.
 */
function setParentDeathSignal(): void {
  try {
    const libc = dlopen("libc.so.6", {
      prctl: { args: [FFIType.int, FFIType.int, FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int },
    });
    const PR_SET_PDEATHSIG = 1;
    libc.symbols.prctl(PR_SET_PDEATHSIG, 15 /* SIGTERM */, 0, 0, 0);
    // Already orphaned between fork and prctl? Leave now.
    if (process.ppid === 1) process.kill(process.pid, "SIGTERM");
  } catch {
    // No FFI (or non-glibc): teardown falls back to the group kill.
  }
}

export async function startEgressBridge(opts: {
  unixPath: string;
  port?: number;
  host?: string;
  pdeathsig?: boolean;
}): Promise<EgressBridge> {
  if (opts.pdeathsig) setParentDeathSignal();
  const host = opts.host ?? "127.0.0.1";
  const wanted = opts.port ?? EGRESS_PROXY_PORT;

  const server = net.createServer((client) => {
    const upstream = net.connect(opts.unixPath);
    track(client);
    track(upstream);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  server.on("error", () => {
    // Accepted-socket errors are per-connection above; a listener error
    // (port busy) rejects below during listen only. Keep node from raising.
  });
  // net.Server has no closeAllConnections; track tunnels so stop() is prompt.
  const tunnels = new Set<net.Socket>();
  const track = (s: net.Socket): void => {
    tunnels.add(s);
    s.on("close", () => tunnels.delete(s));
  };
  server.on("connection", track);

  await new Promise<void>((resolve, reject) => {
    server.once("error", (e) => reject(e));
    server.listen(wanted, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("egress bridge failed to bind a TCP port");
  }
  const port = address.port;
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of tunnels) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// ── Standalone mode (spawned by the netns shim for stdio MCP servers) ───────
// usage: bun egress-bridge.ts [--pdeathsig] <unixPath> <port>

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const pdeathsig = argv[0] === "--pdeathsig";
  const rest = pdeathsig ? argv.slice(1) : argv;
  const [unixPath, portText] = rest;
  if (!unixPath) {
    console.error("usage: egress-bridge.ts [--pdeathsig] <unixPath> [port]");
    process.exit(2);
  }
  const port = portText ? Number(portText) : EGRESS_PROXY_PORT;
  startEgressBridge({ unixPath, port, pdeathsig })
    .then((b) => {
      console.log(`egress bridge listening on 127.0.0.1:${b.port} -> unix:${unixPath}`);
    })
    .catch((e) => {
      console.error(`egress bridge failed: ${e instanceof Error ? e.stack ?? String(e) : String(e)}`);
      process.exit(1);
    });
}
