import { describe, it, expect, beforeEach } from 'bun:test';
import { Agent } from '../src/agent/agent.js';
import { MessageLog } from '../src/context/index.js';
import { NoopSink, OUTPUT_EVENT } from '../src/context/output.js';
import { Command } from '../src/agent/commands.js';
import { disabledSessionLog } from '../src/session_log.js';

describe('Agent.executeCommand', () => {
  let agent;

  beforeEach(() => {
    agent = new Agent({
      model: 'qwen3.5-0.8b',
      modelRegistry: {
        'qwen3.5-0.8b': { name: 'qwen3.5-0.8b' },
        'gpt-4': { name: 'gpt-4', tags: ['fast'] },
      },
      sink: new NoopSink(),
      sessionLog: disabledSessionLog(),
      compaction: { enabled: false, keepRecentMessages: 10 },
      compactionStrategy: 'summarize',
    });
  });

  describe('clear', () => {
    it('clears context and returns success message', async () => {
      agent.addInput('Hello');
      expect(agent.context.messages().length).toBeGreaterThan(0);

      const result = await agent.executeCommand({ type: Command.Clear, value: null });
      expect(result).toEqual({ content: 'Context cleared.' });
      expect(agent.context.messages().length).toBe(0);
      expect(agent.context.systemMessages.length).toBe(0);
    });
  });

  describe('model', () => {
    it('lists models when no name provided', async () => {
      const result = await agent.executeCommand({ type: Command.Model, value: null });
      expect(result.content).toContain('qwen3.5-0.8b');
      expect(result.content).toContain('gpt-4');
    });

    it('switches model and clears context', async () => {
      agent.addInput('Hello');
      const result = await agent.executeCommand({ type: Command.Model, value: 'gpt-4' });
      expect(result.content).toBe('Switched to model: gpt-4');
      expect(agent.model).toBe('gpt-4');
      expect(agent.context.messages().length).toBe(0);
    });
  });

  describe('models', () => {
    it('lists all models with current', async () => {
      const result = await agent.executeCommand({ type: Command.Models, value: null });
      expect(result.content).toContain('Available models:');
      expect(result.content).toContain('Currently using: qwen3.5-0.8b');
    });
  });

  describe('tokens', () => {
    it('returns token stats display', async () => {
      const result = await agent.executeCommand({ type: Command.Tokens, value: null });
      expect(result.content).toContain('Token Usage');
    });
  });

  describe('unknown', () => {
    it('returns error for unknown command', async () => {
      const result = await agent.executeCommand({ type: Command.Unknown, value: 'foobar' });
      expect(result).toEqual({ error: 'Unknown command: foobar' });
    });
  });

  describe('UI-only commands', () => {
    it('returns error for help', async () => {
      const result = await agent.executeCommand({ type: Command.Help, value: null });
      expect(result).toEqual({ error: 'UI command: help' });
    });

    it('returns error for quit', async () => {
      const result = await agent.executeCommand({ type: Command.Quit, value: null });
      expect(result).toEqual({ error: 'UI command: quit' });
    });
  });

  describe('tools toggle', () => {
    it('toggles hideTools and returns status', async () => {
      expect(agent.hideTools).toBe(true);
      const result = await agent.executeCommand({ type: Command.Tools, value: null });
      expect(result.content).toContain('Tool display: shown');
      expect(agent.hideTools).toBe(false);

      // Toggle again
      const result2 = await agent.executeCommand({ type: Command.Tools, value: null });
      expect(result2.content).toContain('Tool display: hidden');
      expect(agent.hideTools).toBe(true);
    });
  });

  describe('thinking toggle', () => {
    it('toggles hideThinking and returns status', async () => {
      expect(agent.hideThinking).toBe(false);
      const result = await agent.executeCommand({ type: Command.Thinking, value: null });
      expect(result.content).toContain('Thinking display: hidden');
      expect(agent.hideThinking).toBe(true);

      // Toggle again
      const result2 = await agent.executeCommand({ type: Command.Thinking, value: null });
      expect(result2.content).toContain('Thinking display: shown');
      expect(agent.hideThinking).toBe(false);
    });
  });

  describe('skill list', () => {
    it('lists skills when no name provided', async () => {
      agent = new Agent({
        model: 'qwen3.5-0.8b',
        modelRegistry: { 'qwen3.5-0.8b': { name: 'qwen3.5-0.8b' } },
        sink: new NoopSink(),
        sessionLog: disabledSessionLog(),
        compaction: { enabled: false, keepRecentMessages: 10 },
        compactionStrategy: 'summarize',
        skillsLoader: {
          allSkills: () => [
            { name: 'test-skill', description: 'A test', visible: true, loaded: false },
          ],
        },
      });
      const result = await agent.executeCommand({ type: Command.Skill, value: null });
      expect(result.content).toContain('Available skills:');
      expect(result.content).toContain('test-skill');
    });
  });

  describe('compact', () => {
    it('returns usage when no value', async () => {
      const result = await agent.executeCommand({ type: Command.Compact, value: null });
      expect(result.content).toContain('Usage: /compact');
    });
  });

  describe('compact:strategy', () => {
    it('lists strategies', async () => {
      const result = await agent.executeCommand({
        type: Command.CompactStrategy,
        value: { action: 'list' },
      });
      expect(result.content).toContain('Compaction Strategies:');
      expect(result.content).toContain('summarize');
    });

    it('sets strategy', async () => {
      const result = await agent.executeCommand({
        type: Command.CompactStrategy,
        value: { action: 'set', name: 'drop' },
      });
      expect(result.content).toContain('Compaction strategy set to: drop');
      expect(agent.compactionStrategy).toBe('drop');
    });

    it('returns error for unknown strategy', async () => {
      const result = await agent.executeCommand({
        type: Command.CompactStrategy,
        value: { action: 'set', name: 'nonexistent' },
      });
      expect(result.error).toContain("Unknown strategy 'nonexistent'");
    });
  });
});

