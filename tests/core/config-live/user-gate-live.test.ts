/**
 * The approvals gate against the real write transaction: what a change under
 * `userGate` does to the rules the NEXT gated call is decided by.
 *
 * The gate ships three seams and every one of them is pinned here on a host
 * whose gate is enabled at boot, through the production write chain (no mocks;
 * only the approval prompt's input seam is faked, at its natural boundary):
 *  - BOTH panel entry points pre-compile the candidate block before a byte is
 *    written (the value editor and the list ops): a rule the compiler rejects
 *    leaves the file's bytes alone, leaves the published generation alone, and
 *    leaves the running rules in charge of the next call, with the compiler's
 *    own words as the refusal.
 *  - the PREPARE hook is the transaction's copy of that check. On a gate-enabled
 *    host the panel fires first (same compiler, same candidate, earlier), so a
 *    bad rule never survives to a prepare refusal through either panel path --
 *    the refusal shape is therefore pinned at the hook itself, run through the
 *    real runner over a constructed context, with the good-candidate control
 *    beside it.
 *  - the APPLY hook swaps the rule holder the tool-call handler reads per call:
 *    a rewritten rule element flips the verdict of the very next gated call
 *    (both directions), a scalar rule field claims `live` in the reply,
 *    in-memory session grants survive a swap, and a write under the same root
 *    that moves none of the fields the compile reads recompiles nothing and logs
 *    nothing.
 * The swap's audit line carries who wrote it and the shape of what changed.
 *
 * Sequential-run isolation: the enabled gate registers its rows in the
 * process-wide hook table, so the instance is drained at file end through its
 * own SHUTDOWN_CLEANUP seam -- a later file's hook-coverage walk must only ever
 * see its own rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, type GateAction } from "@core/hooks.ts";
import {
  registeredHooks,
  runConfigApplyHook,
  type ConfigApplyContext,
} from "@core/config/apply-hooks.ts";
import { registerConfigAuditSurface } from "@core/config/audit.ts";
import { applyConfigKeyEdit, applyConfigListEdit } from "@extensions/websocket/handlers-config.ts";
import { create as createUserGate } from "@extensions/user-gate/index.ts";
import { Workspace } from "@utils/workspace.ts";
import type { HookPayloads } from "@core/extensions/types.ts";
import { bootLive, fsDeps, seedFile, withShadowEnvCleared, type LiveEnv } from "./probes.ts";

type ToolCallPayload = HookPayloads["tool:call"];
type ToolCallHandler = (payload: ToolCallPayload) => Promise<GateAction | undefined>;

/** The boot block: an allow-listed `git`, nothing denied, ask everything else.
 *  The rows below flip both directions from here. A primitive array in the file
 *  edits ELEMENT-wise (the array itself is chrome), so the boot list has exactly
 *  one element for the element rows to rewrite. */
const gateSeed = () => ({
  ...seedFile(),
  userGate: { enabled: true, default: "ask", allow: ["bash.cmd=git"], deny: [] },
});

let env: LiveEnv;
let gate: ToolCallHandler;
let releaseGate: (() => void) | null = null;
let notices: string[] = [];
let releaseSurface: (() => void) | null = null;

beforeAll(async () => {
  env = await bootLive(gateSeed());
  releaseSurface = registerConfigAuditSurface((text) => notices.push(text));
  const instance = createUserGate(env.core);
  gate = instance.hooks?.[HOOKS.TOOL_CALL] as unknown as ToolCallHandler;
  releaseGate = instance.hooks?.[HOOKS.SHUTDOWN_CLEANUP] as unknown as (() => void) | null;
  expect(gate, "an enabled gate ships a TOOL_CALL handler").toBeTypeOf("function");
});

afterAll(() => {
  releaseGate?.();
  releaseSurface?.();
  env?.cleanup();
});

const file = () => readFileSync(join(env.dir, "defaults.json"), "utf-8");

