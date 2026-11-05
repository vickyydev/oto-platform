import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentPromptSchema, type ConsentPrompt, type StationSessionDocument } from '@oto/shared';
import { ConsentCapture, ConsentTicksStatus } from '@/components/till/ConsentCapture';
import { PublicConsentCapture, mergeConsentDraft } from '@/components/till/PublicConsentCapture';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { LanguageProvider, tFor } from '@/i18n/LanguageContext';
import { DICTIONARY } from '@/i18n/dictionary';
import type { SupportedLang } from '@/i18n/types';
import { consentSlotPatches } from '@/lib/consentForm';
import { readTicketDisplayView, ticketDisplayPresentation, type TicketDisplayState } from '@/lib/displaySession';
import type { Sale } from '@/types';

vi.mock('@/components/till/AddOnsGrid', () => ({ AddOnsGrid: () => null }));

/**
 * SCRUM-764 — THE DROP-OFF AND NANNY FORMS ON THE CUSTOMER SCREEN, IN SYNC
 * WITH THE TILL; THE AGREEMENT TICKS ON THE CUSTOMER SIDE ONLY.
 *
 * Mariia (30 October), confirmed by Tony as the original design (4 November):
 * the family fills the form on their own screen, in their language; the till
 * follows it so reception can help; staff can no longer tick the agreements,
 * the till shows whether each one is ticked.
 */

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const under = (lang: SupportedLang, element: ReactElement): string => {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => lang, setItem: () => undefined },
    location: { search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test-764', children: element }));
};

/** The form as the till publishes it the moment the gate opens: nobody named yet. */
const blank: ConsentPrompt = {
  kind: 'consent', requestId: 'request-1', visitorId: 'visitor-1',
  slots: [
    { id: 'slot-a', name: '', ageYears: null, requirement: 'none', dateOfBirth: null, allergiesMedical: '', foodRestrictions: '' },
    { id: 'slot-b', name: 'Saved Ploy', ageYears: 3, requirement: 'nanny', dateOfBirth: '2023-01-01', saved: true },
  ],
  guardianName: '', consentRequired: true, consentAcknowledged: false,
  confirmations: [{ id: 'pickup', text: 'I will collect my child before closing', required: true, acknowledged: false }],
  guardianPhone: '+66812345678', fees: { nannyHourlyTHB: 300, dropOffFeeTHB: 200 },
  staffReady: false, canContinue: false, completed: false,
};

