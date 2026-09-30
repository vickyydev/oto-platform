import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrintTemplate } from '@/types';
import {
  fromApi,
  isDirty,
  paperLabel,
  previewRequest,
  saveBarView,
  saveBody,
  testPrintOutcome,
} from '@/components/admin/templates/templateDraft';
import {
  APPLICABLE_FIELDS,
  FIELD_META,
  editorGroups,
  isBandType,
  moreOptions,
  type EditorRow,
} from '@/components/admin/templates/templateFields';
import {
  DEFAULT_PREVIEW_SAMPLE,
  PREVIEW_SAMPLES,
} from '@/components/admin/templates/previewSamples';
import { TemplateEditor } from '@/components/admin/templates/TemplateEditor';

/**
 * SCRUM-472 — the Print Templates editor redesigned around its preview.
 *
 * The rules under the screen are pure and tested here: what counts as an
 * unsaved change (the save bar's one question), what the preview is asked
 * for, what the paper chip says, how a test print's answer reads, and how the
 * controls are grouped. The screen itself is rendered once without a browser,
 * to pin its structure: grouped, iconed rows with eyes, and no save bar until
 * something changes.
 */

vi.mock('@/store/CatalogStoreContext', () => ({
  useCatalogStore: () => ({ mutators: { upsertPrintTemplate: () => undefined } }),
  MOCK_MUTATOR_TICKETS: { upsertPrintTemplate: 'S2-06' },
}));
vi.mock('@/station/StationContext', () => ({
  useStation: () => ({ station: { stationId: '0192f3a4-5b6c-7d8e-9fa0-b1c2d3e4f506' } }),
}));

// This runner has no React plugin (vitest.config.ts), so the component's JSX
// is compiled to `React.createElement` and looks for `React` in scope — put
// there for each test, as `sale-detail-label.test.ts` does.
beforeEach(() => {
  vi.stubGlobal('React', React);
});

const receipt: PrintTemplate = {
  id: 'tpl-receipt',
  type: 'receipt',
  name: 'Standard receipt',
  showLogo: true,
  headerText: 'Oto Play Park',
  footerText: 'Thank you',
  fields: { itemizedLines: true, taxServiceBreakdown: true, voucherInfo: false },
};

const kidsBand: PrintTemplate = {
  id: 'tpl-kids',
  type: 'kids_wristband',
  name: 'Kids band',
  showLogo: false,
  fields: { holderName: true, allergyLine: true, qr: true },
};

describe('what counts as an unsaved change', () => {
  it('an untouched draft is clean', () => {
    expect(isDirty(receipt, { ...receipt, fields: { ...receipt.fields } })).toBe(false);
  });

  it('a section switched on, a logo hidden, a line of text or a name is a change', () => {
    expect(isDirty(receipt, { ...receipt, fields: { ...receipt.fields, voucherInfo: true } })).toBe(
      true,
    );
    expect(isDirty(receipt, { ...receipt, showLogo: false })).toBe(true);
    expect(isDirty(receipt, { ...receipt, footerText: 'Thank you!' })).toBe(true);
    expect(isDirty(receipt, { ...receipt, name: 'Receipt' })).toBe(true);
  });

  it('a section never set and one switched off print the same, so are the same', () => {
    const unset: PrintTemplate = { ...receipt, fields: { itemizedLines: true, taxServiceBreakdown: true } };
    expect(isDirty(unset, { ...unset, fields: { ...unset.fields, voucherInfo: false } })).toBe(false);
  });

  it('an empty line of text and no line are the same', () => {
    const none: PrintTemplate = { ...receipt, headerText: undefined };
    expect(isDirty(none, { ...none, headerText: '' })).toBe(false);
  });
});

