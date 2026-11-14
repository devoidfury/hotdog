// Pooled executor runner (descriptor-driven), the RUNNER_ENTRY of
// tool-exec-layout.ts. Spawned by the broker (`bun <this file>`), one entry
// per (session, class): reads frames on stdin, runs the tool, writes one
// result frame per call.
//
// It imports NO tool module at boot -- zero static `@extensions/*` or
// `@experimental/*` edges: which modules this host may load arrives over the
// wire, as descriptors (tool name + module file URL + factory-map export
// name) in the register frame, and each tool is dynamic-imported on FIRST
// USE. Every value a tool needs (workspace roots + deny, bash caps, env
// policy) arrives per call in the frame ctx -- no config stack, no hooks,
// no model fetch.
//
// The fence is argv: this file is identical fenced and unfenced; the jail
// plan wraps the spawn, not the code. The runner rebuilds `Workspace` from
// ctx and runs `resolveSafe` itself -- belt under the fence, not the fence.
// Exits on stdin EOF (the broker going away).

import { ToolContext } from "@core/extensions/tool-context.ts";
import { formatError, ToolError } from "@core/error.ts";
import type { Tool } from "@core/extensions/tool-registry.ts";
import {
  encodeFrame,
  LineDecoder,
  serializeToolResult,
  serializeWireError,
  type InvokeFrame,
  type OutboundFrame,
  type WireToolConfig,
  type WireToolDescriptor,
} from "@core/tool-exec-protocol.ts";
import { PROJECT_ROOT } from "@core/tool-exec-layout.ts";
import { Workspace } from "@utils/workspace.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Descriptor-driven tool loading ──────────────────────────────────────────

type ToolFactoryFn = (cfg: WireToolConfig) => Tool;

/**
 * The tool surface, exactly as the register frame said: a register frame
 * REPLACES the whole map (the supervisor ships the complete set).
 */
let descriptors = new Map<string, WireToolDescriptor>();
/** Lazily resolved factories: a module is imported on the tool's first invoke. */
const factories = new Map<string, ToolFactoryFn>();
/** Bumped by every register; lets an in-flight lazy import notice a replacement. */
let generation = 0;

/**
 * A descriptor module must be a file: URL whose normalized path resolves
 * under PROJECT_ROOT (no `..` dance); anything else is refused loudly and
 * NEVER imported. The broker is the trusted host: this is the belt against
 * forged or corrupted frames, not the containment boundary -- the fence is
 * that.
 */
