import { describe, expect, it } from 'vitest';
import { BOX_LANE_PAYMENT_REFUSAL, BOX_LANE_UNREACHABLE } from '@oto/shared';

/** SCRUM-502: a native real-box cash press succeeded before its reply was lost. */
describe('SCRUM-502 payment uncertainty review', () => {
  it('resolved HIGH: no answer does not prove no money was taken; say it may already be recorded', () => {
    // Fix: the shared connection message preserves uncertainty, IDs and retry behavior.
    expect(BOX_LANE_UNREACHABLE.message).toContain('may already have recorded');
    expect(BOX_LANE_UNREACHABLE.message).not.toContain('nothing was taken');
  });

  it('a definite unavailable payment lane keeps its refusal and does not promise a successful sale', () => {
    expect(BOX_LANE_PAYMENT_REFUSAL.code).toBe('BOX_LANE_PAYMENT_UNAVAILABLE');
    expect(BOX_LANE_PAYMENT_REFUSAL.message).toContain('taking payment offline is not switched on yet');
    expect(BOX_LANE_PAYMENT_REFUSAL.message).toContain('Keep the order');
  });
});
