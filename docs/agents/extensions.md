### Extension Architecture
The core is minimal -- all features (tools, compaction, MCP, skills, prompts, subcommands) live as extensions in `src/extensions/`. Extensions plug into the core via hooks defined in `src/core/hooks.js`.

When adding new functionality:
1. Check if an existing extension can be extended
2. If creating a new extension, place it in `src/extensions/<name>/` with `index.js` and a `extension.json` metadata file
3. Register tools via `HOOKS.TOOLS_REGISTER`
4. Register CLI subcommands via `HOOKS.CLI_SUBCOMMANDS_REGISTER` (or via `core.cliSubcommandRegistry`)
5. **Define config options in `configSchema` in `extension.json`** (single source of truth)
6. Optionally use `HOOKS.CONFIG_CLI_FLAGS_REGISTER` for CLI flags that need programmatic control
7. Contribute to system prompt via `HOOKS.SYSTEM_PROMPT_BUILD`

When adding new subcommands, create a new extension in `src/extensions/` and register via `CliSubcommandRegistry`.

### Extension.json Schema

Every extension directory must contain an `extension.json` metadata file. This is the **primary discovery signal** — the extension loader uses `extension.json` presence (plus `index.js`) to identify valid extensions.

```json
{
  "name": "extension-name",
  "provides": ["tools", "cli:subcommands"],
  "loadOrder": 10,
  "description": "Brief description of what this extension does",
  "cli:subcommands": [
    {
      "name": "my-cmd",
      "description": "Do something useful"
    }
  ],
  "cli:flags": [
    {
      "short": "-x",
      "long": "--my-flag",
      "description": "My extension flag",
      "type": "string"
    }
  ],
  "configSchema": {
    "type": "object",
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": true,
        "description": "Whether this extension is enabled"
      },
      "timeout": {
        "type": "number",
        "default": 30,
        "description": "Request timeout in seconds"
      }
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique extension identifier (used for loading/filtering) |
| `provides` | string[] | No | Capabilities: `"tools"`, `"cli:subcommands"` |
| `loadOrder` | number | No | Load priority (lower = earlier). Defaults to 10. |
| `dependsOn` | string[] | No | Names of extensions that must load before this one |
| `description` | string | No | Human-readable description |
| `cli:subcommands` | array | No | Subcommand declarations for static discovery (help text, `--help`) |
| `cli:flags` | array | No | CLI flag declarations for static discovery |
| `configSchema` | object | No | JSON Schema for extension config options (**single source of truth**) |
| `autoload` | boolean | No | Whether to auto-discover. Default: true |

**Load Order Constants** (from `LOAD_ORDER` in `extensions.js`):
- `0` — REFRESH (must load first, tracks other extensions)
- `1` — CORE_TOOLS (needed by other extensions)
- `2` — CLI (loaded early for CLI subcommand registration)
- `10` — DEFAULT (most extensions)

**Discovery flow**: `extension.json` exists → `index.js` exists → valid extension.

**Static discovery**: CLI flags, subcommand declarations, and config params from `configSchema` are read at startup without loading extension code. This enables `--help`, subcommand discovery, and config defaults to work immediately.

### Configuration

**`configSchema` is the single source of truth** for extension configuration. Defaults defined in `configSchema` are automatically extracted and registered as config params. Extensions do NOT need to also register via `HOOKS.CONFIG_PARAMS_REGISTER` — the loader handles this automatically.

The extension name (kebab-case) is converted to camelCase for the config key:
- `core-tools` → `coreTools`
- `model-switch` → `modelSwitch`
- `mcp-client` → `mcpClient`

Config values are accessed via `core.config.<configKey>`:
```javascript
export function create(core) {
  const config = core.config?.modelSwitch || {};
  if (config.toolEnabled) {
    // ...
  }
}
```

**When to use `HOOKS.CONFIG_PARAMS_REGISTER`**: Only use this hook when you need programmatic control over config registration (e.g., dynamic defaults based on runtime conditions). For the common case, define defaults in `configSchema` only.

**When to use `HOOKS.CONFIG_CLI_FLAGS_REGISTER`**: Use this hook to register CLI flags that need programmatic control or custom parsers. Simple flags can be declared in `extension.json` via `cli:flags`.

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
