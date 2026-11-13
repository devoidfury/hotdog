/// <reference lib="dom" />
// Session/log sidebar. Both lists share one row grammar:
//
//   profile · provider/model          [status] [action]
//   start date & time · (ctx used / ctx total) · (msg count)  [plug n]
//
// The connected-client count shows as the bottom-row plug pinned to the
// card's bottom-right (icon + number for 2+, icon only for 1, nothing at
// 0/unattested) -- never a text metric.
//
// No literal parens anywhere: status renders as a glyph badge (custom
// inline-SVG set in icons.tsx, tinted by currentColor, native title
// tooltip), profile as quiet muted text. Missing segments are omitted
// outright, never rendered empty; " · " (middle dot, U+00B7) is the segment
// separator between the slots the example dot-joins (the profile/model join
// dot rides only when both speak). The line-1 action pins right
// (margin-left:auto), no sep.
// The raw session id is not displayed at all: it stays the selection key,
// pin/export identifier and handler argument -- never card text.

import { formatTokenCount, SIDEBAR_MIN_WIDTH, shortId } from "./utils.ts";
import { IconChevron, IconKebab, IconPlug, IconSearch, RowStatusGlyph } from "./icons.tsx";
import { SubagentsSection } from "./subagents.tsx";
import type { JsxChild, Ref } from "@utils/jsx";
import type { SearchHitWire, TaskInfoWire } from "@extensions/websocket/protocol.ts";

export interface SessionInfo {
  id: string;
  profile?: string;
  /** Explicit session name; absent/null means the display name is the profile. */
  title?: string | null;
  model?: string;
  createdAt: number;
  lastActivityAt: number;
  /** Live websocket clients on this session (registry metadata via the list
   *  payload). Shown as the card's bottom-right plug, never as text. */
  connectedClients: number;
  /** A pending question is blocking this session (registry metadata via the
   *  list payload). Wins the status slot: the card badges awaiting_question
   *  instead of working/idle while a human answer is outstanding. */
  questionPending?: boolean;
  /** Sidebar row slots: the conversation record count (same rule as the cold
   *  rows' messageCount: user input and model responses only -- tool traffic
   *  and bookkeeping never count) and the last token_usage snapshot. */
  messageCount?: number;
  ctxUsed?: number;
  ctxTotal?: number;
  /** Absolute JSONL log path on the server; omitted when the server could
   *  not compute it (the menu then hides "Copy log file path"). */
  logPath?: string;
  /** Server-persisted pin flag; the sidebar's pin marks hydrate from it. */
  pinned?: boolean;
}

export interface LogInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  /** Derived index state (idle/awaiting_question/interrupted/parked);
   *  absent when the log has no reconciled row yet. */
  state?: string;
  /** Index-attested model/profile + ctx; absent on legacy logs (segments omitted). */
  model?: string;
  profile?: string;
  /** Heuristic title derived from the log's first user messages (see
   *  deriveTitleFromMessages); absent until the index has a derived title.
   *  Renders on its own middle line -- never in the profile slot. */
  title?: string;
  ctxUsed?: number;
  ctxTotal?: number;
  /** Absolute JSONL log path on the server; omitted when the server could
   *  not compute it (the menu then hides "Copy log file path"). */
  logPath?: string;
  /** Server-persisted pin flag; the sidebar's pin marks hydrate from it. */
  pinned?: boolean;
}

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** Sidebar full-text search panel state (see the search button in the header).
 *  `results` is null until the first search settles; an empty array means the
 *  last query matched nothing. `live` hits open via switchSession, cold ones
 *  via viewLog (the app picks the verb). */
export interface SearchState {
  open: boolean;
  query: string;
  /** A search request is in flight (the debounce or the server scan). */
  pending: boolean;
  results: SearchHitWire[] | null;
}

