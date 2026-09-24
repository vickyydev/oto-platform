import { describe, expect, it } from 'vitest';
import {
  APPLICABLE_FIELDS,
  TEMPLATE_FOR_KIND,
  TEMPLATE_TYPE_ORDER,
  fieldOn,
  layoutSummary,
  renderJob,
  resolveTemplate,
  seedPrintTemplates,
} from '../src/index';
import type { BoothVoucherData, LayoutItem, PrintTemplate } from '../src/index';
import { FIXTURES, PROFILES, TEMPLATES } from './fixtures';

const escpos576 = PROFILES.escpos576!;
const escpos512 = PROFILES.escpos512!;
const tspl400 = PROFILES.tspl400!;

/** Every string a printout put on the page, in order. */
function textOf(job: ReturnType<typeof renderJob>): string[] {
  return job.layout.items.filter((i) => i.k === 'text').map((i) => (i as { text: string }).text);
}

describe('the ported template model', () => {
  it('keeps the prototype seed exactly', () => {
    expect(seedPrintTemplates.map((t) => t.id)).toEqual([
      'tpl-receipt',
      'tpl-kids-wristband',
      'tpl-adult-wristband',
      'tpl-kitchen',
      'tpl-bar',
      'tpl-credit-voucher',
    ]);
    // Two values that look like mistakes and are not.
    const adult = seedPrintTemplates.find((t) => t.id === 'tpl-adult-wristband');
    expect(adult?.fields.holderName).toBe(false);
    expect(APPLICABLE_FIELDS.adult_wristband).not.toContain('allergyLine');
  });

  it('lists the admin panel order', () => {
    expect(TEMPLATE_TYPE_ORDER).toEqual([
      'receipt',
      'kids_wristband',
      'adult_wristband',
      'kitchen_ticket',
      'bar_ticket',
      'credit_voucher',
    ]);
  });

  it('looks a template up by type and takes the first match', () => {
    const second: PrintTemplate = {
      id: 'tpl-receipt-2',
      type: 'receipt',
      name: 'Another receipt',
      showLogo: false,
      fields: {},
    };
    const list = [...seedPrintTemplates, second];
    expect(resolveTemplate(list, 'receipt')?.id).toBe('tpl-receipt');
  });

  it('gates a field on applicability and the toggle together', () => {
    const tpl = resolveTemplate(seedPrintTemplates, 'adult_wristband');
    // Set on the object but not applicable to the type: inert.
    const stale = { ...tpl!, fields: { ...tpl!.fields, allergyLine: true } };
    expect(fieldOn(stale, 'adult_wristband', 'allergyLine')).toBe(false);
    expect(fieldOn(tpl, 'adult_wristband', 'qr')).toBe(true);
    expect(fieldOn(tpl, 'adult_wristband', 'holderName')).toBe(false);
  });

  it('maps the item voucher onto the credit_voucher template, as the prototype does', () => {
    expect(TEMPLATE_FOR_KIND.item_voucher).toBe('credit_voucher');
    expect(TEMPLATE_FOR_KIND.booth_voucher).toBeUndefined();
    expect(TEMPLATE_FOR_KIND.test_page).toBeUndefined();
  });
});

describe('a missing template means print everything', () => {
  // A new branch starts with no templates at all (`catalogStore.ts:900`), and
  // the safe fallback is "print it", never "print nothing".
  const data = {
    holderName: 'Mali',
    startEndTime: '10:00 - 12:00',
    duration: '2 hours',
    partyName: "Ploy's Birthday",
    dietaryRequirement: 'Gluten-free',
    assignedNannyName: 'Fon',
    allergy: 'Peanuts',
    supervisionMode: 'NANNY' as const,
    bandCode: 'HKT1:01J8Z4M2QR',
    shortCode: 'HKT1-4821',
  };

  it('prints every applicable section on a kids band with no template', () => {
    const none = renderJob({ kind: 'kids_wristband', data }, { device: tspl400, templates: [] });
    const text = textOf(none).join('\n');
    expect(text).toContain('Mali');
    expect(text).toContain('NANNY');
    expect(text).toContain('Fon');
    expect(text).toContain('Peanuts');
  });

  it('still honours applicability: an adult band never shows an allergy', () => {
    const none = renderJob({ kind: 'adult_wristband', data }, { device: tspl400, templates: [] });
    expect(textOf(none).join('\n')).not.toContain('Peanuts');
  });
});

