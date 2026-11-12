/**
 * tests/core/config-live/negative-pins.test.ts -- the other half of design
 * §4.5 item 1. family-probes.test.ts proves the POSITIVE doctrine: the next
 * use answers the published value. These rows pin the NEGATIVE half, the
 * promises about what a publish must NOT do mid-session:
 *
 *  1. skills: the path is live for LOOKUPS (the loader's reader), but a
 *     publish never yanks the loader out from under a running session -- the
 *     imported skill set and its dirs survive, and only an explicit re-read
 *     walks the new root (§4.3 skills row: "changing path affects future
 *     preloads + lookups that re-read"; the loaded set is next-session).
 *     And preloadSkills stays a CREATE-time act: publishing a preload list
 *     activates nothing in a live session (its loaded flags flipped at load,
 *     and un-loading or retro-loading under a session is not promised).
 *  2. prompts: `path` is loader lifecycle (fs-import = activation machinery),
 *     so it stays CREATE-PINNED both ways -- a published path change neither
 *     drops the prompts this session imported nor admits the new dir's
 *     prompts. (The displayPrompt live half is the family row.)
 *  3. workflows P8 trio: a RUNNING run keeps the limits its dispatch froze
 *     (graph stamp + WorkflowRun construction) -- turning the timeout toggle
 *     OFF mid-run cannot disarm a run that started armed; the toggle lands on
 *     the NEXT dispatch (an armed-then-off cap never kills the new run even
 *     past the cap); and a raised maxNodes lands on the NEXT validate while
 *     the already-dispatched over-cap run keeps running untouched.
 *
 * The workflow hosts run real WorkflowRuns against a parked-worker port
 * (probes.ts hangTaskPort): the only forward edge is time, so "kept its
 * start-time limits" and "never armed" are timed observations, not comments.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../../mocks/io.ts";
import { bootLiveStore, liveStoreCore } from "../../mocks/config-live.ts";
import { HOOKS } from "@core/hooks.ts";
import { ACTIONS } from "@core/commands.ts";
import { create as createSkillsExtension } from "@extensions/skills/index.ts";
import { create as createPromptsExtension } from "@extensions/prompts/index.ts";
import {
  publishKey,
  until,
  wfTool,
  workflowRunHost,
  writeWorkflowGraph,
  type FamilyCtx,
} from "./probes.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(TMP_PARENT, prefix));
}

/** A SKILL.md dir under root (description is the parse's required field). */
function skillDir(root: string, name: string): void {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\ndescription: b7 negative-pin skill ${name}\n---\nbody ${name}\n`);
}

function promptFile(root: string, name: string): void {
  writeFileSync(join(root, `${name}.prompt.md`), `---\nname: ${name}\ndescription: b7 negative-pin prompt\n---\nHello ${name} $ARGS\n`);
}

const teardownDirs: string[] = [];
function later(...dirs: string[]): void {
  teardownDirs.push(...dirs);
}

afterAll(() => {
  for (const dir of teardownDirs) rmSync(dir, { recursive: true, force: true });
});

describe("negative pins: what a live publish must NOT do mid-session (§4.3 rows, P8)", () => {
  // ── skills ───────────────────────────────────────────────────────────────

  it("skills: a path publish re-points lookups but never yanks the live loader", async () => {
    const a = tmp("b7-neg-skills-a-");
    const b = tmp("b7-neg-skills-b-");
    later(a, b);
    skillDir(a, "alpha");
    skillDir(b, "beta");
    const store = bootLiveStore({ skills: { path: a, preloadSkills: [] } });
    const ext = await createSkillsExtension(liveStoreCore(store) as never);
    const loader = (ext as unknown as {
      loader: {
        directories(): string[];
        loadedDirectories(): string[];
        allSkills(): Array<{ name: string }>;
        getSkill(n: string): unknown;
        loadSkills(): Promise<number>;
      };
    }).loader;

    expect(loader.loadedDirectories()).toEqual([a]);
    expect(loader.allSkills().map((s) => s.name)).toEqual(["alpha"]);

    publishKey(store, "skills.path", { value: b });

    // The A half (§4.3 skills row): lookups resolve the CURRENT path.
    expect(loader.directories()).toEqual([b]);
    // The negative half: what this session IMPORTED stays intact -- a
    // published path change does not un-load skills under a running session
    // (next-session doctrine; the loaded set belongs to the dirs it came from).
    expect(loader.loadedDirectories()).toEqual([a]);
    expect(loader.allSkills().map((s) => s.name)).toEqual(["alpha"]);
    expect(loader.getSkill("alpha")).not.toBeNull();
    expect(loader.getSkill("beta")).toBeNull();

    // "affects future preloads + lookups that re-read": an explicit re-read
    // walks the new root (and keeps what was already loaded -- merge, not yank).
    expect(await loader.loadSkills()).toBe(1);
    expect(loader.loadedDirectories()).toEqual([b]);
    expect(loader.allSkills().map((s) => s.name)).toEqual(["alpha", "beta"]);
  });

  it("skills.preloadSkills stays a create-time act: a publish activates nothing mid-session", async () => {
    const a = tmp("b7-neg-preload-");
    later(a);
    skillDir(a, "alpha");
    const store = bootLiveStore({ skills: { path: a, preloadSkills: [] } });
    const ext = await createSkillsExtension(liveStoreCore(store) as never);
    const loader = (ext as unknown as {
      loader: { getSkill(n: string): { loaded: boolean } | null; activateSkill(n: string): void };
    }).loader;

    expect(loader.getSkill("alpha")!.loaded).toBe(false); // control: create-time list was empty

    publishKey(store, "skills.preloadSkills", { value: ["alpha"] });

    // The loaded flag flips AT LOAD; a published preload list reaches the
    // NEXT session -- nothing retro-activates here (an explicit activate --
    // the /skill command's act -- still works, proving the pin is about the
    // publish, not about loaded ever being true).
    expect(loader.getSkill("alpha")!.loaded).toBe(false);
    loader.activateSkill("alpha");
    expect(loader.getSkill("alpha")!.loaded).toBe(true);

    // Positive control for the create-time act itself: the same dir booted
    // WITH a preload list answers loaded at boot.
    const store2 = bootLiveStore({ skills: { path: a, preloadSkills: ["alpha"] } });
    const ext2 = await createSkillsExtension(liveStoreCore(store2) as never);
    const loader2 = (ext2 as unknown as { loader: { getSkill(n: string): { loaded: boolean } | null } }).loader;
    expect(loader2.getSkill("alpha")!.loaded).toBe(true);
  });

  // ── prompts ──────────────────────────────────────────────────────────────

  it("prompts.path is create-pinned: a publish neither yanks the imported prompts nor admits the new dir", async () => {
    const a = tmp("b7-neg-prompts-a-");
    const b = tmp("b7-neg-prompts-b-");
    later(a, b);
    promptFile(a, "hello");
    promptFile(b, "later");
    const store = bootLiveStore({ prompts: { path: a, displayPrompt: true } });
    const ext = await createPromptsExtension(liveStoreCore(store) as never);
    const cmds: Record<string, { handler?: (a: unknown, v: string | null) => Promise<Record<string, unknown>> }> = {};
    await ext.hooks![HOOKS.COMMANDS_REGISTER]!({
      registry: { register: (name: string, def: unknown) => (cmds[name] = def as never), getAll: () => [] },
      agent: {},
    } as never);
    const run = (v: string) => cmds["prompt"]!.handler!({}, v);

    // Control: the imported prompt executes.
    const control = await run("prompt:hello world");
    expect((control.action as number) & ACTIONS.PROMPT).not.toBe(0);

    publishKey(store, "prompts.path", { value: b });

    // Not yanked: hello still executes through the SAME loader.
    const after = await run("prompt:hello world");
    expect((after.action as number) & ACTIONS.PROMPT).not.toBe(0);
    expect(String(after.content)).toContain("Hello hello");
    // Not repointed: the new dir's prompt stays UNKNOWN mid-session (the fs
    // import list is activation machinery; admitting it would mean swapping
    // templates a conversation may be quoting -- next-session per §4.3).
    const unknown = await run("prompt:later");
    expect((unknown.action as number) & ACTIONS.ERROR).not.toBe(0);
    expect(String(unknown.error)).toContain("Unknown prompt: later");
    // The listing is create-pinned with the loader.
    expect(
      (ext as unknown as { getAllPrompts(): Array<{ name: string }> }).getAllPrompts().map((p) => p.name),
    ).toEqual(["hello"]);
  });

  // ── workflows P8 trio ────────────────────────────────────────────────────

  /** The extension's in-process run registry (ManagedRun shape, as far as
   *  these pins need it; the engine's WorkflowRun is typed structurally). */
  interface ManagedRunView {
    runId: string;
    finished: { outcome: string } | null;
    error: string | null;
    run: {
      status(): Array<{ id: string; state: string; detail: string | null }>;
      cancel(): void;
    };
  }
  const runsOf = (ctx: FamilyCtx): { all(): ManagedRunView[] } =>
    (ctx.host.ext as unknown as { runs: { all(): ManagedRunView[] } }).runs;

  async function dispatchAndRegister(ctx: FamilyCtx, file: string): Promise<ManagedRunView> {
    const res = await wfTool(ctx, "workflow_dispatch").execute({ file });
    expect(res.error).toBeNull();
    const runs = runsOf(ctx).all();
    return runs[runs.length - 1]!;
  }

  async function settleCancel(ctx: FamilyCtx): Promise<void> {
    for (const m of runsOf(ctx).all()) {
      if (m.finished || m.error) continue;
      m.run.cancel();
      await until(() => !!m.finished || !!m.error, `run ${m.runId} settle after cancel`, 3000).catch(() => {});
    }
  }

  it(
    "P8: an enableRuntimeTimeouts publish cannot reach the RUNNING run -- it keeps its armed cap",
    async () => {
      const ctx = await workflowRunHost({ maxRuntimeMins: 0.03, enableRuntimeTimeouts: true }); // 1800ms cap
      try {
        writeWorkflowGraph(ctx.host.dir as string, "b7hang1");
        const m = await dispatchAndRegister(ctx, "b7hang1");

        publishKey(ctx.store, "workflows.enableRuntimeTimeouts", { value: false });
        // The live value is OFF now. The dispatched run froze TRUE at
        // construction (the engine's constructor is the freeze), so its 1800ms
        // deadline is still armed and MUST kill: a run reading the live toggle
        // would hang forever here.
        await until(() => !!m.finished || !!m.error, "the armed running run to hit its frozen cap", 6000);
        expect(m.error).toBeNull();
        expect(m.finished!.outcome).toBe("failed");
        const node = m.run.status().find((n) => n.id === "a")!;
        expect(node.state).toBe("failed");
        expect(String(node.detail)).toContain("max_runtime exceeded");
      } finally {
        await settleCancel(ctx);
        rmSync(ctx.host.dir as string, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "enableRuntimeTimeouts lands on the NEXT dispatch: an off publish disarms new runs past the same cap",
    async () => {
      const ctx = await workflowRunHost({ maxRuntimeMins: 0.03, enableRuntimeTimeouts: true });
      try {
        publishKey(ctx.store, "workflows.enableRuntimeTimeouts", { value: false });
        writeWorkflowGraph(ctx.host.dir as string, "b7hang2");
        const m = await dispatchAndRegister(ctx, "b7hang2");

        // 2600ms > the 1800ms cap. The published OFF value landed at this
        // dispatch, so every kill point is dormant (bank-only accounting):
        // if the publish had NOT landed -- or the run could be reached
        // mid-flight -- the node would be failed by now.
        await new Promise((r) => setTimeout(r, 2600));
        expect(m.finished).toBeNull();
        expect(m.error).toBeNull();
        const node = m.run.status().find((n) => n.id === "a")!;
        expect(node.state).toBe("running");
      } finally {
        await settleCancel(ctx);
        rmSync(ctx.host.dir as string, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "a raised maxNodes lands on the NEXT validate while the dispatched over-cap run keeps running untouched",
    async () => {
      const ctx = await workflowRunHost({ maxNodes: 2, enableRuntimeTimeouts: false });
      try {
        writeWorkflowGraph(ctx.host.dir as string, "b7three", 3);
        const validate = wfTool(ctx, "workflow_validate");

        const before = await validate.execute({ file: "b7three" });
        expect(String(before.output)).toContain("exceeds soft cap"); // control: over the boot cap

        const m = await dispatchAndRegister(ctx, "b7three"); // soft cap warns; the hard ceiling rules

        publishKey(ctx.store, "workflows.maxNodes", { value: 9 });

        // The raise lands on the next validate (the same code path dispatch
        // parses through: readKnob(limits) at the call).
        const after = await validate.execute({ file: "b7three" });
        expect(String(after.output)).not.toContain("exceeds soft cap");
        expect(String(after.output)).toContain("valid: b7three");

        // P8: the already-dispatched run carries the stamp its parse took
        // (workflow.limits) and is NOT retroactively re-validated, re-gated,
        // or disturbed by the publish -- still live, worker still hanging.
        await until(
          () => m.run.status().find((n) => n.id === "a")!.state === "running",
          "node a of the over-cap run to be mid-turn",
          3000,
        );
        expect(m.finished).toBeNull();
        expect(m.error).toBeNull();
        expect(m.run.status().find((n) => n.id === "a")!.state).toBe("running");
      } finally {
        await settleCancel(ctx);
        rmSync(ctx.host.dir as string, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
