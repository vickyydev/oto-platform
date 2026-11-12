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
 * commit): the full-width layout cannot move. The same holds for the party
 * modals' payment step, which is under @xl at every window and keeps the
 * prototype's footer row (`stickyFoot={false}`).
 *
 * WHERE THE BOXES ARE EXACT. The fixture names the platform it was recorded
 * on (Windows: Edge lays text out to the subpixel). On another platform (CI's
 * Linux runner lays text on whole pixels, a pixel or so apart) the same pin
 * is kept without the fonts: the same texts and controls in the same order,
 * each text on as many lines as before, and every query container in the
 * till's column at least 36rem wide, so none of SCRUM-884's `md:@max-*`
 * variants can be in effect at full width.
 *
 * The browser is the machine's own Edge or Chrome, or Playwright's Chromium;
 * with none of them the file is skipped and says so. Re-record the full-width
 * layout only for a deliberate change to it, on Windows, from the commit
 * before the change: SPLITVIEW_RECORD=1.
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
/** What `full-width-layout.json` holds: the boxes and line counts, and where they were laid out. */
interface Fixture {
  platform: NodeJS.Platform;
  layouts: Record<string, { key: string; box: Box }[]>;
  lines: Record<string, Record<string, number>>;
}
const recorded: Fixture = { platform: process.platform, layouts: {}, lines: {} };
const reported: Record<string, Reading> = {};
const fixture: Fixture | null = existsSync(FIXTURE) && !RECORD ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture) : null;
/** The boxes are compared to the half pixel only where they were recorded. */
const EXACT = fixture?.platform === process.platform;
if (browser && fixture && !EXACT) {
  console.warn(`SCRUM-884 full-width pin: boxes recorded on ${fixture.platform}, read on ${process.platform}: compared without the fonts`);
}
/** 36rem: under it a `@max-xl` variant applies. */
const XL_PX = 576;

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

/**
 * The layout recorded before SCRUM-884 for `id`, kept: recorded under
 * SPLITVIEW_RECORD; otherwise the same texts and controls in the same order,
 * each text on as many lines, and (on the platform it was recorded on) every
 * box where it was, to the half pixel.
 */
function pinLayout(id: string, reading: Reading): void {
  if (RECORD) {
    recorded.layouts[id] = reading.layout;
    recorded.lines[id] = reading.textLines;
    return;
  }
  const before = fixture?.layouts[id];
  expect(before, `a recorded layout for ${id}`).toBeDefined();
  expect(reading.layout.map((l) => l.key)).toEqual(before!.map((l) => l.key));
  expect(reading.textLines).toEqual(fixture!.lines[id]);
  if (!EXACT) return;
  const moved = reading.layout.flatMap((now, i) => {
    const was = before![i]!.box;
    const off = (['left', 'top', 'width', 'height'] as const).some((k) => Math.abs(now.box[k] - was[k]) > 0.5);
    return off ? [`${now.key}: ${JSON.stringify(was)} -> ${JSON.stringify(now.box)}`] : [];
  });
  expect(moved).toEqual([]);
}

/** Back's row on the payment step: how it is placed and painted (strings only). */
async function paymentFoot(): Promise<{ position: string; backgroundColor: string; backgroundImage: string; paddingBottom: string } | null> {
  return harness.page.evaluate(() => {
    const back = Array.from(document.querySelectorAll('#region button')).find((b) => b.textContent?.trim() === 'Back');
    const row = back?.parentElement;
    if (!row) return null;
    const style = getComputedStyle(row);
    return { position: style.position, backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, paddingBottom: style.paddingBottom };
  });
}
/** The prototype's footer row: in the flow, unpainted. */
const PLAIN_FOOT = { position: 'static', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', paddingBottom: '0px' };

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
  for (const size of FULL_SIZES) {
    for (const screen of TILL_SCREENS) {
      const id = `${screen}@${size.width}x${size.height}`;
      it(id, async () => {
        const reading = await readTill(screen, false, size);
        expect(reading.region.width).toBe(size.width - 361);
        if (RECORD) return pinLayout(id, reading);
        // Every query container in the column is 36rem or wider: no `md:@max-*` variant is in effect.
        expect(reading.containers.length).toBeGreaterThan(0);
        expect(reading.containers.filter((c) => c.width < XL_PX).map((c) => `${c.key}: ${c.width}px`)).toEqual([]);
        pinLayout(id, reading);
        if (screen.startsWith('payment')) expect(await paymentFoot()).toEqual(PLAIN_FOOT);
      }, 120_000);
    }
  }
});

