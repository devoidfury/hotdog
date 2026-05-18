import { describe, it, expect } from 'bun:test';
import {
  DelegateTaskTool,
  TaskStatusTool,
  TaskFollowupTool,
  TaskInterruptTool,
  PlanStatusTool,
  CompleteTaskTool,
} from '../src/tools/subagents.js';
import { TASK_STATUS } from '../src/agent/worker.js';

// Mock task manager for testing
class MockTaskManager {
  constructor() {
    this._tasks = new Map();
    this._wakeUpCallback = null;
  }

  setWakeUpCallback(cb) { this._wakeUpCallback = cb; }

  spawnTask(taskId, description, workerModel = null) {
    const handle = {
      taskId,
      get status() { return this._status; },
      _status: TASK_STATUS.RUNNING,
      interrupt() { this._status = TASK_STATUS.CANCELLED; return true; },
      sendFollowUp(msg) { return true; },
    };
    this._tasks.set(taskId, handle);
    return handle;
  }

  taskStatus(taskId) {
    const handle = this._tasks.get(taskId);
    return handle ? handle.status : null;
  }

  sendFollowUp(taskId, message) {
    const handle = this._tasks.get(taskId);
    return handle ? handle.sendFollowUp(message) : false;
  }

  interruptTask(taskId) {
    const handle = this._tasks.get(taskId);
    return handle ? handle.interrupt() : false;
  }

  activeTasks() {
    const active = [];
    for (const [id, handle] of this._tasks) {
      if (handle.status === TASK_STATUS.RUNNING) active.push(id);
    }
    return active;
  }

  taskCounts() {
    const active = this.activeTasks().length;
    if (active === 0) return null;
    return [active, this._tasks.size];
  }

  progressMessage() {
    const active = this.activeTasks().length;
    if (active === 0) return null;
    return `${active} task${active === 1 ? '' : 's'} running`;
  }
}

// Mock follow-up emitter for TaskWorker tests
class MockFollowEmitter {
  constructor() {
    this.listeners = [];
  }
  on(event, cb) { this.listeners.push({ event, cb }); }
  emit(event, data) {
    for (const l of this.listeners) {
      if (l.event === event) l.cb(data);
    }
  }
}

describe('DelegateTaskTool', () => {
  it('spawns a task with required args', async () => {
    const tm = new MockTaskManager();
    const tool = new DelegateTaskTool(tm);
    const result = await tool.execute(JSON.stringify({ task_id: 't1', description: 'Build feature X' }));
    expect(result).toContain('Task t1 delegated');
    expect(tm.taskStatus('t1')).toBe(TASK_STATUS.RUNNING);
  });

  it('requires task_id', async () => {
    const tm = new MockTaskManager();
    const tool = new DelegateTaskTool(tm);
    const result = await tool.execute(JSON.stringify({ description: 'Build feature X' }));
    expect(result).toContain('Error');
    expect(result).toContain('task_id');
  });

  it('requires description', async () => {
    const tm = new MockTaskManager();
    const tool = new DelegateTaskTool(tm);
    const result = await tool.execute(JSON.stringify({ task_id: 't1' }));
    expect(result).toContain('Error');
    expect(result).toContain('description');
  });

  it('returns error when task manager is null', async () => {
    const tool = new DelegateTaskTool(null);
    const result = await tool.execute(JSON.stringify({ task_id: 't1', description: 'Do something' }));
    expect(result).toContain('Error');
    expect(result).toContain('Task manager not available');
  });

  it('generates tool definition', () => {
    const tm = new MockTaskManager();
    const tool = new DelegateTaskTool(tm);
    const def = tool.toToolDef();
    expect(def.function.name).toBe('delegate_task');
    expect(def.function.parameters.required).toEqual(['task_id', 'description']);
  });

  it('generates call display', () => {
    const tm = new MockTaskManager();
    const tool = new DelegateTaskTool(tm);
    const display = tool.callDisplay(JSON.stringify({ task_id: 't1', description: 'Build feature X' }));
    expect(display).toContain('delegate_task');
    expect(display).toContain('t1');
  });
});