describe('toggling a field changes the next printout', () => {
  const receiptData = {
    title: 'Receipt',
    lines: [{ qty: 1, name: 'Adult Pass', price: '฿150' }],
    subtotal: '฿150',
    total: '฿150',
    creditGrants: ['฿100 credit'],
  };

  it('drops the itemised lines when itemizedLines is off', () => {
    const on = renderJob({ kind: 'receipt', data: receiptData }, { device: escpos576, templates: TEMPLATES });
    expect(textOf(on).join('\n')).toContain('Adult Pass');

    const off = TEMPLATES.map((t) =>
      t.type === 'receipt' ? { ...t, fields: { ...t.fields, itemizedLines: false } } : t,
    );
    const after = renderJob({ kind: 'receipt', data: receiptData }, { device: escpos576, templates: off });
    expect(textOf(after).join('\n')).not.toContain('Adult Pass');
    expect(textOf(after).join('\n')).toContain('TOTAL');
  });

  it('drops the header and logo when the template says so', () => {
    const plain = TEMPLATES.map((t) =>
      t.type === 'receipt' ? { ...t, showLogo: false, headerText: undefined } : t,
    );
    const job = renderJob({ kind: 'receipt', data: receiptData }, { device: escpos576, templates: plain });
    expect(textOf(job).join('\n')).not.toContain('Oto Play Park');
    expect(job.layout.items.some((i) => i.k === 'invert')).toBe(false);
  });

  it('honours only creditVoucherQr on an item voucher', () => {
    const noQr = TEMPLATES.map((t) =>
      t.type === 'credit_voucher' ? { ...t, fields: { ...t.fields, creditVoucherQr: false } } : t,
    );
    const data = { label: 'Free: Ice Cream Cone', quantity: 2, qrCode: 'grant-1' };
    const withQr = renderJob({ kind: 'item_voucher', data }, { device: escpos576, templates: TEMPLATES });
    const without = renderJob({ kind: 'item_voucher', data }, { device: escpos576, templates: noQr });
    expect(withQr.layout.items.some((i) => i.k === 'qr')).toBe(true);
    expect(without.layout.items.some((i) => i.k === 'qr')).toBe(false);
    // The label still prints either way: it is not a gated field.
    expect(textOf(without).join('\n')).toContain('Free: Ice Cream Cone');
  });
});

describe('a band never carries the logo or the header', () => {
  // The OTO mark is pre-printed on the band stock, so the editor hides those
  // controls for band types. A template with them set must still not print them.
  it('ignores showLogo and headerText on a wristband', () => {
    const loud = TEMPLATES.map((t) =>
      t.type === 'kids_wristband'
        ? { ...t, showLogo: true, headerText: 'Oto Play Park', footerText: 'Thank you' }
        : t,
    );
    const job = renderJob(
      { kind: 'kids_wristband', data: { holderName: 'Mali' } },
      { device: tspl400, templates: loud },
    );
    const text = textOf(job).join('\n');
    expect(text).not.toContain('Oto Play Park');
    expect(text).not.toContain('oto');
    // Footer text is editable for a band but the prototype never draws it.
    expect(text).not.toContain('Thank you');
  });
});

