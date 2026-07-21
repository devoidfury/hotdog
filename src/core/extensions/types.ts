// Shared types for the extension system.
// Describes the contract between core and extensions.

import type {
  HookSystem,
  GateAction,
  ContextHookResult,
  ProviderRequestHookResult,
  ToolResultHookResult,
  InputHookResult,
  SystemPromptChunk,
} from "../hooks.ts";
import type { ToolRegistry, ToolDef } from "./tool-registry.ts";
import type { ExtensionLoader } from "./extensions.ts";
import type { ServiceRegistry } from "./service-registry.ts";
import type { CliSubcommandRegistry } from "./registries.ts";
import type { ConfigRegistry } from "./config-registry.ts";
import type { ModelConfig } from "../config/providers.ts";
import type { CoreConfig } from "../config/schema-loader.ts";
import type { Agent } from "../agent.ts";
import type { Message } from "../context/message.ts";
import type { ParsedCommand } from "../commands.ts";
import type { ToolContext } from "./tool-context.ts";
import { logger } from "../logger.ts";

// ── Hook Payload Types ──────────────────────────────────────────────────────

/**
 * Payload shapes for every standard hook name.
 * Each key maps to the data object passed to handlers registered on that hook.
 *
 * Return types for pipeline hooks are documented in each entry:
 * - Gate hooks (tool:call, input): return GateAction
 * - Context hooks (context): return ContextHookResult
 * - Provider hooks (provider:request): return ProviderRequestHookResult
 * - Tool result hooks (tool:result): return ToolResultHookResult
 * - System prompt hooks (systemPrompt:build): return SystemPromptChunk | SystemPromptChunk[]
 */
export interface HookPayloads {
  // Session lifecycle
  "session:create": { session: unknown; config: Record<string, unknown> };
  "session:swap": { oldAgent: unknown; newAgent: unknown };
  "session:serialize": { agent: unknown };
  "session:deserialize": { data: Record<string, unknown> };
  "session:restoreActive": { agent: unknown; isRestoring: boolean };

  // Tool context enrichment
  "agent:toolContext": { toolCtx: ToolContext; toolName: string; agent: Agent };

  // Model changes
  "model:change": { agent: Agent; oldModel: string; newModel: string };

  // Message flow after LLM
  "messages:afterLLM": { response: unknown; messages: Message[]; agent: Agent };

  // Tool execution lifecycle
  "tools:register": ToolsRegisterPayload;
  "tool:beforeExecute": { toolCallId: string; toolName: string; input: string; agent: Agent };
  "services:register": ServiceRegistry;
  "tool:afterExecute": {
    toolCallId: string;
    toolName: string;
    result: unknown;
    input: string;
    agent: Agent;
    success: boolean;
  };
  "loop:detected": { agent: Agent };
  "tool:metrics": {
    toolName: string;
    toolCallId: string;
    durationMs: number;
    success: boolean;
    resultSize: number;
    input: string;
    agent: Agent;
  };

  // Context management
  "context:message": { message: Message; agent: Agent };
  "context:replaced": { agent: Agent; oldContext: Message[]; newContext: Message[] };

  // System prompt — handlers return SystemPromptChunk or SystemPromptChunk[]
  "systemPrompt:build": { agent: Agent };

  // Commands
  "command:dispatch": { command: ParsedCommand; agent: Agent };
  "commands:register": CommandsRegisterPayload;

  // Output
  "output:event": { type: string; data: unknown; agent: Agent };

  // Shutdown
  "shutdown:cleanup": unknown;

  // CLI
  "cli:subcommandsRegister": CliSubcommandRegistry;
  "cli:argsParsed": { cli: Record<string, unknown> };

  // Input preprocessing — return InputHookResult
  //   { action: "continue" }
  //   { action: "transform", text, images? }
  //   { action: "handled" }
  "input": { text: string; images: unknown[] | null };

  // Context modification pipeline — return ContextHookResult
  //   { messages } — replace the messages array
  "context": { messages: Message[]; agent: Agent };

