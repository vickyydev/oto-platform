import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startConsentHarness, type ConsentHarness } from '../../pos/test/support/consent-harness/server';

/** SCRUM-722: attack the real dialog in a browser, not a copy of its handlers.
 * Two FINDINGs reproduced false instead of true for a click and Space.
 * The prescribed labelled checkbox with one handler is now pinned below.
 * Server consent behavior is covered by checkin-board, s708-consent-review
 * and s723-forced-offline-review in the same release battery. */
let harness: ConsentHarness;
const sentence = /^Parent \/ guardian authorizes Oto Play Park/;
const box = () => harness.page.getByRole('checkbox');
const confirm = () => harness.page.getByRole('button', { name: 'Check in & issue band', exact: true });
const selected = (value: boolean) => expect.poll(() => box().isChecked(), { timeout: 1000 }).toBe(value);
const enabled = (value: boolean) => expect.poll(() => confirm().isEnabled()).toBe(value);

beforeAll(async () => { harness = await startConsentHarness(); }, 90_000);
beforeEach(async () => { await harness.open(); }, 40_000);
afterAll(async () => { await harness?.close(); });

describe('SCRUM-722: each consent target changes the acknowledgement once', () => {
  it('HIGH pin: the small checkbox toggles once and submits only acknowledged consent', async () => {
    await enabled(false);
    await box().click(); await selected(true); await enabled(true);
    await box().click(); await selected(false); await enabled(false);
    await box().click(); await selected(true);
    await confirm().click();
    expect(JSON.parse((await harness.page.locator('#confirmed').textContent())!)).toEqual([
      [{ checkInId: 'zz-test-child', confirmationsAccepted: true }],
    ]);
  });

  it('MEDIUM pin: Space toggles the single labelled control once', async () => {
    await box().focus();
    await box().press('Space'); await selected(true); await enabled(true);
    await box().press('Space'); await selected(false); await enabled(false);
    expect(await harness.page.getByRole('checkbox', { name: sentence }).count()).toBe(1);
  });

  it('clicking the consent sentence changes the acknowledgement once in either direction', async () => {
    await harness.page.getByText(sentence).click(); await selected(true); await enabled(true);
    await harness.page.getByText(sentence).click(); await selected(false); await enabled(false);
  });

  it('acknowledgement cannot bypass a missing photo', async () => {
    await harness.open('?missingPhoto');
    await harness.page.getByText(sentence).click(); await selected(true); await enabled(false);
    expect(await harness.page.locator('#confirmed').textContent()).toBe('[]');
  });

  it('closing and reopening asks for a fresh acknowledgement', async () => {
    await harness.page.getByText(sentence).click(); await selected(true);
    await harness.page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await harness.page.getByRole('button', { name: 'Open booked arrival', exact: true }).click();
    await selected(false); await enabled(false);
  });

  it('existing consent is not asked for again or replaced by a new acknowledgement', async () => {
    await harness.open('?recorded');
    expect(await box().count()).toBe(0); await enabled(true);
    await confirm().click();
    expect(JSON.parse((await harness.page.locator('#confirmed').textContent())!)).toEqual([[{ checkInId: 'zz-test-child' }]]);
  });
});
