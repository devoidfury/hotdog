// Per-session runtime exec-fence policy toggle: the shared broker's override
// map (pending map keyed by session id, consumed at construction), the
// instance-level setSessionFencePolicy against REAL spawns (seam fence, the
// increment-3 idiom), per-session MEMO invalidation (a toggle drops its own
// session's memo entries and never touches siblings'), and the /fence command
// surface (inline-plane refusal, transcript notice landing on the toggled
// session's log only, per-session live display, override enumeration for the
// status surfaces).
//
// Module-state discipline: the pending override map is process-global and
// sequential `bun test` shares one process across files, so everything that
// needs a VIRGIN process (no override, no shared broker) rides the
// fence-policy-child fixture (fresh process per run). In-process tests key
// every override by a unique session id (a leaked key can never describe
// another file's sessions) and reset in afterAll -- later files must see
// exactly what they see today.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  ToolExecBroker,
  sharedExecFenceDisplay,
  setExecFencePolicy,
  getExecFencePolicy,
  execFenceOverrides,
  resetExecFenceOverridesForTesting,
} from "@core/tool-exec-broker.ts";
import { parseCommand, Command } from "@core/commands.ts";
import { execFenceBackend } from "@utils/exec-plan.ts";
import type { WireToolCtx, WireToolResult } from "@core/tool-exec-protocol.ts";
import type { Message } from "@core/context/message.ts";
import {
  fenceCommand,
  FENCE_USAGE,
  FENCE_OFF_NOTICE,
  FENCE_ON_NOTICE,
} from "@extensions/ui-interactive-cli/fence-command.ts";
import { recordingPlanner } from "../fixtures/fence-seam-planner.ts";
import type { AgentLike } from "@core/session/index.ts";
import { tmpDir, cleanupDir, processAlive } from "../helpers.ts";

const TOOL_CONFIG = {
  bashTool: { bashTimeoutMs: 20000, maxToolOutputLines: 100, maxTimeoutMs: 20000 },
  coreTools: { readToolLimit: 500, maxImageSize: 10485760, grepMaxResults: 50, maxToolOutputLines: 600 },
  envScrubbing: true,
  envScrubExtra: [],
};
const CHILD = join(import.meta.dir, "../fixtures/fence-policy-child.ts");

/** Unique to this process: override maps are keyed by session id. */
const sess = (name: string): string => `fence-ovr-${process.pid}-${name}`;

let dir: string;

beforeAll(() => {
  dir = tmpDir("hotdog-fence-toggle-");
});

afterAll(() => {
  cleanupDir(dir);
  resetExecFenceOverridesForTesting();
});

function ctx(session: string): WireToolCtx {
  return {
    session,
    workspace: { roots: [dir], deny: [".env*"] },
    toolConfig: TOOL_CONFIG,
  };
}

function text(result: WireToolResult): string {
  return result.kind === "tool-result" ? result.output : String(result.value);
}

