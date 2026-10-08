import crypto from "node:crypto";
import { HOOKS, createHooks } from "@core/hooks.ts";
import { SessionManager, type AgentLike } from "@core/session/index.ts";
import { createTurnLanes, type TurnLanes } from "@core/session/turn-lanes.ts";
import type { SwitchProfile } from "@core/config/profiles.ts";
import { WebSocketChannel } from "./websocket-channel.ts";
import { C2S, S2C, C2SMessage, wireImages, taskActivityMessage } from "./protocol.ts";
import { parseUploadedFiles } from "./uploads.ts";
import { DEFAULT_MAX_IMAGE_SIZE } from "@extensions/core-tools/defaults.ts";
import { modelAcceptsImages } from "@core/config/providers.ts";
import { TaskManager, type TaskObserverEvent } from "@core/session/task-manager.ts";
import { registerTaskManagerService } from "../subagents/index.ts";
import { WebSocketQuestionBridge, type QuestionStrategy } from "./question-input.ts";
import type { LlmClient } from "@core/llm-client/client.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { getExtensionConfig } from "@core/extensions/types.ts";
import type { AuthMiddleware } from "./auth.ts";
import { Agent } from "@core/agent.ts";
import { createAgentFactory } from "@core/agent-factory.ts";
import {
  readSessionEntries,
  replayEntriesIntoContext,
  listSessionLogs,
  deleteSessionLog,
  type PendingQuestion,
} from "@core/session/session-log.ts";
import { Message } from "@core/context/message.ts";
import { formatToolResult } from "@core/extensions/tool-utils.ts";
import type { QuestionDef } from "@core/context/input.ts";
import { AgentError, formatError } from "@core/error.ts";
import { parseForkArg } from "@core/command-handlers.ts";
import { completionPrefix, parseCompletionContext } from "@core/completion.ts";
import { logger } from "@utils/logger.ts";
import { splitFileIncludes, toolContentText } from "@utils/tool-content.ts";
import { transcribeAudio } from "@utils/stt.ts";
import { resolveSttTarget, type SttTarget } from "@core/config/stt.ts";

interface SessionMetadata {
  profile: string;
  /**
   * Explicit session name, independent of the active profile. null means the
   * display name follows `profile`; an explicit title survives profile
   * switches.
   */
  title: string | null;
  model: string;
  createdAt: number;
  lastActivityAt: number;
  connectedClients: number;
  questionStrategy: string;
  questionTimeoutSecs: number;
  userMessageCount: number;
}

interface CreateSessionOptions {
  profile?: string;
  model?: string;
  questionStrategy?: string;
  questionTimeoutSecs?: number;
}

interface SwitchProfileOptions {
  sessionId: string;
  profileName: string;
  force?: boolean;
}

interface SessionRegistryOptions {
  buildAgent: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike>;
  llmClient?: LlmClient;
  questionTimeoutSecs?: number;
  questionStrategy?: string;
  sessionTimeoutMin?: number;
  profiles?: Record<string, SwitchProfile>;
  /** Resolved STT backend (explicit sttUrl or audio-capable registry model); advertised as sttEnabled. */
  sttTarget?: SttTarget | null;
  /** Invoked when a session is deleted (cancels its pending questions). */
  onSessionDeleted?: (sessionId: string) => void;
  /** Provider-lane coordinator for session turns. Without it webui turns
   *  run uncoordinated: two live sessions double up requests on one backend
   *  instead of queueing on the lane. */
  turnLanes?: TurnLanes;
}

interface CreateWsServerOptions {
  buildAgent?: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike>;
  sessionTimeoutMin?: number;
  questionTimeoutSecs?: number;
  questionStrategy?: string;
  auth?: AuthMiddleware;
  profiles?: Record<string, SwitchProfile>;
}

export interface WsServer {
  sessionRegistry: SessionRegistry;
  onUpgrade: (
    req: { url: string; headers?: Record<string, string> },
    ws: HotdogServerSocket<unknown>,
  ) => void;
  onMessage: (ws: HotdogServerSocket<unknown>, raw: string | Buffer) => void;
  onClose: (ws: HotdogServerSocket<unknown>) => void;
  startCleanupLoop: () => void;
  stopCleanupLoop: () => void;
  /** Release the TaskManager's provider-health sweep timer, if a TaskManager was built. */
  stopTaskManager: () => void;
}

export type HotdogServerSocket<T = undefined> = Bun.ServerWebSocket<T> & {
  activeSessionId?: string;
  activeChannel?: WebSocketChannel;
  authToken?: string;
};

// How long a socket that never authenticates is kept before the cleanup
// loop closes it. Comfortably longer than a legit AUTH round-trip (first
// message after open), short enough that anonymous sockets do not pile up.
const PENDING_AUTH_TIMEOUT_MS = 30_000;

// Cap for client-supplied completion input; nothing legit needs more.
const MAX_COMPLETE_LINE = 10_000;

// Ceiling on one transcribe upload, mirroring OpenAI's whisper 25MB limit.
// Checked against the base64 string length (inflates ~4/3) before decoding,
// so an oversized blob never costs a decode.
const MAX_TRANSCRIBE_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIBE_BASE64_CHARS = Math.ceil(MAX_TRANSCRIBE_AUDIO_BYTES / 3) * 4;

