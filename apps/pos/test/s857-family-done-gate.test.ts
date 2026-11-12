import { describe, expect, it } from 'vitest';
import { tFor } from '@/i18n/LanguageContext';
import { DICTIONARY } from '@/i18n/dictionary';
import type { SupportedLang } from '@/i18n/types';
import {
  CONSENT_MISSING_KEY,
  consentMissing,
  consentMissingLine,
  familyDoneDecision,
  type ConsentFinishInput,
  type ConsentMissing,
} from '@/lib/consentFinish';

/**
 * SCRUM-857 / SCRUM-875 — THE FAMILY'S DONE: WHAT STILL STANDS IN ITS WAY,
 * AND WHEN THE TILL HONOURS IT.
 *
 * The owner's ruling of 8 November: "Once the customer has filled in all the
 * information, passed all checks and clicked Done, they proceed to the next
 * step without receptionist confirmation." Each check that is not yet met
 * keeps Done from being pressed and is named on the family's screen, in the
 * form's order; and a Done that reaches the till moves the sale on only for
 * the sale and form it was pressed on, while the till is still on that form
 * and every check passes.
 */

const complete: ConsentFinishInput = {
  children: [{ name: 'ZZ TEST Mai', ageYears: 6 }, { name: 'ZZ TEST Ton', ageYears: 4 }],
  consentRequired: true,
  guardianName: 'ZZ TEST guardian',
  consentAcknowledged: true,
  confirmations: [{ required: true, acknowledged: true }, { required: false, acknowledged: false }],
  contact: { confirmed: true, problem: null },
  photosTaken: true,
};

describe('each missing check blocks Done with its own reason', () => {
  it('nothing is missing on a finished form', () => {
    expect(consentMissing(complete)).toEqual([]);
  });

  const cases: [string, Partial<ConsentFinishInput>, ConsentMissing][] = [
    ['a child with no name', { children: [{ name: ' ', ageYears: 6 }, { name: 'ZZ TEST Ton', ageYears: 4 }] }, 'children'],
    ['a child with no age', { children: [{ name: 'ZZ TEST Mai', ageYears: null }] }, 'children'],
    ['no guardian name', { guardianName: '  ' }, 'guardian_name'],
    ['the consent not ticked', { consentAcknowledged: false }, 'consent'],
    ['a required confirmation not ticked', { confirmations: [{ required: true, acknowledged: false }] }, 'confirmations'],
    ['the number not confirmed', { contact: { confirmed: false, problem: null } }, 'contact'],
    ['no number to confirm', { contact: { confirmed: false, problem: 'empty' } }, 'contact'],
    ['a number that cannot take messages', { contact: { confirmed: true, problem: 'invalid' } }, 'contact'],
    ['a child in care without a photo', { photosTaken: false }, 'photo'],
  ];
  it.each(cases)('%s', (_name, change, reason) => {
    expect(consentMissing({ ...complete, ...change })).toEqual([reason]);
  });

  it('names everything missing at once, in the order the form asks for it', () => {
    expect(consentMissing({
      children: [{ name: '', ageYears: null }], consentRequired: true, guardianName: '', consentAcknowledged: false,
      confirmations: [{ required: true, acknowledged: false }], contact: { confirmed: false, problem: 'empty' }, photosTaken: false,
    })).toEqual(['children', 'guardian_name', 'consent', 'confirmations', 'contact', 'photo']);
  });

  it('an optional confirmation left unticked is not missing', () => {
    expect(consentMissing({ ...complete, confirmations: [{ required: false, acknowledged: false }] })).toEqual([]);
  });

  it('a form that does not ask the number confirmation (an older till) does not ask for it', () => {
    const { contact: _contact, ...withoutContact } = complete;
    expect(consentMissing({ ...withoutContact })).toEqual([]);
  });

  it('a group with no child in care asks no name, consent, number or photo; only the details and confirmations', () => {
    const plain = { ...complete, consentRequired: false, guardianName: '', consentAcknowledged: false,
      contact: { confirmed: false, problem: 'empty' as const }, photosTaken: false };
    expect(consentMissing(plain)).toEqual([]);
    expect(consentMissing({ ...plain, confirmations: [{ required: true, acknowledged: false }] })).toEqual(['confirmations']);
  });
});

describe('the short line the family reads, in all five languages', () => {
  const LANGS: SupportedLang[] = ['en', 'zh', 'th', 'ru', 'fr'];

  it('every key it uses is in the dictionary in every language, so no raw key is ever shown', () => {
    for (const key of [...Object.values(CONSENT_MISSING_KEY), 'superviseConsent.stillNeeded', 'superviseConsent.finishing', 'superviseConsent.notSaved']) {
      for (const lang of LANGS) expect(DICTIONARY[key]?.[lang], `${key} ${lang}`).toBeTruthy();
    }
  });

  it.each(LANGS)('%s: one line naming each missing item, the channel filled in', (lang) => {
    const t = tFor(lang);
    const line = consentMissingLine(t, ['children', 'contact', 'photo'], 'Telegram')!;
    expect(line).toContain(t('superviseConsent.missingChildren'));
    expect(line).toContain(t('superviseConsent.missingContact', { channel: 'Telegram' }));
    expect(line).toContain('Telegram');
    expect(line).toContain(t('superviseConsent.missingPhoto'));
    expect(line).not.toMatch(/superviseConsent\.|\{\{/);
  });

  it('no line when nothing is missing', () => {
    expect(consentMissingLine(tFor('en'), [], 'WhatsApp')).toBeNull();
  });

  it('reads plainly in English', () => {
    expect(consentMissingLine(tFor('en'), ['guardian_name', 'contact'], 'WhatsApp'))
      .toBe('Still needed before Done: your name · confirming your WhatsApp number');
  });
});

describe('a Done that reaches the till', () => {
  const base = { onForm: true, sameForm: true, saving: false, ready: true };

  it('moves the sale on when it is for this form and every check passes', () => {
    expect(familyDoneDecision(base)).toBe('move_on');
  });

  it('is ignored by a till no longer on the form: staff went back, the sale was abandoned or another started', () => {
    expect(familyDoneDecision({ ...base, onForm: false })).toBe('ignore');
  });

  it('is ignored for another sale, family or form revision than the one the till shows now', () => {
    expect(familyDoneDecision({ ...base, sameForm: false })).toBe('ignore');
    expect(familyDoneDecision({ ...base, onForm: false, sameForm: false, ready: false })).toBe('ignore');
  });

  it('waits for staff when a check the till makes is not met', () => {
    expect(familyDoneDecision({ ...base, ready: false })).toBe('wait');
  });

  it('never starts a second write while one is running (a double tap, or staff pressing Continue too)', () => {
    expect(familyDoneDecision({ ...base, saving: true })).toBe('wait');
  });
});
