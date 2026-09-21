import { formatError, isExpectedError, LlmError } from "../error.ts";
import { OUTPUT_EVENT, OutputEvent } from "../context/output.ts";
import { contentToText, type Message, type MessageSource } from "../context/message.ts";
import { repairToolCalls } from "../context/repair.ts";
import { HOOKS } from "../hooks.ts";
import type { HookPayloads } from "../extensions/types.ts";
import { parseCommand, ACTIONS, SESSION_MUTATING_COMMANDS, ParsedCommand, type CommandRegistryLike } from "../commands.ts";
import type { CommandResult } from "../extensions/registries.ts";

/** INPUT pipeline payload: core's shape with the bus's minimal agent. The
 * pipeline adopts a handler's InputHookResult fields onto it. */
type InputPipelineData = Omit<HookPayloads["input"], "agent"> & { agent: MessageBusAgent };

export interface MessageBusSessionManager {
  getAgent(): MessageBusAgent | undefined;
}

/** Minimal Agent interface for message bus usage. */
export interface MessageBusAgent {
  hooks: {
    runHookPipeline(
      hookName: string,
      data: unknown,
      opts?: { shouldStop?: (result: unknown) => boolean },
    ): Promise<unknown>;
  };
  run(
    content: string | Array<Record<string, unknown>>,
    images?: unknown,
    opts?: { source?: MessageSource },
  ): Promise<unknown>;
  resetCancel(): void;
  cancel(): void;
  /**
   * Steering seam: in-core append drained between LLM calls. Present on the
   * real Agent; optional so test fakes can stay minimal. Submission goes
   * through enqueue(..., { steering: true }), not this method directly.
   */
  steer?(content: string | Array<Record<string, unknown>>): void;
  /**
   * Tool-call repair seam: present on the real Agent, optional so test fakes
   * can stay minimal. Used to heal interrupted tool calls after a cancelled
   * turn (an assistant message whose calls never got results is a guaranteed
   * 400 on the next request).
   */
  getMessages?(): Message[];
  replaceContext?(messages: Message[]): void;
  commandRegistry?: CommandRegistryLike | null;
  executeCommand(cmd: ParsedCommand): Promise<CommandResult | null>;
}

/**
 * A queued bus message. `content` is plain text or content parts (so harness
 * messages can carry `untrusted` parts, mangled only at the wire); `source`
 * carries provenance to the agent.
 */
export interface BusQueueItem {
  content: string | Array<Record<string, unknown>>;
  source?: MessageSource;
}

export interface Sink {
  emit(event: OutputEvent): void;
}

/**
 * Queue-boundary rule: structured content (content parts) is harness
 * semantic. Wrapper parts (file-include, system-notice) render with their
 * real tags at the wire -- a genuine-harness-marker guarantee that only
 * trusted producers (harness code enqueuing with harness provenance, or
 * INPUT-hook output, which is trusted code) may place in a message. A parts
 * array arriving from an external surface without harness provenance is
 * flattened to plain text so it rides the wire mangled like any user input.
 */
function sanitizeQueuedContent(
  content: string | Array<Record<string, unknown>>,
  source: MessageSource | undefined,
): string | Array<Record<string, unknown>> {
  if (source === "harness" || typeof content === "string" || !Array.isArray(content)) {
    return content;
  }
  return contentToText(content);
}

export interface MessageBusOptions {
  sessionManager: MessageBusSessionManager;
  sink: Sink;
  /** Optional callback to broadcast events to all connected clients. */
  broadcastCallback?: (msg: Record<string, unknown>) => void;
}

// Owns the agent run loop; no polling -- enqueue() resolves a per-iteration deferred.
export class MessageBus {
  // The active run loop's promise, or null. This is the single-consumer
  // guard: a second run()/runUntilCancelled() joins the existing loop instead
  // of starting a second consumer on one queue. Two consumers sharing the
  // single-slot #waiter strand parked generators and let one queued message
  // drive overlapping agent.run() calls (duplicate delivery).
  #loopPromise: Promise<void> | null = null;
  #sessionManager: MessageBusSessionManager;
  #sink: Sink;
  #queue: BusQueueItem[];
  #isRunning: boolean;
  #abortController: AbortController;
  #waiter: { resolve: () => void } | null;
  #broadcastCallback: ((msg: Record<string, unknown>) => void) | undefined;
  // Serializes mid-run steering delivery: pipelines are async, so per-item
  // fire-and-forget would let a later submission overtake an earlier one.
  #steerChain: Promise<void> = Promise.resolve();