/** One write through the real transaction, with every audit-surface line it emitted. */
async function write(
  keyPath: string,
  input: Parameters<typeof applyConfigKeyEdit>[2],
  actor?: string,
): Promise<{ res: Awaited<ReturnType<typeof applyConfigKeyEdit>>; notices: string[] }> {
  notices = [];
  const res = await withShadowEnvCleared(() =>
    applyConfigKeyEdit(
      env.core,
      keyPath,
      input,
      actor === undefined ? { deps: fsDeps } : { deps: fsDeps, actor },
    ),
  );
  return { res, notices: [...notices] };
}

const ws = new Workspace("/ws");

/** A gated call, exactly as the executor hands it over: the workspace the
 *  extractor resolves targets against, and (for the ask rows) a fake prompt
 *  seam at its natural boundary. With no `answer` there is no UI at all, which
 *  is the fail-closed path: an ask becomes a block naming the missing UI. */
function call(
  toolName: string,
  args: Record<string, unknown>,
  over: { sessionId?: string; answer?: string; asked?: string[] } = {},
): ToolCallPayload {
  const bag: Record<string, unknown> = { workspace: ws };
  if (over.answer !== undefined) {
    bag["input"] = {
      isInteractive: () => true,
      collectAnswers: (qs: Record<string, unknown>[]) => {
        over.asked?.push(String(qs[0]?.prompt ?? ""));
        return { approve: over.answer };
      },
    };
  }
  return {
    toolCallId: `gate-${toolName}`,
    toolName,
    input: JSON.stringify(args),
    agent: { sessionId: over.sessionId ?? "gate-session" },
    toolCtx: { get: (k: string) => bag[k] },
  } as unknown as ToolCallPayload;
}

/** What the gate answered: allowed (its no-opinion form) or blocked, with text. */
async function verdict(payload: ToolCallPayload): Promise<{ blocked: boolean; text: string }> {
  const action = await gate(payload);
  return {
    blocked: action?.action === "block",
    text: String((action as { result?: unknown } | undefined)?.result ?? ""),
  };
}

const gitStatus = () => call("bash", { command: "git status" });
const userGateLines = (list: string[]) => list.filter((n) => n.startsWith("userGate:"));

