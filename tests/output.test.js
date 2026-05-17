import { describe, it, expect } from 'bun:test';
import { OUTPUT_EVENT, outputEvent, OutputSink, NoopSink } from '../src/context/output.js';

describe('OUTPUT_EVENT', () => {
  it('has all expected event types', () => {
    expect(OUTPUT_EVENT.USER_MESSAGE).toBe(1);
    expect(OUTPUT_EVENT.ASSISTANT_MESSAGE).toBe(2);
    expect(OUTPUT_EVENT.THINKING).toBe(3);
    expect(OUTPUT_EVENT.TOOL_CALL).toBe(4);
    expect(OUTPUT_EVENT.TOOL_RESULT).toBe(5);
    expect(OUTPUT_EVENT.COMPACTING).toBe(6);
    expect(OUTPUT_EVENT.COMMAND_RESULT).toBe(7);
    expect(OUTPUT_EVENT.QUESTION).toBe(8);
    expect(OUTPUT_EVENT.STREAMING_CHUNK).toBe(9);
    expect(OUTPUT_EVENT.STREAMING_REASONING_CHUNK).toBe(10);
    expect(OUTPUT_EVENT.TASK_PROGRESS).toBe(11);
    expect(OUTPUT_EVENT.TOKEN_USAGE).toBe(12);
  });
});

describe('outputEvent', () => {
  it('creates an event with type and data', () => {
    const event = outputEvent(OUTPUT_EVENT.USER_MESSAGE, { content: 'Hello' });
    expect(event.type).toBe(1);
    expect(event.content).toBe('Hello');
  });

  it('creates an event with empty data', () => {
    const event = outputEvent(OUTPUT_EVENT.USER_MESSAGE);
    expect(event.type).toBe(1);
    expect(event).toEqual({ type: 1 });
  });
});

describe('OutputSink', () => {
  it('emits user messages', () => {
    const sink = new OutputSink();
    const emitted = [];
    sink.emitUserMessage = (content) => emitted.push(content);
    sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE, content: 'Hello' });
    expect(emitted).toEqual(['Hello']);
  });

  it('emits assistant messages', () => {
    const sink = new OutputSink({ stream: true });
    const written = [];
    sink.emitAssistantMessage = (content) => written.push(content);
    sink.emit({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: 'Response' });
    expect(written).toEqual(['Response']);
  });

  it('emits thinking', () => {
    const sink = new OutputSink();
    const written = [];
    sink.emitThinking = (content) => written.push(content);
    sink.emit({ type: OUTPUT_EVENT.THINKING, content: 'Thinking...' });
    expect(written).toEqual(['Thinking...']);
  });

  it('emits tool call', () => {
    const sink = new OutputSink();
    const emitted = [];
    sink.emitToolCall = (name, input, id) => emitted.push({ name, input, id });
    sink.emit({ type: OUTPUT_EVENT.TOOL_CALL, toolName: 'bash', input: '{"cmd":"ls"}', toolCallId: '1' });
    expect(emitted).toEqual([{ name: 'bash', input: '{"cmd":"ls"}', id: '1' }]);
  });

  it('emits tool result', () => {
    const sink = new OutputSink();
    const emitted = [];
    sink.emitToolResult = (name, input, result) => emitted.push({ name, input, result });
    sink.emit({ type: OUTPUT_EVENT.TOOL_RESULT, toolName: 'bash', input: '{}', result: 'output' });
    expect(emitted).toEqual([{ name: 'bash', input: '{}', result: 'output' }]);
  });

  it('emits compacting', () => {
    const sink = new OutputSink();
    const emitted = [];
    sink.emitCompacting = (count, keep) => emitted.push({ count, keep });
    sink.emit({ type: OUTPUT_EVENT.COMPACTING, messageCount: 10, keepRecent: 3 });
    expect(emitted).toEqual([{ count: 10, keep: 3 }]);
  });

  it('emits command result', () => {
    const sink = new OutputSink();
    const written = [];
    sink.emitCommandResult = (content) => written.push(content);
    sink.emit({ type: OUTPUT_EVENT.COMMAND_RESULT, content: 'done' });
    expect(written).toEqual(['done']);
  });

  it('emits question', () => {
    const sink = new OutputSink();
    const emitted = [];
    sink.emitQuestion = (questions) => emitted.push(questions);
    sink.emit({ type: OUTPUT_EVENT.QUESTION, questions: [{ key: 'name' }] });
    expect(emitted).toEqual([[{ key: 'name' }]]);
  });

  it('emits streaming chunk when enabled', () => {
    const sink = new OutputSink({ stream: true });
    const written = [];
    sink.emitStreamingChunk = (content) => written.push(content);
    sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: 'chunk' });
    expect(written).toEqual(['chunk']);
  });

  it('emits streaming reasoning chunk', () => {
    const sink = new OutputSink({ stream: true });
    const written = [];
    sink.emitStreamingReasoningChunk = (content) => written.push(content);
    sink.emit({ type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: 'reasoning' });
    expect(written).toEqual(['reasoning']);
  });

  it('emits task progress', () => {
    const sink = new OutputSink();
    const emitted = [];
    sink.emitTaskProgress = (active, total) => emitted.push({ active, total });
    sink.emit({ type: OUTPUT_EVENT.TASK_PROGRESS, activeTasks: 2, totalTasks: 5 });
    expect(emitted).toEqual([{ active: 2, total: 5 }]);
  });

  it('emits token usage', () => {
    const sink = new OutputSink();
    const emitted = [];
    sink.emitTokenUsage = (prompt, cached, completion, total) => emitted.push({ prompt, cached, completion, total });
    sink.emit({ type: OUTPUT_EVENT.TOKEN_USAGE, promptTokens: 100, cachedTokens: 50, completionTokens: 200, totalTokens: 350 });
    expect(emitted).toEqual([{ prompt: 100, cached: 50, completion: 200, total: 350 }]);
  });

  it('respects stream setting', () => {
    const sink = new OutputSink({ stream: false });
    expect(sink.stream).toBe(false);
  });

  it('defaults to stream true', () => {
    const sink = new OutputSink();
    expect(sink.stream).toBe(true);
  });

  it('reset is a no-op', () => {
    const sink = new OutputSink();
    expect(() => sink.reset()).not.toThrow();
  });
});

describe('NoopSink', () => {
  it('silently discards all events', () => {
    const sink = new NoopSink();
    expect(() => sink.emit({ type: 1, content: 'test' })).not.toThrow();
  });
});
