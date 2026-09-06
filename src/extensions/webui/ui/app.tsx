/// <reference lib="dom" />
// Wires login, chat, and sessions together. The JSX tree owns all layout;
// atoms hold view state and a single render() re-renders on change. The
// message list container is handed to the imperative renderer via ref.

import { mount, type Mounted, type Ref, type DomNode } from "@utils/jsx";
import { reactiveState, effect, shortId } from "./utils.ts";
import { createChat, type ChatController } from "./chat.ts";
import {
  LoginScreen,
  focusLoginInput,
  getStoredToken,
  clearStoredToken,
  loginAtoms,
} from "./login.tsx";
import { Sidebar, ContextMenu, type ContextMenuState, type SessionInfo, type LogInfo } from "./sessions.tsx";

type Screen = "login" | "main";

const screenAtom = reactiveState<Screen>("login");
const sessionsAtom = reactiveState<SessionInfo[]>([]);
const logsAtom = reactiveState<LogInfo[]>([]);
const activeLogIdAtom = reactiveState<string | null>(null);
const contextMenuAtom = reactiveState<ContextMenuState | null>(null);

let token: string | null = null;
let chat: ChatController | null = null;
let mounted: Mounted | null = null;
let stopChatEffects: (() => void) | null = null;

// Imperative handles into the tree (useRef-style). The runtime hands out
// structural DomElement nodes; browser nodes are real element instances, so
// domRef re-types each handle for DOM API use.
function domRef<T>(set: (el: T | null) => void): Ref {
  return (el) => set(el as unknown as T | null);
}

let chatInputEl: HTMLTextAreaElement | null = null;
let profileSelectEl: HTMLSelectElement | null = null;
let modelSelectEl: HTMLSelectElement | null = null;
let messageListEl: HTMLElement | null = null;
let contextMenuEl: HTMLDivElement | null = null;

// Stable ref identities. Inline closures would be new every render, making
// patch() detach (null) and re-attach every ref on every render.
const chatInputRef = domRef<HTMLTextAreaElement>((el) => {
  chatInputEl = el;
});
const profileSelectRef = domRef<HTMLSelectElement>((el) => {
  profileSelectEl = el;
});
const modelSelectRef = domRef<HTMLSelectElement>((el) => {
  modelSelectEl = el;
});
const messageListRef = domRef<HTMLElement>((el) => {
  messageListEl = el;
});
const contextMenuRef = domRef<HTMLDivElement>((el) => {
  contextMenuEl = el;
});

// Several atoms usually flip within one WS message (e.g. sessionInfo sets
// title, model, and models); coalesce to one render per microtask so each
// burst costs a single tree patch.
let renderQueued = false;
function render(): void {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    mounted?.render(<App />);
    syncSelects();
  });
}

// Once a user touches a select the browser ignores `selected` attribute
// changes, so drive the live value imperatively after every render.
function syncSelects(): void {
  if (!chat) return;
  const profile = chat.currentProfileAtom();
  if (profileSelectEl && profileSelectEl.value !== profile) profileSelectEl.value = profile;
  const model = chat.currentModelAtom();
  if (modelSelectEl && modelSelectEl.value !== model) modelSelectEl.value = model;
}

// ── Auth ────────────────────────────────────────────────────────────────────

function showLogin(): void {
  screenAtom("login");
}

/** Token invalid/expired: clear storage, drop the chat, show login. */
function handleAuthFailure(): void {
  clearStoredToken();
  token = null;
  if (chat) {
    stopChatEffects?.();
    stopChatEffects = null;
    // The #message-list div outlives the chat (main-ui is only class-hidden),
    // so detach the manager's scroll listener before dropping it; otherwise
    // each login cycle stacks another listener on the same element.
    chat.messageListAtom()?.destroy();
    chat.disconnect();
    chat = null;
  }
  // The message-list div persists across login screens (main-ui is only
  // class-hidden), and each new chat attaches a fresh MessageListManager.
  // Clear the container so stale messages from the old chat do not pile up.
  if (messageListEl) messageListEl.innerHTML = "";
  sessionsAtom([]);
  logsAtom([]);
  activeLogIdAtom(null);
  contextMenuAtom(null);
  showLogin();
}

async function verifyToken(tokenToCheck: string): Promise<boolean> {
  try {
    const res = await fetch(`/verify`, {
      headers: { "x-hotdog-token": tokenToCheck },
    });
    if (res.status === 401) {
      handleAuthFailure();
      return false;
    }
    return true;
  } catch {
    // Network error — server might be down; proceed and let chat retry
    return true;
  }
}

// Token accepted (fresh login or stored-token auto-login): wire up the
// chat and swap screens. LoginScreen owns persistence of the token.
function activateToken(newToken: string): void {
  token = newToken;
  startChat();
  screenAtom("main");
}

// ── Log view ────────────────────────────────────────────────────────────────

function clearLogView(): void {
  activeLogIdAtom(null);
  // Remove the active-log highlight.
  chat?.listLogs();
}

