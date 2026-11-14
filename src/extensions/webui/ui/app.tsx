/// <reference lib="dom" />
// Wires login, chat, and sessions together. The JSX tree owns all layout;
// atoms hold view state and a single render() re-renders on change. The
// message list container is handed to the imperative renderer via ref.

import { mount, type JsxChild, type Mounted, type Ref, type DomNode } from "@utils/jsx";
import {
  IconBan,
  IconCheck,
  IconCopy,
  IconGear,
  IconPalette,
  IconShield,
  IconShieldCheck,
  IconThinking,
  IconWorkbench,
} from "./icons.tsx";
import { reactiveState, effect, shortId, copyText, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, LOGS_DEFAULT_HEIGHT, LOGS_MIN_HEIGHT, LOGS_MAX_HEIGHT, LOGS_VIEWPORT_RESERVE, WORKBENCH_MIN_WIDTH, WORKBENCH_MAX_WIDTH, WORKBENCH_DEFAULT_WIDTH } from "./utils.ts";
import { createPanelResize, decodeCollapsed, encodeCollapsed } from "./panel-resize.ts";
import { createChat, type ChatController, type CompletionItem } from "./chat.ts";
import {
  LoginScreen,
  focusLoginInput,
  getStoredToken,
  clearStoredToken,
  loginAtoms,
} from "./login.tsx";
import { loadDraft, clearDraft, scheduleDraftSave, flushDraftSave, cancelDraftSave } from "./draft.ts";
import {
  applyStoredTheme,
  applyThemeId,
  labelForTheme,
  nextThemeId,
  saveThemeId,
} from "./theme-pref.ts";
import { loadAttachments, saveAttachments, type PendingAttachment } from "./attachment-store.ts";
import { Sidebar, ContextMenu, clampMenuAnchor, scrollHitIntoView, type ContextMenuItem, type ContextMenuState, type SessionInfo, type LogInfo, type SearchState } from "./sessions.tsx";
import type { SearchHitWire, ConfigSnapshotResultWire, SetConfigKeyResultWire, ListDirResultWire, ReadFileResultWire } from "./chat.ts";
import type { ConfigKeyEditWire, EditConfigListResultWire, TaskInfoWire } from "@extensions/websocket/protocol.ts";
import { chipLabel, openTargetFor } from "./subagents.tsx";
import {
  persistWorkbenchTabs,
  seedWorkbenchStoreFromStorage,
  WorkbenchPanel,
  workbenchStore,
} from "./workbench.tsx";
import {
  emptyFileTree,
  openFileTree,
  revealDir,
  toggleDir,
  applyListDir,
  filesTab,
  type FileTreeState,
  type TreeFetch,
} from "./file-tree.tsx";
import {
  emptyFileViews,
  openFileView,
  reloadFileView,
  moreFileView,
  applyReadFile,
  type FileViewsState,
  type FileFetch,
} from "./file-view.tsx";
import {
  SettingsViewer,
  initialSettingsPanelState,
  openSettingsPanel,
  refreshSettingsPanel,
  closeSettingsPanel,
  applySnapshotReply,
  startSettingsEdit,
  cancelSettingsEdit,
  parseEditValue,
  rejectSettingsSave,
  requestSettingsSave,
  flushSettingsSave,
  pendingDisplay,
  applySetConfigReply,
  setSettingsQuery,
  setSettingsCategory,
  startListAdd,
  cancelListAdd,
  armProviderRemove,
  cancelProviderRemove,
  requestListOp,
  applyListOpReply,
  flushListOp,
  parseListAddValue,
  rejectListAdd,
  clearProviderFocus,
  type SettingsPanelState,
  type ListOpSend,
} from "./settings-view.tsx";
import { audioBlobToWav } from "./wav.ts";

type Screen = "login" | "main";

const screenAtom = reactiveState<Screen>("login");
const sessionsAtom = reactiveState<SessionInfo[]>([]);
const logsAtom = reactiveState<LogInfo[]>([]);
const activeLogIdAtom = reactiveState<string | null>(null);
const contextMenuAtom = reactiveState<ContextMenuState | null>(null);

// Screen-reader announcements for the streaming reply the transcript renders
// imperatively (audit 1.1). Kept deliberately coarse: the attached session's
// run boundaries only -- "Working" on a start, and on the end edge a string
// picked from the TERMINAL SIGNAL: "Work stopped" (local Stop pressed),
// "Run failed" (the server's error frame), "Connection lost" (dead socket),
// or "Reply complete" (a genuinely finished turn). An errored or stopped turn
// claims no completion -- the same rule message-list.ts:1130-1133 applies to
// the turn footer. Never a streamed token, never reply text (the transcript
// already exposes that; duplicating it would fight the reader). A
// role="status" aria-live region (#live-status) renders this; every on-edge
// announces "Working", so consecutive end-strings are always separated by a
// different value and always re-announced.
const liveAnnounceAtom = reactiveState<string>("");

// One-shot terminal markers so the off-edge knows WHY the run ended (the
// workingAtom(false) flip itself does not say). Armed only while a run is
// actually in flight -- an idle command error or a Stop with nothing running
// has no off-edge to consume the marker, and a stale one would mislabel the
// next real completion. Both are consumed by the single off-edge they arm.
let liveStopped = false;
let liveFailed = false;

// Sidebar full-text search (see sessions.tsx SearchPanel + the searchLogs WS
// round-trip). One atom; every handler replaces the object wholesale. `open`
// swaps the two sidebar lists for the panel. The input is uncontrolled: its
// DOM node is stable across renders (unlike the tree), so keystrokes never
// rebuild it; query mirrors into the atom for the highlight/results only.
const searchAtom = reactiveState<SearchState>({ open: false, query: "", pending: false, results: null });

// Settings viewer (settings button in the chat header): the panel state + request-id
// doctrine live in settings-view.tsx (pure functions); every open/refresh
// re-fetches with a fresh requestId and stale replies drop by id.
const settingsAtom = reactiveState<SettingsPanelState>(initialSettingsPanelState);

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

/**
 * The panel unmounts its input (and the hit rows), so every UI close must
 * hand focus somewhere on purpose -- <body> is not an option (audit keyboard
 * pass: Escape dropped focus). The header chip is the dialog's opener, so it
 * is the default receiver. getElementById: the chip lives inside the Sidebar
 * tree, out of this module's ref reach.
 */
function refocusSearchChip(): void {
  document.getElementById("search-btn")?.focus();
}

/** A user closing the dialog (the ✕ button or the chip toggle) lands focus
 *  back on the chip. Escape has its own path (onSearchKeydown); activation
 *  hands focus to the revealed row instead (onActivateHit). The auth-failure
 *  teardown deliberately stays on bare closeSearch. */
