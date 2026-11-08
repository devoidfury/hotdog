// agent-browser: one model-facing `agent_browser` tool over Bun.WebView (experimental).
//
// Owner rulings this file implements (see README.md for the full contract):
//  - One tool, action enum: open | navigate | snapshot | click | type | press |
//    screenshot | evaluate | close | list.
//  - Standing sessions: named views keyed by the calling hotdog sessionId; views
//    survive across tool calls. SESSION_END closes the session's views -- the
//    known leak pattern in this repo (user-gate's sessionGrants does the same).
//  - Chrome backend is SPAWN-FORCED (`backend: { type: "chrome", url: false }`):
//    never auto-connect to a stray DevToolsActivePort browser. Storage is
//    ephemeral; no persistent dataStore in v1.
//  - Navigation admission: https/http only; the host is resolved and private
//    ranges are BLOCKED, loopback included, unless agentBrowser.allowLoopback.
//    The classifier is fetch-tool's (imported, not forked). onNavigated
//    re-checks landed URLs (redirects, page-initiated jumps) and drives the
//    view back to about:blank when a disallowed host was reached. This is
//    ADMISSION only -- subresources/XHR from an admitted page are not fenced.
//  - `evaluate` runs model-authored JS inside the loaded page. It rides the
//    user-gate TOOL_CALL approval (script-target param rules; a tool-level
//    allow cannot admit it -- see utils/approvals). With no prompt surface
//    (user-gate not enabled) the tool REFUSES evaluate outright: fail closed.
//
// The view is reached through an injectable factory seam (ViewFactory) so unit
// tests drive a fake view; no mock.module anywhere.

import { isIP } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOOKS } from "@core/hooks.ts";
import { AppError, formatError } from "@core/error.ts";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  truncateOutput,
} from "@core/extensions/tool-utils.ts";
import type { ToolDef, ToolMetadata } from "@core/extensions/tool-registry.ts";
import type { ToolContext } from "@core/extensions/tool-context.ts";
import {
  getExtensionConfig,
  type CoreContext,
  type ExtensionInstance,
} from "@core/extensions/types.ts";
import { modelAcceptsImages } from "@core/config/providers.ts";
import { sessionsDir, isSafeSessionId } from "@core/session/session-log.ts";
import { assertPublicHost } from "@extensions/fetch-tool/index.ts";
import { logger } from "@utils/logger.ts";
import type { Agent } from "@core/agent.ts";

// ── Hardcoded limits (documented, deliberately not config) ─────────────────
// Ruling: no speculative config keys. These are the tool's own shape, not knobs.

/** Views a single hotdog session may hold open at once. */
export const MAX_VIEWS_PER_SESSION = 3;
/** Default viewport for created views (CSS pixels). */
const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 900;
/**
 * Wall-clock ceiling for EVERY queue-bound view step: an action's place in
 * the view's FIFO plus the page call itself, the navigation guard's URL
 * check and about:blank egress, and the queue drain. A stalled page load or
 * a stalled egress must never hold a model turn or wedge the FIFO past this
 * point: the call rejects with a timeout error and the view is poisoned
 * until close/reopen (see #govern). Tests override it through the
 * constructor seam ONLY (house precedent: mcp-client's killGraceMs) --
 * deliberately not a config key.
 */
const VIEW_OP_TIMEOUT_MS = 30_000;
/**
 * Selector-click actionability wait -- Bun's own per-call timeout option.
 * Relationship to the watchdog: this bounds the common "selector never
 * became actionable" case BELOW the generic ceiling, so the specific error
 * surfaces first and (being a settled rejection) does not poison the view.
 * The watchdog still covers what Bun does not bound -- coordinate clicks,
 * navigate, evaluate, screenshot capture -- plus a renderer wedged so hard
 * it ignores Bun's timeout entirely. Keep it well inside VIEW_OP_TIMEOUT_MS.
 */
const CLICK_TIMEOUT_MS = 10_000;
/** Snapshot extraction: elements collected / output lines shown (house truncateOutput seam). */
const SNAPSHOT_MAX_ELEMENTS = 200;
const SNAPSHOT_MAX_LINES = 150;
/** Inline-image budget (source bytes). read.ts images bypass tool-result char caps
 *  (review 11-02 frame-cap H-1), so the byte fence lives here, at the source. */
const SCREENSHOT_BUDGET_BYTES = 1_500_000;
/** Re-encode ladder when the PNG overshoots the budget: jpeg quality/width steps. */
const RECOMPRESS_STEPS: ReadonlyArray<{ width: number | null; quality: number }> = [
  { width: null, quality: 75 },
  { width: null, quality: 55 },
  { width: 800, quality: 55 },
  { width: 600, quality: 40 },
];
/** Cap on a model-facing evaluate result (page JSON is unbounded). */
const EVALUATE_RESULT_MAX_CHARS = 8_000;

const ACTIONS = [
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "screenshot",
  "evaluate",
  "close",
  "list",
] as const;

// ── View seam ───────────────────────────────────────────────────────────────