describe.skipIf(!browser)("the party modals' payment step: the prototype's footer, exactly as before", () => {
  // PartySettleModal ("Take the balance") and AddAttendeeModal hold the step in
  // a 448px pane: under @xl at every window. Its Back and Confirm row stays in
  // the flow, unpainted, where it was; only the counter till's column turns the
  // split view's footer on.
  for (const { size, split } of [
    { size: { width: 1024, height: 768 }, split: false },
    { size: { width: 1440, height: 900 }, split: false },
    { size: { width: 1680, height: 1050 }, split: false },
    { size: { width: 1440, height: 900 }, split: true },
  ]) {
    const id = `party-payment@${size.width}x${size.height}${split ? ' split' : ''}`;
    it(id, async () => {
      const reading = await harness.read(`screen=party-payment&split=${split ? 1 : 0}`, size);
      reported[id] = reading;
      await shoot(id);
      expect(reading.region.width).toBe(448);
      if (RECORD) return pinLayout(id, reading);
      pinLayout(id, reading);
      expect(await paymentFoot()).toEqual(PLAIN_FOOT);
    }, 120_000);
  }

  it("the counter till's column in the split view keeps its footer at the panel's foot", async () => {
    await readTill('payment', true, { width: 1440, height: 900 });
    expect((await paymentFoot())?.position).toBe('sticky');
  }, 120_000);
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
    pinLayout('card-single@560', reading);
    if (RECORD) return;
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

const PHONES = [{ width: 390, height: 844 }, { width: 360, height: 740 }] as const;

describe.skipIf(!browser)('SCRUM-956: the phone family screen is as wide as the phone', () => {
  /** The body's scroll area: its content's width against the phone's, and any sideways scroll. */
  const body = () => harness.page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('#region [data-radix-scroll-area-viewport]')!;
    const content = viewport.firstElementChild as HTMLElement;
    return {
      viewport: viewport.clientWidth, content: Math.round(content.getBoundingClientRect().width * 10) / 10,
      scrolls: viewport.scrollWidth > viewport.clientWidth, page: document.documentElement.scrollWidth > window.innerWidth,
    };
  });

  for (const size of PHONES) {
    it(`a long child name at ${size.width}x${size.height}: every line whole, the names wrapped, nothing sideways`, async () => {
      const reading = await harness.read('screen=phone-card-long', size);
      reported[`phone-card-long@${size.width}`] = reading;
      await shoot(`phone-card-long@${size.width}`);
      const child = 'ZZ TEST Phongsakorn Wattanachaiyaphum Long Name 956';
      // The proof's cut lines among them: "WhatsApp confirmed", "May order food: No".
      // The bar at the top keeps the prototype's one-line title (a long name
      // ends in "…" there): that one cut is allowed; the body under it names
      // the child in full (read on its own just below).
      expect(faultsOf(reading).filter((f) => !f.startsWith(`clipped: ${child} — `))).toEqual([]);
      const named = await harness.page.evaluate((name) => {
        const heading = [...document.querySelectorAll('#region h3')].find((h) => h.textContent === name)!;
        const range = document.createRange();
        range.selectNodeContents(heading);
        const right = Math.max(...[...range.getClientRects()].map((r) => r.right));
        return { right, inside: right <= window.innerWidth, clips: heading.scrollWidth > heading.clientWidth };
      }, child);
      expect([named.inside, named.clips], JSON.stringify(named)).toEqual([true, false]);
      const seen = await body();
      expect(seen.content, JSON.stringify(seen)).toBeLessThanOrEqual(seen.viewport);
      expect([seen.scrolls, seen.page]).toEqual([false, false]);
      // Long names wrap between their words (no word is broken: no fault above).
      expect(reading.textLines[child]).toBeGreaterThan(1);
      expect(reading.textLines['ZZ TEST guardian Chanthawongsakul Long Family 956']).toBeGreaterThan(1);
      // The proof's two cut lines, each whole once scrolled to (WaChip writes
      // "{channel} confirmed": two pieces of text).
      for (const [line, pieces] of [['WhatsApp confirmed', ['WhatsApp', 'confirmed']], ['May order food', ['May order food', 'No']]] as const) {
        await harness.page.getByText(line, { exact: true }).first().scrollIntoViewIfNeeded();
        const again = await harness.page.evaluate(() => window.__readSplitView!());
        for (const piece of pieces) expect(again.textInView[piece], `"${piece}" whole on screen`).toBe(true);
      }
    }, 120_000);

    it(`the proof's family (SCRUM-886) at ${size.width}x${size.height}: the scrolling body too, every line whole`, async () => {
      const reading = await harness.read('screen=phone-card', size);
      expect(faultsOf(reading)).toEqual([]);
      const seen = await body();
      expect(seen.content, JSON.stringify(seen)).toBeLessThanOrEqual(seen.viewport);
      expect([seen.scrolls, seen.page]).toEqual([false, false]);
    }, 120_000);
  }
});

