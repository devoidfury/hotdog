import { describe, it, expect } from 'bun:test';
import {
  parseFrontMatter,
  resolveString,
  resolveApiKey,
  isFalse,
  isEmptyArray,
  isNoneOr,
  buildModelRegistry,
} from '../src/config.js';

describe('parseFrontMatter', () => {
  it('parses simple front matter', () => {
    const input = `---
title: Hello
---
Body content`;
    const result = parseFrontMatter(input);
    expect(result).toEqual({ frontMatter: { title: 'Hello' }, body: 'Body content' });
  });

  it('parses front matter without trailing newline', () => {
    const input = `---
name: test
---
Body`; 
    const result = parseFrontMatter(input);
    expect(result).toEqual({ frontMatter: { name: 'test' }, body: 'Body' });
  });

  it('handles empty body after front matter', () => {
    const input = `---
title: test
---`;
    const result = parseFrontMatter(input);
    expect(result).toEqual({ frontMatter: { title: 'test' }, body: '' });
  });

  it('returns null when no front matter', () => {
    expect(parseFrontMatter('just plain text')).toBeNull();
  });

  it('parses multiple fields', () => {
    const input = `---
title: Hello
description: A test
author: John
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter).toEqual({
      title: 'Hello',
      description: 'A test',
      author: 'John',
    });
  });

  it('parses booleans', () => {
    const input = `---
active: true
hidden: false
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter).toEqual({ active: true, hidden: false });
  });

  it('parses numbers', () => {
    const input = `---
count: 42
negative: -7
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter).toEqual({ count: 42, negative: -7 });
  });

  it('parses arrays', () => {
    const input = `---
tags: ["a", "b", "c"]
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter.tags).toEqual(['a', 'b', 'c']);
  });

  it('parses arrays without quotes', () => {
    const input = `---
tags: [a, b, c]
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter.tags).toEqual(['a', 'b', 'c']);
  });

  it('skips comments and blank lines in front matter', () => {
    const input = `---
# comment
title: Hello

---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter).toEqual({ title: 'Hello' });
  });

  it('strips quotes from string values', () => {
    const input = `---
title: "Hello World"
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.frontMatter.title).toBe('Hello World');
  });
});

describe('resolveString', () => {
  it('prefers cli value', () => {
    expect(resolveString('cli', 'config', 'default', 'ENV')).toBe('cli');
  });

  it('prefers config over cli null', () => {
    expect(resolveString(null, 'config', 'default', 'ENV')).toBe('config');
  });

  it('prefers config over cli undefined', () => {
    expect(resolveString(undefined, 'config', 'default', 'ENV')).toBe('config');
  });

  it('skips empty config value', () => {
    expect(resolveString(null, '', 'default', 'ENV')).toBe('default');
  });

  it('uses env when cli and config are absent', () => {
    const orig = process.env.TEST_RESOLVE;
    process.env.TEST_RESOLVE = 'envval';
    expect(resolveString(null, null, 'default', 'TEST_RESOLVE')).toBe('envval');
    if (orig !== undefined) process.env.TEST_RESOLVE = orig;
    else delete process.env.TEST_RESOLVE;
  });

  it('uses default when nothing set', () => {
    expect(resolveString(null, null, 'default', 'NONEXISTENT')).toBe('default');
  });

  it('skips empty env value', () => {
    const orig = process.env.TEST_RESOLVE2;
    process.env.TEST_RESOLVE2 = '';
    expect(resolveString(null, null, 'default', 'TEST_RESOLVE2')).toBe('default');
    if (orig !== undefined) process.env.TEST_RESOLVE2 = orig;
    else delete process.env.TEST_RESOLVE2;
  });
});

describe('resolveApiKey', () => {
  it('prefers cli key', () => {
    expect(resolveApiKey('cli-key', {})).toBe('cli-key');
  });

  it('uses config key when no cli', () => {
    expect(resolveApiKey(null, { apiKey: 'config-key' })).toBe('config-key');
  });

  it('uses env key when no cli or config', () => {
    const orig = process.env.AI_API_KEY;
    process.env.AI_API_KEY = 'env-key';
    expect(resolveApiKey(null, {})).toBe('env-key');
    if (orig !== undefined) process.env.AI_API_KEY = orig;
    else delete process.env.AI_API_KEY;
  });

  it('returns null when nothing set', () => {
    const orig = process.env.AI_API_KEY;
    delete process.env.AI_API_KEY;
    expect(resolveApiKey(null, {})).toBeNull();
    if (orig !== undefined) process.env.AI_API_KEY = orig;
  });
});

describe('isFalse', () => {
  it('returns true for false', () => expect(isFalse(false)).toBe(true));
  it('returns false for true', () => expect(isFalse(true)).toBe(false));
  it('returns false for null', () => expect(isFalse(null)).toBe(false));
  it('returns false for string', () => expect(isFalse('false')).toBe(false));
});

describe('isEmptyArray', () => {
  it('returns true for empty array', () => expect(isEmptyArray([])).toBe(true));
  it('returns false for non-empty array', () => expect(isEmptyArray([1])).toBe(false));
  it('returns false for non-array', () => expect(isEmptyArray('')).toBe(false));
  it('returns false for null', () => expect(isEmptyArray(null)).toBe(false));
});

describe('isNoneOr', () => {
  it('returns true for null', () => expect(isNoneOr(null, () => true)).toBe(true));
  it('returns true for undefined', () => expect(isNoneOr(undefined, () => true)).toBe(true));
  it('returns false when check fails', () => expect(isNoneOr(0, v => v > 0)).toBe(false));
  it('returns true when check passes', () => expect(isNoneOr(5, v => v > 0)).toBe(true));
});

describe('buildModelRegistry', () => {
  it('registers models from providers', () => {
    const config = {
      providers: [
        {
          name: 'openai',
          models: [{ name: 'gpt-4', temperature: 0.7 }],
        },
      ],
    };
    const registry = buildModelRegistry(config);
    expect(registry['openai/gpt-4']).toEqual({
      name: 'openai/gpt-4',
      temperature: 0.7,
      maxTokens: 32000,
    });
  });

  it('uses default max tokens when not specified', () => {
    const config = {
      providers: [{ name: 'test', models: [{ name: 'model' }] }],
    };
    const registry = buildModelRegistry(config);
    expect(registry['test/model'].maxTokens).toBe(32000);
  });

  it('handles provider-level default model', () => {
    const config = {
      providers: [{ name: 'test', defaultModel: 'gpt-3.5', temperature: 0.5 }],
    };
    const registry = buildModelRegistry(config);
    expect(registry['test/gpt-3.5']).toEqual({
      name: 'test/gpt-3.5',
      temperature: 0.5,
      maxTokens: 32000,
    });
  });

  it('handles empty providers', () => {
    expect(buildModelRegistry({})).toEqual({});
  });

  it('handles multiple providers', () => {
    const config = {
      providers: [
        { name: 'a', models: [{ name: 'm1' }] },
        { name: 'b', models: [{ name: 'm2' }] },
      ],
    };
    const registry = buildModelRegistry(config);
    expect(registry['a/m1']).toBeDefined();
    expect(registry['b/m2']).toBeDefined();
  });
});
