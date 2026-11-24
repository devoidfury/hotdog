/**
 * ConfigStore -- the single owner of the process's resolved config.
 *
 * The boot pipeline (buildConfig via main.ts) stays as-is; its output is
 * ADOPTED here, and `core.config` / `core.resolved` become accessors that
 * answer from whatever generation this store holds. Adoption is behavior-neutral:
 * boot adopts (twice -- createCore's config bag, then main.ts's
 * resolved-adopt), nobody calls swap() yet, and current() answers exactly
 * what the plain core properties answered before. The notify-pass machinery
 * above the atom (live.ts's onConfigChange, the apply hooks, the write
 * transaction) is separate; this file ships the generation atom
 * and the publish mechanics only.
 */
// ---------------------------------------------------------------------------
// THE CONFIG-LIVE EXEMPTION TABLE (X / P / D / H inventory), written up IN
// the code as one table.
//
// What it answers: "why does this key still not move, and which row of this
// table says so?" Every key classed X (exempt), P<n> (a physical ceiling),
// D (already live byte-identically) or H (config-as-side-effect) appears
// here -- pending and shipped alike -- so each key's class and the pin
// guarding it is stated once in the tree instead of scattered across notes.
// The A rows that DID migrate are listed too, because "it is live now, and
// here is the class of live" belongs next to the exemptions.
//
// Codes: X = exempt | P1..P10 = the physical ceiling with that number (each
// row's reason states its own) | D = live byte-identically today |
// H = needs/uses an apply hook | A = read at use | P (no number) = per-build
// pin.
//
// The enforcement trio lives beside this table:
//   tests/core/config-live/probes.ts -- one liveness probe per migrated key
//   tests/core/config-live/no-stale-capture.test.ts -- no create/build-scope
//     copy survives in a migrated file (allow-list carries the justified ones)
//   tests/core/config-live/hook-honesty.test.ts -- every registered apply hook
//     is watched by at least one probe
// ---------------------------------------------------------------------------
//   key(s)                                 | class          | one-line reason
//   ---------------------------------------+----------------+----------------------------------------------------
//   extensionPaths, extensionAutoload,     | X / P1         | loading, hooking and un-loading extension CODE is
//   extensions, services                   |                | its own analysis; live-apply here is a
//                                          |                | hot-(un)load program, not a config mechanism
//   every <ext>.enabled                    | X / P1         | false-at-boot means the extension does not EXIST;
//   (coreTools.enabled, loop.enabled,      |                | no live off->true is ever promised, on->off is a
//   compaction.enabled,                    |                | freebie only where a per-use gate already re-reads
//   handoffTool.enabled, ...)              |                |
//   mcpServers[].*                         | X / P1         | process spawn/kill + tool registration lifecycle
//                                          |                | (the P1 twin)
//   mcpClient connect/close timeouts (mcp- | X / P1         | they resolve INTO live connections; the reconnect
//   client/index.ts:45-52)                 |                | lifecycle IS activation machinery, not a value a
//                                          |                | socket re-reads
//   modelSwitch.toolEnabled                | X / P1-adj.    | TOOLS_REGISTER boot gate: flipping a registered
//                                          |                | tool on/off mid-run is registration lifecycle, not
//                                          |                | a config read
//   toolExecConfig.coreTools snapshot +    | X (E1) / P3    | a spawned runner never boots config; the snapshot
//   workers/tool-exec.ts wire scalars      |                | is pinned per pool entry -- a write changes NEW
//                                          |                | entries only
//   execFence (file key)                   | H (shipped)    | an in-flight runner keeps its kernel fence; the
//                                          |                | broker's plan-time default posture reads the LIVE
//                                          |                | store through its fence-policy reader -- writes
//                                          |                | reach NEW pool entries only (audited per change);
//                                          |                | the per-session /fence toggle stays the mid-run
//                                          |                | control (interactive, not file-key machinery)
//   bashTool.env                           | DANGER + pool- | a subprocess env map is a code-execution channel
//                                          | pinned         | (PATH/LD_PRELOAD/NODE_OPTIONS shaping every next
//                                          |                | exec); boot-snapshotted, values never echoed
//   webui.host                             | X / P2         | rebind is mechanical, but it silently relocates a
//                                          |                | cleartext credential surface across a network
//                                          |                | boundary mid-run; restart keeps the decision
//                                          |                | conscious
//   Bun.serve maxPayloadLength             | X (no setter)  | fixed at serve construction, no setter; picked
//   (frameBound)                           |                | up at EVERY rebind (the webui.port H row
//                                          |                | recomputes it from live uploadLimits)
//   taskLanesDir + websocket turnLanes     | X (dir swap)   | the cross-process lane ledger: swapping dirs mid-
//   caps/dir (server.ts:222-228)           |                | run orphans live slots and double-books against
//                                          |                | the old ledger
//   TaskManager ctor options               | X / P9         | built once per host; the scheduler/lanes/options
//   (session/index.ts:557-571):            |                | have no reconfigure surface today (its health-
//   taskProfile, taskLanesPerProvider,     |                | timer half IS an H row and shipped)
//   probe provider list, + its frozen      |                |
//   chatTimeout/maxRetries copies          |                |
//   noLog, reindex, sessionId,             | X / P6         | boot-repair/resume flags + boot-time default-
//   defaultSubcommand (main.ts:409-410)    |                | subcommand dispatch: no coherent mid-run meaning.
//                                          |                | sessionId's file entry is inert bytes (cli-layer-
//                                          |                | only)
//   theme, colors, thinkerFormat,          | X / P10        | no-daemon-consumer: the webui
//   toolCallDisplayFormat, toolOutputFmt   |                | renders none of them and CLI hosts are per-
//   (+ ui-interactive-cli renderer keys)   |                | process, so there is nothing to restart INTO and
//                                          |                | nothing live to watch
//   P8 in-flight-turn semantics            | X / P8         | a turn that already decided is never retro-
//   (dispatched workflow runs, armed       |                | decided; per-use reads apply from the NEXT
//   question timers, a loop's running lap, |                | read/dispatch/build (each pinned in its own suite)
//   already-gated tool calls)              |                |
//   workspace.paths / workspace.deny /     | P (P5)         | live for NEW agent builds, pinned into a running
//   legacy cwdBoundary / workspaceRoot     | (shipped)      | agent's overlay -- moving them mid-turn moves the
//                                          |                | trust boundary (the P5 probe shipped)
//   sandboxMode / maxToolDifficulty /      | P (P5)         | same build-pin: the loop-exec gate reads the ctor
//   defaultMaxToolDifficulty               |                | field, so a running agent's posture cannot flip
//                                          |                | under it
//   maxIterations                          | P + next-      | the loop reads the ctor field; a config write
//                                          | session        | moves NEW agents only (no per-iteration live read
//                                          |                | is promised); the TaskManager copy is P9
//   hideTools / hideThinking /             | P (next-       | per-build ctor fields fed from LIVE resolved (the
//   showTokenUse                           | session)       | cli tiers keep winning through the chain); an
//                                          |                | in-flight agent keeps its field value
//   agent-factory.ts:81 bag copy           |                | the DEFAULT store-backed path became a live Proxy;
//                                          | shipped)       | hosts passing explicit
//                                          |                | options.config/options.resolved stay PINNED BY
//                                          |                | CONSTRUCTION -- the surviving spread is exactly
//                                          |                | that pinned copy
//   main.ts core.config shallow copy +     |                | boot bags are adopted into the store; the
//   :384 resolved attach                   | shipped)       | accessors ARE the migration
//   uploadLimits (upload-limits.ts:10,     | D              | the reference pattern: every send-path read
//   handlers-send.ts:28)                   |                | already resolves per request; stays byte-identical
//   fileAttachment.maxFileSize /           | mirrors D (+P4 | a pure alias layer resolved THROUGH the root
//   maxImageSize / maxFiles (deprecated    | rest)          | uploadLimits resolution -- no independent consumer
//   alias)                                 |                | to migrate; the frameBound-capped remainder rides
//                                          |                | port rebind
//   sharedLlmClient fields + LlmClient     | H              | IN-PLACE public-field reassignment on the ONE
//   ctor (baseUrl/aiUrl, apiKey,           | shipped)       | object all three holders keep; per-request reads
//   chatTimeout, healthCheckTimeout,       |                | honor it (a rebuild stays rejected)
//   streamIdleTimeout, maxRetries,         |                |
//   modelWireFormat, modelRoleMapping)     |                |
//   hookTrace                              | H              | trivial reassign -- the boot reassign's live twin
//                                          | shipped)       |
//   websocket.sessionTimeoutMin            | H              | re-arms the already-idempotent cleanup loop; the
//                                          | shipped)       | eviction lands on the next 60s tick
//   providerHealthCheckIntervalSecs        | H              | setIntervalSecs stop+recreate (0 disables;
//                                          | shipped)       | failure-driven demotion untouched); its observable
//                                          |                | is the RE-ARM, probed through the timer write
//   websocket.questionTimeoutSecs /        | A              | resolved at question-ARMED time; an in-flight
//   questionStrategy                       | shipped)       | question keeps its armed timer (P8's benign twin,
//                                          |                | pinned both ways)
//   toolExecResolved posture strip         | A              | the registry holds a reader over the live resolved
//   (websocket/server.ts:118)              | shipped)       | plane per payload -- honestly live, static-bag
//                                          |                | pins intact
//   compaction block + the deleted         | A              | per-run reads (runSettings derives the effective
//   contextLimit ??= boot mutator          | shipped)       | window per run); the config bag stays byte-
//                                          |                | untouched
//   contextLimit (registry-wide + agent    | A / D          | compaction resolves the window per run (row
//   build reads; per-model overrides)      | shipped)       | above); agent-factory reads resolved.contextLimit
//                                          |                | per build; the modelRegistry is the carried mutable
//                                          |                | identity -- re-resolve keeps it (probes pin the
//                                          |                | carry-forward), so there is no copy to migrate
//   toolCallRepair.maxRepairsPerTurn       | A              | per-turn read through the live block
//                                          | shipped)       |
//   modelGroups (scheduler placement +     | A              | a READER over the live CONFIG bag per
//   workflow group refs)                   | shipped)       | placement/resolution -- the captured-map hot-ref
//                                          |                | problem is gone. Config bag, NOT resolved:
//                                          |                | modelGroups has no resolved slot (code wins over
//                                          |                | prose)
//   systemPromptTemplate / profilesPath +  | next-session / | the template's FILE TEXT is re-read by each re-
//   profiles scan                          | D              | resolve and the factory reads the profile map per
//                                          |                | build; the boot scan itself is machinery
//   defaultModel / defaultProvider /       | next-session   | re-resolve recomputes the active provider +
//   provider                               |                | resolved model; reaches new agents/builds/clients
//                                          |                | only (the runtime /model path keeps its own
//                                          |                | doctrine)
//   envScrubbing                           | A (shipped)    | SPAWN-TIME read of resolved.envScrubbing (inline:
//                                          |                | next exec; pool: new entries): cli falsy > config
//                                          |                | > default true
//   envScrub.extra                         | A              | extra scrub keys re-read at spawn (values never
//                                          | shipped)       | echoed)
//   coreTools readToolLimit / maxImageSize | A              | the read/grep/find/edit tools read their block
//   / findMaxResults / grepMaxResults /    |                | per execute; enabled stays X/P1 above
//   maxEditInputSize                       |                |
//   bashTool.bashTimeoutMs / maxTimeoutMs  | A + P5         | per execute (one live read shared by the spawn);
//                                          | shipped)       | the requested timeoutMs still clamps at the live
//                                          |                | max, the scrub posture reads at spawn
//   fetchTool.maxBodyLength / fetchTimeout | A              | per-request scalars; the posture pair has its own
//   Ms / maxImageSize                      |                | ruled row below
//   webSearch.provider / maxResults /      | A              | per-search reads beside the secrets row; the cap
//   timeout                                |                | clamp rides the READ, not a stored field
//   handoffTool.autoIncludeFilesUnderBytes | A              | per-handoff read
//   loopDetect.repeatThreshold /           | A              | thresholds read per turn; the window length is
//   pingPongThreshold                      |                | DERIVED at use (no cached window)
//   loop.maxLoops                          | A              | read at every TURN_END check; the running lap
//                                          | shipped)       | finishes under the cap its count was scored on
//   skills.path (consumers)                | A              | the loader holds a path READER, so listings and
//                                          | shipped)       | re-reads answer the current generation; a
//                                          |                | publish that UNSETS path falls back to the boot
//                                          |                | value (a bad write cannot zero a running loader)
//   skills.preloadSkills + the boot fs     | next-session   | preload is a create-time import act (a skill's
//   import; the legacy top-level           |                | loaded flag flips at load); "Not X: skills are
//   skillsPath passthrough                 |                | data, no code loading"; the passthrough feeds
//                                          |                | the same path-layer chain (rescue.ts names it)
//   prompts.displayPrompt                  | A              | knob per prompt execution (a plain-boolean host
//                                          | shipped)       | keeps its pinned answer)
//   prompts.path (+ deprecated             | next-session   | the loader's fs-import list is activation
//   promptsPath compat and its warn)       |                | machinery; repointing it mid-session would
//                                          |                | un-load templates a conversation may quote
//   agentsMd.autoload                      | A              | read per SYSTEM_PROMPT_BUILD; live both
//                                          | shipped)       | directions from the NEXT rebuild (P8: an
//                                          |                | in-flight request carries the prompt it was
//                                          |                | built with)
//   workflows.maxNodes / maxRuntimeMins    | A              | limits resolve at validate/dispatch; a run keeps
//                                          | shipped)       | the stamp its parse took + WorkflowRun's
//                                          |                | construction freeze (P8)
//   workflows.enableRuntimeTimeouts        | A              | read at DISPATCH -- the toggle's own doc says
//                                          | shipped)       | dispatch, and engine.ts now says the same
//   workflows.path / runsRoot              | A              | per lookup: the availability scanner re-roots
//                                          |                | each prompt build; existing runs carry their own
//                                          |                | runDir; the boot durability scan stays boot
//                                          |                | machinery (ONE read at activation)
//   fetchTool.allowedSchemes /             | A + audit      | RULED LIVE with the audit floor --
//   allowPrivateHosts                      | shipped)       | the exception list names bashTool.env, NOT
//                                          |                | these; vectors stay explicit (file: = local read;
//                                          |                | private = link-local/metadata class)
//   webSearch.braveApiKey / tavilyApiKey / | A + audit      | per-search reads incl. secrets; redaction doctrine
//   searxngInstanceUrl                     | shipped)       | unchanged -- change lines name HOST and
//                                          |                | set/unset/changed only
//   webui.port                             | H (shipped)    | rebind with a downtime notice, REPLY-FIRST; a
//                                          |                | failed rebind re-listens the old port and the
//                                          |                | degraded truth lands on the log + the next
//                                          |                | snapshot; the frame cap recomputes at every
//                                          |                | rebind (a host not serving webui has no hook
//                                          |                | and honestly answers restart-required)
//   webui.apiKey / sessionTokenTtlMin /    | H (shipped)    | auth-middleware REBUILD over the carried
//   trustedProxy (+ auth.ts middleware     |                | AuthState (issued tokens live to their stamped
//   ctor)                                  |                | expiresAt, throttle buckets + the xff once-flag
//                                          |                | survive, ONE cleanup timer); every consumer
//                                          |                | resolves the CURRENT instance per request via
//                                          |                | the authRef facade; prepare refuses malformed
//                                          |                | trustedProxy and a blank key (verbatim parse
//                                          |                | error)
//   userGate.allow / deny / default        | H (shipped)    | prepare-recompile of the CANDIDATE block (a
//   (+ userGate.tools; rule fields only)   |                | throw refuses the swap) + post-swap holder swap;
//                                          |                | grant state survives, boot fail-closed
//                                          |                | unchanged; the panel pre-compiles too (bad
//                                          |                | rules never reach the file); an approval-
//                                          |                | posture change is the highest-value audit line
//   providers[].url / providers[].apiKey   | H (shipped)    | both halves live: the shared-client re-point
//   (+ root baseUrl/apiKey; + models)      |                | and the modelRegistry refresh (upsert into the
//                                          |                | CARRIED registry, never store-swapped) + the
//                                          |                | writeOnly secret replace; endpoint lines
//                                          |                | host-only, credentials set/unset/changed only;
//                                          |                | the health-sweep PROBE LIST stays
//                                          |                | restart-bound (the hook notice says "probe
//                                          |                | set: restart-bound"); providers[].models rides
//                                          |                | the carried registry identity (the liveness
//                                          |                | probe pins the carry-forward itself)
//   sttTarget / sttUrl / sttModel          | H (shipped)    | rebuild the STT target on the live resolved bag;
//                                          |                | an endpoint change is always audited (host
//                                          |                | only); the sttEnabled flip rides the
//                                          |                | sessionState posture channel to live sessions
//                                          |                | (in-flight uploads keep the target they started
//                                          |                | with)
//   toolExec (worker <-> inline plane)     | H (shipped)    | LIVE for NEW agent builds (the per-build plane
//                                          |                | read is already live) + NEW pool entries via
//                                          |                | the fence knob; the pool drains via idle-reap/
//                                          |                | SESSION_END, the posture-strip label honest
//                                          |                | per-session; attested next-session with the
//                                          |                | "new pool entries only" audit notice
//   modelSwitch.commandEnabled             | OPEN (not      | the row says A per-build and COMMANDS_REGISTER
//                                          | exempt)        | does fire per build -- but model-
//                                          |                | switch/index.ts:41 still captures the block at
//                                          |                | create(). No batch claimed it (B7's sites are
//                                          |                | skills/prompts/agentsMd/workflows), so it is
//                                          |                | flagged here rather than silently exempt
//
// The ruling is mechanical: a key answers live ONLY where this table says so;
// everything else replies "restart-required", so no change lands a trust-
// boundary answer by accident. The attestation table
// (extensions/websocket/handlers-config.ts, LIVE_APPLIED_KEYS) is deliberately
// NARROWER than this list: it claims "live" only for hook-backed keys, so a
// per-use-read key still answers restart-required -- an under-claim, not a
// guess.
import { reactiveState, type Atom } from "@utils/reactive-state.ts";
import type { CoreConfigWithExtensions } from "./schema-loader.ts";
import type { ResolvedConfig } from "../extensions/types.ts";

