import { describe, it, expect } from 'bun:test';
import { isExpectedError, formatError, withContext } from '../src/context/error.js';

describe('isExpectedError', () => {
  it('returns false for non-Error values', () => {
    expect(isExpectedError(null)).toBe(false);
    expect(isExpectedError(undefined)).toBe(false);
    expect(isExpectedError('string')).toBe(false);
    expect(isExpectedError({})).toBe(false);
    expect(isExpectedError(42)).toBe(false);
  });

  it('recognizes cancelled errors', () => {
    const err = new Error('user cancelled');
    err.type = 'cancelled';
    expect(isExpectedError(err)).toBe(true);
  });

  it('recognizes http errors', () => {
    const err = new Error('connection refused');
    err.type = 'http';
    expect(isExpectedError(err)).toBe(true);
  });

  it('recognizes api errors', () => {
    const err = new Error('invalid API key');
    err.type = 'api';
    expect(isExpectedError(err)).toBe(true);
  });

  it('recognizes timeout errors', () => {
    const err = new Error('request timed out');
    err.type = 'timeout';
    expect(isExpectedError(err)).toBe(true);
  });

  it('recognizes invalid_response errors', () => {
    const err = new Error('malformed JSON');
    err.type = 'invalid_response';
    expect(isExpectedError(err)).toBe(true);
  });

  it('recognizes errors with "cancelled" in message', () => {
    const err = new Error('Operation cancelled by user');
    expect(isExpectedError(err)).toBe(true);
  });

  it('does not recognize unknown error types', () => {
    const err = new Error('some error');
    err.type = 'unknown_type';
    expect(isExpectedError(err)).toBe(false);
  });

  it('does not recognize plain errors without type', () => {
    const err = new Error('plain error');
    expect(isExpectedError(err)).toBe(false);
  });
});

describe('formatError', () => {
  it('returns message only for expected errors', () => {
    const err = new Error('connection refused');
    err.type = 'http';
    const formatted = formatError(err);
    expect(formatted).toBe('connection refused');
    expect(formatted).not.toContain('at '); // no stack trace
  });

  it('returns message only for cancelled errors', () => {
    const err = new Error('user cancelled');
    err.type = 'cancelled';
    const formatted = formatError(err);
    expect(formatted).toBe('user cancelled');
  });

  it('returns message only for errors with cancelled in message', () => {
    const err = new Error('Operation cancelled');
    const formatted = formatError(err);
    expect(formatted).toBe('Operation cancelled');
  });

  it('returns message + stack for unexpected errors', () => {
    const err = new Error('null pointer');
    const formatted = formatError(err);
    expect(formatted).toContain('null pointer');
    expect(formatted).toContain('at '); // includes stack trace
  });

  it('uses String(err) when message is empty', () => {
    const err = new Error();
    err.type = 'http';
    const formatted = formatError(err);
    // err.message is '', so falls back to String(err) which is 'Error'
    expect(formatted).toBe('Error');
  });

  it('handles errors with no stack property', () => {
    const err = new Error('test');
    err.stack = undefined;
    const formatted = formatError(err);
    expect(formatted).toContain('test');
    expect(formatted).toContain('(no stack)');
  });

  it('handles non-Error values gracefully', () => {
    expect(formatError(null)).toBe('null');
    expect(formatError(undefined)).toBe('undefined');
    expect(formatError('string error')).toBe('string error');
  });
});

describe('withContext', () => {
  it('returns the result of a successful async function', async () => {
    const result = await withContext('test label', async () => 'success');
    expect(result).toBe('success');
  });

  it('re-throws expected errors as-is', async () => {
    const err = new Error('api failure');
    err.type = 'api';
    await expect(
      withContext('test label', async () => { throw err; })
    ).rejects.toBe(err);
  });

  it('wraps unexpected errors with context label', async () => {
    try {
      await withContext('building agent', async () => {
        throw new Error('null reference');
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.message).toContain('[building agent]');
      expect(e.message).toContain('null reference');
      expect(e.stack).toContain('null reference');
    }
  });

  it('wraps unexpected errors preserving stack trace', async () => {
    try {
      await withContext('processing', async () => {
        const obj = null;
        obj.foo; // TypeError
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.message).toContain('[processing]');
      expect(e.stack).toContain('at '); // stack preserved
    }
  });

  it('handles sync functions', async () => {
    const result = await withContext('sync test', () => 'sync result');
    expect(result).toBe('sync result');
  });
});