export class SessionRegistry {
  #sessionManager: SessionManager;
  #buildAgent: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike>;
  #questionTimeoutSecs: number;
  #questionStrategy: string;
  #cleanupTimer: ReturnType<typeof setInterval> | null = null;
  #timeoutMin: number;
  #allConnections = new Set<HotdogServerSocket<unknown>>();
  // Sockets that opened without a validated token and are waiting on the
  // protocol AUTH handshake (webui upgrades arrive unauthenticated). The
  // cleanup loop reaps these: without it a client could hold an anonymous
  // socket open forever.
  #pendingAuth = new Map<HotdogServerSocket<unknown>, number>();
  #metadata: Map<string, SessionMetadata>;
  #channels: Map<string, Set<WebSocketChannel>>;
  #profiles: Record<string, SwitchProfile>;
  #onSessionDeleted: ((sessionId: string) => void) | null;
  #taskManager: TaskManager | null = null;
  /** Resolved STT backend; every sessionCreated payload advertises its presence as sttEnabled. */
  readonly sttTarget: SttTarget | null;

  get sttEnabled(): boolean {
    return this.sttTarget !== null;
  }
  /** Publish the TaskManager whose observer feeds the webui subagents panel. */
  setTaskManager(taskManager: TaskManager | null): void {
    this.#taskManager = taskManager;
  }

  getTaskManager(): TaskManager | null {
    return this.#taskManager;
  }

  /** Current subagent task snapshot for one socket (sent on fresh auth). */
  sendTaskSnapshot(ws: HotdogServerSocket<unknown>): void {
    SessionRegistry.sendSafe(ws, {
      type: S2C.TASK_LIST,
      tasks: this.#taskManager ? this.#taskManager.listTasks() : [],
    });
  }