/** One complete view of the running config. Built wholesale by boot or by a
 *  re-resolve, then treated as read data (the two documented mutable
 *  identities -- resolved.modelRegistry and intentional live references --
 *  ride the bag). */
export interface ConfigGeneration {
  /** Monotonic publish counter; doubles as the notify batch id.
   *  0 means "never published" (the boot generation). */
  batchId: number;
  /** The loaded+merged bag (today's core.config surface: schema defaults,
   *  file bytes, env-interpolated, extension-resolved blocks merged in). */
  config: CoreConfigWithExtensions;
  /** The resolution chain's output (today's core.resolved surface).
   *  Undefined only in the boot window between config-adopt and the
   *  main.ts resolved-adopt -- same as today's optional core.resolved. */
  resolved?: ResolvedConfig;
  /** Top-level keys whose canonical value differs from the previous
   *  generation (computed at swap time). */
  changed: string[];
  /** Durable degraded-apply reports attached at commit: a subsystem still
   *  honoring less than this generation says. Cleared by the next successful
   *  publish touching that prefix. The field ships typed in B1; the
   *  apply-hook producers are later batches. */
  degraded?: Array<{ keyPath: string; why: string }>;
}

export interface ConfigStore {
  /** The notify seam: one reactiveState atom of generations. Set only by a
   *  commit (one publish = one fire); its seed value is unreachable through
   *  current() and never observed at boot (no subscriber exists before the
   *  first live publish). */
  readonly generation: Atom<ConfigGeneration>;
  /** Property access at call time -- the stable read surface. */
  current(): ConfigGeneration;

