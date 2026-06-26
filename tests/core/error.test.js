import { describe, it, expect } from 'bun:test';
import { isExpectedError, formatError, withContext } from '../../src/core/error.js';


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