  constructor({
    buildAgent,
    llmClient,
    questionTimeoutSecs = 300,
    questionStrategy = "wait",
    sessionTimeoutMin = 30,
    profiles = {},
    sttTarget = null,
    onSessionDeleted,
    turnLanes,
  }: SessionRegistryOptions) {
    this.#buildAgent = buildAgent;
    this.#questionTimeoutSecs = questionTimeoutSecs;
    this.#questionStrategy = questionStrategy;
    this.#timeoutMin = sessionTimeoutMin;
    this.sttTarget = sttTarget;
    this.#metadata = new Map();
    this.#channels = new Map();
    this.#profiles = profiles;
    this.#onSessionDeleted = onSessionDeleted ?? null;

    this.#sessionManager = new SessionManager({
      hooks: createHooks(),
      extensions: null,
      buildAgent: buildAgent as (
        config: Record<string, unknown>,
      ) => Promise<AgentLike>,
      llmClient: llmClient,
      turnLanes,
    });
  }

  registerConnection(ws: HotdogServerSocket<unknown>): void {
    this.#allConnections.add(ws);
  }

  unregisterConnection(ws: HotdogServerSocket<unknown>): void {
    this.#allConnections.delete(ws);
  }

  addPendingAuth(ws: HotdogServerSocket<unknown>): void {
    this.#pendingAuth.set(ws, Date.now());
  }

  removePendingAuth(ws: HotdogServerSocket<unknown>): void {
    this.#pendingAuth.delete(ws);
  }

  broadcast(msg: Record<string, unknown>): void {
    for (const ws of this.#allConnections) {
      SessionRegistry.sendSafe(ws, msg);
    }
  }

  static sendSafe(ws: HotdogServerSocket<unknown>, msg: Record<string, unknown>): void {
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
      }
    } catch {}
  }

  async create({
    profile,
    model,
    questionStrategy,
    questionTimeoutSecs,
  }: CreateSessionOptions = {}): Promise<{
    sessionId: string;
    agent: AgentLike;
  }> {
    const proposedSessionId = crypto.randomUUID();

    const agent = await this.#buildAgent({
      model,
      sessionId: proposedSessionId,
      profileName: profile,
    });
    const actualSessionId = agent.sessionId || proposedSessionId;

    this.#metadata.set(actualSessionId, {
      profile: profile || "default",
      title: null,
      model: agent.model || "",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      connectedClients: 0,
      questionStrategy: questionStrategy || this.#questionStrategy,
      questionTimeoutSecs: questionTimeoutSecs || this.#questionTimeoutSecs,
      userMessageCount: 0,
    });

    this.#sessionManager.registerAgent(agent, {
      // Build-config shape (profileName, not profile): forkSession reuses this entry
      // metadata as the fork's buildAgent config, so the keys must match what #buildAgent reads.
      profileName: profile || "default",
      model,
    });

    return { sessionId: actualSessionId, agent };
  }

  /**
   * Branch a registry session (webui `/fork`): SessionManager.forkSession plus UI-side metadata
   * for the new session. No prompt here on purpose -- the caller enqueues it after re-targeting
   * the requesting socket, so the prompt's user message echoes live exactly once and the history
   * replay snapshot never races it.
   */
  async fork(
    sourceSessionId: string,
    opts: { turnsBack: number },
  ): Promise<{ sessionId: string; agent: AgentLike }> {
    const meta = this.#metadata.get(sourceSessionId);
    if (!meta) {
      throw new AgentError(`Cannot fork unknown session: ${sourceSessionId}`);
    }

    const { sessionId: newSessionId } = await this.#sessionManager.forkSession(
      sourceSessionId,
      opts,
    );
    const agent = this.#sessionManager.getAgentBySessionId(newSessionId);
    if (!agent) {
      throw new AgentError(`Forked session vanished: ${newSessionId}`);
    }

    this.#metadata.set(newSessionId, {
      profile: meta.profile,
      title: null,
      model: agent.model || meta.model,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      connectedClients: 0,
      questionStrategy: meta.questionStrategy,
      questionTimeoutSecs: meta.questionTimeoutSecs,
      userMessageCount: agent
        .getMessages()
        .filter((m) => m.role === "user").length,
    });

    return { sessionId: newSessionId, agent };
  }

  get(
    sessionId: string,
  ): { agent: AgentLike; metadata: SessionMetadata } | null {
    const metadata = this.#metadata.get(sessionId);
    if (!metadata) return null;
    const agent = this.#sessionManager.getAgentBySessionId(sessionId);
    if (!agent) return null;
    return { agent, metadata };
  }

  list(): Array<{
    id: string;
    profile: string;
    title: string | null;
    model: string;
    createdAt: number;
    lastActivityAt: number;
    connectedClients: number;
    userMessageCount: number;
  }> {
    const result: Array<{
      id: string;
      profile: string;
      title: string | null;
      model: string;
      createdAt: number;
      lastActivityAt: number;
      connectedClients: number;
      userMessageCount: number;
    }> = [];
    for (const [id, meta] of this.#metadata) {
      const agent = this.#sessionManager.getAgentBySessionId(id);
      result.push({
        id,
        profile: meta.profile,
        title: meta.title,
        model: agent?.model || meta.model,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        connectedClients: meta.connectedClients,
        userMessageCount: meta.userMessageCount,
      });
    }
    return result;
  }

  delete(sessionId: string): boolean {
    const meta = this.#metadata.get(sessionId);
    if (!meta) return false;

    const channels = this.#channels.get(sessionId);
    if (channels) {
      for (const ch of channels) {
        ch.close();
      }
      this.#channels.delete(sessionId);
    }

    this.#sessionManager.deleteSession(sessionId);
    this.#metadata.delete(sessionId);
    this.#onSessionDeleted?.(sessionId);
    return true;
  }

  /** True if the session has at least one connected channel. */
  hasChannels(sessionId: string): boolean {
    return (this.#channels.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * Set the session's display title. Independent of the active profile: the
   * profile keeps driving behavior (tools, model), while the title is
   * purely the label shown in the UI.
   */
  rename(sessionId: string, newName: string): boolean {
    const meta = this.#metadata.get(sessionId);
    if (!meta) return false;
    meta.title = newName;
    return true;
  }

  listProfiles(): Record<string, SwitchProfile> {
    return { ...this.#profiles };
  }

  async switchProfile({
    sessionId,
    profileName,
    force = false,
  }: SwitchProfileOptions): Promise<{
    success: boolean;
    requiresConfirmation: boolean;
    error?: string;
  }> {
    const meta = this.#metadata.get(sessionId);
    if (!meta) {
      return {
        success: false,
        requiresConfirmation: false,
        error: "Session not found",
      };
    }

    const profile = this.#profiles[profileName];
    if (!profile) {
      return {
        success: false,
        requiresConfirmation: false,
        error: `Profile "${profileName}" not found`,
      };
    }

    if (!force && meta.userMessageCount >= 1) {
      return { success: false, requiresConfirmation: true };
    }

    const agent = this.#sessionManager.getAgentBySessionId(sessionId);
    if (agent) {
      agent.applyProfile(profileName, profile);
      // Wipes messages + system prompt, hence the UI confirmation above.
      await agent.clearContext();
      meta.model = agent.model;
    }
    meta.profile = profileName;
    meta.userMessageCount = 0;
    meta.lastActivityAt = Date.now();

    return { success: true, requiresConfirmation: false };
  }

  incrementUserMessageCount(sessionId: string): void {
    const meta = this.#metadata.get(sessionId);
    if (meta) {
      meta.userMessageCount += 1;
    }
  }

  createChannel(
    sessionId: string,
    ws: HotdogServerSocket<unknown>,
  ): WebSocketChannel | undefined {
    const session = this.get(sessionId);
    if (!session) return undefined;

    const channel = new WebSocketChannel({
      sessionManager: this.#sessionManager,
      ws,
      sessionId,
      broadcastCallback: (msg: Record<string, unknown>) => this.broadcast(msg),
    });

    if (!this.#channels.has(sessionId)) {
      this.#channels.set(sessionId, new Set());
    }
    this.#channels.get(sessionId)!.add(channel);

    session.metadata.connectedClients += 1;
    session.metadata.lastActivityAt = Date.now();

    return channel;
  }

  removeChannel(sessionId: string, channel: WebSocketChannel): void {
    channel.detach(sessionId);

    const channels = this.#channels.get(sessionId);
    if (!channels) return;
    channels.delete(channel);

    const meta = this.#metadata.get(sessionId);
    if (meta) {
      meta.connectedClients = Math.max(0, meta.connectedClients - 1);
    }
  }

  // Prevents idle cleanup of the session.
  touch(sessionId: string): void {
    const meta = this.#metadata.get(sessionId);
    if (meta) {
      meta.lastActivityAt = Date.now();
    }
  }

  startCleanupLoop(timeoutMin: number): void {
    this.#timeoutMin = timeoutMin;
    if (this.#cleanupTimer) return;
    this.#cleanupTimer = setInterval(() => {
      this.#cleanupIdleSessions();
      this.#reapPendingAuth();
    }, 60_000);
  }

  stopCleanupLoop(): void {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
  }

  #cleanupIdleSessions(): void {
    const now = Date.now();
    const timeoutMs = this.#timeoutMin * 60 * 1000;
    for (const [id, meta] of this.#metadata) {
      if (
        now - meta.lastActivityAt > timeoutMs &&
        meta.connectedClients === 0
      ) {
        this.delete(id);
      }
    }
  }

  // Close sockets that never completed the AUTH handshake. A validated
  // token lands in ws.authToken (routeMessage), so authenticated sockets
  // just leave the map without being touched.
  #reapPendingAuth(): void {
    const now = Date.now();
    for (const [ws, since] of this.#pendingAuth) {
      if (ws.authToken) {
        this.#pendingAuth.delete(ws);
      } else if (now - since > PENDING_AUTH_TIMEOUT_MS) {
        this.#pendingAuth.delete(ws);
        try {
          ws.close(4001, "Authentication timeout");
        } catch {}
      }
    }
  }

  get size(): number {
    return this.#metadata.size;
  }

  /** @internal */
  getSessionManager(): SessionManager {
    return this.#sessionManager;
  }

  /** @internal */
  get _test_metadata(): Map<string, SessionMetadata> {
    return this.#metadata;
  }

  /** @internal */
  get _test_pendingAuth(): Map<HotdogServerSocket<unknown>, number> {
    return this.#pendingAuth;
  }

  /** @internal */
  _test_cleanupIdleSessions(): void {
    this.#cleanupIdleSessions();
    this.#reapPendingAuth();
  }
}

