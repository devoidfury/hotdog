
# Extensions system

I want to update the core to be a modular system via events and hooks, and then move as much as possible out of core into extensions.

## Extensions goals
- should each have their own config key in config json
- modify the behavior of the core with hooks
- can provide tools (lsp, mcp, fetch, grep)
- can provide functionality (eg compaction should be moved to an extension)
- need to have a way to explicitly hot reload extensions/tools in a running session
- can be a UI, eg a webserver or rpc or tui
- can read the whole resolved config object

## Why?

Keep the core clean and minimal, and fully tested. It should be rock solid. Features can be built as extensions, contained instead of creeping out and blending together, as well as making it possible to easily configure totally differently behaving agent harness setups and allowing end users to customize their own clients.

## What I'm envisioning

The core should have the main sessions/agent interface, operate the main loop for agents and session serialization, and core tool calling code path -- although most of the tools themselves should be moved to extensions, as well as mcp, prompts, skills, show-prompt and review subcommands, and compaction.