function onCloseLogView(): void {
  clearLogView();
  // Re-switching to the same session makes the server replay history.
  const currentSessionId = chat?.sessionIdAtom();
  if (currentSessionId && chat) {
    chat.switchSession(currentSessionId);
  }
}

// ── Context menus ───────────────────────────────────────────────────────────

function dismissContextMenu(): void {
  contextMenuAtom(null);
}

function onSessionMenu(e: MouseEvent, s: SessionInfo): void {
  const displayName = s.title || s.profile || "default";
  contextMenuAtom({
    x: e.clientX,
    y: e.clientY,
    items: [
      {
        label: "Rename",
        onSelect: () => {
          const newName = prompt("Rename session:", displayName);
          if (newName !== null && newName.trim() !== "") {
            chat?.renameSession(s.id, newName.trim());
          }
          dismissContextMenu();
        },
      },
      {
        label: "Delete",
        danger: true,
        onSelect: () => {
          if (confirm(`Delete session ${shortId(s.id)}?`)) {
            chat?.deleteSession(s.id);
          }
          dismissContextMenu();
        },
      },
    ],
  });
}

function onLogMenu(e: MouseEvent, logId: string): void {
  contextMenuAtom({
    x: e.clientX,
    y: e.clientY,
    items: [
      {
        label: "Delete",
        danger: true,
        onSelect: () => {
          if (confirm(`Delete log ${shortId(logId)}?`)) {
            chat?.deleteLog(logId);
          }
          dismissContextMenu();
        },
      },
    ],
  });
}

// Close the menu on any mousedown outside it. No deferral needed: the
// mousedown that opens a menu lands before contextMenuAtom is set, and a
// right-click on another item closes the old menu and reopens via contextmenu.
document.addEventListener("mousedown", (e: MouseEvent) => {
  if (!contextMenuAtom()) return;
  if (contextMenuEl && contextMenuEl.contains(e.target as Node)) return;
  dismissContextMenu();
});

// ── Chat wiring ─────────────────────────────────────────────────────────────

function startChat(): void {
  chat = createChat({
    token,
    host: window.location.host,
    getMessageListContainer: () => messageListEl,
    onSessionCreated: ({ sessionId }) => {
      chat!.setSession(sessionId);
      chat!.listSessions();
      chat!.listProfiles();
      clearLogView();
    },
    onSessionsUpdate: (sessions, activeSessionId) => {
      sessionsAtom(sessions);
      if (activeSessionId && activeLogIdAtom()) {
        clearLogView();
      }
    },
    onLogsUpdate: (logs) => {
      logsAtom(logs);
    },
    onLogViewed: (logId, entries) => {
      activeLogIdAtom(logId);
      // Re-render both lists so the active log is highlighted.
      chat?.listLogs();
      chat?.listSessions();
      const messageList = chat?.messageListAtom();
      if (messageList) {
        messageList.clear();
        messageList.renderLogEntries(entries);
      }
    },
    onLogDeleted: (logId) => {
      if (activeLogIdAtom() === logId) {
        clearLogView();
      }
      chat?.listLogs();
    },
    onAuthFailure: handleAuthFailure,
    onWorkingMapChange: () => {
      // Re-poll so the sidebar's per-session working indicators refresh.
      chat?.listSessions();
    },
  });

  // Re-render on any chat atom change; also refresh the sidebar when the
  // model changes, and pull profiles once connected.
  stopChatEffects = effect(render, [
    chat.connectedAtom,
    chat.workingAtom,
    chat.sessionIdAtom,
    chat.sessionTitleAtom,
    chat.modelsAtom,
    chat.currentModelAtom,
    chat.profilesAtom,
    chat.currentProfileAtom,
  ]);
  const stopModelRefresh = chat.currentModelAtom.effect(() => {
    chat?.listSessions();
  });
  const stopProfilesRefresh = chat.connectedAtom.effect(() => {
    if (chat?.connectedAtom()) chat.listProfiles();
  });
  const prevStop = stopChatEffects;
  stopChatEffects = () => {
    prevStop();
    stopModelRefresh();
    stopProfilesRefresh();
  };
}

// ── Composer handlers ───────────────────────────────────────────────────────

function autoResize(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

function onChatSubmit(e: Event): void {
  e.preventDefault();
  const el = chatInputEl;
  if (!el) return;
  const text = el.value.trim();
  if (!text) return;
  el.value = "";
  autoResize(el);

  if (text.startsWith("/")) {
    chat?.sendSlashCommand(text);
  } else {
    chat?.sendMessage(text);
  }
}

function onChatKeydown(e: KeyboardEvent): void {
  // Enter submits, Shift+Enter inserts a newline.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    (e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
  }
}

function onProfileChange(e: Event): void {
  const select = e.currentTarget as HTMLSelectElement;
  const profileName = select.value;
  if (!chat) return;

  if (
    chat.getUserMessageCount() > 0 &&
    !confirm("Switching profile will clear session context and all messages. Continue?")
  ) {
    select.value = chat.currentProfileAtom();
    return;
  }
  chat.switchProfile(profileName, true); // force: confirm() above already asked
}

