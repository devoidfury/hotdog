// The codemode tool: schema, description (domain index from catalog.ts),
// display metadata, envelope-param validation, the run (bridge + result
// assembly), and nothing else.
//
// The schema is exactly { code (required string), timeout_ms?,
// max_output_chars? } with additionalProperties: false, so an invented key is
// a schema error rather than something silently carried. Option discipline is
// enforced twice: the JSON Schema catches non-integer / out-of-range values in
// the pipeline, and resolveRunOptions() re-checks pre-execution at the tool
// boundary (refusals are model-fixable errors). Values above the host
// ceilings are clamped down, never honored; absent options take the defaults
// from options.ts.
//
// Result assembly: the host-recorded sections (header, block boundaries,
// digest, elision marker) are minted here and ONLY here -- a script printing
// its own fake digest is just bytes inside a `text N/M` block, unable to join
// the `Tool calls (host-recorded):` section below them.

import { parseToolInput, ToolResult } from "@core/extensions/tool-utils.ts";
import type { Tool, ToolDef, ToolMetadata } from "@core/extensions/tool-registry.ts";
import type { ToolContext } from "@core/extensions/tool-context.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import {
  callableInfos,
  CodemodeBridge,
  renderReturnValue,
  type CallableToolInfo,
  type CodemodeRunOutcome,
} from "./bridge.ts";
import { buildDomainIndex, policyFilteredNames } from "./catalog.ts";
import {
  DIGEST_ARGS_MAX_CHARS,
  DIGEST_ARGS_TOTAL_MAX_CHARS,
  DIGEST_ERROR_MAX_CHARS,
  DIGEST_MAX_ROWS,
  OUTPUT_KEEP_CHARS,
  WALL_CEILING_MS,
  WALL_DEFAULT_MS,
} from "./options.ts";

export const CODEMODE_TOOL_NAME = "codemode";

const PARAM_KEYS = ["code", "timeout_ms", "max_output_chars"] as const;

export interface ResolvedRunOptions {
  code: string;
  /** Wall deadline already clamped to WALL_CEILING_MS. */
  timeoutMs: number;
  /** Output characters kept (head + tail); clamped to OUTPUT_KEEP_CHARS. */
  maxOutputChars: number;
  /** Human-readable clamp notes for the resolved envelope, e.g.
   *  "timeout_ms=300000 (clamped down from 999999)". */
  envelopeNotes: string[];
}

export type RunOptionsResolution =
  | { ok: true; opts: ResolvedRunOptions }
  | { ok: false; error: string };

function positiveInteger(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Validate + resolve the call envelope BEFORE anything runs: non-integer
 * / zero / negative options and unknown properties are refused with a
 * model-fixable schema error; over-ceiling values clamp down; absent options
 * take the defaults.
 */
export function resolveRunOptions(
  input: string | Record<string, unknown> | null,
): RunOptionsResolution {
  const parsed = parseToolInput(input);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return {
      ok: false,
      error:
        "codemode expects an object with a `code` string " +
        '(e.g. {"code":"return await tools.read({path:\'README.md\'})"}).',
    };
  }

  const unknown = Object.keys(parsed).filter(
    (k) => !(PARAM_KEYS as readonly string[]).includes(k),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `codemode: unknown parameter(s) ${unknown.map((k) => `\`${k}\``).join(", ")}; ` +
        `allowed: ${PARAM_KEYS.join(", ")}.`,
    };
  }

  const code = parsed.code;
  if (typeof code !== "string" || code.trim().length === 0) {
    return {
      ok: false,
      error: "codemode: `code` is required -- the JavaScript program to run, as a string.",
    };
  }

  const envelopeNotes: string[] = [];

  let timeoutMs = WALL_DEFAULT_MS;
  const rawTimeout = parsed.timeout_ms;
  if (rawTimeout !== undefined) {
    if (!positiveInteger(rawTimeout)) {
      return {
        ok: false,
        error:
          `codemode: \`timeout_ms\` must be a positive integer of milliseconds ` +
          `(got ${JSON.stringify(rawTimeout)}).`,
      };
    }
    timeoutMs = rawTimeout as number;
    if (timeoutMs > WALL_CEILING_MS) {
      envelopeNotes.push(`timeout_ms=${WALL_CEILING_MS} (clamped down from ${rawTimeout})`);
      timeoutMs = WALL_CEILING_MS;
    } else {
      envelopeNotes.push(`timeout_ms=${timeoutMs}`);
    }
  } else {
    envelopeNotes.push(`timeout_ms=${WALL_DEFAULT_MS} (default)`);
  }

  let maxOutputChars = OUTPUT_KEEP_CHARS;
  const rawOutput = parsed.max_output_chars;
  if (rawOutput !== undefined) {
    if (!positiveInteger(rawOutput)) {
      return {
        ok: false,
        error:
          `codemode: \`max_output_chars\` must be a positive integer of characters ` +
          `(got ${JSON.stringify(rawOutput)}).`,
      };
    }
    maxOutputChars = rawOutput as number;
    if (maxOutputChars > OUTPUT_KEEP_CHARS) {
      envelopeNotes.push(
        `max_output_chars=${OUTPUT_KEEP_CHARS} (clamped down from ${rawOutput})`,
      );
      maxOutputChars = OUTPUT_KEEP_CHARS;
    } else {
      envelopeNotes.push(`max_output_chars=${maxOutputChars}`);
    }
  } else {
    envelopeNotes.push(`max_output_chars=${OUTPUT_KEEP_CHARS} (default)`);
  }

  return { ok: true, opts: { code, timeoutMs, maxOutputChars, envelopeNotes } };
}