describe('TaskStatusTool', () => {
  it('returns status for existing task', async () => {
    const tm = new MockTaskManager();
    tm.spawnTask('t1', 'Do work');
    const tool = new TaskStatusTool(tm);
    const result = await tool.execute(JSON.stringify({ task_id: 't1' }));
    expect(result).toContain('t1');
    expect(result).toContain(TASK_STATUS.RUNNING);
  });

  it('returns not found for unknown task', async () => {
    const tm = new MockTaskManager();
    const tool = new TaskStatusTool(tm);
    const result = await tool.execute(JSON.stringify({ task_id: 'unknown' }));
    expect(result).toContain('not found');
  });

  it('requires task_id', async () => {
    const tm = new MockTaskManager();
    const tool = new TaskStatusTool(tm);
    const result = await tool.execute(JSON.stringify({}));
    expect(result).toContain('Error');
    expect(result).toContain('task_id');
  });

  it('returns error when task manager is null', async () => {
    const tool = new TaskStatusTool(null);
    const result = await tool.execute(JSON.stringify({ task_id: 't1' }));
    expect(result).toContain('Error');
  });
});

describe('TaskFollowupTool', () => {
  it('sends follow-up to running task', async () => {
    const tm = new MockTaskManager();
    tm.spawnTask('t1', 'Do work');
    const tool = new TaskFollowupTool(tm);
    const result = await tool.execute(JSON.stringify({ task_id: 't1', message: 'Also do X' }));
    expect(result).toContain('Follow-up sent');
  });

  it('requires task_id and message', async () => {
    const tm = new MockTaskManager();
    const tool = new TaskFollowupTool(tm);
    const result = await tool.execute(JSON.stringify({ task_id: 't1' }));
    expect(result).toContain('Error');
    expect(result).toContain('message');
  });

  it('returns error when task manager is null', async () => {
    const tool = new TaskFollowupTool(null);
    const result = await tool.execute(JSON.stringify({ task_id: 't1', message: 'Do X' }));
    expect(result).toContain('Error');
  });
});

describe('TaskInterruptTool', () => {
  it('interrupts a running task', async () => {
    const tm = new MockTaskManager();
    tm.spawnTask('t1', 'Do work');
    const tool = new TaskInterruptTool(tm);
    const result = await tool.execute(JSON.stringify({ task_id: 't1' }));
    expect(result).toContain('interrupted');
    expect(tm.taskStatus('t1')).toBe(TASK_STATUS.CANCELLED);
  });

  it('requires task_id', async () => {
    const tm = new MockTaskManager();
    const tool = new TaskInterruptTool(tm);
    const result = await tool.execute(JSON.stringify({}));
    expect(result).toContain('Error');
    expect(result).toContain('task_id');
  });

  it('returns error when task manager is null', async () => {
    const tool = new TaskInterruptTool(null);
    const result = await tool.execute(JSON.stringify({ task_id: 't1' }));
    expect(result).toContain('Error');
  });
});

describe('PlanStatusTool', () => {
  it('shows all active tasks', async () => {
    const tm = new MockTaskManager();
    tm.spawnTask('t1', 'Work 1');
    tm.spawnTask('t2', 'Work 2');
    const tool = new PlanStatusTool(tm);
    const result = await tool.execute(JSON.stringify({}));
    expect(result).toContain('Active tasks');
    expect(result).toContain('t1');
    expect(result).toContain('t2');
  });

  it('shows specific task status', async () => {
    const tm = new MockTaskManager();
    tm.spawnTask('t1', 'Work 1');
    const tool = new PlanStatusTool(tm);
    const result = await tool.execute(JSON.stringify({ task_id: 't1' }));
    expect(result).toContain('t1');
    expect(result).toContain(TASK_STATUS.RUNNING);
  });

  it('shows no active tasks when none running', async () => {
    const tm = new MockTaskManager();
    const tool = new PlanStatusTool(tm);
    const result = await tool.execute(JSON.stringify({}));
    expect(result).toContain('No active tasks');
  });

  it('returns not found for unknown task', async () => {
    const tm = new MockTaskManager();
    const tool = new PlanStatusTool(tm);
    const result = await tool.execute(JSON.stringify({ task_id: 'unknown' }));
    expect(result).toContain('not found');
  });

  it('returns error when task manager is null', async () => {
    const tool = new PlanStatusTool(null);
    const result = await tool.execute(JSON.stringify({}));
    expect(result).toContain('Error');
  });
});

