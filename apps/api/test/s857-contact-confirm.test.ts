import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, registration, station } from '@oto/db';
import { newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-857 — THE REGISTRATION KEEPS THE FAMILY'S CONFIRMATION OF THEIR NUMBER.
 *
 * The owner's ruling of 8 November: the drop-off and nanny form shows the
 * number the child's messages go to and the family must explicitly confirm it
 * is the one for the chosen channel. The till requires the tick before it
 * writes the registration; the platform keeps when it was given and by whom
 * (the family on their own screen, or staff on the till with the family
 * beside them), beside the number and channel it was given for, and audits
 * it. The api also checks the number itself: a valid number for its country
 * that can take a message, refused with a clear line otherwise.
 */

let ctx: TestContext;
let reception: string;
let branchId: string;
let stationId: string;

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];
/** A minute ago on this machine's clock: the till stamps the tick as it is given, never ahead of the platform. */
const CONFIRMED_AT = new Date(Date.now() - 60_000).toISOString();

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
    guardianPhone: '0898570001',
    contactChannel: 'telegram',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
    children: [{ checkinId: newId(), name: 'ZZ TEST child', ageYears: 6, service: 'drop_off', foodProvision: { mode: 'none', paidSatang: 0 } }],
    ...over,
  };
}

async function register(over: Record<string, unknown> = {}) {
  const payload = body(over);
  const res = await ctx.app.inject({ method: 'POST', url: '/checkin/registrations', headers: { cookie: reception }, payload });
  return { res, payload };
}

async function createAudit(id: string) {
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'registration'), eq(auditLog.entityId, id), eq(auditLog.action, 'registration.create')));
  return rows[0]!.after as Record<string, unknown>;
}

