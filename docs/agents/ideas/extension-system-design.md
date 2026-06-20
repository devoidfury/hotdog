> **⚠️ OBSOLETE — Extension system implemented.**
>
> The extension architecture described in this design has been implemented. See:
> - `docs/agents/architecture.md` -- Current architecture overview
> - `src/core/hooks.js` -- Hook system implementation
> - `src/core/extensions/extensions.js` -- Extension loader implementation
> - `AGENTS.md` -- Module layout and extension guidelines
> - `docs/cli-subcommands.md` -- CLI subcommand registration
>
> Key differences from this design:
> - Extensions use `create(core, options)` instead of `register(context)`
> - Hook-based registration (`HOOKS.TOOLS_REGISTER`, etc.) instead of context methods
> - `ExtensionLoader` class with `load()`, `unload()`, `reload()` lifecycle
> - `ConfigRegistry` for extension CLI flags and config params
> - `CliSubcommandRegistry` for CLI subcommand registration
> - Extension metadata via `extension.json` with `provides` array
> - Auto-discovery from configured extension paths

# OA-JS Extension System Design

## 1. Current State Analysis

### What Exists Today

The codebase already has four distinct "extension-like" systems, but they are **independent and hardcoded**:

| System | Discovery | Registration | Where Defined |
|--------|-----------|-------------|---------------|
| **Core Tools** | Static `TOOL_DESCRIPTORS` array | `TOOL_CONSTRUCTORS` map in `src/tools/index.js` | Hardcoded in source |
| **MCP Servers** | Config file `mcpServers` array | `SessionBuilder._buildMcpConnections()` | Config file only |
| **Skills** | Filesystem scan of directories | `SkillsLoader.loadFromDirectory()` | Filesystem directories |
| **Prompts** | Filesystem scan of directories | `PromptsLoader.loadFromDirectory()` | Filesystem directories |

### Pain Points

1. **Adding a tool requires modifying source code** — Every new tool must be added to `TOOL_DESCRIPTORS`, `TOOL_CONSTRUCTORS`, and `CORE_TOOL_NAMES` in `src/tools/index.js`. There is no way to add tools from config or external files.
2. **No unified extension model** — Each system has its own loading pattern. A third-party developer must understand four different mechanisms to integrate something.
3. **MCP connections are config-only** — MCP servers can only be configured via JSON config. There is no programmatic way to register MCP connections from code.
4. **Skills and prompts are filesystem-only** — There is no way to register skills or prompts from code (e.g., from an npm package).
5. **No lifecycle hooks** — There is no way for an extension to run initialization code, register output event handlers, or participate in the agent lifecycle.
6. **Tool factory is opaque** — `createToolFactory()` is a closure over hardcoded maps. External code cannot inject tool constructors.

### Existing Abstractions Worth Preserving

- **`OutputSink`** — Already a clean abstraction. Agent emits events; UI formats them. No change needed.
- **`ToolRegistry`** — Already has `register(name, tool)`, `get(name)`, `getAll()`. Perfectly usable by external code.
- **`SkillsLoader`** / **`PromptsLoader`** — Already have `getSkill(name)`, `getPrompt(name)`, `allSkills()`, `allPrompts()`. These could accept external registrations.
- **`SessionBuilder`** — Central initialization pipeline. This is the right place to hook in.
- **`Agent`** — Already has `createToolContext()` which passes context to tools.

---

## 2. Design Principles

1. **Simple authoring, powerful internals** — Plugin authors write one function. The system behind it is flexible.
2. **Convention over configuration** — Extensions are discovered by convention (a directory, or explicit paths in config). No manifest files required for simple extensions.
3. **Additive, not replace** — The extension system is purely additive. All existing behavior (hardcoded tools, config MCP, filesystem skills/prompts) continues to work exactly as before.
4. **No new types for authors** — Extensions work with the existing types (`ToolRegistry`, `SkillsLoader`, `PromptsLoader`, `McpConnection`). No new abstractions required to write a plugin.
5. **Simple mental model** — "An extension is a JS file that exports a `register(context)` function. The context gives you methods to register tools, skills, prompts, and MCP connections."
6. **Opt-in complexity** — Manifests, sandboxing, hot-reloading, and other advanced features are optional. Start simple, add features as needed.

