// Session browser: the /sessions picker for a mounted split-mode session.
// Row assembly, the two-tier filter glue, paging through the existing
// cursor grammar, pin flips through the webui's pin store, and Enter-resume
// through the EXISTING seams (Channel's /attach and /switch verbs for live
// rows; the launch-resume path -- sessionManager.swap into buildInteractiveAgent
// -- for cold logs). The pure row/selection/filter model lives beside popup
// in @utils/cli/renderer/list-picker.ts; this file owns the session policy.
//
// Inheritance rules (one implementation each, no second policy invented):
// - Row source is listSessionLogs (the core sidebar list); the worker/subagent
//   exclusion is the SAME attestation coldLogRows applies --
//   TaskManager.joinedAgentSessionIds, injected here so the seam stays pure.
// - The walk order and the [lastActivityAt, id] cursor are the webui RECENT
//   LOGS grammar verbatim: compareLogRowsDesc + isOlderThanCursor +
//   LOG_LIST_WINDOW, pinned rows lead and always ride the loaded set.
// - Corpus rows carry a snippet and match count (display-layer formatting,
//   the split the session index documents as "the caller's"); worker-attested
//   hits carry the webui search label "subagent of <desc>" when the sidecar
//   attests one, and nothing when it does not.
// - Cost rides only on a pre-attested number from costOf (modelPricing-gated
//   upstream); unattested columns are omitted, never invented.

import { formatError } from "@core/error.ts";
import { listSessionLogs } from "@core/session/session-log.ts";
import {
  getSessionEnrichRow,
  searchSessionCorpora,
  type SessionSearchMatch,
} from "@core/session/session-index.ts";
import {
  compareLogRowsDesc,
  MAX_SEARCH_HITS,
  SEARCH_SNIPPET_CONTEXT,
  type LogListCursorWire,
} from "@extensions/websocket/protocol.ts";
import { isOlderThanCursor } from "@extensions/websocket/handlers-logs.ts";
import { LOG_LIST_WINDOW } from "@extensions/websocket/history-window.ts";
import { isPinned, reloadPins, setPinned } from "@extensions/websocket/pin-store.ts";
import {
  ListPicker,
  LIST_PICKER_DEBOUNCE_MS,
  LIST_PICKER_MAX_ROWS,
  type PickerRow,
} from "@utils/cli/renderer/list-picker.ts";
import type { EditorView } from "@utils/cli/renderer/editor-view.ts";
import type { Clock } from "@utils/cli/renderer/seams.ts";

/** Cold-log state tokens get a word; idle says nothing and costs no cells. */
const STATE_WORDS: Record<string, string> = {
  awaiting_question: "awaiting question",
  interrupted: "interrupted",
  parked: "parked",
};

/** The webui row handle: the profile names the row, the short id backs it up
 *  (sessions.tsx `hit.profile || shortId(hit.logId)` grammar). */
export function rowHandle(id: string, profile?: string | null): string {
  return profile || id.slice(0, 8);
}

/**
 * The webui sidebar's current-year idiom (sessions.tsx formatDateTime):
 * "MM-DD HH:MM" when the stamp's year is the current one, "YYYY-MM-DD HH:MM"
 * otherwise, compared against the reading clock at format time.
 */
export function formatSessionStamp(ts: number, nowMs: number): string {
  const d = new Date(ts);
  const p = (n: number): string => n.toString().padStart(2, "0");
  const rest = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === new Date(nowMs).getFullYear() ? rest : `${d.getFullYear()}-${rest}`;
}

export interface BrowserRowDeps {
  /** Live registry sessions (core SessionManager projection). */
  liveSessions(): Array<{ id: string; model?: string; profile?: string }>;
  currentId(): string | null;
  /** Worker attestation (TaskManager.joinedAgentSessionIds). */
  joinedWorkers(): Promise<Set<string>>;
  /** Pre-attested cost string ("$0.42") or null; pricing gates it upstream. */
  costOf?(id: string): string | null;
  now(): number;
}

export interface BuiltRows {
  rows: PickerRow[];
  hasMore: boolean;
  /** [lastActivityAt, id] of the oldest UNPINNED loaded row (walk cursor). */
  cursor: LogListCursorWire | null;
}

