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
// stroke-SVG set through a CSS mask, tinted by currentColor, native title
// tooltip), profile as quiet muted text. Missing segments are omitted
// outright, never rendered empty; " · " (middle dot, U+00B7) is the segment
// separator between the slots the example dot-joins (the profile/model join
// dot rides only when both speak). The line-1 action pins right
// (margin-left:auto), no sep.
// The raw session id is not displayed at all: it stays the selection key,
// pin/export identifier and handler argument -- never card text.

import { formatTokenCount, SIDEBAR_MIN_WIDTH, shortId } from "./utils.ts";
import type { JsxChild, Ref } from "@utils/jsx";
import type { SearchHitWire } from "@extensions/websocket/protocol.ts";

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
  /** Sidebar row slots: the log record count (same rule as the cold rows'
   *  messageCount: every log record except system_prompt/reset) and the last
   *  token_usage snapshot. */
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
  onCreate: () => void;
  onSwitch: (sessionId: string) => void;
  onCancel: (sessionId: string) => void;
  onContinueLog: (logId: string) => void;
  onViewLog: (logId: string) => void;
  onSessionMenu: (e: MouseEvent, session: SessionInfo) => void;
  onLogMenu: (e: MouseEvent, logId: string) => void;
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
}

interface SidebarRowProps {
  /** Slab styling: "session-item" (live) or "log-item" (cold). */
  kindClass: string;
  active: boolean;
  model?: string | null;
  /** Line-1 profile tag: display name (title wins), dot-joined ahead of the
   *  model; omitted when neither set. */
  displayName?: string | null;
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
   *  as the bottom-row plug icon, never a text metric (see styles .row-clients). */
  connectedClients?: number;
  createdAt: number;
  /** Server pin flag: leads line-1 with a small badge (see styles .row-pin). */
  pinned?: boolean;
  /** Line-1 trailing action node (Stop / Resume); null omits the slot. */
  action?: JsxChild;
  onSelect: () => void;
  onContextMenu?: (e: MouseEvent) => void;
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

/** One sidebar row in the shared grammar; the callers decide which slots exist. */
export function SidebarRow(p: SidebarRowProps) {
  const line1: JsxChild[] = [];
  if (p.pinned) line1.push(<span className="row-pin" title="Pinned">📌</span>);
  // Profile leads, dot-joined to the model; the sep rides only when both
  // halves exist (title wins the profile slot, both-missing omits).
  if (p.displayName) line1.push(<span className="row-profile">{p.displayName}</span>);
  if (p.displayName && p.model) line1.push(<span className="row-sep">·</span>);
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
        tabindex="0"
      >
        {hasGlyph ? <span className={`row-glyph row-glyph-${p.status}`}></span> : label}
      </span>,
    );
  }
  if (p.action) line1.push(<span className="row-action row-action-right">{p.action}</span>);

  // Bottom row: date · ctx · msgs. The date always leads, so every metric
  // that rides gets a sep; unattested slots are omitted outright (legacy
  // logs: date · msgs). The live plug trails at the card's bottom-right
  // (row-action-right idiom, margin-left:auto): a CSS mask glyph (see
  // .row-clients in styles.css), no raw svg through the client mount.
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
        tabindex="0"
      >
        {clients > 1 ? <span className="row-clients-count">{clients}</span> : null}
      </span>,
    );
  }

  return (
    <div
      className={rowClass(p.kindClass, p.active)}
      onClick={p.onSelect}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        p.onContextMenu?.(e);
      }}
    >
      <div className="row-l1">{line1}</div>
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
        <span className="search-bar-glyph" aria-hidden="true"></span>
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
    <aside id="sidebar">
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
            <span className="search-btn-glyph" aria-hidden="true"></span>
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
      <div id="session-list">
        {sortPinned(p.sessions, p.pinnedIds).map((s) => {
          const isWorking = p.workingMap.get(s.id) ?? false;
          return (
            <SidebarRow
              key={s.id}
              kindClass="session-item"
              active={s.id === p.activeSessionId}
              pinned={p.pinnedIds.has(s.id)}
              model={s.model}
              displayName={s.title || s.profile}
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
              onContextMenu={(e) => p.onSessionMenu(e, s)}
            />
          );
        })}
      </div>

      <div className="sidebar-header sidebar-header-secondary">
        <h2>Recent Logs</h2>
      </div>
      <div id="log-list">
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
              active={log.id === p.activeLogId}
              pinned={p.pinnedIds.has(log.id)}
              model={log.model}
              displayName={log.profile}
              // Derived index state badges the row (idle stays unbadged).
              status={log.state && log.state !== "idle" ? log.state : null}
              statusClass={log.state ? `log-state-${log.state}` : undefined}
              ctxUsed={log.ctxUsed}
              ctxTotal={log.ctxTotal}
              messageCount={log.messageCount}
              createdAt={log.createdAt}
              action={
                <button
                  className="log-continue-btn"
                  title="Resume this session (keeps its session id)"
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    p.onContinueLog(log.id);
                  }}
                >
                  Resume
                </button>
              }
              onSelect={() => p.onViewLog(log.id)}
              onContextMenu={(e) => p.onLogMenu(e, log.id)}
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

export function ContextMenu(props: {
  menu: ContextMenuState;
  rootRef: Ref;
}) {
  return (
    <div
      className="context-menu"
      ref={props.rootRef}
      style={{ left: `${props.menu.x}px`, top: `${props.menu.y}px` }}
    >
      {props.menu.items.map((it, i) => (
        <div
          key={i}
          className={`context-menu-item${it.danger ? " context-menu-item-danger" : ""}`}
          onClick={it.onSelect}
        >
          {it.label}
        </div>
      ))}
    </div>
  );
}
