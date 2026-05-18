import { describe, it, expect } from 'bun:test';
import {
  resolveFormatString,
  resolveNoLog,
  resolveTheme,
  resolveColors,
  resolveColorPalette,
  resolveModelName,
  resolveModelWithProvider,
  resolveBaseUrl,
  resolveApiKey,
  resolveAspectNames,
  resolveRole,
  resolveProfile,
  resolveProvider,
  renderProfileBody,
  resolveSwitchProfile,
  allProfilesForSwitch,
  initSystemPromptTemplate,
} from '../src/init/resolution.js';

describe('resolveFormatString', () => {
  it('prefers cli value', () => {
    expect(resolveFormatString('cli', 'config', 'default')).toBe('cli');
  });

  it('prefers config when cli is null', () => {
    expect(resolveFormatString(null, 'config', 'default')).toBe('config');
  });

  it('prefers config when cli is undefined', () => {
    expect(resolveFormatString(undefined, 'config', 'default')).toBe('config');
  });

  it('prefers config when cli is empty string', () => {
    expect(resolveFormatString('', 'config', 'default')).toBe('config');
  });

  it('uses default when cli and config are absent', () => {
    expect(resolveFormatString(null, null, 'default')).toBe('default');
  });

  it('skips empty config value', () => {
    expect(resolveFormatString(null, '', 'default')).toBe('default');
  });

  it('prefers config over empty cli', () => {
    expect(resolveFormatString('', 'config-value', 'default')).toBe('config-value');
  });
});

describe('resolveNoLog', () => {
  it('returns true when cli is true', () => {
    expect(resolveNoLog(true, {})).toBe(true);
  });

  it('returns true when OA_AGENT_LOG is false', () => {
    const orig = process.env.OA_AGENT_LOG;
    process.env.OA_AGENT_LOG = 'false';
    expect(resolveNoLog(false, {})).toBe(true);
    if (orig !== undefined) process.env.OA_AGENT_LOG = orig;
    else delete process.env.OA_AGENT_LOG;
  });

  it('returns true when OA_AGENT_NO_LOG is 1', () => {
    const orig = process.env.OA_AGENT_NO_LOG;
    process.env.OA_AGENT_NO_LOG = '1';
    expect(resolveNoLog(false, {})).toBe(true);
    if (orig !== undefined) process.env.OA_AGENT_NO_LOG = orig;
    else delete process.env.OA_AGENT_NO_LOG;
  });

  it('returns true when config is true', () => {
    expect(resolveNoLog(false, { noLog: true })).toBe(true);
  });

  it('returns false when nothing set', () => {
    const origLog = process.env.OA_AGENT_LOG;
    const origNoLog = process.env.OA_AGENT_NO_LOG;
    delete process.env.OA_AGENT_LOG;
    delete process.env.OA_AGENT_NO_LOG;
    expect(resolveNoLog(false, {})).toBe(false);
    if (origLog !== undefined) process.env.OA_AGENT_LOG = origLog;
    if (origNoLog !== undefined) process.env.OA_AGENT_NO_LOG = origNoLog;
  });
});

describe('resolveTheme', () => {
  it('prefers cli theme', () => {
    expect(resolveTheme('light', 'dark')).toBe('light');
  });

  it('prefers config theme when cli is null', () => {
    expect(resolveTheme(null, 'dark')).toBe('dark');
  });

  it('prefers config theme when cli is empty', () => {
    expect(resolveTheme('', 'dark')).toBe('dark');
  });

  it('uses dark default when nothing set', () => {
    expect(resolveTheme(null, null)).toBe('dark');
  });

  it('handles file path theme', () => {
    expect(resolveTheme('/path/to/theme.json', null)).toBe('/path/to/theme.json');
  });
});

describe('resolveColors', () => {
  it('returns cli value when true', () => {
    expect(resolveColors(true, null)).toBe(true);
  });

  it('returns cli value when false', () => {
    expect(resolveColors(false, true)).toBe(false);
  });

  it('returns config value when cli is undefined', () => {
    expect(resolveColors(undefined, true)).toBe(true);
  });

  it('defaults to true when nothing set', () => {
    expect(resolveColors(undefined, undefined)).toBe(true);
  });
});