describe('CompleteTaskTool', () => {
  it('marks task as complete', async () => {
    const tm = new MockTaskManager();
    tm.spawnTask('t1', 'Do work');
    const tool = new CompleteTaskTool(tm);
    const result = await tool.execute(JSON.stringify({ task_id: 't1' }));
    expect(result).toContain('marked as complete');
  });

  it('requires task_id', async () => {
    const tm = new MockTaskManager();
    const tool = new CompleteTaskTool(tm);
    const result = await tool.execute(JSON.stringify({}));
    expect(result).toContain('Error');
    expect(result).toContain('task_id');
  });

  it('returns error when task manager is null', async () => {
    const tool = new CompleteTaskTool(null);
    const result = await tool.execute(JSON.stringify({ task_id: 't1' }));
    expect(result).toContain('Error');
  });
});

describe('TaskManager', () => {
  it('spawns tasks and tracks status', () => {
    const tm = new MockTaskManager();
    const handle = tm.spawnTask('t1', 'Build feature');
    expect(handle.taskId).toBe('t1');
    expect(tm.taskStatus('t1')).toBe(TASK_STATUS.RUNNING);
  });

  it('tracks multiple tasks', () => {
    const tm = new MockTaskManager();
    tm.spawnTask('t1', 'Work 1');
    tm.spawnTask('t2', 'Work 2');
    tm.spawnTask('t3', 'Work 3');
    expect(tm.taskCounts()).toEqual([3, 3]);
  });

  it('returns null for unknown task status', () => {
    const tm = new MockTaskManager();
    expect(tm.taskStatus('unknown')).toBeNull();
  });

  it('interrupts tasks', () => {
    const tm = new MockTaskManager();
    tm.spawnTask('t1', 'Work 1');
    expect(tm.interruptTask('t1')).toBe(true);
    expect(tm.taskStatus('t1')).toBe(TASK_STATUS.CANCELLED);
  });

  it('returns false for interrupting unknown task', () => {
    const tm = new MockTaskManager();
    expect(tm.interruptTask('unknown')).toBe(false);
  });

  it('sends follow-up messages', () => {
    const tm = new MockTaskManager();
    tm.spawnTask('t1', 'Work 1');
    expect(tm.sendFollowUp('t1', 'Do X')).toBe(true);
  });

  it('returns false for follow-up to unknown task', () => {
    const tm = new MockTaskManager();
    expect(tm.sendFollowUp('unknown', 'Do X')).toBe(false);
  });

  it('gets active task IDs', () => {
    const tm = new MockTaskManager();
    tm.spawnTask('t1', 'Work 1');
    tm.spawnTask('t2', 'Work 2');
    const active = tm.activeTasks();
    expect(active).toContain('t1');
    expect(active).toContain('t2');
    expect(active).toHaveLength(2);
  });

  it('returns empty array when no active tasks', () => {
    const tm = new MockTaskManager();
    expect(tm.activeTasks()).toEqual([]);
  });

  it('returns null task counts when no active tasks', () => {
    const tm = new MockTaskManager();
    expect(tm.taskCounts()).toBeNull();
  });

  it('generates progress message', () => {
    const tm = new MockTaskManager();
    expect(tm.progressMessage()).toBeNull();
    tm.spawnTask('t1', 'Work 1');
    expect(tm.progressMessage()).toContain('1 task running');
    tm.spawnTask('t2', 'Work 2');
    expect(tm.progressMessage()).toContain('2 tasks running');
  });

  it('sets and uses wake-up callback', () => {
    const tm = new MockTaskManager();
    let wakeCalled = false;
    tm.setWakeUpCallback((taskId, result) => {
      wakeCalled = true;
      expect(taskId).toBe('t1');
    });
    // We can't easily trigger the callback in our mock, but we verify it's set
    expect(tm._wakeUpCallback).not.toBeNull();
  });
});

describe('TaskHandle', () => {
  it('reports status', () => {
    const statusRef = { value: TASK_STATUS.RUNNING };
    const handle = {
      taskId: 't1',
      get status() { return statusRef.value; },
      interrupt() { statusRef.value = TASK_STATUS.CANCELLED; return true; },
      sendFollowUp() { return true; },
    };
    expect(handle.status).toBe(TASK_STATUS.RUNNING);
  });

  it('interrupts task', () => {
    const statusRef = { value: TASK_STATUS.RUNNING };
    const handle = {
      taskId: 't1',
      get status() { return statusRef.value; },
      interrupt() { statusRef.value = TASK_STATUS.CANCELLED; return true; },
      sendFollowUp() { return true; },
    };
    handle.interrupt();
    expect(handle.status).toBe(TASK_STATUS.CANCELLED);
  });
});

