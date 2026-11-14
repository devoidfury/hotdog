# Live config

hotdog resolves its configuration at boot and, for most settings, keeps applying it live afterward: a field edit saved from the webui settings panel persists the file and moves the running process in the same transaction, without a restart. This document describes what "live" means operationally, what happens on a write, what each family honors and when, and what still genuinely requires a restart. The per-key layer chains and every setting's schema live in [config-reference.md](config-reference.md); nothing here duplicates that table.

## Config sources and precedence

Config arrives from six layer sources: CLI flags, the config file (`defaults.json` in the resolved config directory), environment variables, the active profile, the active provider, and schema defaults. There is no single global order; each key walks its own declared chain:

- Most keys: CLI flag > config file > schema default.
- Provider-sourced keys (`aiUrl`/`apiKey`): the active provider wins first (provider > CLI > config > env > default).
- Profile-aware keys (`defaultModel` and friends): a profile layer sits inside the chain.

The config directory resolves as `--config-dir` > `HOTDOG_CONFIG_DIR` > `/etc/hotdog` > `~/.config/hotdog` > the bundled example. String values that are exactly `$VAR` or `${VAR}` interpolate from the environment at load; an unset variable is a hard config error. The full per-key precedence table, layer attestations, and file format rules: [config-reference.md](config-reference.md).

## The live store

The process owns exactly one **generation** of config at a time. A generation is a complete view: the loaded+merged config bag, the resolution chain's output, the list of top-level keys that changed at its publish, a monotonic publish counter, and any degraded-apply reports. Boot adopts its generation silently; every later change replaces it wholesale through one publish step.

`core.config` and `core.resolved` are accessors over the current generation, so a consumer that reads a property gets the current value at call time. That is the whole contract on the read side, and it shapes how code is written: consumers read at the point of use, never a copy captured at construction. A copy taken across a use boundary is frozen forever (a spread of the live agent view is a point-in-time copy by definition), which is why live families hold a reader instead of a value.

Publishing is serialized and atomic in the seams that matter: the changed-key diff is computed before anything moves, reads answer the new generation the moment it swaps, and subscribers get exactly one notify pass per publish. A reader that wakes mid-transaction sees the new values, not a half-state. The machinery: `src/core/config/store.ts` (generation atom), `src/core/config/live.ts` (keyPath-filtered subscription), `src/core/config/apply-hooks.ts` (the hook table), and the write transaction in `src/extensions/websocket/handlers-config.ts`.

### What "live" means operationally

- **The settings panel has two write paths.** A **field write** (editing one value) writes the file and, once it verifies, runs the live transaction described below; its reply attests what actually happened for that key in this process, and the row's own attestation is a "restart pending" badge, shown on rows whose save reply carried the derived `needsRestart`. A **list op** (array append/remove -- the provider add/remove controls, a gate rule "+") shares only the persist half: same validate/rollback discipline against the file, but no re-resolve, no hooks, no class -- the reply is the legacy `needsRestart: true`, and the change moves the running process at the next field write of any key (the transaction re-resolves the whole file and diffs every root) or at restart.
- **A hand edit to the file** does not touch the running process. There is no file watcher, on purpose: editor saves are transiently broken mid-write, and a second process resolves `$VAR` against a different environment, so adopting foreign bytes could inject values nobody wrote. The panel's file column re-reads the actual file on every open, so disk truth is always visible. A hand edit reaches the running process at the next panel field write (the transaction re-resolves the whole file, not just the saved key) or at the next boot, whichever comes first.
- **Restart remains the universal fallback.** Whatever a save does or does not do live, the persisted file is boot truth; restarting applies exactly what the file says.

## The write pipeline

