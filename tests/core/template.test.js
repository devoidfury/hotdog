import { describe, it, expect } from 'bun:test';
import { compile } from '../../src/core/context/render.js';

describe('compile - plain text', () => {
  it('returns a render function', () => {
    const render = compile('hello');
    expect(typeof render).toBe('function');
  });

  it('renders plain text without tokens', () => {
    const render = compile('Hello World!');
    expect(render({})).toBe('Hello World!');
  });

  it('renders empty template', () => {
    const render = compile('');
    expect(render({})).toBe('');
  });

  it('renders template with no special tokens', () => {
    const render = compile('Line 1\nLine 2\tTab');
    expect(render({})).toBe('Line 1\nLine 2\tTab');
  });
});

describe('compile - interpolation', () => {
  it('interpolates simple variable', () => {
    const render = compile('Hello {{ name }}!');
    expect(render({ name: 'World' })).toBe('Hello World!');
  });

  it('handles missing variable', () => {
    const render = compile('Hello {{ name }}!');
    expect(render({})).toBe('Hello !');
  });

  it('handles null variable', () => {
    const render = compile('{{ val }}');
    expect(render({ val: null })).toBe('');
  });

  it('interpolates nested path', () => {
    const render = compile('{{ user.name }}');
    expect(render({ user: { name: 'Alice' } })).toBe('Alice');
  });

  it('handles multiple interpolations', () => {
    const render = compile('{{ a }} + {{ b }}');
    expect(render({ a: '1', b: '2' })).toBe('1 + 2');
  });

  it('applies length filter', () => {
    const render = compile('{{ items|length }}');
    expect(render({ items: ['a', 'b', 'c'] })).toBe('3');
  });

  it('applies trim filter', () => {
    const render = compile('{{ name|trim }}');
    expect(render({ name: '  hello  ' })).toBe('hello');
  });
});

describe('compile - conditionals', () => {
  it('keeps content when true', () => {
    const render = compile('Hello {% if show %}World{% endif %}!');
    expect(render({ show: true })).toBe('Hello World!');
  });

  it('removes content when false', () => {
    const render = compile('Hello {% if show %}World{% endif %}!');
    expect(render({ show: false })).toBe('Hello !');
  });

  it('removes content for empty string', () => {
    const render = compile('Hello {% if show %}World{% endif %}!');
    expect(render({ show: '' })).toBe('Hello !');
  });

  it('keeps content for non-empty string', () => {
    const render = compile('Hello {% if name %}{{ name }}{% endif %}!');
    expect(render({ name: 'Alice' })).toBe('Hello Alice!');
  });

  it('supports negation with !', () => {
    const render = compile('Hello {% if !hidden %}World{% endif %}!');
    expect(render({ hidden: false })).toBe('Hello World!');
  });

  it('supports negation with not', () => {
    const render = compile('Hello {% if not hidden %}World{% endif %}!');
    expect(render({ hidden: false })).toBe('Hello World!');
  });

  it('handles nested ifs', () => {
    const render = compile('{% if a %}{% if b %}AB{% endif %}{% endif %}');
    expect(render({ a: true, b: true })).toBe('AB');
  });

  it('handles nested ifs false', () => {
    const render = compile('{% if a %}{% if b %}AB{% endif %}{% endif %}');
    expect(render({ a: true, b: false })).toBe('');
  });
});
