// S2C wire message builders: the single byte-home for the conversation
// message shape. The live OUTPUT_EVENT mapper (websocket-channel.ts) and both
// history-replay paths (replay.ts: log entries and in-memory Messages) build
// their frames here, so the client sees one wire shape regardless of source.
// Any field-order or guard change lands once, for live and replay together.

import { OUTPUT_EVENT, type FileAttachmentView, type OutputEvent } from "@core/context/output.ts";
import { summarizeHeaderArgs, summarizeToolArgs } from "@core/extensions/tool-utils.ts";
import type { ArgDisplay, ToolDisplaySpec } from "@core/extensions/tool-registry.ts";
import { toolContentMeta, toolContentText } from "@utils/tool-content.ts";
import type { CtxUsage } from "@utils/session-turns.ts";
import { trySessionPath } from "@core/session/session-log.ts";
import type { TaskInfo } from "@core/session/task-types.ts";
import type { LineageRecord } from "@core/session/spawn-log.ts";
import { S2C, type S2CType, type TaskActivityWire, type ToolDisplayWire, wireImages } from "./protocol.ts";

/**
 * TaskInfo -> TaskInfoWire for the two task frames (snapshot TASK_LIST and
 * relay TASK_UPDATE): the core fields ride untouched, plus ONE derived
 * display field -- `agentLogPath`, the absolute log file path of the worker's
 * session, gated by the same core helper the cold-log rows use (omitted when
 * the id fails the path gate or there is no agent yet). The webui row menu
 * needs it for "Copy log file path", and the browser cannot compute the
 * server's sessions dir -- this is the cold-rows' logPath grammar, one level
 * down. The worker's own session id (agentSessionId) already rides from core;
 * Export keys on it through the EXISTING /export route.
 */
export function taskWire(info: TaskInfo): Record<string, unknown> {
  const logPath = info.agentSessionId ? trySessionPath(info.agentSessionId) : undefined;
  return {
    ...info,
    ...(logPath !== undefined ? { agentLogPath: logPath } : {}),
  };
}

/**
 * LineageRecord -> task row for the RESTART-REBUILT subagent feed (the boot
 * snapshot on live rows, the nested `subagents` array on cold rows). The row
 * speaks the TaskInfoWire grammar so the client renders it with the one
 * sidebar component, plus ONE new derived field, `durable: true`: there is no
 * live task behind it, so the client opens the worker's durable log (viewLog
 * / LOG_VIEWED) instead of requesting the process-local activity replay.
 *
 * Honesty rules (the durability batch's interrupted-task doctrine, restated
 * for the sidebar):
 *  - An OPEN sidecar record means the writing process died mid-task: the
 *    status is "interrupted" -- never a claim that a dead worker runs.
 *  - A closed record carries its RECORDED outcome through untouched (an
 *    end line that lost its outcome yields "", which the client's unknown-
 *    glyph fallback shows; nothing is upgraded to "completed").
 *  - startedAt is unattested (null). The elapsed clock rides the sidecar's
 *    own wall stamps -- spawn->end for a closed record, spawn->observation
 *    for an interrupted one -- frozen at read time (turnStartedAt null,
 *    inRun false), so a dead row never ticks.
 *  - agentSessionId rides only when the sidecar recorded the worker join;
 *    pre-join records render as labelled, unopenable rows (the client hides
 *    Open/menu items whose fields are absent, the rowMenuTail idiom).
 *  - The engine run dir (workflow spawns record it on the spawn line) rides
 *    the same gate taskWire uses, so a restart survivor keeps Reveal.
 */