/** The slice of Bun.WebView this tool uses; tests pass a duck-typed fake. */
export interface BrowserView {
  navigate(url: string): Promise<void>;
  evaluate<T = unknown>(script: string): Promise<T>;
  screenshot(options: {
    encoding: "base64";
    format: "png" | "jpeg";
    quality?: number;
  }): Promise<string>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  readonly url: string;
  readonly title: string;
  onNavigated: ((url: string, title: string) => void) | null;
  close(): void;
}

export interface ViewOptions {
  width: number;
  height: number;
}

export type ViewFactory = (options: ViewOptions) => BrowserView;

/**
 * The exact Bun.WebView constructor options (pure, so the spawn-forced
 * backend and ephemeral storage are pinned by unit tests without a browser).
 * `url: false` skips DevToolsActivePort auto-detect: always spawn a fresh
 * headless Chrome, never hijack the user's running browser.
 */
export function bunWebViewOptions(options: ViewOptions): Record<string, unknown> {
  return {
    width: options.width,
    height: options.height,
    backend: { type: "chrome", url: false },
    dataStore: "ephemeral",
  };
}

export const createBunWebView: ViewFactory = (options) =>
  new Bun.WebView(bunWebViewOptions(options));

// ── Navigation admission ────────────────────────────────────────────────────

/** Loopback by NAME/literal only (localhost, 127/8, ::1); used under allowLoopback. */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  const bare = host.toLowerCase().split("%")[0] ?? host;
  return bare === "::1" || bare === "0:0:0:0:0:0:0:1";
}

/**
 * Admit a navigation target: https/http only; the host is resolved and
 * private/reserved ranges are refused (loopback included) unless `allowLoopback`
 * additionally opens the loopback literals. about:blank is admitted -- it is
 * the guard's own egress target. Fails closed on unparseable/unresolvable URLs.
 * Returns an error string or null when allowed.
 */
export async function checkNavigationAllowed(
  urlText: string,
  allowLoopback: boolean,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    return `"${urlText.slice(0, 200)}" is not a valid absolute URL.`;
  }
  if (parsed.protocol === "about:") {
    return parsed.href === "about:blank" ? null : "only about:blank is allowed among about: URLs";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `scheme "${parsed.protocol}" is not allowed; the browser navigates only to http(s) URLs.`;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (allowLoopback && isLoopbackHost(host)) return null;
  return assertPublicHost(host);
}

// ── Snapshot extraction (extension-internal) ────────────────────────────────
// NOT the gated model `evaluate` action: this script is fixed extension code
// shipped in this file, run via view.evaluate to enumerate interactive elements
// for the model. The model-authored path is `#modelEvaluate` and must go
// through the approval gate; keep the two code paths separate.

const SNAPSHOT_SCRIPT = `(() => {
  const kMax = ${SNAPSHOT_MAX_ELEMENTS};
  const sel = "a[href],button,input,select,textarea,summary,[role],[contenteditable='true'],[onclick],[tabindex]";
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const label = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "";
    const text = (el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    out.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      cls: (typeof el.className === "string" ? el.className : "").slice(0, 60),
      name: el.getAttribute("name") || "",
      role: el.getAttribute("role") || "",
      type: el.getAttribute("type") || "",
      label: label.slice(0, 80),
      text,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    });
    if (out.length >= kMax) break;
  }
  return { url: location.href, title: document.title, elements: out };
})()`;

function formatSnapshot(raw: unknown): string {
  const page = raw as {
    url?: string;
    title?: string;
    elements?: Array<Record<string, string | number>>;
  } | null;
  const elements = Array.isArray(page?.elements) ? page.elements : [];
  const header = `URL: ${page?.url ?? "?"}\nTitle: ${page?.title ?? ""}`;
  const lines = elements.map((el, i) => {
    const bits: string[] = [`${i + 1}. ${el.tag}`];
    if (el.id) bits.push(`#${el.id}`);
    if (el.cls) bits.push(`.${String(el.cls).split(/\s+/).join(".")}`);
    for (const k of ["name", "type", "role"] as const) {
      if (el[k]) bits.push(`${k}=${el[k]}`);
    }
    if (el.label) bits.push(`aria="${el.label}"`);
    if (el.text) bits.push(`"${el.text}"`);
    bits.push(`(${el.x},${el.y})`);
    return bits.join(" ");
  });
  if (lines.length === 0) lines.push("(no visible interactive elements)");
  return truncateOutput(`${header}\n${lines.join("\n")}`, SNAPSHOT_MAX_LINES);
}

// ── Sessions ────────────────────────────────────────────────────────────────

interface OpenView {
  name: string;
  view: BrowserView;
  /** Per-view FIFO: Bun.WebView rejects a second in-flight evaluate/navigate. */
  queue: Promise<unknown>;
  /** Set by the onNavigated guard when a landed URL was disallowed. */
  blocked: string | null;
  closed: boolean;
  /**
   * Non-null once a queue-bound step hit the watchdog: the view is wedged
   * (an abandoned page call still owns it) and holds the reason. Queue-bound
   * calls then fail fast; `list`/`close` stay queue-free, and close, a
   * same-name re-open, or SESSION_END (any path that drops the entry) fully
   * recovers the name.
   */
  poison: string | null;
}