/** Local "YYYY-MM-DD HH:MM" -- the sidebar line-3 stamp. */
export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface SidebarProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  workingMap: Map<string, boolean>;
  logs: LogInfo[];
  activeLogId: string | null;
  /** Server-pinned row ids (pin-store.ts, hydrated from the list payload
   *  flags; see app.tsx). Pinned rows sort above unpinned ones within their
   *  own section, relative order kept. */
  pinnedIds: Set<string>;
  sidebarWidth: number;
  sidebarMax: number;
  /** Recent Logs section state (see app.tsx logsPanel). `logsCollapsed` hides
   *  the list and drops the titlebar's drag-handle semantics entirely -- a
   *  collapsed section has no height to drag. Height clamps ride as props so
   *  the aria limits and the seam's clamp stay one source. */
  logsCollapsed: boolean;
  logsHeight: number;
  logsMin: number;
  logsMax: number;
  /** Server-global subagent task feed; the section nested under each session
   *  card filters it to its own manager (null-parent tasks match no row and
   *  never render -- same scoping rule the retired strip enforced). */
  tasks: TaskInfoWire[];
  /** Task whose transcript the main view is showing (row highlight). */
  viewedTaskId: string | null;
  /** Subagents-section collapse, shared across cards (view setting; the
   *  feed only ever populates the attached manager anyway). */
  subagentsCollapsed: boolean;
  /** Wall clock for the rows' elapsed clocks (app ticks it once per second
   *  while any task is live; finished rows freeze on their own). */
  now: number;
  onCreate: () => void;
  onSwitch: (sessionId: string) => void;
  onCancel: (sessionId: string) => void;
  onViewLog: (logId: string) => void;
  /** Open a task's transcript in the main view (chat.viewSubagent). */
  onOpenTask: (taskId: string) => void;
  /** A task row's context menu (right-click + kebab + keyboard twins; the
   *  app builds the honest task action set on the shared ContextMenu
   *  machinery -- same open/positioning/focus path as the session/log rows). */
  onTaskMenu: (e: MouseEvent | KeyboardEvent, task: TaskInfoWire, rowEl: HTMLElement) => void;
  onToggleSubagents: () => void;
  onSessionMenu: (e: MouseEvent | KeyboardEvent, session: SessionInfo, rowEl: HTMLElement) => void;
  onLogMenu: (e: MouseEvent | KeyboardEvent, logId: string, rowEl: HTMLElement) => void;
  /** Search panel state + handlers (header magnifier toggles `open`). */
  search: SearchState;
  searchInputRef: Ref;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onSearchQuery: (text: string) => void;
  onSearchKeydown: (e: KeyboardEvent) => void;
  /** Activate a hit: live → switchSession, cold → viewLog (app decides). */
  onActivateHit: (hit: SearchHitWire) => void;
  onResizeStart: (e: PointerEvent) => void;
  onResizeMove: (e: PointerEvent) => void;
  onResizeEnd: (e: PointerEvent) => void;
  onResizeKey: (e: KeyboardEvent) => void;
  onResizeReset: (e: MouseEvent) => void;
  /** The chevron at the right of the Recent Logs titlebar. */
  onToggleLogs: () => void;
  /** The same five gestures for the Recent Logs section, bound to its
   *  titlebar (drag anywhere on it but the collapse button; double-click
   *  resets the height; arrows resize it while it has keyboard focus). */
  onLogsResizeStart: (e: PointerEvent) => void;
  onLogsResizeMove: (e: PointerEvent) => void;
  onLogsResizeEnd: (e: PointerEvent) => void;
  onLogsResizeKey: (e: KeyboardEvent) => void;
  onLogsResizeReset: (e: MouseEvent) => void;
}

