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
import { toolContentMeta, toolContentMetaAll, toolContentText, wrapperContentText, splitFileIncludes } from "@utils/tool-content.ts";
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
// { skipped, note } with no data. HISTORY frames omit image payloads
// entirely: { omitted: true, bytes } + the fetch coordinate (entryIndex =
// FULL-log entry, imageIndex = slot) -- rendered as a placeholder box that
// fetches the pixels when it comes on screen (see onFetchImage).
export interface UiImage {
  mimeType: string;
  data?: string;
  skipped?: boolean;
  note?: string;
  omitted?: boolean;
  bytes?: number;
  entryIndex?: number;
  imageIndex?: number;
}

interface UserMessage { content: string; images?: UiImage[]; files?: Array<{ path: string; content: string }>; }

/**
 * Long user prompts (workflow task descriptions, pasted docs) render folded
 * to this many SOURCE lines with a chevron toggle (one message ate a
 * viewport). Folding is a CSS clamp: the full text stays in the DOM,
 * so the row's textContent search still sees the hit, and revealMatch opens
 * the fold before flashing (expand-on-hit). User messages only -- assistant
 * prose is structured markdown, and attachments already ride details boxes.
 */
const USER_PROMPT_FOLD_LINES = 4;
/** Fold-toggle chevron: the jump-button glyph in the .fold-chevron family,
 *  sized to the sidebar header chevron (#logs-toggle). Open state rotates
 *  180°, CSS-attested by aria-expanded. */
const ICON_CHEVRON_FOLD =
  '<svg class="fold-chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" tabindex="-1">' +
  '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
/**
 * Live-only in-flight tool call (S2C `streamingToolCall`): `index` is the
 * wire's tool-call slot (the frame's identity -- see s2cStreamingToolCall),
 * `name` is "" until the first toolName delta, and the preview bytes ride
 * ONE posture: `delta` (an increment to APPEND to the per-index accumulator)
 * or `args` (the accumulated partial, REPLACE -- the legacy/cumulative
 * posture, also what a merged-window cumulative channel ships). Shape is
 * self-describing; a frame carrying neither shows nothing new.
 */
interface StreamingToolCallMessage { index: number; name: string; args?: string; delta?: string; }
interface ToolResultMessage { name: string; output?: string; error?: string; images?: UiImage[]; toolCallId?: string; startLine?: number; meta?: Record<string, string>; }
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
    /** Registry-resolved title-bar fold for tools declaring headerKeys
     *  (additive; "" is explicit -- it suppresses the client heuristic). */
    argsSummary?: string;
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
 *
 * Every number is optional BY CONTRACT: s2cTokenUsage gates contextWindow,
 * durationMs and the ctx pair onto the frame only when attested as finite
 * numbers (older records and unmeasured callers stay silent), and each
 * handler gate already treats a missing/non-finite field as unattested
 * (omitted from the gauge and its tooltip, never zeroed in).
 */
interface TokenUsageMessage {
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
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
  /** Lazy history: fired ONCE per top-zone entry while setHasOlder(true)
   *  (see TOP_TRIGGER_PX) -- the chat layer pages older history on it and
   *  re-arms itself by delivering a page (or the user leaving the zone). */
  onNearTop?: () => void;
  /** Host for the jump-to-bottom button (the app's #input-area seam). When
   *  set, the manager mounts one button on it, visible exactly while the
   *  view is un-pinned from the bottom. Absent (tests, the history mirror)
   *  means no button, never a crash. */
  jumpHost?: HTMLElement;
  /** History image fetch seam: a stub box's host callback, called
   *  with the stub's (entryIndex, imageIndex) coordinate when the box comes
   *  on screen (IntersectionObserver; at render where none exists). Resolves
   *  with the single WireImage (inline data, or the honest skipped+note
   *  posture), rejects with the server's refusal text. Absent (mirrors
   *  without a socket, tests that never fetch): stubs render as static
   *  honest boxes. Forwarded to the older-page mirror by construction. */
  onFetchImage?: (entryIndex: number, imageIndex: number) => Promise<UiImage>;
}

