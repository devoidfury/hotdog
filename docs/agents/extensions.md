### Extension Architecture
The core is minimal -- all features (tools, compaction, MCP, skills, prompts, subcommands) live as extensions in `src/extensions/`. Extensions plug into the core via hooks defined in `src/core/hooks.ts`.

When adding new functionality:
1. Check if an existing extension can be extended
2. If creating a new extension, place it in `src/extensions/<name>/` with `index.js` and a `extension.json` metadata file
3. Register tools via `HOOKS.TOOLS_REGISTER`
4. Register CLI subcommands via `HOOKS.CLI_SUBCOMMANDS_REGISTER` (or via `core.cliSubcommandRegistry`)
5. **Define config options in `configSchema` in `extension.json`** (single source of truth)
6. **Define CLI flags in `cli:flags` in `extension.json`**
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
    "myExtension": {
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
      },
      "additionalProperties": false
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
| `services` | object | No | Abstract services this extension provides. Keys are service names, values are method arrays. |
| `requires` | object | No | Abstract services this extension requires. Keys are service names, values are expected method arrays. |

**Load Order Constants** (from `LOAD_ORDER` in `extensions.ts`):
- `0` — REFRESH (must load first, tracks other extensions)
- `1` — CORE_TOOLS (needed by other extensions)
- `2` — CLI (loaded early for CLI subcommand registration)
- `10` — DEFAULT (most extensions)

**Discovery flow**: `extension.json` exists → `index.js` exists → valid extension.

**Static discovery**: CLI flags, subcommand declarations, and config params from `configSchema` are read at startup without loading extension code. This enables `--help`, subcommand discovery, and config defaults to work immediately.

### Configuration

**`configSchema` is the single source of truth** for extension configuration. Defaults defined in `configSchema` are automatically extracted and registered as config params. CLI flags are declared in `cli:flags`. The loader handles all registration automatically -- no imperative hooks needed.

The config key is the property name defined in `configSchema` (typically camelCase of the extension name):
- `core-tools` → configSchema key `coreTools` → `core.config.coreTools`
- `model-switch` → configSchema key `modelSwitch` → `core.config.modelSwitch`
- `mcp-client` → configSchema key `mcpServers` → `core.config.mcpServers`

Config values are accessed via `core.config.<configKey>`:
```javascript
export function create(core) {
  const config = core.config?.modelSwitch || {};
  if (config.toolEnabled) {
    // ...
  }
}
```

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

### Abstract Service Dependencies

Extensions can declare abstract service dependencies via `requires` and `services` fields. This enables **swappable dependencies** — swap the implementation of a service (e.g., "session") without changing any extension that depends on it.

```json
{
  "name": "my-extension",
  "services": {
    "session": ["list", "get", "create", "swap"],
    "resourceLoader": ["read", "write", "exists"]
  },
  "requires": {
    "config": ["get", "set"]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `services` | `object` | Abstract services this extension *provides*. Keys are service names, values are method arrays. |
| `requires` | `object` | Abstract services this extension *requires*. Keys are service names, values are expected method arrays. |

**How it works:**
1. During static metadata discovery, the system scans all `services` declarations to build a service→provider map
2. For each `requires` entry, a dependency edge is added from the consumer to the provider extension
3. Topological sort ensures providers load before consumers
4. Extensions register their implementation via `core.services.register(name, impl)` in `create()`
5. Consumers access the implementation via `core.service(name)` in `create()` or hooks

**Service Registry API (available on `core`):**

```js
// Register a service implementation (in the provider's create())
core.services.register("session", {
  list:   ()        => core.sessionManager.sessionIds(),
  get:    (id)      => core.sessionManager.getAgentBySessionId(id),
  create: (config)  => core.sessionManager.create(config),
  swap:   (config)  => core.sessionManager.swap(config),
});

// Consume a service (in a dependent extension)
const session = core.service("session");
const sessions = session.list();
```

**Config-based service override:**

To swap which extension provides a service, set `services.<name>` in config:

```json
{
  "services": {
    "session": "my-custom-session-extension"
  }
}
```

If multiple extensions provide the same service and no override is set, the first-loaded wins (with a warning).

**Validation:** After all extensions load, the system validates that every `requires` declaration has a matching registered service satisfying the method contract. Missing or incomplete services are reported as warnings.

### Capability Queries

The `ExtensionLoader` exposes methods to query extension capabilities:
- `loader.getProvides(name)` — get `provides` array for an extension
- `loader.hasCapability(capability)` — check if any extension provides a capability
- `loader.getProviders(capability)` — get all extensions providing a capability
- `loader.getDependsOn(name)` — get `dependsOn` array for an extension

When `extensionAutoload: false`, the loader auto-resolves transitive dependencies — if extension A depends on B, and A is explicitly listed but B is not, B is automatically included.
