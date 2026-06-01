# Tools and Skills

## Tools

### Tool System (`src/extensions/core-tools/`)

Core tools are provided by the `core-tools` extension. Tools are registered via the `HOOKS.TOOLS_REGISTER` hook.

**Tool interface** — all tools implement: `execute(input, ctx) → result`
- `input` — JSON string or parsed object from LLM
- `ctx` — `ToolContext` with agent, isSessionRestoring, cwdBoundary, workspaceRoot
- Result can be: string, ToolResult instance, or object

**ToolRegistry** — stores tools by name, provides lookup, serialization, and `getToolDefs()` accessor. Located in `src/core/extensions/tool-registry.js`.

**Tool definition helpers** (from `src/core/extensions/tool-utils.js`):
- `toolDef(name, description, parameters)` — creates OpenAI function-calling schema
- `param(typeName, description, extra)` — creates parameter definition with JSON Schema fields (enum, min/max, etc.)
- `ToolResult` — structured result with `output`, `error`, `metadata`, `success`, `outputTag`, `toDisplay()`, `toApiContent()`
- `parseToolInput(input)` — safe argument parsing returning null on failure
- `defaultCallDisplay(input, templateFn, options)` — default display formatter for tools

**Tool descriptors** — declarative table in `src/extensions/core-tools/index.js`:
- `TOOL_DESCRIPTORS` — array of `{ name, disabled }` for all core tools
- `CORE_TOOL_NAMES` — all core tool names
- `TOOL_CONSTRUCTORS` — declarative map of tool names to constructor functions

**Disabled by default** — `ExploreTool` and `ProjectInfoTool` have `disabled: true` in their descriptors; they require explicit inclusion via profile `whitelist_tools`. Subagent tools require `manager: true` profile flag and a `taskManager`.

### Core Tool Implementations

| Tool | Description | Key Params |
|------|-------------|------------|
| `bash` | Executes shell commands via `bash -c` | `command` |
| `write` | Writes files with multi-mode support | `path`, `content` / `regex` + `content` / `files` + `atomic` |
| `read` | Reads file contents with pagination | `path`, `limit`, `offset` |
| `edit` | Edits files using replace modes | `path`, `oldString`, `newString` / `search`, `replace` / `files` + `atomic` |
| `grep` | Searches file contents for regex patterns | `pattern`, `path`, `type`, `context` |
| `find` | Glob-based file search using `fd` with `find` fallback | `pattern`, `path`, `file_type`, `max_results` |
| `fetch` | Fetches URLs via HTTP | `url`, `method`, `headers`, `body` |
| `question` | Asks interactive questions to the user | `questions` array with `key`, `prompt`, `options`, `required`, `default` |
| `pager` | Virtual pagination of truncated tool output | `tool_call_id`, `page` |
| `project_info` *(disabled)* | Gathers project information | `path` |
| `explore` *(disabled)* | Explores codebase with configurable thoroughness | `path`, `thoroughness` |

### Additional Tools (from other extensions)

| Tool | Extension | Description |
|------|-----------|-------------|
| `model` | `model-switch` | Switches to a different model mid-conversation |
| `review` | `session-review` | Lists recent sessions, gets session entries, or gets tool call index |

### Subagent Tools *(disabled by default, enabled in manager profile)*

Provided by the `subagents` extension. Only registered when `profile.manager: true` and a `taskManager` is available.

| Tool | Description |
|------|-------------|
| `delegate_task` | Spawn a background task agent |
| `task_status` | Check status of a running task |
| `task_followup` | Send follow-up to a running task |
| `task_interrupt` | Interrupt (cancel) a running task |
| `plan_status` | List recent sessions or check task status |
| `complete_task` | Mark a task as complete |
| `wait` | Model yields control back to user |

### LSP Tools (`src/extensions/lsp/`)

12 tools providing IDE-like features via external language servers. All tools require:
- `lsp.enabled: true` in config or profile
- A language server binary installed (e.g., `typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer`)
- A file with a supported extension to determine the language server

**Activation**: LSP tools are registered by the LSP extension via `HOOKS.TOOLS_REGISTER` when `lsp.enabled` is `true`.

| Tool | LSP Method | Purpose |
|------|-----------|--------|
| `lsp-hover` | `textDocument/hover` | Type info, docs at position |
| `lsp-definition` | `textDocument/definition` | Find symbol definition location |
| `lsp-completion` | `textDocument/completion` | Auto-completion suggestions |
| `lsp-signature` | `textDocument/signatureHelp` | Function parameter hints |
| `lsp-document-symbol` | `textDocument/documentSymbol` | All symbols in a document |
| `lsp-references` | `textDocument/references` | All usages of a symbol |
| `lsp-code-action` | `textDocument/codeAction` | Quick fixes, refactoring options |
| `lsp-formatting` | `textDocument/formatting` | Format entire document |
| `lsp-rename` | `textDocument/rename` | Rename symbol across project |
| `lsp-diagnostics` | `publishDiagnostics` (push) | Errors, warnings, hints |
| `lsp-workspace-symbol` | `workspace/symbol` | Search symbols across workspace |
| `lsp-apply-edit` | `workspace/applyEdit` | Apply multi-file edits atomically |

**Position encoding**: All position parameters (`line`, `character`) use LSP's UTF-16 zero-based indexing.

**LSP Client Management**: Tools use `client-cache.js` for LSP client caching per language ID. The LSP extension manages server lifecycle (spawn → initialize → shutdown) with configurable timeouts.

## Skills

### Skill System (`src/extensions/skills/`)

Skills are load-on-demand guides/workflows. They are discovered by name + description and can reference external files and scripts.

**Skill states**:
- **Unknown** (invisible to agent)
- **Available** (known, can be loaded)
- **Loaded** (body text inlined into context + additional files listed)

**Skill data** — parsed from `SKILL.md` files:
- `name` — skill identifier (matches directory name)
- `description` — human-readable description
- `license` — skill license
- `compatibility` — compatibility info
- `metadata` — additional metadata
- `allowed_tools` — array of tool names (from space-separated YAML string)
- `include_tools` — tools to include
- `tool_dependencies` — tools the skill depends on
- `visible` — whether the skill is visible to the agent
- `disable_model_invocation` — whether model invocation is disabled
- `loaded` — whether the skill is currently loaded
- `content` — markdown body
- `location` — file path
- `additional_files` — additional files referenced by the skill

**SkillsLoader** — loads SKILL.md files from directories:
- `load_skills()` — loads all skills from all configured paths
- `load_from_directory(path)` — loads from a single directory
- `parse_skill_from_md(content, dir_name)` — parses YAML frontmatter + markdown body
- `setAvailableTools(coreToolNames)` — loads skills whose tool-dependencies are met
- `all_skills()`, `get_skill(name)`, `directories()`, `activeSkills()`
- Non-existent paths are silently skipped
- Name validation: lowercase alphanumeric + hyphens only (1-64 chars, no leading/trailing hyphens, no consecutive hyphens)

**Skill loading**: Skills are loaded by the `skills` extension via `HOOKS.SYSTEM_PROMPT_BUILD` hook, contributing a skills preamble to the system prompt. Skills can also be loaded mid-conversation via the `load_skill` tool.