interface SidebarRowProps {
  /** Slab styling: "session-item" (live) or "log-item" (cold). */
  kindClass: string;
  /** Session/log id, echoed as data-sid so search activation can find the
   * row to scroll (see scrollHitIntoView). */
  sid: string;
  active: boolean;
  model?: string | null;
  /** Line-1 profile tag, dot-joined ahead of the model; omitted when absent.
   *  (Title no longer rides here: it got its own middle line.) */
  profile?: string | null;
  /** Middle line: the session title (derived or renamed), full value on the
   *  native title attribute since the line ellipsizes. Omitted outright when
   *  absent (the row stays two lines). */
  title?: string | null;
  /** Line-1 status badge: raw state token (working/idle/awaiting_question/
   *  interrupted/parked). Renders as a glyph badge (see styles .row-glyph)
   *  with the human label as native title; unknown tokens fall back to text.
   *  null/empty omits the segment. */
  status?: string | null;
  /** Optional color modifier for the status slot (cold-log derived states). */
  statusClass?: string;
  ctxUsed?: number;
  ctxTotal?: number;
  messageCount?: number;
  /** Live rows only; absent on cold logs (structurally 0 clients). Renders
   *  as the bottom-row plug icon, never a text metric (see styles
   *  .row-clients): aria-hidden decoration, the tooltip carries the figure. */
  connectedClients?: number;
  createdAt: number;
  /** Server pin flag: leads line-1 with a small badge (see styles .row-pin). */
  pinned?: boolean;
  /** Line-1 trailing action node (Stop / Resume); null omits the slot. */
  action?: JsxChild;
  onSelect: () => void;
  /** Right-click AND its keyboard twins (Menu key / Shift+F10, and the
   *  keyboard-fired contextmenu event). rowEl is the row element: the app
   *  anchors keyboard-opened menus on it and restores focus there on close. */
  onContextMenu?: (e: MouseEvent | KeyboardEvent, rowEl: HTMLElement) => void;
}

function rowClass(kindClass: string, active: boolean): string {
  return active ? `${kindClass} active` : kindClass;
}

/** Status tokens with a custom glyph (see .row-glyph-* in styles.css); the
 *  value is the badge's native title. Unlisted tokens render as text. */
const STATUS_GLYPHS: Record<string, string> = {
  working: "Working",
  idle: "Idle",
  awaiting_question: "Awaiting question",
  interrupted: "Interrupted",
  parked: "Parked",
};

/** Stable partition: pinned rows lead their section, everything else keeps
 *  the incoming order (sort is stable, so both halves stay untouched). */
export function sortPinned<T extends { id: string }>(rows: T[], pinned: Set<string>): T[] {
  return [...rows].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
}

/**
 * Scroll the sidebar row a search hit names into view (owner QoL
 * 2026-11-05): the click activates elsewhere, and the row can sit below the
 * fold of the list the search panel just re-mounted (opening search drops
 * the lists, so their scroll position is gone). Scoped to the list the hit
 * declares (live -> #session-list, cold -> #log-list), so an id present on
 * both sides scrolls the one the click opens. Missing row is a silent
 * no-op -- a session can end between the search and the click. "nearest"
 * keeps the scroll minimal: a visible row never moves. Returns the row it
 * revealed (null for the missing case) so the caller can hand it focus -- the
 * search hit that was just clicked unmounted with the panel.
 */
export function scrollHitIntoView(
  root: Document | Element,
  live: boolean,
  sid: string,
): HTMLElement | null {
  const el = root.querySelector(`#${live ? "session" : "log"}-list [data-sid="${sid}"]`);
  el?.scrollIntoView({ block: "nearest" });
  return (el as unknown as HTMLElement | null) ?? null;
}