const VIEW_NAME_RE = /^[a-zA-Z0-9._-]{1,48}$/;

// ── Tool ────────────────────────────────────────────────────────────────────

export interface AgentBrowserToolOptions {
  /** Resolved agentBrowser.allowLoopback (no backup default here). */
  allowLoopback: boolean;
  /** Injectable factory seam; production wires createBunWebView. */
  createView: ViewFactory;
  /** True only when the user-gate extension is enabled (evaluate prompt surface). */
  userGateEnabled: boolean;
  /**
   * Per-op watchdog ceiling override, a tests-only constructor seam
   * (house precedent: mcp-client's killGraceMs), never a config knob;
   * production always takes VIEW_OP_TIMEOUT_MS.
   */
  opTimeoutMs?: number;
}

export class AgentBrowserTool {
  static readonly TOOL_NAME = "agent_browser";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 3, tags: ["network"] };

  #allowLoopback: boolean;
  #createView: ViewFactory;
  #userGateEnabled: boolean;
  #opTimeoutMs: number;
  /** sessionId -> view name -> view. Caller sessions survive tool calls. */
  #sessions = new Map<string, Map<string, OpenView>>();

  constructor(options: AgentBrowserToolOptions) {
    this.#allowLoopback = options.allowLoopback;
    this.#createView = options.createView;
    this.#userGateEnabled = options.userGateEnabled;
    this.#opTimeoutMs = options.opTimeoutMs ?? VIEW_OP_TIMEOUT_MS;
  }

  toToolDef(): ToolDef {
    return toolDef(
      AgentBrowserTool.TOOL_NAME,
      `Drive a headless browser view (experimental; Bun.WebView on a spawned Chromium, ephemeral storage). Actions: open (create a named view and load an http(s) URL), navigate (load a URL in an existing view), snapshot (structured text of interactive elements with click coordinates), click (CSS selector or viewport x/y), type (text into the focused element), press (a key, e.g. Enter), screenshot (viewport PNG), evaluate (run JavaScript you write inside the loaded page -- always prompts for user approval, and is refused when no approval UI exists), close (one view, or all of the session's views), list. Views are per-session, survive across calls, and are capped at ${MAX_VIEWS_PER_SESSION} per session. Navigation is admission-checked (https/http only, private/loopback hosts blocked) and re-checked after redirects; subresources and page requests of an admitted page are NOT fenced.`,
      {
        properties: {
          action: param("string", "Browser action to perform", { enum: [...ACTIONS] }),
          view: param(
            "string",
            'Named view to operate on (default "main"). open creates/replaces it; close without a name closes all of the session\'s views.',
          ),
          url: param("string", "Absolute http(s) URL for open/navigate"),
          selector: param("string", "CSS selector for click (waits for the element to be actionable)"),
          x: param("number", "Viewport x coordinate for click"),
          y: param("number", "Viewport y coordinate for click"),
          text: param("string", "Text for type (goes to the focused element)"),
          key: param(
            "string",
            "Key for press: Enter, Tab, Space, Escape, Backspace, Delete, Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, or a single character",
          ),
          script: param(
            "string",
            "JavaScript EXPRESSION for evaluate, run inside the loaded page (awaited; results must be JSON-serializable). Requires user approval per distinct script.",
          ),
        },
        required: ["action"],
      },
    );
  }

  /** Close every view of a session (SESSION_END). Exported via the extension hook. */
  closeSession(sessionId: string): void {
    const views = this.#sessions.get(sessionId);
    if (!views) return;
    for (const entry of views.values()) this.#closeView(entry);
    this.#sessions.delete(sessionId);
  }

  /** View count for a session (tests / diagnostics). */
  viewCount(sessionId: string): number {
    return this.#sessions.get(sessionId)?.size ?? 0;
  }

  async execute(input: string | Record<string, unknown> | null, ctx?: ToolContext): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args) return ToolResult.err("agent_browser: could not parse arguments");
    const action = args.action;
    if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
      return ToolResult.err(
        `agent_browser: unknown action ${JSON.stringify(action)}. Valid: ${ACTIONS.join(", ")}`,
      );
    }

    const agent = ctx?.get("agent") as Agent | undefined;
    const sessionId = typeof agent?.sessionId === "string" ? agent.sessionId : "";
    // The run's cancellation (ToolExecutor wires it; standalone callers have none).
    const signal = ctx?.get("abortSignal") ?? null;

    // Stateful actions must belong to a session: views are reclaimed at
    // SESSION_END, and a sessionless view lands in a shared "" bucket that no
    // session end can ever reach (a live Chromium view pinned forever).
    // `list`/`close` on that necessarily-empty bucket are harmless no-ops.
    if (sessionId === "" && action !== "close" && action !== "list") {
      return ToolResult.err(
        `agent_browser: ${action} needs a sessionId on the calling context; views are reclaimed when their session ends, and a sessionless view could never be.`,
      );
    }

    try {
      switch (action) {
        case "open":
          return await this.#open(args, sessionId, signal);
        case "navigate":
          return await this.#navigate(args, sessionId, signal);
        case "snapshot":
          return await this.#snapshot(args, sessionId, signal);
        case "click":
          return await this.#click(args, sessionId, signal);
        case "type":
          return await this.#type(args, sessionId, signal);
        case "press":
          return await this.#press(args, sessionId, signal);
        case "screenshot":
          return await this.#screenshot(args, sessionId, signal, agent);
        case "evaluate":
          return await this.#modelEvaluate(args, sessionId, signal);
        case "close":
          return this.#close(args, sessionId);
        case "list":
          return this.#list(sessionId);
        default:
          return ToolResult.err(`agent_browser: unreachable action ${action}`);
      }
    } catch (err) {
      return ToolResult.err(formatError(err));
    }
  }

  // ── view plumbing ─────────────────────────────────────────────────────────

  #views(sessionId: string): Map<string, OpenView> {
    let mine = this.#sessions.get(sessionId);
    if (!mine) {
      mine = new Map();
      this.#sessions.set(sessionId, mine);
    }
    return mine;
  }

  #viewName(args: Record<string, unknown>): string | null {
    if (args.view === undefined || args.view === null || args.view === "") return "main";
    if (typeof args.view !== "string" || !VIEW_NAME_RE.test(args.view)) {
      return null;
    }
    return args.view;
  }

  #getEntry(args: Record<string, unknown>, sessionId: string):
    | { entry: OpenView; name: string }
    | { error: ToolResult } {
    const name = this.#viewName(args);
    if (name === null) {
      return { error: ToolResult.err(`agent_browser: invalid view name ${JSON.stringify(args.view)} (use [a-zA-Z0-9._-]{1,48})`) };
    }
    const entry = this.#views(sessionId).get(name);
    if (!entry) {
      return {
        error: ToolResult.err(`agent_browser: no view "${name}" is open`).withHint(
          `Call action=open first (existing views: ${[...this.#views(sessionId).keys()].join(", ") || "none"}).`,
        ),
      };
    }
    // Wedged views refuse queue-bound work FAST: never queue behind the
    // abandoned call that poisoned them. list/close bypass #getEntry and
    // keep working; close (or same-name re-open / SESSION_END) recovers.
    if (entry.poison) {
      return {
        error: ToolResult.err(
          `agent_browser: view "${name}" is wedged: ${entry.poison}. It still holds a page operation that never completed, so no new operation is accepted.`,
        ).withHint(`Close it (action=close, view="${name}") and open it again; "list" and "close" still work on a wedged view.`),
      };
    }
    return { entry, name };
  }

  /** Serialize one view operation (Bun.WebView allows one in-flight per view). */
  #enqueue<T>(entry: OpenView, op: () => Promise<T>): Promise<T> {
    const run = entry.queue.then(op, op);
    entry.queue = run.catch(() => {});
    return run;
  }

  /** Wait until the operation queue (including guard egress) is fully drained. */
  async #settle(entry: OpenView): Promise<void> {
    let queue: Promise<unknown>;
    do {
      queue = entry.queue;
      await queue;
    } while (queue !== entry.queue);
  }

  /**
   * Await `work` (already started) under BOTH the per-op ceiling and the
   * run's abort signal -- the one governed-wait primitive every queue-bound
   * step uses (operations plus their FIFO wait, the guard's check/egress,
   * the queue drain).
   *
   * Ceiling hit: the view is poisoned (the abandoned page call owns the
   * FIFO; Bun.WebView has no cancel -- poisoning is what contains it) and an
   * expected "timeout" error names the view and its recovery. Abort: an
   * expected "cancelled" error WITHOUT poisoning -- the abandoned call
   * usually settles on its own and leaves a healthy view, and if it never
   * does, the NEXT caller's own ceiling converts that wedge into a poison
   * within one ceiling. That is the bounded-degradation posture: every wait
   * here is bounded, so no state can leave a follow-up call hanging
   * unbounded; recovery is always close/reopen. The timer and listener are
   * always cleared, even when the abort wins, so a released call never pins
   * the process with a stray timer. `work` keeps running after either loss;
   * its late settle/rejection stays handled by Promise.race (no unhandled
   * rejections). `signal` is null for guard steps, which fire outside any
   * calling run.
   */
  async #govern<T>(
    entry: OpenView,
    label: string,
    work: Promise<T>,
    signal: AbortSignal | null,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new AppError(
        `agent_browser: the run was cancelled before ${label} could touch view "${entry.name}".`,
        "cancelled",
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ceiling = new Promise<"ceiling">((resolve) => {
      timer = setTimeout(() => resolve("ceiling"), this.#opTimeoutMs);
    });
    let detach: () => void = () => {};
    const aborted = new Promise<"abort">((resolve) => {
      if (!signal) return;
      const onAbort = () => resolve("abort");
      signal.addEventListener("abort", onAbort, { once: true });
      detach = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      const winner = await Promise.race([work.then(() => "done" as const), ceiling, aborted]);
      if (winner === "ceiling") {
        const reason = `${label} did not finish within ${this.#opTimeoutMs} ms; the page never answered`;
        entry.poison ??= reason;
        throw new AppError(
          `agent_browser: view "${entry.name}" hit its operation ceiling: ${reason}. Close it (action=close, view="${entry.name}") and open a fresh one.`,
          "timeout",
        );
      }
      if (winner === "abort") {
        throw new AppError(
          `agent_browser: the run was cancelled while ${label} was pending on view "${entry.name}"; the browser call was released and its outcome is unknown. If the view misbehaves, close it (action=close, view="${entry.name}") and reopen.`,
          "cancelled",
        );
      }
      return await work;
    } finally {
      clearTimeout(timer);
      detach();
    }
  }

  /**
   * Run one queue-bound view operation: FIFO position + page call under the
   * governed wait (ceiling + abort; see #govern for the degradation
   * posture). An already-aborted run never touches the view at all.
   */
  async #runView<T>(
    entry: OpenView,
    label: string,
    signal: AbortSignal | null,
    op: () => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new AppError(
        `agent_browser: the run was cancelled before ${label} could touch view "${entry.name}".`,
        "cancelled",
      );
    }
    return this.#govern(entry, label, this.#enqueue(entry, op), signal);
  }

  /** Await the FIFO drain (incl. guard egress): ceilinged and cancellable like #runView. */
  async #drain(entry: OpenView, signal: AbortSignal | null): Promise<void> {
    await this.#govern(
      entry,
      "the view's pending work (navigation guard)",
      this.#settle(entry),
      signal,
    );
  }

  /**
   * The landed-URL guard. onNavigated fires for redirects and page-initiated
   * jumps too, before navigate() resolves -- the egress navigation queues
   * behind the in-flight one instead of racing it (ERR_INVALID_STATE). The
   * whole check+egress runs under the same per-op ceiling as ordinary
   * operations: a stalled egress (the 0.0.0.x class) must release the FIFO,
   * and a guard that times out poisons the view -- it can neither confirm
   * the landing nor leave it, so follow-up work must fail fast, not queue
   * behind a page stuck on a disallowed host.
   */
  #installGuard(entry: OpenView): void {
    entry.view.onNavigated = (landed: string) => {
      void this.#enqueue(entry, () => this.#guardLanding(entry, landed));
    };
  }

  async #guardLanding(entry: OpenView, landed: string): Promise<void> {
    if (entry.closed || entry.poison) return;
    let problem: string | null;
    try {
      problem = await this.#govern(
        entry,
        "the navigation guard's URL check",
        checkNavigationAllowed(landed, this.#allowLoopback),
        null, // the guard fires from onNavigated, outside any calling run
      );
    } catch (err) {
      // Watchdog (already poisoned) or a checker bug; either way the landing
      // is unjudged -- report it, and let the poison (if any) fail the next call.
      entry.blocked ??= `landed on "${landed}" and the guard could not finish checking it (${formatError(err)}).`;
      logger.warn(`agent-browser: navigation guard check failed: ${formatError(err)}`);
      return;
    }
    if (!problem) return;
    try {
      await this.#govern(
        entry,
        "the navigation guard's about:blank egress",
        entry.view.navigate("about:blank"),
        null,
      );
      entry.blocked = `landed on "${landed}" which is not allowed (${problem}); the view was returned to about:blank.`;
    } catch (err) {
      // Timeout poisons (the view is stuck ON a disallowed host); a plain
      // rejection leaves the view usable but must still surface.
      entry.blocked ??= `landed on "${landed}" which is not allowed (${problem}); returning it to about:blank failed (${formatError(err)}).`;
      logger.warn(`agent-browser: egress navigation failed: ${formatError(err)}`);
    }
  }

  #closeView(entry: OpenView): void {
    if (entry.closed) return;
    entry.closed = true;
    entry.view.onNavigated = null;
    try {
      entry.view.close();
    } catch (err) {
      logger.warn(`agent-browser: closing a view failed: ${formatError(err)}`);
    }
  }

  /** Take the guard note (report-and-clear). */
  #takeGuardNote(entry: OpenView): string | null {
    const note = entry.blocked;
    entry.blocked = null;
    return note;
  }

  async #admittedNavigate(
    entry: OpenView,
    url: string,
    signal: AbortSignal | null,
  ): Promise<ToolResult | null> {
    const problem = await checkNavigationAllowed(url, this.#allowLoopback);
    if (problem) {
      return ToolResult.err(`agent_browser: navigation refused for ${url}: ${problem}`).withHint(
        "Only public http(s) hosts are allowed; agentBrowser.allowLoopback additionally opens localhost/127.x/::1.",
      );
    }
    await this.#runView(entry, "navigation", signal, () => entry.view.navigate(url));
    await this.#drain(entry, signal);
    const note = this.#takeGuardNote(entry);
    if (note) return ToolResult.err(`agent_browser: blocked by navigation guard: ${note}`);
    return null;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  async #open(
    args: Record<string, unknown>,
    sessionId: string,
    signal: AbortSignal | null,
  ): Promise<ToolResult> {
    const name = this.#viewName(args);
    if (name === null) return ToolResult.err(`agent_browser: invalid view name ${JSON.stringify(args.view)} (use [a-zA-Z0-9._-]{1,48})`);
    const url = typeof args.url === "string" ? args.url : "";
    if (!url) return ToolResult.err("agent_browser: open needs a url").withHint('Pass url: "https://example.com".');

    // Admission BEFORE creation: a refused URL must not burn a cap slot on a blank view.
    const problem = await checkNavigationAllowed(url, this.#allowLoopback);
    if (problem) {
      return ToolResult.err(`agent_browser: navigation refused for ${url}: ${problem}`).withHint(
        "Only public http(s) hosts are allowed; agentBrowser.allowLoopback additionally opens localhost/127.x/::1.",
      );
    }

    const views = this.#views(sessionId);
    const existing = views.get(name);
    if (!existing && views.size >= MAX_VIEWS_PER_SESSION) {
      return ToolResult.err(
        `agent_browser: this session already holds ${MAX_VIEWS_PER_SESSION} views (the hardcoded cap).`,
      ).withHint("Close a view first (action=close, name it in view), or reuse one with action=navigate.");
    }
    if (existing) this.#closeView(existing); // open replaces a view of the same name

    let entry: OpenView;
    try {
      const view = this.#createView({ width: VIEW_WIDTH, height: VIEW_HEIGHT });
      entry = { name, view, queue: Promise.resolve(), blocked: null, closed: false, poison: null };
      views.set(name, entry);
      this.#installGuard(entry);
    } catch (err) {
      return ToolResult.err(`agent_browser: could not create a browser view: ${formatError(err)}`).withHint(
        "The Chrome backend needs Chromium/Chrome installed (BUN_CHROME_PATH overrides the search).",
      );
    }

    await this.#runView(entry, "the initial page load", signal, () => entry.view.navigate(url));
    await this.#drain(entry, signal);
    const note = this.#takeGuardNote(entry);
    if (note) return ToolResult.err(`agent_browser: blocked by navigation guard: ${note}`);
    return ToolResult.ok(`Opened view "${name}": ${entry.view.url} ("${entry.view.title}")`);
  }

  async #navigate(
    args: Record<string, unknown>,
    sessionId: string,
    signal: AbortSignal | null,
  ): Promise<ToolResult> {
    const got = this.#getEntry(args, sessionId);
    if ("error" in got) return got.error;
    const url = typeof args.url === "string" ? args.url : "";
    if (!url) return ToolResult.err("agent_browser: navigate needs a url").withHint('Pass url: "https://example.com".');
    const blocked = await this.#admittedNavigate(got.entry, url, signal);
    if (blocked) return blocked;
    return ToolResult.ok(`View "${got.name}" at ${got.entry.view.url} ("${got.entry.view.title}")`);
  }

  async #snapshot(
    args: Record<string, unknown>,
    sessionId: string,
    signal: AbortSignal | null,
  ): Promise<ToolResult> {
    const got = this.#getEntry(args, sessionId);
    if ("error" in got) return got.error;
    // Extension-internal extraction (fixed script in this file) -- see
    // SNAPSHOT_SCRIPT: deliberately NOT the gated model-evaluate path.
    const raw = await this.#runView(got.entry, "the snapshot extraction", signal, () =>
      got.entry.view.evaluate<unknown>(SNAPSHOT_SCRIPT),
    );
    await this.#drain(got.entry, signal);
    const text = formatSnapshot(raw);
    const note = this.#takeGuardNote(got.entry);
    return ToolResult.ok(note ? `${text}\nWARNING: navigation guard ${note}` : text);
  }

  async #click(
    args: Record<string, unknown>,
    sessionId: string,
    signal: AbortSignal | null,
  ): Promise<ToolResult> {
    const got = this.#getEntry(args, sessionId);
    if ("error" in got) return got.error;
    const { entry } = got;
    if (typeof args.selector === "string" && args.selector !== "") {
      // Bun's own actionability wait (see CLICK_TIMEOUT_MS) usually fires
      // before the watchdog here and rejects cleanly without poisoning; the
      // watchdog is the backstop for a renderer that ignores it.
      await this.#runView(entry, "the click", signal, () =>
        entry.view.click(args.selector as string, { timeout: CLICK_TIMEOUT_MS }),
      );
    } else if (typeof args.x === "number" && typeof args.y === "number") {
      await this.#runView(entry, "the click", signal, () => entry.view.click(args.x as number, args.y as number));
    } else {
      return ToolResult.err("agent_browser: click needs a selector or numeric x and y").withHint(
        'A snapshot line shows each element\'s (x,y) center; selector clicks wait for actionability.',
      );
    }
    await this.#drain(entry, signal);
    const note = this.#takeGuardNote(entry);
    if (note) return ToolResult.err(`agent_browser: blocked by navigation guard: ${note}`);
    return ToolResult.ok(`Clicked in view "${got.name}": ${entry.view.url} ("${entry.view.title}")`);
  }

  async #type(
    args: Record<string, unknown>,
    sessionId: string,
    signal: AbortSignal | null,
  ): Promise<ToolResult> {
    const got = this.#getEntry(args, sessionId);
    if ("error" in got) return got.error;
    if (typeof args.text !== "string") return ToolResult.err("agent_browser: type needs a text string");
    await this.#runView(got.entry, "typing", signal, () => got.entry.view.type(args.text as string));
    await this.#drain(got.entry, signal);
    const note = this.#takeGuardNote(got.entry);
    return ToolResult.ok(
      note
        ? `Typed into view "${got.name}". WARNING: navigation guard ${note}`
        : `Typed ${JSON.stringify(args.text)} into view "${got.name}".`,
    );
  }

  async #press(
    args: Record<string, unknown>,
    sessionId: string,
    signal: AbortSignal | null,
  ): Promise<ToolResult> {
    const got = this.#getEntry(args, sessionId);
    if ("error" in got) return got.error;
    if (typeof args.key !== "string" || args.key === "") {
      return ToolResult.err("agent_browser: press needs a key (e.g. Enter, Tab, Escape)");
    }
    await this.#runView(got.entry, "the key press", signal, () => got.entry.view.press(args.key as string));
    await this.#drain(got.entry, signal);
    const note = this.#takeGuardNote(got.entry);
    if (note) return ToolResult.err(`agent_browser: blocked by navigation guard: ${note}`);
    return ToolResult.ok(`Pressed ${JSON.stringify(args.key)} in view "${got.name}".`);
  }

  async #screenshot(
    args: Record<string, unknown>,
    sessionId: string,
    signal: AbortSignal | null,
    agent: Agent | undefined,
  ): Promise<ToolResult> {
    const got = this.#getEntry(args, sessionId);
    if ("error" in got) return got.error;
    const { entry } = got;

    const png = Buffer.from(
      await this.#runView(entry, "screenshot capture", signal, () =>
        entry.view.screenshot({ encoding: "base64", format: "png" }),
      ),
      "base64",
    );
    await this.#drain(entry, signal);

    let mime = "image/png";
    let ext = "png";
    let bytes: Buffer<ArrayBufferLike> = png;
    if (png.byteLength > SCREENSHOT_BUDGET_BYTES) {
      const shrunk = await recompressJpeg(png);
      if (shrunk) {
        bytes = shrunk;
        mime = "image/jpeg";
        ext = "jpg";
      }
    }

    const path = await saveScreenshot(bytes, ext, sessionId);
    const label = `Screenshot of view "${got.name}" (${entry.view.url}): ${path} (${mime}, ${(bytes.byteLength / 1024).toFixed(1)}KB)`;

    if (bytes.byteLength > SCREENSHOT_BUDGET_BYTES) {
      // Still over budget after every ladder step: save only, never attach.
      return ToolResult.ok(
        `${label} -- over the ${(SCREENSHOT_BUDGET_BYTES / 1_000_000).toFixed(1)}MB inline budget even after re-encoding; saved to disk, not attached.`,
      ).withEntries({ path, size: String(bytes.byteLength) });
    }

    if (!modelAcceptsImages(agent?.model, agent?.modelRegistry ?? null)) {
      return ToolResult.ok(`${label} -- the current model is not vision-capable, so the image is not attached.`).withEntries({
        path,
        size: String(bytes.byteLength),
      });
    }

    return ToolResult.ok(label)
      .withImages([{ type: "image_url", mimeType: mime, data: bytes.toString("base64") }])
      .withEntries({ path, mime_type: mime, size: String(bytes.byteLength) });
  }

  /**
   * The gated model-authored JS path -- deliberately separate from the
   * snapshot extraction above. Ruling: without an enabled user-gate there is
   * no prompt surface (one-shot, CI, gate off), so evaluate REFUSES here
   * (fail closed); the user never sees a tool result for JS nobody approved.
   * With the gate on, the approval decision itself happens in the TOOL_CALL
   * pipeline (user-gate + utils/approvals: the `script` param is the target;
   * a tool-level allow cannot admit it).
   */
  async #modelEvaluate(
    args: Record<string, unknown>,
    sessionId: string,
    signal: AbortSignal | null,
  ): Promise<ToolResult> {
    if (!this.#userGateEnabled) {
      return ToolResult.err(
        "agent_browser: the evaluate action runs model-authored JavaScript inside whatever page is loaded, and there is no approval prompt surface here (the user-gate extension is not enabled). Refused.",
      ).withHint("Use snapshot for page structure, or enable user-gate (userGate.enabled: true) in an interactive session.");
    }
    const got = this.#getEntry(args, sessionId);
    if ("error" in got) return got.error;
    const script = typeof args.script === "string" ? args.script : "";
    if (script === "") return ToolResult.err("agent_browser: evaluate needs a script (a JavaScript expression)");

    const result = await this.#runView(got.entry, "the evaluate script", signal, () =>
      got.entry.view.evaluate<unknown>(script),
    );
    await this.#drain(got.entry, signal);
    const note = this.#takeGuardNote(got.entry);
    let text: string;
    try {
      text = JSON.stringify(result === undefined ? "(undefined)" : result) ?? "(undefined)";
    } catch {
      text = "(result not JSON-serializable)";
    }
    if (text.length > EVALUATE_RESULT_MAX_CHARS) {
      text = `${text.slice(0, EVALUATE_RESULT_MAX_CHARS)}\n--- [truncated at ${EVALUATE_RESULT_MAX_CHARS} chars] ---`;
    }
    return ToolResult.ok(note ? `${text}\nWARNING: navigation guard ${note}` : text);
  }

  #close(args: Record<string, unknown>, sessionId: string): ToolResult {
    const views = this.#views(sessionId);
    if (args.view === undefined || args.view === null || args.view === "") {
      const names = [...views.keys()];
      for (const entry of views.values()) this.#closeView(entry);
      views.clear();
      return ToolResult.ok(
        names.length > 0 ? `Closed ${names.length} view(s): ${names.join(", ")}.` : "No views were open.",
      );
    }
    const name = this.#viewName(args);
    if (name === null) return ToolResult.err(`agent_browser: invalid view name ${JSON.stringify(args.view)} (use [a-zA-Z0-9._-]{1,48})`);
    const entry = views.get(name);
    if (!entry) return ToolResult.err(`agent_browser: no view "${name}" is open`);
    this.#closeView(entry);
    views.delete(name);
    return ToolResult.ok(`Closed view "${name}".`);
  }

  #list(sessionId: string): ToolResult {
    const views = this.#views(sessionId);
    if (views.size === 0) return ToolResult.ok(`No views open (cap ${MAX_VIEWS_PER_SESSION} per session).`);
    const lines = [...views.values()].map(
      (e) => `"${e.name}": ${e.view.url} ("${e.view.title}")${e.closed ? " [closed]" : ""}`,
    );
    lines.push(`(${views.size}/${MAX_VIEWS_PER_SESSION} views)`);
    return ToolResult.ok(lines.join("\n"));
  }
}

