# Extensions system

I want to update the core to be a modular system via events and hooks, and then move as much as possible out of core into extensions.

## Extensions goals
- should each have their own config key in config json
- modify the behavior of the core with hooks
- can provide tools (lsp, mcp, fetch, grep)
- can provide functionality (eg compaction should be moved to an extension)
- need to have a way to explicitly hot reload extensions/tools in a running session
- can be a UI, eg a webserver or rpc or tui
- can read the whole resolved config object

## Why?

Keep the core clean and minimal, and fully tested. It should be rock solid. Features can be built as extensions, contained instead of creeping out and blending together, as well as making it possible to easily configure totally differently behaving agent harness setups and allowing end users to customize their own clients.

## What I'm envisioning

The core should have the main sessions/agent interface, operate the main loop for agents and session serialization, and core tool calling code path -- although most of the tools themselves should be moved to extensions, as well as mcp, prompts, skills, show-prompt and review subcommands, and compaction.



# Full Review: Extension System Alignment

**Date:** 2026-05-21
**Goal:** Modular extension system — core stays minimal, features live in extensions

---

## Executive Summary

The goal is to **decompose into extensions** — a minimal core with hooks, where compaction, LSP, MCP, skills, prompts, tools, and subcommands all live as extensions.

---

## Target Architecture

```
┌─────────────────────────────────────────────┐
│                 Extensions                   │
├────────────┬──────────┬──────────┬──────────┤
│ compaction │  LSP     │  MCP     │ skills   │
│  prompts   │  fetch   │  grep    │  tools   │
│ subcommands│   UI     │  bash    │  edit    │
│   review   │ show-prompt│ write  │  read    │
└────┬───────┴──────────┴──────────┴──────────┘
     │ hooks, events, tool registration
     ▼
┌─────────────────────────────────────────────┐
│                  Core                        │
├─────────────────────────────────────────────┤
│ • Session lifecycle (create, swap, serialize)│
│ • Agent run loop (LLM call → tool exec)     │
│ • Minimal message format                    │
│ • Hook/event system                          │
│ • Extension loading & hot-reload             │
│ • Config schema (core + extension keys)      │
└─────────────────────────────────────────────┘
```

### Core Responsibilities (what stays)

1. **Session lifecycle** — create, swap, serialize, switch
2. **Agent run loop** — dequeue → LLM → tool exec → repeat
3. **Minimal message format** — role/content/toolCalls, nothing more
4. **Hook/event system** — where extensions plug in
5. **Extension loader** — discovery, loading, hot-reload
6. **Config resolution** — core defaults + extension config keys

### Everything else is an extension

| Extension | Current Location | Hook/Integration Point |
|-----------|-----------------|----------------------|
| compaction | `src/compaction/` | `onContextFull` hook, `beforeLLMCall` |
| LSP | `ext/lsp/` | `registerTools` hook |
| MCP | `src/mcp/` | `registerTools` hook, `onSessionInit` |
| skills | `src/skills/` | `onSystemPromptBuild`, `registerTools` |
| prompts | `src/prompts/` | `onCommand` hook |
| tools (core) | `src/tools/` | `registerTools` hook |
| subcommands | `src/ui/*.js` | CLI dispatch → extension entry points |
| session log | `src/session_log.js` | `onMessage` hook |
| compaction strategies | `src/compaction/strategies*` | Part of compaction extension |
| model registry | `src/config.js` | Part of config resolution |

---

## Part 1: The Core (Target State)

### 1.1 Minimal Message Format

The core needs only one message type. Everything else is extension concerns.

```javascript
// core/message.js
export class Message {
  constructor({ role, content, reasoningContent, toolCalls, toolCallId }) {
    this.role = role;        // "system" | "user" | "assistant" | "tool"
    this.content = content;
    this.reasoningContent = reasoningContent;
    this.toolCalls = toolCalls;
    this.toolCallId = toolCallId;
  }

  toJSON() {
    // Minimal — only what the LLM API needs
    const obj = { role: this.role, content: this.content ?? "" };
    if (this.reasoningContent) obj.reasoning_content = this.reasoningContent;
    if (this.toolCalls) obj.tool_calls = this.toolCalls;
    if (this.toolCallId) obj.tool_call_id = this.toolCallId;
    return obj;
  }
}
```

