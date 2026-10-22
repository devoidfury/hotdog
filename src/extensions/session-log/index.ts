// Session Log Extension
// Append-only JSONL audit trail for observability.

import { appendFile, open, readFile, access, mkdir } from "node:fs/promises";
import { HOOKS, type GateAction } from "@core/hooks.ts";
import { stripNulls } from "@utils/objects.ts";
import { CoreContext, ExtensionInstance } from "@core/extensions/types.ts";
import { isWrapperPart, isToolResultPart } from "@core/context/wrappers.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";

import { LOG_SOURCE, LOG_VERSION, MAX_CONSECUTIVE_AUTO_RESUMES, sessionPath, sessionsDir, type LogEntry } from "@core/session/session-log.ts";
import {
  reconcileSessionIndex,
  syncSessionFromLog,
  indexToolStarted,
  indexQuestionAsked,
  indexToolResult,
  indexResumeAttempt,
  indexSessionProfile,
  indexSessionModel,
} from "@core/session/session-index.ts";

interface SessionLogMessage {
  sessionId?: string;
  role: string | undefined;
  content?: string | Array<unknown>;
  reasoningContent?: string | null;
  toolCalls?: unknown;
  toolCallId?: string | null;
  /** Message provenance (Message.source); recorded as `origin` on the entry. */
  source?: string;
  /** Present when the payload is a live Message (not raw log data). */
  getTextContent?: () => string;
}


/**
 * Content to persist: structured content (harness messages with `untrusted`
 * parts) is kept as raw parts so replay restores the exact trust structure;
 * everything else stays plain text (images stripped) as before.
 */
function logContent(message: SessionLogMessage): string | Array<Record<string, unknown>> {
  const raw = message.content;
  // Raw parts ride the log as-is when they carry harness structure:
  // `untrusted` payloads (mangled only at the wire) and wrapper parts -- a
  // tool-result part must round-trip as DATA, since rendering it here would
  // bake one WireFormat's shape into a log that other formats (and the UI)
  // have to read.
  if (
    Array.isArray(raw) &&
    raw.some(
      (p) =>
        p != null &&
        typeof p === "object" &&
        ((p as Record<string, unknown>).type === "untrusted" || isWrapperPart(p)),
    )
  ) {
    return raw as Array<Record<string, unknown>>;
  }
  if (typeof message.getTextContent === "function") return message.getTextContent();
  return (raw as string | undefined) || "";
}

/**
 * Create a log entry from a message.
 */
function messageToLogEntry(
  message: SessionLogMessage & { content: string | Array<Record<string, unknown>> },
  source: string,
): LogEntry {
  // The executor's tool messages carry one ToolResultPart; its `tool` is the
  // authoritative name. Legacy string contents have no part, so no name.
  const toolResult = Array.isArray(message.content)
    ? (message.content as unknown[]).find(isToolResultPart)
    : undefined;
  return stripNulls({
    ts: new Date().toISOString(),
    session_id: message.sessionId || "unknown",
    role: message.role,
    source,
    v: LOG_VERSION,
    content: message.content,
    reasoning_content: message.reasoningContent || null,
    tool_calls: message.toolCalls || null,
    tool_call_id: message.toolCallId || null,
    tool_name: toolResult?.tool ?? null,
    // Provenance: recorded for every message so resume replay restores the
    // exact source (and the mangle exemption for "harness").
    origin: message.source ?? null,
  }) as LogEntry;
}

/**
 * Boot reconcile runs once per process per sessions dir: it is stat-only for
 * fresh rows (O(changed), not O(all)), and the session-log extension's
 * create() is the per-process point where the sessions world is already set
 * up. `--reindex` (resolved config) forces the full-scan repair mode.
 */
let reconciledDir: string | null = null;

/**
 * Create the session log extension.
 * Uses the current agent's session ID (from the hook context) for the log file.
 */
