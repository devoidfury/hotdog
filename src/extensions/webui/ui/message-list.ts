/// <reference lib="dom" />
// Per-session message list: renders OUTPUT_EVENTs, incl. streaming markdown.

import { sanitize, resolveQuestionAnswer, formatTokenCount, formatClock, formatDuration, formatCallDuration, copyText } from "./utils.ts";
import {
  parseMarkdown,
  mdTreeToHtml,
  renderBlocksToHtml,
  createStreamingParser,
  type StreamingMdParser,
  type FeedResult,
  type MdDocument,
} from "@utils/md-parser.ts";
import { toolContentText, wrapperContentText, splitFileIncludes } from "@utils/tool-content.ts";
import { ctxByIndex, deriveCallDurationsByIndex, parseEntryTs, turnFinalDurationsByIndex, type CtxUsage } from "@utils/session-turns.ts";
import { ToolBlockController, type ToolDisplayWire } from "./tool-block.tsx";
import type { DomNode } from "@utils/jsx";

// Debug instrumentation, enabled with ?debug=1 in the URL.
const DEBUG = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");
let _debugSeq = 0;

function dbg(label: string, data: Record<string, unknown>): void {
  if (!DEBUG) return;
  console.log(`[streaming #${_debugSeq++}] ${label}`, data);
}

function dbgTree(label: string, tree: MdDocument): void {
  if (!DEBUG) return;
  const summary = tree.children.map((b, i) => {
    if (b.type === "code_block") {
      const cb = b as { type: "code_block"; content: string };
      return `[${i}] ${b.type}(${cb.content.slice(0, 30).replace(/\n/g, "\\n")})`;
    }
    if (b.type === "paragraph") {
      const p = b as { type: "paragraph"; children: { type: string; content?: string }[] };
      const text = p.children
        .filter((c) => c.type === "text")
        .map((c) => (c as { content: string }).content)
        .join(" ")
        .slice(0, 40);
      return `[${i}] ${b.type}(${text})`;
    }
    return `[${i}] ${b.type}`;
  }).join(" | ");
  console.log(`[streaming #${_debugSeq++}] ${label}  blocks=${tree.children.length}  ${summary}`);
}

// Image payload on the wire (see wireImages in @extensions/websocket/
// protocol.ts): base64 without data: prefix; oversized images arrive as
// { skipped, note } with no data.
export interface UiImage {
  mimeType: string;
  data?: string;
  skipped?: boolean;
  note?: string;
}

interface UserMessage { content: string; images?: UiImage[]; files?: Array<{ path: string; content: string }>; }
/**
 * A committed assistant message. The optional footer meta is data the wire
 * path carries: `ts` (epoch ms, when the message completed), `durationMs`
 * (the wall-clock duration of the TURN that produced it), `ctx` (the token
 * usage attested at this message's commit; replay fills it from the log's
 * token_usage records, live frames leave it off and the client folds in the
 * live TOKEN_USAGE events it observes), and the producing LLM CALL's own
 * wall time `callMs` -- the recorded duration on the usage record first,
 * else the strict-adjacency log-gap derivation, which `callDerived: true`
 * then marks so the tooltip says so (a derived number never presents as
 * recorded). Absent fields are omitted from the footer, never invented.
 * `content` may be empty: a response with no text (tool calls and/or
 * reasoning only) still sends its frame so the per-response bar lands --
 * without a copy button (nothing to copy), and not at all without a
 * trustworthy ts.
 */
interface AssistantMessage {
  content: string;
  ts?: number;
  durationMs?: number;
  ctx?: CtxUsage;
  callMs?: number;
  callDerived?: boolean;
}
interface StreamingChunk { content: string; }
interface ThinkingMessage { content: string; }
interface ToolCallMessage { name: string; args: string; argsSummary?: string; display?: ToolDisplayWire[]; toolCallId?: string; }
interface ToolResultMessage { name: string; output?: string; error?: string; images?: UiImage[]; toolCallId?: string; }
interface CompactingMessage { message: string; }
interface CommandResultMessage { content: string; }

// Log entry as returned by the server's logViewed message.
// `content` may be raw content parts (harness messages); flatten via wrapperContentText().
interface LogEntry {
  source: string;
  /** Entry timestamp (ISO). Legacy entries may lack it -- then no footer. */
  ts?: string;
  content: string | Array<Record<string, unknown>>;
  images?: UiImage[];
  reasoning_content?: string | null;
  /** llm records store the provider wire object ({function:{name,
   *  arguments}} with arguments as a JSON string); the older flattened
   *  {name, args} shape stays accepted. */
  tool_calls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
    arguments?: string;
    function?: { name?: string; arguments?: string };
    /** Registry-resolved display parts the server annotated onto the raw
     *  entry (additive per-call field; cold logs then render exactly like
     *  live frames -- same specs, same posture code path). */
    display?: ToolDisplayWire[];
  }> | null;
  tool_call_id?: string | null;
  /** token_usage records (ctx segment source for the cold-log footer): the
   *  server forwards raw entries, so the same ctxByIndex derivation the
   *  websocket replay runs can run here too. Absent on non-usage entries. */
  totalTokens?: number;
  contextWindow?: number;
  cachedTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
}

interface QuestionOption {
  key?: string;
  message?: string;
  prompt?: string;
  options?: string[];
  default?: string;
  required?: boolean;
  allowOther?: boolean;
}
interface QuestionMessage { questions: QuestionOption[]; }
interface QuestionAnsweredMessage {
  sessionId?: string;
  answers: Record<string, string>;
}
/** Question fields after normalizing aliases and defaults. */
interface NormalizedQuestion {
  key: string;
  prompt: string;
  options: string[];
  default?: string;
  required?: boolean;
  allowOther?: boolean;
}

interface TaskProgressMessage { taskId: string; status: string; message?: string; }

/**
 * Live TOKEN_USAGE wire frame. The per-call numbers (prompt is net of cache,
 * see TokenTracker) plus the gauge pair the server derives additively in
 * s2cTokenUsage: ctxUsed (the call's totalTokens) / ctxTotal (context
 * window), and durationMs (the producing call's own measured span). The
 * frame no longer renders its own transcript bubble: its data folds into
 * the footer's ctx segment and per-call duration segment.
 */
interface TokenUsageMessage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow?: number;
  ctxUsed?: number;
  ctxTotal?: number;
  durationMs?: number;
}

interface CompactionResultMessage { summary?: string; messagesCompacted: number; }
interface SessionStateMessage { key: string; value: string | string[] | boolean | number; }
interface ErrorMessage { message: string; }

interface MessageListOptions {
  hideThinking?: boolean;
  /** When set, question messages render as an interactive form. */
  onQuestionAnswer?: (answers: Record<string, string>) => void;
}

