// Server→client messages always include `sessionId`.

// ── Client → Server ─────────────────────────────────────────────────────────

export const C2S = {
  AUTH: "auth",
  CREATE_SESSION: "createSession",
  DELETE_SESSION: "deleteSession",
  RENAME_SESSION: "renameSession",
  LIST_SESSIONS: "listSessions",
  SWITCH_SESSION: "switchSession",
  SEND: "send",
  CANCEL: "cancel",
  QUESTION_ANSWER: "questionAnswer",
  COMMAND: "command",
  // Cold session log management
  LIST_LOGS: "listLogs",
  LOAD_LOG: "loadLog",
  VIEW_LOG: "viewLog",
  DELETE_LOG: "deleteLog",
  // Profile management
  LIST_PROFILES: "listProfiles",
  SWITCH_PROFILE: "switchProfile",
} as const;

// ── Server → Client ─────────────────────────────────────────────────────────

export const S2C = {
  // Session management
  SESSION_CREATED: "sessionCreated",
  SESSION_DELETED: "sessionDeleted",
  SESSIONS: "sessions",
  AUTH_REQUIRED: "authRequired",
  AUTH_ERROR: "authError",

  // Cold session log management
  LOGS_LISTED: "logsListed",
  LOG_VIEWED: "logViewed",
  LOG_DELETED: "logDeleted",

  // Profile management
  PROFILES: "profiles",
  PROFILE_SWITCHED: "profileSwitched",

  // OUTPUT_EVENT mappings
  USER_MESSAGE: "userMessage",
  ASSISTANT_MESSAGE: "assistantMessage",
  THINKING: "thinking",
  TOOL_CALL: "toolCall",
  TOOL_RESULT: "toolResult",
  COMPACTING: "compacting",
  COMMAND_RESULT: "commandResult",
  QUESTION: "question",
  STREAMING_CHUNK: "streamingChunk",
  STREAMING_REASONING_CHUNK: "streamingReasoningChunk",
  TASK_PROGRESS: "taskProgress",
  TOKEN_USAGE: "tokenUsage",
  COMPACTION_RESULT: "compactionResult",
  SESSION_STATE: "sessionState",
  SYSTEM_MESSAGE: "systemMessage",

  // Question answers (broadcast to all clients when a question is resolved)
  QUESTION_ANSWERED: "questionAnswered",

  // Connection management
  ERROR: "error",
} as const;

export type C2SType = (typeof C2S)[keyof typeof C2S];
export type S2CType = (typeof S2C)[keyof typeof S2C];

export interface C2SMessage {
  type: C2SType;
  [key: string]: unknown;
}

export interface S2CMessage {
  type: S2CType;
  sessionId?: string;
  [key: string]: unknown;
}
