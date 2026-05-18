import { describe, it, expect } from 'bun:test';
import { OutputSink, NoopSink, OUTPUT_EVENT, outputEvent } from '../src/context/output.js';

describe('outputEvent', () => {
  it('creates event with type and data', () => {
    const event = outputEvent(OUTPUT_EVENT.USER_MESSAGE, { content: 'hello' });
    expect(event.type).toBe(OUTPUT_EVENT.USER_MESSAGE);
    expect(event.content).toBe('hello');
  });

  it('creates event with empty data', () => {
    const event = outputEvent(OUTPUT_EVENT.COMMAND_RESULT);
    expect(event.type).toBe(OUTPUT_EVENT.COMMAND_RESULT);
  });
});

describe('NoopSink', () => {
  it('does nothing on emit', () => {
    const sink = new NoopSink();
    expect(() => sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE })).not.toThrow();
    expect(() => sink.emit({ type: OUTPUT_EVENT.TOOL_CALL })).not.toThrow();
    expect(() => sink.emit({ type: OUTPUT_EVENT.TOKEN_USAGE })).not.toThrow();
  });
});

describe('OutputSink', () => {
  it('creates with default stream enabled', () => {
    const sink = new OutputSink();
    expect(sink.stream).toBe(true);
  });

  it('accepts custom stream option', () => {
    const sink = new OutputSink({ stream: false });
    expect(sink.stream).toBe(false);
  });

  it('dispatches events to correct handler', () => {
    const handlers = [];
    const sink = new OutputSink();
    // Override handlers to track calls
    sink.emitUserMessage = (event) => handlers.push('user');
    sink.emitAssistantMessage = (event) => handlers.push('assistant');
    sink.emitThinking = (event) => handlers.push('thinking');
    sink.emitToolCall = (event) => handlers.push('tool_call');
    sink.emitToolResult = (event) => handlers.push('tool_result');
    sink.emitCompacting = (event) => handlers.push('compacting');
    sink.emitCommandResult = (event) => handlers.push('command');
    sink.emitQuestion = (event) => handlers.push('question');
    sink.emitStreamingChunk = (event) => handlers.push('streaming');
    sink.emitStreamingReasoningChunk = (event) => handlers.push('reasoning');
    sink.emitTaskProgress = (event) => handlers.push('task');
    sink.emitTokenUsage = (event) => handlers.push('token');

    sink.emit(outputEvent(OUTPUT_EVENT.USER_MESSAGE, { content: 'hi' }));
    sink.emit(outputEvent(OUTPUT_EVENT.ASSISTANT_MESSAGE, { content: 'hello' }));
    sink.emit(outputEvent(OUTPUT_EVENT.THINKING, { content: 'thinking' }));
    sink.emit(outputEvent(OUTPUT_EVENT.TOOL_CALL, { toolName: 'bash' }));
    sink.emit(outputEvent(OUTPUT_EVENT.TOOL_RESULT, { toolName: 'bash', result: 'out' }));
    sink.emit(outputEvent(OUTPUT_EVENT.COMMAND_RESULT, { content: 'cmd out' }));
    sink.emit(outputEvent(OUTPUT_EVENT.QUESTION, { question: 'what?' }));
    sink.emit(outputEvent(OUTPUT_EVENT.STREAMING_CHUNK, { content: 'chunk' }));
    sink.emit(outputEvent(OUTPUT_EVENT.STREAMING_REASONING_CHUNK, { content: 'think' }));
    sink.emit(outputEvent(OUTPUT_EVENT.TASK_PROGRESS, { status: 'ok' }));
    sink.emit(outputEvent(OUTPUT_EVENT.TOKEN_USAGE, { totalTokens: 100 }));

    expect(handlers).toEqual([
      'user', 'assistant', 'thinking', 'tool_call', 'tool_result',
      'command', 'question', 'streaming', 'reasoning', 'task', 'token',
    ]);
  });

  it('ignores unknown event types', () => {
    const sink = new OutputSink();
    // Should not throw for unknown event type
    expect(() => sink.emit({ type: 999 })).not.toThrow();
  });

  it('emitAssistantMessage writes to stdout', () => {
    const originalStdout = process.stdout.write;
    let written = '';
    process.stdout.write = (data) => { written += data; return true; };
    
    const sink = new OutputSink();
    sink.emitAssistantMessage({ content: 'assistant output' });
    
    expect(written).toBe('assistant output');
    process.stdout.write = originalStdout;
  });

  it('emitThinking writes to stderr', () => {
    const originalStderr = process.stderr.write;
    let written = '';
    process.stderr.write = (data) => { written += data; return true; };
    
    const sink = new OutputSink();
    sink.emitThinking({ content: 'thinking content' });
    
    expect(written).toBe('thinking content');
    process.stderr.write = originalStderr;
  });

  it('emitCommandResult writes to stdout with newline', () => {
    const originalStdout = process.stdout.write;
    let written = '';
    process.stdout.write = (data) => { written += data; return true; };
    
    const sink = new OutputSink();
    sink.emitCommandResult({ content: 'command output' });
    
    expect(written).toBe('command output\n');
    process.stdout.write = originalStdout;
  });

  it('emitStreamingChunk writes when stream enabled', () => {
    const originalStdout = process.stdout.write;
    let written = '';
    process.stdout.write = (data) => { written += data; return true; };
    
    const sink = new OutputSink({ stream: true });
    sink.emitStreamingChunk({ content: 'stream chunk' });
    
    expect(written).toBe('stream chunk');
    process.stdout.write = originalStdout;
  });

  it('emitStreamingChunk does not write when stream disabled', () => {
    const originalStdout = process.stdout.write;
    let written = '';
    process.stdout.write = (data) => { written += data; return true; };
    
    const sink = new OutputSink({ stream: false });
    sink.emitStreamingChunk({ content: 'stream chunk' });
    
    expect(written).toBe('');
    process.stdout.write = originalStdout;
  });

  it('emitStreamingReasoningChunk writes when stream enabled', () => {
    const originalStderr = process.stderr.write;
    let written = '';
    process.stderr.write = (data) => { written += data; return true; };
    
    const sink = new OutputSink({ stream: true });
    sink.emitStreamingReasoningChunk({ content: 'reasoning chunk' });
    
    expect(written).toBe('reasoning chunk');
    process.stderr.write = originalStderr;
  });

  it('emitStreamingReasoningChunk does not write when stream disabled', () => {
    const originalStderr = process.stderr.write;
    let written = '';
    process.stderr.write = (data) => { written += data; return true; };
    
    const sink = new OutputSink({ stream: false });
    sink.emitStreamingReasoningChunk({ content: 'reasoning chunk' });
    
    expect(written).toBe('');
    process.stderr.write = originalStderr;
  });

  it('emitToolCall does nothing by default', () => {
    const sink = new OutputSink();
    // Should not throw
    expect(() => sink.emitToolCall({ toolName: 'bash', input: '{}' })).not.toThrow();
  });

  it('emitToolResult does nothing by default', () => {
    const sink = new OutputSink();
    // Should not throw
    expect(() => sink.emitToolResult({ toolName: 'bash', result: 'output' })).not.toThrow();
  });

  it('emitCompacting does nothing by default', () => {
    const sink = new OutputSink();
    // Should not throw
    expect(() => sink.emitCompacting({ messageCount: 10, keepRecent: 2 })).not.toThrow();
  });

  it('emitQuestion does nothing by default', () => {
    const sink = new OutputSink();
    // Should not throw
    expect(() => sink.emitQuestion({ question: 'What is your name?' })).not.toThrow();
  });

  it('emitTaskProgress does nothing by default', () => {
    const sink = new OutputSink();
    // Should not throw
    expect(() => sink.emitTaskProgress({ status: 'task_result_received' })).not.toThrow();
  });

  it('emitTokenUsage does nothing by default', () => {
    const sink = new OutputSink();
    // Should not throw
    expect(() => sink.emitTokenUsage({ totalTokens: 100 })).not.toThrow();
  });

  it('emitUserMessage does nothing by default', () => {
    const sink = new OutputSink();
    // Should not throw
    expect(() => sink.emitUserMessage({ content: 'user message' })).not.toThrow();
  });

  it('reset does nothing by default', () => {
    const sink = new OutputSink();
    expect(() => sink.reset()).not.toThrow();
  });
});

