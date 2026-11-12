import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentActionSchema, ConsentPromptSchema, consentActionAllowed, type ConsentAction, type ConsentFormStep, type ConsentPrompt } from '@oto/shared';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { LIVE_FILL_MAX_MS, LIVE_FILL_MS, PublicConsentCapture, mergeConsentDraft } from '@/components/till/PublicConsentCapture';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', t: (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(',')}` : key }) }));
beforeEach(() => { vi.stubGlobal('React', React); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/**
 * SCRUM-857 — STAFF WATCH THE FAMILY FILL THE DROP-OFF AND NANNY FORM, LIVE.
 *
 * The owner's ruling of 12 November (Tom's point: "the form opens and staff
 * just keep waiting"). On a separate paired display the family's entries
 * travel to the till as they type — a few hundred milliseconds after they
 * stop, at the latest every second while they keep typing, at once for a
 * choice and when a box loses focus — never only when a step is finished.
 * The step they are on goes with it, so the till's copy of the same form
 * (`mirror`) shows staff the same screen, read-only.
 *
 * Who wins a field when the family and staff both change it: the last change
 * the station accepted (`mergeConsentDraft`), and a fill of the family's own
 * that the station took late never pulls their newer text back.
 */

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

const START = '+66898020001'; // ZZ TEST numbers, used only by this fixture.

type Slot = ConsentPrompt['slots'][number];
const child = (id: string, extra: Partial<Slot> = {}): Slot => ({ id, name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off',
  dateOfBirth: null, allergiesMedical: '', foodRestrictions: '', ...extra });
const promptOf = (extra: Partial<ConsentPrompt> = {}): ConsentPrompt => ({
  kind: 'consent', requestId: 'zz-live-1', visitorId: 'zz-live-visitor',
  slots: [child('a')],
  guardianName: '', guardianPhone: START, contactChannel: 'whatsapp', contactConfirmed: false, familyStep: 'children',
  consentRequired: true, consentAcknowledged: false,
  confirmations: [{ id: 'pickup', text: 'ZZ TEST pick-up before closing', required: true, acknowledged: false }],
  staffReady: false, canContinue: false, completed: false, ...extra,
});
const unnamed = (id: string) => child(id, { name: '', ageYears: null, requirement: 'none' });
const twoChildren = (extra: Partial<ConsentPrompt> = {}) => promptOf({ slots: [unnamed('a'), unnamed('b')], ...extra });

interface Props { prompt: ConsentPrompt; answerPending?: boolean; mirror?: { step: ConsentFormStep | null } }

function open(initial: Props) {
  const sent: ConsentAction[] = [];
  let props = initial;
  const view = renderHook((p: Props) => PublicConsentCapture({ prompt: p.prompt, busy: false, answerPending: p.answerPending ?? false,
    mirror: p.mirror, onAction: (action) => { sent.push(action); } }), initial);
  const root = () => view.result.current as Element;
  const all = () => elements(view.result.current);
  const byId = (id: string) => all().find((node) => node.props.id === id);
  const button = (label: string) => all().find((node) => words(node.props.children) === label && typeof node.props.onClick === 'function');
  const set = (next: Partial<Props>) => { props = { ...props, ...next }; view.rerender(props); };
  const fills = () => sent.filter((action): action is Extract<ConsentAction, { action: 'fill' }> => action.action === 'fill');
  return {
    view, sent, fills, all, byId, button, set, root,
    press: (label: string) => (button(label)!.props.onClick as () => void)(),
    type: (id: string, value: string) => (byId(id)!.props.onChange as (v: string) => void)(value),
    phone: () => all().find((node) => node.type === PhoneInput) as Element | undefined,
    testId: (testId: string) => all().find((node) => node.props['data-testid'] === testId) as Element | undefined,
    blur: () => (root().props.onBlurCapture as () => void)(),
    /** The till's newer copy of the form, under a new request. */
    till: (extra: Partial<ConsentPrompt>) => set({ prompt: { ...props.prompt, ...extra } }),
    text: () => words(view.result.current),
  };
}

describe('the family’s screen sends the form as they type', () => {
  it('a typed name reaches the till a moment after they stop, without Continue', () => {
    const form = open({ prompt: promptOf({ familyStep: 'agreements' }) });
    form.type('public-consent-guardian', 'ZZ TEST Ploy');
    expect(form.fills()).toHaveLength(0);
    vi.advanceTimersByTime(LIVE_FILL_MS - 1);
    expect(form.fills()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(form.fills()).toHaveLength(1);
    expect(form.fills()[0]).toMatchObject({ guardianName: 'ZZ TEST Ploy', step: 'agreements', requestId: 'zz-live-1' });
    const parsed = ConsentActionSchema.parse(form.fills()[0]);
    expect(consentActionAllowed(promptOf(), parsed)).toBe(true);
    form.view.unmount();
  });

  it('while they keep typing, the form goes at the latest every second', () => {
    const form = open({ prompt: promptOf({ familyStep: 'agreements' }) });
    const name = 'ZZ TEST Ploy Smith';
    for (let at = 1; at <= name.length; at += 1) {
      form.type('public-consent-guardian', name.slice(0, at));
      vi.advanceTimersByTime(100);
    }
    // 18 keystrokes over 1.8 s, one every 100 ms: a fill went within the first second, with what was typed by then.
    expect(form.fills()).toHaveLength(1);
    expect(form.fills()[0]!.guardianName.length).toBeGreaterThanOrEqual(LIVE_FILL_MAX_MS / 100 - 1);
    form.view.unmount();
  });

  it('a box losing focus sends at once', () => {
    const form = open({ prompt: promptOf({ familyStep: 'agreements' }) });
    form.type('public-consent-guardian', 'ZZ TEST P');
    form.blur();
    expect(form.fills()).toHaveLength(1);
    expect(form.fills()[0]).toMatchObject({ guardianName: 'ZZ TEST P' });
    form.view.unmount();
  });

  it('a choice (a tick, the channel) goes at once', () => {
    const form = open({ prompt: promptOf({ familyStep: 'agreements', guardianName: 'ZZ TEST Ploy' }) });
    (form.testId('public-consent-ack')!.props.onCheckedChange as (v: boolean) => void)(true);
    vi.advanceTimersByTime(0);
    expect(form.fills()).toHaveLength(1);
    expect(form.fills()[0]).toMatchObject({ consentAcknowledged: true });
    form.till({ requestId: 'zz-live-2', consentAcknowledged: true });
    (form.phone()!.props.onChannelChange as (v: string) => void)('telegram');
    vi.advanceTimersByTime(0);
    expect(form.fills()).toHaveLength(2);
    expect(form.fills()[1]).toMatchObject({ contactChannel: 'telegram', requestId: 'zz-live-2' });
    form.view.unmount();
  });

  it('the step goes with the fill, so the till follows the family from step to step', () => {
    const form = open({ prompt: promptOf() });
    form.press('common.continue');
    expect(form.fills()).toHaveLength(1);
    expect(form.fills()[0]).toMatchObject({ step: 'care' });
    form.till({ requestId: 'zz-live-2', familyStep: 'care' });
    form.press('common.continue');
    expect(form.fills()[1]).toMatchObject({ step: 'agreements', requestId: 'zz-live-2' });
    form.till({ requestId: 'zz-live-3', familyStep: 'agreements' });
    form.press('common.back');
    expect(form.fills()[2]).toMatchObject({ step: 'care', requestId: 'zz-live-3' });
    form.view.unmount();
  });

  it('sends no step to a till (or through a station) that does not follow it', () => {
    const form = open({ prompt: promptOf({ familyStep: undefined }) });
    form.press('common.continue');
    form.press('common.continue');
    expect(form.fills()).toHaveLength(0);
    form.type('public-consent-guardian', 'ZZ TEST Ploy');
    vi.advanceTimersByTime(LIVE_FILL_MS);
    expect(form.fills()).toHaveLength(1);
    expect('step' in form.fills()[0]!).toBe(false);
    form.view.unmount();
  });

  it('one answer at a time: the form stays open meanwhile, and the newest goes once the till has taken the last', () => {
    const form = open({ prompt: promptOf({ familyStep: 'agreements' }) });
    form.type('public-consent-guardian', 'ZZ TEST P');
    vi.advanceTimersByTime(LIVE_FILL_MS);
    expect(form.fills()).toHaveLength(1);
    form.set({ answerPending: true });
    form.type('public-consent-guardian', 'ZZ TEST Ploy');
    expect(form.byId('public-consent-guardian')!.props.disabled).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(form.fills()).toHaveLength(1);
    // The till took the first: its copy comes back with it, and the newest goes.
    form.set({ answerPending: false, prompt: promptOf({ requestId: 'zz-live-2', guardianName: 'ZZ TEST P', familyStep: 'agreements' }) });
    expect(form.byId('public-consent-guardian')!.props.value).toBe('ZZ TEST Ploy');
    vi.advanceTimersByTime(LIVE_FILL_MS);
    expect(form.fills()).toHaveLength(2);
    expect(form.fills()[1]).toMatchObject({ guardianName: 'ZZ TEST Ploy', requestId: 'zz-live-2' });
    form.view.unmount();
  });

  it('two children: both are sent, each as typed', () => {
    const form = open({ prompt: twoChildren() });
    form.type('consent-child-0', 'ZZ TEST Mai');
    form.type('consent-child-1', 'ZZ TEST Nok');
    vi.advanceTimersByTime(LIVE_FILL_MS);
    expect(form.fills()).toHaveLength(1);
    expect(form.fills()[0]!.slots.map((slot) => slot.name)).toEqual(['ZZ TEST Mai', 'ZZ TEST Nok']);
    form.view.unmount();
  });

  it('a display that re-pairs mid-form opens on the step the till last heard, with what the till holds', () => {
    const form = open({ prompt: promptOf({ familyStep: 'agreements', guardianName: 'ZZ TEST Ploy' }) });
    expect(form.byId('public-consent-guardian')!.props.value).toBe('ZZ TEST Ploy');
    expect(form.text()).toContain('superviseConsent.stepOf:3,3');
    vi.advanceTimersByTime(5_000);
    expect(form.fills()).toHaveLength(0);
    form.view.unmount();
  });

  it('a fill the till takes but does not keep is not sent for ever', () => {
    const form = open({ prompt: promptOf({ familyStep: 'agreements' }) });
    form.type('public-consent-guardian', 'ZZ TEST Ploy');
    // The till answers every fill with a new copy that still holds the old value.
    for (let round = 2; round < 12; round += 1) {
      const before = form.fills().length;
      vi.advanceTimersByTime(1_500);
      if (form.fills().length > before) form.till({ requestId: `zz-live-${round}` });
    }
    expect(form.fills().length).toBeGreaterThanOrEqual(1);
    expect(form.fills().length).toBeLessThanOrEqual(2);
    // The family changing something sends again.
    form.type('public-consent-guardian', 'ZZ TEST Ploy S');
    vi.advanceTimersByTime(1_500);
    expect(form.fills().at(-1)).toMatchObject({ guardianName: 'ZZ TEST Ploy S' });
    form.view.unmount();
  });
});

describe('who wins a field (`mergeConsentDraft`)', () => {
  const slot = { name: 'ZZ TEST Mai', dateOfBirth: null, ageYears: 6, allergiesMedical: '', foodRestrictions: '' };
  const base = { slots: { a: slot }, guardianName: '', guardianPhone: START, contactChannel: 'whatsapp' as const,
    consentAcknowledged: false, confirmations: [] as string[] };

  it('the family’s typing since their last fill stays while the till’s copy of that fill comes back', () => {
    const local = { ...base, guardianName: 'ZZ TEST Ploy Sm' };
    const sent = { ...base, guardianName: 'ZZ TEST Ploy' };
    expect(mergeConsentDraft(local, base, sent, [sent]).guardianName).toBe('ZZ TEST Ploy Sm');
  });

  it('an older fill of theirs that the station took late never pulls their text back', () => {
    const older = { ...base, guardianName: 'ZZ TEST P' };
    const newer = { ...base, guardianName: 'ZZ TEST Ploy' };
    const local = { ...base, guardianName: 'ZZ TEST Ploy S' };
    // Knowing only the last fill, the older value would read as a staff edit.
    expect(mergeConsentDraft(local, base, older, [newer]).guardianName).toBe('ZZ TEST P');
    expect(mergeConsentDraft(local, base, older, [older, newer]).guardianName).toBe('ZZ TEST Ploy S');
  });

  it('a staff edit on the till wins the field it changed, and only that one', () => {
    const local = { ...base, guardianName: 'ZZ TEST Ploy', slots: { a: { ...slot, allergiesMedical: 'ZZ TEST peanuts' } } };
    const sent = { ...base, guardianName: 'ZZ TEST Pl' };
    const staff = { ...base, guardianName: 'ZZ TEST Ploy Staff' };
    const merged = mergeConsentDraft(local, base, staff, [sent]);
    expect(merged.guardianName).toBe('ZZ TEST Ploy Staff');
    expect(merged.slots.a!.allergiesMedical).toBe('ZZ TEST peanuts');
  });

  it('a field the family has not touched takes the till’s value', () => {
    const staff = { ...base, slots: { a: { ...slot, foodRestrictions: 'ZZ TEST no nuts' } } };
    expect(mergeConsentDraft(base, base, staff).slots.a!.foodRestrictions).toBe('ZZ TEST no nuts');
  });

  it('on the screen: a staff edit before the family’s fill arrived is shown, and their stale typing is never sent over it', () => {
    const form = open({ prompt: promptOf({ familyStep: 'agreements' }) });
    form.type('public-consent-guardian', 'ZZ TEST Pl');
    vi.advanceTimersByTime(LIVE_FILL_MS);
    form.type('public-consent-guardian', 'ZZ TEST Plo');
    // Staff changed the name on the till first: the station refused the family's fill on the older copy.
    form.till({ requestId: 'zz-live-2', guardianName: 'ZZ TEST Ploy Staff' });
    expect(form.byId('public-consent-guardian')!.props.value).toBe('ZZ TEST Ploy Staff');
    vi.advanceTimersByTime(5_000);
    expect(form.fills().every((fill) => fill.guardianName !== 'ZZ TEST Plo')).toBe(true);
    form.view.unmount();
  });
});

describe('the till’s copy of the family’s screen (`mirror`)', () => {
  it('is the same form, as the till holds it, on the step the family is on, and sends nothing', () => {
    const prompt = promptOf({ guardianName: 'ZZ TEST Ploy', familyStep: 'agreements', requestId: 'staff-mirror' });
    expect(ConsentPromptSchema.safeParse(prompt).success).toBe(true);
    const form = open({ prompt, mirror: { step: 'agreements' } });
    expect(form.root().props['data-testid']).toBe('consent-mirror');
    expect(form.root().props.inert).toBe(true);
    expect(form.root().props.onBlurCapture).toBeUndefined();
    expect(form.text()).toContain('superviseConsent.mirrorFilling');
    expect(form.byId('public-consent-guardian')!.props.value).toBe('ZZ TEST Ploy');
    expect(form.text()).toContain('superviseConsent.stepOf:3,3');
    vi.advanceTimersByTime(5_000);
    expect(form.sent).toHaveLength(0);
    form.view.unmount();
  });

  it('follows the till’s state as the family’s fills arrive, step by step, with what they still need to do', () => {
    const form = open({ prompt: twoChildren({ requestId: 'staff-mirror' }), mirror: { step: 'children' } });
    expect(form.text()).toContain('superviseConsent.nameAndAgeFirst');
    const named = [child('a'), child('b', { name: 'ZZ TEST Nok', ageYears: 4, allergiesMedical: 'ZZ TEST eggs' })];
    form.set({ prompt: twoChildren({ requestId: 'staff-mirror', slots: named }) });
    expect(form.byId('consent-child-0')!.props.value).toBe('ZZ TEST Mai');
    expect(form.byId('consent-child-1')!.props.value).toBe('ZZ TEST Nok');
    expect(form.text()).not.toContain('superviseConsent.nameAndAgeFirst');
    form.set({ mirror: { step: 'care' } });
    expect(form.all().filter((node) => node.props['data-testid'] === 'consent-care')).toHaveLength(2);
    expect(form.all().some((node) => node.props.value === 'ZZ TEST eggs')).toBe(true);
    form.set({ mirror: { step: 'agreements' }, prompt: twoChildren({ requestId: 'staff-mirror', guardianPhone: '+6621234567', slots: named }) });
    // The validation the family is seeing: this number cannot take messages.
    expect(form.testId('consent-contact-invalid')).toBeDefined();
    expect(form.testId('public-consent-ack')!.props.checked).toBe(false);
    expect(form.sent).toHaveLength(0);
    form.view.unmount();
  });

  it('shows every step, one under the other, when the family’s screen does not say where it is', () => {
    const form = open({ prompt: promptOf({ requestId: 'staff-mirror', familyStep: undefined }), mirror: { step: null } });
    expect(form.all().some((node) => node.props['data-testid'] === 'consent-child')).toBe(true);
    expect(form.all().some((node) => node.props['data-testid'] === 'consent-care')).toBe(true);
    expect(form.byId('public-consent-guardian')).toBeDefined();
    form.view.unmount();
  });

  it('the finished form reads as finished', () => {
    const form = open({ prompt: promptOf({ requestId: 'staff-mirror', guardianName: 'ZZ TEST Ploy', consentAcknowledged: true, contactConfirmed: true,
      confirmations: [{ id: 'pickup', text: 'ZZ TEST pick-up', required: true, acknowledged: true }], staffReady: true, canContinue: true, completed: true }),
    mirror: { step: 'agreements' } });
    expect(form.text()).toContain('superviseConsent.waitForTeam');
    form.view.unmount();
  });
});
