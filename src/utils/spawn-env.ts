// Child-spawn env: the seam between a policy layer and every process hotdog
// spawns on the model's behalf.
//
// One provider slot at process scope (the same shape as the shared prompt
// queue and the shared exec broker): whoever owns a boundary installs it, and
// every spawner asks here before exec. Today the owner is the fetch-policy
// extension, whose provider answers with the per-session policy-proxy URL as
// HTTP(S)_PROXY + NO_PROXY. No provider (policy absent or disabled) means no
// injection and the spawn proceeds exactly as it did before.
//
// The injected vars are merged LAST -- over the scrubbed base and over the
// user's own env config (bashTool.env, mcpServers[].env): a child must not be
// able to buy its way out of the policy by keeping its own proxy setting.
//
// A provider that REJECTS (the policy proxy could not bind) is fatal to the
// spawn. Dropping the env silently would hand the child open network access
// behind the policy's back -- the same never-fail-open rule the exec fence
// follows.
//
// Where the env travels:
//  - inline bash (supervisor process): resolved here, per call, per session.
//  - the tool exec plane: the supervisor resolves it and rides it on the
//    invoke frame (ctx.spawnEnv); the runner installs that answer as its own
//    provider, because the provider slot in the runner process has no policy
//    layer to talk to. The frame is a private pipe to our own child -- unlike
//    argv, the token in the URL never lands in a process listing.
//  - stdio MCP servers: resolved here under the server's owner id (below).

import { formatError, ToolError } from "@core/error.ts";
import { EGRESS_PROXY_PORT } from "./egress-bridge.ts";

export type SpawnEnvProvider = (sessionId: string) => Promise<Record<string, string> | null>;

let provider: SpawnEnvProvider | null = null;

/** Install (or clear with null) the process-wide provider. */
export function setSpawnEnvProvider(next: SpawnEnvProvider | null): void {
  provider = next;
}

/** The installed provider -- so an owner can clear only its own registration. */
export function getSpawnEnvProvider(): SpawnEnvProvider | null {
  return provider;
}

/**
 * Env the children of `sessionId` must carry, or null when there is nothing to
 * inject. Rejects only as a refusal to spawn (see the header).
 */
export async function spawnEnvFor(sessionId: string | null): Promise<Record<string, string> | null> {
  if (!provider || sessionId === null) return null;
  try {
    return await provider(sessionId);
  } catch (e) {
    throw new ToolError(
      `Spawn refused: the child-env policy could not be resolved (${formatError(e)}). ` +
        "Children are not spawned outside it; set fetchPolicy.proxyEnabled to false to opt out.",
    );
  }
}

/**
 * A stdio MCP server is a child of the process, not of a session: it boots at
 * extension load, before any run exists. Attribute its traffic to
 * `mcp:<serverName>` so its tokens and grants land on the server; the
 * fetch-policy extension answers prompts for these ids through whichever
 * session's UI is live, and fails closed when none is.
 *
 * Session ids are uuids, so the "mcp:" prefix cannot collide with one.
 */
export function mcpOwnerSession(serverName: string): string {
  return `mcp:${serverName}`;
}

/** True for ids minted by `mcpOwnerSession` (nothing else has this shape). */
export function isMcpOwnerSession(sessionId: string): boolean {
  return sessionId.startsWith("mcp:");
}

// ── Hard egress tier (fetchPolicy.hardEgress) ────────────────────────────────
//
// The cooperative proxy above can be ignored by a child; this tier removes
// the option. When installed, the provider answers per owner id with the
// policy proxy's UNIX socket: plane entries spawn under the netns shim (the
// fence carries it) with the socket bind-mounted, stdio MCP servers get their
// argv wrapped by the same shim plus a bridge child. Inside either, the only
// network that exists is the jail loopback port below, piped to that socket.
// A provider that rejects (no userns/bwrap on the host, no policy proxy) is
// fatal to the spawn -- the tier never silently degrades to the cooperative
// lane, and never lets a child run with an open network "just this once".

/**
 * The jail-loopback port the egress bridge listens on. Fixed, not ephemeral:
 * every jail netns is private, so the same number can serve every session,
 * and the injected proxy URL therefore never changes (config files, npmrc
 * style tooling and reconnecting MCP servers all keep working).
 */
export const HARD_EGRESS_PROXY_PORT = EGRESS_PROXY_PORT;

/** The proxy URL a hard-egress child is configured with. */
export const HARD_EGRESS_PROXY_URL = `http://127.0.0.1:${HARD_EGRESS_PROXY_PORT}`;

/** Where the bridge (runner-side) finds the policy proxy inside the jail. */
export const JAIL_EGRESS_SOCKET = "/tmp/hotdog-egress.sock";

export interface HardEgressDirective {
  /** Host path of this owner's policy-proxy unix socket (bind-mounted/bridged). */
  socketPath: string;
  /** True = a spawn that cannot get inside the jail (inline tools) must be refused. */
  strict: boolean;
}

export type HardEgressProvider = (sessionId: string) => Promise<HardEgressDirective | null>;

let hardProvider: HardEgressProvider | null = null;

/** Install (or clear with null) the process-wide hard-egress provider. */
export function setHardEgressProvider(next: HardEgressProvider | null): void {
  hardProvider = next;
}

/** The installed provider -- so an owner can clear only its own registration. */
export function getHardEgressProvider(): HardEgressProvider | null {
  return hardProvider;
}

/** The jail plan for `sessionId`, or null when no hard tier is installed.
 * Rejects only as a refusal to spawn (see the header). */
export async function hardEgressFor(
  sessionId: string | null,
): Promise<HardEgressDirective | null> {
  if (!hardProvider || sessionId === null) return null;
  try {
    return await hardProvider(sessionId);
  } catch (e) {
    throw new ToolError(
      `Spawn refused: the hard egress posture (fetchPolicy.hardEgress) could not be resolved (${formatError(e)}). ` +
        "Children are not started outside it; set fetchPolicy.hardEgress to false to opt out.",
    );
  }
}
