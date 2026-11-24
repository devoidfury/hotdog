// The codemode host bridge. One entry per script run: fence plan (planFor,
// probe-and-degrade -- no backend means a plain spawn with copyScrubbedEnv
// and the result says `fence: absent`, never silently), the per-run
// scratch/journal dir under joinDataDir("codemode")/<runId> (created
// HOST-side; bwrap bind sources must exist), the NDJSON frame loop with the
// 1 MiB cap both directions, timeout/cancel kills via the process group, and
// the admission semaphore (2 live children, FIFO wait, "all runners busy").
//
// `call` frames dispatch through the nested-call entry (the
// toolCtx.get("executeToolCall") seam, handed in on the run request) with the
// run's cancellation, under the per-run caps: MAX_INNER_CALLS counted per
// dispatched PIPELINE call (meta/store/load frames never count),
// INNER_CALL_CONCURRENCY in flight, calls still running when the script ends
// cancelled and recorded so in the digest. Every dispatch leaves an
// fsync-before-dispatch journal line (call_started) answered with name +
// payload refs (call_answered). `store`/`load` frames round-trip through the
// StoreSession (quotas host-side, writes commit on script success only). The
// `meta` frames are the discovery ops: searchTools/describeTool run host-side
// over the run's policy-filtered set (request.toolDefs -- the
// agent.getToolDefs() derivation, never a raw registry traversal), round-trip
// like tool calls, are host-recorded in the digest as meta lines, and are NOT
// pipeline calls: MAX_INNER_CALLS never counts them.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatError } from "@core/error.ts";
import { PROJECT_ROOT } from "@core/tool-exec-layout.ts";
import type {
  ExecuteToolCall,
  NestedCallInput,
  NestedCallResult,
} from "@core/extensions/tool-context.ts";
import type { ToolDef, ToolMetadata } from "@core/extensions/tool-registry.ts";
import { copyScrubbedEnv } from "@utils/env.ts";
import { planFor } from "@utils/exec-plan.ts";
import { logger } from "@utils/logger.ts";
import { killProcessGroup, OWN_PROCESS_GROUP } from "@utils/process-group.ts";
import { normalizeMetadataTags } from "./catalog.ts";
import {
  ADMISSION_WAIT_MS,
  DIGEST_MAX_ROWS,
  FRAME_MAX_BYTES,
  INNER_CALL_CONCURRENCY,
  MAX_INNER_CALLS,
  MAX_LIVE_CHILDREN,
  OUTPUT_KEEP_CHARS,
  OUTPUT_STREAM_CAP_BYTES,
  OUTPUT_STREAM_MAX_ITEMS,
  SEARCH_TOOLS_DEFAULT_LIMIT,
  WALL_DEFAULT_MS,
} from "./options.ts";
import {
  newRunId,
  RUN_JOURNAL_FILE,
  type JournalLine,
  RunJournal,
  runDirFor,
  scratchDirFor,
  StoreSession,
} from "./journal.ts";
import {
  createFrameDecoder,
  encodeFrame,
  encodeLine,
  NON_CALLABLE,
  parseChildFrame,
  RUNNER_CAP_EXIT,
  type CallFrame,
  type DoneFrame,
  type LoadFrame,
  type MetaFrame,
  type ResFrame,
  type ResPayload,
  type RunFrame,
  type StoreFrame,
} from "./host/protocol.ts";

const RUNNER_ENTRY = fileURLToPath(new URL("./host/runner.ts", import.meta.url));

/** A done'd child that lingers on its own handles gets this much grace. */
const DONE_GRACE_MS = 1000;

/** Stderr kept from the child (diagnostics for unexpected death only). */
const STDERR_TAIL_LIMIT = 8192;

/** The bridge is text-only: an image-bearing inner result resolves its text
 *  with this note where the images were. The nested-call result shape carries
 *  no image bytes, so nothing binary crosses a frame; this covers results
 *  that surface images at the seam. */
const IMAGE_OMITTED_NOTE = "[image from read omitted: not supported inside codemode]";

/** Gate-block vocabulary: the pipeline's block answers (user-gate's
 *  `Tool call blocked: <reasons>`) are failures like any other; the digest
 *  records them as denied with the reason. */
const BLOCKED_RE = /^tool call blocked\b/i;

/**
 * SOFT COUPLING TO CORE TEXT. The executor wraps every registry validation
 * failure as `Parameter validation error:\n<details>`
 * (src/core/tool-executor.ts, the validateToolArgs branch) -- this constant
 * is the recognition shape for the parameter-signature decoration below.
 * Recognition mismatch means a plain error, never a wrong decoration: if
 * core ever rewords it the hint detaches quietly, and the drift pin in
 * tests/core/nested-tool-call.test.ts (the constant appears in a REAL
 * bad-args nested rejection) fails loudly. Runtime failures never match on
 * purpose -- gate denials, tool errors, timeouts, unavailable: there the
 * parameter list is noise and the gate's own text is authoritative.
 */
export const VALIDATION_REJECTION_PREFIX = "Parameter validation error:";

export type FenceLabel = "bwrap" | "seatbelt" | "absent";

type KillReason = "timeout" | "cancelled" | "output-cap" | "protocol" | "done-grace";

/** One host-recorded inner-call row: host-generated, the script's own text
 *  can never join this list. "running" never survives the outcome -- the
 *  terminal pass marks outstanding calls cancelled. kind "meta" rows record
 *  discovery ops: host-memory traversals, never dispatches, so they carry a
 *  `note` trailer instead of pipeline status detail and count against
 *  nothing. */
export type CodemodeCallStatus = "running" | "ok" | "error" | "denied" | "cancelled";

