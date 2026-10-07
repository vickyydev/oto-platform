import { describe, expect, it } from 'vitest';
import {
  PARTY_EDITABLE_FIELDS,
  PartyChargeBodySchema,
  PartyPatchBodySchema,
  PartyPaymentBodySchema,
  partyBillOf,
} from '../src/index';

/**
 * S2-20 E4 — the party tab's arithmetic and shapes (events-kiosk PLAN §3:
 * `computePartyTotal`, `computePartyOutstanding`, `updateParty`'s protected
 * fields, a charge's total, a payment in whole baht).
 */

const ids = {
  branchId: '0190a0a0-0000-7000-8000-000000000001',
  editId: '0190a0a0-0000-7000-8000-000000000002',
};

describe('partyBillOf — lib/party.ts in satang', () => {
  it('total = base + line items + charges; outstanding = total − deposit − payments', () => {
    expect(
      partyBillOf({ baseSatang: 1_200_000, lineItemsSatang: 50_000, chargesSatang: 97_000, depositSatang: 300_000, paidSatang: 500_000 }),
    ).toEqual({
      baseSatang: 1_200_000,
      chargesSatang: 97_000,
      totalSatang: 1_347_000,
      depositSatang: 300_000,
      paidSatang: 500_000,
      outstandingSatang: 547_000,
    });
  });

  it('is never below zero (`Math.max(0, …)`), even when the deposit covers more than the bill', () => {
    expect(partyBillOf({ baseSatang: 100_000, chargesSatang: 0, depositSatang: 150_000, paidSatang: 0 }).outstandingSatang).toBe(0);
  });
});

describe("a PATCH is updateParty's patch", () => {
  it('carries any key it is sent, so the protected ones can be named back rather than silently dropped', () => {
    const parsed = PartyPatchBodySchema.parse({ ...ids, title: 'Party', id: 'x', partyPayments: [] });
    expect(parsed).toMatchObject({ title: 'Party', id: 'x', partyPayments: [] });
  });

  it('the editable fields are the OTO App’s, never the identity, the branch or the ledgers', () => {
    for (const key of ['id', 'branchId', 'partyExtraCharges', 'partyPayments', 'charges', 'payments', 'lastEditedBy']) {
      expect(PARTY_EDITABLE_FIELDS).not.toContain(key);
    }
    expect(PARTY_EDITABLE_FIELDS).toEqual(
      expect.arrayContaining(['title', 'status', 'date', 'basePriceSatang', 'depositSatang', 'depositDate', 'whatsapp']),
    );
  });

  it('money the OTO App keeps in baht must be whole baht', () => {
    expect(PartyPatchBodySchema.safeParse({ ...ids, basePriceSatang: 900_000 }).success).toBe(true);
    expect(PartyPatchBodySchema.safeParse({ ...ids, basePriceSatang: 900_050 }).success).toBe(false);
    expect(PartyPatchBodySchema.safeParse({ ...ids, depositSatang: -100 }).success).toBe(false);
  });

  it('a status is one of the four, a time is HH:mm, a date is a calendar date', () => {
    expect(PartyPatchBodySchema.safeParse({ ...ids, status: 'in_progress' }).success).toBe(true);
    expect(PartyPatchBodySchema.safeParse({ ...ids, status: 'party_time' }).success).toBe(false);
    expect(PartyPatchBodySchema.safeParse({ ...ids, startTime: '25:00' }).success).toBe(false);
    expect(PartyPatchBodySchema.safeParse({ ...ids, date: '2026-02-30' }).success).toBe(false);
  });
});

describe('a charge and a payment', () => {
  it('a charge names its kind and at least one item', () => {
    const base = { branchId: ids.branchId, chargeId: ids.editId, totalSatang: 1_000 };
    expect(PartyChargeBodySchema.safeParse({ ...base, kind: 'fnb', items: [{ name: 'Tea', qty: 1, lineTotalSatang: 1_000 }] }).success).toBe(true);
    expect(PartyChargeBodySchema.safeParse({ ...base, kind: 'bar', items: [{ name: 'Tea', qty: 1, lineTotalSatang: 1_000 }] }).success).toBe(false);
    expect(PartyChargeBodySchema.safeParse({ ...base, kind: 'fnb', items: [] }).success).toBe(false);
  });

  it('a payment is taken at a counter, with a tender, for at least one satang', () => {
    const base = { branchId: ids.branchId, paymentId: ids.editId, tender: { method: 'cash' } };
    expect(PartyPaymentBodySchema.safeParse({ ...base, stationId: ids.branchId, amountSatang: 10_000 }).success).toBe(true);
    expect(PartyPaymentBodySchema.safeParse({ ...base, amountSatang: 10_000 }).success).toBe(false);
    expect(PartyPaymentBodySchema.safeParse({ ...base, stationId: ids.branchId, amountSatang: 0 }).success).toBe(false);
  });
});