describe.skipIf(!browser)('SCRUM-953: the phone refund’s By item rows wrap a long name', () => {
  const longRow = 'ZZ TEST Phongsakorn Wattanachaiyaphum Long Name 956 · 2 Hours Play · 1 ppl'.slice(0, 60);
  for (const size of PHONES) {
    it(`at ${size.width}x${size.height}`, async () => {
      await harness.read('screen=phone-refund', size);
      const reading = await harness.pressAndRead('By item');
      reported[`phone-refund@${size.width}`] = reading;
      await shoot(`phone-refund@${size.width}`);
      expect(faultsOf(reading)).toEqual([]);
      expect(reading.textLines[longRow]).toBeGreaterThan(1);
      // Each row's amount stays whole beside it ("฿" and the figure are two pieces of text).
      for (const amount of ['823.50', '621']) expect(reading.textInView[amount], amount).toBe(true);
    }, 120_000);
  }
});

describe.skipIf(!browser)('SCRUM-954: the phone till’s supervision gate keeps the side gutter', () => {
  for (const size of PHONES) {
    it(`"Continue to payment" inside the phone's 16px gutter at ${size.width}x${size.height}`, async () => {
      const reading = await harness.read('screen=phone-gate', size);
      reported[`phone-gate@${size.width}`] = reading;
      await shoot(`phone-gate@${size.width}`);
      const go = control(reading, 'Continue to payment');
      const back = control(reading, 'Back');
      expect(go, 'Continue to payment').toBeDefined();
      expect(go!.box.right, JSON.stringify(go!.box)).toBeLessThanOrEqual(size.width - 16 + 0.5);
      expect(back!.box.left).toBeGreaterThanOrEqual(16 - 0.5);
      expect(go!.inView).toBe(true);
      expect(faultsOf(reading).filter((f) => /Continue to payment|Back/.test(f))).toEqual([]);
    }, 120_000);
  }

  it('where its words fit, they stay on one line', async () => {
    const reading = await harness.read('screen=phone-gate', { width: 1024, height: 768 });
    expect(reading.textLines['Continue to payment']).toBe(1);
    expect(control(reading, 'Continue to payment')?.box.height).toBe(56);
  }, 120_000);
});

describe("the harness draws the till's own frame", () => {
  // If Till.tsx's frame changes, the measurement above is of the wrong frame:
  // this fails first, and the harness's `TillFrame` is brought back in line.
  const source = (...rel: string[]) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', ...rel), 'utf8');
  const till = source('pages', 'Till.tsx');
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

  // The party modals' frame, the same way (`PartyFrame`), and the prop that
  // keeps their footer the prototype's.
  const settle = source('components', 'parties', 'PartySettleModal.tsx');
  const attendee = source('components', 'parties', 'AddAttendeeModal.tsx');
  for (const cls of [
    'fixed inset-0 z-50 bg-background text-foreground flex flex-col',
    'shrink-0 flex items-center justify-between gap-3 px-5 h-14 border-b border-white/10',
    'flex-1 flex min-h-0',
    "'w-1/2 border-r border-white/10' : 'w-full'} h-full min-w-0",
    'h-full p-6',
    'mx-auto w-full max-w-md h-full',
  ]) {
    it(`the party modals: ${cls}`, () => {
      expect(settle).toContain(cls);
      expect(attendee).toContain(cls);
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

  it('the party modals: stickyFoot={false}', () => {
    expect(settle).toContain('stickyFoot={false}');
    expect(attendee).toContain('stickyFoot={false}');
    expect(harnessPage).toContain('stickyFoot: false');
    // The counter till leaves it on (the default).
    expect(till).not.toContain('stickyFoot');
  });
});
