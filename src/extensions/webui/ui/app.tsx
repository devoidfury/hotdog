/// <reference lib="dom" />
// Wires login, chat, and sessions together. The JSX tree owns all layout;
// atoms hold view state and a single render() re-renders on change. The
// message list container is handed to the imperative renderer via ref.

import { mount, type Mounted, type Ref, type DomNode } from "@utils/jsx";
import { reactiveState, effect, shortId } from "./utils.ts";
import { createChat, type ChatController, type CompletionItem } from "./chat.ts";
import {
  LoginScreen,
  focusLoginInput,
  getStoredToken,
  clearStoredToken,
  loginAtoms,
} from "./login.tsx";
import { Sidebar, ContextMenu, type ContextMenuState, type SessionInfo, type LogInfo } from "./sessions.tsx";
import { SubagentsStrip, TaskPanel } from "./subagents.tsx";
import { audioBlobToWav } from "./wav.ts";

type Screen = "login" | "main";

const screenAtom = reactiveState<Screen>("login");
const sessionsAtom = reactiveState<SessionInfo[]>([]);
const logsAtom = reactiveState<LogInfo[]>([]);
const activeLogIdAtom = reactiveState<string | null>(null);
const contextMenuAtom = reactiveState<ContextMenuState | null>(null);

// Subagent overlay panels: task ids with an open panel, bottom-first; the
// last entry renders above the others. nowAtom ticks once per second while a
// task is live so elapsed times refresh.
const openTasksAtom = reactiveState<string[]>([]);
const nowAtom = reactiveState<number>(Date.now());
let taskTickTimer: ReturnType<typeof setInterval> | null = null;

function syncTaskTick(): void {
  const tasks = chat?.tasksAtom() ?? [];
  const hasActive = tasks.some((t) => t.status === "running" || t.status === "queued");
  if (hasActive && taskTickTimer === null) {
    taskTickTimer = setInterval(() => nowAtom(Date.now()), 1000);
  } else if (!hasActive && taskTickTimer !== null) {
    clearInterval(taskTickTimer);
    taskTickTimer = null;
  }
}

function openTask(taskId: string): void {
  // Panel opened after a page refresh: fetch the buffered history first.
  if (chat && chat.getTaskActivity(taskId).length === 0) chat.requestTaskActivity(taskId);
  // Re-opening brings the panel to the front instead of duplicating it.
  openTasksAtom([...openTasksAtom().filter((id) => id !== taskId), taskId]);
}

function closeTask(taskId: string): void {
  openTasksAtom(openTasksAtom().filter((id) => id !== taskId));
}

function cancelTask(taskId: string): void {
  // Server delegates to TaskManager.interruptTask; the taskUpdate feed
  // flips the panel status to cancelled on the way back.
  if (confirm(`Cancel task ${taskId}? In-flight work is aborted.`)) {
    chat?.interruptTask(taskId);
  }
}

// Tab-completion popup for the composer (server-driven, see C2S.COMPLETE).
interface CompletionMenu {
  options: CompletionItem[];
  /** Text before the caret that a chosen option replaces. */
  prefix: string;
  index: number;
}
const completionAtom = reactiveState<CompletionMenu | null>(null);

// Composer file attachments (upload button): base64 payloads staged client-
// side, sent with the next message as C2S `send` files (see protocol.ts
// UploadFileWire). Size/vision limits are enforced server-side; rejections
// surface as visible chat errors.
interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  data: string; // base64, no data: prefix
}
const attachmentsAtom = reactiveState<PendingAttachment[]>([]);

// When checked, messages are injected into the next seam (mid-turn steering)
// rather than queued. This is useful for redirecting the agent while it works.
const steerAtom = reactiveState<boolean>(true);

// Bumped whenever the app stops caring about a pending completion response
// (escape, blur, edit, apply), so a late reply cannot reopen the menu;
// chat.ts separately drops stale responses by request id.
let completionToken = 0;

function dismissCompletion(): void {
  completionToken++;
  if (completionAtom()) completionAtom(null);
}

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
let fileInputEl: HTMLInputElement | null = null;

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
const fileInputRef = domRef<HTMLInputElement>((el) => {
  fileInputEl = el;
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
    chat.clearTasks();
    chat.disconnect();
    chat = null;
  }
  if (taskTickTimer !== null) {
    clearInterval(taskTickTimer);
    taskTickTimer = null;
  }
  openTasksAtom([]);
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
    chat.tasksAtom,
    chat.activityVersionAtom,
    chat.taskControlAtom,
    chat.sttEnabledAtom,
    sttPhaseAtom,
  ]);
  const stopModelRefresh = chat.currentModelAtom.effect(() => {
    chat?.listSessions();
  });
  const stopProfilesRefresh = chat.connectedAtom.effect(() => {
    if (chat?.connectedAtom()) chat.listProfiles();
  });
  // Elapsed-time tick only while a task is live (idle sessions burn nothing).
  const stopTaskTick = chat.tasksAtom.effect(syncTaskTick);
  syncTaskTick();
  const prevStop = stopChatEffects;
  stopChatEffects = () => {
    prevStop();
    stopModelRefresh();
    stopProfilesRefresh();
    stopTaskTick();
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
  const attachments = attachmentsAtom();
  if (!text && attachments.length === 0) return;
  el.value = "";
  autoResize(el);
  dismissCompletion();

  const files =
    attachments.length > 0
      ? attachments.map(({ name, mimeType, data }) => ({ name, mimeType, data }))
      : undefined;
  if (files) {
    attachmentsAtom([]);
    if (fileInputEl) fileInputEl.value = "";
  }

  if (text.startsWith("/") && !files) {
    chat?.sendSlashCommand(text);
  } else {
    chat?.sendMessage(text, files, steerAtom());
  }
}