describe('OUTPUT_EVENT constants', () => {
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

describe('EVENT_HANDLERS mapping', () => {
  it('maps all event types to handler methods', async () => {
    const { EVENT_HANDLERS } = await import('../src/context/output.js');
    expect(EVENT_HANDLERS[OUTPUT_EVENT.USER_MESSAGE]).toBe('emitUserMessage');
    expect(EVENT_HANDLERS[OUTPUT_EVENT.ASSISTANT_MESSAGE]).toBe('emitAssistantMessage');
    expect(EVENT_HANDLERS[OUTPUT_EVENT.THINKING]).toBe('emitThinking');
    expect(EVENT_HANDLERS[OUTPUT_EVENT.TOOL_CALL]).toBe('emitToolCall');
    expect(EVENT_HANDLERS[OUTPUT_EVENT.TOOL_RESULT]).toBe('emitToolResult');
    expect(EVENT_HANDLERS[OUTPUT_EVENT.COMPACTING]).toBe('emitCompacting');
    expect(EVENT_HANDLERS[OUTPUT_EVENT.COMMAND_RESULT]).toBe('emitCommandResult');
    expect(EVENT_HANDLERS[OUTPUT_EVENT.QUESTION]).toBe('emitQuestion');
    expect(EVENT_HANDLERS[OUTPUT_EVENT.STREAMING_CHUNK]).toBe('emitStreamingChunk');
    expect(EVENT_HANDLERS[OUTPUT_EVENT.STREAMING_REASONING_CHUNK]).toBe('emitStreamingReasoningChunk');
    expect(EVENT_HANDLERS[OUTPUT_EVENT.TASK_PROGRESS]).toBe('emitTaskProgress');
    expect(EVENT_HANDLERS[OUTPUT_EVENT.TOKEN_USAGE]).toBe('emitTokenUsage');
  });
});
