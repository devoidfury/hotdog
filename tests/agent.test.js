import { describe, it, expect } from 'bun:test';
import { Agent } from '../src/agent/agent.js';
import { MessageLog, Message, outputEvent, OUTPUT_EVENT } from '../src/context/index.js';
import { NoopSink } from '../src/context/output.js';
import { ToolRegistry, ToolContext } from '../src/tools/registry.js';

describe('Agent constructor', () => {
  it('creates agent with defaults', () => {
    const agent = new Agent();
    expect(agent.model).toBe('qwen3.5-0.8b');
    expect(agent.hideTools).toBe(true);
    expect(agent.hideThinking).toBe(false);
    expect(agent.stream).toBe(true);
    expect(agent.showTokenUse).toBe(true);
    expect(agent.activeSkills.size).toBe(0);
    expect(agent.usedTools.size).toBe(0);
    expect(agent.iterationCount).toBe(0);
    expect(agent.cancelled).toBe(false);
    expect(agent.outputCache.size).toBe(0);
    expect(agent.tokenStats.size).toBe(0);
    expect(agent.taskManager).toBeNull();
    expect(agent._mcpConnections).toEqual([]);
    expect(agent._config).toBeNull();
    expect(agent._toolDefs).toBeNull();
    expect(agent._mcpToolDefs).toBeNull();
    expect(agent._mcpToolDefsDirty).toBe(true);
  });

  it('accepts custom options', () => {
    const mockClient = { chat: async () => ({ type: 'content', content: 'test' }) };
    const mockSink = new NoopSink();
    const agent = new Agent({
      client: mockClient,
      model: 'gpt-4',
      sink: mockSink,
      hideTools: false,
      hideThinking: true,
      skills: [{ name: 'test', allowedTools: ['read'] }],
      allSkills: [{ name: 'test', allowedTools: ['read'] }],
      skillDirectories: ['/skills'],
      maxToolOutputLines: 500,
      sessionId: 'custom-session',
      cwdBoundary: '/workspace',
      role: 'Custom role',
      profileBody: 'Custom body',
      stream: false,
      showTokenUse: false,
      profileName: 'custom',
      sessionLog: { append: () => {} },
      taskManager: { id: 'manager' },
      mcpConnections: [],
      config: {},
    });
    expect(agent.model).toBe('gpt-4');
    expect(agent.sink).toBe(mockSink);
    expect(agent.hideTools).toBe(false);
    expect(agent.hideThinking).toBe(true);
    expect(agent.stream).toBe(false);
    expect(agent.showTokenUse).toBe(false);
    expect(agent.maxToolOutputLines).toBe(500);
    expect(agent.sessionId).toBe('custom-session');
    expect(agent.cwdBoundary).toBe('/workspace');
    expect(agent.role).toBe('Custom role');
    expect(agent.profileBody).toBe('Custom body');
    expect(agent.profileName).toBe('custom');
    expect(agent.taskManager).toEqual({ id: 'manager' });
  });

  it('creates its own MessageLog when not provided', () => {
    const agent = new Agent();
    expect(agent.context).toBeInstanceOf(MessageLog);
  });

  it('creates its own NoopSink when not provided', () => {
    const agent = new Agent();
    expect(agent.sink).toBeInstanceOf(NoopSink);
  });
});

describe('Agent.allowedToolNames', () => {
  it('returns empty set when no active skills', () => {
    const agent = new Agent();
    expect(agent.allowedToolNames()).toEqual(new Set());
  });

  it('returns allowed tools from active skills', () => {
    const agent = new Agent({
      skills: [
        { name: 'skill-a', allowedTools: ['read', 'write'] },
        { name: 'skill-b', allowedTools: ['grep', 'find'] },
      ],
      allSkills: [
        { name: 'skill-a', allowedTools: ['read', 'write'] },
        { name: 'skill-b', allowedTools: ['grep', 'find'] },
      ],
    });
    agent.activeSkills.add('skill-a');
    expect(agent.allowedToolNames()).toEqual(new Set(['read', 'write']));
  });

  it('merges allowed tools from multiple active skills', () => {
    const agent = new Agent({
      skills: [
        { name: 'skill-a', allowedTools: ['read', 'write'] },
        { name: 'skill-b', allowedTools: ['grep', 'find'] },
      ],
      allSkills: [
        { name: 'skill-a', allowedTools: ['read', 'write'] },
        { name: 'skill-b', allowedTools: ['grep', 'find'] },
      ],
    });
    agent.activeSkills.add('skill-a');
    agent.activeSkills.add('skill-b');
    expect(agent.allowedToolNames()).toEqual(new Set(['read', 'write', 'grep', 'find']));
  });

  it('handles skill not found in skills list', () => {
    const agent = new Agent({
      skills: [],
      allSkills: [],
    });
    agent.activeSkills.add('nonexistent');
    expect(agent.allowedToolNames()).toEqual(new Set());
  });

  it('handles skill with no allowedTools', () => {
    const agent = new Agent({
      skills: [{ name: 'skill-a', allowedTools: undefined }],
      allSkills: [{ name: 'skill-a', allowedTools: undefined }],
    });
    agent.activeSkills.add('skill-a');
    expect(agent.allowedToolNames()).toEqual(new Set());
  });
});

describe('Agent.combinedToolPatterns', () => {
  it('returns empty set when no active skills', () => {
    const agent = new Agent();
    expect(agent.combinedToolPatterns()).toEqual(new Set());
  });

  it('combines includeTools and allowedTools from active skills', () => {
    const agent = new Agent({
      skills: [
        { name: 'skill-a', includeTools: ['read', 'write'], allowedTools: ['grep'] },
      ],
      allSkills: [
        { name: 'skill-a', includeTools: ['read', 'write'], allowedTools: ['grep'] },
      ],
    });
    agent.activeSkills.add('skill-a');
    const patterns = agent.combinedToolPatterns();
    expect(patterns).toEqual(new Set(['read', 'write', 'grep']));
  });

  it('deduplicates patterns across skills', () => {
    const agent = new Agent({
      skills: [
        { name: 'skill-a', includeTools: ['read'] },
        { name: 'skill-b', allowedTools: ['read'] },
      ],
      allSkills: [
        { name: 'skill-a', includeTools: ['read'] },
        { name: 'skill-b', allowedTools: ['read'] },
      ],
    });
    agent.activeSkills.add('skill-a');
    agent.activeSkills.add('skill-b');
    const patterns = agent.combinedToolPatterns();
    expect(patterns.size).toBe(1);
    expect(patterns.has('read')).toBe(true);
  });
});

