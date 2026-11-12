import * as React from 'react';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StepPayment } from '@/components/till/StepPayment';
import { launchBrowser, startSplitViewHarness, type SplitViewHarness } from './support/splitview-harness/server';
import type { Box, Reading } from './support/splitview-harness/measure';

/**
 * SCRUM-884 / SCRUM-918 / SCRUM-901 — THE STAFF SCREENS, MEASURED IN A BROWSER.
 *
 * The split view (the staff till and the customer display side by side on one
 * screen: the test harness, and what the park runs on a single screen) gives
 * the till's wizard column 312px of a 1440 window and 432px of a 1680 one.
 * Staging's proofs of 12 November showed what that did (SCRUM-858 10b, 03b,
 * 01a, 02b; SCRUM-885 01c, 03c): payment names broken letter by letter and
 * Confirm Payment Received below the window, every add-on name cut to one
 * letter, "Out of stock" one word a line, "Add Another Ticket" past its
 * button, the participants' captions cut, one and a half rate cards and the
 * member's name cut to "Z…". And on the Check-in board (SCRUM-886 07a) a
 * Check in naming three children spilled above and below its button.
 *
 * `support/splitview-harness` draws each screen in the till's own frame (its
 * classes are pinned against `pages/Till.tsx` below) at 1440x900 and
 * 1680x1050, staging's chrome above it, and reads the boxes and line boxes the
 * browser laid out. In the split view it asserts that no text is clipped, no
 * word is drawn on two lines, no label runs out of its button, and the
 * screen's own way on (Continue, Confirm Payment Received, every rate card)
 * is on screen without scrolling. With the staff screen at full width (a
 * separate customer display) every text and control must sit exactly where
 * it sat before SCRUM-884 (`full-width-layout.json`, recorded on the base
 * commit): the full-width layout cannot move.
 *
 * The browser is the machine's own Edge or Chrome, or Playwright's Chromium;
 * with none of them the file is skipped and says so. Re-record the full-width
 * layout only for a deliberate change to it: SPLITVIEW_RECORD=1.
 */
const RECORD = process.env.SPLITVIEW_RECORD === '1';
const REPORT = process.env.SPLITVIEW_REPORT;
/** A folder to save a picture of every screen read into, for a person to look at. */
const SHOTS = process.env.SPLITVIEW_SHOTS;
const FIXTURE = path.join(import.meta.dirname, 'support', 'splitview-harness', 'full-width-layout.json');

/** The split view the park and the proofs use. */
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1680, height: 1050 },
] as const;
/** Full width: those two, and the smaller desk windows a till may run in. */
const FULL_SIZES = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  ...SIZES,
] as const;
const TILL_SCREENS = [
  'configure', 'tickets', 'tiers-walkin', 'tiers-member', 'tiers-member-all', 'tiers-unverified',
  'payment', 'payment+Cash', 'payment+Cash+Partial payment',
] as const;
type TillScreen = (typeof TILL_SCREENS)[number];

const { browser, why } = await launchBrowser();
if (!browser) console.warn(`SCRUM-884 split view measurement skipped: no browser to lay the page out (${why})`);

let harness: SplitViewHarness;
const recorded: Record<string, { key: string; box: Box }[]> = {};
const reported: Record<string, Reading> = {};

