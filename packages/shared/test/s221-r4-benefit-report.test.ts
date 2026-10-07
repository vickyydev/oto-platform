import { describe, expect, it } from 'vitest';
import {
  BenefitReportQuerySchema,
  BenefitReportSchema,
  addBenefitReliefSums,
  emptyBenefitReliefSums,
} from '../src/index';

/**
 * S2-21 (SCRUM-218) round 4 — the staff benefits report's wire and its sums
 * (`GET /analytics/reports/benefits`, the plan's GET /reports/benefits).
 */

describe('the benefits report’s sums', () => {
  it('adds the twelve figures and leaves a row’s head alone', () => {
    const row = { role: 'manager' as const, name: 'Khun Lek (Manager)', ...emptyBenefitReliefSums() };
    const once = {
      ...emptyBenefitReliefSums(),
      applications: 1,
      freeItemsCount: 1,
      freeItemUnits: 2,
      freeItemsSatang: 12_000,
      creditCount: 1,
      creditSatang: 50_000,
      discountCount: 1,
      discountSatang: 3_300,
      totalReliefSatang: 65_300,
      appliedSatang: 65_300,
    };
    addBenefitReliefSums(row, once);
    addBenefitReliefSums(row, once);
    expect(row).toEqual({
      role: 'manager',
      name: 'Khun Lek (Manager)',
      applications: 2,
      compCount: 0,
      compedSatang: 0,
      freeItemsCount: 2,
      freeItemUnits: 4,
      freeItemsSatang: 24_000,
      creditCount: 2,
      creditSatang: 100_000,
      discountCount: 2,
      discountSatang: 6_600,
      totalReliefSatang: 130_600,
      appliedSatang: 130_600,
    });
  });

  it('the query takes a beneficiary and a role, and refuses a role the platform does not have', () => {
    const ok = BenefitReportQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-07', role: 'owner' });
    expect(ok.success).toBe(true);
    expect(BenefitReportQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-07', role: 'cashier' }).success).toBe(false);
    expect(BenefitReportQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-07', employeeId: 'nobody' }).success).toBe(false);
  });

  it('an empty answer is a valid report', () => {
    const parsed = BenefitReportSchema.safeParse({
      from: '2026-10-01',
      to: '2026-10-07',
      branches: [],
      omitted: [],
      employeeId: null,
      role: null,
      totals: emptyBenefitReliefSums(),
      byRole: [],
      byBeneficiary: [],
      days: [],
      lastRolledUpAt: null,
    });
    expect(parsed.success).toBe(true);
  });
});
