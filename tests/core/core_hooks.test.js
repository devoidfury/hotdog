// Tests for the core hook system.

import { HookSystem, HOOKS, createHooks } from '../../src/core/hooks.js';
import { describe, it, expect } from 'bun:test';

describe('HookSystem', () => {
  describe('on() / emit()', () => {
    it('should call registered handlers on emit', () => {
      const hooks = createHooks();
      const calls = [];
      hooks.on('test:hook', (data) => calls.push(data));
      hooks.emit('test:hook', { value: 42 });
      expect(calls).toEqual([{ value: 42 }]);
    });

    it('should call multiple handlers in order', () => {
      const hooks = createHooks();
      const order = [];
      hooks.on('test:hook', (data) => order.push('a'));
      hooks.on('test:hook', (data) => order.push('b'));
      hooks.emit('test:hook', {});
      expect(order).toEqual(['a', 'b']);
    });

    it('should pass data to handlers', () => {
      const hooks = createHooks();
      let received = null;
      hooks.on('test:hook', (data) => { received = data; });
      hooks.emit('test:hook', { foo: 'bar', count: 3 });
      expect(received).toEqual({ foo: 'bar', count: 3 });
    });

    it('should handle handlers that return values', () => {
      const hooks = createHooks();
      hooks.on('test:hook', () => 'first');
      hooks.on('test:hook', () => 'second');
      const result = hooks.emit('test:hook', {});
      expect(result).toBe('second');
    });

    it('should return undefined when no handlers match', () => {
      const hooks = createHooks();
      const result = hooks.emit('nonexistent:hook', {});
      expect(result).toBeUndefined();
    });

    it('should handle no registered handlers gracefully', () => {
      const hooks = createHooks();
      const result = hooks.emit('test:hook', { data: true });
      expect(result).toBeUndefined();
    });
  });

  describe('on() returns removal function', () => {
    it('should return a function that removes the handler', () => {
      const hooks = createHooks();
      const calls = [];
      const remove = hooks.on('test:hook', (data) => calls.push(data));
      hooks.emit('test:hook', { value: 1 });
      expect(calls).toEqual([{ value: 1 }]);

      remove();
      hooks.emit('test:hook', { value: 2 });
      expect(calls).toEqual([{ value: 1 }]); // handler no longer called
    });

    it('should handle removal of a handler that was already removed', () => {
      const hooks = createHooks();
      const remove = hooks.on('test:hook', () => {});
      remove();
      expect(() => remove()).not.toThrow();
      expect(hooks.handlerCount('test:hook')).toBe(0);
    });

    it('should allow re-registering the same function after removal', () => {
      const hooks = createHooks();
      const handler = () => 'result';
      const remove1 = hooks.on('test:hook', handler);
      expect(hooks.handlerCount('test:hook')).toBe(1);

      remove1();
      expect(hooks.handlerCount('test:hook')).toBe(0);

      const remove2 = hooks.on('test:hook', handler);
      expect(hooks.handlerCount('test:hook')).toBe(1);
      remove2();
    });
  });

  describe('off()', () => {
    it('should remove a specific handler by reference', () => {
      const hooks = createHooks();
      const handler1 = () => 'first';
      const handler2 = () => 'second';
      hooks.on('test:hook', handler1);
      hooks.on('test:hook', handler2);
      expect(hooks.handlerCount('test:hook')).toBe(2);

      const removed = hooks.off('test:hook', handler1);
      expect(removed).toBe(true);
      expect(hooks.handlerCount('test:hook')).toBe(1);
      expect(hooks.emit('test:hook', {})).toBe('second');
    });

    it('should return false when handler not found', () => {
      const hooks = createHooks();
      const handler = () => {};
      const removed = hooks.off('test:hook', handler);
      expect(removed).toBe(false);
    });

    it('should handle off on non-existent hook', () => {
      const hooks = createHooks();
      const removed = hooks.off('nonexistent:hook', () => {});
      expect(removed).toBe(false);
    });
  });

  describe('emitAsync()', () => {
    it('should call async handlers', async () => {
      const hooks = createHooks();
      const results = [];
      hooks.on('test:hook', async (data) => {
        await new Promise(r => setTimeout(r, 10));
        results.push(data.value);
      });
      await hooks.emitAsync('test:hook', { value: 1 });
      expect(results).toEqual([1]);
    });

    it('should call multiple async handlers concurrently', async () => {
      const hooks = createHooks();
      const order = [];
      hooks.on('test:hook', async () => {
        await new Promise(r => setTimeout(r, 50));
        order.push('slow');
      });
      hooks.on('test:hook', async () => {
        order.push('fast');
      });
      await hooks.emitAsync('test:hook', {});
      expect(order).toContain('fast');
      expect(order).toContain('slow');
      expect(order.length).toBe(2);
    });

    it('should not propagate errors from async handlers', async () => {
      const hooks = createHooks();
      let handlerCalled = false;
      hooks.on('test:hook', async () => {
        handlerCalled = true;
        await new Promise((_, reject) => reject(new Error('boom')));
      });
      // Should not throw — errors are caught and logged
      await hooks.emitAsync('test:hook', {});
      expect(handlerCalled).toBe(true);
    });

    it('should not propagate errors from sync handlers', async () => {
      const hooks = createHooks();
      let handlerCalled = false;
      hooks.on('test:hook', () => {
        handlerCalled = true;
        throw new Error('sync boom');
      });
      // Should not throw — errors are caught and logged
      await hooks.emitAsync('test:hook', {});
      expect(handlerCalled).toBe(true);
    });

    it('should handle sync handlers that return promises', async () => {
      const hooks = createHooks();
      const results = [];
      hooks.on('test:hook', (data) => {
        return new Promise(resolve => {
          setTimeout(() => {
            results.push(data.value);
            resolve();
          }, 10);
        });
      });
      await hooks.emitAsync('test:hook', { value: 42 });
      expect(results).toEqual([42]);
    });
  });

  describe('emitAsyncSeq()', () => {
    it('should call async handlers sequentially', async () => {
      const hooks = createHooks();
      const order = [];
      hooks.on('test:hook', async () => {
        order.push('a-start');
        await new Promise(r => setTimeout(r, 30));
        order.push('a-end');
      });
      hooks.on('test:hook', async () => {
        order.push('b-start');
        await new Promise(r => setTimeout(r, 10));
        order.push('b-end');
      });
      await hooks.emitAsyncSeq('test:hook', {});
      expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    });

    it('should not propagate errors from async handlers', async () => {
      const hooks = createHooks();
      let secondRan = false;
      hooks.on('test:hook', async () => {
        throw new Error('boom');
      });
      hooks.on('test:hook', async () => {
        secondRan = true;
      });
      await hooks.emitAsyncSeq('test:hook', {});
      expect(secondRan).toBe(true);
    });
  });

  describe('clear()', () => {
    it('should clear a specific hook', () => {
      const hooks = createHooks();
      hooks.on('test:hook', () => {});
      hooks.on('other:hook', () => {});
      hooks.clear('test:hook');
      expect(hooks.handlerCount('test:hook')).toBe(0);
      expect(hooks.handlerCount('other:hook')).toBe(1);
    });

    it('should clear all hooks when no name given', () => {
      const hooks = createHooks();
      hooks.on('test:hook', () => {});
      hooks.on('other:hook', () => {});
      hooks.clear();
      expect(hooks.hookNames().length).toBe(0);
    });
  });

  describe('handlerCount() / hookNames()', () => {
    it('should return correct handler count', () => {
      const hooks = createHooks();
      expect(hooks.handlerCount('test:hook')).toBe(0);
      hooks.on('test:hook', () => {});
      hooks.on('test:hook', () => {});
      expect(hooks.handlerCount('test:hook')).toBe(2);
    });

    it('should return all registered hook names', () => {
      const hooks = createHooks();
      hooks.on('a', () => {});
      hooks.on('b', () => {});
      hooks.on('a', () => {});
      expect(hooks.hookNames()).toEqual(['a', 'b']);
    });
  });

  describe('HOOKS constants', () => {
    it('should define all standard hook names', () => {
      expect(HOOKS.SESSION_CREATE).toBe('session:create');
      expect(HOOKS.AGENT_BEFORE_RUN).toBe('agent:beforeRun');
      expect(HOOKS.TOOLS_REGISTER).toBe('tools:register');
      expect(HOOKS.CONTEXT_FULL).toBe('context:full');
      expect(HOOKS.OUTPUT_EVENT).toBe('output:event');
    });

    it('should include COMPACT_STRATEGY_LIST hook', () => {
      expect(HOOKS.COMPACT_STRATEGY_LIST).toBe('compact:strategyList');
    });
  });
});
