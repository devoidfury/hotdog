// hotdog extension SDK — the stable authoring surface for third-party extensions.
//
// Contract: everything re-exported here is public API. Hotdog's version policy
// applies: within a major these exports are additive-only; breaking changes
// land at majors. Anything under src/ NOT re-exported here is internal —
// it moves freely between minors, and an extension importing it directly is
// unsupported. Extensions import this module as "@read-receipt/hotdog/sdk"
// (package.json "exports"); the name resolves from inside the source tree via
// package self-reference and from any project with hotdog installed. See
// examples/extension-starter (the tool shape) and examples/extension-redactor
// (the hook shape: pipeline mutation + the question seam).

export { HOOKS } from "@core/hooks.ts";
export type {
  HookSystem,
  GateAction,
  ContextHookResult,
  ProviderRequestHookResult,
  ToolResultHookResult,
  ToolCallRefusal,
  InputHookResult,
  SystemPromptChunk,
} from "@core/hooks.ts";

export { getExtensionConfig, getConfigSchemaProperties, readKnob } from "@core/extensions/types.ts";
export type {
  CoreContext,
  ExtensionInstance,
  HookPayloads,
  ToolsRegisterPayload,
  ToolMetadataPayload,
  ConfigKnob,
} from "@core/extensions/types.ts";

export type { Tool, ToolDef, ToolMetadata } from "@core/extensions/tool-registry.ts";
export type { ToolContext } from "@core/extensions/tool-context.ts";

// The question seam: the one route from an extension to the human, mounted by
// the interactive UI at toolCtx.get("input"). Reachable from the tool:call
// gate and the tool:result pipeline.
export type { QuestionSeam, QuestionDef } from "@core/context/input.ts";
export {
  ToolResult,
  toolDef,
  param,
  toolResult,
  parseToolInput,
  truncateOutput,
  resolveToolPath,
} from "@core/extensions/tool-utils.ts";

export { ToolError, ConfigError, AgentError, LlmError, formatError } from "@core/error.ts";
export { logger } from "@utils/logger.ts";
// Prompt-rendering neutralizer for escapes/bidi: anything that puts tool
// output (or other untrusted text) into a human-facing prompt needs it.
export { spoofSafe } from "@utils/spoof.ts";
export type { Message } from "@core/context/message.ts";
