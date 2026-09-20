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
import type { PrintTemplate } from '../src/index';
import { PROFILES, TEMPLATES } from './fixtures';

const escpos576 = PROFILES.escpos576!;
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
