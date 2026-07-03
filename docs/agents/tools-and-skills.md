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
- `TOOL_FACTORIES` — declarative map of tool names to factory functions

**Disabled by default** — `ExploreTool` has `disabled: true` in its descriptor; it requires explicit inclusion via profile `whitelist_tools`. Subagent tools require `manager: true` profile flag and a `taskManager`.

### Core Tool Implementations

| Tool | Extension | Description | Key Params |
|------|-----------|-------------|------------|
| `write` | `core-tools` | Writes files with multi-mode support | `path`, `content` / `regex` + `content` / `files` + `atomic` |
| `read` | `core-tools` | Reads file contents with pagination | `path`, `limit`, `offset` |
| `edit` | `core-tools` | Edits files using replace modes | `path`, `oldString`, `newString` / `search`, `replace` / `files` + `atomic` |
| `grep` | `core-tools` | Searches file contents for regex patterns | `pattern`, `path`, `type`, `context` |
| `find` | `core-tools` | Glob-based file search | `pattern`, `path`, `file_type`, `max_results` |
| `pager` | `core-tools` | Show a previously cached tool output for pagination | `tool_call_id` |
| `project_info` | `core-tools` | Gathers project information | `path` |
| `explore` *(disabled)* | `core-tools` | Runs the agent in explorer mode against a project directory | `path`, `outline` |
| `bash` | `bash-tool` | Executes shell commands via `bash -c` | `command`, `timeoutMs` |
| `fetch` | `fetch-tool` | Fetches URLs via HTTP | `url`, `method`, `headers`, `body`, `showOriginal` |
| `question` | `question-tool` | Asks interactive questions to the user | `questions` array with `key`, `prompt`, `options`, `required`, `default` |
| `model` | `model-switch` | Switches to a different model mid-conversation | `name` |
| `web_search` | `web-search` | Searches the web for information | `query` |
| `review` | `ui-session-review-cli` | Lists recent sessions, gets session entries, or gets tool call index | `operation`, `session_id`, `limit` |

### Subagent Tools *(disabled by default, enabled in manager profile)*

Provided by the `subagents` extension. Only registered when `profile.manager: true` and a `taskManager` is available.

| Tool | Description |
|------|-------------|
| `delegate_task` | Spawn a background task agent |
| `task_status` | Check status of a running task |
| `task_followup` | Send follow-up to a running task |
| `task_interrupt` | Interrupt (cancel) a running task |
| `plan_status` | Check status of task agents — shows all active tasks or a specific task's status |
| `complete_task` | Mark a task as complete |
| `wait` | Model yields control back to user |

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
- `loadSkills()` — loads all skills from all configured paths
- `loadFromDirectory(path)` — loads from a single directory
- `parseSkillFromMd(content, dirName)` — parses YAML frontmatter + markdown body
- `setAvailableTools(coreToolNames)` — loads skills whose tool-dependencies are met
- `allSkills()`, `getSkill(name)`, `directories()`, `activeSkills()`
- Non-existent paths are silently skipped
- Name validation: lowercase alphanumeric + hyphens only (1-64 chars, no leading/trailing hyphens, no consecutive hyphens)

**Skill loading**: Skills are loaded by the `skills` extension via `HOOKS.SYSTEM_PROMPT_BUILD` hook, contributing a skills preamble to the system prompt. Skills can also be loaded mid-conversation via the `load_skill` tool.
