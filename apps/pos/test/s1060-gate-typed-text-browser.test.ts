import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startFamilyFormHarness } from './support/family-form-harness/server';

/**
 * SCRUM-1060 (3) — STAFF'S DESK GATE: A TYPED NAME IS THE BOX'S OWN SIZE AT
 * EVERY WIDTH, MEASURED IN A BROWSER.
 *
 * The "Children playing alone" gate's "Child's name" box is drawn at
 * `text-lg` (18px), but the till's plain `Input` drops its type to
 * `md:text-sm` from 768px up, so a name typed on the counter till read 14px
 * inside the large box — the cause SCRUM-1059 put right on the family's form
 * (`typedTextClass`). The box repeats its size at `md:`. It is the gate's only
 * text box: the age is a picker of buttons, the photo choice buttons too.
 *
 * `support/family-form-harness` draws the gate with the till's own component
 * (`?screen=gate`: the phone till's step; `&desk=1`: the counter till's) in a
 * real browser (Edge, Chrome or Playwright's Chromium; with none the file is
 * skipped and says so) and reads the type size the browser gives what is
 * typed. FAMILYFORM_SHOTS=<dir> also writes each screen to look at.
 */
const SHOTS = process.env.FAMILYFORM_SHOTS;
const { harness, why } = await startFamilyFormHarness();
if (!harness) console.warn(`SCRUM-1060 gate typed text measurement skipped: no browser to lay the gate out (${why})`);
afterAll(async () => { await harness?.close(); });

const SCREENS = [
  { query: 'screen=gate', size: { width: 390, height: 844 }, name: 'phone 390' },
  { query: 'screen=gate', size: { width: 768, height: 1024 }, name: 'phone till at 768' },
  { query: 'screen=gate&desk=1', size: { width: 768, height: 1024 }, name: 'desk 768' },
  { query: 'screen=gate&desk=1', size: { width: 1024, height: 768 }, name: 'desk 1024' },
  { query: 'screen=gate&desk=1', size: { width: 1440, height: 900 }, name: 'desk 1440' },
] as const;

describe.skipIf(!harness)("SCRUM-1060 (3): the gate's typed name keeps its 18px", () => {
  for (const screen of SCREENS) {
    it(`${screen.name}: what is typed in "Child's name" is 18px, the box's own size`, async () => {
      const page = await harness!.open(screen.query, screen.size, { touch: !screen.query.includes('desk') });
      const name = page.getByPlaceholder("Child's name");
      await name.fill('ZZ TEST Mai');
      expect(await name.evaluate((box) => getComputedStyle(box).fontSize)).toBe('18px');
      // The gate has no other box to type in.
      expect(await page.locator('input:not([type=hidden]), textarea').count()).toBe(1);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `gate-${screen.name.replaceAll(' ', '-')}.png`) });
    }, 120_000);
  }
});
