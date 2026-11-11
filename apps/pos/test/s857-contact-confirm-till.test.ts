import { describe, expect, it, vi } from 'vitest';
import type { ConsentAction } from '@oto/shared';
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