export interface MessageListManager {
  handleUserMessage: (data: UserMessage) => void;
  handleAssistantMessage: (data: AssistantMessage) => void;
  handleStreamingChunk: (data: StreamingChunk) => void;
  handleStreamingReasoningChunk: (data: StreamingChunk) => void;
  /** Mid-stream provider-failure retry: drop the in-flight text/thinking
   * accumulators so the retry's deltas render into fresh renderers. */
  handleStreamReset: () => void;
  handleThinking: (data: ThinkingMessage) => void;
  handleToolCall: (data: ToolCallMessage) => void;
  handleToolResult: (data: ToolResultMessage) => void;
  handleCompacting: (data: CompactingMessage) => void;
  handleCommandResult: (data: CommandResultMessage) => void;
  handleQuestion: (data: QuestionMessage) => void;
  handleQuestionAnswered: (data: QuestionAnsweredMessage) => void;
  handleTaskProgress: (data: TaskProgressMessage) => void;
  handleTokenUsage: (data: TokenUsageMessage) => void;
  handleCompactionResult: (data: CompactionResultMessage) => void;
  handleSessionState: (data: SessionStateMessage) => void;
  /**
   * Programmatic visibility switch for this view (the webui's per-browser
   * reasoning toggle). Same engine as the `hideThinking` session state above,
   * but driven by the client: sweeps every thinking block, in-flight or
   * finalized.
   */
  setHideThinking: (hide: boolean) => void;
  handleError: (data: ErrorMessage) => void;
  /**
   * Close the in-flight streaming row. Pass `end` when the row committed as
   * a COMPLETED message (turn end / tool boundary): the footer (timestamp +
   * copy, with the ctx gauge and duration when known) rides the completion,
   * and a text-less completed response (usage attested, no text streamed)
   * gets its bar with no copy button. Quiet closes (interruption, error)
   * take nothing and render no footer.
   */
  finalizeAssistant: (end?: { ts: number; durationMs?: number; ctx?: CtxUsage; callMs?: number }) => void;
  /** Turn boundary from the session's "working" state (live turn clock). */
  noteWorking: (active: boolean) => void;
  clear: () => void;
  /** Append a system notice (e.g. profile switched). Input must be a trusted display name. */
  addSystemMessage: (text: string) => void;
  /** Render a server system message (profile switched, tool-call repair notices, ...). */
  handleSystemMessage: (data: { content?: string; files?: Array<{ path: string; content: string }> }) => void;
  /** Detach the container's scroll listener. The #message-list div outlives the chat across logins, so the owner must call this before dropping the manager. */
  destroy: () => void;
  /** Render a batch of session log entries (for viewing cold session logs). */
  renderLogEntries: (entries: LogEntry[]) => void;
}