describe('Agent.isToolAllowed', () => {
  it('allows core tools always', () => {
    const agent = new Agent();
    expect(agent.isToolAllowed('bash')).toBe(true);
    expect(agent.isToolAllowed('write')).toBe(true);
    expect(agent.isToolAllowed('read')).toBe(true);
    expect(agent.isToolAllowed('edit')).toBe(true);
    expect(agent.isToolAllowed('grep')).toBe(true);
    expect(agent.isToolAllowed('find')).toBe(true);
    expect(agent.isToolAllowed('fetch')).toBe(true);
    expect(agent.isToolAllowed('question')).toBe(true);
    expect(agent.isToolAllowed('pager')).toBe(true);
    expect(agent.isToolAllowed('model')).toBe(true);
    expect(agent.isToolAllowed('load_skill')).toBe(true);
    expect(agent.isToolAllowed('review')).toBe(true);
  });

  it('allows tool when no active skills', () => {
    const agent = new Agent();
    expect(agent.isToolAllowed('any-tool')).toBe(true);
  });

  it('allows subagent tools always', () => {
    const agent = new Agent();
    expect(agent.isToolAllowed('delegate_task')).toBe(true);
    expect(agent.isToolAllowed('task_status')).toBe(true);
  });

  it('denies unknown tool not matching pattern', () => {
    const agent = new Agent({
      skills: [{ name: 'skill-a', includeTools: ['read'] }],
      allSkills: [{ name: 'skill-a', includeTools: ['read'] }],
    });
    agent.activeSkills.add('skill-a');
    // Unknown tools must match a pattern
    expect(agent.isToolAllowed('custom_tool_xyz')).toBe(false);
  });

  it('allows unknown tool matching pattern', () => {
    const agent = new Agent({
      skills: [{ name: 'skill-a', includeTools: ['custom_*'] }],
      allSkills: [{ name: 'skill-a', includeTools: ['custom_*'] }],
    });
    agent.activeSkills.add('skill-a');
    expect(agent.isToolAllowed('custom_tool_xyz')).toBe(true);
  });
});

describe('Agent.filteredToolDefs', () => {
  it('returns all defs when no active skills', () => {
    const agent = new Agent();
    const registry = new ToolRegistry();
    registry.register('bash', { toToolDef: () => ({ function: { name: 'bash' } }) });
    registry.register('write', { toToolDef: () => ({ function: { name: 'write' } }) });
    const defs = agent.filteredToolDefs(registry);
    expect(defs).toHaveLength(2);
  });

  it('filters tools by active skill patterns using non-core tools', () => {
    const agent = new Agent({
      skills: [{ name: 'skill-a', includeTools: ['custom_tool'] }],
      allSkills: [{ name: 'skill-a', includeTools: ['custom_tool'] }],
    });
    agent.activeSkills.add('skill-a');
    const registry = new ToolRegistry();
    registry.register('custom_tool', { toToolDef: () => ({ function: { name: 'custom_tool' } }) });
    registry.register('other_tool', { toToolDef: () => ({ function: { name: 'other_tool' } }) });
    const defs = agent.filteredToolDefs(registry);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe('custom_tool');
  });

  it('only includes core tools that match patterns', () => {
    const agent = new Agent({
      skills: [{ name: 'skill-a', includeTools: ['bash'] }],
      allSkills: [{ name: 'skill-a', includeTools: ['bash'] }],
    });
    agent.activeSkills.add('skill-a');
    const registry = new ToolRegistry();
    registry.register('bash', { toToolDef: () => ({ function: { name: 'bash' } }) });
    registry.register('custom_tool', { toToolDef: () => ({ function: { name: 'custom_tool' } }) });
    const defs = agent.filteredToolDefs(registry);
    expect(defs).toHaveLength(1);
  });

  it('deduplicates tool definitions', () => {
    const agent = new Agent();
    const registry = new ToolRegistry();
    const toolDef = { function: { name: 'bash' } };
    registry.register('bash', { toToolDef: () => toolDef });
    const defs = agent.filteredToolDefs(registry);
    expect(defs).toHaveLength(1);
  });
});

describe('Agent._buildSkillsPreamble', () => {
  it('returns empty string when no skills', () => {
    const agent = new Agent();
    expect(agent._buildSkillsPreamble()).toBe('');
  });

  it('returns empty string when all skills hidden', () => {
    const agent = new Agent({
      allSkills: [{ name: 'skill-a', visible: false, loaded: true, content: 'content' }],
    });
    expect(agent._buildSkillsPreamble()).toBe('');
  });

  it('returns empty string when all skills disabled', () => {
    const agent = new Agent({
      allSkills: [{ name: 'skill-a', visible: true, disableModelInvocation: true, loaded: true, content: 'content' }],
    });
    expect(agent._buildSkillsPreamble()).toBe('');
  });

  it('includes loaded skills with content', () => {
    const agent = new Agent({
      allSkills: [{ name: 'test-skill', visible: true, loaded: true, content: '# Skill\n\nContent' }],
      skillDirectories: ['/skills'],
    });
    const preamble = agent._buildSkillsPreamble();
    expect(preamble).toContain('# Available Skills');
    expect(preamble).toContain('/skills');
    expect(preamble).toContain('<skill_content name="test-skill">');
    expect(preamble).toContain('# Skill');
    expect(preamble).toContain('</skill_content>');
  });

  it('includes unloaded skills with descriptions', () => {
    const agent = new Agent({
      allSkills: [{ name: 'test-skill', visible: true, loaded: false, description: 'A test skill' }],
      skillDirectories: ['/skills'],
    });
    const preamble = agent._buildSkillsPreamble();
    expect(preamble).toContain('## Available Skills');
    expect(preamble).toContain('<name>test-skill</name>');
    expect(preamble).toContain('A test skill');
  });

  it('includes both loaded and unloaded skills', () => {
    const agent = new Agent({
      allSkills: [
        { name: 'loaded-skill', visible: true, loaded: true, content: 'loaded content' },
        { name: 'unloaded-skill', visible: true, loaded: false, description: 'unloaded desc' },
      ],
      skillDirectories: ['/skills'],
    });
    const preamble = agent._buildSkillsPreamble();
    expect(preamble).toContain('## Loaded Skills');
    expect(preamble).toContain('## Available Skills');
    expect(preamble).toContain('loaded content');
    expect(preamble).toContain('unloaded desc');
  });
});

describe('Agent.createToolContext', () => {
  it('creates a ToolContext with agent settings', () => {
    const agent = new Agent({
      skills: [{ name: 'test' }],
      allSkills: [{ name: 'test' }],
      skillDirectories: ['/skills'],
      cwdBoundary: '/workspace',
      modelRegistry: { 'gpt-4': {} },
    });
    const ctx = agent.createToolContext();
    expect(ctx).toBeInstanceOf(ToolContext);
    expect(ctx.skills).toEqual([{ name: 'test' }]);
    expect(ctx.allSkills).toEqual([{ name: 'test' }]);
    expect(ctx.skillDirectories).toEqual(['/skills']);
    expect(ctx.cwdBoundary).toBe('/workspace');
    expect(ctx.modelRegistry).toEqual({ 'gpt-4': {} });
  });

  it('creates context with default values', () => {
    const agent = new Agent();
    const ctx = agent.createToolContext();
    expect(ctx.skills).toEqual([]);
    expect(ctx.allSkills).toEqual([]);
    expect(ctx.skillDirectories).toEqual([]);
    expect(ctx.cwdBoundary).toBeNull();
    expect(ctx.workspaceRoot).toBe(process.cwd());
    expect(ctx.currentFile).toBeNull();
    expect(ctx.modelNames).toEqual([]);
    expect(ctx.activeProvider).toBeNull();
  });

  it('context onActivateSkill adds to activeSkills', () => {
    const agent = new Agent();
    const ctx = agent.createToolContext();
    ctx.onActivateSkill('new-skill');
    expect(agent.activeSkills.has('new-skill')).toBe(true);
  });

  it('context onSwitchModel changes model', () => {
    const agent = new Agent({ model: 'gpt-4' });
    const ctx = agent.createToolContext();
    ctx.onSwitchModel('claude-sonnet');
    expect(agent.model).toBe('claude-sonnet');
  });

  it('context isCancelled returns cancelled state', () => {
    const agent = new Agent();
    const ctx = agent.createToolContext();
    expect(ctx.isCancelled()).toBe(false);
    agent.cancel(true);
    expect(ctx.isCancelled()).toBe(true);
  });

  it('context onCacheToolOutput caches output', () => {
    const agent = new Agent();
    const ctx = agent.createToolContext();
    ctx.onCacheToolOutput('call-123', 'cached result');
    expect(agent.outputCache.get('call-123')).toBe('cached result');
  });

  it('context onGetCachedToolOutput retrieves cached output', () => {
    const agent = new Agent();
    agent.outputCache.set('call-456', 'cached value');
    const ctx = agent.createToolContext();
    expect(ctx.onGetCachedToolOutput('call-456')).toBe('cached value');
  });
});