**What this eliminates:**
- `SystemMessage` class (just a Message with role="system")
- `SessionLog` factory functions (`createInputEntry`, `createAssistantEntry`, etc.) — those become an extension that listens to `onMessage` events
- `replayEntriesIntoContext()` — becomes an extension that reads JSONL and emits messages
- `stripNulls()` — the core serializes consistently; extensions handle their own format differences

### 1.2 Hook/Event System

The core exposes hooks. Extensions register handlers.

```javascript
// core/hooks.js
export class HookSystem {
  constructor() {
    this._hooks = new Map();  // hookName → [handler, ...]
  }

  on(hookName, handler) {
    if (!this._hooks.has(hookName)) this._hooks.set(hookName, []);
    this._hooks.get(hookName).push(handler);
  }

  emit(hookName, data) {
    const handlers = this._hooks.get(hookName) || [];
    for (const handler of handlers) {
      handler(data);
    }
  }

  // Async hooks — all handlers run, errors don't stop the chain
  async emitAsync(hookName, data) {
    const handlers = this._hooks.get(hookName) || [];
    for (const handler of handlers) {
      try { await handler(data); } catch (e) {
        console.error(`[hook:${hookName}] ${e.message}`);
      }
    }
  }
}
```

**Core hooks:**

```javascript
// Hook names and their data shapes
const HOOKS = {
  // Session lifecycle
  "session:create":     { session, config },
  "session:swap":       { oldAgent, newAgent },
  "session:serialize":  { session },
  "session:deserialize":{ session, data },

  // Agent run loop
  "agent:beforeRun":    { userInput },
  "agent:afterRun":     { iterations, outcome },
  "agent:cancelled":    {},

  // Message flow (before LLM call)
  "messages:build":     { messages, agent },      // hook can modify messages
  "messages:afterLLM":  { response, messages },   // after LLM returns

  // Tool execution
  "tools:register":     { registry, agent },      // extensions register tools here
  "tool:beforeExecute": { toolName, input, agent },
  "tool:afterExecute":  { toolName, result, agent },

  // Context management
  "context:full":       { agent, contextSize },   // trigger compaction extension
  "context:message":    { message, agent },        // log, transform, etc.

  // System prompt
  "systemPrompt:build": { agent, promptBuilder },  // extensions add to prompt

  // Commands
  "command:dispatch":   { command, agent },        // extensions handle commands

  // Output
  "output:event":       { event, data },           // all output flows through here
};
```

### 1.3 Extension Loader

```javascript
// core/extensions.js
export class ExtensionLoader {
  constructor(core) {
    this._core = core;
    this._extensions = new Map();
  }

  // Load an extension by path or name
  async load(name, entryPoint) {
    const ext = typeof entryPoint === 'string'
      ? await import(entryPoint)
      : entryPoint;

    const instance = ext.create
      ? ext.create(this._core)
      : ext;

    this._extensions.set(name, instance);

    // Auto-register hooks if the extension has them
    if (instance.hooks) {
      for (const [hookName, handler] of Object.entries(instance.hooks)) {
        this._core.hooks.on(hookName, handler);
      }
    }

    // Auto-register tools
    if (instance.registerTools) {
      await instance.registerTools(this._core.toolRegistry);
    }

    return instance;
  }

  // Hot-reload: unload and reload
  async reload(name, entryPoint) {
    await this.unload(name);
    return await this.load(name, entryPoint);
  }

  async unload(name) {
    const ext = this._extensions.get(name);
    if (ext?.shutdown) await ext.shutdown();
    this._extensions.delete(name);
  }

  get(name) {
    return this._extensions.get(name);
  }

  all() {
    return Array.from(this._extensions.entries());
  }
}
```

### 1.4 Config Schema

Core defines its keys. Extensions declare their keys.

```javascript
// core/config.js
export const CORE_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    // Core keys
    model: { type: "string" },
    baseUrl: { type: "string" },
    apiKey: { type: "string" },
    profile: { type: "string" },
    profiles: { type: "object" },
    providers: { type: "array" },
    theme: { type: "string" },
    colors: { type: "object" },
    noLog: { type: "boolean" },
    hideTools: { type: "boolean" },
    hideThinking: { type: "boolean" },
    showTokenUse: { type: "boolean" },
    maxIterations: { type: "integer" },
    maxTokens: { type: "integer" },
    chatTimeoutSecs: { type: "integer" },
    role: { type: "string" },
    skillsPath: { type: "string" },
    profilesPath: { type: "string" },
    promptsPath: { type: "string" },

    // Extension keys (namespace by extension name)
    // These are passed through — extensions validate their own keys
    compaction: { type: "object" },
    lsp: { type: "object" },
    mcpServers: { type: "array" },
    fetch: { type: "object" },
  },
};

// Extensions register their config keys
export function registerExtensionConfig(extName, schema) {
  // Merge into core schema at extName key
}
```