describe('resolveColorPalette', () => {
  it('returns palette when config has one', () => {
    const palette = { thinking: '#ff0000', tool_call: '#00ff00' };
    expect(resolveColorPalette({ colors: palette })).toEqual(palette);
  });

  it('returns null when config has no colors', () => {
    expect(resolveColorPalette({})).toBeNull();
  });

  it('returns null when config colors is null', () => {
    expect(resolveColorPalette({ colors: null })).toBeNull();
  });

  it('returns null when config colors is not a palette', () => {
    expect(resolveColorPalette({ colors: 'dark' })).toBeNull();
  });

  it('returns null when config colors is a string', () => {
    expect(resolveColorPalette({ colors: '#ff0000' })).toBeNull();
  });
});

describe('resolveModelName', () => {
  it('prefers profile model over CLI', () => {
    const result = resolveModelName({
      cliModel: 'cli-model',
      profileModel: 'profile-model',
      configModel: null,
      provider: null,
      defaultModel: 'default',
    });
    expect(result).toBe('profile-model');
  });

  it('uses CLI model when no profile model', () => {
    const result = resolveModelName({
      cliModel: 'cli-model',
      profileModel: null,
      configModel: null,
      provider: null,
      defaultModel: 'default',
    });
    expect(result).toBe('cli-model');
  });

  it('uses provider first model when no CLI or profile', () => {
    const result = resolveModelName({
      cliModel: null,
      profileModel: null,
      configModel: null,
      provider: { name: 'openai', models: [{ name: 'gpt-4' }, { name: 'gpt-3.5' }] },
      defaultModel: 'default',
    });
    expect(result).toBe('openai/gpt-4');
  });

  it('uses config model when no CLI, profile, or provider', () => {
    const result = resolveModelName({
      cliModel: null,
      profileModel: null,
      configModel: 'config-model',
      provider: null,
      defaultModel: 'default',
    });
    expect(result).toBe('config-model');
  });

  it('falls back to default model', () => {
    const result = resolveModelName({
      cliModel: null,
      profileModel: null,
      configModel: null,
      provider: null,
      defaultModel: 'qwen3.5-0.8b',
    });
    expect(result).toBe('qwen3.5-0.8b');
  });

  it('handles provider with no models array', () => {
    const result = resolveModelName({
      cliModel: null,
      profileModel: null,
      configModel: null,
      provider: { name: 'test', models: [] },
      defaultModel: 'default',
    });
    expect(result).toBe('default');
  });

  it('handles provider with no models property', () => {
    const result = resolveModelName({
      cliModel: null,
      profileModel: null,
      configModel: null,
      provider: { name: 'test' },
      defaultModel: 'default',
    });
    expect(result).toBe('default');
  });
});

describe('resolveModelWithProvider', () => {
  it('returns name as-is when it already contains /', () => {
    expect(resolveModelWithProvider('provider/model', null)).toBe('provider/model');
  });

  it('prefixeds with provider name when name matches provider model', () => {
    const provider = { name: 'openai', models: [{ name: 'gpt-4' }] };
    expect(resolveModelWithProvider('gpt-4', provider)).toBe('openai/gpt-4');
  });

  it('returns name as-is when name does not match provider model', () => {
    const provider = { name: 'openai', models: [{ name: 'gpt-4' }] };
    expect(resolveModelWithProvider('claude', provider)).toBe('claude');
  });

  it('returns name as-is when provider has no models', () => {
    expect(resolveModelWithProvider('gpt-4', { name: 'openai' })).toBe('gpt-4');
  });

  it('returns name as-is when provider is null', () => {
    expect(resolveModelWithProvider('gpt-4', null)).toBe('gpt-4');
  });
});

