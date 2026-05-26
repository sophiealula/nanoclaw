import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getTaskById,
  logTaskRun,
} from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  computeRetryOrNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      retry_count: 0,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      retry_count: 0,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  describe('computeRetryOrNextRun', () => {
    const makeTask = (
      overrides: Partial<import('./types.js').ScheduledTask> = {},
    ): import('./types.js').ScheduledTask => ({
      id: 'retry-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '30 13 * * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active',
      retry_count: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });

    it('on success, advances to next cron time and resets retry_count', () => {
      const task = makeTask({ retry_count: 2 });
      const result = computeRetryOrNextRun(task, false);

      expect(result.retry_count).toBe(0);
      // next_run should be the next cron occurrence, not a retry delay
      expect(new Date(result.next_run!).getTime()).toBeGreaterThan(
        Date.now() + 60_000,
      );
    });

    it('on first error, retries in ~5 minutes instead of advancing to next day', () => {
      const task = makeTask({ retry_count: 0 });
      const result = computeRetryOrNextRun(task, true);

      expect(result.retry_count).toBe(1);
      const retryTime = new Date(result.next_run!).getTime();
      const now = Date.now();
      // Should retry in ~5 minutes (300_000ms), not tomorrow
      expect(retryTime).toBeGreaterThan(now);
      expect(retryTime).toBeLessThan(now + 10 * 60_000); // within 10 min
    });

    it('on second error, retries with longer backoff (~10 minutes)', () => {
      const task = makeTask({ retry_count: 1 });
      const result = computeRetryOrNextRun(task, true);

      expect(result.retry_count).toBe(2);
      const retryTime = new Date(result.next_run!).getTime();
      const now = Date.now();
      expect(retryTime).toBeGreaterThan(now + 5 * 60_000); // more than 5 min
      expect(retryTime).toBeLessThan(now + 25 * 60_000); // within 25 min
    });

    it('after 3 failed retries, gives up and advances to next scheduled time', () => {
      const task = makeTask({ retry_count: 3 });
      const result = computeRetryOrNextRun(task, true);

      // Should reset and advance to next cron occurrence
      expect(result.retry_count).toBe(0);
      expect(new Date(result.next_run!).getTime()).toBeGreaterThan(
        Date.now() + 60_000,
      );
    });

    it('on success for once-task, returns null next_run', () => {
      const task = makeTask({ schedule_type: 'once', retry_count: 0 });
      const result = computeRetryOrNextRun(task, false);

      expect(result.next_run).toBeNull();
      expect(result.retry_count).toBe(0);
    });

    it('on error for once-task, retries instead of completing', () => {
      const task = makeTask({ schedule_type: 'once', retry_count: 0 });
      const result = computeRetryOrNextRun(task, true);

      expect(result.retry_count).toBe(1);
      expect(result.next_run).not.toBeNull();
    });
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      retry_count: 0,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});