async function loadLogIntoNewSession(
  logId: string,
  registry: SessionRegistry,
): Promise<{ sessionId: string; agent: AgentLike; pendingQuestions: PendingQuestion[] }> {
  const entries = await readSessionEntries(logId);
  if (entries.length === 0) {
    throw new AgentError(`No entries found for session ${logId}`);
  }

  const newSession = await registry.create({});
  const { pendingQuestions } = replayEntriesIntoContext(newSession.agent, entries);

  return { sessionId: newSession.sessionId, agent: newSession.agent, pendingQuestions };
}

/** Held resumed questions per session (cold log with unanswered questions):
 *  each answer lands as its held call's tool result, the next question
 *  chains, the last queues a continuation turn. A new prompt dismisses
 *  whatever is still held (honest error results) -- no turn may start on a
 *  dangling call (guaranteed 400 on strict backends). */
const resumedHeldQuestions = new Map<string, PendingQuestion[]>();

function resumedToolResult(content: string, toolCallId: string, success: boolean): Message {
  return new Message({
    role: "tool",
    content: [formatToolResult(content, "question", success)],
    toolCallId,
    source: "tool",
  });
}

export function seedResumedQuestions(
  bridge: WebSocketQuestionBridge,
  registry: SessionRegistry,
  sessionId: string,
  pending: PendingQuestion[],
): void {
  if (pending.length === 0) return;
  resumedHeldQuestions.set(sessionId, pending.slice());
  const injectNext = (queue: PendingQuestion[]): void => {
    const q = queue[0];
    if (!q) {
      resumedHeldQuestions.delete(sessionId);
      return;
    }
    bridge.inject(sessionId, q.questions as QuestionDef[], (answers, cancelled) => {
      // The hold was dismissed (new prompt) or the session deleted since the
      // inject: never write tool results for calls we no longer hold.
      if (!resumedHeldQuestions.has(sessionId)) return;
      // Resolve the agent fresh: /model or a profile switch may have replaced
      // it between load and answer; the result must land on the live one.
      const agent = registry.get(sessionId)?.agent;
      if (!agent) return; // session gone with the hold: nothing to answer
      agent.addMessage(
        cancelled
          ? resumedToolResult(
              "Question unanswered: it was dismissed without an answer (cancel resolves with defaults, and defaults are not the user's reply).",
              q.toolCallId,
              false,
            )
          : resumedToolResult(JSON.stringify(answers, null, 2), q.toolCallId, true),
      );
      const rest = queue.slice(1);
      if (rest.length > 0) {
        resumedHeldQuestions.set(sessionId, rest);
        injectNext(rest);
        registry.broadcast({ type: S2C.QUESTION, sessionId, questions: rest[0]!.questions });
        return;
      }
      // All held calls answered: drop the hold BEFORE the continuation, so a
      // following prompt's dismiss cannot re-answer calls already resolved.
      resumedHeldQuestions.delete(sessionId);
      registry.getSessionManager().getBus(sessionId)?.enqueue("", { continuation: true });
    });
  };
  injectNext(pending);
}

/**
 * A new prompt abandons any still-held resumed questions: each unanswered
 * call gets an honest error tool result so the context stays wire-valid.
 * (Live questions are untouched -- they belong to a running turn, and their
 * messages simply queue behind it.)
 */
export function dismissResumedQuestions(
  bridge: WebSocketQuestionBridge,
  registry: SessionRegistry,
  sessionId: string,
): void {
  const held = resumedHeldQuestions.get(sessionId);
  if (!held || held.length === 0) return;
  const agent = registry.get(sessionId)?.agent;
  resumedHeldQuestions.delete(sessionId);
  bridge.remove(sessionId); // the queued resolve would write a duplicate answer
  // Clear any question card still on clients -- answering a stale one would
  // get "No pending question" back. Same event as the live answer path,
  // flagged dismissed with empty answers.
  registry.broadcast({
    type: S2C.QUESTION_ANSWERED,
    sessionId,
    answers: {},
    dismissed: true,
  });
  if (!agent) return;
  for (const q of held) {
    agent.addMessage(
      resumedToolResult(
        "Question unanswered: a new message arrived before an answer; the question was dismissed.",
        q.toolCallId,
        false,
      ),
    );
  }
}

