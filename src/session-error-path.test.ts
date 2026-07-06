/**
 * Regression test: error-path session id must NEVER be persisted.
 *
 * Scenario reproduced:
 *   1. The container is told to resume sessionId `S1`.
 *   2. The SDK can't find session `S1` and emits an error result whose
 *      `newSessionId` field is the very same `S1` (i.e. the failed-resume id).
 *   3. Without the gate, the post-run handler would write `S1` back into the
 *      DB + in-memory map. The next message would then resume `S1` again,
 *      fail again, and the row would never clear → bot becomes silent forever.
 *
 * Acceptance criteria (matches the user's 5-step assertion plan):
 *   1. Force an SDK error after it emits a sessionId
 *   2. Assert DB `sessions` row is unchanged
 *   3. Assert in-memory `sessions[key]` is unchanged
 *   4. Restart process (re-hydrate from DB)
 *   5. Assert hydration does not restore the failed sessionId
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, getAllSessions, setSession } from './db.js';
import { persistSessionIfSuccess } from './index.js';
import type { ContainerOutput } from './container-runner.js';

const GROUP = 'telegram_main';
const DEAD_ID = 'fd66c454-dead-dead-dead-deaddeaddead';
const GOOD_ID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  _initTestDatabase();
});

describe('persistSessionIfSuccess (error-path guard)', () => {
  it('does NOT persist when the run errored, even if newSessionId is set', () => {
    const sessions: Record<string, string> = {};

    // 1. Force an SDK error after it emits a sessionId.
    const errorOutput: ContainerOutput = {
      status: 'error',
      result: null,
      newSessionId: DEAD_ID,
      error:
        'Claude Code returned an error result: No conversation found with session ID: ' +
        DEAD_ID,
    };
    persistSessionIfSuccess(errorOutput, GROUP, sessions);

    // 2. Assert DB session row is unchanged (empty).
    expect(getAllSessions()[GROUP]).toBeUndefined();

    // 3. Assert in-memory sessions[key] is unchanged (empty).
    expect(sessions[GROUP]).toBeUndefined();

    // 4. Restart process — re-hydrate the map from DB the same way
    //    src/index.ts:loadState does on boot.
    const hydrated: Record<string, string> = getAllSessions();

    // 5. Assert hydration does not restore the failed sessionId.
    expect(hydrated[GROUP]).toBeUndefined();
    expect(hydrated[GROUP]).not.toBe(DEAD_ID);
  });

  it('DOES persist when the run succeeded', () => {
    const sessions: Record<string, string> = {};
    const successOutput: ContainerOutput = {
      status: 'success',
      result: 'hi there',
      newSessionId: GOOD_ID,
    };
    persistSessionIfSuccess(successOutput, GROUP, sessions);
    expect(sessions[GROUP]).toBe(GOOD_ID);
    expect(getAllSessions()[GROUP]).toBe(GOOD_ID);

    // And after a "restart" — hydration restores it correctly.
    const hydrated: Record<string, string> = getAllSessions();
    expect(hydrated[GROUP]).toBe(GOOD_ID);
  });

  it('does NOT overwrite a previously-persisted GOOD id with a later error-path id', () => {
    // Seed: a prior successful run already persisted GOOD_ID.
    setSession(GROUP, GOOD_ID);
    const sessions: Record<string, string> = { [GROUP]: GOOD_ID };

    // A subsequent run errors out and reports DEAD_ID as its newSessionId.
    const errorOutput: ContainerOutput = {
      status: 'error',
      result: null,
      newSessionId: DEAD_ID,
      error: 'failed-resume on a follow-up message',
    };
    persistSessionIfSuccess(errorOutput, GROUP, sessions);

    // The good id must survive.
    expect(sessions[GROUP]).toBe(GOOD_ID);
    expect(getAllSessions()[GROUP]).toBe(GOOD_ID);

    // And restart-hydration still returns the good id.
    expect(getAllSessions()[GROUP]).toBe(GOOD_ID);
  });

  it('does nothing when output has no newSessionId at all', () => {
    const sessions: Record<string, string> = {};
    const minimalSuccess: ContainerOutput = { status: 'success', result: null };
    persistSessionIfSuccess(minimalSuccess, GROUP, sessions);
    expect(sessions[GROUP]).toBeUndefined();
    expect(getAllSessions()[GROUP]).toBeUndefined();
  });
});