// ── File uploads ────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Read one File/Blob as base64 (data-URL payload with the prefix stripped). */
function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

let attachmentSeq = 0;

async function onFilesPicked(e: Event): Promise<void> {
  const input = e.currentTarget as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  input.value = ""; // Allow re-picking the same file after a removal.
  if (picked.length === 0) return;

  const added: PendingAttachment[] = [];
  for (const file of picked) {
    if (file.size === 0) continue;
    try {
      added.push({
        id: `att-${++attachmentSeq}`,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        data: await readFileAsBase64(file),
      });
    } catch {
      console.warn("[upload] failed to read", file.name);
    }
  }
  if (added.length > 0) attachmentsAtom([...attachmentsAtom(), ...added]);
}

function removeAttachment(id: string): void {
  attachmentsAtom(attachmentsAtom().filter((a) => a.id !== id));
}

// ── Push-to-talk dictation ──────────────────────────────────────────────────
// Hold the mic button to record (MediaRecorder -> audio/webm); releasing sends
// a `transcribe` and the reply is inserted at the caret. Never auto-sends --
// the transcript always lands as editable text in the composer.

type SttPhase = "idle" | "recording" | "transcribing";
const sttPhaseAtom = reactiveState<SttPhase>("idle");

let micRecorder: MediaRecorder | null = null;
// Set when the button was released while getUserMedia permission was pending.
let micStopArmed = false;

function sttFail(message: string): void {
  console.warn("[stt]", message);
  sttPhaseAtom("idle");
  chat?.messageListAtom()?.handleSystemMessage({ content: message });
}

function insertAtCaret(text: string): void {
  const el = chatInputEl;
  if (!el) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + text.length;
  el.setSelectionRange(pos, pos);
  el.focus();
  autoResize(el);
}

async function micStart(): Promise<void> {
  if (!chat || sttPhaseAtom() !== "idle") return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    sttFail("Microphone capture needs a secure context (https or localhost).");
    return;
  }
  micStopArmed = false;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    sttFail("Microphone unavailable (permission denied?).");
    return;
  }
  if (micStopArmed) {
    // Released while the permission prompt was still up; nothing to record.
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const chunks: Blob[] = [];
  const rec = new MediaRecorder(stream);
  micRecorder = rec;
  rec.ondataavailable = (e: BlobEvent) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    micRecorder = null;
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    if (blob.size === 0) {
      sttPhaseAtom("idle");
      return;
    }
    sttPhaseAtom("transcribing");
    // Backend format sniffing: whisper/llama.cpp-style endpoints reject the
    // browser's webm/opus upload; re-encode to wav, falling back to the raw
    // recording if the browser can't (transcribe then fails with the
    // backend's own error, which is more truthful than a silent drop).
    const toSend = await audioBlobToWav(blob).catch(() => blob);
    readFileAsBase64(toSend)
      .then((data) => chat!.transcribe(toSend.type, data))
      .then((text) => {
        insertAtCaret(text);
        sttPhaseAtom("idle");
      })
      .catch((err: unknown) => sttFail(err instanceof Error ? err.message : String(err)));
  };
  rec.start();
  sttPhaseAtom("recording");
}

function micStop(): void {
  if (micRecorder) micRecorder.stop();
  else micStopArmed = true; // stop as soon as the pending permission resolves
}

function onMicMousedown(e: MouseEvent): void {
  // Hold to talk: stop on mouseup wherever the pointer ended up.
  e.preventDefault();
  if (sttPhaseAtom() === "recording") return;
  void micStart();
  const up = () => {
    document.removeEventListener("mouseup", up);
    micStop();
  };
  document.addEventListener("mouseup", up);
}

function requestCompletions(el: HTMLTextAreaElement): void {
  const cursor = el.selectionStart ?? el.value.length;
  const token = ++completionToken;
  chat?.requestCompletions(el.value, cursor, (options, prefix) => {
    // Results are for the line as it was at request time; any edit, escape,
    // or blur since then bumped the token, so a late reply is dropped.
    if (token !== completionToken) return;
    if (options.length === 0) {
      completionAtom(null);
      return;
    }
    completionAtom({ options, prefix, index: 0 });
  });
}

function applyCompletion(el: HTMLTextAreaElement, menu: CompletionMenu, item: CompletionItem): void {
  const cursor = el.selectionStart ?? el.value.length;
  const start = Math.max(0, cursor - menu.prefix.length);
  el.value = el.value.slice(0, start) + item.value + el.value.slice(cursor);
  const pos = start + item.value.length;
  el.setSelectionRange(pos, pos);
  el.focus();
  dismissCompletion();
  autoResize(el);
}

