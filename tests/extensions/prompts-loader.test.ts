import { describe, it, expect } from 'bun:test';
import { parsePromptFromMd, PromptsLoader } from '../../src/extensions/prompts/loader.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

describe("PromptsLoader", () => {
  it("loadFromDirectory handles directory with valid prompts", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-prompt-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'greet.prompt.md'), `---\ndescription: Greeting prompt\n---\nHello world`);
      const loader = new PromptsLoader(tmpDir);
      await (loader as any).loadFromDirectory(tmpDir);
      const prompts = loader.allPrompts();
      expect(prompts.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadFromDirectory handles invalid frontmatter gracefully", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-prompt-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'bad.prompt.md'), 'No frontmatter here');
      const loader = new PromptsLoader(tmpDir);
      await (loader as any).loadFromDirectory(tmpDir);
      // Should not throw — just log warning
      expect(true).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadFromDirectory handles duplicate prompt names with warning", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-prompt-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'dup.prompt.md'), `---\ndescription: First\n---\nContent 1`);
      fs.mkdirSync(path.join(tmpDir, 'sub'));
      fs.writeFileSync(path.join(tmpDir, 'sub', 'dup.prompt.md'), `---\ndescription: Second\n---\nContent 2`);
      const loader = new PromptsLoader(tmpDir + ":" + path.join(tmpDir, 'sub'));
      await loader.loadPrompts();
      const prompts = loader.allPrompts();
      expect(prompts.length).toBe(1); // Duplicate overwritten (last wins)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadFromDirectory handles read errors gracefully", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-prompt-test-'));
    try {
      // Create a directory that looks like a prompt file
      fs.mkdirSync(path.join(tmpDir, 'not-a-file.prompt.md'));
      const loader = new PromptsLoader(tmpDir);
      await (loader as any).loadFromDirectory(tmpDir);
      // Should not throw — just log warning
      expect(true).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
