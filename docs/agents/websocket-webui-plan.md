# WebSocket + WebUI Extensions — Implementation Plan

Two new extensions: a base **websocket** extension that provides the server-side WebSocket core, and a **webui** extension that depends on it, adds API key auth with login sessions, and serves a frontend UI.

## Design Decisions (Interview Record)

| Decision | Resolution |
|----------|-----------|
| Lifecycle model | Subcommand mode — `hotdog ws-server` and `hotdog webui` are long-running processes |
| Connection-to-session | Connections can join existing sessions AND manage multiple sessions from one connection |
| Wire protocol | Custom envelope (not JSON-RPC), maps directly to `OUTPUT_EVENT` types |
| Extension dependency | Factory function — websocket exports `createWsServer()`, webui imports it |
| Auth model | Config/env API key → POST `/login` → session token (UUID, in-memory, configurable TTL) |
| Auth ownership | Websocket extension owns auth plumbing (login handler, session store, WS token validation); webui provides the API key source |
| Frontend UI | Multi-file vanilla JS (HTML + CSS + JS modules), no build step, served as static files by Bun |
| Agent lifecycle | Persistent sessions — agents continue running when no client is connected |
| Multi-sink pattern | `FanoutSink` class (5 lines) — not EventEmitter, not HookSystem |
| HookSystem | Keep as-is for extension hooks; FanoutSink for output fan-out only |
| Session management | Flat `Map<sessionId, Session>` registry, with metadata (profile, timestamps, connected clients) |
| Bun.serve ownership | Webui extension owns `Bun.serve()`, websocket extension provides handlers (onUpgrade, sessionRegistry) |
| OUTPUT_EVENT mapping | All 14 event types forwarded over WS, each mapped to a protocol message type |
| Question strategy | Per-session: `"wait"` (block + timeout → empty), `"default"` (timeout → empty), `"cancel"` (timeout → cancel run) |
| Session hibernation | Out of scope for v1 — door designed (SessionRegistry interface预留 hibernate/resume) |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Bun.serve()                              │
│  (owned by webui extension's `webui` subcommand)            │
│                                                             │
│  GET  /          → static files (ui/index.html + assets)    │
│  POST /login      → auth.loginHandler (from websocket ext)   │
│  GET  /ws?token=T → WS upgrade → ws.onUpgrade               │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                  SessionRegistry                             │
│  Map<sessionId, { agent, bus, fanoutSink, metadata }>       │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ Session A│  │ Session B│  │ Session C│                  │
│  │          │  │          │  │          │                  │
│  │ Agent    │  │ Agent    │  │ Agent    │                  │
│  │ MessageBus│ │ MessageBus│ │ MessageBus│                  │
│  │          │  │          │  │          │                  │
│  │FanoutSink│  │FanoutSink│  │FanoutSink│                  │
│  │├─ WSSink │  │├─BgSink  │  │├─ WSSink │                  │
│  │├─ WSSink │  │          │  │├─ WSSink │                  │
│  │└─ BgSink │  │          │  │└─ BgSink │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

## Extension Structure

### `extensions/websocket/`

```
extensions/websocket/
  extension.json           # metadata, autoload: false
  index.js                 # main entry — create(core), exports
  server.js                # createWsServer() factory, SessionRegistry
  auth.js                  # createAuthMiddleware(), session token store
  sinks.js                 # WebSocketOutputSink, BackgroundSink, FanoutSink
  protocol.js              # protocol constants, message type definitions
  config.js                # default config values
```

### `extensions/webui/`

```
extensions/webui/
  extension.json           # metadata, dependsOn: ["websocket"]
  index.js                 # main entry — create(core), registers webui subcommand
  server.js                # Bun.serve setup, routing, static file serving
  config.js                # default config values
  ui/
    index.html             # entry point
    styles.css             # all styles
    app.js                 # main app, WS client, routing/state
    login.js               # login screen component
    chat.js                # chat view component
    sessions.js            # session list/management sidebar
    message-list.js        # message rendering
    utils.js               # shared utilities
```

## Wire Protocol

All messages are JSON objects with a `type` field. Every server→client message includes `sessionId`.

### Client → Server

```typescript
// Authentication
{ type: "auth", token: "session-uuid" }

// Session management
{ type: "createSession", profile?: string, model?: string, questionStrategy?: "wait"|"default"|"cancel", questionTimeoutSecs?: number }
{ type: "deleteSession", sessionId: string }
{ type: "listSessions" }
{ type: "switchSession", sessionId: string }

// Agent interaction
{ type: "send", sessionId: string, content: string }
{ type: "cancel", sessionId: string }
{ type: "questionAnswer", sessionId: string, answers: string[] }

// Slash commands
{ type: "command", sessionId: string, command: string }  // e.g., "clear", "model qwen3.5"
```

### Server → Client

```typescript
// Session management
{ type: "sessionCreated", sessionId: string, profile: string }
{ type: "sessionDeleted", sessionId: string }
{ type: "sessions", sessions: Array<{ id, profile, model, createdAt, lastActivityAt, connectedClients }> }
{ type: "authRequired" }
{ type: "authError", message: string }

// OUTPUT_EVENT mappings (all include sessionId)
{ type: "userMessage", sessionId: string, content: string }
{ type: "assistantMessage", sessionId: string, content: string }
{ type: "thinking", sessionId: string, content: string }
{ type: "toolCall", sessionId: string, name: string, args: object }
{ type: "toolResult", sessionId: string, name: string, output?: string, error?: string }
{ type: "compacting", sessionId: string, message: string }
{ type: "commandResult", sessionId: string, content: string }
{ type: "question", sessionId: string, questions: Array<{ name, message }> }
{ type: "streamingChunk", sessionId: string, content: string }
{ type: "streamingReasoningChunk", sessionId: string, content: string }
{ type: "taskProgress", sessionId: string, taskId: string, status: string, message?: string }
{ type: "tokenUsage", sessionId: string, inputTokens: number, outputTokens: number, totalTokens: number }
{ type: "compactionResult", sessionId: string, summary: string, messagesCompacted: number }
{ type: "sessionState", sessionId: string, hideTools: boolean, hideThinking: boolean }

// Connection management
{ type: "error", sessionId?: string, message: string }
```

## Config Parameters

### Websocket Extension

Defined in `extension.json` configSchema:

```jsonc
{
  "key": "websocket",
  "description": "WebSocket server configuration",
  "defaults": {
    "port": 3000,
    "host": "0.0.0.0",
    "sessionTimeoutMin": 30,       // idle session cleanup
    "questionTimeoutSecs": 300,    // default question timeout (5 min)
    "questionStrategy": "wait",    // default question strategy
  }
}
```

### Webui Extension

Defined in `extension.json` configSchema:

```jsonc
{
  "key": "webui",
  "description": "WebUI server configuration",
  "defaults": {
    "port": 3000,
    "host": "0.0.0.0",
    "apiKey": null,                // or from env HOTDOG_WEBUI_API_KEY
    "sessionTokenTtlMin": 1440,    // 24 hours
  }
}
```

## Key Implementation Details

### FanoutSink

```typescript
// sinks.js
export class FanoutSink {
  #sinks = [];

  add(sink) { this.#sinks.push(sink); }
  remove(sink) { this.#sinks = this.#sinks.filter(s => s !== sink); }

  emit(event) {
    this.#sinks.forEach(s => s.emit(event));
  }
}
```

### WebSocketOutputSink

Implements `OutputSink`. Each OUTPUT_EVENT type maps to a protocol message sent via `ws.send(JSON.stringify(msg))`. Tracks whether the WS connection is ready (avoid sending to closed connections).

### BackgroundSink

Implements `OutputSink`. Silently drops streaming chunks (no one to show them to). Logs `QUESTION` events so they can be answered when a client reconnects. All other events are no-ops (session-log extension handles persistence).

### SessionRegistry

```typescript
export class SessionRegistry {
  #sessions = new Map();
  #cleanupTimer;

  create({ profile, model, questionStrategy, questionTimeoutSecs })
    → { sessionId, agent, bus }

  get(sessionId) → Session | null
  list() → Array<SessionMetadata>
  delete(sessionId) → void

  attachSink(sessionId, sink) → void    // called when client connects
  detachSink(sessionId, sink) → void    // called when client disconnects

  startCleanupLoop(timeoutMin) → void   // reaps idle sessions
  stopCleanupLoop() → void
}
```

### Auth Middleware

```typescript
// auth.js
export function createAuthMiddleware({ validateApiKey, tokenTtlMin }) {
  const sessions = new Map(); // token → { createdAt, expiresAt }

  return {
    loginHandler: async (req) => {
      // POST /login, body: { apiKey: "..." }
      // If valid, create session token, return { token }
      // If invalid, return 401
    },
    validateToken: (token) => {
      // Check if token exists and not expired
      // Returns true/false
    },
    cleanup: () => { /* remove expired tokens */ },
  };
}
```

### createWsServer Factory

```typescript
// server.js
export function createWsServer(core, options) {
  const registry = new SessionRegistry(core, options);

  return {
    sessionRegistry: registry,

    onUpgrade(ws, request) {
      // Authenticate via query param ?token=T or first message { type: "auth" }
      // Route messages to session handlers
      // Attach/detach WebSocketOutputSink from FanoutSink
    },

    startCleanupLoop() { registry.startCleanupLoop(options.sessionTimeoutMin); },
    stopCleanupLoop() { registry.stopCleanupLoop(); },
  };
}
```

## Implementation Phases

### Phase 1: Websocket Extension (Foundation)

1. **Scaffolding** — Create `extensions/websocket/` with `extension.json`, `index.js`
2. **Config** — Register config params (`websocket.*`)
3. **Sinks** — Implement `FanoutSink`, `WebSocketOutputSink`, `BackgroundSink`
4. **Protocol** — Define message types in `protocol.js`
5. **Auth** — Implement `createAuthMiddleware()` with session token store
6. **SessionRegistry** — Implement session CRUD, sink attach/detach, cleanup loop
7. **Server factory** — Implement `createWsServer()` with `onUpgrade` handler
8. **Subcommand** — Register `ws-server` subcommand (bare server, no auth, no static files)
9. **Testing** — Unit tests for sinks, auth, session registry

### Phase 2: Webui Extension (Auth + UI)

1. **Scaffolding** — Create `extensions/webui/` with `extension.json`, `index.js`, `dependsOn: ["websocket"]`
2. **Config** — Register config params (`webui.*`), read `HOTDOG_WEBUI_API_KEY` env
3. **Server** — Implement `Bun.serve()` with routing: static files, `/login`, `/ws`
4. **Auth wiring** — Import `createAuthMiddleware` from websocket, wire API key validation
5. **Subcommand** — Register `webui` subcommand
6. **Frontend scaffolding** — Create `ui/` directory with `index.html`, `styles.css`, `app.js`
7. **Login screen** — Implement `login.js` (API key input → POST /login → store token)
8. **Chat view** — Implement `chat.js` (message list, input box, WS send/receive)
9. **Session sidebar** — Implement `sessions.js` (list, create, switch sessions)
10. **Message rendering** — Implement `message-list.js` (render all OUTPUT_EVENT types)
11. **Testing** — Integration tests for login flow, WS messaging, session management

### Phase 3: Polish

1. **Streaming UX** — Render streaming chunks in real-time, merge into final message
2. **Tool call display** — Collapsible tool call/result blocks in the chat view
3. **Thinking display** — Toggleable reasoning content
4. **Question handling** — Render question prompts, send answers back via WS
5. **Session reconnection** — On reconnect, replay missed events from session log
6. **Error handling** — Graceful disconnect/reconnect, error messages in UI
7. **Token usage display** — Show token stats per session
8. **Responsive design** — Mobile-friendly CSS

### Phase 4: Future (Out of Scope)

1. **Session hibernation** — Serialize/unload idle sessions, resume on demand
2. **Cron/scheduler** — Wake agents on schedule via `bus.enqueue()`
3. **Webhook ingress** — HTTP endpoints that enqueue messages to sessions
4. **Multi-user auth** — Database-backed auth, per-user session namespaces
5. **Session sharing** — Multiple users viewing the same session

## Testing Strategy

- **Unit tests** — Sinks, auth middleware, session registry, protocol parsing
- **Integration tests** — Full WS connection lifecycle, login flow, session CRUD
- **Manual testing** — Frontend UI interactions, streaming, multi-session management
- **Use `qwen3.5-0.8b`** for all LLM integration tests (per project convention)

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Memory growth from many sessions | Configurable `sessionTimeoutMin`, cleanup loop, future hibernation |
| WS connection instability | Client-side reconnect logic, server-side sink detach/attach |
| Auth token leakage | Tokens via query param only on initial WS upgrade; consider WebSocket subprotocol auth later |
| Streaming performance | `WebSocketOutputSink` batches small chunks, avoids excessive `ws.send()` calls |
| Question tool blocking | Per-session `questionStrategy` + `questionTimeoutSecs` |

## Notes

- The `question` tool in the core-tools extension is buggy and needs to be addressed separately. This plan assumes the question tool works correctly (emits QUESTION event, waits for answer, continues). Fix the question tool before Phase 2.
- Session hibernation is explicitly out of scope but the SessionRegistry interface is designed to support it (reserve `hibernate()`/`resume()` method names).
