import { describe, it, expect } from 'bun:test';
import { validateNameable } from '../src/lib.js';

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