// ── MessageBus.executeCommand tests ──────────────────────────────────────────

describe('MessageBus.executeCommand', () => {
  // Mock agent with executeCommand
  class MockAgent {
    constructor() {
      this.model = 'qwen3.5-0.8b';
      this.hideTools = true;
      this.hideThinking = false;
    }
    async executeCommand(cmd) {
      switch (cmd.type) {
        case Command.Clear:
          return { content: 'Context cleared.' };
        case Command.Model:
          return { content: `Switched to model: ${cmd.value || 'none'}` };
        case Command.Unknown:
          return { error: `Unknown command: ${cmd.value || ''}` };
        case Command.Help:
          return { error: 'UI command: help' };
        case Command.Tools:
          this.hideTools = !this.hideTools;
          return { content: `Tool display: ${this.hideTools ? 'hidden' : 'shown'}` };
        case Command.Thinking:
          this.hideThinking = !this.hideThinking;
          return { content: `Thinking display: ${this.hideThinking ? 'hidden' : 'shown'}` };
        default:
          return { content: `Executed: ${cmd.type}` };
      }
    }
  }

  // Mock session manager
  class MockSessionManager {
    constructor(agent) {
      this._agent = agent;
    }
    getAgent() { return this._agent; }
    sessionId() { return 'test-session'; }
  }

  // Mock sink
  class MockSink {
    constructor() {
      this.events = [];
    }
    emit(event) {
      this.events.push(event);
    }
  }

  it('emits COMMAND_RESULT on success', async () => {
    const { MessageBus } = await import('../src/agent/message_bus.js');
    const mockAgent = new MockAgent();
    const mockManager = new MockSessionManager(mockAgent);
    const mockSink = new MockSink();
    const bus = new MessageBus({
      sessionManager: mockManager,
      sink: mockSink,
    });

    await bus.executeCommand('clear');
    expect(mockSink.events).toHaveLength(1);
    expect(mockSink.events[0].type).toBe(OUTPUT_EVENT.COMMAND_RESULT);
    expect(mockSink.events[0].content).toBe('Context cleared.');
  });

  it('emits COMMAND_RESULT on error', async () => {
    const { MessageBus } = await import('../src/agent/message_bus.js');
    const mockAgent = new MockAgent();
    const mockManager = new MockSessionManager(mockAgent);
    const mockSink = new MockSink();
    const bus = new MessageBus({
      sessionManager: mockManager,
      sink: mockSink,
    });

    await bus.executeCommand('foobar');
    expect(mockSink.events).toHaveLength(1);
    expect(mockSink.events[0].type).toBe(OUTPUT_EVENT.COMMAND_RESULT);
    expect(mockSink.events[0].content).toBe('Unknown command: foobar');
  });

  it('emits error when no agent', async () => {
    const { MessageBus } = await import('../src/agent/message_bus.js');
    const mockSink = new MockSink();
    const emptyManager = { getAgent: () => null, sessionId: () => 'empty' };
    const bus = new MessageBus({
      sessionManager: emptyManager,
      sink: mockSink,
    });

    await bus.executeCommand('clear');
    expect(mockSink.events).toHaveLength(1);
    expect(mockSink.events[0].content).toBe('No agent available.');
  });

  it('handles UI-only commands', async () => {
    const { MessageBus } = await import('../src/agent/message_bus.js');
    const mockAgent = new MockAgent();
    const mockManager = new MockSessionManager(mockAgent);
    const mockSink = new MockSink();
    const bus = new MessageBus({
      sessionManager: mockManager,
      sink: mockSink,
    });

    await bus.executeCommand('help');
    expect(mockSink.events).toHaveLength(1);
    expect(mockSink.events[0].content).toBe('UI command: help');
  });

  it('parses model command with value', async () => {
    const { MessageBus } = await import('../src/agent/message_bus.js');
    const mockAgent = new MockAgent();
    const mockManager = new MockSessionManager(mockAgent);
    const mockSink = new MockSink();
    const bus = new MessageBus({
      sessionManager: mockManager,
      sink: mockSink,
    });

    await bus.executeCommand('model gpt-4');
    expect(mockSink.events).toHaveLength(1);
    expect(mockSink.events[0].content).toBe('Switched to model: gpt-4');
  });
});
