// Parented tool events -> indented inner rows (split mode only).
//
// The nested dispatcher emits the EXISTING tool_call/tool_result output
// events with an additive `parentToolCallId`. In split mode this view claims
// those events: instead of top-level rows they become `  ↳ read ✓ 12ms`
// rows under the open parent call -- open calls are live
// frame rows, and their elapsed tail needs no timer of its own: the frame
// re-reads the tree on every paint and the bridge's live-elapsed tick
// repaints once per second while a turn works, so the tail advances on the
// existing machinery. Finalized rows commit under the parent's own
// tool_result as ordinary content, through the sink's newline machinery.
//
// The legacy path never installs this view (runInteractiveSession wires it
// only when a bridge is mounted), and the wrapped sink methods delegate
// untouched for every UNPARENTED event, so legacy bytes -- and split bytes
// for parentless calls -- are exactly what they were. Skip-unknown is the
// posture: a missing/empty/non-string parent means "top-level, not mine"; a
// result whose call was never observed (an old-log cold replay, or the
// unavailable-name answer that skips tool_call) renders a finalized row with
// no duration claim instead of breaking; a result with no run at all commits
// immediately as one orphan row rather than strand a phantom tree until the
// next turn.

import type { CliOutputSink } from "@utils/cli/cli.ts";
import type { ToolCallEvent, ToolResultEvent } from "@core/context/output.ts";
import { toolContentSuccess } from "@utils/tool-content.ts";
import { spoofSafe } from "@utils/spoof.ts";
import { formatStatusCall, formatStatusElapsed } from "./split-bridge.ts";

/** Frame cap: the tree renders at most this many live rows, plus a tail
 *  line. Commits stay uncapped -- scrollback keeps every inner call. */
export const NESTED_MAX_FRAME_ROWS = 12;

/** Orphan-result dedupe bound: ids whose result landed without a call. */
const SEEN_RESULTS_MAX = 512;

const INDENT = "  ↳ ";

/** The attribution field, defensively: only a non-empty string parents. */
export function parentOf(event: unknown): string | null {
  const p = (event as { parentToolCallId?: unknown })?.parentToolCallId;
  return typeof p === "string" && p !== "" ? p : null;
}

interface InnerRow {
  id: string;
  name: string;
  done: boolean;
  ok: boolean;
  startMs: number;
  /** Finalized wall ms; null = unknown (a result never observed live). */
  ms: number | null;
}

/**
 * The three seams the session wires: a Clock-seam `now` (Date.now in the
 * session, scripted in tests), a frame `repaint`, and `commit` for orphan
 * history rows (through the sink pipeline, so separators and mode color land
 * like any other content).
 */
export interface NestedViewHost {
  now(): number;
  repaint(): void;
  commit(rows: string[]): void;
}

function formatNestedDuration(ms: number): string {
  const rounded = Math.max(0, Math.round(ms));
  return rounded < 1000 ? `${rounded}ms` : formatStatusCall(rounded);
}

/**
 * The live tree of inner calls, keyed by the parent call's toolCallId.
 * Rows finalize through onCall/onResult; the parent's tool_result (or the
 * turn ending) closes the tree.
 */
export class NestedRowsView {
  #runs = new Map<string, InnerRow[]>();
  #seenResults = new Set<string>();

  constructor(private readonly host: NestedViewHost) {}

