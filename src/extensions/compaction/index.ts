import { CompactionStrategy, CompactionStrategyRegistry, requireContextLimit } from "./strategies.ts";
import { SummarizeStrategy, SUMMARIZE_SHORT_VARIANT } from "./strategies/summarize.ts";
import { DropStrategy } from "./strategies/drop.ts";
import { TokenAwareStrategy } from "./strategies/token-aware.ts";
import { TrimStrategy } from "./strategies/trim.ts";
import { PassTheBatonStrategy, hasBatonNotice } from "./strategies/pass-the-baton.ts";
import { shouldCompact, type WireRenderContext } from "./utils.ts";
import { BATON_NOTICE_PROMPT } from "./prompts.ts";
import { HOOKS } from "@core/hooks.ts";
import { ACTIONS } from "@core/commands.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import { isContextOverflowError } from "@core/llm-client/retry.ts";
import { logger } from "@utils/logger.ts";
import { LlmError, formatError } from "@core/error.ts";
import { Message } from "@core/context/message.ts";
import { sessionsDir, isSafeSessionId } from "@core/session/session-log.ts";
import type { Agent } from "@core/agent.ts";
import { CoreContext, ExtensionInstance, CommandsRegisterPayload, getExtensionConfig } from "@core/extensions/types.ts";
import { resolveModelConfig, type ModelConfig } from "@core/config/providers.ts";
import { matcher, completion } from "./completions.ts";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentMessages: number;
  strategy: string;
  userTurnGuardPrompt: string;
  /** System-notice text appended by pass-the-baton to order a handoff. */
  batonNoticePrompt: string;
  /** Context window size in tokens; threaded from the core contextLimit unless overridden here. */
  contextLimit?: number;
}

/**
 * The model config compaction resolves using same resolution the agent's own loop uses (resolveModelConfig),
 * so an unregistered model (common for --ai-url setups that publish no model list) falls back to the
 * agent's contextLimit instead of erroring on every LLM call. A window that still does not resolve is a config error (requireContextLimit)
 */
