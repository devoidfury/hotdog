// Mock LLM client for testing.
// Produces programmable streams of events.

import type { LlmClient } from '../../src/core/llm-client/client.ts';

/**
 * Build a tool-call event sequence for a single tool call.
 */
function buildToolCallEvents({ index, name, arguments: args, id }: {
  index: number;
  name: string;
  arguments: string;
  id?: string;
}): Record<string, unknown>[] {
  return [
    { type: 'toolName', index, name, toolCallId: id || `call_${index}` },
    { type: 'toolArgument', index, arguments: args },
  ];
}

/**
 * Build a complete streaming response sequence.
 */
export function buildStreamResponse({
  content = '',
  reasoning = null,
  toolCalls = null,
  usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
}: {
  content?: string;
  reasoning?: string | null;
  toolCalls?: Array<{ index: number; name: string; arguments: string; id?: string }> | null;
  usage?: Record<string, unknown>;
}): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];

  if (reasoning) {
    events.push({ type: 'reasoning', content: reasoning });
  }

  if (content) {
    events.push({ type: 'content', content });
  }

  if (toolCalls) {
    for (const tc of toolCalls) {
      events.push(...buildToolCallEvents(tc));
    }
  }

  events.push({ type: 'usage', data: usage });
  return events;
}

/**
 * MockLLMClient — simulates streaming LLM responses for testing.
 */
export class MockLLMClient {
  baseUrl: string | null = null;
  apiKey: string | null = null;
  sessionId: string = '';
  loud: boolean = false;
  chatTimeoutSecs: number = 30;
  maxRetries: number = 3;
  stream: boolean = true;
  providers: Array<{ name: string; url: string; apiKey?: string | null }> = [];
  cancelled: boolean = false;

  _responseSequences: Record<string, unknown>[][] | undefined;
  _callIndex: number;
  cancelable: boolean;
  callCount: number;
  lastMessages: unknown[] | null;
  lastModelConfig: Record<string, unknown> | null;
  lastToolDefs: Record<string, unknown>[] | null;
  lastCancelSignal: AbortSignal | null;

  constructor({ responseSequences = [], cancelable = false }: {
    responseSequences?: Record<string, unknown>[][];
    cancelable?: boolean;
  } = {}) {
    this._responseSequences = responseSequences as Record<string, unknown>[][];
    this._callIndex = 0;
    this.cancelable = cancelable;
    this.callCount = 0;
    this.lastMessages = null;
    this.lastModelConfig = null;
    this.lastToolDefs = null;
    this.lastCancelSignal = null;
  }

  reset(sequences?: Record<string, unknown>[][]): void {
    this._responseSequences = sequences || this._responseSequences;
    this._callIndex = 0;
    this.callCount = 0;
    this.lastMessages = null;
    this.lastModelConfig = null;
    this.lastToolDefs = null;
    this.lastCancelSignal = null;
  }

  chatStreamCancellable(
    messages: unknown[],
    modelConfig: Record<string, unknown>,
    toolDefs: Record<string, unknown>[],
    cancelSignal: AbortSignal | null | undefined,
    sessionId?: string,
  ): AsyncGenerator<Record<string, unknown>, void, unknown> | (() => AsyncGenerator<Record<string, unknown>, void, unknown>) {
    this.callCount++;
    this.lastMessages = messages;
    this.lastModelConfig = modelConfig;
    this.lastToolDefs = toolDefs;
    this.lastCancelSignal = cancelSignal ?? null;

    const sequence = this._responseSequences?.[this._callIndex++];
    if (!sequence) {
      return (async function* (): AsyncGenerator<Record<string, unknown>> {})();
    }

    return this._makeStream(sequence, cancelSignal);
  }

  async *_makeStream(
    events: Record<string, unknown>[],
    cancelSignal: AbortSignal | null | undefined,
  ): AsyncGenerator<Record<string, unknown>> {
    for (const event of events) {
      if (cancelSignal?.aborted) return;
      await Promise.resolve();
      yield event;
    }
  }
}
