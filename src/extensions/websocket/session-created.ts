// The sessionCreated wire payload, built in ONE place: attach (live/resume/
// most-recent), the createSession reply, the fork reply, and the fresh-session
// chain all share this builder, so a field added for one path can never go
// missing from another (the drift class behind several webui replay bugs).
// Runtime deps: protocol.ts (a leaf) plus the core session-index read, so a
// cold-adopted session's derived title rides the very first reply. Neither
// imports the websocket layer, so importing this module can never form a
// cycle; SessionRegistry/Agent ride as types.

import type { Agent } from "@core/agent.ts";
import { getSessionRow } from "@core/session/session-index.ts";
import { S2C } from "./protocol.ts";
import type { SessionRegistry } from "./session-registry.ts";

export function sessionCreatedPayload(
  registry: SessionRegistry,
  sessionId: string,
): Record<string, unknown> {
  const session = registry.get(sessionId);
  const agent = (session?.agent as Agent) || null;
  const meta = session?.metadata;
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
  };
}
