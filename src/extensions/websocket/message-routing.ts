// C2S message routing: the auth gate and the dispatch table. Handlers live
// in the handlers-*.ts files (one per message family); adding a message
// type means writing a handler and registering it in MESSAGE_HANDLERS.
//
// The per-case settle semantics are documented in route-types.ts.

import type { CoreContext } from "@core/extensions/types.ts";
import { C2S, S2C, type C2SType, type C2SMessage } from "./protocol.ts";
import type { AuthMiddleware } from "./auth.ts";
import type { HotdogServerSocket } from "./socket.ts";
import type { WebSocketQuestionBridge } from "./question-input.ts";
import { SessionRegistry } from "./session-registry.ts";
import type { MessageHandler } from "./route-types.ts";
import { handleAuthMessage } from "./handlers-auth.ts";
import {
  handleCreateSession,
  handleDeleteSession,
  handleDismissSession,
  handleRenameSession,
  handleSetPinned,
  handleListSessions,
  handleListProfiles,
  handleSwitchProfile,
  handleSwitchSession,
} from "./handlers-sessions.ts";
import { handleSend, handleCancel } from "./handlers-send.ts";
import { handleExecFence } from "./handlers-exec-fence.ts";
import {
  handleTaskInterrupt,
  handleTaskFollowup,
  handleTaskActivityRequest,
  handleQuestionAnswer,
} from "./handlers-tasks.ts";
import { handleCommand, handleComplete } from "./handlers-commands.ts";
import { handleTranscribe } from "./handlers-transcribe.ts";
import {
  handleListLogs,
  handleLoadLog,
  handleViewLog,
  handleDeleteLog,
  handleSearchLogs,
} from "./handlers-logs.ts";
import { handleConfigSnapshot, handleConfigKeySet } from "./handlers-config.ts";
import { handleListDir, handleReadFile } from "./handlers-files.ts";

const MESSAGE_HANDLERS: Partial<Record<C2SType, MessageHandler>> = {
  [C2S.AUTH]: handleAuthMessage,
  [C2S.CREATE_SESSION]: handleCreateSession,
  [C2S.DELETE_SESSION]: handleDeleteSession,
  [C2S.DISMISS_SESSION]: handleDismissSession,
  [C2S.RENAME_SESSION]: handleRenameSession,
  [C2S.SET_PINNED]: handleSetPinned,
  [C2S.LIST_SESSIONS]: handleListSessions,
  [C2S.LIST_PROFILES]: handleListProfiles,
  [C2S.SWITCH_PROFILE]: handleSwitchProfile,
  [C2S.SWITCH_SESSION]: handleSwitchSession,
  [C2S.SEND]: handleSend,
  [C2S.CANCEL]: handleCancel,
  [C2S.EXEC_FENCE]: handleExecFence,
  [C2S.TASK_INTERRUPT]: handleTaskInterrupt,
  [C2S.TASK_FOLLOWUP]: handleTaskFollowup,
  [C2S.TASK_ACTIVITY_REQUEST]: handleTaskActivityRequest,
  [C2S.QUESTION_ANSWER]: handleQuestionAnswer,
  [C2S.COMMAND]: handleCommand,
  [C2S.COMPLETE]: handleComplete,
  [C2S.TRANSCRIBE]: handleTranscribe,
  [C2S.LIST_LOGS]: handleListLogs,
  [C2S.LOAD_LOG]: handleLoadLog,
  [C2S.VIEW_LOG]: handleViewLog,
  [C2S.DELETE_LOG]: handleDeleteLog,
  [C2S.SEARCH_LOGS]: handleSearchLogs,
  [C2S.CONFIG_SNAPSHOT]: handleConfigSnapshot,
  [C2S.SET_CONFIG_KEY]: handleConfigKeySet,
  [C2S.LIST_DIR]: handleListDir,
  [C2S.READ_FILE]: handleReadFile,
};

export async function routeMessage(
  ws: HotdogServerSocket<unknown>,
  msg: C2SMessage,
  registry: SessionRegistry,
  authMiddleware: AuthMiddleware | undefined,
  bridge: WebSocketQuestionBridge,
  core: CoreContext,
): Promise<void> {
  // Auth gate: when auth is enabled, only the AUTH handshake itself may
  // pass without a validated token. The token is established either at
  // upgrade (URL ?token=) or by a successful AUTH message. This makes the
  // gate hold even for UIs that skip token checks on the HTTP upgrade.
  if (authMiddleware && !ws.authToken && msg.type !== C2S.AUTH) {
    // code:"auth_required" is machine-readable: clients must not treat a
    // pre-auth gate hit as a token failure (see webui/ui/chat.ts authError).
    ws.send(JSON.stringify({ type: S2C.AUTH_ERROR, code: "auth_required", message: "Authentication required" }));
    return;
  }

  // hasOwn: msg.type is raw JSON, so a table lookup must not walk the
  // prototype ("constructor" would resolve to a callable and silently
  // swallow the frame instead of answering Unknown message type).
  const handler = Object.hasOwn(MESSAGE_HANDLERS, msg.type)
    ? MESSAGE_HANDLERS[msg.type as C2SType]
    : undefined;
  if (!handler) {
    ws.send(
      JSON.stringify({
        type: S2C.ERROR,
        message: `Unknown message type: ${(msg as Record<string, unknown>).type}`,
      }),
    );
    return;
  }

  await handler({ ws, msg, registry, authMiddleware, bridge, core });
}
