import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

/**
 * SCRUM-857 — a run of the gate that outlives its sale. The family's Done
 * starts the run with nobody pressing anything at the till, and staff may go
 * Back and Cancel while it is saving: the next sale must never carry this
 * family's member, visit or children, and a cancelled sale registers nobody.
 * The e2e (smoke.spec.ts, the family's photo and Done) holds the visit write
 * open across a Back and Cancel and checks the next sale.
 */
describe('a gate run whose sale was cancelled while it saved', () => {
  const till = readFileSync(resolve(import.meta.dirname, '../src/pages/Till.tsx'), 'utf8');
  const gate = till.slice(till.indexOf('const resolveSupervisionGate'), till.indexOf('const runSupervisionGate'));

  it('every setter after an await asks whether the sale is still the run’s own', () => {
    expect(gate).toMatch(/const gateEpoch = saleEpochRef\.current;\s*const ownSale = \(\) => gateEpoch === saleEpochRef\.current;/);
    expect(gate).toMatch(/guardian = await findOrCreateGateMember\([^)]*\)\);\s*if \(ownSale\(\)\) setMember\(guardian\);/);
    // (Where the SCRUM-887 hold is on the till, its `gateOnline.noteWrite()` is guarded the same way.)
    expect(gate).toMatch(/onSaved: \(slotId, child, guardianId\) => \{\s*if \(!ownSale\(\)\) return;\s*(?:gateOnline\.noteWrite\(\);\s*)?applySavedChild\(child, guardianId\);/);
    expect(gate).toMatch(/gateVisitId = await confirmVisitChildren\([\s\S]*?\);\s*(?:if \(ownSale\(\)\) gateOnline\.noteWrite\(\);\s*)?if \(ownSale\(\)\) setConfirmedVisitId\(gateVisitId\);/);
    expect(gate).not.toMatch(/^\s*setMember\(guardian\);/m);
    expect(gate).not.toMatch(/^\s*setConfirmedVisitId\(gateVisitId\);/m);
  });

  it('writes no registration for a sale that is gone, so the next gate keeps its own ids', () => {
    const stop = gate.indexOf('if (!ownSale()) return { ok: false, message: SALE_MOVED_ON };\n    let created');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(gate.indexOf('gateRegistrationIdRef.current = regId;'));
    expect(stop).toBeLessThan(gate.indexOf('checkinApi.createRegistration('));
  });

  it('the staff’s Continue and the family’s Done end the press the same way, before the family hears the outcome', () => {
    const run = till.slice(till.indexOf('const runSupervisionGate'), till.indexOf('const findOrCreateGateMember'));
    // (Where the SCRUM-887 hold is on the till, its `gateOnline.endPress();` comes first.)
    expect(run).toMatch(/void resolveSupervisionGate\(\)\.finally\(\(\) => \{\s*(?:gateOnline\.endPress\(\);\s*)?gateRunningRef\.current = false;\s*setGateSaving\(false\);\s*setConsentFinishing\(null\);\s*\}\)\.then\(settle, /);
    expect(run).toMatch(/const handleSupervisionContinue = \(\) => \{\s*if \(gateSaving\) return;\s*runSupervisionGate\('staff'\);\s*\};/);
  });

  it('changes the cart only for its own sale, and says nothing of a failure on the next one', () => {
    expect(gate).toMatch(/if \(!ownSale\(\)\) return \{ ok: false, message: SALE_MOVED_ON \};\s*\/\/ A source line fully converts/);
    expect(gate.match(/\} catch \(err\) \{\s*if \(!ownSale\(\)\) return \{ ok: false, message: SALE_MOVED_ON \};\s*toast\(/g)).toHaveLength(2);
  });
});
