import { describe, expect, it } from 'vitest';
import { ConsentActionSchema, consentActionAllowed, type ConsentPrompt } from '@oto/shared';

const prompt: ConsentPrompt = {
  kind: 'consent', visitorId: 'ZZ TEST visitor', requestId: 'request', familyStep: 'agreements', familyView: null,
  slots: [], guardianName: '', consentRequired: true, consentAcknowledged: false,
  confirmations: [], staffReady: false, canContinue: false, completed: false,
};
const move = {
  action: 'view' as const, requestId: prompt.requestId, visitorId: prompt.visitorId,
  view: { step: 'agreements' as const, anchor: 2, offset: 210, progress: 500, active: 3 },
};

describe('the cashier follows only the current guest form', () => {
  it('accepts a scroll without names, edits or consent', () => {
    expect(ConsentActionSchema.parse(move)).toEqual(move);
    expect(consentActionAllowed(prompt, move)).toBe(true);
  });
  it('ignores a different visitor, old request, old step, completed form or legacy station', () => {
    for (const other of [{ visitorId: 'other' }, { requestId: 'later' }, { familyStep: 'care' as const },
      { completed: true }, { familyView: undefined }]) {
      expect(consentActionAllowed({ ...prompt, ...other }, move)).toBe(false);
    }
  });
  it('rejects text, unbounded positions and agreement edits in a view update', () => {
    for (const view of [{ ...move.view, active: 'guardian' }, { ...move.view, offset: 4000 },
      { ...move.view, consentAcknowledged: true }]) {
      expect(ConsentActionSchema.safeParse({ ...move, view }).success).toBe(false);
    }
  });
});