/**
 * Intro + async-body line + globals one-liners + options line; the
 * constant-size domain index is appended per build. The description is paid
 * on every request, so detail stays OUT -- discovery answers it
 * (`describeTool`). The body holds a fixed shape: intro, run model, one line
 * per global, options discipline, index. Size is pinned by test (chars,
 * est-tok = chars/4) and constant in fleet size.
 */
function buildDescription(domainIndex: string): string {
  return (
    "Run a JavaScript program that calls tools; one call replaces a sequence of " +
    "model<->tool round trips. The code runs as the body of an async function: " +
    "top-level `await` and `return` work. Globals: `await tools.<name>({...})` " +
    "(resolves to a string; rejects on failure), `searchTools(query)` and " +
    "`describeTool(name)` for detail on demand, `text(v)`, `console.log(...)`, " +
    "`exit()`, `store(key, value)` / `load(key)` (JSON values; writes commit " +
    "only on script success). Inner calls apply as dispatched: a mid-script " +
    "failure does not roll back the calls that already ran. Options " +
    "`timeout_ms` and `max_output_chars` tighten the host defaults; values " +
    "above the host ceilings are clamped down, never loosened. " + domainIndex
  );
}

// ── result assembly ──────────────────────────────────────────────────────────

/**
 * Head+tail keep over the script's output blocks within `budget` chars.
 * Region model: keep chars [0, floor(budget/2)) and the matching tail, so
 * exactly one dropped region exists and gets exactly one elision marker
 * naming the run journal that holds the full bytes. Block boundaries are
 * re-emitted by the host around kept slices -- a cut never opens a block the
 * script owns.
 */
export function elideBlocks(
  blocks: readonly string[],
  budget: number,
  journalPath: string,
): { lines: string[]; elided: number } {
  const total = blocks.reduce((n, b) => n + b.length, 0);
  if (total <= budget) {
    return {
      lines: blocks.flatMap((b, i) => [`==> text ${i + 1}/${blocks.length} <==`, b]),
      elided: 0,
    };
  }
  const half = Math.floor(budget / 2);
  const gapStart = half;
  const gapEnd = total - half; // dropped region [gapStart, gapEnd), >= 1 char
  const elided = gapEnd - gapStart;
  const marker = `--- [output truncated, ${elided} chars elided; full bytes: ${journalPath}] ---`;
  const lines: string[] = [];
  let markerDone = false;
  const emitMarker = (): void => {
    if (!markerDone) {
      lines.push(marker);
      markerDone = true;
    }
  };
  let pos = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i]!;
    const s = pos;
    const e = s + b.length;
    pos = e;
    const open = `==> text ${i + 1}/${blocks.length} <==`;
    if (e <= gapStart) {
      lines.push(open, b); // fully before the gap
    } else if (s >= gapEnd) {
      emitMarker();
      lines.push(open, b); // fully after the gap
    } else if (s >= gapStart && e > gapEnd) {
      // Straddles the gap's right edge: tail slice.
      emitMarker();
      lines.push(open, b.slice(gapEnd - s));
    } else if (s >= gapStart) {
      // Fully inside the gap: dropped.
    } else if (e <= gapEnd) {
      // Straddles the gap's left edge: head slice, gap keeps running.
      if (s !== e) lines.push(open, b.slice(0, gapStart - s));
      emitMarker();
    } else {
      // One block spans the whole gap: head slice, marker, tail slice.
      lines.push(open, b.slice(0, gapStart - s));
      emitMarker();
      lines.push(b.slice(gapEnd - s));
    }
  }
  emitMarker(); // trailing dropped content: the marker closes the section
  return { lines, elided };
}

