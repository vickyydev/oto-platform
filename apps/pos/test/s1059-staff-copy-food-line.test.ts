import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentCapture, familyTickNote } from '@/components/till/ConsentCapture';
import { ChildFoodProvisionPicker } from '@/components/shared/ChildFoodProvisionPicker';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { DICTIONARY } from '@/i18n/dictionary';
import { LanguageProvider } from '@/i18n/LanguageContext';
import type { SupervisionPolicy } from '@/types';
import { startFamilyFormHarness } from './support/family-form-harness/server';

/**
 * SCRUM-1059 (9) — STAFF'S COPY OF THE DROP-OFF FORM SAYS WHAT THE FAMILY CHOSE.
 *
 * On the till's mirror of the form ("Private child details", "Edit details"),
 * a child whose parent ticked "may order food with the included credit"
 * (SCRUM-1054) showed the food choice "No food" highlighted beside that tick
 * (staging's n5). The choice now reads "Included credit" while the tick
 * stands, in the form's languages (the same picker is the family's own half).
 * And a tick the family left once they had finished the form no longer says
 * "(the family ticks this on their screen)": it says "(not ticked by the
 * family)".
 */
beforeEach(() => {
  vi.stubGlobal('React', React);
});

const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");

const policy: SupervisionPolicy = {
  bands: [{ id: 'band-5-8', label: '5–8', minAge: 5, maxAge: 8, requirement: 'drop_off' }],
  siblingWaiver: { enabled: false, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true },
  confirmations: [{ id: 'confirm-optional', text: 'ZZ TEST optional photo for the wall', required: false, order: 0 }],
};

const slot = (orderWithIncludedCredit: boolean | undefined): SupervisedSlot => ({
  id: 'zz-slot', sourceLineId: 'zz-line', ticketType: { id: 'zz-eat-play', name: 'Eat & Play' } as SupervisedSlot['ticketType'],
  name: 'ZZ TEST Nok', age: '6', waived: false, allergiesMedical: '', foodRestrictions: '', mayOrderFood: false, optIn: true,
  foodProvision: { mode: 'none', paidTHB: 0 }, ...(orderWithIncludedCredit !== undefined ? { orderWithIncludedCredit } : {}),
});

/** Staff's copy, as Till.tsx draws it: read-only ticks, the ticket's ฿1300 included. */
const staffCopy = (ticked: boolean, familyFinished: boolean) => html(React.createElement(LanguageProvider, null,
  React.createElement(ConsentCapture, {
    staffScreen: true, ticksReadOnly: true, familyFinished, slots: [slot(ticked)], includedCreditTHB: () => 1300,
    parentName: 'ZZ TEST guardian', consentAck: true, policy, acknowledgedConfirmationIds: [],
    onParentNameChange: () => undefined, onConsentAckChange: () => undefined, onUpdateChild: () => undefined,
    onToggleConfirmation: () => undefined,
  })));

/** The three food choices' labels, in order. */
const choices = (markup: string) =>
  [...markup.matchAll(/<button type="button" class="flex flex-1 flex-col[^"]*"><svg[^>]*>.*?<\/svg><span class="[^"]*">([^<]+)<\/span><\/button>/g)].map((m) => m[1]);

describe('SCRUM-1059 (9): the food line beside the family\'s tick', () => {
  it('ticked: the chosen food choice reads "Included credit", never "No food"', () => {
    const out = staffCopy(true, false);
    expect(choices(out)).toEqual(['Included credit', 'Prepaid credit', 'Choose items']);
    expect(out).toContain('ZZ TEST Nok may order food with the included credit');
    expect(out).toContain('(ticked by the family)');
  });

  it('not ticked: "No food", as before', () => {
    expect(choices(staffCopy(false, false))).toEqual(['No food', 'Prepaid credit', 'Choose items']);
  });

  it('the choice is the same button: its place, its highlight and what it does do not change', () => {
    const picker = (includedTicked: boolean) => html(React.createElement(ChildFoodProvisionPicker, {
      childName: 'ZZ TEST Nok', value: { mode: 'none', paidTHB: 0 }, onChange: () => undefined, noneNote: false, includedTicked }));
    const classes = (markup: string) => [...markup.matchAll(/<button type="button" class="([^"]+)"/g)].map((m) => m[1]);
    expect(classes(picker(true))).toEqual(classes(picker(false)));
  });

  it('in each of the form\'s five languages', () => {
    expect(DICTIONARY['food.includedCredit']).toEqual({ en: 'Included credit', zh: '已含餐饮额度', th: 'เครดิตอาหารที่รวมไว้', ru: 'Включённый кредит', fr: 'Crédit repas inclus' });
  });
});

describe('SCRUM-1059 (9): a tick the family left after finishing', () => {
  it('reads "not ticked by the family" once they finished, "the family ticks this on their screen" before', () => {
    expect(familyTickNote(true, true)).toBe('ticked by the family');
    expect(familyTickNote(false, false)).toBe('the family ticks this on their screen');
    expect(familyTickNote(false, true)).toBe('not ticked by the family');
    const finished = staffCopy(false, true);
    expect(finished).not.toContain('the family ticks this on their screen');
    // The included-credit tick and the optional confirmation the family left.
    expect(finished.match(/\(not ticked by the family\)/g)).toHaveLength(2);
    expect(staffCopy(false, false).match(/\(the family ticks this on their screen\)/g)).toHaveLength(2);
  });

  it('the till tells both of its staff copies when the family has finished', () => {
    const till = readFileSync(new URL('../src/pages/Till.tsx', import.meta.url), 'utf8');
    expect(till.match(/<ConsentCapture staffScreen [^\n]*familyFinished=\{consentCandidate\.completed\}/g)).toHaveLength(2);
  });
});

// --- drawn in a browser -------------------------------------------------------

const SHOTS = process.env.FAMILYFORM_SHOTS;
const { harness, why } = await startFamilyFormHarness();
if (!harness) console.warn(`SCRUM-1059 staff copy pictures skipped: no browser to draw the form (${why})`);
afterAll(async () => { await harness?.close(); });

describe.skipIf(!harness)("staff's copy in a browser (SCRUM-1059 9)", () => {
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }] as const) {
    it(`at ${size.width}x${size.height}: "Included credit" whole and chosen, the unticked child "not ticked by the family"`, async () => {
      const page = await harness!.open('screen=staff&finished=1', size, { touch: false });
      const included = page.getByRole('button', { name: 'Included credit' });
      await included.scrollIntoViewIfNeeded();
      expect(await included.evaluate((b) => [...b.querySelectorAll('span')].every((s) => s.scrollWidth <= s.clientWidth + 1))).toBe(true);
      expect(await included.evaluate((b) => b.className.includes('border-primary'))).toBe(true);
      expect(await page.getByText('(the family ticks this on their screen)').count()).toBe(0);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `staff-copy-${size.width}x${size.height}.png`) });
    }, 60_000);
  }
});
