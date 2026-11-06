/// <reference lib="dom" />
// Wires login, chat, and sessions together. The JSX tree owns all layout;
// atoms hold view state and a single render() re-renders on change. The
// message list container is handed to the imperative renderer via ref.

import { mount, type Mounted, type Ref, type DomNode } from "@utils/jsx";
import { reactiveState, effect, shortId, copyText, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, clampSidebarWidth } from "./utils.ts";
import { createChat, type ChatController, type CompletionItem } from "./chat.ts";
import {
  LoginScreen,
  focusLoginInput,
  getStoredToken,
  clearStoredToken,
  loginAtoms,
} from "./login.tsx";
import { loadDraft, clearDraft, scheduleDraftSave, flushDraftSave, cancelDraftSave } from "./draft.ts";
import { loadAttachments, saveAttachments, type PendingAttachment } from "./attachment-store.ts";
import { Sidebar, ContextMenu, scrollHitIntoView, type ContextMenuItem, type ContextMenuState, type SessionInfo, type LogInfo, type SearchState } from "./sessions.tsx";
import type { SearchHitWire } from "./chat.ts";
import { SubagentsStrip, TaskPanel, createActivityRegistry } from "./subagents.tsx";
import { createCoalescer } from "./batch.ts";
import { audioBlobToWav } from "./wav.ts";

type Screen = "login" | "main";

const screenAtom = reactiveState<Screen>("login");
const sessionsAtom = reactiveState<SessionInfo[]>([]);
const logsAtom = reactiveState<LogInfo[]>([]);
const activeLogIdAtom = reactiveState<string | null>(null);
const contextMenuAtom = reactiveState<ContextMenuState | null>(null);

// Sidebar full-text search (see sessions.tsx SearchPanel + the searchLogs WS
// round-trip). One atom; every handler replaces the object wholesale. `open`
// swaps the two sidebar lists for the panel. The input is uncontrolled: its
// DOM node is stable across renders (unlike the tree), so keystrokes never
// rebuild it; query mirrors into the atom for the highlight/results only.
const searchAtom = reactiveState<SearchState>({ open: false, query: "", pending: false, results: null });

// Debounce + request-id for the search round-trip. searchReqId bumps on every
// query edit (invalidating any in-flight reply) AND when a request fires, so a
// late server reply carrying an older id is dropped in onSearchResults.
const SEARCH_DEBOUNCE_MS = 250;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let searchReqId = 0;

function cancelSearchDebounce(): void {
  if (searchDebounce !== null) {
    clearTimeout(searchDebounce);
    searchDebounce = null;
  }
}

function openSearch(): void {
  if (searchAtom().open) return;
  searchAtom({ ...searchAtom(), open: true });
  // Focus once the panel has rendered (the atom's render microtask is already
  // queued ahead of this one, so the input element exists by the time we run).
  queueMicrotask(() => searchInputEl?.focus());
}

function closeSearch(): void {
  cancelSearchDebounce();
  searchReqId++; // drop any in-flight reply for the query we're abandoning
  searchAtom({ open: false, query: "", pending: false, results: null });
}

function sendSearch(query: string): void {
  const q = query.trim();
  if (q === "") return;
  searchReqId++;
  searchAtom({ ...searchAtom(), pending: true });
  chat?.searchLogs(q, searchReqId);
}

function onSearchQuery(text: string): void {
  cancelSearchDebounce();
  searchReqId++; // any in-flight reply is now stale
  const q = text.trim();
  if (q === "") {
    searchAtom({ ...searchAtom(), query: text, pending: false, results: null });
    return;
  }
  searchAtom({ ...searchAtom(), query: text, pending: true });
  searchDebounce = setTimeout(() => {
    searchDebounce = null;
    sendSearch(text);
  }, SEARCH_DEBOUNCE_MS);
}

function onSearchKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    closeSearch();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    cancelSearchDebounce();
    sendSearch(searchAtom().query);
  }
}