describe('resolveBaseUrl', () => {
  it('prefers provider URL', () => {
    const result = resolveBaseUrl({
      cliUrl: 'http://cli.com',
      configUrl: 'http://config.com',
      provider: { url: 'http://provider.com' },
    });
    expect(result).toBe('http://provider.com');
  });

  it('prefers CLI URL when no provider', () => {
    const result = resolveBaseUrl({
      cliUrl: 'http://cli.com',
      configUrl: 'http://config.com',
      provider: null,
    });
    expect(result).toBe('http://cli.com');
  });

  it('prefers config URL when no CLI or provider', () => {
    const result = resolveBaseUrl({
      cliUrl: null,
      configUrl: 'http://config.com',
      provider: null,
    });
    expect(result).toBe('http://config.com');
  });

  it('uses default when nothing set', () => {
    const result = resolveBaseUrl({
      cliUrl: null,
      configUrl: null,
      provider: null,
    });
    expect(result).toBe('http://ai365.home:9292');
  });
});

describe('resolveApiKey', () => {
  it('prefers provider API key', () => {
    const result = resolveApiKey({
      cliKey: 'cli-key',
      configKey: 'config-key',
      provider: { apiKey: 'provider-key' },
    });
    expect(result).toBe('provider-key');
  });

  it('prefers CLI key when no provider', () => {
    const result = resolveApiKey({
      cliKey: 'cli-key',
      configKey: 'config-key',
      provider: null,
    });
    expect(result).toBe('cli-key');
  });

  it('prefers config key when no CLI or provider', () => {
    const result = resolveApiKey({
      cliKey: null,
      configKey: 'config-key',
      provider: null,
    });
    expect(result).toBe('config-key');
  });

  it('uses env when no CLI, config, or provider', () => {
    const orig = process.env.AI_API_KEY;
    process.env.AI_API_KEY = 'env-key';
    const result = resolveApiKey({
      cliKey: null,
      configKey: null,
      provider: null,
    });
    expect(result).toBe('env-key');
    if (orig !== undefined) process.env.AI_API_KEY = orig;
    else delete process.env.AI_API_KEY;
  });

  it('returns null when nothing set', () => {
    const orig = process.env.AI_API_KEY;
    delete process.env.AI_API_KEY;
    const result = resolveApiKey({
      cliKey: null,
      configKey: null,
      provider: null,
    });
    expect(result).toBeNull();
    if (orig !== undefined) process.env.AI_API_KEY = orig;
  });
});

describe('resolveAspectNames', () => {
  it('prefers file profile aspects', () => {
    const result = resolveAspectNames({
      fileProfile: { aspects: ['file-aspect'] },
      configProfile: { aspects: ['config-aspect'] },
    });
    expect(result).toEqual(['file-aspect']);
  });

  it('uses config profile aspects when no file profile', () => {
    const result = resolveAspectNames({
      fileProfile: null,
      configProfile: { aspects: ['config-aspect'] },
    });
    expect(result).toEqual(['config-aspect']);
  });

  it('uses config profile aspects when file profile has no aspects', () => {
    const result = resolveAspectNames({
      fileProfile: { aspects: [] },
      configProfile: { aspects: ['config-aspect'] },
    });
    expect(result).toEqual(['config-aspect']);
  });

  it('returns empty array when no aspects anywhere', () => {
    const result = resolveAspectNames({
      fileProfile: null,
      configProfile: null,
    });
    expect(result).toEqual([]);
  });
});