/**
 * Marker hygiene: the host mints `Tool calls (host-recorded):`,
 * `==> text N/M <==` and `--- [output truncated...` -- so anywhere the host
 * re-emits CALLER-INFLUENCED text inside its own framing (digest rows, the
 * failure error line, the not-undone tail), those exact tokens are broken.
 * Idempotent: the broken forms contain none of the originals. Script text
 * inside labeled `text N/M` blocks stays raw bytes -- quarantine there is
 * structural (the block boundaries are host-minted, the forgery is data).
 */
function defangMarkers(text: string): string {
  return text
    .split("==>")
    .join("=->")
    .split("--- [")
    .join("-- -- [")
    .split("Tool calls (host-recorded):")
    .join("Tool calls (host-recorded) :");
}

/**
 * Line discipline for the host-recorded section: one physical line per row.
 * Tool errors re-echo caller-influenced content (failing output, stacks, gate
 * reasons), so CR/LF collapses to a space -- line forgery dies at the section
 * boundary -- before the marker defang and the 500-char cut.
 */
function digestSafe(err: string): string {
  // Fold FIRST: "Tool calls\n(host-recorded):" must not reassemble into the
  // exact header mid-collapse -- defang runs on the folded text.
  const s = defangMarkers(
    err.replace(/[\r\n]+/g, " ").replace(/[ \t]{2,}/g, " ").trim(),
  );
  return s.length > DIGEST_ERROR_MAX_CHARS ? `${s.slice(0, DIGEST_ERROR_MAX_CHARS)}...` : s;
}

function statusOf(e: { status: string; ms: number; error: string | null }): string {
  switch (e.status) {
    case "ok":
      return `ok ${e.ms}ms`;
    case "cancelled":
      return "cancelled";
    case "denied":
      return `denied: ${digestSafe(e.error ?? "")}`;
    default:
      // "error", and a defensive home for anything unexpected.
      return `error: ${digestSafe(e.error ?? "")}`;
  }
}

/** The digest budgets: <=DIGEST_MAX_ROWS rows with an "and N more" tail,
 *  args capped per call and in total, errors at 500 chars. Meta rows carry a
 *  host-authored `note` trailer rendered through the same sanitizer:
 *  `searchTools({"query":"files"})(ok 0ms -> 3)`. `dropped` counts rows the
 *  host refused to RETAIN (meta flood); they still ride the "and N more"
 *  tail. */
export function renderDigestRows(
  digest: readonly {
    name: string;
    args: unknown;
    status: string;
    ms: number;
    error: string | null;
    note?: string | null;
  }[],
  dropped = 0,
): string[] {
  const rows: string[] = [];
  let argsBudget = DIGEST_ARGS_TOTAL_MAX_CHARS;
  let tailDone = false;
  for (let i = 0; i < digest.length; i += 1) {
    if (rows.length >= DIGEST_MAX_ROWS) {
      const more = digest.length - DIGEST_MAX_ROWS + dropped;
      if (more > 0) rows.push(`(...and ${more} more)`);
      tailDone = true;
      break;
    }
    const e = digest[i]!;
    let args = e.args === undefined ? "" : (JSON.stringify(e.args) ?? "");
    // Host-marker tokens arriving through ARGS are defanged too (journal
    // keeps the exact args): a row's args are data, never digest structure.
    args = defangMarkers(args);
    if (args.length > DIGEST_ARGS_MAX_CHARS) {
      args = `${args.slice(0, DIGEST_ARGS_MAX_CHARS)}...[+${args.length - DIGEST_ARGS_MAX_CHARS} chars]`;
    }
    if (args.length > argsBudget) {
      args = "<args elided>";
    } else {
      argsBudget -= args.length; // the pool counts ARGS bytes, not the marker
    }
    const note = e.note ? ` ${digestSafe(e.note)}` : "";
    rows.push(`${e.name}(${args})(${statusOf(e)}${note})`);
  }
  // The retention cap can make the digest EXACTLY DIGEST_MAX_ROWS long with
  // ops still dropped: the in-loop tail never fires then, so print it here.
  if (dropped > 0 && !tailDone) {
    rows.push(`(...and ${dropped} more)`);
  }
  return rows;
}