  constructor({ sessionManager, sink, broadcastCallback }: MessageBusOptions) {
    this.#sessionManager = sessionManager;
    this.#sink = sink;
    this.#broadcastCallback = broadcastCallback;
    this.#queue = [];
    this.#isRunning = false;
    // cancel() aborts it; interrupt() does NOT -- the bus keeps waiting for input.
    this.#abortController = new AbortController();
    this.#waiter = null;
  }

  enqueue(
    content: string | Array<Record<string, unknown>>,
    opts?: { source?: MessageSource; steering?: boolean },
  ): void {
    const clean = sanitizeQueuedContent(content, opts?.source);
    const agent = this.#sessionManager.getAgent();
    if (opts?.steering && this.#isRunning && agent?.steer) {
      // Same processing as any other message only the delivery slot differs:
      // the agent's steering queue, drained before the next LLM call, instead of waiting for a run-loop slot.
      // The chain preserves submission order across async pipelines.
      this.#steerChain = this.#steerChain.then(() => this.#deliverSteering(agent, clean, opts?.source));
      return;
    }
    this.#queue.push({ content: clean, source: opts?.source });
    this._wakeWaiter();
  }

  /** Ends the run loop; the bus is unusable afterwards unless reset(). */
  cancel(): void {
    this.#abortController.abort();
    const agent = this.#sessionManager.getAgent();
    if (agent) agent.cancel();
    this._wakeWaiter();
  }

  /** Cancels the active request and clears the queue, but keeps the run loop alive (Ctrl-C). */
  interrupt(): void {
    const agent = this.#sessionManager.getAgent();
    if (agent) agent.cancel();
    this.#queue = [];
    this._wakeWaiter();
  }

  /** Makes a cancelled bus usable again; the queue is preserved. */
  reset(): void {
    this.#abortController = new AbortController();
    // No touch on #loopPromise: the cancelled loop unwinds asynchronously and
    // its .finally releases the slot. Clearing it here would let a run() race
    // a still-exiting old loop.
  }

  get isCancelled(): boolean {
    return this.#abortController.signal.aborted;
  }

  isIdle(): boolean {
    return (
      !this.#isRunning &&
      this.#queue.length === 0 &&
      !this.#abortController.signal.aborted
    );
  }

  get sessionManager(): MessageBusSessionManager {
    return this.#sessionManager;
  }

  get agent(): MessageBusAgent | undefined {
    return this.#sessionManager.getAgent();
  }

  /** @internal */
  get queue(): string[] {
    return this.#queue.map((item) => contentToText(item.content));
  }
  /** @internal Raw queue items (parts + provenance), for testing. */
  get queueItems(): BusQueueItem[] {
    return this.#queue;
  }
  set queue(v: Array<string | BusQueueItem>) {
    this.#queue = v.map((item) => (typeof item === "string" ? { content: item } : item));
  }

  /** @internal */
  get isRunning(): boolean {
    return this.#isRunning;
  }
  set isRunning(v: boolean) {
    this.#isRunning = v;
  }

  /** @internal Pending mid-run steering delivery chain (for testing). */
  get steeringPending(): Promise<void> {
    return this.#steerChain;
  }

  /** @internal */
  get abortController(): AbortController {
    return this.#abortController;
  }

  /** @internal */
  get waiter(): { resolve: () => void } | null {
    return this.#waiter;
  }
  set waiter(v: { resolve: () => void } | null) {
    this.#waiter = v;
  }

  /** Blocks until cancelled. Idempotent: a second call joins the active loop. */
  async run(): Promise<void> {
    return this.#ensureLoop(false);
  }

  /** Like run(), but drains the queue after cancellation before exiting. */
  async runUntilCancelled(): Promise<void> {
    return this.#ensureLoop(true);
  }