export function taskLineageWire(rec: LineageRecord): Record<string, unknown> {
  const logPath = rec.agentSessionId ? trySessionPath(rec.agentSessionId) : undefined;
  const elapsed =
    rec.spawnedAt === null
      ? 0
      : Math.max(0, (rec.endedAt ?? rec.observedAt) - rec.spawnedAt);
  return {
    taskId: rec.taskId,
    description: rec.description,
    sessionId: rec.sessionId,
    status: rec.outcome ?? "interrupted",
    createdAt: rec.spawnedAt ?? 0,
    startedAt: null,
    endedAt: rec.endedAt,
    activeMs: elapsed,
    inRun: false,
    turnStartedAt: null,
    durable: true,
    ...(rec.agentSessionId !== null ? { agentSessionId: rec.agentSessionId } : {}),
    ...(logPath !== undefined ? { agentLogPath: logPath } : {}),
    ...(rec.runDir !== null ? { runDir: rec.runDir } : {}),
  };
}

/** Mapper options: resolves a tool's per-parameter display hints
 * (argDisplay), its title-bar keys (ToolMetadata.headerKeys), and its
 * call-level display parts (ToolMetadata.display). */
export interface WireMapOptions {
  argDisplay?: (toolName: string) => Record<string, ArgDisplay> | undefined;
  headerKeys?: (toolName: string) => readonly string[] | undefined;
  display?: (toolName: string) => ToolDisplaySpec[] | undefined;
}

/** Content-only messages (thinking, assistant text, streaming chunks, ...). */
export function s2cContent(
  type: S2CType,
  sessionId: string,
  content: string,
): Record<string, unknown> {
  return { type, sessionId, content };
}

/**
 * Assistant message frame. `meta` carries the webui footer data only the
 * log attests: completion ts (the entry timestamp, epoch ms), the duration
 * of the bracketing TURN (`durationMs`, the "Worked for" total), and the
 * ctx usage (`ctx`, see CtxUsage) attested at that message's commit. The
 * call's OWN wall time rides `callMs` (one LLM call, not the turn: a turn
 * can span several calls); `callDerived` marks such a value as a log-gap
 * derivation rather than a duration recorded on the usage record, so the
 * client tooltip can say so instead of dressing a derived number as
 * recorded. Live event frames carry none of these (the client measures its
 * own turn and folds the live TOKEN_USAGE event it receives into the
 * footer); replay fills what the log knows. An empty `content` is the
 * text-less response frame (tool calls and/or reasoning only): the client
 * renders no bubble, only the bar -- no copy button, and nothing at all
 * without a trustworthy ts.
 */
export function s2cAssistantMessage(
  sessionId: string,
  content: string,
  meta?: { ts?: number; durationMs?: number; ctx?: CtxUsage; callMs?: number; callDerived?: boolean },
): Record<string, unknown> {
  return {
    type: S2C.ASSISTANT_MESSAGE,
    sessionId,
    content,
    ...(meta?.ts !== undefined ? { ts: meta.ts } : {}),
    // Duration fields ride only as trustworthy numbers (finite, >= 0): the
    // helpers already uphold this, and the gate here keeps a hand-corrupted
    // log record from pushing a negative onto the wire (the client render
    // gates too -- defense in depth, same posture as s2cTokenUsage).
    ...(meta?.durationMs !== undefined && Number.isFinite(meta.durationMs) && meta.durationMs >= 0
      ? { durationMs: meta.durationMs }
      : {}),
    ...(meta?.ctx !== undefined ? { ctx: meta.ctx } : {}),
    ...(meta?.callMs !== undefined && Number.isFinite(meta.callMs) && meta.callMs >= 0
      ? { callMs: meta.callMs }
      : {}),
    ...(meta?.callDerived === true ? { callDerived: true } : {}),
  };
}

export function s2cUserMessage(
  sessionId: string,
  o: { content: string; files?: FileAttachmentView[]; images?: unknown },
): Record<string, unknown> {
  const imgs = wireImages(o.images);
  return {
    type: S2C.USER_MESSAGE,
    sessionId,
    content: o.content,
    ...(o.files && o.files.length > 0 ? { files: o.files } : {}),
    ...(imgs ? { images: imgs } : {}),
  };
}

/**
 * Resolve a tool's declared display parts into the wire shape
 * (ToolDisplayWire[]): a declared-spec copy -- array order preserved,
 * unknown kinds forwarded untouched (sinks skip what they don't know),
 * values are arg PARAMETER names never values. Nothing declared -- or an
 * empty array -- rides no field. This is the ONE metadata->wire mapping
 * seam: live, replay and the cold LOG_VIEWED annotation all route through
 * it, so they cannot drift.
 */