interface MergedRow {
  id: string;
  lastActivityAt: number;
  pinned: boolean;
  /** A live registry session: always loaded, never paged out (its row is the
   *  one you came here to attach, and an unlogged fresh session stamps 0). */
  live: boolean;
  glyph: string;
  segments: string[];
}

function toPickerRow(r: MergedRow): PickerRow {
  const label = `${r.glyph} ${[...r.segments].join(" · ")}`;
  return { id: r.id, label, filterText: `${r.id} ${r.segments.join(" ")}` };
}

/**
 * One page of browser rows: live sessions merged with the durable index
 * (newest activity first, id DESC tie-break -- compareLogRowsDesc), keyed by
 * session id with LIVE winning the duplicate. Worker-attested logs are
 * excluded (the same joinedAgentSessionIds exclusion the webui list applies);
 * pinned rows lead and always load, the window walk runs over the unpinned
 * remainder, and `olderThan` pages strictly past the cursor the last frame
 * shipped -- the RECENT LOGS loadOlder grammar, not a second list API.
 */
export async function buildSessionRows(
  deps: BrowserRowDeps,
  opts: { olderThan?: LogListCursorWire | null; windowSize?: number } = {},
): Promise<BuiltRows> {
  const windowSize = Math.max(1, opts.windowSize ?? LOG_LIST_WINDOW);
  const logs = await listSessionLogs();
  const live = deps.liveSessions();
  const liveIds = new Set(live.map((s) => s.id));
  const joined = await deps.joinedWorkers();
  const currentId = deps.currentId();
  const now = deps.now();
  const logById = new Map(logs.map((l) => [l.id, l]));

  const rows: MergedRow[] = [];
  for (const s of live) {
    const log = logById.get(s.id);
    const enrich = getSessionEnrichRow(s.id);
    const segments = [rowHandle(s.id, s.profile)];
    if (isPinned(s.id)) segments.push("pinned");
    if (log) segments.push(formatSessionStamp(log.lastActivityAt, now));
    if (s.model) segments.push(s.model);
    if (log && log.messageCount > 0) segments.push(`${log.messageCount} msgs`);
    const cost = deps.costOf?.(s.id) ?? null;
    if (cost) segments.push(cost);
    if (enrich?.title) segments.push(enrich.title);
    segments.push(s.id === currentId ? "(current)" : "(live)");
    rows.push({
      id: s.id,
      lastActivityAt: log?.lastActivityAt ?? 0, // an unlogged fresh live row stamps 0
      pinned: isPinned(s.id),
      live: true,
      glyph: s.id === currentId ? "▶" : "●",
      segments,
    });
  }
  for (const log of logs) {
    // Live wins the duplicate; worker-attested logs stay hidden (the list
    // hides, the log stays addressable -- same posture as the webui).
    if (liveIds.has(log.id) || joined.has(log.id)) continue;
    const enrich = getSessionEnrichRow(log.id);
    const segments = [rowHandle(log.id, enrich?.profile)];
    if (isPinned(log.id)) segments.push("pinned");
    segments.push(formatSessionStamp(log.lastActivityAt, now));
    const state = enrich?.state ? STATE_WORDS[enrich.state] : undefined;
    if (state) segments.push(state);
    if (enrich?.model) segments.push(enrich.model);
    segments.push(`${log.messageCount} msgs`);
    const cost = deps.costOf?.(log.id) ?? null;
    if (cost) segments.push(cost);
    if (enrich?.title) segments.push(enrich.title);
    rows.push({
      id: log.id,
      lastActivityAt: log.lastActivityAt,
      pinned: isPinned(log.id),
      live: false,
      glyph: "·",
      segments,
    });
  }

  rows.sort(compareLogRowsDesc);
  // Pinned rows lead their list, relative order kept (the webui sortPinned
  // precedent). Live rows always ride the loaded set rather than the window:
  // an unlogged fresh session stamps 0, and a walk window that could cut it
  // off could page away the one row the browser exists to reach. The window
  // walk runs over what is neither pinned nor live.
  const pinned = rows.filter((r) => r.pinned);
  const liveRows = rows.filter((r) => !r.pinned && r.live);
  const walk = rows.filter((r) => !r.pinned && !r.live);
  const candidates = opts.olderThan
    ? walk.filter((r) => isOlderThanCursor(r, opts.olderThan!))
    : walk;
  const head = candidates.slice(0, windowSize);
  // First page: live rows merge back into the newest-first order (they lead
  // nothing beyond pinned). Cursor pages ship the walk's next slice only.
  const loaded = opts.olderThan ? head : [...liveRows, ...head].sort(compareLogRowsDesc);
  return {
    // Pinned rides the frame on the FIRST page only (olderThan null), where it
    // loads in full; a cursor page that re-emitted it would append duplicates
    // over the already-loaded list.
    rows: [...(opts.olderThan ? [] : pinned), ...loaded].map(toPickerRow),
    hasMore: candidates.length > head.length,
    cursor: head.length > 0 ? { lastActivityAt: head[head.length - 1]!.lastActivityAt, id: head[head.length - 1]!.id } : null,
  };
}

