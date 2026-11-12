import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { consentActionAllowed, type ConsentAction, type ConsentPrompt } from '@oto/shared';
import { contactConfirmationStands, messagingPhoneProblem, takeConsentAction } from '@/lib/consentForm';

/**
 * SCRUM-857 — THE TILL'S SIDE OF THE NUMBER CONFIRMATION.
 *
 * The owner's ruling of 8 November: the family must explicitly confirm that
 * the number on the drop-off and nanny form is the one for the chosen
 * channel. The till keeps that confirmation WITH the number and the channel
 * it was given for, so it stands only while the form still holds both — an
 * edit to either, on any screen, un-confirms it without any hand-off. A step
 * from the family's screen carries the tick; a step without it, on a form
 * that asked, means the display or the station between is from before the
 * field, and staff confirm with the family on the till instead.
 */

const PHONE = '+66898020001'; // ZZ TEST numbers, used only by this fixture.
const fence = { requestId: 'zz-test-request', visitorId: 'zz-test-visitor' };
const step = (extra: Partial<Extract<ConsentAction, { action: 'fill' }>> = {}): ConsentAction => ({
  ...fence, action: 'fill', slots: [], guardianName: 'ZZ TEST guardian', consentAcknowledged: true, acknowledgedConfirmationIds: [], ...extra,
});

function till(extra: Record<string, unknown> = {}) {
  return {
    slots: [], guardianPhone: PHONE, signature: 'form-1', contactChannel: 'whatsapp' as const,
    updateSlot: vi.fn(), setGuardianName: vi.fn(), setGuardianPhone: vi.fn(), setContactChannel: vi.fn(),
    setConsentAcknowledged: vi.fn(), setAcknowledgedConfirmationIds: vi.fn(), setCompletedSignature: vi.fn(),
    askedForHelp: vi.fn(), answered: vi.fn(),
    setContactConfirmed: vi.fn(), contactConfirmationUnsupported: vi.fn(),
    ...extra,
  };
}

describe('a confirmation stands for the number and channel it was given for', () => {
  const given = { at: '2026-11-12T03:00:00.000Z', by: 'family' as const, phone: PHONE, channel: 'whatsapp' as const };

  it('while the form holds that number (typed any way) and that channel', () => {
    expect(contactConfirmationStands(given, PHONE, 'whatsapp')).toBe(true);
    expect(contactConfirmationStands(given, '0898020001', 'whatsapp')).toBe(true);
    expect(contactConfirmationStands(given, '+660898020001', 'whatsapp')).toBe(true);
  });

  it('and not once the number or the channel has changed, or before any was given', () => {
    expect(contactConfirmationStands(given, '+66898020002', 'whatsapp')).toBe(false);
    expect(contactConfirmationStands(given, PHONE, 'telegram')).toBe(false);
    expect(contactConfirmationStands(given, '', 'whatsapp')).toBe(false);
    expect(contactConfirmationStands(null, PHONE, 'whatsapp')).toBe(false);
    expect(contactConfirmationStands({ ...given, phone: '' }, '', 'whatsapp')).toBe(false);
  });
});

describe('why the number cannot be confirmed yet', () => {
  it('nothing typed, or something that cannot take a family’s messages; null for a mobile', () => {
    expect(messagingPhoneProblem('')).toBe('empty');
    expect(messagingPhoneProblem('  ')).toBe('empty');
    expect(messagingPhoneProblem('+6689')).toBe('invalid');
    expect(messagingPhoneProblem('021234567')).toBe('invalid');
    expect(messagingPhoneProblem('0112345678')).toBe('invalid');
    expect(messagingPhoneProblem('0898020001')).toBeNull();
    expect(messagingPhoneProblem(PHONE)).toBeNull();
    expect(messagingPhoneProblem('+447911123456')).toBeNull();
  });
});

describe('a step from the family’s screen', () => {
  it('brings the tick for the number and channel the step carries', () => {
    const t = till();
    takeConsentAction(step({ guardianPhone: '+660898020002', contactChannel: 'telegram', contactConfirmed: true }), t);
    expect(t.setContactConfirmed).toHaveBeenCalledWith(true, { phone: '+66898020002', channel: 'telegram' });
    expect(t.contactConfirmationUnsupported).not.toHaveBeenCalled();
    expect(t.setCompletedSignature).toHaveBeenCalledWith(null);
    expect(t.answered).toHaveBeenCalledTimes(1);
  });

  it('brings the tick’s removal the same way', () => {
    const t = till();
    takeConsentAction(step({ guardianPhone: PHONE, contactChannel: 'whatsapp', contactConfirmed: false }), t);
    expect(t.setContactConfirmed).toHaveBeenCalledWith(false, { phone: PHONE, channel: 'whatsapp' });
  });

  it('names the till’s own number and channel when the step carries neither', () => {
    const t = till({ contactChannel: 'line' });
    takeConsentAction(step({ contactConfirmed: true }), t);
    expect(t.setContactConfirmed).toHaveBeenCalledWith(true, { phone: PHONE, channel: 'line' });
  });

  it('without the tick on a form that asked for it: the display or station is from before the field', () => {
    const t = till({ asksContactConfirmation: true });
    takeConsentAction(step({ guardianPhone: PHONE, contactChannel: 'whatsapp' }), t);
    expect(t.setContactConfirmed).not.toHaveBeenCalled();
    expect(t.contactConfirmationUnsupported).toHaveBeenCalledTimes(1);
    // The rest of the step is taken as it always was.
    expect(t.setGuardianName).toHaveBeenCalledWith('ZZ TEST guardian');
    expect(t.setConsentAcknowledged).toHaveBeenCalledWith(true);
    expect(t.answered).toHaveBeenCalledTimes(1);
  });

  it('without the tick on a form that never asked: nothing to notice', () => {
    const t = till({ asksContactConfirmation: false });
    takeConsentAction(step(), t);
    expect(t.setContactConfirmed).not.toHaveBeenCalled();
    expect(t.contactConfirmationUnsupported).not.toHaveBeenCalled();
  });

  it('a till from before the tick (no setters) takes the step as it always did', () => {
    const t = till({ setContactConfirmed: undefined, contactConfirmationUnsupported: undefined, asksContactConfirmation: true });
    expect(() => takeConsentAction(step({ contactConfirmed: true }), t)).not.toThrow();
    expect(() => takeConsentAction(step(), t)).not.toThrow();
    expect(t.answered).toHaveBeenCalledTimes(2);
  });
});

