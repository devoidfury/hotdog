// Scheduler — manages timed and recurring tasks.
// Tasks are scheduled with a delay (one-shot) or interval (recurring).
// When a task fires, its message is enqueued into the MessageBus.

import crypto from "node:crypto";
import { logger } from "../../core/logger.js";

/**
 * Scheduled task entry.
 */
export class ScheduledTask {
  constructor(id, description, delaySecs, intervalSecs) {
    this.id = id;
    this.description = description;
    this.delaySecs = delaySecs;
    this.intervalSecs = intervalSecs;
    this.createdAt = Date.now();
    this.nextRun = Date.now() + delaySecs * 1000;
    this.repeat = intervalSecs > 0;
    this.active = true;
    this._timeout = null;
  }
}

/**
 * Task scheduler with delay-based and interval-based scheduling.
 * Wires into the MessageBus to enqueue task messages at scheduled times.
 */
export class Scheduler {
  /**
   * @param {Object} options
   * @param {number} options.maxTasks - Maximum concurrent scheduled tasks
   * @param {boolean} options.logActivity - Whether to log scheduler activity
   */
  constructor(options = {}) {
    this._tasks = new Map();
    this._bus = null;
    this._maxTasks = options.maxTasks || 50;
    this._logActivity = options.logActivity || false;
  }

  /**
   * Set the MessageBus for enqueueing task messages.
   * Must be called before scheduling any tasks.
   * @param {Object} bus - MessageBus instance with enqueue() method
   */
  setBus(bus) {
    this._bus = bus;
  }

  /**
   * Schedule a task.
   * @param {string} description - What the task should do (becomes the message text)
   * @param {number} delaySecs - Seconds until first execution (>= 1)
   * @param {number} [intervalSecs=0] - Seconds between repeat executions (0 = one-shot)
   * @returns {ScheduledTask}
   * @throws {Error} If bus is not set, task count exceeded, or invalid params
   */
  schedule(description, delaySecs, intervalSecs = 0) {
    if (!this._bus) {
      throw new Error("Scheduler: no message bus connected. Tasks can only be scheduled in interactive mode.");
    }
    if (!description || description.trim().length === 0) {
      throw new Error("Scheduler: description is required");
    }
    if (!Number.isFinite(delaySecs) || delaySecs <= 0) {
      throw new Error("Scheduler: delay must be a positive number of seconds");
    }
    if (intervalSecs < 0 || !Number.isFinite(intervalSecs)) {
      throw new Error("Scheduler: interval must be 0 (one-shot) or a positive number");
    }
    if (this._tasks.size >= this._maxTasks) {
      throw new Error(`Scheduler: maximum task count (${this._maxTasks}) reached. Cancel some tasks first.`);
    }

    const id = crypto.randomUUID().slice(0, 8);
    const task = new ScheduledTask(id, description.trim(), delaySecs, intervalSecs);

    task._timeout = setTimeout(() => this._fire(task), task.delaySecs * 1000);
    task._timeout.unref(); // Don't keep the process alive

    this._tasks.set(id, task);

    if (this._logActivity) {
      const mode = task.repeat ? `every ${task.intervalSecs}s` : `in ${task.delaySecs}s`;
      logger.debug(`[scheduler] scheduled ${id}: "${task.description}" ${mode}`);
    }

    return task;
  }

  /**
   * Fire a scheduled task — enqueue its message and reschedule if recurring.
   * @param {ScheduledTask} task
   * @private
   */
  _fire(task) {
    if (!task.active || !this._tasks.has(task.id)) return;
    if (!this._bus) {
      // Bus was removed (e.g., shutdown in progress) — silently drop
      this._tasks.delete(task.id);
      return;
    }

    if (this._logActivity) {
      logger.debug(`[scheduler] firing ${task.id}: "${task.description}"`);
    }

    // Enqueue the task message into the bus
    this._bus.enqueue(task.description);

    if (task.repeat && task.active) {
      // Reschedule for the next interval
      task._timeout = setTimeout(() => this._fire(task), task.intervalSecs * 1000);
      task._timeout.unref();
      task.nextRun = Date.now() + task.intervalSecs * 1000;
    } else {
      // One-shot done — keep in map briefly for list visibility, but mark inactive
      task.active = false;
    }
  }

  /**
   * Cancel a scheduled task by ID.
   * @param {string} id
   * @returns {boolean} true if the task was found and cancelled
   */
  cancel(id) {
    const task = this._tasks.get(id);
    if (!task) return false;

    if (task._timeout) {
      clearTimeout(task._timeout);
      task._timeout = null;
    }
    task.active = false;
    this._tasks.delete(id);

    if (this._logActivity) {
      logger.debug(`[scheduler] cancelled ${id}`);
    }
    return true;
  }

  /**
   * Get all active scheduled tasks.
   * @returns {ScheduledTask[]}
   */
  list() {
    return Array.from(this._tasks.values()).filter((t) => t.active);
  }

  /**
   * Get a task by ID.
   * @param {string} id
   * @returns {ScheduledTask|undefined}
   */
  get(id) {
    return this._tasks.get(id);
  }

  /**
   * Cancel all tasks and clear timeouts. Called during shutdown.
   */
  cleanup() {
    for (const task of this._tasks.values()) {
      if (task._timeout) {
        clearTimeout(task._timeout);
        task._timeout = null;
      }
    }
    this._tasks.clear();

    if (this._logActivity) {
      logger.debug("[scheduler] cleanup complete");
    }
  }
}