function closeSearchFromUi(): void {
  closeSearch();
  refocusSearchChip();
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
    // Escape leaves the dialog the way it entered: back on the chip.
    refocusSearchChip();
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
  if (hit.live) {
    chat?.switchSession(hit.logId);
  } else {
    // A cold hit's row lives in the log list: a collapsed section has no
    // scroll box to reveal it in, so expand first (the height the user left
    // is already stored; expand just shows it).
    if (logsPanel.collapsed()) logsPanel.toggle();
    chat?.viewLog(hit.logId);
  }
  closeSearch();
  // Then bring the selected row into view AND hand it focus: closing search
  // re-mounts the lists, and the hit row that was just clicked unmounted with
  // the panel -- dropping focus to <body> would force a Tab walk from the
  // page top. closeSearch's atom render is already queued ahead of this
  // microtask (the openSearch focus idiom), so the rows exist by the time we
  // look. Missing row (session ended mid-click) is quiet for the scroll and
  // falls back to the search chip for focus.
  queueMicrotask(() => {
    const row = scrollHitIntoView(document, hit.live, hit.logId);
    if (row) row.focus();
    else refocusSearchChip();
  });
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

// ── Settings viewer ─────────────────────────────────────────────────────────

// Imperative handle on the dialog root (focus-in on open, like openSearch's
// input focus). Stable ref identity so patch() never re-attaches it.
let settingsRootEl: HTMLElement | null = null;
const settingsRootRef = domRef<HTMLElement>((el) => {
  settingsRootEl = el;
});

/** Settings button pressed: open the panel and ALWAYS re-fetch a fresh
 *  snapshot (live-at-open: every open issues one configSnapshot request with a
 *  fresh requestId, no cached snapshot is ever shown). Focus moves into the
 *  dialog so Escape is caught by its keydown. */
function openSettings(): void {
  const next = openSettingsPanel(settingsAtom());
  settingsAtom(next);
  chat?.requestConfigSnapshot(next.reqId);
  queueMicrotask(() => settingsRootEl?.focus());
}

/** Escape/✕ leave the dialog the way they entered: focus back on the button
 *  (getElementById: it lives in the header tree, same contract as
 *  refocusSearchChip). The close also invalidates any in-flight reply. */
function closeSettings(): void {
  settingsAtom(closeSettingsPanel(settingsAtom()));
  document.getElementById("settings-btn")?.focus();
}

/** Refresh button: re-issue with a fresh requestId; the stale in-flight
 *  reply (if any) drops by id in onConfigSnapshot. */
function refreshSettings(): void {
  const next = refreshSettingsPanel(settingsAtom());
  settingsAtom(next);
  chat?.requestConfigSnapshot(next.reqId);
}

function onConfigSnapshot(requestId: number | undefined, snapshot: ConfigSnapshotResultWire): void {
  settingsAtom(applySnapshotReply(settingsAtom(), requestId, snapshot));
  // A fresh append asked to bring the new card into view: once the refreshed
  // snapshot is on screen, focus that card (data-name match) and consume the
  // request. Only fires on the CURRENT snapshot id (a stale reply applied
  // nothing, so focusProviderName was not freshly set by it either).
  const st = settingsAtom();
  if (st.focusProviderName !== null && requestId === st.reqId) {
    queueMicrotask(() => {
      // Iterate the data-name attribute instead of interpolating the name into
      // a CSS selector (audit finding 6): provider names are user data, and an
      // unescaped quote/bracket would throw HERE -- inside queueMicrotask, the
      // focus marker would never clear and every later snapshot would re-throw.
      const cards = (Array.from(settingsRootEl?.querySelectorAll(".settings-provider-card") ?? []) as unknown as (
        | (HTMLElement & { focus?: () => void })
        | null
      )[]);
      const card = cards.find((c) => c !== null && c.getAttribute("data-name") === st.focusProviderName);
      card?.focus?.();
      card?.scrollIntoView?.({ block: "nearest" });
      settingsAtom(clearProviderFocus(settingsAtom()));
    });
  }
}

// ── Settings editor (rows the server stamped `edit`; see settings-view.tsx) ─

/** Find a panel container by a data-key attribute value (GENERAL, WEBUI,
 *  providers[0], a row keyPath...). ATTRIBUTE ITERATION, never a built
 *  selector: these keys are user data carrying dots/brackets/quotes, and an
 *  unescaped `[data-key="..."]` would throw inside queueMicrotask (audit
 *  finding 6 -- same idiom as the provider-card focus walk above). */
function findSettingsNodeByDataKey(containerClass: string, dataKey: string): HTMLElement | null {
  const nodes = Array.from(settingsRootEl?.querySelectorAll("." + containerClass) ?? []) as HTMLElement[];
  return nodes.find((n) => n.getAttribute("data-key") === dataKey) ?? null;
}

/** Hand focus to an element the last render just revealed (unconditional:
 *  the interaction demands it -- openSettings/provider-add precedent). */
function focusRevealed(el: HTMLElement | null): void {
  if (!el) return;
  el.focus();
  el.scrollIntoView?.({ block: "nearest" });
}

/** Return focus to a control that replaced a just-destroyed one, but ONLY
 *  when focus is stranded (body, gone, or a node the re-render detached).
 *  A click-away that landed on a live control already moved focus there --
 *  this must not steal it back. */
function refocusStranded(el: HTMLElement | null): void {
  if (!el) return;
  const active = document.activeElement as Node | null;
  if (active && active !== document.body && settingsRootEl?.contains(active)) return;
  el.focus();
}

/** Edit pressed: open the JSON container's textarea and move focus into THAT
 *  row's field (openSettings' queueMicrotask focus idiom, one level down).
 *  The reveal destroys the focused button (rows re-key on the shown value),
 *  so without this the browser drops focus to <body> and Tab restarts from
 *  the top of the document. The textarea is found INSIDE the named row --
 *  a document-wide .settings-edit-input query would hit the first editable
 *  control anywhere in the pane, which is not necessarily this row's.
 *  Scalar rows have no edit mode -- their controls save immediately. */
function startSettingsEditRow(keyPath: string): void {
  settingsAtom(startSettingsEdit(settingsAtom(), keyPath));
  queueMicrotask(() => {
    const area = findSettingsNodeByDataKey("settings-row", keyPath)?.querySelector(".settings-edit-json") ?? null;
    focusRevealed(area as HTMLElement | null);
  });
}

/** Collapse the JSON reveal (Cancel button, Escape inside the textarea, or
 *  the root ladder): hand focus back to the row's Edit JSON button so the
 *  user keeps their place instead of dropping to body (the dialog's
 *  focus-return doctrine, one row deep). */
function cancelSettingsEditRow(): void {
  const keyPath = settingsAtom().editing;
  settingsAtom(cancelSettingsEdit(settingsAtom()));
  if (keyPath === null) return;
  queueMicrotask(() => {
    const btn = findSettingsNodeByDataKey("settings-row", keyPath)?.querySelector(".settings-json-open") ?? null;
    refocusStranded(btn as HTMLElement | null);
  });
}

function setSettingsQueryRow(query: string): void {
  settingsAtom(setSettingsQuery(settingsAtom(), query));
}

function setSettingsCategoryRow(category: string | null): void {
  settingsAtom(setSettingsCategory(settingsAtom(), category));
}

/** A control save: parse against the server-stamped type (a parse miss never
 *  goes to the wire; the row keeps its hint), then SEND or QUEUE. Writes
 *  serialize through one in-flight slot: a further change on a path whose
 *  save is pending updates the queued value (last-write-wins) instead of
 *  firing a parallel second save. The server revalidates every value against
 *  the schema regardless -- this parse is courtesy, not gate. */
function saveSettingsEditRow(keyPath: string, raw: string, edit: ConfigKeyEditWire): void {
  const parsed = parseEditValue(edit, raw);
  if (!parsed.ok) {
    settingsAtom(rejectSettingsSave(settingsAtom(), keyPath, parsed.error));
    return;
  }
  // The optimistic display NEVER carries a writeOnly replace or a json
  // container's bytes (pendingDisplay is "" there).
  const r = requestSettingsSave(settingsAtom(), keyPath, parsed.payload, pendingDisplay(edit, parsed.payload));
  settingsAtom(r.state);
  if (r.send) chat?.setConfigKey(r.send.reqId, keyPath, parsed.payload);
}

/** Write reply: stale ids drop in the pure state fn (the write sequence is
 *  the panel's own). ok: the row updates from the server's echo and the
 *  restart marker follows the reply's needsRestart FIELD; refusal: server
 *  text verbatim. Then the queue drains: the oldest waiting write goes out
 *  (fresh id, same sequence). */
function onSetConfigKey(requestId: number | undefined, result: SetConfigKeyResultWire): void {
  const settled = applySetConfigReply(settingsAtom(), requestId, result);
  const drained = flushSettingsSave(settled);
  settingsAtom(drained.state);
  if (drained.send) chat?.setConfigKey(drained.send.reqId, drained.send.key, drained.send.payload);
}

// ── List ops: array add / remove + provider cards (owner 2026-11-11) ────────
// The provider cards' Add / two-step Remove and every chrome'd list block's
// + / one-click x drive the additive editConfigList pair. A list op obeys the
// one-op-in-flight doctrine (requestListOp queues on a busy path). On success
// the snapshot is RE-READ (the file is the truth -- rows are never patched
// locally); on refusal the server text renders verbatim under the owning
// block's affordance.

const PROVIDERS_KEY = "providers";

/** Send a requested list op (append/remove) if the pure state decided to fire
 *  it (nothing in flight). Empty/whitespace input never reaches here as a
 *  send -- the local refusals (provider name, typed add parse) keep the wire
 *  silent. Each field rides the frame only when defined (chat.editConfigList). */
function sendListOp(send: ListOpSend | null): void {
  if (!send) return;
  chat?.editConfigList(send.reqId, send.keyPath, send.op, send.name, send.index, send.value);
}

/** Open a list block's inline add field. Providers keep their name-field
 *  idiom; every other list gets the typed field ON THE HEADER, focused via
 *  the attribute walk (a keyPath is user data full of dots/brackets -- no
 *  selector is ever built from it). */
function listAddStart(keyPath: string): void {
  settingsAtom(startListAdd(settingsAtom(), keyPath));
  queueMicrotask(() => {
    if (keyPath === PROVIDERS_KEY) {
      (settingsRootEl?.querySelector(".settings-provider-add-input") as HTMLElement | null)?.focus();
      return;
    }
    const field = findSettingsNodeByDataKey("settings-list-block", keyPath)?.querySelector(".settings-list-add-input");
    focusRevealed((field as HTMLElement | null) ?? null);
  });
}

/** Commit an open add field. Providers keep the NAME shape (their elements
 *  are objects); every other list ships the TYPED scalar parsed from the
 *  list's element stamp -- unparseable/off-kind/empty input is refused LOCALLY
 *  with honest text and zero wire traffic (the field stays open for a fix). */
function listAddCommit(keyPath: string, raw: string, edit?: ConfigKeyEditWire): void {
  if (keyPath === PROVIDERS_KEY) {
    const r = requestListOp(settingsAtom(), "append", PROVIDERS_KEY, { name: raw });
    settingsAtom(r.state);
    sendListOp(r.send);
    return;
  }
  const parsed = parseListAddValue(edit, raw);
  if (!parsed.ok) {
    settingsAtom(rejectListAdd(settingsAtom(), keyPath, parsed.error));
    return;
  }
  const r = requestListOp(settingsAtom(), "append", keyPath, { value: parsed.value });
  settingsAtom(r.state);
  sendListOp(r.send);
}

/** Cancel / Escape on an open add field (provider or generic): pure client
 *  state, zero wire traffic. Cancel destroys the focused field (the
 *  affordance re-renders as the + button), so hand focus back to the + the
 *  re-render just created -- the cancelSettingsEditRow doctrine; without it
 *  the browser drops focus to body and Tab restarts from the top.
 *  refocusStranded (not focusRevealed): a click-away that landed on a live
 *  control already moved focus; this never steals it back. */
function listAddCancel(): void {
  const keyPath = settingsAtom().addingList;
  settingsAtom(cancelListAdd(settingsAtom()));
  if (keyPath === null) return;
  queueMicrotask(() => {
    const btn =
      keyPath === PROVIDERS_KEY
        ? (settingsRootEl?.querySelector(".settings-provider-add-btn") ?? null)
        : (findSettingsNodeByDataKey("settings-list-block", keyPath)?.querySelector(".settings-list-add-btn") ?? null);
    refocusStranded(btn as HTMLElement | null);
  });
}

/** One-click x on a list ELEMENT row: the remove frame for THAT index rides
 *  immediately (the index lives IN the keyPath; duplicates address by
 *  occurrence). Whole-provider deletion is NOT this path -- the card keeps
 *  its two-step confirm below. */
function listElementRemove(elementKey: string): void {
  const r = requestListOp(settingsAtom(), "remove", elementKey);
  settingsAtom(r.state);
  sendListOp(r.send);
}

/** Arm the two-step Remove on a provider card (whole-block delete keeps its
 *  confirm -- single-click x is for list elements only). The arm REPLACES the
 *  focused Remove button with the confirm pair (positional diff, different
 *  tags), so focus would drop to body exactly like the JSON reveal did --
 *  hand it to the Confirm control the render just created. */
function providerRemoveArm(cardKey: string, _index: number, _name: string): void {
  settingsAtom(armProviderRemove(settingsAtom(), cardKey));
  queueMicrotask(() => {
    const yes = findSettingsNodeByDataKey("settings-provider-card", cardKey)?.querySelector(
      ".settings-provider-remove-yes",
    );
    focusRevealed((yes as HTMLElement | null) ?? null);
  });
}

function providerRemoveConfirm(index: number, _name: string): void {
  const r = requestListOp(settingsAtom(), "remove", `providers[${index}]`, { index });
  settingsAtom(r.state);
  sendListOp(r.send);
}

/** Disarm (Cancel button / Escape / click-away): the confirm pair is
 *  replaced by the Remove button -- return focus to it (the armed flow
 *  started there; the stranded guard keeps a click-away that landed on a
 *  live control from being stolen back). Zero wire traffic either way. */
function providerRemoveCancel(): void {
  const cardKey = settingsAtom().confirmRemoveKey;
  settingsAtom(cancelProviderRemove(settingsAtom()));
  if (cardKey === null) return;
  queueMicrotask(() => {
    const btn = findSettingsNodeByDataKey("settings-provider-card", cardKey)?.querySelector(
      ".settings-provider-remove",
    );
    refocusStranded((btn as HTMLElement | null) ?? null);
  });
}

/** editConfigList reply: stale ids drop in the pure state fn. ok folds
 *  needsRestart + (for an append) marks the new provider for focus; refusal
 *  renders verbatim. Then any queued list op drains, and a SUCCESS re-reads the
 *  snapshot so the list blocks (and the card list) reflect the file. */
function onEditConfigList(requestId: number | undefined, result: EditConfigListResultWire): void {
  const settled = applyListOpReply(settingsAtom(), requestId, result);
  const drained = flushListOp(settled);
  settingsAtom(drained.state);
  if (drained.send) sendListOp(drained.send);
  if (result.ok) {
    // Re-read: the file changed; bring the rows current (never patch locally).
    const next = refreshSettingsPanel(settingsAtom());
    settingsAtom(next);
    chat?.requestConfigSnapshot(next.reqId);
  }
}

// Subagent sidebar rows: nowAtom ticks once per second while a task is live
// so the rows' elapsed clocks refresh (running rows advance, parked and
// finished rows freeze on their own -- see formatElapsed). The section's
// collapse is a plain view setting: the same "1"/"0" codec the panel seam
// uses, persisted across reloads and logins, no resize machinery (the
// section is content-sized).
const nowAtom = reactiveState<number>(Date.now());
let taskTickTimer: ReturnType<typeof setInterval> | null = null;

const SUBAGENTS_COLLAPSED_KEY = "hotdog.subagentsCollapsed";
const subagentsCollapsedAtom = reactiveState<boolean>(false);

function restoreSubagentsCollapsed(): void {
  try {
    subagentsCollapsedAtom(decodeCollapsed(window.localStorage.getItem(SUBAGENTS_COLLAPSED_KEY)));
  } catch {}
}

function onToggleSubagents(): void {
  const next = !subagentsCollapsedAtom();
  subagentsCollapsedAtom(next);
  try {
    window.localStorage.setItem(SUBAGENTS_COLLAPSED_KEY, encodeCollapsed(next));
  } catch {}
}

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

/** The main pane shows something other than the live manager transcript
 *  (a browsed cold log OR an open subagent transcript): file drops and the
 *  fence toggle stay inert in both -- they act on the ATTACHED session, not
 *  on the pane's subject. The composer differs by mode (see App's
 *  composerLocked): a cold log locks it, a subagent view steers the task. */
function inBrowseView(): boolean {
  return activeLogIdAtom() !== null || (chat?.viewedTaskIdAtom() ?? null) !== null;
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
      // create() fires refs while the node is still detached, and a detached
      // textarea measures scrollHeight 0 (verified in headless Chromium), so
      // the call above pins height:"0px" -- CSS min-height then clamps it to
      // a collapsed one-liner and only the first keypress would re-measure.
      // Re-run the SAME routine one microtask later: the synchronous mount/
      // patch has inserted the subtree by then, so scrollHeight is real. The
      // identity guard skips a composer unmounted before the microtask ran.
      queueMicrotask(() => {
        if (chatInputEl === el) autoResize(el);
      });
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
  // Same for the settings dialog: its snapshot belongs to the dead socket.
  settingsAtom(closeSettingsPanel(settingsAtom()));
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

/** Leave the subagent transcript: the pane goes back to the manager exactly
 *  like closing a log view (re-switch replays the live transcript, and the
 *  sessionCreated attach lifts chat's transcript suppression). */
function onCloseSubagentView(): void {
  chat?.closeSubagentView();
  const currentSessionId = chat?.sessionIdAtom();
  if (currentSessionId && chat) {
    chat.switchSession(currentSessionId);
  }
}

// ── Context menus ───────────────────────────────────────────────────────────

// The row that opened the current menu: dismissContextMenu's focus-return
// target (the menu itself is keyboard-operated via roles + arrow traversal).
let contextMenuTriggerEl: HTMLElement | null = null;

function dismissContextMenu(): void {
  const trigger = contextMenuTriggerEl;
  contextMenuTriggerEl = null;
  // Focus-return (audit 1.2): the menu holds focus from the moment it opens
  // (armContextMenu), so if it is still inside the menu at teardown --
  // Escape, Enter/Space activation, or a mouse click elsewhere -- focus goes
  // back to the row that opened it (when that row still exists) instead of
  // dropping to <body>. A mousedown-outside onto a focusable control is
  // unaffected: the browser's own focus handling runs after this listener.
  if (
    trigger &&
    trigger.parentNode &&
    contextMenuEl &&
    contextMenuEl.contains(document.activeElement as unknown as Node)
  ) {
    trigger.focus();
  }
  contextMenuAtom(null);
}

/**
 * Anchor for a freshly built menu. A pointing event (the pointer
 * contextmenu, or a click on the row's visible menu button) carries client
 * coordinates; the keyboard paths (the row's Menu-key/Shift-F10 handler, and
 * the keyboard-fired contextmenu event) carry none -- anchor at the row's
 * rect, falling back to the origin when there is no layout to measure.
 */
function rowMenuPoint(e: MouseEvent | KeyboardEvent, rowEl: HTMLElement): { x: number; y: number } {
  const pointing = e.type === "contextmenu" || e.type === "click";
  const mx = pointing ? (e as MouseEvent).clientX ?? 0 : 0;
  const my = pointing ? (e as MouseEvent).clientY ?? 0 : 0;
  if (mx || my) return { x: mx, y: my };
  const r = rowEl?.getBoundingClientRect?.();
  return r ? { x: r.left + 12, y: r.bottom + 2 } : { x: 0, y: 0 };
}

/**
 * Arm a menu that was just put on the atom: remember the opening row for
 * dismissContextMenu's focus-return, and move focus to the first item once
 * the menu has rendered (openSearch's queueMicrotask idiom: the atom's
 * render microtask was queued by its setter before this one runs). Every
 * open takes focus so a keyboard-opened menu is immediately operable -- its
 * items sit at tabindex="-1", out of Tab's way by design.
 */
function armContextMenu(rowEl: HTMLElement): void {
  contextMenuTriggerEl = rowEl;
  queueMicrotask(() => {
    const el = contextMenuEl;
    const menu = contextMenuAtom();
    if (el && menu) {
      // Keep the whole box on screen (owner: menus opened near the bottom
      // rendered offscreen). position:fixed, so the rect shares the viewport
      // origin. Clamp and correct the ANCHOR ON THE ATOM, not just the
      // style: ContextMenu re-applies style from state on every coalesced
      // render, so a style-only nudge gets undone by the next payload
      // refresh -- the box jumps back offscreen (owner, 2026-11-09). The
      // style write stays for a flash-free first frame; the atom write is
      // what makes it durable.
      const r = el.getBoundingClientRect();
      const c = clampMenuAnchor(
        r.left,
        r.top,
        r.width,
        r.height,
        window.innerWidth,
        window.innerHeight,
      );
      if (c.left !== menu.x || c.top !== menu.y) {
        el.style.left = `${c.left}px`;
        el.style.top = `${c.top}px`;
        contextMenuAtom({ ...menu, x: c.left, y: c.top });
      }
    }
    contextMenuEl?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  });
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

function onSessionMenu(e: MouseEvent | KeyboardEvent, s: SessionInfo, rowEl: HTMLElement): void {
  const displayName = s.title || s.profile || "default";
  const isWorking = chat?.sessionWorkingMap.get(s.id) ?? false;
  const { x, y } = rowMenuPoint(e, rowEl);
  contextMenuAtom({
    x,
    y,
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
  armContextMenu(rowEl);
}

function onLogMenu(e: MouseEvent | KeyboardEvent, logId: string, rowEl: HTMLElement): void {
  const logPath = logsAtom().find((l) => l.id === logId)?.logPath;
  const { x, y } = rowMenuPoint(e, rowEl);
  contextMenuAtom({
    x,
    y,
    items: [
      pinMenuItem(logId),
      {
        label: "Resume",
        // Sole resume entry since the log-row inline button went away
        // (owner 2026-11-09: the menu item is enough). Same handler the
        // button carried: loads the log as a live session, keeps its id,
        // no confirm.
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
  armContextMenu(rowEl);
}

/** Row-press routing shared by the sidebar row and the context menu's Open
 *  (openTargetFor decides the landing): live/settled-live tasks open the task
 *  transcript; a DURABLE restart-survivor row opens the worker's OWN durable
 *  log through the existing cold log-view machinery (viewLog -> LOG_VIEWED);
 *  a pre-join record has nothing honest to open (the caller hides the item). */
function openTaskRow(t: TaskInfoWire): void {
  const target = openTargetFor(t);
  if (target === null) return;
  if ("logId" in target) {
    // Chat drops the task browse pointer when the log lands (logViewed
    // case); the app-side activeLogId rides onLogViewed, like any other
    // cold-row click.
    chat?.viewLog(target.logId);
    return;
  }
  // Browse modes are exclusive (chat-side); clear the app-side log mirror
  // in the SAME click so the header never carries both labels (and the log
  // row drops its highlight). The chat already dropped its viewedLogId;
  // this keeps the mirrors honest.
  if (activeLogIdAtom() !== null) clearLogView();
  chat?.viewSubagent(t.taskId);
}

/**
 * Subagent row menu (owner 2026-11-13): the SAME context-menu machinery as
 * the session/log rows (rowMenuPoint anchor, armContextMenu focus-return and
 * WAI navigation), with an action set honest for a task row -- zero dead
 * items. "Open" is exactly the row-click action; Cancel rides only while the
 * task is live (taskInterrupt refuses non-active tasks, so a settled row
 * never shows it). The manager card's own menu above it stays untouched.
 *
 * Log actions ride the SESSION idioms exactly (doctrine: a subagent's
 * transcript IS a session log):
 *  - "Copy log file path" appears iff agentLogPath rode, and "Export" iff
 *    agentSessionId rode -- the rowMenuTail "hidden when the server omitted
 *    it" precedent, item by item (taskWire emits both from the same worker
 *    id, so a queued/plan-failed task -- no agent, no log -- hides both;
 *    absent, never disabled-but-dead). Export is the EXACT existing
 *    /export/:id route keyed by that id -- token validation and sessions-dir
 *    containment are that route's own, unchanged (no new endpoint).
 *  - "Reveal run directory" appears iff runDir rode the feed (workflow
 *    spawns only; delegate tasks have no run dir, so the item is absent --
 *    absence IS the truthful treatment for an inapplicable action).
 * Matrix: queued (agent never built) hides both log items; running and every
 * settled state keep them (the log persists past settle -- Export must stay
 * reachable to triage a failure); reveal is state-agnostic, run-dir-or-absent
 * only.
 */
function onSubagentMenu(
  e: MouseEvent | KeyboardEvent,
  t: TaskInfoWire,
  rowEl: HTMLElement,
): void {
  const { x, y } = rowMenuPoint(e, rowEl);
  const live = t.status === "running" || t.status === "queued";
  // Narrow the optional fields once into consts: the spreads below build
  // closures, and a closure over `t.x` loses the truthiness narrowing.
  const workerSid = t.agentSessionId;
  const logPath = t.agentLogPath;
  const runDir = t.runDir;
  // Open routes by row kind (openTargetFor): a pre-join durable record has
  // nothing to open, so the item is HIDDEN -- the rowMenuTail
  // honest-by-construction rule.
  const openTarget = openTargetFor(t);
  contextMenuAtom({
    x,
    y,
    items: [
      ...(openTarget
        ? [
            {
              label: "Open",
              onSelect: () => {
                openTaskRow(t);
                dismissContextMenu();
              },
            },
          ]
        : []),
      {
        label: "Copy task id",
        onSelect: () => {
          copyRowValue(t.taskId, "Task id");
          dismissContextMenu();
        },
      },
      // Copy-path rides agentLogPath and Export rides agentSessionId -- the
      // rowMenuTail precedent exactly: each item is HIDDEN when the server
      // omitted its field (taskWire sends both from the same id, so in
      // practice they appear together). The copy idiom's own toast refuses
      // a clipboard-less page; nothing here is ever click-and-dead.
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
      ...(workerSid
        ? [
            {
              label: "Export",
              onSelect: () => {
                exportSessionLog(workerSid);
                dismissContextMenu();
              },
            },
          ]
        : []),
      ...(runDir
        ? [
            {
              label: "Reveal run directory",
              onSelect: () => {
                revealTaskRunDir(runDir);
                dismissContextMenu();
              },
            },
          ]
        : []),
      ...(live
        ? [
            {
              label: "Cancel",
              // Confirm like the retired panel's Cancel (it tears down a
              // running agent); the stop itself is the server-validated
              // taskInterrupt, and a refusal lands as a taskControl notice.
              onSelect: () => {
                if (
                  confirm(
                    `Cancel subagent ${shortId(t.taskId)}? The task agent stops and the task is marked cancelled.`,
                  )
                ) {
                  chat?.interruptTask(t.taskId);
                }
                dismissContextMenu();
              },
            },
          ]
        : []),
    ],
  });
  armContextMenu(rowEl);
}

// Close the menu on any mousedown outside it. No deferral needed: the
// mousedown that opens a menu lands before contextMenuAtom is set, and a
// right-click on another item closes the old menu and reopens via contextmenu.
document.addEventListener("mousedown", (e: MouseEvent) => {
  if (!contextMenuAtom()) return;
  if (contextMenuEl && contextMenuEl.contains(e.target as Node)) return;
  dismissContextMenu();
});

// ── Panel sizing (sidebar width + Recent Logs height) ──────────────────────
// Both panels ride one seam (panel-resize.ts): a pointerId-guarded drag that
// paints imperatively (CSS var + aria-valuenow, so a pointermove never
// re-renders the tree), viewport-aware clamps, keyboard steps, double-click
// reset, and localStorage that degrades to session-only when storage is
// blocked. The numbers live in utils.ts; the gestures live in the seam.

const SIDEBAR_WIDTH_KEY = "hotdog.sidebarWidth";
const LOGS_HEIGHT_KEY = "hotdog.logsHeight";
const LOGS_COLLAPSED_KEY = "hotdog.logsCollapsed";

const sidebarPanel = createPanelResize({
  axis: "x",
  sizeKey: SIDEBAR_WIDTH_KEY,
  defaultSize: SIDEBAR_DEFAULT_WIDTH,
  min: SIDEBAR_MIN_WIDTH,
  max: SIDEBAR_MAX_WIDTH,
  // 60% of the viewport, whatever that is today: on a narrow window the
  // seam's min-wins rule still takes the wheel (below the ~334px crossover
  // the fraction falls under SIDEBAR_MIN_WIDTH and the min holds the floor).
  viewportMax: () => window.innerWidth * 0.6,
  step: 16,
  coarseStep: 48,
  bodyClass: "sidebar-resizing",
  paint: (width, el) => {
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
    el?.setAttribute("aria-valuenow", String(width));
  },
});

// Recent Logs: a collapsible section the user drags taller/shorter from its
// titlebar. Collapsed keeps the header and drops the list entirely, so the
// resize gestures are gated off until it expands again -- and a section that
// later expands comes back at the height the user left.
const logsCollapsedAtom = reactiveState<boolean>(false);

const logsPanel = createPanelResize({
  axis: "y",
  sizeKey: LOGS_HEIGHT_KEY,
  collapsedKey: LOGS_COLLAPSED_KEY,
  defaultSize: LOGS_DEFAULT_HEIGHT,
  min: LOGS_MIN_HEIGHT,
  max: LOGS_MAX_HEIGHT,
  // Nearly the full viewport: only the reserve (header + a readable floor of
  // live sessions above) is withheld. Degenerate viewports are still covered
  // by the seam's min-wins rule.
  viewportMax: () => window.innerHeight - LOGS_VIEWPORT_RESERVE,
  step: 16,
  coarseStep: 48,
  // The titlebar sits ABOVE the list it sizes, so it rides into it: drag up to
  // grow, drag down to shrink (and ArrowUp/ArrowDown follow the same grammar).
  nearEdge: true,
  bodyClass: "logs-resizing",
  enabled: () => !logsCollapsedAtom(),
  paint: (height, el) => {
    document.documentElement.style.setProperty("--logs-height", `${height}px`);
    el?.setAttribute("aria-valuenow", String(height));
  },
  onCollapseChange: (collapsed) => logsCollapsedAtom(collapsed),
});

function onToggleLogs(): void {
  logsPanel.toggle(); // persists and bumps the atom; the render does the rest
}

// ── Workbench pane (right dock) ─────────────────────────────────────────────
// The third panel on the same seam. axis x + nearEdge: the handle rides the
// panel's LEFT (near) edge, so dragging left GROWS the pane and ArrowLeft
// steps it up -- panelDragSign/panelSizeForKey flip both together.
// DEFAULT COLLAPSED: a first-run visitor never sees the pane; today's layout
// renders exactly as before until the header toggle opens it. The seam's
// collapse codec reads "no stored key" as expanded, so init() seeds the
// first visit (see hasStoredWorkbenchCollapsed there).

const WORKBENCH_WIDTH_KEY = "hotdog.workbenchWidth";
const WORKBENCH_COLLAPSED_KEY = "hotdog.workbenchCollapsed";

const workbenchCollapsedAtom = reactiveState<boolean>(true);

const workbenchPanel = createPanelResize({
  axis: "x",
  sizeKey: WORKBENCH_WIDTH_KEY,
  collapsedKey: WORKBENCH_COLLAPSED_KEY,
  defaultSize: WORKBENCH_DEFAULT_WIDTH,
  min: WORKBENCH_MIN_WIDTH,
  max: WORKBENCH_MAX_WIDTH,
  // Mirror the sidebar's pattern (owner ruling: a wide screen hands the
  // pane most of its width): 60% of the viewport, and on degenerate
  // viewports the seam's min-wins rule takes the wheel.
  viewportMax: () => window.innerWidth * 0.6,
  step: 16,
  coarseStep: 48,
  nearEdge: true,
  bodyClass: "workbench-resizing",
  // A closed pane has no width to drag (its handle is not even mounted);
  // the gate is the same lock logsPanel puts on a collapsed list.
  enabled: () => !workbenchCollapsedAtom(),
  paint: (width, el) => {
    document.documentElement.style.setProperty("--workbench-width", `${width}px`);
    el?.setAttribute("aria-valuenow", String(width));
  },
  onCollapseChange: (collapsed) => workbenchCollapsedAtom(collapsed),
});

function onToggleWorkbench(): void {
  workbenchPanel.toggle(); // persists and bumps the atom; the render does the rest
}

/** Best-effort probe for the init() seed: a throwing or absent storage reads
 *  as "no stored choice", which lands on the default-collapsed side -- the
 *  seam doctrine's cost is the reload, and the session's toggle stays live. */
function hasStoredWorkbenchCollapsed(): boolean {
  try {
    return window.localStorage?.getItem(WORKBENCH_COLLAPSED_KEY) != null;
  } catch {
    return false;
  }
}

// ── Workbench file tabs (tree + read-only viewer) ───────────────────────────

// Both producers keep their state in atoms (pure ops in file-tree.tsx /
// file-view.tsx); this layer's job is (1) run the op, (2) dispatch the fetch
// it mints, (3) feed replies back through the apply op, which drops stale
// request ids. Re-request on every tree open/refresh; file tabs fetch once
// per unseen path (reopen reuses the tab and its state; Reload re-reads).
const fileTreeAtom = reactiveState<FileTreeState>(emptyFileTree());
const fileViewsAtom = reactiveState<FileViewsState>(emptyFileViews());

function dispatchTreeFetches(fetches: TreeFetch[]): void {
  for (const f of fetches) chat?.listDir(f.requestId, f.path);
}

/** Zero-tabs button and any future producer: dock the tree tab, (re)request
 *  the roots + expanded dirs. */
function openFilesTab(): void {
  workbenchStore.open(filesTab());
  const { state, fetches } = openFileTree(fileTreeAtom());
  fileTreeAtom(state);
  dispatchTreeFetches(fetches);
}

/**
 * Reveal a task's workflow RUN DIR (subagent row menu): open/focus the tree
 * tab (the onOpenFilePath visibility idiom -- a reveal into a collapsed pane
 * would otherwise be invisible), expand every ancestor + the dir and select
 * it (revealDir), and dispatch the minted fetches through the SAME listDir
 * path as a hand-opened tree. Confinement is the server's (handlers-files
 * resolveSafe): a run dir outside the workspace roots answers with the
 * honest one-liner, and the roots reply prunes expansions under no root --
 * the reveal degrades to "nothing to show", never to a lie.
 */
function revealTaskRunDir(path: string): void {
  workbenchStore.open(filesTab());
  if (workbenchCollapsedAtom()) onToggleWorkbench();
  const { state, fetches } = revealDir(fileTreeAtom(), path);
  fileTreeAtom(state);
  dispatchTreeFetches(fetches);
}

function onTreeRefresh(): void {
  const { state, fetches } = openFileTree(fileTreeAtom());
  fileTreeAtom(state);
  dispatchTreeFetches(fetches);
}

function onTreeToggleDir(path: string): void {
  const { state, fetch } = toggleDir(fileTreeAtom(), path);
  fileTreeAtom(state);
  if (fetch) chat?.listDir(fetch.requestId, fetch.path);
}

function onListDirReply(requestId: number | undefined, result: ListDirResultWire): void {
  // Stale ids drop inside applyListDir (pending map); rejections ride the
  // payload's error field and render verbatim on their row -- no toast.
  fileTreeAtom(applyListDir(fileTreeAtom(), requestId, result));
}

const baseName = (p: string): string => p.split(/[/\\]/).pop() || p;

/** Fetch a "file" tab's first page unless its entry already exists (open is
 *  idempotent by path). Also wired to tab activation: a tab whose view went
 *  missing re-requests rather than staring at the pending note forever. */
function ensureFileView(path: string): void {
  const { state, fetch } = openFileView(fileViewsAtom(), path);
  fileViewsAtom(state);
  dispatchFileFetch(fetch);
}

function onActivateWorkbenchTab(id: string): void {
  workbenchStore.activate(id);
  const tab = workbenchStore.get().tabs.find((t) => t.id === id);
  if (tab?.kind === "file") ensureFileView(id);
}

/** Tree file click: open the "file" tab (id = path, so re-clicking reuses
 *  it) AND make the pane visible through the EXISTING toggle -- a tab
 *  opened while the pane is collapsed would otherwise be invisible, but the
 *  collapsed default is never fought by anything else (no auto-open on load,
 *  no auto-open on tab close). */
function onOpenFilePath(path: string): void {
  workbenchStore.open({ id: path, kind: "file", label: baseName(path), dirty: false });
  if (workbenchCollapsedAtom()) onToggleWorkbench();
  ensureFileView(path);
}

function dispatchFileFetch(fetch: FileFetch | null): void {
  if (fetch) chat?.readFile(fetch.requestId, fetch.path, fetch.offset);
}

function onFileReload(path: string): void {
  const { state, fetch } = reloadFileView(fileViewsAtom(), path);
  fileViewsAtom(state);
  dispatchFileFetch(fetch);
}

function onFileMore(path: string): void {
  const { state, fetch } = moreFileView(fileViewsAtom(), path);
  fileViewsAtom(state);
  dispatchFileFetch(fetch);
}

function onReadFileReply(requestId: number | undefined, result: ReadFileResultWire): void {
  fileViewsAtom(applyReadFile(fileViewsAtom(), requestId, result));
}

/** Tree-row menu (ContextMenu idiom: the app owns the atom + focus-return,
 *  the rows just hand over (event, path, el); the viewer has no menu by
 *  design). "Quote into composer" is DEFERRED: no composer-insert seam exists
 *  (draft.ts is persistence-only, chat.ts owns the socket, the textarea is
 *  app-internal), so wiring it here would be surgery on app.tsx's #chat-input
 *  -- see the phase notes. */
function onFilePathMenu(e: MouseEvent | KeyboardEvent, path: string, rowEl: HTMLElement): void {
  const { x, y } = rowMenuPoint(e, rowEl);
  const items: ContextMenuItem[] = [
    {
      label: "Copy path",
      onSelect: () => {
        copyRowValue(path, "Path"); // honest toast: "Path copied" / "Copy failed: clipboard unavailable"
        dismissContextMenu();
      },
    },
  ];
  contextMenuAtom({ x, y, items });
  armContextMenu(rowEl);
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
      // Restored "file" tabs (init's sessionStorage seed, or a login landing
      // after boot) read their first page the moment the wire is alive:
      // ensureFileView fetches only unseen paths, so loaded tabs are a
      // zero-traffic no-op. chat.ts drops pre-OPEN frames, so this is THE
      // attach-time dispatch point.
      for (const tab of workbenchStore.get().tabs) {
        if (tab.kind === "file") ensureFileView(tab.id);
        else if (tab.kind === "files" && fileTreeAtom().roots === null) {
          // A restored tree tab on a page that has NEVER listed: activation
          // was the re-request, so run the open/refresh machinery now. A
          // session that already listed rides its cache -- no surprise
          // re-requests on re-attach.
          onTreeRefresh();
        }
      }
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
    onConfigSnapshot,
    onSetConfigKey,
    onEditConfigList,
    onListDir: onListDirReply,
    onReadFile: onReadFileReply,
    onAuthFailure: handleAuthFailure,
    onWorkingMapChange: () => {
      // Re-poll so the sidebar's per-session working indicators refresh.
      chat?.listSessions();
    },
    onRunError: () => {
      // Arm the failure terminal only while a run is actually in flight: an
      // idle command error has no off-edge to consume the marker, and a stale
      // one would mislabel the next real completion.
      if (chat?.workingAtom()) liveFailed = true;
    },
  });

  // Re-render on any chat atom change; also refresh the sidebar when the
  // model changes, and pull profiles once connected. Streaming subagent
  // output must NEVER land in this list: activity frames go straight from
  // chat.ts into the MessageListManager's imperative DOM path, so a task
  // streaming hundreds of deltas per second repaints nothing here -- the
  // sidebar rows refresh on tasksAtom (per taskUpdate) and the 1 s tick.
  stopChatEffects = effect(render, [
    chat.connectedAtom,
    chat.workingAtom,
    chat.sessionIdAtom,
    chat.modelsAtom,
    chat.currentModelAtom,
    chat.profilesAtom,
    chat.currentProfileAtom,
    chat.tasksAtom,
    chat.viewedTaskIdAtom,
    chat.sttEnabledAtom,
    chat.toolExecAtom,
    chat.hideThinkingAtom,
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
  // aria-live narration of the attached session's working run (audit 1.1).
  // The reactiveState primitive fires only on a real change, so every effect
  // run IS a boundary. The off-edge reads its terminal marker first (local
  // Stop, server error), then the socket truth (connectedAtom); only a turn
  // that ended by finishing while connected claims "Reply complete".
  const stopLiveAnnounce = chat.workingAtom.effect(() => {
    const w = chat?.workingAtom() ?? false;
    if (w) {
      liveAnnounceAtom("Working");
      return;
    }
    const stopped = liveStopped;
    const failed = liveFailed;
    liveStopped = false;
    liveFailed = false;
    liveAnnounceAtom(
      stopped
        ? "Work stopped"
        : failed
          ? "Run failed"
          : (chat?.connectedAtom() ?? false)
            ? "Reply complete"
            : "Connection lost",
    );
  });
  const prevStop = stopChatEffects;
  stopChatEffects = () => {
    prevStop();
    stopModelRefresh();
    stopProfilesRefresh();
    stopTaskTick();
    stopLiveAnnounce();
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

  // Subagent view steers the VIEWED task (owner ruling 2026-11-13): the
  // follow-up route is text-only on the wire (taskFollowup carries no
  // files), and a slash command would act on the attached manager, which
  // is not what the pane is showing. With staged attachments the box and
  // the draft stay intact -- the bytes are the user's until a route can
  // carry them.
  const viewedTaskId = chat?.viewedTaskIdAtom() ?? null;
  if (viewedTaskId !== null) {
    if (attachments.length > 0) {
      showCopyToast("Attachments can't ride subagent steering -- send text only");
      return;
    }
    if (!text) return;
    el.value = "";
    autoResize(el);
    cancelDraftSave();
    clearDraft();
    dismissCompletion();
    chat?.taskFollowup(viewedTaskId, text);
    return;
  }

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
    // Steering-on is the webui default: every send steers. The wire shape is
    // unchanged -- chat.ts sendMessage still adds `steering: true`
    // conditionally and its parameter default stays false for other callers.
    chat?.sendMessage(text, files, true);
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
  if (!hasFiles(e.dataTransfer) || inBrowseView()) return;
  e.preventDefault(); // without this the drop never fires on the composer
  dragDepth++;
  setDragHighlight(e.currentTarget, true);
}

function onComposerDragover(e: DragEvent): void {
  if (hasFiles(e.dataTransfer) && !inBrowseView()) e.preventDefault();
}

function onComposerDragleave(e: DragEvent): void {
  if (!hasFiles(e.dataTransfer)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDragHighlight(e.currentTarget, false);
}

function onComposerDrop(e: DragEvent): void {
  dragDepth = 0;
  setDragHighlight(e.currentTarget, false);
  if (inBrowseView()) return; // read-only browse view: ignore file drops
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
  } else if (e.key === "Tab" && !e.shiftKey) {
    // Forward Tab requests completions. Shift+Tab is deliberately NOT caught
    // here (or prevented): it falls through to the browser's backward focus
    // traversal, the universal escape hatch that the old unconditional Tab
    // guard destroyed -- with it, no in-page key could leave the composer.
    e.preventDefault();
    requestCompletions(el);
    return;
  } else if (e.key === "Escape") {
    // No completion popup to dismiss -> Escape blurs the textarea, so the
    // keyboard user can leave the composer (focus would otherwise have no
    // way out). Popup-open Escape is handled above and still dismisses the
    // popup without blurring, exactly as before.
    e.preventDefault();
    el.blur();
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
  // A Stop on the ATTACHED running session is a user-initiated end: arm the
  // terminal marker before the optimistic flip below (and chat.cancel's own
  // flip) so the aria-live off-edge says "Work stopped". Scope: attached +
  // working only, so a stray flag can never mislabel a later completion.
  if (chat && sessionId === chat.sessionIdAtom() && chat.workingAtom()) liveStopped = true;
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
  if (inBrowseView()) return; // browse view: no live session to act on
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

/* Fence chip posture classification (icon-only: the full posture truth the
 * text used to carry rides title + aria-label). The vocabulary is
 * toolExecModeLabel's (src/core/tool-exec-broker.ts):
 *   "worker (fence: bwrap|seatbelt)"        jail in force               -> shield-check
 *   "worker (fence: off)"                   deliberately unfenced       -> no-symbol, error tint
 *   "worker (fence: none -- probe failed)"  policy wants a jail the host cannot give -> no-symbol, warning tint
 *                                                                                       (an accident, not a choice)
 *   "... [degraded: broker respawn cap]"    unhealthy plane             -> plain shield inside the
 *                                                                          chip's existing error chrome
 *   "inline (unfenced)" / unrecognized      inert or unknown posture    -> muted neutral shield
 * An unrecognized token NEVER gets a shield-check: if nothing can be said
 * about what confines the tools, the shield carries no checkmark.
 */
type FenceState = "on" | "off" | "probe-failed" | "degraded" | "neutral";

function classifyFence(toolExec: string): FenceState {
  if (toolExec.includes("degraded")) return "degraded";
  if (toolExec.includes("fence: off")) return "off";
  if (toolExec.includes("none -- probe failed")) return "probe-failed";
  if (toolExec.includes("fence: bwrap") || toolExec.includes("fence: seatbelt")) return "on";
  return "neutral";
}

/* Hover wording: "Sandbox Mode: enabled (worker, bwrap)" /
 * "Sandbox Mode: off (inline)" / "Sandbox Mode: partial (worker, fence off)".
 * The rest of the vocabulary reads in the same grammar: seatbelt names the
 * backend, a failed probe reads "Sandbox Mode: partial (worker, fence
 * failed)" (nothing confined, but an accident rather than a choice),
 * degraded adds the respawn-cap truth on top of whatever jail sentence
 * applies, and an unrecognized posture claims nothing ("unknown").
 * The RAW server posture text stays in the aria-label; the title is the
 * human sentence. A live control rides the toggle hint; a log view names the
 * scope limit instead.
 */
function fenceTitle(state: FenceState, toolExec: string, clickable: boolean, browseView: boolean): string {
  const jail = toolExec.includes("fence: off")
    ? "partial (worker, fence off)"
    : `enabled (worker, ${toolExec.includes("fence: seatbelt") ? "seatbelt" : "bwrap"})`;
  let base: string;
  switch (state) {
    case "on":
      base = `Sandbox Mode: ${jail}`;
      break;
    case "off":
      base = "Sandbox Mode: partial (worker, fence off)";
      break;
    case "probe-failed":
      base = "Sandbox Mode: partial (worker, fence failed)";
      break;
    case "degraded":
      base = `Sandbox Mode: ${jail} -- degraded: broker respawn cap`;
      break;
    case "neutral":
      base = toolExec.includes("inline") ? "Sandbox Mode: off (inline)" : "Sandbox Mode: unknown posture";
      break;
  }
  if (clickable) return `${base} -- click to toggle this session's fence`;
  if (browseView) return `${base} -- the fence toggle acts on live sessions only, not on a viewed log or subagent transcript`;
  return base;
}

/** The chip's icon for one posture; the fence-* class is the CSS tint hook
 *  (error / warning) and the identity the tests pin. */
function fenceGlyph(state: FenceState): JsxChild {
  switch (state) {
    case "on":
      return <IconShieldCheck className="fence-on" />;
    case "off":
      return <IconBan className="fence-off" />;
    case "probe-failed":
      return <IconBan className="fence-probe-failed" />;
    case "degraded":
      return <IconShield className="fence-degraded" />;
    case "neutral":
      return <IconShield className="fence-neutral" />;
  }
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

// ── Theme switcher ──────────────────────────────────────────────────────────
// A per-browser palette (theme-pref.ts): click cycles THEME_REGISTRY order,
// each step persisting to localStorage and re-tagging <html> data-theme.
// The header button re-renders off the atom so its title names the CURRENT
// palette and the one the next click brings; boot applies the stored pref
// (init) after an index.html inline mirror already painted it.

const themeIdAtom = reactiveState<string>("");

function cycleTheme(): void {
  const next = nextThemeId(themeIdAtom());
  themeIdAtom(next);
  saveThemeId(next);
  applyThemeId(next);
}

// ── View ────────────────────────────────────────────────────────────────────

function App() {
  const screen = screenAtom();
  const connected = chat?.connectedAtom() ?? false;
  const activeLogId = activeLogIdAtom();
  // Subagent transcript on screen (the chat-side browse pointer; the sidebar
  // row highlight, the header label and the composer's busy posture all read
  // it).
  const viewedTaskId = chat?.viewedTaskIdAtom() ?? null;
  // The composer's working posture follows the PANE's subject (owner ruling
  // 2026-11-13: the send/stop controls you see belong to the session on
  // screen). While a subagent transcript is open that is the task's own live
  // turn -- TaskInfoWire.inRun, server truth arriving on every taskUpdate,
  // so the button flips with the task's turn boundaries exactly like the
  // manager's working flag does for its session, and can never claim a turn
  // the server never attested (deliberately not optimistic: taskInterrupt can
  // be refused, and a refused Stop must not leave a lying button). A queued
  // or parked task has no turn in flight, so it shows Send, like an idle
  // session. The hidden manager's working flag never drives this pane.
  const working =
    viewedTaskId === null
      ? (chat?.workingAtom() ?? false)
      : (chat?.tasksAtom().find((t) => t.taskId === viewedTaskId)?.inRun ?? false);
  // A cold log is a read-only record: it locks the composer. A subagent
  // transcript is a LIVE view (owner ruling 2026-11-13): the composer stays
  // operable and STEERS the viewed task; the only thing the mode locks is
  // the profile/model switching dropdowns (selects-locked). fence/drops
  // stay inert in both browse modes alike.
  const composerLocked = activeLogId !== null;
  // Either browse mode keeps the fence strip and file drops inert: both act
  // on the ATTACHED session, which is not what the pane is showing.
  const browseView = activeLogId !== null || viewedTaskId !== null;
  const sessionId = chat?.sessionIdAtom() ?? null;
  // The header identity follows the pane's subject: the viewed task's id
  // while its transcript is on screen, the attached session's otherwise
  // (the copy button always copies the full id of what it names).
  const badgeId = viewedTaskId ?? sessionId;
  // Tool-exec plane posture: "worker (fence: bwrap | seatbelt | off | none -- probe failed)" / "inline (unfenced)",
  // plus anything carrying [degraded: ...].
  const toolExec = chat?.toolExecAtom() ?? "";
  // Reasoning visibility (localStorage; survives reload, applies to live transcripts and browsed cold logs alike).
  const hideThinking = chat?.hideThinkingAtom() ?? false;
  // Active color theme (localStorage view setting, see theme-pref.ts); the
  // title names where the next click lands so the cycle is discoverable.
  const themeId = themeIdAtom();
  const themeTitle = `Theme: ${labelForTheme(themeId)} -- click to switch to ${labelForTheme(nextThemeId(themeId))}`;
  // The strip becomes a control exactly when the ATTACHED live session shows a worker-plane fence;
  // inline/degraded postures and either browse mode stay inert.
  const fenceClickable =
    toolExec.includes("fence:") &&
    !toolExec.includes("degraded") &&
    !browseView &&
    sessionId !== null;
  // The chip's posture (classifyFence above). The chip is icon-only: the
  // full posture text lives in the title and an aria-label naming it.
  const fenceState = classifyFence(toolExec);
  const menu = contextMenuAtom();
  const completionMenu = completionAtom();
  const attachments = attachmentsAtom();
  const allTasks = chat ? chat.tasksAtom() : [];
  // Scope the server-global feed to the open session; null-parent tasks
  // (workflow-engine spawns) belong to no session and never show. The
  // sidebar re-scopes per card; this copy labels the viewed subagent.
  const tasks = allTasks.filter((t) => sessionId !== null && t.sessionId === sessionId);
  const sttPhase = sttPhaseAtom();
  const settings = settingsAtom();
  // Workbench file-tab bodies read their state here (atoms flip on WS
  // replies; the coalesced render repaints the pane).
  const fileTree = fileTreeAtom();
  const fileViews = fileViewsAtom();

  return (
    <>
      <LoginScreen hidden={screen !== "login"} onToken={activateToken} />

      <div id="main-ui" className={`screen${screen === "main" ? "" : " hidden"}`}>
        {/* Screen-reader narration channel (audit 1.1): role=status announced
            politely; carries ONLY working-state boundaries (liveAnnounceAtom)
            -- never streamed tokens, never transcript text. Visually hidden:
            clip, not display:none, or readers would skip it. */}
        <div
          id="live-status"
          className="visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {liveAnnounceAtom()}
        </div>
        <Sidebar
          sessions={sessionsAtom()}
          activeSessionId={sessionId}
          workingMap={chat?.sessionWorkingMap ?? new Map()}
          logs={logsAtom()}
          activeLogId={activeLogId}
          pinnedIds={pinnedIdsAtom()}
          onCreate={() => chat?.createSession({})}
          onSwitch={(id) => {
            // Clicking the active session only matters in a browse mode
            // (log view or a subagent transcript): it switches back.
            if (id === sessionId && !browseView) return;
            chat?.switchSession(id);
          }}
          onCancel={onCancelSession}
          onViewLog={(id) => chat?.viewLog(id)}
          onOpenTask={(_id, task) => openTaskRow(task)}
          onTaskMenu={onSubagentMenu}
          onToggleSubagents={onToggleSubagents}
          tasks={allTasks}
          viewedTaskId={viewedTaskId}
          subagentsCollapsed={subagentsCollapsedAtom()}
          now={nowAtom()}
          onSessionMenu={onSessionMenu}
          onLogMenu={onLogMenu}
          search={searchAtom()}
          searchInputRef={searchInputRef}
          onOpenSearch={openSearch}
          onCloseSearch={closeSearchFromUi}
          onSearchQuery={onSearchQuery}
          onSearchKeydown={onSearchKeydown}
          onActivateHit={onActivateHit}
          sidebarWidth={sidebarPanel.size()}
          sidebarMax={sidebarPanel.maxSize()}
          onResizeStart={sidebarPanel.onPointerDown}
          onResizeMove={sidebarPanel.onPointerMove}
          onResizeEnd={sidebarPanel.onPointerUp}
          onResizeKey={sidebarPanel.onKeyDown}
          onResizeReset={sidebarPanel.onDoubleClick}
          logsCollapsed={logsPanel.collapsed()}
          logsHeight={logsPanel.size()}
          logsMin={LOGS_MIN_HEIGHT}
          logsMax={logsPanel.maxSize()}
          onToggleLogs={onToggleLogs}
          onLogsResizeStart={logsPanel.onPointerDown}
          onLogsResizeMove={logsPanel.onPointerMove}
          onLogsResizeEnd={logsPanel.onPointerUp}
          onLogsResizeKey={logsPanel.onKeyDown}
          onLogsResizeReset={logsPanel.onDoubleClick}
        />

        <main id="chat-area">
          <div id="session-info">
            {/* The pane's subject identity (owner ruling 2026-11-13): a
                subagent view names itself -- "Subagent:" + the viewed task's
                id badge, copy landing the FULL task id -- and reverts to the
                attached "Session:" the moment the mode ends. The dim is log
                view only: there the badge shows the attached id while the
                pane is a cold record, so it must read as not-the-subject;
                in subagent view the badge IS the subject, so it never dims. */}
            <span id="session-label" style={activeLogId !== null ? { opacity: "0.5" } : undefined}>
              {viewedTaskId !== null ? "Subagent:" : "Session:"}{" "}
              <button
                type="button"
                id="current-session-id"
                className={copyFlashAtom() ? "copied" : undefined}
                title={
                  badgeId
                    ? viewedTaskId !== null
                      ? "Copy full subagent id"
                      : "Copy full session id"
                    : undefined
                }
                aria-label={
                  badgeId
                    ? viewedTaskId !== null
                      ? "Copy full subagent id"
                      : "Copy full session id"
                    : undefined
                }
                onClick={
                  badgeId
                    ? (e: MouseEvent) => {
                        // The badge had no click action before the copy; stop
                        // so it never bubbles into an ancestor handler.
                        e.stopPropagation();
                        onCopySessionId(badgeId);
                      }
                    : undefined
                }
              >
                {/* Fingerprint ONLY: the badge is the full-id copy button,
                    never a title slot (titles live on the sidebar row; a
                    derived one is far too long for the header). Copy
                    affordance: the inline icon/check pair (CSS swaps them
                    on .copied); the empty glyphs add nothing to
                    textContent, so the badge stays pure id text. */}
                {badgeId ? badgeId.slice(0, 8) : ""}
                <IconCopy className="session-copy-icon" />
                <IconCheck className="session-copy-check" />
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
            {/* The subagent mirror of the log-view label: what is on screen
                (step label idiom; full task id on the native title) and how
                to leave. An evicted task falls back to labeling from its
                bare id. */}
            {viewedTaskId !== null ? (
              <span id="subagent-view-label">
                Viewing subagent:{" "}
                <span id="current-subagent-label" title={viewedTaskId}>
                  {chipLabel(
                    tasks.find((t) => t.taskId === viewedTaskId) ?? {
                      taskId: viewedTaskId,
                      description: "",
                    },
                  )}
                </span>{" "}
                <button
                  id="close-subagent-view-btn"
                  title="Close subagent view"
                  onClick={onCloseSubagentView}
                >
                  ✕
                </button>
              </span>
            ) : null}
            <span className="header-status-group">
              {/* Reasoning visibility toggle: a per-browser view switch (chat
                  toggleHideThinking -> localStorage + a sweep of every thinking
                  block). Glyph-only chrome now, to match the fence/gear/theme/
                  workbench siblings: icons.tsx IconThinking -- the thought
                  bubble WITH its two text lines while reasoning is shown, the
                  same bubble empty when it is hidden -- with zero text node;
                  the full truth rides title + aria-label. Always
                  clickable -- including in log view, where it is the only way
                  to hide a cold log's reasoning. */}
              <button
                type="button"
                id="thinking-toggle"
                className="header-btn toggleable"
                // Same idiom as #search-btn next door: a pressed toggle chip.
                // Pressed = the view deviation is engaged (reasoning hidden);
                // the default "shown" state reads unpressed.
                aria-pressed={hideThinking}
                aria-label={`Reasoning ${hideThinking ? "hidden" : "shown"}: click to ${
                  hideThinking ? "show" : "hide"
                } reasoning in this browser`}
                title={
                  `Reasoning ${hideThinking ? "hidden" : "shown"} in this browser -- show or hide it here (view setting only: it does not change the CLI's /thinking session state, and it applies to the log being browsed too)`
                }
                onClick={() => chat?.toggleHideThinking()}
              >
                <IconThinking off={hideThinking} />
              </button>
              {toolExec ? (
                // Exec-fence posture, icon-only: the posture -> shape/tint
                // table lives with classifyFence; the raw server posture
                // rides the aria-label and the "Sandbox Mode: ..." sentence
                // the title (fenceTitle) -- nothing is icon-decoded.
                <button
                  id="tool-exec-status"
                  className={[
                    "header-btn",
                    toolExec.includes("degraded") ? "tool-exec-degraded" : "",
                    fenceClickable ? "toggleable" : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined}
                  title={fenceTitle(fenceState, toolExec, fenceClickable, browseView)}
                  aria-label={`Tool execution: ${toolExec}`}
                  onClick={fenceClickable ? onFenceToggle : undefined}
                >
                  {fenceGlyph(fenceState)}
                </button>
              ) : null}
              {/* Settings viewer: a live-at-open read of the resolved config
                  (a fresh snapshot is requested on every open; diagnostics +
                  per-key sources, secrets redacted server-side). Opens a
                  dialog; Escape returns focus here. */}
              <button
                type="button"
                id="settings-btn"
                className="header-btn toggleable"
                aria-label="Settings"
                aria-haspopup="dialog"
                aria-expanded={settingsAtom().open ? "true" : "false"}
                title="Settings Menu"
                onClick={openSettings}
              >
                {/* Icon-only: the solid gear carries the button; the hover
                    text is the plain "Settings Menu". aria-label,
                    haspopup/expanded and the open handler unchanged; zero
                    text renders. */}
                <IconGear />
              </button>
              {/* Theme switcher: cycles the palette registry (hotdog ->
                  purple -> ...); a click persists and re-tags <html>.
                  Native button = Enter/Space work for free. The inline SVG
                  glyph is tinted by currentColor, so it recolors with
                  whatever palette is on screen (see #theme-btn in
                  styles.css). Position rides after settings so the header
                  group's pinned children keep their slots. */}
              <button
                type="button"
                id="theme-btn"
                title={themeTitle}
                aria-label={themeTitle}
                onClick={cycleTheme}
              >
                <IconPalette />
              </button>
              {/* Workbench disclosure: the header's LAST control (the
                  connection indicator left for the composer), at the
                  group's absolute right edge. The glyph reads as a panel
                  with its RIGHT column solid-filled, the fill's left edge
                  being the single divider -- the dock this button opens --
                  so icon and dock sit side by side at rest. aria-label
                  carries the name; aria-expanded mirrors the OPEN state
                  like #logs-toggle. */}
              <button
                type="button"
                id="workbench-toggle"
                className="header-btn toggleable"
                aria-label="Toggle workbench pane"
                aria-expanded={workbenchCollapsedAtom() ? "false" : "true"}
                title="Toggle Workbench (right pane sidebar)"
                onClick={onToggleWorkbench}
              >
                <IconWorkbench />
              </button>
            </span>
          </div>

          {/* Imperatively managed by MessageListManager via ref (streaming markdown). */}
          <div id="message-list" ref={messageListRef}></div>

          {/* Subagent view is NOT read-only (composer steers the task);
              only a browsed cold log locks the input area. selects-locked:
              the profile/model switching dropdowns are the one exception
              to "works like a live session" while a subagent is viewed. */}
          <div
            id="input-area"
            className={
              [composerLocked ? "read-only" : "", viewedTaskId !== null ? "selects-locked" : ""]
                .filter(Boolean)
                .join(" ") || undefined
            }
          >
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
                placeholder={viewedTaskId !== null ? "Steer the subagent..." : "Type a message..."}
                autocomplete="off"
                rows="1"
                disabled={composerLocked}
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
                  title={
                    viewedTaskId !== null && !composerLocked
                      ? "Attachments can't ride subagent steering (text only)"
                      : "Attach files to the next message"
                  }
                  aria-label={
                    viewedTaskId !== null && !composerLocked
                      ? "Attachments can't ride subagent steering (text only)"
                      : "Attach files to the next message"
                  }
                  disabled={composerLocked || viewedTaskId !== null}
                  onClick={() => fileInputEl?.click()}
                >
                  {/* currentColor idiom from icons.tsx; 1.8 stroke for the weight. */}
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" tabindex="-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
                {chat?.sttEnabledAtom() ? (
                  <button
                    type="button"
                    id="mic-btn"
                    className={sttPhase === "recording" ? "recording" : undefined}
                    title="Hold to record; the transcript is inserted into the input"
                    aria-label="Hold to record; the transcript is inserted into the input"
                    // The mic only EDITS the box, so it keeps working in a
                    // subagent view (the text it inserts steers the task).
                    disabled={composerLocked || sttPhase === "transcribing"}
                    onMousedown={onMicMousedown}
                  >
                    {/* Idle = glyph only: aria-label + title carry the name.
                        The glyph follows the neighboring #attach-btn paperclip
                        idiom: aria-hidden decoration, currentColor stroke, so
                        the .recording red ink repaints it for free. The
                        transient phases keep their EXPLICIT text
                        ("● Recording" / "..."): a live state needs a visible
                        tell, an aria-label is not one. An empty svg sibling
                        never changes textContent, so idle is "". */}
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" tabindex="-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <path d="M12 19v3" />
                    </svg>
                    {sttPhase === "recording" ? "● Recording" : sttPhase === "transcribing" ? "..." : null}
                  </button>
                ) : null}
                <label id="profile-selector">
                  {/* Label text is screen-reader-only (house .visually-hidden
                      clip: keeps the accessible name, drops the visible
                      "Profile:" the owner hid 2026-11-14). */}
                  <span className="visually-hidden">Profile</span>
                  {/* Profile/model switching belongs to the ATTACHED manager,
                      never to the viewed subagent (owner ruling 2026-11-13:
                      the one exception). Native disabled drops the selects
                      from the tab order; the .selects-locked CSS carries the
                      same dim the read-only composer pills use. */}
                  <select
                    id="profile-select"
                    ref={profileSelectRef}
                    disabled={viewedTaskId !== null}
                    onChange={onProfileChange}
                  >
                    {chat
                      ? Object.keys(chat.profilesAtom()).map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))
                      : null}
                  </select>
                </label>
                <label id="model-selector">
                  <span className="visually-hidden">Model</span>
                  <select
                    id="model-select"
                    ref={modelSelectRef}
                    disabled={viewedTaskId !== null}
                    onChange={onModelChange}
                  >
                    {chat?.modelsAtom().map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                {/* No steer control: every send steers (see the send site;
                    in a subagent view steering rides taskFollowup). */}
                {/* Connection truth, moved out of the header: it renders
                    ONLY while disconnected -- zero DOM when connected, not a
                    hidden span -- immediately LEFT of Stop/Send in this row.
                    Its margin-left:auto absorbs the slack (the buttons' own
                    auto margin is handed over while it's present, see
                    styles.css), so the right-anchored pair never shifts when
                    the indicator appears or vanishes; nothing is reserved. A
                    plain span: no tab stop, no interference with the
                    focusable-ids ordering pins. */}
                {connected ? null : (
                  <span id="connection-status" className="status-disconnected">
                    Disconnected
                  </span>
                )}
                {working ? (
                  // type=button: it lives inside #chat-form; without it the
                  // click would submit the composer before cancelling. The
                  // in-button spinner is the chat column's only busy tell.
                  // Same button, two addressees (owner ruling 2026-11-13):
                  // the viewed subagent's Stop rides taskInterrupt for THAT
                  // task, never the manager's cancel frame.
                  <button
                    type="button"
                    id="cancel-btn"
                    title={
                      viewedTaskId !== null
                        ? "Stop this subagent: it aborts the task agent's turn, and a task turn has no turn-only interrupt on the wire -- the task ends as cancelled (the sidebar row confirms it)"
                        : undefined
                    }
                    onClick={() => {
                      if (viewedTaskId !== null) {
                        // No liveStopped marker here: that arms the manager's
                        // aria-live off-edge, which this click never moves.
                        chat?.interruptTask(viewedTaskId);
                        return;
                      }
                      // Same user-initiated-end marker as the row/menu Stop
                      // (onCancelSession): chat.cancel flips working itself,
                      // so arm before handing it the click.
                      if (chat?.workingAtom()) liveStopped = true;
                      chat?.cancel();
                    }}
                  >
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

        {/* Right-docked workbench; a sibling of the chat column inside the
            #main-ui flex row. Collapsed (the default on first run) renders
            nothing at all. */}
        <WorkbenchPanel
          collapsed={workbenchCollapsedAtom()}
          width={workbenchPanel.size()}
          min={WORKBENCH_MIN_WIDTH}
          max={workbenchPanel.maxSize()}
          state={workbenchStore.get()}
          onActivate={(id) => onActivateWorkbenchTab(id)}
          onCloseTab={(id) => workbenchStore.close(id)}
          onResizeStart={workbenchPanel.onPointerDown}
          onResizeMove={workbenchPanel.onPointerMove}
          onResizeEnd={workbenchPanel.onPointerUp}
          onResizeKey={workbenchPanel.onKeyDown}
          onResizeReset={workbenchPanel.onDoubleClick}
          fileTree={{
            tree: fileTree,
            onToggleDir: onTreeToggleDir,
            onOpenFile: onOpenFilePath,
            onRefresh: onTreeRefresh,
            onContextMenu: onFilePathMenu,
          }}
          fileViews={{
            views: fileViews.views,
            onReload: onFileReload,
            onMore: onFileMore,
          }}
          onOpenFiles={openFilesTab}
        />

        {/* Settings viewer + immediate-save editor dialog (settings button in the
            header). Mounted only while open; Escape closes (or collapses an
            expanded JSON container), ✕ closes, click-outside does NOT (values
            get selected). One mount hook, one import -- the panel is
            self-contained. */}
        {settings.open ? (
          <SettingsViewer
            snapshot={settings.snapshot}
            pending={settings.pending}
            rootRef={settingsRootRef}
            onClose={closeSettings}
            onRefresh={refreshSettings}
            editing={settings.editing}
            pendingSave={settings.pendingSave}
            queuedSaves={settings.queuedSaves}
            editError={settings.editError}
            needsRestart={settings.needsRestart}
            editedKeys={settings.editedKeys}
            query={settings.query}
            category={settings.category}
            onQuery={setSettingsQueryRow}
            onCategory={setSettingsCategoryRow}
            onEdit={startSettingsEditRow}
            onCancelEdit={cancelSettingsEditRow}
            onSaveEdit={saveSettingsEditRow}
            addingList={settings.addingList}
            confirmRemoveKey={settings.confirmRemoveKey}
            listError={settings.listError}
            listBusy={settings.pendingList !== null}
            focusProviderName={settings.focusProviderName}
            onListAddStart={listAddStart}
            onListAddCommit={listAddCommit}
            onListAddCancel={listAddCancel}
            onListRemove={listElementRemove}
            onProviderRemoveArm={providerRemoveArm}
            onProviderRemoveConfirm={providerRemoveConfirm}
            onProviderRemoveCancel={providerRemoveCancel}
          />
        ) : null}
      </div>

      {menu ? <ContextMenu menu={menu} rootRef={contextMenuRef} onClose={dismissContextMenu} /> : null}
    </>
  );
}

// ── Init ────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  // Boot the stored palette onto <html> before the first render. The
  // index.html inline script already did this pre-paint; this is the same
  // value re-applied with the registry's validation behind it.
  themeIdAtom(applyStoredTheme());
  sidebarPanel.restore();
  logsPanel.restore();
  workbenchPanel.restore();
  restoreSubagentsCollapsed();
  // First-run default-collapsed: restore() honors a STORED choice ("0"
  // keeps the pane open across visits), but "no key" decodes as expanded
  // and an unopened workbench must never dock itself into the layout. Seed
  // the first visit (or a storage-blocked one) to collapsed once; the write
  // persists, so later visits are decided by restore() alone.
  if (!hasStoredWorkbenchCollapsed()) workbenchPanel.toggle();
  workbenchCollapsedAtom(workbenchPanel.collapsed());
  // Restored tabs reappear BEFORE the first paint (order + active tab from
  // the sessionStorage record; garbage/absent -> zero tabs, silently). The
  // seed runs ahead of the subscriptions so it neither repaints nor rewrites
  // the record it just read; tab content lands through the existing read
  // machinery on the first sessionCreated (see startChat's onSessionCreated).
  seedWorkbenchStoreFromStorage();
  workbenchStore.subscribe(render);
  // Persist on every actual change (open/close/activate -- the store's one
  // notify per change is the trigger; no-ops write nothing).
  workbenchStore.subscribe(() => persistWorkbenchTabs(workbenchStore.get()));
  mounted = mount(<App />, root as unknown as DomNode);
  effect(render, [
    screenAtom,
    ...loginAtoms,
    sessionsAtom,
    logsAtom,
    activeLogIdAtom,
    pinnedIdsAtom,
    contextMenuAtom,
    liveAnnounceAtom,
    searchAtom,
    logsCollapsedAtom,
    completionAtom,
    attachmentsAtom,
    subagentsCollapsedAtom,
    nowAtom,
    copyFlashAtom,
    workbenchCollapsedAtom,
    settingsAtom,
    fileTreeAtom,
    fileViewsAtom,
    themeIdAtom,
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