export interface CodemodeCallDigest {
  kind: "call" | "meta";
  name: string;
  args: unknown;
  status: CodemodeCallStatus;
  ms: number;
  error: string | null;
  note: string | null;
}

// ── discovery meta ops ───────────────────────────────────────────────────────
// The two host-side globals' answers, computed over the run's POLICY-FILTERED
// set -- the agent.getToolDefs() derivation the tool boundary supplies as
// request.toolDefs (never a raw registry traversal, or tools policy removed
// would surface here and bounce on call). Pure host memory: no pipeline, no
// gate, no MAX_INNER_CALLS (that budget counts call cost).

/** One callable's facts as the meta ops see them: the def's wire identity
 *  plus tags (read via ToolRegistry.getMetadata at request build time --
 *  defs carry no tags themselves). */
export interface CallableToolInfo {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  tags?: readonly string[];
}

/** Map policy-filtered defs to meta-op info; `readMetadata` supplies tags per
 *  name and must touch no def cache, so this cannot re-enter catalog.ts.
 *  `codemode` is stripped here too: the ban covers discovery, not just
 *  dispatch. */
export function callableInfos(
  defs: readonly ToolDef[],
  readMetadata: (name: string) => ToolMetadata | undefined,
): CallableToolInfo[] {
  const out: CallableToolInfo[] = [];
  for (const def of defs) {
    const name = def?.function?.name;
    if (!name || name === NON_CALLABLE) continue;
    out.push({
      name,
      description: typeof def.function.description === "string" ? def.function.description : "",
      parameters: def.function.parameters,
      tags: readMetadata(name)?.tags,
    });
  }
  return out;
}

/** searchTools limits: absent/non-finite/below-1 fall back to the default. */
export function normalizeSearchLimit(raw: number | undefined): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : SEARCH_TOOLS_DEFAULT_LIMIT;
}

/** Retention bound for script-authored meta inputs: a query/name is the
 *  script's own string (up to a full frame each) and the meta leg is NOT
 *  MAX_INNER_CALLS-bound, so a raw-frame flood is unbounded in count. The
 *  digest keeps a preview slice, never the verbatim input; the dropped tail
 *  marker says how much was elided. */
const META_ARG_PREVIEW_CHARS = 256;

/** A retained string must not alias its source: JSC slices, `trim` and
 *  `split` results share the parent's buffer, so a 256-char preview of a
 *  900 KiB frame keeps all 900 KiB reachable (measured: 230 MiB pinned by
 *  256 previews alone). The copy runs char-by-char -- the only construction
 *  guaranteed not to share -- and its cost is bounded by the preview length. */
function detach(value: string): string {
  const out = new Array<string>(value.length);
  for (let i = 0; i < value.length; i += 1) out[i] = value[i]!;
  return out.join("");
}

export function metaPreview(value: string): string {
  return value.length <= META_ARG_PREVIEW_CHARS
    ? detach(value)
    : `${detach(value.slice(0, META_ARG_PREVIEW_CHARS))}...[+${value.length - META_ARG_PREVIEW_CHARS} chars]`;
}

function firstLine(description: string): string {
  const nl = description.indexOf("\n");
  return nl === -1 ? description : description.slice(0, nl);
}

/** Exact normalized-domain match first (getTags semantics: trim+lowercase,
 *  the same normalizer catalog.ts uses), else case-insensitive substring over
 *  name + description + tags -- MCP tools usually carry no tags, so that half
 *  is what makes them findable. Descriptions are first-line only: this feeds
 *  scripts. */
export function searchCallableInfos(
  infos: readonly CallableToolInfo[],
  query: string,
  limit: number = SEARCH_TOOLS_DEFAULT_LIMIT,
): { name: string; description: string }[] {
  const norm = query.trim().toLowerCase();
  let pool = infos.filter((i) => normalizeMetadataTags(i.tags).includes(norm));
  if (pool.length === 0) {
    pool = infos.filter(
      (i) =>
        i.name.toLowerCase().includes(norm) ||
        i.description.toLowerCase().includes(norm) ||
        normalizeMetadataTags(i.tags).some((t) => t.includes(norm)),
    );
  }
  const out: { name: string; description: string }[] = [];
  for (const i of pool) {
    if (out.length >= limit) break;
    out.push({ name: i.name, description: firstLine(i.description) });
  }
  return out;
}

export interface CallableSample {
  name: string;
  description: string;
  parameters: { name: string; type: unknown; required: boolean; description?: string }[];
}

/** The declaration sample: def description + each parameter's type,
 *  description, requiredness. Null for a name outside the run's set; the
 *  caller then adds the searchTools pointer note. */
export function describeCallableInfo(
  infos: readonly CallableToolInfo[],
  name: string,
): CallableSample | null {
  const hit = infos.find((i) => i.name === name);
  if (!hit) return null;
  const schema: Record<string, unknown> | undefined =
    hit.parameters && typeof hit.parameters === "object" && !Array.isArray(hit.parameters)
      ? hit.parameters
      : undefined;
  const props =
    schema && typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : undefined;
  const required = Array.isArray(schema?.required)
    ? (schema.required as unknown[]).filter((r): r is string => typeof r === "string")
    : [];
  const parameters: CallableSample["parameters"] = [];
  if (props && typeof props === "object" && !Array.isArray(props)) {
    for (const [pname, raw] of Object.entries(props as Record<string, unknown>)) {
      const p =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const entry: CallableSample["parameters"][number] = {
        name: pname,
        type: p.type ?? "unknown",
        required: required.includes(pname),
      };
      if (typeof p.description === "string" && p.description !== "") {
        entry.description = p.description;
      }
      parameters.push(entry);
    }
  }
  return { name: hit.name, description: hit.description, parameters };
}