/** One sidebar row in the shared grammar; the callers decide which slots exist. */
export function SidebarRow(p: SidebarRowProps) {
  const line1: JsxChild[] = [];
  if (p.pinned) line1.push(<span className="row-pin" title="Pinned">📌</span>);
  // Profile leads, dot-joined to the model; the sep rides only when both
  // halves exist (both-missing omits). The title is NOT here: it rides its
  // own middle line between this row and the metrics row.
  if (p.profile) line1.push(<span className="row-profile">{p.profile}</span>);
  if (p.profile && p.model) line1.push(<span className="row-sep">·</span>);
  if (p.model) line1.push(<span className="row-model">{p.model}</span>);
  if (p.status) {
    // Glyph badge when the token has a glyph, plain text when it doesn't;
    // the human label always rides as the native title (plug idiom).
    const hasGlyph = Object.hasOwn(STATUS_GLYPHS, p.status);
    const label = hasGlyph ? STATUS_GLYPHS[p.status] : p.status.replace(/_/g, " ");
    line1.push(
      <span
        className={p.statusClass ? `row-status ${p.statusClass}` : "row-status"}
        title={label}
        aria-hidden="true"
      >
        {hasGlyph ? <RowStatusGlyph status={p.status!} /> : label}
      </span>,
    );
  }
  if (p.action) line1.push(<span className="row-action row-action-right">{p.action}</span>);

  // Bottom row: date · ctx · msgs. The date always leads, so every metric
  // that rides gets a sep; unattested slots are omitted outright (legacy
  // logs: date · msgs). The live plug trails at the card's bottom-right
  // (row-action-right idiom, margin-left:auto): the inline plug glyph
  // (icons.tsx IconPlug) inside the decorated span (see .row-clients).
  // Rules: 0/unattested renders nothing; 1 is icon-only; 2+ rides the
  // number; the native title is the tooltip.
  const line3: JsxChild[] = [<span className="row-date">{formatDateTime(p.createdAt)}</span>];
  const ctx =
    p.ctxUsed != null
      ? `${formatTokenCount(p.ctxUsed)}${p.ctxTotal != null && Number.isFinite(p.ctxTotal) ? `/${formatTokenCount(p.ctxTotal)}` : ""}`
      : null;
  const msgs =
    p.messageCount != null && p.messageCount > 0
      ? `${p.messageCount} msg${p.messageCount > 1 ? "s" : ""}`
      : null;
  for (const part of [ctx, msgs]) {
    if (!part) continue;
    line3.push(<span className="row-sep">·</span>, <span className="row-metric">{part}</span>);
  }
  const clients = p.connectedClients ?? 0;
  if (clients > 0) {
    line3.push(
      <span
        className="row-clients"
        title={`${clients} client${clients === 1 ? "" : "s"} connected`}
        aria-hidden="true"
      >
        <IconPlug />
        {clients > 1 ? <span className="row-clients-count">{clients}</span> : null}
      </span>,
    );
  }
  // Visible twin of the right-click (owner: the affordance must be SEEABLE),
  // inline at the end of the metrics line -- trailing the client plug, never
  // its own row. Revealed on row hover/focus; belongs to the row, not the
  // selection (the click stops with the button). Anchor = the click point;
  // focus-return lands on the row.
  if (p.onContextMenu) {
    // Callback-ref handle to the mounted button (house escape hatch): the
    // click resolves the owning row from the DOM parent, not the event.
    let menuBtn: HTMLElement | null = null;
    line3.push(
      <button
        className="row-menu-btn"
        type="button"
        aria-label={p.kindClass === "log-item" ? "Log actions" : "Session actions"}
        title={p.kindClass === "log-item" ? "Log actions" : "Session actions"}
        ref={(el) => {
          if (el) menuBtn = el as unknown as HTMLElement;
        }}
        onClick={(e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          const row = (menuBtn?.parentElement?.parentElement ?? null) as HTMLElement | null;
          if (row) p.onContextMenu?.(e, row);
        }}
      >
        <IconKebab />
      </button>,
    );
  }

  return (
    <div
      className={rowClass(p.kindClass, p.active)}
      data-sid={p.sid}
      // Focusable list item (audit 1.2): the div carried click/contextmenu
      // listeners but no semantics, so rows were invisible to keyboards and
      // assistive tech. Enter/Space activate exactly what a left-click does;
      // the Menu key / Shift+F10 open exactly what a right-click opens.
      role="listitem"
      tabindex="0"
      // "Which row is on screen" rode only the accent border; a reader needs
      // it stated (aria-current on the active row of a role=list).
      aria-current={p.active ? "true" : undefined}
      onClick={p.onSelect}
      onKeydown={(e: KeyboardEvent) => {
        // Direct presses on the row itself only; keys landing on its own
        // buttons (Stop/Resume) belong to those buttons.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); // Space must not page-scroll while the row has focus
          p.onSelect();
        } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          p.onContextMenu?.(e, e.currentTarget as HTMLElement);
        }
      }}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        p.onContextMenu?.(e, e.currentTarget as HTMLElement);
      }}
    >
      <div className="row-l1">{line1}</div>
      {/* Middle line: the title, ellipsized with the full value on the
          native title; omitted outright when absent (two-line row). */}
      {p.title ? (
        <div className="row-l2" title={p.title}>
          {p.title}
        </div>
      ) : null}
      <div className="row-l3">{line3}</div>
    </div>
  );
}

