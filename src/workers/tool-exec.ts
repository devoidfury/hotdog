// Pooled executor runner.
//
// Spawned by the broker (`bun <this file>`), one entry per (session, class).
// Reads invoke frames on stdin, runs the tool, writes one result frame per
// call. It imports tool CLASSES only -- never the config stack: every value
// a tool needs (workspace roots + deny, bash caps, env policy) arrives
// per-call in the frame ctx. No model fetch, no MCP boot, no hook system.
//
// The fence is argv: this file is identical fenced and unfenced; the jail plan
// wraps the spawn, not the code. The runner rebuilds
// `Workspace` from ctx and runs `resolveSafe` itself -- belt under the fence,
// not replacement. Exits on stdin EOF (the broker going away).

import { ToolContext } from "@core/extensions/tool-context.ts";
import { ConfigError, ToolError } from "@core/error.ts";
import type { Tool } from "@core/extensions/tool-registry.ts";
import {
  encodeFrame,
  LineDecoder,
  serializeToolResult,
  serializeWireError,
  type InvokeFrame,
  type OutboundFrame,
  type WireToolConfig,
} from "@core/tool-exec-protocol.ts";
import { Workspace } from "@utils/workspace.ts";
import { BashTool } from "@extensions/bash-tool/index.ts";
import { ReadTool } from "@extensions/core-tools/read.ts";
import { GrepTool } from "@extensions/core-tools/grep.ts";

/**
 * Tool name -> constructor from wire ctx scalars. Mirrors each extension's
 * create() mapping (bash-tool/index.ts, core-tools/index.ts) minus the config
 * layer: the scalars are required, because a silently-defaulted second copy
 * of every tool cap is exactly how a plane drifts from its config.
 */
const TOOL_FACTORIES: Record<string, (cfg: WireToolConfig) => Tool> = {
  bash: (cfg) => {
    const b = cfg.bashTool ?? {};
    return new BashTool({
      timeoutMs: reqNum(b.bashTimeoutMs, "bashTool.bashTimeoutMs"),
      maxOutputLines: reqNum(b.maxToolOutputLines, "bashTool.maxToolOutputLines"),
      maxTimeoutMs: typeof b.maxTimeoutMs === "number" ? b.maxTimeoutMs : undefined,
      envScrubExtra: cfg.envScrubExtra,
      envScrubbing: cfg.envScrubbing !== false,
      env: (b.env ?? {}) as Record<string, string>,
    });
  },
  read: (cfg) => {
    const c = cfg.coreTools ?? {};
    return new ReadTool({
      readLimit: reqNum(c.readToolLimit, "coreTools.readToolLimit"),
      maxImageSize: reqNum(c.maxImageSize, "coreTools.maxImageSize"),
    });
  },
  grep: (cfg) => {
    const c = cfg.coreTools ?? {};
    return new GrepTool({
      maxResults: reqNum(c.grepMaxResults, "coreTools.grepMaxResults"),
      maxOutputLines: reqNum(c.maxToolOutputLines, "coreTools.maxToolOutputLines"),
    });
  },
};

function reqNum(v: unknown, what: string): number {
  if (typeof v !== "number") {
    throw new ConfigError(`tool-exec ctx: missing numeric config ${what}`);
  }
  return v;
}

function writeFrame(frame: unknown): void {
  try {
    process.stdout.write(encodeFrame(frame) + "\n");
  } catch {
    // The supervisor went away mid-answer; nobody is left to read it.
  }
}

/**
 * One controller per in-flight invoke, aborted by a cancel frame. Whether the
 * tool honors it is the tool's business: `bash` kills its process group,
 * while `read`/`grep` run to completion (their syscalls are not interruptible
 * here). The supervisor never waits for either -- it settles a cancelled call
 * itself and drops the late reply -- so a cancel frame is best-effort by
 * design, not a protocol-level kill.
 */
const inFlight = new Map<string, AbortController>();

async function handleInvoke(frame: InvokeFrame): Promise<void> {
  const controller = new AbortController();
  inFlight.set(frame.id, controller);
  try {
    const factory = TOOL_FACTORIES[frame.tool];
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
  for (const line of decoder.push(chunk)) {
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
    if (frame.op === "cancel") {
      inFlight.get(frame.id)?.abort();
      continue;
    }
    // warm/reap are supervisor-scoped; the runner only executes.
  }
});
// Broker gone: nothing to serve, nothing to outlive it -- but not by
// `process.exit(0)` over live work (increment-3 review): an in-flight bash
// escalates TERM->SIGKILL over ~2s on its abort signal, and that timer dies
// with an immediate exit, orphaning the detached process group. So: abort
// everything, let the escalation land, then leave.
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