  #rowText(row: InnerRow): string {
    const name = spoofSafe(row.name);
    if (!row.done) return `${INDENT}${name} ${formatStatusElapsed(this.host.now() - row.startMs)}`;
    const mark = row.ok ? "✓" : "✗";
    return row.ms === null
      ? `${INDENT}${name} ${mark}`
      : `${INDENT}${name} ${mark} ${formatNestedDuration(row.ms)}`;
  }

  /** The whole tree in call order (finalized rows styled, live rows
   *  ticking); null when there is nothing to draw -- cheap per-paint poll. */
  snapshot(): string[] | null {
    if (this.#runs.size === 0) return null;
    const all: string[] = [];
    for (const rows of this.#runs.values()) {
      for (const row of rows) all.push(this.#rowText(row));
    }
    if (all.length <= NESTED_MAX_FRAME_ROWS) return all;
    const hidden = all.length - NESTED_MAX_FRAME_ROWS;
    return [...all.slice(0, NESTED_MAX_FRAME_ROWS), `${INDENT}… (+${hidden} more)`];
  }

  onCall(parent: string, id: string, name: string): void {
    if (!id || this.#seenResults.has(id)) return;
    let run = this.#runs.get(parent);
    if (!run) {
      run = [];
      this.#runs.set(parent, run);
    }
    if (run.some((r) => r.id === id)) return;
    run.push({ id, name, done: false, ok: true, startMs: this.host.now(), ms: null });
    this.host.repaint();
  }

  onResult(parent: string, id: string, name: string, ok: boolean): void {
    if (!id) return;
    const run = this.#runs.get(parent);
    const row = run?.find((r) => r.id === id);
    if (run && row) {
      if (row.done) return; // late duplicate for an answered id: nothing to re-render
      row.done = true;
      row.ok = ok;
      row.ms = Math.max(0, this.host.now() - row.startMs);
      this.host.repaint();
      return;
    }
    if (this.#seenResults.has(id)) return;
    if (this.#seenResults.size >= SEEN_RESULTS_MAX) this.#seenResults.clear();
    // Call never observed: a cold-replay tail, or an answer that skips
    // tool_call (the unavailable-name path). Under a known run the row
    // joins the tree and commits with it at parent close; with no run at
    // all it is already history -- commit one orphan row now rather than
    // strand a phantom tree until the next turn.
    this.#seenResults.add(id);
    if (run) {
      run.push({ id, name, done: true, ok, startMs: 0, ms: null });
      this.host.repaint();
    } else {
      const mark = ok ? "✓" : "✗";
      this.host.commit([`${INDENT}${spoofSafe(name)} ${mark}`]);
    }
  }

  /**
   * The parent's tool_result landed: close the tree (still-open rows are
   * answered-without-result and close as ✗) and commit the finalized rows
   * unless the tool display is toggled off. Unknown parent: nothing to do.
   */
  closeRun(parent: string, commitRows: boolean): void {
    const run = this.#runs.get(parent);
    if (!run) return;
    this.#runs.delete(parent);
    if (run.length > 0 && commitRows) {
      this.host.commit(
        run.map((row) =>
          row.done ? this.#rowText(row) : `${INDENT}${spoofSafe(row.name)} ✗ (no result)`,
        ),
      );
    }
    this.host.repaint();
  }

  /** Turn over: live rows are a dead stream (nothing more will answer them). */
  clearAll(): void {
    if (this.#runs.size === 0) return;
    this.#runs.clear();
    this.host.repaint();
  }
}

/**
 * Split-mode interception (the ONLY byte-behavior seam): wrap the session
 * sink's tool-event methods so parented events render through the view and
 * every unparented event delegates untouched. The wrapper dies with the
 * session's sink; there is nothing to detach.
 */
export function attachNestedRows(sink: CliOutputSink, view: NestedRowsView): void {
  const baseCall = sink.emitToolCall.bind(sink);
  const baseResult = sink.emitToolResult.bind(sink);

  sink.emitToolCall = (event: ToolCallEvent): void => {
    const parent = parentOf(event);
    if (parent === null) return baseCall(event);
    if (sink.hideTools) return;
    view.onCall(parent, event.toolCallId ?? "", event.toolName ?? "(unknown)");
  };

  sink.emitToolResult = (event: ToolResultEvent): void => {
    const parent = parentOf(event);
    if (parent === null) {
      // The parent call is answering: its inner rows commit ABOVE the
      // result box, then the result renders untouched.
      view.closeRun(event.toolCallId ?? "", !sink.hideTools);
      return baseResult(event);
    }
    if (sink.hideTools) return;
    const failed = event.error !== undefined || !toolContentSuccess(event.content);
    view.onResult(parent, event.toolCallId ?? "", event.toolName ?? "(unknown)", !failed);
  };
}