/** Split `text` on every case-insensitive occurrence of `needle` and wrap
 *  each in <mark>. Whitespace inside a snippet is already collapsed to
 *  single spaces server-side (see makeSnippet in handlers-logs.ts). */
function highlightMatches(text: string, needle: string): JsxChild[] {
  if (!needle) return [text];
  const lower = text.toLowerCase();
  const out: JsxChild[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx < 0) {
      out.push(text.slice(i));
      break;
    }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(<mark className="search-mark">{text.slice(idx, idx + needle.length)}</mark>);
    i = idx + needle.length;
  }
  return out;
}

/** One search-result row. The grammar mirrors SidebarRow (profile/model dot
 *  join, date + match-count metrics), with the excerpt snippets trailing. */
function SearchHitRow(p: { hit: SearchHitWire; query: string; onActivate: () => void }) {
  const { hit } = p;
  const line1: JsxChild[] = [];
  const name = hit.profile || shortId(hit.logId);
  line1.push(<span className="row-profile">{name}</span>);
  if (hit.model) line1.push(<span className="row-sep">·</span>, <span className="row-model">{hit.model}</span>);
  // live/cold rides a quiet glyph-adjacent tag; the app opens it with the verb
  // this badge names, so it never lies about what a click will do.
  line1.push(
    <span className={`search-scope${hit.live ? " search-scope-live" : ""}`} title={hit.live ? "Live session" : "Archived log"}>
      {hit.live ? "live" : "log"}
    </span>,
  );

  const line3: JsxChild[] = [
    <span className="row-date">{formatDateTime(hit.lastActivityAt)}</span>,
    <span className="row-sep">·</span>,
    <span className="row-metric">
      {hit.matchCount} match{hit.matchCount === 1 ? "" : "es"}
    </span>,
  ];

  return (
    <div className="search-hit" onClick={p.onActivate} tabindex="0"
      onKeydown={(e: KeyboardEvent) => { if (e.key === "Enter") p.onActivate(); }}
    >
      <div className="row-l1">{line1}</div>
      <div className="row-l3">{line3}</div>
      {hit.snippets.map((s, i) => (
        <div key={i} className="search-snippet">{highlightMatches(s, p.query)}</div>
      ))}
    </div>
  );
}

/** Search panel: a filter-style input above a scrollable result list. Empty
 *  query is a client-side idle prompt (never sent to the server). */