describe("user-gate live: a write that would break the compile never lands", () => {
  it("the value editor refuses before a byte is written, and the old rules keep gating", async () => {
    const bytesBefore = file();
    const genBefore = env.store.current();
    expect((await verdict(gitStatus())).blocked).toBe(false); // control: the boot allow rule

    const { res } = await write("userGate.allow[0]", { value: "nope." });
    expect(res.ok).toBe(false);
    const error = res.ok ? "" : res.error;
    expect(error).toContain("would leave approval rules that do not compile");
    // The compile error rides verbatim: the row the operator just edited is
    // told what is wrong with it, in the compiler's own words.
    expect(error).toContain(`userGate rule must be 'tool' or 'tool.param=glob', got: 'nope.'`);
    expect(error).toContain("nothing was written");

    // Nothing moved: the file's bytes, the published generation, and the rules
    // the next gated call is decided by.
    expect(file()).toBe(bytesBefore);
    expect(env.store.current()).toBe(genBefore);
    expect(userGateLines(notices)).toEqual([]);
    expect((await verdict(gitStatus())).blocked).toBe(false);
  });

  it("the list ops refuse the same candidate before a byte is written", async () => {
    const bytesBefore = file();
    const genBefore = env.store.current();
    let res: Awaited<ReturnType<typeof applyConfigListEdit>> | null = null;
    try {
      res = await withShadowEnvCleared(() =>
        applyConfigListEdit(env.core, "userGate.allow", "append", { value: "oops." }, { deps: fsDeps }),
      );
    } finally {
      // A refusal must not have touched the file even if an assertion below trips.
      expect(file()).toBe(bytesBefore);
    }
    expect(res!.ok).toBe(false);
    const error = res!.ok ? "" : res!.error;
    expect(error).toContain("would leave approval rules that do not compile");
    expect(error).toContain(`userGate rule must be 'tool' or 'tool.param=glob', got: 'oops.'`);
    expect(env.store.current()).toBe(genBefore);
    expect((await verdict(gitStatus())).blocked).toBe(false);
  });

  it("the prepare hook is the transaction's copy of that check (refused, verbatim, holder untouched)", async () => {
    // WHY THIS IS PINNED AT THE HOOK: both panel entry points pre-compile the
    // candidate block before the write and run the SAME compiler over the SAME
    // candidate the prepare hook receives, so on a gate-enabled host a
    // malformed rule is refused there and the transaction never reaches its
    // prepare pass with a bad userGate value. The refusal contract still needs
    // a pin, so the hook runs here through the real runner, over the context
    // shape the transaction builds (store, notice fan-out, live core).
    const prepare = registeredHooks().find((h) => h.keyPath === "userGate" && h.phase === "prepare");
    expect(prepare, "an enabled gate registers a prepare row").toBeDefined();
    const live = (env.core.config as Record<string, unknown>).userGate as Record<string, unknown>;
    const ctx: ConfigApplyContext = { store: env.store, notice: (text) => notices.push(text), core: env.core };
    const genBefore = env.store.current();

    const refused = await runConfigApplyHook(ctx, prepare!, live, {
      ...live,
      allow: [...(live.allow as string[]), "nope."],
    });
    expect(refused.phase).toBe("prepare");
    expect(refused.status).toBe("refused");
    expect(refused.error).toContain(`userGate rule must be 'tool' or 'tool.param=glob'`);
    expect(refused.error).toContain("'nope.'");
    // The refusal is a compile attempt, not an act: no notice, no holder swap,
    // so the rules that were in charge before the attempt still are.
    expect(userGateLines(notices)).toEqual([]);
    expect((await verdict(gitStatus())).blocked).toBe(false);

    // Control: a candidate that compiles passes the guard without acting;
    // PREPARE only proves a swap would be safe to make.
    notices = [];
    const ok = await runConfigApplyHook(ctx, prepare!, live, { ...live, deny: ["bash.cmd=rm"] });
    expect(ok.status).toBe("applied");
    expect(userGateLines(notices)).toEqual([]);
    expect(env.store.current()).toBe(genBefore);
    expect((await verdict(gitStatus())).blocked).toBe(false);
  });
});

