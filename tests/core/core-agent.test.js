// Tests for the core Agent class.

import { Agent, HOOKS } from '../../src/core/index.js';
import { HookSystem, createHooks } from '../../src/core/hooks.js';
import { ToolRegistry, createToolRegistry } from '../../src/core/extensions/tool-registry.js';
import { Message } from '../../src/core/context/message.js';
import { describe, it, expect, beforeEach, spyOn } from 'bun:test';

describe('Agent', () => {
  let hooks;
  let toolRegistry;
  let llmClient;
  let agent;

  beforeEach(() => {
    hooks = createHooks();
    toolRegistry = createToolRegistry();
    llmClient = {
      chatStreamCancellable: () => (async function* () {})(),
    };
    agent = new Agent({
      hooks,
      toolRegistry,
      llmClient,
      model: 'test-model',
      maxIterations: 10,
      maxTokens: 4096,
    });
  });

  describe('constructor', () => {
    it('should set default values', () => {
      expect(agent.model).toBe('test-model');
      expect(agent.iterationCount).toBe(0);
      expect(agent.hideTools).toBe(true);
      expect(agent.hideThinking).toBe(false);
      expect(agent.cancelled).toBe(false);
    });

    it('should accept custom options', () => {
      const a = new Agent({
        hooks,
        toolRegistry,
        llmClient,
        model: 'custom',
        maxIterations: 42,
        hideTools: false,
        hideThinking: true,
        showTokenUse: false,
      });
      expect(a.model).toBe('custom');
      expect(a.hideTools).toBe(false);
      expect(a.hideThinking).toBe(true);
    });
  });

  describe('properties', () => {
    it('should allow model setter', () => {
      agent.model = 'new-model';
      expect(agent.model).toBe('new-model');
    });

    it('should allow hideTools setter', () => {
      agent.hideTools = false;
      expect(agent.hideTools).toBe(false);
    });

    it('should allow hideThinking setter', () => {
      agent.hideThinking = true;
      expect(agent.hideThinking).toBe(true);
    });
  });

  describe('context', () => {
    it('should start with empty context', () => {
      expect(agent.context).toEqual([]);
    });

    it('should allow clearing context', () => {
      agent.context.push(new Message({ role: 'user', content: 'hello' }));
      agent.clearContext();
      expect(agent.context).toEqual([]);
      expect(agent.iterationCount).toBe(0);
    });
  });

  describe('cancel', () => {
    it('should set cancelled flag', () => {
      expect(agent.cancelled).toBe(false);
      agent.cancel(true);
      expect(agent.cancelled).toBe(true);
      agent.cancel(false);
      expect(agent.cancelled).toBe(false);
    });
  });

  describe('tool registry access', () => {
    it('should return empty tool defs when no tools registered', async () => {
      expect(await agent.getToolDefs()).toEqual([]);
      expect(agent.getToolNames()).toEqual([]);
    });

    it('should return registered tools', async () => {
      const tool = {
        toToolDef: () => ({ type: 'function', function: { name: 'test-tool' } }),
        execute: async () => 'result',
      };
      toolRegistry.register('test-tool', tool);

      const defs = await agent.getToolDefs();
      expect(defs).toEqual([
        { type: 'function', function: { name: 'test-tool' } },
      ]);
      expect(agent.getToolNames()).toEqual(['test-tool']);
    });
  });

  describe('executeCommand', () => {
    it('should handle clear command', async () => {
      agent.context.push(new Message({ role: 'user', content: 'hello' }));
      const result = await agent.executeCommand({ type: 'clear' });
      expect(result).toEqual({ content: 'Context cleared.' });
      expect(agent.context).toEqual([]);
    });

    it('should delegate to hooks for custom commands', async () => {
      hooks.on(HOOKS.COMMAND_DISPATCH, () => ({ content: 'custom handled' }));
      const result = await agent.executeCommand({ type: 'custom' });
      expect(result).toEqual({ content: 'custom handled' });
    });

    it('should return error for unknown commands', async () => {
      const result = await agent.executeCommand({ type: 'unknown-cmd' });
      expect(result).toEqual({ error: 'Unknown command: unknown-cmd' });
    });

    it('should return UI command errors', async () => {
      const result = await agent.executeCommand({ type: 'quit' });
      expect(result).toEqual({ error: 'UI command: quit' });
    });
  });

  describe('serialize / deserialize', () => {
    it('should serialize agent state', () => {
      agent.context.push(new Message({ role: 'user', content: 'hello' }));
      agent.context.push(new Message({ role: 'assistant', content: 'hi' }));
      agent._iterationCount = 3;

      const data = agent.serialize();
      expect(data.sessionId).toBeDefined();
      expect(data.model).toBe('test-model');
      expect(data.iterationCount).toBe(3);
      expect(data.context.length).toBe(2);
      expect(data.context[0].role).toBe('user');
      expect(data.context[1].role).toBe('assistant');
    });

    it('should deserialize agent state', () => {
      const data = {
        sessionId: 'test-session',
        model: 'other-model',
        context: [
          { role: 'user', content: 'hello', reasoning_content: null, tool_calls: null, tool_call_id: null },
        ],
        iterationCount: 5,
      };

      agent.deserialize(data);
      expect(agent.sessionId).toBe('test-session');
      expect(agent.model).toBe('other-model');
      expect(agent.context.length).toBe(1);
      expect(agent.context[0].content).toBe('hello');
      expect(agent.iterationCount).toBe(5);
    });
  });

  describe('hooks integration', () => {
    it('should call SYSTEM_PROMPT_BUILD handlers with contribute callback', async () => {
      const contributed = [];
      hooks.on(HOOKS.SYSTEM_PROMPT_BUILD, ({ agent: a, contribute }) => {
        contribute('test-chunk', 500, '\n# Test Chunk');
        contributed.push('called');
      });

      await agent.ensureSystemPrompt();
      expect(contributed.length).toBe(1);
      expect(agent._systemPrompt).toBeDefined();
      expect(agent._systemPrompt).toContain('Test Chunk');
    });

    it('should emit CONTEXT_MESSAGE on context changes', async () => {
      const emitted = [];
      hooks.on(HOOKS.CONTEXT_MESSAGE, ({ message }) => {
        emitted.push(message);
      });

      agent.context.push(new Message({ role: 'user', content: 'test' }));
      await hooks.emitAsync(HOOKS.CONTEXT_MESSAGE, {
        message: agent.context[0],
      });
      expect(emitted.length).toBe(1);
    });
  });

  describe('_formatToolResult', () => {
    it('should format string results as XML', () => {
      const result = agent._formatToolResult('hello', 'test-tool');
      expect(result).toContain('<tool name="test-tool"');
      expect(result).toContain('hello');
    });

    it('should format object results as XML', () => {
      const result = agent._formatToolResult({ key: 'value' }, 'test-tool');
      expect(result).toContain('<tool name="test-tool"');
      expect(result).toContain('key');
    });

    it('should escape XML special characters', () => {
      const result = agent._formatToolResult('a < b & c > d', 'test-tool');
      expect(result).toContain('&lt;');
      expect(result).toContain('&amp;');
      expect(result).toContain('&gt;');
    });
  });
});