function SearchPanel(p: {
  search: SearchState;
  inputRef: Ref;
  onQuery: (text: string) => void;
  onKeydown: (e: KeyboardEvent) => void;
  onClose: () => void;
  onActivate: (hit: SearchHitWire) => void;
}) {
  const { search } = p;
  let body: JsxChild;
  if (search.pending) {
    body = <div className="search-status">Searching…</div>;
  } else if (search.results === null) {
    body = <div className="search-status">Type to search all session logs.</div>;
  } else if (search.results.length === 0) {
    body = <div className="search-status">No logs match{search.query ? ` "${search.query}"` : ""}.</div>;
  } else {
    body = search.results.map((hit) => (
      <SearchHitRow key={hit.logId} hit={hit} query={search.query} onActivate={() => p.onActivate(hit)} />
    ));
  }
  return (
    <div id="search-panel">
      <div id="search-bar">
        <IconSearch size={14} className="search-bar-glyph" />
        <input
          id="search-input"
          type="text"
          placeholder="Search logs…"
          autocomplete="off"
          spellcheck="false"
          ref={p.inputRef}
          onInput={(e: Event) => p.onQuery((e.currentTarget as HTMLInputElement).value)}
          onKeydown={p.onKeydown}
        />
        <button id="search-clear" title="Close search (Esc)" onClick={p.onClose}>✕</button>
      </div>
      <div id="search-results">{body}</div>
    </div>
  );
}

