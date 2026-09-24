import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PANEL_IDLE_MS, PANEL_OPEN_CAP_MS, createPanelTimer } from '../src/panel-timer.ts';
import { isButtonKey } from '../src/press.ts';

/**
 * SCRUM-223 — the staff panel closes itself, and a guest pressing the red
 * button cannot keep it up.
 *
 * The red button and the space bar send the same key. Pressed while the
 * password box had the keyboard, it typed a space into the password, the
 * countdown restarted on the change, and the form — which holds the wheel
 * while it has the keyboard — stayed up for as long as guests kept pressing
 * (the gate measured 92 s with a press every 15 s). The countdown now ignores
 * the button's key, and a cap closes the panel whatever is typed.
 *
 * The clock is run by hand: no DOM, no React, no real waiting.
 */

const SPACE = { key: ' ', code: 'Space' };
const LETTER = { key: 'a', code: 'KeyA' };
const S = 1_000;

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
    /** Move to `at`, firing whatever falls due on the way, in order. */
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
    now: () => now,
  };
}

function panel(buttonKey = 'Space') {
  const clock = handClock();
  const closes: number[] = [];
  const timer = createPanelTimer({
    onClose: () => closes.push(clock.now()),
    isButtonKey: (event) => isButtonKey(event, buttonKey),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, closes, timer };
}

test('guests pressing the button into the form do not keep it open', () => {
  const { clock, closes, timer } = panel();
  timer.open();
  // One press every fifteen seconds, as the gate did on the television.
  for (let at = 15 * S; at <= 90 * S; at += 15 * S) {
    clock.to(at);
    timer.key(SPACE);
  }
  assert.deepEqual(closes, [PANEL_IDLE_MS], 'closed 45 s after it opened, however often the button was pressed');
});

test('a key that is not the button restarts the idle countdown; the button never does', () => {
  const { clock, closes, timer } = panel();
  timer.open();
  clock.to(40 * S);
  timer.key(LETTER);
  clock.to(80 * S);
  timer.key(SPACE);
  clock.to(84 * S);
  assert.deepEqual(closes, [], 'open until 45 s after the letter');
  clock.to(86 * S);
  assert.deepEqual(closes, [40 * S + PANEL_IDLE_MS]);
});

test('staff typing keep it open, but never past the cap', () => {
  const { clock, closes, timer } = panel();
  timer.open();
  for (let at = 20 * S; at <= 200 * S; at += 20 * S) {
    clock.to(at);
    timer.key(LETTER);
  }
  assert.equal(PANEL_OPEN_CAP_MS, 120 * S, 'two minutes');
  assert.deepEqual(closes, [PANEL_OPEN_CAP_MS], 'closed at the cap with somebody still typing');
});

test('the button is whatever key the booth is set to, and never Enter', () => {
  const { clock, closes, timer } = panel('KeyF');
  timer.open();
  clock.to(40 * S);
  timer.key({ key: 'f', code: 'KeyF' });
  clock.to(46 * S);
  assert.deepEqual(closes, [PANEL_IDLE_MS], 'this booth’s button is F, and F did not keep it open');

  const spaceBooth = panel('KeyF');
  spaceBooth.timer.open();
  spaceBooth.clock.to(40 * S);
  spaceBooth.timer.key(SPACE);
  spaceBooth.clock.to(46 * S);
  assert.deepEqual(spaceBooth.closes, [], 'on that booth a space is typing');

  // A badge scan ends in Enter, and Enter is never the button, whatever is configured.
  assert.equal(isButtonKey({ key: 'Enter', code: 'Enter' }, 'Enter'), false);
  assert.equal(isButtonKey({ key: 'Enter', code: 'NumpadEnter' }, 'NumpadEnter'), false);
});

test('signing in turns the panel into staff’s buttons, with both countdowns from then', () => {
  const { clock, closes, timer } = panel();
  timer.open();
  // A slow sign-in: somebody typing until the answer comes, a hundred seconds in.
  for (let at = 30 * S; at <= 90 * S; at += 30 * S) {
    clock.to(at);
    timer.key(LETTER);
  }
  clock.to(100 * S);
  timer.open();
  clock.to(PANEL_OPEN_CAP_MS + S);
  assert.deepEqual(closes, [], 'the form’s cap does not close the signed-in panel');
  clock.to(146 * S);
  assert.deepEqual(closes, [100 * S + PANEL_IDLE_MS]);
});

test('a panel closed by hand has nothing left to fire, and a key does not bring a countdown back', () => {
  const { clock, closes, timer } = panel();
  timer.open();
  clock.to(10 * S);
  timer.stop();
  timer.key(LETTER);
  timer.touch();
  clock.to(300 * S);
  assert.deepEqual(closes, []);
});
