import assert from 'node:assert/strict';
import { test } from 'node:test';

import { POINTER_IDLE_MS, createPointerIdle } from '../src/pointer-idle.ts';

/**
 * SCRUM-419 (closing audit L34) — the kiosk's pointer does not sit on the
 * wheel all day. Hidden after a few seconds without movement, back the moment
 * it moves. The clock is run by hand: no DOM, no waiting.
 */
function handClock() {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; fire: () => void }>();
  return {
    setTimer: (fire: () => void, ms: number): unknown => {
      next += 1;
      pending.set(next, { at: now + ms, fire });
      return next;
    },
    clearTimer: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    to(at: number): void {
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= at)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fire();
      }
      now = at;
    },
  };
}

test('the pointer is hidden once nobody has moved it, and shown again when it moves', () => {
  const clock = handClock();
  const states: boolean[] = [];
  const idle = createPointerIdle({
    setHidden: (hidden) => states.push(hidden),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  clock.to(POINTER_IDLE_MS - 1);
  assert.deepEqual(states, [], 'hidden before the idle time ran out');
  clock.to(POINTER_IDLE_MS);
  assert.deepEqual(states, [true]);
  idle.moved();
  assert.deepEqual(states, [true, false], 'a movement did not bring the pointer back');
  // Moving keeps it up; only stillness hides it again.
  clock.to(POINTER_IDLE_MS + 2_000);
  idle.moved();
  clock.to(POINTER_IDLE_MS + 2_000 + POINTER_IDLE_MS - 1);
  assert.deepEqual(states, [true, false]);
  clock.to(POINTER_IDLE_MS + 2_000 + POINTER_IDLE_MS);
  assert.deepEqual(states, [true, false, true]);
  idle.stop();
  clock.to(60_000);
  assert.deepEqual(states, [true, false, true], 'a stopped timer still fired');
});
