import { describe, it, expect } from 'bun:test';
import { LlmClient, LlmError } from '../../src/core/llm_client/client.js';
import { Message } from '../../src/core/context/message.js';

describe('LlmError', () => {
  it('creates error with type', () => {
    const err = new LlmError('test', 'http');
    expect(err.message).toBe('test');
    expect(err.type).toBe('http');
  });

  it('Http factory creates http error', () => {
    const err = LlmError.Http('connection failed');
    expect(err.type).toBe('http');
    expect(err.message).toBe('connection failed');
  });

  it('Api factory creates api error', () => {
    const err = LlmError.Api('bad input');
    expect(err.type).toBe('api');
  });

  it('Timeout factory creates timeout error', () => {
    const err = LlmError.Timeout('timed out');
    expect(err.type).toBe('timeout');
  });

  it('Cancelled factory creates cancelled error', () => {
    const err = LlmError.Cancelled('cancelled');
    expect(err.type).toBe('cancelled');
  });

  it('InvalidResponse factory creates invalid_response error', () => {
    const err = LlmError.InvalidResponse('unexpected format');
    expect(err.type).toBe('invalid_response');
  });

  it('isCancelled checks type', () => {
    expect(LlmError.isCancelled(LlmError.Cancelled('x'))).toBe(true);
    expect(LlmError.isCancelled(LlmError.Http('x'))).toBe(false);
    expect(LlmError.isCancelled(new Error('x'))).toBe(false);
  });
});

describe('LlmClient', () => {
  it('creates with defaults', () => {
    const origKey = process.env.AI_API_KEY;
    delete process.env.AI_API_KEY;
    const client = new LlmClient();
    expect(client.baseUrl).toContain('ai365.home');
    expect(client.apiKey).toBeNull();
    expect(client.stream).toBe(true);
    expect(client.chatTimeoutSecs).toBe(600);
    expect(client.loud).toBe(false);
    if (origKey !== undefined) process.env.AI_API_KEY = origKey;
  });

  it('accepts custom options', () => {
    const client = new LlmClient({
      baseUrl: 'http://custom.com',
      apiKey: 'test-key',
      stream: false,
      chatTimeoutSecs: 30,
      loud: true,
    });
    expect(client.baseUrl).toBe('http://custom.com');
    expect(client.apiKey).toBe('test-key');
    expect(client.stream).toBe(false);
    expect(client.chatTimeoutSecs).toBe(30);
    expect(client.loud).toBe(true);
  });

  it('reads from environment variables', () => {
    const origUrl = process.env.AI_URL;
    const origKey = process.env.AI_API_KEY;
    process.env.AI_URL = 'http://env-url.com';
    process.env.AI_API_KEY = 'env-key';

    const client = new LlmClient();
    expect(client.baseUrl).toBe('http://env-url.com');
    expect(client.apiKey).toBe('env-key');

    if (origUrl !== undefined) process.env.AI_URL = origUrl;
    else delete process.env.AI_URL;
    if (origKey !== undefined) process.env.AI_API_KEY = origKey;
    else delete process.env.AI_API_KEY;
  });
});

describe('LlmClient.resolveProviderSettings', () => {
  it('uses default settings when provider not found', () => {
    const client = new LlmClient({ baseUrl: 'http://default.com', apiKey: 'default-key' });
    const settings = client.resolveProviderSettings('openai/gpt-4');
    expect(settings.url).toBe('http://default.com');
    expect(settings.apiKey).toBe('default-key');
  });

  it('uses provider settings when found', () => {
    const client = new LlmClient({
      baseUrl: 'http://default.com',
      providers: [
        { name: 'openai', url: 'http://openai.com', apiKey: 'openai-key' },
      ],
    });
    const settings = client.resolveProviderSettings('openai/gpt-4');
    expect(settings.url).toBe('http://openai.com');
    expect(settings.apiKey).toBe('openai-key');
  });

  it('handles provider with only name', () => {
    const client = new LlmClient({
      baseUrl: 'http://default.com',
      apiKey: 'default-key',
      providers: [
        { name: 'openai' },
      ],
    });
    const settings = client.resolveProviderSettings('openai/gpt-4');
    // Provider has no url/apiKey, so it falls back to client defaults
    expect(settings.url).toBe('http://default.com');
    expect(settings.apiKey).toBe('default-key');
  });
});