describe('Agent.addInput', () => {
  it('adds user message to context', () => {
    const agent = new Agent();
    agent.addInput('Hello world');
    const messages = agent.context.getMessages();
    const userMsg = messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe('Hello world');
  });

  it('adds system prompt before user message', () => {
    const agent = new Agent();
    agent.addInput('Hello');
    const messages = agent.context.getMessages();
    expect(messages[0].role).toBe('system');
  });

  it('skips empty input', () => {
    const agent = new Agent();
    agent.addInput('');
    const messages = agent.context.getMessages();
    const userMsg = messages.find(m => m.role === 'user');
    expect(userMsg).toBeUndefined();
  });

  it('skips whitespace-only input', () => {
    const agent = new Agent();
    agent.addInput('   ');
    const messages = agent.context.getMessages();
    const userMsg = messages.find(m => m.role === 'user');
    expect(userMsg).toBeUndefined();
  });
});

describe('Agent.addResponse', () => {
  it('adds assistant message to context', () => {
    const agent = new Agent();
    agent.addResponse('I can help you.');
    const messages = agent.context.getMessages();
    const assistantMsg = messages.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBe('I can help you.');
  });

  it('adds assistant message with reasoning content', () => {
    const agent = new Agent();
    agent.addResponse('Output', 'Thinking...');
    const messages = agent.context.getMessages();
    const assistantMsg = messages.find(m => m.role === 'assistant');
    expect(assistantMsg.reasoningContent).toBe('Thinking...');
  });

  it('adds assistant message with tool calls', () => {
    const agent = new Agent();
    const toolCalls = [{ id: 'tc1', function: { name: 'bash', arguments: '{}' } }];
    agent.addResponse('Done', null, toolCalls);
    const messages = agent.context.getMessages();
    const assistantMsg = messages.find(m => m.role === 'assistant');
    expect(assistantMsg.toolCalls).toEqual(toolCalls);
  });
});

describe('Agent.clearContext', () => {
  it('clears messages and resets iteration count', () => {
    const agent = new Agent();
    agent.addInput('Hello');
    agent.iterationCount = 5;
    agent.clearContext();
    // clearContext clears both messages and systemMessages
    // After clear, ensureSystemPrompt is needed to re-add system prompt
    expect(agent.context.messages().length).toBe(0);
    expect(agent.iterationCount).toBe(0);
  });

  it('generates new session ID on clear', () => {
    const agent = new Agent({ sessionId: 'original-session' });
    const originalId = agent.sessionId;
    agent.clearContext();
    expect(agent.sessionId).not.toBe(originalId);
  });
});

describe('Agent.setSink', () => {
  it('swaps the output sink', () => {
    const agent = new Agent();
    const newSink = new NoopSink();
    agent.setSink(newSink);
    expect(agent.sink).toBe(newSink);
  });
});

describe('Agent.cancel', () => {
  it('cancels the agent', () => {
    const agent = new Agent();
    expect(agent.cancelled).toBe(false);
    agent.cancel(true);
    expect(agent.cancelled).toBe(true);
  });

  it('resets cancellation', () => {
    const agent = new Agent();
    agent.cancel(true);
    agent.cancel(false);
    expect(agent.cancelled).toBe(false);
  });

  it('defaults to cancelling', () => {
    const agent = new Agent();
    agent.cancel();
    expect(agent.cancelled).toBe(true);
  });
});

describe('Agent.currentModel', () => {
  it('returns current model', () => {
    const agent = new Agent({ model: 'gpt-4' });
    expect(agent.currentModel()).toBe('gpt-4');
  });

  it('returns default model', () => {
    const agent = new Agent();
    expect(agent.currentModel()).toBe('qwen3.5-0.8b');
  });
});

describe('Agent.executePrompt', () => {
  it('returns error when prompts loader not configured', () => {
    const agent = new Agent();
    const result = agent.executePrompt('test-prompt');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Prompts loader not configured');
  });

  it('returns error on unknown prompt', () => {
    const mockLoader = {
      getPrompt: () => null,
      allPrompts: () => [{ name: 'existing-prompt', disableModelInvocation: false }],
    };
    const agent = new Agent({ promptsLoader: mockLoader });
    const result = agent.executePrompt('unknown');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown prompt');
    expect(result.error).toContain('existing-prompt');
  });

  it('executes prompt with template rendering', () => {
    const mockLoader = {
      getPrompt: () => ({ content: 'Task: {{ ARGS.task }}' }),
      allPrompts: () => [],
    };
    const agent = new Agent({ promptsLoader: mockLoader });
    const result = agent.executePrompt('test', { task: 'write code' });
    expect(result.success).toBe(true);
    expect(result.prompt).toBe('Task: write code');
  });

  it('executes prompt without args', () => {
    const mockLoader = {
      getPrompt: () => ({ content: 'Static prompt' }),
      allPrompts: () => [],
    };
    const agent = new Agent({ promptsLoader: mockLoader });
    const result = agent.executePrompt('test');
    expect(result.success).toBe(true);
  });

  it('falls back to raw content on render error', () => {
    const mockLoader = {
      getPrompt: () => ({ content: '{{ broken' }),
      allPrompts: () => [],
    };
    const agent = new Agent({ promptsLoader: mockLoader });
    const result = agent.executePrompt('test', {});
    expect(result.success).toBe(true);
    expect(result.prompt).toBe('{{ broken');
  });

  it('appends prompt as user message', () => {
    const mockLoader = {
      getPrompt: () => ({ content: 'Prompt content' }),
      allPrompts: () => [],
    };
    const agent = new Agent({ promptsLoader: mockLoader });
    agent.executePrompt('test');
    const messages = agent.context.getMessages();
    const userMsg = [...messages].reverse().find(m => m.role === 'user');
    expect(userMsg.content).toBe('Prompt content');
  });
});

