import { describe, it, expect } from 'bun:test';
import { render } from '../../src/utils/render.ts';

describe('render', () => {
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

  it('renders for loops with nested context', () => {
    expect(render('{% for item in items %}{{ item }}{% endfor %}', { items: ['a', 'b', 'c'] })).toBe('abc');
    expect(render('{% for user in users %}{{ user.name }}{% endfor %}', {
      users: [{ name: 'Alice' }, { name: 'Bob' }],
    })).toBe('AliceBob');
  });

  it('handles empty/missing arrays in for loops', () => {
    expect(render('{% for item in items %}{{ item }}{% endfor %}', { items: [] })).toBe('');
    expect(render('{% for item in items %}{{ item }}{% endfor %}', {})).toBe('');
  });

  it('handles conditionals and negation', () => {
    expect(render('{% if flag %}yes{% endif %}', { flag: true })).toBe('yes');
    expect(render('{% if flag %}yes{% endif %}', { flag: false })).toBe('');
    expect(render('{% if not items %}empty{% endif %}', { items: null })).toBe('empty');
    expect(render('{% if a %}{% if b %}both{% endif %}{% endif %}', { a: true, b: true })).toBe('both');
    expect(render('{% if a %}{% if b %}both{% endif %}{% endif %}', { a: true, b: false })).toBe('');
  });

  it('applies default and trim filters', () => {
    expect(render('{{ name|default("World") }}', { name: '' })).toBe('World');
    expect(render('{{ name|default("Fallback") }}', { name: 'Hello' })).toBe('Hello');
    expect(render('{{ name|trim }}', { name: '  hello  ' })).toBe('hello');
  });

  it('strips comments', () => {
    expect(render('hello{# comment #}world', {})).toBe('helloworld');
  });

  it('throws on unclosed delimiters', () => {
    expect(() => render('{{ broken', {})).toThrow();
    expect(() => render('{% if true', {})).toThrow();
  });

  it('handles empty template and null context', () => {
    expect(render('', {})).toBe('');
    expect(render('static text', null)).toBe('static text');
  });
});

describe('whitespace control (Tera-style dashes)', () => {
  it('right dash on print strips leading whitespace after the token', () => {
    expect(render('a {{ x -}} b', { x: 1 })).toBe('a 1b');
    expect(render('a {{ x-}} b', { x: 1 })).toBe('a 1b');
    expect(render('a {{ x }} b', { x: 1 })).toBe('a 1 b'); // no dash: untouched
  });

  it('left dash on print strips trailing whitespace before the token', () => {
    expect(render('a  {{- x }}b', { x: 1 })).toBe('a1b');
    expect(render('a\n\n\t{{- x }}b', { x: 'X' })).toBe('aXb');
    expect(render('a  {{ x }}b', { x: 1 })).toBe('a  1b'); // no dash: untouched
  });

  it('applies both dashes on a print token', () => {
    expect(render('a  {{- x -}}  b', { x: 1 })).toBe('a1b');
  });

  it('does not treat dashes inside string literals as control dashes', () => {
    expect(render('{{ "a - b" }}', {})).toBe('a - b');
    expect(render('{{ "a-" -}}b', {})).toBe('a-b');
    expect(render('a{{- "x-" }}', {})).toBe('ax-');
  });

  it('right dash on tag strips leading whitespace of the body', () => {
    expect(render('{% if f -%}  yes{% endif %}', { f: true })).toBe('yes');
    expect(render('{% if f - %}  yes{% endif %}', { f: true })).toBe('yes'); // dash + space before %}
    expect(render('{% if f %}  yes{% endif %}', { f: true })).toBe('  yes'); // no dash: untouched
  });

  it('left dash on tag strips trailing whitespace before the tag', () => {
    expect(render('pre  {%- if f %}yes{% endif %}', { f: true })).toBe('preyes');
    expect(render('pre text  {%- if f %}yes{% endif %}', { f: true })).toBe('pre textyes');
    expect(render('pre  {% if f %}yes{% endif %}', { f: true })).toBe('pre  yes'); // no dash: untouched
  });

  it('left dash on closing tag strips trailing whitespace inside the body', () => {
    expect(render('{% if f %}yes  {%- endif %} after', { f: true })).toBe('yes after');
    expect(render('{% if f %}yes  {% endif %} after', { f: true })).toBe('yes   after');
  });

  it('strips both sides of an if block', () => {
    expect(render('A {%- if f -%}  yes  {%- endif %} B', { f: true })).toBe('Ayes B');
    expect(render('A {%- if f -%}  yes  {%- endif %} B', { f: false })).toBe('A B');
  });

  it('supports dashes on the else tag', () => {
    expect(render('{% if a -%}yes{% else -%}no{% endif %}', { a: true })).toBe('yes');
    expect(render('{% if a -%}yes{% else -%}no{% endif %}', { a: false })).toBe('no');
  });

  it('right dash on for strips leading whitespace of the loop body', () => {
    expect(render('{% for i in xs -%}{{ i }}\n{% endfor %}', { xs: [1, 2] })).toBe('1\n2\n');
    expect(render('{% for i in xs %}{{ i }}\n{% endfor %}', { xs: [1, 2] })).toBe('1\n2\n');
  });

  it('left dash on endfor strips trailing whitespace of the loop body', () => {
    expect(render('{% for i in xs -%}\n{{ i }}\n{%- endfor %}', { xs: [1, 2] })).toBe('12');
    expect(render('{% for i in xs -%}\n{{ i }}\n{% endfor %}', { xs: [1, 2] })).toBe('1\n2\n');
  });

  it('left dash works between a tag and a print', () => {
    expect(render('{% if f %}a{{- b }}{% endif %}', { f: true, b: 'B' })).toBe('aB');
  });

  it('renders the system prompt template layout', () => {
    const template = [
      '{{ role }}',
      '{%- if body %}',
      '{{ body }}',
      '{%- endif %}',
      'Parallel tool calling enabled.',
      '',
      '{% for chunk in chunks -%}',
      '{{ chunk.content }}',
      '{%- endfor -%}',
      '',
    ].join('\n');
    const chunks = [
      { content: '\n# One\n' },
      { content: '\n# Two\n' },
    ];
    expect(render(template, { role: 'R', body: 'B', chunks })).toBe(
      'R\nB\nParallel tool calling enabled.\n\n\n# One\n\n# Two\n',
    );
    // empty body: the if block collapses without leaving blank lines behind
    expect(render(template, { role: 'R', body: '', chunks })).toBe(
      'R\nParallel tool calling enabled.\n\n\n# One\n\n# Two\n',
    );
  });
});

describe('render edge cases', () => {
  it('handles else branch in conditionals', () => {
    expect(render('{% if flag %}yes{% else %}no{% endif %}', { flag: true })).toBe('yes');
    expect(render('{% if flag %}yes{% else %}no{% endif %}', { flag: false })).toBe('no');
  });

  it('applies length filter', () => {
    expect(render('{{ name|length }}', { name: 'hello' })).toBe('5');
    expect(render('{{ name|length }}', { name: '' })).toBe('0');
  });

  it('handles string literals', () => {
    expect(render("{{ 'hello' }}", {})).toBe('hello');
    expect(render('{{ "world" }}', {})).toBe('world');
  });

  it('handles length > 0 filter in conditionals', () => {
    expect(render('{% if items|length > 0 %}has{% endif %}', { items: [1] })).toBe('has');
    expect(render('{% if items|length > 0 %}has{% endif %}', { items: [] })).toBe('');
  });
});