  // Tool call gate — return GateAction
  //   { action: "continue" }
  //   { action: "modify", input }
  //   { action: "block", result }
  "tool:call": { toolCallId: string; toolName: string; input: string; agent: Agent };

  // Tool result modification — return ToolResultHookResult
  //   { result } — replace the result
  "tool:result": {
    toolCallId: string;
    toolName: string;
    result: unknown;
    success: boolean;
    input: string;
    agent: Agent;
  };

  // Provider request — return ProviderRequestHookResult
  //   { messages } — replace the messages array
  //   { modelConfig } — replace the model config
  //   { toolDefs } — replace the tool definitions
  "provider:request": {
    messages: Message[];
    modelConfig: ModelConfig;
    toolDefs: ToolDef[];
    agent: Agent;
  };

  // Provider response — emitted AFTER the LLM response is fully received
  "provider:response": { response: unknown; modelConfig: ModelConfig; agent: Agent };

  // Turn lifecycle
  "turn:start": { turnIndex: number; timestamp: number; agent: Agent };
  "turn:end": {
    turnIndex: number;
    message: string;
    toolResults: Array<{ toolName: string; input: string; result: string }>;
    stopped: boolean;
    cancelled?: boolean;
    agent: Agent;
  };

  // Logging
  "log": { level: string; message: string; metadata?: Record<string, unknown> };
}

/**
 * Derive the handler type for a given hook name.
 * Re-exported for convenience; aliases HookHandler from hooks.ts.
 */
export type HookHandlerFor<K extends keyof HookPayloads> =
  (payload: HookPayloads[K]) => void | Promise<void> | unknown;

/**
 * Expected return types for pipeline hooks.
 * Used by callers to type-check hook results.
 */
export interface HookReturnTypes {
  "tool:call": GateAction;
  "input": InputHookResult;
  "context": ContextHookResult;
  "tool:result": ToolResultHookResult;
  "provider:request": ProviderRequestHookResult;
  "systemPrompt:build": SystemPromptChunk | SystemPromptChunk[];
}

// ── Core Context ─────────────────────────────────────────────────────────────

/**
 * The `core` object passed to every extension's `create(core)` function.
 * This is the single source of truth for what extensions can access.
 */
export interface CoreContext {
  /** Hook system for registering event handlers. */
  hooks: HookSystem;

  /** Registry of all available tools. */
  toolRegistry: ToolRegistry;

  /** Extension loader for managing extension lifecycle. */
  extensions: ExtensionLoader;

  /** Service registry for abstract service implementations. */
  services: ServiceRegistry;

  /** Resolved configuration, including extension-specific config blocks. */
  config: CoreConfig & Record<string, unknown>;

  /** CLI subcommand registry. */
  cliSubcommandRegistry: CliSubcommandRegistry;

  /** Config registry for extension-registered CLI flags, config params, and schemas. */
  configRegistry: ConfigRegistry;

  /**
   * Look up a registered service by name.
   */
  service(name: string): unknown;

  /**
   * Resolved build-time config (providers, model registry, etc.).
   * Attached after buildConfig() resolves.
   */
  resolved?: ResolvedConfig;

  /**
   * Optional buildConfig function, available for subcommand handlers
   * that need to rebuild config at runtime.
   */
  buildConfig?: (cli: Record<string, unknown>) => Promise<{
    resolved: Record<string, unknown>;
    modelRegistry: Record<string, ModelConfig>;
    providers: unknown[];
  }>;
}

/**
 * Resolved configuration attached to core after buildConfig().
 * Includes all resolved schema keys plus agent-specific extras.
 */
export interface ResolvedConfig {
  modelRegistry?: Record<string, ModelConfig>;
  activeProvider?: string;
  profile?: Record<string, unknown>;
  profileName?: string;
  configDir?: string;
  [key: string]: unknown;
}

// ── Extension Return Type ────────────────────────────────────────────────────

/**
 * Shape of the object an extension's `create()` function returns.
 *
 * Hook handlers are keyed by hook name (e.g., HOOKS.TOOLS_REGISTER).
 * The type system checks that the handler function matches the expected payload
 * for that hook name.
 */
