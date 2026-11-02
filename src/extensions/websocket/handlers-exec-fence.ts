// Exec-fence posture flip from the webui header strip. Security-relevant:
// kept in its own file so the validation-to-the-letter rules stay together.

import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { fenceCommand, type FenceCommandResult } from "../ui-interactive-cli/fence-command.ts";
import { S2C } from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import type { RouteContext } from "./route-types.ts";

export function handleExecFence(ctx: RouteContext): void {
  const { ws, msg, registry, core } = ctx;
  // Webui header strip: flip ONE session's runtime exec-fence policy.
  // The policy is security-relevant, so the frame is validated to the
  // letter: exactly one of the two literals, and the session binding is
  // the same one the other session-scoped frames use -- the named
  // session must be a live session of this server (registry.get, the
  // lookup switchSession rejects with and COMPLETE shares; cancel's
  // interrupt bottoms out in the same SessionManager map, so a foreign
  // id can never move state here). Auth is upstream: this point is
  // already past the routeMessage auth gate and the upgrade-time
  // Origin/Host gate.
  const sid = typeof msg.sessionId === "string" ? msg.sessionId : "";
  const policy = msg.policy;
  if (policy !== "off" && policy !== "probe") {
    // Never coerced, never applied: a security posture has no "close enough".
    logger.warn(
      `[websocket] execFence rejected: policy must be exactly "off" or "probe" (session ${sid || "(none)"})`,
    );
    SessionRegistry.sendSafe(ws, {
      type: S2C.ERROR,
      message: 'execFence rejected: policy must be "off" or "probe". Nothing changed.',
    });
    return;
  }
  const fenceSession = sid ? registry.get(sid) : null;
  if (!fenceSession) {
    logger.warn(`[websocket] execFence rejected: ${sid || "(no sessionId)"} is not a live session of this server`);
    SessionRegistry.sendSafe(ws, { type: S2C.ERROR, message: "Session not found" });
    return;
  }
  // Decide + apply + transcript notice: the SAME per-session helper the
  // /fence command runs (inline-plane refusal included), so the notice
  // wording is never duplicated and lands on the TOGGLED session's log.
  // registry.get already returned an agent, so the notice channel
  // exists; if addMessage still fails, the catch logs the session + the
  // requested policy (the documented floor -- an unlogged posture change
  // must never pass silently).
  let outcome: FenceCommandResult;
  try {
    outcome = fenceCommand(
      policy === "probe" ? "on" : "off",
      (core.resolved as Record<string, unknown> | undefined) ?? null,
      fenceSession.agent,
      sid,
    );
  } catch (e: unknown) {
    logger.warn(
      `[websocket] execFence failed for session ${sid} (policy "${policy}"): ${formatError(e)}`,
    );
    SessionRegistry.sendSafe(ws, { type: S2C.ERROR, message: `execFence failed: ${formatError(e)}` });
    return;
  }
  if (outcome.applied === null) {
    // Inline plane (no pool to fence) or an unusable posture: the same
    // refusal the CLI prints, and the store was untouched.
    SessionRegistry.sendSafe(ws, { type: S2C.ERROR, message: outcome.output });
    return;
  }
  // Posture push on the existing sessionState channel (the per-session
  // state frame), field "toolExec" -- the same value the attach path's
  // sessionCreated.toolExec carries, from the same per-session producer
  // (registry.toolExecLabel). broadcastScoped is the transport-level
  // isolation: only sockets whose active session is `sid` receive it,
  // so another session's header strip never repaints.
  registry.broadcastScoped(sid, {
    type: S2C.SESSION_STATE,
    sessionId: sid,
    key: "toolExec",
    value: registry.toolExecLabel(sid),
  });
}