describe('Agent.regenerateSystemPrompt', () => {
  it('returns rendered string when system prompt exists', () => {
    const agent = new Agent();
    agent.ensureSystemPrompt();
    const rendered = agent.regenerateSystemPrompt();
    expect(typeof rendered).toBe('string');
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('replaces system message with new content', () => {
    const agent = new Agent();
    agent.ensureSystemPrompt();
    agent.addInput('User message');
    const rendered = agent.regenerateSystemPrompt();
    // System prompt should be replaced with new content
    expect(agent.context.getMessages()[0].role).toBe('system');
    expect(agent.context.getMessages()[0].content).toContain('Role & Mission');
    // Check that the regenerated prompt contains the key static parts
    // (not the full string, since timestamps change between calls)
    expect(agent.context.getMessages()[0].content).toContain('# Role & Mission');
    expect(agent.context.getMessages()[0].content).toContain('# Environment');
    expect(agent.context.getMessages()[0].content).toContain('# Guidelines');
    expect(agent.context.getMessages()[0].content).toContain('# Project Context');
  });

  it('prunes old skill content messages from conversation', () => {
    const agent = new Agent();
    agent.ensureSystemPrompt();
    agent.addInput('User message');
    // Simulate a skill content message
    agent.context.addUserMessage('<skill_content name="test">content</skill_content>');
    agent.addResponse('Response');

    const skillMsgsBefore = agent.context.messages().filter(m => m.content && m.content.includes('skill_content')).length;
    agent.regenerateSystemPrompt();
    const skillMsgsAfter = agent.context.messages().filter(m => m.content && m.content.includes('skill_content')).length;
    expect(skillMsgsAfter).toBeLessThan(skillMsgsBefore);
  });

  it('keeps user messages and assistant responses', () => {
    const agent = new Agent();
    agent.ensureSystemPrompt();
    agent.addInput('User message 1');
    agent.addResponse('Response 1');
    agent.addInput('User message 2');

    const userMsgsBefore = agent.context.messages().filter(m => m.role === 'user').length;
    const assistantMsgsBefore = agent.context.messages().filter(m => m.role === 'assistant').length;

    agent.regenerateSystemPrompt();

    const userMsgsAfter = agent.context.messages().filter(m => m.role === 'user').length;
    const assistantMsgsAfter = agent.context.messages().filter(m => m.role === 'assistant').length;
    expect(userMsgsAfter).toBe(userMsgsBefore);
    expect(assistantMsgsAfter).toBe(assistantMsgsBefore);
  });
});

describe('Agent.ensureSystemPrompt', () => {
  it('adds system prompt when none exists', () => {
    const agent = new Agent();
    expect(agent.context.systemMessages.length).toBe(0);
    agent.ensureSystemPrompt();
    expect(agent.context.systemMessages.length).toBe(1);
  });

  it('does not add system prompt when one exists', () => {
    const agent = new Agent();
    agent.ensureSystemPrompt();
    const firstCount = agent.context.systemMessages.length;
    agent.ensureSystemPrompt();
    expect(agent.context.systemMessages.length).toBe(firstCount);
  });
});

describe('Agent.buildLayeredMessages', () => {
  it('returns messages from context', () => {
    const agent = new Agent();
    agent.addInput('Hello');
    const messages = agent.buildLayeredMessages();
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe('Agent._emitToolResult', () => {
  it('emits tool result event', () => {
    const events = [];
    const mockSink = {
      emit: (event) => { events.push(event); },
    };
    const agent = new Agent({ sink: mockSink });
    agent._emitToolResult('bash', '{}', 'output', 'call-123');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(OUTPUT_EVENT.TOOL_RESULT);
    // outputEvent spreads data directly onto the event
    expect(events[0].toolName).toBe('bash');
    expect(events[0].input).toBe('{}');
    expect(events[0].result).toBe('output');
  });
});

describe('Agent.handleToolCalls', async () => {
  it('handles tool calls with a registry', async () => {
    const events = [];
    const mockSink = {
      emit: (event) => { events.push(event); },
    };
    const mockTool = {
      execute: async () => 'tool output',
      firstUseHelp: 'First use help text',
    };
    const registry = new ToolRegistry();
    registry.register('bash', mockTool);

    const agent = new Agent({
      sink: mockSink,
      skills: [],
      allSkills: [],
    });

    const toolCalls = [
      { function: { name: 'bash', arguments: '{}' }, id: 'call-1' },
    ];

    const result = await agent.handleToolCalls(toolCalls, registry);
    expect(result).toBe('continue');
    expect(events).toHaveLength(2); // TOOL_CALL + TOOL_RESULT
  });

  it('handles tool call with object result', async () => {
    const mockSink = { emit: () => {} };
    const mockTool = {
      execute: async () => ({ status: 'ok', count: 5 }),
    };
    const registry = new ToolRegistry();
    registry.register('bash', mockTool);

    const agent = new Agent({
      sink: mockSink,
      skills: [],
      allSkills: [],
    });

    const toolCalls = [{ function: { name: 'bash', arguments: '{}' }, id: 'call-1' }];
    await agent.handleToolCalls(toolCalls, registry);

    const messages = agent.context.getMessages();
    const toolMsg = messages.find(m => m.role === 'tool');
    // Tool results are now XML-wrapped: <tool name="..." status="..." duration_ms="...">
    expect(toolMsg.content).toContain('<tool name="bash"');
    expect(toolMsg.content).toContain('status="success"');
    expect(toolMsg.content).toContain('duration_ms=');
    expect(toolMsg.content).toContain('<output>');
    // JSON inside <output> is NOT escaped (raw content)
    expect(toolMsg.content).toContain('"status":"ok"');
    expect(toolMsg.content).toContain('"count":5');
  });

  it('handles tool execution error', async () => {
    const mockSink = { emit: () => {} };
    const mockTool = {
      execute: async () => { throw new Error('Tool failed'); },
    };
    const registry = new ToolRegistry();
    registry.register('bash', mockTool);

    const agent = new Agent({
      sink: mockSink,
      skills: [],
      allSkills: [],
    });

    const toolCalls = [{ function: { name: 'bash', arguments: '{}' }, id: 'call-1' }];
    await agent.handleToolCalls(toolCalls, registry);

    const messages = agent.context.getMessages();
    const toolMsg = messages.find(m => m.role === 'tool');
    expect(toolMsg.content).toContain('Error executing tool bash');
  });

  it('handles tool not allowed by skills with unknown tool', async () => {
    const mockSink = { emit: () => {} };
    const mockTool = {
      execute: async () => 'output',
    };
    const registry = new ToolRegistry();
    registry.register('custom_tool_xyz', mockTool);

    const agent = new Agent({
      sink: mockSink,
      skills: [{ name: 'skill-a', allowedTools: ['read'] }],
      allSkills: [{ name: 'skill-a', allowedTools: ['read'] }],
    });
    agent.activeSkills.add('skill-a');

    const toolCalls = [{ function: { name: 'custom_tool_xyz', arguments: '{}' }, id: 'call-1' }];
    await agent.handleToolCalls(toolCalls, registry);

    const messages = agent.context.getMessages();
    const toolMsg = messages.find(m => m.role === 'tool');
    expect(toolMsg.content).toContain('not allowed');
  });

  it('caches tool output', async () => {
    const mockSink = { emit: () => {} };
    const mockTool = {
      execute: async () => 'cached result',
    };
    const registry = new ToolRegistry();
    registry.register('bash', mockTool);

    const agent = new Agent({
      sink: mockSink,
      skills: [],
      allSkills: [],
    });

    const toolCalls = [{ function: { name: 'bash', arguments: '{}' }, id: 'call-1' }];
    await agent.handleToolCalls(toolCalls, registry);

    expect(agent.outputCache.has('call-1')).toBe(true);
    expect(agent.outputCache.get('call-1')).toContain('cached result');
  });
});

describe('Agent.activateSkill', () => {
  it('returns error when skills loader not configured', () => {
    const agent = new Agent();
    const result = agent.activateSkill('test-skill');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Skills loader not configured');
  });

  it('returns success when skill already active', () => {
    const mockLoader = {
      activateSkill: () => {},
    };
    const agent = new Agent({
      skillsLoader: mockLoader,
      skills: [{ name: 'test-skill', content: 'skill content', location: '/skills/test' }],
    });
    agent.activeSkills.add('test-skill');
    const result = agent.activateSkill('test-skill');
    expect(result.success).toBe(true);
  });

  it('adds skill to active skills', () => {
    const mockLoader = {
      activateSkill: (name) => {},
    };
    const agent = new Agent({
      skillsLoader: mockLoader,
      skills: [{ name: 'test-skill', content: 'skill content', location: '/skills/test' }],
    });
    const result = agent.activateSkill('test-skill');
    expect(result.success).toBe(true);
    expect(agent.activeSkills.has('test-skill')).toBe(true);
  });

  it('adds wrapped skill content to context', () => {
    const mockLoader = {
      activateSkill: (name) => {},
    };
    const agent = new Agent({
      skillsLoader: mockLoader,
      skills: [{ name: 'test-skill', content: 'skill content', location: '/skills/test' }],
    });
    agent.activateSkill('test-skill');
    const messages = agent.context.getMessages();
    const skillMsg = [...messages].reverse().find(m => m.role === 'user' && m.content.includes('skill_content'));
    expect(skillMsg).toBeDefined();
    expect(skillMsg.content).toContain('<skill_content name="test-skill">');
    expect(skillMsg.content).toContain('skill content');
  });

  it('includes additionalFiles as skill_resources', () => {
    const mockLoader = {
      activateSkill: (name) => {},
    };
    const agent = new Agent({
      skillsLoader: mockLoader,
      skills: [{
        name: 'test-skill',
        content: 'content',
        location: '/skills/test',
        additionalFiles: ['/skills/test/file1.txt', '/skills/test/file2.txt'],
      }],
    });
    agent.activateSkill('test-skill');
    const messages = agent.context.getMessages();
    const skillMsg = [...messages].reverse().find(m => m.role === 'user' && m.content.includes('skill_resources'));
    expect(skillMsg).toBeDefined();
    expect(skillMsg.content).toContain('<skill_resources>');
    expect(skillMsg.content).toContain('file1.txt');
    expect(skillMsg.content).toContain('file2.txt');
  });

  it('resets system messages on skill activation', () => {
    const mockLoader = {
      activateSkill: (name) => {},
    };
    const agent = new Agent({
      skillsLoader: mockLoader,
      skills: [{ name: 'test-skill', content: 'content', location: '/skills/test' }],
    });
    agent.ensureSystemPrompt();
    expect(agent.context.systemMessages.length).toBe(1);
    agent.activateSkill('test-skill');
    expect(agent.context.systemMessages.length).toBe(0);
  });
});

describe('Agent.processStream', () => {
  it('accumulates full text from content events', async () => {
    const agent = new Agent();
    const stream = (async function* () {
      yield { type: 'content', content: 'Hello' };
      yield { type: 'content', content: ' World' };
    })();

    const result = await agent.processStream(stream, 100);
    expect(result.fullText).toBe('Hello World');
    expect(result.generationDurationMs).toBe(100);
  });

  it('accumulates reasoning content', async () => {
    const agent = new Agent();
    const stream = (async function* () {
      yield { type: 'reasoning', content: 'Thinking ' };
      yield { type: 'reasoning', content: 'about it' };
      yield { type: 'content', content: 'Done' };
    })();

    const result = await agent.processStream(stream, 50);
    expect(result.fullReasoning).toBe('Thinking about it');
    expect(result.fullText).toBe('Done');
  });

  it('buffers and builds tool calls from events', async () => {
    const agent = new Agent();
    const stream = (async function* () {
      yield { type: 'toolName', index: 0, name: 'bash', toolCallId: 'call-1' };
      yield { type: 'toolArgument', index: 0, arguments: '{"cmd"' };
      yield { type: 'toolArgument', index: 0, arguments: ': "ls"}' };
      yield { type: 'content', content: 'Result' };
    })();

    const result = await agent.processStream(stream, 10);
    expect(result.finalToolCalls).toHaveLength(1);
    expect(result.finalToolCalls[0].function.name).toBe('bash');
    expect(result.finalToolCalls[0].function.arguments).toBe('{"cmd": "ls"}');
    expect(result.finalToolCalls[0].id).toBeDefined();
  });

  it('handles multiple tool calls', async () => {
    const agent = new Agent();
    const stream = (async function* () {
      yield { type: 'toolName', index: 0, name: 'read', toolCallId: 'call-a' };
      yield { type: 'toolArgument', index: 0, arguments: '{"path":"a"}' };
      yield { type: 'toolName', index: 1, name: 'write', toolCallId: 'call-b' };
      yield { type: 'toolArgument', index: 1, arguments: '{"path":"b"}' };
    })();

    const result = await agent.processStream(stream, 10);
    expect(result.finalToolCalls).toHaveLength(2);
    expect(result.finalToolCalls[0].function.name).toBe('read');
    expect(result.finalToolCalls[1].function.name).toBe('write');
  });

  it('captures usage data', async () => {
    const agent = new Agent();
    const stream = (async function* () {
      yield { type: 'content', content: 'Hi' };
      yield { type: 'usage', data: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    })();

    const result = await agent.processStream(stream, 20);
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('respects cancellation during stream', async () => {
    const agent = new Agent();
    agent.cancel(true);
    const stream = (async function* () {
      yield { type: 'content', content: 'Hello' };
    })();

    await expect(agent.processStream(stream, 10)).rejects.toThrow('cancelled');
  });

  it('does not emit streaming chunks when stream is false', async () => {
    const agent = new Agent({ stream: false });
    const events = [];
    const mockSink = { emit: (e) => events.push(e) };
    agent.setSink(mockSink);

    const stream = (async function* () {
      yield { type: 'content', content: 'Hello' };
    })();

    const result = await agent.processStream(stream, 10);
    expect(result.fullText).toBe('Hello');
    expect(events).toHaveLength(0);
  });

  it('emits streaming chunks when stream is true', async () => {
    const agent = new Agent({ stream: true });
    const events = [];
    const mockSink = { emit: (e) => events.push(e) };
    agent.setSink(mockSink);

    const stream = (async function* () {
      yield { type: 'content', content: 'Hello' };
      yield { type: 'content', content: ' World' };
    })();

    const result = await agent.processStream(stream, 10);
    expect(result.fullText).toBe('Hello World');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe(OUTPUT_EVENT.STREAMING_CHUNK);
    expect(events[1].type).toBe(OUTPUT_EVENT.STREAMING_CHUNK);
  });

  it('emits reasoning chunks when stream is true', async () => {
    const agent = new Agent({ stream: true });
    const events = [];
    const mockSink = { emit: (e) => events.push(e) };
    agent.setSink(mockSink);

    const stream = (async function* () {
      yield { type: 'reasoning', content: 'Thinking' };
    })();

    await agent.processStream(stream, 10);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(OUTPUT_EVENT.STREAMING_REASONING_CHUNK);
  });
});

describe('Agent.processResponse', async () => {
  it('returns text when no tool calls', async () => {
    const agent = new Agent();
    const response = {
      fullText: 'Hello world',
      fullReasoning: null,
      finalToolCalls: null,
      usage: null,
      generationDurationMs: 100,
    };
    const result = await agent.processResponse(response);
    expect(result).toBe('Hello world');
    const messages = agent.context.getMessages();
    const assistantMsg = messages.find(m => m.role === 'assistant');
    expect(assistantMsg.content).toBe('Hello world');
  });

  it('returns "continue" when tool calls present', async () => {
    const mockSink = { emit: () => {} };
    const mockTool = { execute: async () => 'tool output' };
    const registry = new ToolRegistry();
    registry.register('bash', mockTool);

    const agent = new Agent({ sink: mockSink, skills: [], allSkills: [] });
    agent._currentTools = registry;

    const response = {
      fullText: 'I will run bash',
      fullReasoning: null,
      finalToolCalls: [{ id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      usage: null,
      generationDurationMs: 100,
    };
    const result = await agent.processResponse(response);
    expect(result).toBe('continue');
  });

  it('adds response with reasoning and tool calls', async () => {
    const mockSink = { emit: () => {} };
    const mockTool = { execute: async () => 'tool output' };
    const registry = new ToolRegistry();
    registry.register('bash', mockTool);

    const agent = new Agent({ sink: mockSink, skills: [], allSkills: [] });
    agent._currentTools = registry;

    const response = {
      fullText: 'Output',
      fullReasoning: 'Thinking...',
      finalToolCalls: [{ id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      usage: null,
      generationDurationMs: 100,
    };
    await agent.processResponse(response);

    const messages = agent.context.getMessages();
    const assistantMsg = messages.find(m => m.role === 'assistant');
    expect(assistantMsg.content).toBe('Output');
    expect(assistantMsg.reasoningContent).toBe('Thinking...');
    expect(assistantMsg.toolCalls).toBeDefined();
  });
});

describe('Agent.trackTokenStats', () => {
  it('creates new stats entry for first usage', () => {
    const agent = new Agent();
    agent.trackTokenStats(
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      'test-model',
    );
    const stats = agent.getTokenStats().get('test-model');
    expect(stats).toBeDefined();
    expect(stats.totalRequests).toBe(1);
    expect(stats.successfulRequests).toBe(1);
    expect(stats.latestPromptTokens).toBe(100);
    expect(stats.latestCompletionTokens).toBe(50);
    expect(stats.latestTotalTokens).toBe(150);
  });

  it('accumulates stats across multiple calls', () => {
    const agent = new Agent();
    agent.trackTokenStats({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, 'test-model');
    agent.trackTokenStats({ prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 }, 'test-model');

    const stats = agent.getTokenStats().get('test-model');
    expect(stats.totalRequests).toBe(2);
    expect(stats.successfulRequests).toBe(2);
    expect(stats.latestPromptTokens).toBe(200);
    expect(stats.latestCompletionTokens).toBe(100);
    expect(stats.latestTotalTokens).toBe(300);
  });

  it('handles cached tokens', () => {
    const agent = new Agent();
    agent.trackTokenStats(
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 80 } },
      'test-model',
    );
    const stats = agent.getTokenStats().get('test-model');
    expect(stats.latestCachedTokens).toBe(80);
  });

  it('handles missing fields gracefully', () => {
    const agent = new Agent();
    agent.trackTokenStats({}, 'test-model');
    const stats = agent.getTokenStats().get('test-model');
    expect(stats.latestPromptTokens).toBe(0);
    expect(stats.latestCompletionTokens).toBe(0);
    expect(stats.latestTotalTokens).toBe(0);
  });

  it('tracks separate stats per model', () => {
    const agent = new Agent();
    agent.trackTokenStats({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, 'model-a');
    agent.trackTokenStats({ prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 }, 'model-b');

    const stats = agent.getTokenStats();
    expect(stats.size).toBe(2);
    expect(stats.get('model-a').latestPromptTokens).toBe(100);
    expect(stats.get('model-b').latestPromptTokens).toBe(200);
  });
});

describe('Agent.drainPendingTaskMessages', () => {
  it('returns false when no pending messages', () => {
    const agent = new Agent();
    expect(agent.drainPendingTaskMessages()).toBe(false);
  });

  it('drains messages into context and emits events', () => {
    const events = [];
    const mockSink = { emit: (e) => events.push(e) };
    const agent = new Agent({ sink: mockSink });

    agent._pendingTaskMessages = [
      'Task 1 completed',
      'Task 2 completed',
    ];

    const drained = agent.drainPendingTaskMessages();
    expect(drained).toBe(true);
    expect(agent._pendingTaskMessages.length).toBe(0);

    const messages = agent.context.getMessages();
    const systemMsgs = messages.filter(m => m.role === 'system');
    expect(systemMsgs.length).toBe(2);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe(OUTPUT_EVENT.TASK_PROGRESS);
    expect(events[0].status).toBe('task_result_received');
  });

  it('returns false on second drain', () => {
    const agent = new Agent();
    agent._pendingTaskMessages = ['msg'];
    agent.drainPendingTaskMessages();
    expect(agent.drainPendingTaskMessages()).toBe(false);
  });
});

describe('Agent.waitForTasksAndDrain', async () => {
  it('returns false when no task manager', async () => {
    const agent = new Agent();
    const result = await agent.waitForTasksAndDrain();
    expect(result).toBe(false);
  });

  it('returns false when no active tasks and no pending messages', async () => {
    const agent = new Agent({
      taskManager: {
        activeTasks: () => [],
      },
    });
    const result = await agent.waitForTasksAndDrain();
    expect(result).toBe(false);
  });

  it('returns true when tasks complete and drain messages', async () => {
    const agent = new Agent({
      taskManager: {
        activeTasks: () => [],
      },
    });
    agent._pendingTaskMessages = ['task result'];
    const result = await agent.waitForTasksAndDrain();
    expect(result).toBe(true);
  });
});

describe('Agent.tokenStatsDisplay', () => {
  it('returns default when no stats', () => {
    const agent = new Agent();
    const display = agent.tokenStatsDisplay();
    expect(display).toContain('Token Usage');
  });

  it('shows stats for tracked models', () => {
    const agent = new Agent();
    agent.trackTokenStats(
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 80 } },
      'test-model',
    );
    const display = agent.tokenStatsDisplay();
    expect(display).toContain('Token Usage');
    expect(display).toContain('test-model');
    expect(display).toContain('1 ok');
    expect(display).toContain('20 prompt');
    expect(display).toContain('80 cached');
    expect(display).toContain('50 completion');
    expect(display).toContain('150 total');
  });

  it('handles multiple models', () => {
    const agent = new Agent();
    agent.trackTokenStats({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, 'model-a');
    agent.trackTokenStats({ prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 }, 'model-b');
    const display = agent.tokenStatsDisplay();
    expect(display).toContain('model-a');
    expect(display).toContain('model-b');
  });
});

describe('Agent.availablePrompts', () => {
  it('returns empty array when no prompts loader', () => {
    const agent = new Agent();
    expect(agent.availablePrompts()).toEqual([]);
  });

  it('returns prompts from loader', () => {
    const mockLoader = {
      allPrompts: () => [
        { name: 'prompt-a', disableModelInvocation: false },
        { name: 'prompt-b', disableModelInvocation: true },
      ],
    };
    const agent = new Agent({ promptsLoader: mockLoader });
    expect(agent.availablePrompts()).toEqual([
      { name: 'prompt-a', disableModelInvocation: false },
      { name: 'prompt-b', disableModelInvocation: true },
    ]);
  });
});

describe('Agent.allSkills', () => {
  it('returns empty array when no skills loader', () => {
    const agent = new Agent();
    expect(agent.allSkills()).toEqual([]);
  });

  it('returns skills from loader', () => {
    const mockLoader = {
      allSkills: () => [{ name: 'skill-a' }, { name: 'skill-b' }],
    };
    // Don't pass allSkills as constructor arg — it would shadow the method
    const agent = new Agent({ skillsLoader: mockLoader });
    expect(agent.allSkills()).toEqual([{ name: 'skill-a' }, { name: 'skill-b' }]);
  });
});

describe('Agent.autoActivateSkills', () => {
  it('does nothing when no skills loader', () => {
    const agent = new Agent();
    expect(() => agent.autoActivateSkills(['read', 'write'])).not.toThrow();
  });

  it('calls loader autoActivate with tool names', () => {
    let capturedTools = null;
    const mockLoader = {
      autoActivate: (tools) => { capturedTools = tools; },
    };
    const agent = new Agent({ skillsLoader: mockLoader });
    agent.autoActivateSkills(['read', 'write', 'grep']);
    expect(capturedTools).toEqual(['read', 'write', 'grep']);
  });
});

describe('Agent.getToolDefs', () => {
  it('returns filtered tool defs', () => {
    const agent = new Agent();
    const registry = new ToolRegistry();
    registry.register('bash', { toToolDef: () => ({ function: { name: 'bash' } }) });
    registry.register('write', { toToolDef: () => ({ function: { name: 'write' } }) });
    const defs = agent.getToolDefs(registry);
    expect(defs).toHaveLength(2);
  });
});

describe('Agent.writeCompactionDebugFile', () => {
  it('writes JSON to file when compactDebug is true', () => {
    const agent = new Agent({ compactDebug: true });
    agent.addInput('Hello');
    agent.addResponse('Hi there');
    expect(() => agent.writeCompactionDebugFile()).not.toThrow();
  });
});

describe('Agent.createToolContext', () => {
  it('provides onClearContext callback', () => {
    const agent = new Agent();
    agent.addInput('Hello');
    agent.iterationCount = 5;
    const ctx = agent.createToolContext();
    ctx.onClearContext();
    expect(agent.iterationCount).toBe(0);
  });
});

describe('Agent._buildSkillsPreamble', () => {
  it('returns empty string when no skills', () => {
    const agent = new Agent();
    expect(agent._buildSkillsPreamble()).toBe('');
  });

  it('returns empty string when no visible skills', () => {
    const agent = new Agent({
      allSkills: [
        { name: 'skill-a', visible: false, loaded: true, content: 'content' },
      ],
    });
    expect(agent._buildSkillsPreamble()).toBe('');
  });

  it('returns empty string when all visible skills are disabled', () => {
    const agent = new Agent({
      allSkills: [
        { name: 'skill-a', visible: true, disableModelInvocation: true, loaded: true, content: 'content' },
      ],
    });
    expect(agent._buildSkillsPreamble()).toBe('');
  });

  it('includes loaded skills with content', () => {
    const agent = new Agent({
      allSkills: [
        { name: 'skill-a', visible: true, loaded: true, content: 'Skill A content' },
      ],
      skillDirectories: ['/skills'],
    });
    const preamble = agent._buildSkillsPreamble();
    expect(preamble).toContain('# Available Skills');
    expect(preamble).toContain('## Loaded Skills');
    expect(preamble).toContain('<skill_content name="skill-a">');
    expect(preamble).toContain('Skill A content');
  });

  it('includes unloaded skills with descriptions', () => {
    const agent = new Agent({
      allSkills: [
        { name: 'skill-a', visible: true, loaded: false, description: 'A helpful skill' },
      ],
      skillDirectories: ['/skills'],
    });
    const preamble = agent._buildSkillsPreamble();
    expect(preamble).toContain('# Available Skills');
    expect(preamble).toContain('## Available Skills');
    expect(preamble).toContain('<name>skill-a</name>');
    expect(preamble).toContain('A helpful skill');
  });

  it('includes both loaded and unloaded skills', () => {
    const agent = new Agent({
      allSkills: [
        { name: 'loaded-skill', visible: true, loaded: true, content: 'loaded content' },
        { name: 'unloaded-skill', visible: true, loaded: false, description: 'unloaded desc' },
      ],
      skillDirectories: ['/skills'],
    });
    const preamble = agent._buildSkillsPreamble();
    expect(preamble).toContain('<skill_content name="loaded-skill">');
    expect(preamble).toContain('loaded content');
    expect(preamble).toContain('<name>unloaded-skill</name>');
    expect(preamble).toContain('unloaded desc');
  });

  it('uses default skill directory when none configured', () => {
    const agent = new Agent({
      allSkills: [
        { name: 'skill-a', visible: true, loaded: true, content: 'content' },
      ],
      skillDirectories: [],
    });
    const preamble = agent._buildSkillsPreamble();
    expect(preamble).toContain('/skills');
  });
});

describe('Agent.executePrompt', () => {
  it('returns error when no prompts loader', () => {
    const agent = new Agent();
    const result = agent.executePrompt('test');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Prompts loader not configured');
  });

  it('returns error for unknown prompt', () => {
    const mockLoader = {
      allPrompts: () => [{ name: 'prompt-a', disableModelInvocation: false }],
      getPrompt: () => null,
    };
    const agent = new Agent({ promptsLoader: mockLoader });
    const result = agent.executePrompt('unknown');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown prompt');
    expect(result.error).toContain('prompt-a');
  });

  it('executes prompt without args', () => {
    const mockLoader = {
      getPrompt: () => ({ content: 'Hello {{ARGS.name}}' }),
      allPrompts: () => [],
    };
    const agent = new Agent({ promptsLoader: mockLoader });
    const result = agent.executePrompt('test');
    expect(result.success).toBe(true);
    expect(result.prompt).toBe('Hello {{ARGS.name}}');
  });

  it('executes prompt with args', () => {
    const mockLoader = {
      getPrompt: () => ({ content: 'Hello {{ARGS.name}}' }),
      allPrompts: () => [],
    };
    const agent = new Agent({ promptsLoader: mockLoader });
    const result = agent.executePrompt('test', { name: 'World' });
    expect(result.success).toBe(true);
    expect(result.prompt).toBe('Hello World');
  });

  it('falls back to raw content on render error', () => {
    const mockLoader = {
      getPrompt: () => ({ content: '{{invalid syntax' }),
      allPrompts: () => [],
    };
    const agent = new Agent({ promptsLoader: mockLoader });
    const result = agent.executePrompt('test', { name: 'World' });
    expect(result.success).toBe(true);
    expect(result.prompt).toBe('{{invalid syntax');
  });

  it('adds rendered prompt as user message', () => {
    const mockLoader = {
      getPrompt: () => ({ content: 'Prompt content' }),
      allPrompts: () => [],
    };
    const agent = new Agent({ promptsLoader: mockLoader });
    agent.executePrompt('test');
    const messages = agent.context.getMessages();
    const userMsg = [...messages].reverse().find(m => m.role === 'user');
    expect(userMsg.content).toBe('Prompt content');
  });
});

describe('Agent.clearContext', () => {
  it('generates new session ID', () => {
    const agent = new Agent();
    const oldId = agent.sessionId;
    agent.clearContext();
    expect(agent.sessionId).not.toBe(oldId);
  });

  it('resets iteration count', () => {
    const agent = new Agent();
    agent.iterationCount = 42;
    agent.clearContext();
    expect(agent.iterationCount).toBe(0);
  });

  it('clears context messages', () => {
    const agent = new Agent();
    agent.addInput('Hello');
    agent.clearContext();
    expect(agent.context.size()).toBe(0);
  });

  it('does not clear used tools', () => {
    const agent = new Agent();
    agent.usedTools.add('bash');
    agent.clearContext();
    expect(agent.usedTools.has('bash')).toBe(true);
  });

  it('does not clear active skills', () => {
    const agent = new Agent();
    agent.activeSkills.add('skill-a');
    agent.clearContext();
    expect(agent.activeSkills.has('skill-a')).toBe(true);
  });
});

describe('Agent.filteredToolDefs', () => {
  it('returns all defs when no active skills', () => {
    const agent = new Agent();
    const registry = new ToolRegistry();
    registry.register('bash', { toToolDef: () => ({ function: { name: 'bash' } }) });
    registry.register('write', { toToolDef: () => ({ function: { name: 'write' } }) });
    const defs = agent.filteredToolDefs(registry);
    expect(defs).toHaveLength(2);
  });

  it('filters tool defs by active skill patterns', () => {
    const agent = new Agent({
      skills: [{ name: 'skill-a', allowedTools: ['read'], includeTools: ['grep'] }],
    });
    agent.activeSkills.add('skill-a');
    const registry = new ToolRegistry();
    registry.register('bash', { toToolDef: () => ({ function: { name: 'bash' } }) });
    registry.register('read', { toToolDef: () => ({ function: { name: 'read' } }) });
    registry.register('grep', { toToolDef: () => ({ function: { name: 'grep' } }) });
    const defs = agent.filteredToolDefs(registry);
    expect(defs).toHaveLength(2);
    expect(defs[0].function.name).toBe('read');
    expect(defs[1].function.name).toBe('grep');
  });

  it('deduplicates tool defs', () => {
    const agent = new Agent({
      skills: [{ name: 'skill-a', allowedTools: ['read'] }],
    });
    agent.activeSkills.add('skill-a');
    const registry = new ToolRegistry();
    registry.register('read', { toToolDef: () => ({ function: { name: 'read' } }) });
    // Register same tool name again - should be deduplicated
    registry.register('read2', { toToolDef: () => ({ function: { name: 'read' } }) });
    const defs = agent.filteredToolDefs(registry);
    expect(defs).toHaveLength(1);
  });
});

describe('Agent.isToolAllowed', () => {
  it('returns true when no active skills', () => {
    const agent = new Agent();
    expect(agent.isToolAllowed('bash')).toBe(true);
    expect(agent.isToolAllowed('write')).toBe(true);
  });

  it('returns true for tools allowed by active skills', () => {
    const agent = new Agent({
      skills: [{ name: 'skill-a', allowedTools: ['read', 'write'] }],
    });
    agent.activeSkills.add('skill-a');
    expect(agent.isToolAllowed('read')).toBe(true);
    expect(agent.isToolAllowed('write')).toBe(true);
  });

  it('returns false for tools not allowed by active skills', () => {
    const agent = new Agent({
      skills: [{ name: 'skill-a', allowedTools: ['read', 'write'] }],
    });
    agent.activeSkills.add('skill-a');
    expect(agent.isToolAllowed('bash')).toBe(false);
  });

  it('returns false for tools not in any active skill', () => {
    const agent = new Agent({
      skills: [
        { name: 'skill-a', allowedTools: ['read'] },
        { name: 'skill-b', allowedTools: ['write'] },
      ],
    });
    agent.activeSkills.add('skill-a');
    expect(agent.isToolAllowed('read')).toBe(true);
    expect(agent.isToolAllowed('write')).toBe(false);
  });

  it('supports includeTools patterns', () => {
    const agent = new Agent({
      skills: [{ name: 'skill-a', allowedTools: ['read'], includeTools: ['grep*'] }],
    });
    agent.activeSkills.add('skill-a');
    expect(agent.isToolAllowed('grep')).toBe(true);
    expect(agent.isToolAllowed('grep-file')).toBe(true);
    expect(agent.isToolAllowed('bash')).toBe(false);
  });
});

describe('Agent.allowedToolNames', () => {
  it('returns empty set when no active skills', () => {
    const agent = new Agent();
    const allowed = agent.allowedToolNames();
    expect(allowed.size).toBe(0);
  });

  it('returns allowed tools from active skills', () => {
    const agent = new Agent({
      skills: [{ name: 'skill-a', allowedTools: ['read', 'grep'] }],
    });
    agent.activeSkills.add('skill-a');
    const allowed = agent.allowedToolNames();
    expect(allowed.has('read')).toBe(true);
    expect(allowed.has('grep')).toBe(true);
    expect(allowed.has('bash')).toBe(false);
  });

  it('converts tool names to lowercase', () => {
    const agent = new Agent({
      skills: [{ name: 'skill-a', allowedTools: ['READ', 'Write'] }],
    });
    agent.activeSkills.add('skill-a');
    const allowed = agent.allowedToolNames();
    expect(allowed.has('read')).toBe(true);
    expect(allowed.has('write')).toBe(true);
  });
});

describe('Agent.currentModel', () => {
  it('returns the current model', () => {
    const agent = new Agent();
    expect(agent.currentModel()).toBe('qwen3.5-0.8b');
  });

  it('returns custom model when set', () => {
    const agent = new Agent({ model: 'custom-model' });
    expect(agent.currentModel()).toBe('custom-model');
  });
});

describe('Agent.cancel', () => {
  it('cancels the agent', () => {
    const agent = new Agent();
    expect(agent.cancelled).toBe(false);
    agent.cancel(true);
    expect(agent.cancelled).toBe(true);
  });

  it('resets cancellation', () => {
    const agent = new Agent();
    agent.cancel(true);
    agent.cancel(false);
    expect(agent.cancelled).toBe(false);
  });
});

describe('Agent.setSink', () => {
  it('sets a new output sink', () => {
    const agent = new Agent();
    const newSink = { emit: () => {} };
    agent.setSink(newSink);
    expect(agent.sink).toBe(newSink);
  });
});
