import { describe, it, expect } from 'bun:test';
import { Message, contentToText, ImageAttachment } from '../../src/core/context/message.ts';

type ContentPart = { type: string; text?: string; image_url?: { url: string } };

describe('Message', () => {
  it('creates a message with all fields', () => {
    const msg = new Message({
      role: 'assistant',
      content: 'Hello',
      reasoningContent: 'Thinking',
      toolCalls: [{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }],
      toolCallId: '1',
    });
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello');
    expect(msg.reasoningContent).toBe('Thinking');
    expect(msg.toolCalls).toEqual([{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }]);
    expect(msg.toolCallId).toBe('1');
  });

  it('creates a minimal message', () => {
    const msg = new Message({ role: 'user', content: 'Hi' });
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hi');
    expect(msg.reasoningContent).toBeNull();
    expect(msg.toolCalls).toBeNull();
    expect(msg.toolCallId).toBeNull();
  });

  it('defaults to empty object', () => {
    const msg = new Message();
    expect(msg.role).toBeUndefined();
    expect(msg.content).toBeUndefined();
  });
});

describe('Message.toJSON', () => {
  it('serializes to JSON with all fields', () => {
    const msg = new Message({
      role: 'assistant',
      content: 'Hi',
      reasoningContent: 'Thoughts',
      toolCalls: [{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }],
      toolCallId: '1',
    });
    const json = msg.toJSON();
    expect(json).toEqual({
      role: 'assistant',
      content: 'Hi',
      reasoning_content: 'Thoughts',
      tool_calls: [{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }],
      tool_call_id: '1',
    });
  });

  it('serializes minimal message and omits null fields', () => {
    const msg = new Message({ role: 'user', content: 'Hi' });
    const json = msg.toJSON();
    expect(json).toEqual({ role: 'user', content: 'Hi' });
    expect(json).not.toHaveProperty('reasoning_content');
    expect(json).not.toHaveProperty('tool_calls');
    expect(json).not.toHaveProperty('tool_call_id');
  });


  it('handles null content in JSON serialization', () => {
    const msg = new Message({ role: 'user', content: null });
    const json = msg.toJSON();
    expect(
      json.content === '' || json.content === undefined || json.content === null
    ).toBe(true);
  });
});

describe('Message.fromJSON', () => {
  it('deserializes from snake_case JSON', () => {
    const msg = Message.fromJSON({
      role: 'assistant',
      content: 'Hello',
      reasoning_content: 'Thinking',
      tool_calls: [{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }],
      tool_call_id: 'tc1',
    });
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello');
    expect(msg.reasoningContent).toBe('Thinking');
    expect(msg.toolCalls).toEqual([{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }]);
    expect(msg.toolCallId).toBe('tc1');
  });

  it('handles camelCase input as fallback', () => {
    const msg = Message.fromJSON({
      role: 'user',
      content: 'Hi',
      reasoningContent: 'Thoughts',
      toolCalls: [{ id: '2', type: 'function', function: { name: 'test', arguments: '{}' } }],
      toolCallId: 'tc2',
    });
    expect(msg.role).toBe('user');
    expect(msg.reasoningContent).toBe('Thoughts');
    expect(msg.toolCalls).toEqual([{ id: '2', type: 'function', function: { name: 'test', arguments: '{}' } }]);
    expect(msg.toolCallId).toBe('tc2');
  });

  it('prefers snake_case when both are present', () => {
    const msg = Message.fromJSON({
      role: 'assistant',
      content: 'Hi',
      reasoning_content: 'snake',
      reasoningContent: 'camel',
      tool_calls: [{ id: 'snake', type: 'function', function: { name: 'test', arguments: '{}' } }],
      toolCalls: [{ id: 'camel', type: 'function', function: { name: 'test', arguments: '{}' } }],
      tool_call_id: 'snake_id',
      toolCallId: 'camel_id',
    });
    expect(msg.reasoningContent).toBe('snake');
    expect(msg.toolCalls).toEqual([{ id: 'snake', type: 'function', function: { name: 'test', arguments: '{}' } }]);
    expect(msg.toolCallId).toBe('snake_id');
  });

  it('handles minimal or empty JSON', () => {
    const msg1 = Message.fromJSON({ role: 'user', content: 'Hi' });
    expect(msg1.role).toBe('user');
    expect(msg1.reasoningContent).toBeNull();

    const msg2 = Message.fromJSON({});
    expect(msg2.role).toBeUndefined();
  });

  it('handles images in JSON', () => {
    const msg = Message.fromJSON({
      role: 'user',
      content: 'Look at this',
      images: [{ type: 'image_url', mimeType: 'image/png', data: 'abc123' }],
    });
    expect(msg.images).toHaveLength(1);
    expect(msg.images![0]!.mimeType).toBe('image/png');
  });
});