function isUnderProjectRoot(moduleUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(moduleUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "file:") return false;
  let path: string;
  try {
    path = resolve(fileURLToPath(parsed));
  } catch {
    return false;
  }
  // Bun decodes %00 where Node's fileURLToPath throws; a NUL byte never names a file.
  if (path.includes("\0")) return false;
  const root = resolve(PROJECT_ROOT);
  return path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * Validate and install the frame's descriptors: a refused descriptor drops
 * only itself -- sibling descriptors keep serving.
 */
function handleRegister(frame: { tools: WireToolDescriptor[] }): void {
  const next = new Map<string, WireToolDescriptor>();
  for (const d of Array.isArray(frame.tools) ? frame.tools : []) {
    if (
      !d ||
      typeof d.tool !== "string" ||
      typeof d.module !== "string" ||
      typeof d.factory !== "string"
    ) {
      writeFrame({
        op: "log",
        level: "error",
        msg: `refusing malformed tool descriptor: ${JSON.stringify(d).slice(0, 200)}`,
      });
      continue;
    }
    if (!isUnderProjectRoot(d.module)) {
      writeFrame({
        op: "log",
        level: "error",
        msg:
          `refusing tool descriptor for "${d.tool}": module "${d.module}" ` +
          `is not a file: URL resolving under the project root`,
      });
      continue;
    }
    next.set(d.tool, { tool: d.tool, module: d.module, factory: d.factory });
  }
  descriptors = next;
  factories.clear();
  generation++;
}

/**
 * Resolve a tool's factory, dynamic-importing its module on first use (and
 * caching it). Any failure (import throws, missing key, export not a
 * function) logs loudly and answers null: the caller fails with the same
 * unknown-tool error an unregistered name gets, never a silent fallback.
 */
async function factoryFor(name: string): Promise<ToolFactoryFn | null> {
  const hit = factories.get(name);
  if (hit) return hit;
  const desc = descriptors.get(name);
  if (!desc) return null;
  const gen = generation;
  try {
    const mod = (await import(desc.module)) as Record<string, unknown>;
    const map = mod[desc.factory] as Record<string, unknown> | undefined;
    const fn = map ? map[name] : undefined;
    if (typeof fn !== "function") {
      writeFrame({
        op: "log",
        level: "error",
        msg: `tool "${name}": module "${desc.module}" exports no callable ${desc.factory}.${name}`,
      });
      return null;
    }
    const factory = fn as ToolFactoryFn;
    // Invariant: the broker child writes register exactly once per runner
    // birth. If one landed while this import ran it REPLACED the map and
    // evicted this descriptor, so the import result falls instead of
    // re-entering the cache; the call answers "not registered" like any
    // unknown tool.
    if (gen !== generation) return null;
    factories.set(name, factory);
    return factory;
  } catch (e) {
    writeFrame({
      op: "log",
      level: "error",
      msg: `tool "${name}": dynamic import of "${desc.module}" failed: ${formatError(e)}`,
    });
    return null;
  }
}

function writeFrame(frame: unknown): void {
  try {
    process.stdout.write(encodeFrame(frame) + "\n");
  } catch {
    // The supervisor went away mid-answer; nobody is left to read it.
  }
}

/**
 * One controller per in-flight invoke, aborted by a cancel frame. Honor is
 * the tool's business (`bash` kills its process group; `read`/`grep` run to
 * completion) and the supervisor never waits -- a cancel frame is
 * best-effort by design, not a protocol-level kill.
 */
const inFlight = new Map<string, AbortController>();

async function handleInvoke(frame: InvokeFrame): Promise<void> {
  const controller = new AbortController();
  inFlight.set(frame.id, controller);
  try {
    const factory = await factoryFor(frame.tool);
    if (!factory) {
      throw new ToolError(`tool-exec: tool "${frame.tool}" is not registered in the runner`);
    }
    const { roots, deny } = frame.ctx.workspace;
    // Same construction rule as the supervisor's ToolExecutor: an explicit []
    // disables the denylist; null/unset falls back to DEFAULT_DENY_PATTERNS.
    const workspace =
      deny !== null && deny !== undefined
        ? new Workspace(roots, deny)
        : new Workspace(roots);
    const toolCtx = new ToolContext({
      workspace,
      isSessionRestoring: false,
      // The model's call id when the frame carries one; the wire id only
      // attributes when the host never sent one (standalone broker clients).
      toolCallId: frame.toolCallId ?? frame.id,
      abortSignal: controller.signal,
    });
    // Construction per call, from the frame's pinned scalars: a missing
    // required numeric throws ConfigError (reqWireNum, E1) and the catch
    // below fails the call with it.
    const tool = factory(frame.ctx.toolConfig ?? {});
    const result = await tool.execute(frame.args, toolCtx);
    writeFrame({ id: frame.id, ok: true, result: serializeToolResult(result) });
  } catch (e) {
    writeFrame({ id: frame.id, ok: false, error: serializeWireError(e) });
  } finally {
    inFlight.delete(frame.id);
  }
}

const decoder = new LineDecoder();
process.stdin.setEncoding("utf8");
// Pipe errors (EPIPE racing the supervisor's exit) must not become unhandled
// 'error' events; the end/close path below handles the real teardown.
process.stdin.on("error", () => {});
process.stdout.on("error", () => {});
process.stdin.on("data", (chunk: string) => {
  let lines: string[];
  try {
    lines = decoder.push(chunk);
  } catch (e) {
    // Past an overflow the broker's frame stream is unresyncable: drain
    // exactly as an EOF does (abort in-flight so the bash SIGKILL escalation
    // lands); the broker's exit handler answers every pending call with the
    // executor-died contract.
    if (!draining) {
      writeFrame({
        op: "log",
        level: "error",
        msg: `frame overflow from broker: ${formatError(e)}; draining`,
      });
    }
    drain();
    return;
  }
  for (const line of lines) {
    let frame: OutboundFrame;
    try {
      frame = JSON.parse(line) as OutboundFrame;
    } catch {
      writeFrame({ op: "log", level: "error", msg: `malformed frame dropped: ${line.slice(0, 200)}` });
      continue;
    }
    if (!frame || typeof frame !== "object") continue;
    if (frame.op === "invoke") {
      void handleInvoke(frame);
      continue;
    }
    if (frame.op === "register") {
      handleRegister(frame);
      continue;
    }
    if (frame.op === "cancel") {
      inFlight.get(frame.id)?.abort();
      continue;
    }
    // warm/reap are supervisor-scoped; the runner only executes.
  }
});
// Broker gone: nothing to serve. NOT `process.exit(0)` over live work: an
// in-flight bash escalates TERM->SIGKILL over ~2s on its abort signal, and
// that timer dies with an immediate exit, orphaning the detached process
// group. So: abort everything, let the escalation land, then leave.
let draining = false;
function drain(): void {
  if (draining) return;
  draining = true;
  const live = inFlight.size;
  for (const controller of inFlight.values()) controller.abort();
  if (live === 0) process.exit(0);
  // Slack over the 2s SIGKILL grace so the escalation always outruns the exit.
  setTimeout(() => process.exit(0), 2500);
}
process.stdin.on("end", drain);
// A targeted SIGTERM reaches only the runner (bash groups are detached from
// this process's group), so it must drain the same way an EOF does.
process.on("SIGTERM", drain);