function onChatKeydown(e: KeyboardEvent): void {
  const el = e.currentTarget as HTMLTextAreaElement;
  const menu = completionAtom();

  if (menu) {
    if (e.key === "Escape") {
      e.preventDefault();
      dismissCompletion();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      completionAtom({ ...menu, index: (menu.index + 1) % menu.options.length });
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      const n = menu.options.length;
      completionAtom({ ...menu, index: (menu.index - 1 + n) % n });
      return;
    }
    if (e.key === "Enter" && !e.ctrlKey && !e.altKey) {
      // Accept instead of submit; Escape first to send the raw text.
      e.preventDefault();
      applyCompletion(el, menu, menu.options[menu.index]!);
      return;
    }
  } else if (e.key === "Tab") {
    e.preventDefault();
    requestCompletions(el);
    return;
  }

  // Enter submits, Shift+Enter inserts a newline.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    el.form?.requestSubmit();
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
  const completionMenu = completionAtom();
  const attachments = attachmentsAtom();
  const allTasks = chat ? chat.tasksAtom() : [];
  // Scope the server-global feed to the open session; null-parent tasks
  // (workflow-engine spawns) belong to no session and never show.
  const tasks = allTasks.filter((t) => sessionId !== null && t.sessionId === sessionId);
  const openTasks = openTasksAtom();
  const sttPhase = sttPhaseAtom();

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

          {/* Live background task agents; clicking a chip opens its overlay. */}
          <SubagentsStrip
            tasks={tasks}
            now={nowAtom()}
            openTaskIds={openTasks}
            onOpen={openTask}
          />

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
              {completionMenu ? (
                <div id="completion-menu">
                  {completionMenu.options.map((o, i) => (
                    <div
                      key={o.value}
                      className={`completion-item${i === completionMenu.index ? " active" : ""}`}
                      // mousedown + preventDefault: accept without the
                      // blur-then-click losing the caret position.
                      onMousedown={(e: MouseEvent) => {
                        e.preventDefault();
                        if (chatInputEl) applyCompletion(chatInputEl, completionMenu, o);
                      }}
                    >
                      {o.display ?? o.value}
                    </div>
                  ))}
                </div>
              ) : null}
              <div id="attachment-chips">
                {attachments.map((a) => (
                  <span key={a.id} className="attachment-chip" title={a.name}>
                    <span className="attachment-name">{a.name}</span>
                    <span className="attachment-size">{formatSize(a.size)}</span>
                    <button
                      type="button"
                      className="attachment-remove"
                      title="Remove attachment"
                      onClick={() => removeAttachment(a.id)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <textarea
                id="chat-input"
                placeholder="Type a message..."
                autocomplete="off"
                rows="1"
                disabled={activeLogId !== null}
                ref={chatInputRef}
                onInput={() => {
                  if (chatInputEl) autoResize(chatInputEl);
                  dismissCompletion();
                }}
                onBlur={dismissCompletion}
                onKeydown={onChatKeydown}
              />
              <div id="composer-actions">
                <input
                  type="file"
                  id="file-input"
                  multiple
                  hidden
                  ref={fileInputRef}
                  onChange={onFilesPicked}
                />
                <button
                  type="button"
                  id="attach-btn"
                  title="Attach files to the next message"
                  disabled={activeLogId !== null}
                  onClick={() => fileInputEl?.click()}
                >
                  Attach
                </button>
                {chat?.sttEnabledAtom() ? (
                  <button
                    type="button"
                    id="mic-btn"
                    className={sttPhase === "recording" ? "recording" : undefined}
                    title="Hold to record; the transcript is inserted into the input"
                    disabled={activeLogId !== null || sttPhase === "transcribing"}
                    onMousedown={onMicMousedown}
                  >
                    {sttPhase === "recording" ? "● Recording" : sttPhase === "transcribing" ? "..." : "Mic"}
                  </button>
                ) : null}
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
                <label id="steer-label">
                  <input
                    type="checkbox"
                    id="steer-checkbox"
                    checked={steerAtom()}
                    onChange={(e: Event) =>
                      steerAtom((e.target as HTMLInputElement).checked)
                    }
                  />
                  Steer
                </label>
                <button type="submit" id="send-btn">
                  Send
                </button>
              </div>
            </form>
          </div>
        </main>

        {/* Stacked task overlays; the most recently opened sits on top. */}
        {openTasks.map((id, i) => {
          const task = tasks.find((t) => t.taskId === id);
          if (!task || !chat) return null;
          return (
            <TaskPanel
              key={id}
              task={task}
              activity={chat.getTaskActivity(id)}
              now={nowAtom()}
              zBase={100 + i}
              control={chat.taskControlAtom()[id] ?? null}
              onClose={closeTask}
              onCancel={cancelTask}
              onFollowup={(tid, message) => chat?.taskFollowup(tid, message)}
            />
          );
        })}
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
    completionAtom,
    attachmentsAtom,
    openTasksAtom,
    nowAtom,
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