export interface AssembledRun {
  output: string;
  error: string | null;
  hint: string | null;
}

/**
 * The one tool result. Success: header, output blocks, then the
 * host-recorded digest. Failure: partial output, `Script error: <message>`,
 * and the tail -- "Tool calls made before the failure (they are not undone):
 * read(ok) bash(error: exit 1)". The failure tail carries no args or times:
 * the fact of what ran is what the model needs next.
 */
export function assembleRunResult(o: CodemodeRunOutcome, maxOutputChars: number): AssembledRun {
  const secs = (o.elapsedMs / 1000).toFixed(1);
  const blocks = [...o.items];
  if (o.value !== null && o.value !== undefined) {
    blocks.push(renderReturnValue(o.value)); // the exact bytes the journal holds
  }
  const { lines } = elideBlocks(blocks, maxOutputChars, o.journalPath);
  const outSection = lines.join("\n");

  if (!o.ok) {
    const parts: string[] = [`Script failed -- wall ${secs}s -- fence: ${o.fence ?? "absent"}`];
    if (outSection) parts.push(outSection);
    // Stays multi-line (a stack is useful), but the host marker tokens are
    // broken: an error quoting them cannot pose as digest structure.
    parts.push(defangMarkers(o.error ?? "Script error: unknown failure"));
    // The tail lists EFFECTS: meta ops are read-only host-memory traversals,
    // so there is nothing for them to leave un-undone.
    const effectRows = o.digest.filter((e) => e.kind !== "meta");
    if (effectRows.length > 0) {
      const tails = effectRows.slice(0, DIGEST_MAX_ROWS).map(
        (e) => `${e.name}(${statusOf(e).startsWith("ok") ? "ok" : statusOf(e)})`,
      );
      if (effectRows.length > DIGEST_MAX_ROWS) tails.push(`...and ${effectRows.length - DIGEST_MAX_ROWS} more`);
      parts.push(`Tool calls made before the failure (they are not undone): ${tails.join(" ")}`);
    }
    // The error ELEMENT rides to the model too with the same defang as the
    // embedded line, so the two fields cannot disagree about what is
    // structure. The journal keeps o.error raw and verbatim.
    return {
      output: parts.join("\n"),
      error: o.error ? defangMarkers(o.error) : null,
      hint: null,
    };
  }

  const parts: string[] = [`Script completed -- wall ${secs}s -- fence: ${o.fence ?? "absent"}`];
  if (outSection) parts.push(outSection);
  parts.push("Tool calls (host-recorded):");
  const rows = renderDigestRows(o.digest, o.digestDropped);
  parts.push(rows.length > 0 ? rows.join("\n") : "none");
  return {
    output: parts.join("\n"),
    error: null,
    hint: o.storeError ? `store commit failed: ${o.storeError}` : null,
  };
}

export class CodeModeTool implements Tool {
  #core: CoreContext;
  #bridge: CodemodeBridge;

  constructor(core: CoreContext, bridge?: CodemodeBridge) {
    this.#core = core;
    // One bridge per tool instance == one per loaded extension == one per
    // host process, which is what the live-children cap assumes.
    this.#bridge = bridge ?? new CodemodeBridge();
  }

  metadata: ToolMetadata = {
    sideEffects: true,
    difficulty: 4,
    tags: ["system"],
    display: [{ kind: "code", lang: "javascript", source: "args", arg: "code" }],
  };

