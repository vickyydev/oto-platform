import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkSettings,
  createGateController,
  creditingUnread,
  GATE_GRACE_MS,
} from '../src/gate/controller';
import { HX_X1_FACTORY } from '../src/gate/ge-x2';

/**
 * Crediting and fault inference (S2-12 round 2, plan §2.4, OD-A13), over a
 * clock the test moves by hand.
 */

function setup(over: { heldOpenAfterMs?: number } = {}) {
  let t = 1_000_000;
  let n = 0;
  const c = createGateController({ now: () => t, mintId: () => `p${++n}`, ...over });
  return {
    c,
    at: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

const ADULT = { direction: 'entry' as const, bandId: 'band-1', offline: false, revoked: false };

test('the window is open duration (L-1) + close delay (L-3) + grace, from what the board said', () => {
  const { c } = setup();
  // Nothing read yet: HX-X1's factory values.
  assert.equal(
    c.windowMs(),
    HX_X1_FACTORY.openDurationS * 1000 + HX_X1_FACTORY.closeDelayDs * 100 + GATE_GRACE_MS,
  );
  c.applySettings({ openDurationS: 8, closeDelayDs: 5 }, {});
  assert.equal(c.windowMs(), 8000 + 500 + GATE_GRACE_MS);
});

test('one pending open per side: a second open on that side is refused, the other side is free', () => {
  const { c } = setup();
  assert.equal(c.claim({ ...ADULT, side: 'left' }).ok, true);
  const second = c.claim({ ...ADULT, bandId: 'band-2', side: 'left' });
  assert.deepEqual(second, { ok: false, reason: 'GATE_BUSY', expired: [] });
  assert.equal(c.claim({ ...ADULT, bandId: 'band-3', direction: 'exit', side: 'right' }).ok, true);
});

test('a claim that finds an open past its window hands its timeout back, never drops it', () => {
  const { c, advance } = setup();
  const first = c.claim({ ...ADULT, side: 'left' });
  assert.ok(first.ok);
  advance(c.windowMs() + 1);
  const next = c.claim({ ...ADULT, bandId: 'band-2', side: 'left' });
  assert.ok(next.ok);
  assert.equal(next.expired.length, 1);
  const [o] = next.expired;
  assert.equal(o?.type, 'timeout');
  assert.equal(o?.type === 'timeout' && o.pending.id, first.pending.id);
});

test('the next passed feedback on the side within the window is credited to the pending open', () => {
  const { c, advance } = setup();
  const claim = c.claim({ ...ADULT, side: 'left' });
  assert.ok(claim.ok);
  advance(3000);
  const out = c.onFeedback({ kind: 'passed', side: 'left' });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.type, 'passed');
  assert.equal(out[0]?.type === 'passed' && out[0].pending.bandId, 'band-1');
  assert.equal(c.pending('left'), null);
});

test('feedback on the OTHER side is not credited to this open', () => {
  const { c } = setup();
  c.claim({ ...ADULT, side: 'left' });
  const out = c.onFeedback({ kind: 'passed', side: 'right' });
  assert.deepEqual(
    out.map((o) => o.type),
    ['uncredited_passage'],
  );
  assert.notEqual(c.pending('left'), null);
});

test('feedback outside the window is credited to no one; the open ends as an inferred timeout', () => {
  const { c, advance } = setup();
  c.claim({ ...ADULT, side: 'left' });
  advance(c.windowMs() + 1);
  const out = c.onFeedback({ kind: 'passed', side: 'left' });
  assert.deepEqual(
    out.map((o) => o.type),
    ['timeout', 'uncredited_passage'],
  );
  assert.equal(out[0]?.type === 'timeout' && out[0].inferred, true);
});

test('a board timeout ends the open with nobody credited; "in lane" is kept', () => {
  const { c } = setup();
  c.claim({ ...ADULT, side: 'right', direction: 'exit' });
  const [o] = c.onFeedback({ kind: 'timeout_in_lane', side: 'right' });
  assert.equal(o?.type, 'timeout');
  assert.equal(o?.type === 'timeout' && o.personInLane, true);
  assert.equal(o?.type === 'timeout' && o.inferred, false);
});

test('reverse and tailgating alarms name the pending open, credit nobody, and leave it pending', () => {
  const { c } = setup();
  c.claim({ ...ADULT, side: 'left' });
  const [rev] = c.onFeedback({ kind: 'reverse', side: 'left' });
  assert.equal(rev?.type === 'alarm' && rev.alarm, 'reverse');
  assert.equal(rev?.type === 'alarm' && rev.pending?.bandId, 'band-1');
  const [tail] = c.onFeedback({ kind: 'tailgating', side: 'left' });
  assert.equal(tail?.type === 'alarm' && tail.alarm, 'tailgating');
  // The guest the open was for still passes, and is credited.
  const [passed] = c.onFeedback({ kind: 'passed', side: 'left' });
  assert.equal(passed?.type, 'passed');
});

test('a claim released after a failed open frees the side', () => {
  const { c } = setup();
  const claim = c.claim({ ...ADULT, side: 'left' });
  assert.ok(claim.ok);
  c.release(claim.pending.id);
  assert.equal(c.claim({ ...ADULT, side: 'left' }).ok, true);
});

test('held open with nothing pending: faulted, passages uncredited, opens refused until the door closes', () => {
  const { c, advance } = setup({ heldOpenAfterMs: 5000 });
  c.onDoorState('open_a');
  advance(5000);
  c.onDoorState('open_a');
  assert.equal(c.isHeldOpen(), true);
  assert.deepEqual(c.claim({ ...ADULT, side: 'left' }), {
    ok: false,
    reason: 'GATE_NOT_READY',
    expired: [],
  });
  assert.deepEqual(
    c
      .onFeedback({ kind: 'passed', side: 'left' })
      .map((o) => o.type === 'uncredited_passage' && o.why),
    ['held_open'],
  );
  assert.ok(c.faults().some((f) => f.code === 'held_open'));
  c.onDoorState('closed');
  assert.equal(c.isHeldOpen(), false);
  assert.equal(c.claim({ ...ADULT, side: 'left' }).ok, true);
});

test('a door open while an open is pending is not held open', () => {
  const { c, advance } = setup({ heldOpenAfterMs: 1000 });
  c.claim({ ...ADULT, side: 'left' });
  c.onDoorState('open_a');
  advance(2000);
  c.onDoorState('open_a');
  assert.equal(c.isHeldOpen(), false);
});

test('faults are inferred: silence, stuck initialising, a beam that stays broken, opens with no feedback', () => {
  const { c, advance } = setup();
  c.noteMissedReply();
  c.noteMissedReply();
  assert.equal(c.isAnswering(), true);
  c.noteMissedReply();
  assert.equal(c.isAnswering(), false);
  assert.ok(c.faults().some((f) => f.code === 'not_answering'));
  c.noteReply();
  assert.equal(c.isAnswering(), true);

  c.onDoorState('zero_search');
  advance(31_000);
  c.onDoorState('zero_search');
  assert.ok(c.faults().some((f) => f.code === 'stuck_initialising'));
  c.onDoorState('closed');

  c.onInfraredState('first_point');
  advance(61_000);
  assert.ok(c.faults().some((f) => f.code === 'infrared_fault'));
  c.onInfraredState('clear');
  assert.equal(
    c.faults().some((f) => f.code === 'infrared_fault'),
    false,
  );

  for (let i = 0; i < 3; i += 1) {
    c.claim({ ...ADULT, side: 'left' });
    advance(c.windowMs() + 1);
    c.expire();
  }
  assert.ok(c.faults().some((f) => f.code === 'no_feedback'));
  c.claim({ ...ADULT, side: 'left' });
  c.onFeedback({ kind: 'passed', side: 'left' });
  assert.equal(
    c.faults().some((f) => f.code === 'no_feedback'),
    false,
  );
});

test('the startup read: mismatches against config, memory on or polled-only upload make crediting unsound', () => {
  const good = checkSettings(
    {
      openDurationS: 5,
      workingMode: 0,
      closeDelayDs: 2,
      entryExitMemory: 0,
      tailgatingDetection: 1,
      closeOnTailgating: 0,
      uploadMode: 1,
    },
    { openDurationS: 5, tailgatingDetection: 1 },
  );
  assert.deepEqual(good.mismatches, []);
  assert.equal(good.creditingSound, true);

  const bad = checkSettings(
    { openDurationS: 6, entryExitMemory: 1, uploadMode: 0, workingMode: 1 },
    { openDurationS: 5 },
  );
  assert.deepEqual(bad.mismatches, [{ key: 'openDurationS', expected: 5, actual: 6 }]);
  assert.equal(bad.creditingSound, false);
  assert.equal(bad.notes.length, 3);
  assert.ok(bad.unread.includes('closeDelayDs'));

  const { c } = setup();
  c.applySettings({ entryExitMemory: 1 }, {});
  const codes = c.faults().map((f) => f.code);
  assert.ok(codes.includes('crediting_unsound'));
  assert.ok(codes.includes('settings_unread'));
});

test('noteReply says when the board came back: once, at the end of a silence', () => {
  const { c } = setup();
  assert.equal(c.noteReply(), false);
  c.noteMissedReply();
  c.noteMissedReply();
  // Two misses are not a silence; nothing to come back from.
  assert.equal(c.noteReply(), false);
  for (let i = 0; i < 3; i += 1) c.noteMissedReply();
  assert.equal(c.isAnswering(), false);
  assert.equal(c.noteReply(), true);
  assert.equal(c.isAnswering(), true);
  assert.equal(c.noteReply(), false);
});

test('an entry is trusted to the crediting rule only when it is shown to hold: read, sound, answering, reporting', () => {
  const { c, advance } = setup();
  // Nothing read yet.
  assert.equal(c.creditBlocker(), 'settings_unread');
  assert.deepEqual(creditingUnread(null), ['entryExitMemory', 'uploadMode']);
  // A read the board did not answer (still booting) is not a sound read.
  c.applySettings({ openDurationS: null, entryExitMemory: null, uploadMode: null }, {});
  assert.equal(c.creditBlocker(), 'settings_unread');
  assert.deepEqual(creditingUnread(c.settings()), ['entryExitMemory', 'uploadMode']);
  // L-34 read, L-9 not: still unverified.
  c.applySettings({ entryExitMemory: null, uploadMode: 1 }, {});
  assert.equal(c.creditBlocker(), 'settings_unread');
  assert.deepEqual(creditingUnread(c.settings()), ['entryExitMemory']);
  // What the board DID say wins over what it did not.
  c.applySettings({ entryExitMemory: 1, uploadMode: null }, {});
  assert.equal(c.creditBlocker(), 'crediting_unsound');
  c.applySettings({ entryExitMemory: 0, uploadMode: 0 }, {});
  assert.equal(c.creditBlocker(), 'crediting_unsound');
  // Read and sound.
  c.applySettings({ entryExitMemory: 0, uploadMode: 1 }, {});
  assert.deepEqual(creditingUnread(c.settings()), []);
  assert.equal(c.creditBlocker(), null);
  // A silence, then back.
  for (let i = 0; i < 3; i += 1) c.noteMissedReply();
  assert.equal(c.creditBlocker(), 'not_answering');
  c.noteReply();
  assert.equal(c.creditBlocker(), null);
  // Opens ending with no report while the board answers — until the next report.
  for (let i = 0; i < 3; i += 1) {
    c.claim({ ...ADULT, side: 'left' });
    advance(c.windowMs() + 1);
    c.expire();
  }
  assert.equal(c.creditBlocker(), 'no_feedback');
  c.claim({ ...ADULT, side: 'right', direction: 'exit' });
  c.onFeedback({ kind: 'passed', side: 'right' });
  assert.equal(c.creditBlocker(), null);
});