### 1.5 The Core Agent Loop

```javascript
// core/agent.js — the entire run loop, ~150 lines
export class Agent {
  constructor(options) {
    this._hooks = options.hooks;
    this._toolRegistry = options.toolRegistry;
    this._llmClient = options.llmClient;
    this._context = [];  // minimal: just Message[]
    this._model = options.model;
    this._maxIterations = options.maxIterations || 1000;
  }

  async run(userInput) {
    this._hooks.emit("agent:beforeRun", { userInput });

    // Add user input
    this._context.push(new Message({ role: "user", content: userInput }));
    this._hooks.emit("context:message", { message: this._context[this._context.length - 1] });

    let iteration = 0;
    while (iteration < this._maxIterations) {
      iteration++;

      // Hook: build messages (extensions can modify)
      const messages = this._buildMessages();
      await this._hooks.emitAsync("messages:build", { messages, agent: this });

      // Check context size — trigger compaction extension if needed
      if (this._context.length > this._maxIterations / 10) {
        await this._hooks.emitAsync("context:full", {
          agent: this,
          contextSize: this._context.length,
        });
      }

      // LLM call
      const toolDefs = this._toolRegistry.getToolDefs();
      const modelConfig = this._resolveModelConfig();
      const stream = this._llmClient.chatStreamCancellable(
        messages, modelConfig, toolDefs, { aborted: this._cancelled }
      );

      const response = await this._processStream(stream);
      await this._hooks.emitAsync("messages:afterLLM", {
        response, messages: this._context
      });

      // Tool execution
      if (response.finalToolCalls) {
        const outcome = await this._executeTools(response.finalToolCalls);
        if (outcome !== "continue") return outcome;
      } else {
        this._context.push(new Message({
          role: "assistant", content: response.fullText
        }));
        return response.fullText;
      }
    }

    throw new Error(`Max iterations (${this._maxIterations}) reached`);
  }

  _buildMessages() {
    // Core only knows about messages + system prompt
    // System prompt is built via hooks (extensions add to it)
    return this._systemPrompt
      ? [new Message({ role: "system", content: this._systemPrompt }), ...this._context]
      : [...this._context];
  }

  async _processStream(stream) {
    // Same as now — stream processing is core, not extension
    let fullText = "";
    let fullReasoning = null;
    const toolCallsBuffer = new Map();

    for await (const event of stream) {
      switch (event.type) {
        case "content": fullText += event.content; break;
        case "reasoning":
          fullReasoning = (fullReasoning || "") + event.content; break;
        case "toolName":
          toolCallsBuffer.set(event.index, { name: event.name, args: "", id: event.toolCallId || "" });
          break;
        case "toolArgument":
          toolCallsBuffer.get(event.index).args += event.arguments;
          break;
        case "usage":
          this._hooks.emit("output:event", { type: "token_usage", data: event.data });
          break;
      }
    }

    const finalToolCalls = Array.from(toolCallsBuffer.values()).map((tc, i) => ({
      id: tc.id || `call_${i}_${Date.now()}`,
      type: "function",
      function: { name: tc.name, arguments: tc.args },
    }));

    return { fullText, fullReasoning, finalToolCalls, usage: null };
  }

  async _executeTools(toolCalls) {
    for (const tc of toolCalls) {
      const toolName = tc.function?.name;
      const input = tc.function?.arguments || "{}";

      await this._hooks.emitAsync("tool:beforeExecute", { toolName, input, agent: this });

      const tool = this._toolRegistry.get(toolName);
      if (!tool) {
        this._context.push(new Message({
          role: "tool", content: `Unknown tool: ${toolName}`,
          toolCallId: tc.id
        }));
        continue;
      }

      let result;
      try {
        result = await tool.execute(input, { agent: this });
      } catch (e) {
        result = `Error: ${e.message}`;
      }

      await this._hooks.emitAsync("tool:afterExecute", { toolName, result, agent: this });

      this._context.push(new Message({
        role: "tool", content: String(result), toolCallId: tc.id
      }));
    }
    return "continue";
  }
}
```