function onActivateHit(hit: SearchHitWire): void {
  // live → attach to the running session; cold → read-only log view.
  if (hit.live) chat?.switchSession(hit.logId);
  else chat?.viewLog(hit.logId);
  closeSearch();
  // Then bring the selected row into view: closing search re-mounts the
  // lists, and closeSearch's atom render is already queued ahead of this
  // microtask (the openSearch focus idiom), so the rows exist by the time
  // we look. Missing row (session ended mid-click) is a quiet no-op.
  queueMicrotask(() => scrollHitIntoView(document, hit.live, hit.logId));
}

function onSearchResults(
  requestId: number | undefined,
  query: string,
  results: SearchHitWire[],
): void {
  if (requestId !== searchReqId) return; // stale: a newer query superseded it
  cancelSearchDebounce();
  searchAtom({ ...searchAtom(), pending: false, query, results });
}

// Subagent overlay panels: task ids with an open panel, bottom-first; the
// last entry renders above the others. nowAtom ticks once per second while a
// task is live so elapsed times refresh.
const openTasksAtom = reactiveState<string[]>([]);
const stripExpandedAtom = reactiveState<boolean>(false);
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

// Composer file attachments: base64 payloads staged client-side (Attach
// button, paste, drop), sent with the next message as C2S `send` files (see
// protocol.ts UploadFileWire). Persisted across reloads by attachment-store,
// restored when the composer mounts (same lifecycle as the draft). Size and
// vision limits are enforced server-side; rejections surface as chat errors.
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

// Search input (sidebar). Uncontrolled: value lives in the DOM node, the atom
// only mirrors it for highlight/results. Stable ref identity so the node is
// never re-mounted (and focus preserved) across renders.
let searchInputEl: HTMLInputElement | null = null;
const searchInputRef = domRef<HTMLInputElement>((el) => {
  searchInputEl = el;
});

// pagehide fires reliably everywhere modern; beforeunload only as the legacy
// fallback so an unload still flushes a pending draft save.
const DRAFT_LEAVE_EVENT = "onpagehide" in window ? "pagehide" : "beforeunload";
function flushDraftOnLeave(): void {
  flushDraftSave();
}

