// Test kit for extension authors -- "@read-receipt/hotdog/testing".
//
// A published double + fakes so an external extension bundle can boot its own
// extension in `bun test` with zero deep imports into src/ and zero hand-rolled
// seams. The documented flow (dogfooded by examples/extension-starter and
// examples/extension-redactor):
//
//   import { createTestCore, ExtensionLoader } from "@read-receipt/hotdog/testing";
//   const core = createTestCore({ config: { myExtension: { enabled: true } } });
//   const loader = new ExtensionLoader(core); // a TestCore IS a loader core: no cast
//   const inst = await loader.load("my-extension", join(import.meta.dir, "index.ts"));
//
// Config is a plain mutable bag: flip a knob by direct field assignment
// (`core.config.myExtension = { ... }`, or mutate one nested field) and the
// NEXT `getExtensionConfig()` read inside the extension answers with it. That
// is the pattern; there is no knob-flip helper because none is needed.
//
// The double is minimal BY DESIGN: real registries + a completion service, and
// nothing else. No LlmClient, no resolved bag, no configStore, no wire-format
// registries -- an extension that needs those in a unit test is asking the host
// for more than the authoring contract gives it. Surface policy matches the
// other doors: additive within a major, breaking at majors.

import { createHooks } from "@core/hooks.ts";
import type { HookSystem } from "@core/hooks.ts";
import { ToolRegistry } from "@core/extensions/tool-registry.ts";
import { ToolContext } from "@core/extensions/tool-context.ts";
import { createServiceRegistry } from "@core/extensions/service-registry.ts";
import type { ServiceRegistry } from "@core/extensions/service-registry.ts";
import { ConfigRegistry } from "@core/extensions/config.ts";
import { createSubcommandRegistry } from "@core/extensions/registries.ts";
import type { CliSubcommandRegistry } from "@core/extensions/registries.ts";
import { createCompletionService } from "@core/completion.ts";
import type { CompletionService } from "@core/completion.ts";
import type { CoreConfigWithExtensions } from "@core/config/schema-loader.ts";
import type { LoaderCore } from "@core/extensions/extensions.ts";
import type { HookPayloads } from "@core/extensions/types.ts";
import type { QuestionDef, QuestionSeam } from "@core/context/input.ts";

/**
 * The core double handed to `ExtensionLoader` (and through it to the
 * extension's `create()`). Structurally a `LoaderCore` -- see the compile-time
 * assertion below -- so feeding it to the loader needs no cast.
 */
export interface TestCore {
  hooks: HookSystem;
  toolRegistry: ToolRegistry;
  services: ServiceRegistry;
  completion: CompletionService;
  /** Plain mutable bag: direct field assignment IS the knob-flip (see header). */
  config: CoreConfigWithExtensions;
  configRegistry: ConfigRegistry;
  cliSubcommandRegistry: CliSubcommandRegistry;
  /** No extension manager: tests drive the loader directly. */
  extensions: null;
  service(name: string): unknown;
}

// Compile-time proof the double satisfies the loader contract; if TestCore
// ever stops being assignable, tsc fails HERE, not in every consumer test.
type Assert<T extends true> = T;
export type _TestCoreIsLoaderCore = Assert<TestCore extends LoaderCore ? true : false>;

export function createTestCore(
  options: { config?: Record<string, unknown> } = {},
): TestCore {
  const services = createServiceRegistry();
  return {
    hooks: createHooks(),
    toolRegistry: new ToolRegistry(),
    services,
    completion: createCompletionService(),
    config: { ...options.config } as CoreConfigWithExtensions,
    configRegistry: new ConfigRegistry(),
    cliSubcommandRegistry: createSubcommandRegistry(),
    extensions: null,
    service: (name: string) => services.get(name),
  };
}

export interface FakeQuestionSeamOptions {
  /** false => non-interactive: callers must fail closed without asking. */
  interactive?: boolean;
  /** collectAnswers throws synchronously (a broken prompt). */
  throws?: boolean;
  /** collectAnswers returns a rejected promise. */
  rejects?: boolean;
  /** collectAnswers never settles: only the run's abort can release the caller. */
  never?: boolean;
}

/**
 * A QuestionSeam double plus the questions it was asked (every QuestionDef,
 * in order). `answer` is returned under every question's own key, matching
 * how the real seam answers.
 */
export function fakeQuestionSeam(
  answer = "",
  options: FakeQuestionSeamOptions = {},
): { seam: QuestionSeam; asked: QuestionDef[] } {
  const asked: QuestionDef[] = [];
  const interactive = options.interactive !== false;
  const seam: QuestionSeam = {
    isInteractive: () => interactive,
    collectAnswers(
      questions: QuestionDef[],
    ): Record<string, unknown> | Promise<Record<string, unknown>> {
      asked.push(...questions);
      if (options.throws) throw new Error("fake question seam: prompt exploded");
      if (options.rejects) return Promise.reject(new Error("fake question seam: rejected"));
      if (options.never) return new Promise<Record<string, unknown>>(() => {});
      return Object.fromEntries(questions.map((q) => [q.key, answer]));
    },
  };
  return { seam, asked };
}

/**
 * A real ToolContext with the question seam mounted under "input" (the SDK's
 * seam key) and the run's cancellation under "abortSignal".
 */
export function makeToolContext(
  options: { seam?: QuestionSeam; abortSignal?: AbortSignal } = {},
): ToolContext {
  const ctx = new ToolContext();
  if (options.seam !== undefined) ctx.set("input", options.seam);
  if (options.abortSignal !== undefined) ctx.set("abortSignal", options.abortSignal);
  return ctx;
}

/**
 * A properly-shaped `HookPayloads["tool:result"]` for driving the pipeline.
 * `sessionId: null` carries an agent WITHOUT a session id (the degrade route);
 * `agent` replaces the agent double whole (e.g. a throwing getter). The
 * internal cast lives here so extension tests never have to write one.
 */
export function toolResultPayload(options: {
  result: unknown;
  toolName?: string;
  toolCallId?: string;
  success?: boolean;
  input?: string;
  sessionId?: string | null;
  agent?: unknown;
  toolCtx?: ToolContext;
}): HookPayloads["tool:result"] {
  const agent =
    options.agent !== undefined
      ? options.agent
      : options.sessionId === null
        ? {}
        : { sessionId: options.sessionId ?? "test-session" };
  const payload = {
    toolCallId: options.toolCallId ?? "test-call",
    toolName: options.toolName ?? "bash",
    result: options.result,
    success: options.success ?? true,
    input: options.input ?? "{}",
    agent,
    toolCtx: options.toolCtx,
  };
  return payload as unknown as HookPayloads["tool:result"];
}

// Boot-path re-exports: `./testing` alone carries the documented flow.
export {
  ExtensionLoader,
  discoverExtensions,
  getExtensionConfigDefaults,
  isExtensionDirectory,
  sdkCompatibilityWarning,
} from "@core/extensions/extensions.ts";
export { HOOKS } from "@core/hooks.ts";
export { ToolResult } from "@core/extensions/tool-utils.ts";
export { ToolContext } from "@core/extensions/tool-context.ts";
export type { HookPayloads } from "@core/extensions/types.ts";
export type { QuestionDef, QuestionSeam } from "@core/context/input.ts";
