import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BOOTH_ERROR_CODES } from '../src/booth/contract.ts';
import {
  COPY,
  KIOSK_COPY,
  NO_WHEEL_COPY,
  STAFF_COPY,
  noWheelScreen,
  refusalLine,
} from '../src/copy.ts';

/**
 * What the television says when a press is refused, and while the booth has
 * no wheel — the words, chosen by the refusal's code and by whether the box
 * has the internet (`refusalLine` and `noWheelScreen` in src/copy.ts).
 *
 * Two lines used to be wrong in a way a person at the booth would act on:
 *
 *  - a retried press the box had already recorded (`duplicate_press`) was not
 *    a code the page knew, so it ended on "Booth not ready — please call
 *    staff" while the slip came out of the printer;
 *  - an online box whose booth nobody had published yet said "Booth not set
 *    up, connect to internet", beside a green online dot.
 */

const EVERY_LINK_STATE = [true, false, null] as const;

test('a press the box already recorded says the voucher is being printed, never "Booth not ready"', () => {
  // The client keeps only the codes this list names; anything else reaches
  // the page as null and ends on the fixed line.
  assert.ok(
    (BOOTH_ERROR_CODES as readonly string[]).includes('duplicate_press'),
    'the page knows the code, so the client does not turn it into null',
  );
  for (const online of EVERY_LINK_STATE) {
    const line = refusalLine('duplicate_press', online);
    assert.deepEqual(line, COPY.voucherPrinting, `online: ${String(online)}`);
    assert.notDeepEqual(line, COPY.notReady);
  }
  assert.equal(
    COPY.voucherPrinting.en,
    'Your voucher is being printed — ask our staff if it does not come out',
  );
  assert.notEqual(COPY.voucherPrinting.th.trim(), '', 'a Thai line as well, like every guest line');
});

test('no wheel and no internet: "connect to internet", and nothing for staff to publish', () => {
  const screen = noWheelScreen(false);
  assert.deepEqual(screen.guest, COPY.notSetUp);
  assert.match(screen.guest.en, /connect to internet/);
  assert.equal(screen.staff, null);
});

test('no wheel and online: nobody is sent to the network — staff are told to publish it', () => {
  const screen = noWheelScreen(true);
  assert.deepEqual(screen.guest, KIOSK_COPY.guest, 'the guest is asked to fetch staff');
  assert.doesNotMatch(screen.guest.en, /internet/i);
  assert.doesNotMatch(screen.guest.th, /อินเทอร์เน็ต/);
  assert.deepEqual(screen.staff, NO_WHEEL_COPY);
  assert.match(NO_WHEEL_COPY.title, /No wheel published/);
  assert.match(NO_WHEEL_COPY.hint, /Console → Booths/);
});

test('no wheel, and the box has not answered yet: the guest line alone, no instruction to staff', () => {
  const screen = noWheelScreen(null);
  assert.deepEqual(screen.guest, KIOSK_COPY.guest);
  assert.equal(screen.staff, null);
});

test('a press refused for having no wheel follows the same rule as the screen', () => {
  assert.deepEqual(refusalLine('not_configured', false), COPY.notSetUp);
  assert.deepEqual(refusalLine('not_configured', true), KIOSK_COPY.guest);
  assert.deepEqual(refusalLine('not_configured', null), KIOSK_COPY.guest);
});

test('the other refusals keep their lines', () => {
  for (const online of EVERY_LINK_STATE) {
    assert.deepEqual(refusalLine('daily_spin_cap_reached', online), COPY.allSpinsGone);
    // D5's refusal, a failure with no code, and the box not answering at all.
    assert.deepEqual(refusalLine('booth_not_ready', online), COPY.notReady);
    assert.deepEqual(refusalLine(null, online), COPY.notReady);
    assert.deepEqual(refusalLine('unreachable', online), COPY.notReady);
  }
});

test('the new box’s hint names the two-character code prefix a booth needs', () => {
  assert.match(KIOSK_COPY.noBoothHint, /code prefix of two letters or digits/);
  assert.match(KIOSK_COPY.noBoothHint, /kind Booth/);
});

test('the PIN pad asks for a PIN, not a badge nothing can check yet', () => {
  assert.equal(STAFF_COPY.signInHint, 'Enter your PIN');
  assert.doesNotMatch(STAFF_COPY.signInHint, /badge/i);
});
