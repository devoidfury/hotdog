// Shared types for the extension system.
// Describes the contract between core and extensions.

import type { HookSystem } from "../hooks.ts";
import type { ToolRegistry, ToolDef } from "./tool-registry.ts";
import type { ExtensionLoader } from "./extensions.ts";
import type { ServiceRegistry } from "./service-registry.ts";
import type { CliSubcommandRegistry } from "./registries.ts";
import type { ModelConfig } from "../config/providers.ts";

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
  config: Record<string, unknown>;

  /** CLI subcommand registry. */
  cliSubcommandRegistry: CliSubcommandRegistry;

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
 */
export interface ExtensionInstance {
  /**
   * Hook handlers keyed by hook name (e.g., HOOKS.TOOLS_REGISTER).
   */
  hooks?: Record<string, (data: unknown) => unknown | Promise<unknown>>;

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
}

// ── Hook Payload Types ──────────────────────────────────────────────────────

/**
 * Payload for the `tools:register` hook.
 */
export interface ToolsRegisterPayload {
  register(name: string, tool: unknown): void;
  getAll(): [string, unknown][];
}

/**
 * Payload for the `commands:register` hook.
 */
export interface CommandsRegisterPayload {
  register(name: string, definition: Record<string, unknown>): void;
}

/**
 * Payload for the `context` hook (context modification pipeline).
 */
export interface ContextHookPayload {
  messages: unknown[];
  agent: unknown;
}

// ── Extension Config Helpers ─────────────────────────────────────────────────

/**
 * Safely extract an extension's config block from core.config.
 */
export function getExtensionConfig(
  core: CoreContext,
  key: string,
): Record<string, unknown> {
  const block = core.config?.[key];
  if (block && typeof block === "object" && !Array.isArray(block)) {
    return block as Record<string, unknown>;
  }
  return {};
}

/**
 * Safely extract schema defaults from an extension's configSchema.
 */
export function getConfigSchemaProperties(
  configSchema: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> {
  const block = configSchema?.[key];
  if (block && typeof block === "object" && !Array.isArray(block)) {
    const props = (block as Record<string, unknown>).properties;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      return props as Record<string, unknown>;
    }
  }
  return {};
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
    return (prop as Record<string, unknown>).default as T | undefined;
  }
  return undefined;
}