---

## 3. Architecture

### 3.1 The Extension Context

The context object is the **only** interface an extension sees. It provides five methods:

```
┌─────────────────────────────────────────────────────────┐
│                    Extension Context                     │
├─────────────────────────────────────────────────────────┤
│  registerTool(name, tool)                               │
│    → Registers a tool with the ToolRegistry             │
│                                                         │
│  registerTools([toolDefs])                              │
│    → Registers multiple tools at once                   │
│                                                         │
│  addSkill(skill)                                        │
│    → Adds a skill to the SkillsLoader                   │
│                                                         │
│  addPrompt(prompt)                                      │
│    → Adds a prompt to the PromptsLoader                 │
│                                                         │
│  registerMcpTool(serverName, toolDef, handler)          │
│    → Registers an MCP-style tool (same as McpTool)      │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Extension Discovery

Extensions are discovered in two ways:

1. **Explicit paths** — Listed in the config file under `extensions` array.
2. **Convention directory** — A configured directory (default: `./extensions/`) where any `.js` file with a `register` export is loaded.

### 3.3 Loading Pipeline

```
main.js
  │
  ├── parseArgs()
  ├── buildConfig()
  ├── loadConfig()
  │
  └── SessionBuilder(resolved, config, modelRegistry)
        │
        ├── _buildSkillsLoader()     ← existing
        ├── _buildPromptsLoader()    ← existing
        ├── _buildMcpConnections()   ← existing
        ├── _buildExtensionManager() ← NEW
        │
        └── buildAgent(sink)
              │
              └── new Agent({ ... })
                    │
                    └── Agent.buildToolRegistry()
                          │
                          ├── Core tools (existing)
                          ├── MCP tools (from connections)
                          └── Extension tools (from context)
```

---

## 4. Implementation

### 4.1 Extension Manager (`src/extension_manager.js`)

```javascript
// Extension manager — loads and runs extensions.
// An extension is a JS file that exports a register(context) function.

/**
 * Create an extension context — the only interface extensions see.
 */
export function createExtensionContext(options) {
  const {
    toolRegistry = null,       // May be null during early loading
    skillsLoader = null,
    promptsLoader = null,
    deferredTools = [],        // Buffer for tools registered before registry exists
    deferredMcpTools = [],     // Buffer for MCP tools
  } = options;

  return {
    /**
     * Register a single tool.
     * @param {string} name - Tool name
     * @param {object} tool - Tool instance with execute(), toToolDef(), callDisplay()
     */
    registerTool(name, tool) {
      if (toolRegistry) {
        toolRegistry.register(name, tool);
      } else {
        deferredTools.push({ name, tool });
      }
    },

    /**
     * Register multiple tools at once.
     * @param {Array<{name: string, tool: object}>} tools - Array of {name, tool} pairs
     */
    registerTools(tools) {
      for (const { name, tool } of tools) {
        this.registerTool(name, tool);
      }
    },

    /**
     * Add a skill to the skills loader.
     * @param {object} skill - Skill object from parseSkillFromMd()
     */
    addSkill(skill) {
      if (skillsLoader) {
        skillsLoader.skills.set(skill.name, skill);
      }
    },

    /**
     * Add a prompt to the prompts loader.
     * @param {object} prompt - Prompt object from parsePromptFromMd()
     */
    addPrompt(prompt) {
      if (promptsLoader) {
        promptsLoader.prompts.set(prompt.name, prompt);
      }
    },

    /**
     * Register an MCP-style tool.
     * @param {string} serverName - MCP server name prefix
     * @param {object} toolDef - Tool definition object
     * @param {Function} handler - Async function that executes the tool
     */
    registerMcpTool(serverName, toolDef, handler) {
      if (toolRegistry) {
        import("../mcp/tools.js").then(({ McpTool }) => {
          const mcpTool = new McpTool(serverName, toolDef, { callTool: handler });
          toolRegistry.register(`${serverName}/${toolDef.name}`, mcpTool);
        });
      } else {
        deferredMcpTools.push({ serverName, toolDef, handler });
      }
    },

    // Expose deferred tools for the agent to apply
    get deferred() {
      return { tools: deferredTools, mcpTools: deferredMcpTools };
    },
  };
}