// Stable ref identities. Inline closures would be new every render, making
// patch() detach (null) and re-attach every ref on every render.
const chatInputRef = domRef<HTMLTextAreaElement>((el) => {
  chatInputEl = el;
  if (el) {
    // Composer mount: bring back the previous visit's draft (never clobber
    // text already in the box) and hook the unload flush to the composer's
    // own lifecycle.
    const draft = loadDraft();
    if (draft !== null && el.value === "") {
      el.value = draft;
      autoResize(el);
    }
    // Same reload-survival for staged attachments (never clobber live ones).
    if (attachmentsAtom().length === 0) {
      const stored = loadAttachments();
      if (stored.length > 0) {
        attachmentsAtom(stored.map((f) => ({ ...f, id: newAttachmentId() })));
      }
    }
    window.addEventListener(DRAFT_LEAVE_EVENT, flushDraftOnLeave);
    window.addEventListener("dragover", swallowFileDrop);
    window.addEventListener("drop", swallowFileDrop);
  } else {
    window.removeEventListener(DRAFT_LEAVE_EVENT, flushDraftOnLeave);
    window.removeEventListener("dragover", swallowFileDrop);
    window.removeEventListener("drop", swallowFileDrop);
  }
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

// Panel activity bodies are per-panel declarative mounts (see subagents.tsx):
// a delta re-renders only the open panels' small trees, coalesced to one
// pass per frame. activityVersionAtom is deliberately NOT in the App render
// effect -- streaming subagent output must never re-render the transcript.
const activityRegistry = createActivityRegistry((taskId) => chat?.getTaskActivity(taskId) ?? []);
const flushActivityViews = createCoalescer(() => activityRegistry.renderAll());

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
  stripExpandedAtom(false);
  // The message-list div persists across login screens (main-ui is only
  // class-hidden), and each new chat attaches a fresh MessageListManager.
  // Clear the container so stale messages from the old chat do not pile up.
  if (messageListEl) messageListEl.innerHTML = "";
  sessionsAtom([]);
  logsAtom([]);
  activeLogIdAtom(null);
  contextMenuAtom(null);
  // Pins are server truth rehydrated from list payloads: start the next
  // login from an empty set so a dead connection can't keep stale marks.
  pinnedIdsAtom(new Set());
  // Drop any open search: the panel is chat-scoped and the socket is gone.
  closeSearch();
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

// ── Row pins (server-persisted) ─────────────────────────────────────────────
// Pins live on the server (src/extensions/websocket/pin-store.ts) and ride
// both list payloads as a per-row `pinned` flag; pinnedIdsAtom hydrates
// from those flags (no localStorage, no client-side prune). The menu toggle
// flips the atom optimistically and sends C2S setPinned; the server's
// broadcast reconciles every tab, and a refused flip reverts on the next
// payload. Pinned rows sort above unpinned ones within their section (see
// sessions.tsx sortPinned).

const pinnedIdsAtom = reactiveState<Set<string>>(new Set());

/** Rehydrate pin marks from a list payload: the flags on the rows present
 *  win outright, so this tab's optimistic flips reconcile and other tabs'
 *  changes land. Rows absent from a payload are left alone (they belong to
 *  the other list); rows that died are dropped by the delete broadcasts. */
function applyPinnedFlags(rows: Array<{ id: string; pinned?: boolean }>): void {
  const current = pinnedIdsAtom();
  const next = new Set(current);
  for (const row of rows) {
    if (row.pinned === true) next.add(row.id);
    else next.delete(row.id);
  }
  if (next.size !== current.size || [...next].some((id) => !current.has(id))) {
    pinnedIdsAtom(next);
  }
}

/** Forget a pin whose row just died (sessionDeleted / logDeleted). */
function dropPinnedId(id: string): void {
  const current = pinnedIdsAtom();
  if (!current.has(id)) return;
  const next = new Set(current);
  next.delete(id);
  pinnedIdsAtom(next);
}

function togglePinned(id: string): void {
  const pinned = !pinnedIdsAtom().has(id);
  const next = new Set(pinnedIdsAtom());
  if (pinned) next.add(id);
  else next.delete(id);
  pinnedIdsAtom(next);
  chat?.setPinned(id, pinned);
}

// ── Row menu shared actions ─────────────────────────────────────────────────

let copyToastTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Ephemeral bottom-center confirmation (#copy-toast). Deliberately NOT
 * messageList.handleSystemMessage: that appends into the transcript, and a
 * "Copied" bubble must not land in an open cold-log window (Feature B).
 */
function showCopyToast(text: string): void {
  let toast = document.getElementById("copy-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "copy-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("visible");
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    toast?.classList.remove("visible");
    copyToastTimer = null;
  }, 1800);
}

function copyRowValue(text: string, label: string): void {
  void copyText(text).then((ok) => {
    showCopyToast(ok ? `${label} copied` : "Copy failed: clipboard unavailable");
  });
}

/**
 * Raw JSONL download through the webui server's /export route. A plain
 * navigation (hidden anchor) cannot carry the x-hotdog-token header, so the
 * session token rides the query string; the route checks it with exactly the
 * /verify validation. The attachment Content-Disposition means the click
 * downloads instead of navigating.
 */
function exportSessionLog(id: string): void {
  const a = document.createElement("a");
  a.href = `/export/${encodeURIComponent(id)}?token=${encodeURIComponent(token ?? "")}`;
  a.download = `${id}.jsonl`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Pin/Unpin toggle, one per row grammar, leading the menu. */
function pinMenuItem(id: string): ContextMenuItem {
  return {
    label: pinnedIdsAtom().has(id) ? "Unpin" : "Pin",
    onSelect: () => {
      togglePinned(id);
      dismissContextMenu();
    },
  };
}

/** Shared tail: copy id, copy path (hidden when the server omitted it), export. */
function rowMenuTail(id: string, logPath: string | undefined): ContextMenuItem[] {
  return [
    {
      label: "Copy session id",
      onSelect: () => {
        copyRowValue(id, "Session id");
        dismissContextMenu();
      },
    },
    ...(logPath
      ? [
          {
            label: "Copy log file path",
            onSelect: () => {
              copyRowValue(logPath, "Log file path");
              dismissContextMenu();
            },
          },
        ]
      : []),
    {
      label: "Export",
      onSelect: () => {
        exportSessionLog(id);
        dismissContextMenu();
      },
    },
  ];
}

function onSessionMenu(e: MouseEvent, s: SessionInfo): void {
  const displayName = s.title || s.profile || "default";
  const isWorking = chat?.sessionWorkingMap.get(s.id) ?? false;
  contextMenuAtom({
    x: e.clientX,
    y: e.clientY,
    items: [
      pinMenuItem(s.id),
      ...(isWorking
        ? [
            {
              label: "Stop",
              // The same availability and the same handler as the row's
              // inline Stop (which carries no confirm): the chat cancel
              // path plus the optimistic working-flag clear.
              onSelect: () => {
                onCancelSession(s.id);
                dismissContextMenu();
              },
            },
          ]
        : [
            {
              label: "Dismiss",
              // Idle rows only (working rows keep Stop above). Confirm
              // because it tears down a live agent, with honest copy: the
              // log and the pin survive; the row demotes to Recent Logs.
              onSelect: () => {
                if (
                  confirm(
                    `Dismiss session ${shortId(s.id)}? The live session closes; its log stays in Recent Logs.`,
                  )
                ) {
                  chat?.dismissSession(s.id);
                }
                dismissContextMenu();
              },
            },
          ]),
      ...rowMenuTail(s.id, s.logPath),
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
  const logPath = logsAtom().find((l) => l.id === logId)?.logPath;
  contextMenuAtom({
    x: e.clientX,
    y: e.clientY,
    items: [
      pinMenuItem(logId),
      {
        label: "Resume",
        // The inline Resume's handler verbatim (no confirm on either).
        onSelect: () => {
          chat?.loadLog(logId);
          dismissContextMenu();
        },
      },
      ...rowMenuTail(logId, logPath),
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

// ── Sidebar resize ──────────────────────────────────────────────────────────

const SIDEBAR_WIDTH_KEY = "hotdog.sidebarWidth";

// Live width; App reads it per render for aria-valuenow. Drags update it
// imperatively (CSS var + aria attr) so pointermove never re-renders the tree.
let sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
let resizeDrag: { pointerId: number; startX: number; startWidth: number } | null = null;

function sidebarMaxWidth(): number {
  // Same floor as clampSidebarWidth: on sub-400px viewports min wins.
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth / 2));
}

function applySidebarWidth(el: HTMLElement | null, width: number): void {
  sidebarWidth = clampSidebarWidth(width, window.innerWidth);
  document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  el?.setAttribute("aria-valuenow", String(sidebarWidth));
}

function persistSidebarWidth(): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  } catch {
    // Storage disabled (private mode / blocked): the session still resizes.
  }
}

function restoreSidebarWidth(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  } catch {
    return;
  }
  if (raw === null) return;
  const saved = Number(raw);
  if (!Number.isFinite(saved)) return;
  // Clamp against the current viewport, not the one it was saved on.
  applySidebarWidth(null, saved);
}

function onSidebarResizeStart(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement;
  if (el.offsetParent === null) return; // mobile drawer: width is CSS-only
  el.focus();
  resizeDrag = { pointerId: e.pointerId, startX: e.clientX, startWidth: sidebarWidth };
  el.setPointerCapture(e.pointerId);
  document.body.classList.add("sidebar-resizing");
}

function onSidebarResizeMove(e: PointerEvent): void {
  if (!resizeDrag || e.pointerId !== resizeDrag.pointerId) return;
  applySidebarWidth(e.currentTarget as HTMLElement, resizeDrag.startWidth + (e.clientX - resizeDrag.startX));
}

function onSidebarResizeEnd(e: PointerEvent): void {
  if (!resizeDrag || e.pointerId !== resizeDrag.pointerId) return;
  resizeDrag = null;
  document.body.classList.remove("sidebar-resizing");
  persistSidebarWidth();
}

// Home/End jump to min/max (standard slider semantics); arrows step 16px,
// or 48px with Shift for a coarse step.
function onSidebarResizeKey(e: KeyboardEvent): void {
  let next: number | null = null;
  if (e.key === "ArrowRight") next = sidebarWidth + (e.shiftKey ? 48 : 16);
  else if (e.key === "ArrowLeft") next = sidebarWidth - (e.shiftKey ? 48 : 16);
  else if (e.key === "Home") next = SIDEBAR_MIN_WIDTH;
  else if (e.key === "End") next = SIDEBAR_MAX_WIDTH;
  if (next === null) return;
  e.preventDefault();
  applySidebarWidth(e.currentTarget as HTMLElement, next);
  persistSidebarWidth();
}

function onSidebarResizeReset(e: MouseEvent): void {
  // Double-click: back to the default and forget the stored preference.
  applySidebarWidth(e.currentTarget as HTMLElement, SIDEBAR_DEFAULT_WIDTH);
  try {
    localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  } catch {
    // ignore storage failures
  }
}

// ── Chat wiring ─────────────────────────────────────────────────────────────

function startChat(): void {
  chat = createChat({
    token,
    host: window.location.host,
    getMessageListContainer: () => messageListEl,
    onSessionCreated: ({ sessionId, replayDelta }) => {
      // A delta attach replays only the tail past the cursor, so the existing
      // transcript (its prefix) must survive the switch.
      chat!.setSession(sessionId, replayDelta === true);
      chat!.listSessions();
      chat!.listProfiles();
      clearLogView();
    },
    onSessionsUpdate: (sessions) => {
      // The display pointer must not move here: the socket stays attached to
      // its session while a cold log is being browsed, so a sidebar refresh
      // is never an attach. (It used to clear log view whenever any session
      // was attached -- including the refresh that entering log view itself
      // triggers -- which desynced the pointer from the transcript and made
      // the live-row click read "same session, nothing to do".) Only the
      // attach path (sessionCreated) and explicit exits leave log view.
      sessionsAtom(sessions);
      applyPinnedFlags(sessions);
    },
    onLogsUpdate: (logs) => {
      logsAtom(logs);
      applyPinnedFlags(logs);
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
      dropPinnedId(logId);
      if (activeLogIdAtom() === logId) {        // The viewed log died: restore the live transcript the same way
        // closing the log view does (re-attach replays it), so a deleted
        // log's entries can never sit on screen while live events
        // un-suppress beneath them.
        onCloseLogView();
      } else {
        chat?.listLogs();
      }
    },
    onSessionDeleted: (sessionId) => {
      dropPinnedId(sessionId);
    },
    onSearchResults,
    onAuthFailure: handleAuthFailure,
    onWorkingMapChange: () => {
      // Re-poll so the sidebar's per-session working indicators refresh.
      chat?.listSessions();
    },
  });

  // Re-render on any chat atom change; also refresh the sidebar when the
  // model changes, and pull profiles once connected. activityVersionAtom is
  // absent on purpose -- it drives flushActivityViews, not the JSX tree.
  stopChatEffects = effect(render, [
    chat.connectedAtom,
    chat.workingAtom,
    chat.sessionIdAtom,
    chat.modelsAtom,
    chat.currentModelAtom,
    chat.profilesAtom,
    chat.currentProfileAtom,
    chat.tasksAtom,
    chat.taskControlAtom,
    chat.sttEnabledAtom,
    chat.toolExecAtom,
    chat.hideThinkingAtom,
    sttPhaseAtom,
  ]);
  const stopActivitySync = chat.activityVersionAtom.effect(flushActivityViews);
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
    stopActivitySync();
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
  // Send consumes the draft: drop the pending save too, or a later unload
  // flush would resurrect text that already went out.
  cancelDraftSave();
  clearDraft();
  dismissCompletion();

  const files =
    attachments.length > 0
      ? attachments.map(({ name, mimeType, data }) => ({ name, mimeType, data }))
      : undefined;
  if (files) {
    attachmentsAtom([]);
    persistAttachments(); // sent: a reload must not resurrect consumed files
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

function newAttachmentId(): string {
  return `att-${++attachmentSeq}`;
}

/** Persist the staged set after every mutation (hydrate deliberately skips
 *  this: it restores what is already in storage). */
function persistAttachments(): void {
  saveAttachments(attachmentsAtom());
}

async function onFilesPicked(e: Event): Promise<void> {
  const input = e.currentTarget as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  input.value = ""; // Allow re-picking the same file after a removal.
  if (picked.length === 0) return;
  await stageFiles(picked);
}

/** Stage picked/pasted/dropped files as pending attachments. One shared path
 *  for all three composer gestures; size/vision limits stay server-side. */
async function stageFiles(picked: File[]): Promise<void> {
  const added: PendingAttachment[] = [];
  for (const file of picked) {
    if (file.size === 0) continue;
    try {
      added.push({
        id: newAttachmentId(),
        name: displayNameFor(file),
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        data: await readFileAsBase64(file),
      });
    } catch {
      console.warn("[upload] failed to read", file.name);
    }
  }
  if (added.length > 0) {
    attachmentsAtom([...attachmentsAtom(), ...added]);
    persistAttachments();
  }
}

/** Pasted screenshots arrive as anonymous blobs ("blob"/empty name); give
 *  them a timestamped name so the chip and the server-side label mean something. */
function displayNameFor(file: File): string {
  if (file.name && file.name !== "blob") return file.name;
  const ext = file.type.split("/")[1]?.split("+")[0] || "bin";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `pasted-${stamp}.${ext}`;
}

function removeAttachment(id: string): void {
  attachmentsAtom(attachmentsAtom().filter((a) => a.id !== id));
  persistAttachments();
}

// ── Paste & drag-drop into the composer ─────────────────────────────────────
// Both feed the same stageFiles pipeline as the Attach button. Plain-text
// pastes are never intercepted; a mixed text+file paste keeps both.

function hasFiles(dt: DataTransfer | null): boolean {
  return Array.from(dt?.types ?? []).includes("Files");
}

function onComposerPaste(e: ClipboardEvent): void {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length === 0) return; // plain text: let the browser paste it
  e.preventDefault();
  const el = e.currentTarget as HTMLTextAreaElement;
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (text) {
    // Same splice pattern as applyCompletion: insert at the caret.
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.setSelectionRange(start + text.length, start + text.length);
    autoResize(el);
    scheduleDraftSave(() => el.value);
  }
  void stageFiles(files);
}

// dragenter/dragleave fire for every node crossed while hovering the composer,
// so track depth and only clear the highlight once the pointer truly leaves.
let dragDepth = 0;

function setDragHighlight(el: EventTarget | null, on: boolean): void {
  (el as HTMLElement | null)?.classList.toggle("drag-over", on);
}

function onComposerDragenter(e: DragEvent): void {
  if (!hasFiles(e.dataTransfer) || activeLogIdAtom()) return;
  e.preventDefault(); // without this the drop never fires on the composer
  dragDepth++;
  setDragHighlight(e.currentTarget, true);
}

function onComposerDragover(e: DragEvent): void {
  if (hasFiles(e.dataTransfer) && !activeLogIdAtom()) e.preventDefault();
}

function onComposerDragleave(e: DragEvent): void {
  if (!hasFiles(e.dataTransfer)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDragHighlight(e.currentTarget, false);
}

function onComposerDrop(e: DragEvent): void {
  dragDepth = 0;
  setDragHighlight(e.currentTarget, false);
  if (activeLogIdAtom()) return; // read-only log view: ignore file drops
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  e.preventDefault();
  e.stopPropagation(); // the window guard would otherwise re-handle it
  void stageFiles(files);
  chatInputEl?.focus();
}

// Escape mid-drag fires dragcancel with no dragleave: reset the depth so a
// later drag-enter starts clean.
function onComposerDragcancel(e: DragEvent): void {
  dragDepth = 0;
  setDragHighlight(e.currentTarget, false);
}

/** Dropping a file anywhere else on the page would navigate away to the blob
 *  and lose the composer draft; swallow it instead. The composer's own drop
 *  handler runs first (deeper target), so accepted drops are unaffected. */
function swallowFileDrop(e: DragEvent): void {
  if (hasFiles(e.dataTransfer)) e.preventDefault();
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
  const profileName = (e.currentTarget as HTMLSelectElement).value;
  if (!chat) return;
  // Switching preserves the conversation (see SessionRegistry.switchProfile).
  chat.switchProfile(profileName);
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

/**
 * Header strip fence toggle: proposes flipping the ATTACHED session's runtime
 * exec-fence policy. Worker-plane postures only ("fence:" in the display);
 * inline/degraded and log view stay inert. probe -> off confirms loudly
 * (cancelTask idiom: the confirm says exactly what opens up), off -> probe
 * applies without one. The strip repaints ONLY from the server's posture
 * push -- never optimistically -- so a refusal can never leave it lying.
 */
function onFenceToggle(): void {
  if (activeLogIdAtom()) return; // log view: no live session to act on
  const sid = chat?.sessionIdAtom() ?? null;
  const posture = chat?.toolExecAtom() ?? "";
  if (!sid || !posture.includes("fence:")) return;
  if (posture.includes("fence: off)")) {
    chat?.setExecFencePolicy("probe");
    return;
  }
  if (
    !confirm(`Turn the exec fence OFF? Tools will run UNFENCED starting from the next tool call (this session only). This scalates permissions and access for the agent, which may be used to work around issues (eg allowing for updating system packages and issuing restart commands). Recommended to leave the fence ON unless the task cannot be completed with the fence in place.`)
  ) {
    return;
  }
  chat?.setExecFencePolicy("off");
}

// Header fingerprint badge: copy the FULL session id (the message-footer
// .footer-copy idiom, message-list.ts makeCopyButton -- copyText's seam and
// a transient confirmed flash on the same 1.2s budget; the check rides a
// real copy, failures stay silent).
const copyFlashAtom = reactiveState<boolean>(false);
let copyFlashTimer: ReturnType<typeof setTimeout> | null = null;

function onCopySessionId(sessionId: string): void {
  void copyText(sessionId).then((ok) => {
    if (!ok) return; // no fake confirmation: the check rides a real copy
    if (copyFlashTimer) clearTimeout(copyFlashTimer);
    copyFlashAtom(true);
    copyFlashTimer = setTimeout(() => {
      copyFlashAtom(false);
      copyFlashTimer = null;
    }, 1200);
  });
}

// ── View ────────────────────────────────────────────────────────────────────

function App() {
  const screen = screenAtom();
  const connected = chat?.connectedAtom() ?? false;
  const working = chat?.workingAtom() ?? false;
  const activeLogId = activeLogIdAtom();
  const sessionId = chat?.sessionIdAtom() ?? null;
  // Tool-exec plane posture: "worker (fence: bwrap | seatbelt | off | none -- probe failed)" / "inline (unfenced)",
  // plus anything carrying [degraded: ...].
  const toolExec = chat?.toolExecAtom() ?? "";
  // Reasoning visibility (localStorage; survives reload, applies to live transcripts and browsed cold logs alike).
  const hideThinking = chat?.hideThinkingAtom() ?? false;
  // The strip becomes a control exactly when the ATTACHED live session shows a worker-plane fence;
  // inline/degraded postures and log view stay inert.
  const fenceClickable =
    toolExec.includes("fence:") &&
    !toolExec.includes("degraded") &&
    !activeLogId &&
    sessionId !== null;
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
          pinnedIds={pinnedIdsAtom()}
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
          search={searchAtom()}
          searchInputRef={searchInputRef}
          onOpenSearch={openSearch}
          onCloseSearch={closeSearch}
          onSearchQuery={onSearchQuery}
          onSearchKeydown={onSearchKeydown}
          onActivateHit={onActivateHit}
          sidebarWidth={sidebarWidth}
          sidebarMax={sidebarMaxWidth()}
          onResizeStart={onSidebarResizeStart}
          onResizeMove={onSidebarResizeMove}
          onResizeEnd={onSidebarResizeEnd}
          onResizeKey={onSidebarResizeKey}
          onResizeReset={onSidebarResizeReset}
        />

        <main id="chat-area">
          <div id="session-info">
            <span id="session-label" style={activeLogId ? { opacity: "0.5" } : undefined}>
              Session:{" "}
              <button
                type="button"
                id="current-session-id"
                className={copyFlashAtom() ? "copied" : undefined}
                title={sessionId ? "Copy full session id" : undefined}
                aria-label={sessionId ? "Copy full session id" : undefined}
                onClick={
                  sessionId
                    ? (e: MouseEvent) => {
                        // The badge had no click action before the copy; stop
                        // so it never bubbles into an ancestor handler.
                        e.stopPropagation();
                        onCopySessionId(sessionId);
                      }
                    : undefined
                }
              >
                {/* Fingerprint ONLY: the badge is the full-id copy button,
                    never a title slot (titles live on the sidebar row; a
                    derived one is far too long for the header). */}
                {sessionId ? sessionId.slice(0, 8) : ""}
              </button>
            </span>
            {activeLogId ? (
              <span id="log-view-label">
                Viewing log: <span id="current-log-id">{activeLogId.slice(0, 8)}</span>{" "}
                <button id="close-log-view-btn" title="Close log view" onClick={onCloseLogView}>
                  ✕
                </button>
              </span>
            ) : null}
            <span className="header-status-group">
              {/* Reasoning visibility chip: a per-browser view toggle (chat
                  toggleHideThinking -> localStorage + a sweep of every thinking
                  block). Always clickable -- including in log view, where it is
                  the only way to hide a cold log's reasoning. */}
              <button
                type="button"
                id="thinking-toggle"
                className="header-btn toggleable"
                title={
                  "Show or hide reasoning in this browser (view setting only: it does not change the CLI's /thinking session state, and it applies to the log being browsed too)"
                }
                onClick={() => chat?.toggleHideThinking()}
              >
                reasoning {hideThinking ? "hidden" : "shown"}
              </button>
              {toolExec ? (
                <button
                  id="tool-exec-status"
                  className={[
                    "header-btn",
                    toolExec.includes("degraded") ? "tool-exec-degraded" : "",
                    fenceClickable ? "toggleable" : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined}
                  disabled={fenceClickable}
                  title={
                    fenceClickable
                      ? `${toolExec} -- click to toggle this session's fence`
                      : activeLogId
                        ? `Tool execution plane (config keys: toolExec, execFence). The fence toggle acts on live sessions only, not on a viewed log.`
                        : "Tool execution plane (config keys: toolExec, execFence)"
                  }
                  onClick={fenceClickable ? onFenceToggle : undefined}
                >
                  tools: {toolExec}
                </button>
              ) : null}
              <span id="connection-status" className={connected ? "status-connected" : "status-disconnected"}>
                {connected ? "Connected" : "Disconnected"}
              </span>
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
            expanded={stripExpandedAtom()}
            onToggleExpanded={() => stripExpandedAtom(!stripExpandedAtom())}
          />

          <div id="input-area" className={activeLogId ? "read-only" : undefined}>
            <form
              id="chat-form"
              onSubmit={onChatSubmit}
              onDragenter={onComposerDragenter}
              onDragover={onComposerDragover}
              onDragleave={onComposerDragleave}
              onDragcancel={onComposerDragcancel}
              onDrop={onComposerDrop}
            >
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
                  if (chatInputEl && chatInputEl.value === "") {
                    // An emptied box must not come back as empty-string noise.
                    cancelDraftSave();
                    clearDraft();
                  } else {
                    scheduleDraftSave(() => chatInputEl?.value ?? "");
                  }
                }}
                onBlur={dismissCompletion}
                onPaste={onComposerPaste}
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
                {working ? (
                  // type=button: it lives inside #chat-form; without it the
                  // click would submit the composer before cancelling. The
                  // in-button spinner is the chat column's only busy tell.
                  <button type="button" id="cancel-btn" onClick={() => chat?.cancel()}>
                    <span className="spinner"></span>
                    Stop
                  </button>
                ) : null}
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
              now={nowAtom()}
              zBase={100 + i}
              control={chat.taskControlAtom()[id] ?? null}
              bodyRef={activityRegistry.ref(id)}
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
  restoreSidebarWidth();
  mounted = mount(<App />, root as unknown as DomNode);
  effect(render, [
    screenAtom,
    ...loginAtoms,
    sessionsAtom,
    logsAtom,
    activeLogIdAtom,
    pinnedIdsAtom,
    contextMenuAtom,
    searchAtom,
    completionAtom,
    attachmentsAtom,
    openTasksAtom,
    stripExpandedAtom,
    nowAtom,
    copyFlashAtom,
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
