import { describe, it, expect } from 'bun:test';
import { validateNameable, deepMerge } from '../../src/lib.js';

// Helper to check if any warning contains a substring
const hasWarning = (warnings, substring) => warnings.some(w => w.includes(substring));

describe('validateNameable', () => {
  it('returns no warnings for valid name matching dir', () => {
    const warnings = validateNameable('my-tool', 'Tool', 'my-tool');
    expect(warnings).toEqual([]);
  });

  it('returns warning when name does not match dir', () => {
    const warnings = validateNameable('my-tool', 'Tool', 'different');
    expect(hasWarning(warnings, 'does not match')).toBe(true);
  });

  it('returns warning for empty name', () => {
    const warnings = validateNameable('', 'Tool', 'my-tool');
    expect(hasWarning(warnings, 'name is empty')).toBe(true);
  });

  it('returns warning for null name', () => {
    const warnings = validateNameable(null, 'Tool', 'my-tool');
    expect(hasWarning(warnings, 'name is empty')).toBe(true);
  });

  it('returns warning for name exceeding 64 chars', () => {
    const longName = 'a'.repeat(65);
    const warnings = validateNameable(longName, 'Tool', longName);
    expect(hasWarning(warnings, 'exceeds 64 characters')).toBe(true);
  });

  it('returns no warning for exactly 64 char name', () => {
    const name = 'a'.repeat(64);
    const warnings = validateNameable(name, 'Tool', name);
    expect(warnings).toEqual([]);
  });

  it('returns warning for name starting with hyphen', () => {
    const warnings = validateNameable('-tool', 'Tool', 'tool');
    expect(hasWarning(warnings, 'must not start or end with a hyphen')).toBe(true);
  });

  it('returns warning for name ending with hyphen', () => {
    const warnings = validateNameable('tool-', 'Tool', 'tool');
    expect(hasWarning(warnings, 'must not start or end with a hyphen')).toBe(true);
  });

  it('returns warning for name with consecutive hyphens', () => {
    const warnings = validateNameable('tool--name', 'Tool', 'tool-name');
    expect(hasWarning(warnings, 'must not contain consecutive hyphens')).toBe(true);
  });

  it('returns warning for name with uppercase letters', () => {
    const warnings = validateNameable('MyTool', 'Tool', 'mytool');
    expect(hasWarning(warnings, 'contains invalid character')).toBe(true);
  });

  it('returns warning for name with underscores', () => {
    const warnings = validateNameable('my_tool', 'Tool', 'my-tool');
    expect(hasWarning(warnings, 'contains invalid character')).toBe(true);
  });

  it('returns warning for name with spaces', () => {
    const warnings = validateNameable('my tool', 'Tool', 'my-tool');
    expect(hasWarning(warnings, 'contains invalid character')).toBe(true);
  });

  it('returns warning for name with special characters', () => {
    const warnings = validateNameable('my@tool', 'Tool', 'my-tool');
    expect(hasWarning(warnings, 'contains invalid character')).toBe(true);
  });

  it('accepts valid names with hyphens', () => {
    const warnings = validateNameable('my-tool-name', 'Tool', 'my-tool-name');
    expect(warnings).toEqual([]);
  });

  it('accepts valid names with numbers', () => {
    const warnings = validateNameable('tool-123', 'Tool', 'tool-123');
    expect(warnings).toEqual([]);
  });

  it('accepts single character name', () => {
    const warnings = validateNameable('a', 'Tool', 'a');
    expect(warnings).toEqual([]);
  });

  it('returns warning for empty name with matching dir', () => {
    const warnings = validateNameable('', 'Tool', '');
    expect(hasWarning(warnings, 'name is empty')).toBe(true);
  });

  it('accumulates multiple warnings', () => {
    const warnings = validateNameable('-MyTool--', 'Tool', 'different');
    expect(warnings.length).toBeGreaterThan(1);
  });
});

describe('deepMerge', () => {
  it('returns a new object (does not mutate sources)', () => {
    const a = { x: 1 };
    const b = { y: 2 };
    const result = deepMerge(a, b);
    expect(result).toEqual({ x: 1, y: 2 });
    expect(a).toEqual({ x: 1 });
    expect(b).toEqual({ y: 2 });
  });

  it('merges top-level keys', () => {
    const result = deepMerge({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('later source overrides earlier for same key (primitive)', () => {
    const result = deepMerge({ x: 1 }, { x: 2 });
    expect(result).toEqual({ x: 2 });
  });

  it('deeply merges nested plain objects', () => {
    const result = deepMerge(
      { a: { b: 1, c: 2 } },
      { a: { c: 3, d: 4 } },
    );
    expect(result).toEqual({ a: { b: 1, c: 3, d: 4 } });
  });

  it('replaces arrays (does not concatenate)', () => {
    const result = deepMerge(
      { items: [1, 2, 3] },
      { items: [4, 5] },
    );
    expect(result).toEqual({ items: [4, 5] });
  });

  it('merges arrays of objects as replacement', () => {
    const result = deepMerge(
      { items: [{ id: 1 }] },
      { items: [{ id: 2 }] },
    );
    expect(result).toEqual({ items: [{ id: 2 }] });
  });

  it('handles deeply nested merging (3+ levels)', () => {
    const result = deepMerge(
      { a: { b: { c: { d: 1, e: 2 } } } },
      { a: { b: { c: { e: 3, f: 4 } } } },
    );
    expect(result).toEqual({ a: { b: { c: { d: 1, e: 3, f: 4 } } } });
  });

  it('skips null and undefined sources', () => {
    const result = deepMerge({ a: 1 }, null, undefined, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('handles non-object sources by replacing', () => {
    const result = deepMerge(
      { a: { nested: { x: 1 } } },
      { a: 42 },
    );
    expect(result).toEqual({ a: 42 });
  });

  it('handles empty objects', () => {
    const result = deepMerge({ a: 1 }, {}, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('handles no sources', () => {
    const result = deepMerge();
    expect(result).toEqual({});
  });

  it('handles merging with primitives (non-object sources)', () => {
    const result = deepMerge({ a: 1 }, 'string', { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('preserves non-plain-object values (e.g., Date, RegExp)', () => {
    const date = new Date('2024-01-01');
    const result = deepMerge(
      { ts: date },
      { other: true },
    );
    expect(result.ts).toBe(date);
    expect(result.other).toBe(true);
  });
});
