import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, checkin, registration, station } from '@oto/db';
import { newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-857 — THE FAMILY'S DONE WRITES ONE REGISTRATION, HOWEVER OFTEN IT ARRIVES.
 *
 * The owner's ruling of 8 November: once every check passes the family's
 * Done moves the sale on without staff, so the registration the staff's
 * "Continue to payment" used to write is written on the family's Done, by
 * the same till gate and the same route. A Done can arrive more than once —
 * a double tap, a reply lost on the counter's connection and the gate run
 * again, staff pressing Continue as the family presses Done — and every run
 * of the gate sends the same client-minted registration and stay ids. The
 * platform answers each repeat with the registration that exists: one
 * registration, one stay per child, one audit row each. A child whose stay
 * already belongs to another registration is refused with a clear line, which
 * the family's screen and the staff line then show.
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

function body(over: Record<string, unknown> = {}) {
  return {
    id: newId(),
    branchId,
    stationId,
    guardianName: 'ZZ TEST guardian',
    guardianPhone: '0898570002',
    contactChannel: 'whatsapp',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
    contactConfirmation: { confirmedAt: new Date(Date.now() - 60_000).toISOString(), by: 'family' },
    children: [
      { checkinId: newId(), name: 'ZZ TEST Mai', ageYears: 6, service: 'drop_off', foodProvision: { mode: 'none', paidSatang: 0 } },
      { checkinId: newId(), name: 'ZZ TEST Ton', ageYears: 3, service: 'nanny', foodProvision: { mode: 'none', paidSatang: 0 } },
    ],
    ...over,
  };
}

const post = (payload: Record<string, unknown>, key?: string) => ctx.app.inject({
  method: 'POST', url: '/checkin/registrations',
  headers: { cookie: reception, ...(key ? { 'idempotency-key': key } : {}) }, payload,
});

async function writes(id: string, checkinIds: string[]) {
  const registrations = await ctx.db.select().from(registration).where(eq(registration.id, id));
  const stays = await ctx.db.select().from(checkin).where(eq(checkin.registrationId, id));
  const regAudit = await ctx.db.select().from(auditLog)
    .where(and(eq(auditLog.entityType, 'registration'), eq(auditLog.entityId, id), eq(auditLog.action, 'registration.create')));
  const stayAudit = (await Promise.all(checkinIds.map((stayId) => ctx.db.select().from(auditLog)
    .where(and(eq(auditLog.entityType, 'checkin'), eq(auditLog.entityId, stayId), eq(auditLog.action, 'checkin.create')))))).flat();
  return { registrations: registrations.length, stays: stays.length, regAudit: regAudit.length, stayAudit: stayAudit.length };
}

describe('the family’s Done, arriving more than once', () => {
  it('the same gate run again (a re-sent Done, a fresh request key) answers with the one registration', async () => {
    const payload = body();
    const ids = (payload.children as { checkinId: string }[]).map((c) => c.checkinId);
    const first = await post(payload, `zz-857-done-${newId()}`);
    expect(first.statusCode, first.body).toBe(200);
    const again = await post(payload, `zz-857-done-${newId()}`);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await writes(payload.id as string, ids)).toEqual({ registrations: 1, stays: 2, regAudit: 1, stayAudit: 2 });
  });

  it('the same request sent twice under one key is answered the same, and writes once', async () => {
    const payload = body();
    const ids = (payload.children as { checkinId: string }[]).map((c) => c.checkinId);
    const key = `zz-857-done-${newId()}`;
    const [a, b] = [await post(payload, key), await post(payload, key)];
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(await writes(payload.id as string, ids)).toEqual({ registrations: 1, stays: 2, regAudit: 1, stayAudit: 2 });
  });

  it('a child whose stay already belongs to another registration is refused with a clear line, and nothing is written', async () => {
    const first = body();
    expect((await post(first)).statusCode).toBe(200);
    const taken = (first.children as { checkinId: string }[])[0]!.checkinId;
    const second = body({ children: [{ checkinId: taken, name: 'ZZ TEST Mai', ageYears: 6, service: 'drop_off', foodProvision: { mode: 'none', paidSatang: 0 } }] });
    const refused = await post(second);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('ID_IN_USE');
    expect(refused.json().error.message).toMatch(/nothing was saved/);
    expect(await writes(second.id as string, [])).toMatchObject({ registrations: 0, stays: 0, regAudit: 0 });
  });

  it('a form whose consent was not finished is refused, so no registration is written for a family that did not complete it', async () => {
    const payload = body({ consentAcknowledged: false });
    const refused = await post(payload);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('CONSENT_REQUIRED');
    expect(await writes(payload.id as string, [])).toMatchObject({ registrations: 0, stays: 0, regAudit: 0 });
  });
});
