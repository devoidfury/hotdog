import {
  CompactionStrategy,
  CompactionStrategyRegistry,
} from "./strategies.ts";
import { SummarizeStrategy } from "./strategies/summarize.ts";
import { DropStrategy } from "./strategies/drop.ts";
import { SummarizeShortStrategy } from "./strategies/summarize-short.ts";
import { TokenAwareStrategy } from "./strategies/token-aware.ts";
import { TrimStrategy } from "./strategies/trim.ts";
import { estimateContextTokens } from "./utils.ts";
import { HOOKS } from "../../core/hooks.ts";
import { ACTIONS } from "../../core/commands.ts";
import { logger } from "../../core/logger.ts";
import { LlmError, formatError } from "../../core/error.ts";
import { Message } from "../../core/context/message.ts";
import type { Agent } from "../../core/agent.ts";
import {
  CoreContext,
  ExtensionInstance,
  CommandsRegisterPayload,
  getExtensionConfig,
} from "../../core/extensions/types.ts";
import { findModelEntry, type ModelConfig } from "../../core/config/providers.ts";
import { matcher, completion } from "./completions.ts";

interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentMessages: number;
  strategy: string;
  userTurnGuardPrompt: string;
  /** Context window size in tokens; threaded from the core contextLimit unless overridden here. */
  contextLimit?: number;
}

function getModelConfig(modelRegistry: Record<string, ModelConfig>, modelName: string): ModelConfig {
  const entry = findModelEntry(modelName, modelRegistry);
  if (!entry) {
    throw new Error(`Model "${modelName}" not found in registry`);
  }
  if (typeof entry.contextLimit !== "number" || entry.contextLimit <= 0) {
    throw new Error(`Model "${modelName}" missing contextLimit in registry`);
  }
  return entry;
}

