import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ConsentAction, ConsentPrompt, StationSessionDocument } from '@oto/shared';
import { takeConsentAction } from '@/lib/consentForm';
import { readDisplayAnswer } from '@/lib/displaySession';

/**
 * SCRUM-857 — THE TILL'S SIDE OF THE LIVE FORM (the owner's ruling of 12
 * November: staff watch the family fill the drop-off and nanny form).
 *
 * The family's screen sends its `fill` as they type, with the step they are
 * on. The till takes it into the same state the staff gate and Private child
 * details read, keeps the step for its own copy of the family's screen, and
 * shows that copy beside the staff gate while the form is on the paired
 * display — read-only, in the staff's language. A fill based on a copy the
 * till has since replaced (staff typing at the same moment) is never taken.
 */

const till = readFileSync(resolve(import.meta.dirname, '../src/pages/Till.tsx'), 'utf8');
const fence = { requestId: 'zz-live-request', visitorId: 'zz-live-visitor' };
const fill = (extra: Partial<Extract<ConsentAction, { action: 'fill' }>> = {}): ConsentAction => ({
  ...fence, action: 'fill', slots: [], guardianName: 'ZZ TEST Ploy', consentAcknowledged: false, acknowledgedConfirmationIds: [], ...extra,
});
const model = () => ({
  slots: [], guardianPhone: '+66898020001', signature: 'form-1', contactChannel: 'whatsapp' as const,
  updateSlot: vi.fn(), setGuardianName: vi.fn(), setGuardianPhone: vi.fn(), setContactChannel: vi.fn(),
  setConsentAcknowledged: vi.fn(), setAcknowledgedConfirmationIds: vi.fn(), setCompletedSignature: vi.fn(),
  askedForHelp: vi.fn(), answered: vi.fn(), setFamilyStep: vi.fn(),
});

describe('a fill taken by the till', () => {
  it.each(['children', 'care', 'agreements'] as const)('keeps the step the family is on: %s', (step) => {
    const t = model();
    takeConsentAction(fill({ step }), t);
    expect(t.setFamilyStep).toHaveBeenCalledWith(step);
    expect(t.setGuardianName).toHaveBeenCalledWith('ZZ TEST Ploy');
    expect(t.answered).toHaveBeenCalledTimes(1);
  });

  it('without a step (an older display, or a station that drops it) the till does not know where they are', () => {
    const t = model();
    takeConsentAction(fill(), t);
    expect(t.setFamilyStep).toHaveBeenCalledWith(null);
  });

  it('Done and a call for help leave the step as it was', () => {
    for (const action of [{ ...fence, action: 'done' }, { ...fence, action: 'staff_help' }] as ConsentAction[]) {
      const t = model();
      takeConsentAction(action, t);
      expect(t.setFamilyStep).not.toHaveBeenCalled();
    }
  });

  it('a till without the step setter takes the fill as before', () => {
    const { setFamilyStep: _unused, ...older } = model();
    expect(() => takeConsentAction(fill({ step: 'care' }), older)).not.toThrow();
    expect(older.setGuardianName).toHaveBeenCalledWith('ZZ TEST Ploy');
  });
});

describe('a fill based on a copy the till has replaced', () => {
  const prompt = (requestId: string): ConsentPrompt => ({
    kind: 'consent', requestId, visitorId: fence.visitorId,
    slots: [{ id: 'a', name: 'ZZ TEST Mai', ageYears: 6, requirement: 'drop_off' }],
    guardianName: 'ZZ TEST staff typed', consentRequired: true, consentAcknowledged: false, confirmations: [],
    staffReady: false, canContinue: false, completed: false, familyStep: 'agreements',
  });
  const document = (requestId: string, answerRequestId: string) => ({
    stage: 'input', step: 7, sequence: 3,
    prompt: { ...prompt(requestId), answer: { type: 'consent', actionId: 'zz-fill',
      payload: fill({ requestId: answerRequestId, guardianName: 'ZZ TEST stale', step: 'agreements' }) } },
  }) as unknown as StationSessionDocument;

  it('is read for the copy the till is on', () => {
    expect(readDisplayAnswer(document('zz-current', 'zz-current'), 'zz-current')).toMatchObject({ type: 'consent' });
  });

  it('is never read once staff changed the form (a new request), so it cannot undo their edit', () => {
    expect(readDisplayAnswer(document('zz-older', 'zz-older'), 'zz-current')).toBeNull();
    expect(readDisplayAnswer(document('zz-current', 'zz-older'), 'zz-current')).toBeNull();
  });
});

describe('the till publishes the step and shows staff the family’s screen', () => {
  it('the form it publishes says which step the family is on, outside canContinue', () => {
    expect(till).toMatch(/familyStep: consentFamilyStep \?\? 'children',\s*staffReady: consentStaffReady,/);
    expect(till).toMatch(/setFamilyStep: setConsentFamilyStep,/);
  });

  it('every new form starts on the first step', () => {
    expect(till).toMatch(/setConsentContactLegacy\(false\);\s*setConsentFamilyStep\('children'\);/);
  });

  it('beside the staff gate, only while the form is on a working paired display', () => {
    expect(till).toMatch(/const consentMirror = step === 7 && !!consent && !staffTicks && !inlineDisplay;/);
    expect(till).toMatch(/\$\{inlineDisplay \|\| consentMirror \? 'w-1\/2 border-r border-foreground\/10' : 'w-full'\}/);
  });

  it('as the till holds it, read-only, on the family’s step, in the staff’s language (a provider of its own)', () => {
    const mirror = till.match(/\{consentMirror && consent && \([\s\S]*?\n {8}\)\}/)?.[0] ?? '';
    expect(mirror).toContain('<LanguageProvider>');
    expect(mirror).toMatch(/<PublicConsentCapture prompt=\{\{ \.\.\.consent, kind: 'consent', requestId: 'staff-mirror' \}\} busy=\{false\}/);
    expect(mirror).toContain('onAction={() => undefined} mirror={{ step: consentFamilyStep }}');
    expect(mirror).not.toMatch(/storageKey/);
  });
});