/** First whitespace-separated token of a result, as a pid. */
function pidOf(result: WireToolResult): number {
  return parseInt(text(result).trim().split(/\s+/)[0] ?? "", 10);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function settle(fn: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// The command's channel is the only thing the in-process tests cannot carry;
// recording addMessage is the seam every logged harness record travels
// through (CONTEXT_MESSAGE -> session-log append).
function recordingAgent(): { agent: AgentLike; added: Message[] } {
  const added: Message[] = [];
  const agent = { addMessage: (m: Message) => added.push(m) } as unknown as AgentLike;
  return { agent, added };
}

// ── Pending override before first construction (fresh process) ──────────────

describe("pending override precedence per session (subprocess, virgin module state)", () => {
  it("a session toggled before broker construction lands on THAT session; the sibling follows boot", async () => {
    const proc = Bun.spawn([process.execPath, CHILD], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    const steps = new Map<string, Record<string, unknown>>();
    for (const line of out.split("\n")) {
      if (line.startsWith("STEP:")) {
        const j = JSON.parse(line.slice(5)) as { step: string; value: Record<string, unknown> };
        steps.set(j.step, j.value);
      }
    }

    // Virgin process: no override anywhere, the display delegates to the boot
    // config (off never probes; probe shows the backend or honest failure).
    const backend = steps.get("delegate")!.backend as string | null;
    const wantProbe = backend ?? "none -- probe failed";
    expect(steps.get("delegate")!.bootOff).toBe("off");
    expect(steps.get("delegate")!.bootProbe).toBe(wantProbe);
    expect(steps.get("delegate")!.policy).toBeNull();
    expect(steps.get("delegate")!.overrides).toEqual([]);

    // Pending override observable before any broker exists -- and it is
    // KEYED: only the toggled session reports it; the sibling reads null
    // (follow the boot config).
    const pend = steps.get("pending")!;
    expect(pend.policyOvr).toBe("off");
    expect(pend.policySib).toBeNull();
    expect(pend.overrides).toEqual([{ session: pend.sessionOvr, policy: "off" }]);

    // The shared construction CONSUMES the pending map per key.
    expect(steps.get("constructed")!.policyOvr).toBe("off");
    expect(steps.get("constructed")!.policySib).toBeNull();

    // Planned-fence effect: the overridden session spawns UNFENCED -- the
    // probe-booted planner would have created a hotdog-exec-<session>-*
    // scratch dir before its first spawn. The non-overridden sibling on the
    // same broker proves the boot "probe" DOES plan on this host; with no
    // backend the contrast is vacuous (the probe planner memoizes null) and
    // says so.
    expect(steps.get("ovr-invoke")!.text).toBe("unfenced-ok");
    expect(steps.get("ovr-invoke")!.scratch).toBe(0);
    expect(steps.get("sib-invoke")!.scratch).toBe(backend === null ? 0 : 1);
    if (backend === null) {
      process.stderr.write(
        "[fence-toggle] no jail backend on this host: the unfenced-vs-sibling scratch contrast is VACUOUS here (policy assertions above still bind)\n",
      );
    }

    // Display matrix: per session, the override wins over the boot value in
    // BOTH directions; a session without one always derives from the boot
    // config; inline never shows a fence.
    expect(steps.get("display-matrix")!.offOverride_bootProbe).toBe("off");
    expect(steps.get("display-matrix")!.probeOverride_bootOff).toBe(wantProbe);
    expect(steps.get("display-matrix")!.noOverride_bootProbe).toBe(wantProbe);
    expect(steps.get("display-matrix")!.noOverride_bootOff).toBe("off");
    expect(steps.get("display-matrix")!.inline_underOverride).toBe("off");
  }, 30_000);
});

// ── Live toggles on a broker (real spawn, seam fence) ───────────────────────

describe("live per-session policy toggle (seam fence, real spawn)", () => {
  /** One spawn probe: prints its runner pid and the fence generation it was born under. */
  const spawnProbe = (session: string) => ({
    session,
    tool: "bash",
    args: { command: "echo $PPID gen=[${FAKE_FENCE_GEN:-absent}]" },
    ctx: ctx(session),
  });

  it("off -> on: setSessionFencePolicy replaces the entry and the respawn carries the fence prefix", async () => {
    const session = sess("toggle-on");
    const planner = recordingPlanner(11);
    const broker = new ToolExecBroker({ fencePlan: null }); // the fence-off shape
    try {
      const first = await broker.invoke(spawnProbe(session));
      expect(text(first)).toContain("gen=[absent]");
      const plainPid = pidOf(first);

      broker.setSessionFencePolicy(session, "probe", planner.plan); // probe-equivalent fresh planner
      expect(broker.getSessionFencePolicy(session)).toBe("probe");
      const second = await broker.invoke(spawnProbe(session));
      expect(text(second)).toContain("gen=[11]"); // the new spawn is wrapped
      expect(pidOf(second)).not.toBe(plainPid); // fence mismatch replaced the entry
      await settle(() => !processAlive(plainPid), "the unfenced entry to die");
    } finally {
      await broker.close();
    }
  }, 20_000);

  it("on -> off: the entry is replaced, the respawn is UNFENCED, and no old prefix is ever reused", async () => {
    const session = sess("toggle-off");
    const gen1 = recordingPlanner(21);
    const broker = new ToolExecBroker({ fencePlan: gen1.plan }); // born ON with the seam fence
    try {
      const first = await broker.invoke(spawnProbe(session));
      expect(text(first)).toContain("gen=[21]");
      const fencedPid = pidOf(first);
      const callsAfterBirth = gen1.calls();
      expect(await broker.invoke(spawnProbe(session))).toBeDefined();
      expect(gen1.calls()).toBe(callsAfterBirth + 1); // the memo answers per invoke, entry stays

      broker.setSessionFencePolicy(session, "off"); // policy gate off: the planner is not consulted
      const off = await broker.invoke(spawnProbe(session));
      expect(text(off)).toContain("gen=[absent]"); // respawn unfenced
      expect(pidOf(off)).not.toBe(fencedPid); // fence mismatch replaced the entry
      await settle(() => !processAlive(fencedPid), "the fenced entry to die");

      // Back to probe with a FRESH planner: its first plan is a new argv
      // (gen 22). The old memoized gen-21 prefix must never come back -- a
      // surviving memo on THIS session would have replayed it (id match, no
      // replacement).
      const gen22 = recordingPlanner(22);
      broker.setSessionFencePolicy(session, "probe", gen22.plan);
      const back = await broker.invoke(spawnProbe(session));
      expect(text(back)).toContain("gen=[22]");
      expect(text(back)).not.toContain("gen=[21]");
      expect(pidOf(back)).not.toBe(pidOf(off));
      expect(gen1.calls()).toBe(callsAfterBirth + 1); // the retired planner was never consulted again
    } finally {
      await broker.close();
    }
  }, 30_000);

  it("isolation (headline): toggling A off leaves B fenced, B's memo byte-identical, and A respawns unfenced", async () => {
    const a = sess("iso-a");
    const b = sess("iso-b");
    const planner = recordingPlanner(31);
    const broker = new ToolExecBroker({ fencePlan: planner.plan }); // boot probe (seam)
    try {
      const a1 = await broker.invoke(spawnProbe(a));
      expect(text(a1)).toContain("gen=[31]");
      const b1 = await broker.invoke(spawnProbe(b));
      expect(text(b1)).toContain("gen=[31]");
      const bPid = pidOf(b1);
      // B's planned fence through the memo (the same object/id every invoke gets).
      const bFence = planner.plan(b, "rw", [dir])!;
      const bFenceId = bFence.id;

      broker.setSessionFencePolicy(a, "off");
      expect(broker.getSessionFencePolicy(a)).toBe("off");
      expect(broker.getSessionFencePolicy(b)).toBeNull(); // B never toggled: boot policy

      // B's memo SURVIVES A's toggle: the planned fence is byte-identical.
      // (A memo blown by A's toggle would replan under a new id -- and the
      // pool entry below would visibly replace itself to honor it.)
      expect(planner.plan(b, "rw", [dir])!.id).toBe(bFenceId);

      // B's next invoke still gets the fence prefix and keeps its entry.
      const b2 = await broker.invoke(spawnProbe(b));
      expect(text(b2)).toContain("gen=[31]");
      expect(pidOf(b2)).toBe(bPid);

      // A's entry is replaced unfenced on its next invoke.
      const a2 = await broker.invoke(spawnProbe(a));
      expect(text(a2)).toContain("gen=[absent]");
      expect(pidOf(a2)).not.toBe(pidOf(a1));
      await settle(() => !processAlive(pidOf(a1)), "A's fenced entry to die");
    } finally {
      await broker.close();
    }
  }, 30_000);

  it("reverse: B to probe on a boot-off broker fences B while A stays unfenced", async () => {
    const a = sess("rev-a");
    const b = sess("rev-b");
    const planner = recordingPlanner(41);
    const broker = new ToolExecBroker({ fencePlan: null }); // boot OFF shape
    try {
      const a1 = await broker.invoke(spawnProbe(a));
      expect(text(a1)).toContain("gen=[absent]");

      broker.setSessionFencePolicy(b, "probe", planner.plan);
      const b1 = await broker.invoke(spawnProbe(b));
      expect(text(b1)).toContain("gen=[41]");

      // A has no override: it keeps the boot "off" -- plain spawn, and its
      // warm entry survives (nothing about B's toggle rewrites A's plan).
      const a2 = await broker.invoke(spawnProbe(a));
      expect(text(a2)).toContain("gen=[absent]");
      expect(pidOf(a2)).toBe(pidOf(a1));
    } finally {
      await broker.close();
    }
  }, 20_000);

  it("setSessionFencePolicy on a closed-to-invoke broker keeps the plane contract: no spawn is downgraded", async () => {
    // Degraded/closed planes still reject loudly; a policy toggle never
    // turns a worker call into an inline run.
    const broker = new ToolExecBroker({ fencePlan: null, respawnCap: 0, execPath: "/definitely/not/bun" });
    broker.setSessionFencePolicy(sess("toggle-no-downgrade"), "probe");
    await expect(
      broker.invoke({ session: "toggle-no-downgrade", tool: "bash", args: { command: "echo x" }, ctx: ctx("toggle-no-downgrade") }),
    ).rejects.toThrow(/broker/);
    await broker.close();
  });
});

// ── The /fence command surface ──────────────────────────────────────────────

describe("parseCommand /fence", () => {
  it("resolves on/off/status args like the sibling value commands", () => {
    expect(parseCommand("fence off")).toEqual({ type: Command.Fence, value: "off" });
    expect(parseCommand("fence status")).toEqual({ type: Command.Fence, value: "status" });
    expect(parseCommand("fence")).toEqual({ type: Command.Fence, value: null });
    expect(parseCommand("fences off").type).toBe(Command.Unknown);
  });
});

describe("fenceCommand (per session)", () => {
  const worker = { toolExec: "worker", execFence: "probe" };
  const inline = { toolExec: "inline", execFence: "probe" };

  afterAll(resetExecFenceOverridesForTesting);

  it("refuses on an inline plane and changes nothing (no policy, no notice)", () => {
    const session = sess("inline-refusal");
    const { agent, added } = recordingAgent();
    for (const arg of ["on", "off"]) {
      const r = fenceCommand(arg, inline, agent, session);
      expect(r.applied).toBeNull();
      expect(r.output).toContain("refused");
      expect(r.output).toContain("inline");
    }
    expect(added).toHaveLength(0);
    expect(getExecFencePolicy(session)).toBeNull();
  });

  it("usage for a missing or unknown argument; no resolved posture means refusal, not a guess", () => {
    const session = sess("garbage");
    const { agent, added } = recordingAgent();
    expect(fenceCommand(null, worker, agent, session).output).toBe(FENCE_USAGE);
    expect(fenceCommand("sideways", worker, agent, session).output).toBe(FENCE_USAGE);
    expect(added).toHaveLength(0);
    const orphan = fenceCommand("off", null, agent, session);
    expect(orphan.applied).toBeNull();
    expect(orphan.output).toContain("refusing");
    expect(getExecFencePolicy(session)).toBeNull();
  });

  it("off applies to THIS session, prints the UNFENCED warning, and logs the notice to this session's log only", () => {
    const session = sess("notice-a");
    const sibling = sess("notice-b");
    const { agent, added } = recordingAgent();
    const siblingAgent = recordingAgent();
    const r = fenceCommand("off", worker, agent, session);
    expect(r.applied).toBe("off");
    expect(r.output).toContain("UNFENCED");
    expect(r.output).toContain("for this session");
    expect(getExecFencePolicy(session)).toBe("off");
    expect(getExecFencePolicy(sibling)).toBeNull(); // the sibling is untouched
    expect(added).toHaveLength(1);
    expect(siblingAgent.added).toHaveLength(0); // the notice rides the toggled agent only
    const msg = added[0] as unknown as {
      role: string;
      source: string;
      content: Array<{ type: string; text: string }>;
    };
    expect(msg.role).toBe("harness");
    expect(msg.source).toBe("harness");
    expect(msg.content[0]!.type).toBe("system-notice");
    expect(msg.content[0]!.text).toBe(FENCE_OFF_NOTICE);
    expect(msg.content[0]!.text).toContain("UNFENCED from the next spawn");
    expect(msg.content[0]!.text).toContain("THIS session");
  });

  it("on applies probe to THIS session and logs its own notice", () => {
    const session = sess("notice-on");
    const { agent, added } = recordingAgent();
    const r = fenceCommand("on", worker, agent, session);
    expect(r.applied).toBe("probe");
    expect(getExecFencePolicy(session)).toBe("probe");
    expect(added).toHaveLength(1);
    const msg = added[0] as unknown as { content: Array<{ type: string; text: string }> };
    expect(msg.content[0]!.type).toBe("system-notice");
    expect(msg.content[0]!.text).toBe(FENCE_ON_NOTICE);
  });

  it("status prints THIS session's live posture, its override state, and the boot config", () => {
    const session = sess("status-a");
    const sibling = sess("status-b");
    const { agent, added } = recordingAgent();
    setExecFencePolicy(session, "off");
    const r = fenceCommand("status", { toolExec: "worker", execFence: "probe" }, agent, session);
    expect(r.applied).toBeNull();
    expect(r.output).toContain("worker (fence: off)"); // LIVE policy, not the boot "probe"
    expect(r.output).toContain('This session runs a runtime override (policy "off")');
    expect(r.output).toContain('boot config said "probe"');
    // The sibling sees NO override: its status derives from the boot config.
    const sib = fenceCommand("status", { toolExec: "worker", execFence: "probe" }, agent, sibling);
    expect(sib.output).toContain("No runtime override for this session");
    const backend = execFenceBackend() ?? "none -- probe failed";
    expect(sib.output).toContain(`worker (fence: ${backend})`);
    // A probe override over a boot-off config flips the display too.
    setExecFencePolicy(sess("status-c"), "probe");
    const clean = fenceCommand("status", { toolExec: "worker", execFence: "off" }, agent, sess("status-c"));
    expect(clean.output).toContain(`worker (fence: ${backend})`);
    expect(clean.output).toContain('boot config said "off"');
    // status never writes policy and never logs.
    expect(added).toHaveLength(0);
  });

  it("execFenceOverrides enumerates the live overrides (the info line); empty when none", () => {
    resetExecFenceOverridesForTesting();
    // No overrides -> `hotdog info` prints no override line at all.
    expect(execFenceOverrides()).toEqual([]);
    const a = sess("enum-a");
    const b = sess("enum-b");
    setExecFencePolicy(a, "off");
    setExecFencePolicy(b, "probe");
    expect(execFenceOverrides()).toEqual([
      { session: a, policy: "off" },
      { session: b, policy: "probe" },
    ]);
    resetExecFenceOverridesForTesting();
    expect(execFenceOverrides()).toEqual([]);
  });
});

// ── Live display (in-process, explicit override; reset after) ───────────────

describe("sharedExecFenceDisplay per session", () => {
  afterAll(resetExecFenceOverridesForTesting);

  it("the override wins over boot for ITS session; a sibling session follows boot", () => {
    const wantProbe = execFenceBackend() ?? "none -- probe failed";
    const s = sess("display");
    const sibling = sess("display-sibling");
    setExecFencePolicy(s, "probe");
    expect(sharedExecFenceDisplay(s, { toolExec: "worker", execFence: "off" })).toBe(wantProbe);
    // The sibling has no override: boot "off" stays "off" for it.
    expect(sharedExecFenceDisplay(sibling, { toolExec: "worker", execFence: "off" })).toBe("off");
    setExecFencePolicy(s, "off");
    expect(sharedExecFenceDisplay(s, { toolExec: "worker", execFence: "probe" })).toBe("off");
    // And boot "probe" stays probed for the sibling.
    expect(sharedExecFenceDisplay(sibling, { toolExec: "worker", execFence: "probe" })).toBe(wantProbe);
    // Inline never shows a fence, whatever the live policy says.
    setExecFencePolicy(s, "probe");
    expect(sharedExecFenceDisplay(s, { toolExec: "inline", execFence: "probe" })).toBe("off");
  });
});

// ── Zero writes to config files (the honest minimum) ────────────────────────

describe("the toggle touches no config", () => {
  it("a full status/off/on cycle leaves config files byte-identical by mtime", () => {
    const session = sess("noconfig");
    const coreSchema = join(import.meta.dir, "../../src/core/core.config.json");
    const fakeUserDir = mkdtempSync(join(tmpdir(), "hotdog-fence-noconfig-"));
    const userDefaults = join(fakeUserDir, "defaults.json");
    writeFileSync(userDefaults, '{ "execFence": "probe" }\n');
    const before = [coreSchema, userDefaults].map((p) => statSync(p).mtimeMs);
    try {
      const { agent } = recordingAgent();
      const resolved = { toolExec: "worker", execFence: "probe", configDir: fakeUserDir };
      fenceCommand("status", resolved, agent, session);
      fenceCommand("off", resolved, agent, session);
      fenceCommand("status", resolved, agent, session);
      fenceCommand("on", resolved, agent, session);
      const after = [coreSchema, userDefaults].map((p) => statSync(p).mtimeMs);
      expect(after).toEqual(before);
    } finally {
      rmSync(fakeUserDir, { recursive: true, force: true });
      resetExecFenceOverridesForTesting();
    }
  });
});