### 1.6 The Core Session Manager

```javascript
// core/session.js — session lifecycle, ~100 lines
export class SessionManager {
  constructor(options) {
    this._hooks = options.hooks;
    this._extensions = options.extensions;
    this._agents = new Map();
    this._currentSessionId = null;
    this._serializer = options.serializer;  // for session persistence
  }

  async create(config) {
    const agent = await this._buildAgent(config);
    const sessionId = crypto.randomUUID();
    this._agents.set(sessionId, agent);
    this._currentSessionId = sessionId;
    this._hooks.emit("session:create", { session: this, config });
    return sessionId;
  }

  async swap(config) {
    const oldAgent = this._agents.get(this._currentSessionId);
    const newAgent = await this._buildAgent(config);
    this._agents.set(newAgent.sessionId, newAgent);
    this._currentSessionId = newAgent.sessionId;
    this._hooks.emit("session:swap", { oldAgent, newAgent });
    return newAgent;
  }

  getAgent() {
    return this._agents.get(this._currentSessionId);
  }

  switch(sessionId) {
    const agent = this._agents.get(sessionId);
    if (agent) this._currentSessionId = sessionId;
    return agent;
  }

  serialize() {
    const agent = this.getAgent();
    return this._serializer?.serialize(agent) ?? {
      sessionId: this._currentSessionId,
      context: agent._context.map(m => m.toJSON()),
      model: agent._model,
    };
  }

  async deserialize(data) {
    // Extensions can hook into deserialization
    await this._hooks.emitAsync("session:deserialize", { data });
    // Core restores context
    const agent = await this._buildAgent({ model: data.model });
    agent._context = data.context.map(m => new Message(m));
    this._agents.set(data.sessionId, agent);
    this._currentSessionId = data.sessionId;
    return agent;
  }

  async _buildAgent(config) {
    // Core creates a minimal agent
    // Extensions hook into via hooks to add their pieces
    return new Agent({
      hooks: this._hooks,
      toolRegistry: this._extensions.toolRegistry,
      llmClient: this._buildLlmClient(config),
      model: config.model,
      maxIterations: config.maxIterations,
    });
  }
}
```

---

## Part 2: Extensions (What Moves Out)

### 2.1 Compaction Extension

**Current:** `src/compaction/` (~400 lines across strategies.js + 4 strategy files)

```javascript
// extensions/compaction/index.js
export function create(core) {
  return {
    hooks: {
      "context:full": async ({ agent, contextSize }) => {
        const config = core.config.compaction;
        if (!config?.enabled) return;
        if (contextSize <= (config.keepRecent || 3) * 2) return;

        const strategy = core.extensions.get(`compaction-${config.strategy || "summarize"}`);
        if (!strategy) return;

        const result = await strategy.execute(agent._context, config);
        if (result) {
          // Replace old messages with summary
          agent._context = [
            new Message({ role: "user", content: `<m_ckga3qxdoia7896k>${result.summary}</m_ckga3qxdoia7896k>` }),
            ...agent._context.slice(-result.keepRecent),
          ];
          core.hooks.emit("output:event", { type: "compaction_result", data: result });
        }
      },
    },

    // Sub-strategies as separate loadable modules
    strategies: {
      summarize: async (messages, config, llmChat) => {
        const toSummarize = messages.slice(0, -config.keepRecent);
        const summary = await llmChat(toSummarize);
        return { messagesCompacted: toSummarize.length, summary, keepRecent: config.keepRecent };
      },
      drop: async (messages, config) => {
        const toDrop = messages.slice(0, -config.keepRecent);
        return { messagesCompacted: toDrop.length, summary: null, keepRecent: config.keepRecent };
      },
      summarizeShort: async (messages, config, llmChat) => {
        // Summarize everything except last 1 pair
        const toSummarize = messages.slice(0, -2);
        const summary = await llmChat(toSummarize);
        return { messagesCompacted: toSummarize.length, summary, keepRecent: 1 };
      },
      tokenAware: async (messages, config, llmChat) => {
        // Token-budget-aware compaction
        const target = config.targetTokens || 16384;
        // ... estimate tokens, find cutoff, summarize
      },
    },
  };
}
```