export async function create(core: CoreContext): Promise<ExtensionInstance> {
  // `--no-log` / HOTDOG_NO_LOG / noLog config
  if (core.resolved?.noLog) return {};

  // Canonical sessions dir (respects HOTDOG_SESSIONS_DIR for tests).
  const cacheDir = sessionsDir();
  await mkdir(cacheDir, { recursive: true });

  if (reconciledDir !== cacheDir) {
    reconciledDir = cacheDir;
    try {
      const stats = await reconcileSessionIndex({ full: !!core.resolved?.reindex });
      if (stats.adopted || stats.reindexed || stats.quarantined || stats.errors) {
        logger.warn(
          `[session-index] boot reconcile: ${stats.scanned} scanned, ${stats.unchanged} fresh, ` +
            `${stats.reindexed} re-read, ${stats.adopted} adopted, ${stats.quarantined} quarantined` +
            (stats.errors ? `, ${stats.errors} errors` : ""),
        );
      }
    } catch (err) {
      // The index is a mirror: a broken db file must never block a session.
      // Row staleness (or nothing at all) costs re-reads, never correctness.
      logger.error(
        `[session-index] boot reconcile failed: ${formatError(err)} -- continuing without the index`,
      );
    }
  }

  // Track session state
  let isRestoring = false;
  // Durability-barrier failures keyed by tool call id (set when that call's
  // tool_started fsync fails). notifyHooks swallows handler errors, so the
  // failure cannot propagate from TOOL_BEFORE_EXECUTE -- the TOOL_CALL gate
  // below refuses the call instead. Per-call, never a global flag: this
  // instance is shared across webui sessions, and another session's landed
  // write must not rescue a call whose own record is missing (replay would
  // read it as "never ran, safe to retry" when it may have run).
  const barrierFailures = new Map<string, string>();
  // Open turns per session (v2): set on the turn_started record, cleared on
  // turn_end. A rewind checkpoint (CONTEXT_REWOUND) uses this to re-emit the
  // marker below the reset. Compaction never reaches this path: it fires only
  // CONTEXT_REPLACED, which writes nothing (in-memory-only by design).
  const openTurns = new Map<string, "input" | "continuation">();
  // Last system prompt written per session. The prompt is audit content, so
  // it records once and re-records only when it actually changes (mid-run
  // /model rebuild, profile switch) or after a rewind checkpoint (the map
  // entry drops so the post-reset slice carries the prompt again).
  const loggedPrompts = new Map<string, string>();
  // Track the most recent session ID so readEntries/getLogPath work correctly.
  let lastSessionId: string | null = null;

  // Serialize writes per session file. Hook handlers fire independently (addMessage
  // does not await notifyHooks), so floating appendFile calls can land out of dispatch
  // order -- e.g. a /fork's first prompt entry written below the copied history it
  // should follow. Chaining keeps file order equal to hook dispatch order, which holds
  // because handlers enqueue synchronously (async handlers run to their first await
  // before the next dispatch).
  const writeQueues = new Map<string, Promise<void>>();
  const queuedAppend = (logPath: string, line: string): Promise<void> => {
    const prev = writeQueues.get(logPath) ?? Promise.resolve();
    // Chain on either outcome: one failed write must not poison the queue.
    const next = prev.then(
      () => appendFile(logPath, line),
      () => appendFile(logPath, line),
    );
    writeQueues.set(logPath, next);
    return next;
  };

  /**
   * Durability-class append: same write queue (file order = dispatch order),
   * fsynced so the record and everything appended before it survives
   * kill -9 / power loss. Only for records whose presence on disk carries
   * meaning: tool_started, question_asked.
   */
  const queuedFsyncAppend = (logPath: string, line: string): Promise<void> => {
    const prev = writeQueues.get(logPath) ?? Promise.resolve();
    const write = async () => {
      const fh = await open(logPath, "a");
      try {
        await fh.appendFile(line);
        await fh.sync();
      } finally {
        await fh.close();
      }
    };
    const next = prev.then(write, write);
    writeQueues.set(logPath, next);
    return next;
  };

  /** Validate + remember the log path for a session id; null when rejected. */
  const resolveLogPath = (sessionId: string): string | null => {
    try {
      const logPath = sessionPath(sessionId);
      lastSessionId = sessionId;
      return logPath;
    } catch (err) {
      logger.warn(`[session-log] rejected session id: ${formatError(err)}`);
      return null;
    }
  };

  /**
   * Mirror a just-fsynced record into the session index. Failures are loud
   * but harmless: the row goes stale (size/mtime disagree with the file),
   * and the next boot reconcile re-derives it from the log. Never allowed to
   * break the tool call that committed the record.
   */
  const safeIndex = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      logger.error(
        `[session-index] ${what} mirror write failed: ${formatError(err)} -- row stale, reconcile will repair`,
      );
    }
  };

  /** Map message role to the correct log source type. */
  const logSourceForRole = (role: string | undefined): string => {
    switch (role) {
      case "assistant":
        return LOG_SOURCE.LLM;
      case "tool":
        return LOG_SOURCE.TOOL_RESULT;
      case "user":
      case "system":
      case "harness":
      default:
        // Non-initial system messages (e.g. task completion) should be logged as user messages with wrapper --
        // but at this point they're already wrapped as user messages by the caller. If a bare system message
        // somehow makes it here, log it as a user input to avoid mislabeling it as the initial system prompt.
        // Harness-injected messages replay via their "harness" origin.
        return LOG_SOURCE.INPUT;
    }
  };

  /** Append one message to the agent's session log (validated path). */
  const appendMessageEntry = async (
    agent: { sessionId?: string },
    message: SessionLogMessage,
  ): Promise<void> => {
    const sessionId = agent.sessionId || "unknown";
    let logPath: string;
    try {
      logPath = sessionPath(sessionId);
    } catch (err) {
      logger.warn(`[session-log] rejected session id: ${formatError(err)}`);
      return;
    }
    lastSessionId = sessionId;

    const entry = messageToLogEntry(
      {
        sessionId: agent.sessionId,
        role: message.role,
        content: logContent(message),
        reasoningContent: message.reasoningContent,
        toolCalls: message.toolCalls,
        toolCallId: message.toolCallId,
        source: message.source,
      },
      logSourceForRole(message.role),
    );
    await queuedAppend(logPath, JSON.stringify(entry) + "\n");
  };

  /**
   * Record the built system prompt when it is new for this session. Fires at
   * message-entry and turn-start points because run() builds the prompt
   * before the first user message reaches the context, so the turn-1 record
   * lands above the first input row; TURN_START catches the rest (continuation
   * turns with no new input, and mid-run rebuilds after a model switch).
   * The prompt is never re-derived on replay (regenerated dynamically), so
   * this is pure audit -- plain append, not the durability fsync class.
   */
  const recordSystemPrompt = (agent: {
    sessionId?: string;
    context?: { getSystemPrompt?: () => string | null };
  }): Promise<void> | undefined => {
    const prompt = agent.context?.getSystemPrompt?.();
    if (typeof prompt !== "string" || prompt === "") return;
    const sessionId = agent.sessionId || "unknown";
    if (loggedPrompts.get(sessionId) === prompt) return;
    const logPath = resolveLogPath(sessionId);
    if (!logPath) return;
    // Remember before returning: concurrent dispatches of the same prompt
    // must not both enqueue.
    loggedPrompts.set(sessionId, prompt);
    const entry = stripNulls({
      ts: new Date().toISOString(),
      session_id: sessionId,
      source: LOG_SOURCE.SYSTEM_PROMPT,
      v: LOG_VERSION,
      content: prompt,
    });
    return queuedAppend(logPath, JSON.stringify(entry) + "\n");
  };

  return {
    hooks: {
      [HOOKS.SESSION_CREATE]: async ({
        sessionId,
        config,
      }: {
        sessionId: string;
        config: Record<string, unknown>;
      }) => {
        const logPath = resolveLogPath(sessionId);
        if (!logPath) return;
        const entry = stripNulls({
          ts: new Date().toISOString(),
          session_id: sessionId,
          source: LOG_SOURCE.SESSION_START,
          v: LOG_VERSION,
          content: "",
          model: (config.model as string) || null,
          profile: (config.profileName as string) || null,
        });
        await queuedAppend(logPath, JSON.stringify(entry) + "\n");
      },

      [HOOKS.SESSION_RESTORE_ACTIVE]: ({
        isRestoring: restoring,
      }: {
        isRestoring: boolean;
      }) => {
        isRestoring = restoring;
      },

      /**
       * Log messages as they enter the context.
       * Uses the agent's sessionId from the hook context to determine the log file.
       * Maps message roles to the correct log source types for proper replay.
       */
      [HOOKS.CONTEXT_MESSAGE]: async ({
        message,
        agent,
      }: {
        message: SessionLogMessage;
        agent: { sessionId?: string; context?: { getSystemPrompt?: () => string | null } };
      }) => {
        // Skip logging during session restoration to avoid duplicate entries
        if (isRestoring) return;
        // Both records enter the write queue synchronously (prompt first);
        // awaiting before the message enqueue would break dispatch-order
        // serialization for floating dispatches.
        const promptWrite = recordSystemPrompt(agent);
        await appendMessageEntry(agent, message);
        if (promptWrite) await promptWrite;
        // A tool_result closes its mirrored durability call (and can clear
        // awaiting_question). Index-only: no new log record here.
        if (message.role === "tool" && message.toolCallId) {
          await safeIndex("tool_result", () =>
            indexToolResult(agent.sessionId || "unknown", message.toolCallId!),
          );
        }
      },

      /**
       * Checkpoint the log on a deliberate rewind (/undo, /rewind, /clear): append a reset entry, then re-append the kept messages.
       * Replay slices from the last reset, so resume (and any fork of this session) sees exactly the rewound context while the
       * log stays append-only (the undone history remains above the marker for audit).
       *
       * System-role messages are skipped: the system prompt is regenerated on replay, so writing it would resurface it as a user message.
       */
      [HOOKS.CONTEXT_REWOUND]: async ({
        agent,
        newContext,
      }: {
        agent: { sessionId?: string };
        newContext: SessionLogMessage[];
      }) => {
        if (isRestoring) return;

        const sessionId = agent.sessionId || "unknown";
        let logPath: string;
        try {
          logPath = sessionPath(sessionId);
        } catch (err) {
          logger.warn(`[session-log] rejected session id: ${formatError(err)}`);
          return;
        }
        lastSessionId = sessionId;
        // The reset slices the replay window, and kept history re-appends skip
        // system messages -- drop the dedupe entry so the next turn's event
        // records the prompt again below the checkpoint.
        loggedPrompts.delete(sessionId);

        const resetEntry = stripNulls({
          ts: new Date().toISOString(),
          session_id: sessionId,
          source: LOG_SOURCE.RESET,
          v: LOG_VERSION,
          content: "",
        });

        // Enqueue the whole checkpoint synchronously (no await in between): the
        // block must be atomic in queue order, or a message dispatched mid-checkpoint
        // would replay between the reset marker and the kept history.
        let done = queuedAppend(logPath, JSON.stringify(resetEntry) + "\n");
        for (const message of newContext || []) {
          if (message.role === "system") continue;
          // appendMessageEntry queues synchronously before its first await.
          done = appendMessageEntry(agent, message);
        }
        // A mid-turn checkpoint truncates the epoch view: the original
        // turn_started sits above the reset and would vanish, hiding the open
        // turn. Re-emit the marker (same kind) in the same atomic block.
        // Between-turn rewinds have no open turn and add nothing.
        const openKind = openTurns.get(sessionId);
        if (openKind !== undefined) {
          const marker = stripNulls({
            ts: new Date().toISOString(),
            session_id: sessionId,
            source: LOG_SOURCE.TURN_STARTED,
            v: LOG_VERSION,
            content: { kind: openKind },
          });
          done = queuedAppend(logPath, JSON.stringify(marker) + "\n");
        }
        await done;
        // The reset moved the replay window and wiped all durability facts:
        // rebuild the row (and drop open_calls) from the checkpointed log.
        await safeIndex("rewind", () => syncSessionFromLog(sessionId));
      },

      /**
       * Write the tool_started record on the executor's awaited hook, so the
       * fsync lands the record (and the tool_calls entry appended before it)
       * before any side effect runs. Classification semantics: see
       * LOG_SOURCE.TOOL_STARTED.
       */
      [HOOKS.TOOL_BEFORE_EXECUTE]: async ({
        toolCallId,
        toolName,
        input,
        agent,
      }: {
        toolCallId?: string;
        toolName: string;
        input: string;
        agent: { sessionId?: string; profileName?: string; model?: string };
      }) => {
        if (!toolCallId) return; // no id to tie the record (and any replay) to
        const sessionId = agent.sessionId || "unknown";
        const logPath = resolveLogPath(sessionId);
        if (!logPath) return;
        const entry = stripNulls({
          ts: new Date().toISOString(),
          session_id: sessionId,
          source: LOG_SOURCE.TOOL_STARTED,
          v: LOG_VERSION,
          content: input,
          tool_call_id: toolCallId,
          tool_name: toolName,
        });
        // A rejection here is invisible to the executor (notifyHooks swallows
        // handler errors): catch, remember it against the call id, and let
        // the TOOL_CALL gate refuse it.
        try {
          await queuedFsyncAppend(logPath, JSON.stringify(entry) + "\n");
          barrierFailures.delete(toolCallId);
        } catch (err) {
          const why = formatError(err);
          barrierFailures.set(toolCallId, why);
          logger.error(
            `[session-log] durability barrier failed: ${why} -- tool ${toolCallId} is blocked until its record can be written`,
          );
          return;
        }
        // Commit point: the record is fsynced, so mirror the open call (and
        // cheap sidebar metadata) in one index transaction. State is NOT
        // touched -- a live writer mid-tool is not "interrupted", and the
        // index must never outrank the log.
        await safeIndex("tool_started", () =>
          indexToolStarted(sessionId, toolCallId, {
            profile: agent.profileName,
            model: agent.model,
          }),
        );
      },

      /**
       * Fail-closed gate: a call whose own tool_started write failed does not
       * run. The block surfaces to the model as a normal blocked tool result.
       * A retry is a new call id with a fresh barrier attempt.
       */
      [HOOKS.TOOL_CALL]: ({ toolCallId }: { toolCallId?: string }): GateAction | undefined => {
        if (typeof toolCallId !== "string" || toolCallId === "") return undefined;
        const failure = barrierFailures.get(toolCallId);
        if (!failure) return undefined;
        // The call is answered once (the block); forget its failure so the
        // map cannot accumulate stale ids.
        barrierFailures.delete(toolCallId);
        return {
          action: "block",
          result:
            `Tool not executed: the session log is unwritable (${failure}), so this call could not be recorded ` +
            "before its side effects. Fix the sessions directory (disk space / permissions) and retry. " +
            "If you accept losing crash-resume safety for this session, disable logging with --no-log.",
        };
      },

      /**
       * Turn lifecycle (v2): fsync turn_started on the turn's FIRST iteration
       * (turnIndex === 1; TURN_START fires per iteration). Awaited, so the
       * record lands before the turn's first LLM call: a crash mid-turn
       * leaves an open turn the auto-resume can continue.
       */
      [HOOKS.TURN_START]: async ({
        turnIndex,
        agent,
        kind,
      }: {
        turnIndex: number;
        agent: { sessionId?: string; context?: { getSystemPrompt?: () => string | null } };
        kind?: "input" | "continuation";
      }) => {
        // Fires per iteration: catches prompt rebuilds (model switch) and
        // continuation turns, where no CONTEXT_MESSAGE may ever arrive.
        // The enqueue is synchronous; the turn_started fsync chains after it.
        const promptWrite = recordSystemPrompt(agent);
        if (turnIndex !== 1) {
          if (promptWrite) await promptWrite;
          return;
        }
        const sessionId = agent.sessionId || "unknown";
        const logPath = resolveLogPath(sessionId);
        if (!logPath) {
          if (promptWrite) await promptWrite;
          return;
        }
        const entry = stripNulls({
          ts: new Date().toISOString(),
          session_id: sessionId,
          source: LOG_SOURCE.TURN_STARTED,
          v: LOG_VERSION,
          content: { kind: kind ?? "input" },
        });
        const turnRecord = queuedFsyncAppend(logPath, JSON.stringify(entry) + "\n");
        if (promptWrite) await promptWrite;
        await turnRecord;
        openTurns.set(sessionId, kind ?? "input");
      },

      /**
       * Turn lifecycle (v2): fsync turn_end when the turn stops (TURN_END
       * fires per iteration with stopped: false for in-turn advances).
       * Status: completed / cancelled (user interrupt) / error (failure or
       * empty-response budget spent). Awaited, so a crash cannot leave a
       * finished turn looking open.
       *
       * A between-turn context clear may run BEFORE this handler and
       * re-emit the open-turn marker; turn_end lands after that marker, so
       * the pair still closes. A crash strictly between the two writes
       * reports a false open turn (one spurious continuation, bounded).
       */
      [HOOKS.TURN_END]: async ({
        stopped,
        reason,
        cancelled,
        agent,
      }: {
        stopped: boolean;
        reason?: string;
        cancelled?: boolean;
        agent: { sessionId?: string };
      }) => {
        if (!stopped) return;
        // cancelled outranks reason: a late cancel still carries reason
        // "completion" ("cancelled" is only the mid-LLM abort path).
        const status =
          reason === "cancelled" || cancelled === true
            ? "cancelled"
            : reason === "error" || reason === "empty_response"
              ? "error"
              : "completed";
        const sessionId = agent.sessionId || "unknown";
        const logPath = resolveLogPath(sessionId);
        if (!logPath) return;
        const entry = stripNulls({
          ts: new Date().toISOString(),
          session_id: sessionId,
          source: LOG_SOURCE.TURN_END,
          v: LOG_VERSION,
          content: { status },
        });
        await queuedFsyncAppend(logPath, JSON.stringify(entry) + "\n");
        openTurns.delete(sessionId);
      },

      /**
       * Durability record for a resume into an existing log, fsynced before
       * the replay begins. The cap's counter lives in the log; the index
       * only mirrors it, so deleting the index costs a re-scan, never the
       * cap. `content` carries the origin (only "auto" resumes count);
       * pre-cap logs carry no origin and derive as manual.
       */
      [HOOKS.SESSION_RESUME_ATTEMPT]: async ({
        sessionId,
        origin,
        consecutiveAutoResumes,
      }: {
        sessionId: string;
        origin?: string;
        consecutiveAutoResumes?: number;
      }) => {
        const logPath = resolveLogPath(sessionId);
        if (!logPath) return;
        const entry = stripNulls({
          ts: new Date().toISOString(),
          session_id: sessionId,
          source: LOG_SOURCE.RESUME_ATTEMPT,
          v: LOG_VERSION,
          content: { origin: origin === "auto" ? "auto" : "manual" },
        });
        await queuedFsyncAppend(logPath, JSON.stringify(entry) + "\n");
        await safeIndex("resume_attempt", () =>
          indexResumeAttempt(sessionId, (consecutiveAutoResumes ?? 0) >= MAX_CONSECUTIVE_AUTO_RESUMES),
        );
      },

      [HOOKS.PROFILE_SWITCH]: async ({
        agent,
        fromProfile,
        toProfile,
      }: {
        agent: { sessionId?: string };
        fromProfile?: string;
        toProfile: string;
      }) => {
        const sessionId = agent.sessionId || "unknown";
        const logPath = resolveLogPath(sessionId);
        if (!logPath) return;
        const entry = stripNulls({
          ts: new Date().toISOString(),
          session_id: sessionId,
          source: LOG_SOURCE.PROFILE_SWITCH,
          v: LOG_VERSION,
          content: "",
          from_profile: fromProfile || null,
          profile: toProfile,
        });
        await queuedAppend(logPath, JSON.stringify(entry) + "\n");
        await safeIndex("profile_switch", () => indexSessionProfile(sessionId, toProfile));
      },

      /**
       * Model switch (model setter: /model, the webui selector, or the model
       * change implied by a profile switch). Without this record the model
       * timeline lives only in the index, so an index loss would silently
       * revert a switched session to its session_start model on the next
       * rebuild. Never replayed as a message.
       */
      [HOOKS.MODEL_CHANGE]: async ({
        agent,
        newModel,
      }: {
        agent: { sessionId?: string };
        newModel?: string;
      }) => {
        if (!newModel) return;
        const sessionId = agent.sessionId || "unknown";
        const logPath = resolveLogPath(sessionId);
        if (!logPath) return;
        const entry = stripNulls({
          ts: new Date().toISOString(),
          session_id: sessionId,
          source: LOG_SOURCE.MODEL_CHANGE,
          v: LOG_VERSION,
          content: "",
          model: newModel,
        });
        await queuedAppend(logPath, JSON.stringify(entry) + "\n");
        await safeIndex("model_change", () => indexSessionModel(sessionId, newModel));
      },

      [HOOKS.OUTPUT_EVENT]: async ({ type, data, agent }) => {
        // QUESTION durability: fsynced but fire-and-forget (handlers aren't awaited).
        if (type === "question") {
          const d = data as { toolCallId?: unknown; questions?: unknown };
          const toolCallId = typeof d.toolCallId === "string" ? d.toolCallId : "";
          const questions = Array.isArray(d.questions) ? d.questions : null;
          if (!toolCallId || !questions || questions.length === 0) return;
          const sessionId = agent.sessionId || "unknown";
          const logPath = resolveLogPath(sessionId);
          if (!logPath) return;
          const entry = stripNulls({
            ts: new Date().toISOString(),
            session_id: sessionId,
            source: LOG_SOURCE.QUESTION_ASKED,
            v: LOG_VERSION,
            content: questions,
            tool_call_id: toolCallId,
          });
          await queuedFsyncAppend(logPath, JSON.stringify(entry) + "\n");
          // Commit point: awaiting_question is honest the moment the record
          // lands -- alive or dead, the session IS waiting on a human now.
          await safeIndex("question_asked", () => indexQuestionAsked(sessionId, toolCallId));
          return;
        }

        // Token usage snapshot: replayed as an output event so the UI can
        // show the token bubble on cold-log load and reconnect.
        if (type === "token_usage") {
          const d = data as {
            sessionPromptTokens?: number;
            sessionCachedTokens?: number;
            sessionCompletionTokens?: number;
            sessionTotalTokens?: number;
            turns?: number;
            promptTokens?: number;
            cachedTokens?: number;
            completionTokens?: number;
            totalTokens?: number;
            contextWindow?: number;
          };
          const sessionId = agent.sessionId || "unknown";
          let logPath: string;
          try {
            logPath = sessionPath(sessionId);
          } catch (err) {
            logger.warn(`[session-log] rejected session id: ${formatError(err)}`);
            return;
          }
          const entry = stripNulls({
            ts: new Date().toISOString(),
            session_id: sessionId,
            source: LOG_SOURCE.TOKEN_USAGE,
            v: LOG_VERSION,
            content: "",
            sessionPromptTokens: d.sessionPromptTokens ?? 0,
            sessionCachedTokens: d.sessionCachedTokens ?? 0,
            sessionCompletionTokens: d.sessionCompletionTokens ?? 0,
            sessionTotalTokens: d.sessionTotalTokens ?? 0,
            turns: d.turns ?? 0,
            promptTokens: d.promptTokens ?? 0,
            cachedTokens: d.cachedTokens ?? 0,
            completionTokens: d.completionTokens ?? 0,
            totalTokens: d.totalTokens ?? 0,
            contextWindow: d.contextWindow ?? 0,
          });
          await queuedAppend(logPath, JSON.stringify(entry) + "\n");
          return;
        }

        if (type === "compaction_result") {
          const compactionData = data as { summary?: string; messagesCompacted?: number };
          if (compactionData?.summary) {
            const sessionId = agent.sessionId || "unknown";
            let logPath: string;
            try {
              logPath = sessionPath(sessionId);
            } catch (err) {
              logger.warn(`[session-log] rejected session id: ${formatError(err)}`);
              return;
            }
            lastSessionId = sessionId;
            // Log the message exactly as it enters the context: harness
            // structure with the real wrapper tag parts around the RAW
            // model-generated summary (`untrusted` part, mangled only at the
            // wire). Never escape here: the log must stay re-serializable by
            // any future session's mangler.
            const tag = "previous-context-summary";
            const entry = stripNulls({
              ts: new Date().toISOString(),
              session_id: sessionId,
              source: LOG_SOURCE.COMPACTION,
              v: LOG_VERSION,
              content: [
                { type: "text", text: `<${tag}>` },
                { type: "untrusted", text: compactionData.summary },
                { type: "text", text: `</${tag}>` },
              ],
              summary: compactionData.summary,
              messages_compacted: compactionData.messagesCompacted,
              // Compaction summaries are harness-generated content.
              origin: "harness",
            });
            await queuedAppend(logPath, JSON.stringify(entry) + "\n");
          }
        }
      },
    },

    /**
     * Read all entries from the session log.
     * Uses the most recently observed session ID.
     */
    async readEntries(): Promise<Record<string, LogEntry>[]> {
      if (!lastSessionId) return [];
      // lastSessionId is only set after a successful sessionPath() validation.
      const logPath = sessionPath(lastSessionId);
      // Drain the write queue: entries dispatched but not yet flushed (floating
      // hook writes) must be on disk before the read.
      const pending = writeQueues.get(logPath);
      if (pending) {
        try {
          await pending;
        } catch {}
      }
      try {
        await access(logPath);
      } catch {
        return [];
      }
      const content = await readFile(logPath, "utf-8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line: string) => JSON.parse(line));
    },

    /**
     * Get the session log path.
     * Returns the path for the most recently observed session ID.
     */
    getLogPath(): string | null {
      if (!lastSessionId) return null;
      return sessionPath(lastSessionId);
    },
  };
}