describe('resolveRole', () => {
  it('prefers CLI role', () => {
    const result = resolveRole({
      cliRole: 'cli-role',
      configRole: 'config-role',
      fileProfile: { role: 'file-role' },
      defaultRole: 'default-role',
    });
    expect(result).toBe('cli-role');
  });

  it('prefers config role when no CLI', () => {
    const result = resolveRole({
      cliRole: null,
      configRole: 'config-role',
      fileProfile: { role: 'file-role' },
      defaultRole: 'default-role',
    });
    expect(result).toBe('config-role');
  });

  it('prefers file profile role when no CLI or config', () => {
    const result = resolveRole({
      cliRole: null,
      configRole: null,
      fileProfile: { role: 'file-role' },
      defaultRole: 'default-role',
    });
    expect(result).toBe('file-role');
  });

  it('skips empty config role', () => {
    const result = resolveRole({
      cliRole: null,
      configRole: '',
      fileProfile: { role: 'file-role' },
      defaultRole: 'default-role',
    });
    expect(result).toBe('file-role');
  });

  it('skips whitespace-only config role', () => {
    const result = resolveRole({
      cliRole: null,
      configRole: '   ',
      fileProfile: { role: 'file-role' },
      defaultRole: 'default-role',
    });
    expect(result).toBe('file-role');
  });

  it('skips empty file profile role', () => {
    const result = resolveRole({
      cliRole: null,
      configRole: null,
      fileProfile: { role: '' },
      defaultRole: 'default-role',
    });
    expect(result).toBe('default-role');
  });

  it('uses default when nothing set', () => {
    const result = resolveRole({
      cliRole: null,
      configRole: null,
      fileProfile: null,
      defaultRole: 'You are an AI coding assistant.',
    });
    expect(result).toBe('You are an AI coding assistant.');
  });
});

describe('resolveProfile', () => {
  it('returns defaults when no profiles', () => {
    const result = resolveProfile({ configProfile: null, fileProfile: null });
    expect(result).toEqual({
      whitelistTools: null,
      blacklistTools: [],
      skills: [],
      role: null,
      model: null,
      preloadSkills: [],
      manager: false,
      cwdBoundary: null,
      aspects: [],
    });
  });

  it('merges file profile overrides into config profile', () => {
    const result = resolveProfile({
      configProfile: {
        whitelistTools: ['read', 'write'],
        blacklistTools: ['edit'],
        preloadSkills: ['skill-a'],
        manager: false,
      },
      fileProfile: {
        whitelistTools: ['read'],
        blacklistTools: ['edit', 'grep'],
        preloadSkills: ['skill-b'],
        manager: true,
      },
    });
    expect(result.whitelistTools).toEqual(['read']);
    expect(result.blacklistTools).toEqual(['edit', 'grep']);
    expect(result.preloadSkills).toEqual(['skill-b']);
    expect(result.manager).toBe(true);
  });

  it('keeps config profile when no file profile', () => {
    const result = resolveProfile({
      configProfile: { whitelistTools: ['read'] },
      fileProfile: null,
    });
    expect(result.whitelistTools).toEqual(['read']);
  });

  it('handles file profile without whitelistTools', () => {
    const result = resolveProfile({
      configProfile: { whitelistTools: ['read'] },
      fileProfile: { blacklistTools: ['edit'] },
    });
    expect(result.whitelistTools).toEqual(['read']);
    expect(result.blacklistTools).toEqual(['edit']);
  });
});

describe('resolveProvider', () => {
  it('returns provider by CLI name', () => {
    const providers = [
      { name: 'openai' },
      { name: 'anthropic' },
    ];
    const result = resolveProvider({
      cliProvider: 'anthropic',
      configProvider: null,
      providers,
    });
    expect(result).toEqual({ name: 'anthropic' });
  });

  it('returns provider by config name when no CLI', () => {
    const providers = [
      { name: 'openai' },
      { name: 'anthropic' },
    ];
    const result = resolveProvider({
      cliProvider: null,
      configProvider: 'openai',
      providers,
    });
    expect(result).toEqual({ name: 'openai' });
  });

  it('returns null when provider not found', () => {
    const providers = [{ name: 'openai' }];
    const result = resolveProvider({
      cliProvider: 'nonexistent',
      configProvider: null,
      providers,
    });
    expect(result).toBeNull();
  });

  it('returns null when no provider name', () => {
    const result = resolveProvider({
      cliProvider: null,
      configProvider: null,
      providers: [],
    });
    expect(result).toBeNull();
  });

  it('CLI takes priority over config', () => {
    const providers = [
      { name: 'openai' },
      { name: 'anthropic' },
    ];
    const result = resolveProvider({
      cliProvider: 'anthropic',
      configProvider: 'openai',
      providers,
    });
    expect(result.name).toBe('anthropic');
  });
});