/** Count literal substring hits and cut a display window around the first.
 *  Same display grammar as the webui search (context chars each side,
 *  whitespace collapsed, ellipses at the cut edges). */
export function scanCorpus(
  text: string,
  needleLower: string,
): { count: number; snippet: string | null } {
  if (needleLower === "") return { count: 0, snippet: null };
  const lower = text.toLowerCase();
  let count = 0;
  let first = -1;
  let from = 0;
  for (;;) {
    const i = lower.indexOf(needleLower, from);
    if (i < 0) break;
    if (count === 0) first = i;
    count++;
    from = i + needleLower.length;
  }
  if (count === 0) return { count: 0, snippet: null };
  const start = Math.max(0, first - SEARCH_SNIPPET_CONTEXT);
  const end = Math.min(text.length, first + needleLower.length + SEARCH_SNIPPET_CONTEXT);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return {
    count,
    snippet: `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`,
  };
}

/**
 * Corpus matches -> picker rows (newest-first as searchSessionCorpora sorted
 * them). Capped at `cap` rows with `capped` surfacing the honest
 * "more matches; refine query" line; worker-attested hits carry
 * "subagent of <desc>" where the sidecar/task registry attests a description
 * (the webui search-label precedent), and no description means no claim.
 */
export function searchCorpusRows(
  matches: SessionSearchMatch[],
  query: string,
  opts: {
    cap: number;
    joined: Set<string>;
    descriptions: Map<string, string>;
    now(): number;
  },
): { rows: PickerRow[]; capped: boolean } {
  const capped = matches.length > opts.cap;
  const rows: PickerRow[] = [];
  for (const m of matches.slice(0, opts.cap)) {
    const { count, snippet } = scanCorpus(m.text, query.toLowerCase());
    if (count === 0) continue; // the mirror moved under us; nothing to show
    const desc = opts.joined.has(m.sessionId) ? opts.descriptions.get(m.sessionId) : undefined;
    const segments = [
      rowHandle(m.sessionId, m.profile),
      formatSessionStamp(m.lastActivityAt, opts.now()),
      `${count} match${count === 1 ? "" : "es"}`,
    ];
    if (m.model) segments.push(m.model);
    if (desc) segments.push(`subagent of ${desc}`);
    rows.push({
      id: m.sessionId,
      label: `· ${segments.join(" · ")}`,
      ...(snippet ? { detail: snippet } : {}),
      filterText: `${m.sessionId} ${m.model ?? ""} ${m.profile ?? ""}`,
    });
  }
  return { rows, capped };
}

/** The live-row activation seams: Channel's public /attach and /switch
 *  paths (the same handlers the typed commands run), kept narrow for tests. */
export interface LiveActivator {
  isLive(id: string): boolean;
  isAttached(id: string): boolean;
  attach(id: string): Promise<void>;
  switchTo(id: string): Promise<void>;
}

