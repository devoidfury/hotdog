import { describe, it, expect } from 'bun:test';
import { LlmClient, LlmError } from '../src/llm_client/client.js';

describe('LlmError', () => {
  it('creates errors with type', () => {
    const err = new LlmError('test', 'http');
    expect(err.message).toBe('test');
    expect(err.type).toBe('http');
  });

  it('has static factory methods', () => {
    expect(LlmError.Http('msg').type).toBe('http');
    expect(LlmError.Api('msg').type).toBe('api');
    expect(LlmError.Timeout('msg').type).toBe('timeout');
    expect(LlmError.Cancelled('msg').type).toBe('cancelled');
    expect(LlmError.InvalidResponse('msg').type).toBe('invalid_response');
  });

  it('isCancelled checks type', () => {
    expect(LlmError.isCancelled(LlmError.Cancelled('test'))).toBe(true);
    expect(LlmError.isCancelled(new Error('test'))).toBe(false);
    expect(LlmError.isCancelled(LlmError.Http('test'))).toBe(false);
  });
});

describe('LlmClient constructor', () => {
  it('uses defaults', () => {
    const origApiKey = process.env.AI_API_KEY;
    delete process.env.AI_API_KEY;
    const client = new LlmClient();
    if (origApiKey) process.env.AI_API_KEY = origApiKey;
    expect(client.apiKey).toBeNull();
    expect(client.loud).toBe(false);
    expect(client.stream).toBe(true);
    expect(client.chatTimeoutSecs).toBe(600);
  });

  it('accepts custom options', () => {
    const client = new LlmClient({
      baseUrl: 'http://custom:5000',
      apiKey: 'test-key',
      loud: true,
      stream: false,
      chatTimeoutSecs: 60,
    });
    expect(client.baseUrl).toBe('http://custom:5000');
    expect(client.apiKey).toBe('test-key');
    expect(client.loud).toBe(true);
    expect(client.stream).toBe(false);
    expect(client.chatTimeoutSecs).toBe(60);
  });

  it('reads from environment variables', () => {
    const origAiUrl = process.env.AI_URL;
    const origApiKey = process.env.AI_API_KEY;
    process.env.AI_URL = 'http://env-url:9000';
    process.env.AI_API_KEY = 'env-key';

    const client = new LlmClient();
    expect(client.baseUrl).toBe('http://env-url:9000');
    expect(client.apiKey).toBe('env-key');

    process.env.AI_URL = origAiUrl;
    process.env.AI_API_KEY = origApiKey;
  });

  it('options override environment variables', () => {
    const origAiUrl = process.env.AI_URL;
    const origApiKey = process.env.AI_API_KEY;
    process.env.AI_URL = 'http://env-url:9000';
    process.env.AI_API_KEY = 'env-key';

    const client = new LlmClient({
      baseUrl: 'http://opt-url:8000',
      apiKey: 'opt-key',
    });
    expect(client.baseUrl).toBe('http://opt-url:8000');
    expect(client.apiKey).toBe('opt-key');

    process.env.AI_URL = origAiUrl;
    process.env.AI_API_KEY = origApiKey;
  });
});

describe('LlmClient.resolveProviderSettings', () => {
  it('returns default settings for unknown provider', () => {
    const client = new LlmClient({ baseUrl: 'http://default:3000', apiKey: 'default-key' });
    const settings = client.resolveProviderSettings('unknown/model');
    expect(settings.url).toBe('http://default:3000');
    expect(settings.apiKey).toBe('default-key');
  });

  it('returns provider-specific settings when provider exists', () => {
    const client = new LlmClient({
      baseUrl: 'http://default:3000',
      apiKey: 'default-key',
      providers: [
        { name: 'openai', url: 'http://openai:3000', apiKey: 'openai-key' },
        { name: 'anthropic', url: 'http://anthropic:3000' },
      ],
    });

    expect(client.resolveProviderSettings('openai/gpt-4').url).toBe('http://openai:3000');
    expect(client.resolveProviderSettings('openai/gpt-4').apiKey).toBe('openai-key');
    expect(client.resolveProviderSettings('anthropic/claude').url).toBe('http://anthropic:3000');
    expect(client.resolveProviderSettings('anthropic/claude').apiKey).toBe('default-key');
  });

  it('handles model names without provider prefix', () => {
    const client = new LlmClient({ baseUrl: 'http://default:3000' });
    const settings = client.resolveProviderSettings('gpt-4');
    expect(settings.url).toBe('http://default:3000');
  });
});