// ── Screenshot helpers ──────────────────────────────────────────────────────

/** Re-encode an oversized PNG as jpeg down the ladder; null when no step fits. */
async function recompressJpeg(png: Buffer): Promise<Buffer | null> {
  for (const step of RECOMPRESS_STEPS) {
    try {
      const img = new Bun.Image(png);
      if (step.width !== null) img.resize(step.width, undefined, { fit: "inside", withoutEnlargement: true });
      const out = await img.jpeg({ quality: step.quality }).toBuffer();
      if (out.byteLength <= SCREENSHOT_BUDGET_BYTES) return out;
    } catch (err) {
      logger.warn(`agent-browser: screenshot re-encode step failed: ${formatError(err)}`);
    }
  }
  return null;
}

/**
 * Save under the session's directory (sessionsDir, honoring HOTDOG_SESSIONS_DIR;
 * tests point that at a tmp dir). A missing/unsafe sessionId must not traverse
 * or litter the real dir, so those saves land in a private tmp directory.
 */
async function saveScreenshot(bytes: Buffer, ext: string, sessionId: string): Promise<string> {
  let dir: string;
  let id = "session";
  if (isSafeSessionId(sessionId)) {
    dir = sessionsDir();
    id = sessionId;
  } else {
    dir = await mkdtemp(join(tmpdir(), "hotdog-agent-browser-"));
  }
  await mkdir(dir, { recursive: true });
  const path = join(dir, `agent-browser-${id}-${Date.now()}.${ext}`);
  await writeFile(path, bytes);
  return path;
}

// ── Extension entry point ───────────────────────────────────────────────────

export function create(core: CoreContext): ExtensionInstance {
  // Config defaults come from extension.json configSchema (single key, by ruling).
  const config = getExtensionConfig<{ allowLoopback: boolean }>(core, "agentBrowser");
  const allowLoopback = config.allowLoopback === true;

  // Evaluate prompt-surface probe (ruling 4): read user-gate's own resolved
  // block; absent or disabled means no interactive approval exists anywhere,
  // so evaluate fails closed inside the tool rather than executing ungated.
  const userGateEnabled =
    getExtensionConfig<{ enabled?: boolean }>(core, "userGate").enabled === true;

  const tool = new AgentBrowserTool({ allowLoopback, createView: createBunWebView, userGateEnabled });

  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register(AgentBrowserTool.TOOL_NAME, tool);
      },
      // The leak pin: a dead session must not keep Chromium views open
      // (same reclaim hook user-gate/file-watch/loop-detect use).
      [HOOKS.SESSION_END]: ({ sessionId }: { sessionId: string }) => {
        tool.closeSession(sessionId);
      },
    },

    // Expose for external use (matches fetch-tool's pattern).
    agentBrowserTool: tool,
  };
}