// Re-emit a session's history as S2C messages so the frontend can reconstruct the chat.
function replaySessionHistory(
  sessionId: string,
  agent: AgentLike,
  ws: HotdogServerSocket<unknown>,
): void {
  const messages = agent.getMessages();

  try {
    let pendingToolCalls: Array<{
      id: string;
      function?: { name?: string; arguments?: string };
    }> = [];

    for (const msg of messages) {
      switch (msg.role) {
        case "user": {
          const userImgs = wireImages((msg as { images?: unknown }).images);
          // Attachments in `files`; the text excludes file-include parts.
          const display = splitFileIncludes(msg.content);
          ws.send(
            JSON.stringify({
              type: S2C.USER_MESSAGE,
              sessionId,
              content: display.text,
              ...(display.files.length > 0 ? { files: display.files } : {}),
              ...(userImgs ? { images: userImgs } : {}),
            }),
          );
          break;
        }

        case "assistant": {
          if (msg.reasoningContent) {
            ws.send(
              JSON.stringify({
                type: S2C.THINKING,
                sessionId,
                content: msg.reasoningContent,
              }),
            );
          }

          const toolCalls = msg.toolCalls as
            | Array<{
                id: string;
                function?: { name?: string; arguments?: string };
              }>
            | undefined;
          if (toolCalls && toolCalls.length > 0) {
            pendingToolCalls = toolCalls;
            for (const tc of toolCalls) {
              ws.send(
                JSON.stringify({
                  type: S2C.TOOL_CALL,
                  sessionId,
                  name: tc.function?.name || "unknown",
                  args: tc.function?.arguments || "{}",
                }),
              );
            }
          }
          const textContent =
            typeof msg.getTextContent === "function"
              ? msg.getTextContent()
              : msg.content || "";
          if (textContent) {
            ws.send(
              JSON.stringify({
                type: S2C.ASSISTANT_MESSAGE,
                sessionId,
                content: textContent,
              }),
            );
          }
          break;
        }

        case "tool": {
          const matchedCall = pendingToolCalls.find(
            (tc) => tc.id === msg.toolCallId,
          );
          const toolImgs = wireImages((msg as { images?: unknown }).images);
          ws.send(
            JSON.stringify({
              type: S2C.TOOL_RESULT,
              sessionId,
              name: matchedCall?.function?.name || "unknown",
              // Parts (tool-result) flatten for this string-only transport;
              // legacy entries are already plain text.
              output: toolContentText(msg.content ?? ""),
              ...(toolImgs ? { images: toolImgs } : {}),
            }),
          );
          break;
        }

        default:
          break;
      }
    }

    // Flush in-flight chunks that haven't reached the message log yet.
    const agentImpl = agent as Agent;
    const partialReasoning = agentImpl.currentStreamingReasoning;
    const partialContent = agentImpl.currentStreamingContent;
    if (partialReasoning) {
      ws.send(
        JSON.stringify({
          type: S2C.STREAMING_REASONING_CHUNK,
          sessionId,
          content: partialReasoning,
        }),
      );
    }
    if (partialContent) {
      ws.send(
        JSON.stringify({
          type: S2C.STREAMING_CHUNK,
          sessionId,
          content: partialContent,
        }),
      );
    }
  } catch {
    // Connection dropped mid-replay -- nothing to do.
  }
}

/**
 * Upload size limits, reused from the fileAttachment extension config
 * (its schema defaults: 100KB per text file, 10MB per image, 10 files per message).
 * uploads and @refs share one ceiling, including the separate image budget (fileAttachment.maxImageSize).
 */
