import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, registration, station } from '@oto/db';
import { newId } from '@oto/shared';
import { CONFIRMATION_WITHDRAWN } from '../src/services/checkin';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-914 — THE CHECK-IN BOARD'S EDIT HOLDS A NEW NUMBER TO THE FORM'S RULE,
 * AND SAYS WHEN IT WITHDREW THE FAMILY'S CONFIRMATION.
 *
 * The drop-off and nanny form refuses a number the park cannot message a
 * family on (a landline, a service line); the board's edit took one. A new
 * number on the board is now held to the same rule, with the same words; the
 * number already on the registration is never questioned. And when a new
 * number or another channel withdraws the family's confirmation (SCRUM-857),
 * the save says so plainly in its warnings, which the board shows.
 */

let ctx: TestContext;
let reception: string;
let branchId: string;
let stationId: string;
const CONFIRMED_AT = new Date(Date.now() - 60_000).toISOString();

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  const [till] = await ctx.db.select().from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function confirmedStay(phone = '0898914001') {
  const id = newId();
  const res = await ctx.app.inject({ method: 'POST', url: '/checkin/registrations', headers: { cookie: reception }, payload: {
    id, branchId, stationId, guardianName: 'ZZ TEST guardian', guardianPhone: phone, contactChannel: 'whatsapp',
    consentAcknowledged: true, acknowledgedConfirmationIds: ['confirm-15min', 'confirm-no-refund', 'confirm-evac'],
    contactConfirmation: { confirmedAt: CONFIRMED_AT, by: 'family' },
    children: [{ checkinId: newId(), name: 'ZZ TEST child', ageYears: 6, service: 'drop_off', foodProvision: { mode: 'none', paidSatang: 0 } }],
  } });
  expect(res.statusCode, res.body).toBe(200);
  return { registrationId: id, stayId: res.json().children[0].id as string };
}
const edit = (id: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'PATCH', url: `/checkin/checkins/${id}`, headers: { cookie: reception }, payload });
const row = async (id: string) => (await ctx.db.select().from(registration).where(eq(registration.id, id)))[0]!;

describe('PATCH /checkin/checkins/:id — the number', () => {
  it('refuses a new landline with the form’s own line, and changes nothing', async () => {
    const { registrationId, stayId } = await confirmedStay();
    const res = await edit(stayId, { guardianPhone: '021234567' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/landline or a service line/);
    const after = await row(registrationId);
    expect(after.guardianPhone).toBe('+66898914001');
    expect(after.contactConfirmedBy).toBe('family');
  });

  it('refuses a number that is not one of its country, as the form does', async () => {
    const { stayId } = await confirmedStay();
    const res = await edit(stayId, { guardianPhone: '0112345678' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not a valid number for its country/);
  });

  it('takes the number already on the registration sent back in another form, and withdraws nothing', async () => {
    const { registrationId, stayId } = await confirmedStay();
    const res = await edit(stayId, { guardianPhone: '+660898914001', guardianName: 'ZZ TEST guardian B' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().warnings).not.toContain(CONFIRMATION_WITHDRAWN);
    expect((await row(registrationId)).contactConfirmedBy).toBe('family');
  });
});

describe('PATCH /checkin/checkins/:id — the confirmation', () => {
  it.each([
    ['a new mobile', { guardianPhone: '0898914002' }],
    ['another channel', { contactChannel: 'telegram' }],
  ])('%s withdraws it, and the save says so plainly', async (_label, change) => {
    const { registrationId, stayId } = await confirmedStay();
    const res = await edit(stayId, change);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().warnings).toContain(CONFIRMATION_WITHDRAWN);
    expect(CONFIRMATION_WITHDRAWN).toMatch(/confirmation of their messaging number was withdrawn/);
    expect((await row(registrationId)).contactConfirmedAt).toBeNull();
    const audits = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityType, 'registration'),
      eq(auditLog.entityId, registrationId), eq(auditLog.action, 'registration.update')));
    expect(audits.at(-1)!.after).toMatchObject({ contactConfirmedAt: null, contactConfirmedBy: null });
  });

  it('a change of the name alone says nothing about it', async () => {
    const { stayId } = await confirmedStay();
    const res = await edit(stayId, { guardianName: 'ZZ TEST guardian C' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().warnings).not.toContain(CONFIRMATION_WITHDRAWN);
  });
});
