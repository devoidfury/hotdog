# CLI Subcommand Registration

Extensions can register CLI subcommands that are automatically discovered and dispatched without needing to be explicitly wired up in `src/main.js`.

## How It Works

1. At startup, the CLI discovers extensions by reading `extension.json` files (no code loading needed)
2. CLI flags and subcommand declarations from `extension.json` are registered immediately
3. This enables `--help` and subcommand discovery without loading any extension code
4. When a subcommand is invoked, extensions are loaded and their handlers are registered
5. Help text is generated from the registered subcommands

## Extension Metadata (extension.json)

Subcommands and CLI flags are declared in `extension.json`:

```json
{
  "name": "my-extension",
  "provides": ["cli:subcommands"],
  "cli:subcommands": [
    {
      "name": "my-cmd",
      "description": "Do something useful",
      "options": [
        {
          "name": "--verbose",
          "type": "boolean",
          "description": "Enable verbose output"
        }
      ]
    }
  ],
  "cli:flags": [
    {
      "short": "-x",
      "long": "--my-flag",
      "description": "My extension flag",
      "type": "string",
      "default": null
    }
  ]
}
```

### Subcommand Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | (required) | Subcommand name (e.g., "info", "show-prompt") |
| `description` | string | "" | Short description shown in help text |
| `options` | array | [] | Subcommand-specific options for help text |

### Option Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Option name (e.g., "--json", "--session-id") |
| `type` | string | Option type: "boolean", "string", or "number" |
| `description` | string | Option description for help text |

### CLI Flag Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `short` | string | null | Short flag (e.g., '-x') |
| `long` | string | (required) | Long flag (e.g., '--my-flag') |
| `description` | string | "" | Help text for this flag |
| `type` | string | "string" | Flag type: 'string', 'boolean', 'number', 'array' |
| `default` | any | null | Default value when flag is not provided |

## Creating a CLI Extension

### Minimal Example

```javascript
// extensions/my-subcommand/index.js

export function create(core) {
  // Register subcommands if the registry is available
  if (core.cliSubcommandRegistry) {
    core.cliSubcommandRegistry.register("my-cmd", {
      description: "Do something useful",
      handler: async (cli, core) => {
        const { config, buildConfig } = core;
        console.log("Hello from my-cmd!");
      },
    });
  }

  return {};
}
```

### Extension Metadata

Each CLI extension needs an `extension.json` file declaring its capability:

```json
{
  "name": "example-ext",
  "provides": ["cli:subcommands"],
  "cli:subcommands": [
    {
      "name": "my-cmd",
      "description": "Do something useful"
    }
  ]
}
```

The `cli:subcommands` array is used for **discovery** (help text, `--help`, unknown subcommand messages). The actual handler is registered at runtime by the extension's `create()` function.

## Hook Registration (Alternative)

For more complex setups, extensions can register via the hook:

```javascript
import { HOOKS } from '../../core/hooks.js';

export function create(core) {
  return {
    hooks: core.hooks ? {
      [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
        registry.register("my-cmd", {
          description: "Do something useful",
          handler: async (cli, core) => {
            // ...
          },
        });
      },
    } : undefined,
  };
}
```

## Built-in Subcommands

| Subcommand | Extension | Description |
|-----------|-----------|-------------|
| `info` | `ui-info-cli` | Show system info and diagnostics |
| `show-prompt` | `ui-info-cli` | Show rendered system prompt |
| `review` | `ui-session-review-cli` | Review session logs |
| `prompt` | `ui-one-shot` | One-shot prompt mode — run a single prompt and exit |
| `cli` | `ui-interactive-cli` | Interactive CLI session (default when stdin is TTY) |
| `webui` | `webui` | Start the WebUI server (HTTP + WebSocket + frontend) |

## Benefits

1. **No manual wiring**: Extensions self-register their subcommands
2. **Static discovery**: Help text and subcommand discovery work without loading extension code
3. **Dynamic help**: Help text automatically includes all registered subcommands
4. **Consistent API**: All subcommands receive the same `(cliArgs, core)` interface
5. **Config management**: Extensions can opt-in to having config loaded automatically