describe('Message — source provenance', () => {
  it('stores source when provided', () => {
    for (const source of ['user', 'harness', 'model', 'system', 'tool'] as const) {
      const msg = new Message({ role: 'user', content: 'hi', source });
      expect(msg.source).toBe(source);
    }
  });

  it('defaults source to undefined', () => {
    expect(new Message({ role: 'user', content: 'hi' }).source).toBeUndefined();
  });

  it('toJSON omits source when undefined', () => {
    const json = new Message({ role: 'user', content: 'hi' }).toJSON();
    expect(json).not.toHaveProperty('source');
  });

  it('toJSON includes source when defined', () => {
    const json = new Message({ role: 'user', content: 'hi', source: 'harness' }).toJSON();
    expect(json).toEqual({ role: 'user', content: 'hi', source: 'harness' });
  });

  it('fromJSON round-trips source', () => {
    for (const source of ['user', 'harness', 'model', 'system', 'tool'] as const) {
      const msg = new Message({ role: 'user', content: 'hi', source });
      const restored = Message.fromJSON(msg.toJSON());
      expect(restored.source).toBe(source);
      expect(restored.toJSON()).toEqual(msg.toJSON());
    }
  });

  it('fromJSON drops unknown or invalid source values', () => {
    expect(Message.fromJSON({ role: 'user', content: 'hi', source: 'admin' }).source).toBeUndefined();
    expect(Message.fromJSON({ role: 'user', content: 'hi', source: 42 }).source).toBeUndefined();
    expect(Message.fromJSON({ role: 'user', content: 'hi', source: null }).source).toBeUndefined();
  });
});

describe('Message.getTextContent', () => {
  it('returns content string for plain text messages', () => {
    expect(new Message({ role: 'user', content: 'Hello world' }).getTextContent()).toBe('Hello world');
  });

  it('returns empty string for null/undefined content', () => {
    expect(new Message({ role: 'user', content: null }).getTextContent()).toBe('');
    expect(new Message({ role: 'user' }).getTextContent()).toBe('');
  });

  it('extracts text from array content parts', () => {
    const msg = new Message({
      role: 'user',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        { type: 'text', text: 'World' },
      ],
    });
    expect(msg.getTextContent()).toBe('Hello\nWorld');
  });

  it('handles array with only image or text parts', () => {
    expect(new Message({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }],
    }).getTextContent()).toBe('');

    expect(new Message({
      role: 'user',
      content: [
        { type: 'text', text: 'Line 1' },
        { type: 'text', text: 'Line 2' },
      ],
    }).getTextContent()).toBe('Line 1\nLine 2');
  });

  it('handles empty array content', () => {
    expect(new Message({ role: 'user', content: [] }).getTextContent()).toBe('');
  });

  it('includes untrusted parts (raw) in the text form', () => {
    const msg = new Message({
      role: 'harness',
      source: 'harness',
      content: [
        { type: 'text', text: '<previous-context-summary>' },
        { type: 'untrusted', text: 'raw model output' },
        { type: 'text', text: '</previous-context-summary>' },
      ],
    });
    expect(msg.getTextContent()).toBe('<previous-context-summary>\nraw model output\n</previous-context-summary>');
  });
});

describe('contentToText', () => {
  it('passes strings through; null/undefined become empty', () => {
    expect(contentToText('plain')).toBe('plain');
    expect(contentToText('')).toBe('');
    expect(contentToText(null)).toBe('');
    expect(contentToText(undefined)).toBe('');
  });

  it('flattens text and untrusted parts, drops images', () => {
    expect(
      contentToText([
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        { type: 'untrusted', text: 'b' },
      ]),
    ).toBe('a\nb');
  });
});