describe('POST /checkin/registrations with the number confirmed', () => {
  it.each(['family', 'staff'] as const)('keeps when it was confirmed and that the %s gave the tick, on the record, the view and the audit row', async (by) => {
    const { res, payload } = await register({ contactConfirmation: { confirmedAt: CONFIRMED_AT, by } });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json();
    expect(view).toMatchObject({ guardianPhone: '+66898570001', contactChannel: 'telegram', contactConfirmedAt: CONFIRMED_AT, contactConfirmedBy: by });
    const [row] = await ctx.db.select().from(registration).where(eq(registration.id, payload.id as string));
    expect(row!.contactConfirmedAt?.toISOString()).toBe(CONFIRMED_AT);
    expect(row!.contactConfirmedBy).toBe(by);
    expect(await createAudit(payload.id as string)).toMatchObject({
      guardianPhone: '+66898570001', contactChannel: 'telegram', contactConfirmedAt: CONFIRMED_AT, contactConfirmedBy: by,
    });
    // A retry with the same id answers with the same record, confirmation included.
    const again = await ctx.app.inject({ method: 'POST', url: '/checkin/registrations', headers: { cookie: reception }, payload });
    expect(again.statusCode).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.json()).toMatchObject({ contactConfirmedAt: CONFIRMED_AT, contactConfirmedBy: by });
  });

  it('a confirmation from a clock ahead of the platform is stamped now, never in the future', async () => {
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    const { res } = await register({ contactConfirmation: { confirmedAt: ahead, by: 'family' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(Date.parse(res.json().contactConfirmedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('without the confirmation — a station’s offline path, an older till — the record says none was taken', async () => {
    for (const over of [{}, { contactConfirmation: null }]) {
      const { res, payload } = await register(over);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ contactConfirmedAt: null, contactConfirmedBy: null });
      expect(await createAudit(payload.id as string)).toMatchObject({ contactConfirmedAt: null, contactConfirmedBy: null });
    }
  });

  it('refuses a confirmation with no number to confirm', async () => {
    const { res } = await register({ guardianPhone: null, contactConfirmation: { confirmedAt: CONFIRMED_AT, by: 'family' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('none was given');
    const empty = await register({ guardianPhone: '  ', contactConfirmation: { confirmedAt: CONFIRMED_AT, by: 'family' } });
    expect(empty.res.statusCode).toBe(400);
  });

  it('refuses a confirmation that names anyone but the family or staff, or is not a time', async () => {
    const who = await register({ contactConfirmation: { confirmedAt: CONFIRMED_AT, by: 'guardian' } });
    expect(who.res.statusCode).toBe(400);
    const when = await register({ contactConfirmation: { confirmedAt: 'this morning', by: 'family' } });
    expect(when.res.statusCode).toBe(400);
  });
});

describe('POST /checkin/registrations checks the number itself', () => {
  it('refuses a landline with a line that says so', async () => {
    const { res } = await register({ guardianPhone: '021234567' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/landline/);
  });

  it('refuses a number of the right length that is not a number of its country', async () => {
    const { res } = await register({ guardianPhone: '0112345678' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not a valid number for its country/);
  });

  it('refuses something that cannot be a phone number, as before', async () => {
    const { res } = await register({ guardianPhone: 'call me' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/doesn't look right/);
  });

  it('takes a mobile typed any way a family types it, and a number from abroad', async () => {
    for (const guardianPhone of ['0898570002', '+66 89 857 0002', '+660898570002', '+447911123456']) {
      const { res } = await register({ guardianPhone });
      expect(res.statusCode, `${guardianPhone}: ${res.body}`).toBe(200);
    }
  });

  it('still registers a family that gave no number at all', async () => {
    const { res } = await register({ guardianPhone: null });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().guardianPhone).toBeNull();
  });
});

describe('PATCH /checkin/checkins/:id after the family confirmed the number', () => {
  async function confirmedStay() {
    const { res, payload } = await register({ contactConfirmation: { confirmedAt: CONFIRMED_AT, by: 'family' } });
    expect(res.statusCode, res.body).toBe(200);
    return { registrationId: payload.id as string, stayId: res.json().children[0].id as string };
  }
  const edit = (id: string, payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'PATCH', url: `/checkin/checkins/${id}`, headers: { cookie: reception }, payload });
  const row = async (id: string) => (await ctx.db.select().from(registration).where(eq(registration.id, id)))[0]!;
  const lastEdit = async (id: string) => {
    const rows = await ctx.db.select().from(auditLog)
      .where(and(eq(auditLog.entityType, 'registration'), eq(auditLog.entityId, id), eq(auditLog.action, 'registration.update')));
    return rows.at(-1)!;
  };

  it('keeps the confirmation when only the name changes', async () => {
    const { registrationId, stayId } = await confirmedStay();
    expect((await edit(stayId, { guardianName: 'ZZ TEST guardian B' })).statusCode).toBe(200);
    expect((await row(registrationId)).contactConfirmedBy).toBe('family');
  });

  it.each([
    ['a new number', { guardianPhone: '0898570003' }],
    ['another channel', { contactChannel: 'line' }],
  ])('withdraws it on %s, and the audit row says so', async (_label, change) => {
    const { registrationId, stayId } = await confirmedStay();
    const res = await edit(stayId, change);
    expect(res.statusCode, res.body).toBe(200);
    const after = await row(registrationId);
    expect(after.contactConfirmedAt).toBeNull();
    expect(after.contactConfirmedBy).toBeNull();
    const audited = await lastEdit(registrationId);
    expect(audited.before).toMatchObject({ contactConfirmedAt: CONFIRMED_AT, contactConfirmedBy: 'family' });
    expect(audited.after).toMatchObject({ contactConfirmedAt: null, contactConfirmedBy: null });
  });

  it('lets staff clear the number, which takes the confirmation with it', async () => {
    const { registrationId, stayId } = await confirmedStay();
    const res = await edit(stayId, { guardianPhone: null });
    expect(res.statusCode, res.body).toBe(200);
    const after = await row(registrationId);
    expect(after.guardianPhone).toBeNull();
    expect(after.contactConfirmedAt).toBeNull();
  });
});
