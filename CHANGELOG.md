# Changelog

## Unreleased

- add medium reasoning level support
- `/loop` - now keyed by session id, supports multi-agent sessions

- internals
  - split internal message format from wire formats
  - split the tool->model wire format (ToolFormat) and the LLM provider protocol (LlmProtocol) out of the llm-client
  - fetch util bugfix - remove default content-type json header

- llm-client
  - health check (`ping`) now accepts a model name to check a specific provider, instead of only the default base url
  - no auto-retry on 3xx status

- subagents
  - fix tool registration issue
  - remove noop complete_task tool
  - fix task result routing to the delegating session (instead of whatever session was created last)

- security
  - expand env var filter for child process secret scrubbing (bash/mcp-client)
  - fetch tool - fix redirect SSRF bypass (redirect targets are now re-validated)

**Full Changelog**: https://github.com/devoidfury/hotdog/compare/v0.4.1...main

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
- [BRK] remove pager tool (it was never used, never reached for, just dead weight)
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