### 2.2 LSP Extension

**Current:** `ext/lsp/` (~20 files)

```javascript
// extensions/lsp/index.js
export function create(core) {
  const config = core.config.lsp;
  if (!config?.enabled) return null;  // Don't load if disabled

  return {
    hooks: {
      "tools:register": async (registry) => {
        const client = await LspClient.connect(config);
        for (const toolName of LSP_TOOL_NAMES) {
          const tool = createLspTool(toolName, client, config);
          if (tool) registry.register(toolName, tool);
        }
      },
    },
    // Hot-reload: reconnect LSP server
    async reload() {
      // Reconnect, re-register tools
    },
  };
}
```

### 2.3 MCP Extension

**Current:** `src/mcp/` (~5 files)

```javascript
// extensions/mcp/index.js
export function create(core) {
  const servers = core.config.mcpServers || [];
  return {
    hooks: {
      "session:create": async ({ config }) => {
        for (const serverConfig of servers) {
          if (serverConfig.enabled === false) continue;
          const connection = await McpConnection.connect(serverConfig);
          for (const toolDef of connection.tools) {
            const tool = new McpTool(connection, toolDef);
            core.extensions.toolRegistry.register(`${connection.serverName}/${toolDef.name}`, tool);
          }
        }
      },
    },
  };
}
```

### 2.4 Skills Extension

**Current:** `src/skills/` (~310 lines)

```javascript
// extensions/skills/index.js
export function create(core) {
  return {
    hooks: {
      "systemPrompt:build": async ({ promptBuilder, agent }) => {
        const skillsLoader = new SkillsLoader(core.config.skillsPath);
        skillsLoader.loadSkills();
        skillsLoader.preloadSkills(agent._preloadSkills || []);

        // Add skills to system prompt
        const preamble = buildSkillsPreamble(skillsLoader);
        if (preamble) promptBuilder.add(preamble);

        // Store for tool filtering
        agent._skillsLoader = skillsLoader;
      },

      "tools:register": async (registry, agent) => {
        // Register load_skill tool
        registry.register("load_skill", new LoadSkillTool(agent._skillsLoader));

        // Filter other tools by skill patterns
        const patterns = agent._skillsLoader.combinedToolPatterns();
        // ... apply filtering
      },

      "command:dispatch": async ({ command, agent }) => {
        if (command.type === "skill") {
          if (command.value) {
            agent._skillsLoader.activateSkill(command.value);
            return { content: `Skill '${command.value}' activated.` };
          } else {
            const skills = agent._skillsLoader.allSkills();
            return { content: formatSkillList(skills) };
          }
        }
      },
    },
  };
}
```

### 2.5 Prompts Extension

**Current:** `src/prompts/` (~loader.js)

```javascript
// extensions/prompts/index.js
export function create(core) {
  return {
    hooks: {
      "command:dispatch": async ({ command, agent }) => {
        if (command.type === "prompt") {
          const promptsLoader = new PromptsLoader(core.config.promptsPath);
          const prompt = promptsLoader.getPrompt(command.value.name);
          if (!prompt) return { error: `Unknown prompt: ${command.value.name}` };

          const rendered = command.value.args
            ? renderTemplate(prompt.content, { ARGS: command.value.args })
            : prompt.content;

          agent._context.push(new Message({ role: "user", content: rendered }));
          return { content: `Prompt '${command.value.name}' executed.` };
        }
      },
    },
  };
}
```

### 2.6 Session Log Extension

**Current:** `src/session_log.js` (~462 lines)

```javascript
// extensions/session-log/index.js
export function create(core) {
  const sessionId = crypto.randomUUID();
  const logPath = join(cacheDir(), "sessions", `${sessionId}.jsonl`);

  return {
    hooks: {
      "context:message": ({ message }) => {
        appendFileSync(logPath, JSON.stringify(toLogEntry(message)) + "\n");
      },
      "tool:afterExecute": ({ toolName, result }) => {
        // Log tool results separately
      },
      "output:event": ({ type, data }) => {
        if (type === "compaction_result") {
          appendFileSync(logPath, JSON.stringify({
            source: "compaction", summary: data.summary
          }) + "\n");
        }
      },
    },

    // Session replay: load previous logs and emit messages
    async replay(previousSessionId) {
      const entries = readSessionEntries(previousSessionId);
      for (const entry of entries) {
        const message = Message.fromLogEntry(entry);
        core.hooks.emit("context:message", { message });
        // Agent adds to context
      }
    },
  };
}
```