function getModelConfig(agent: Agent): ModelConfig {
  const modelConfig = resolveModelConfig(
    agent.model,
    agent.modelRegistry,
    agent.contextLimit,
    agent.reasoningEffort,
  );
  requireContextLimit(modelConfig.contextLimit);
  return modelConfig;
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
  strategyRegistry.register(new SummarizeStrategy(SUMMARIZE_SHORT_VARIANT));
  strategyRegistry.register(new TokenAwareStrategy());
  strategyRegistry.register(new TrimStrategy());
  strategyRegistry.register(new PassTheBatonStrategy());

  /**
   * Live baton state per session: the tail popped by pass-the-baton, plus
   * the flag set once the handoff has happened (via the handoff tool or a
   * narrated final message) and the fresh context awaits the replay.
   * Keyed by REAL sessionId only (M-26): this instance is shared across
   * every session, so a fallback key ("default") would let one agent
   * without a sessionId replay another's popped tail. Agents with no
   * sessionId are declined the tail-pop entirely (see _performCompaction).
   */
  const batonStash = new Map<string, { popped: Message[]; replayPending: boolean }>();

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
   * The session's wire-render context for compaction: the same mangler and
   * WireFormat the main loop would use for these messages. Tolerant of
   * duck-typed clients (test mocks); a missing format only matters if a
   * tool-result part actually reaches the dump, where it then throws --
   * exactly like the wire would.
   */
  function wireFor(agent: Agent, modelConfig: ModelConfig): WireRenderContext {
    const client = agent.llmClient as
      | { markerMangler?: WireRenderContext["mangler"]; resolveWireFormat?: (mc: ModelConfig) => WireRenderContext["wireFormat"] }
      | null
      | undefined;
    return {
      mangler: client?.markerMangler ?? null,
      wireFormat: client?.resolveWireFormat?.(modelConfig) ?? null,
    };
  }

  /**
   * Perform the actual compaction. Returns false when compaction is
   * declined or fails (including a strategy boundary that would orphan a
   * tool message) so the caller leaves the context untouched.
   */
  async function _performCompaction(agent: Agent, strategy: CompactionStrategy): Promise<boolean> {
    const messages = agent.context.getMessages(); // defensive copy — strategies expect Message[]
    const model = agent.model;
    const modelConfig = getModelConfig(agent);

    // Wire-render context: the dump speaks the session's presentation
    // (genuine wrappers via the resolved WireFormat, payloads pre-mangled).
    const wire = wireFor(agent, modelConfig);

    const llmChat = async (chatMessages: Array<{ role: string; content: string }>, _chatModel: string): Promise<string> => {
      const abortController = new AbortController();

      // Wire to task-agent abort signal if present. The listener is removed
      // in finally (not left on the agent's long-lived signal), mirroring
      // Agent#performLlmCall so listeners don't accumulate across compactions.
      const signal = agent.abortSignal;
      let removeAbortForwarder: (() => void) | null = null;
      if (signal?.aborted) {
        abortController.abort();
      } else if (signal) {
        const onAbort = () => abortController.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortForwarder = () => signal.removeEventListener("abort", onAbort);
      }

      // Summarization call: the system prompt is trusted. The conversation
      // dump arrives PRE-RENDERED by serializeConversation with the session's
      // wire context: tool/user/model payloads are already mangled and the
      // wrapper framing is genuine harness markup, so the message rides as
      // harness content -- re-mangling it as untrusted would alias the genuine
      // wrappers right back out of the dump.
      const wrapped = chatMessages.map(
        (m) =>
          new Message({
            role: m.role,
            content: m.content,
            source: m.role === "system" ? "system" : "harness",
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
          if (event.type === "reset") {
            // A mid-stream failure is being retried: the request is
            // re-issued from scratch, so the failed attempt's partial
            // output must not leak into the assembled summary.
            fullText = "";
            continue;
          }
          if (event.type === "content") {
            fullText += event.content;
          }
        }
      } finally {
        removeAbortForwarder?.();
      }
      // Stream events carry raw wire content: unescape the ASSEMBLED summary
      // once. The summary is stored in context, so an alias straddling a
      // delta boundary must be recovered (per-chunk unescaping would
      // fossilize it into the summary).
      const mangler = agent.llmClient.markerMangler;
      return mangler ? (mangler.unescape(fullText) ?? fullText) : fullText;
    };

    try {
      const result = await strategy.execute(messages, settings, llmChat, model, wire);
      if (!result) return false;

      const compactedCount = result.messagesCompacted;
      const tailCut = result.keepFrom === "tail";
      const keptMessages = tailCut
        ? messages.slice(0, messages.length - compactedCount)
        : messages.slice(compactedCount);

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

      // Tail-pop (pass-the-baton): stash the popped tail so the fresh
      // context after the handoff can pick the recent turns back up — the
      // narrating agent shed them to stay on the cached prefix, the
      // incoming agent inherits them (see the TURN_END/CONTEXT replay
      // below). The live map is the in-process path; the file is the
      // cross-process/debug record. Best-effort: a failed write must not
      // abort the baton itself.
      //
      // Declined outright without a real sessionId: the pop is only safe
      // because the stash can hand the tail back, and there is no safe
      // shared key for sessionId-less agents (bare factory-built workers,
      // embeds) on this shared instance. Losing the tail unrecoverably is
      // worse than not compacting; callers degrade onward (the overflow
      // rescue chains to trim/drop).
      if (tailCut && compactedCount > 0 && !agent.sessionId) {
        logger.warn(
          "[compaction] pass-the-baton declined: agent has no sessionId to stash the popped tail under",
        );
        return false;
      }
      if (tailCut && compactedCount > 0) {
        const popped = messages.slice(messages.length - compactedCount);
        await stashBatonMessages(agent.sessionId, popped);
        batonStash.set(agent.sessionId, { popped, replayPending: false });
      }

      const newContext: Message[] = [...keptMessages];

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
        newContext.unshift(summaryMsg);
      }

      if (result.appendNotice) {
        // Harness system-notice: verbatim at the wire per the wrapper trust
        // spec. Its harness role also satisfies ensureUserTurnGuard, so the
        // baton notice stays the last message in the context.
        newContext.push(
          new Message({
            role: "harness",
            source: "harness",
            content: [{ type: "system-notice", text: result.appendNotice }],
          }),
        );
      }

      agent.replaceContext(ensureUserTurnGuard(newContext));

      // Normalized to the CompactionResultEvent shape (core/context/
      // output.ts) so any sink bridge can forward it verbatim: token
      // figures come from the strategy metadata, and a strategy with no
      // summary (baton, drop, trim) omits the field rather than sending
      // null — consumers render "Summary: null" if it is present.
      await core.hooks.notifyHooks(HOOKS.OUTPUT_EVENT, {
        type: "compaction_result",
        data: {
          messagesCompacted: result.messagesCompacted,
          tokensBefore: result.metadata?.tokensBefore,
          tokensAfter: result.metadata?.tokensAfter,
          strategy: result.metadata?.strategyName ?? strategy.name,
          ...(result.summary ? { summary: result.summary } : {}),
        },
        agent,
      });
      return true;

    } catch (e: unknown) {
      // Compaction failure is non-fatal — log and continue
      logger.error(`[compaction] error: ${formatError(e)}`);
      return false;
    }
  }

  /**
   * `--compact-debug` / `compactDebug` config: dump settings and message
   * counts to compaction.out.json. Lives in the sessions dir so
   * HOTDOG_SESSIONS_DIR keeps test writes out of the user cache. Returns
   * false when the write failed -- the reply must not claim a file exists.
   */
  async function writeCompactionDump(data: Record<string, unknown>): Promise<boolean> {
    const dir = sessionsDir();
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "compaction.out.json"), JSON.stringify(data, null, 2) + "\n");
      return true;
    } catch (err) {
      logger.warn(`[compaction] debug dump failed: ${formatError(err)}`);
      return false;
    }
  }

  /**
   * Persist the tail popped by pass-the-baton. After the handoff, a fresh
   * session can re-append these messages so the recent turns survive the
   * pop; overwritten on each baton pass. The reader side (handoff into a
   * new session) is intentionally not wired here.
   *
   * One file per session (`<session-id>.baton.json`) so concurrent
   * sessions popping at once cannot clobber each other's stash; the same
   * guard makes write and remove always target the same file. Missing or
   * unsafe ids skip the mirror (see batonStashPath) but keep working
   * through the live map.
   */
  async function stashBatonMessages(
    sessionId: string | null | undefined,
    popped: Message[],
  ): Promise<void> {
    const path = batonStashPath(sessionId);
    if (!path) {
      logger.warn(
        `[compaction] baton stash skipped: unsafe session id ${JSON.stringify(String(sessionId).slice(0, 80))}`,
      );
      return;
    }
    try {
      await mkdir(sessionsDir(), { recursive: true });
      await writeFile(
        path,
        JSON.stringify(
          {
            ts: new Date().toISOString(),
            session_id: sessionId ?? null,
            messages: popped.map((m) => m.toJSON()),
          },
          null,
          2,
        ) + "\n",
      );
    } catch (err) {
      logger.warn(`[compaction] baton stash failed: ${formatError(err)}`);
    }
  }

  /**
   * Path of the per-session stash file, or null when the id is missing or
   * not a safe file name. Applies the same id guard sessionLog uses for the
   * .jsonl logs: a crafted session id must not escape the sessions dir
   * through join(). Missing ids get no path: there is no shared "default"
   * file any more (M-26).
   */
  function batonStashPath(sessionId: string | null | undefined): string | null {
    if (!sessionId || !isSafeSessionId(sessionId)) return null;
    return join(sessionsDir(), `${sessionId}.baton.json`);
  }

  /** Best-effort removal of the stash file once its tail is replayed or dropped. */
  async function removeBatonStashFile(sessionId: string | null | undefined): Promise<void> {
    const path = batonStashPath(sessionId);
    if (!path) return;
    try {
      await unlink(path);
    } catch {
      // Missing or already gone: nothing to clean.
    }
  }

  /**
   * Drop the baton for good: forget the live entry and unlink its mirror
   * so an abandoned tail cannot outlive the session that popped it.
   */
  async function dropBaton(agent: { sessionId?: string | null }): Promise<void> {
    if (agent.sessionId) batonStash.delete(agent.sessionId);
    await removeBatonStashFile(agent.sessionId);
  }

  /**
   * Formats the narrated summary as the plan message of the fresh session,
   * mirroring the handoff tool's contract (title + plan + continuation
   * note) without depending on that extension.
   */
  function formatBatonPlanMessage(summary: string): string {
    return [
      "# Baton handoff",
      "",
      "## Status",
      summary,
      "",
      "_The previous session hit its context limit and handed off mid-session. Its most recent turns are appended below verbatim. Continue the work directly; do not restart it from scratch._",
    ].join("\n");
  }

  async function _handleCompactCommand(agent: Agent, opts: { keep: number | null; debug: boolean }): Promise<Record<string, unknown>> {
    const nonSystemMessages = agent.context.getNonSystem();
    const debug = opts.debug || core.resolved?.compactDebug === true;

    if (nonSystemMessages.length <= 2) {
      return { action: ACTIONS.DISPLAY, content: "Not enough messages to compact." };
    }

    if (opts.keep !== null) {
      const systemMessages = agent.context.getSystem();
      // keep=0 keeps everything, as the old slice(-0) did (pinned behavior).
      const requested = opts.keep === 0 ? nonSystemMessages.length : opts.keep;
      // Back the boundary up over tool results so the kept window never
      // starts on a tool message whose parent assistant tool_calls was
      // dropped -- strict OpenAI-compatible backends reject that. Same rule
      // findFirstKeptIndex enforces for the strategies.
      let start = Math.max(0, nonSystemMessages.length - requested);
      while (start > 0 && nonSystemMessages[start]!.role === "tool") start--;
      const keptMessages = nonSystemMessages.slice(start);
      agent.replaceContext(ensureUserTurnGuard([...systemMessages, ...keptMessages]));
      const keepContent = `Context compacted to ${keptMessages.length} messages.`;
      if (debug) {
        const written = await writeCompactionDump({
          ts: new Date().toISOString(),
          session_id: agent.sessionId ?? null,
          mode: "keep",
          keep_requested: opts.keep,
          strategy: null,
          settings: { ...settings },
          messages: { before: nonSystemMessages.length, after: keptMessages.length },
        });
        if (written) {
          return { action: ACTIONS.DISPLAY, content: keepContent + "\n(Debug mode: debug file written.)" };
        }
      }
      return { action: ACTIONS.DISPLAY, content: keepContent };
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
    if (debug) {
      const written = await writeCompactionDump({
        ts: new Date().toISOString(),
        session_id: agent.sessionId ?? null,
        mode: "strategy",
        keep_requested: null,
        strategy: settings.strategy,
        settings: { ...settings },
        messages: {
          before: nonSystemMessages.length,
          after: agent.context.getNonSystem().length,
        },
      });
      if (written) {
        return { action: ACTIONS.DISPLAY, content: resultContent + "\n(Debug mode: debug file written.)" };
      }
      return { action: ACTIONS.DISPLAY, content: resultContent + "\n(Debug dump failed; see logs.)" };
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
        // Baton replay (first act of the fresh session): re-append the
        // popped tail verbatim, right after the plan message the drain
        // already placed in context (bus messages enter the context before
        // this hook fires, so the order is always plan-then-tail). The
        // boundary rule on the pop side guarantees the tail never starts
        // with a tool result orphaned from its parent assistant turn.
        const st = agent?.sessionId ? batonStash.get(agent.sessionId) : undefined;
        if (st?.replayPending) {
          await dropBaton(agent);
          const current = agent.context.getMessages();
          agent.replaceContext([...current, ...st.popped]);
          return { messages: agent.buildMessages() };
        }

        if (!settings.enabled) return;

        const nonSystemMessages = messages.filter((m) => m.role !== "system");

        if (nonSystemMessages.length <= settings.keepRecentMessages * 2) return;

        const modelConfig = getModelConfig(agent);
        // The trigger bills the FULL window: the system prompt (base prompt +
        // AGENTS.md + skill chunks) rides every request, so estimating only
        // the conversation under-counts and the provider overflows before
        // compaction fires. Strategies still see -- and evict -- only the
        // non-system messages.
        if (
          !shouldCompact(messages, modelConfig.contextLimit, settings.reserveTokens, wireFor(agent, modelConfig))
        )
          return;

        const strategy = strategyRegistry.get(settings.strategy) || strategyRegistry.getDefault();
        if (!strategy) return;

        if (!strategy.canCompact(nonSystemMessages, settings)) return;

        // _performCompaction rewrites agent.context in place.
        const compacted = await _performCompaction(agent, strategy);
        if (!compacted) return;

        return { messages: agent.buildMessages() };
      },

      /**
       * Baton handoff detection. After pass-the-baton fires there are two
       * ways the session ends, and both must reach the same fresh context:
       *
       *  A. The model calls the handoff tool. The handoff-tool extension
       *     (higher TURN_END priority, already run) clears the context and
       *     enqueues its plan; we only mark the tail for replay.
       *  B. The model ignores the tool and just emits its handoff as a
       *     final summary message with stop ("completion"). We treat that
       *     the same: clear, restart on the summary as the plan (the same
       *     clear/ensureSystemPrompt/enqueue/claim sequence the handoff
       *     tool runs, owned by us), and mark the tail for replay.
       *
       * The replay itself happens in the CONTEXT hook so it lands after
       * the enqueued plan message (drained into context before that hook
       * fires). Abnormal endings drop the baton: a cancelled or errored
       * turn must not hijack whatever comes next.
       */
      [HOOKS.TURN_END]: async ({ reason, cancelled, agent, toolResults, claimTurn, message }) => {
        if (!agent) return;
        const st = agent.sessionId ? batonStash.get(agent.sessionId) : undefined;
        if (!st) return;

        if (cancelled || reason === "error" || reason === "max_iterations" || reason === "empty_response") {
          await dropBaton(agent);
          return;
        }

        // The handoff tool's registered name ("handoff" in the handoff-tool
        // extension; referenced by name only — no dependency on it).
        const notice = settings.batonNoticePrompt ?? BATON_NOTICE_PROMPT;
        if (toolResults?.some((tr) => tr.toolName === "handoff")) {
          // Path A, armed on a precondition instead of the call alone: the
          // handoff tool cleared the context on success, so our notice is
          // gone only when the restart actually happened. A failed call
          // (ToolResult.err on bad input) or a synthesized skip (length-
          // stop, maxToolCalls cap) leaves the context — and the notice —
          // intact; replaying the tail into that live context would undo
          // the pop. Keep the stash: a real handoff or a narrated wrap-up
          // can still take the baton on a later turn.
          if (hasBatonNotice(agent.context.getMessages(), notice)) return;
          // Handoff-tool already claimed the turn and enqueued the plan.
          // Nothing to do but queue the tail replay.
          st.replayPending = true;
          return;
        }

        if (reason !== "completion" || st.replayPending) return;

        // Path B: only if our notice is still in the context — the model
        // narrated its wrap-up in response to the baton. (If the notice is
        // gone the context was rewritten out from under us; drop the baton
        // rather than hijack the session.)
        if (!hasBatonNotice(agent.context.getMessages(), notice)) {
          await dropBaton(agent);
          return;
        }

        // Continuation-seam guard: enqueue() reaches a draining consumer only
        // when the host wired agent.enqueueCallback (the session bus does;
        // factory-built task/subagent workers leave it null, where enqueue()
        // is a silent no-op). Clearing such an agent would destroy its work
        // with no plan to restart on — the baton is dropped, not taken.
        if (typeof (agent as { enqueueCallback?: unknown }).enqueueCallback !== "function") {
          await dropBaton(agent);
          return;
        }

        // Own the continuation before any await, mirroring the handoff
        // tool: a failed claim means another handler owns this turn.
        if (claimTurn && !claimTurn()) return;

        const summary =
          typeof message === "string" && message.trim().length > 0
            ? message
            : "(The previous agent hit the context limit and stopped without a written summary. Its most recent turns are appended verbatim below.)";
        try {
          await agent.clearContext();
          await agent.ensureSystemPrompt();
          // The summary is model-authored, so it rides model provenance —
          // same rule the handoff tool applies to the plan it enqueues.
          agent.enqueue(formatBatonPlanMessage(summary), { source: "model" });
          st.replayPending = true;
        } catch (e: unknown) {
          await dropBaton(agent);
          logger.warn(`[compaction] baton handoff failed: ${formatError(e)}`);
        }
      },

      // Error-driven compaction (context-overflow rescue): llama.cpp/Ollama/
      // LM Studio/vLLM reject an oversized prompt with a 4xx/5xx. That is not
      // fatal -- compact once and let core's exactly-once provider:error
      // retry re-issue the request with the trimmed context.
      [HOOKS.PROVIDER_ERROR]: async ({ error, params, agent }) => {
        if (!agent || agent.cancelled) return;
        if (!isContextOverflowError(error)) return;

        // The rescue is LLM-free on purpose: the backend just rejected a
        // roughly conversation-sized request, so a summarize pass (same size,
        // same window) would likely fail too. Chain, cheapest and
        // cache-friendliest first:
        //  - pass-the-baton pops the newest messages and orders a handoff;
        //    the kept window stays a byte-prefix of the failed prompt, so
        //    prefix-matching runners re-read it from cache. Declined when a
        //    baton notice is already present or the estimate says the
        //    context fits.
        //  - trim drops the minimum number of oldest messages; its own fit
        //    check returns null when the local estimate claims the context
        //    already fits (that estimate is exactly what lost the race).
        //  - drop is the blunt last resort, gated so a misclassified
        //    overflow (a generic error body quoting an overflow phrase)
        //    cannot silently lose real history from a young,
        //    comfortably-fitting session. Same count gate the CONTEXT hook
        //    uses; a genuine estimate-race overflow is conversation-sized
        //    and passes it.
        // A second overflow propagates -- the core provider:error seam
        // retries once and the retry is not itself re-caught.
        let rescued = false;
        const baton = strategyRegistry.get("pass-the-baton");
        if (baton && baton.canCompact(agent.context.getMessages(), settings)) {
          rescued = await _performCompaction(agent, baton);
        }
        if (!rescued) {
          // trim stays ungated (as before): its execute self-checks the fit,
          // so a genuine overflow of few but huge messages is rescued even
          // below the message-count gate.
          const trim = strategyRegistry.get("trim");
          if (trim) rescued = await _performCompaction(agent, trim);
        }
        if (!rescued) {
          const drop = strategyRegistry.get("drop");
          if (drop && drop.canCompact(agent.context.getMessages(), settings)) {
            rescued = await _performCompaction(agent, drop);
          }
        }
        if (!rescued) {
          logger.warn(
            `[compaction] context overflow but no strategy could compact session ${agent.sessionId}; surfacing the error`,
          );
          return;
        }

        // The retry must send the compacted context, not the messages captured
        // before the overflow (same params-mutation pattern as tool-call-repair).
        params.messages = agent.buildMessages();
        agent.sink?.emit({
          type: OUTPUT_EVENT.SYSTEM_MESSAGE,
          content: "Context overflow: compacted the conversation and retrying the request once.",
        });
        return { retry: true };
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
          mutatesSession: true,
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