export type ExtensionInstance = {
  /**
   * Hook handlers keyed by hook name.
   * Only known hook names from HookPayloads are allowed.
   *
   * Each handler receives the typed payload for that hook name, ensuring
   * type-safe access to hook data at compile time.
   *
   * Pipeline hooks should return the appropriate type:
   * - tool:call → GateAction ({ action: "continue"|"block"|"modify" })
   * - input → InputHookResult ({ action: "continue"|"transform"|"handled" })
   * - context → ContextHookResult ({ messages })
   * - tool:result → ToolResultHookResult ({ result })
   * - provider:request → ProviderRequestHookResult ({ messages?, modelConfig?, toolDefs? })
   * - systemPrompt:build → SystemPromptChunk | SystemPromptChunk[]
   */
  hooks?: {
    [K in keyof HookPayloads]?: (payload: HookPayloads[K]) => void | Promise<void> | unknown;
  };

  /**
   * Optional shutdown hook called during extension unload.
   */
  shutdown?: () => Promise<void>;

  /**
   * Optional legacy tool registration method.
   */
  registerTools?: (registry: ToolRegistry) => Promise<void>;

  /**
   * Arbitrary extension-specific properties exposed for external use.
   */
  [key: string]: unknown;
};

// ── Specific Hook Payload Types ──────────────────────────────────────────────

/**
 * Payload for the `tools:register` hook.
 */
export interface ToolsRegisterPayload {
  register(name: string, tool: unknown): void;
  getAll(): [string, unknown][];
}

/**
 * Payload for the `commands:register` hook.
 * Carries the agent's command registry and the agent instance.
 */
export interface CommandsRegisterPayload {
  /** The agent's command registry for registering slash commands. */
  registry: { register(name: string, definition: Record<string, unknown>): void };
  /** The agent instance for accessing agent state. */
  agent: unknown;
}

// ── Tool Execution Context ───────────────────────────────────────────────────

/**
 * Context passed to tool `execute()` methods.
 * Provides access to shared state and configuration.
 */
export type ToolExecutionContext = ToolContext;

// ── Extension Config Helpers ─────────────────────────────────────────────────

/**
 * Safely extract an extension's config block from core.config.
 * Generic type T allows extensions to declare their expected config shape.
 *
 * Runtime validation: if the config registry has a schema registered for this key,
 * the value is validated against it and a warning is logged on mismatch.
 * Also warns if the extension that owns this key is not loaded.
 */
export function getExtensionConfig<T = Record<string, unknown>>(
  core: CoreContext,
  key: string,
): T {
  const block = core.config?.[key];

  // Runtime validation: check schema if registered
  if (core.configRegistry) {
    const result = core.configRegistry.validateConfigByKey(key, block);
    if (!result.valid) {
      logger.warn(
        `[config] Extension config "${key}" validation failed: ${result.errors.join("; ")} ` +
        `— config may be ignored or have unexpected values`,
      );
    }
  }

  // Note: we don't check if the extension is loaded here because config keys
  // may not match extension names — an extension can define multiple config
  // keys with arbitrary names. The schema validation above is the right check.

  if (block && typeof block === "object" && !Array.isArray(block)) {
    return block as T;
  }
  return {} as T;
}

/**
 * Safely extract schema defaults from an extension's configSchema.
 */
export function getConfigSchemaProperties<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  configSchema: Record<string, unknown> | null | undefined,
  key: string,
): T {
  const block = configSchema?.[key];
  if (block && typeof block === "object" && !Array.isArray(block)) {
    const props = (block as Record<string, unknown>).properties;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      return props as T;
    }
  }
  return {} as T;
}

/**
 * Get a default value from a config schema property.
 */
export function getConfigDefault<T = unknown>(
  props: Record<string, unknown>,
  propName: string,
): T | undefined {
  const prop = props[propName];
  if (prop && typeof prop === "object" && !Array.isArray(prop)) {
    const defaultVal = (prop as Record<string, unknown>).default;
    // Treat null as "no default" to avoid overwriting user-provided values with null
    if (defaultVal === null) return undefined;
    return defaultVal as T | undefined;
  }
  return undefined;
}
