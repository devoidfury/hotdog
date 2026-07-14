import { describe, it, expect } from 'bun:test';
import { render, compile } from '../../src/utils/render.ts';

describe('render - interpolation', () => {
  it('renders variable interpolation', () => {
    expect(render('Hello {{ name }}!', { name: 'World' })).toBe('Hello World!');
    expect(render('{{ a }}{{ b }}{{ c }}', { a: '1', b: '2', c: '3' })).toBe('123');
  });

  it('handles deep nested paths and missing values', () => {
    expect(render('{{ a.b.c.d }}', { a: { b: { c: { d: 'deep' } } } })).toBe('deep');
    expect(render('{{ a.b.c.d }}', { a: { b: null } })).toBe('');
    expect(render('{{ missing }}', {})).toBe('');
    expect(render('{{ value }}', { value: 0 })).toBe('0');
    expect(render('{{ value }}', { value: false })).toBe('false');
  });
});

describe('render - for loops', () => {
  it('renders for loops with nested context', () => {
    expect(render('{% for item in items %}{{ item }}{% endfor %}', { items: ['a', 'b', 'c'] })).toBe('abc');
    const result = render('{% for user in users %}{{ user.name }}{% endfor %}', {
      users: [{ name: 'Alice' }, { name: 'Bob' }],
    });
    expect(result).toBe('AliceBob');
  });

  it('handles empty/missing arrays', () => {
    expect(render('{% for item in items %}{{ item }}{% endfor %}', { items: [] })).toBe('');
    expect(render('{% for item in items %}{{ item }}{% endfor %}', {})).toBe('');
  });
});

describe('render - conditionals', () => {
  it('handles if/endif and negation', () => {
    expect(render('{% if flag %}yes{% endif %}', { flag: true })).toBe('yes');
    expect(render('{% if flag %}yes{% endif %}', { flag: false })).toBe('');
    expect(render('{% if not items %}empty{% endif %}', { items: null })).toBe('empty');
  });

  it('handles deeply nested conditionals', () => {
    expect(render('{% if a %}{% if b %}both{% endif %}{% endif %}', { a: true, b: true })).toBe('both');
    expect(render('{% if a %}{% if b %}both{% endif %}{% endif %}', { a: true, b: false })).toBe('');
  });
});

describe('render - filters and comments', () => {
  it('applies default and trim filters', () => {
    expect(render('{{ name|default("World") }}', { name: '' })).toBe('World');
    expect(render('{{ name|default("Fallback") }}', { name: 'Hello' })).toBe('Hello');
    expect(render('{{ name|trim }}', { name: '  hello  ' })).toBe('hello');
  });

  it('strips comments', () => {
    expect(render('hello{# comment #}world', {})).toBe('helloworld');
  });
});

describe('render - error handling and edge cases', () => {
  it('throws on unclosed delimiters', () => {
    expect(() => render('{{ broken', {})).toThrow();
    expect(() => render('{% if true', {})).toThrow();
  });

  it('handles empty template and null context', () => {
    expect(render('', {})).toBe('');
    expect(render('static text', null)).toBe('static text');
  });
});

describe('compile', () => {
  it('returns a reusable render function', () => {
    const fn = compile('Hello {{ name }}');
    expect(typeof fn).toBe('function');
    expect(fn({ name: 'World' })).toBe('Hello World');
  });

  it('renders plain text without tokens', () => {
    expect(compile('Hello World!')({})).toBe('Hello World!');
  });
});