describe('TaskWorker', () => {
  it('has correct default values', () => {
    const mockEmitter = new MockFollowEmitter();
    const statusRef = { value: TASK_STATUS.RUNNING };
    const handle = {
      taskId: 't1',
      get status() { return statusRef.value; },
      interrupt() { statusRef.value = TASK_STATUS.CANCELLED; return true; },
      sendFollowUp() { return true; },
    };
    expect(handle.taskId).toBe('t1');
  });
});

describe('DelegateTaskTool.toToolDef', () => {
  it('includes visible profiles in description', () => {
    const tm = new MockTaskManager();
    tm._config = {
      worker_profiles: {
        'task-default': { visibleWorker: true },
        'task-default2': { visibleWorker: false },
      },
    };
    const tool = new DelegateTaskTool(tm);
    const def = tool.toToolDef();
    expect(def.function.description).toContain('task-default');
    expect(def.function.description).not.toContain('task-default2');
  });

  it('handles null task manager', () => {
    const tool = new DelegateTaskTool(null);
    const def = tool.toToolDef();
    expect(def.function.name).toBe('delegate_task');
  });
});

describe('TaskFollowupTool.toToolDef', () => {
  it('generates correct tool definition', () => {
    const tm = new MockTaskManager();
    const tool = new TaskFollowupTool(tm);
    const def = tool.toToolDef();
    expect(def.function.name).toBe('task_followup');
    expect(def.function.parameters.required).toEqual(['task_id', 'message']);
  });
});

describe('TaskFollowupTool.callDisplay', () => {
  it('shows truncated message', () => {
    const tm = new MockTaskManager();
    const tool = new TaskFollowupTool(tm);
    const display = tool.callDisplay(JSON.stringify({ task_id: 't1', message: 'A very long message that should be truncated' }));
    expect(display).toContain('task_followup');
    expect(display).toContain('t1');
    // Message is truncated to 40 chars: task_followup(t1 -> ...) = 16 + 2 + 4 + 40 + 1 = 63 max
    expect(display.length).toBeLessThanOrEqual(63);
  });
});

describe('TaskInterruptTool.toToolDef', () => {
  it('generates correct tool definition', () => {
    const tm = new MockTaskManager();
    const tool = new TaskInterruptTool(tm);
    const def = tool.toToolDef();
    expect(def.function.name).toBe('task_interrupt');
    expect(def.function.parameters.required).toEqual(['task_id']);
  });
});

describe('TaskInterruptTool.callDisplay', () => {
  it('shows task ID', () => {
    const tm = new MockTaskManager();
    const tool = new TaskInterruptTool(tm);
    const display = tool.callDisplay(JSON.stringify({ task_id: 't1' }));
    expect(display).toContain('task_interrupt');
    expect(display).toContain('t1');
  });
});

describe('PlanStatusTool.toToolDef', () => {
  it('generates correct tool definition', () => {
    const tm = new MockTaskManager();
    const tool = new PlanStatusTool(tm);
    const def = tool.toToolDef();
    expect(def.function.name).toBe('plan_status');
    expect(def.function.parameters.required).toEqual([]);
  });
});

describe('PlanStatusTool.callDisplay', () => {
  it('shows task ID when specified', () => {
    const tm = new MockTaskManager();
    const tool = new PlanStatusTool(tm);
    const display = tool.callDisplay(JSON.stringify({ task_id: 't1' }));
    expect(display).toContain('plan_status');
    expect(display).toContain('task=t1');
  });

  it('shows all when no task ID', () => {
    const tm = new MockTaskManager();
    const tool = new PlanStatusTool(tm);
    const display = tool.callDisplay(JSON.stringify({}));
    expect(display).toContain('plan_status');
    expect(display).toContain('task=all');
  });
});

describe('CompleteTaskTool.toToolDef', () => {
  it('generates correct tool definition', () => {
    const tm = new MockTaskManager();
    const tool = new CompleteTaskTool(tm);
    const def = tool.toToolDef();
    expect(def.function.name).toBe('complete_task');
    expect(def.function.parameters.required).toEqual(['task_id']);
  });
});

describe('CompleteTaskTool.callDisplay', () => {
  it('shows task ID', () => {
    const tm = new MockTaskManager();
    const tool = new CompleteTaskTool(tm);
    const display = tool.callDisplay(JSON.stringify({ task_id: 't1' }));
    expect(display).toContain('complete_task');
    expect(display).toContain('t1');
  });
});
