import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRefusalBackOff, REREGISTER_WINDOW_MS } from '../src/reregister';

/**
 * A refused credential cannot cost more than one registration a minute
 * (SCRUM-331).
 *
 * **What this file drives, and what it cannot.** It drives the rule, with the
 * cloud's answers faked by a counting `register()` and the clock supplied by
 * hand — the same two things `agent.ts` puts around it. It does NOT build
 * `createBoxAgent`: that file reaches `printing/index.ts`, which imports
 * `@oto/print`, which this package's runner cannot load at all (Node's
 * strip-only mode refuses `Bitmap1`'s parameter properties — measured, the
 * error is `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). It is the same wall
 * `booth.test.ts` and `print-restart.test.ts` describe. The agent wired to a
 * fake transport, refusing three times and registering once, is proved in
 * `apps/api/test/virtual-box-lease.test.ts`, where vitest transpiles properly.
 */

/**
 * The refusal path as `agent.ts` runs it: ask the back-off, register when it
 * says so, tell it when the registration succeeded.
 */
function refusalPath(opts: { registerSucceeds?: () => boolean } = {}) {
  const backOff = createRefusalBackOff();
  const succeeds = opts.registerSucceeds ?? (() => true);
  let registrations = 0;
  const logs: string[] = [];
  return {
    logs,
    registrations: () => registrations,
    /** One 401 from the cloud, at `now`. Returns true when it re-registered. */
    refused(now: number): boolean {
      const verdict = backOff.refused(now);
      if (!verdict.register) {
        logs.push(
          `${verdict.swallowed} refusal${verdict.swallowed === 1 ? '' : 's'} inside the back-off window`,
        );
        return false;
      }
      registrations += 1;
      if (succeeds()) backOff.registered();
      return true;
    },
  };
}

const AT = Date.parse('2026-09-23T05:00:00.000Z');

test('three refusals inside the window cost one registration, and the next window costs a second', () => {
  const box = refusalPath();

  assert.equal(box.refused(AT), true);
  assert.equal(box.registrations(), 1);

  // The cloud goes on refusing — the other agent registered a moment ago and
  // took this box's secret with it.
  assert.equal(box.refused(AT + 5_000), false);
  assert.equal(box.refused(AT + 10_000), false);
  assert.equal(box.registrations(), 1);

  // A refusal at the very edge of the window is still inside it.
  assert.equal(box.refused(AT + REREGISTER_WINDOW_MS - 1), false);
  assert.equal(box.registrations(), 1);

  // Past it, the door opens again: a rotated claim code brings a box back
  // within a minute, which is the behaviour the window must not cost.
  assert.equal(box.refused(AT + REREGISTER_WINDOW_MS), true);
  assert.equal(box.registrations(), 2);
});

test('a successful registration restarts the count, and the window still holds', () => {
  const box = refusalPath();

  box.refused(AT);
  box.refused(AT + 1_000);
  box.refused(AT + 2_000);
  assert.deepEqual(box.logs, [
    '1 refusal inside the back-off window',
    '2 refusals inside the back-off window',
  ]);

  // Past the window: registers again, and that success resets the count.
  assert.equal(box.refused(AT + REREGISTER_WINDOW_MS + 1_000), true);
  box.refused(AT + REREGISTER_WINDOW_MS + 2_000);
  assert.equal(
    box.logs[box.logs.length - 1],
    '1 refusal inside the back-off window',
    'the count starts from one after a box is registered again',
  );
  assert.equal(box.registrations(), 2);
});

test('a registration that fails does not reopen the door', () => {
  // The virtual box mints its own claim code, but a Pi whose code an
  // administrator has not issued yet gets nothing back. It must wait its
  // window like any other refusal rather than hammering `/register`.
  const box = refusalPath({ registerSucceeds: () => false });

  assert.equal(box.refused(AT), true);
  assert.equal(box.refused(AT + 1_000), false);
  assert.equal(box.refused(AT + 30_000), false);
  assert.equal(box.registrations(), 1);
  // The swallowed count is not reset by a registration that did not land, so
  // the log reads as one unbroken episode.
  assert.deepEqual(box.logs, [
    '1 refusal inside the back-off window',
    '2 refusals inside the back-off window',
  ]);
});

test('a clock that steps backwards does not shut the door for hours', () => {
  const box = refusalPath();

  assert.equal(box.refused(AT), true);
  // NTP corrects a Pi with no clock battery an hour backwards: the window
  // cannot be measured, so the refusal is honoured.
  assert.equal(box.refused(AT - 3_600_000), true);
  assert.equal(box.registrations(), 2);
});