describe('LlmClient.buildChatRequest', () => {
  it('builds a basic chat request', () => {
    const client = new LlmClient();
    const messages = [
      { role: 'system', content: 'You are helpful', toJSON: () => ({ role: 'system', content: 'You are helpful' }) },
      { role: 'user', content: 'Hello', toJSON: () => ({ role: 'user', content: 'Hello' }) },
    ];
    const request = client.buildChatRequest(messages, { name: 'gpt-4', maxTokens: 100 });

    expect(request.model).toBe('gpt-4');
    expect(request.messages).toHaveLength(2);
    expect(request.max_tokens).toBe(100);
    expect(request.stream).toBe(true);
    expect(request.parallel_tool_calls).toBe(true);
    expect(request.function_choice).toBe('auto');
    expect(request.stream_options).toEqual({ include_usage: true });
  });

  it('sets temperature when provided', () => {
    const client = new LlmClient();
    const request = client.buildChatRequest([], { name: 'gpt-4', temperature: 0.7 });
    expect(request.temperature).toBe(0.7);
  });

  it('includes tools when provided', () => {
    const client = new LlmClient();
    const tools = [{ type: 'function', function: { name: 'test' } }];
    const request = client.buildChatRequest([], { name: 'gpt-4' }, tools);
    expect(request.tools).toEqual(tools);
  });

  it('disables streaming when requested', () => {
    const client = new LlmClient({ stream: false });
    const request = client.buildChatRequest([], { name: 'gpt-4' });
    expect(request.stream).toBe(false);
    expect(request.stream_options).toBeUndefined();
  });

  it('extracts model name from provider/model format', () => {
    const client = new LlmClient();
    const request = client.buildChatRequest([], { name: 'openai/gpt-4' });
    expect(request.model).toBe('gpt-4');
  });
});

describe('LlmClient._escapeMessages', () => {
  it('escapes protected markers in content', () => {
    const client = new LlmClient();
    const messages = [
      { role: 'user', content: 'Hello <previous-context-summary>test</previous-context-summary>', toJSON: () => ({ role: 'user', content: 'Hello <previous-context-summary>test</previous-context-summary>' }) },
    ];
    const escaped = client._escapeMessages(messages);
    // The protected marker should be escaped to m_<alias> form
    expect(escaped[0].content).not.toBe(messages[0].content);
    expect(escaped[0].content).toContain('m_');
  });

  it('escapes markers in tool calls', () => {
    const client = new LlmClient();
    const msg = {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        function: { name: 'bash', arguments: 'test' },
      }],
      toJSON: () => ({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          function: { name: 'bash', arguments: 'test' },
        }],
      }),
    };
    const messages = [msg];
    const escaped = client._escapeMessages(messages);
    expect(escaped[0].tool_calls).toBeDefined();
    expect(escaped[0].tool_calls[0].function.name).toBe('bash');
  });

  it('returns messages as-is when no mangler', () => {
    const client = new LlmClient({ markerMangler: null });
    const msg = { role: 'user', content: 'test', toJSON: () => ({ role: 'user', content: 'test' }) };
    const escaped = client._escapeMessages([msg]);
    expect(escaped[0].content).toBe('test');
  });
});

describe('LlmClient._parseStreamData', () => {
  it('parses content events', () => {
    const client = new LlmClient();
    const data = {
      choices: [{ delta: { content: 'Hello' } }],
    };
    const events = client._parseStreamData(data);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('content');
    expect(events[0].content).toBe('Hello');
  });

  it('parses reasoning events', () => {
    const client = new LlmClient();
    const data = {
      choices: [{ delta: { reasoning_content: 'Thinking...' } }],
    };
    const events = client._parseStreamData(data);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('reasoning');
    expect(events[0].content).toBe('Thinking...');
  });

  it('parses tool call name events', () => {
    const client = new LlmClient();
    const data = {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'bash' }, id: 'call-1' }] } }],
    };
    const events = client._parseStreamData(data);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('toolName');
    expect(events[0].name).toBe('bash');
    expect(events[0].toolCallId).toBe('call-1');
  });

  it('parses tool call argument events', () => {
    const client = new LlmClient();
    const toolCall = { index: 0, function: { arguments: 'arg1' } };
    const delta = { tool_calls: [toolCall] };
    const data = { choices: [{ delta }] };
    const events = client._parseStreamData(data);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('toolArgument');
    expect(events[0].arguments).toBe('arg1');
  });

  it('parses usage events', () => {
    const client = new LlmClient();
    const data = {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const events = client._parseStreamData(data);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('usage');
    expect(events[0].data).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('parses mixed events', () => {
    const client = new LlmClient();
    const data = {
      choices: [
        { delta: { content: 'Hello' } },
        { delta: { reasoning_content: 'Thinking' } },
        { delta: { tool_calls: [{ index: 0, function: { name: 'bash' }, id: 'call-1' }] } },
      ],
      usage: { prompt_tokens: 10 },
    };
    const events = client._parseStreamData(data);
    expect(events.length).toBeGreaterThan(2);
    expect(events.find(e => e.type === 'content')).toBeDefined();
    expect(events.find(e => e.type === 'reasoning')).toBeDefined();
    expect(events.find(e => e.type === 'toolName')).toBeDefined();
    expect(events.find(e => e.type === 'usage')).toBeDefined();
  });

  it('handles empty choices', () => {
    const client = new LlmClient();
    const events = client._parseStreamData({});
    expect(events).toHaveLength(0);
  });
});

describe('LlmClient.ping', () => {
  it('returns normally on successful ping', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true });

    const client = new LlmClient();
    await expect(client.ping()).resolves.toBeUndefined();

    global.fetch = originalFetch;
  });

  it('throws on non-ok response', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500 });

    const client = new LlmClient();
    await expect(client.ping()).rejects.toThrow('HTTP 500');

    global.fetch = originalFetch;
  });

  it('throws Http error on fetch failure', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('Network error'); };

    const client = new LlmClient();
    await expect(client.ping()).rejects.toThrow();

    global.fetch = originalFetch;
  });
});