/** The pointer for a describeTool miss: names are searched by domain/fragment,
 *  so an MCP-shaped server__tool request points at the server half. */
export function searchToolsPointer(name: string): string {
  const trimmed = name.trim();
  const head = trimmed.split("__")[0]?.trim();
  // detach: trim/split/slice results alias the (potentially huge) source.
  return detach((head || trimmed || "domain").slice(0, 48));
}

/** Budget for the appended parameter-signature line: 512 chars (~128
 *  est-tok at chars/4, same order as DIGEST_ERROR_MAX_CHARS). Parameter
 *  lists can be wide, so the LIST truncates (ellipsis + the describeTool
 *  pointer always survives); see parameterSignatureLine. */
export const PARAM_SIGNATURE_MAX_CHARS = 512;

/**
 * The compact signature line for a validation rejection, built from the
 * run's OWN toolDefs -- the same policy-filtered CallableToolInfo set
 * describeTool answers from (never a raw registry). null when the run's set
 * has no def for the name (nothing to surface) or the def declares no
 * parameters (a validation failure there has no parameter answer).
 * Truncation drops trailing parameters, never the pointer; a tool name so
 * long that the empty-list line still busts the budget keeps the full
 * pointer anyway -- cutting or misstating it is worse than an overflow.
 */
export function parameterSignatureLine(
  infos: readonly CallableToolInfo[],
  name: string,
): string | null {
  const sample = describeCallableInfo(infos, name);
  if (!sample || sample.parameters.length === 0) return null;
  const items = sample.parameters.map((p) => {
    const type = typeof p.type === "string" ? p.type : (JSON.stringify(p.type) ?? "unknown");
    const pname = p.name.replace(/\s+/g, " "); // one physical line, always
    return `${pname}: ${type}${p.required ? " (required)" : ""}`;
  });
  const head = `Parameters for ${name}: `;
  const tail = ` -- full schema: describeTool("${name}")`;
  const full = `${head}${items.join(", ")}${tail}`;
  if (full.length <= PARAM_SIGNATURE_MAX_CHARS) return full;
  const kept: string[] = [];
  for (const item of items) {
    const next = kept.length ? `${[...kept, item].join(", ")}...` : `${item}...`;
    if (`${head}${next}${tail}`.length > PARAM_SIGNATURE_MAX_CHARS) break;
    kept.push(item);
  }
  return `${head}${kept.length ? `${kept.join(", ")}...` : "..."}${tail}`;
}

/**
 * Host-side decoration of a PARAMETER-VALIDATION rejection (the shadowing
 * problem: the direct tool schema is not in the model's context, so the
 * rejection alone says "path: missing required field" with nowhere to
 * look). Appends the run's signature line; the executor's own detail
 * survives verbatim -- decoration never replaces. Any other failure
 * (denial, tool error, timeout, unknown name without a def) returns r
 * untouched.
 */
function decorateValidationRejection(
  r: NestedCallResult,
  name: string,
  infos: readonly CallableToolInfo[],
): NestedCallResult {
  const text = r.error ?? r.output;
  if (typeof text !== "string" || !text.startsWith(VALIDATION_REJECTION_PREFIX)) return r;
  const line = parameterSignatureLine(infos, name);
  if (line === null) return r;
  const decorated = `${text}\n${line}`;
  return r.error !== undefined ? { ...r, error: decorated } : { ...r, output: decorated };
}

export interface CodemodeRunRequest {
  /** The script body; clamped/validated upstream (tool.ts envelope). */
  code: string;
  /** Policy-filtered callable names (pre-shadow getToolDefs set).
   *  `codemode` is filtered out of this list, not denied at call time. */
  toolNames: string[];
  /** Wall deadline; caller resolves + clamps (tool.ts). */
  timeoutMs?: number;
  /** Host-side keep budget carried in the run frame. */
  maxOutputChars?: number;
  /** rw roots for the jail (session workspace roots); default none. */
  roots?: string[];
  abortSignal?: AbortSignal;
  /**
   * The nested-call dispatcher (toolCtx.get("executeToolCall")): every
   * `call` frame runs through the real pipeline (gate, durability, caps).
   * Absent only on hand-built contexts (test doubles without the seam): the
   * run answers inner calls with an error instead of dispatching.
   */
  dispatch?: ExecuteToolCall;
  /** The codemode tool's own call id, for attribution: the dispatcher mints
   *  inner ids as "<parentCallId>/<n>" under it (the bridge never
   *  pre-suffixes). */
  callId?: string;
  /** The meta-op source: the SAME policy-filtered run set as toolNames,
   *  enriched with def description/parameters and tags. Absent on hand-built
   *  runs: search falls back to the name list (names only), describe answers
   *  null-with-pointer. `codemode` is stripped like the callable table. */
  toolDefs?: CallableToolInfo[];
}

export interface CodemodeRunOutcome {
  ok: boolean;
  runId: string;
  runDir: string;
  journalPath: string;
  /** null = the spawn decision was never reached (pre-spawn refusal). */
  fence: FenceLabel | null;
  /** done-frame value (script return); null when absent/unsuccessful. */
  value: unknown;
  /** Streamed text items joined with newlines, as the host recorded them. */
  output: string;
  /** The streamed out-items, in order (result assembly blocks). */
  items: string[];
  /** Host-recorded inner-call rows, in arrival order. Meta rows are retained
   *  up to DIGEST_MAX_ROWS with preview-bounded args; everything recorded
   *  beyond that is counted in `digestDropped` and rendered into the
   *  "(...and N more)" tail, never retained verbatim. */
  digest: CodemodeCallDigest[];
  digestDropped: number;
  /** "Script error: ..." / "Protocol violation: ..." on failure, else null. */
  error: string | null;
  /** Set when the script succeeded but its store() writes failed to commit. */
  storeError: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when the host killed the child (deadline/cancel/cap/violation). */
  killed: boolean;
  pid: number | null;
  elapsedMs: number;
  outBytes: number;
  outItems: number;
}

