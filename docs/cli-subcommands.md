# CLI Subcommand Registration

Extensions can register CLI subcommands that are automatically discovered and dispatched without needing to be explicitly wired up in `src/main.js`.

## How It Works

1. When the CLI starts, it creates an early core with a `CliSubcommandRegistry`
2. CLI extensions are loaded and can register subcommands via:
   - Direct registration: `core.cliSubcommandRegistry.register(name, definition)`
   - Hook-based registration: Register a handler for `HOOKS.CLI_SUBCOMMANDS_REGISTER`
3. When a subcommand is invoked, main.js looks it up in the registry and dispatches to the handler
4. Help text is dynamically generated from registered subcommands

## Creating a CLI Extension

### Minimal Example

```javascript
// extensions/my-subcommand/index.js

import { HOOKS } from '../../src/hooks.js';

export function create(core) {
  // Option 1: Direct registration (recommended for simple cases)
  if (core.cliSubcommandRegistry) {
    core.cliSubcommandRegistry.register("my-cmd", {
      description: "Do something useful",
      requiresConfig: true,  // Load config before running
      handler: async (cli, core) => {
        const { config } = core;
        console.log("Hello from my-cmd!");
      },
    });
  }

  // Option 2: Hook-based registration (for more complex setups)
  return {
    hooks: core.hooks
      ? {
          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
            registry.register("my-cmd", {
              description: "Do something useful",
              requiresConfig: true,
              handler: async (cli, core) => {
                // ...
              },
            });
          },
        }
      : undefined,
  };
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

### Loading Your Extension

Add your extension to `loadCliExtensions()` in `src/main.js`:

```javascript
async function loadCliExtensions(earlyCore) {
  const loaded = [];

  // ... existing extensions ...

  // Your extension
  const { create: createMyExt } = await import("../extensions/my-subcommand/index.js");
  const myExt = createMyExt(earlyCore);
  if (myExt) loaded.push(myExt);

  return loaded;
}
```

## Examples

### Simple Info Command

```javascript
// extensions/my-info/index.js

export function create(core) {
  if (core.cliSubcommandRegistry) {
    core.cliSubcommandRegistry.register("my-info", {
      description: "Show custom information",
      handler: async (cli, core) => {
        console.log("Custom info here");
      },
    });
  }
  return {};
}
```

### Command with Config Access

```javascript
export function create(core) {
  if (core.cliSubcommandRegistry) {
    core.cliSubcommandRegistry.register("my-command", {
      description: "Command that needs config",
      requiresConfig: true,
      handler: async (cli, core) => {
        const { config, buildConfig } = core;
        const { resolved } = await buildConfig(cli);
        console.log(`Model: ${resolved.model}`);
      },
    });
  }
  return {};
}
```

## Hook Constants

The following hook is used for CLI subcommand registration:

```javascript
import { HOOKS } from '../../src/hooks.js';

// Hook name: 'cli:subcommandsRegister'
HOOKS.CLI_SUBCOMMANDS_REGISTER
```

## Benefits

1. **No manual wiring**: Extensions self-register their subcommands
2. **Dynamic help**: Help text automatically includes all registered subcommands
3. **Consistent API**: All subcommands receive the same `(cliArgs, core)` interface
4. **Config management**: Extensions can opt-in to having config loaded automatically