describe('Message — images', () => {
  // Contract: toJSON() stores content RAW; images ride the separate `images`
  // field; _buildContent() is the only place images merge into content parts.

  it('keeps raw content in toJSON and merges images in _buildContent', () => {
    const msg = new Message({
      role: 'user',
      content: 'What is in this image?',
      images: [{ type: 'image_url', mimeType: 'image/png', data: 'abc123' }],
    });
    const json = msg.toJSON();
    expect(json.content).toBe('What is in this image?');
    expect(json.images).toEqual([{ type: 'image_url', mimeType: 'image/png', data: 'abc123' }]);

    const content = msg._buildContent() as ContentPart[];
    expect(content).toEqual([
      { type: 'text', text: 'What is in this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ]);
  });

  it('handles multiple images', () => {
    const msg = new Message({
      role: 'user',
      content: 'Compare these images',
      images: [
        { type: 'image_url', mimeType: 'image/png', data: 'img1' },
        { type: 'image_url', mimeType: 'image/jpeg', data: 'img2' },
        { type: 'image_url', mimeType: 'image/webp', data: 'img3' },
      ],
    });
    expect(msg.toJSON().content).toBe('Compare these images');
    const content = msg._buildContent() as ContentPart[];
    expect(content.length).toBe(4); // 1 text + 3 images
    expect(content[0]).toEqual({ type: 'text', text: 'Compare these images' });
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,img1' } });
    expect(content[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,img2' } });
    expect(content[3]).toEqual({ type: 'image_url', image_url: { url: 'data:image/webp;base64,img3' } });
  });

  it('preserves existing data: URIs', () => {
    const msg = new Message({
      role: 'user',
      content: 'Look at this',
      images: [{ type: 'image_url', mimeType: 'image/png', data: 'data:image/png;base64,alreadyencoded' }],
    });
    const content = msg._buildContent() as ContentPart[];
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,alreadyencoded' },
    });
  });

  it('handles images without text content', () => {
    const msg = new Message({
      role: 'user',
      content: null,
      images: [{ type: 'image_url', mimeType: 'image/png', data: 'img' }],
    });
    expect(msg.toJSON().content).toBe('');
    const content = msg._buildContent() as ContentPart[];
    expect(content.length).toBe(1);
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,img' } });
  });

  it('handles array content with images appended', () => {
    const msg = new Message({
      role: 'user',
      content: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
      images: [{ type: 'image_url', mimeType: 'image/png', data: 'img' }],
    });
    expect(msg.toJSON().content).toEqual([
      { type: 'text', text: 'Part 1' },
      { type: 'text', text: 'Part 2' },
    ]);
    const content = msg._buildContent() as ContentPart[];
    expect(content.length).toBe(3);
    expect(content[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,img' } });
  });

  it('omits images in toJSON when absent or empty', () => {
    expect(new Message({ role: 'user', content: 'Hello' }).toJSON().images).toBeUndefined();
    expect(new Message({ role: 'user', content: 'Hello', images: [] }).toJSON().images).toBeUndefined();
  });

  it('defaults mimeType to image/png', () => {
    const msg = new Message({
      role: 'user',
      content: 'Look',
      images: [{ type: 'image_url', mimeType: '', data: 'data' }],
    });
    const content = msg._buildContent() as ContentPart[];
    expect(content[1]!.image_url!.url).toContain('image/png');
  });

  it('preserves other fields alongside images', () => {
    const msg = new Message({
      role: 'assistant',
      content: 'Response',
      reasoningContent: 'Thinking...',
      toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'test', arguments: '{}' } }],
      images: [{ type: 'image_url', mimeType: 'image/png', data: 'img' }],
    });
    const json = msg.toJSON();
    expect(json.role).toBe('assistant');
    expect(json.reasoning_content).toBe('Thinking...');
    expect(json.tool_calls).toBeDefined();
    expect(json.images).toEqual([{ type: 'image_url', mimeType: 'image/png', data: 'img' }]);
  });
});

describe('Message — image round-trip (regression)', () => {
  const image: ImageAttachment = { type: 'image_url', mimeType: 'image/png', data: 'abc123' };

  it('toJSON -> fromJSON -> toJSON is idempotent for messages with images', () => {
    const m1 = new Message({ role: 'user', content: 'Look at this', images: [image] });
    const m2 = Message.fromJSON(m1.toJSON());
    const m3 = Message.fromJSON(m2.toJSON());
    expect(m2.toJSON()).toEqual(m1.toJSON());
    expect(m3.toJSON()).toEqual(m1.toJSON());
  });

  it('restored message emits exactly one image part per image on the wire', () => {
    const m1 = new Message({ role: 'user', content: 'Look at this', images: [image] });
    const restored = Message.fromJSON(m1.toJSON());
    const parts = restored._buildContent() as ContentPart[];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(1);
  });

  it('fromJSON heals legacy JSON that inlined image parts into content', () => {
    // Pre-fix toJSON() stored image parts in content AND in the images
    // array; restoring such persisted data must not re-inline them.
    const legacy = {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
      ],
      images: [image],
    };
    const m = Message.fromJSON(legacy);
    expect(m.images).toHaveLength(1);
    const parts = m._buildContent() as ContentPart[];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(1);
    expect(parts.filter((p) => p.type === 'text')).toHaveLength(1);
  });

  it('heal keeps content image parts whose URL does not match any image', () => {
    const m = Message.fromJSON({
      role: 'user',
      content: [
        { type: 'text', text: 'Look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } }, // matches images -> dropped
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,other' } }, // not in images -> kept
      ],
      images: [image],
    });
    const parts = m._buildContent() as ContentPart[];
    const urls = parts.filter((p) => p.type === 'image_url').map((p) => p.image_url!.url);
    expect(urls).toEqual(['data:image/jpeg;base64,other', 'data:image/png;base64,abc123']);
  });

  it('fromJSON ignores a malformed (non-array) images field', () => {
    const m = Message.fromJSON({
      role: 'user',
      content: 'hi',
      images: { not: 'an array' },
    });
    expect(m.images).toBeUndefined();
    expect(m.toJSON().content).toBe('hi');
    expect(m._buildContent()).toBe('hi');
  });

  it('fromJSON keeps content image parts when no images field is present', () => {
    const m = Message.fromJSON({
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
    });
    const parts = m._buildContent() as ContentPart[];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(1);
  });
});