export function wireToolDisplay(
  display: ToolDisplaySpec[] | undefined,
): ToolDisplayWire[] | undefined {
  if (!display || display.length === 0) return undefined;
  return display.map((spec) => ({ ...spec }));
}

/**
 * A tool call frame. argsSummary is the shared hint-driven fold
 * (ToolMetadata.argDisplay): the same shape the terminal's template args slot
 * prints, ANSI-free. Empty summaries ride no field; clients fall back to
 * their own header. EXCEPTION: a tool that declares headerKeys
 * (ToolMetadata.headerKeys) gets the title-bar fold instead
 * (summarizeHeaderArgs), and it rides even when empty -- `argsSummary: ""`
 * is the explicit "no summary, no fallback" signal (the body's declared
 * parts are the story). `display` is the forwarded declared spec
 * (ToolMetadata.display -> ToolDisplayWire[]): arg parameter names only,
 * omitted entirely when the tool declares nothing.
 */
export function s2cToolCall(
  sessionId: string,
  o: {
    name: string;
    args: string;
    toolCallId?: string;
    argDisplay?: Record<string, ArgDisplay>;
    display?: ToolDisplaySpec[] | undefined;
    headerKeys?: readonly string[] | undefined;
  },
): Record<string, unknown> {
  const summary = o.headerKeys
    ? summarizeHeaderArgs(o.args, o.headerKeys, o.argDisplay)
    : summarizeToolArgs(o.args, undefined, o.argDisplay);
  const display = wireToolDisplay(o.display);
  return {
    type: S2C.TOOL_CALL,
    sessionId,
    name: o.name,
    args: o.args,
    // The call id lets clients pair results to calls.
    ...(o.toolCallId ? { toolCallId: o.toolCallId } : {}),
    // A declared header fold always rides ("" = suppress the client header);
    // the shared fold keeps its old rule (non-empty only).
    ...(o.headerKeys !== undefined || summary ? { argsSummary: summary } : {}),
    ...(display ? { display } : {}),
  };
}

export function s2cToolResult(
  sessionId: string,
  o: {
    name: string;
    content: string | Array<unknown> | null | undefined;
    toolCallId?: string | null;
    images?: unknown;
    error?: string;
  },
): Record<string, unknown> {
  const imgs = wireImages(o.images);
  // A result part that knows where its change landed (edit's `start_line`
  // meta) rides it as a structured number: the diff rails then number from
  // the real file line instead of the snippet's 1..N. Anything not a
  // positive integer is dropped -- a blank rail beats a fake number.
  const startLine = Number(toolContentMeta(o.content, "start_line"));
  return {
    type: S2C.TOOL_RESULT,
    sessionId,
    name: o.name,
    // Content parts travel as text on this transport: the browser has no
    // part renderer, so flatten the fields here (display, not a format).
    output: toolContentText(o.content),
    ...(o.toolCallId ? { toolCallId: o.toolCallId } : {}),
    ...(o.error !== undefined ? { error: o.error } : {}),
    ...(imgs ? { images: imgs } : {}),
    ...(Number.isInteger(startLine) && startLine > 0 ? { startLine } : {}),
  };
}

/** Per-tool display-metadata view the task-activity relay resolves from the
 *  producing (worker) agent's own tool registry -- the same ToolMetadata
 *  keys createChannel hands to s2cToolCall for live session frames. */
export interface TaskActivityToolMeta {
  argDisplay?: Record<string, ArgDisplay>;
  headerKeys?: readonly string[];
  display?: ToolDisplaySpec[];
}

