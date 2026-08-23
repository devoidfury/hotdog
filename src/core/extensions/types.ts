// Contract between core and extensions.

import type {
  HookSystem,
  GateAction,
  ContextHookResult,
  ProviderRequestHookResult,
  ToolResultHookResult,
  InputHookResult,
  SystemPromptChunk,
} from "../hooks.ts";
import type { CliSubcommandRegistryLike } from "./registries.ts";

export type {
  GateAction,
  ContextHookResult,
  ProviderRequestHookResult,
  ToolResultHookResult,
  InputHookResult,
  SystemPromptChunk,
} from "../hooks.ts";
import type { ToolRegistry, ToolDef, Tool, ToolMetadata } from "./tool-registry.ts";
import type { ExtensionLoader } from "./extensions.ts";
import type { ServiceRegistry } from "./service-registry.ts";
import type { AgentCommandRegistry, CliSubcommandRegistry } from "./registries.ts";
import type { ToolFormatRegistry } from "./tool-format.ts";
import type { LlmProtocolRegistry } from "../llm-client/protocol.ts";
import type { ConfigRegistry } from "./config.ts";
import type { ModelConfig, ProviderDef } from "../config/providers.ts";
import type { BuildAgentConfig } from "../config/index.ts";
import type { CoreConfigWithExtensions } from "../config/schema-loader.ts";
import type { Agent } from "../agent.ts";
import type { AgentLike } from "../session/index.ts";
import type { ImageAttachment, Message, MessageSource } from "../context/message.ts";
import type { ParsedCommand } from "../commands.ts";
import type { ToolContext } from "./tool-context.ts";
export type { ToolContext };
import type { StreamResult } from "../llm-client/stream-processor.ts";
import type { LlmClient, LlmClientOptions } from "../llm-client/client.ts";
import { logger } from "../logger.ts";
import { ProfileDef, ProfileManager } from "../config/profiles.ts";
import { ParsedCliOptions } from "../cli.ts";
import { SessionManager } from "../session/index.ts";
import { CompletionService, CompletionContext } from "../completion.ts";


export interface ExtensionMetadata {
  name: string;
  path?: string;
  provides: string[];
  loadOrder: number;
  description: string;
  dependsOn: string[];
  autoload: boolean;
  configSchema: Record<string, unknown> | null;
  cliSubcommands: Array<{
    name: string;
    description: string;
    options: unknown[];
  }>;
  cliFlags: Array<{
    short: string | null;
    long: string;
    description: string;
    type: string;
    default: unknown;
  }>;
  services: Record<string, unknown[]>;
  requires: Record<string, unknown[]>;
}

// Payload shapes for every standard hook name. Pipeline return types are noted per entry.
export interface HookPayloads {
  "session:create": { session: SessionManager; sessionId: string; config: Record<string, unknown> };
  "session:swap": { oldAgent?: AgentLike; newAgent: AgentLike };
  "session:serialize": { agent: Agent };
  "session:deserialize": { data: Record<string, unknown> };
  "session:restoreActive": { agent: Agent; isRestoring: boolean };

  "agent:toolContext": { toolCtx: ToolContext; toolName: string; agent: Agent };

  "model:change": { agent: Agent; oldModel: string; newModel: string };

  "messages:afterLLM": { response: StreamResult; messages: Message[]; agent: Agent };

  "tools:register": ToolsRegisterPayload;
  "tool:metadata": ToolMetadataPayload;
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

  "context:message": { message: Message; agent: Agent };
  "context:replaced": { agent: Agent; oldContext: Message[]; newContext: Message[] };

  // Returns SystemPromptChunk or SystemPromptChunk[].
  "systemPrompt:build": { agent: Agent };

  "command:dispatch": { command: ParsedCommand; agent: Agent };
  "commands:register": CommandsRegisterPayload;

  "output:event": { type: string; data: unknown; agent: Agent };

  "shutdown:cleanup": unknown;

  "cli:subcommandsRegister": CliSubcommandRegistryLike;
  "cli:argsParsed": { cli: ParsedCliOptions };

  // Returns InputHookResult. `origin` carries harness provenance (undefined for
  // normal user input); `source: "interactive"` marks the channel, not provenance.
  "input": { text: string; images?: ImageAttachment[]; source?: string; origin?: MessageSource; agent: Agent };

  // Returns ContextHookResult ({ messages } replaces the array).
  "context": { messages: Message[]; agent: Agent };

  // Returns GateAction (continue / modify input / block).
  "tool:call": { toolCallId: string; toolName: string; input: string; agent: Agent };

  // Returns ToolResultHookResult ({ result } replaces the result).
  "tool:result": {
    toolCallId: string;
    toolName: string;
    result: unknown;
    success: boolean;
    input: string;
    agent: Agent;
  };

  // Returns ProviderRequestHookResult (any of messages/modelConfig/toolDefs replace).
  "provider:request": ProviderRequestPayload,

  "provider:response": { response: StreamResult; modelConfig: ModelConfig; agent: Agent };