export interface CodemodeBridgeOptions {
  /** Test seams, never config keys: production numbers live in options.ts. */
  maxLiveChildren?: number;
  admissionWaitMs?: number;
  /** Tests-only, forwarded to planFor.binary: null forces the plain-spawn
   *  degrade path; a string forces a bwrap-shape plan. Production probes. */
  fenceBinary?: string | null;
}

interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Host->child res fitting: `maxToolResultChars` is a CHAR cap (default
 *  1e6), so a legal pipeline result can still encode past the 1 MiB frame in
 *  multi-byte text. Never send an illegal frame -- the child's decoder must
 *  not be the one to notice; shrink the payload to fit with a visible marker.
 *  Both legs: an over-cap ERROR string shrinks the same way, so the script
 *  catches a truncated error instead of the run dying as a host->child frame
 *  overflow with the real cause buried. */
const FRAME_FIT_MARKER = `\n[truncated to fit the ${FRAME_MAX_BYTES}-byte bridge frame]`;

function fitResFrame(frame: ResFrame): ResFrame {
  if (Buffer.byteLength(encodeFrame(frame)) <= FRAME_MAX_BYTES) return frame;
  const shrink = (text: string, wrap: (fitted: string) => ResFrame): ResFrame => {
    let keep = text.length;
    for (;;) {
      const fitted = wrap(text.slice(0, keep) + FRAME_FIT_MARKER);
      const bytes = Buffer.byteLength(encodeFrame(fitted));
      if (bytes <= FRAME_MAX_BYTES || keep === 0) return fitted;
      // Geometric shrink toward the cap (monotone; multibyte-safe without
      // guessing a bytes-per-char ratio).
      keep = Math.max(0, Math.floor((keep * (FRAME_MAX_BYTES - 4096)) / bytes) - 8);
    }
  };
  return frame.ok
    ? shrink(frame.payload.output, (t) => ({ ...frame, payload: { ...frame.payload, output: t } }))
    : shrink(frame.error, (t) => ({ ...frame, error: t }));
}

function writeResFrame(child: ChildProcess, frame: ResFrame): void {
  try {
    child.stdin?.write(encodeLine(fitResFrame(frame)));
  } catch {
    // EPIPE racing a dying child: death itself arrives on exit/error.
  }
}

/**
 * How result assembly renders the done-frame value as its final output
 * block. The journal records exactly these bytes at settle so the elision
 * marker's promise ("full bytes: <journalPath>") holds for the return
 * value, not just the streamed items.
 */
export function renderReturnValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
}

/**
 * The live-children semaphore is per bridge instance; a loaded extension
 * holds exactly one instance (CodeModeTool owns it), so the cap is
 * effectively per process.
 */
export class CodemodeBridge {
  #maxLive: number;
  #waitMs: number;
  #fenceBinary?: string | null;
  #live = 0;
  #queue: Waiter[] = [];

  constructor(options: CodemodeBridgeOptions = {}) {
    this.#maxLive = options.maxLiveChildren ?? MAX_LIVE_CHILDREN;
    this.#waitMs = options.admissionWaitMs ?? ADMISSION_WAIT_MS;
    this.#fenceBinary = options.fenceBinary;
  }

  /** Children currently holding an admission slot (including hand-offs). */
  liveChildren(): number {
    return this.#live;
  }

