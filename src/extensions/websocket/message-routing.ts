// C2S message routing, split out of server.ts: the auth gate and the
// per-type handlers (sessions, send/uploads, commands/fork, tasks,
// questions, logs, completions, transcribe).

import { getSessionRow } from "@core/session/session-index.ts";
import { deleteSessionLog, listSessionLogs, readSessionEntries } from "@core/session/session-log.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { modelAcceptsImages } from "@core/config/providers.ts";
import { uploadLimits } from "@core/config/upload-limits.ts";
import { parseUploadedFiles } from "./uploads.ts";
import type { AuthMiddleware } from "./auth.ts";
import type { HotdogServerSocket } from "./socket.ts";
import type { WebSocketQuestionBridge } from "./question-input.ts";
import {
  C2S,
  S2C,
  taskControlMessage,
  C2SMessage,
  wireImages,
  type TranscribeRequestWire,
  type TranscriptReplyWire,
} from "./protocol.ts";
import { parseForkArg } from "@core/command-handlers.ts";
import { completionPrefix, parseCompletionContext } from "@core/completion.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { transcribeAudio } from "@utils/stt.ts";
import type { SttTarget } from "@core/config/stt.ts";
import { SessionRegistry } from "./session-registry.ts";
import { replaySessionHistory } from "./replay.ts";
import { createAndAttachSession, dismissResumedQuestions } from "./resume.ts";
import { attachLiveSession, attachResumedSession, attachToMostRecentSession, fallbackAttach } from "./attach.ts";
import { MAX_COMPLETE_LINE, MAX_TRANSCRIBE_AUDIO_BYTES, MAX_TRANSCRIBE_BASE64_CHARS } from "./constants.ts";

/**
 * Parses (never casts) one `transcribe` off an untrusted socket into
 * TranscribeRequestWire. This is the only place its fields are checked, so
 * everything downstream reads typed values; a rejected payload comes back as the
 * in-band error text. `id` comes from the caller: a reply needs the correlation
 * key even when the rest of the request is junk.
 */
function parseTranscribeRequest(
  msg: C2SMessage,
  id: string,
): TranscribeRequestWire | { error: string } {
  if (typeof msg.data !== "string" || msg.data.length === 0) {
    return { error: "transcribe: missing audio data" };
  }
  if (msg.data.length > MAX_TRANSCRIBE_BASE64_CHARS) {
    return {
      error: `transcribe: audio too large (limit ${MAX_TRANSCRIBE_AUDIO_BYTES / 1024 / 1024}MB)`,
    };
  }
  return {
    type: C2S.TRANSCRIBE,
    id,
    mimeType: typeof msg.mimeType === "string" ? msg.mimeType : undefined,
    data: msg.data,
  };
}

/**
 * Push-to-talk transcription: decode the base64 audio, forward it to the
 * OpenAI-compatible endpoint resolved from config (`sttUrl`/`sttModel`), and
 * answer with a `transcript` message correlated by the client's request id.
 * All failures land in-band ({ ok:false, error }): a missing or broken STT
 * backend must never drop the socket.
 */