describe('the form on the customer screen', () => {
  it('is a valid public prompt before anybody has been named, so the family fills it from the first step', () => {
    expect(ConsentPromptSchema.safeParse(blank).success).toBe(true);
  });

  it.each(['en', 'th', 'ru'] as const)('%s: opens on the children step with name and age to fill, in the customer’s language', (lang) => {
    const t = tFor(lang);
    const html = under(lang, createElement(PublicConsentCapture, { prompt: blank, busy: false, onAction: () => undefined }));
    expect(html).toContain('data-testid="consent-steps"');
    for (const key of ['superviseConsent.stepChildren', 'superviseConsent.stepCare', 'superviseConsent.stepAgreements',
      'superviseConsent.childName', 'superviseConsent.nameAndAgeFirst']) {
      expect(html, key).toContain(t(key).replace(/'/g, '&#x27;'));
    }
    expect(html).toContain(t('superviseConsent.stepOf', { n: 1, total: 3 }));
    // Two children, each with a name box the family types into.
    expect(html.match(/data-testid="consent-child"/g)).toHaveLength(2);
    expect(html).toContain('value="Saved Ploy"');
    // The nanny's rate is on the form for the child who needs one.
    expect(html).toContain(t('superviseConsent.reqNanny'));
    expect(html).toContain(t('superviseConsent.requiredNannyRate', { rate: 300 }));
    // No agreement is ticked from this step.
    expect(html).not.toContain('data-testid="public-consent-ack"');
  });

  it('every new word is there in all five languages', () => {
    for (const key of ['superviseConsent.stepChildren', 'superviseConsent.stepCare', 'superviseConsent.stepAgreements',
      'superviseConsent.stepOf', 'superviseConsent.teamFollowing', 'superviseConsent.nameAndAgeFirst',
      'superviseConsent.savedOnProfile', 'superviseConsent.teamComing']) {
      const entry = DICTIONARY[key]!;
      for (const lang of ['en', 'zh', 'th', 'ru', 'fr'] as const) expect(entry[lang], `${key} ${lang}`).toBeTruthy();
      for (const lang of ['zh', 'th', 'ru', 'fr'] as const) expect(entry[lang], `${key} ${lang}`).not.toBe(entry.en);
    }
  });

  it('a copy from the till takes the fields the family has not touched and keeps what they are typing', () => {
    const base = { slots: { a: { name: '', dateOfBirth: null, ageYears: null, allergiesMedical: '', foodRestrictions: '' } },
      guardianName: '', guardianPhone: '', consentAcknowledged: false, confirmations: [] as string[] };
    const local = { ...base, slots: { a: { ...base.slots.a, allergiesMedical: 'Peanu' } }, consentAcknowledged: true };
    // Reception typed the name on the till while the family was typing the allergy.
    const fromTill = { ...base, slots: { a: { ...base.slots.a, name: 'Mai', dateOfBirth: '2020-01-02', ageYears: 6 } } };
    const merged = mergeConsentDraft(local, base, fromTill);
    expect(merged.slots.a).toEqual({ name: 'Mai', dateOfBirth: '2020-01-02', ageYears: 6, allergiesMedical: 'Peanu', foodRestrictions: '' });
    expect(merged.consentAcknowledged).toBe(true);
  });
});

describe('the till follows the form', () => {
  const slot = (id: string, extra: Partial<SupervisedSlot> = {}): SupervisedSlot => ({
    id, sourceLineId: 'line', ticketType: {} as SupervisedSlot['ticketType'], name: '', age: '', waived: false,
    allergiesMedical: '', foodRestrictions: '', mayOrderFood: false, ...extra,
  });

  it('mirrors each child the family filled, and leaves a saved child’s care notes to the profile', () => {
    const patches = consentSlotPatches([slot('a'), slot('b', { savedChildId: 'child-1', allergiesMedical: 'On profile' })], [
      { id: 'a', name: 'Mai', dateOfBirth: '2020-01-02', ageYears: 6, allergiesMedical: 'Peanuts', foodRestrictions: 'Halal' },
      { id: 'b', name: 'Ploy', dateOfBirth: null, ageYears: 3, allergiesMedical: 'Typed on the display', foodRestrictions: '' },
      { id: 'not-on-this-form', name: 'X', dateOfBirth: null, ageYears: 5, allergiesMedical: '', foodRestrictions: '' },
    ]);
    expect(patches).toEqual([
      { id: 'a', patch: { name: 'Mai', dateOfBirth: '2020-01-02', age: '6', allergiesMedical: 'Peanuts', foodRestrictions: 'Halal' } },
      { id: 'b', patch: { name: 'Ploy', dateOfBirth: undefined, age: '3' } },
    ]);
  });

  it('publishes the form to a paired display from the first step, and the display reads it', () => {
    const sale = { id: 'sale-764', tier: 'tourist', total: 0, lines: [], manualDiscounts: [], creditGrants: [],
      bracelets: { adults: 0, children: 0 } } as unknown as Sale;
    const state: TicketDisplayState = {
      stage: 'input', step: 7, sessionKey: '1', tier: 'tourist', phone: '', nickname: '', contactChannel: 'whatsapp',
      member: null, sale, online: true, consent: (({ kind: _kind, requestId: _request, ...rest }) => rest)(blank),
      totals: { manualAmounts: {}, discountAmount: 0, total: 0, taxBreakdown: { serviceChargeTotal: 0, categories: [] } } as never,
    };
    const presented = ticketDisplayPresentation(state, 'request-9');
    expect(presented.prompt).toMatchObject({ kind: 'consent', requestId: 'request-9', guardianPhone: '+66812345678' });
    const view = readTicketDisplayView({ stationId: 's', boxId: 'b', schemaVersion: 1, sequence: 1, language: 'en', lease: null,
      takeoverCount: 0, updatedAt: '2026-11-05T00:00:00.000Z', ...presented, step: null } as StationSessionDocument);
    expect(view?.consent?.slots[0]).toMatchObject({ name: '', ageYears: null });
  });

  it('takes a filled step into the gate, and keeps the form on the display when the family asks for help', () => {
    const till = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Till.tsx'), 'utf8');
    expect(till).toMatch(/action\.data\.action === 'fill'\) \{[\s\S]*?consentSlotPatches\(superSlots, filled\.slots\)[\s\S]*?setSuperConsentAck\(filled\.consentAcknowledged\)/);
    expect(till).toMatch(/const consent = step === 7 && displayOnline\n/);
    expect(till).toMatch(/<ConsentTicksStatus consentRequired=\{consentRequired\}/);
  });
});

describe('the agreement ticks are the family’s alone', () => {
  const props = {
    slots: [{ id: 's1', name: 'Mai', age: '6', waived: false, optIn: false, allergiesMedical: '', foodRestrictions: '' }],
    parentName: 'Guardian', consentAck: false,
    policy: {
      bands: [{ id: 'b', label: 'All', minAge: 0, maxAge: null, requirement: 'nanny' }],
      siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true },
      confirmations: [{ id: 'pickup', text: 'I will collect my child before closing', required: true, order: 1 }],
    },
    onParentNameChange: () => undefined, onConsentAckChange: () => { throw new Error('staff ticked'); },
    onUpdateChild: () => undefined, acknowledgedConfirmationIds: [], onToggleConfirmation: () => { throw new Error('staff ticked'); },
  };
  const ticks = (html: string, id: string) => [...html.matchAll(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`, 'g'))].map((m) => m[0]);

  it('staff cannot tick an agreement on their copy of the form; they see whether it is ticked', () => {
    const html = under('en', createElement(ConsentCapture, { ...props, staffScreen: true, ticksReadOnly: true } as never));
    const consent = ticks(html, 'consent-ack');
    const confirmations = ticks(html, 'consent-confirmation');
    expect(consent).toHaveLength(1);
    expect(confirmations).toHaveLength(1);
    for (const button of [...consent, ...confirmations]) expect(button).toContain('disabled=""');
    expect(html).toContain('the family ticks this on their screen');
  });

  it('the customer’s half of the till still takes the ticks, as the family’s own screen', () => {
    const html = under('en', createElement(ConsentCapture, props as never));
    for (const button of [...ticks(html, 'consent-ack'), ...ticks(html, 'consent-confirmation')]) {
      expect(button).not.toContain('disabled=""');
    }
  });

  it('the till shows each agreement as ticked or not', () => {
    const html = renderToStaticMarkup(createElement(ConsentTicksStatus, {
      consentRequired: true, consentAcknowledged: true,
      confirmations: [{ id: 'pickup', text: 'I will collect my child before closing', required: true, acknowledged: false }],
    }));
    expect(html).toContain('Supervision and photo consent · ticked');
    expect(html).toContain('I will collect my child before closing');
    expect(html).toContain('not ticked yet');
  });
});