export function create(core: CoreContext): ExtensionInstance | null {
  // Config defaults come from extension.json configSchema
  const settings = getExtensionConfig<CompactionSettings>(core, "compaction");

  if (!settings.enabled) return null;

  // Honor the core contextLimit unless compaction.contextLimit overrides it.
  settings.contextLimit ??= core.resolved?.contextLimit;

  const strategyRegistry = new CompactionStrategyRegistry();
  strategyRegistry.register(new SummarizeStrategy());
  strategyRegistry.register(new DropStrategy());
  strategyRegistry.register(new SummarizeShortStrategy());
  strategyRegistry.register(new TokenAwareStrategy());
  strategyRegistry.register(new TrimStrategy());

  // Helpers are nested in create() so they close over core, settings, and the registry.

  /**
   * Ensure the conversation ends with a user turn.
   * Some strict chat templates (e.g. in LM Studio/llama.cpp) fail if the
   * message history ends with an assistant or tool message.
   */
  function ensureUserTurnGuard(messages: Message[]): Message[] {
    if (messages.length === 0) return messages;
    const lastMsg = messages[messages.length - 1];
    // "harness" acts as a user turn on the wire in system-first format.
    if (!lastMsg || lastMsg.role === "user" || lastMsg.role === "harness") return messages;

    return [
      ...messages,
      // Code-generated guard: harness-provenance so it is never marker-mangled.
      // The prompt is config text (trusted layer), so no inner escaping.
      new Message({
        role: "harness",
        content: settings.userTurnGuardPrompt,
        source: "harness",
      }),
    ];
  }

  /**
   * Perform the actual compaction. Returns false when compaction is
   * declined or fails (including a strategy boundary that would orphan a
   * tool message) so the caller leaves the context untouched.
   */
  async function _performCompaction(agent: Agent, strategy: CompactionStrategy): Promise<boolean> {

    const messages = agent.context.getMessages(); // defensive copy — strategies expect Message[]
    const model = agent.model;
    const modelConfig = getModelConfig(agent.modelRegistry, model);

    const llmChat = async (chatMessages: Array<{ role: string; content: string }>, chatModel: string): Promise<string> => {
      const abortController = new AbortController();

      // Wire to task-agent abort signal if present. The listener is removed
      // in finally (not left on the agent's long-lived signal), mirroring
      // Agent._performLlmCall so listeners don't accumulate across compactions.
      const signal = agent.abortSignal;
      let removeAbortForwarder: (() => void) | null = null;
      if (signal?.aborted) {
        abortController.abort();
      } else if (signal) {
        const onAbort = () => abortController.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortForwarder = () => signal.removeEventListener("abort", onAbort);
      }

      // Summarization call: the system prompt is trusted; the conversation
      // dump in the user prompt is untrusted model/user content.
      const wrapped = chatMessages.map(
        (m) =>
          new Message({
            role: m.role,
            content: m.content,
            source: m.role === "system" ? "system" : "user",
          }),
      );
      const stream = agent.llmClient.chatStreamCancellable(
        wrapped,
        modelConfig,
        [],
        abortController.signal,
        agent.sessionId,
      );

      let fullText = "";
      try {
        for await (const event of stream) {
          // Check main-agent cancellation flag each iteration (Ctrl+C, etc.)
          if (agent.cancelled) {
            abortController.abort();
            throw LlmError.Cancelled("Compaction cancelled");
          }
          if (event.type === "content") {
            fullText += event.content;
          }
        }
      } finally {
        removeAbortForwarder?.();
      }
      return fullText;
    };

    try {
      const result = await strategy.execute(messages, settings, llmChat, model);
      if (!result) return false;

      const compactedCount = result.messagesCompacted;

      const keptMessages = messages.slice(compactedCount);

      // Safety net against custom strategies: a tool message must never be
      // the first kept message without its parent assistant tool_calls
      // message — strict OpenAI-compatible backends reject that.
      const firstKept = keptMessages.find((m) => m.role !== "system");
      if (firstKept?.role === "tool") {
        logger.error(
          `[compaction] aborted: '${strategy.name}' kept window starts with an orphaned tool message; context left unchanged`,
        );
        return false;
      }

      if (result.summary) {
        // Harness message: the wrapper tag parts are trusted and reach the
        // model with their real names; the summary body is model-generated,
        // so it rides an `untrusted` part that the wire serializer mangles.
        // Context and session log keep the raw summary.
        const tag = "previous-context-summary";
        const summaryMsg = new Message({
          role: "harness",
          source: "harness",
          content: [
            { type: "text", text: `<${tag}>` },
            { type: "untrusted", text: result.summary },
            { type: "text", text: `</${tag}>` },
          ],
        });

        agent.replaceContext(ensureUserTurnGuard([
          summaryMsg,
          ...keptMessages,
        ]));
      } else {
        agent.replaceContext(ensureUserTurnGuard(keptMessages));
      }

      core.hooks.notifyHooks(HOOKS.OUTPUT_EVENT, {
        type: "compaction_result",
        data: result,
        agent,
      });
      return true;

    } catch (e: unknown) {
      // Compaction failure is non-fatal — log and continue
      logger.error(`[compaction] error: ${formatError(e)}`);
      return false;
    }
  }

  async function _handleCompactCommand(agent: Agent, opts: { keep: number | null; debug: boolean }): Promise<Record<string, unknown>> {
    const nonSystemMessages = agent.context.getNonSystem();

    if (nonSystemMessages.length <= 2) {
      return { action: ACTIONS.DISPLAY, content: "Not enough messages to compact." };
    }

    if (opts.keep !== null) {
      const systemMessages = agent.context.getSystem();
      const keptMessages = nonSystemMessages.slice(-opts.keep);
      agent.replaceContext(ensureUserTurnGuard([...systemMessages, ...keptMessages]));
      return { action: ACTIONS.DISPLAY, content: `Context compacted to ${keptMessages.length} messages.` };
    }

    const strategy = strategyRegistry.get(settings.strategy) || strategyRegistry.getDefault();
    if (!strategy) {
      return { action: ACTIONS.ERROR, error: "No compaction strategy available." };
    }

    if (!strategy.canCompact(nonSystemMessages, settings)) {
      return { action: ACTIONS.DISPLAY, content: "Compaction not applicable with current settings." };
    }

    await _performCompaction(agent, strategy);

    const resultContent = `Context compacted using '${settings.strategy}' strategy.`;
    if (opts.debug) {
      return { action: ACTIONS.DISPLAY, content: resultContent + "\n(Debug mode: debug file written.)" };
    }
    return { action: ACTIONS.DISPLAY, content: resultContent };
  }

  const instance: ExtensionInstance & {
    registry: CompactionStrategyRegistry;
    settings: CompactionSettings;
    getStrategyList(): Array<{ name: string; description: string }>;
  } = {
    hooks: {
      /** Mount registry on agent for completion access. */
      [HOOKS.AGENT_TOOL_CONTEXT]: async ({ agent }) => {
        (agent as { compactionRegistry?: typeof strategyRegistry }).compactionRegistry = strategyRegistry;
      },

      // Runs before each LLM call; compacts in place when the token budget is exceeded.
      [HOOKS.CONTEXT]: async ({ messages, agent }) => {
        if (!settings.enabled) return;

        const nonSystemMessages = messages.filter((m) => m.role !== "system");

        if (nonSystemMessages.length <= settings.keepRecentMessages * 2) return;

        const estimatedTokens = estimateContextTokens(nonSystemMessages);
        const reserveTokens = settings.reserveTokens;
        const modelConfig = getModelConfig(agent.modelRegistry, agent.model);
        const contextLimit = modelConfig.contextLimit;

        if (estimatedTokens <= contextLimit - reserveTokens) return;

        const strategy = strategyRegistry.get(settings.strategy) || strategyRegistry.getDefault();
        if (!strategy) return;

        if (!strategy.canCompact(nonSystemMessages, settings)) return;

        // _performCompaction rewrites agent.context in place.
        const compacted = await _performCompaction(agent, strategy);
        if (!compacted) return;

        // The hook's `messages` input is stale after compaction.
        const newMessages = agent.buildMessages();
        return { messages: newMessages };
      },

      [HOOKS.COMMANDS_REGISTER]: async (payload: CommandsRegisterPayload) => {
        const { registry } = payload;

        const strategyNames = (): string =>
          strategyRegistry.getAll().map((s) => s.name).join(", ");

        const setStrategy = (name: string) => {
          if (!strategyRegistry.get(name)) {
            return {
              action: ACTIONS.ERROR,
              error: `Unknown compaction strategy: '${name}'. Available: ${strategyNames()}`,
            };
          }
          settings.strategy = name;
          return { action: ACTIONS.DISPLAY, content: `Compaction strategy set to: ${name}` };
        };

        registry.register("compact", {
          description: "Compact context ([n] [--compact-debug]) or switch strategy (<strategy>, compact:<strategy>)",
          matches: (cmd: string) =>
            cmd === "compact" || cmd.startsWith("compact ") || cmd.startsWith("compact:"),
          completion,
          handler: async (agent, cmdValue) => {
            const parts = (cmdValue || "").split(/\s+/).filter(Boolean);
            const head = parts[0] || "compact";
            const rest = parts.slice(1);
            const debug = rest.includes("--compact-debug");
            const args = rest.filter((p) => p !== "--compact-debug");

            if (head.startsWith("compact:")) {
              if (args.length > 0) {
                return {
                  action: ACTIONS.ERROR,
                  error: `Unexpected arguments: ${args.join(" ")}\nUsage: /compact:<strategy> (available: ${strategyNames()})`,
                };
              }
              return setStrategy(head.slice("compact:".length));
            }

            if (args.length === 0) {
              return await _handleCompactCommand(agent, { keep: null, debug });
            }

            const first = args[0] ?? "";
            if (strategyRegistry.get(first)) {
              if (args.length > 1) {
                return {
                  action: ACTIONS.ERROR,
                  error: `Unexpected arguments: ${args.slice(1).join(" ")}\nUsage: /compact <strategy> (available: ${strategyNames()})`,
                };
              }
              return setStrategy(first);
            }

            if (args.length === 1 && /^\d+$/.test(first)) {
              return await _handleCompactCommand(agent, {
                keep: parseInt(first, 10),
                debug,
              });
            }

            return {
              action: ACTIONS.ERROR,
              error: `Unknown argument: '${first}'\nUsage: /compact [n] [--compact-debug] | /compact <strategy> | /compact:<strategy>\nAvailable strategies: ${strategyNames()}`,
            };
          },
        });
      },
    },

    // Expose for external use
    registry: strategyRegistry,
    settings,

    getStrategyList() {
      return strategyRegistry.getAll().map((s) => ({
        name: s.name,
        description: s.description,
      }));
    },
  };

  if (core.completion) {
    core.completion.register(matcher, completion, "compaction:compact-strategy");
  }

  return instance;
}

