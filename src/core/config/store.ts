/**
 * ConfigStore -- the single owner of the process's resolved config.
 *
 * The boot pipeline (buildConfig via main.ts) stays as-is; its output is
 * ADOPTED here, and `core.config` / `core.resolved` become accessors that
 * answer from whatever generation this store holds. B1 is behavior-neutral:
 * boot adopts (twice -- createCore's config bag, then main.ts's
 * resolved-adopt), nobody calls swap() yet, and current() answers exactly
 * what the plain core properties answered before. The notify-pass machinery
 * above the atom (live.ts's onConfigChange, the apply hooks, the write
 * transaction) arrives in later batches; this file ships the generation atom
 * and the publish mechanics only.
 */
// ---------------------------------------------------------------------------
// THE CONFIG-LIVE EXEMPTION TABLE (design §4.3's X / P / D / H inventory plus
// the §5.4 owner ruling), written up IN the code as one table.
//
// What it answers: "why does this key still not move, and which contract line
// says so?" Every survey row the inventory marked X (exempt), P<n> (a §3.4
// physical ceiling), D (already live byte-identically) or H (config-as-
// side-effect, §3.3) appears here -- the pending owner-gated rows (B8) and the
// shipped ones alike -- so each key's class and the pin guarding it is stated
// once in the tree instead of scattered across batch notes. The A rows that
// DID migrate are listed too (marked with their batch), because "it is live
// now, and here is the class of live" belongs next to the exemptions.
//
// Codes (§4.3 conventions): X = exempt | P1..P10 = the §3.4 physical ceiling
// with that number | D = live byte-identically today | H = needs/uses an apply
// hook (§3.3) | A = read at use | P (no number) = the §4.2 per-build pin.
//
// Cites are section numbers of the contract,
// ~/.cache/hotdog/workflows/runs/20261110-config-live-design-2/config-live-
// design.md. The enforcement trio lives beside this table:
//   tests/core/config-live/probes.ts -- one liveness probe per migrated key
//   tests/core/config-live/no-stale-capture.test.ts -- no create/build-scope
//     copy survives in a migrated file (allow-list carries the justified ones)
//   tests/core/config-live/hook-honesty.test.ts -- every registered apply hook
//     is watched by at least one probe
// ---------------------------------------------------------------------------
//   key(s)                                 | class          | one-line reason                                    | contract cite       
//   ---------------------------------------+----------------+----------------------------------------------------+---------------------
//   extensionPaths, extensionAutoload,     | X / P1         | loading, hooking and un-loading extension CODE is  | §4.3, §3.4 P1, §5.4 
//   extensions, services                   |                | its own analysis; live-apply here is a             | (ruled)             
//                                          |                | hot-(un)load program, not a config mechanism       |                     
//   every <ext>.enabled                    | X / P1         | false-at-boot means the extension does not EXIST;  | §4.3, §5.4          
//   (coreTools.enabled, loop.enabled,      |                | no live off->true is ever promised, on->off is a   |                     
//   compaction.enabled,                    |                | freebie only where a per-use gate already re-reads |                     
//   handoffTool.enabled, ...)              |                |                                                    |                     
//   mcpServers[].*                         | X / P1         | process spawn/kill + tool registration lifecycle   | §4.3, §5.4          
//                                          |                | (the P1 twin)                                      |                     
//   mcpClient connect/close timeouts (mcp- | X / P1         | they resolve INTO live connections; the reconnect  | §4.3 row            
//   client/index.ts:45-52)                 |                | lifecycle IS activation machinery, not a value a   |                     
//                                          |                | socket re-reads                                    |                     
//   modelSwitch.toolEnabled                | X / P1-adj.    | TOOLS_REGISTER boot gate: flipping a registered    | §4.3 row            
//                                          |                | tool on/off mid-run is registration lifecycle, not |                     
//                                          |                | a config read                                      |                     
//   toolExecConfig.coreTools snapshot +    | X (E1) / P3    | a spawned runner never boots config; the snapshot  | §4.3 core-tools row,
//   workers/tool-exec.ts wire scalars      |                | is pinned per pool entry -- a write changes NEW    | B6a (E1)            
//                                          |                | entries only                                       |                     
//   execFence (file key)                   | P3             | an in-flight runner keeps its kernel fence; live   | §5.2 row            
//                                          |                | for NEW pool entries only, and the per-session     |                     
//                                          |                | /fence toggle stays the mid-run control            |                     
//   bashTool.env                           | DANGER + pool- | a subprocess env map is a code-execution channel   | §5.4 (ruled         
//                                          | pinned         | (PATH/LD_PRELOAD/NODE_OPTIONS shaping every next   | 2026-11-10)         
//                                          |                | exec); boot-snapshotted, values never echoed       |                     
//   webui.host                             | X / P2         | rebind is mechanical, but it silently relocates a  | §3.4 P2, §5.4       
//                                          |                | cleartext credential surface across a network      |                     
//                                          |                | boundary mid-run; restart keeps the decision       |                     
//                                          |                | conscious                                          |                     
//   Bun.serve maxPayloadLength             | P4             | fixed at serve construction, no setter; picked up  | §3.4 P4             
//   (frameBound)                           |                | at any rebind (webui.port's H row, B8)             |                     
//   taskLanesDir + websocket turnLanes     | X / P7 (+P9)   | the cross-process lane ledger: swapping dirs mid-  | §3.4 P7, §4.3 row   
//   caps/dir (server.ts:105-112)           |                | run orphans live slots and double-books against    |                     
//                                          |                | the old ledger                                     |                     
//   TaskManager ctor options               | X / P9         | built once per host; the scheduler/lanes/options   | §3.4 P9, §4.3 row   
//   (session/index.ts:557-571):            |                | have no reconfigure surface today (its health-     |                     
//   taskProfile, taskLanesPerProvider,     |                | timer half IS an H row and shipped B4)             |                     
//   probe provider list, + its frozen      |                |                                                    |                     
//   chatTimeout/maxRetries copies          |                |                                                    |                     
//   noLog, reindex, sessionId,             | X / P6         | boot-repair/resume flags + boot-time default-      | §3.4 P6, §4.3 row   
//   defaultSubcommand (main.ts:409-410)    |                | subcommand dispatch: no coherent mid-run meaning.  |                     
//                                          |                | sessionId's file entry is inert bytes (cli-layer-  |                     
//                                          |                | only) -- ruling open, see sessionid-tombstone-memo |                     
//   theme, colors, thinkerFormat,          | X / P10        | no-daemon-consumer (survey Pattern E): the webui   | §3.4 P10, §4.3      
//   toolCallDisplayFormat, toolOutputFmt   |                | renders none of them and CLI hosts are per-        |                     
//   (+ ui-interactive-cli renderer keys)   |                | process, so there is nothing to restart INTO and   |                     
//                                          |                | nothing live to watch                              |                     
//   P8 in-flight-turn semantics            | X / P8         | a turn that already decided is never retro-        | §3.4 P8             
//   (dispatched workflow runs, armed       |                | decided; per-use reads apply from the NEXT         |                     
//   question timers, a loop's running lap, |                | read/dispatch/build (each pinned in its own suite) |                     
//   already-gated tool calls)              |                |                                                    |                     
//   workspace.paths / workspace.deny /     | P (P5) + §5    | live for NEW agent builds, pinned into a running   | §4.3, §5.2, §4.4    
//   legacy cwdBoundary / workspaceRoot     | (B8)           | agent's overlay -- moving them mid-turn moves the  |                     
//                                          |                | trust boundary (the P5 probe shipped in B5)        |                     
//   sandboxMode / maxToolDifficulty /      | P (P5)         | same build-pin: the loop-exec gate reads the ctor  | §4.3, §4.2 invariant
//   defaultMaxToolDifficulty               |                | field, so a running agent's posture cannot flip    |                     
//                                          |                | under it                                           |                     
//   maxIterations                          | P + next-      | the loop reads the ctor field; a config write      | §4.3 row            
//                                          | session        | moves NEW agents only (no per-iteration live read  |                     
//                                          |                | is promised); the TaskManager copy is P9           |                     
//   hideTools / hideThinking /             | P (next-       | per-build ctor fields fed from LIVE resolved (the  | §4.3 row            
//   showTokenUse                           | session)       | cli tiers keep winning through the §4.2 chain); an |                     
//                                          |                | in-flight agent keeps its field value              |                     
//   agent-factory.ts:81 bag copy           | §4.2 (B5,      | the DEFAULT store-backed path became a live Proxy; | §4.2; lint allow-   
//                                          | shipped)       | hosts passing explicit                             | list entry          
//                                          |                | options.config/options.resolved stay PINNED BY     |                     
//                                          |                | CONSTRUCTION -- the surviving spread is exactly    |                     
//                                          |                | that pinned copy                                   |                     
//   main.ts core.config shallow copy +     | §1.2 (B1,      | boot bags are adopted into the store; the          | §1.2, §4.3 row      
//   :384 resolved attach                   | shipped)       | accessors ARE the migration                        |                     
//   uploadLimits (upload-limits.ts:10,     | D              | the reference pattern: every send-path read        | §4.3 row            
//   handlers-send.ts:28)                   |                | already resolves per request; stays byte-identical |                     
//   fileAttachment.maxFileSize /           | mirrors D (+P4 | a pure alias layer resolved THROUGH the root       | §4.3 row            
//   maxImageSize / maxFiles (deprecated    | rest)          | uploadLimits resolution -- no independent consumer |                     
//   alias)                                 |                | to migrate; the frameBound-capped remainder rides  |                     
//                                          |                | port rebind                                        |                     
//   sharedLlmClient fields + LlmClient     | H (B4,         | IN-PLACE public-field reassignment on the ONE      | §3.3, §4.3 row      
//   ctor (baseUrl/aiUrl, apiKey,           | shipped)       | object all three holders keep; per-request reads   |                     
//   chatTimeout, healthCheckTimeout,       |                | honor it (a rebuild stays rejected)                |                     
//   streamIdleTimeout, maxRetries,         |                |                                                    |                     
//   modelWireFormat, modelRoleMapping)     |                |                                                    |                     
//   hookTrace                              | H (B4,         | trivial reassign -- the boot reassign's live twin  | §3.3, §4.3 row      
//                                          | shipped)       |                                                    |                     
//   websocket.sessionTimeoutMin            | H (B4,         | re-arms the already-idempotent cleanup loop; the   | §3.3, §4.3 row      
//                                          | shipped)       | eviction lands on the next 60s tick                |                     
//   providerHealthCheckIntervalSecs        | H (B4,         | setIntervalSecs stop+recreate (0 disables;         | §3.3, §4.3 row      
//                                          | shipped)       | failure-driven demotion untouched); its observable |                     
//                                          |                | is the RE-ARM, probed through the timer write      |                     
//   websocket.questionTimeoutSecs /        | A (B3,         | resolved at question-ARMED time; an in-flight      | §4.3 row            
//   questionStrategy                       | shipped)       | question keeps its armed timer (P8's benign twin,  |                     
//                                          |                | pinned both ways)                                  |                     
//   toolExecResolved posture strip         | A (B3,         | the registry holds a reader over the live resolved | §4.3 row            
//   (websocket/server.ts:118)              | shipped)       | plane per payload -- honestly live, static-bag     |                     
//                                          |                | pins intact                                        |                     
//   compaction block + the deleted         | A (B3,         | per-run reads (runSettings derives the effective   | §4.3 row            
//   contextLimit ??= boot mutator          | shipped)       | window per run); the config bag stays byte-        |                     
//                                          |                | untouched (§1.5)                                   |                     
//   contextLimit (registry-wide + agent    | A / D (B3/B5,  | compaction resolves the window per run (row        | §4.3 contextLimit   
//   build reads; per-model overrides)      | shipped)       | above); agent-factory reads resolved.contextLimit  | row                 
//                                          |                | per build; the modelRegistry is the carried mutable|                     
//                                          |                | identity -- re-resolve keeps it (B4 probes pin the |                     
//                                          |                | carry-forward), so there is no copy to migrate     |                     
//   toolCallRepair.maxRepairsPerTurn       | A (B3,         | per-turn read through the live block               | §4.3 row            
//                                          | shipped)       |                                                    |                     
//   modelGroups (scheduler placement +     | A (B3/B7,      | a READER over the live CONFIG bag per              | §4.3 row, B3, B7    
//   workflow group refs)                   | shipped)       | placement/resolution -- the captured-map hot-ref   |                     
//                                          |                | problem is gone. Config bag, NOT resolved:         |                     
//                                          |                | modelGroups has no resolved slot (code wins over   |                     
//                                          |                | prose)                                             |                     
//   systemPromptTemplate / profilesPath +  | next-session / | the template's FILE TEXT is re-read by each re-    | §4.3 row            
//   profiles scan                          | D              | resolve and the factory reads the profile map per  |                     
//                                          |                | build (B3); the boot scan itself is machinery      |                     
//   defaultModel / defaultProvider /       | next-session   | re-resolve recomputes the active provider +        | §4.3 row            
//   provider                               |                | resolved model; reaches new agents/builds/clients  |                     
//                                          |                | only (the runtime /model path keeps its own        |                     
//                                          |                | doctrine)                                          |                     
//   envScrubbing                           | A (B6a,        | SPAWN-TIME read of resolved.envScrubbing (inline:  | §4.3 + §5.2 rows +  
//                                          | shipped)       | next exec; pool: new entries). SUPERSEDED: no      | override            
//                                          |                | longer cli-layer-only -- the owner override        |                     
//                                          |                | 2026-11-11 added a config layer (cli falsy >       |                     
//                                          |                | config > default true), shipped 32cd4a07 /         |                     
//                                          |                | 3f1d87ee                                           |                     
//   envScrub.extra                         | A (B6a,        | extra scrub keys re-read at spawn (values never    | §4.3, §5.2          
//                                          | shipped)       | echoed)                                            |                     
//   coreTools readToolLimit / maxImageSize | A (B6a,        | the read/grep/find/edit tools read their block     | §4.3 core-tools row  
//   / findMaxResults / grepMaxResults /    |                | per execute; enabled stays X/P1 above              |                     
//   maxEditInputSize                       |                |                                                    |                     
//   bashTool.bashTimeoutMs / maxTimeoutMs  | A + P5 (B6a,   | per execute (one live read shared by the spawn);   | §4.3 bash-tool row   
//                                          | shipped)       | the requested timeoutMs still clamps at the live   |                     
//                                          |                | max, the scrub posture reads at spawn              |                     
//   fetchTool.maxBodyLength / fetchTimeout | A (B6b,        | per-request scalars; the posture pair has its own  | §4.3 fetch-tool row  
//   Ms / maxImageSize                      |                | ruled row below                                    |                     
//   webSearch.provider / maxResults /      | A (B6b,        | per-search reads beside the secrets row; the cap   | §4.3 web-search row  
//   timeout                                |                | clamp rides the READ, not a stored field           |                     
//   handoffTool.autoIncludeFilesUnderBytes | A (B6b,        | per-handoff read                                   | §4.3 handoff row     
//   loopDetect.repeatThreshold /           | A (B6b,        | thresholds read per turn; the window length is     | §4.3 loop-detect row 
//   pingPongThreshold                      |                | DERIVED at use (no cached window)                  |                     
//   loop.maxLoops                          | A (B6b,        | read at every TURN_END check; the running lap      | §4.3 loop row + P8   
//                                          | shipped)       | finishes under the cap its count was scored on     |                     
//   skills.path (consumers)                | A (B7,         | the loader holds a path READER, so listings and    | §4.3 skills row      
//                                          | shipped)       | re-reads answer the current generation; a          |                     
//                                          |                | publish that UNSETS path falls back to the boot    |                     
//                                          |                | value (a bad write cannot zero a running loader)   |                     
//   skills.preloadSkills + the boot fs     | next-session   | preload is a create-time import act (a skill's     | §4.3 skills row      
//   import; the legacy top-level           |                | loaded flag flips at load); "Not X: skills are     |                     
//   skillsPath passthrough                 |                | data, no code loading"; the passthrough feeds      |                     
//                                          |                | the same path-layer chain (rescue.ts names it)     |                     
//   prompts.displayPrompt                  | A (B7,         | knob per prompt execution (a plain-boolean host    | §4.3 prompts row     
//                                          | shipped)       | keeps its pinned answer)                           |                     
//   prompts.path (+ deprecated             | next-session   | the loader's fs-import list is activation          | §4.3 prompts row     
//   promptsPath compat and its warn)       |                | machinery; repointing it mid-session would         |                     
//                                          |                | un-load templates a conversation may quote         |                     
//   agentsMd.autoload                      | A (B7,         | read per SYSTEM_PROMPT_BUILD; live both            | §4.3 agents-md row   
//                                          | shipped)       | directions from the NEXT rebuild (P8: an           |                     
//                                          |                | in-flight request carries the prompt it was        |                     
//                                          |                | built with)                                        |                     
//   workflows.maxNodes / maxRuntimeMins    | A (B7,         | limits resolve at validate/dispatch; a run keeps   | §4.3 workflows row   
//                                          | shipped)       | the stamp its parse took + WorkflowRun's           |                     
//                                          |                | construction freeze (P8)                           |                     
//   workflows.enableRuntimeTimeouts        | A (B7,         | read at DISPATCH -- the toggle's own doc says      | §4.3 row + timeout-  
//                                          | shipped)       | dispatch, and engine.ts now says the same          | toggle doc           
//   workflows.path / runsRoot              | A (B7,         | per lookup: the availability scanner re-roots      | §4.3 workflows row   
//                                          |                | each prompt build; existing runs carry their own   |                     
//                                          |                | runDir; the boot durability scan stays boot        |                     
//                                          |                | machinery (ONE read at activation)                 |                     
//   fetchTool.allowedSchemes /             | A + §5 audit   | RULED LIVE 2026-11-10 with the §5.3 audit floor -- | §5.2, §5.4 ruling   
//   allowPrivateHosts                      | (B6b, shipped) | the §5.4 exception list names bashTool.env, NOT    |                     
//                                          |                | these; vectors stay explicit (file: = local read;  |                     
//                                          |                | private = link-local/metadata class)               |                     
//   webSearch.braveApiKey / tavilyApiKey / | A + §5 audit   | per-search reads incl. secrets; redaction doctrine | §5.2, §5.3          
//   searxngInstanceUrl                     | (B6b, shipped) | unchanged -- change lines name HOST and            |                     
//                                          |                | set/unset/changed only                             |                     
//   webui.port                             | H (B8) + P4    | rebind with a downtime notice; the P4 frame cap is | §3.3, §5.2          
//                                          |                | picked up at the rebind                            |                     
//   webui.apiKey / sessionTokenTtlMin /    | H (B8) + §5    | auth-middleware REBUILD over the carried AuthState | §3.3, §5.2, §9 tests
//   trustedProxy (+ auth.ts middleware     |                | (issued tokens live to their stamped expiresAt,    | 4/4b                
//   ctor)                                  |                | throttle buckets survive); prepare refuses         |                     
//                                          |                | malformed trustedProxy and a blank key             |                     
//   userGate.allow / deny / default        | H (B8) + §5    | prepare-recompile: bad rules refused pre-swap,     | §3.3, §5.2, §9 test 
//                                          |                | grant state survives, boot fail-closed unchanged;  | 4                   
//                                          |                | the highest-value audit line in §5.2               |                     
//   providers[].url / providers[].apiKey   | H (B4 half, B8 | the shared-client re-point shipped in B4; the      | §3.3, §5.2          
//   (+ root baseUrl/apiKey; + models)      | rest) + §5     | modelRegistry refresh and the writeOnly secret     |                     
//                                          |                | replace are the owner-gated B8 half; providers[].  |                     
//                                          |                | models rides the carried registry identity (new    |                     
//                                          |                | values reach builds through re-resolve -- the      |                     
//                                          |                | B4 probe pins the carry-forward itself)            |                     
//   sttTarget / sttUrl / sttModel          | H (B8) + §5    | rebuild the STT target; an endpoint change is      | §3.3, §5.2          
//                                          |                | always audited                                     |                     
//   toolExec (worker <-> inline plane)     | H (B8) + P5    | live for NEW agent builds; the pool drains via     | §3.3, §5.2          
//                                          |                | idle-reap/SESSION_END, the posture-strip label     |                     
//                                          |                | honest per-session                                 |                     
//   modelSwitch.commandEnabled             | OPEN (not      | the row says A per-build and COMMANDS_REGISTER     | §4.3 row; no batch  
//                                          | exempt)        | does fire per build -- but model-                  | yet                 
//                                          |                | switch/index.ts:41 still captures the block at     |                     
//                                          |                | create(). No batch claimed it (B7's sites are      |                     
//                                          |                | skills/prompts/agentsMd/workflows), so it is       |                     
//                                          |                | flagged here rather than silently exempt           |                     
//
// The §5.4 exception list (owner ACCEPTED exactly as proposed 2026-11-10) is
// the authority for the rows marked "(ruled)". The panel honors it
// mechanically: everything outside a ruled-live row keeps replying
// applied: "restart-required" (§5.1), so no batch in this train changes a
// trust-boundary answer by accident. The §7.1 attestation table
// (extensions/websocket/handlers-config.ts, LIVE_APPLIED_KEYS) is deliberately
// NARROWER than this list: it claims "live" only for the hook-backed keys B4
// wired, so a per-use-read key still answers restart-required -- an under-
// claim B9's server-side needsRestart derivation replaces, not a guess here.
import { reactiveState, type Atom } from "@utils/reactive-state.ts";
import type { CoreConfigWithExtensions } from "./schema-loader.ts";
import type { ResolvedConfig } from "../extensions/types.ts";

/** One complete view of the running config. Built wholesale by boot or by a
 *  re-resolve, then treated as read data (the two documented mutable
 *  identities -- resolved.modelRegistry and intentional live references --
 *  ride the bag, see design §1.5). */
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
   *  THROWS once anything has published (§1.6): a mid-process adopt would
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
   *  applying (attaching the degraded list, §3.2 clearing rule included) and
   *  fires the atom exactly once after the apply hooks run. Throws if a
   *  commit is already pending: publishes serialize, a second publisher
   *  fails loudly instead of interleaving notify passes. */
  swap(next: {
    config: CoreConfigWithExtensions;
    resolved: ResolvedConfig;
  }): (degraded?: Array<{ keyPath: string; why: string }>) => ConfigGeneration;
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
 *  Exported (B4): the write transaction needs the SAME diff BEFORE the swap
 *  to prefix-match prepare hooks (§2.4); swap() recomputes it verbatim, so
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
      // §1.6 assert (mirrors swap()'s pendingCommit guard): adopt is legal
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