/**
 * Load a single extension module.
 * @param {string} path - Module path
 * @param {object} context - Extension context
 * @returns {Promise<void>}
 */
export async function loadExtension(path, context) {
  const mod = await import(path);
  if (typeof mod.register !== "function") {
    console.warn(`Warning: extension '${path}' does not export a register() function`);
    return;
  }
  try {
    await mod.register(context);
  } catch (e) {
    console.error(`Error loading extension '${path}': ${e.message}`);
  }
}

/**
 * Load extensions from a directory by convention.
 * Scans for .js files, loads those that export register().
 * @param {string} dir - Directory path
 * @param {object} context - Extension context
 * @returns {Promise<void>}
 */
export async function loadExtensionsFromDirectory(dir, context) {
  const fs = await import("node:fs");
  const path = await import("node:path");

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist — silently skip
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js")) continue;

    const filePath = path.join(dir, entry.name);
    await loadExtension(filePath, context);
  }
}

/**
 * Extension manager — discovers and loads extensions.
 */
export class ExtensionManager {
  constructor({ extensionsPaths = [], extensionsDir = null } = {}) {
    this._paths = extensionsPaths || [];
    this._dir = extensionsDir;
  }

  /**
   * Load all extensions.
   * @param {object} context - Extension context
   * @returns {Promise<void>}
   */
  async load(context) {
    // Load from explicit config paths
    for (const path of this._paths) {
      await loadExtension(path, context);
    }

    // Load from convention directory
    if (this._dir) {
      await loadExtensionsFromDirectory(this._dir, context);
    }
  }
}
```

### 4.2 Integration into SessionBuilder (`src/agent/session_builder.js`)

```javascript
// Add to imports at top
import { ExtensionManager, createExtensionContext } from "../extension_manager.js";

// Add to constructor
constructor(resolved, config, modelRegistry) {
  // ... existing code ...
  this._extensionManager = this._buildExtensionManager();
}

// Add new private method
_buildExtensionManager() {
  return new ExtensionManager({
    extensionsPaths: this._config.extensions || [],
    extensionsDir: this._config.extensionsDir || "./extensions",
  });
}

// Add to buildAgent() — call extensions BEFORE building tool registry
async buildAgent(sink) {
  // ... existing code ...

  // Build extension context with skills/prompts (tool registry not yet built)
  const extContext = createExtensionContext({
    toolRegistry: null,       // Deferred — applied in Agent.buildToolRegistry()
    skillsLoader: this._skillsLoader,
    promptsLoader: this._promptsLoader,
  });

  // Load extensions — they can register tools, skills, prompts, MCP connections
  await this._extensionManager.load(extContext);

  // ... rest of buildAgent ...
}
```

### 4.3 Integration into Agent.buildToolRegistry()

```javascript
// In Agent constructor, add:
constructor(config = {}) {
  // ... existing code ...
  this._extensionDeferredTools = config.extensionDeferredTools || [];
  this._extensionDeferredMcpTools = config.extensionDeferredMcpTools || [];
}