### 2.7 Subcommands Extension

**Current:** `src/ui/info.js`, `src/ui/review.js`, `src/ui/show_prompt.js`

```javascript
// extensions/subcommands/index.js
export function create(core) {
  return {
    // CLI dispatch routes to extension handlers
    cli: {
      "info": () => runInfo(core),
      "review": (cli) => runReview(cli, core),
      "show-prompt": (cli) => runShowPrompt(cli, core),
    },
  };
}
```

### 2.8 Core Tools Extension

**Current:** `src/tools/` (~15 files, ~2,000 lines)

```javascript
// extensions/core-tools/index.js
export function create(core) {
  return {
    hooks: {
      "tools:register": async (registry) => {
        const tools = [
          { name: "bash", cls: BashTool },
          { name: "read", cls: ReadTool },
          { name: "write", cls: WriteTool },
          { name: "edit", cls: EditTool },
          { name: "grep", cls: GrepTool },
          { name: "find", cls: FindTool },
          { name: "fetch", cls: FetchTool },
          { name: "question", cls: QuestionTool },
          { name: "pager", cls: PagerTool },
          { name: "model", cls: ModelTool },
          { name: "load_skill", cls: LoadSkillTool },
          { name: "explore", cls: ExploreTool },
          { name: "review", cls: ReviewTool },
          { name: "project_info", cls: ProjectInfoTool, disabled: true },
        ];

        for (const { name, cls, disabled } of tools) {
          if (disabled) continue;
          registry.register(name, new cls());
        }
      },
    },
  };
}
```

### 2.9 Output/UI Extension

**Current:** `src/ui/cli.js`, `src/ui/colors.js`, `src/ui/session.js`

```javascript
// extensions/ui-cli/index.js
export function create(core) {
  const palette = resolvePalette(core.config);
  const sink = new CliOutputSink({ palette, core });

  return {
    hooks: {
      "output:event": ({ type, data }) => {
        sink.emit({ type, ...data });
      },
    },

    // Interactive session
    async runSession(sessionManager) {
      // Readline loop — delegates to core
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.prompt();

      rl.on("line", async (line) => {
        if (line.startsWith("/")) {
          await sessionManager.getAgent().executeCommand(parseCommand(line.slice(1)));
        } else {
          await sessionManager.getAgent().run(line);
        }
        rl.prompt();
      });
    },
  };
}
```

### 2.10 Model Registry Extension

**Current:** `src/config.js` — `buildModelRegistry()`

```javascript
// extensions/model-registry/index.js
export function create(core) {
  return {
    hooks: {
      "session:create": async ({ config }) => {
        const registry = buildModelRegistry(config);
        core.modelRegistry = registry;
      },
    },
  };
}
```

---

## Part 3: Revised Implementation Order

| Phase | What | Impact |
|-------|------|--------|
| **0** | Hook system + Extension loader | Foundation — everything depends on this |
| **1** | Minimal core: Message, Agent loop, SessionManager | Replace current monolith |
| **2** | Config: core schema + extension namespaces | Clean separation |
| **3** | Move compaction to extension | Biggest single extraction |
| **4** | Move tools to extension | Core no longer knows about tools |
| **5** | Move skills, prompts, session-log to extensions | Core is now ~500 lines |
| **6** | Move LSP, MCP to extensions | Already partially externalized |
| **7** | Move subcommands, UI to extensions | CLI becomes an extension |

### Phase 0: Hook System 

This is the single most important change. Without hooks, nothing can be an extension.

Estimated effort: ~100 lines. Low risk.

**Completed:**
- `src/core/hooks.js` — HookSystem with sync/async/sequential emit, HOOKS constants
- `src/core/extensions.js` — ExtensionLoader with load/unload/reload lifecycle
- `src/core/tool-registry.js` — Minimal tool registry for extension tool registration
- `src/core/index.js` — Barrel exports
- 36 tests across 3 test files (all passing)

### Phase 1: Minimal Core 