  /** Boot adoption (createCore's config bag; main.ts's resolved-adopt goes
   *  through the core `resolved` setter's adopt). Boot adopts TWICE: an
   *  adopt REPLACES the pending generation WITHOUT firing the atom (boot
   *  fires nothing), and batchId is assigned on the first LIVE publish.
   *  THROWS once anything has published: a mid-process adopt would
   *  replace a generation with no publish. */
  adopt(config: CoreConfigWithExtensions, resolved?: ResolvedConfig): void;

  /** Prefixes currently between swap and commit -- an apply-hooks pass is in
   *  flight. A snapshot row under an applying prefix renders "applying",
   *  never a bare live value (a rebind in progress is not yet listening). */
  applying(): readonly string[];

  /** The ONLY mutation step, called by the write transaction:
   *  makes the accessors read `next` immediately, computes `changed`
   *  (top-level canonical-JSON diff against the current generation) and
   *  records it as applying prefixes; returns the one-shot commit that clears
   *  applying (attaching the degraded list, clearing rule included) and
   *  fires the atom exactly once after the apply hooks run. Throws if a
   *  commit is already pending: publishes serialize, a second publisher
   *  fails loudly instead of interleaving notify passes. */
  swap(next: {
    config: CoreConfigWithExtensions;
    resolved: ResolvedConfig;
  }): (degraded?: Array<{ keyPath: string; why: string }>) => ConfigGeneration;