export function Sidebar(p: SidebarProps) {
  return (
    <aside id="sidebar" className={p.logsCollapsed ? "logs-collapsed" : undefined}>
      <div className="sidebar-header">
        <h2>Sessions</h2>
        <div className="sidebar-header-actions">
          <button
            id="search-btn"
            title={p.search.open ? "Close search" : "Search logs"}
            aria-pressed={p.search.open}
            className={p.search.open ? "active" : undefined}
            onClick={() => (p.search.open ? p.onCloseSearch() : p.onOpenSearch())}
          >
            <IconSearch />
          </button>
          <button id="new-session-btn" title="New session" onClick={p.onCreate}>+</button>
        </div>
      </div>

      {p.search.open ? (
        <SearchPanel
          search={p.search}
          inputRef={p.searchInputRef}
          onQuery={p.onSearchQuery}
          onKeydown={p.onSearchKeydown}
          onClose={p.onCloseSearch}
          onActivate={p.onActivateHit}
        />
      ) : (
        <>
      <div id="session-list" role={p.sessions.length > 0 ? "list" : undefined}>
        {sortPinned(p.sessions, p.pinnedIds).flatMap((s) => {
          const isWorking = p.workingMap.get(s.id) ?? false;
          const owned = p.tasks.filter((t) => t.sessionId === s.id);
          return [
            <SidebarRow
              key={s.id}
              kindClass="session-item"
              sid={s.id}
              active={s.id === p.activeSessionId}
              pinned={p.pinnedIds.has(s.id)}
              model={s.model}
              profile={s.profile}
              title={s.title}
              // Idle omits the badge outright (the cold-log rule, now shared):
              // the resting state is the default. Working omits it too (owner
              // ruling 2026-11-05): the Stop button's spinner is the busy
              // tell; only a pending question speaks in this slot.
              status={s.questionPending ? "awaiting_question" : null}
              statusClass={s.questionPending ? "log-state-awaiting_question" : undefined}
              ctxUsed={s.ctxUsed}
              ctxTotal={s.ctxTotal}
              messageCount={s.messageCount}
              connectedClients={s.connectedClients}
              createdAt={s.createdAt}
              action={
                isWorking ? (
                  // The composer idiom: the spinner rides the Stop button
                  // itself (.spinner is currentColor-tracked, so it survives
                  // the hover flip), not the status badge.
                  <button
                    className="session-cancel-btn"
                    title="Stop"
                    onClick={(e: MouseEvent) => {
                      e.stopPropagation();
                      p.onCancel(s.id);
                    }}
                  >
                    <span className="spinner"></span>
                    Stop
                  </button>
                ) : null
              }
              onSelect={() => p.onSwitch(s.id)}
              onContextMenu={(e, rowEl) => p.onSessionMenu(e, s, rowEl)}
            />,
            // The collapsible Subagents section nests directly under the
            // manager card. Only the attached session ever owns rows: the
            // server scopes the task feed to it, so other cards honestly
            // show nothing rather than an empty section.
            owned.length > 0 ? (
              <SubagentsSection
                key={`${s.id}:subagents`}
                sid={s.id}
                tasks={owned}
                now={p.now}
                collapsed={p.subagentsCollapsed}
                viewedTaskId={p.viewedTaskId}
                onToggle={p.onToggleSubagents}
                onOpenTask={p.onOpenTask}
                onTaskMenu={p.onTaskMenu}
              />
            ) : null,
          ];
        })}
      </div>

      {/* Secondary header: the Recent Logs title, its collapse chevron, and
          the vertical drag handle for the list below. The seam logic lives in
          app.tsx; the titlebar is a focusable separator so the keyboard gets
          the same respect #sidebar-resize has (arrows resize, Home/End clamp).
          While collapsed there is no height to drag, so the handle semantics
          (role, tabindex, row-resize cursor) drop out entirely and the header
          is just a header again. */}
      <div
        className={
          p.logsCollapsed
            ? "sidebar-header sidebar-header-secondary"
            : "sidebar-header sidebar-header-secondary sidebar-header-resize"
        }
        role={p.logsCollapsed ? undefined : "separator"}
        aria-orientation={p.logsCollapsed ? undefined : "horizontal"}
        aria-label={p.logsCollapsed ? undefined : "Resize Recent Logs height"}
        aria-valuenow={p.logsCollapsed ? undefined : p.logsHeight}
        aria-valuemin={p.logsCollapsed ? undefined : p.logsMin}
        aria-valuemax={p.logsCollapsed ? undefined : p.logsMax}
        tabindex={p.logsCollapsed ? undefined : "0"}
        onPointerdown={p.onLogsResizeStart}
        onPointermove={p.onLogsResizeMove}
        onPointerup={p.onLogsResizeEnd}
        onPointercancel={p.onLogsResizeEnd}
        onKeydown={p.onLogsResizeKey}
        onDblclick={p.onLogsResizeReset}
      >
        <h2>Recent Logs</h2>
        {/* Chevron: down while expanded (click folds the list up), up while
            collapsed (click opens it back down). The button swallows its own
            pointerdown and dblclick, so a press on it is never a drag and a
            double-click on it is never a height reset. */}
        <button
          id="logs-toggle"
          type="button"
          aria-expanded={p.logsCollapsed ? "false" : "true"}
          aria-controls="log-list"
          aria-label={p.logsCollapsed ? "Expand recent logs" : "Collapse recent logs"}
          title={p.logsCollapsed ? "Expand recent logs" : "Collapse recent logs"}
          onClick={p.onToggleLogs}
          onPointerdown={(e: MouseEvent) => e.stopPropagation()}
          onDblclick={(e: MouseEvent) => e.stopPropagation()}
        >
          {/* The flip rides a rotation class on the chevron svg: -up turns
              the down-chevron 180 degrees. */}
          <IconChevron
            className={p.logsCollapsed ? "logs-toggle-glyph logs-toggle-glyph-up" : "logs-toggle-glyph"}
          />
        </button>
      </div>
      <div id="log-list" role={p.logs.length > 0 ? "list" : undefined}>
        {p.logs.length === 0 ? (
          <div
            className="log-empty"
            style={{ padding: "10px", "font-size": "0.75rem", color: "var(--text-muted)", "text-align": "center" }}
          >
            No recent logs
          </div>
        ) : (
          sortPinned(p.logs, p.pinnedIds).map((log) => (
            <SidebarRow
              key={log.id}
              kindClass="log-item"
              sid={log.id}
              active={log.id === p.activeLogId}
              pinned={p.pinnedIds.has(log.id)}
              model={log.model}
              profile={log.profile}
              title={log.title}
              // Derived index state badges the row (idle stays unbadged).
              status={log.state && log.state !== "idle" ? log.state : null}
              statusClass={log.state ? `log-state-${log.state}` : undefined}
              ctxUsed={log.ctxUsed}
              ctxTotal={log.ctxTotal}
              messageCount={log.messageCount}
              createdAt={log.createdAt}
              onSelect={() => p.onViewLog(log.id)}
              onContextMenu={(e, rowEl) => p.onLogMenu(e, log.id, rowEl)}
            />
          ))
        )}
      </div>
        </>
      )}

      {/* Drag/keyboard resize handle straddling the right border. The logic
          lives in app.tsx; hidden by CSS in the mobile drawer media query. */}
      <div
        id="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={p.sidebarWidth}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={p.sidebarMax}
        tabindex="0"
        onPointerdown={p.onResizeStart}
        onPointermove={p.onResizeMove}
        onPointerup={p.onResizeEnd}
        onPointercancel={p.onResizeEnd}
        onKeydown={p.onResizeKey}
        onDblclick={p.onResizeReset}
      />
    </aside>
  );
}

