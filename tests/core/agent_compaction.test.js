import { describe, it, expect } from 'bun:test';
import { Agent } from '../src/agent/agent.js';
import { Message, MessageLog } from '../src/context/index.js';
import { NoopSink } from '../src/context/output.js';
import { OUTPUT_EVENT } from '../src/context/output.js';

describe('Agent.compactMessages', () => {
  it('returns null when messages are below threshold', async () => {
    const agent = new Agent({
      compaction: { enabled: true, keepRecentMessages: 10 },
      sink: new NoopSink(),
    });
    agent.ensureSystemPrompt();
    agent.addInput('Hello');
    agent.addResponse('Hi there!');
    const result = await agent.compactMessages();
    expect(result).toBeNull();
  });

  it('returns null when compaction is disabled', async () => {
    const agent = new Agent({
      compaction: { enabled: false, keepRecentMessages: 1 },
      sink: new NoopSink(),
    });
    agent.ensureSystemPrompt();
    for (let i = 0; i < 50; i++) {
      agent.addInput(`User message ${i}`);
      agent.addResponse(`Response ${i}`);
    }
    const result = await agent.compactMessages();
    expect(result).toBeNull();
  });

  it('emits COMPACTING event when compaction triggers', async () => {
    const events = [];
    const mockSink = {
      emit: (event) => { events.push(event); },
    };
    const agent = new Agent({
      compaction: { enabled: true, keepRecentMessages: 1 },
      sink: mockSink,
    });
    agent.ensureSystemPrompt();
    for (let i = 0; i < 50; i++) {
      agent.addInput(`User message ${i}`);
      agent.addResponse(`Response ${i}`);
    }

    const mockClient = {
      chatStreamCancellable: async function* () {
        yield { type: 'content', content: 'Summarized context' };
      },
    };
    agent.client = mockClient;

    await agent.compactMessages();

    const compactingEvent = events.find(e => e.type === OUTPUT_EVENT.COMPACTING);
    expect(compactingEvent).toBeDefined();
    expect(compactingEvent.messageCount).toBeGreaterThan(0);
  });

  it('rebuilds context with summary after compaction', async () => {
    const agent = new Agent({
      compaction: { enabled: true, keepRecentMessages: 1 },
      sink: new NoopSink(),
    });
    agent.ensureSystemPrompt();
    agent.addInput('First user message');
    agent.addResponse('First response');
    agent.addInput('Second user message');
    agent.addResponse('Second response');

    const mockClient = {
      chatStreamCancellable: async function* () {
        yield { type: 'content', content: 'Summarized conversation about user queries' };
      },
    };
    agent.client = mockClient;

    for (let i = 0; i < 50; i++) {
      agent.addInput(`User message ${i}`);
      agent.addResponse(`Response ${i}`);
    }

    await agent.compactMessages();

    // Context should have been rebuilt with summary
    const messages = agent.context.getMessages();
    // Summary is wrapped in a previous-context-summary tag
    const summaryMsg = messages.find(m => m.role === 'user' && m.content && m.content.includes('<previous-context-summary>'));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg.content).toContain('Summarized conversation about user queries');

    // Should have kept recent messages
    const assistantMsg = messages.find(m => m.role === 'assistant' && m.content && m.content.includes('Response 49'));
    expect(assistantMsg).toBeDefined();
  });

  it('respects overrideKeep parameter', async () => {
    const agent = new Agent({
      compaction: { enabled: true, keepRecentMessages: 10 },
      sink: new NoopSink(),
    });
    agent.ensureSystemPrompt();
    for (let i = 0; i < 50; i++) {
      agent.addInput(`User message ${i}`);
      agent.addResponse(`Response ${i}`);
    }

    const mockClient = {
      chatStreamCancellable: async function* () {
        yield { type: 'content', content: 'Summary' };
      },
    };
    agent.client = mockClient;

    await agent.compactMessages(1);

    const messages = agent.context.getMessages();
    const summaryMsg = messages.find(m => m.role === 'user' && m.content && m.content.includes('<previous-context-summary>'));
    expect(summaryMsg).toBeDefined();
  });

  it('writes compaction debug file when enabled', async () => {
    const fs = require('node:fs');
    const agent = new Agent({
      compaction: { enabled: true, keepRecentMessages: 1 },
      sink: new NoopSink(),
      compactDebug: true,
    });
    agent.ensureSystemPrompt();
    for (let i = 0; i < 50; i++) {
      agent.addInput(`User message ${i}`);
      agent.addResponse(`Response ${i}`);
    }

    const mockClient = {
      chatStreamCancellable: async function* () {
        yield { type: 'content', content: 'Summary' };
      },
    };
    agent.client = mockClient;

    try {
      fs.unlinkSync('compaction.out.json');
    } catch {}

    await agent.compactMessages();

    expect(fs.existsSync('compaction.out.json')).toBe(true);
    const content = JSON.parse(fs.readFileSync('compaction.out.json', 'utf-8'));
    expect(Array.isArray(content)).toBe(true);

    fs.unlinkSync('compaction.out.json');
  });

  it('logs compaction to session log', async () => {
    const logWrites = [];
    const mockSessionLog = {
      writeCompaction: (count, summary) => {
        logWrites.push({ count, summary });
      },
      writeSystemPrompt: () => {},
      writeInput: () => {},
      writeToolResult: () => {},
      writeAssistant: () => {},
      writeReset: () => {},
      writePrompt: () => {},
    };
    const agent = new Agent({
      compaction: { enabled: true, keepRecentMessages: 1 },
      sink: new NoopSink(),
      sessionLog: mockSessionLog,
    });
    agent.ensureSystemPrompt();
    for (let i = 0; i < 50; i++) {
      agent.addInput(`User message ${i}`);
      agent.addResponse(`Response ${i}`);
    }

    const mockClient = {
      chatStreamCancellable: async function* () {
        yield { type: 'content', content: 'Conversation summary' };
      },
    };
    agent.client = mockClient;

    await agent.compactMessages();

    expect(logWrites).toHaveLength(1);
    expect(logWrites[0].count).toBeGreaterThan(0);
    expect(logWrites[0].summary).toBe('Conversation summary');
  });

  it('returns summary string after successful compaction', async () => {
    const agent = new Agent({
      compaction: { enabled: true, keepRecentMessages: 1 },
      sink: new NoopSink(),
    });
    agent.ensureSystemPrompt();
    for (let i = 0; i < 50; i++) {
      agent.addInput(`User message ${i}`);
      agent.addResponse(`Response ${i}`);
    }

    const mockClient = {
      chatStreamCancellable: async function* () {
        yield { type: 'content', content: 'Summarized conversation' };
      },
    };
    agent.client = mockClient;

    const result = await agent.compactMessages();
    expect(typeof result).toBe('string');
    expect(result).toBe('Summarized conversation');
  });

  it('preserves kept messages after compaction', async () => {
    const agent = new Agent({
      compaction: { enabled: true, keepRecentMessages: 2 },
      sink: new NoopSink(),
    });
    agent.ensureSystemPrompt();
    for (let i = 0; i < 50; i++) {
      agent.addInput(`User message ${i}`);
      agent.addResponse(`Response ${i}`);
    }

    const mockClient = {
      chatStreamCancellable: async function* () {
        yield { type: 'content', content: 'Summary' };
      },
    };
    agent.client = mockClient;

    await agent.compactMessages();

    const messages = agent.context.getMessages();
    // With keepRecentMessages: 2, we keep 2 recent pairs = 4 messages
    // But findFirstKeptIndex uses keepRecent * 2 = 4, so we keep 2 messages
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    // The last kept message should be Response 49
    expect(assistantMsgs[assistantMsgs.length - 1].content).toBe('Response 49');
  });
});
