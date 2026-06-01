import { describe, it, expect } from 'bun:test';
import { parsePromptFromMd } from '../../src/extensions/prompts/loader.js';

describe('parsePromptFromMd', () => {
  it('parses a valid prompt file', () => {
    const content = `---
description: A test prompt
---
Body content here`;
    const prompt = parsePromptFromMd(content, 'test.prompt.md', '/path/to/test.prompt.md');
    expect(prompt.name).toBe('test');
    expect(prompt.description).toBe('A test prompt');
    expect(prompt.content).toBe('Body content here');
    expect(prompt.location).toBe('/path/to/test.prompt.md');
    expect(prompt.disableModelInvocation).toBe(false);
  });

  it('uses explicit name from front matter', () => {
    const content = `---
name: my-prompt
description: A prompt
---
Body`;
    const prompt = parsePromptFromMd(content, 'test.prompt.md', '/path');
    expect(prompt.name).toBe('my-prompt');
  });

  it('parses disable-model-invocation flag', () => {
    const content = `---
description: A prompt
disable-model-invocation: true
---
Body`;
    const prompt = parsePromptFromMd(content, 'test.prompt.md', '/path');
    expect(prompt.disableModelInvocation).toBe(true);
  });

  it('parses disable_model_invocation with underscore', () => {
    const content = `---
description: A prompt
disable_model_invocation: true
---
Body`;
    const prompt = parsePromptFromMd(content, 'test.prompt.md', '/path');
    expect(prompt.disableModelInvocation).toBe(true);
  });

  it('throws when no front matter', () => {
    expect(() => parsePromptFromMd('just text', 'test.prompt.md', '/path')).toThrow('No YAML frontmatter');
  });

  it('throws when description is missing', () => {
    const content = `---
name: test
---
Body`;
    expect(() => parsePromptFromMd(content, 'test.prompt.md', '/path')).toThrow('description');
  });

  it('throws when description is empty', () => {
    const content = `---
description: 
---
Body`;
    expect(() => parsePromptFromMd(content, 'test.prompt.md', '/path')).toThrow('description');
  });

  it('preserves leading newline in body', () => {
    const content = `---
description: test
---

Body`;
    const prompt = parsePromptFromMd(content, 'test.prompt.md', '/path');
    expect(prompt.content).toBe('\nBody');
  });
});