export interface SessionBrowserDeps extends BrowserRowDeps {
  /** Worker-hit labels: sidecar lineage UNION this lifetime's task registry
   *  (the grammar searchSessionLogs uses for the subagentOf field). */
  taskDescriptions(): Promise<Map<string, string>>;
  search(query: string): Promise<SessionSearchMatch[]>;
  /** Cold resume: the launch-resume path, driven in-process (swap into the
   *  same buildInteractiveAgent that boots a --session-id launch). */
  resumeCold(id: string): Promise<void>;
  /**
   * True while the CURRENT session has a turn in flight. A cold resume swaps
   * the session, and `swap` -- unlike `forkSession` -- carries no running
   * guard: resuming mid-turn would abandon a turn whose output nobody is
   * subscribed to any more, so the browser refuses it and says why. Live
   * attach/switch stay allowed, exactly as the typed /switch always did.
   */
  currentRunning?(): boolean;
  activator: LiveActivator;
  clock: Clock;
  /** Honest plain-text line (transcript channel). */
  output(text: string): void;
  /** The mounted editor view, or null (no editor, no picker). */
  editor(): EditorView | null;
  /** Install/clear the bridge paint source and ask for a repaint. */
  paintRows(source: ((width: number) => string[]) | null): void;
  repaint(): void;
  windowSize?: number;
  searchCap?: number;
  /** Frame rows the picker may paint (short terminals pass a smaller set). */
  maxRows?: number;
}

/**
 * Build the /sessions hook (installed as Channel.sessionBrowser). Opening
 * re-reads pins fresh (the pin-store cache would otherwise serve a long-lived
 * process a stale view of pins flipped by the webui daemon), loads the head
 * page, and mounts the picker over the frame.
 *
 * Answers false -- so handleSessions falls back to the plain-text list and the
 * keypress is never swallowed -- when no editor is mounted or the open-time
 * reads fail (the failure says so on the transcript channel, and no half-built
 * session survives it). Enter on a cold log is refused while the current
 * session still runs, because the resume swaps the session away mid-turn.
 */