A settings-panel field write runs one serialized transaction under the config edit lock. File truth, store truth, and the reply can never interleave with another writer. (List ops share step 2's persist machinery and stop there -- no steps 3-7.)

1. **Validate.** The value is revalidated server-side against the running unified schema (core + loaded extension schemas): types, bounds, enum sets, shape class for containers. Removed keys and keys the config file cannot affect are refused before any byte moves. Gate (`userGate.*`) writes are additionally pre-compiled here, so bad rules are refused before the file too.
2. **Persist.** A surgical edit of the original file bytes (comments and siblings survive; the write splices the exact value range), atomic temp+rename in the same directory, then a re-read and verification. Any post-write doubt rolls back to the exact pre-write bytes (or un-creates a file that did not exist) and the rollback itself is re-verified before it is claimed.
3. **Re-resolve.** The cheap half of the boot pipeline runs against the verified file: fresh load with `$VAR` interpolation, the full resolution chain, extension-block resolve/merge/validate. No network: the running model registry is carried forward into the new generation, so catalog state accumulated by the health sweep survives publishes.
4. **Prepare hooks.** Side effects that can fail hard run *before* the store moves: a throw here refuses the swap while refusal is still free. The file keeps the write; the runtime keeps the old generation; the reply says restart-required and names the reason.
5. **Publish.** The store swaps to the new generation; every accessor answers from it immediately.
6. **Apply hooks.** Side effects that rewire running machinery (timers, listeners, shared clients, compiled rule sets) run after the swap, awaited, each under its own timeout (default 2 seconds, hard cap 15). An apply hook cannot veto: a throw or timeout becomes a degraded report, and the store never re-swaps, because the store's contract is "what the persisted, verified config says."
7. **Reply.** One notify pass fires, then the reply is composed, still under the lock. It carries the attestation fields below.

## What the reply attests

Every successful field write answers with:

- **`applied`**, the class for that key: `live` (the effect is observable in this process now), `rebind` (a listen-level rebind is about to run; the notice states the cost), `next-session` (the store is swapped; new sessions, builds, and pool entries honor it, running artifacts keep theirs), or `restart-required` (persisted only). All four are produced today: `rebind` on a `webui.port` move, `next-session` on the `execFence`/`toolExec` pair, `live` on the other hook-backed rows, `restart-required` on everything else.
- **`appliedNotices`**, human one-liners riding the reply: downtime warnings, in-flight semantics, failure explanations.
- **`applyHooks`**, the per-hook ledger (`applied` / `degraded` / `refused`) for the side effects that ran.
- **`needsRestart`**, the legacy flag, derived server-side (`true` exactly when `applied` is `restart-required`), never hand-maintained.

The shipped webui panel consumes one of these: the settings row shows the restart badge on `needsRestart`. `applied`, `appliedNotices`, and `applyHooks` ride the reply as the server-to-client contract; the panel does not render the class or the notices itself -- where this document quotes a notice, that is what a raw reply carries, not what the panel prints. List-op replies are the exception to this whole section: `{ ok: true, needsRestart: true }`, nothing else.

The `live` claim is deliberately narrow: it attaches to the hook-backed keys whose effect the transaction can confirm, so a per-use-read key can answer `restart-required` while its new value in fact governs the next use. An under-claim that way is honest; a false `live` never is. The reply also demotes itself in concrete situations: the key's apply hook degraded (the old side effect still runs); the write moved nothing this key reads because a higher layer (a flag, env var, or provider entry) decides the value (the notice says a higher layer is deciding, not which one); or no live holder is registered on this host (a process not serving the webui has no webui hooks and answers its rows restart-required). And a `rebind` write whose port did not actually move demotes to `live`: nothing is rebound, the current listener stays up.

Secrets keep their posture across the whole wire: a secret-shaped path ships redacted in snapshots, its replace box is write-only, and no reply ever echoes a new secret value.

## What is live today, and how

### Per-use reads

These values resolve at the moment they are consumed, so a published change governs the **next use**: the next tool execute, request, search, turn, prompt build, or dispatch.

| Family | Keys | Read point |
|---|---|---|
| core tools | `coreTools.readToolLimit`, `maxImageSize`, `maxEditInputSize`, `grepMaxResults`, `findMaxResults` | per execute (and per tool-def render of advertised defaults) |
| bash tool | `bashTool.bashTimeoutMs`, `maxTimeoutMs` | per execute; the requested timeout clamps at the live cap |
| exec scrubbing | `envScrubbing`, `envScrub.extra` | at spawn (the resolved posture, read inline; pooled runners pin their environment at entry spawn) |
| fetch tool | `fetchTool.maxBodyLength`, `fetchTimeoutMs`, `maxImageSize`, `allowedSchemes`, `allowPrivateHosts` | per request; the redirect re-check shares the request's single read |
| web search | `webSearch.provider`, `maxResults`, `timeout`, `braveApiKey`, `tavilyApiKey`, `searxngInstanceUrl` | per search; the caps clamp at the read |
| handoff | `handoffTool.autoIncludeFilesUnderBytes` | per handoff; an invalid published value loudly refuses the next file-carrying handoff and recovers on the next valid publish |
| loop control | `loopDetect.repeatThreshold`, `pingPongThreshold`, `loop.maxLoops` | per turn / per loop check; the detection window derives from the current thresholds |
| context | the `compaction` block, `contextLimit`, `toolCallRepair.maxRepairsPerTurn` | per run / per turn |
| ask-a-question | `websocket.questionTimeoutSecs`, `questionStrategy` | at question arm; an in-flight question keeps its armed timer |
| upload limits | `uploadLimits` block | per send; each send-path read resolves the ceilings from the live generation |
| scheduling | `modelGroups` | per placement and per workflow group resolution (a reader over the live config bag) |
| skills | `skills.path` | per lookup: listings and re-reads answer the current generation; a publish that unsets the path falls back to the boot value, so a bad write cannot zero a running loader |
| prompts | `prompts.displayPrompt` | per prompt execution |
| agents file | `agentsMd.autoload` | per system-prompt rebuild, both directions from the next rebuild |
| workflows | `workflows.maxNodes`, `maxRuntimeMins`, `enableRuntimeTimeouts`, `path` | at validate/dispatch; paths per lookup, so the availability scanner re-roots each prompt build (the runs dir follows `path` as `<path>/runs`) |
| agent view | keys read through `agent.config` (e.g. `toolRetryDelay`, `maxToolResultChars`, `modelPricing`) | per read on the live agent view; an existing agent sees them without a rebuild (per-agent pins and profile writes overlay the live base) |

### Shared LLM client

One client object serves the process. An apply hook reassigns its fields in place, from the resolved chain, so every holder (the server, every new agent build, the session registry) observes the change with zero plumbing: `aiUrl` (resolved `baseUrl`), `apiKey`, `chatTimeoutSecs`, `healthCheckTimeoutSecs`, `streamIdleTimeoutSecs`, `maxRetries`, `modelWireFormat`, `modelRoleMapping`. A request already sent finishes with the body it built; the **next request attempt** reads the new fields.

### Providers list and model catalog

A `providers[<i>]` URL, key, or models **field write** has two halves, both live. The shared client's provider list is re-pointed in place (next request attempt resolves against it), and every `fetchModels` provider's model catalog is re-read and **upserted** into the carried-forward live registry -- never removals, the registry object identity is kept -- awaited under the hook timeout. A catalog that cannot be read reports degraded: the list still moved, the catalog waits for the next health sweep, and the reply's notices say so. What does NOT rebuild is the sweep's probe provider set: that stays restart-bound with the TaskManager. Provider **add/remove** is a list op: it persists, restart-bound, and joins the running list at the next field write of any key or at restart.

### Webui port and auth

A `webui.port` write rebinds the listener. The reply is composed and sent FIRST, claiming `rebind` and carrying (in its notices) the warning to expect a brief drop; only then does the listener close and re-listen on the new port. Connected sockets drop and the webui reconnects; the websocket frame-size cap, fixed per listener construction, is recomputed at the same rebind. If the new port will not bind, the old listener comes back up; either failure is logged loudly on the `[config-live]` audit trail and decorates the generation's degraded report until the next successful publish touching `webui` decides it -- the panel does not surface that report yet. A write to the same port claims no drop. A write to `0` ("any free port") is the one claim that cannot be honored: the deferred move refuses BEFORE closing anything, so the listener never blinks, and the refusal lands after the reply as the audit line and the degraded report; port `0` stays restart-bound.

`webui.apiKey`, `webui.sessionTokenTtlMin`, and `webui.trustedProxy` share one prepare+apply pair that rebuilds the auth middleware's POLICY over the carried auth state: issued session tokens live to their stamped expiry (no connected client is logged out by an auth-config write), login throttle buckets and the trusted-proxy warning flag survive, and new logins get the new key, TTL, and trust set. Prepare refuses a blank `webui.apiKey` replacement (boot would not serve without a key; neither does a live write) and a malformed `trustedProxy`, before the swap.

### Approvals gate rules

`userGate.allow`/`deny`/`default`/`tools` field writes recompile BEFORE the swap; a rule that fails to compile is refused pre-swap, so a bad live edit reaches neither fail-closed block-all nor silent allow-all. Post-swap, the gate's rules holder takes the fresh set; in-memory per-session grants survive (they are grants, not rules), a decision already in flight keeps the answer that was asked about it, and the boot fail-closed posture is unchanged for boots. The panel's write paths pre-compile gate rules before the file, on both write tails: a whole-field write and a single rule appended or removed. (A rule added or removed through the panel is a list op: pre-compiled, persisted, and folded into the running set at the next field write of any key or at restart.) A gate that is OFF at boot registers no hook: on that host these writes honestly answer restart-required.

### Speech-to-text

A `sttUrl` or `sttModel` write rebuilds the resolved speech-to-text target. When the enabled/disabled flip moves, every connected session is pushed the `sttEnabled` posture frame, so the mic affordance changes live; a dictation upload already in flight keeps the target it started with. An endpoint change is audited as host only (see below).

### Timers

- `providerHealthCheckIntervalSecs`: the sweep timer stops and recreates; `0` disables the timer. The change lands on the next interval tick, and failure-driven provider demotion is untouched either way.
- `websocket.sessionTimeoutMin`: the idle-session cleanup loop re-arms with the new age. Eviction runs on a 60-second tick, so the effect lands on the next tick.

### Hook trace and posture display

`hookTrace` flips hook tracing live (the live twin of the boot posture; the CLI/env layers still win where they apply). The webui's per-session exec-plane posture strip resolves per payload from the live generation.

### Exec fence and tool-exec plane

The `execFence` and `toolExec` file keys answer `next-session`, and the reason is physics, not machinery: a pool entry's isolation IS its spawn argv, so no hook can retro-fit a running entry. The new posture is what the next spawn gets; a warm entry whose fence no longer matches is replaced at its next invoke; the pool otherwise turns over via idle reaping and session end. The per-session `/fence` toggle stays the interactive mid-run control (runtime-only, never written to config).

### New builds only

Some values are pinned when an agent is built, on purpose: a published change reaches **new sessions/builds** and never moves a running agent. That is the trust-pin set (`workspace.paths`/`workspace.deny`, `sandboxMode`, `maxToolDifficulty`/`defaultMaxToolDifficulty`, the tool filters) plus the loop scalars frozen with the build (`maxIterations`, `maxToolCallsPerIteration`, `maxEmptyRetries`) and the display knobs (`hideTools`, `hideThinking`, `showTokenUse`). Likewise `defaultModel`/`defaultProvider`/`provider` recompute the active provider and model for new agents and builds (the runtime `/model` command keeps its own doctrine), and the activation-time acts stay activation-time: `skills.preloadSkills` and the boot skill import, `prompts.path` (a published change neither yanks imported templates nor admits the new dir), the system prompt template file (re-read on re-resolve; in-flight agents keep their build-time text), and the boot scan of the profiles directory.

## What running work keeps

A value that already took effect is never retro-decided. Concretely:

- **A running turn** carries the prompt, gates, and posture it was built with. Threshold and limit changes apply from the next read, dispatch, or build.
- **A running loop lap** finishes under the cap its count was scored on; a mid-lap `maxLoops` shrink stops at the next boundary, naming the current cap.
- **A dispatched workflow run** keeps the `maxNodes`/runtime-cap stamp its parse took and its construction freeze; the raise lands on the next validate or dispatch.
- **A running pool exec entry** keeps the kernel fence and environment snapshot it spawned with; only new pool entries honor the new posture. The fence scratch is per session, and the pool's tool set itself is fixed at the first worker-plane build (runners boot with zero extension-tree code and load exactly what their spawn's descriptor frame names), so changing which tools the pool can run is a restart.
- **A running agent's trust overlay** (workspace roots and deny list, sandbox mode, difficulty gate) is pinned per build; a config write cannot move the boundary under a live conversation.
- **An armed question** keeps its armed timer; **an in-flight tool call** keeps the gates it passed; **an in-flight dictation upload** keeps the STT target it read at start.

