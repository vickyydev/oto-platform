import * as React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentAction, ConsentPrompt } from '@oto/shared';
import { LIVE_FILL_MS, PublicConsentCapture } from '@/components/till/PublicConsentCapture';
import { CONSENT_DRAFT_TTL_MS, clearConsentDraft, keepConsentDraft, readConsentDraft } from '@/lib/consentDraftStore';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(',')}` : key }) }));

/**
 * SCRUM-874 — THE FAMILY'S FORM SURVIVES A SHORT CONNECTION DROP.
 *
 * The drop-off and nanny form on a separate paired display keeps a draft per
 * visitor in this tab's session storage. A display that loses the box long
 * enough to show its paused screen, or is reloaded or paired again, opens
 * the form again from the till's copy and lays the draft back over it, field
 * by field — then sends what the till is missing. The draft is cleared when
 * the form is finished, when another visitor's form opens, when the display
 * moves on to another screen of the sale, and after half an hour. A fill
 * whose reply was lost while the line was down goes again, as it was, when
 * the box is heard from again.
 */

const display = readFileSync(resolve(import.meta.dirname, '../src/pages/Display.tsx'), 'utf8');

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}
let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.useFakeTimers();
  storage = memoryStorage();
  vi.stubGlobal('window', { sessionStorage: storage });
});
afterEach(() => { vi.useRealTimers(); });

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

const promptOf = (extra: Partial<ConsentPrompt> = {}): ConsentPrompt => ({
  kind: 'consent', requestId: 'zz-drop-1', visitorId: 'zz-drop-visitor',
  slots: [{ id: 'a', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off', dateOfBirth: null, allergiesMedical: '', foodRestrictions: '' }],
  guardianName: '', guardianPhone: '+66898020001', contactChannel: 'whatsapp', contactConfirmed: false, familyStep: 'children',
  consentRequired: true, consentAcknowledged: false, confirmations: [],
  staffReady: false, canContinue: false, completed: false, ...extra,
});

function open(prompt: ConsentPrompt) {
  const sent: ConsentAction[] = [];
  const view = renderHook((p: ConsentPrompt) => PublicConsentCapture({ prompt: p, busy: false, answerPending: false,
    onAction: (action) => { sent.push(action); } }), prompt);
  const all = () => elements(view.result.current);
  const byId = (id: string) => all().find((node) => node.props.id === id);
  const button = (label: string) => all().find((node) => words(node.props.children) === label && typeof node.props.onClick === 'function');
  return {
    view, sent, byId,
    fills: () => sent.filter((action): action is Extract<ConsentAction, { action: 'fill' }> => action.action === 'fill'),
    press: (label: string) => (button(label)!.props.onClick as () => void)(),
    type: (id: string, value: string) => (byId(id)!.props.onChange as (v: string) => void)(value),
    text: () => words(view.result.current),
  };
}

describe('the form opened again for the same family', () => {
  it('brings back what they typed before the line dropped, on their step, and sends it', () => {
    const before = open(promptOf({ familyStep: 'agreements' }));
    before.type('public-consent-guardian', 'ZZ TEST Ploy');
    // The line drops before the fill goes: the display pauses and the form goes away.
    before.view.unmount();
    expect(before.fills()).toHaveLength(0);
    const after = open(promptOf({ familyStep: 'agreements' }));
    expect(after.byId('public-consent-guardian')!.props.value).toBe('ZZ TEST Ploy');
    expect(after.text()).toContain('superviseConsent.stepOf:3,3');
    vi.advanceTimersByTime(LIVE_FILL_MS);
    expect(after.fills()).toHaveLength(1);
    expect(after.fills()[0]).toMatchObject({ guardianName: 'ZZ TEST Ploy', step: 'agreements' });
    after.view.unmount();
  });

  it('takes a staff edit made meanwhile, and keeps the family’s own typing elsewhere', () => {
    const before = open(promptOf({ familyStep: 'agreements' }));
    before.type('public-consent-guardian', 'ZZ TEST Ploy');
    before.view.unmount();
    // Staff typed a care note on the till while the display was away.
    const staff = promptOf({ requestId: 'zz-drop-2', familyStep: 'agreements', slots: [{ id: 'a', name: 'ZZ TEST Mai', ageYears: 6,
      requirement: 'drop_off', dateOfBirth: null, allergiesMedical: 'ZZ TEST eggs', foodRestrictions: '' }] });
    const after = open(staff);
    expect(after.byId('public-consent-guardian')!.props.value).toBe('ZZ TEST Ploy');
    after.press('2. superviseConsent.stepCare');
    const notes = elements(after.view.result.current).filter((node) => node.props.value === 'ZZ TEST eggs');
    expect(notes).toHaveLength(1);
    after.view.unmount();
  });

  it('a step the family moved to comes back with them', () => {
    const before = open(promptOf());
    before.press('common.continue');
    before.view.unmount();
    // The till never heard the step (the fill was lost with the line).
    const after = open(promptOf());
    expect(after.text()).toContain('superviseConsent.stepOf:2,3');
    vi.advanceTimersByTime(LIVE_FILL_MS);
    expect(after.fills().at(-1)).toMatchObject({ step: 'care' });
    after.view.unmount();
  });

  it('another family’s form starts clean, and their draft is gone', () => {
    const before = open(promptOf({ familyStep: 'agreements' }));
    before.type('public-consent-guardian', 'ZZ TEST Ploy');
    before.view.unmount();
    const other = open(promptOf({ visitorId: 'zz-drop-other', familyStep: 'agreements' }));
    expect(other.byId('public-consent-guardian')!.props.value).toBe('');
    other.view.unmount();
    expect(readConsentDraft('zz-drop-visitor', (_value): _value is unknown => true)).toBeNull();
  });

  it('a finished form keeps nothing', () => {
    const before = open(promptOf({ familyStep: 'agreements' }));
    before.type('public-consent-guardian', 'ZZ TEST Ploy');
    before.view.rerender(promptOf({ requestId: 'zz-drop-2', familyStep: 'agreements', guardianName: 'ZZ TEST Ploy', completed: false }));
    expect(storage.values.size).toBe(1);
    before.view.rerender(promptOf({ requestId: 'zz-drop-3', familyStep: 'agreements', guardianName: 'ZZ TEST Ploy', consentAcknowledged: true,
      contactConfirmed: true, staffReady: true, canContinue: true, completed: true }));
    expect(storage.values.size).toBe(0);
    before.view.unmount();
  });

  it('the till’s copy alone, when nothing was kept (another tab, storage refused)', () => {
    vi.stubGlobal('window', { get sessionStorage(): Storage { throw new Error('ZZ TEST storage refused'); } });
    const form = open(promptOf({ familyStep: 'care', guardianName: 'ZZ TEST till' }));
    expect(form.text()).toContain('superviseConsent.stepOf:2,3');
    // Typing and moving on still work; only the draft is not kept.
    form.press('common.continue');
    expect(form.fills().at(-1)).toMatchObject({ step: 'agreements' });
    form.type('public-consent-guardian', 'ZZ TEST till Ploy');
    vi.advanceTimersByTime(5_000);
    expect(form.byId('public-consent-guardian')!.props.value).toBe('ZZ TEST till Ploy');
    form.view.unmount();
  });
});

describe('the draft kept for a visitor', () => {
  const draft = { slots: {}, guardianName: 'ZZ TEST Ploy', guardianPhone: '', consentAcknowledged: false, confirmations: [] };
  const isDraft = (value: unknown): value is typeof draft => !!value && typeof value === 'object';

  it('is read back for that visitor only', () => {
    keepConsentDraft({ visitorId: 'zz-a', base: draft, local: draft, sent: [], step: 'care', savedAt: Date.now() });
    expect(readConsentDraft('zz-a', isDraft)).toMatchObject({ step: 'care', local: { guardianName: 'ZZ TEST Ploy' } });
    expect(readConsentDraft('zz-b', isDraft)).toBeNull();
    expect(readConsentDraft('zz-a', isDraft)).toBeNull();
  });

  it('is gone after half an hour', () => {
    keepConsentDraft({ visitorId: 'zz-a', base: draft, local: draft, sent: [], step: 'care', savedAt: Date.now() });
    expect(readConsentDraft('zz-a', isDraft, Date.now() + CONSENT_DRAFT_TTL_MS + 1)).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  it('is never used when it is not one (a damaged entry), and is cleared', () => {
    storage.setItem('oto.display.consentDraft.v1', '{"visitorId":"zz-a","savedAt":1,');
    expect(readConsentDraft('zz-a', isDraft)).toBeNull();
    keepConsentDraft({ visitorId: 'zz-a', base: draft, local: draft, sent: [], step: 'payment' as 'care', savedAt: Date.now() });
    expect(readConsentDraft('zz-a', isDraft)).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  it('is kept in this tab’s session storage, never in local storage', () => {
    keepConsentDraft({ visitorId: 'zz-a', base: draft, local: draft, sent: [], step: 'care', savedAt: Date.now() });
    expect(storage.values.size).toBe(1);
    clearConsentDraft();
    expect(storage.values.size).toBe(0);
    const source = readFileSync(resolve(import.meta.dirname, '../src/lib/consentDraftStore.ts'), 'utf8');
    expect(source).toContain('window.sessionStorage');
    expect(source).not.toContain('localStorage.');
  });
});

describe('the paired display', () => {
  it('sends a fill whose reply was lost again, as it was, once the box is heard from', () => {
    expect(display).toMatch(/if \(connection !== 'connected' \|\| !intent \|\| intent\.type !== 'display\.consent'\s*\|\| \(intent\.payload as \{ action\?: unknown \}\)\.action !== 'fill'\) return;\s*void send\(intent\.type, intent\.payload, true\);\s*\}, \[connection, send\]\);/);
  });

  it('clears the draft once it has moved on to the first screen, payment or thank-you', () => {
    expect(display).toMatch(/if \(viewStage === 'identify' \|\| viewStage === 'payment' \|\| viewStage === 'thankyou'\) clearConsentDraft\(\);/);
  });

  it('keeps the form keyed by the visitor, so another family’s form is a new one', () => {
    expect(display).toContain('<PublicConsentCapture key={view.consent.visitorId} prompt={view.consent}');
  });
});