/** Pure viewport clamp for a fixed-positioned menu box anchored at (x, y)
 *  with size (w, h). A pointing event near the bottom or right edge would
 *  otherwise push the box offscreen; nudge it back inside the pad frame
 *  staying as close to the anchor as possible. A box larger than the
 *  viewport pins to the top-left pad. Geometry-only so the layout-free
 *  dom harness can pin every direction (same reasoning as panel-resize's
 *  env seam); the caller measures and applies. Zero rect (no layout)
 *  degrades to (pad, pad), the documented fallback. */
export function clampMenuAnchor(
  x: number,
  y: number,
  w: number,
  h: number,
  viewportWidth: number,
  viewportHeight: number,
  pad = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(pad, viewportWidth - w - pad);
  const maxTop = Math.max(pad, viewportHeight - h - pad);
  return {
    left: Math.min(Math.max(x, pad), maxLeft),
    top: Math.min(Math.max(y, pad), maxTop),
  };
}

/**
 * Row context menu (audit 1.2): a real WAI menu. role=menu/menuitem, arrow
 * keys move focus, Enter/Space activates (menuitems are divs -- no native
 * activation), Escape closes (the app's onClose returns focus to the row
 * that opened it). The app focuses the first item when the menu mounts, so
 * a keyboard-opened menu is operable without traversal, and Tab never has
 * to hunt items that sit at tabindex="-1".
 */
export function ContextMenu(props: {
  menu: ContextMenuState;
  rootRef: Ref;
  onClose: () => void;
}) {
  const onMenuKeydown = (e: KeyboardEvent): void => {
    const root = e.currentTarget as HTMLElement;
    const items = Array.from(root.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const n = items.length;
      const next =
        e.key === "Home" ? 0
        : e.key === "End" ? n - 1
        : e.key === "ArrowDown" ? (idx + 1) % n
        : (idx - 1 + n) % n;
      items[idx < 0 ? 0 : next]?.focus();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (e.key === "Tab") {
      // WAI menu: Tab dismisses and moves on. Deliberately NOT prevented:
      // traversal continues (the dismiss hands focus to the row, and the
      // browser advances from there). Without this, Tab would leave the
      // overlay mounted with focus wandering out of it.
      props.onClose();
    }
  };

  return (
    <div
      className="context-menu"
      role="menu"
      ref={props.rootRef}
      style={{ left: `${props.menu.x}px`, top: `${props.menu.y}px` }}
      onKeydown={onMenuKeydown}
    >
      {props.menu.items.map((it, i) => (
        <div
          key={i}
          role="menuitem"
          tabindex="-1"
          className={`context-menu-item${it.danger ? " context-menu-item-danger" : ""}`}
          onClick={it.onSelect}
          onKeydown={(e: KeyboardEvent) => {
            // Div menuitems get no native Enter/Space activation.
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              it.onSelect();
            }
          }}
        >
          {it.label}
        </div>
      ))}
    </div>
  );
}