function onModelChange(e: Event): void {
  const modelName = (e.currentTarget as HTMLSelectElement).value;
  if (!modelName) return;
  chat?.sendSlashCommand(`/model ${modelName}`);
}

function onCancelSession(sessionId: string): void {
  chat?.send({ type: "cancel", sessionId });
  chat?.sessionWorkingMap.set(sessionId, false);
  if (chat?.sessionIdAtom() === sessionId) {
    chat?.workingAtom(false);
  }
}

// ── View ────────────────────────────────────────────────────────────────────

function App() {
  const screen = screenAtom();
  const connected = chat?.connectedAtom() ?? false;
  const working = chat?.workingAtom() ?? false;
  const activeLogId = activeLogIdAtom();
  const sessionId = chat?.sessionIdAtom() ?? null;
  const title = chat?.sessionTitleAtom() ?? null;
  const menu = contextMenuAtom();

  return (
    <>
      <LoginScreen hidden={screen !== "login"} onToken={activateToken} />

      <div id="main-ui" className={`screen${screen === "main" ? "" : " hidden"}`}>
        <Sidebar
          sessions={sessionsAtom()}
          activeSessionId={sessionId}
          workingMap={chat?.sessionWorkingMap ?? new Map()}
          logs={logsAtom()}
          activeLogId={activeLogId}
          onCreate={() => chat?.createSession({})}
          onSwitch={(id) => {
            // Clicking the active session only matters in log view mode (switches back).
            if (id === sessionId && !activeLogId) return;
            chat?.switchSession(id);
          }}
          onCancel={onCancelSession}
          onContinueLog={(id) => chat?.loadLog(id)}
          onViewLog={(id) => chat?.viewLog(id)}
          onSessionMenu={onSessionMenu}
          onLogMenu={onLogMenu}
        />

        <main id="chat-area">
          <div id="session-info">
            <span id="session-label" style={activeLogId ? { opacity: "0.5" } : undefined}>
              Session:{" "}
              <span id="current-session-id">{title || (sessionId ? sessionId.slice(0, 8) : "")}</span>
            </span>
            {activeLogId ? (
              <span id="log-view-label">
                Viewing log: <span id="current-log-id">{activeLogId.slice(0, 8)}</span>{" "}
                <button id="close-log-view-btn" title="Close log view" onClick={onCloseLogView}>
                  ✕
                </button>
              </span>
            ) : null}
            <span id="connection-status" className={connected ? "status-connected" : "status-disconnected"}>
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>

          {/* Imperatively managed by MessageListManager via ref (streaming markdown). */}
          <div id="message-list" ref={messageListRef}></div>

          {working ? (
            <div id="working-indicator">
              <span className="spinner"></span>
              <span>Model is working...</span>
              <button id="cancel-btn" className="cancel-inline" onClick={() => chat?.cancel()}>
                Cancel
              </button>
            </div>
          ) : null}

          <div id="input-area" className={activeLogId ? "read-only" : undefined}>
            <form id="chat-form" onSubmit={onChatSubmit}>
              <textarea
                id="chat-input"
                placeholder="Type a message..."
                autocomplete="off"
                rows="1"
                disabled={activeLogId !== null}
                ref={chatInputRef}
                onInput={() => {
                  if (chatInputEl) autoResize(chatInputEl);
                }}
                onKeydown={onChatKeydown}
              />
              <div id="composer-actions">
                <label id="profile-selector">
                  Profile:{" "}
                  <select id="profile-select" ref={profileSelectRef} onChange={onProfileChange}>
                    {chat
                      ? Object.keys(chat.profilesAtom()).map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))
                      : null}
                  </select>
                </label>
                <label id="model-selector">
                  Model:{" "}
                  <select id="model-select" ref={modelSelectRef} onChange={onModelChange}>
                    {chat?.modelsAtom().map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" id="send-btn">
                  Send
                </button>
              </div>
            </form>
          </div>
        </main>
      </div>

      {menu ? <ContextMenu menu={menu} rootRef={contextMenuRef} /> : null}
    </>
  );
}

// ── Init ────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  mounted = mount(<App />, root as unknown as DomNode);
  effect(render, [
    screenAtom,
    ...loginAtoms,
    sessionsAtom,
    logsAtom,
    activeLogIdAtom,
    contextMenuAtom,
  ]);

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    // Ctrl+Shift+L logs out.
    if (e.ctrlKey && e.shiftKey && (e.key === "L" || e.key === "l")) {
      handleAuthFailure();
    }
  });

  const savedToken = getStoredToken();
  if (savedToken) {
    if (await verifyToken(savedToken)) {
      activateToken(savedToken);
    }
  } else {
    showLogin();
  }
  // On auto-login the login screen is hidden; focusing its input is a no-op
  // at best and steals focus from the composer UX.
  if (screenAtom() === "login") focusLoginInput();
}

void init();