  "turn:start": { turnIndex: number; timestamp: number; agent: Agent };
  "turn:end": {
    turnIndex: number;
    message: string;
    toolResults: Array<{ toolName: string; input: string; result: string }>;
    stopped: boolean;
    cancelled?: boolean;
    reason?: "completion" | "tool_return" | "continue" | "cancelled" | "error" | "max_iterations";
    agent: Agent;
  };

  "log": { level: string; message: string; metadata?: Record<string, unknown> };

  "completion:request": {
    ctx: CompletionContext;
    timeoutMs?: number;
  };
}

export type HookHandlerFor<K extends keyof HookPayloads> =
  (payload: HookPayloads[K]) => void | Promise<void> | unknown;

// Expected return types for pipeline hooks.
export interface HookReturnTypes {
  "tool:call": GateAction;
  "input": InputHookResult;
  "context": ContextHookResult;
  "tool:result": ToolResultHookResult;
  "provider:request": ProviderRequestHookResult;
  "systemPrompt:build": SystemPromptChunk | SystemPromptChunk[];
}

// The `core` object passed to every extension's create(core).
export interface CoreContext {
  hooks: HookSystem;
  toolRegistry: ToolRegistry;
  extensions: ExtensionLoader;
  services: ServiceRegistry;
  completion: CompletionService;
  config: CoreConfigWithExtensions;
  cliSubcommandRegistry: CliSubcommandRegistry;
  configRegistry: ConfigRegistry;
  toolFormatRegistry: ToolFormatRegistry;
  llmProtocolRegistry: LlmProtocolRegistry;

  service(name: string): unknown;

  /** Build an LlmClient from the core config + registries, with per-caller overrides applied last. */
  createLlmClient(overrides?: Partial<LlmClientOptions>): LlmClient;

  // Attached after buildConfig() resolves.
  resolved?: ResolvedConfig;

  // For subcommand handlers that need to rebuild config at runtime.
  buildConfig?: (cli: Record<string, unknown>) => Promise<{
    resolved: BuildAgentConfig;
    modelRegistry: Record<string, ModelConfig>;
    providers: ProviderDef[];
  }>;
}

// Fully resolved config attached to core after buildConfig().
export interface ResolvedConfig {
  baseUrl: string;
  apiKey: string;
  chatTimeout: number;
  maxRetries: number;
  maxIterations: number;

  model: string;
  modelRegistry: Record<string, ModelConfig>;
  profileName: string;
  profileDef?: ProfileDef;
  profileBody?: string;
  role?: string;
  activeProvider?: string;
  configDir?: string;

  stream?: boolean;
  hideTools?: boolean;
  hideThinking?: boolean;
  showTokenUse?: boolean;
  thinkerFormat?: string;
  /** CLI display format for tool calls. */
  toolCallDisplayFormat?: string;
  /** Global default ToolFormat registry name (CLI > config > "xml"). */
  modelToolFormat?: string;
  toolOutputFmt?: string;
  taskProfile?: string;
  taskDefaultRole?: string;
  profilesPath?: string;

  profileManager?: ProfileManager;

  [key: string]: unknown;
}

// Shape of the object an extension's create() returns. Handlers are keyed by
// hook name and receive the typed payload for that hook.
export type ExtensionInstance = {
  hooks?: {
    [K in keyof HookPayloads]?: (payload: HookPayloads[K]) => void | Promise<void> | unknown;
  };

  shutdown?: () => Promise<void>;

  // Legacy tool registration method.
  registerTools?: (registry: ToolRegistry) => Promise<void>;

  [key: string]: unknown;
};

export interface ToolsRegisterPayload {
  register(name: string, tool: Tool): void;
  getAll(): [string, Tool][];
}

// Fired after all tools are registered.
export interface ToolMetadataPayload {
  tools: Map<string, ToolMetadata | undefined>;
}

// Fired before each LLM request; handlers can replace any field.
export interface ProviderRequestPayload {
  messages: Message[];
  modelConfig: ModelConfig;
  toolDefs: ToolDef[];
  agent: Agent;
}

export interface CommandsRegisterPayload {
  registry: AgentCommandRegistry;
  agent: Agent;
}

// Extract an extension's config block from core.config. If a schema is
// registered for the key, the value is validated and a warning logged on mismatch.
export function getExtensionConfig<T = Record<string, unknown>>(
  core: CoreContext,
  key: string,
): T {
  const block = core.config?.[key];

  if (core.configRegistry) {
    const result = core.configRegistry.validateConfigByKey(key, block);
    if (!result.valid) {
      logger.warn(
        `[config] Extension config "${key}" validation failed: ${result.errors.join("; ")} ` +
        `— config may be ignored or have unexpected values`,
      );
    }
  }

  if (block && typeof block === "object" && !Array.isArray(block)) {
    return block as T;
  }
  return {} as T;
}

// Extract a property block from an extension's configSchema.
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

export function getConfigDefault<T = unknown>(
  props: Record<string, unknown>,
  propName: string,
): T | undefined {
  const prop = props[propName];
  if (prop && typeof prop === "object" && !Array.isArray(prop)) {
    const defaultVal = (prop as Record<string, unknown>).default;
    // null means "no default", so it can't clobber a user-provided value
    if (defaultVal === null) return undefined;
    return defaultVal as T | undefined;
  }
}