// In Agent.buildToolRegistry():
async buildToolRegistry(whitelist = null, blacklist = null, managerToolsEnabled = false) {
  const registry = new ToolRegistry();
  const ctx = this.createToolContext();
  const factory = createToolFactory(this.taskManager);

  // 1. Core tools (existing)
  // ... existing core tool loading ...

  // 2. MCP tools (existing)
  // ... existing MCP tool loading ...

  // 3. Extension tools (NEW)
  for (const { name, tool } of this._extensionDeferredTools) {
    registry.register(name, tool);
  }
  for (const { serverName, toolDef, handler } of this._extensionDeferredMcpTools) {
    const mcpTool = new McpTool(serverName, toolDef, { callTool: handler });
    registry.register(`${serverName}/${toolDef.name}`, mcpTool);
  }

  return registry;
}
```

### 4.4 Config Changes (`src/config.js`)

Add to `getDefaultConfig()`:

```javascript
function getDefaultConfig() {
  return {
    // ... existing fields ...
    extensions: [],                  // Array of explicit extension paths
    extensionsDir: "./extensions",   // Convention directory (null to disable)
  };
}
```

---

## 5. Extension Examples

### 5.1 Simple Tool Extension

```javascript
// extensions/my_tool.js
import { toolDef, param, toolResult } from "../src/tools/registry.js";

export function register(context) {
  class MyTool {
    toToolDef() {
      return toolDef(
        "my_tool",
        "Does something useful",
        {
          schema: "https://json-schema.org/draft/2020-12/schema",
          properties: {
            message: param("string", "The message to process"),
          },
          required: ["message"],
        },
      );
    }

    callDisplay(input) {
      const args = typeof input === "string" ? JSON.parse(input) : input;
      return `my_tool: ${args.message || ""}`;
    }

    async execute(input) {
      const args = typeof input === "string" ? JSON.parse(input) : input;
      return toolResult(`Processed: ${args.message}`);
    }
  }

  context.registerTool("my_tool", new MyTool());
}
```

### 5.2 Bulk Tool Extension

```javascript
// extensions/bulk_tools.js
import { toolDef, param, toolResult } from "../src/tools/registry.js";

function createTool(name, description, properties, handler) {
  return {
    toToolDef() {
      return toolDef(name, description, {
        schema: "https://json-schema.org/draft/2020-12/schema",
        properties,
        required: [],
      });
    },
    callDisplay(input) {
      return `${name}: ${input}`;
    },
    async execute(input) {
      const args = typeof input === "string" ? JSON.parse(input) : input;
      return toolResult(await handler(args));
    },
  };
}

export function register(context) {
  context.registerTools([
    {
      name: "greet",
      tool: createTool(
        "greet",
        "Greets someone by name",
        { name: param("string", "Name to greet") },
        (args) => `Hello, ${args.name}!`,
      ),
    },
    {
      name: "echo",
      tool: createTool(
        "echo",
        "Echoes input back",
        { text: param("string", "Text to echo") },
        (args) => args.text,
      ),
    },
  ]);
}
```

### 5.3 MCP Bridge Extension

```javascript
// extensions/mcp_bridge.js
import { McpTool } from "../src/mcp/tools.js";

export async function register(context) {
  context.registerMcpTool("weather", {
    name: "forecast",
    description: "Get weather forecast for a location",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
  }, async (args) => {
    const response = await fetch(
      `https://api.weather.example.com/forecast?location=${args.location}`,
    );
    return await response.text();
  });
}
```

### 5.4 Skill and Prompt Extension

```javascript
// extensions/developer_skills.js

export function register(context) {
  // Register a developer skill
  context.addSkill({
    name: "developer",
    description: "General development guidelines",
    content: `# Developer Skill

Write clean, well-tested code.

## Guidelines
- Follow existing project patterns
- Add tests for new functionality
- Document public APIs
`,
    location: "extension:developer_skills",
    visible: true,
    loaded: true,
    disableModelInvocation: false,
    additionalFiles: [],
    allowedTools: [],
    includeTools: [],
