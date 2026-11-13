import { describe, expect, it } from 'vitest';
import { buildDocument, lineDots, renderJob, tsplProfile, type DeviceProfile, type TestPageData } from '../src/index';
import { bodyBold } from '../src/templates/common';
import { PROFILES, TEMPLATES } from './fixtures';

/**
 * SCRUM-971 — the test page after the printers' second staging proof.
 *
 * Point 11: the band printer's test page ran past a band's print window. On
 * the park's band stock — 25 by 246 mm, white for 80 mm from 50 mm
 * (DEVICE_INVENTORY, SCRUM-689) — it was 1,108 dots (138.5 mm) against a
 * window of 640. On a label it is now composed to the window a real band is
 * laid out to (`buildBand`): it keeps the rows that identify the printer and
 * drops the rest in order — the ruler, the scripts, the money column, the
 * codes, the template list — until it fits.
 *
 * Point 7 of the plan: on the receipt page the Station, Box and Time rows were
 * drawn about 21 dots apart against the 25 to 27 of the rows around them
 * (proof picture 01c). They now take the pitch of the Device and Model rows.
 * The committed fixture's page has none of those rows and is unchanged
 * (`fixtures.test.ts`).
 */

/** The page as the platform composes it for a station's test print (`testPageDocumentOf`). */
const page = (widthDots: number): TestPageData => ({
  deviceLabel: 'ZZ TEST 952 band printer',
  model: 'Band printer',
  address: '192.0.2.53:9100',
  station: 'ZZ TEST 952 till',
  box: 'Virtual box 1',
  time: '13 Nov 2026 05:47',
  transport: 'Simulated · tspl2',
  widthDots,
  rendererVersion: 'oto-print/0.1.0',
  fontVersions: ['NotoSans', 'NotoSansThai', 'OtoPrintSC'],
  seededTemplates: TEMPLATES.map((t) => t.name),
  sampleCode: 'HKT1-4821',
});

/** A band printer on the park's stock, with a print window of this many mm. */
const parkBand = (printLengthMm = 80): DeviceProfile =>
  tsplProfile({
    id: 'zz-band',
    label: 'ZZ TEST 952 band printer',
    model: '4B-2082A',
    widthDots: 200,
    media: { widthMm: 25, lengthMm: 246, gapMm: 4, sensing: 'bline', printOffsetMm: 50, printLengthMm },
  });

const rendered = (device: DeviceProfile) =>
  renderJob({ kind: 'test_page', data: page(device.widthDots) }, { device, templates: TEMPLATES });
const textsOf = (device: DeviceProfile) =>
  rendered(device).layout.items.flatMap((item) => (item.k === 'text' ? [item.text] : []));

/** Each droppable part of the page, by a line only it prints, in the order it is dropped. */
const PARTS: Array<[string, string]> = [
  ['the ruler', 'Dot ruler'],
  ['the scripts', 'Привет'],
  ['the money column', 'Subtotal'],
  ['the codes', 'Codes'],
  ['the template list', 'Seeded templates'],
];
const IDENTITY = ['PRINTER TEST', 'Device', 'Model', 'Address', '192.0.2.53:9100', 'Station', 'ZZ TEST 952 till', 'Box', 'Virtual box 1', 'Time', '13 Nov 2026 05:47'];

describe('SCRUM-971 — a band’s test page fits the band’s print window', () => {
  it('on the park’s band stock: within the 80 mm window, nothing reported over', () => {
    const job = rendered(parkBand());
    expect(job.document.media.heightDots).toBe(640);
    expect(job.layout.heightDots).toBeLessThanOrEqual(640);
    expect(job.overflow).toEqual([]);
  });

  it('keeps the rows that say which printer it is, and drops the ruler, scripts, money and codes first', () => {
    const texts = textsOf(parkBand());
    for (const said of IDENTITY) expect(texts, said).toContain(said);
    for (const said of ['Dot ruler', 'Привет', 'Subtotal', 'Codes']) expect(texts, said).not.toContain(said);
    // What still fits on the park's window: how it is driven, and the branch's templates.
    for (const said of ['Transport', 'Dots/line', 'Renderer', 'Fonts', 'Seeded templates']) expect(texts, said).toContain(said);
  });

  it('drops in that order, whatever the window: never a later part while an earlier one stays', () => {
    for (let mm = 30; mm <= 160; mm += 5) {
      const texts = textsOf(parkBand(mm));
      for (const said of IDENTITY) expect(texts, `${said} at ${mm} mm`).toContain(said);
      const kept = PARTS.map(([, line]) => texts.includes(line));
      // Kept parts are always the tail of the order: once one is kept, every later one is.
      const first = kept.indexOf(true);
      if (first >= 0) expect(kept.slice(first).every(Boolean), `at ${mm} mm: ${JSON.stringify(kept)}`).toBe(true);
    }
  });

  it('is laid out to the same window as a band on the same stock', () => {
    const device = parkBand();
    const band = buildDocument({ kind: 'kids_wristband', data: { holderName: 'ZZ TEST' } } as never, undefined, device);
    expect(rendered(device).document.media.heightDots).toBe(band.media.heightDots);
  });

  it('a label with no print window has its whole length, and keeps the whole page', () => {
    const said = textsOf(PROFILES.tspl400!).join(' | ');
    for (const line of ['Dot ruler', 'Привет', 'Subtotal', 'Codes', 'Templates seeded for this branch']) {
      expect(said.includes(line), line).toBe(true);
    }
  });
});

describe('SCRUM-971 — the Station, Box and Time rows at the pitch of Device and Model', () => {
  it('on the 576-dot page every fact row from Model to Transport is 24 to 27 dots under the one before', () => {
    const items = rendered(PROFILES.escpos576!).layout.items;
    const value = (said: string) => {
      const item = items.find((i) => i.k === 'text' && i.text === said);
      if (!item || item.k !== 'text') throw new Error(`${said} is not on the page`);
      return item.baselineY;
    };
    const rows = ['Band printer', '192.0.2.53:9100', 'ZZ TEST 952 till', 'Virtual box 1', '13 Nov 2026 05:47', 'Simulated · tspl2'];
    for (let i = 1; i < rows.length; i += 1) {
      const pitch = value(rows[i]!) - value(rows[i - 1]!);
      expect(pitch, `${rows[i - 1]} → ${rows[i]}`).toBeGreaterThanOrEqual(24);
      expect(pitch, `${rows[i - 1]} → ${rows[i]}`).toBeLessThanOrEqual(27);
    }
  });

  it('the pitch is that of a row whose value reaches above and below the line, as Device and Model do', () => {
    expect(lineDots('lip', bodyBold)).toBe(lineDots('Xprinter XP-80', bodyBold));
    expect(lineDots('lip', bodyBold)).toBe(lineDots('ZZ TEST 952 receipt printer', bodyBold));
  });
});
