# Tools and Skills

## Tools

### Tool System (`src/tools/`)

- **Tool interface** — all tools implement: `create(ctx) → { instance, error }`, `execute(input, ctx, toolCallId) → { result, error }`, `toToolDef()`, `callDisplay(input)`
- **ToolRegistry** — stores tools by name, provides lookup, serialization, and `toolDefs()` accessor
- **Tool** / **ToolFunction** / **ToolParams** / **ToolParam** — shared types for LLM tool definitions
- **ToolFactory interface + DefaultToolFactory** — creates tool instances from config, supports `ToolContext`
- **TOOL_DESCRIPTORS** — static array of tool descriptors defining all core + manager tools with their factory functions and disabled flags
- **CORE_TOOL_NAMES** — includes all 15 core tool names: `bash`, `write`, `model`, `load_skill`, `read`, `question`, `pager`, `explore`, `find`, `grep`, `fetch`, `project_info`, `review`, `edit`. Filtered by profile whitelist/blacklist.
- **Disabled by default** — `ProjectInfoTool` and all orchestrator tools (`plan_status`, `complete_task`, `delegate_task`, `task_status`, `task_followup`, `task_interrupt`) have `disabled: true` in their descriptors; they require explicit inclusion via profile `whitelist_tools` or the `manager: true` profile flag

### Implementations

- **BashTool** — executes shell commands via `bash -c`. Params: `{"command": "..."}`
- **WriteTool** — writes files with three modes:
  1. **Full replacement**: `{"path": "file.txt", "content": "new content"}` — replaces entire file
  2. **Regex replace**: `{"path": "file.txt", "regex": "old_pattern", "content": "replacement"}` — replaces all regex matches
  3. **Atomic multi-file**: `{"files": [{"path": "a.txt", "regex": "old", "content": "new"}], "atomic": true}` — writes multiple files atomically (all-or-nothing)
  Auto-creates parent directories.
- **ModelTool** — switches to a different model mid-conversation. Params: `{"name": "model-name"}`. Tool description dynamically shows the current model and lists all available models in the schema. Each agent instance has its own `ModelTool`.
- **LoadSkillTool** — activates a skill mid-conversation by loading its full content. Params: `{"name": "skill-name"}`
- **ReadTool** — reads file contents with pagination. Params: `{"path": "...", "limit": N, "offset": N, "type": "lines"|"bytes"}`. Returns error for directories with a depth-1 listing.
- **QuestionTool** — asks interactive questions to the user with optional choices and defaults. Params: `{"questions": [{"key": "...", "prompt": "...", "options": [...], "required": true, "default": "..."}]}` (interactive mode is auto-detected based on stdin terminal)
- **PagerTool** — virtual pagination of truncated tool output. Params: `{"tool_call_id": "...", "page": N}`. Use after a tool returns truncated output to see subsequent pages.
- **ExploreTool** — explores codebase with configurable thoroughness (quick, medium, very thorough). Params: `{"path": "...", "thoroughness": "..."}`
- **FindTool** — glob-based file search using `fd` with fallback to `find`. Params: `{"pattern": "...", "path": "...", "file_type": "file"|"directory"|"empty", "max_results": N}`.
- **FetchTool** — fetches URLs via HTTP. Params: `{"url": "...", "method": "GET"|"POST", "headers": {...}}`
- **GrepTool** — searches file contents for a pattern using regex. Params: `{"pattern": "...", "path": "...", "type": "all"|"rust"|"ts"|"py"|"js", "context": N}`.
- **ProjectInfoTool** *(disabled by default)* — gathers project information (structure, dependencies, entry points). Params: `{"path": "..."}`
- **EditTool** — edits files using three modes: full replacement, regex replace, and atomic multi-file edits. Supports the same pattern format as WriteTool for structured edits.
- **ReviewTool** — lists recent sessions, gets all entries for a specific session, or gets a lightweight tool call index. Returns JSON data. Params: `{"operation": "list"|"get"|"tool_index", "session_id": "...", "limit": N}`.
- **Subagent tools** *(disabled by default, enabled in meta profile)*: `plan_status`, `complete_task`, `delegate_task`, `task_status`, `task_followup`, `task_interrupt` — async task delegation and management.

### LSP Tools (`src/lsp/`)

12 tools providing IDE-like features via external language servers. All tools require:
- `lsp.enabled: true` in config or profile
- A language server binary installed (e.g., `typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer`)
- A file with a supported extension to determine the language server

**Activation**: LSP tools are only registered when `lsp.enabled` is `true` in the resolved config. Tools are created per-file using the file's language ID to select the appropriate server.

| Tool | Params | Description |
|------|--------|-------------|
| `lsp-hover` | `file`, `line`, `character` | Get type info, docs, function signatures at a position |
| `lsp-definition` | `file`, `line`, `character` | Find where a symbol is defined |
| `lsp-completion` | `file`, `line`, `character`, `limit` | Auto-completion suggestions (default limit: 50) |
| `lsp-signature` | `file`, `line`, `character` | Function parameter hints with active signature tracking |
| `lsp-document-symbol` | `file` | List all symbols in a document (functions, classes, variables) |
| `lsp-references` | `file`, `line`, `character` | Find all usages/references of a symbol |
| `lsp-code-action` | `file`, `line`, `character` | Quick fixes and refactoring options |
| `lsp-formatting` | `file` | Format an entire document (tabSize=2, insertSpaces=true) |
| `lsp-rename` | `file`, `line`, `character`, `newName` | Rename a symbol across all files |
| `lsp-diagnostics` | `file` | Get errors/warnings/hints (**push-mode only** — server must publish diagnostics after document open) |
| `lsp-workspace-symbol` | `query` | Search for symbols across the entire workspace |
| `lsp-apply-edit` | `edit` (JSON) | Apply multi-file workspace edits atomically |

**Position encoding**: All position parameters (`line`, `character`) use LSP's UTF-16 zero-based indexing.

**Known limitations**:
- `lsp-diagnostics` is a stub: it reports capability status but cannot retrieve actual diagnostics because the LSP client is never initialized (language server process never spawned). This is a critical implementation gap.
- Each tool creates its own LSP client (no document sharing across tools for the same file).
- No support for incremental document sync (uses full document replacement).

## Skills

### Skill System (`src/skills/`)

- **Skill** — skill data with `name`, `description`, `license`, `compatibility`, `metadata`, `allowed_tools` (array from space-separated YAML string), `include_tools`, `tool_dependencies`, `visible`, `disable_model_invocation`, `loaded`, `content` (markdown body), `location`, `additional_files`
- **SkillConfig** — `path` (default: `/skills`, colon-separated multi-path support)
- **SkillsLoader** — loads SKILL.md files from directories following Agent Skills spec
  - Recursive directory scanning, finds `SKILL.md` in each subdirectory
  - Validates `name` matches directory name, lowercase alphanumeric + hyphens only (1-64 chars, no leading/trailing hyphens, no consecutive hyphens)
  - `load_skills()` — loads all skills from all configured paths
  - `load_from_directory(path)` — loads from a single directory
  - `parse_skill_from_md(content, dir_name)` — parses YAML frontmatter + markdown body
  - `setAvailableTools(coreToolNames)` — loads skills whose tool-dependencies are met by tools
  - `all_skills()`, `get_skill(name)`, `directories()`
  - Non-existent paths are silently skipped