/**
 * Attach the display-DSL posture fields to one serialized task-activity item
 * so the subagent transcript reaches the SAME ToolBlock postures as a live
 * session view (read file box, edit inline diff, bash code block; owner
 * ruling 2026-11-13). s2cToolCall/s2cToolResult stay the byte-home: the fold
 * (with its headerKeys tri-state) and the declared-spec copy are computed
 * here with the same calls from the same raw event fields -- the fold reads
 * the FULL event.input exactly like the session frame (the relay's truncated
 * `args` is a transport cap, never a posture input), and start_line gets the
 * same positive-integer gate. One computation, two envelopes: no drift
 * possible between the session path and the relay. A tool with no resolved
 * metadata rides the same hint-free fold the session frame computes (parity,
 * not presence) and no `display`; the result kind rides `startLine` only for
 * a positive integer.
 */
export function taskActivityWithPosture(
  activity: TaskActivityWire,
  event: OutputEvent,
  toolMeta: (toolName: string) => TaskActivityToolMeta | undefined,
): TaskActivityWire {
  if (activity.kind === "tool_call" && event.type === OUTPUT_EVENT.TOOL_CALL) {
    const meta = toolMeta(activity.name);
    const summary = meta?.headerKeys
      ? summarizeHeaderArgs(event.input, meta.headerKeys, meta.argDisplay)
      : summarizeToolArgs(event.input, undefined, meta?.argDisplay);
    const display = wireToolDisplay(meta?.display);
    return {
      ...activity,
      ...(meta?.headerKeys !== undefined || summary ? { argsSummary: summary } : {}),
      ...(display ? { display } : {}),
    };
  }
  if (activity.kind === "tool_result" && event.type === OUTPUT_EVENT.TOOL_RESULT) {
    const startLine = Number(toolContentMeta(event.content, "start_line"));
    return Number.isInteger(startLine) && startLine > 0 ? { ...activity, startLine } : activity;
  }
  return activity;
}

/** Loose source for TOKEN_USAGE: live events and raw log entries both fit. */
export interface TokenUsageWireSource {
  sessionPromptTokens?: number;
  sessionCompletionTokens?: number;
  sessionTotalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  contextWindow?: number;
  /** Wall ms of the producing LLM call (agent.ts measured span). */
  durationMs?: number;
}

/**
 * Ctx gauge view of a usage source, in the footer's field names: `used` is
 * the call's totalTokens and `total` the context window -- exactly the pair
 * the sidebar gauge caches (SessionRegistry.#trackUsage) and the session
 * index derives (deriveCtxFromLog), so footer and gauge always agree. The
 * window echoes whatever the event carries (stale-contextLimit on un-
 * registered models is an open finding in agent.ts; fixing it there fixes
 * gauge and footer together, so nothing here may hardwire a constant).
 * Both numbers need finite > 0 to count as attested (same gate as
 * deriveCtxFromLog); unattested fields ride no wire field.
 */
export function ctxFromUsage(u: TokenUsageWireSource): Pick<CtxUsage, "used" | "total"> | undefined {
  const used = typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens) && u.totalTokens > 0
    ? u.totalTokens
    : undefined;
  const total = typeof u.contextWindow === "number" && Number.isFinite(u.contextWindow) && u.contextWindow > 0
    ? u.contextWindow
    : undefined;
  if (used === undefined) return undefined;
  return total !== undefined ? { used, total } : { used };
}

export function s2cTokenUsage(
  sessionId: string,
  u: TokenUsageWireSource,
): Record<string, unknown> {
  const ctx = ctxFromUsage(u);
  const msg: Record<string, unknown> = {
    type: S2C.TOKEN_USAGE,
    sessionId,
    sessionPromptTokens: u.sessionPromptTokens || 0,
    sessionCompletionTokens: u.sessionCompletionTokens || 0,
    sessionTotalTokens: u.sessionTotalTokens || 0,
    promptTokens: u.promptTokens || 0,
    completionTokens: u.completionTokens || 0,
    totalTokens: u.totalTokens || 0,
    cachedTokens: u.cachedTokens || 0,
  };
  if (Number.isFinite(u.contextWindow)) msg.contextWindow = u.contextWindow;
  // The call's own wall time (sibling of the ctx pair, see the footer):
  // only a finite non-negative measurement rides the frame -- old records
  // and unmeasured callers stay silent.
  if (typeof u.durationMs === "number" && Number.isFinite(u.durationMs) && u.durationMs >= 0) {
    msg.durationMs = u.durationMs;
  }
  // Additive ctx fields for the message-list footer (older clients ignore
  // them). ctxTotal is gated finite>0 here, so a present-but-absurd window
  // (0/NaN) leaves the denominator off rather than rendering "126k/0".
  if (ctx) msg.ctxUsed = ctx.used;
  if (ctx?.total !== undefined) msg.ctxTotal = ctx.total;
  return msg;
}

