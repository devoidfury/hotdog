import { CompactionStrategy, CompactionStrategyRegistry, requireContextLimit } from "./strategies.ts";
import { SummarizeStrategy, SUMMARIZE_SHORT_VARIANT } from "./strategies/summarize.ts";
import { DropStrategy } from "./strategies/drop.ts";
import { TokenAwareStrategy } from "./strategies/token-aware.ts";
import { TrimStrategy } from "./strategies/trim.ts";
import { PassTheBatonStrategy, hasBatonNotice, isBatonNoticeMessage, recentWindow, mergeStashWindows } from "./strategies/pass-the-baton.ts";
import { shouldCompact, estimateContextTokens, estimatorFor, downgradeOlderImages, type WireRenderContext } from "./utils.ts";
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

/**
 * Images kept (payload intact) by the overflow-rescue downgrade: the newest
 * N image payloads in the context survive, everything older is replaced by
 * the placeholder text. Aggressive on purpose -- on the rescue path the
 * full-size request already failed once, and the freshest screenshots are
 * the only pixels the model plausibly still needs (older captures keep
 * their on-disk path in the tool-result text and stay re-readable).
 */
export const RESCUE_KEEP_RECENT_IMAGES = 2;

interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentMessages: number;
  strategy: string;
  userTurnGuardPrompt: string;
  /** System-notice text appended by pass-the-baton to order a handoff. */
  batonNoticePrompt: string;
  /** Context window size in tokens; resolved per run (see runSettings). */
  contextLimit?: number;
  /** Runtime pop directive (overflow rescue / manual /compact); never a config key. */
  batonPopNow?: boolean;
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
  // Boot gate only: enabled=false at boot means this extension never exists
  // (X/P1 loader gate, unchanged). A live on->off rides the per-trigger read
  // in the CONTEXT hook, never a captured block.
  if (!getExtensionConfig<CompactionSettings>(core, "compaction").enabled) return null;

  /**
   * Per-run settings view: the live block for this generation plus the
   * EFFECTIVE context window. An explicit compaction.contextLimit always
   * wins; otherwise callers that know the agent's resolved model config
   * pass it and the window is the EFFECTIVE MODEL WINDOW -- the same
   * resolveModelConfig value the shouldCompact trigger bills against. The
   * core knob (core.resolved.contextLimit, default 128000) must NOT budget
   * a larger-window model (2026-11-15 victim: a 262144-token model got a
   * ~120k keep and a ~246k trigger). Only views with no agent context --
   * the /compact <n> keep path and its debug dump -- fall back to
   * core.resolved. strategies.ts pins that the CALLER resolves the window;
   * the config block stays byte-untouched either way.
   */
  function runSettings(modelConfig?: ModelConfig | null): CompactionSettings {
    const s = getExtensionConfig<CompactionSettings>(core, "compaction");
    return {
      ...s,
      contextLimit:
        s.contextLimit ?? (modelConfig ? modelConfig.contextLimit : core.resolved?.contextLimit),
    };
  }

  /**
   * getModelConfig, tolerant of duck-typed/embedded agents that resolve no
   * window at all (no registry entry, no agent.contextLimit): null, so the
   * settings view falls back to core.resolved exactly as before. The
   * CONTEXT hook keeps the strict getModelConfig -- an unresolvable window
   * there is a config error and must surface.
   */
  function tryModelConfig(agent: Agent): ModelConfig | null {
    try {
      return getModelConfig(agent);
    } catch {
      return null;
    }
  }

  const strategyRegistry = new CompactionStrategyRegistry();
  strategyRegistry.register(new SummarizeStrategy());
  strategyRegistry.register(new DropStrategy());
  strategyRegistry.register(new SummarizeStrategy(SUMMARIZE_SHORT_VARIANT));
  strategyRegistry.register(new TokenAwareStrategy());
  strategyRegistry.register(new TrimStrategy());
  strategyRegistry.register(new PassTheBatonStrategy());

  /**
   * Live baton state per session: the recent-window stash pass-the-baton
   * hands the continuation (a popped tail, or the notice-append snapshot),
   * plus the flag set once the handoff has happened (via the handoff tool
   * or a narrated final message) and the fresh context awaits the replay.
   * Keyed by REAL sessionId only (M-26): this instance is shared across
   * every session, so a fallback key ("default") would let one agent
   * without a sessionId replay another's popped tail. Agents with no
   * sessionId are declined the tail-pop entirely (see _performCompaction).
   */
  const batonStash = new Map<string, { popped: Message[]; replayPending: boolean }>();

  // Helpers are nested in create() so they close over core and the registry;
  // every config value is read per run through getExtensionConfig (runSettings).

  /**
   * Ensure the conversation ends with a user turn.
   * Some strict chat templates (e.g. in LM Studio/llama.cpp) fail if the
   * message history ends with an assistant or tool message.
   */
  function ensureUserTurnGuard(messages: Message[], userTurnGuardPrompt: string): Message[] {
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
        content: userTurnGuardPrompt,
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
  function wireFor(agent: Agent, modelConfig: ModelConfig | null): WireRenderContext {
    const client = agent.llmClient as
      | { markerMangler?: WireRenderContext["mangler"]; resolveWireFormat?: (mc: ModelConfig | null) => WireRenderContext["wireFormat"] }
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
   * tool message) so the caller leaves the context untouched. `s` is the
   * caller's settings view (one live read, shared by canCompact +
   * execute so the pair always agrees).
   */
  async function _performCompaction(
    agent: Agent,
    strategy: CompactionStrategy,
    s: CompactionSettings,
  ): Promise<boolean> {
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
      const result = await strategy.execute(messages, s, llmChat, model, wire);
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

      // Tail-cut stash bookkeeping (pass-the-baton): whatever the strategy
      // hands in result.batonStash -- the popped tail on a pop, the recent
      // window snapshot on a notice-only append -- is mirrored to the live
      // map and the <session-id>.baton.json file BEFORE the context is
      // rewritten, so a handoff landing on this turn always has verbatim
      // turns to replay. When a pop finds an older un-replayed stash (the
      // model ignored the last pop and kept working), the old window is
      // MERGED ahead of the new cut and re-capped to the newest budget
      // window: timeline-wise the old popped tail sits between the kept
      // prefix and this pop's messages, and dropping it would lose the
      // newest narrated work. Best-effort mirror: a failed write must not
      // abort the baton itself.
      //
      // Declined outright without a real sessionId when a pop would lose
      // messages: the pop is only safe because the stash can hand the tail
      // back, and there is no safe shared key for sessionId-less agents
      // (bare factory-built workers, embeds) on this shared instance.
      // Losing the tail unrecoverably is worse than not compacting;
      // callers degrade onward (the overflow rescue chains to trim/drop).
      // A notice-only append costs nothing to lose and still runs without
      // a stash.
      if (tailCut && compactedCount > 0 && !agent.sessionId) {
        logger.warn(
          "[compaction] pass-the-baton declined: agent has no sessionId to stash the popped tail under",
        );
        return false;
      }
      if (tailCut) {
        const fresh = result.batonStash ?? messages.slice(messages.length - compactedCount);
        const prior = agent.sessionId ? batonStash.get(agent.sessionId) : undefined;
        const source =
          compactedCount > 0 && prior && !prior.replayPending
            ? mergeStashWindows(prior.popped, fresh)
            : fresh;
        const maxKeep = result.metadata?.maxKeepTokens;
        const stashed =
          typeof maxKeep === "number"
            ? recentWindow(source, estimatorFor(wire), maxKeep, result.appendNotice ?? "")
            : source;
        if (stashed.length > 0 && agent.sessionId) {
          await stashBatonMessages(agent.sessionId, stashed);
          batonStash.set(agent.sessionId, { popped: stashed, replayPending: false });
        }
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

      agent.replaceContext(ensureUserTurnGuard(newContext, s.userTurnGuardPrompt));

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
    const s = runSettings(); // one live read for this command run
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
      agent.replaceContext(ensureUserTurnGuard([...systemMessages, ...keptMessages], s.userTurnGuardPrompt));
      const keepContent = `Context compacted to ${keptMessages.length} messages.`;
      if (debug) {
        const written = await writeCompactionDump({
          ts: new Date().toISOString(),
          session_id: agent.sessionId ?? null,
          mode: "keep",
          keep_requested: opts.keep,
          strategy: null,
          settings: { ...s },
          messages: { before: nonSystemMessages.length, after: keptMessages.length },
        });
        if (written) {
          return { action: ACTIONS.DISPLAY, content: keepContent + "\n(Debug mode: debug file written.)" };
        }
      }
      return { action: ACTIONS.DISPLAY, content: keepContent };
    }

    const strategy = strategyRegistry.get(s.strategy) || strategyRegistry.getDefault();
    if (!strategy) {
      return { action: ACTIONS.ERROR, error: "No compaction strategy available." };
    }

    // A manual /compact orders compaction NOW -- it is not the
    // notice-first auto-trigger, so the baton pops (same directive the
    // overflow rescue uses). The window is the effective model config
    // when it resolves; duck-typed agents fall back to the core knob.
    const run = { ...runSettings(tryModelConfig(agent)), batonPopNow: true };

    if (!strategy.canCompact(nonSystemMessages, run)) {
      return { action: ACTIONS.DISPLAY, content: "Compaction not applicable with current settings." };
    }

    await _performCompaction(agent, strategy, run);

    const resultContent = `Context compacted using '${s.strategy}' strategy.`;
    if (debug) {
      const written = await writeCompactionDump({
        ts: new Date().toISOString(),
        session_id: agent.sessionId ?? null,
        mode: "strategy",
        keep_requested: null,
        strategy: s.strategy,
        settings: { ...run },
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

      // Runs before each LLM call; on an over-budget context drives the
      // baton flow (notice-first append, then degrade pop once the model
      // has demonstrably ignored the notice -- see the strategy doctrine).
      [HOOKS.CONTEXT]: async ({ messages, agent }) => {
        // Baton replay (first act of the fresh session): re-append the
        // stashed recent window verbatim, right after the plan message the
        // drain already placed in context (bus messages enter the context
        // before this hook fires, so the order is always plan-then-tail).
        // The stash-side boundary rule guarantees the window never starts
        // with a tool result orphaned from its parent assistant turn.
        const st = agent?.sessionId ? batonStash.get(agent.sessionId) : undefined;
        if (st?.replayPending) {
          await dropBaton(agent);
          const current = agent.context.getMessages();
          agent.replaceContext([...current, ...st.popped]);
          return { messages: agent.buildMessages() };
        }

        // Live reads only: an enabled on->off swap stops the NEXT trigger
        // from compacting (a run already in flight finishes -- P8's benign
        // twin). Direct accessor calls per use (no block binding); the
        // strategy view is the runSettings read below, once the model
        // window is known.
        if (!getExtensionConfig<CompactionSettings>(core, "compaction").enabled) return;

        const nonSystemMessages = messages.filter((m) => m.role !== "system");

        if (
          nonSystemMessages.length <=
          getExtensionConfig<CompactionSettings>(core, "compaction").keepRecentMessages * 2
        )
          return;

        const modelConfig = getModelConfig(agent);
        // R2: the strategy budget is resolved against the EFFECTIVE model
        // window -- the same value shouldCompact bills below -- not the
        // core contextLimit (default 128000), which under-counts
        // large-window models into an oversized pop.
        const s = runSettings(modelConfig);
        // The trigger bills the FULL window: the system prompt (base prompt +
        // AGENTS.md + skill chunks) rides every request, so estimating only
        // the conversation under-counts and the provider overflows before
        // compaction fires. Strategies still see -- and evict -- only the
        // non-system messages.
        // The last call's provider-reported prompt size (net + cached) rides in
        // as the second opinion: the local chars/4 estimate loses the race
        // against the tokenizer on code-heavy sessions, and the window dies at
        // finish_reason=length before the estimate ever crosses the gate.
        const usage = agent.context.getTokenUsage?.();
        const actualPromptTokens = usage ? (usage.promptTokens ?? 0) + (usage.cachedTokens ?? 0) : 0;
        if (
          !shouldCompact(
            messages,
            modelConfig.contextLimit,
            s.reserveTokens,
            wireFor(agent, modelConfig),
            actualPromptTokens,
          )
        )
          return;

        const strategy = strategyRegistry.get(s.strategy) || strategyRegistry.getDefault();
        if (!strategy) return;

        if (!strategy.canCompact(nonSystemMessages, s)) return;

        // _performCompaction rewrites agent.context in place.
        const compacted = await _performCompaction(agent, strategy, s);
        if (!compacted) return;

        return { messages: agent.buildMessages() };
      },

      /**
       * Baton handoff detection -- where the notice is CONSUMED. After
       * pass-the-baton appends its notice (notice-first: nothing popped)
       * there are two ways the session ends, and both must reach the same
       * fresh context:
       *
       *  A. The model calls the handoff tool. The handoff-tool extension
       *     (higher TURN_END priority, already run) clears the context and
       *     enqueues its plan; we only mark the stash for replay. The
       *     clear happened above us, so path A replays the LAST KNOWN
       *     stash (the append-time snapshot or the last pop's tail) -- the
       *     wrap-up itself lives inside the handoff plan.
       *  B. The model ignores the tool and just emits its handoff as a
       *     final summary message with stop ("completion"). We treat that
       *     the same: clear, restart on the summary as the plan (the same
       *     clear/ensureSystemPrompt/enqueue/claim sequence the handoff
       *     tool runs, owned by us), and mark the stash for replay.
       *
       * Stash-before-clear (R3): this clear wipes the context the recent
       * turns live in, and the plan text promises "Its most recent turns
       * are appended verbatim below". On path B nothing has popped yet
       * (notice-first), so the replay copy must be taken NOW: the last
       * stashed window merged with everything that arrived after the
       * notice, re-capped to the newest budget window. On path A the
       * context is already gone before this hook runs -- hence A's
       * documented best-effort limitation above.
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
        const notice =
          getExtensionConfig<CompactionSettings>(core, "compaction").batonNoticePrompt ??
          BATON_NOTICE_PROMPT;
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
          // STASH BEFORE THE CLEAR (R3): merge the last stashed window
          // with everything appended after the notice -- the work the
          // model did while wrapping up -- re-capped to the newest budget
          // window, and refresh the file mirror. If the window cannot be
          // computed the handoff still proceeds on the previous stash; a
          // stash problem must not strand the session mid-handoff.
          try {
            const live = agent.context.getMessages();
            let noticeIdx = -1;
            for (let i = live.length - 1; i >= 0; i--) {
              if (isBatonNoticeMessage(live[i], notice)) {
                noticeIdx = i;
                break;
              }
            }
            const mc = tryModelConfig(agent);
            const rs = runSettings(mc);
            const maxKeep = requireContextLimit(rs.contextLimit) - (rs.reserveTokens || 0);
            const fresh = recentWindow(
              mergeStashWindows(st.popped, live.slice(noticeIdx + 1)),
              estimatorFor(wireFor(agent, mc)),
              maxKeep,
              notice,
            );
            st.popped = fresh;
            await stashBatonMessages(agent.sessionId, fresh);
          } catch (e: unknown) {
            logger.warn(`[compaction] baton stash before handoff failed (keeping previous): ${formatError(e)}`);
          }
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
        //  - pass-the-baton POPS the newest messages immediately and orders a
        //    handoff (batonPopNow below: the full-size request already
        //    failed, there is no room for the notice-first round the auto
        //    trigger uses). The kept window stays a byte-prefix of the
        //    failed prompt, so prefix-matching runners re-read it from
        //    cache, and the cut lands on a clean exchange. Declined when
        //    no clean exchange boundary exists at a viable floor (a
        //    tool-only worker transcript -> null, this chain moves on),
        //    the estimate says the context fits, or there is no sessionId
        //    to stash the popped tail under.
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
        // One live read for the whole rescue chain: baton/trim/drop attempt the
        // same settings the overflow saw, and the NEXT rescue reads fresh.
        // R2: the window is the effective model config when it resolves,
        // so the baton's keep budget matches the provider's real window.
        const s: CompactionSettings = {
          ...runSettings(tryModelConfig(agent)),
          batonPopNow: true,
        };

        // Plausibility gate before touching anything: a real overflow is
        // physically large, so at least one measurement of THIS transcript
        // must sit at/over the billed budget. An error body that merely
        // QUOTES an overflow phrase (gateway wraps, upstream echoes) would
        // otherwise route a comfortably-fitting session into the chain --
        // and drop's gate is a message COUNT, so a long-but-fitting session
        // gets shredded (2026-11-18 victim: a transient 5xx quoting
        // "maximum context length" at 52% of the window, provider-reported
        // input 136,093/262,144, local chars/4 estimate also under budget).
        // Window unresolvable -> no gate, exactly as before (the strategies'
        // own requireContextLimit is the loud failure then).
        const beforeMessages = agent.context.getMessages();
        const usage = agent.context.getTokenUsage?.();
        const actualPromptTokens = usage ? (usage.promptTokens ?? 0) + (usage.cachedTokens ?? 0) : 0;
        let budget: number | null = null;
        let estimated = 0;
        try {
          budget = requireContextLimit(s.contextLimit) - (s.reserveTokens || 0);
          // The estimate is image-aware: providers that bill image tokens
          // OUTSIDE their reported usage make `actualPromptTokens` a number
          // that can never see the overflow (2026-11-18 victim: gauge
          // 67k/262k, provider input 66,569, real request >262,144 with
          // ~7.9 MB of base64 screenshots). A session whose image-inclusive
          // estimate is over the budget therefore PASSES this gate even when
          // the provider number sits comfortably under it.
          estimated = estimateContextTokens(beforeMessages);
          if (estimated < budget && actualPromptTokens < budget) {
            logger.warn(
              `[compaction] provider error quoted an overflow phrase, but session ${agent.sessionId} fits the budget on both sources (estimate ${estimated}, provider ${actualPromptTokens} < ${budget}); surfacing the error`,
            );
            return;
          }
        } catch {
          // Unresolved window: fall through, same posture as the chain below.
        }

        // IMAGE DOWNGRADE before anything else: images are compactible
        // weight, and on the rescue path the doctrine is aggressive -- strip
        // every image payload except the newest few (their text survives,
        // placeholder in place, and tool results carry the on-disk path so a
        // needed screenshot is still re-readable). Text-only reduction
        // "removing" image-dominated messages barely touches the bytes, and
        // the provider-side image accounting is unknowable from here, so
        // when the image-inclusive estimate is over budget, stale pixels go
        // first (2026-11-18 incident: the chain cut 40->6 messages every
        // turn while the 26 surviving payloads kept the request over the
        // limit; see tests/extensions/compaction-image-rescue.test.ts).
        let rescued = false;
        if (budget !== null && estimated > budget) {
          const { messages: downgraded, strippedImages } = downgradeOlderImages(
            beforeMessages,
            RESCUE_KEEP_RECENT_IMAGES,
          );
          if (strippedImages > 0) {
            agent.replaceContext(downgraded);
            logger.warn(
              `[compaction] overflow rescue: stripped ${strippedImages} stale image payloads (kept the newest ${RESCUE_KEEP_RECENT_IMAGES}) for session ${agent.sessionId}`,
            );
            // The strip alone cleared the budget: every message survives
            // with its text, no message-dropping chain needed.
            rescued = estimateContextTokens(downgraded) <= budget;
          }
        }

        if (!rescued) {
          const baton = strategyRegistry.get("pass-the-baton");
          if (baton && baton.canCompact(agent.context.getMessages(), s)) {
            rescued = await _performCompaction(agent, baton, s);
          }
        }
        if (!rescued) {
          // trim stays ungated (as before): its execute self-checks the fit,
          // so a genuine overflow of few but huge messages is rescued even
          // below the message-count gate.
          const trim = strategyRegistry.get("trim");
          if (trim) rescued = await _performCompaction(agent, trim, s);
        }
        if (!rescued) {
          const drop = strategyRegistry.get("drop");
          if (drop && drop.canCompact(agent.context.getMessages(), s)) {
            rescued = await _performCompaction(agent, drop, s);
          }
        }
        if (!rescued) {
          logger.warn(
            `[compaction] context overflow but no strategy could compact session ${agent.sessionId}; surfacing the error`,
          );
          return;
        }

        // Honest notice: a strategy can report success while removing
        // nothing (e.g. trim's orphan-safe boundary rewind walking back to
        // zero). Claiming "compacted the conversation" then is a lie, and
        // re-issuing the unchanged context behind it cannot heal an
        // overflow -- the retry only follows a real reduction. A reduction
        // is measured in context weight, not only message count: an image
        // downgrade removes bytes while keeping every message (a plain
        // length compare would call that "nothing reduced").
        const afterMessages = agent.context.getMessages();
        const reduced =
          afterMessages.length < beforeMessages.length ||
          (budget !== null && estimateContextTokens(afterMessages) < estimated);
        if (!reduced) {
          logger.warn(
            `[compaction] context overflow but compaction reduced nothing for session ${agent.sessionId}; surfacing the error`,
          );
          agent.sink?.emit({
            type: OUTPUT_EVENT.SYSTEM_MESSAGE,
            content: "Context overflow: compaction found nothing eligible to compact; surfacing the error.",
          });
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
          // Command-side switch writes the CURRENT generation's block in place
          // (same posture as before; the notify/transaction wiring is B4's job
          // -- writing through the live read keeps the current bag honest
          // instead of mutating a captured one).
          getExtensionConfig<CompactionSettings>(core, "compaction").strategy = name;
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

    // Exposed for external use: the CURRENT generation's block (tests and
    // hosts read/write through it; a create-time capture is exactly what B3
    // removes).
    registry: strategyRegistry,
    get settings(): CompactionSettings {
      return getExtensionConfig<CompactionSettings>(core, "compaction");
    },

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

