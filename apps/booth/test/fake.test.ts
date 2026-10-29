import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { fakeDutyLabel } from '../src/booth/fake-roster.ts';

/**
 * SCRUM-694 — the fake booth names today's roster and signs nobody in.
 *
 * The fake itself cannot be loaded under Node's strip-only test runner: it
 * imports `@oto/shared` and its neighbours without file extensions, which
 * only the bundler resolves. So its roster label is asserted through the
 * import-free helper it prints from (`src/booth/fake-roster.ts`), and the rest
 * of its shape — no sign-in, no account on a spin, a reprint refused only for
 * having nothing to reprint — is asserted on its source. Both are honest: the
 * label is the same function the fake calls, and the source is what ships.
 */

const source = readFileSync(new URL('../src/booth/fake.ts', import.meta.url), 'utf8');

test('the status and every spin carry today’s roster: “Demo staff”, or nobody with #no-roster', () => {
  assert.equal(fakeDutyLabel(false), 'Demo staff');
  assert.equal(fakeDutyLabel(true), null);
  assert.match(source, /dutyLabel: fakeDutyLabel\(flags\.noRoster\)/);
  // The real press and the simulated one both answer the label.
  assert.equal(source.match(/staffLabel: fakeDutyLabel\(flags\.noRoster\)/g)?.length, 2);
});

test('nobody signs in: no sign-in, no session, no account on a spin, no staff on the status', () => {
  for (const gone of ['staffSignedIn', 'staffAccountId', 'signIn(', 'signOut(', 'getStaff(', 'signOnAs(']) {
    assert.equal(source.includes(gone), false, `${gone} is gone from the fake`);
  }
});

test('a reprint is refused only for having nothing to reprint — anyone may ask for one', () => {
  assert.match(source, /throw new BoothCallError\('nothing_to_reprint', 404\)/);
  assert.equal(source.includes('staff_required'), false);
  // It picks the voucher with the box's own rule, so the panel a held button
  // opened (`beforeSpinId`) reprints the same slip on the fake as on a box;
  // the rule itself is tested in @oto/shared (booth-reprint.test.ts).
  assert.match(source, /boothReprintTarget\(this\.recentVouchers, request\)/);
});