## Trust-boundary changes are audited

Changing a security-relevant setting mid-run never passes silently. Every audited change writes a grep-able `[config-live] <keyPath>: <redacted summary>` warning to the diagnostic log (`old -> new` where both sides print, state-form otherwise). Hook-backed changes reach further: the same summary lands on every live session's transcript as a system notice and repaints open panels (a host not serving the webui gets the log line alone, and that is the complete floor). The per-use rows print at their observation point -- the next request or search -- with no transcript push. The write's reply carries the transaction's own notes (drop warning, refuse and degraded reasons, shadow and no-holder explanations), never the audit line; a clean audited write answers with no notices at all. Values are never rendered where a value is a secret:

- `fetchTool.allowedSchemes` and `allowPrivateHosts`: live per request, with one audit line per changed vector at the next request (the first observation seeds the baseline; boot posture is not a change). Both vectors print, because both are explicit: adding `file:` opens local read; `allowPrivateHosts: true` opens the link-local/cloud-metadata class.
- `webSearch.braveApiKey`, `tavilyApiKey`, `searxngInstanceUrl`: live per search. Keys render only as set/unset/changed states; the SearXNG endpoint renders as host only. Zero key bytes in any line.
- Shared-client endpoint and credential changes (`baseUrl`/`aiUrl`, `apiKey`, and provider-list changes that move the resolved endpoint): the audit line renders the redacted host for an endpoint and "credential replaced (value not shown)" for a key.
- Webui auth changes: the credential is reported as replaced and `trustedProxy` as changed, both without value bytes; the TTL is a duration and prints. STT endpoint changes render host:port only.
- `userGate` rule swaps: the line is a shape summary (default posture + rule counts), not a dump. `execFence`/`toolExec` posture lines name the posture values and the writing session.

