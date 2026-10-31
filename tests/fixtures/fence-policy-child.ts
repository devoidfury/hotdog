// Subprocess probe for the per-session runtime exec-fence override state
// machine. The pending-override-before-construction precedence (keyed by
// session id) and the boot-config x live-override display matrix need a
// process where NO shared broker and NO override exist yet -- module state
// is process-global, so the in-process suite cannot observe a virgin process
// (sequential `bun test` shares one process across files). The parent parses
// STEP: JSON lines off stdout.
//
// Honest observable for "the pending override landed on ITS session only":
// an invoke for the overridden session (off) plans NO fence -- no
// hotdog-exec-<session>-* scratch dir under the OS tmp dir may appear for
// it -- while an invoke for a NON-overridden sibling on the same broker
// takes the boot "probe" and DOES create one when the host has a jail
// backend (with no backend the sibling also plans nothing and the printed
// "backend" tells the parent when the contrast is vacuous).

import {
  getExecFencePolicy,
  setExecFencePolicy,
  execFenceOverrides,
  sharedToolExecBroker,
  sharedExecFenceDisplay,
} from "../../src/core/tool-exec-broker.ts";
import type { WireToolCtx, WireToolResult } from "../../src/core/tool-exec-protocol.ts";
import { execFenceBackend } from "../../src/utils/exec-plan.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const step = (name: string, value: unknown): void => {
  process.stdout.write(`STEP:${JSON.stringify({ step: name, value })}\n`);
};

const TOOL_CONFIG = {
  bashTool: { bashTimeoutMs: 20000, maxToolOutputLines: 100, maxTimeoutMs: 20000 },
  coreTools: { readToolLimit: 500, maxImageSize: 10485760, grepMaxResults: 50, maxToolOutputLines: 600 },
  envScrubbing: true,
  envScrubExtra: [],
};

const tag = `${process.pid}`;
const ovrSession = `pend-ovr-${tag}`; // toggled OFF before the broker exists
const sibSession = `pend-sib-${tag}`; // never toggled: follows boot "probe"
const roots = mkdtempSync(join(tmpdir(), "hotdog-fence-ovr-"));
const scratchCount = (session: string): number =>
  readdirSync(tmpdir()).filter((d) => d.startsWith(`hotdog-exec-${session}-`)).length;

function ctx(session: string): WireToolCtx {
  return { session, workspace: { roots: [roots], deny: [".env*"] }, toolConfig: TOOL_CONFIG };
}

const resultText = (r: WireToolResult): string =>
  r.kind === "tool-result" ? r.output : String((r as { value?: unknown }).value);

// 1. Virgin process: no overrides, no broker -> the display delegates to the
//    boot config (off never probes; probe shows the backend or honest failure).
step("delegate", {
  bootOff: sharedExecFenceDisplay(ovrSession, { toolExec: "worker", execFence: "off" }),
  bootProbe: sharedExecFenceDisplay(ovrSession, { toolExec: "worker", execFence: "probe" }),
  policy: getExecFencePolicy(ovrSession),
  overrides: execFenceOverrides(),
  backend: execFenceBackend(),
});

// 2. Pending override set BEFORE any broker exists: keyed to ovrSession; the
//    sibling session has no opinion (null = follow boot config).
setExecFencePolicy(ovrSession, "off");
step("pending", {
  sessionOvr: ovrSession,
  policyOvr: getExecFencePolicy(ovrSession),
  policySib: getExecFencePolicy(sibSession),
  overrides: execFenceOverrides(),
});

// 3. The shared construction CONSUMES the pending map (per-key: it outranks
//    the boot fence for its own session).
const shared = sharedToolExecBroker({ fence: "probe" });
step("constructed", {
  policyOvr: getExecFencePolicy(ovrSession),
  policySib: getExecFencePolicy(sibSession),
  overrides: execFenceOverrides(),
});

// 4. Planned-fence effect: the overridden session spawns unfenced -> no
//    scratch dir for it; the sibling plans under the boot "probe" -> one
//    appears when the host has a backend.
const ovrResult = await shared.invoke({
  session: ovrSession,
  tool: "bash",
  args: { command: "echo unfenced-ok" },
  ctx: ctx(ovrSession),
});
step("ovr-invoke", {
  text: resultText(ovrResult).trim(),
  scratch: scratchCount(ovrSession),
});
const sibResult = await shared.invoke({
  session: sibSession,
  tool: "bash",
  args: { command: "echo sibling" },
  ctx: ctx(sibSession),
});
step("sib-invoke", {
  text: resultText(sibResult).trim(),
  scratch: scratchCount(sibSession),
});

// 5. Display matrix with live overrides on the constructed broker: the
//    override wins over the boot value in both directions, per session; a
//    session with no override always derives from the boot config.
setExecFencePolicy(`pend-probe-${tag}`, "probe");
step("display-matrix", {
  offOverride_bootProbe: sharedExecFenceDisplay(ovrSession, { toolExec: "worker", execFence: "probe" }),
  probeOverride_bootOff: sharedExecFenceDisplay(`pend-probe-${tag}`, { toolExec: "worker", execFence: "off" }),
  noOverride_bootProbe: sharedExecFenceDisplay(sibSession, { toolExec: "worker", execFence: "probe" }),
  noOverride_bootOff: sharedExecFenceDisplay(sibSession, { toolExec: "worker", execFence: "off" }),
  inline_underOverride: sharedExecFenceDisplay(`pend-probe-${tag}`, { toolExec: "inline", execFence: "probe" }),
  backend: execFenceBackend(),
});

await shared.close();
for (const d of readdirSync(tmpdir())) {
  if (d.startsWith(`hotdog-exec-${ovrSession}-`) || d.startsWith(`hotdog-exec-${sibSession}-`)) {
    try {
      rmSync(join(tmpdir(), d), { recursive: true, force: true });
    } catch {
      // tmp policy takes them otherwise
    }
  }
}
rmSync(roots, { recursive: true, force: true });
process.exit(0);
