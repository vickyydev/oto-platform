import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Locator } from '@playwright/test';
import { startConsentLineHarness } from './support/consent-line-harness/server';
import { tFor } from '@/i18n/LanguageContext';

/**
 * SCRUM-767 — ONE TAP ON A "PLEASE CONFIRM" LINE, BOX INCLUDED, TICKS IT ONCE.
 *
 * On the till's own consent screen (the customer's half beside the staff
 * screen on the same iPad) a tap on the small box of a "Please confirm" line
 * ticked and unticked it in one go, while a tap on the words worked. Each line
 * was a <button> with its own toggle wrapped round the Radix checkbox (itself
 * a <button>) with a second toggle: a tap on the box ran the box's handler and
 * then, bubbling, the line's, and the till's toggle flipped the line back. The
 * supervision consent line above the list had the same two handlers; it only
 * ended right because both set the same value. SCRUM-722 found the same shape
 * on the check-in board's consent box.
 *
 * Each line is now one control: a <label> for the checkbox, whose own handler
 * is the only one. These drive the till's components in a real browser with
 * taps, as on the iPad: the box, the words, the line's edge and Space each
 * change a line once; the staff copy that only shows the family's ticks takes
 * none. The paired customer screen, already built as labelled checkboxes, is
 * pinned alongside.
 *
 * Like the header measurements, this file needs a browser: Edge, Chrome or
 * Playwright's Chromium. With none it is skipped and says so.
 */

const { harness, why } = await startConsentLineHarness();
if (!harness) console.warn(`SCRUM-767 consent line review skipped: no browser to tap in (${why})`);
afterAll(async () => { await harness?.close(); });

const CONSENT = tFor('en')('superviseConsent.consentText');
const CONFIRMATIONS = [
  { id: 'confirm-15min', text: 'I will remain within 15 minutes of the venue' },
  { id: 'confirm-no-refund', text: 'I understand early pickup does not qualify for refund' },
  { id: 'confirm-evac', text: 'I acknowledge the emergency evacuation point' },
] as const;

const page = () => harness!.page;
/** The boxes in screen order: the supervision consent first, then each confirmation. */
const box = (at: number) => page().getByRole('checkbox').nth(at);
const words = (text: string) => page().getByText(text, { exact: true });
const ticked = (locator: Locator, value: boolean) =>
  expect.poll(() => locator.isChecked(), { timeout: 1000 }).toBe(value);
const calls = async (): Promise<unknown[]> => JSON.parse((await page().locator('#calls').textContent())!);
const toggled = (id: string) => ({ handler: 'toggleConfirmation', id });
const acked = (value: boolean) => ({ handler: 'consentAck', value });
/** Room for a run of taps on a slow runner; each settles in well under a second. */
const TAPS = 30_000;

/** A tap on the line's own edge, away from the box and the words. */
async function tapEdge(locator: Locator): Promise<void> {
  const line = locator.locator('xpath=..');
  const area = (await line.boundingBox())!;
  await line.tap({ position: { x: area.width - 6, y: area.height - 6 } });
}