/**
 * Map a live OutputEvent onto an S2C wire message. Adding an event type here
 * IS a protocol change; returning null keeps an event off the wire.
 */
export function toS2CMessage(
  event: OutputEvent,
  sessionId: string,
  opts?: WireMapOptions,
): Record<string, unknown> | null {
  switch (event.type) {
    case OUTPUT_EVENT.USER_MESSAGE:
      return s2cUserMessage(sessionId, { content: event.content, files: event.files, images: event.images });
    case OUTPUT_EVENT.ASSISTANT_MESSAGE:
      // No meta: a live event has no log entry behind it yet; the client
      // times its own turn (sessionState working true->false).
      return s2cAssistantMessage(sessionId, event.content);
    case OUTPUT_EVENT.STREAMING_CHUNK:
      return s2cContent(S2C.STREAMING_CHUNK, sessionId, event.content);
    case OUTPUT_EVENT.STREAMING_REASONING_CHUNK:
      return s2cContent(S2C.STREAMING_REASONING_CHUNK, sessionId, event.content);
    case OUTPUT_EVENT.THINKING:
      return s2cContent(S2C.THINKING, sessionId, event.content);
    case OUTPUT_EVENT.TOOL_CALL:
      return s2cToolCall(sessionId, {
        name: event.toolName,
        args: event.input,
        toolCallId: event.toolCallId,
        argDisplay: opts?.argDisplay?.(event.toolName),
        headerKeys: opts?.headerKeys?.(event.toolName),
        display: opts?.display?.(event.toolName),
      });
    case OUTPUT_EVENT.TOOL_RESULT:
      return s2cToolResult(sessionId, {
        name: event.toolName,
        content: event.content,
        toolCallId: event.toolCallId,
        images: event.images,
        error: event.error,
      });
    case OUTPUT_EVENT.COMPACTING:
      return { type: S2C.COMPACTING, sessionId, message: event.message };
    case OUTPUT_EVENT.COMMAND_RESULT:
      return s2cContent(S2C.COMMAND_RESULT, sessionId, event.content);
    case OUTPUT_EVENT.QUESTION:
      return { type: S2C.QUESTION, sessionId, questions: event.questions };
    case OUTPUT_EVENT.SYSTEM_MESSAGE:
      return s2cContent(S2C.SYSTEM_MESSAGE, sessionId, event.content);
    case OUTPUT_EVENT.STREAM_RESET:
      // Payload-free: { type, sessionId } is the whole instruction.
      return { type: S2C.STREAM_RESET, sessionId };
    case OUTPUT_EVENT.TASK_PROGRESS:
      return {
        type: S2C.TASK_PROGRESS,
        sessionId,
        taskId: event.taskId,
        status: event.status,
        ...(event.message !== undefined ? { message: event.message } : {}),
      };
    case OUTPUT_EVENT.TOKEN_USAGE:
      return s2cTokenUsage(sessionId, event);
    case OUTPUT_EVENT.COMPACTION_RESULT:
      return {
        type: S2C.COMPACTION_RESULT,
        sessionId,
        summary: event.summary,
        messagesCompacted: event.messagesCompacted,
      };
    case OUTPUT_EVENT.SESSION_STATE:
      return { type: S2C.SESSION_STATE, sessionId, key: event.key, value: event.value };
    default:
      // Frame-only events (QUEUE_UPDATE, TOOL_CALL_DELTA) intentionally stay
      // off the wire; write() drops what maps to null.
      return null;
  }
}
