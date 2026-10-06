import { describe, expect, it } from 'vitest';
import { GATE_DENY_REASONS, planLedgerBands, type LedgerBandLine } from '../src/index';

/**
 * SCRUM-494 register item 4 — the bands a sale owes carry their Gate access,
 * as the approved design's `buildPersonGrants` (`lib/sale.ts`) gives it: an
 * adult takes `line.ticketType.gateAccess ?? false`, a kid always false.
 */

const line = (over: Partial<LedgerBandLine>): LedgerBandLine => ({
  id: 'l1',
  cartLineId: 'c1',
  kind: 'kids',
  ticket: true,
  kidCount: 0,
  adultCount: 0,
  freeAdultCount: 0,
  ...over,
});

describe('planLedgerBands gives each band its line ticket Gate access', () => {
  it('adults on a gate ticket have it; kids never do', () => {
    const plan = planLedgerBands([
      line({ id: 'k', kind: 'kids', kidCount: 2, adultCount: 1, gateAccess: true }),
      line({ id: 'a', kind: 'adults_paid', kidCount: 2, adultCount: 1, gateAccess: true }),
    ]);
    expect(plan).toEqual([
      { kind: 'kid', saleLineId: 'k', cartLineId: 'c1', gateAccess: false },
      { kind: 'kid', saleLineId: 'k', cartLineId: 'c1', gateAccess: false },
      { kind: 'adult', saleLineId: 'a', cartLineId: 'c1', gateAccess: true },
    ]);
  });

  it('adults on a ticket with Gate access off, and on a line that names no setting, do not', () => {
    const plan = planLedgerBands([
      line({ id: 'p', cartLineId: 'off', kind: 'adults_paid', adultCount: 2, freeAdultCount: 1, gateAccess: false }),
      line({ id: 'f', cartLineId: 'off', kind: 'adults_free', adultCount: 2, freeAdultCount: 1, gateAccess: false }),
      line({ id: 'u', cartLineId: 'unset', kind: 'adults_paid', adultCount: 1 }),
      line({ id: 'g', cartLineId: 'on', kind: 'adults_paid', adultCount: 1, gateAccess: true }),
    ]);
    expect(plan.map((p) => [p.saleLineId, p.gateAccess])).toEqual([
      ['p', false],
      ['f', false],
      ['u', false],
      ['g', true],
    ]);
  });

  it('the gate journal names the refusal of a band without Gate access', () => {
    expect(GATE_DENY_REASONS).toContain('NO_GATE_ACCESS');
  });
});