describe('the save bar', () => {
  it('shows while there is something to save, and while a save is in flight', () => {
    expect(saveBarView({ dirty: true, saving: false, saveError: null }).shown).toBe(true);
    expect(saveBarView({ dirty: false, saving: true, saveError: null }).shown).toBe(true);
    expect(saveBarView({ dirty: false, saving: false, saveError: null }).shown).toBe(false);
  });

  it('carries a failed save’s reason while the change is still there', () => {
    expect(saveBarView({ dirty: true, saving: false, saveError: 'Offline' })).toEqual({
      shown: true,
      error: 'Offline',
    });
  });

  it('goes away when a change is flipped back by hand after a failed save', () => {
    // The fix round's reproduction: the bar used to stay up on the error alone,
    // offering a Save that would PATCH nothing but the version — and with it
    // the branch's config hash, so every box on the branch pulled again.
    const failed = { dirty: true, saving: false, saveError: 'The template could not be saved.' };
    expect(saveBarView(failed).shown).toBe(true);
    expect(saveBarView({ ...failed, dirty: false })).toEqual({ shown: false, error: null });
  });
});

describe('what is sent', () => {
  it('saves a trimmed name and says null for an absent line', () => {
    const body = saveBody({ ...receipt, name: '  Receipt  ', headerText: undefined });
    expect(body.name).toBe('Receipt');
    expect(body.headerText).toBeNull();
    expect(body.footerText).toBe('Thank you');
  });

  it('asks for the preview without naming the default scenario, and names any other', () => {
    const plain = JSON.parse(previewRequest(receipt, null)) as Record<string, unknown>;
    expect(plain).not.toHaveProperty('sample');
    expect(plain.stationId).toBeNull();
    expect(previewRequest(receipt, null, DEFAULT_PREVIEW_SAMPLE)).toBe(previewRequest(receipt, null));
    const full = JSON.parse(previewRequest(receipt, 'st-1', 'full')) as Record<string, unknown>;
    expect(full.sample).toBe('full');
    expect(full.stationId).toBe('st-1');
  });

  it('does not re-ask when only the name changed — nothing on paper moved', () => {
    expect(previewRequest({ ...receipt, name: 'Renamed' }, null)).toBe(previewRequest(receipt, null));
  });

  it('reads the API row once, at the boundary', () => {
    const row = fromApi({
      id: 'x',
      branchId: 'b',
      type: 'receipt',
      name: 'R',
      showLogo: false,
      headerText: null,
      footerText: 'F',
      fields: { itemizedLines: true },
      version: 3,
      updatedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(row.headerText).toBeUndefined();
    expect(row.footerText).toBe('F');
    expect(row).not.toHaveProperty('version');
  });
});

describe('the scenarios the preview offers', () => {
  it('lists the Test print sample first, as the default, and at least three more', () => {
    expect(PREVIEW_SAMPLES[0].id).toBe(DEFAULT_PREVIEW_SAMPLE);
    expect(PREVIEW_SAMPLES.map((s) => s.id)).toEqual(['standard', 'simple', 'full', 'long_names']);
  });
});

describe('the paper chip', () => {
  it('names the receipt roll from the width in dots', () => {
    expect(paperLabel('receipt', 576)).toBe('80 mm');
    expect(paperLabel('kitchen_ticket', 512)).toBe('80 mm');
    expect(paperLabel('credit_voucher', 384)).toBe('58 mm');
  });

  it('names a band by its own width, eight dots a millimetre', () => {
    expect(paperLabel('kids_wristband', 400)).toBe('50 mm band');
    expect(paperLabel('adult_wristband', 200)).toBe('25 mm band');
  });
});

describe('a test print’s answer, in one line', () => {
  it('queued is sent, to the printer the job or the editor named', () => {
    const out = testPrintOutcome({ status: 'queued', deviceLabel: null, errorMessage: null }, 'Receipt Printer 1');
    expect(out.tone).toBe('ok');
    expect(out.text).toContain('Sent to Receipt Printer 1');
  });

  it('skipped is not printed, with the reason', () => {
    const out = testPrintOutcome(
      { status: 'skipped', deviceLabel: null, errorMessage: 'No receipt printer is assigned to this station' },
      null,
    );
    expect(out.tone).toBe('warn');
    expect(out.text).toBe('Not printed — No receipt printer is assigned to this station.');
  });

  it('failed says where and why', () => {
    const out = testPrintOutcome(
      { status: 'failed', deviceLabel: 'Receipt Printer 1', errorMessage: 'out of paper' },
      null,
    );
    expect(out.tone).toBe('error');
    expect(out.text).toBe('Failed on Receipt Printer 1 — out of paper.');
  });
});

describe('the controls, grouped the way the paper is', () => {
  const keysOf = (rows: EditorRow[]) =>
    rows.map((r) => (r.kind === 'field' ? r.key : r.kind === 'text' ? r.which : 'logo'));

  it('a receipt reads Top, Body, Bottom, with its sections in print order', () => {
    const groups = editorGroups('receipt');
    expect(groups.map((g) => g.title)).toEqual(['Top', 'Body', 'Bottom']);
    expect(keysOf(groups[0]!.rows)).toEqual(['logo', 'headerText']);
    expect(keysOf(groups[1]!.rows)).toEqual(APPLICABLE_FIELDS.receipt);
    expect(keysOf(groups[2]!.rows)).toEqual(['footerText']);
  });

  it('a band is grouped by purpose, with every applicable section once and nothing else', () => {
    for (const type of ['kids_wristband', 'adult_wristband'] as const) {
      const groups = editorGroups(type);
      expect(groups.map((g) => g.title)).toEqual(['Identity', 'Safety', 'Entry']);
      const keys = groups.flatMap((g) => keysOf(g.rows));
      expect([...keys].sort()).toEqual([...APPLICABLE_FIELDS[type]].sort());
      // No logo, no header: the band stock carries the branding.
      expect(keys).not.toContain('logo');
      expect(keys).not.toContain('headerText');
    }
    const adultSafety = editorGroups('adult_wristband').find((g) => g.id === 'safety')!;
    expect(keysOf(adultSafety.rows)).not.toContain('allergyLine');
  });

  it('every type puts every one of its sections somewhere, each with an icon', () => {
    for (const type of Object.keys(APPLICABLE_FIELDS) as (keyof typeof APPLICABLE_FIELDS)[]) {
      const keys = editorGroups(type).flatMap((g) => keysOf(g.rows));
      for (const key of APPLICABLE_FIELDS[type]) {
        expect(keys, `${type} ${key}`).toContain(key);
        expect(FIELD_META[key].icon).toBeTruthy();
      }
    }
  });

  it('folds the name away everywhere, and a band’s unprinted footer with it', () => {
    expect(moreOptions('receipt')).toEqual(['name']);
    expect(moreOptions('kids_wristband')).toEqual(['name', 'footerText']);
    expect(isBandType('adult_wristband')).toBe(true);
    expect(isBandType('bar_ticket')).toBe(false);
  });
});

describe('the editor, drawn once', () => {
  it('shows grouped eye rows, the preview’s scenario picker and Test print, and no save bar', () => {

    const html = renderToStaticMarkup(
      React.createElement(TemplateEditor, { template: receipt, live: true, onClose: () => undefined }),
    );
    for (const title of ['Top', 'Body', 'Bottom']) expect(html).toContain(`>${title}<`);
    // Eyes, not switches: each section is a pressed or unpressed button.
    expect(html).not.toContain('role="switch"');
    expect(html).toContain('aria-label="Itemized lines on the printout"');
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="Credit grants issued on the printout"/);
    expect(html).toContain('2 of 3 shown');
    expect(html).toContain('More options');
    expect(html).toContain('Fuller sale');
    expect(html).toContain('Print test');
    // Nothing changed, so there is nothing to save.
    expect(html).not.toContain('Unsaved changes');
    expect(html).not.toContain('Save changes');
  });

  it('a band gets Identity, Safety and Entry, and no logo row', () => {

    const html = renderToStaticMarkup(
      React.createElement(TemplateEditor, { template: kidsBand, live: true, onClose: () => undefined }),
    );
    for (const title of ['Identity', 'Safety', 'Entry']) expect(html).toContain(`>${title}<`);
    expect(html).not.toContain('aria-label="Logo on the printout"');
    expect(html).not.toContain('>Top<');
  });
});