describe("user-gate live: the swap reaches the rules the next call is decided by", () => {
  it("rewriting a rule element flips the next gated call, both directions", async () => {
    expect((await verdict(gitStatus())).blocked).toBe(false); // the boot allow rule

    const swap = await write("userGate.allow[0]", { value: "bash.cmd=ls" }, "panel-gate-a");
    expect(swap.res.ok, swap.res.ok ? "" : swap.res.error).toBe(true);
    // The rule landed in the file the next boot reads.
    expect(file()).toContain("bash.cmd=ls");
    // The element spelling has no row in the static live-class table (the table
    // names the array field, which the write gate treats as chrome), so the
    // reply claims nothing it was not granted: restart-required, while the
    // holder it does not claim has in fact moved. Under-claiming is the honest
    // direction, and the observable below is the point of the row.
    if (swap.res.ok) expect(swap.res.applied).toBe("restart-required");

    // The same call, decided again with no restart in between: `git` fell out
    // of the allow list, so it falls to `default: "ask"`, and a headless call
    // with nobody to ask is a block that says why.
    const after = await verdict(gitStatus());
    expect(after.blocked).toBe(true);
    expect(after.text).toContain("Tool call blocked");
    expect(after.text).toContain("no interactive UI to approve bash");

    const audit = userGateLines(swap.notices)[0];
    expect(audit, `the swap logged an audit line: ${JSON.stringify(swap.notices)}`).toBeDefined();
    expect(audit).toContain("userGate: approval rules recompiled");
    expect(audit).toContain("written by session panel-gate-a");
    // The summary is a shape, not a dump of the operator's patterns: one element
    // rewritten keeps the counts and says exactly that.
    expect(audit).toContain("same shape, rule contents changed");
    expect(audit).toContain("default=ask, 1 allow, 0 deny, 0 tool patterns");
    expect(audit).toContain("in-memory session grants survive the swap");
    expect(audit).not.toContain("bash.cmd=");

    // And back through the same transaction: the restored rule allows again.
    const back = await write("userGate.allow[0]", { value: "bash.cmd=git" });
    expect(back.res.ok, back.res.ok ? "" : back.res.error).toBe(true);
    expect((await verdict(gitStatus())).blocked).toBe(false);
    const backAudit = userGateLines(back.notices)[0];
    expect(backAudit).toContain("userGate: approval rules recompiled");
    // No session rode this write (a direct caller), and the line claims none.
    expect(backAudit).not.toContain("written by session");
  });

  it("a scalar rule field is attested live and reaches the gate on the next call", async () => {
    // The uncovered call: no rule matches it, so it lives or dies by
    // `userGate.default`, and there is nobody at the keyboard.
    const uptime = () => call("bash", { command: "uptime" });
    expect((await verdict(uptime())).blocked).toBe(true);

    const { res, notices } = await write("userGate.default", { value: "allow" }, "panel-gate-b");
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (res.ok) {
      expect(res.applied).toBe("live");
      expect(res.needsRestart).toBe(false);
    }
    expect((await verdict(uptime())).blocked).toBe(false);

    const audit = userGateLines(notices)[0];
    expect(audit, `the swap logged an audit line: ${JSON.stringify(notices)}`).toBeDefined();
    expect(audit).toContain("written by session panel-gate-b");
    expect(audit).toMatch(/default=ask[^(]*-> .*default=allow/);

    // Restored for the rows that follow (and the flip is visible both ways).
    const back = await write("userGate.default", { value: "ask" });
    expect(back.res.ok, back.res.ok ? "" : back.res.error).toBe(true);
    expect((await verdict(uptime())).blocked).toBe(true);
  });

  it("an in-memory session grant survives a good swap", async () => {
    // A call no rule covers: it asks, and the human grants it for the session.
    const asked: string[] = [];
    const uncovered = () =>
      call("bash", { command: "uptime" }, { answer: "allow for session", asked, sessionId: "grant-session" });
    expect((await verdict(uncovered())).blocked).toBe(false);
    expect(asked.length).toBe(1);

    // A rule write that recompiles the holder and says nothing about THIS call:
    // the grant has to outlive it, so a second identical call asks no question.
    const swap = await write("userGate.allow[0]", { value: "bash.cmd=du" });
    expect(swap.res.ok, swap.res.ok ? "" : swap.res.error).toBe(true);
    expect(userGateLines(swap.notices).length).toBe(1);
    expect((await verdict(uncovered())).blocked).toBe(false);
    expect(asked.length).toBe(1);

    // The grant is per session, not per process: another session asking the
    // same call is asked.
    const other = () =>
      call("bash", { command: "uptime" }, { answer: "allow for session", asked, sessionId: "other-session" });
    expect((await verdict(other())).blocked).toBe(false);
    expect(asked.length).toBe(2);

    const restore = await write("userGate.allow[0]", { value: "bash.cmd=git" });
    expect(restore.res.ok, restore.res.ok ? "" : restore.res.error).toBe(true);
  });

  it("the boot-only sibling field moves the root and recompiles nothing", async () => {
    // `enabled` is the one field under this root that the compiled rules do not
    // read: the boot gate owns it (toggling it mid-run is a restart decision),
    // so the row fires on the root and must act on none of it -- no recompile,
    // no audit line, no changed verdict, and no live claim in the reply.
    const blockedBefore = (await verdict(gitStatus())).blocked;
    const off = await write("userGate.enabled", { value: false });
    expect(off.res.ok, off.res.ok ? "" : off.res.error).toBe(true);
    if (off.res.ok) expect(off.res.applied).toBe("restart-required");
    expect(userGateLines(off.notices)).toEqual([]);
    expect((await verdict(gitStatus())).blocked).toBe(blockedBefore);

    const on = await write("userGate.enabled", { value: true });
    expect(on.res.ok, on.res.ok ? "" : on.res.error).toBe(true);
    expect(userGateLines(on.notices)).toEqual([]);
    expect((await verdict(gitStatus())).blocked).toBe(blockedBefore);
  });
});