export interface MessageListManager {
  handleUserMessage: (data: UserMessage) => void;
  handleAssistantMessage: (data: AssistantMessage) => void;
  handleStreamingChunk: (data: StreamingChunk) => void;
  handleStreamingReasoningChunk: (data: StreamingChunk) => void;
  /**
   * Live-only tool-call preview (S2C `streamingToolCall`): one bubble per
   * wire slot; `delta` frames append to the slot's arg accumulator, `args`
   * frames replace it (postures self-describe, see StreamingToolCallMessage).
   * The regular `toolCall` frame upgrades the bubble in place with the
   * AUTHORITATIVE full args; a retry (handleStreamReset) or a closing turn
   * drops the bubble and its accumulator.
   */
  handleStreamingToolCall: (data: StreamingToolCallMessage) => void;
  /**
   * The optimistic request edge (the composer's send / Stop clicks), which
   * arrives long before the server's working sessionState frame. The live
   * "Thinking" row follows it; `noteWorking` still owns the turn clock and
   * the footer, and re-attests the same posture when the wire lands.
   */
  setRequestPending: (pending: boolean) => void;
  /** Mid-stream provider-failure retry: drop the in-flight text/thinking
   * accumulators so the retry's deltas render into fresh renderers. */
  handleStreamReset: () => void;
  handleThinking: (data: ThinkingMessage) => void;
  handleToolCall: (data: ToolCallMessage) => void;
  handleToolResult: (data: ToolResultMessage) => void;
  handleCompacting: (data: CompactingMessage) => void;
  handleCommandResult: (data: CommandResultMessage) => void;
  handleQuestion: (data: QuestionMessage) => void;
  /**
   * Worker-view question surface: a watcher of a subagent session
   * SEES the pending question but can never answer it -- the delegating
   * manager is the only respondent. Set true on a worker attach (kind
   * "subagent"), false on every interactive attach; while true, question
   * cards render read-only with the honest "awaiting the manager" label and
   * no submit path exists to reach the server's refusal.
   */
  setQuestionReadOnly: (readOnly: boolean) => void;
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
   * Honest fallback for a FAILED subagent live attach: the pane shows
   * the fact ("Live tail unavailable for this subagent") plus two real
   * actions -- "View log" (the settled view of the worker's own durable
   * log) and "Close" (removes the card). Never a raw error bubble, never
   * another session's transcript. One card at a time; the next attach or
   * view replaces the pane, and clear() drops it with everything else.
   */
  showAttachUnavailable: (opts: { onViewLog: () => void }) => void;
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
  /** Lazy history: whether older entries exist above what is on screen.
   *  Drives the scroll-up trigger only -- never the render, never a count. */
  setHasOlder: (hasOlder: boolean) => void;
  /** Prepend an older history page WITHOUT moving the viewport: capture
   *  scroll geometry, render the page through the same pipeline in a
   *  detached mirror, splice the finished nodes in above the current
   *  content, then restore `scrollTop += heightDelta` and mark the restore
   *  so the scroll listener never reads it as the user scrolling. */
  renderOlderEntries: (entries: LogEntry[]) => void;
  /** Search peek seam: scroll the FIRST user/assistant row whose
   *  rendered text contains `needle` (case-insensitive -- the search
   *  corpus's own rule) into view and flash it (`.search-flash`, removed
   *  after a beat). True when the match landed. Scoped to `.message` rows
   *  -- the user/assistant lanes the server searches -- so a tool block or
   *  a thinking fold can never steal the landing. */
  revealMatch: (needle: string) => boolean;
}