beforeAll(async () => {
  if (browser) harness = await startSplitViewHarness(browser);
}, 180_000);
afterAll(async () => {
  if (RECORD) writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 1)}\n`);
  if (REPORT) writeFileSync(REPORT, JSON.stringify(reported, null, 1));
  await harness?.close();
  await browser?.close();
});

async function readTill(screen: TillScreen, split: boolean, size: { width: number; height: number }): Promise<Reading> {
  const [name, ...presses] = screen.split('+') as [string, ...string[]];
  let reading = await harness.read(`screen=${name}&split=${split ? 1 : 0}`, size);
  if (presses.length) reading = await harness.pressAndRead(...presses);
  const id = `${screen}@${size.width}${split ? ' split' : ' full'}`;
  reported[id] = reading;
  await shoot(id);
  return reading;
}

async function shoot(id: string): Promise<void> {
  if (SHOTS) await harness.page.screenshot({ path: path.join(SHOTS, `${id.replace(/[^\w@.-]+/g, '-')}.png`) });
}

const control = (reading: Reading, name: string) => reading.controls.find((c) => c.name === name);
const faultsOf = (reading: Reading) => reading.faults.map((f) => `${f.kind}: ${f.text} — ${f.detail}`);

/** What each screen must show without scrolling in the split view. */
const IN_VIEW: Record<TillScreen, { controls: string[]; text: string[] }> = {
  configure: { controls: ['Add Another Ticket', 'Continue'], text: [] },
  tickets: { controls: ['Done Adding'], text: ['1 Hour Play'] },
  'tiers-walkin': { controls: [], text: ['Tourist', 'Expat', 'Thai'] },
  'tiers-member': { controls: [], text: ['ZZ TEST 858 Expat', 'Expat'] },
  'tiers-member-all': { controls: [], text: ['ZZ TEST 858 Expat', 'Tourist', 'Expat', 'Thai'] },
  'tiers-unverified': { controls: [], text: ['ZZ TEST 885 split 1440 r01', 'Tourist', 'Expat', 'Thai'] },
  // The tiles are cards that answer a press, not buttons: their names are read as text.
  payment: { controls: ['Back', 'Confirm Payment Received'], text: ['Cash', 'Card', 'PromptPay'] },
  'payment+Cash': { controls: ['Back', 'Confirm Payment Received'], text: [] },
  'payment+Cash+Partial payment': { controls: ['Back', 'Confirm Payment Received'], text: [] },
};

/** Short labels that must stay on one line in the split view. */
const ONE_LINE: Partial<Record<TillScreen, string[]>> = {
  configure: ['Out of stock', 'Kids', 'Adults'],
  payment: ['Cash', 'Card', 'PromptPay'],
};

describe.skipIf(!browser)('the split view: every name readable, nothing out of its button or below the window', () => {
  for (const size of SIZES) {
    for (const screen of TILL_SCREENS) {
      it(`${screen} at ${size.width}x${size.height}`, async () => {
        const reading = await readTill(screen, true, size);
        // The split view's wizard column: half the window, less the half's
        // border, the 360px order column and the column's own border.
        expect(reading.region.width).toBe(size.width / 2 - 362);
        expect(faultsOf(reading)).toEqual([]);
        for (const name of IN_VIEW[screen].controls) {
          expect(control(reading, name)?.inView, `${name} on screen`).toBe(true);
        }
        for (const text of IN_VIEW[screen].text) {
          expect(reading.textInView[text], `"${text}" on screen`).toBe(true);
        }
        for (const text of ONE_LINE[screen] ?? []) {
          expect(reading.textLines[text], `"${text}" on one line`).toBe(1);
        }
      }, 120_000);
    }
  }
});

describe.skipIf(!browser)('full width (a separate customer display): the layout is exactly as before', () => {
  const baseline: Record<string, { key: string; box: Box }[]> = existsSync(FIXTURE) && !RECORD
    ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, { key: string; box: Box }[]>)
    : {};
  for (const size of FULL_SIZES) {
    for (const screen of TILL_SCREENS) {
      const id = `${screen}@${size.width}x${size.height}`;
      it(id, async () => {
        const reading = await readTill(screen, false, size);
        expect(reading.region.width).toBe(size.width - 361);
        if (RECORD) {
          recorded[id] = reading.layout;
          return;
        }
        const before = baseline[id];
        expect(before, `a recorded layout for ${id}`).toBeDefined();
        expect(reading.layout.map((l) => l.key)).toEqual(before!.map((l) => l.key));
        const moved = reading.layout.flatMap((now, i) => {
          const was = before![i]!.box;
          const off = (['left', 'top', 'width', 'height'] as const).some((k) => Math.abs(now.box[k] - was[k]) > 0.5);
          return off ? [`${now.key}: ${JSON.stringify(was)} -> ${JSON.stringify(now.box)}`] : [];
        });
        expect(moved).toEqual([]);
      }, 120_000);
    }
  }
});

describe.skipIf(!browser)('SCRUM-901: a long check-in label stays inside its button', () => {
  // The desk board's card: two a row from 1024px (about 490px wide) to the
  // 570px of a 1440 or 1680 window; one a row, wider, below 1024px.
  for (const width of [440, 490, 570]) {
    it(`the board's family card at ${width}px`, async () => {
      const reading = await harness.read(`screen=card&w=${width}`, { width: 1440, height: 900 });
      reported[`card@${width}`] = reading;
      await shoot(`card@${width}`);
      expect(faultsOf(reading)).toEqual([]);
      const named = reading.controls.find((c) => c.name.startsWith('Check in ZZ TEST Sibling 496 age3'));
      expect(named, 'the named check-in').toBeDefined();
      // It grew with its label rather than spilling out of 44px.
      expect(named!.box.height).toBeGreaterThan(44);
    }, 120_000);
  }

  it('a one-word Check in keeps its 44px button (the card exactly as before)', async () => {
    const reading = await harness.read('screen=card-single&w=560', { width: 1440, height: 900 });
    const id = 'card-single@560';
    if (RECORD) {
      recorded[id] = reading.layout;
      return;
    }
    const before = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, { key: string; box: Box }[]>)[id]!;
    expect(reading.layout).toEqual(before);
    expect(control(reading, 'Check in')?.box.height).toBe(44);
  }, 120_000);

  for (const size of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
    it(`the phone's family screen at ${size.width}x${size.height}`, async () => {
      const reading = await harness.read('screen=phone-card', size);
      reported[`phone-card@${size.width}`] = reading;
      await shoot(`phone-card@${size.width}`);
      // The screen's action footer: every label inside its button, none cut.
      // (The scrolling body above it is not this ticket's: see the report.)
      expect(faultsOf(reading).filter((f) => f.startsWith('outsideButton') || /^clipped: (Check In|Cancel)/.test(f))).toEqual([]);
      const named = reading.controls.find((c) => c.name.startsWith('Check In ZZ TEST Sibling 496 age3'));
      expect(named?.inView, 'the named Check In on screen').toBe(true);
      expect(named!.box.height).toBeGreaterThan(64);
    }, 120_000);
  }
});

