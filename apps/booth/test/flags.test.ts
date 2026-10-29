import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseHash, withoutHandoff } from '../src/flags.ts';

/**
 * SCRUM-694 — a launcher hand-off left in the address by a tab opened before
 * the booth stopped signing anybody in.
 *
 * Rewritten from the SCRUM-528 sign-on test: the page no longer reads or
 * exchanges the token, but it still scrubs it from the fragment, keeps the
 * stage flags, and opens the demonstration wheel that tab expected.
 */

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJqdGkiOiJ4In0.Ab-c_D';

test('scrubs the hand-off from the fragment and keeps the stage flags', () => {
  assert.equal(withoutHandoff(`#handoff=${TOKEN}`), '');
  assert.equal(withoutHandoff(`#cw,handoff=${TOKEN},lite`), '#cw,lite');
  assert.equal(withoutHandoff('#fake,debug'), '#fake,debug');
  assert.equal(withoutHandoff(''), '');
});

test('a stale hand-off is noticed, and nothing else is one', () => {
  assert.equal(parseHash(`#handoff=${TOKEN}`).staleHandoff, true);
  assert.equal(parseHash(`#cw,handoff=${TOKEN}`).staleHandoff, true);
  assert.equal(parseHash('#debug').staleHandoff, false);
  assert.equal(parseHash('').staleHandoff, false);
});

test('#no-roster is the fake’s only roster switch, and #debug opens directly', () => {
  assert.equal(parseHash('#fake,no-roster').noRoster, true);
  assert.equal(parseHash('#fake').noRoster, false);
  assert.equal(parseHash('#debug').debug, true);
  assert.equal(parseHash('#not-debug').debug, false);
});
