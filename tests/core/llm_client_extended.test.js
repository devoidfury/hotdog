import { describe, it, expect } from 'bun:test';
import { LlmClient, LlmError } from '../../src/llm_client/client.js';
import { Message } from '../../src/context/message.js';

describe('LlmClient.resolveProviderSettings', () => {
  it('falls back to defaults when provider not found', () => {
    const client = new LlmClient({ baseUrl: 'http://default.com', apiKey: 'default-key' });
    const settings = client.resolveProviderSettings('unknown/model');
    expect(settings.url).toBe('http://default.com');
    expect(settings.apiKey).toBe('default-key');
  });

  it('uses provider URL when found', () => {
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

  it('handles model name without provider prefix', () => {
    const client = new LlmClient({ baseUrl: 'http://default.com' });
    const settings = client.resolveProviderSettings('gpt-4');
    expect(settings.url).toBe('http://default.com');
  });

  it('uses default URL when providers list is empty', () => {
    const client = new LlmClient({ providers: [] });
    const settings = client.resolveProviderSettings('openai/gpt-4');
    // Default URL includes the port
    expect(settings.url).toBe('http://ai365.home:9292');
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
    expect(request.messages[0].content).toBe('Hello');
    expect(request.temperature).toBe(0.7);
    expect(request.max_tokens).toBe(100);
    expect(request.stream).toBe(true);
    expect(request.parallel_tool_calls).toBe(true);
    expect(request.function_choice).toBe('auto');
    expect(request.stream_options).toEqual({ include_usage: true });
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

  it('handles model name with multiple slashes (takes last part)', () => {
    const client = new LlmClient();
    const request = client.buildChatRequest(
      [],
      { name: 'provider/sub/model', temperature: null, maxTokens: 50 },
      null,
    );
    // split('/').pop() takes the last part
    expect(request.model).toBe('model');
  });

  it('disables stream when requested', () => {
    const client = new LlmClient();
    const request = client.buildChatRequest([], { name: 'gpt-4' }, null, false);
    expect(request.stream).toBe(false);
    expect(request.stream_options).toBeUndefined();
  });

  it('uses client default stream setting', () => {
    const client = new LlmClient({ stream: false });
    const request = client.buildChatRequest([], { name: 'gpt-4' }, null);
    expect(request.stream).toBe(false);
  });

  it('handles null tools as empty array', () => {
    const client = new LlmClient();
    const request = client.buildChatRequest([], { name: 'gpt-4' }, null);
    expect(request.tools).toEqual([]);
  });

  it('handles empty tools array', () => {
    const client = new LlmClient();
    const request = client.buildChatRequest([], { name: 'gpt-4' }, []);
    expect(request.tools).toEqual([]);
  });

  it('handles Message objects with tool_calls', () => {
    const client = new LlmClient();
    const msg = new Message({
      role: 'assistant',
      content: 'I will run a command',
      toolCalls: [{ id: 'tc1', function: { name: 'bash', arguments: '{}' } }],
    });
    const request = client.buildChatRequest([msg], { name: 'gpt-4' }, null);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].tool_calls).toHaveLength(1);
  });

  it('handles Message objects with reasoning_content', () => {
    const client = new LlmClient({ markerMangler: null });
    const msg = new Message({
      role: 'assistant',
      content: 'final answer',
      reasoningContent: 'thinking process',
    });
    const request = client.buildChatRequest([msg], { name: 'gpt-4' }, null);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].content).toBe('final answer');
  });

  it('handles Message objects with toolCallId (uses snake_case in JSON)', () => {
    const mangler = { escape: (s) => s, unescape: (s) => s };
    const client = new LlmClient({ markerMangler: mangler });
    const msg = new Message({
      role: 'tool',
      content: 'output',
      toolCallId: 'tc1',
    });
    const request = client.buildChatRequest([msg], { name: 'gpt-4' }, null);
    expect(request.messages).toHaveLength(1);
    // When mangler is set, toJSON() is called which uses snake_case
    expect(request.messages[0].tool_call_id).toBe('tc1');
  });
});