export function createMessageList(
  container: HTMLElement,
  { hideThinking = false, onQuestionAnswer, onNearTop, jumpHost, onFetchImage }: MessageListOptions = {},
): MessageListManager {
  let currentAssistantEl: HTMLDivElement | null = null;
  let currentThinkingEl: HTMLDivElement | null = null;
  // Tool-call/result pairing: by tool-call id when the wire carries one,
  // else the oldest unresolved call with the same name (id-less log replay).
  const toolBlocksById = new Map<string, ToolBlockController>();
  const pendingToolCallsByName = new Map<string, ToolBlockController[]>();
  // Block -> its host div (the element the controller mounts INTO and that
  // message-list created). Omitted history-image stubs render as sibling
  // boxes at the block's foot via this map (tool-block's ImagesView only
  // ever sees inline payloads; that seam stays untouched).
  const toolBlockHosts = new WeakMap<ToolBlockController, HTMLElement>();
  let hasToolCallsSinceLastAssistant = false;
  let hideThinkingValue = hideThinking;
  // Worker-view question surface (see setQuestionReadOnly); every attach
  // rewrites it from the sessionCreated kind.
  let questionReadOnly = false;

  // ── Live activity: the "Thinking" row and the in-flight tool bubbles ─────
  // Both are LIVE transcript state: cold logs never paint them (they render
  // through renderLogEntries, which touches none of this), and while a browse
  // mode is on the whole manager is bypassed (chat.ts LOG_VIEW_SINK).
  //
  // The row is a PER-MODEL-CALL tell, not a per-turn tell: it covers the gap
  // where the harness is waiting on a response with nothing visible on screen
  // yet. Two flags hold it:
  //   requestPending -- a request is in flight (the optimistic send click,
  //     then the session's "working" edges, which re-attest the same truth).
  //   streamedVisible -- the CURRENT model call has produced visible output,
  //     which retires the row until the next call starts. Reasoning chunks
  //     count only when reasoning is actually visible (the per-browser
  //     hideThinking preference): hidden reasoning renders nothing, so the row
  //     stays up through the whole reasoning phase.
  // Every call boundary resets streamedVisible: the working true-edge, a
  // retry's streamReset, and a tool result landing (the turn is still working
  // and the next call has nothing streamed yet).
  let requestPending = false;
  let streamedVisible = false;
  // PLAIN (non-reasoning) visible output of the CURRENT call -- text, tool
  // calls, previews. The reasoning toggle re-derives streamedVisible from it
  // on the set-hide path (the row covers the reasoning
  // phase while reasoning is hidden, so hiding mid-call brings the row back
  // unless plain content has already streamed).
  let streamedPlain = false;
  // The session's "working" value as THIS view last saw it, and whether it
  // has seen one at all. Only a real idle->working edge opens a fresh model
  // call; a mid-turn attach (or reconnect) re-attests working, and there the
  // row is derived from what THIS view holds UNCOMMITTED (see
  // inFlightContent): the burst's committed rows are earlier calls of the
  // turn, never evidence about the call actually running. Same doctrine as
  // the turn clock's workingBaseline one flag below.
  let workingSeen = false;
  let workingValue = false;
  let thinkingRow: HTMLElement | null = null;

  /** Put the row on screen (idempotent: one element, so a reset/re-show cycle
   *  can never leave two rows) or take it off. The dots are markup, not text
   *  churn: the row's content is set once, so the polite live region says
   *  "Thinking" once per appearance and never per blink. */
  function setThinkingRow(visible: boolean): void {
    if (!visible) {
      thinkingRow?.remove();
      thinkingRow = null;
      return;
    }
    if (thinkingRow && container.contains(thinkingRow)) return;
    thinkingRow = document.createElement("div");
    thinkingRow.className = "thinking-live";
    // The app's narration idiom (app.tsx #live-status): a polite status region
    // the dots are hidden from, so the animation never feeds the reader.
    thinkingRow.setAttribute("role", "status");
    thinkingRow.setAttribute("aria-live", "polite");
    const label = document.createElement("span");
    label.className = "thinking-live-text";
    label.textContent = "Thinking";
    const dots = document.createElement("span");
    dots.className = "thinking-live-dots";
    dots.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("span");
      dot.className = "thinking-live-dot";
      dot.textContent = ".";
      dots.appendChild(dot);
    }
    thinkingRow.appendChild(label);
    thinkingRow.appendChild(dots);
    container.appendChild(thinkingRow);
    scrollBottom();
  }

  /** Re-derive the row from the flags -- the ONE evaluation every show/hide
   *  decision rides (working edges, the send click, the reasoning toggle). */
  function syncThinkingRow(): void {
    setThinkingRow(requestPending && !streamedVisible);
  }

  /** Visible output landed for the current call; `plain` marks non-reasoning
   *  content (text, committed tools, previews) -- the "content already
   *  streaming" truth the reasoning toggle re-derives from. */
  function noteVisibleOutput(plain: boolean): void {
    streamedVisible = true;
    if (plain) streamedPlain = true;
    syncThinkingRow();
  }

  /** Attach-time truth: does THIS view show content that has not committed
   *  yet (an open streaming row, a tool round awaiting its result, an in-
   *  flight preview)? A fresh view's first working report is a mid-turn
   *  attach/reconnect re-attestation, not a watched edge: the burst's
   *  COMMITTED rows are EARLIER calls, so the row must be derived from the
   *  uncommitted lanes only (the attach's partial flush lives there). With
   *  `plainOnly` the visible-reasoning lane drops out -- the question the
   *  hidden-reasoning phase answers. */
  function inFlightContent(plainOnly: boolean): boolean {
    if (currentAssistantEl !== null) return true;
    if (pendingToolResults > 0) return true;
    if (inflightSlots.length > 0) return true;
    if (!plainOnly && !hideThinkingValue && currentThinkingEl?.textContent?.trim()) return true;
    return false;
  }

  // Committed tool calls still waiting for their result: the round-closed
  // test the per-call tell uses to come back between model calls (0 means the
  // harness is about to ask the model again, not run another tool).
  let pendingToolResults = 0;

  // In-flight tool calls, keyed by the wire slot index the streamingToolCall
  // frame carries. One host div per slot: the regular toolCall frame mounts
  // the real ToolBlockController into the SAME host (claimInflightHost), so
  // the bubble upgrades in place -- same node, no second bubble, no frame
  // where the row is empty.
  const inflightToolHosts = new Map<number, HTMLDivElement>();
  // Slots that already have a bubble, in arrival order: the pairing key for
  // the final frame (the delta carries no provider tool-call id -- see
  // s2cStreamingToolCall -- so a same-name preview is claimed first, then the
  // oldest preview at all, exactly like the name-pairing of results without
  // ids).
  let inflightSlots: Array<{ index: number; name: string }> = [];
  // Per-slot preview buffer (delta posture): `delta` frames append, `args`
  // frames replace (the legacy posture needs no buffer, but keeping one for
  // both makes the two postures coexist mid-stream -- a capability flip
  // mid-call just changes how the text is grown). It dies with the bubble;
  // the final `toolCall` frame's args are the authority either way, and a
  // mid-call attach starts empty and self-heals on that frame (the ceiling
  // documented on s2cStreamingToolCall).
  const inflightToolArgs = new Map<number, string>();

  /**
   * Drop every in-flight bubble (retry, turn end, clear) and the committed
   * ledger beside it: on these paths a pending result can never land again,
   * and a stale count would mute the per-call tell for the next turn (the
   * round-closed test could never reach 0).
   */
  function clearInflightToolCalls(): void {
    for (const host of inflightToolHosts.values()) host.remove();
    inflightToolHosts.clear();
    inflightToolArgs.clear();
    inflightSlots = [];
    pendingToolResults = 0;
  }

  /** Claim (and remove) the in-flight host a final toolCall frame upgrades.
   *  A same-name preview wins; the only other pairing is a preview that is
   *  still NAME-LESS (its args deltas arrived before the toolName delta),
   *  which is positionally this frame's call. A preview already labelled with
   *  a different name belongs to a different call, so it is never stolen --
   *  the frame gets a fresh host, exactly the no-preview path. */
  function claimInflightHost(name: string): HTMLDivElement | null {
    let at = inflightSlots.findIndex((s) => s.name !== "" && s.name === name);
    if (at < 0) at = inflightSlots.findIndex((s) => s.name === "");
    if (at < 0) return null;
    const slot = inflightSlots[at]!;
    inflightSlots.splice(at, 1);
    const host = inflightToolHosts.get(slot.index) ?? null;
    inflightToolHosts.delete(slot.index);
    // The claimed slot's built-up preview dies with the bubble: the final
    // frame's args are the authority now.
    inflightToolArgs.delete(slot.index);
    return host;
  }

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
      // Per-model-call tell. Only a transition THIS view watched (it saw the
      // turn idle, now it runs) opens a call with nothing streamed: a fresh
      // view attaching mid-turn re-derives the tell from what IT holds
      // uncommitted (inFlightContent) -- the burst's committed rows are
      // EARLIER calls of the turn, no evidence about the call running now.
      // Same doctrine as the turn clock's workingBaseline flag above.
      requestPending = true;
      if (workingSeen && !workingValue) {
        streamedVisible = false;
        streamedPlain = false;
      } else if (!workingSeen) {
        streamedVisible = inFlightContent(false);
        streamedPlain = inFlightContent(true);
      }
      workingSeen = true;
      workingValue = true;
      syncThinkingRow();
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
    // Turn over: the tell retires and any call still previewing is a dead
    // stream (no final frame will ever land for it).
    requestPending = false;
    streamedVisible = false;
    streamedPlain = false;
    workingSeen = true;
    workingValue = false;
    clearInflightToolCalls();
    syncThinkingRow();
  }

  /**
   * The optimistic request edge (composer send / Stop). The row follows the
   * click, not the round trip; the wire's working edges land afterwards and
   * re-attest the same posture through noteWorking.
   */
  function setRequestPending(pending: boolean): void {
    if (pending) {
      // Only a FRESH request re-opens the tell: a mid-run steer must not
      // resurrect it over the bytes still streaming from the running call.
      if (!requestPending) {
        streamedVisible = false;
        streamedPlain = false;
      }
      requestPending = true;
    } else {
      requestPending = false;
      streamedPlain = false;
      // A stop ends the turn: nothing will ever stream into an in-flight
      // preview again, so it goes with it (no bubble stuck "in progress").
      clearInflightToolCalls();
    }
    syncThinkingRow();
  }

  function handleStreamingToolCall({ index, name, args, delta }: StreamingToolCallMessage): void {
    // The preview bubble is the visible activity now: the row retires.
    noteVisibleOutput(true);
    // Preview bytes by posture (self-describing frame, see
    // s2cStreamingToolCall): a `delta` APPENDS to the slot's buffer, an
    // `args` frame REPLACES it (legacy cumulative). A merged-window delta
    // frame is just a bigger append.
    let previewText: string;
    if (typeof delta === "string") {
      previewText = `${inflightToolArgs.get(index) ?? ""}${delta}`;
      inflightToolArgs.set(index, previewText);
    } else if (typeof args === "string") {
      previewText = args;
      inflightToolArgs.set(index, previewText);
    } else {
      previewText = inflightToolArgs.get(index) ?? "";
    }
    let host = inflightToolHosts.get(index);
    if (!host) {
      host = document.createElement("div");
      host.className = "tool-call-block tool-call-streaming status-pending";
      const header = document.createElement("div");
      header.className = "tool-call-header";
      const nameEl = document.createElement("span");
      nameEl.className = "tool-call-name";
      // Pre-naming placeholder: the toolName delta can trail the first arg
      // deltas by a beat (and on a mid-call attach the bubble opens without
      // one); without this the header would be a spinner on empty air.
      nameEl.textContent = "🛠 working…";
      const statusEl = document.createElement("span");
      statusEl.className = "tool-call-status status-pending";
      // The house busy affordance (composer/sidebar .spinner): a
      // currentColor ring, so the pending header tints it without a new hue.
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      statusEl.appendChild(spinner);
      header.appendChild(nameEl);
      header.appendChild(statusEl);
      const preview = document.createElement("pre");
      preview.className = "tool-call-stream-preview";
      host.appendChild(header);
      host.appendChild(preview);
      container.appendChild(host);
      inflightToolHosts.set(index, host);
      inflightSlots.push({ index, name });
    } else {
      // The name lands in its own delta (some backends resend it): fill the
      // slot's record once, so the final-frame pairing can use it.
      const slot = inflightSlots.find((s) => s.index === index);
      if (slot && slot.name === "" && name !== "") slot.name = name;
    }
    // textContent all the way down: wire bytes never reach innerHTML.
    const nameEl = host.querySelector(".tool-call-name");
    if (nameEl && name !== "") nameEl.textContent = `🛠 ${name}`;
    const preview = host.querySelector(".tool-call-stream-preview");
    if (preview) preview.textContent = previewText;
    scrollBottom();
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
   *
   * Both flips RE-DERIVE the Thinking row (symmetric with
   * the attach-time driving): the row covers the reasoning phase while
   * reasoning is hidden, so the SET-HIDE path must re-evaluate a decision
   * that already fired while the reasoning was visible -- a call in flight
   * with no plain content streamed yet takes the row back; content already
   * streaming keeps it down. The SET-SHOW path retires the row once reasoning
   * blocks actually appear.
   */
  function setHideThinking(v: boolean): void {
    hideThinkingValue = v;
    // forEach (not a for..of spread): NodeList iteration needs dom.iterable,
    // which the src build does not pull in.
    container.querySelectorAll(".thinking-block").forEach((el) => {
      el.classList.toggle("hidden", v);
    });
    if (v) {
      streamedVisible = streamedPlain;
      syncThinkingRow();
    } else if (currentThinkingEl?.textContent?.trim()) {
      // Revealing reasoning mid-call puts real content on screen.
      noteVisibleOutput(false);
    }
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
  /** Human size for a stub box (display copy only; the wire attests the
   *  base64 payload length). KB below a MB, MB above, one decimal. */
  function formatImageBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
  }

  /** The inline-posture <img> (click toggles full size). Built with
   * createElement + setAttribute -- no markup ever comes from the wire. */
  function makeImageEl(mimeType: string, data: string): HTMLImageElement {
    const el = document.createElement("img");
    el.className = "message-image";
    el.setAttribute("src", `data:${mimeType};base64,${data}`);
    el.setAttribute("loading", "lazy");
    el.addEventListener("click", () => el.classList.toggle("fullsize"));
    return el;
  }

  /**
   * Placeholder box for an OMITTED history image: shows the media type +
   * human size and trades the coordinate for pixels through the host
   * callback. The fetch fires when the box scrolls into the viewport
   * (IntersectionObserver; a page of heavy images stays free until the user
   * looks), or at render where no observer exists (headless DOM). One fetch
   * per box; success swaps the pixels IN (a skipped+note answer renders the
   * note), failure paints the error into the box. A stub without
   * coordinates or without a host callback is a static honest box.
   */
  function makeImageStubBox(img: UiImage): HTMLElement {
    const box = document.createElement("div");
    box.className = "image-stub";
    box.textContent = `${img.mimeType} image, not loaded (${formatImageBytes(img.bytes ?? NaN)})`;
    const fetchable =
      onFetchImage !== undefined
      && Number.isInteger(img.entryIndex) && (img.entryIndex as number) >= 0
      && Number.isInteger(img.imageIndex) && (img.imageIndex as number) >= 0;
    if (!fetchable) return box;
    let requested = false;
    const load = (): void => {
      if (requested) return;
      requested = true;
      onFetchImage!(img.entryIndex as number, img.imageIndex as number).then(
        (got) => {
          if (got && got.data && got.mimeType.startsWith("image/")) {
            const el = makeImageEl(got.mimeType, got.data);
            // Swap WITHOUT replaceChild/replaceWith (the minimal host DOMs
            // do not all carry them): insert beside, then drop the box. A
            // box the view already dropped (clear / pane switch) is simply
            // gone -- nothing to paint into.
            const parent = box.parentNode;
            if (parent) {
              parent.insertBefore(el, box);
              box.remove();
            }
          } else {
            box.textContent = got?.note || "image not displayed";
          }
        },
        (err: unknown) => {
          box.classList.add("image-stub-failed");
          box.textContent = err instanceof Error ? err.message : String(err);
        },
      );
    };
    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver((records) => {
        for (const rec of records) {
          if (rec.isIntersecting) {
            io.disconnect();
            load();
            break;
          }
        }
      });
      io.observe(box);
    } else {
      load();
    }
    return box;
  }

  /**
   * Append image payloads to a message block as data-URL thumbnails (click
   * toggles full size). Built with createElement + setAttribute, never
   * innerHTML, so no markup ever comes from the wire; mimeTypes that are not
   * images are rejected outright (a data: URL is still a URL). OMITTED
   * history stubs render the fetch-on-view placeholder instead.
   */
  function appendImages(parent: HTMLElement, images?: UiImage[]): void {
    if (!images || images.length === 0) return;
    const wrap = document.createElement("div");
    wrap.className = "message-images";
    for (const img of images) {
      if (img.omitted) {
        wrap.appendChild(makeImageStubBox(img));
        continue;
      }
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
      wrap.appendChild(makeImageEl(img.mimeType, img.data));
    }
    parent.appendChild(wrap);
  }

  // ── Assistant message footer ─────────────────────────────────────────────
  // Static icon markup (never carries wire data; innerHTML on a constant).
  const ICON_COPY =
    '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" tabindex="-1">' +
    '<rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M5 15V6a2 2 0 0 1 2-2h9" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" tabindex="-1">' +
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
  /** Open/close a folded user prompt: the one owner of the clamp class and
   *  the toggle's aria pair (click handler and revealMatch both ride it). */
  function setPromptFolded(row: HTMLElement, folded: boolean): void {
    const content = row.querySelector(".content");
    if (!content) return;
    content.classList.toggle("prompt-folded", folded);
    const toggle = row.querySelector(".user-fold-toggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", folded ? "false" : "true");
      toggle.setAttribute("aria-label", folded ? "Expand full prompt" : "Collapse full prompt");
    }
  }

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
    // Fold at the source-line count (see USER_PROMPT_FOLD_LINES): cheap,
    // layout-free, and identical live and in a replayed log view.
    const folded = content.split("\n").length > USER_PROMPT_FOLD_LINES;
    if (folded) contentEl.classList.add("prompt-folded");
    bubble.appendChild(contentEl);
    // The toggle rides directly under the clamped text, above the images
    // and attachment boxes: it owns the prompt, not the boxes below it.
    if (folded) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "user-fold-toggle";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Expand full prompt");
      toggle.innerHTML = ICON_CHEVRON_FOLD;
      toggle.addEventListener("click", () =>
        setPromptFolded(el, !contentEl.classList.contains("prompt-folded")),
      );
      bubble.appendChild(toggle);
    }
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
    // Committed response text IS visible content (the non-streaming shape and
    // every replay burst land here), so the live tell retires for it too.
    noteVisibleOutput(true);
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
    // Plain response text is the visible tell par excellence: the row retires
    // for the rest of this model call.
    noteVisibleOutput(true);
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
    // Visible reasoning IS visible activity, so the row retires for it. Under
    // the per-browser hideThinking preference the block renders nothing, so
    // the row stays up: hidden bytes are not activity the user can see.
    if (!hideThinkingValue) noteVisibleOutput(false);
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
    // The dead attempt's in-flight previews die with its text: the retry
    // re-streams them into fresh bubbles. Nothing has streamed for the retry
    // yet, so if the turn is still running the tell takes the gap back (the
    // single row element makes a second one impossible).
    clearInflightToolCalls();
    streamedVisible = false;
    streamedPlain = false;
    syncThinkingRow();
  }

  function handleThinking({ content }: ThinkingMessage): void {
    if (!hideThinkingValue) noteVisibleOutput(false);
    const el = ensureThinkingEl();
    const tree = parseMarkdown(content);
    el.innerHTML = mdTreeToHtml(tree);
  }

  function handleToolCall({ name, args, argsSummary, display, toolCallId }: ToolCallMessage): void {
    // A committed tool block is visible response content -- the row retires
    // whether or not a preview led it.
    noteVisibleOutput(true);
    // Finalize the current assistant message so tool calls appear as
    // separate blocks after the user message, not nested inside the assistant.
    // A text row closed here is a completed message (the model answered, then
    // reached for tools -- the log stores it as one llm entry), so it gets a
    // footer; the turn's duration segment is omitted mid-turn (unknown yet),
    // while the ctx segment rides the producing call's held usage (the
    // TOKEN_USAGE frame precedes this frame in the same ordered sink; see
    // the boundary-commit note in handleStreamingChunk).
    finalizeAssistant({ ts: Date.now(), ctx: lastTurnCtx, callMs: lastTurnCallMs });

    // A preview bubble for this call (streamingToolCall) upgrades in place:
    // the same host element, emptied and re-mounted, so the row never blanks
    // and no second block appears. Re-appending it keeps the order a
    // no-preview turn has (the footer finalizeAssistant may have just landed
    // sits ABOVE the call, not under it). Otherwise: today's fresh host.
    const upgraded = claimInflightHost(name);
    const host = upgraded ?? document.createElement("div");
    if (upgraded) {
      // Reset the host to what a preview-less call would hand the controller:
      // no children (mount refuses a non-empty container) and no preview
      // classes (the in-progress posture and its accent rail must not survive
      // onto a committed block).
      host.className = "";
      host.innerHTML = "";
    }
    container.appendChild(host);
    const block = new ToolBlockController(host as unknown as DomNode, { name, args, argsSummary, display });
    toolBlockHosts.set(block, host);
    if (toolCallId) toolBlocksById.set(toolCallId, block);
    const queue = pendingToolCallsByName.get(name);
    if (queue) queue.push(block);
    else pendingToolCallsByName.set(name, [block]);
    pendingToolResults++;

    hasToolCallsSinceLastAssistant = true;
    scrollBottom();
  }

  function handleToolResult({ name, output, error, images, toolCallId, startLine, meta }: ToolResultMessage): void {
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
    if (pendingToolResults > 0 && block) pendingToolResults--;
    // Round closed (every committed call has its answer): the next thing is a
    // fresh model call with nothing streamed yet, so the per-call tell comes
    // back -- and any preview whose call was answered WITHOUT a committed
    // frame (invalid name, unavailable tool) is dead and drops here.
    if (pendingToolResults === 0) {
      clearInflightToolCalls();
      streamedVisible = false;
      streamedPlain = false;
      syncThinkingRow();
    }
    if (!block) return; // orphan result: no matching call to attach to

    // OMITTED history stubs render as fetch-on-view boxes at the block's
    // foot (message-list owns the seam; tool-block.tsx's ImagesView stays
    // inline-only); the inline remainder rides setResult exactly as before,
    // so live results cannot drift.
    const stubs = images?.filter((im) => im.omitted === true) ?? [];
    const inline = stubs.length > 0 ? images!.filter((im) => im.omitted !== true) : images;
    block.setResult({
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(inline && inline.length > 0 ? { images: inline } : {}),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(meta ? { meta } : {}),
    });
    if (stubs.length > 0) {
      const hostEl = toolBlockHosts.get(block);
      if (hostEl) appendImages(hostEl, stubs);
    }
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

    // Read-only renders (no answer callback -- e.g. cold log replay -- or a
    // worker view, where the delegating manager owns the answer): the card
    // says WHAT it is instead of pretending a submit path exists.
    if (!onQuestionAnswer || questionReadOnly) {
      contentEl.innerHTML = questionReadOnly
        ? `<strong>Question -- asked the delegating manager, awaiting answer:</strong><br>`
        : `<strong>Question:</strong><br>`;
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
    // Terminal: the tell retires with the turn it was waiting on, and no
    // preview outlives the request that produced it.
    setRequestPending(false);
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

  // The failed-attach card: the one shown at a time; Close detaches it,
  // and any pane replacement (clear) forgets the handle with the DOM.
  let attachFallbackEl: HTMLElement | null = null;

  function showAttachUnavailable({ onViewLog }: { onViewLog: () => void }): void {
    attachFallbackEl?.remove();
    const el = document.createElement("div");
    el.className = "message attach-fallback";
    el.setAttribute("role", "alert");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const contentEl = document.createElement("div");
    contentEl.className = "content";
    contentEl.textContent = "Live tail unavailable for this subagent.";
    bubble.appendChild(contentEl);
    const actions = document.createElement("div");
    actions.className = "attach-fallback-actions";
    const viewBtn = document.createElement("button");
    viewBtn.setAttribute("type", "button");
    viewBtn.className = "attach-fallback-btn";
    viewBtn.textContent = "View log";
    viewBtn.addEventListener("click", () => onViewLog());
    const closeBtn = document.createElement("button");
    closeBtn.setAttribute("type", "button");
    closeBtn.className = "attach-fallback-btn";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => {
      el.remove();
      if (attachFallbackEl === el) attachFallbackEl = null;
    });
    actions.appendChild(viewBtn);
    actions.appendChild(closeBtn);
    bubble.appendChild(actions);
    el.appendChild(bubble);
    attachFallbackEl = el;
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
  // Lazy history scroll-up trigger: the TOP mirror of the 150px bottom rule.
  // Edging INTO the top zone (scrollTop <= 150px, with older history to load
  // and a scrollable list) fires onNearTop exactly once per entry; leaving
  // the zone re-arms it. hasOlder is the chat layer's attestation (the
  // server's window flag), never a client guess; clear() resets both.
  const TOP_TRIGGER_PX = 150;
  let hasOlderValue = false;
  // Starts "inside" so a fresh/opened list never fires on its own way to the
  // bottom; the first real entry-edge is what triggers.
  let nearTopInside = true;
  // The scrollTop our prepend restore just wrote (see renderOlderEntries).
  // A scroll event landing exactly on this value is OUR programmatic write,
  // not the user scrolling: it never re-evaluates follow state (numeric
  // restore keeps distFromBottom invariant anyway) and never edges a fresh
  // trigger. The first event at any other value is the user's; the mark dies.
  let restoreTarget: number | null = null;
  function syncNearTop(): void {
    const scrollable = container.scrollHeight - container.clientHeight > 0;
    const inside = scrollable && container.scrollTop <= TOP_TRIGGER_PX;
    if (inside && !nearTopInside && hasOlderValue) onNearTop?.();
    nearTopInside = inside;
  }
  const onScroll = () => {
    if (restoreTarget !== null) {
      const ours = container.scrollTop === restoreTarget;
      restoreTarget = null;
      if (ours) {
        // Programmatic restore: keep follow as-is, only re-sync the trigger
        // zone so the next real scroll-up edges honestly.
        syncNearTop();
        return;
      }
    }
    const distFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    followBottom = distFromBottom <= 150;
    syncJumpButton();
    syncNearTop();
  };
  container.addEventListener("scroll", onScroll);

  // ── Jump-to-bottom button ────────────────────────────────────────────────
  // The un-pinned view's affordance: a round chevron docked on the composer
  // seam (jumpHost = the app's #input-area), visible exactly when the
  // transcript is NOT following the bottom. followBottom is the single
  // source of truth -- syncJumpButton rides the user scroll path, clear(),
  // and the click; the guarded restore never touches it (follow survives the
  // restore, so the button is already right -- and syncing there could flash
  // it mid-anchoring). The click pins INSTANTLY, no smooth scroll: a native
  // animation emits intermediate scroll events whose distFromBottom > 150
  // would flip followBottom off mid-flight, killing the very follow it seeks.
  // Same glyph and size as the sidebar header chevron (#logs-toggle).
  const ICON_CHEVRON_DOWN =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" tabindex="-1">' +
    '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  let jumpButton: HTMLButtonElement | null = null;
  function syncJumpButton(): void {
    if (jumpButton) jumpButton.hidden = followBottom;
  }
  function onJumpClick(): void {
    followBottom = true;
    container.scrollTop = container.scrollHeight;
    syncJumpButton();
  }
  if (jumpHost) {
    jumpButton = document.createElement("button");
    jumpButton.type = "button";
    jumpButton.className = "jump-to-bottom";
    jumpButton.setAttribute("aria-label", "Jump to end");
    jumpButton.hidden = true; // followBottom starts true; hide from frame one
    jumpButton.innerHTML = "Jump to end" + ICON_CHEVRON_DOWN;
    jumpButton.addEventListener("click", onJumpClick);
    jumpHost.appendChild(jumpButton);
  }

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
    // The card's DOM is gone with the pane; drop the handle so a stale
    // reference never blocks a later replacement.
    attachFallbackEl = null;
    followBottom = true;
    syncJumpButton();
    // The lazy-history trigger is per-view: the chat layer re-attests
    // hasOlder after rendering the new view (LOG_VIEWED / attach burst).
    hasOlderValue = false;
    nearTopInside = true;
    restoreTarget = null;
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
    // Live-activity state is per-view: a session switch / cold log / subagent
    // transcript never carries the previous view's row or previews (the
    // container is emptied above, so only the bookkeeping needs it).
    requestPending = false;
    streamedVisible = false;
    streamedPlain = false;
    // The turn-observation flags are per-view too: a fresh manager (or a
    // switched-to session) watched no idle->working edge, so its first
    // working:true is read as a mid-turn attach and re-derives the tell
    // from the burst's UNCOMMITTED lanes (inFlightContent).
    workingSeen = false;
    workingValue = false;
    thinkingRow = null;
    inflightToolHosts.clear();
    inflightSlots = [];
    pendingToolResults = 0;
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
              ? // Same posture as the live wire (s2cToolResult): the META
                // envelope never reaches a chat surface; start_line rides
                // structured via toolContentMeta below.
                toolContentText(entry.content, undefined, { omitMeta: true })
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
                argsSummary?: string;
              };
              const name = toolCall.function?.name || toolCall.name || "unknown";
              const rawArgs = toolCall.function?.arguments ?? toolCall.arguments ?? toolCall.args;
              const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {}, null, 2);
              // The server annotated the entry's calls with their resolved
              // display parts and declared-header fold (handlers-logs.ts), so
              // a browsed log reaches the exact same posture code as a live
              // TOOL_CALL frame.
              handleToolCall({
                name,
                args,
                argsSummary: toolCall.argsSummary,
                display: toolCall.display,
                toolCallId: tc.id || undefined,
              });
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
        case "tool_result": {
          // Cold parity with the live TOOL_RESULT frame: the stored parts'
          // start_line meta numbers the diff gutters with real file lines,
          // and the whole envelope rides structured for the muted facts
          // strip -- a browsed log renders the
          // exact same posture as the live transcript.
          const metaStartLine = Number(toolContentMeta(entry.content, "start_line"));
          const envelope = toolContentMetaAll(entry.content);
          handleToolResult({
            name:
              (entry as { tool_name?: string | null }).tool_name || extractToolNameFromEntry(entry),
            output: content,
            images: entry.images,
            toolCallId: (entry as { tool_call_id?: string | null }).tool_call_id || undefined,
            ...(Number.isInteger(metaStartLine) && metaStartLine > 0 ? { startLine: metaStartLine } : {}),
            ...(envelope ? { meta: envelope } : {}),
          });
          break;
        }
        case "compaction":
          handleCompacting({ message: content });
          break;
      }
    }
    scrollBottom();
  }

  /**
   * Prepend an older history page (loadOlderResult) without the viewport
   * jumping: capture geometry, render the page through the SAME pipeline in
   * a detached mirror list, splice the finished nodes above the current
   * first child, then restore `scrollTop += heightDelta`. Pages lead at a
   * countable message, so a result's calling llm entry is on the page with
   * it and tool-call/result pairing resolves inside the mirror; a page that
   * ends right after an llm entry leaves its blocks in the ordinary pending
   * posture (the interrupted-call idiom, never a crash) -- the mirror never
   * touches the live manager's state and is simply discarded with its
   * (never-destroyed) handles: the moved tool blocks are live transcript
   * now, and its scroll listener dies with the detached node.
   */
  function renderOlderEntries(entries: LogEntry[]): void {
    const prevScrollTop = container.scrollTop;
    const prevScrollHeight = container.scrollHeight;
    const scratch = document.createElement("div");
    // The mirror renders the SAME pipeline, including the image-stub fetch
    // seam: the spliced-in boxes (already live DOM by the time a reply
    // lands) resolve into real pixels just like the first page's.
    const mirror = createMessageList(scratch, {
      hideThinking: hideThinkingValue,
      onQuestionAnswer,
      onFetchImage,
    });
    mirror.renderLogEntries(entries);
    const first = container.firstChild;
    for (const node of [...scratch.childNodes]) {
      // Chrome never splices into the live list: the mirror gets no jump
      // host by construction, and this keeps it that way even if one did.
      if ((node as { classList?: { contains(name: string): boolean } }).classList?.contains("jump-to-bottom")) continue;
      if (first) container.insertBefore(node, first);
      else container.appendChild(node);
    }
    const delta = container.scrollHeight - prevScrollHeight;
    if (delta > 0) {
      container.scrollTop = prevScrollTop + delta;
      restoreTarget = prevScrollTop + delta;
    }
    // Re-sync the trigger zone by hand: the restore moved scrollTop down past
    // the page height, so the next genuine scroll-up INTO the zone edges --
    // the restore itself never counts (see the restoreTarget guard).
    nearTopInside = container.scrollTop > TOP_TRIGGER_PX ? false : nearTopInside;
  }

  /** See MessageListManager.revealMatch. The seek driver (chat.ts) calls
   *  this after every page lands; a miss means "page older", not "retry". */
  function revealMatch(needle: string): boolean {
    if (needle === "") return false;
    const lower = needle.toLowerCase();
    // Guarded: the headless test double for the container may not carry a
    // live children collection; a container without rows never lands.
    const rows = Array.from(
      (container as unknown as { children?: ArrayLike<HTMLElement> }).children ?? [],
    );
    for (const row of rows) {
      if (!row.classList.contains("message")) continue;
      if (!(row.textContent ?? "").toLowerCase().includes(lower)) continue;
      // A hit inside a folded user prompt hides behind the clamp (the text
      // is in the DOM, which is why the scan found it): open the fold first
      // so the flash lands on readable text (expand-on-hit).
      if (row.querySelector(".content.prompt-folded")) setPromptFolded(row, false);
      row.scrollIntoView({ block: "center" });
      row.classList.add("search-flash");
      // Transient: the flash marks WHERE the hit landed, then lets the row
      // read like the rest of the transcript again.
      setTimeout(() => row.classList.remove("search-flash"), 2500);
      return true;
    }
    return false;
  }

  function setHasOlder(hasOlder: boolean): void {
    hasOlderValue = hasOlder;
    // Re-arm WITHOUT firing: the view just opened; the next top-zone ENTRY
    // (a real scroll) is the trigger.
    nearTopInside = true;
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
    if (jumpButton) {
      jumpButton.removeEventListener("click", onJumpClick);
      jumpButton.remove();
      jumpButton = null;
    }
    // The manager is dropped after this: no tool block may outlive it with
    // a live mount still waiting for a result.
    destroyToolBlocks();
  }

  return {
    handleUserMessage,
    handleAssistantMessage,
    handleStreamingChunk,
    handleStreamingReasoningChunk,
    handleStreamingToolCall,
    setRequestPending,
    handleStreamReset,
    handleThinking,
    handleToolCall,
    handleToolResult,
    handleCompacting,
    handleCommandResult,
    handleQuestion,
    setQuestionReadOnly(readOnly: boolean): void {
      questionReadOnly = readOnly;
    },
    handleQuestionAnswered,
    handleTaskProgress,
    handleTokenUsage,
    handleCompactionResult,
    handleSessionState,
    setHideThinking,
    handleError,
    showAttachUnavailable,
    finalizeAssistant,
    noteWorking,
    clear,
    addSystemMessage,
    handleSystemMessage,
    destroy,
    renderLogEntries,
    renderOlderEntries,
    setHasOlder,
    revealMatch,
  };
}