describe('renderProfileBody', () => {
  it('returns empty string for null body', () => {
    expect(renderProfileBody(null, null)).toBe('');
  });

  it('returns empty string for empty body', () => {
    expect(renderProfileBody('', null)).toBe('');
  });

  it('returns body when no args', () => {
    expect(renderProfileBody('Hello world', null)).toBe('Hello world');
  });

  it('renders template with args', () => {
    const body = 'Task: {{ ARGS.task }}';
    const result = renderProfileBody(body, { task: 'write code' });
    expect(result).toBe('Task: write code');
  });

  it('falls back to raw body on render error', () => {
    const body = '{{ broken }}';
    const result = renderProfileBody(body, null);
    expect(result).toBe('{{ broken }}');
  });
});

describe('resolveSwitchProfile', () => {
  it('uses file profile role over config role', () => {
    const result = resolveSwitchProfile(
      'test',
      { role: 'file-role' },
      { role: 'config-role' },
      [],
      './config/profiles',
    );
    expect(result.role).toBe('file-role');
  });

  it('uses config role when no file role', () => {
    const result = resolveSwitchProfile(
      'test',
      null,
      { role: 'config-role' },
      [],
      './config/profiles',
    );
    expect(result.role).toBe('config-role');
  });

  it('uses empty string when no roles', () => {
    const result = resolveSwitchProfile(
      'test',
      null,
      null,
      [],
      './config/profiles',
    );
    expect(result.role).toBe('');
  });

  it('returns model from config profile', () => {
    const result = resolveSwitchProfile(
      'test',
      null,
      { model: 'gpt-4' },
      [],
      './config/profiles',
    );
    expect(result.model).toBe('gpt-4');
  });

  it('returns null model when not set', () => {
    const result = resolveSwitchProfile(
      'test',
      null,
      null,
      [],
      './config/profiles',
    );
    expect(result.model).toBeNull();
  });

  it('returns empty aspects when no aspect names', () => {
    const result = resolveSwitchProfile(
      'test',
      null,
      null,
      [],
      './config/profiles',
    );
    expect(result.aspects).toEqual([]);
  });
});

describe('allProfilesForSwitch', () => {
  it('merges config and file profiles', () => {
    const result = allProfilesForSwitch({
      profileFiles: { 'minimal': { role: 'file-role', aspects: ['aspect-a'] } },
      configProfiles: { 'default': { role: 'config-role' }, 'minimal': { role: 'config-role', aspects: ['aspect-b'] } },
      profilesPath: './config/profiles',
    });
    expect(result).toHaveProperty('minimal');
    expect(result).toHaveProperty('default');
  });

  it('handles empty inputs', () => {
    const result = allProfilesForSwitch({
      profileFiles: null,
      configProfiles: null,
      profilesPath: './config/profiles',
    });
    expect(result).toEqual({});
  });

  it('handles only file profiles', () => {
    const result = allProfilesForSwitch({
      profileFiles: { 'test': { role: 'test-role', aspects: [] } },
      configProfiles: {},
      profilesPath: './config/profiles',
    });
    expect(result).toHaveProperty('test');
  });
});

describe('initSystemPromptTemplate', () => {
  it('returns cached template on second call', () => {
    const template1 = initSystemPromptTemplate('./nonexistent/path1.md');
    const template2 = initSystemPromptTemplate('./nonexistent/path2.md');
    expect(template1).toBe(template2);
  });

  it('returns the template string', () => {
    const template = initSystemPromptTemplate('./nonexistent/path.md');
    expect(typeof template).toBe('string');
    expect(template.length).toBeGreaterThan(0);
  });

  it('uses fallback template when file not found', () => {
    const template = initSystemPromptTemplate('./nonexistent/fallback.md');
    expect(template).toContain('{{ role }}');
    expect(template).toContain('{{ model }}');
    expect(template).toContain('{{ profile_name }}');
  });
});
