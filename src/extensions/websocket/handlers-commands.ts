// Slash commands (with the /fork interception) and completion requests.

import { parseForkArg } from "@core/command-handlers.ts";
import { completionPrefix, parseCompletionContext } from "@core/completion.ts";
import { S2C, errorFrame } from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import { replaySessionHistory } from "./replay.ts";
import { sessionCreatedPayload } from "./session-created.ts";
import { MAX_COMPLETE_LINE } from "./constants.ts";
import type { RouteContext } from "./route-types.ts";

export function handleCommand(ctx: RouteContext): void {
  const { ws, msg, registry } = ctx;
  const sessionManager = registry.getSessionManager();
  if (!msg.sessionId || !msg.command) return;
  registry.touch(msg.sessionId as string);
  let cmdText = msg.command as string;
  if (cmdText.startsWith("/")) {
    cmdText = cmdText.slice(1).trim();
  }

  // /fork is intercepted rather than dispatched to the bus: the registry must
  // register the new session's UI metadata and re-target the requesting socket,
  // or the tab stays on the source and the fork is unreachable in the webui.
  if (cmdText === "fork" || cmdText.startsWith("fork ")) {
    const { cut, prompt } = parseForkArg(cmdText.slice("fork".length));
    registry
      .fork(msg.sessionId as string, { cut })
      .then(({ sessionId: newSessionId, agent }) => {
        if (ws.activeSessionId && ws.activeChannel) {
          registry.removeChannel(ws.activeSessionId, ws.activeChannel);
        }
        ws.activeSessionId = newSessionId;
        ws.activeChannel = registry.createChannel(newSessionId, ws);

        const sessionCreatedMsg = sessionCreatedPayload(registry, newSessionId);
        SessionRegistry.sendSafe(ws, sessionCreatedMsg);
        registry.broadcast(sessionCreatedMsg);
        // A fresh fork id owns no tasks, so it inherits none of the source's chips.
        registry.sendTaskSnapshot(ws);

        // After the fork's sessionCreated lands (the client clears its list and
        // re-targets), replay the copied history, then start the optional prompt.
        replaySessionHistory(newSessionId, agent, ws);
        // Close the client's attach bookkeeping like every other attach path.
        // Cursor 0 on purpose: this replay came from in-memory messages, not a
        // log read, so no log coordinate can be claimed -- the next reconnect
        // takes a full replay.
        SessionRegistry.sendSafe(ws, {
          type: S2C.SESSION_STATE,
          sessionId: newSessionId,
          key: "cursor",
          value: 0,
        });
        if (prompt) {
          sessionManager.enqueue(newSessionId, prompt);
        }
      })
      .catch((err: unknown) => {
        SessionRegistry.sendSafe(ws, errorFrame(err));
      });
    return;
  }

  sessionManager.executeCommand(msg.sessionId as string, cmdText);
}

export async function handleComplete(ctx: RouteContext): Promise<void> {
  const { ws, msg, registry, core } = ctx;
  const completion = core.completion;
  // Same core completion system the interactive CLI uses; the client
  // renders the list and replaces `prefix` at its own caret.
  if (!completion || !msg.sessionId) return;
  const session = registry.get(msg.sessionId as string);
  const agent = session?.agent;
  if (!agent) return;

  const line =
    (typeof msg.line === "string" ? msg.line : "").slice(0, MAX_COMPLETE_LINE);
  let cursorPos = Number.isFinite(msg.cursorPos)
    ? Math.trunc(msg.cursorPos as number)
    : line.length;
  cursorPos = Math.max(0, Math.min(cursorPos, line.length));

  const compCtx = parseCompletionContext(line, cursorPos, agent);
  const options = await completion.request(compCtx, 200);
  SessionRegistry.sendSafe(ws, {
    type: S2C.COMPLETIONS,
    sessionId: msg.sessionId,
    requestId: msg.requestId ?? null,
    prefix: completionPrefix(line, cursorPos),
    options: options.map((o) => ({
      value: o.value,
      display: o.display ?? o.value,
    })),
  });
}