  /** Attach a degraded report to the CURRENT generation WITHOUT publishing
   *  (the rebind exception): a rebind closes the socket that would
   *  carry its own receipt, so the reply goes out BEFORE the side effect and
   *  the outcome settles after the commit. Its durable truth rides this
   *  seam so the NEXT snapshot's row attestation renders it. Same clearing
   *  discipline as commit-attached reports: the next successful publish
   *  touching the prefix decides it. No-op-safe: requires an adopted
   *  generation (throws like current() before boot adopt). */
  reportDegraded(report: { keyPath: string; why: string }): void;
}

/** Canonical JSON for the changed-diff: key-sorted stringify, so a
 *  re-resolve that rebuilds a subtree with a different key order compares
 *  equal and only real value differences land in `changed`. */
function canon(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "\u0000"; // stringify(undefined) -> undefined (unset vs unset reads equal)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
    return out;
  }
  return value;
}

function bagKey(bag: object | undefined, key: string): unknown {
  return bag === undefined ? undefined : (bag as Record<string, unknown>)[key];
}

/** Top-level keys whose canonical value differs across the two bags. The
 *  two surfaces share one prefix namespace (a hook on "providers" means the
 *  root in config AND resolved), so a differing root in either bag records
 *  the key once. Computed BEFORE the swap mutates anything: a throwing
 *  compare (e.g. a cyclic value) leaves the store on the previous
 *  generation.
 *
 *  Exported: the write transaction needs the SAME diff BEFORE the swap
 *  to prefix-match prepare hooks; swap() recomputes it verbatim, so
 *  the prepare-time and commit-time views cannot drift. */
