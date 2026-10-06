/**
 * The editor's named preview scenarios (SCRUM-472).
 *
 * Three things are worth pinning. Every scenario covers every printout a
 * template governs, so switching scenario never leaves a template with nothing
 * to draw. The money on a sample receipt is money the till could print —
 * `formatTHB`'s spelling, lines that add up, VAT included at 7%. And each
 * scenario renders through the one drawing path with no overflow the renderer
 * could not recover from, at the widths the park's printers really are.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRINT_SAMPLE,
  PRINT_SAMPLES,
  PRINT_SAMPLE_NAMES,
  TEMPLATE_FOR_KIND,
  printSampleJob,
  renderJob,
} from '../src/index';
import type { PrintKind, ReceiptData } from '../src/index';
import { formatTHB } from '../../shared/src/money';
import { PROFILES, TEMPLATES } from './fixtures';

const TEMPLATED_KINDS = (Object.keys(TEMPLATE_FOR_KIND) as PrintKind[]).filter(
  (k) => TEMPLATE_FOR_KIND[k] !== undefined,
);
const OWN_SETS = PRINT_SAMPLE_NAMES.filter((n) => n !== 'standard');

/** `฿1,234.50` → 123450. Throws on anything `formatTHB` would not write. */
function satang(money: string): number {
  const match = /^฿(\d{1,3}(?:,\d{3})*)(?:\.(\d{2}))?$/.exec(money);
  if (!match) throw new Error(`not a formatTHB string: ${money}`);
  const whole = Number(match[1]!.replace(/,/g, ''));
  const value = whole * 100 + Number(match[2] ?? '0');
  expect(formatTHB(value), `${money} is spelled the way formatTHB spells it`).toBe(money);
  return value;
}

describe('the named preview scenarios', () => {
  it('offers the fixture first, as the default, and three sets of its own', () => {
    expect(PRINT_SAMPLE_NAMES[0]).toBe('standard');
    expect(DEFAULT_PRINT_SAMPLE).toBe('standard');
    expect(Object.keys(PRINT_SAMPLES).sort()).toEqual([...OWN_SETS].sort());
    expect(OWN_SETS.length).toBeGreaterThanOrEqual(3);
  });

  it('answers the fixture for standard and for a printout no template governs', () => {
    for (const kind of TEMPLATED_KINDS) expect(printSampleJob(kind, 'standard')).toBeUndefined();
    expect(printSampleJob('booth_voucher', 'full')).toBeUndefined();
    expect(printSampleJob('test_page', 'simple')).toBeUndefined();
  });

  it.each(OWN_SETS)('%s covers every printout a template governs, with its own kind', (name) => {
    for (const kind of TEMPLATED_KINDS) {
      const job = printSampleJob(kind, name);
      expect(job, `${name} has no ${kind}`).toBeDefined();
      expect(job!.kind).toBe(kind);
    }
  });

  it('hands out a copy, so a caller that edits one cannot change the next preview', () => {
    const first = printSampleJob('receipt', 'full');
    if (first?.kind !== 'receipt') throw new Error('expected a receipt');
    first.data.lines.length = 0;
    const second = printSampleJob('receipt', 'full');
    expect(second?.kind === 'receipt' && second.data.lines.length).toBeGreaterThan(1);
  });

  it.each(OWN_SETS)('the %s receipt adds up the way the till would add it', (name) => {
    const data: ReceiptData = PRINT_SAMPLES[name].receipt.data;
    const lines = data.lines.reduce((sum, line) => sum + satang(line.price ?? '฿0'), 0);
    expect(satang(data.subtotal ?? '฿0')).toBe(lines);
    const service = data.service ? satang(data.service) : 0;
    const total = satang(data.total);
    expect(total).toBe(lines + service);
    // Prices include VAT at 7%: the VAT line is the total's 7/107, rounded.
    expect(satang(data.vat ?? '฿0')).toBe(Math.round((total * 7) / 107));
    const tendered = (data.tenders ?? [])
      .filter((t) => t.label !== 'Change')
      .reduce((sum, t) => sum + satang(t.amount), 0);
    const change = (data.tenders ?? []).find((t) => t.label === 'Change');
    expect(tendered - (change ? satang(change.amount) : 0)).toBe(total);
  });

  it('the fuller sale is fuller: many lines, a service charge and credit handed out', () => {
    const data = PRINT_SAMPLES.full.receipt.data;
    expect(data.lines.length).toBeGreaterThanOrEqual(4);
    expect(satang(data.service ?? '฿0')).toBeGreaterThan(0);
    expect(data.creditGrants?.length).toBeGreaterThanOrEqual(2);
  });

  it('the long-names case is long where a printout wraps', () => {
    const set = PRINT_SAMPLES.long_names;
    expect(set.kids_wristband.data.holderName!.length).toBeGreaterThan(30);
    expect(Math.max(...set.receipt.data.lines.map((l) => l.name.length))).toBeGreaterThan(60);
    expect(set.kitchen_ticket.data.allergiesMedical!.length).toBeGreaterThan(60);
  });

  it.each(OWN_SETS)('%s renders every printout through the one drawing path', (name) => {
    for (const kind of TEMPLATED_KINDS) {
      const job = printSampleJob(kind, name)!;
      const device = kind.endsWith('wristband') ? PROFILES.tspl400! : PROFILES.escpos576!;
      const rendered = renderJob(job, { device, templates: TEMPLATES });
      expect(rendered.bitmap.width).toBe(device.widthDots);
      expect(rendered.bitmap.height).toBeGreaterThan(0);
      // A character no bundled font has would print as a box.
      expect(rendered.overflow.filter((o) => /glyph|font|tofu/i.test(o)), `${name} ${kind}`).toEqual(
        [],
      );
    }
  });
});