export function createSessionBrowser(deps: SessionBrowserDeps): () => Promise<boolean> {
  interface Session {
    picker: ListPicker | null;
    view: EditorView;
    joined: Set<string>;
    descriptions: Map<string, string>;
    primary: PickerRow[];
    cursor: LogListCursorWire | null;
  }
  let session: Session | null = null;

  const close = (): void => {
    if (!session) return;
    const s = session;
    session = null;
    s.picker?.close();
    if (s.view.overlay) s.view.overlay = null;
    deps.paintRows(null);
    deps.repaint();
  };

  const openLive = async (id: string): Promise<void> => {
    if (!deps.activator.isAttached(id)) await deps.activator.attach(id);
    if (deps.currentId() !== id) await deps.activator.switchTo(id);
  };

  return async function open(): Promise<boolean> {
    if (session) return true; // one browser at a time
    const view = deps.editor();
    if (!view) return false;

    // Opening reads the world the rows are attested from. A throw here is
    // reported and hands the command back: Channel still prints its plain
    // list, so a broken index never swallows the keypress into silence.
    let joined: Set<string>;
    let descriptions: Map<string, string>;
    try {
      reloadPins(); // fresh pins off disk: the store caches by path otherwise
      joined = await deps.joinedWorkers();
      descriptions = await deps.taskDescriptions();
    } catch (e: unknown) {
      deps.output(`Session browser unavailable: ${formatError(e)}`);
      return false;
    }

    const s: Session = {
      picker: null,
      view,
      joined,
      descriptions,
      primary: [],
      cursor: null,
    };
    const picker = new ListPicker({
      clock: deps.clock,
      maxRows: deps.maxRows ?? LIST_PICKER_MAX_ROWS,
      debounceMs: LIST_PICKER_DEBOUNCE_MS,
      copy: {
        idle: "sessions  type to filter - enter open - p pin - esc close",
        empty: "no sessions to show",
        noMatch: (q) => `no match for "${q}" - searches conversation text, not tool output`,
        separator: "-- conversation matches --",
        searching: "searching conversation text...",
      },
      events: {
        onChange: () => deps.repaint(),
        onClose: close,
        onAccept: (row) => {
          if (row.id === deps.currentId()) {
            // The marked row is the one you are typing in: a refused no-op,
            // plainly said, picker down, nothing moved.
            close();
            deps.output(`Already on session ${row.id}; nothing to switch.`);
            return;
          }
          if (deps.activator.isLive(row.id)) {
            close();
            void openLive(row.id).catch((e: unknown) => deps.output(formatError(e)));
            return;
          }
          if (deps.currentRunning?.()) {
            // A cold resume swaps the session, and swap carries no running
            // guard: this would abandon a turn whose output nobody would be
            // subscribed to any more. Refused, plainly said, list stays up.
            deps.output(
              `Cannot resume ${row.id}: this session is still running. ` +
                "Esc closes this browser so Ctrl-C can interrupt the turn, " +
                "or wait for it to end.",
            );
            return;
          }
          close();
          void deps.resumeCold(row.id).catch((e: unknown) => deps.output(formatError(e)));
        },
        onPin: (row) => {
          if (s.joined.has(row.id)) {
            // The webui prunes pins on excluded rows; silently accepting a
            // pin the next webui list would drop is a claim that dies later.
            deps.output(`Pin refused: ${row.id} is a subagent log, it is not a listable row.`);
            return;
          }
          // setPinned updates the store's own set AND persists it; no re-read
          // here, because the store keeps the in-memory set authoritative when
          // a write fails. The next open() re-reads and sees the webui's flips.
          setPinned(row.id, !isPinned(row.id));
          // The rebuild re-reads the log list, so it can fail after the flip
          // already took: report it on the transcript like every other async
          // path here does, instead of leaving an unhandled rejection that
          // makes a pin that landed look ignored.
          void refresh().catch((e: unknown) => deps.output(formatError(e)));
        },
        onNeedMore: () => {
          void (async () => {
            const built = await buildSessionRows(deps, {
              olderThan: s.cursor,
              windowSize: deps.windowSize,
            });
            if (built.rows.length === 0) {
              // The walk is exhausted (rows vanished mid-session): honest end,
              // no cursor echo, the needMore latch clears with setPrimary.
              picker.setMore(false);
              picker.setPrimary([...s.primary]);
              return;
            }
            s.primary.push(...built.rows);
            if (built.cursor) s.cursor = built.cursor;
            picker.setMore(built.hasMore);
            picker.setPrimary([...s.primary]);
          })().catch((e: unknown) => deps.output(formatError(e)));
        },
        onCorpusQuery: (query, seq) => {
          void deps
            .search(query)
            .then((matches) => {
              const built = searchCorpusRows(matches, query, {
                cap: deps.searchCap ?? MAX_SEARCH_HITS,
                joined: s.joined,
                descriptions: s.descriptions,
                now: deps.now,
              });
              // Stale (seq moved on / picker closed): applyCorpus drops it
              // WITHOUT a repaint, so the list never shows a query you no
              // longer typed. The footer is derived state: it follows the
              // ACCEPTANCE, or a late reply would write its cap/failure claim
              // under a query it no longer answers (and repaint for nothing).
              if (picker.applyCorpus(seq, built.rows)) {
                picker.setFooter(built.capped ? "more matches; refine query" : null);
              }
            })
            .catch((e: unknown) => {
              if (picker.applyCorpus(seq, [])) {
                picker.setFooter(`search failed: ${formatError(e)}`);
              }
            });
        },
      },
    });
    s.picker = picker;

    const refresh = async (): Promise<void> => {
      const built = await buildSessionRows(deps, { olderThan: null, windowSize: deps.windowSize });
      s.primary = built.rows;
      s.cursor = built.cursor;
      picker.setMore(built.hasMore);
      picker.setPrimary(built.rows);
    };

    session = s;
    try {
      await refresh();
    } catch (e: unknown) {
      // Same posture as the load above -- and the teardown matters doubly here:
      // leaving `session` set without an overlay would make every later
      // /sessions answer "already open" on a screen showing nothing.
      close();
      deps.output(`Session browser unavailable: ${formatError(e)}`);
      return false;
    }
    if (session !== s) return true; // closed underneath the load (quit path)
    view.overlay = (e) => picker.handleKey(e);
    deps.paintRows((width) => picker.renderRows(width));
    deps.repaint();
    return true;
  };
}

/** Production wiring default: the core corpus seam. */
export const defaultSearch = (query: string): Promise<SessionSearchMatch[]> =>
  searchSessionCorpora(query);
