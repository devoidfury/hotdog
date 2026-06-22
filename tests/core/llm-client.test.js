import { describe, it, expect } from 'bun:test';
import { LlmClient, LlmError } from '../../src/core/llm-client/client.js';
import { Message } from '../../src/core/context/message.js';

describe('LlmError', () => {
  it('creates error with type', () => {
    const err = new LlmError('test', 'http');
    expect(err.message).toBe('test');
    expect(err.type).toBe('http');
  });

  it('factory methods create typed errors', () => {
    expect(LlmError.Http('fail').type).toBe('http');
    expect(LlmError.Api('bad input').type).toBe('api');
    expect(LlmError.Timeout('timed out').type).toBe('timeout');
    expect(LlmError.Cancelled('cancelled').type).toBe('cancelled');
    expect(LlmError.InvalidResponse('malformed').type).toBe('invalid_response');
  });

  it('isCancelled checks type', () => {
    expect(LlmError.isCancelled(LlmError.Cancelled('x'))).toBe(true);
    expect(LlmError.isCancelled(LlmError.Http('x'))).toBe(false);
    expect(LlmError.isCancelled(new Error('x'))).toBe(false);
  });
});

describe('LlmClient constructor', () => {
  it('creates with defaults', () => {
    const origKey = process.env.AI_API_KEY;
    const origUrl = process.env.AI_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_URL;
    try {
      const client = new LlmClient();
      // Default baseUrl is null (configured at runtime via config resolution)
      expect(client.baseUrl).toBeNull();
      expect(client.apiKey).toBeNull();
      expect(client.stream).toBe(true);
      expect(client.chatTimeoutSecs).toBe(600);
    } finally {
      if (origKey !== undefined) process.env.AI_API_KEY = origKey;
      else delete process.env.AI_API_KEY;
      if (origUrl !== undefined) process.env.AI_URL = origUrl;
      else delete process.env.AI_URL;
    }
  });

  it('accepts custom options', () => {
    const client = new LlmClient({
      baseUrl: 'http://custom.com',
      apiKey: 'test-key',
      stream: false,
      chatTimeoutSecs: 30,
    });
    expect(client.baseUrl).toBe('http://custom.com');
    expect(client.apiKey).toBe('test-key');
    expect(client.stream).toBe(false);
    expect(client.chatTimeoutSecs).toBe(30);
  });

  it('reads from environment variables', () => {
    const origUrl = process.env.AI_URL;
    const origKey = process.env.AI_API_KEY;
    process.env.AI_URL = 'http://env-url.com';
    process.env.AI_API_KEY = 'env-key';
    try {
      const client = new LlmClient();
      expect(client.baseUrl).toBe('http://env-url.com');
      expect(client.apiKey).toBe('env-key');
    } finally {
      if (origUrl !== undefined) process.env.AI_URL = origUrl;
      else delete process.env.AI_URL;
      if (origKey !== undefined) process.env.AI_API_KEY = origKey;
      else delete process.env.AI_API_KEY;
    }
  });

  it('explicit options override environment', () => {
    const origUrl = process.env.AI_URL;
    const origKey = process.env.AI_API_KEY;
    process.env.AI_URL = 'http://env-url.com';
    process.env.AI_API_KEY = 'env-key';
    try {
      const client = new LlmClient({ baseUrl: 'http://explicit.com', apiKey: 'explicit-key' });
      expect(client.baseUrl).toBe('http://explicit.com');
      expect(client.apiKey).toBe('explicit-key');
    } finally {
      if (origUrl !== undefined) process.env.AI_URL = origUrl;
      else delete process.env.AI_URL;
      if (origKey !== undefined) process.env.AI_API_KEY = origKey;
      else delete process.env.AI_API_KEY;
    }
  });
});

describe('LlmClient.resolveProviderSettings', () => {
  it('falls back to defaults when provider not found', () => {
    const client = new LlmClient({ baseUrl: 'http://default.com', apiKey: 'default-key' });
    const settings = client.resolveProviderSettings('unknown/model');
    expect(settings.url).toBe('http://default.com');
    expect(settings.apiKey).toBe('default-key');
  });

  it('uses provider settings when found', () => {
    const client = new LlmClient({
      baseUrl: 'http://default.com',
      apiKey: 'default-key',
      providers: [{ name: 'openai', url: 'http://openai.com', apiKey: 'openai-key' }],
    });
    const settings = client.resolveProviderSettings('openai/gpt-4');
    expect(settings.url).toBe('http://openai.com');
    expect(settings.apiKey).toBe('openai-key');
  });

  it('uses provider URL but falls back to client apiKey', () => {
    const client = new LlmClient({
      baseUrl: 'http://default.com',
      apiKey: 'default-key',
      providers: [{ name: 'openai', url: 'http://openai.com' }],
    });
    const settings = client.resolveProviderSettings('openai/gpt-4');
    expect(settings.url).toBe('http://openai.com');
    expect(settings.apiKey).toBe('default-key');
  });
});

describe('LlmClient.buildChatRequest', () => {
  it('builds request with all fields', () => {
    const client = new LlmClient();
    const messages = [new Message({ role: 'user', content: 'Hello' })];
    const request = client.buildChatRequest(
      messages,
      { name: 'gpt-4', temperature: 0.7, maxTokens: 100 },
      [{ type: 'function', function: { name: 'bash' } }],
    );
    expect(request.model).toBe('gpt-4');
    expect(request.messages).toHaveLength(1);
    expect(request.temperature).toBe(0.7);
    expect(request.max_tokens).toBe(100);
    expect(request.stream).toBe(true);
    expect(request.parallel_tool_calls).toBe(true);
    expect(request.tools).toHaveLength(1);
  });

  it('strips provider prefix from model name', () => {
    const client = new LlmClient();
    const request = client.buildChatRequest(
      [],
      { name: 'anthropic/claude-sonnet-4-20250514', temperature: null, maxTokens: 50 },
      null,
    );
    expect(request.model).toBe('claude-sonnet-4-20250514');
  });

  it('disables stream when requested', () => {
    const client = new LlmClient();
    const request = client.buildChatRequest([], { name: 'gpt-4' }, null, false);
    expect(request.stream).toBe(false);
    expect(request.stream_options).toBeUndefined();
  });

  it('handles Message objects with tool_calls', () => {
    const client = new LlmClient();
    const msg = new Message({
      role: 'assistant',
      content: 'I will run a command',
      toolCalls: [{ id: 'tc1', function: { name: 'bash', arguments: '{}' } }],
    });
    const request = client.buildChatRequest([msg], { name: 'gpt-4' }, null);
    expect(request.messages[0].tool_calls).toHaveLength(1);
  });

  it('handles Message objects with toolCallId', () => {
    const client = new LlmClient();
    const msg = new Message({ role: 'tool', content: 'output', toolCallId: 'tc1' });
    const request = client.buildChatRequest([msg], { name: 'gpt-4' }, null);
    // Messages are escaped to JSON which includes tool_call_id
    expect(request.messages[0].tool_call_id).toBe('tc1');
  });
});

describe('LlmClient.chatStream', () => {
  it('returns an async generator', () => {
    const client = new LlmClient({ baseUrl: 'http://test.com' });
    const gen = client.chatStream([{ role: 'user', content: 'Hi' }], 'test-model');
    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });
});