## When a write fails

The reply always says which failure happened; the runtime story is never left ambiguous.

- **Refusal before the file:** schema/shape validation, a removed key, a duplicate path, an unaddressable file, uncompilable gate rules. Nothing is written; the row shows the server's text.
- **Persist failure or post-write doubt:** the file rolls back to the exact pre-write bytes and the reply says so (with an explicit "restore it by hand" escalation if even the rollback cannot be verified).
- **Last-good:** if re-resolution of the written file fails (an unset `$VAR`, a validation failure), the file keeps the verified bytes, the running process keeps its current generation untouched, and the reply is restart-required with the error text in the notices. No retry machinery exists: the next successful write re-runs the chain against the whole file, or you restart with the fixed file.
- **Prepare refusal:** the risky side effect refused to rebuild (bad rules, blank webui key, malformed proxy config, a non-positive `sessionTokenTtlMin`). The file is persisted, the swap is refused, the old behavior stays exact, and the refuse reason rides verbatim in the reply's notices.
- **Degraded apply:** the new value is live in the store but its side effect failed; the *previous* side effect keeps running (the old timer age, the old client wiring). The reply answers restart-required (the row's badge follows), its notices explain which side effect failed, and the degraded report persists on the store until a later publish touches that key's prefix.

## What still requires a restart

The complete list. Anything not listed as live above answers `restart-required`, and a restart applies exactly what the file says.

**By policy (trust boundary):**

- `extensionPaths`, `extensionAutoload`, `extensions`, `services`, every `<ext>.enabled`, `mcpServers[].*` (and the MCP client connect/close timeouts, which resolve into live connections), `modelSwitch.toolEnabled` (tool registration lifecycle).
- `webui.host` (rebinding moves a cleartext credential surface across a network boundary mid-run).
- `bashTool.env` (a subprocess environment map is a code-execution channel; it is boot-snapshotted and its values are never echoed).

**By physics:**

- The exec fence and the pooled-runner environment snapshot for **running** pool entries: entries spawned after the change fence per the new posture; in-flight runners keep theirs until the entry turns over. The pool's tool set is fixed at the first worker-plane build.
- A **running agent's** pinned trust and build-frozen scalars (new builds honor the file; see "New builds only").
- The websocket frame-size cap, fixed at listener construction (the send-path upload limits themselves read per send; the cap rides the next `webui.port` rebind or restart).
- `webui.port: 0` -- "any free port" needs a fresh listener and is never a rebind target.
- The cross-process task-lane ledger: `taskLanesDir` and the websocket turn-lane directory/caps (swapping dirs mid-run orphans live slots).
- TaskManager-wide options: `taskProfile`, `taskLanesPerProvider`, and the health-probe provider set (built once per host).
- Boot/resume flags: `sessionId`, `reindex`, `noLog`, `defaultSubcommand` (no coherent mid-run meaning).
- The logger's own posture: `logLevel`, `logTarget` (read from the file before the config layer loads).
- CLI-host display keys (`theme`, `colors`, `thinkerFormat`, `toolCallDisplayFormat`, `toolOutputFmt`, the interactive-CLI renderer keys): the daemon has no consumer of them, and CLI hosts are per-process by definition.
- `modelSwitch.commandEnabled`: the commands-registration seam reads the block the extension captured at creation, so it does not move live; treat it as restart-bound.