describe("the harness draws the till's own frame", () => {
  // If Till.tsx's frame changes, the measurement above is of the wrong frame:
  // this fails first, and the harness's `TillFrame` is brought back in line.
  const till = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Till.tsx'), 'utf8');
  const harnessPage = readFileSync(path.join(import.meta.dirname, 'support', 'splitview-harness', 'main.ts'), 'utf8');
  for (const cls of [
    'flex h-full w-full bg-background text-foreground overflow-hidden',
    'flex-1 flex flex-col border-r bg-card/30 min-w-0',
    'flex-1 overflow-hidden relative p-6',
    'w-[360px] min-w-0 bg-sidebar flex flex-col p-6 overflow-y-auto',
    "'w-1/2 border-r border-foreground/10' : 'w-full'} h-full min-w-0",
  ]) {
    it(cls, () => {
      expect(till).toContain(cls);
      expect(harnessPage).toContain(cls);
    });
  }

  it("the payment step's footer: the till's split-view classes by default, the prototype's row with stickyFoot={false}", () => {
    vi.stubGlobal('React', React);
    try {
      const foot = (stickyFoot?: boolean) => {
        const html = renderToStaticMarkup(React.createElement(StepPayment, {
          total: 1500, selectedMethod: null, onSelectMethod: () => {}, onComplete: () => {}, onBack: () => {},
          ...(stickyFoot === undefined ? {} : { stickyFoot }),
        }));
        return /<div class="(mt-auto pt-6 [^"]*)"><button/.exec(html)?.[1] ?? '';
      };
      const prototypeRow = 'mt-auto pt-6 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 sm:gap-4';
      expect(foot(false)).toBe(prototypeRow);
      expect(foot()).toBe(`${prototypeRow} md:@max-xl:sticky md:@max-xl:bottom-0 md:@max-xl:z-10 md:@max-xl:pb-1 md:@max-xl:bg-background md:@max-xl:bg-linear-to-b md:@max-xl:from-card/30 md:@max-xl:to-card/30`);
      expect(foot(true)).toBe(foot());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the party modals: stickyFoot={false}; the counter till leaves it on (the default)', () => {
    const party = (name: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'components', 'parties', name), 'utf8');
    expect(party('PartySettleModal.tsx')).toContain('stickyFoot={false}');
    expect(party('AddAttendeeModal.tsx')).toContain('stickyFoot={false}');
    expect(till).not.toContain('stickyFoot');
  });
});
