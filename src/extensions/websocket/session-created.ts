// The sessionCreated wire payload, built in ONE place: attach (live/resume/
// most-recent), the createSession reply, the fork reply, and the fresh-session
// chain all share this builder, so a field added for one path can never go
// missing from another (the drift class behind several webui replay bugs).
// Runtime deps: protocol.ts (a leaf) plus the core session-index read, so a
// cold-adopted session's derived title rides the very first reply. Neither
// imports the websocket layer, so importing this module can never form a
// cycle; SessionRegistry/Agent ride as types.

import type { Agent } from "@core/agent.ts";
import type { AgentLike } from "@core/session/index.ts";
import { getSessionRow } from "@core/session/session-index.ts";
import { S2C } from "./protocol.ts";
import type { SessionRegistry } from "./session-registry.ts";

export function sessionCreatedPayload(
  registry: SessionRegistry,
  sessionId: string,
): Record<string, unknown> {
  const session = registry.get(sessionId);
  // Worker rows read null from the live-agent oracle; their bookkeeping
  // half comes from the raw row, the behavior half from the row agent's
  // ACCESSOR (null after release: the fields fall back like a released
  // interactive agent's do). The kind read keys on the ROW, not the oracle:
  // an ADOPTED worker row has both a live agent and worker posture, and the
  // badge must ride for exactly that row. Interactive rows (kind absent)
  // never touch getRow's output, so their payload bytes are unchanged.
  const row = registry.getRow(sessionId);
  const workerRow = row?.kind === "worker" ? row : null;
  const agent = (session?.agent ?? workerRow?.getAgent?.() ?? null) as Agent | AgentLike | null;
  const meta = session?.metadata ?? workerRow;
  return {
    type: S2C.SESSION_CREATED,
    sessionId,
    profile: agent?.profileName || meta?.profile || "default",
    // Title priority: rename (in-memory meta) > derived (index row) > null.
    title: meta?.title ?? getSessionRow(sessionId)?.title ?? null,
    currentModel: agent?.model || meta?.model || "?",
    models: Object.keys(agent?.modelRegistry || {}),
    sttEnabled: registry.sttEnabled,
    toolExec: registry.toolExecLabel(sessionId),
    // Client-facing vocabulary (the row's birth attribute
    // stays "worker"): additive -- OMITTED on interactive rows, so an
    // interactive payload's bytes are unchanged. Absence = old behavior.
    // `adopted` (additive, same omit rule): this worker session was born by
    // restart-adoption -- no manager lane answers its questions, the pane's
    // human does.
    ...(workerRow
      ? {
          kind: "subagent",
          parentSessionId: workerRow.parentSessionId ?? null,
          ...(workerRow.adoptedWorker === true ? { adopted: true } : {}),
        }
      : {}),
  };
}
