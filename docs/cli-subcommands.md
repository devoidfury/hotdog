# CLI Subcommand Registration

Extensions can register CLI subcommands that are automatically discovered and dispatched without needing to be explicitly wired up in `src/main.js`.

## How It Works

1. When the CLI starts, it creates an early core with a `CliSubcommandRegistry`
2. CLI extensions are loaded (auto-discovered via `provides: ["cli:subcommands"]` in `extension.json`)
3. CLI extensions register subcommands via:
   - Direct registration: `core.cliSubcommandRegistry.register(name, definition)`
   - Hook-based registration: Register a handler for `HOOKS.CLI_SUBCOMMANDS_REGISTER`
4. When a subcommand is invoked, main.js looks it up in the registry and dispatches to the handler
5. Help text is dynamically generated from registered subcommands

## Creating a CLI Extension

### Minimal Example

```javascript
// extensions/my-subcommand/index.js

import { HOOKS } from '../../src/hooks.js';

export function create(core) {
  // Direct registration (recommended)
  if (core.cliSubcommandRegistry) {
    core.cliSubcommandRegistry.register("my-cmd", {
      description: "Do something useful",
      requiresConfig: true,  // Load config before running (default: true)
      requiresCore: false,   // Whether this needs the full core (default: false)
      handler: async (cli, core) => {
        const { config } = core;
        console.log("Hello from my-cmd!");
      },
    });
  }

  return {};
}
```

### Subcommand Definition

```javascript
{
  description: "Short description shown in help",
  requiresConfig: true,      // Auto-load config before handler runs (default: true)
  requiresCore: false,       // Whether this needs the full core (default: false)
  handler: async (cliArgs, core) => {
    // cliArgs: CLI arguments parsed by parseArgs()
    // core: The early core object with hooks, config, buildConfig, etc.
  },
}
```

### Extension Metadata

Each CLI extension needs an `extension.json` file declaring its capability:

```json
{
  "provides": ["cli:subcommands"]
}
```

This is how the extension loader auto-discovers CLI extensions before config is loaded.

## Hook Registration (Alternative)

For more complex setups, extensions can register via the hook:

```javascript
export function create(core) {
  return {
    hooks: core.hooks ? {
      [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
        registry.register("my-cmd", {
          description: "Do something useful",
          requiresConfig: true,
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
| `info` | `info-show-prompt` | Show system info and diagnostics |
| `show-prompt` | `info-show-prompt` | Show rendered system prompt |
| `review` | `session-review` | Review session logs |

## Benefits

1. **No manual wiring**: Extensions self-register their subcommands
2. **Dynamic help**: Help text automatically includes all registered subcommands
3. **Consistent API**: All subcommands receive the same `(cliArgs, core)` interface
4. **Config management**: Extensions can opt-in to having config loaded automatically
