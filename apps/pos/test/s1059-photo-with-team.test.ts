import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { DICTIONARY as dictionary } from '@/i18n/dictionary';
import { photoWithTeamLine, type ConsentMissing } from '@/lib/consentFinish';
import { startFamilyFormHarness } from './support/family-form-harness/server';

/**
 * SCRUM-1059 (7) — THE FAMILY IS TOLD THE TEAM IS CHECKING THE PHOTO.
 *
 * On a returning family's short form, a child's last photo is staff's to
 * compare on the till ("Still matches" or "Take a new one"), and the
 * "Still needed before Done" line does not name it (`photoWithStaff`,
 * SCRUM-1053). Once the agreements were ticked the line was empty while Done
 * stayed grey (staging's b1). The line now says the team is checking the
 * photo and there is nothing more for the family to do; when staff decide it
 * clears ("Still matches") or names the photo as before ("Take a new one").
 * The till's own customer half says the same in the same case.
 */

const en = (key: string) => (dictionary as Record<string, Record<string, string>>)[key]?.en ?? key;
const LINE = en('superviseConsent.photoWithTeam');

describe('SCRUM-1059 (7): the line, worked out', () => {
  const none: ConsentMissing[] = [];
  it('only when nothing of the family is missing and the photo is with staff', () => {
    expect(photoWithTeamLine(en, { missing: none, consentRequired: true, photoWithStaff: true })).toBe(LINE);
    expect(photoWithTeamLine(en, { missing: ['confirmations'], consentRequired: true, photoWithStaff: true })).toBeNull();
    expect(photoWithTeamLine(en, { missing: none, consentRequired: true, photoWithStaff: false })).toBeNull();
    expect(photoWithTeamLine(en, { missing: none, consentRequired: false, photoWithStaff: true })).toBeNull();
  });

  it("in each of the form's five languages", () => {
    const entry = (dictionary as Record<string, Record<string, string>>)['superviseConsent.photoWithTeam']!;
    expect(Object.keys(entry).sort()).toEqual(['en', 'fr', 'ru', 'th', 'zh']);
    expect(entry.en).toBe('The team is checking the photo — there is nothing more for you to do.');
    for (const text of Object.values(entry)) expect(text.trim().length).toBeGreaterThan(10);
  });

  it('both forms put it after what the family still has to do', () => {
    const src = (file: string) => readFileSync(new URL(`../src/components/till/${file}`, import.meta.url), 'utf8');
    expect(src('PublicConsentCapture.tsx')).toContain(
      "const doneLine = careLine ?? missingLine ?? (slowSend ? t('display.sending') : null) ?? teamPhotoLine;");
    expect(src('PublicConsentCapture.tsx')).toContain('photoWithStaff: prompt.photoWithStaff === true });');
    const half = src('ConsentCapture.tsx');
    expect(half).toContain('careLine ?? consentMissingLine(t, familyMissing, CHANNEL_LABEL[parentContactMethod]) ?? teamPhotoLine');
    expect(half).toContain('photoWithStaff: !doneReady && rows.some((r) => r.needsConsent && !r.slot.childPhotoUrl && photoAtTillFor.includes(r.slot.id)) });');
  });
});

const SHOTS = process.env.FAMILYFORM_SHOTS;
const { harness, why } = await startFamilyFormHarness();
if (!harness) console.warn(`SCRUM-1059 photo line skipped: no browser to draw the form (${why})`);
afterAll(async () => { await harness?.close(); });

/** The agreements filled and every tick given, as a family that has done everything. */
async function finish(page: Page): Promise<string> {
  await page.getByTestId('consent-guardian').fill('ZZ TEST guardian');
  for (const box of await page.getByRole('checkbox').all()) {
    if ((await box.getAttribute('data-state')) !== 'checked') await box.click();
  }
  await page.waitForTimeout(600);
  return (await page.getByTestId('consent-missing').textContent()) ?? '';
}

describe.skipIf(!harness)("the family's form with the photo at the till (SCRUM-1059 7)", () => {
  for (const [size, theme] of [[{ width: 600, height: 1024 }, 'dark'], [{ width: 600, height: 1024 }, 'light'], [{ width: 768, height: 1024 }, 'dark']] as const) {
    it(`at ${size.width}x${size.height}, ${theme}: the line says the team is checking the photo; Done waits`, async () => {
      const page = await harness!.open(`screen=display&step=agreements&short=1&photoWithStaff=1&theme=${theme}`, size);
      expect(await finish(page)).toBe(LINE);
      expect(await page.getByRole('button', { name: 'Done' }).isDisabled()).toBe(true);
      // The line is one line of the bar, inside the screen.
      const box = (await page.getByTestId('consent-missing').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `photo-with-team-${size.width}-${theme}.png`) });
    }, 60_000);
  }

  it('without the photo at the till the line names the photo, as before', async () => {
    const page = await harness!.open('screen=display&step=agreements&short=1', { width: 600, height: 1024 });
    expect(await finish(page)).toBe(`Still needed before Done: ${en('superviseConsent.missingPhoto')}`);
  }, 60_000);
});