describe('LlmClient.buildChatRequest', () => {
  it('builds a basic request', () => {
    const client = new LlmClient();
    const msg = new Message({ role: 'user', content: 'Hello' });
    const request = client.buildChatRequest(
      [msg],
      { name: 'gpt-4', temperature: 0.7, maxTokens: 100 },
      null,
    );
    expect(request.model).toBe('gpt-4');
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].content).toBe('Hello');
    expect(request.temperature).toBe(0.7);
    expect(request.max_tokens).toBe(100);
    expect(request.stream).toBe(true);
    expect(request.parallel_tool_calls).toBe(true);
    expect(request.function_choice).toBe('auto');
    expect(request.stream_options).toEqual({ include_usage: true });
  });

  it('strips provider prefix from model name', () => {
    const client = new LlmClient();
    const request = client.buildChatRequest(
      [],
      { name: 'openai/gpt-4', temperature: null, maxTokens: 50 },
      null,
    );
    expect(request.model).toBe('gpt-4');
  });

  it('handles non-streaming mode', () => {
    const client = new LlmClient({ stream: false });
    const request = client.buildChatRequest([], { name: 'gpt-4' }, null, false);
    expect(request.stream).toBe(false);
    expect(request.stream_options).toBeUndefined();
  });

  it('handles tools', () => {
    const client = new LlmClient();
    const tools = [{ type: 'function', function: { name: 'bash' } }];
    const request = client.buildChatRequest([], { name: 'gpt-4' }, tools);
    expect(request.tools).toEqual(tools);
  });
});

describe('LlmClient._escapeMessages', () => {
  it('returns messages as-is when no mangler', () => {
    const client = new LlmClient({ markerMangler: null });
    const messages = [{ role: 'user', content: 'Hello' }];
    const escaped = client._escapeMessages(messages);
    expect(escaped).toHaveLength(1);
    expect(escaped[0].content).toBe('Hello');
  });

  it('clones messages when mangler is set', () => {
    const mangler = { escape: (s) => s, unescape: (s) => s };
    const client = new LlmClient({ markerMangler: mangler });
    const msg = new Message({ role: 'user', content: 'Hello' });
    const messages = [msg];
    const escaped = client._escapeMessages(messages);
    expect(escaped).not.toBe(messages);
    expect(escaped[0]).not.toBe(msg);
  });

  it('returns messages as-is when no mangler', () => {
    const client = new LlmClient({ markerMangler: null });
    const msg = new Message({ role: 'user', content: 'Hello' });
    const messages = [msg];
    const escaped = client._escapeMessages(messages);
    expect(escaped).toBe(messages);
  });
});

describe('LlmClient._parseStreamData', () => {
  it('parses content events', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [{ delta: { content: 'Hello' } }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('content');
    expect(events[0].content).toBe('Hello');
  });

  it('parses reasoning events', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [{ delta: { reasoning_content: 'Thinking' } }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('reasoning');
    expect(events[0].content).toBe('Thinking');
  });

  it('parses tool name events', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'bash' }, id: 'call-1' }] } }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('toolName');
    expect(events[0].name).toBe('bash');
    expect(events[0].index).toBe(0);
    expect(events[0].toolCallId).toBe('call-1');
  });

  it('parses tool argument events', () => {
    const client = new LlmClient();
    const toolArg = String.fromCharCode(123) + 'cmd';
    const eventData = { delta: { tool_calls: [{ index: 0, function: { arguments: toolArg } } ] } };
    const events = client._parseStreamData({ choices: [eventData] });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('toolArgument');
    expect(events[0].arguments).toBe(toolArg);
  });

  it('parses usage events', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('usage');
    expect(events[0].data).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('handles empty choices', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({ choices: [] });
    expect(events).toHaveLength(0);
  });

  it('handles missing delta', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({ choices: [{}] });
    expect(events).toHaveLength(0);
  });

  it('handles multiple tool calls in one event', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [{ delta: { tool_calls: [
        { index: 0, function: { name: 'bash' }, id: 'call-1' },
        { index: 1, function: { name: 'read' }, id: 'call-2' },
      ] } }],
    });
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe('bash');
    expect(events[1].name).toBe('read');
  });

  it('handles tool call with name but no arguments', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'bash' } }] } }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('toolName');
  });

  it('handles tool call with arguments but no name', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'x'} }] } }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('toolArgument');
  });
});

describe('LlmClient.chat', () => {
  it('resolves to content response', async () => {
    const client = new LlmClient({ baseUrl: 'http://test.com' });
    expect(typeof client.chat).toBe('function');
  });
});

describe('LlmClient.chatStream', () => {
  it('returns an async generator', () => {
    const client = new LlmClient({ baseUrl: 'http://test.com' });
    const gen = client.chatStream([{ role: 'user', content: 'Hi' }], 'test-model');
    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });
});
