import { describe, it, expect } from 'bun:test';
import { Message, ImageAttachment } from '../../src/core/context/message.ts';

type ContentPart = { type: string; text?: string; image_url?: { url: string } };

describe('Message', () => {
  it('creates a message with all fields', () => {
    const msg = new Message({
      role: 'assistant',
      content: 'Hello',
      reasoningContent: 'Thinking',
      toolCalls: [{ id: '1' }],
      toolCallId: '1',
    });
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello');
    expect(msg.reasoningContent).toBe('Thinking');
    expect(msg.toolCalls).toEqual([{ id: '1' }]);
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
      toolCalls: [{ id: '1' }],
      toolCallId: '1',
    });
    const json = msg.toJSON();
    expect(json).toEqual({
      role: 'assistant',
      content: 'Hi',
      reasoning_content: 'Thoughts',
      tool_calls: [{ id: '1' }],
      tool_call_id: '1',
    });
  });

  it('serializes minimal message', () => {
    const msg = new Message({ role: 'user', content: 'Hi' });
    const json = msg.toJSON();
    expect(json).toEqual({ role: 'user', content: 'Hi' });
  });

  it('omits null fields from JSON', () => {
    const msg = new Message({ role: 'user', content: 'Hi' });
    const json = msg.toJSON();
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
      tool_calls: [{ id: '1' }],
      tool_call_id: 'tc1',
    });
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello');
    expect(msg.reasoningContent).toBe('Thinking');
    expect(msg.toolCalls).toEqual([{ id: '1' }]);
    expect(msg.toolCallId).toBe('tc1');
  });

  it('handles camelCase input as fallback', () => {
    const msg = Message.fromJSON({
      role: 'user',
      content: 'Hi',
      reasoningContent: 'Thoughts',
      toolCalls: [{ id: '2' }],
      toolCallId: 'tc2',
    });
    expect(msg.role).toBe('user');
    expect(msg.reasoningContent).toBe('Thoughts');
    expect(msg.toolCalls).toEqual([{ id: '2' }]);
    expect(msg.toolCallId).toBe('tc2');
  });

  it('prefers snake_case when both are present', () => {
    const msg = Message.fromJSON({
      role: 'assistant',
      content: 'Hi',
      reasoning_content: 'snake',
      reasoningContent: 'camel',
      tool_calls: [{ id: 'snake' }],
      toolCalls: [{ id: 'camel' }],
      tool_call_id: 'snake_id',
      toolCallId: 'camel_id',
    });
    expect(msg.reasoningContent).toBe('snake');
    expect(msg.toolCalls).toEqual([{ id: 'snake' }]);
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
    expect(msg.images![0].mimeType).toBe('image/png');
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
});

describe('Message — images', () => {
  it('returns array content with text + image parts', () => {
    const msg = new Message({
      role: 'user',
      content: 'What is in this image?',
      images: [{ type: 'image_url', mimeType: 'image/png', data: 'abc123' }],
    });
    const json = msg.toJSON();
    const content = json.content as ContentPart[];

    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([
      { type: 'text', text: 'What is in this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ]);
    expect(json.images).toEqual([{ type: 'image_url', mimeType: 'image/png', data: 'abc123' }]);
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
    const content = msg.toJSON().content as ContentPart[];
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
    const content = msg.toJSON().content as ContentPart[];
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
    const content = msg.toJSON().content as ContentPart[];
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
    const content = msg.toJSON().content as ContentPart[];
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
    const content = msg.toJSON().content as ContentPart[];
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