describe.skipIf(!harness).each([
  { screen: 'till', what: 'the customer’s half of the till' },
  { screen: 'staff', what: 'the staff’s private copy, when staff tick (no display paired)' },
])('SCRUM-767 $screen — $what', ({ screen }) => {
  beforeEach(async () => { await harness!.open(screen); }, 90_000);

  it('one tap on a confirmation’s small box ticks it once; a second tap unticks it', async () => {
    for (const at of CONFIRMATIONS.keys()) {
      const line = box(at + 1);
      await line.tap(); await ticked(line, true);
      await line.tap(); await ticked(line, false);
      await line.tap(); await ticked(line, true);
    }
    // One toggle per tap: three for each line, never a second from the line round the box.
    expect(await calls()).toEqual(CONFIRMATIONS.flatMap(({ id }) => [toggled(id), toggled(id), toggled(id)]));
  }, TAPS);

  it('one tap on a confirmation’s words, or on the line’s edge, ticks it once', async () => {
    const [first, second] = CONFIRMATIONS;
    await words(first.text).tap(); await ticked(box(1), true);
    await words(first.text).tap(); await ticked(box(1), false);
    await tapEdge(box(2)); await ticked(box(2), true);
    await tapEdge(box(2)); await ticked(box(2), false);
    expect(await calls()).toEqual([toggled(first.id), toggled(first.id), toggled(second.id), toggled(second.id)]);
  }, TAPS);

  it('Space on the focused box toggles a confirmation once, and each box carries its line as its name', async () => {
    const line = box(1);
    await line.focus();
    expect(await line.evaluate((element) => element === document.activeElement)).toBe(true);
    await line.press('Space'); await ticked(line, true);
    await line.press('Space'); await ticked(line, false);
    expect(await calls()).toEqual([toggled('confirm-15min'), toggled('confirm-15min')]);
    for (const { text } of CONFIRMATIONS) expect(await page().getByRole('checkbox', { name: text }).count()).toBe(1);
    expect(await page().getByRole('checkbox', { name: CONSENT }).count()).toBe(1);
  }, TAPS);

  it('the supervision consent line takes one tap on its box, its words or Space, with one call each', async () => {
    const consent = box(0);
    await consent.tap(); await ticked(consent, true);
    await consent.tap(); await ticked(consent, false);
    await words(CONSENT).tap(); await ticked(consent, true);
    await words(CONSENT).tap(); await ticked(consent, false);
    await consent.focus();
    await consent.press('Space'); await ticked(consent, true);
    expect(await calls()).toEqual([acked(true), acked(false), acked(true), acked(false), acked(true)]);
  }, TAPS);
});

describe.skipIf(!harness)('SCRUM-767 staff-readonly — the staff’s copy while the family ticks on their screen', () => {
  beforeEach(async () => { await harness!.open('staff-readonly'); }, 90_000);

  it('a tap on a box or its words ticks nothing: the agreements stay the family’s (SCRUM-764)', async () => {
    // Forced: a disabled box is not "actionable" to Playwright, but a finger still lands on it.
    for (const at of [0, 1, 2, 3]) {
      await expect.poll(() => box(at).isDisabled()).toBe(true);
      await box(at).tap({ force: true });
    }
    // The words carry the read-only note after them here, so they are found by what they start with.
    await page().getByText(CONSENT).first().tap({ force: true });
    for (const { text } of CONFIRMATIONS) await page().getByText(text).first().tap({ force: true });
    for (const at of [0, 1, 2, 3]) await ticked(box(at), false);
    expect(await calls()).toEqual([]);
  }, TAPS);
});

describe.skipIf(!harness)('SCRUM-767 display — the paired customer screen, agreements step', () => {
  beforeEach(async () => {
    await harness!.open('display');
    await page().getByTestId('consent-steps').getByRole('button').nth(2).click();
    await page().getByRole('checkbox').first().waitFor();
  }, 90_000);

  it('the box, the words and Space each tick a confirmation once', async () => {
    const [first, second, third] = CONFIRMATIONS;
    await box(1).tap(); await ticked(box(1), true);
    await box(1).tap(); await ticked(box(1), false);
    await words(second.text).tap(); await ticked(box(2), true);
    await words(second.text).tap(); await ticked(box(2), false);
    await box(3).focus();
    await box(3).press('Space'); await ticked(box(3), true);
    expect(await page().getByRole('checkbox', { name: first.text }).count()).toBe(1);
    expect(await page().getByRole('checkbox', { name: third.text }).count()).toBe(1);
  }, TAPS);

  it('the supervision consent takes one tap on its box or its words', async () => {
    await box(0).tap(); await ticked(box(0), true);
    await words(CONSENT).tap(); await ticked(box(0), false);
  }, TAPS);
});