export function diffChanged(
  prev: ConfigGeneration,
  next: { config: CoreConfigWithExtensions; resolved: ResolvedConfig },
): string[] {
  const keys = new Set([
    ...Object.keys(prev.config ?? {}),
    ...Object.keys(next.config ?? {}),
    ...Object.keys((prev.resolved as object | undefined) ?? {}),
    ...Object.keys(next.resolved as object),
  ]);
  const changed: string[] = [];
  for (const key of keys) {
    if (
      canon(bagKey(prev.config, key)) !== canon(bagKey(next.config, key)) ||
      canon(bagKey(prev.resolved, key)) !== canon(bagKey(next.resolved, key))
    ) {
      changed.push(key);
    }
  }
  return changed;
}

/** Is a degraded report's prefix touched by this publish? Reports key by
 *  path ("webui.port", or "" for a global report); `changed` lists top-level
 *  roots, so a report is touched when its root is in the diff (a global
 *  report is touched by every publish). */
function publishTouches(changed: readonly string[], reportKeyPath: string): boolean {
  return reportKeyPath === "" || changed.includes(reportKeyPath.split(".")[0]!);
}

export function createConfigStore(): ConfigStore {
  // The store's own current generation: adopt() writes it silently, swap()
  // moves it, commit() only notifies. Undefined until the first boot adopt
  // (createCore adopts before the core object is observable).
  let generationNow: ConfigGeneration | undefined;
  let published = 0;
  let applyingNow: readonly string[] = [];
  let pendingCommit = false;

  // reactiveState needs a seed at construction; adopt() never sets the atom,
  // so this placeholder is unreachable through current() (the documented read
  // surface) and unobservable at boot (effects fire only on sets).
  const generationAtom = reactiveState<ConfigGeneration>({
    batchId: 0,
    config: {} as CoreConfigWithExtensions,
    changed: [],
  });

  function current(): ConfigGeneration {
    if (!generationNow) {
      throw new Error("[config-store] current() before adopt() -- the boot pipeline must adopt the config bag first");
    }
    return generationNow;
  }

  return {
    generation: generationAtom,

    current,

    adopt(config, resolved) {
      // assert (mirrors swap()'s pendingCommit guard): adopt is legal
      // ONLY in the boot window, before the first live publish. A mid-process
      // adopt would silently replace a published generation with batchId 0
      // and no notify pass -- every reader would move without a word.
      if (published > 0) {
        throw new Error("[config-store] adopt() after a publish -- boot adopts only; mid-process replacement belongs to the write transaction (swap -> commit)");
      }
      // Boot path: replace the pending generation. The atom is NEVER set
      // here -- no subscriber exists at boot, and boot fires nothing.
      // batchId 0 = never published (a post-live adopt is out of contract;
      // only the write transaction publishes after boot).
      generationNow = { batchId: 0, config, resolved, changed: [] };
    },

    applying() {
      return applyingNow;
    },

    reportDegraded(report) {
      // Post-commit attach (the rebind exception): the generation is
      // already published and the reply already sent, so this cannot ride
      // commit()'s channel -- it decorates the CURRENT generation's durable
      // degraded list the same way commit does, without a second publish.
      // The next successful publish touching the prefix clears it (the
      // commit-side publishTouches rule runs then).
      const gen = current();
      gen.degraded = [...(gen.degraded ?? []), report];
    },

    swap(next) {
      if (pendingCommit) {
        throw new Error("[config-store] swap() while a commit is pending -- publishes must serialize");
      }
      const prev = current();
      const changed = diffChanged(prev, next);
      const gen: ConfigGeneration = {
        batchId: ++published,
        config: next.config,
        resolved: next.resolved,
        changed,
        // Carry the previous degraded reports; commit re-attaches per the
        // clearing rule (a publish touching a report's prefix decides it).
        degraded: prev.degraded,
      };
      generationNow = gen; // reads see the NEW generation immediately (torn-read posture)
      applyingNow = [...changed];
      pendingCommit = true;

      let done = false;
      return (degraded) => {
        if (done) {
          throw new Error("[config-store] commit() already ran for this swap -- one notify pass per publish");
        }
        done = true;
        pendingCommit = false;
        applyingNow = [];
        const kept = (gen.degraded ?? []).filter((d) => !publishTouches(changed, d.keyPath));
        const attached = degraded ? [...kept, ...degraded] : kept;
        gen.degraded = attached.length > 0 ? attached : undefined;
        generationAtom(gen); // object sets always fire: exactly one notify pass
        return gen;
      };
    },
  };
}