export function createMessageList(
  container: HTMLElement,
  { hideThinking = false, onQuestionAnswer }: MessageListOptions = {},
): MessageListManager {
  let currentAssistantEl: HTMLDivElement | null = null;
  let currentThinkingEl: HTMLDivElement | null = null;
  // Tool-call/result pairing: by tool-call id when the wire carries one,
  // else the oldest unresolved call with the same name (id-less log replay).
  const toolBlocksById = new Map<string, ToolBlockController>();
  const pendingToolCallsByName = new Map<string, ToolBlockController[]>();
  let hasToolCallsSinceLastAssistant = false;
  let hideThinkingValue = hideThinking;

  let streamingParser: StreamingMdParser | null = null;
  let thinkingParser: StreamingMdParser | null = null;
  let streamingBlockCount = 0;
  let thinkingBlockCount = 0;

  // Raw markdown of the in-flight streaming row: the footer's copy source.
  // The DOM holds rendered blocks; the copy button must hand out the wire text.
  let currentAssistantRaw = "";

  // Live turn clock, driven by the session's "working" edges (the live wire's
  // turn-start/turn-end counterpart). The FIRST report a view sees is baseline
  // only: attaching mid-turn knows a turn is running but not when it started,
  // and measuring from the attach would print a duration smaller than the
  // truth. Only false->true edges after the baseline get clocked; an unclocked
  // turn end renders no duration segment.
  let turnStartMs: number | null = null;
  let workingBaseline = false;

  // Latest ctx usage attested since the current turn opened, folded into
  // the footer's gauge segment at the next commit. Filled by the TOKEN_USAGE
  // frames of this turn (the same events the server caches for the sidebar
  // gauge, and via the same ctxUsed/ctxTotal pair), so the footer echoes the
  // gauge instead of re-deriving it. Reset on every working edge: usage
  // observed BEFORE this view started watching a turn (replay burst of a
  // previous turn, attach mid-turn) must never stamp this turn's footer.
  let lastTurnCtx: CtxUsage | undefined;

  // Wall time of the LLM call behind the in-flight/last-committed row, from
  // the same TOKEN_USAGE frames (their durationMs, the agent's measured
  // span). Held beside the ctx pair and folded into the footer's call
  // segment at the next commit; reset on every working edge, same
  // attribution rule: an unobserved duration renders nothing.
  let lastTurnCallMs: number | undefined;

  // One bar per response: the TOKEN_USAGE frame is the marker that an LLM
  // response completed (agent.ts emits it once per call, right after
  // addMessage and -- ordered sink -- before that call's tool frames).
  // Every commit consumes it; a completed commit with no text row in flight
  // renders the bar on its own (no copy button: nothing to copy), so a
  // tool-only/reasoning-only response still gets its bar + gauge update.
  // TOOL_RESULT frames clear it: in log replay the usage record lands
  // BEFORE the next entry's tool frames, and a stale flag must never stamp
  // a later response. Providers that report no usage emit no frame: their
  // text-less responses honestly have no per-response bar to show.
  let usageAwaitingBar = false;

  // The most recently rendered footer row + whether its "Worked for" turn
  // total already rode it. A turn closing with a measured duration attaches
  // the total to the last bar when that bar landed mid-turn (tool round,
  // then stop). Turn start clears this so a bar from an earlier turn (or a
  // replayed log) never claims the new turn's duration.
  let lastBar: HTMLElement | null = null;
  let lastBarWorked = false;

  /**
   * Turn boundary from the session's "working" state. False finalizes the
   * in-flight row as a COMPLETED assistant message: the footer (client-clock
   * timestamp, plus the measured turn duration when this view saw the turn
   * start, plus the turn's last attested ctx usage and call duration) rides
   * that commit, never a per-delta update.
   */
  function noteWorking(active: boolean): void {
    if (active) {
      if (workingBaseline && turnStartMs === null) turnStartMs = Date.now();
      workingBaseline = true;
      lastTurnCtx = undefined;
      lastTurnCallMs = undefined;
      usageAwaitingBar = false;
      lastBar = null;
      lastBarWorked = false;
      return;
    }
    // The very first report (idle attach): this view observed no turn, so a
    // usage flag left behind by the replay burst must never render a bar --
    // only a real turn end consumes the flag. A flushed in-flight row
    // (mid-turn attach) still commits honestly here.
    const wasFirstReport = !workingBaseline;
    workingBaseline = true;
    if (wasFirstReport) usageAwaitingBar = false;
    const durationMs = turnStartMs !== null ? Date.now() - turnStartMs : undefined;
    turnStartMs = null;
    finalizeAssistant({ ts: Date.now(), durationMs, ctx: lastTurnCtx, callMs: lastTurnCallMs });
    // The turn closed on a tool/reasoning round: the final response's bar
    // landed at the tool boundary with no duration (the turn was still
    // open). The wall-clock total is known now -- attach it there, so the
    // stopped row carries "Worked for X" like any completed final row.
    if (durationMs !== undefined && lastBar && !lastBarWorked) {
      appendWorkedSegment(lastBar, durationMs);
      lastBarWorked = true;
    }
    lastTurnCtx = undefined;
    lastTurnCallMs = undefined;
  }

  function ensureAssistantEl(): HTMLDivElement {
    if (!currentAssistantEl) {
      currentAssistantEl = document.createElement("div");
      currentAssistantEl.className = "message assistant streaming";

      const bubble = document.createElement("div");
      const contentEl = document.createElement("div");
      contentEl.className = "content md-content";
      bubble.appendChild(contentEl);
      currentAssistantEl.appendChild(bubble);

      container.appendChild(currentAssistantEl);
    }
    return currentAssistantEl;
  }

  function ensureThinkingEl(): HTMLDivElement {
    if (!currentThinkingEl) {
      currentThinkingEl = document.createElement("div");
      currentThinkingEl.className = "thinking-block md-content";
      if (hideThinkingValue) currentThinkingEl.classList.add("hidden");
      container.appendChild(currentThinkingEl);
    }
    return currentThinkingEl;
  }

  /**
   * Flip reasoning visibility for this view. Sweeps EVERY .thinking-block in
   * the container: the in-flight row and the finalized ones alike (the toggle
   * used to touch only `currentThinkingEl`, so blocks committed before the
   * click stayed in their old state -- history stayed visible after a "hide").
   * Creation-time honoring in `ensureThinkingEl` is unchanged: blocks that
   * arrive after a flip are born with the right class.
   */
  function setHideThinking(v: boolean): void {
    hideThinkingValue = v;
    // forEach (not a for..of spread): NodeList iteration needs dom.iterable,
    // which the src build does not pull in.
    container.querySelectorAll(".thinking-block").forEach((el) => {
      el.classList.toggle("hidden", v);
    });
  }

  /**
   * Incrementally update a content div's DOM from a streaming feed result.
   * Only re-renders blocks from `stableFrom` onward, leaving the stable
   * prefix untouched so the browser doesn't reflow the entire message.
   *
   * @param contentDiv — The target .content div
   * @param result — The FeedResult from StreamingMdParser.feed()
   * @param blockCountRef — Mutable ref tracking current rendered block count
   */
  function updateMdDom(
    contentDiv: HTMLDivElement,
    result: FeedResult,
    blockCountRef: { count: number },
  ): void {
    const { tree, stableFrom } = result;
    const totalBlocks = tree.children.length;

    const effectiveStable = Math.min(stableFrom, blockCountRef.count);

    dbg("updateMdDom", {
      stableFrom,
      prevBlockCount: blockCountRef.count,
      totalBlocks,
      effectiveStable,
      willRemove: blockCountRef.count - effectiveStable,
      willRender: Math.max(0, totalBlocks - effectiveStable),
    });
    dbgTree("updateMdDom tree", tree);

    let removed = 0;
    for (let i = effectiveStable; i < blockCountRef.count; i++) {
      const el = contentDiv.querySelector(`[data-block-index="${i}"]`);
      if (el) { el.remove(); removed++; }
    }

    let rendered = 0;
    if (effectiveStable < totalBlocks) {
      const html = renderBlocksToHtml(tree, effectiveStable);
      const fragment = document.createDocumentFragment();
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      while (wrapper.firstChild) {
        fragment.appendChild(wrapper.firstChild);
      }

      // Index each block so future diffs can target it.
      const newStart = effectiveStable;
      const children = Array.from(fragment.children);
      for (let i = 0; i < children.length; i++) {
        (children[i] as HTMLElement).dataset.blockIndex = String(newStart + i);
      }

      contentDiv.appendChild(fragment);
      rendered = children.length;
      blockCountRef.count = newStart + children.length;
    }
    // Always sync the count to the actual tree size so that when the
    // tree shrinks (e.g. paragraph + unclosed code block → single code
    // block on closing fence), subsequent diffs use the correct baseline.
    blockCountRef.count = totalBlocks;

    dbg("updateMdDom done", { removed, rendered, finalBlockCount: totalBlocks });
  }

  // ── Images ────────────────────────────────────────────────────────────────
  /**
   * Append image payloads to a message block as data-URL thumbnails (click
   * toggles full size). Built with createElement + setAttribute, never
   * innerHTML, so no markup ever comes from the wire; mimeTypes that are not
   * images are rejected outright (a data: URL is still a URL).
   */
  function appendImages(parent: HTMLElement, images?: UiImage[]): void {
    if (!images || images.length === 0) return;
    const wrap = document.createElement("div");
    wrap.className = "message-images";
    for (const img of images) {
      if (img.skipped || !img.data) {
        const note = document.createElement("div");
        note.className = "image-skipped";
        note.textContent = img.note || "image not displayed";
        wrap.appendChild(note);
        continue;
      }
      if (!img.mimeType.startsWith("image/")) {
        const note = document.createElement("div");
        note.className = "image-skipped";
        note.textContent = `unsupported image type: ${img.mimeType}`;
        wrap.appendChild(note);
        continue;
      }
      const el = document.createElement("img");
      el.className = "message-image";
      el.setAttribute("src", `data:${img.mimeType};base64,${img.data}`);
      el.setAttribute("loading", "lazy");
      el.addEventListener("click", () => el.classList.toggle("fullsize"));
      wrap.appendChild(el);
    }
    parent.appendChild(wrap);
  }

  // ── Assistant message footer ─────────────────────────────────────────────
  // Static icon markup (never carries wire data; innerHTML on a constant).
  const ICON_COPY =
    '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
    '<rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M5 15V6a2 2 0 0 1 2-2h9" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
    '<path d="M4 12l5 5L20 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function makeCopyButton(rawMarkdown: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "footer-copy";
    btn.setAttribute("title", "Copy message");
    btn.setAttribute("aria-label", "Copy message");
    btn.innerHTML = ICON_COPY;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    btn.addEventListener("click", () => {
      void copyText(rawMarkdown).then((ok) => {
        if (!ok) return; // no fake confirmation: the check rides a real copy
        if (flashTimer) clearTimeout(flashTimer);
        btn.classList.add("copied");
        btn.innerHTML = ICON_CHECK;
        flashTimer = setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = ICON_COPY;
          flashTimer = null;
        }, 1200);
      });
    });
    return btn;
  }

  /**
   * Muted meta row under a completed assistant message: finish time, then
   * the `used/total` ctx segment when THIS render path attests the usage at
   * this message's commit (cold replay: the log's token_usage record; live:
   * the TOKEN_USAGE frames observed since the turn opened), then the
   * producing LLM call's own wall time adjacent to the gauge (`4.2s`;
   * recorded on the usage record first, else a strict-adjacency log-gap
   * derivation -- callDerived says which, and the tooltip discloses it),
   * then "Worked for X" when the turn total is reliably known (cold replay:
   * the log's turn markers; live: the observed working-edge span), then the
   * copy button -- which only rides when there IS text to copy: a text-less
   * response's bar (tool calls and/or reasoning only) has no raw markdown,
   * so no button. Segments render independently -- ts-only, ts+gauge,
   * call-only, ctx+call, turn-total+call are all valid rows. No trustworthy
   * timestamp means no footer at all (pinned degradation for legacy logs):
   * the row speaks times, so it never renders without one.
   */
  function appendFooterRow(
    rawMarkdown: string,
    meta: { ts?: number; durationMs?: number; ctx?: CtxUsage; callMs?: number; callDerived?: boolean },
  ): void {
    if (meta.ts === undefined || !Number.isFinite(meta.ts)) return;
    const row = document.createElement("div");
    row.className = "message-assistant-footer";
    const time = document.createElement("span");
    time.className = "footer-time";
    time.textContent = formatClock(meta.ts);
    row.appendChild(time);
    // Per-call wall time, gated like the turn total: an unattested number
    // is omitted, never guessed. The tooltip phrasing (and, with no gauge
    // to carry it, the segment's own title) keeps a derived value honestly
    // marked as a log-gap derivation.
    const callMs =
      meta.callMs !== undefined && Number.isFinite(meta.callMs) && meta.callMs >= 0
        ? meta.callMs
        : undefined;
    const callTip = callMs === undefined
      ? undefined
      : meta.callDerived === true
        ? `call ~${formatCallDuration(callMs)} (derived from log gap)`
        : `call ${formatCallDuration(callMs)}`;
    const ctx = meta.ctx;
    if (ctx && Number.isFinite(ctx.used) && ctx.used > 0) {
      const gauge = document.createElement("span");
      gauge.className = "footer-ctx";
      gauge.textContent =
        formatTokenCount(ctx.used)
        + (ctx.total !== undefined && Number.isFinite(ctx.total) ? "/" + formatTokenCount(ctx.total) : "");
      // Hover breakdown, same compact house format. The webui tooltip idiom
      // is the native title attribute (copy button, sidebar rows, tool
      // headers), which carries multi-line content fine -- no custom tooltip
      // layer gets invented here. Lines follow the retired token-usage
      // bubble (cached / prompt / completion / total, prompt net of cache);
      // an unattested number omits its line rather than printing 0. The
      // total line echoes the segment's used value: they are one number.
      // The call line rides last: it names the producing call, not the
      // usage numbers. tabIndex lets keyboard focus surface the title like
      // it does on the focusable copy button; nothing beyond that.
      const tip: string[] = [];
      if (ctx.cached !== undefined) tip.push(`cached ${formatTokenCount(ctx.cached)}`);
      if (ctx.prompt !== undefined) tip.push(`prompt ${formatTokenCount(ctx.prompt)}`);
      if (ctx.completion !== undefined) tip.push(`completion ${formatTokenCount(ctx.completion)}`);
      tip.push(`total ${formatTokenCount(ctx.used)}`);
      if (callTip !== undefined) tip.push(callTip);
      gauge.setAttribute("title", tip.join("\n"));
      gauge.setAttribute("tabindex", "0");
      row.appendChild(gauge);
    }
    if (callMs !== undefined) {
      const call = document.createElement("span");
      call.className = "footer-call";
      call.textContent = formatCallDuration(callMs);
      // With no gauge there is no tooltip to carry the derivation note;
      // the segment states it itself so a derived number never reads as
      // recorded even when the gauge is absent.
      if (meta.callDerived === true && !(ctx && Number.isFinite(ctx.used) && ctx.used > 0)) {
        call.setAttribute("title", "~ derived from log gap");
        call.setAttribute("tabindex", "0");
      }
      row.appendChild(call);
    }
    if (meta.durationMs !== undefined && Number.isFinite(meta.durationMs) && meta.durationMs >= 0) {
      appendWorkedSegment(row, meta.durationMs);
    }
    // The copy button is the row's action for text: a text-less response's
    // bar (no raw markdown) gets no button -- nothing to copy.
    if (rawMarkdown.trim() !== "") {
      row.appendChild(makeCopyButton(rawMarkdown));
    }
    container.appendChild(row);
    lastBar = row;
    lastBarWorked = meta.durationMs !== undefined && Number.isFinite(meta.durationMs) && meta.durationMs >= 0;
    scrollBottom();
  }

  /** The "Worked for X" segment, before the copy button when one is there.
   *  Also used to attach a closing turn's total to the last bar that landed
   *  mid-turn (a tool-only final response committed without a duration). */
  function appendWorkedSegment(row: HTMLElement, durationMs: number): void {
    const worked = document.createElement("span");
    worked.className = "footer-worked";
    worked.textContent = `Worked for ${formatDuration(durationMs)}`;
    const copy = row.querySelector(".footer-copy");
    if (copy) row.insertBefore(worked, copy);
    else row.appendChild(worked);
  }

  // ── Message Handlers ──────────────────────────────────────────────────────
  function handleUserMessage({ content, images, files }: UserMessage): void {
    // Close any in-flight assistant/thinking element first in case an interruption occurred;
    // without this the next turn's streaming chunks resume the stale element above this message.
    finalizeAssistant();

    const el = document.createElement("div");
    el.className = "message user";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const contentEl = document.createElement("div");
    contentEl.className = "content";
    contentEl.textContent = content;
    bubble.appendChild(contentEl);
    appendImages(bubble, images);
    appendAttachments(bubble, files);
    el.appendChild(bubble);

    container.appendChild(el);
    scrollBottom();
  }

  /** One collapsible box per attached file: path as summary, escaped content inside. */
  function appendAttachments(bubble: HTMLElement, files?: Array<{ path: string; content: string }>): void {
    if (!files || files.length === 0) return;
    for (const f of files) {
      const box = document.createElement("details");
      box.className = "attachment-box";
      box.innerHTML =
        `<summary>${sanitize(f.path)}</summary>` +
        `<pre class="attachment-content">${sanitize(f.content)}</pre>`;
      bubble.appendChild(box);
    }
  }

  function handleAssistantMessage({ content, ts, durationMs, ctx, callMs, callDerived }: AssistantMessage): void {
    finalizeAssistant();
    if (!content?.trim()) {
      // A response with no text (tool calls and/or reasoning only). Replay
      // paths still send this frame with the entry's footer meta, so the
      // bar lands under the response's blocks -- no bubble, no copy button
      // (nothing to copy), and no bar at all without a trustworthy ts.
      appendFooterRow("", { ts, durationMs, ctx, callMs, callDerived });
      return;
    }
    const el = document.createElement("div");
    el.className = "message assistant";

    const bubble = document.createElement("div");
    const contentEl = document.createElement("div");
    contentEl.className = "content md-content";
    const tree = parseMarkdown(content);
    contentEl.innerHTML = mdTreeToHtml(tree);
    bubble.appendChild(contentEl);
    el.appendChild(bubble);

    container.appendChild(el);
    // Replay frames carry the log's ts/duration/ctx and the per-call ms
    // (recorded first, else marked derived); frames without a trustworthy
    // ts (fork replay, legacy) get no footer.
    appendFooterRow(content, { ts, durationMs, ctx, callMs, callDerived });
    scrollBottom();
  }

  function handleStreamingChunk({ content }: StreamingChunk): void {
    // If we've had tool calls since the last assistant message, start a new
    // assistant element so tool calls appear sequentially before the final text.
    if (hasToolCallsSinceLastAssistant) {
      // The previous row committed when the model stopped to call tools -- a
      // completed message (log-replay parity) -- but mid-turn: the turn's
      // duration is unknowable until it closes, so the footer omits it. The
      // ctx segment IS attested here when the provider emits usage at all:
      // agent.ts records the producing call's usage (and emits TOKEN_USAGE)
      // before dispatching its tool calls, so the held numbers belong to
      // this very message. If no usage arrived yet this turn, nothing was
      // attested and the segment stays off.
      finalizeAssistant({ ts: Date.now(), ctx: lastTurnCtx, callMs: lastTurnCallMs });
      hasToolCallsSinceLastAssistant = false;
    }
    const el = ensureAssistantEl();
    const contentDiv = el.querySelector(".content") as HTMLDivElement;

    if (!streamingParser) {
      streamingParser = createStreamingParser();
    }

    currentAssistantRaw += content;
    dbg("handleStreamingChunk", { chunkLen: content.length, chunkPreview: content.slice(0, 60).replace(/\n/g, "\\n"), prevBlockCount: streamingBlockCount });
    const result = streamingParser.feed(content);
    dbg("handleStreamingChunk after feed", { stableFrom: result.stableFrom, treeBlocks: result.tree.children.length });
    updateMdDom(contentDiv, result, { count: streamingBlockCount });
    streamingBlockCount = result.tree.children.length;
    scrollBottom();
  }

  function handleStreamingReasoningChunk({ content }: StreamingChunk): void {
    const el = ensureThinkingEl();

    if (!thinkingParser) {
      thinkingParser = createStreamingParser();
    }

    dbg("handleStreamingReasoningChunk", { chunkLen: content.length, chunkPreview: content.slice(0, 60).replace(/\n/g, "\\n"), prevBlockCount: thinkingBlockCount });
    const result = thinkingParser.feed(content);
    dbg("handleStreamingReasoningChunk after feed", { stableFrom: result.stableFrom, treeBlocks: result.tree.children.length });
    updateMdDom(el, result, { count: thinkingBlockCount });
    thinkingBlockCount = result.tree.children.length;
    scrollBottom();
  }

  /**
   * The transport re-issued a request after a mid-stream failure: everything
   * the failed attempt streamed (assistant text AND thinking, plus any
   * hasToolCallsSinceLastAssistant flag from its tool-call phase) is dead --
   * the retry re-streams from scratch and the assembled message will contain
   * none of it. Drop both in-flight renderers outright (NOT
   * finalizeAssistant: dead text must not be committed as a kept message).
   * Sanitizer path untouched: the retry's chunks still flow through
   * StreamingMdParser + renderBlocksToHtml exactly as before; nothing here
   * writes markup. Tool blocks are untouched (a reset precedes tool results).
   */
  function handleStreamReset(): void {
    dbg("handleStreamReset", {
      hadAssistant: !!currentAssistantEl,
      hadThinking: !!currentThinkingEl,
      streamingBlockCount,
      thinkingBlockCount,
    });
    if (currentAssistantEl) currentAssistantEl.remove();
    currentAssistantEl = null;
    if (currentThinkingEl) currentThinkingEl.remove();
    currentThinkingEl = null;
    hasToolCallsSinceLastAssistant = false;
    usageAwaitingBar = false;
    streamingParser = null;
    thinkingParser = null;
    streamingBlockCount = 0;
    thinkingBlockCount = 0;
    currentAssistantRaw = "";
  }

  function handleThinking({ content }: ThinkingMessage): void {
    const el = ensureThinkingEl();
    const tree = parseMarkdown(content);
    el.innerHTML = mdTreeToHtml(tree);
  }

  function handleToolCall({ name, args, argsSummary, display, toolCallId }: ToolCallMessage): void {
    // Finalize the current assistant message so tool calls appear as
    // separate blocks after the user message, not nested inside the assistant.
    // A text row closed here is a completed message (the model answered, then
    // reached for tools -- the log stores it as one llm entry), so it gets a
    // footer; the turn's duration segment is omitted mid-turn (unknown yet),
    // while the ctx segment rides the producing call's held usage (the
    // TOKEN_USAGE frame precedes this frame in the same ordered sink; see
    // the boundary-commit note in handleStreamingChunk).
    finalizeAssistant({ ts: Date.now(), ctx: lastTurnCtx, callMs: lastTurnCallMs });

    const host = document.createElement("div");
    container.appendChild(host);
    const block = new ToolBlockController(host as unknown as DomNode, { name, args, argsSummary, display });
    if (toolCallId) toolBlocksById.set(toolCallId, block);
    const queue = pendingToolCallsByName.get(name);
    if (queue) queue.push(block);
    else pendingToolCallsByName.set(name, [block]);

    hasToolCallsSinceLastAssistant = true;
    scrollBottom();
  }

  function handleToolResult({ name, output, error, images, toolCallId }: ToolResultMessage): void {
    // The response behind the preceding usage record is fully closed here.
    // Log-order replay puts the usage frame BEFORE the next entry's tool
    // frames, so a held flag must not survive into a later response's bar.
    usageAwaitingBar = false;
    // Pair by tool-call id first; without one (old logs), fall back to the
    // oldest unresolved call of the same name.
    let block = toolCallId ? toolBlocksById.get(toolCallId) : undefined;
    if (block && toolCallId) {
      toolBlocksById.delete(toolCallId);
      const queue = pendingToolCallsByName.get(name);
      if (queue) {
        const at = queue.indexOf(block);
        if (at !== -1) queue.splice(at, 1);
      }
    }
    if (!block) {
      const queue = pendingToolCallsByName.get(name);
      block = queue && queue.length > 0 ? queue.shift() : undefined;
    }
    if (!block) return; // orphan result: no matching call to attach to

    block.setResult({
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(images ? { images } : {}),
    });
    scrollBottom();
  }

  function handleCompacting({ message }: CompactingMessage): void {
    const el = document.createElement("div");
    el.className = "message compacting";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = `⚡ ${message}`;
    el.appendChild(bubble);
    container.appendChild(el);
    scrollBottom();
  }

  function handleCommandResult({ content }: CommandResultMessage): void {
    const el = document.createElement("div");
    el.className = "message command-result";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const contentEl = document.createElement("div");
    contentEl.className = "content";
    contentEl.textContent = content;
    bubble.appendChild(contentEl);
    el.appendChild(bubble);
    container.appendChild(el);
    scrollBottom();
  }

  function handleQuestion({ questions }: QuestionMessage): void {
    // A streamed row cut by a question did complete (the assistant reached its
    // tool call); footer with ts and the held ctx usage, no duration (turn
    // still open). Same ordered-sink attestation as the tool-call boundary.
    finalizeAssistant({ ts: Date.now(), ctx: lastTurnCtx, callMs: lastTurnCallMs });
    const el = document.createElement("div");
    el.className = "message question";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const contentEl = document.createElement("div");
    contentEl.className = "content";

    const normalized = questions.map((q, i) => ({
      key: q.key || `question_${i}`,
      prompt: q.message || q.prompt || "",
      options: q.options || [],
      default: q.default,
      required: q.required,
      allowOther: q.allowOther,
    }));

    // Without an answer callback (e.g. cold log replay) render read-only.
    if (!onQuestionAnswer) {
      contentEl.innerHTML = `<strong>Question:</strong><br>`;
      for (const q of normalized) {
        contentEl.innerHTML += `${sanitize(q.prompt)}<br>`;
        for (const opt of q.options) {
          contentEl.innerHTML += `  • ${sanitize(opt)}<br>`;
        }
      }
      bubble.appendChild(contentEl);
      el.appendChild(bubble);
      container.appendChild(el);
      scrollBottom();
      return;
    }

    buildQuestionCard(contentEl, normalized);
    bubble.appendChild(contentEl);
    el.appendChild(bubble);
    container.appendChild(el);
    scrollBottom();
  }

  /**
   * Build an interactive question form into contentEl; on submit calls
   * onQuestionAnswer(answers) and marks the card answered.
   */
  function buildQuestionCard(
    contentEl: HTMLElement,
    normalized: NormalizedQuestion[],
  ): void {
    const card = document.createElement("div");
    card.className = "question-card";

    const selections = new Map<
      string,
      { text: string; selectedOption: string | null }
    >();
    const items: Array<{
      q: NormalizedQuestion;
      textEl: HTMLInputElement | null;
      optEls: HTMLButtonElement[];
      errEl: HTMLDivElement;
    }> = [];

    for (const q of normalized) {
      const item = document.createElement("div");
      item.className = "q-item";

      const promptEl = document.createElement("div");
      promptEl.className = "q-prompt";
      promptEl.textContent = q.prompt + (q.required !== false ? " *" : " (optional)");
      item.appendChild(promptEl);

      const sel = {
        text: "",
        selectedOption:
          q.default && q.options.includes(q.default) ? q.default : null,
      };
      selections.set(q.key, sel);

      const optWrap = document.createElement("div");
      optWrap.className = "q-options";

      const optEls: HTMLButtonElement[] = [];
      for (const opt of q.options) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "q-option";
        if (sel.selectedOption === opt) btn.classList.add("selected");
        btn.textContent = opt;
        btn.addEventListener("click", () => {
          sel.selectedOption = opt;
          sel.text = "";
          if (textEl) textEl.value = "";
          for (const b of optEls) b.classList.toggle("selected", b === btn);
        });
        optWrap.appendChild(btn);
        optEls.push(btn);
      }

      let textEl: HTMLInputElement | null = null;
      if (q.allowOther !== false) {
        textEl = document.createElement("input");
        textEl.type = "text";
        textEl.className = "q-text";
        textEl.placeholder = q.default ? `default: ${q.default}` : "Your answer…";
        textEl.addEventListener("input", () => {
          sel.text = textEl!.value;
          if (sel.text.trim()) {
            sel.selectedOption = null;
            for (const b of optEls) b.classList.remove("selected");
          }
        });
        optWrap.appendChild(textEl);
      }

      item.appendChild(optWrap);

      const errEl = document.createElement("div");
      errEl.className = "q-error";
      item.appendChild(errEl);

      card.appendChild(item);
      items.push({ q, textEl, optEls, errEl });
    }

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "q-submit";
    submitBtn.textContent = "Submit answers";
    submitBtn.addEventListener("click", () => {
      const answers: Record<string, string> = {};
      let ok = true;
      for (const ref of items) {
        const { value, error } = resolveQuestionAnswer(ref.q, {
          text: ref.textEl?.value ?? "",
          selectedOption: selections.get(ref.q.key)?.selectedOption ?? null,
        });
        ref.errEl.textContent = error || "";
        if (error) {
          ok = false;
        } else {
          answers[ref.q.key] = value;
        }
      }
      if (!ok) return;
      onQuestionAnswer!(answers);
      markQuestionAnswered(card, answers);
    });
    card.appendChild(submitBtn);
    contentEl.appendChild(card);
  }

  /** Disable all controls on a card and show the submitted answers. */
  function markQuestionAnswered(
    card: HTMLElement,
    answers: Record<string, string>,
  ): void {
    if (card.classList.contains("answered")) return;
    card.classList.add("answered");
    Array.from(
      card.querySelectorAll<HTMLButtonElement>("button"),
    ).forEach((btn) => {
      btn.disabled = true;
    });
    Array.from(card.querySelectorAll<HTMLInputElement>("input")).forEach(
      (input) => {
        input.disabled = true;
      },
    );
    const summary = document.createElement("div");
    summary.className = "q-answers";
    // textContent is injection-safe; no HTML escaping needed (or wanted).
    const parts = Object.entries(answers).map(
      ([k, v]) => `${k}: ${v || "(empty)"}`,
    );
    summary.textContent = `Answered — ${parts.join("; ")}`;
    card.appendChild(summary);
  }

  function handleQuestionAnswered({ answers }: QuestionAnsweredMessage): void {
    // Resolve pending forms in this session's list (multi-tab case).
    container
      .querySelectorAll<HTMLElement>(".question-card:not(.answered)")
      .forEach((card) => {
        markQuestionAnswered(card, answers);
      });
  }

  function handleTaskProgress({ taskId, status, message }: TaskProgressMessage): void {
    let el = container.querySelector<HTMLDivElement>(
      `.task-progress[data-task-id="${sanitize(taskId)}"]`,
    );
    if (!el) {
      el = document.createElement("div");
      el.className = "message task-progress";
      el.dataset.taskId = taskId;
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = `⚡ ${status}${message ? ": " + message : ""}`;
      el.appendChild(bubble);
      container.appendChild(el);
    } else {
      const bubble = el.querySelector<HTMLDivElement>(".bubble");
      if (bubble) {
        bubble.textContent = `⚡ ${status}${message ? ": " + message : ""}`;
      }
    }
    scrollBottom();
  }

  /**
   * Live TOKEN_USAGE frame: the transcript bubble is retired -- its numbers
   * fold into the footer's ctx segment. The frame instead refreshes the
   * held gauge pair (ctxUsed/ctxTotal, pre-derived server-side exactly like
   * the sidebar's cached numbers) plus the per-call breakdown for the
   * hover tooltip, for whatever commit lands next this turn (turn end, tool
   * boundary, question). The frame's own durationMs (the producing call's
   * measured span, agent.ts) refreshes the held call duration the same way:
   * a call with unattested usage tokens still attests its wall time. The
   * event itself keeps flowing untouched: session log, session index,
   * sidebar cache and the terminal UI all still read it. A frame that
   * attests no usable used-number refreshes the gauge with nothing: the
   * last honest value held this turn stays.
   */
  function handleTokenUsage({
    ctxUsed,
    ctxTotal,
    cachedTokens,
    promptTokens,
    completionTokens,
    durationMs,
  }: TokenUsageMessage): void {
    // The frame itself is the per-response marker: an LLM call completed
    // (even one whose provider kept the numbers private). Every completed
    // commit consumes it; TOOL_RESULT clears it so a replayed usage record
    // (which lands BEFORE the next entry's tool frames in log order) can
    // never stamp a later response's bar.
    usageAwaitingBar = true;
    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
      lastTurnCallMs = durationMs;
    }
    if (typeof ctxUsed !== "number" || !Number.isFinite(ctxUsed) || ctxUsed <= 0) return;
    const ctx: CtxUsage = { used: ctxUsed };
    if (typeof ctxTotal === "number" && Number.isFinite(ctxTotal) && ctxTotal > 0) ctx.total = ctxTotal;
    // Breakdown numbers: 0 is an attested value (nothing cached), so only
    // missing/non-finite fields drop their tooltip line.
    if (typeof cachedTokens === "number" && Number.isFinite(cachedTokens)) ctx.cached = cachedTokens;
    if (typeof promptTokens === "number" && Number.isFinite(promptTokens)) ctx.prompt = promptTokens;
    if (typeof completionTokens === "number" && Number.isFinite(completionTokens)) ctx.completion = completionTokens;
    lastTurnCtx = ctx;
  }

  function handleCompactionResult({ summary, messagesCompacted }: CompactionResultMessage): void {
    const el = document.createElement("div");
    el.className = "message compaction-result";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    // Strategies without a summary (pass-the-baton, drop, trim) omit the
    // field; never render "Summary: null".
    bubble.textContent = summary
      ? `Compacted ${messagesCompacted} messages. Summary: ${summary}`
      : `Compacted ${messagesCompacted} messages.`;
    el.appendChild(bubble);
    container.appendChild(el);
    scrollBottom();
  }

  function handleSessionState({ key, value }: SessionStateMessage): void {
    if (key === "hideThinking") {
      setHideThinking(Boolean(value));
    }
  }

  function handleError({ message }: ErrorMessage): void {
    finalizeAssistant();
    // An errored turn is neither completed nor stopped: no "Worked for"
    // claim on the last bar.
    lastBar = null;
    lastBarWorked = false;
    const el = document.createElement("div");
    el.className = "message error";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const contentEl = document.createElement("div");
    contentEl.className = "content";
    contentEl.textContent = `Error: ${sanitize(message)}`;
    bubble.appendChild(contentEl);
    el.appendChild(bubble);

    container.appendChild(el);
    scrollBottom();
  }

  function finalizeAssistant(end?: { ts: number; durationMs?: number; ctx?: CtxUsage; callMs?: number }): void {
    dbg("finalizeAssistant", { hadAssistant: !!currentAssistantEl, streamingBlockCount, thinkingBlockCount });
    let rowCommitted = false;
    if (currentAssistantEl) {
      // Drop empty assistant elements (e.g. tool-only turns).
      const contentDiv = currentAssistantEl.querySelector(".content") as HTMLDivElement;
      const hasContent = contentDiv && contentDiv.textContent?.trim().length > 0;
      if (!hasContent) {
        currentAssistantEl.remove();
      } else {
        currentAssistantEl.classList.remove("streaming");
        // A completed commit (turn end / tool boundary): footer row with the
        // client-clock finish time; the duration segment only when known.
        appendFooterRow(currentAssistantRaw, end ?? {});
        rowCommitted = true;
      }
      currentAssistantEl = null;
    }
    if (!rowCommitted && end && usageAwaitingBar) {
      // Text-less completed response (tool calls and/or reasoning, no text
      // streamed): the usage frame attests the response and this completed
      // commit is its boundary. One bar per response -- the bar lands here
      // (no copy button: there is no raw markdown), so every response shows
      // its own ts + ctx gauge update, not just the ones with prose.
      appendFooterRow("", end);
    }
    usageAwaitingBar = false;
    if (currentThinkingEl && !currentThinkingEl.textContent?.trim()) {
      currentThinkingEl.remove();
    }
    currentThinkingEl = null;
    hasToolCallsSinceLastAssistant = false;
    streamingParser = null;
    thinkingParser = null;
    streamingBlockCount = 0;
    thinkingBlockCount = 0;
    currentAssistantRaw = "";
  }

  // Auto-scroll follow state: the view stays pinned to the bottom unless the
  // user has scrolled up (within 150px of the bottom counts as "at bottom").
  // Checking distance after append would block follow whenever a single
  // message is taller than the threshold — e.g. a long history replay on
  // load, which would otherwise leave the view stuck at the top.
  let followBottom = true;
  const onScroll = () => {
    const distFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    followBottom = distFromBottom <= 150;
  };
  container.addEventListener("scroll", onScroll);

  function scrollBottom(): void {
    if (followBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  /** Tear down every live tool-block mount (the DOM is dropped by the caller). */
  function destroyToolBlocks(): void {
    for (const block of toolBlocksById.values()) block.destroy();
    for (const queue of pendingToolCallsByName.values()) {
      for (const block of queue) block.destroy();
    }
    toolBlocksById.clear();
    pendingToolCallsByName.clear();
  }

  function clear(): void {
    container.innerHTML = "";
    followBottom = true;
    currentAssistantEl = null;
    currentThinkingEl = null;
    destroyToolBlocks();
    hasToolCallsSinceLastAssistant = false;
    streamingParser = null;
    thinkingParser = null;
    streamingBlockCount = 0;
    thinkingBlockCount = 0;
    currentAssistantRaw = "";
    turnStartMs = null;
    workingBaseline = false;
    lastTurnCtx = undefined;
    lastTurnCallMs = undefined;
    usageAwaitingBar = false;
    lastBar = null;
    lastBarWorked = false;
  }

  /** Best-effort tool name from a tool_result entry: stored part, then JSON "name", then "tool: ..." prefix. */
  function extractToolNameFromEntry(entry: LogEntry | string): string {
    // A stored tool-result part names its own tool.
    if (typeof entry !== "string" && Array.isArray(entry.content)) {
      for (const part of entry.content) {
        if (part && typeof part === "object" && (part as Record<string, unknown>).type === "tool-result") {
          const tool = (part as Record<string, unknown>).tool;
          if (typeof tool === "string" && tool) return tool;
        }
      }
    }
    const content = typeof entry === "string" ? entry : toolContentText(entry.content);
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && "name" in parsed) {
        return String(parsed.name);
      }
    } catch {
      // Not JSON.
    }
    const match = content.match(/^(\w+):\s/);
    if (match) return match[1] ?? "tool";
    return "tool";
  }

  /**
   * Render a batch of session log entries into the message list.
   * Used for viewing cold session logs in read-only mode.
   */
  function renderLogEntries(entries: LogEntry[]): void {
    // Footer data for the replay path: each entry's own ts is its completion
    // time, the v2 turn markers give the turn's wall-clock total to the
    // response that CLOSED the turn and nothing to the rounds before it
    // (turnFinalDurationsByIndex returns undefined -- segment omitted -- for
    // every other entry, for v1 logs without markers and for turns still open
    // at log end), and each
    // llm entry's commit ctx comes from the token_usage record written for
    // that response (ctxByIndex, the sibling derivation: undefined for logs
    // predating usage records or calls whose provider kept usage private).
    // The per-call duration is the record's own durationMs first (ctx.callMs),
    // else the strict-adjacency log-gap derivation -- marked derived so the
    // tooltip never presents it as a measured value.
    const turnFinalDurations = turnFinalDurationsByIndex(entries);
    const ctxs = ctxByIndex(entries);
    const derivedCalls = deriveCallDurationsByIndex(entries);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      // content may be raw parts (harness messages); flatten once per entry.
      const isTool = entry.source === "tool_result";
      const content =
        entry.content == null
          ? ""
          : typeof entry.content === "string"
            ? entry.content
            : isTool
              ? toolContentText(entry.content)
              : wrapperContentText(entry.content);
      switch (entry.source) {
        case "input":
        case "prompt": {
          // Attachments render inline: split the file-include parts out of
          // the text so the bubble gets prose + collapsible boxes, not JSON.
          const split = Array.isArray(entry.content) ? splitFileIncludes(entry.content) : null;
          handleUserMessage({
            content: split ? split.text : content,
            images: entry.images,
            ...(split && split.files.length > 0 ? { files: split.files } : {}),
          });
          break;
        }
        case "llm": {
          if (entry.reasoning_content?.trim()) {
            handleThinking({ content: entry.reasoning_content });
          }
          if (entry.tool_calls && Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
            for (const tc of entry.tool_calls) {
              // File-log records hold the provider wire object
              // ({function:{name,arguments}}); the flat {name,args} shape
              // stays supported for older logs and hand-built entries.
              const toolCall = tc as {
                name?: string;
                arguments?: string | object;
                args?: string | object;
                function?: { name?: string; arguments?: string | object };
                display?: ToolDisplayWire[];
              };
              const name = toolCall.function?.name || toolCall.name || "unknown";
              const rawArgs = toolCall.function?.arguments ?? toolCall.arguments ?? toolCall.args;
              const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {}, null, 2);
              // The server annotated the entry's calls with their resolved
              // display parts (handlers-logs.ts), so a browsed log reaches the
              // exact same posture code as a live TOOL_CALL frame.
              handleToolCall({ name, args, display: toolCall.display, toolCallId: tc.id || undefined });
            }
          }
          // Every llm entry gets its footer, text or not: the per-call
          // duration is the usage record's own durationMs (ctx.callMs)
          // first; otherwise the strict-adjacency log gap, flagged derived
          // so the tooltip says so. Neither attested -> segment omitted. A
          // text-less entry (tool calls and/or reasoning only) renders no
          // bubble -- just the bar, without a copy button.
          const recordedCall = ctxs[i]?.callMs;
          const derivedCall = recordedCall === undefined ? derivedCalls[i] : undefined;
          handleAssistantMessage({
            content,
            ts: parseEntryTs(entry.ts),
            durationMs: turnFinalDurations[i],
            ctx: ctxs[i],
            callMs: recordedCall ?? derivedCall,
            ...(derivedCall !== undefined ? { callDerived: true } : {}),
          });
          break;
        }
        case "tool_result":
          handleToolResult({
            name:
              (entry as { tool_name?: string | null }).tool_name || extractToolNameFromEntry(entry),
            output: content,
            images: entry.images,
            toolCallId: (entry as { tool_call_id?: string | null }).tool_call_id || undefined,
          });
          break;
        case "compaction":
          handleCompacting({ message: content });
          break;
      }
    }
    scrollBottom();
  }

  /** Append a system notice bubble (used for profile-switch confirmations). */
  function addSystemMessage(text: string): void {
    handleSystemMessage({ content: `Switched to profile: ${text}` });
  }

  /** Append a system notice bubble from a server system message. */
  function handleSystemMessage(data: { content?: string }): void {
    const el = document.createElement("div");
    el.className = "message system-message";
    el.innerHTML = `<span class="message-role system-label">System</span><div class="message-content"><p>${sanitize(data.content ?? "")}</p></div>`;
    container.appendChild(el);
    scrollBottom();
  }

  /** Detach the container's scroll listener; the container itself is left untouched. */
  function destroy(): void {
    container.removeEventListener("scroll", onScroll);
    // The manager is dropped after this: no tool block may outlive it with
    // a live mount still waiting for a result.
    destroyToolBlocks();
  }

  return {
    handleUserMessage,
    handleAssistantMessage,
    handleStreamingChunk,
    handleStreamingReasoningChunk,
    handleStreamReset,
    handleThinking,
    handleToolCall,
    handleToolResult,
    handleCompacting,
    handleCommandResult,
    handleQuestion,
    handleQuestionAnswered,
    handleTaskProgress,
    handleTokenUsage,
    handleCompactionResult,
    handleSessionState,
    setHideThinking,
    handleError,
    finalizeAssistant,
    noteWorking,
    clear,
    addSystemMessage,
    handleSystemMessage,
    destroy,
    renderLogEntries,
  };
}