describe('the booth voucher', () => {
  const sample = FIXTURES.find((f) => f.job.kind === 'booth_voucher')!;
  const data = sample.job.data as BoothVoucherData;

  /** The committed sample, so this and `test/fixtures/` never describe two vouchers. */
  function build(overrides: Partial<BoothVoucherData> = {}, device = escpos576) {
    return renderJob(
      { kind: 'booth_voucher', data: { ...data, ...overrides } },
      { device, templates: TEMPLATES },
    );
  }

  it('carries every part the specification names', () => {
    const job = build();
    const lines = textOf(job).join('\n');

    // The logo: the inverted "oto" badge, which is an `invert` item with the
    // word inside it. Unconditional here — there is no template to toggle it.
    expect(job.layout.items.some((i) => i.k === 'invert')).toBe(true);
    expect(lines).toContain('oto');

    // The prize in both scripts.
    expect(lines).toContain('150 THB VOUCHER');
    expect(lines).toContain('คูปอง 150 บาท');

    // The QR and the readable code come from one field, so they cannot differ.
    const qr = job.document.blocks.find((b) => b.k === 'qr');
    expect(qr && qr.k === 'qr' ? qr.value : undefined).toBe(data.voucherCode);
    expect(lines).toContain(data.voucherCode);
    expect(job.layout.items.some((i) => i.k === 'qr')).toBe(true);

    // Issue time, booth, expiry, terms.
    expect(lines).toContain('Issued');
    expect(lines).toContain(data.issuedAt);
    expect(lines).toContain('Booth');
    expect(lines).toContain(data.booth);
    expect(lines).toContain('Expires');
    expect(lines).toContain('1 Oct 2026');
    for (const line of data.terms) expect(lines).toContain(line);

    expect(job.overflow).toEqual([]);
  });

  it('is not admin-editable: a branch’s templates change nothing about it', () => {
    // `TEMPLATE_FOR_KIND.booth_voucher` is undefined, so the branch's template
    // list is never consulted. Asserted on the BYTES rather than on the lookup,
    // because the lookup returning undefined and the builder ignoring what it
    // returns are two different claims.
    const withTemplates = build();
    const without = renderJob(
      { kind: 'booth_voucher', data },
      { device: escpos576, templates: [] },
    );
    expect(withTemplates.template).toBeUndefined();
    expect(Buffer.from(withTemplates.bytes).equals(Buffer.from(without.bytes))).toBe(true);
  });

  it('prints "unattributed" rather than dropping the row', () => {
    // A sign-in problem never takes the booth down, so an unattributed voucher
    // is expected paper. A missing row and a row saying nobody look identical
    // to reception, so the slip says which — in the word the Console's alert
    // uses for the same spins (SCRUM-223).
    const lines = textOf(build({ staff: null })).join('\n');
    expect(lines).toContain('Staff');
    expect(lines).toContain('unattributed');
    expect(lines).not.toContain('Not signed in');
    expect(lines).not.toContain('Nok (S-014)');
  });

  it('prints the name and code of whoever was on duty', () => {
    const lines = textOf(build({ staff: 'Nok (S-7KMQ)' }));
    expect(lines).toContain('Nok (S-7KMQ)');
  });

  it('prints the definition’s terms at the foot, after the single-use line (SCRUM-223)', () => {
    const lines = textOf(build());
    const singleUse = lines.indexOf('Single use · ใช้ได้ 1 ครั้ง');
    expect(singleUse).toBeGreaterThan(0);
    for (const term of data.terms) {
      const at = lines.indexOf(term);
      expect(at, term).toBeGreaterThan(singleUse);
    }
    // And no longer between the redemption sentence and the code as well.
    const code = lines.indexOf(data.voucherCode);
    for (const term of data.terms) expect(lines.indexOf(term)).toBeGreaterThan(code);
  });

  it('prints nothing for an empty footer line', () => {
    const withFooter = textOf(build());
    const without = textOf(build({ footerLine: '' }));
    expect(withFooter).toContain(data.footerLine);
    expect(without.length).toBe(withFooter.length - 1);
    expect(without).not.toContain('');
  });

  it('marks a reprint at the top, and a first print not at all (SCRUM-223)', () => {
    const first = textOf(build());
    expect(first.some((l) => l.startsWith('Reprint'))).toBe(false);

    const copy = build({ reprintNote: 'Reprint · 24 Sep 2026 16:40' });
    const lines = textOf(copy);
    expect(lines).toContain('Reprint · 24 Sep 2026 16:40');
    expect(lines.indexOf('Reprint · 24 Sep 2026 16:40')).toBeLessThan(lines.indexOf('★ YOU WON ★'));
    // The code is the code: a reprint never carries a different one.
    const qr = copy.document.blocks.find((b) => b.k === 'qr');
    expect(qr && qr.k === 'qr' ? qr.value : undefined).toBe(data.voucherCode);
    expect(copy.overflow).toEqual([]);
  });

  it('prints "No expiry" rather than dropping the row', () => {
    const lines = textOf(build({ expiresAt: null })).join('\n');
    expect(lines).toContain('Expires');
    expect(lines).toContain('No expiry');
  });

  it('prints the English prize alone when the prize has no Thai name', () => {
    const job = build({ prizeLineThai: null });
    const lines = textOf(job).join('\n');
    expect(lines).toContain('150 THB VOUCHER');
    expect(lines).not.toContain('คูปอง 150 บาท');
    // Still Thai on the slip: the single-use line is fixed text, not the prize.
    expect(lines).toContain('Single use · ใช้ได้ 1 ครั้ง');
    expect(job.overflow).toEqual([]);
  });

  it('prints no terms when the voucher definition carries none', () => {
    const job = build({ terms: [] });
    const lines = textOf(job).join('\n');
    expect(lines).not.toContain('Cannot be combined with other offers.');
    // The redemption sentence is not a term and still prints.
    expect(lines).toContain('Show this QR at OTO Reception');
    expect(job.overflow).toEqual([]);
  });

  /**
   * What a wrong width costs, measured on this content rather than reasoned
   * about.
   *
   * The booth printer is in no section of `DEVICE_INVENTORY.md` §2 and 576 dots
   * is an assumption (`templates/booth.ts`). If the head turns out to be 512,
   * `GS v 0` drops everything past dot 512 of a 576-dot raster and reports
   * nothing at all — so this walks the 576 layout and names what would be lost.
   *
   * **The result below is a property of THIS content, not of the template.** A
   * longer prize name, a longer redemption sentence or a wider code moves it,
   * which is the point: when the fixture changes, this number changes with it
   * and the diff says what the assumption now costs.
   */
  it('what a wrong width costs: names what a 512-dot head would drop', () => {
    const HEAD_DOTS = 512;
    const job = build();
    expect(job.layout.widthDots).toBe(576);

    const rightEdge = (i: LayoutItem): number => {
      switch (i.k) {
        case 'text':
          return i.x + i.widthDots;
        case 'qr':
          return i.x + i.matrix.size * i.moduleDots;
        case 'barcode':
          return i.x + i.modules.length * i.moduleDots;
        case 'image':
          return i.x + i.bitmap.width;
        case 'warning':
          return i.x + i.size;
        case 'dashes':
          return i.x + i.w;
        default:
          return i.x + i.w;
      }
    };

    const lost = job.layout.items
      .filter((i) => rightEdge(i) > HEAD_DOTS)
      .map((i) => (i.k === 'text' ? `text: ${i.text}` : i.k));

    expect(lost).toEqual([
      'dashes',
      'text: Show this QR at OTO Reception and get 150 THB off your ticket',
      'dashes',
      'dashes',
      'dashes',
    ]);

    // For this content the QR and the readable code both clear the narrower
    // head, so a truncated slip would still be redeemable while looking broken.
    // That is a measurement of one voucher, not a guarantee about any voucher.
    const qr = job.layout.items.find((i) => i.k === 'qr')!;
    expect(rightEdge(qr)).toBeLessThanOrEqual(HEAD_DOTS);
    const code = job.layout.items.find((i) => i.k === 'text' && i.text === data.voucherCode)!;
    expect(rightEdge(code)).toBeLessThanOrEqual(HEAD_DOTS);
  });

  it('lays out correctly for a 512-dot head when the profile is right', () => {
    // Which is a different thing from the test above: a correct 512 layout is
    // not what a 576 layout looks like truncated. Nothing overflows, the QR
    // keeps its full module size, and every part still prints.
    const job = build({}, escpos512);
    expect(job.layout.widthDots).toBe(512);
    expect(job.overflow).toEqual([]);
    const qr = job.layout.items.find((i) => i.k === 'qr')!;
    expect(qr.k === 'qr' ? qr.moduleDots : 0).toBe(8);
    const lines = textOf(job).join('\n');
    expect(lines).toContain(data.voucherCode);
    expect(lines).toContain('คูปอง 150 บาท');
  });
});

describe('the layout summary is the fixture diff', () => {
  it('serialises to JSON with no glyph arrays', () => {
    const job = renderJob(
      { kind: 'credit_voucher', data: { balance: '฿150', qrCode: 'wb-1' } },
      { device: escpos576, templates: TEMPLATES },
    );
    const summary = JSON.parse(JSON.stringify(layoutSummary(job.layout)));
    expect(summary.widthDots).toBe(576);
    expect(summary.items.some((i: { k: string }) => i.k === 'qr')).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('glyphs');
  });
});
