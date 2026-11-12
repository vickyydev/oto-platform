import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, checkin, station } from '@oto/db';
import { newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-911 — SCRUM-862 made `cancelled` a stay status and taught
 * `boardChildOf` to throw on one ("a cancelled stay is never on the board").
 * The board's Edit (`PATCH /checkins/:id`, `editCheckin`) was not taught the
 * new status (found in the defect hunt, 12 Nov): it edited the cancelled stay
 * and then answered with `boardChildById`, which throws. A stale board card
 * (another till cancelled the booking meanwhile) met a 500, not the
 * counter's words. Now the edit is refused before anything is written, with
 * the refusal Assign nanny gives, and the till's board reads afresh on it.
 */

let ctx: TestContext;
let reception: string;
let branchId: string;
let stationId: string;

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('a board Edit on a stay cancelled meanwhile', () => {
  it('is refused in the counter words, not a server error', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/registrations',
      headers: { cookie: reception },
      payload: {
        id: newId(),
        branchId,
        stationId,
        guardianName: 'ZZ TEST Hunt',
        guardianPhone: '0812345670',
        contactChannel: 'whatsapp',
        consentAcknowledged: true,
        acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
        children: [
          {
            checkinId: newId(),
            name: 'ZZ TEST Kid',
            ageYears: 6,
            service: 'drop_off',
            allergies: null,
            foodRestrictions: null,
            foodProvision: { mode: 'none', paidSatang: 0 },
          },
        ],
      },
    });
    expect(reg.statusCode, reg.body).toBe(200);
    const registration = reg.json() as { id: string; children: Array<{ id: string }> };
    const stayId = registration.children[0]!.id;

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/registrations/${registration.id}/cancel`,
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { reason: 'family left' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    // The board card was read before the cancel; staff save an allergy on it.
    const edit = await ctx.app.inject({
      method: 'PATCH',
      url: `/checkin/checkins/${stayId}`,
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { allergies: 'Peanuts' },
    });
    const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, stayId));
    expect(row!.status).toBe('cancelled');
    // A 409 in the counter's words, as Assign nanny answers; nothing is written.
    expect(edit.statusCode, edit.body).toBe(409);
    expect(edit.json().error.code).toBe('CHECKIN_NOT_REGISTERED');
    expect(edit.json().error.message).toBe("ZZ TEST Kid's drop-off booking was cancelled — register them again if they are staying.");
    expect(row!.allergies).toBeNull();
  });
});