describe('LlmClient._escapeMessages', () => {
  it('returns messages as-is when mangler is null', () => {
    const client = new LlmClient({ markerMangler: null });
    const msg = new Message({ role: 'user', content: 'Hello' });
    const result = client._escapeMessages([msg]);
    expect(result[0]).toBe(msg);
  });

  it('clones messages when mangler is set', () => {
    const mangler = { escape: (s) => s, unescape: (s) => s };
    const client = new LlmClient({ markerMangler: mangler });
    const msg = new Message({ role: 'user', content: 'Hello' });
    const result = client._escapeMessages([msg]);
    expect(result).not.toBe([msg]);
    expect(result[0]).not.toBe(msg);
    expect(result[0].content).toBe('Hello');
  });

  it('escapes tool call names and arguments', () => {
    let escapedCalls = [];
    const mangler = {
      escape: (s) => {
        if (s.includes('bash')) escapedCalls.push(s);
        return s;
      },
      unescape: (s) => s,
    };
    const client = new LlmClient({ markerMangler: mangler });
    const msg = new Message({
      role: 'assistant',
      content: 'Running bash',
      toolCalls: [{ id: 'tc1', function: { name: 'bash', arguments: '{"cmd": "ls"}' } }],
    });
    client._escapeMessages([msg]);
    expect(escapedCalls).toContain('bash');
  });

  it('handles messages with no content (toJSON converts null to "")', () => {
    const mangler = { escape: (s) => s, unescape: (s) => s };
    const client = new LlmClient({ markerMangler: mangler });
    const msg = new Message({ role: 'assistant', content: null, toolCalls: null, toolCallId: null });
    const result = client._escapeMessages([msg]);
    // toJSON() converts null content to ""
    expect(result[0].content).toBe('');
  });

  it('handles empty messages array', () => {
    const mangler = { escape: (s) => s, unescape: (s) => s };
    const client = new LlmClient({ markerMangler: mangler });
    const result = client._escapeMessages([]);
    expect(result).toEqual([]);
  });
});

describe('LlmClient._parseStreamData', () => {
  it('handles choices with no delta', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({ choices: [{ delta: null }] });
    expect(events).toHaveLength(0);
  });

  it('handles choices with empty delta', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({ choices: [{ delta: {} }] });
    expect(events).toHaveLength(0);
  });

  it('handles multiple choices', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [
        { delta: { content: 'choice1' } },
        { delta: { content: 'choice2' } },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events[0].content).toBe('choice1');
    expect(events[1].content).toBe('choice2');
  });

  it('handles tool call with no function', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [{ delta: { tool_calls: [{ index: 0 }] } }],
    });
    expect(events).toHaveLength(0);
  });

  it('handles tool call with empty name', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '' } }] } }],
    });
    expect(events).toHaveLength(0);
  });

  it('handles tool call with empty arguments (produces toolName event)', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'bash', arguments: '' } }] } }],
    });
    // Empty arguments are still skipped (only toolName event)
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('toolName');
    expect(events[0].name).toBe('bash');
  });

  it('handles usage without choices', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('usage');
  });

  it('handles data without choices or usage', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({});
    expect(events).toHaveLength(0);
  });

  it('handles data with reasoning and content in same choice', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({
      choices: [{ delta: { reasoning_content: 'thinking', content: 'answer' } }],
    });
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('reasoning');
    expect(events[1].type).toBe('content');
  });
});

describe('LlmClient constructor options', () => {
  it('reads AI_URL from environment', () => {
    const orig = process.env.AI_URL;
    process.env.AI_URL = 'http://env-url.com';
    const client = new LlmClient();
    expect(client.baseUrl).toBe('http://env-url.com');
    if (orig !== undefined) process.env.AI_URL = orig;
    else delete process.env.AI_URL;
  });

  it('reads AI_API_KEY from environment', () => {
    const orig = process.env.AI_API_KEY;
    process.env.AI_API_KEY = 'env-key';
    const client = new LlmClient();
    expect(client.apiKey).toBe('env-key');
    if (orig !== undefined) process.env.AI_API_KEY = orig;
    else delete process.env.AI_API_KEY;
  });

  it('explicit options override environment', () => {
    const origUrl = process.env.AI_URL;
    const origKey = process.env.AI_API_KEY;
    process.env.AI_URL = 'http://env-url.com';
    process.env.AI_API_KEY = 'env-key';
    const client = new LlmClient({ baseUrl: 'http://explicit.com', apiKey: 'explicit-key' });
    expect(client.baseUrl).toBe('http://explicit.com');
    expect(client.apiKey).toBe('explicit-key');
    if (origUrl !== undefined) process.env.AI_URL = origUrl;
    else delete process.env.AI_URL;
    if (origKey !== undefined) process.env.AI_API_KEY = origKey;
    else delete process.env.AI_API_KEY;
  });

  it('sets sessionId', () => {
    const client = new LlmClient({ sessionId: 'test-session' });
    expect(client.sessionId).toBe('test-session');
  });

  it('sets loud mode', () => {
    const client = new LlmClient({ loud: true });
    expect(client.loud).toBe(true);
  });

  it('uses custom timeout', () => {
    const client = new LlmClient({ chatTimeoutSecs: 30 });
    expect(client.chatTimeoutSecs).toBe(30);
  });
});