  // Single-consumer run loop. The FIRST run()/runUntilCancelled() starts the
  // loop and records its promise; any later call JOINS the same promise
  // instead of spawning a second consumer. Two consumers on one #waiter is
  // the root of the duplicate-delivery bug: the UI hosts
  // (ui-interactive-cli, ui-one-shot) call run() after SessionManager
  // already started the loop, so without this they race the manager's loop
  // and a single queued message can drive two agent.run() calls (the loser
  // then throws AlreadyRunning inside _processMessage).
  #ensureLoop(drain: boolean): Promise<void> {
    if (this.#loopPromise) {
      return this.#loopPromise;
    }
    const loop = (async () => {
      for await (const item of this._messages(drain)) {
        await this._processMessage(item);
      }
    })();
    const tracked = loop.finally(() => {
      if (this.#loopPromise === tracked) this.#loopPromise = null;
    });
    this.#loopPromise = tracked;
    return tracked;
  }

  _wakeWaiter(): void {
    if (this.#waiter) {
      const resolve = this.#waiter.resolve;
      this.#waiter = null;
      resolve();
    }
  }

  /** Yields queued messages; drains remaining ones after cancellation when drain is set. */
  async *_messages(drain: boolean = false): AsyncGenerator<BusQueueItem> {
    const signal = this.#abortController.signal;
    while (true) {
      while (this.#queue.length > 0) {
        if (signal.aborted && !drain) break;
        yield this.#queue.shift()!;
      }

      if (signal.aborted) {
        if (!drain) break;
        // Drain mode: exit only once the queue is empty after cancellation.
        if (this.#queue.length === 0) break;
        continue;
      }

      const promise = new Promise<void>((resolve) => {
        this.#waiter = { resolve };
      });
      await promise;
      this.#waiter = null;
    }
  }

  /** Broadcasts to all clients, not just those attached to this session. */
  #emitSessionState(key: string, value: unknown, sessionId?: string): void {
    const event: OutputEvent = {
      type: OUTPUT_EVENT.SESSION_STATE,
      key,
      value,
      sessionId,
    };
    this.#sink.emit(event);

    if (this.#broadcastCallback) {
      this.#broadcastCallback({
        type: "sessionState",
        key,
        value,
        sessionId,
      });
    }
  }

  /**
   * After a cancelled turn settles, the context may hold an assistant message
   * whose tool calls never received results (interrupted mid-execution). The
   * next request would 400 on a strict backend, so the missing results are
   * synthesized in memory (orphan results dropped). The session log keeps its
   * original lines: replay repair re-derives the identical repair on resume.
   */
  #repairInterruptedToolCalls(agent: MessageBusAgent): void {
    if (typeof agent.getMessages !== "function" || typeof agent.replaceContext !== "function") {
      return;
    }
    const { messages, repaired, dropped } = repairToolCalls(agent.getMessages());
    if (repaired.length === 0 && dropped.length === 0) return;

    agent.replaceContext(messages);

    const parts: string[] = [];
    if (repaired.length > 0) {
      parts.push(`synthesized results for interrupted tool call(s): ${repaired.join(", ")}`);
    }
    if (dropped.length > 0) {
      parts.push(`dropped ${dropped.length} orphan tool result(s)`);
    }
    this.#sink.emit({
      type: OUTPUT_EVENT.SYSTEM_MESSAGE,
      content: `Repaired tool calls after cancel: ${parts.join("; ")}.`,
    });
  }

  /**
   * INPUT hook pipeline, shared by the run loop and steering delivery.
   * Hooks see flattened text; the structured content (with its trust parts) is what reaches the agent.
   * The pipeline adopts a handler's InputHookResult fields (action/content) onto this payload.
   */
  async #runInputPipeline(
    agent: MessageBusAgent,
    content: string | Array<Record<string, unknown>>,
    source: MessageSource | undefined,
  ): Promise<{ content: string | Array<Record<string, unknown>>; handled: boolean }> {
    if (!agent.hooks) return { content, handled: false };

    const inputData: InputPipelineData = {
      text: contentToText(content),
      source: "interactive",
      origin: source,
      agent,
    };
    const inputResult = (await agent.hooks.runHookPipeline(
      HOOKS.INPUT,
      inputData,
      { shouldStop: (result: unknown) => (result as { action?: string })?.action === "handled" },
    )) as { stopped?: boolean };
    if (inputResult.stopped) return { content, handled: true };

    if (inputData.action === "transform" && inputData.content !== undefined) {
      // A transform replaces the content. Structured results pass through with the hook's own parts (INPUT-hook output
      // is trusted code; the wire applies each part type's trust spec)
      return {
        content:
          typeof inputData.content === "string" && Array.isArray(content)
            ? [{ type: "untrusted", text: inputData.content }]
            : inputData.content,
        handled: false,
      };
    }
    return { content, handled: false };
  }

  /** Steering delivery: INPUT pipeline, then the agent's steering seam. */
  async #deliverSteering(
    agent: MessageBusAgent,
    content: string | Array<Record<string, unknown>>,
    source: MessageSource | undefined,
  ): Promise<void> {
    try {
      const piped = await this.#runInputPipeline(agent, content, source);
      if (piped.handled) return;
      agent.steer!(piped.content);
    } catch (e: unknown) {
      this.#sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: isExpectedError(e) ? (e as Error).message : formatError(e),
      });
    }
  }

  /** Runs the input hook pipeline, then hands off to the agent. */
  async _processMessage(item: string | BusQueueItem): Promise<void> {
    // Accept a bare string (tests / simple callers) or a full queue item.
    const source: MessageSource | undefined = typeof item === "string" ? undefined : item.source;
    let content: string | Array<Record<string, unknown>> =
      typeof item === "string" ? item : item.content;
    this.#isRunning = true;
    const agent = this.#sessionManager.getAgent();
    if (!agent) {
      this.#isRunning = false;
      this.#emitSessionState("working", false);
      return;
    }

    // sessionId lets the frontend track per-session working state.
    const agentSid = (agent as { sessionId?: string }).sessionId;
    this.#emitSessionState("working", true, agentSid);

    // Reset before processing so a leftover cancel from an interrupt can't swallow this run.
    agent.resetCancel();

    const piped = await this.#runInputPipeline(agent, content, source);
    if (piped.handled) {
      this.#isRunning = false;
      this.#emitSessionState("working", false, agentSid);
      return;
    }
    content = piped.content;

    try {
      await agent.run(content, undefined, source ? { source } : undefined);
    } catch (e: unknown) {
      // Suppress cancellation errors on interrupt — the UI already
      // prints an "Interrupted" message, so the full error is noise.
      const isCancellation =
        (e instanceof LlmError && e.type === "cancelled") ||
        (e instanceof Error && e.name === "AbortError") ||
        LlmError.isCancelled(e);

      if (!isCancellation) {
        this.#sink.emit({
          type: OUTPUT_EVENT.COMMAND_RESULT,
          content: isExpectedError(e) ? (e as Error).message : formatError(e),
        });
      } else {
        this.#repairInterruptedToolCalls(agent);
      }
    }

    this.#isRunning = false;
    this.#emitSessionState("working", false, agentSid);
  }

  async executeCommand(cmdText: string): Promise<number | undefined> {
    const agent = this.#sessionManager.getAgent();
    const cmd = parseCommand(cmdText, agent?.commandRegistry);

    if (!agent) {
      this.#sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: "No agent available.",
      });
      return;
    }

    // Rewriting/branching the context mid-turn could corrupt both histories: in-flight loop would append to the array being undone,
    // or a fork would snapshot an agent whose turn is still writing.
    if (this.#isRunning && SESSION_MUTATING_COMMANDS.has(cmd.type)) {
      this.#sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content:
          `/${cmd.type} is not available while the session is running — ` +
          `wait for it to finish or interrupt (Ctrl-C) first.`,
      });
      return ACTIONS.ERROR;
    }

    const result = await agent.executeCommand(cmd);

    if (!result) {
      return;
    }

    // Bitflags: multiple actions can fire simultaneously.
    // PROMPT enqueues the content as a user message so the normal run loop sends it to the LLM.
    if (result.action && (result.action & ACTIONS.PROMPT) && result.content) {
      this.enqueue(result.content);
    }

    if (result.action && (result.action & ACTIONS.ERROR) && result.error) {
      this.#sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: result.error,
      });
    }

    if (result.action && (result.action & ACTIONS.DISPLAY) && result.content) {
      this.#sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: result.content,
      });
    }

    // Backward compat: action absent means error/content are the payload.
    // Only triggers when action is null/undefined, not 0 (a valid "no action" bitflag).
    if (result.action == null && result.error) {
      this.#sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: result.error,
      });
    }
    if (result.action == null && result.content) {
      this.#sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: result.content,
      });
    }

    return result.action;
  }
}