  toToolDef(): ToolDef {
    // Domain index over the policy-filtered name set, metadata read per name
    // via getMetadata: NEVER getToolDefs()/getToolDef() here -- that would
    // re-enter the all-defs cache this very def is populating.
    const names = policyFilteredNames(
      this.#core.toolRegistry,
      this.#core.config as Parameters<typeof policyFilteredNames>[1],
    );
    const index = buildDomainIndex(
      names,
      (name) => this.#core.toolRegistry.getMetadata(name),
      CODEMODE_TOOL_NAME,
    );
    return {
      type: "function",
      function: {
        name: CODEMODE_TOOL_NAME,
        description: buildDescription(index),
        parameters: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description:
                "JavaScript program, run as the body of an async function (top-level await and return work).",
            },
            timeout_ms: {
              type: "integer",
              minimum: 1,
              description:
                `Wall-clock deadline in milliseconds. Default ${WALL_DEFAULT_MS}; ` +
                `host ceiling ${WALL_CEILING_MS} -- larger values are clamped down, never honored.`,
            },
            max_output_chars: {
              type: "integer",
              minimum: 1,
              description:
                `Output characters kept (head + tail). Default ${OUTPUT_KEEP_CHARS}; ` +
                "it can only be lowered, never raised.",
            },
          },
          required: ["code"],
          additionalProperties: false,
        },
      },
    };
  }

  async execute(
    input: string | Record<string, unknown> | null,
    ctx?: ToolContext,
  ): Promise<ToolResult> {
    const resolved = resolveRunOptions(input);
    if (!resolved.ok) {
      return new ToolResult({
        error: resolved.error,
        hint:
          "Retry with a valid envelope: `code` (string) required; " +
          "`timeout_ms` / `max_output_chars` optional positive integers.",
      });
    }

    // The nested-call entry: mounted by the executor on every real call
    // context. A hand-built context without it (test doubles) gets a refusal
    // rather than a script that can never reach a tool. The envelope echo
    // keeps the resolution inspectable.
    const dispatch = ctx?.get("executeToolCall");
    if (!ctx || !dispatch) {
      return new ToolResult({
        error:
          "codemode: no nested-call dispatcher on this tool context " +
          "(executeToolCall unmounted) -- the script was NOT executed. " +
          `Resolved envelope: code=${resolved.opts.code.length} chars, ` +
          `${resolved.opts.envelopeNotes.join(", ")}.`,
      });
    }

    // Callable table + meta-op view: the agent's POLICY-FILTERED defs --
    // agent.getToolDefs(), the same set the model sees before any shadowing,
    // minus codemode itself. Def description/parameters ride to the bridge so
    // searchTools/describeTool answer from policy facts, never a raw
    // traversal. The registry filter chain is the fallback when no agent
    // handle is mounted.
    const agent = ctx.get("agent") as { getToolDefs?: () => Promise<ToolDef[]> } | undefined;
    const readMetadata = (name: string) => this.#core.toolRegistry.getMetadata(name);
    let callableDefs: CallableToolInfo[];
    if (typeof agent?.getToolDefs === "function") {
      callableDefs = callableInfos(await agent.getToolDefs(), readMetadata);
    } else {
      const names = policyFilteredNames(
        this.#core.toolRegistry,
        this.#core.config as Parameters<typeof policyFilteredNames>[1],
      );
      const defs = await Promise.all(names.map((n) => this.#core.toolRegistry.getToolDef(n)));
      callableDefs = callableInfos(defs.filter((d): d is ToolDef => d !== null), readMetadata);
    }

    const workspace = ctx.get("workspace");
    const outcome = await this.#bridge.run({
      code: resolved.opts.code,
      toolNames: callableDefs.map((d) => d.name),
      toolDefs: callableDefs,
      timeoutMs: resolved.opts.timeoutMs,
      maxOutputChars: resolved.opts.maxOutputChars,
      roots: workspace?.roots ?? [],
      abortSignal: ctx.get("abortSignal"),
      dispatch,
      callId: (ctx.get("toolCallId") as string | undefined) ?? undefined,
    });

    const assembled = assembleRunResult(outcome, resolved.opts.maxOutputChars);
    return new ToolResult({
      output: assembled.output,
      error: assembled.error,
      hint: assembled.hint ?? undefined,
    });
  }
}
