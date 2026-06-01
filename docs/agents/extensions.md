### Extension Architecture
The core is minimal — all features (tools, compaction, MCP, skills, prompts, subcommands, LSP) live as extensions in `extensions/`. Extensions plug into the core via hooks defined in `src/hooks.js`.

When adding new functionality:
1. Check if an existing extension can be extended
2. If creating a new extension, place it in `extensions/<name>/` with `index.js` and a `extension.json` metadata file
3. Register tools via `HOOKS.TOOLS_REGISTER`
4. Register CLI subcommands via `HOOKS.CLI_SUBCOMMANDS_REGISTER`
5. Register config params/CLI flags via `HOOKS.CONFIG_PARAMS_REGISTER` / `HOOKS.CONFIG_CLI_FLAGS_REGISTER`
6. Contribute to system prompt via `HOOKS.SYSTEM_PROMPT_BUILD`

When adding new subcommands, create a new extension in `extensions/` and register via `CliSubcommandRegistry`.

### Extension.json Schema

Every extension directory must contain an `extension.json` metadata file. This is the **primary discovery signal** — the extension loader uses `extension.json` presence (plus `index.js`) to identify valid extensions.

```json
{
  "name": "extension-name",
  "provides": ["tools", "cli:subcommands"],
  "loadOrder": 10,
  "description": "Brief description of what this extension does"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique extension identifier (used for loading/filtering) |
| `provides` | string[] | No | Capabilities: `"tools"`, `"cli:subcommands"` |
| `loadOrder` | number | No | Load priority (lower = earlier). Defaults to 10. |
| `dependsOn` | string[] | No | Names of extensions that must load before this one |
| `description` | string | No | Human-readable description |

**Load Order Constants** (from `LOAD_ORDER` in `extensions.js`):
- `0` — REFRESH (must load first, tracks other extensions)
- `1` — CORE_TOOLS (needed by other extensions)
- `2` — CLI (loaded early for CLI subcommand registration)
- `10` — DEFAULT (most extensions)

**Discovery flow**: `extension.json` exists → `index.js` exists → valid extension.

### Dependencies

Use `dependsOn` to declare that an extension must load after specific other extensions. The loader uses topological sort to resolve dependencies — a dependency's `loadOrder` is ignored if it would violate the dependency order. Circular dependencies are detected and reported as errors.

Example:
```json
{
  "name": "skills",
  "dependsOn": ["core-tools"],
  "provides": ["tools"]
}
```

### Capability Queries

The `ExtensionLoader` exposes methods to query extension capabilities:
- `loader.getProvides(name)` — get `provides` array for an extension
- `loader.hasCapability(capability)` — check if any extension provides a capability
- `loader.getProviders(capability)` — get all extensions providing a capability
- `loader.getDependsOn(name)` — get `dependsOn` array for an extension

When `extensionAutoload: false`, the loader auto-resolves transitive dependencies — if extension A depends on B, and A is explicitly listed but B is not, B is automatically included.