async function handleTranscribe(
  ws: HotdogServerSocket<unknown>,
  msg: C2SMessage,
  stt: SttTarget | null,
): Promise<void> {
  const id = typeof msg.id === "string" ? msg.id : "";
  const reply = (payload: { ok: boolean; text?: string; error?: string }) => {
    const wire: TranscriptReplyWire = { type: S2C.TRANSCRIPT, id, ...payload };
    SessionRegistry.sendSafe(ws, wire);
  };

  const req = parseTranscribeRequest(msg, id);
  if ("error" in req) {
    reply({ ok: false, error: req.error });
    return;
  }
  if (!stt) {
    reply({
      ok: false,
      error:
        "Speech-to-text is not configured (no audio-capable model in the registry; set sttUrl to override)",
    });
    return;
  }

  try {
    const audio = new Uint8Array(Buffer.from(req.data, "base64"));
    const text = await transcribeAudio({
      url: stt.url,
      model: stt.model,
      authHeader: stt.authHeader,
      audio,
      mimeType: req.mimeType,
    });
    reply({ ok: true, text });
  } catch (err: unknown) {
    logger.error(`[websocket] transcribe failed: ${formatError(err)}`);
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function routeMessage(
  ws: HotdogServerSocket<unknown>,
  msg: C2SMessage,
  registry: SessionRegistry,
  authMiddleware: AuthMiddleware | undefined,
  bridge: WebSocketQuestionBridge,
  core: CoreContext,
): Promise<void> {
  const completion = core.completion;
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

  const sessionManager = registry.getSessionManager();

  switch (msg.type) {
    case C2S.AUTH: {
      if (authMiddleware) {
        if (msg.token) {
          const valid = authMiddleware.validateToken(msg.token as string);
          if (valid) {
            ws.authToken = msg.token as string;
            // Handshake complete: drop the pending-auth stamp now instead of
            // leaving the reaper to notice ws.authToken on its next sweep.
            registry.removePendingAuth(ws);
            // Authed sockets join the broadcast group (no-op if already
            // registered via a token upgrade).
            registry.registerConnection(ws);
            ws.send(JSON.stringify({ type: S2C.AUTH_OK }));
            // The task snapshot rides the attach paths below. A client that
            // remembers its session (upgrade ?session=...) gets it back
            // instead of the most recent one. attachStarted covers an
            // upgrade-site attach still in flight (activeSessionId is not set
            // until its first awaits settle).
            if (!ws.activeSessionId && !ws.attachStarted) {
              ws.attachStarted = true;
              if (ws.resumeSessionId) {
                // Await the attach-or-fallback chain: routeMessage's promise
                // is the caller's settle signal for this message's replies,
                // and the attach reads real disk. Fire-and-forget made the
                // fallback burst (sessionCreated, cursor, error) unobservable
                // -- a starved runner resolved the handler before the EACCES
                // read even completed (the CI [authOk]-only flake).
                await attachResumedSession(
                  ws,
                  registry,
                  bridge,
                  ws.resumeSessionId,
                  ws.resumeCursor ?? 0,
                  true,
                ).catch((err: unknown) => {
                  logger.error(`[websocket] resumed attach failed: ${formatError(err)}`);
                  return fallbackAttach(ws, registry, bridge, "Session resume failed.");
                });
              } else if (registry.size > 0) {
                await attachToMostRecentSession(ws, registry, bridge).catch((err: unknown) => {
                  logger.error(`[websocket] attach to most recent failed: ${formatError(err)}`);
                });
              } else {
                await createAndAttachSession(ws, registry);
              }
            }
          } else {
            ws.send(
              JSON.stringify({ type: S2C.AUTH_ERROR, message: "Invalid token" }),
            );
          }
        } else {
          // Malformed AUTH: answer instead of going silent, or the client
          // waits out the pending-auth timeout with no clue why.
          ws.send(
            JSON.stringify({ type: S2C.AUTH_ERROR, message: "AUTH message requires a token" }),
          );
        }
      }
      break;
    }

    case C2S.CREATE_SESSION: {
      if (ws.activeSessionId && ws.activeChannel) {
        registry.removeChannel(ws.activeSessionId, ws.activeChannel);
      }
      registry
        .create({
          profile: msg.profile as string | undefined,
          model: msg.model as string | undefined,
          questionStrategy: msg.questionStrategy as string | undefined,
          questionTimeoutSecs: msg.questionTimeoutSecs as number | undefined,
        })
        .then(({ sessionId, agent }) => {
          const channel = registry.createChannel(sessionId, ws);
          ws.activeSessionId = sessionId;
          ws.activeChannel = channel;

          const sessionCreatedMsg = {
            type: S2C.SESSION_CREATED,
            sessionId,
            profile: agent.profileName || "default",
            // Fresh session: no explicit title yet, display follows profile.
            title: null,
            currentModel: agent.model,
            models: Object.keys(agent.modelRegistry || {}),
            sttEnabled: registry.sttEnabled,
            toolExec: registry.toolExecLabel,
          };
          SessionRegistry.sendSafe(ws, sessionCreatedMsg);
          registry.broadcast(sessionCreatedMsg);
          registry.sendTaskSnapshot(ws);
        })
        .catch((err: unknown) => {
          SessionRegistry.sendSafe(ws, {
            type: S2C.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      break;
    }

    case C2S.DELETE_SESSION: {
      if (msg.sessionId) {
        registry.delete(msg.sessionId as string);
        const sessionDeletedMsg = {
          type: S2C.SESSION_DELETED,
          sessionId: msg.sessionId,
        };
        ws.send(JSON.stringify(sessionDeletedMsg));
        registry.broadcast(sessionDeletedMsg);
      }
      break;
    }

    case C2S.RENAME_SESSION: {
      if (msg.sessionId && msg.newName) {
        registry.rename(msg.sessionId as string, msg.newName as string);
      }
      break;
    }

    case C2S.LIST_SESSIONS: {
      const sessions = registry.list();
      ws.send(JSON.stringify({ type: "sessions", sessions }));
      break;
    }

    case C2S.LIST_PROFILES: {
      const profiles = registry.listProfiles();
      ws.send(JSON.stringify({ type: S2C.PROFILES, profiles }));
      break;
    }

    case C2S.SWITCH_PROFILE: {
      if (msg.sessionId && msg.profileName) {
        const result = await registry.switchProfile({
          sessionId: msg.sessionId as string,
          profileName: msg.profileName as string,
        });
        if (result.success) {
          ws.send(
            JSON.stringify({
              type: S2C.PROFILE_SWITCHED,
              sessionId: msg.sessionId,
              profile: msg.profileName,
              success: true,
            }),
          );
        } else {
          ws.send(
            JSON.stringify({
              type: S2C.ERROR,
              message: result.error || "Profile switch failed",
            }),
          );
        }
      }
      break;
    }

    case C2S.SWITCH_SESSION: {
      // Manual sidebar switch: the client has no replay cursor for a session
      // it is not currently on, so this is always a full replay (cursor 0).
      if (msg.sessionId) {
        const attached = await attachLiveSession(
          ws,
          registry,
          bridge,
          msg.sessionId as string,
        );
        if (!attached) {
          ws.send(JSON.stringify({ type: S2C.ERROR, message: "Session not found" }));
        }
      }
      break;
    }

    case C2S.SEND: {
      const sid = msg.sessionId as string | undefined;
      const text = typeof msg.content === "string" ? msg.content : "";
      const files = msg.files;
      if (!sid) break;

      // A new prompt supersedes any resumed question still on hold.
      dismissResumedQuestions(bridge, registry, sid);

      if (Array.isArray(files) && files.length > 0) {
        // Webui upload: base64 files on the send message.
        // Validation is all-or-nothing so nothing is ever silently dropped.
        // Provenance: the parse happened server-side, so this enqueue is harness-authoritative --
        // the only way file-include parts survive the bus queue boundary (sanitizeQueuedContent).
        const agent = sessionManager.getAgentBySessionId(sid);
        const limits = uploadLimits(core);
        const parsed = parseUploadedFiles(files, {
          ...limits,
          vision: modelAcceptsImages(agent?.model, (agent as { modelRegistry?: Record<string, never> } | undefined)?.modelRegistry),
        });
        if (parsed.errors.length > 0) {
          SessionRegistry.sendSafe(ws, {
            type: S2C.ERROR,
            message: `Upload rejected: ${parsed.errors.join("; ")}`,
          });
          break;
        }
        const content: Array<Record<string, unknown>> = [];
        if (text) content.push({ type: "untrusted", text });
        content.push(...parsed.parts);
        if (content.length === 0 && parsed.images.length === 0) break;
        registry.touch(sid);
        registry.incrementUserMessageCount(sid);
        sessionManager.enqueue(sid, content, {
          source: "harness",
          ...(parsed.images.length > 0 ? { images: parsed.images } : {}),
        });
        break;
      }

      if (text) {
        registry.touch(sid);
        registry.incrementUserMessageCount(sid);
        sessionManager.enqueue(
          sid,
          text,
          msg.steering === true ? { steering: true } : undefined,
        );
      }
      break;
    }

    case C2S.CANCEL: {
      if (msg.sessionId) {
        // interrupt() keeps the bus alive for follow-ups; cancel() would abort it.
        sessionManager.interrupt(msg.sessionId as string);
        // Unblock a pending question-tool call so it can't hang.
        bridge.cancel(msg.sessionId as string);
      }
      break;
    }

    // Subagent panel controls: thin delegates onto the TaskManager primitives
    // the task_interrupt / task_followup tools already use. No control logic
    // here -- the primitives own queued/running/parked semantics.
    case C2S.TASK_INTERRUPT: {
      const taskId = typeof msg.taskId === "string" ? msg.taskId : null;
      if (!taskId) break;
      const taskManager = registry.getTaskManager();
      const ok = taskManager ? taskManager.interruptTask(taskId) : false;
      SessionRegistry.sendSafe(
        ws,
        taskControlMessage(
          taskId,
          "interrupt",
          ok,
          ok ? undefined : "Task not found or no longer active",
        ),
      );
      break;
    }

    case C2S.TASK_FOLLOWUP: {
      const taskId = typeof msg.taskId === "string" ? msg.taskId : null;
      const message = typeof msg.message === "string" ? msg.message.trim() : "";
      if (!taskId || !message) break;
      const taskManager = registry.getTaskManager();
      const ok = taskManager ? taskManager.sendFollowUp(taskId, message) : false;
      SessionRegistry.sendSafe(
        ws,
        taskControlMessage(
          taskId,
          "followup",
          ok,
          ok ? undefined : "Steering needs a running task with a live turn",
        ),
      );
      break;
    }
    case C2S.TASK_ACTIVITY_REQUEST: {
      // Buffered tail for one task, requester only. Gated to the socket's own
      // session, so probing arbitrary task ids leaks nothing.
      const taskId = typeof msg.taskId === "string" ? msg.taskId : null;
      if (!taskId) break;
      const taskManager = registry.getTaskManager();
      const owner = taskManager ? taskManager.getTaskSession(taskId) : undefined;
      const allowed = owner !== undefined && owner === ws.activeSessionId;
      SessionRegistry.sendSafe(ws, {
        type: S2C.TASK_ACTIVITY_HISTORY,
        taskId,
        activity: allowed ? registry.getTaskActivityHistory(taskId) : [],
      });
      break;
    }

    case C2S.QUESTION_ANSWER: {
      const sid = msg.sessionId as string | undefined;
      const answers = msg.answers;
      if (sid && answers && typeof answers === "object" && !Array.isArray(answers)) {
        if (bridge.answer(sid, answers as Record<string, unknown>)) {
          // Notify all clients (multiple tabs may be showing the prompt).
          registry.broadcast({
            type: S2C.QUESTION_ANSWERED,
            sessionId: sid,
            answers,
          });
        } else {
          ws.send(
            JSON.stringify({
              type: S2C.ERROR,
              message: `No pending question for session ${sid}`,
            }),
          );
        }
      }
      break;
    }

    case C2S.COMMAND: {
      if (msg.sessionId && msg.command) {
        registry.touch(msg.sessionId as string);
        let cmdText = msg.command as string;
        if (cmdText.startsWith("/")) {
          cmdText = cmdText.slice(1).trim();
        }

        // /fork is intercepted rather than dispatched to the bus: the registry must
        // register the new session's UI metadata and re-target the requesting socket,
        // or the tab stays on the source and the fork is unreachable in the webui.
        if (cmdText === "fork" || cmdText.startsWith("fork ")) {
          const { turnsBack, prompt } = parseForkArg(cmdText.slice("fork".length));
          registry
            .fork(msg.sessionId as string, { turnsBack })
            .then(({ sessionId: newSessionId, agent }) => {
              if (ws.activeSessionId && ws.activeChannel) {
                registry.removeChannel(ws.activeSessionId, ws.activeChannel);
              }
              ws.activeSessionId = newSessionId;
              ws.activeChannel = registry.createChannel(newSessionId, ws);

              const sessionCreatedMsg = {
                type: S2C.SESSION_CREATED,
                sessionId: newSessionId,
                profile: agent.profileName || "default",
                // Fresh session (branch): no explicit title yet, display follows profile.
                title: null,
                currentModel: agent.model,
                models: Object.keys(agent.modelRegistry || {}),
                sttEnabled: registry.sttEnabled,
                toolExec: registry.toolExecLabel,
              };
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
              SessionRegistry.sendSafe(ws, {
                type: S2C.ERROR,
                message: err instanceof Error ? err.message : String(err),
              });
            });
          break;
        }

        sessionManager.executeCommand(msg.sessionId as string, cmdText);
      }
      break;
    }

    case C2S.COMPLETE: {
      // Same core completion system the interactive CLI uses; the client
      // renders the list and replaces `prefix` at its own caret.
      if (!completion || !msg.sessionId) break;
      const session = registry.get(msg.sessionId as string);
      const agent = session?.agent;
      if (!agent) break;

      const line =
        (typeof msg.line === "string" ? msg.line : "").slice(0, MAX_COMPLETE_LINE);
      let cursorPos = Number.isFinite(msg.cursorPos)
        ? Math.trunc(msg.cursorPos as number)
        : line.length;
      cursorPos = Math.max(0, Math.min(cursorPos, line.length));

      const ctx = parseCompletionContext(line, cursorPos, agent);
      const options = await completion.request(ctx, 200);
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
      break;
    }

    case C2S.TRANSCRIBE: {
      await handleTranscribe(ws, msg, registry.sttTarget);
      break;
    }

    case C2S.LIST_LOGS: {
      // Awaited so the reply has settled when routeMessage resolves (the
      // directory read is real I/O; fire-and-forget raced the caller).
      await listSessionLogs()
        .then((logs) => {
          // Only return cold logs, not sessions that are still live.
          const activeIds = new Set(registry.list().map((s) => s.id));
          const coldLogs = logs
            .filter((log) => !activeIds.has(log.id))
            .map((log) => {
              // The index row carries the session's derived state (parked,
              // interrupted, ...) so the sidebar can badge it; missing row
              // (fresh log, unreconciled) simply has no state.
              const row = getSessionRow(log.id);
              return row ? { ...log, state: row.state } : log;
            });
          SessionRegistry.sendSafe(ws, {
            type: S2C.LOGS_LISTED,
            logs: coldLogs,
          });
        })
        .catch((err: unknown) => {
          SessionRegistry.sendSafe(ws, {
            type: S2C.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      break;
    }

    case C2S.LOAD_LOG: {
      // "Continue": resume the log under its OWN session id (identity is
      // preserved; the session keeps living in the same log). User-initiated,
      // so auto=false: the livelock cap never blocks an explicit resume, and
      // its resume_attempt records as manual. If the log is already live
      // (another tab on it), this is just an attach.
      if (msg.logId) {
        // Awaited for the settle contract: the attach reads the real log.
        await attachResumedSession(ws, registry, bridge, msg.logId as string, 0, false).catch(
          (err: unknown) => {
            logger.error(`[websocket] loadLog failed: ${formatError(err)}`);
            SessionRegistry.sendSafe(ws, {
              type: S2C.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
          },
        );
      }
      break;
    }

    case C2S.VIEW_LOG: {
      if (msg.logId) {
        // Awaited so the caller sees LOG_VIEWED/ERROR on return (real log read).
        await readSessionEntries(msg.logId as string)
          .then((entries) => {
            // Log entries carry raw images; put them through the same wire cap so a huge base64 can't flood the socket.
            const capped = entries.map((entry) => {
              const imgs = wireImages(entry.images);
              if (!entry.images) return entry;
              return { ...entry, images: imgs };
            });
            SessionRegistry.sendSafe(ws, {
              type: S2C.LOG_VIEWED,
              logId: msg.logId,
              entries: capped,
            });
          })
          .catch((err: unknown) => {
            SessionRegistry.sendSafe(ws, {
              type: S2C.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
          });
      }
      break;
    }

    case C2S.DELETE_LOG: {
      if (msg.logId) {
        // Awaited so the caller sees the confirm/error on return (real unlink).
        await deleteSessionLog(msg.logId as string)
          .then((deleted) => {
            if (deleted) {
              SessionRegistry.sendSafe(ws, {
                type: S2C.LOG_DELETED,
                logId: msg.logId,
              });
              registry.broadcast({ type: S2C.LOG_DELETED, logId: msg.logId });
            } else {
              SessionRegistry.sendSafe(ws, {
                type: S2C.ERROR,
                message: `Log ${msg.logId} not found`,
              });
            }
          })
          .catch((err: unknown) => {
            SessionRegistry.sendSafe(ws, {
              type: S2C.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
          });
      }
      break;
    }

    default: {
      ws.send(
        JSON.stringify({
          type: S2C.ERROR,
          message: `Unknown message type: ${(msg as Record<string, unknown>).type}`,
        }),
      );
      break;
    }
  }
}
