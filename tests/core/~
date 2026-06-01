import { describe, it, expect } from 'bun:test';
import { TASK_STATUS, TaskHandle, TaskWorker, TaskManager } from '../src/agent/worker.js';

describe('TASK_STATUS', () => {
  it('has all status values', () => {
    expect(TASK_STATUS.RUNNING).toBe('running');
    expect(TASK_STATUS.COMPLETED).toBe('completed');
    expect(TASK_STATUS.FAILED).toBe('failed');
    expect(TASK_STATUS.CANCELLED).toBe('cancelled');
  });
});

describe('TaskHandle', () => {
  it('returns status from ref', () => {
    const statusRef = { value: TASK_STATUS.RUNNING };
    const handle = new TaskHandle('task-1', statusRef, null, null);
    expect(handle.taskId).toBe('task-1');
    expect(handle.status).toBe('running');
  });

  it('sends follow-up when running', () => {
    const statusRef = { value: TASK_STATUS.RUNNING };
    const followQueue = [];
    const handle = new TaskHandle('task-1', statusRef, null, followQueue);
    const sent = handle.sendFollowUp('continue working');
    expect(sent).toBe(true);
    expect(followQueue).toEqual(['continue working']);
  });

  it('does not send follow-up when not running', () => {
    const statusRef = { value: TASK_STATUS.COMPLETED };
    const handle = new TaskHandle('task-1', statusRef, null, null);
    expect(handle.sendFollowUp('hi')).toBe(false);
  });

  it('interrupts running task', () => {
    const statusRef = { value: TASK_STATUS.RUNNING };
    let aborted = false;
    const abortController = {
      abort: () => { aborted = true; },
    };
    const handle = new TaskHandle('task-1', statusRef, abortController, null);
    const interrupted = handle.interrupt();
    expect(interrupted).toBe(true);
    expect(aborted).toBe(true);
  });

  it('does not interrupt when not running', () => {
    const statusRef = { value: TASK_STATUS.COMPLETED };
    let aborted = false;
    const abortController = {
      abort: () => { aborted = true; },
    };
    const handle = new TaskHandle('task-1', statusRef, abortController, null);
    expect(handle.interrupt()).toBe(false);
    expect(aborted).toBe(false);
  });
});

describe('TaskWorker', () => {
  it('creates worker with defaults', () => {
    const worker = new TaskWorker({
      taskId: 'task-1',
      taskDescription: 'Do something',
      managerContext: { addSystemMessage: () => {} },
      llmClient: {},
      systemPrompt: 'You are a worker',
    });
    expect(worker.taskId).toBe('task-1');
    expect(worker.taskDescription).toBe('Do something');
    expect(worker.systemPrompt).toBe('You are a worker');
    expect(worker.maxIterations).toBe(1000); // DEFAULT_MAX_ITERATIONS
    expect(worker.maxToolOutputLines).toBe(800);
  });

  it('accepts custom maxIterations', () => {
    const worker = new TaskWorker({
      taskId: 'task-1',
      taskDescription: 'Do something',
      managerContext: { addSystemMessage: () => {} },
      llmClient: {},
      systemPrompt: 'You are a worker',
      maxIterations: 5,
    });
    expect(worker.maxIterations).toBe(5);
  });

  it('creates handle via spawn', () => {
    const handle = TaskWorker.spawn({
      taskId: 'task-1',
      taskDescription: 'Do something',
      managerContext: { addSystemMessage: () => {} },
      llmClient: {},
      systemPrompt: 'You are a worker',
    });
    expect(handle.taskId).toBe('task-1');
    expect(handle.status).toBe('running');
  });

  it('creates handle with follow queue', () => {
    const worker = new TaskWorker({
      taskId: 'task-1',
      taskDescription: 'Do something',
      managerContext: { addSystemMessage: () => {} },
      llmClient: {},
      systemPrompt: 'You are a worker',
    });
    const handle = worker._createHandle();
    // The handle's _followQueue is a reference to the worker's queue
    expect(handle._followQueue).toBe(worker._followQueue);
    // Messages pushed to the queue are accessible
    worker._followQueue.push('test message');
    expect(worker._followQueue).toEqual(['test message']);
  });
});

describe('TaskManager', () => {
  it('creates with defaults', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    expect(manager._tasks.size).toBe(0);
  });

  it('sets wake up callback', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    let callbackSet = false;
    manager.setWakeUpCallback(() => { callbackSet = true; });
    expect(manager._wakeUpCallback).toBeDefined();
  });

  it('spawns task and tracks it', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    const handle = manager.spawnTask('task-1', 'Do something');
    expect(handle.taskId).toBe('task-1');
    expect(manager.taskStatus('task-1')).toBe('running');
  });

  it('returns null for unknown task status', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    expect(manager.taskStatus('nonexistent')).toBeNull();
  });

  it('sends follow-up to running task', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    manager.spawnTask('task-1', 'Do something');
    // Follow-up should succeed since task is running
    const sent = manager.sendFollowUp('task-1', 'continue');
    expect(sent).toBe(true);
  });

  it('returns false for follow-up to unknown task', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    expect(manager.sendFollowUp('nonexistent', 'hi')).toBe(false);
  });

  it('interrupts running task', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    manager.spawnTask('task-1', 'Do something');
    const interrupted = manager.interruptTask('task-1');
    expect(interrupted).toBe(true);
  });

  it('returns false for interrupt of unknown task', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    expect(manager.interruptTask('nonexistent')).toBe(false);
  });

  it('tracks active tasks', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    manager.spawnTask('task-1', 'Do something');
    manager.spawnTask('task-2', 'Do something else');
    const active = manager.activeTasks();
    expect(active).toHaveLength(2);
    expect(active).toContain('task-1');
    expect(active).toContain('task-2');
  });

  it('returns empty array when no active tasks', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    expect(manager.activeTasks()).toEqual([]);
  });

  it('returns task counts', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    manager.spawnTask('task-1', 'Do something');
    manager.spawnTask('task-2', 'Do something else');
    const counts = manager.taskCounts();
    expect(counts).toEqual([2, 2]);
  });

  it('returns null task counts when no active tasks', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    expect(manager.taskCounts()).toBeNull();
  });

  it('returns progress message when tasks active', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    manager.spawnTask('task-1', 'Do something');
    const progress = manager.progressMessage();
    expect(progress).toContain('1 task');
  });

  it('returns null progress when no active tasks', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
    });
    expect(manager.progressMessage()).toBeNull();
  });

  it('uses custom model name', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
      modelName: 'custom-model',
    });
    expect(manager.modelName).toBe('custom-model');
  });

  it('uses custom allowed tools', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
      allowedTools: ['read', 'write'],
    });
    expect(manager.allowedTools).toEqual(['read', 'write']);
  });

  it('uses custom max iterations', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
      maxIterations: 10,
    });
    expect(manager.maxIterations).toBe(10);
  });

  it('uses custom max tool output lines', () => {
    const manager = new TaskManager({
      managerContext: { addSystemMessage: () => {} },
      maxToolOutputLines: 500,
    });
    expect(manager.maxToolOutputLines).toBe(500);
  });
});
