# Changelog

## Unreleased

- tools - bash output truncation is now announced where it can still change behavior: a cut result carries `truncated="true"` on its XML result element (the key was already in the format's short-meta attribute set, used by find/grep/read), instead of the fact living only in a `--- [truncated, N more lines] ---` marker after the 600 kept lines. Applies to both cuts: the line cap (`maxToolOutputLines`) and the 1 MB in-memory buffer cap
- approvals - `user-gate` is back as a **tool-call** approval layer, above the spawn boundary the deleted sandbox gate lived at. Opt-in (`userGate.enabled` defaults false -- with `default: "ask"` an on-by-default gate would prompt every user on every call): one `HOOKS.TOOL_CALL` handler decides continue / block, either directly from `allow`/`deny` rules or by asking through the existing question-tool input seam (`allow once` / `allow for session` / `deny`, one question at a time process-wide, deny the default answer). Grammar is `tool` or `tool.param=glob` -- `bash.cmd=git`, `edit.paths=src`, `fetch.url=https://docs.example.com/*` -- and path values reuse `Workspace`'s own rule matcher (`workspace.deny` dialect, no second glob language), matched against the absolute AND the workspace-relative path. Precedence deny > allow > `default`, and a deny never prompts and cannot be overridden mid-run. `default` is `ask` (interactive), `allow` (deny-list style; deliberately does NOT rescue unrecognized tools, so a newly connected MCP server inherits nothing) or `deny` -- allowlist-only, where nothing prompts, unrecognized tools and unanalyzable bash deny too, and a blocked call's text carries the exact `allow` line that would have matched. That last one is the only shape usable with nobody at the keyboard: on `-p`/CI there is no prompt seam, so `ask` blocks everything by design and `deny` plus an allow list is the working configuration (hazard to accept: the tool surface grows after startup -- MCP servers, `delegate_task`, `model` -- so a list that was complete at boot goes stale, and under `deny` that is a dead call rather than a question). Unrecognized tools always ask unless an allow entry names them, so MCP tools need saying yes to once rather than passing silently. Bash commands are segmented on `;`/`&&`/`||`/`|`/newline with `cd` retargeting later segments, and the analysis **bails to an ask** on anything that could hide an effect: `$(...)`, backticks, `${}`/`$VAR`, parens, brace expansion, unquoted globs, here-documents, `xargs`, `eval`, `env`, `find -exec`/`-delete`, and inline-code interpreters (`sh -c`, `python -c`, `node -e`, `awk`...). Fail-closed like the gate it replaces -- no seam, non-interactive UI, throwing prompt, aborted run or empty answer all block, with the reason and the exact config line that would have allowed it; a malformed rule is a startup error and keeps every call blocked until fixed. **What it does NOT stop**: nothing enforced. Approvals see the call, never the running command, and the bash analysis is triage with quoting tricks available to anyone motivated -- a determined model gets misread. Kernel enforcement remains `bashTool.sandbox`, which is independent (approvals apply in `sandbox: "off"` too, and the fence applies with approvals off). Nothing is written to config from a prompt; a session allow is in-memory only, keyed on the tool plus every extracted value
- sysbox - `fence` now denies the **network** as well as the filesystem. The ruleset handles every net right the running Landlock ABI knows with zero allow rules, so TCP `bind`/`connect` (ABI v4, kernels ~6.7+) and UDP `bind`/`connect_send` (ABI v10) fail `EACCES` kernel-side instead of being a syscall-table question. `hotdog info` prints the posture (`net: tcp bind+connect denied +udp` here, `net: unhandled` below ABI 4). The bit numbers are pinned by behavior probes, not doc trust: the plan expected the UDP pair at bits 8/9 and this ABI-10 kernel has them at 2/3 (a wrong bit `EINVAL`s the ruleset, i.e. a refused spawn). Abstract unix sockets and signals (ABI v6 scope rights) stay unhandled, so they are not covered; `static` mode still restricts no network
- sysbox - `fence` reads the `$PATH` dirs too. The read-only allowlist was the system dirs (`/usr`, `/etc`, ...) only, so a toolchain installed outside them (bun in `~/.bun/bin`) was unreadable inside the fence and every sandboxed command invoking it got `EACCES`. Ceiling: whatever an absolute `PATH` entry points at becomes readable, so an entry onto a broad dir (`$HOME` itself) widens the fence's read surface to match
- sysbox - every sandboxed spawn (`static` and `fence`) now runs in a per-spawn cgroup v2 with `pids.max` (512) and `memory.max` (half host RAM, clamped to [512 MiB, 4 GiB], swap off) where the host delegates a writable subtree: fork bombs fail with `EAGAIN` instead of eating the host's pid table, and a memory hog takes an in-cgroup OOM kill instead of host swap thrash. An in-cgroup OOM is reported instead of a bare dead exit code -- the bash tool appends `sandbox memory limit reached ... (cgroup memory.max = ..., oom_kill = ...)`. Hosting dir is found by walking UP from our own cgroup, because on systemd hosts our own cgroup is a member-occupied leaf scope where the kernel's "no internal processes" rule means children can never get limit files (probing only our own cgroup reported "unavailable" on every systemd machine). Delegation is per-controller, so a pids-only host gets fork containment only. Disk-filling is NOT contained, and in `static` the cage is advisory (no path visibility to stop a `cgroup.procs` write); `off` gets no cgroup
- sysbox - **removed** the `gate` mode, its USER_NOTIF supervisor (`sup.ts`), the userspace path reconstructor (`procfs.ts`), the policy oracle (`policy.ts`), the `sandbox:gate` hook and the `user-gate` approval extension, with their four test suites (~2,000 src + ~1,900 test lines). Six review rounds each turned up another bypass class -- legacy syscall twins (`creat`/`truncate`/`link`), the `sendmsg` fd-number carve-out, `openat2`, alias-laundered `..` -- and the failure modes were the worst available kind: a dead supervisor froze the command, and closing the notify fd released every frozen task with `ENOSYS`. Consequences, said plainly: `bashTool.sandbox` is now `off | static | fence`; nothing has path visibility at the syscall boundary any more, so `workspace.deny` binds nothing under bash (`cat .env` succeeds in every mode; the file tools still bind it), there is no `execve` audit log, and at Yama `ptrace_scope` 0 an ancestor's `/proc/<pid>/{mem,fd,...}` is reachable again. Post-mortem, the kernel facts it cost, and where the two policy surfaces are supposed to go instead (static: the mount view; dynamic: approvals above the spawn boundary) -- `docs/agents/sandbox-direction.md`

- sysbox - `gate` mode no longer allows `sendmsg` through for the supervisor handshake. The filter had a carve-out permitting `sendmsg` when its first argument equalled the helper's control-socket fd NUMBER, and an fd number is not a capability: a sandboxed command closes the fds it inherited, reallocates that number with a socket of its own (`close` + `socket`, no `connect` needed), and sends. Measured -- one UDP datagram egressed through a real gate spawn whose decider denied every notification. `sendmsg` is now trapped unconditionally: the helper `write()`s the notify-fd number to the control socket and the supervisor imports the fd itself with `pidfd_open`/`pidfd_getfd`, after checking the connecting peer's uid (`SO_PEERCRED`); the control socket (`SOCK_CLOEXEC`) and the listener (kernel-set `O_CLOEXEC`) are both gone from the sandboxed command. Only `bashTool.sandbox: "gate"` was affected
- sysbox - the gate capability probe now does a real parent->child `pidfd_getfd` round trip in addition to the listener install probe: where an outer seccomp policy ERRNOes 438 (hotdog sandboxed inside hotdog), `gate` reports unavailable at startup with a reason instead of hanging in the handshake
- docs - corrected two false claims (`docs/sysbox-sandbox.md`, `docs/config-reference.md`): the sendmsg carve-out's "post-exec reuse cannot occur", and the parent-memory ceiling, which is Yama `ptrace_scope` 0 / no-Yama rather than "<= 1" (scope 1 denies descendant->ancestor; `open("/proc/<parent>/mem")` measured `EACCES`)
- sysbox - `gate` denies the controlling terminal (`/dev/tty`, `/dev/console`) outright in both open classes instead of treating it as an out-of-root ask. `bash -c` opens `/dev/tty` with `O_RDWR|O_NONBLOCK` on every startup, so on a host where `/bin/sh` is bash (CI's dash never does it) EVERY sandboxed command raised one approval prompt -- and the first `SANDBOX_GATE` payload was the terminal rather than the path under test, which is how six gate integration tests were failing on a developer laptop. The open is one the kernel denies anyway: the spawn is detached, hence its own session leader with no controlling terminal, so the deny now answers `ENXIO` (`EACCES` for the root-owned `/dev/console`) -- what the command would have seen unsandboxed. Reads of `/dev/tty` were also free through the fence's `/dev` mirror; they deny now. Only `bashTool.sandbox: "gate"` was affected

- internals
  - tool-executor - `toolCtx` is now built (and `AGENT_TOOL_CONTEXT` fires) BEFORE the `TOOL_CALL` gate pipeline, and the gate payload carries `toolCtx`. Reason: `toolCtx.get("input")` -> `InputInterface.collectAnswers/isInteractive` is the one route from an extension to the human, so a gate handler that needs to ask must not have to invent a parallel prompt service. Context handlers only mount services on `toolCtx`/`agent` today, so the reorder is behaviour-neutral; pinned by a test. The websocket server correspondingly sets `input` on every tool call rather than only for `question`

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.8.0...main

# [v0.8.0] - 2026-09-06

Added `utils/jsx` to hook into [bun's jsx support](https://bun.com/docs/runtime/jsx) as a react-like jsx view layer for the UI, and then refactored most of the webui to use that. There's also a bunch of little QoL things and bug fixes in this release.

- llm-client - retries now honor a server `Retry-After` header (delta-seconds and HTTP-date forms, capped at 60s) instead of the fixed exponential backoff; absent or malformed headers fall back to the existing ladder
- llm-client - error responses are now read up to the 200K cap but quoted in the LlmError message up to 2K (with a `[truncated]` marker), so a broken endpoint returning a full HTML page no longer dumps hundreds of KB into the sink, logs, and retry lines
- agent - `run()` is now guarded against re-entrancy: a second overlapping `run()` throws `AgentError.AlreadyRunning` instead of silently interleaving loop state (iteration count, abort controller, stream replay buffers)
- tool-executor - "Tool 'x' is not available for this agent" now suggests near-matching tools from the set the model was offered (case/separator differences first, then prefix/substring near-matches), so a misspelled or case-flipped tool name self-corrects in one retry
- cli - unknown flags are now fatal (exit 1) with a "Did you mean" suggestion when a registered flag is a near-match, instead of a warning that let the run proceed with the flag silently dropped
- session - a throwing channel event handler is now logged at debug level instead of being swallowed silently; other handlers still run
- package - minimum bun bumped to 1.3.1 (the `--only-failures` flag used by the test scripts landed in 1.3.1)

- internals
  - webui - rewrote in jsx
  - marker mangler - compiled escape/unescape regexes are now built once per name pair instead of rebuilt per protected prefix on every escape() call
  - cleanup session - remove unused SessionManager.deserialize and related unused serialize/deserialize hooks
  - task-manager - drop unsafe last-set bus fallback
  - task-manager - release the finished task's Agent reference from the registry when a task reaches a terminal state (completed/failed/cancelled); previously dead tasks pinned their full agent context for the manager's lifetime, an unbounded leak on long-lived hosts like the webui
  - tool-utils - remove legacy parseToolArgs (its invalid-JSON `{input: ...}` fallback was a footgun); subagents now use parseToolInput like every other tool

- CLI colors now honor the NO_COLOR environment convention and TERM=dumb: color output is disabled regardless of config when either is present

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.7.3...v0.8.0

[v0.7.3] - 2026-09-01

This release includes some security fixes for grep/find, expands the default workspace path denylist to include cloud creds, and other improvements.

- find/grep tool - fix argument injection in the fd path: a model-supplied pattern starting with - was parsed as an fd flag (e.g. --exec=rm made fd run rm on every file found, recursively). Same issue with grep/rg. Dash-leading patterns now route to the find fallback, whose -name/-path consume the pattern as a literal, and the positional slot is additionally guarded with a -- separator.
- workspace denylist defaults expanded with cloud/credential directories: `.aws`, `.azure`, `.docker`, `.gnupg`, `.kube` (alongside `.ssh`, `.config`, `.git`). Projects that legitimately keep a directory of one of these names inside a workspace root can carve it out via `workspace.deny` (rules are last-match-wins, so `!.aws` after the positive rule disables it, or configure the exact rule set you want)
- fetch tool SSRF blocklist now refuses Teredo (`2001:0000::/32`) alongside the existing 6to4/NAT64 refusal -- a Teredo packet carries an unchecked (XOR-obfuscated) IPv4 destination; adjacent `2001::` allocations such as provider space (`2001:4860::/32`) and documentation (`2001:db8::/32`) are unaffected
- websocket/webui: renaming a session now sets a display title instead of changing the session's profile; the profile keeps driving behavior (role, tools, model) and is still switched via the profile switcher. Titles are in-memory only and are dropped when a session is rebuilt from a cold log or the server restarts
- ui-session-review-cli - sessions delete subcommand now validates sessionId before confirmation gate
- handoff-tool: listed handoff files that exist and are under the new `handoffTool.autoIncludeFilesUnderBytes` config (default 24KB) are now auto-inlined into the handoff message instead of just listed; oversized, binary, missing, and directory entries are listed with a note (size, `binary`, `not found`, `directory`, or `path rejected`)

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.7.2...v0.7.3

## [v0.7.2] - 2026-08-30

I've been wanting this feature for a while and took a few tries at it - this is the first implementation I'm happy with so it's worth cutting a release.

- ui-interactive-cli: clipboard paste detection and support in the interactive session (bracketed paste mode)
  - does not auto-submit on paste; pasted content appears inline as a numbered `[Paste #N - M lines]` marker in the input line.
  - one backspace, or the Delete key with the cursor on the marker, deletes the whole paste.
  - paste answers in question prompts are normalized the same way and should work the same.

- internal code cleanup, config resolution system consolidated

- removed action dependencies from CI test/coverage runner

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.7.1...v0.7.2

## [v0.7.1] - 2026-08-30

- mcp-client fix regression in http, incorrect DI
- internals code cleanup

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.7.0...v0.7.1

## [v0.7.0] - 2026-08-29

- requirements
  - minimum bun version bumped to 1.2

- [BRK] the placeholder `qwen3.5-0.8b` default model is gone -- when nothing in the model resolution chain (CLI `--model`, profile, env, config `default_model`, provider models) supplies a model, agent creation now fails with a `No model configured` configuration error instead of silently using a bogus model; model-free subcommands (`profiles`, `sessions`, `info`, `show-prompt`) keep working with an incomplete config
  - fix - the `HOTDOG_MODEL`/`AI_MODEL` env layers of the `defaultModel` schema were dead for the final resolved model (only the raw config value reached `resolveModel`); they are honored now

- llm-client
  - `chatStreamCancellable` now cancels the response body when the consumer abandons the stream (cancellation or early return), so the connection is released instead of lingering
  - fix - streaming no longer sees stale provider state: SSE parsing now receives the provider-resolved `baseUrl`/`apiKey`/session id instead of the raw client-level fallbacks, so protocols that read those values while streaming work with per-provider settings
  - `maxRetries: 0` now means exactly one attempt with no retries, instead of falling back to the configured default

- config
  - the previously hardcoded fallback context window is now the `contextLimit` core config key (default `128000`) -- it feeds the model registry fallback, the agent, and compaction, so small-context local models can lower the base limit from `defaults.json`; compaction can override it per-extension via `compaction.contextLimit`
  - **behavior change** -- `extensionAutoload` now defaults to `true` (was `false`); extensions on disk are loaded without being listed explicitly. Set `extensionAutoload: false` to restore the previous opt-in behavior
  - removed dead config keys that were never read: `defaultAiUrl`, `systemPromptDefaultTemplate`, `embeddingsTimeout` / `embeddingsTimeoutSecs`

- workspace
  - `.git` is now in the default deny list; workspace files inside `.git` are no longer reachable by file tools
  - fix - deny-list entries could be bypassed through symlinks that resolve outside the listed path; the resolved target is now checked as well

- mcp-client
  - new `mcpClient.httpTimeoutSecs` config (default `30`) -- bounds HTTP transport requests (connect, headers, body) so a wedged MCP HTTP server can't hang a tool call indefinitely; invalid values fall back to the default, never to "no timeout"
  - per-stream in-memory accumulation is now capped (2M chars) for stdio and HTTP transports; a chatty or hostile server can no longer exhaust memory, and truncated oversized lines are drained (not dispatched) to keep framing aligned

- fetch tool
  - default `maxBodyLength` raised from `8000` to `20000`

- file-attachment
  - fails closed (attachment rejected) when a workspace boundary check throws, instead of propagating the error

- internals
  - the tool-call hook pipeline now fails the call with an error when a hook errors, instead of swallowing the error and continuing
  - tool defs are resolved once per batch of parallel tool calls, not once per call (faster multi-tool turns)

- performance
  - read tool - fewer redundant disk reads for the same functionality
  - grep tool - the native fallback binary detection no longer reads whole file into memory

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.6.0...v0.7.0

## [v0.6.0] - 2026-08-27

- [BRK] the `"builtins"` magic string for extension paths is no longer accepted and now fails startup with a config error -- use the `@extensions` path alias instead

- workspace
  - multi-root workspace support: new `workspace.paths` config (array of directories; entries may be relative, `~`-expanded, or globs). Relative tool paths resolve against the first root; absolute paths must fall inside one of the configured roots. The roots are surfaced in the system prompt environment chunk when more than one is configured
  - **Notice for existing configs** -- legacy `cwdBoundary` / `workspaceRoot` keys are still honored (as a single root) when `workspace.paths` is absent, but their handling changed: they are now validated at startup, so a value pointing at a nonexistent path fails startup with a config error instead of degrading at runtime, and `~` / glob expansion is now applied to their values as well
  - fix - `project_info` path was not bounded by the workspace boundary; it now is, and escaping paths are rejected

- llm-client / tool-executor
  - `maxRetries` now means retries *after* the initial attempt (total attempts = `1 + maxRetries`); previously the value was the total number of attempts, so `maxRetries: 3` gave 1 + 2 rather than 1 + 3

- mcp-client
  - tool names no longer use `server/tool` as the `/` may be rejected by some APIs. Tools now register as `server__tool` with characters outside `[a-zA-Z0-9_-]` sanitized
  - tool registry now rejects names outside `[a-zA-Z0-9_-]` at registration, so a bad name fails fast instead of failing every LLM request

- bash tool
  - model-requested `timeoutMs` is now sanitized and clamped: invalid values (zero, negative, non-numeric) fall back to the configured default, and valid values are capped by the new `bashTool.maxTimeoutMs` config (default `600000`)

- fetch tool
  - transient failures (timeout, abort, network) are now only auto-retried for GET/HEAD; other methods resolve as a plain error so a dropped POST/PUT/PATCH is not re-executed against a third-party endpoint

- websocket
  - unauthenticated sockets can no longer join the broadcast group until authenticated (defense in depth for extensions that upgrade without a token)
  - profile switch now also switches the model when the profile specifies one, and rebuilds the cached system prompt and tool defs; session metadata reports the active model

- static file server
  - fix - sibling directories sharing a prefix with the root (e.g. `/srv/app2` under root `/srv/app`) no longer pass the path containment check

- render templates
  - fix - left-dash whitespace control (`{%-`) now actually strips the whitespace before the token

- explore tool
  - fix - the spawned sub-agent used outdated `-c` instead of `-p` flag
  - marked `sideEffects: true` (it spawns an agent process)

- sessions
  - fix - images duplicated on every save/load round-trip; content is now persisted raw and legacy sessions with inlined image parts are healed on load

- info CLI
  - fix - `info --config-debug`

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.5.0...v0.6.0

## [v0.5.0] - 2026-08-26

- add string-length tool
- add medium reasoning level support
- `/loop` - now keyed by session id, supports multi-agent sessions
- fix - tab completion for the `/reasoning` level argument
- fix - environment system prompt chunk referenced the wrong profile name
- bash tool - set `EDITOR=cat` in child process env to prevent hangs in some programs

- internals
  - split internal message format from wire formats
  - split the tool->model wire format (ToolFormat) and the LLM provider protocol (LlmProtocol) out of the llm-client
  - fetch util bugfix - remove default content-type json header
  - move token estimation (chars/4 heuristic) out of the compaction extension into `utils/token-estimate.ts`
  - hook system - dedupe trace logging into a single helper (notifyHooks + runHookPipeline)
  - fix - `retryWithBackoff` with `maxRetries: 0` made zero attempts
  - fix - tool registry logged "unknown" instead of the tool name when a tool's `toToolDef()` threw
  - fix - `switchSession` emitted `session:swap` with the switch target as both old and new agent; oldAgent is now the previously active agent
  - compaction - fix - abort listener leaked on the agent's long-lived signal; now removed after each summarization call

- llm-client
  - health check (`ping`) now accepts a model name to check a specific provider, instead of only the default base url
  - fix - health check (`ping`) now times out; configurable via `healthCheckTimeoutSecs`
  - LLM HTTP error bodies are now capped at 200k chars before being embedded into error messages
  - retry classification reads a structured `LlmError.status` instead of parsing the error message

- fetch tool
  - response read cap raised 100k -> 2mb; display truncation now runs after cleanup / md conversion, so verbose HTML isn't cut before it can shrink

- mcp-client
  - stdio servers now run detached; process group is killed on destroy (no orphaned processes)

- subagents
  - fix tool registration issue
  - remove noop complete_task tool
  - fix task result routing to the delegating session (instead of whatever session was created last)

- security
  - expand env var filter for child process secret scrubbing (bash/mcp-client)
  - fetch tool - fix redirect SSRF bypass (redirect targets are now re-validated)

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.4.1...v0.5.0

## [v0.4.1] - 2026-08-19

This is mostly a bug fixes and security hardening release.

- webui - interactive question tool support
- edit tool - support empty replacement string / deletion
- edit tool - fix - when using space-stripped fallback, the starting index to replace is now correct so lines aren't duplicated or cut off mid-line.
- explore tool - inherit and respect workspace/cwd boundary
- fetch tool - add configurable scheme filter, and disallow private addresses by default (SSRF filtering)
- tool executor now actually enforces tool filters. Previously these were just filtered from system prompt/tools param, but technically if the LLM was guided into calling a tool it couldn't see, it could do so if it guessed the syntax exactly right.
- compaction - no longer orphans tool results without tool call
- handoff tool - tighten up inlined ctx, remove system prompt chunk
- fix - reject path traversal in profile/aspect names
- webui/websocket - default bind to localhost instead of 0.0.0.0, warn when publicly accessible
- mcp-client - hide inherited env secrets from stdio mcp

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.4.0...v0.4.1

## [v0.4.0] - 2026-08-17

It's been a couple weeks since I cut a release, figure it's about time. The focus here has been around code cleanup, improving robustness, security, and QoL features.

- [BRK] renamed TokenTracker fields for clarity
- [BRK] improve /compaction syntax (see README.md or `--help`)
- [BRK] remove pager tool (used exactly once, by a model that did not believe it existed)
- add HOTDOG_MODEL, AI_MODEL, HOTDOG_API_KEY envvars for config
- fix some issues with profile loading & switching
- webui - add profile switching
- webui - markdown streaming formatting improvements
- webui - brute force hardening, rate-limit login endpoint
- websocket - stricter auth gate on ws lib backend
- refactor - drop duplicate configuration fallbacks and fail harder to uncover actual problems faster
- bash tool - kill whole process tree on timeout, not just shell
- bash tool - filter out sensitive env vars to reduce secrets exposure
- skills - fix - now mid-session loaded skills properly list files & resources section
- harden path resolution / path escape prevention for filesystem-related tools, default workspace boundary to cwd
- file-attachment no longer triggers in the middle of email addresses
- internals - add short import path aliases (`@core/`, `@utils/`, `@extensions/`, `@package.json`)
- html-to-md (fetch) - strip unsafe images and links
- use unified fetch wrapper everywhere, consistently use user agent string with hotdog version
- fix - rebuild system prompt when model changes
- subagents - fix result double-appended

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.6...v0.4.0

## [v0.3.6] - 2026-08-02

- interactive cli - added tab completions for slash commands, \@file-attachments, and shell mode.
- shell mode - better command foregrounding; color support
- shell mode - can now send the command & results to the agent by using the suffix `| @`.
  May include an optional note after that, for example `bun run test | @ review the failing tests.`
- better error output in logs

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.5...v0.3.6

## [v0.3.5] - 2026-07-31

- new extension: file-attachment - picks up on @file-include syntax in direct user input to automatically include files into the context.
- fixes in configuration system where missing values were silently dropped in favor of defaults; most noticeably in compaction context limit.
- `/model` switch now validates the target model and prints an error if not found.
- shortened handoff system prompt chunk.
- agents-md - added clear instructions to read docs before edits in system prompt chunk.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.4...v0.3.5

## [v0.3.4] - 2026-07-29

- add `fetchModels` option to provider config to automatically load model list from backend if supported (llama-swap tested)
- add maxToolCallsPerIteration to prevent runaway tool call storm
- webui: hide empty chat messages, eg during rapid tool calls
- md-to-html / webui: better handling of escape sequences like `\\`
- html-to-md / fetch: strip data: images which can be very long
- add transient / agent retry-able with hint error types
- fix: slash commands arguments no longer always lowercased
- more fixes and code cleanup

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.3...v0.3.4

## [v0.3.3] - 2026-07-26

- All tools now require a `sideEffects: bool` definition to indicate if they have any capacity for destruction, RCE, or exfil.
- Added `--sandbox` mode, which disables all tools with sideEffects.
- Added tool `difficulty: number (1-5)` indicating which tools are easier/harder to use, which can be used for automatically hiding more complex tools from smaller models that they would struggle with by setting a `max-tool-difficulty`/`maxToolDifficulty` on the model configuration.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.2...v0.3.3

## [v0.3.2] - 2026-07-24

- add "handoff" tool allowing the assistant to prepare a context, then start fresh on that in a new context window, as an alternative technique to compaction
- webui - add cold session history viewing/resuming
- webui - session switching and reload resume bug fixes
- fix - avoid mangling system prompt message
- core tool `write` rework into simpler tools that are easier for current llms to understand and use -> `overwrite` & `append`
- tool definitions cleaned up, base system prompt reduced ~5k -> 3.5k

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.1...v0.3.2

## [v0.3.1] - 2026-07-21

- add utils/md-parser, one-shot and streaming md->ast->html transforms
- webui - render md into better-looking html
- reworked internals between agent and ui, add SessionManager, Channels

Dev Notes: The webui is really coming along, but at the same time it's still rough. Particularly buggy around switching sessions - I want to lock down the state handling there next, then add cold session loading to it, profile switching, session forking, and settings management.

cli feels fairly solid to me in the current shape, although you can't do a whole lot while it's streaming. I am experimenting with wrapping stdout in another stream to keep the input prompt below the streaming output but it's super experimental right now and not solid enough to ship. I'll keep playing with it but this will unlock easy multi-agent switching and then we can open up autocomplete.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.3.0...v0.3.1

## [v0.3.0] - 2026-07-19

**Breaking Changes**

- rename prompt shorthand `-c` flag to `-p` to mirror most other tools
- rename `hotdog review` subcommand to `hotdog sessions show`

**Other Changes**

- add `sessions delete <id>`
- add `sessions cleanup [n-days: default 30]`
- internal code cleanup and type updates

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.2.1...v0.3.0

## [v0.2.1] - 2026-07-18

- grep - fix "No matches found" when path is a specific single file.
- add `/loop Some prompt here` command
- code cleanup and type improvements

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.2.0...v0.2.1

## [v0.2.0] - 2026-07-15

- Ported the codebase from JS->TS -- still some rough edges to iron out but mostly looking good.
- question tool - fixed it to prompt now instead of skip with an error
- bash tool - add env vars to get cleaner output for 3rd party tools, easier for agent to use (`TERM=dumb,NO_COLOR=1,CI=true,AGENT=1,GIT_EDITOR=cat,GIT_TERMINAL_PROMPT=0`)
- webui - fixed issues and worked on the interface to bring it up to a basic usable point (still has some visual bugs and no cold session resume yet)
- skills - fixed loading issues
- updated configuration system to do more runtime validation
- improved test suite
- file path handling - added simple autocorrects for paths input handling for various tools that hit the filesystem

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.1.5...v0.2.0

## [v0.1.5] - 2026-07-08

- webui stability fixes
- interactive cli shell mode - added word filter list for basic common words likely to trigger a false positive such as `if` / `yes` etc

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.1.4...v0.1.5

## [v0.1.4] - 2026-07-07

- [BRK] removed old /sh command extension in favor of --shell-mode
- fixed and fleshed out output for ui-info commands
- fixed some issues around config loading
- improve llm-client sse perser to be more robust
- improved tool error handling
- improved hooks for extension development

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.1.3...v0.1.4

## [v0.1.3] - 2026-07-05

Ironed out some issues around the display in interactive cli, fixed a couple bugs like double-print user messages, too few/too many line breaks.

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.1.2...v0.1.3

## [v0.1.2] - 2026-07-05

Some bugfixes in this release; also added the config reference docs and expanded on the examples.

**model**

- fix: `/model switch` no longer incorrectly clears the message log, keeps conversation history

**fetch**

- fix: output returning [object Object] when using md
- fix: use internal html->md function instead of invoking pandoc when using md output

**web-search**

- improvement: use proper HTML parser (bun HTMLRewriter) instead of regex for ddg search

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.1.0...v0.1.2

## [v0.1.0] (aka v0.1.1) - 2026-07-03

Well, hot-dog! I guess it's about cooked.

Here's what's stable and solid:

- One-shot prompt mode (`hotdog prompt "Hey! What's the word?"`)
- Interactive cli -- simple, but works great for one interactive session. `hotdog` or `hotdog cli`
- Extension system base -- I am happy with where this is at generally and ready to build on the foundations.
- Declarative config system.
- Profiles, aspects, skills, tool calling.

Experimental stuff that may be broken:

- explore tool (disabled by default).
- websocket/webui -- this part is rough; session swapping seems broken. Cleaning these up is my main goal for 0.2.0.

Features that generally work but have rough edges:

- Compaction. Not all strategies tested; haven't explored all the potential failure modes.
- Marker mangler / io escaping pipeline needs work, customizable tokens per model/backend, different format support, converting to extension.
- Tool result formatting - should be configurable/swappable via extension system; a bit too simplistic right now; needs work with io escaping pipeline.

**Full Changelog**: https://github.com/devoidfury/hotdog/releases/tag/v0.1.0
- sysbox - follow-ups on the `gate` notify-fd handoff, from review of the above:
  - **the supervisor now verifies the fd it imported is actually a seccomp notify fd** (`isSeccompNotifyFd`, `readlink("/proc/self/fd/N")` -> `anon_inode:seccomp notify`) before answering a single syscall with it, and refuses the spawn if it is not. The `SO_PEERCRED` check proves the connecting uid, not *which of that peer's fds* it chose to name: at `ptrace_scope` 0 a same-uid process that wins the accept can hand the supervisor one of **its own** notify fds from a different sandbox, and the import succeeds -- putting hotdog's decider in front of another supervisor's frozen tasks. A non-notify fd died on `NOTIF_RECV` (`EINVAL`) by accident; a foreign *notify* fd never would have
  - **the import probe no longer blames the kernel for its own failures.** `--probe-import` exited 3 for everything, so the startup reason claimed "pidfd_getfd blocked by an outer seccomp policy" even when the real cause was a missing C compiler, an unreadable `/proc`, or a probe child that died on the way -- a misdiagnosis with no way to check it. Exit codes are now a contract (`3` only for `EPERM`/`EACCES` on a real parent->child import, `4` = probe could not run), and the helper's stderr is attached to the reason the user sees. Both codes still mean gate is unavailable; nothing is allowed that was not allowed before
  - the `--probe-import` comment claimed the child's listener link reads `anon_inode:[seccomp]`; measured here it is `anon_inode:seccomp notify`, no brackets. The substring match was always right, the stated bytes were not
  - tests: the exit-code contract and the notify-fd predicate are covered directly (the predicate pinned against a real listener fd, with pipe/regular-file/bogus-fd negatives), so neither depends on a host where `gate` happens to work
