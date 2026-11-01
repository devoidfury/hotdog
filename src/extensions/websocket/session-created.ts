// The sessionCreated wire payload, built in ONE place: attach (live/resume/
// most-recent), the createSession reply, the fork reply, and the fresh-session
// chain all share this builder, so a field added for one path can never go
// missing from another (the drift class behind several webui replay bugs).
// Runtime dep is protocol.ts only (a leaf); SessionRegistry/Agent ride as
// types, so importing this module can never form a cycle.

import type { Agent } from "@core/agent.ts";
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
    // Title follows the registry metadata: null until a rename sets it.
    title: meta?.title ?? null,
    currentModel: agent?.model || meta?.model || "?",
    models: Object.keys(agent?.modelRegistry || {}),
    sttEnabled: registry.sttEnabled,
    toolExec: registry.toolExecLabel(sessionId),
  };
}
