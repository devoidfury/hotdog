// AgentSink — bridges Agent output to the Session Core.
// Two modes: normal agent (all events forwarded) and task agent (filtered).

import { OUTPUT_EVENT, OutputEvent, OutputEventType } from "../context/output.ts";

export interface AgentSinkOptions {
  parentSink?: { emit: (event: OutputEvent) => void } | null;
  isTaskAgent?: boolean;
  onTaskComplete?: ((taskId: string | null, result: string) => void) | null;
}

/**
 * Output sink assigned to every agent. Routes agent output events
 * through the Session Core for further processing.
 *
 * Two modes:
 * 1. Normal agent: `#isTaskAgent = false` — all events forwarded to parent sink.
 * 2. Task agent: `#isTaskAgent = true` — filters streaming/tool events,
 *    only TASK_PROGRESS passes through. On completion, calls onTaskComplete().
 */
export class AgentSink {
  #parentSink: { emit: (event: OutputEvent) => void } | null;
  #isTaskAgent: boolean;
  #onTaskComplete: ((taskId: string | null, result: string) => void) | null;
  #taskId: string | null;

  /**
   * @param options
   * @param options.parentSink — The parent sink to forward events to
   * @param options.isTaskAgent — If true, filter output
   * @param options.onTaskComplete — Called when task agent finishes
   */
  constructor(options: AgentSinkOptions = {}) {
    this.#parentSink = options.parentSink || null;
    this.#isTaskAgent = options.isTaskAgent || false;
    this.#onTaskComplete = options.onTaskComplete || null;
    this.#taskId = null;
  }

  /**
   * Emit an output event.
   * Task agents filter streaming/tool/events — only TASK_PROGRESS passes through.
   * @param event
   */
  emit(event: OutputEvent): void {
    if (this.#isTaskAgent) {
      // Task agents are silent to the UI — filter most events
      const filterTypes: OutputEventType[] = [
        OUTPUT_EVENT.STREAMING_CHUNK,
        OUTPUT_EVENT.STREAMING_REASONING_CHUNK,
        OUTPUT_EVENT.TOOL_CALL,
        OUTPUT_EVENT.TOOL_RESULT,
        OUTPUT_EVENT.ASSISTANT_MESSAGE,
        OUTPUT_EVENT.THINKING,
        OUTPUT_EVENT.COMMAND_RESULT,
      ];

      if (filterTypes.includes(event.type)) {
        return; // Silent — don't forward to UI
      }

      // TASK_PROGRESS events pass through
      if (event.type === OUTPUT_EVENT.TASK_PROGRESS) {
        if (this.#parentSink) {
          this.#parentSink.emit(event);
        }
      }

      // Token usage always passes through for task agents
      if (event.type === OUTPUT_EVENT.TOKEN_USAGE) {
        if (this.#parentSink) {
          this.#parentSink.emit(event);
        }
      }

      return;
    }

    // Normal agent: forward all events to parent sink
    if (this.#parentSink) {
      this.#parentSink.emit(event);
    }
  }

  /**
   * Set the task ID for this task agent sink.
   * @param taskId
   */
  setTaskAgentId(taskId: string): void {
    this.#taskId = taskId;
  }

  /**
   * Called when the task agent completes.
   * Routes the result back to the parent via onTaskComplete callback.
   * @param result
   */
  onTaskComplete(result: string): void {
    // Emit TASK_PROGRESS for the completion
    if (this.#parentSink) {
      this.#parentSink.emit({
        type: OUTPUT_EVENT.TASK_PROGRESS,
        taskId: this.#taskId,
        content: `Task ${this.#taskId} completed`,
      });
    }

    if (this.#onTaskComplete) {
      this.#onTaskComplete(this.#taskId, result);
    }
  }

  /**
   * Check if this sink is for a task agent.
   * @returns Whether this is a task agent sink.
   */
  get isTaskAgent(): boolean {
    return this.#isTaskAgent;
  }

  /**
   * Set the parent sink (exposed for testing).
   * @param sink — The parent sink to forward events to.
   */
  set parentSink(sink: { emit: (event: OutputEvent) => void } | null) {
    this.#parentSink = sink;
  }
}