  /** FIFO admission: first come, first served; a waiter that runs out of
   *  patience errors "all runners busy" rather than barging in. */
  #acquire(): Promise<void> {
    if (this.#live < this.#maxLive) {
      this.#live += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const i = this.#queue.indexOf(waiter);
          if (i >= 0) {
            this.#queue.splice(i, 1);
            reject(
              new Error(
                `codemode: all runners busy (${this.#maxLive} live children; ` +
                  `waited ${this.#waitMs} ms for an admission slot)`,
              ),
            );
          }
        }, this.#waitMs),
      };
      this.#queue.push(waiter);
    });
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(); // slot handed over directly: #live unchanged
      return;
    }
    this.#live -= 1;
  }

  async run(request: CodemodeRunRequest): Promise<CodemodeRunOutcome> {
    await this.#acquire();
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        this.#release();
      }
    };
    try {
      return await this.#runAdmitted(request, release);
    } finally {
      release(); // no-op when the child's exit/error path already handed it back
    }
  }

  async #runAdmitted(
    request: CodemodeRunRequest,
    release: () => void,
  ): Promise<CodemodeRunOutcome> {
    const startedAt = Date.now();
    const runId = newRunId();
    const runDir = runDirFor(runId);
    const journalPath = join(runDir, RUN_JOURNAL_FILE);
    const timeoutMs = request.timeoutMs ?? WALL_DEFAULT_MS;
    const maxOutputChars = request.maxOutputChars ?? OUTPUT_KEEP_CHARS;
    const names = [...new Set(request.toolNames.filter((n) => n !== NON_CALLABLE))];
    // Meta-op view: the caller supplies the full policy-filtered def facts;
    // hand-built runs fall back to names so the ops answer short (substring
    // search by name, null describes) instead of reaching for a raw registry.
    const metaInfos: CallableToolInfo[] = request.toolDefs
      ? request.toolDefs.filter((d) => d.name && d.name !== NON_CALLABLE)
      : names.map((name) => ({ name, description: "", tags: [] }));

    const refused = (error: string, fence: FenceLabel | null): CodemodeRunOutcome => ({
      ok: false,
      runId,
      runDir,
      journalPath,
      fence,
      value: null,
      output: "",
      items: [],
      digest: [],
      digestDropped: 0,
      error,
      storeError: null,
      exitCode: null,
      signal: null,
      killed: false,
      pid: null,
      elapsedMs: Date.now() - startedAt,
      outBytes: 0,
      outItems: 0,
    });

    if (request.abortSignal?.aborted) return refused("Script error: cancelled", null);

    const runFrame: RunFrame = {
      t: "run",
      src: request.code,
      opts: { timeout_ms: timeoutMs, max_output_chars: maxOutputChars },
      calls: MAX_INNER_CALLS,
      names,
    };
    // Measure the frame content (no newline): the peer's LineDecoder accepts
    // a line when its bytes-minus-terminator are <= cap, so the legs must
    // agree at exactly cap -- content bytes, not the encoded line.
    const programBytes = Buffer.byteLength(encodeFrame(runFrame));
    if (programBytes > FRAME_MAX_BYTES) {
      // Host->child leg of the frame cap: refuse rather than spawn a child
      // whose instruction frame we cannot legally send.
      return refused(
        `codemode: program too large for the bridge ` +
          `(${programBytes} bytes > ${FRAME_MAX_BYTES} frame cap)`,
        null,
      );
    }

    // Journal dir + jail scratch SUBDIR, HOST-side, before the plan: bwrap
    // bind sources must exist, and the journal must NOT sit in the bound dir
    // -- the script owns /tmp and could forge or truncate a journal placed
    // there. run.jsonl lives one level up, outside the jail's view.
    const journal = await RunJournal.open(runDir);
    const scratch = scratchDirFor(runDir);
    await mkdir(scratch, { recursive: true });

    const jailEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: process.env.LANG ?? "C.UTF-8",
    };
    const { prefixArgv, probe } = planFor({
      roots: request.roots ?? [],
      cls: "rw",
      scratch,
      command: process.execPath,
      args: [RUNNER_ENTRY],
      repoRoot: PROJECT_ROOT,
      binary: this.#fenceBinary,
      setEnv: jailEnv,
    });
    // Probe-and-degrade: record the backend this run actually used
    // (tool.ts prints it in the result header).
    const fence: FenceLabel = probe ?? "absent";

    await journal.append({
      ev: "run_started",
      runId,
      fence,
      timeout_ms: timeoutMs,
      max_output_chars: maxOutputChars,
      calls: MAX_INNER_CALLS,
      names,
    });

    // Jailed: bwrap/seatbelt gets ONLY PATH/LANG (bwrap passes its own env
    // through, so the spawner env is the whitelist; --setenv adds the jail's
    // HOME/TMPDIR). Degraded: the scrubbed copy -- provider keys never cross,
    // and the outcome says the fence was absent.
    const argv = prefixArgv ?? [process.execPath, RUNNER_ENTRY];
    const env = prefixArgv ? jailEnv : (copyScrubbedEnv(process.env) as Record<string, string>);
    let child: ChildProcess;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: PROJECT_ROOT,
        env,
        ...OWN_PROCESS_GROUP,
      });
    } catch (e) {
      const msg = `codemode spawn failed: ${formatError(e)}`;
      await journal
        .append({ ev: "run_finished", runId, ok: false, error: msg })
        .catch(() => {});
      throw new Error(msg);
    }

    return await new Promise<CodemodeRunOutcome>((resolve) => {
      let settled = false;
      let killReason: KillReason | null = null;
      let protocolError: string | null = null;
      let spawnError: string | null = null;
      let done: DoneFrame | null = null;
      let exitCode: number | null = null;
      let signal: NodeJS.Signals | null = null;
      let outBytes = 0;
      let outItems = 0;
      let stderrTail = "";
      let grace: ReturnType<typeof setTimeout> | null = null;
      const outTexts: string[] = [];

      // ── inner-call dispatch ───────────────────────────────────────────────
      // Digest rows record arrival order (queued AND answered calls); rows
      // are host-generated, the script's own text can never join them.
      interface LiveCall {
        entry: CodemodeCallDigest;
        answered: boolean;
        marked: boolean; // terminal pass already recorded it cancelled
        dispatchedAt: number | null;
        seq: number;
      }
      const digest: CodemodeCallDigest[] = [];
      const inFlight = new Map<number, LiveCall>();
      // Accepted PIPELINE-call rows (the MAX_INNER_CALLS budget; meta rows
      // share the digest but never this counter).
      let callRows = 0;
      // Meta-leg retention: metaTotal = ops received (reported in
      // run_finished); metaRows = rows kept (<= DIGEST_MAX_ROWS). Answers
      // keep flowing past the retention cap: the bound is on retention, not
      // on service.
      let metaTotal = 0;
      let metaRows = 0;
      // Cancellation for every dispatch: fires when the child is killed OR
      // when the script ends with calls still outstanding ("cancelled, and
      // the digest says so"). Merged with the caller's own signal.
      const runAbort = new AbortController();
      const callSignal = request.abortSignal
        ? AbortSignal.any([request.abortSignal, runAbort.signal])
        : runAbort.signal;
      // Per-script concurrency clamp: at most INNER_CALL_CONCURRENCY pipeline
      // dispatches in flight; the rest queue FIFO behind the gate.
      let dispatching = 0;
      let dispatchSeq = 0;
      const slotQueue: Array<() => void> = [];
      const slot = (): Promise<void> =>
        new Promise<void>((res) => {
          const grant = (): void => {
            dispatching += 1;
            res();
          };
          if (dispatching < INNER_CALL_CONCURRENCY) grant();
          else slotQueue.push(grant);
        });
      const releaseSlot = (): void => {
        dispatching -= 1;
        slotQueue.shift()?.();
      };
      // store()/load(): lazy-opened session, host-side quotas, commit only
      // when the script succeeded (in settle).
      let storeP: Promise<StoreSession> | null = null;
      let storeError: string | null = null;
      const storeSession = (): Promise<StoreSession> =>
        (storeP ??= StoreSession.open().catch((e) => {
          storeP = null; // a failed open must not poison later frames
          throw e;
        }));

      const cancelOutstanding = (): void => {
        runAbort.abort(); // stop the effects of in-flight dispatches
        for (const live of inFlight.values()) {
          if (live.answered || live.marked) continue;
          live.marked = true;
          live.entry.status = "cancelled";
          live.entry.ms = live.dispatchedAt ? Date.now() - live.dispatchedAt : 0;
        }
      };

      const warnJournal = (what: string) => (e: unknown): void => {
        logger.warn(`[codemode] journal ${what} write failed: ${formatError(e)}`);
      };

      const answerCall = (frame: CallFrame, live: LiveCall, r: NestedCallResult): void => {
        live.answered = true;
        inFlight.delete(frame.id);
        // Text-only bridge: inner images are dropped and the omission is
        // visible to the script. The nested-call result shape carries text
        // only, so this is the seam-level check: an image-bearing result
        // resolves its text plus the note.
        const images = (r as { images?: unknown[] }).images;
        const droppedImages = Array.isArray(images) && images.length > 0;
        const output = r.ok && droppedImages ? `${r.output}\n${IMAGE_OMITTED_NOTE}` : r.output;
        if (!live.marked) {
          if (live.dispatchedAt) live.entry.ms = Date.now() - live.dispatchedAt;
          if (r.ok) {
            live.entry.status = "ok";
            live.entry.error = null;
          } else {
            const msg = r.error ?? r.output;
            live.entry.error = msg;
            live.entry.status = BLOCKED_RE.test(msg) ? "denied" : "error";
          }
        }
        // Answered line: name + payload REFS (size, sha256, head). The raw
        // payload went back to the script; forensics keep the digest of it.
        void journal
          .append({
            ev: "call_answered",
            runId,
            seq: live.seq,
            childId: frame.id,
            name: live.entry.name,
            ok: r.ok,
            out_bytes: Buffer.byteLength(output),
            out_sha256: createHash("sha256").update(output).digest("hex"),
            out_head: output.slice(0, 240),
            err_head: live.entry.error?.slice(0, 240) ?? "",
          })
          .catch(warnJournal("answered"));
        if (settled || live.marked) return; // nobody left to answer
        writeResFrame(
          child,
          r.ok
            ? {
                t: "res",
                id: frame.id,
                ok: true,
                payload: {
                  output,
                  hint: r.hint ?? null,
                  error: r.error ?? null,
                  meta: r.meta ?? [],
                } satisfies ResPayload,
              }
            : {
                t: "res",
                id: frame.id,
                ok: false,
                error: r.error ?? r.output ?? "tool call failed",
              },
        );
      };

      const dispatchLive = async (frame: CallFrame, live: LiveCall): Promise<void> => {
        try {
          if (settled || runAbort.signal.aborted) return; // run's over; already cancelled
          live.seq = ++dispatchSeq;
          live.dispatchedAt = Date.now();
          // fsync-BEFORE-DISPATCH: the durable "this call started with these
          // args" line is on disk before the pipeline can run. A crash after
          // this point reads as started-not-answered, never never-asked.
          await journal
            .append({
              ev: "call_started",
              runId,
              seq: live.seq,
              childId: frame.id,
              name: frame.name,
              args: frame.args,
            })
            .catch(warnJournal("started"));
          if (settled || runAbort.signal.aborted) return;
          const dispatch = request.dispatch!;
          let r: NestedCallResult;
          try {
            // The dispatcher mints the inner id as "<parentCallId>/<n>" under
            // the codemode call's own id -- never pre-suffix here.
            r = await dispatch(frame.name, frame.args as NestedCallInput, {
              parentToolCallId: request.callId,
              signal: callSignal,
            });
          } catch (e) {
            // The dispatcher contract never throws; a broken seam still must
            // not strand the script's Promise.
            const msg = `nested dispatch failed: ${formatError(e)}`;
            r = { ok: false, output: msg, error: msg };
          }
          // A parameter-validation rejection carries the run's own def
          // signature (names + requiredness + describeTool pointer), since
          // the direct schema is not in the model's context.
          if (!r.ok) r = decorateValidationRejection(r, frame.name, metaInfos);
          answerCall(frame, live, r);
        } finally {
          releaseSlot();
        }
      };

      const handleCall = (frame: CallFrame): void => {
        const refuse = (error: string, reason: string): void => {
          void journal
            .append({
              ev: "call_refused",
              runId,
              childId: frame.id,
              name: frame.name,
              reason,
            })
            .catch(warnJournal("refusal"));
          writeResFrame(child, { t: "res", id: frame.id, ok: false, error });
        };
        if (!request.dispatch) {
          refuse(
            "inner tool calls are not wired: this run has no nested-call dispatcher",
            "no-dispatcher",
          );
          return;
        }
        if (!names.includes(frame.name)) {
          // A frame-forging child stays inside its run's callable table, and
          // `codemode` is filtered out of every table at build time.
          refuse(`unknown tool: ${frame.name} (not in this run's table)`, "not-callable");
          return;
        }
        if (inFlight.has(frame.id)) {
          // A forged duplicate id would evict the live call from inFlight,
          // hiding it from the terminal cancel pass (a "running" row would
          // survive the outcome). Two calls cannot share an id.
          refuse(`duplicate call id ${frame.id} still in flight`, "duplicate-id");
          return;
        }
        if (callRows >= MAX_INNER_CALLS) {
          // The cap errors the call rather than dropping it.
          refuse(`inner call limit reached (${MAX_INNER_CALLS} per script)`, "limit");
          return;
        }
        const live: LiveCall = {
          entry: {
            kind: "call",
            name: frame.name,
            args: frame.args,
            status: "running",
            ms: 0,
            error: null,
            note: null,
          },
          answered: false,
          marked: false,
          dispatchedAt: null,
          seq: 0,
        };
        digest.push(live.entry);
        callRows += 1;
        inFlight.set(frame.id, live);
        void slot().then(() => dispatchLive(frame, live));
      };

      const handleStore = async (frame: StoreFrame): Promise<void> => {
        try {
          const s = await storeSession();
          const err = s.set(frame.key, frame.value);
          if (!settled) {
            writeResFrame(
              child,
              err
                ? { t: "res", id: frame.id, ok: false, error: err }
                : {
                    t: "res",
                    id: frame.id,
                    ok: true,
                    payload: { output: "", hint: null, error: null, meta: [] },
                  },
            );
          }
        } catch (e) {
          if (!settled) {
            writeResFrame(child, {
              t: "res",
              id: frame.id,
              ok: false,
              error: `store failed: ${formatError(e)}`,
            });
          }
        }
      };

      const handleLoad = async (frame: LoadFrame): Promise<void> => {
        try {
          const s = await storeSession();
          const entry = s.lookup(frame.key);
          if (!settled) {
            writeResFrame(child, {
              t: "res",
              id: frame.id,
              ok: true,
              payload: {
                output: JSON.stringify(entry?.value ?? null),
                hint: null,
                error: null,
                meta: [],
              },
            });
          }
        } catch (e) {
          if (!settled) {
            writeResFrame(child, {
              t: "res",
              id: frame.id,
              ok: false,
              error: `load failed: ${formatError(e)}`,
            });
          }
        }
      };

      // Discovery meta ops: pure host-memory answers over metaInfos (the
      // policy-filtered set). No pipeline, no gate, no journal line, no
      // MAX_INNER_CALLS charge -- but the digest records ops as
      // host-authored meta lines, so what the script QUERIED is recorded no
      // matter what it prints. Retention is bounded: inputs enter rows only
      // as detached previews, and rows past DIGEST_MAX_ROWS are dropped with
      // the tail marker and the ops total in run_finished.
      const handleMeta = (frame: MetaFrame): void => {
        const startedAt = Date.now();
        metaTotal += 1;
        const row: CodemodeCallDigest = {
          kind: "meta",
          name: frame.op,
          args: null,
          status: "ok",
          ms: 0,
          error: null,
          note: null,
        };
        let output: string;
        let hint: string | null = null;
        if (frame.op === "searchTools") {
          const limit = normalizeSearchLimit(frame.limit);
          row.args = { query: metaPreview(frame.query), limit };
          const results = searchCallableInfos(metaInfos, frame.query, limit);
          row.note = `-> ${results.length}`;
          output = JSON.stringify(results);
        } else {
          row.args = { name: metaPreview(frame.name) };
          const sample = describeCallableInfo(metaInfos, frame.name);
          if (sample === null) {
            hint = `unknown tool "${metaPreview(frame.name)}" (outside this run's callable set); try searchTools("${searchToolsPointer(frame.name)}")`;
            row.note = `-> null; ${hint}`;
          }
          output = JSON.stringify(sample);
        }
        row.ms = Date.now() - startedAt;
        if (metaRows < DIGEST_MAX_ROWS) {
          metaRows += 1;
          digest.push(row);
        } // answered but not retained: digestDropped counts it, the rendered
        // tail says so, and run_finished journals the op total.
        if (!settled) {
          writeResFrame(child, {
            t: "res",
            id: frame.id,
            ok: true,
            payload: { output, hint, error: null, meta: [] },
          });
        }
      };

      const kill = (reason: KillReason): void => {
        if (!killReason) killReason = reason;
        cancelOutstanding(); // a killed script's outstanding calls stop now
        killProcessGroup(child, "SIGKILL");
      };

      const deadline = setTimeout(() => kill("timeout"), timeoutMs);
      const onAbort = (): void => kill("cancelled");
      request.abortSignal?.addEventListener("abort", onAbort);
      if (request.abortSignal?.aborted) onAbort(); // raced between the pre-check and here

      const settle = async (): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (grace) clearTimeout(grace);
        request.abortSignal?.removeEventListener("abort", onAbort);
        // The admission slot comes back on the child's ACTUAL exit (this
        // fires from 'exit'/'error'). Freeing it at result settle instead
        // lets a lingering child double-spawn runners.
        release();
        cancelOutstanding(); // terminal pass: no "running" row survives

        // Terminal precedence: once the host killed the run or called a
        // protocol violation, THAT decides the outcome -- a done frame that
        // made it through before the kill cannot rescue the run (a
        // violation means the script failed). "done-grace" is absent here:
        // there the script answered and only its lingerer died, so `done`
        // still decides.
        let error: string | null;
        const capMsg =
          `Script error: streamed output past ${OUTPUT_STREAM_CAP_BYTES} bytes / ` +
          `${OUTPUT_STREAM_MAX_ITEMS} items -- child killed`;
        if (protocolError) error = `Protocol violation: ${protocolError}`;
        else if (killReason === "timeout") error = "Script error: timeout";
        else if (killReason === "cancelled") error = "Script error: cancelled";
        else if (killReason === "output-cap" || exitCode === RUNNER_CAP_EXIT) {
          // Child-enforced cap (its own exit code) or the host backstop kill
          // on the received-bytes tally.
          error = capMsg;
        } else if (done) error = done.ok ? null : `Script error: ${done.error}`;
        else if (spawnError) error = `codemode spawn failed: ${spawnError}`;
        else {
          const tail = stderrTail.trim() ? `; stderr: ${stderrTail.trim().slice(-2000)}` : "";
          error = `Script error: runner exited unexpectedly (code ${exitCode}, signal ${signal})${tail}`;
        }

        // Store writes commit on script SUCCESS only: a failed or killed
        // script's store() calls never happened. A success whose commit fails
        // reports storeError rather than passing as ok.
        let storeCommitted = 0;
        if (error === null && storeP) {
          try {
            storeCommitted = await (await storeP).commit(runId);
          } catch (e) {
            storeError = formatError(e);
          }
        }

        const outcome: CodemodeRunOutcome = {
          ok: error === null,
          runId,
          runDir,
          journalPath,
          fence,
          // A failed run advertises no return value: whatever the child's
          // done frame claimed, the terminal fact is the failure.
          value: error === null && done && done.ok ? (done.value ?? null) : null,
          output: outTexts.join("\n"),
          items: [...outTexts],
          digest,
          digestDropped: metaTotal - metaRows,
          error,
          storeError,
          exitCode,
          signal,
          killed: killReason !== null,
          pid: child.pid ?? null,
          elapsedMs: Date.now() - startedAt,
          outBytes,
          outItems,
        };
        // Full-bytes output record: the result's elision marker names THIS
        // journal as holding everything the script streamed, so the items
        // belong on disk -- batched (one write, one fsync) at settle, before
        // the closing line. The rendered `return` value gets its own record
        // too: result assembly appends it as the last block BEFORE eliding,
        // so the marker must hold its bytes as well (recorded exactly as
        // renderReturnValue renders them).
        const outputRecords: JournalLine[] = outTexts.map((text) => ({
          ev: "output",
          runId,
          text,
        }));
        if (error === null && done && done.ok && done.value !== null && done.value !== undefined) {
          outputRecords.push({
            ev: "output",
            runId,
            kind: "return",
            text: renderReturnValue(done.value),
          });
        }
        try {
          await journal.appendMany(outputRecords);
        } catch (e) {
          warnJournal("output")(e);
        }
        // The closing record lands BEFORE the caller sees the outcome (and
        // before the host can exit): a run that reported must leave its
        // run_finished line on disk. release() already ran above, so the
        // admission slot still returns on actual child exit, not here.
        try {
          await journal.append({
            ev: "run_finished",
            runId,
            ok: outcome.ok,
            error,
            fence,
            killed: outcome.killed,
            exit_code: exitCode,
            signal,
            out_bytes: outBytes,
            out_items: outItems,
            calls: callRows, // pipeline calls only; meta rows are not calls
            meta_ops: metaTotal, // ops received even past the retention cap
            store_writes: storeCommitted,
            store_error: storeError,
          });
        } catch (e) {
          warnJournal("finish")(e);
        }
        await journal.close().catch(() => {});
        resolve(outcome);
      };

      // Pipe errors (EPIPE racing a dying child) land on the sockets, not the
      // write callbacks; an unhandled 'error' would throw in the host.
      child.stdin?.on("error", () => {});
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});

      const decoder = createFrameDecoder();
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        // Once the host killed this run, its frame stream decides NOTHING: a
        // done frame queued behind the SIGKILL must not resurrect a killed
        // run as success. Only `done` may end the run, and it ends it before
        // any kill can fire; everything after a kill is a dying child's
        // leftover noise.
        if (settled || killReason) return;
        let lines: string[];
        try {
          lines = decoder.push(chunk);
        } catch (e) {
          // Oversize (or hostile) frame: the stream is untrustworthy past it
          // -- protocol violation, child killed, error surfaced verbatim.
          protocolError = formatError(e);
          kill("protocol");
          return;
        }
        for (const line of lines) {
          if (killReason) break; // killed mid-batch: the rest is noise
          const frame = parseChildFrame(line);
          if (!frame) {
            protocolError = `malformed child frame: ${line.slice(0, 120)}`;
            kill("protocol");
            return;
          }
          switch (frame.t) {
            case "out":
              outBytes += Buffer.byteLength(line) + 1;
              outItems += 1;
              outTexts.push(frame.item.text);
              // Backstop to the child's self-enforcement (same numbers): a
              // runner that skips its own tally still dies here.
              if (outBytes > OUTPUT_STREAM_CAP_BYTES || outItems > OUTPUT_STREAM_MAX_ITEMS) {
                kill("output-cap");
              }
              break;
            case "done":
              done = frame;
              // Script ended: calls it left un-awaited are cancelled and the
              // digest says so. Grace covers a process lingering on handles
              // the script left behind; the wall deadline is done.
              cancelOutstanding();
              clearTimeout(deadline);
              grace = setTimeout(() => kill("done-grace"), DONE_GRACE_MS);
              break;
            case "call":
              // Dispatch through the nested-call entry (caps + clamp +
              // fsync-before-dispatch live in handleCall/dispatchLive).
              handleCall(frame);
              break;
            case "store":
              void handleStore(frame);
              break;
            case "load":
              void handleLoad(frame);
              break;
            case "meta":
              // Discovery: answered host-side over the run's
              // policy-filtered set; digest-recorded, never cap-charged.
              handleMeta(frame);
              break;
          }
        }
      });

      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });

      child.on("exit", (code, sig) => {
        exitCode = code;
        signal = sig;
        settle();
      });
      child.on("error", (e) => {
        // Spawn failure (ENOENT ...) arrives here without an exit; settle
        // still runs, so the admission slot comes back either way.
        spawnError = formatError(e);
        settle();
      });

      child.stdin!.write(encodeLine(runFrame));
    });
  }
}