function uploadLimits(core: CoreContext): { maxFileSize: number; maxImageSize: number; maxFiles: number } {
  const cfg = getExtensionConfig<{ maxFileSize?: number; maxImageSize?: number; maxFiles?: number }>(
    core,
    "fileAttachment",
  );

  return {
    maxFileSize: typeof cfg.maxFileSize === "number" ? cfg.maxFileSize : 102400,
    maxImageSize: typeof cfg.maxImageSize === "number" ? cfg.maxImageSize : DEFAULT_MAX_IMAGE_SIZE,
    maxFiles: typeof cfg.maxFiles === "number" ? cfg.maxFiles : 10,
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
  const reply = (payload: { ok: boolean; text?: string; error?: string }) =>
    SessionRegistry.sendSafe(ws, { type: S2C.TRANSCRIPT, id, ...payload });

  if (!stt) {
    reply({
      ok: false,
      error:
        "Speech-to-text is not configured (no audio-capable model in the registry; set sttUrl to override)",
    });
    return;
  }
  if (typeof msg.data !== "string" || msg.data.length === 0) {
    reply({ ok: false, error: "transcribe: missing audio data" });
    return;
  }
  if (msg.data.length > MAX_TRANSCRIBE_BASE64_CHARS) {
    reply({
      ok: false,
      error: `transcribe: audio too large (limit ${MAX_TRANSCRIBE_AUDIO_BYTES / 1024 / 1024}MB)`,
    });
    return;
  }

  try {
    const audio = new Uint8Array(Buffer.from(msg.data, "base64"));
    const text = await transcribeAudio({
      url: stt.url,
      model: stt.model,
      authHeader: stt.authHeader,
      audio,
      mimeType: typeof msg.mimeType === "string" ? msg.mimeType : undefined,
    });
    reply({ ok: true, text });
  } catch (err: unknown) {
    logger.error(`[websocket] transcribe failed: ${formatError(err)}`);
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function routeMessage(
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
            // Late joiner: seed the subagents panel with what already ran.
            registry.sendTaskSnapshot(ws);
            if (!ws.activeSessionId) {
              if (registry.size > 0) {
                attachToMostRecentSession(ws, registry, bridge);
              } else {
                createAndAttachSession(ws, registry);
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
          };
          SessionRegistry.sendSafe(ws, sessionCreatedMsg);
          registry.broadcast(sessionCreatedMsg);
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
          force: msg.force as boolean | undefined,
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
        } else if (result.requiresConfirmation) {
          ws.send(
            JSON.stringify({
              type: S2C.PROFILE_SWITCHED,
              sessionId: msg.sessionId,
              requiresConfirmation: true,
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
      if (msg.sessionId) {
        const session = registry.get(msg.sessionId as string);
        if (session) {
          if (ws.activeSessionId && ws.activeChannel) {
            registry.removeChannel(ws.activeSessionId, ws.activeChannel);
          }
          const channel = registry.createChannel(msg.sessionId as string, ws);
          ws.activeSessionId = msg.sessionId as string;
          ws.activeChannel = channel;

          const agent = session.agent as Agent;
          ws.send(
            JSON.stringify({
              type: S2C.SESSION_STATE,
              sessionId: msg.sessionId,
              key: "model",
              value: agent?.model || session.metadata.model || "?",
            }),
          );
          ws.send(
            JSON.stringify({
              type: S2C.SESSION_STATE,
              sessionId: msg.sessionId,
              key: "models",
              value: Object.keys(agent?.modelRegistry || {}),
            }),
          );
          ws.send(
            JSON.stringify({
              type: S2C.SESSION_STATE,
              sessionId: msg.sessionId,
              key: "profile",
              value:
                agent?.profileName || session.metadata.profile || "default",
            }),
          );
          ws.send(
            JSON.stringify({
              type: S2C.SESSION_STATE,
              sessionId: msg.sessionId,
              key: "title",
              // null = display name follows the profile.
              value: session.metadata.title ?? null,
            }),
          );
          replaySessionHistory(msg.sessionId as string, session.agent, ws);
          const isRunning = registry
            .getSessionManager()
            .isSessionRunning(msg.sessionId as string);
          ws.send(
            JSON.stringify({
              type: S2C.SESSION_STATE,
              sessionId: msg.sessionId,
              key: "working",
              value: isRunning,
            }),
          );
          replayPendingQuestion(bridge, msg.sessionId as string, ws);
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
              };
              SessionRegistry.sendSafe(ws, sessionCreatedMsg);
              registry.broadcast(sessionCreatedMsg);

              // After the fork's sessionCreated lands (the client clears its list and
              // re-targets), replay the copied history, then start the optional prompt.
              replaySessionHistory(newSessionId, agent, ws);
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
      listSessionLogs()
        .then((logs) => {
          // Only return cold logs, not sessions that are still live.
          const activeIds = new Set(registry.list().map((s) => s.id));
          const coldLogs = logs.filter((log) => !activeIds.has(log.id));
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
      if (msg.logId) {
        if (ws.activeSessionId && ws.activeChannel) {
          registry.removeChannel(ws.activeSessionId, ws.activeChannel);
        }

        loadLogIntoNewSession(msg.logId as string, registry)
          .then(({ sessionId, agent, pendingQuestions }) => {
            const channel = registry.createChannel(sessionId, ws);
            ws.activeSessionId = sessionId;
            ws.activeChannel = channel;

            const sessionCreatedMsg = {
              type: S2C.SESSION_CREATED,
              sessionId,
              profile: agent.profileName || "default",
              // Fresh session (rebuilt from a cold log): no explicit title yet.
              title: null,
              currentModel: agent.model,
              models: Object.keys(agent.modelRegistry || {}),
              sttEnabled: registry.sttEnabled,
            };
            SessionRegistry.sendSafe(ws, sessionCreatedMsg);
            registry.broadcast(sessionCreatedMsg);

            replaySessionHistory(sessionId, agent, ws);

            // The log died mid-question: re-present to the loading client
            // (other tabs get it via the attach flow).
            if (pendingQuestions.length > 0) {
              seedResumedQuestions(bridge, registry, sessionId, pendingQuestions);
              SessionRegistry.sendSafe(ws, {
                type: S2C.QUESTION,
                sessionId,
                questions: pendingQuestions[0]!.questions as QuestionDef[],
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

    case C2S.VIEW_LOG: {
      if (msg.logId) {
        readSessionEntries(msg.logId as string)
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
        deleteSessionLog(msg.logId as string)
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

/** A blocked question outlives the socket that was showing it (tab
 *  refresh, session switch). Re-send after attach so the client
 *  renders the card again. */
function replayPendingQuestion(
  bridge: WebSocketQuestionBridge,
  sessionId: string,
  ws: HotdogServerSocket<unknown>,
): void {
  const questions = bridge.peek(sessionId);
  if (!questions) return;
  SessionRegistry.sendSafe(ws, {
    type: S2C.QUESTION,
    sessionId,
    questions,
  });
}

function attachToMostRecentSession(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
  bridge: WebSocketQuestionBridge,
): void {
  const sessions = registry.list();
  let mostRecent: {
    id: string;
    lastActivityAt: number;
    profile: string;
    model: string;
  } | null = null;
  let mostRecentTime = 0;
  for (const s of sessions) {
    if (s.lastActivityAt > mostRecentTime) {
      mostRecent = s;
      mostRecentTime = s.lastActivityAt;
    }
  }

  if (!mostRecent) {
    createAndAttachSession(ws, registry);
    return;
  }

  const sessionId = mostRecent.id;
  const session = registry.get(sessionId);
  if (!session || !session.agent) {
    createAndAttachSession(ws, registry);
    return;
  }

  const channel = registry.createChannel(sessionId, ws);
  ws.activeSessionId = sessionId;
  ws.activeChannel = channel;

  const agent = session.agent as Agent;
  SessionRegistry.sendSafe(ws, {
    type: S2C.SESSION_CREATED,
    sessionId,
    profile: agent?.profileName || mostRecent.profile || "default",
    title: session.metadata.title,
    currentModel: agent?.model || mostRecent.model || "?",
    models: Object.keys(agent?.modelRegistry || {}),
    sttEnabled: registry.sttEnabled,
  });

  replaySessionHistory(sessionId, session.agent, ws);

  const isRunning = registry.getSessionManager().isSessionRunning(sessionId);
  SessionRegistry.sendSafe(ws, {
    type: S2C.SESSION_STATE,
    sessionId,
    key: "working",
    value: isRunning,
  });

  replayPendingQuestion(bridge, sessionId, ws);
}

function createAndAttachSession(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
): void {
  registry
    .create({})
    .then(({ sessionId, agent }) => {
      const channel = registry.createChannel(sessionId, ws);
      ws.activeSessionId = sessionId;
      ws.activeChannel = channel;

      SessionRegistry.sendSafe(ws, {
        type: S2C.SESSION_CREATED,
        sessionId,
        profile: agent.profileName || "default",
        // Fresh session: no explicit title yet, display follows profile.
        title: null,
        currentModel: agent.model,
        models: Object.keys(agent.modelRegistry || {}),
        sttEnabled: registry.sttEnabled,
      });
    })
    .catch((err: unknown) => {
      SessionRegistry.sendSafe(ws, {
        type: S2C.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      try {
        ws.close(4003, "Failed to create session");
      } catch {}
    });
}

export function createWsServer(
  core: CoreContext,
  options: CreateWsServerOptions = {},
): WsServer {
  const {
    buildAgent: customBuildAgent,
    sessionTimeoutMin = 30,
    questionTimeoutSecs = 300,
    questionStrategy = "wait",
    auth,
    profiles,
  } = options;

  const sharedLlmClient = core.createLlmClient();

  // Speech-to-text: explicit sttUrl, else auto-pick an audio-capable model
  // from the registry (its provider supplies URL + key, like show-me's
  // image models). Null = disabled; the webui hides its mic affordance from
  // the sttEnabled flag on the sessionCreated payload.
  const sttTarget = resolveSttTarget(core.resolved, sharedLlmClient);

  const buildAgent: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike> =
    customBuildAgent ?? createAgentFactory(core, { profiles, llmClient: sharedLlmClient });

  // Question tool integration: the bridge resolves pending question-tool
  // calls when a client answers. Declared before the registry so the
  // onSessionDeleted callback can reference it (called lazily).
  let bridge: WebSocketQuestionBridge | null = null;

  // Webui turns must queue on the provider lane like everything else. The ws
  // registry builds its SessionManager without taskConfig (its TaskManager
  // lives here), so hand the lanes in explicitly: same caps, same ledger,
  // same raw-config source the CLI's SessionManager uses.
  const resolvedCore = core.resolved;
  const turnLanes = resolvedCore
    ? createTurnLanes({
        lanesDir: resolvedCore.taskLanesDir ?? null,
        lanesPerProvider: resolvedCore.taskLanesPerProvider,
        providerDefs:
          (core.config?.providers as { name: string; taskLanes?: unknown }[] | undefined) ?? [],
      })
    : undefined;

  const registry = new SessionRegistry({
    buildAgent,
    llmClient: sharedLlmClient,
    questionTimeoutSecs,
    questionStrategy,
    sessionTimeoutMin,
    profiles,
    sttTarget,
    turnLanes,
    onSessionDeleted: (sid) => {
      // Drop the hold FIRST: dropSession cancels the pending question, and
      // the resolve callback checks resumedHeldQuestions before touching the
      // (now deleted) session's agent or bus.
      resumedHeldQuestions.delete(sid);
      bridge?.dropSession(sid);
    },
  });

  // Subagent tasks for webui/ws sessions: the registry's SessionManager is built without taskConfig,
  // so the TaskManager lives here. Publishing it as the taskManager service lets delegate_task
  // resolve lazily; the observer relays spawn/status/activity to every connected client --
  // the webui subagents panel consumes it, and nothing reaches the main chat transcript.
  // Hoisted so the returned stopTaskManager() can reach it (null when no registry).
  let taskManager: TaskManager | null = null;
  if (resolvedCore?.modelRegistry) {
    taskManager = new TaskManager({
      buildAgent: buildAgent as (config: Record<string, unknown>) => Promise<AgentLike>,
      modelRegistry: resolvedCore.modelRegistry,
      config: core.config,
      maxIterations: resolvedCore.maxIterations,
      taskProfile: resolvedCore.taskProfile || "task-default",
      lanesPerProvider: resolvedCore.taskLanesPerProvider,
      lanesDir: resolvedCore.taskLanesDir ?? null,
      defaultModel: resolvedCore.model ?? null,
      healthIntervalSecs: resolvedCore.providerHealthCheckIntervalSecs,
      healthCheckTimeoutSecs: resolvedCore.healthCheckTimeout,
      healthContextLimit: resolvedCore.contextLimit,
      profileManager: resolvedCore.profileManager,
      sessionManager: registry.getSessionManager(),
    });
    // Hand-built mock cores (tests, embedded hosts) may carry no service
    // registry; the relay still works, only delegate_task lookup is skipped.
    if (core.services) registerTaskManagerService(core, taskManager);
    registry.setTaskManager(taskManager);
    taskManager.setObserver((ev: TaskObserverEvent) => {
      if (ev.kind === "task") {
        registry.broadcast({ type: S2C.TASK_UPDATE, task: ev.task });
        return;
      }
      const activityMsg = taskActivityMessage(ev.taskId, ev.event);
      if (activityMsg) registry.broadcast(activityMsg);
    });
  }

  bridge = new WebSocketQuestionBridge({
    getPolicy: (sid) => {
      const meta = registry.get(sid)?.metadata;
      return {
        strategy: (meta?.questionStrategy ||
          questionStrategy) as QuestionStrategy,
        timeoutSecs: meta?.questionTimeoutSecs || questionTimeoutSecs,
      };
    },
    hasChannels: (sid) => registry.hasChannels(sid),
    interrupt: (sid) => registry.getSessionManager().interrupt(sid),
  });

  // Give every tool call for WS agents an Input implementation that resolves
  // via the bridge (same pattern as ui-interactive-cli, which sets it
  // unconditionally). Not filtering on toolName here means the approvals
  // extension can reach the human on any tool, not just `question`.
  if (core.hooks && typeof core.hooks.on === "function") {
    core.hooks.on(
      HOOKS.AGENT_TOOL_CONTEXT,
      ({ toolCtx, agent }) => {
        const sessionId = agent?.sessionId;
        if (sessionId) toolCtx.set("input", bridge!.inputFor(sessionId));
      },
      { source: "websocket" },
    );
  }

  function onUpgrade(
    req: { url: string; headers?: Record<string, string> },
    ws: HotdogServerSocket<unknown>,
  ): void {
    const url = new URL(req.url, `http://${req.headers?.host || "localhost"}`);
    const token = url.searchParams.get("token");

    // Only register a socket for broadcasts once it is authenticated (or
    // auth is disabled): an unauthenticated socket must not receive
    // broadcast events (e.g. question answers) while it waits to auth.
    if (auth && token) {
      if (!auth.validateToken(token)) {
        ws.send(
          JSON.stringify({
            type: S2C.AUTH_ERROR,
            message: "Invalid or expired token",
          }),
        );
        ws.close(4001, "Invalid token");
        return;
      }
      ws.authToken = token;
      registry.registerConnection(ws);
      registry.sendTaskSnapshot(ws);
    } else if (auth && !token) {
      // Socket stays open so the client can still authenticate via a
      // protocol AUTH message; routeMessage() gates everything else.
      // Registration for broadcasts happens on AUTH success. The cleanup
      // loop reaps the socket if AUTH never arrives (see #pendingAuth).
      registry.addPendingAuth(ws);
      ws.send(JSON.stringify({ type: S2C.AUTH_REQUIRED }));
      return;
    } else {
      registry.registerConnection(ws);
      registry.sendTaskSnapshot(ws);
    }

    const existingCount = registry.size;
    if (existingCount > 0) {
      attachToMostRecentSession(ws, registry, bridge!);
    } else {
      createAndAttachSession(ws, registry);
    }
  }

  async function onMessage(
    ws: HotdogServerSocket<unknown>,
    raw: string | Buffer,
  ): Promise<void> {
    let msg: C2SMessage;
    try {
      msg = JSON.parse(
        typeof raw === "string" ? raw : raw.toString(),
      ) as C2SMessage;
    } catch {
      try {
        ws.send(JSON.stringify({ type: S2C.ERROR, message: "Invalid JSON" }));
      } catch {}
      return;
    }

    if (!msg.type) {
      try {
        ws.send(
          JSON.stringify({ type: S2C.ERROR, message: "Message type required" }),
        );
      } catch {}
      return;
    }

    try {
      await routeMessage(ws, msg, registry, auth, bridge!, core);
    } catch (err: unknown) {
      // Don't let errors from dropped connections kill the server.
      const typedErr = err as Error;
      if (
        typedErr.message !== "WebSocket is not open: readyState 2 (CLOSING)" &&
        typedErr.message !== "WebSocket is not open: readyState 3 (CLOSED)"
      ) {
        logger.error(`[websocket] message handling error: ${formatError(typedErr)}`);
      }
    }
  }

  function onClose(ws: HotdogServerSocket<unknown>): void {
    if (ws.activeSessionId && ws.activeChannel) {
      registry.removeChannel(ws.activeSessionId, ws.activeChannel);
      ws.activeChannel.close();
    }
    registry.removePendingAuth(ws);
    registry.unregisterConnection(ws);
  }

  return {
    sessionRegistry: registry,
    onUpgrade,
    onMessage,
    onClose,
    startCleanupLoop: () => registry.startCleanupLoop(sessionTimeoutMin),
    stopCleanupLoop: () => registry.stopCleanupLoop(),
    stopTaskManager: () => taskManager?.stop(),
  };
}
