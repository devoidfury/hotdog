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
  - `autoActivate(coreToolNames)` — auto-activates skills whose tool-dependencies are met by core tools
  - `all_skills()`, `get_skill(name)`, `directories()`
  - Non-existent paths are silently skipped
