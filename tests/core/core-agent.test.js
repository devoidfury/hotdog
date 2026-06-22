// Tests for the core Agent class.

import { Agent, HOOKS } from '../../src/core/index.js';
import { HookSystem, createHooks } from '../../src/core/hooks.js';
import { ToolRegistry, createToolRegistry } from '../../src/core/extensions/tool-registry.js';
import { Message } from '../../src/core/context/message.js';
import { describe, it, expect, beforeEach } from 'bun:test';

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
      });
      expect(a.model).toBe('custom');
      expect(a.hideTools).toBe(false);
      expect(a.hideThinking).toBe(true);
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

    it('should handle reasoning command to set effort', async () => {
      const result = await agent.executeCommand({ type: 'reasoning', value: 'high' });
      expect(result).toEqual({ content: 'Reasoning effort set to: high' });
      expect(agent._reasoningEffort).toBe('high');
    });

    it('should handle reasoning command with unset', async () => {
      agent._reasoningEffort = 'high';
      const result = await agent.executeCommand({ type: 'reasoning', value: 'unset' });
      expect(result).toEqual({ content: 'Reasoning effort unset (omitted from requests).' });
      expect(agent._reasoningEffort).toBeUndefined();
    });

    it('should show current setting when no value given', async () => {
      agent._reasoningEffort = 'high';
      const result = await agent.executeCommand({ type: 'reasoning', value: null });
      expect(result).toEqual({ content: 'Current reasoning effort: high' });
      expect(agent._reasoningEffort).toBe('high');
    });

    it('should show (not set) when no value given and no override', async () => {
      const result = await agent.executeCommand({ type: 'reasoning', value: null });
      expect(result).toEqual({ content: 'Current reasoning effort: (not set, omitted from requests)' });
      expect(agent._reasoningEffort).toBeUndefined();
    });

    it('should reject invalid reasoning effort', async () => {
      const result = await agent.executeCommand({ type: 'reasoning', value: 'invalid' });
      expect(result.error).toContain('Invalid reasoning effort');
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

  describe('hooks integration', () => {
    it('should call SYSTEM_PROMPT_BUILD handlers with contribute callback', async () => {
      const contributed = [];
      hooks.on(HOOKS.SYSTEM_PROMPT_BUILD, ({ agent: a, contribute }) => {
        contribute('test-chunk', 500, '\n# Test Chunk');
        contributed.push('called');
      });

      await agent.ensureSystemPrompt();
      expect(contributed.length).toBe(1);
      expect(agent._systemPrompt).toContain('Test Chunk');
    });
  });

  describe('_resolveModelConfig', () => {
    it('should include reasoning_effort from model registry', () => {
      agent._modelRegistry = {
        'test-model': { name: 'test-model', temperature: 0.5, maxTokens: 100, reasoningEffort: 'high' },
      };
      const config = agent._resolveModelConfig();
      expect(config.reasoningEffort).toBe('high');
    });

    it('should override reasoning_effort from runtime setting', () => {
      agent._modelRegistry = {
        'test-model': { name: 'test-model', temperature: 0.5, maxTokens: 100, reasoningEffort: 'low' },
      };
      agent._reasoningEffort = 'max';
      const config = agent._resolveModelConfig();
      expect(config.reasoningEffort).toBe('max');
    });

    it('should omit reasoning_effort when not set anywhere', () => {
      agent._modelRegistry = {
        'test-model': { name: 'test-model', temperature: 0.5, maxTokens: 100 },
      };
      const config = agent._resolveModelConfig();
      expect(config.reasoningEffort).toBeUndefined();
    });
  });

  describe('serialize/deserialize reasoning_effort', () => {
    it('should serialize and deserialize reasoning_effort', () => {
      agent._reasoningEffort = 'max';
      const serialized = agent.serialize();
      expect(serialized.reasoningEffort).toBe('max');

      const newAgent = new Agent({ hooks, toolRegistry, llmClient, model: 'test' });
      newAgent.deserialize(serialized);
      expect(newAgent._reasoningEffort).toBe('max');
    });

    it('should handle undefined reasoning_effort in deserialize', () => {
      const serialized = agent.serialize();
      expect(serialized.reasoningEffort).toBeUndefined();

      const newAgent = new Agent({ hooks, toolRegistry, llmClient, model: 'test' });
      newAgent._reasoningEffort = 'high';
      newAgent.deserialize(serialized);
      expect(newAgent._reasoningEffort).toBeUndefined();
    });
  });
});