describe('Done from the family’s screen', () => {
  const done: ConsentAction = { ...fence, action: 'done' };

  it('finishes the form once the number is confirmed', () => {
    const t = till({ asksContactConfirmation: true, contactConfirmed: true });
    takeConsentAction(done, t);
    expect(t.setCompletedSignature).toHaveBeenCalledWith('form-1');
    expect(t.contactConfirmationUnsupported).not.toHaveBeenCalled();
  });

  it('finishes a form that never asked', () => {
    const t = till({ asksContactConfirmation: false, contactConfirmed: false });
    takeConsentAction(done, t);
    expect(t.setCompletedSignature).toHaveBeenCalledWith('form-1');
  });

  it('while the till asks and the number is unconfirmed: not finished, and staff confirm with the family here', () => {
    // A display that shows the tick never offers Done without it, so this
    // Done came through a display or station from before the field.
    const t = till({ asksContactConfirmation: true, contactConfirmed: false });
    takeConsentAction(done, t);
    expect(t.setCompletedSignature).not.toHaveBeenCalled();
    expect(t.contactConfirmationUnsupported).toHaveBeenCalledTimes(1);
    // The family's screen still moves on to a new request, never stuck on the answer.
    expect(t.answered).toHaveBeenCalledTimes(1);
  });
});

/**
 * SCRUM-857 — THROUGH A COUNTER BOX FROM BEFORE THE FIELD (the park's Pi box
 * until it gets a release built with the number confirmation). The station
 * keeps only the fields its own schema knows: the tick, the family's step,
 * the photo marks and the saving lines are dropped from the form it hands the
 * display, and the tick and the step from every fill it hands the till. So
 * the family's screen never shows the tick, and their Done cannot move the
 * sale on: the till stays on the form, staff confirm the number with the
 * family in Private child details, and press Continue. The owner's "the
 * customer must explicitly confirm" and "no staff verification" need that
 * box release; through the platform's virtual box they hold today.
 */
describe('through a station that drops the tick (an older box)', () => {
  const tillSource = readFileSync(resolve(import.meta.dirname, '../src/pages/Till.tsx'), 'utf8');
  const prompt: ConsentPrompt = {
    kind: 'consent', requestId: fence.requestId, visitorId: fence.visitorId,
    slots: [{ id: 'a', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off' }],
    guardianName: 'ZZ TEST guardian', guardianPhone: PHONE, contactChannel: 'whatsapp', contactConfirmed: false,
    consentRequired: true, consentAcknowledged: true, confirmations: [],
    staffReady: true, canContinue: true, completed: false, familyStep: 'agreements',
  };
  /** What an older station keeps of a fill: everything but the fields it does not know. */
  const throughOlderStation = (action: ConsentAction): ConsentAction => {
    const { contactConfirmed: _tick, step: _step, ...kept } = action as Extract<ConsentAction, { action: 'fill' }>;
    return kept;
  };

  it('a fill arrives without the tick: staff are told to confirm the number on the till', () => {
    const t = till({ asksContactConfirmation: true, contactConfirmed: false });
    const fill = throughOlderStation(step({ guardianPhone: PHONE, contactChannel: 'whatsapp', contactConfirmed: true, step: 'agreements' }));
    expect(consentActionAllowed(prompt, fill)).toBe(true);
    takeConsentAction(fill, t);
    expect(t.setContactConfirmed).not.toHaveBeenCalled();
    expect(t.contactConfirmationUnsupported).toHaveBeenCalledTimes(1);
  });

  it('their Done is taken as not finished, so the till stays on the form for staff to finish', () => {
    const done: ConsentAction = { ...fence, action: 'done' };
    // The till's own check: this Done is the "unconfirmed Done" an older station brings.
    expect(consentActionAllowed(prompt, done)).toBe(false);
    expect(consentActionAllowed({ ...prompt, contactConfirmed: true }, done)).toBe(true);
    expect(tillSource).toMatch(/const familyDone = action\.data\.action === 'done' && !unconfirmedDone;/);
    const t = till({ asksContactConfirmation: true, contactConfirmed: false });
    takeConsentAction(done, t);
    // Never finished: the family's Done never starts the gate, staff press Continue.
    expect(t.setCompletedSignature).not.toHaveBeenCalled();
    expect(t.contactConfirmationUnsupported).toHaveBeenCalledTimes(1);
    expect(t.answered).toHaveBeenCalledTimes(1);
  });
});