Rewrite Agent and SessionManager to use hooks instead of internal methods.

Estimated effort: ~500 lines rewritten. Medium risk — need to ensure all current behavior works.

**Completed:**
- `src/core/agent.js` — Minimal Agent (~380 lines) with hook-based run loop
- `src/core/session.js` — SessionManager (~180 lines) + SessionStore
- 36 new tests (agent + session)
- Total: 71 tests across 5 files (all passing)

### Phase 2: Config 

Restructure config into core schema + extension namespaces.

Estimated effort: ~200 lines. Low risk.

**Completed:**
- `src/core/config.js` — Config schema, defaults, resolution helpers (~300 lines)
- `tests/core_config.test.js` — 33 tests
- Total: 104 tests across 6 files (all passing)

### Phase 3: Move compaction to extension 

Move `src/compaction/` to `extensions/compaction/`.

**Completed:**
- `extensions/compaction/index.js` — Extension entry point (140 lines)
- `extensions/compaction/utils.js` — Token estimation, serialization (100 lines)
- `extensions/compaction/prompts.js` — Summarization prompts (70 lines)
- `extensions/compaction/strategies.js` — Strategy registry + base class (50 lines)
- `extensions/compaction/strategies/summarize.js` — LLM summarization (50 lines)
- `extensions/compaction/strategies/drop.js` — Drop without summary (40 lines)
- `extensions/compaction/strategies/summarize-short.js` — Aggressive summarization (60 lines)
- `extensions/compaction/strategies/token-aware.js` — Token-aware compaction (90 lines)
- `tests/compaction_extension.test.js` — 26 tests
- Total: 130 tests across 7 files (all passing)

### Phase 4-7: Extract Remaining Extensions

Each extension is a self-contained module. Move code, wire up hooks, test.

---

## Part 4: What the Core Looks Like After

```
src/
├── core/                    # The minimal core (~500 lines)
│   ├── hooks.js             # Hook system
│   ├── message.js           # Minimal Message class
│   ├── agent.js             # Agent run loop (~150 lines)
│   ├── session.js           # SessionManager (~100 lines)
│   ├── extensions.js        # Extension loader
│   ├── config.js            # Core config schema
│   ├── tool-registry.js     # Tool registration (extensions fill this)
│   └── llm-client.js        # LLM HTTP client (stays in core)
├── main.js                  # Load extensions, create core, run
├── cli.js                   # CLI arg parsing
├── config.js                # Load config file, pass to core
│
└─ extensions/               # Everything else
   ├── core-tools/           # bash, read, write, edit, grep, find, etc.
   ├── compaction/           # All compaction strategies
   ├── skills/               # Skills loader + activation
   ├── prompts/              # Prompt templates
   ├── session-log/          # JSONL audit trail
   ├── lsp/                  # LSP tools (already partially external)
   ├── mcp/                  # MCP connections
   ├── ui-cli/               # CLI output + readline session
   ├── subcommands/          # info, review, show-prompt
   └── model-registry/       # Provider/model resolution
```

**Core total: ~500 lines** (down from ~13,900)
**Extensions: ~13,400 lines** (same code, reorganized)

---

## Appendix: Hook Data Flow

```
User types "hello"
  → SessionManager.create() → hooks.emit("session:create")
  → Agent.run("hello")
    → hooks.emit("agent:beforeRun", { userInput: "hello" })
    → hooks.emit("context:message", { message: UserMessage("hello") })
    → hooks.emit("messages:build", { messages: [...] })
      ← skills extension adds skills preamble to messages
      ← prompts extension adds prompt content
    → LLM call
    → hooks.emit("messages:afterLLM", { response, messages })
    → hooks.emit("tool:beforeExecute", { toolName: "bash", input: "ls" })
    → tool.execute() → result
    → hooks.emit("tool:afterExecute", { toolName: "bash", result: "..." })
    → hooks.emit("context:message", { message: ToolResultMessage(...) })
    → hooks.emit("output:event", { type: "tool_result", data: {...} })
      ← ui-cli extension renders to terminal
    → hooks.emit("context:full", { contextSize: 50 })
      ← compaction extension triggers if needed
    → hooks.emit("agent:afterRun", { iterations: 3, outcome: "..." })
```

Each hook is a clear extension point. No core code needs to know about compaction, skills, LSP, or tools — they all plug in via hooks.
