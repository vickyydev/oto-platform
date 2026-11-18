import { randomBytes } from 'node:crypto';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, authThrottle, booking, branch, checkin, child, member, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  createTestContext,
  lastCode,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-1011 — A RETURNING FAMILY'S ONLINE CHANGES ARE SAVED TO THEIR RECORD.
 *
 * The owner's ruling of 18 November ("Save it to the family record") and his
 * choices of 19 November: plain (saved and logged), the record changes when
 * the parent confirms online paid or not, "Remove from saved" online, and the
 * contact app saved to the family record too. The approved design did all four
 * (`imports/oto-pos/artifacts/oto-till/src/pages/Book.tsx`).
 *
 * What these pin, in the order of the plan's checks (adjusted to "at confirm"):
 *   - no pass, nothing saved; a pass for another family refused; a saved
 *     child of another family refused; an expired pass refused;
 *   - a confirm with no booking and no payment updates a saved child and adds
 *     a new one, each with its audit row (before, after, `booking_site`, no
 *     staff actor), and saves the contact app; a replay writes nothing more;
 *   - "Remove from saved" archives the child, audited, once;
 *   - the booking carries the pass and the saved-child ids, is refused for
 *     another family's child, and its paid stay is linked to the saved child.
 */

const SECRET = randomBytes(32).toString('hex');
const PHONE_A = '0812011011';
const PHONE_B = '0812011022';

/** A plain weekday a week out, skipping weekends and the seeded holiday range. */
const WEEKDAY = (() => {
  const day = new Date(Date.now() + 7 * 86_400_000);
  for (;;) {
    const iso = new Date(day.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    const nearHoliday = iso >= '2026-11-23' && iso <= '2026-11-25';
    if (dow !== 0 && dow !== 6 && !nearHoliday) return iso;
    day.setUTCDate(day.getUTCDate() + 1);
  }
})();

let ctx: TestContext;
let reception: string;
let oneHourId: string;
let confirmationIds: string[];
let familyA: { memberId: string; childIds: string[]; pass: string };
let familyB: { memberId: string; childIds: string[]; pass: string };

let caller = 0;
const address = (): string => {
  caller += 1;
  return `10.211.${Math.floor(caller / 250)}.${(caller % 250) + 1}`;
};

async function makeFamily(phone: string, nickname: string, kids: Array<Record<string, unknown>>) {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/members',
    headers: { cookie: reception, 'idempotency-key': newId() },
    payload: { phone, nickname },
  });
  expect(created.statusCode, created.body).toBe(200);
  const memberId = (created.json().member as { id: string }).id;
  const childIds: string[] = [];
  for (const kid of kids) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/members/${memberId}/children`,
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: kid,
    });
    expect(res.statusCode, res.body).toBe(200);
    childIds.push((res.json().child as { id: string }).id);
  }
  return { memberId, childIds };
}

async function passFor(phone: string): Promise<{ pass: string; expiresAt: string; children: Array<Record<string, unknown>> }> {
  const sent = await ctx.app.inject({
    method: 'POST',
    url: '/public/saved-children/code',
    remoteAddress: address(),
    payload: { phone, branch: CENTRAL_BRANCH_CODE },
  });
  expect(sent.statusCode, sent.body).toBe(200);
  const verified = await ctx.app.inject({
    method: 'POST',
    url: '/public/saved-children/verify',
    remoteAddress: address(),
    payload: { phone, branch: CENTRAL_BRANCH_CODE, code: lastCode(ctx.smsLog) },
  });
  expect(verified.statusCode, verified.body).toBe(200);
  const body = verified.json() as { children: Array<Record<string, unknown>>; familyPass: string; familyPassExpiresAt: string };
  return { pass: body.familyPass, expiresAt: body.familyPassExpiresAt, children: body.children };
}

function save(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/public/saved-children/save',
    remoteAddress: address(),
    payload: { branch: CENTRAL_BRANCH_CODE, children: [], ...payload },
  });
}

async function childRow(id: string) {
  const [row] = await ctx.db.select().from(child).where(eq(child.id, id));
  return row!;
}

async function auditFor(entityIds: string[], actions: string[]) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(inArray(auditLog.entityId, entityIds), inArray(auditLog.action, actions)));
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api,jobs',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: 'OTOTESTMERCHANT',
      PGW_SECRET_KEY: SECRET,
      PGW_WEBHOOK_SECRET: 'a-path-filter-not-a-credential',
    },
  });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, central!.id));
  oneHourId = packages.find((p) => p.name === '1 Hour Play')!.id;
  const cat = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
  confirmationIds = (cat.json().supervision as { policy: { confirmations: Array<{ id: string; required: boolean }> } })
    .policy.confirmations.filter((c) => c.required).map((c) => c.id);

  const a = await makeFamily(PHONE_A, 'ZZ TEST Family A', [
    { name: 'ZZ TEST Aya', dateOfBirth: '2020-03-01', allergies: 'Peanuts', foodRestrictions: 'No pork' },
    { name: 'ZZ TEST Ben', ageYears: 7 },
  ]);
  const b = await makeFamily(PHONE_B, 'ZZ TEST Family B', [{ name: 'ZZ TEST Cara', ageYears: 5, allergies: 'Milk' }]);
  familyA = { ...a, pass: (await passFor(PHONE_A)).pass };
  familyB = { ...b, pass: (await passFor(PHONE_B)).pass };
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-1011 — the family pass from the code check', () => {
  it('comes with the saved children, for sixty minutes, and only its hash is kept', async () => {
    const got = await passFor(PHONE_A);
    expect(got.pass).toMatch(/^[0-9a-f]{64}$/);
    const minutes = (Date.parse(got.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(58);
    expect(minutes).toBeLessThanOrEqual(60);
    const rows = await ctx.db.select().from(authThrottle).where(like(authThrottle.key, `mpass:${familyA.memberId}:%`));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) expect(row.key).not.toContain(got.pass);
  });
});

describe('SCRUM-1011 — nothing is saved without the family pass for this family', () => {
  const changed = (childId: string) => ({ savedChildId: childId, name: 'ZZ TEST Aya', ageYears: 6, dateOfBirth: '2020-03-01', allergies: 'Everything' });

  it('no pass, nothing saved', async () => {
    const before = await childRow(familyA.childIds[0]!);
    const noPass = await save({ phone: PHONE_A, children: [changed(familyA.childIds[0]!)] });
    expect(noPass.statusCode).toBe(400);
    const madeUp = await save({ phone: PHONE_A, pass: randomBytes(32).toString('hex'), children: [changed(familyA.childIds[0]!)] });
    expect(madeUp.statusCode, madeUp.body).toBe(403);
    expect(madeUp.json().error.code).toBe('FAMILY_CHECK_EXPIRED');
    expect((await childRow(familyA.childIds[0]!)).allergies).toBe(before.allergies);
    expect(await auditFor([familyA.childIds[0]!], ['child.update'])).toHaveLength(0);
  });

  it('a pass for another family is refused', async () => {
    const res = await save({
      phone: PHONE_B,
      pass: familyA.pass,
      children: [{ savedChildId: familyB.childIds[0]!, name: 'ZZ TEST Cara', ageYears: 5, allergies: 'Nothing' }],
    });
    expect(res.statusCode, res.body).toBe(403);
    expect((await childRow(familyB.childIds[0]!)).allergies).toBe('Milk');
  });

  it("another family's saved child is refused, and the family's own change in the same send is not written", async () => {
    const res = await save({
      phone: PHONE_A,
      pass: familyA.pass,
      children: [
        changed(familyA.childIds[0]!),
        { savedChildId: familyB.childIds[0]!, name: 'ZZ TEST Cara', ageYears: 5, allergies: 'Nothing' },
      ],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect((await childRow(familyA.childIds[0]!)).allergies).toBe('Peanuts');
    expect((await childRow(familyB.childIds[0]!)).allergies).toBe('Milk');
    // Nor removed, nor reused as a "new" child's id.
    const removing = await save({ phone: PHONE_A, pass: familyA.pass, remove: [familyB.childIds[0]!] });
    expect(removing.statusCode).toBe(400);
    const asNew = await save({
      phone: PHONE_A,
      pass: familyA.pass,
      children: [{ newChildId: familyB.childIds[0]!, name: 'ZZ TEST Cara', ageYears: 5 }],
    });
    expect(asNew.statusCode).toBe(400);
    expect((await childRow(familyB.childIds[0]!)).archivedAt).toBeNull();
    expect((await childRow(familyB.childIds[0]!)).memberId).toBe(familyB.memberId);
  });

  it('an expired pass is refused', async () => {
    const stale = await passFor(PHONE_A);
    const keys = await ctx.db.select().from(authThrottle).where(like(authThrottle.key, `mpass:${familyA.memberId}:%`));
    // Every pass of this family but the one the other cases use runs out now.
    const { createHash } = await import('node:crypto');
    const keep = `mpass:${familyA.memberId}:${createHash('sha256').update(familyA.pass).digest('hex')}`;
    for (const row of keys) {
      if (row.key !== keep) {
        await ctx.db.update(authThrottle).set({ lockedUntil: new Date(Date.now() - 1_000) }).where(eq(authThrottle.key, row.key));
      }
    }
    const res = await save({ phone: PHONE_A, pass: stale.pass, children: [changed(familyA.childIds[0]!)] });
    expect(res.statusCode, res.body).toBe(403);
    expect((await childRow(familyA.childIds[0]!)).allergies).toBe('Peanuts');
  });
});

describe('SCRUM-1011 — the parent confirms online, paid or not', () => {
  const siblingId = newId();
  const confirm = () =>
    save({
      phone: PHONE_A,
      pass: familyA.pass,
      contactChannel: 'telegram',
      children: [
        { savedChildId: familyA.childIds[0]!, name: 'ZZ TEST Aya', dateOfBirth: '2020-03-01', ageYears: 6, allergies: 'Peanuts and sesame', foodRestrictions: 'No pork' },
        { newChildId: siblingId, name: 'ZZ TEST Dao', dateOfBirth: '2022-05-10', ageYears: 4, allergies: '', foodRestrictions: 'Vegetarian' },
      ],
    });

  it('updates the saved child and adds the sibling, each audited with before and after, and saves the contact app', async () => {
    const res = await confirm();
    expect(res.statusCode, res.body).toBe(200);
    const answered = res.json().children as Array<{ id: string; name: string; allergies: string | null }>;
    expect(answered.map((c) => c.name).sort()).toEqual(['ZZ TEST Aya', 'ZZ TEST Ben', 'ZZ TEST Dao']);
    expect(answered.find((c) => c.id === familyA.childIds[0])!.allergies).toBe('Peanuts and sesame');

    const aya = await childRow(familyA.childIds[0]!);
    expect(aya.allergies).toBe('Peanuts and sesame');
    expect(aya.medicalAlert).toBe(true);
    const dao = await childRow(siblingId);
    expect(dao).toMatchObject({ memberId: familyA.memberId, name: 'ZZ TEST Dao', dateOfBirth: '2022-05-10', ageYears: 4, allergies: null, foodRestrictions: 'Vegetarian' });

    const [update] = await auditFor([familyA.childIds[0]!], ['child.update']);
    expect(update).toMatchObject({ actorAccountId: null, origin: 'booking_site' });
    expect(update!.before).toEqual({ allergies: 'Peanuts' });
    expect(update!.after).toEqual({ allergies: 'Peanuts and sesame', source: 'booking_site' });
    const [created] = await auditFor([siblingId], ['child.create']);
    expect(created).toMatchObject({ actorAccountId: null, origin: 'booking_site' });
    expect(created!.after).toMatchObject({ memberId: familyA.memberId, name: 'ZZ TEST Dao', source: 'booking_site' });

    const [m] = await ctx.db.select().from(member).where(eq(member.id, familyA.memberId));
    expect(m!.preferredChannel).toBe('telegram');
    const [channel] = await auditFor([familyA.memberId], ['member.update']);
    expect(channel!.before).toEqual({ preferredChannel: null });
    expect(channel!.after).toEqual({ preferredChannel: 'telegram', source: 'booking_site' });

    // No booking was made, and none was paid.
    const bookings = await ctx.db.select().from(booking).where(eq(booking.memberId, familyA.memberId));
    expect(bookings).toHaveLength(0);
  });

  it('a replayed confirm writes once', async () => {
    const before = await auditFor([familyA.childIds[0]!, siblingId, familyA.memberId], ['child.update', 'child.create', 'member.update']);
    const again = await confirm();
    expect(again.statusCode, again.body).toBe(200);
    const after = await auditFor([familyA.childIds[0]!, siblingId, familyA.memberId], ['child.update', 'child.create', 'member.update']);
    expect(after).toHaveLength(before.length);
    const kids = await ctx.db.select().from(child).where(eq(child.memberId, familyA.memberId));
    expect(kids).toHaveLength(3);
  });

  it('"Remove from saved" archives the child, audited, once', async () => {
    const benId = familyA.childIds[1]!;
    const res = await save({ phone: PHONE_A, pass: familyA.pass, remove: [benId] });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().children as Array<{ id: string }>).map((c) => c.id)).not.toContain(benId);
    const ben = await childRow(benId);
    expect(ben.archivedAt).not.toBeNull();
    const again = await save({ phone: PHONE_A, pass: familyA.pass, remove: [benId] });
    expect(again.statusCode).toBe(200);
    const rows = await auditFor([benId], ['child.archive']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorAccountId: null, origin: 'booking_site' });
    expect((rows[0]!.after as { source?: string }).source).toBe('booking_site');
    // A removed child is not confirmed back onto the record.
    const back = await save({ phone: PHONE_A, pass: familyA.pass, children: [{ savedChildId: benId, name: 'ZZ TEST Ben', ageYears: 7 }] });
    expect(back.statusCode).toBe(400);
  });
});

describe('SCRUM-1011 — the booking says which saved child each child is', () => {
  const supervisedLine = (savedChildId?: string) => ({
    packageId: oneHourId,
    kids: 1,
    adults: 0,
    supervision: { childName: 'ZZ TEST Aya', ageYears: 6, allergies: 'Peanuts and sesame', ...(savedChildId ? { savedChildId } : {}) },
  });
  const book = (over: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/public/bookings',
      remoteAddress: address(),
      payload: {
        branchCode: CENTRAL_BRANCH_CODE,
        phone: PHONE_A,
        parentName: 'ZZ TEST Family A',
        tier: 'thai',
        visitDate: WEEKDAY,
        consentAck: true,
        acknowledgedConfirmationIds: confirmationIds,
        ...over,
      },
    });

  it("is refused with another family's child, or with no pass", async () => {
    const foreign = await book({ familyPass: familyA.pass, lines: [supervisedLine(familyB.childIds[0]!)] });
    expect(foreign.statusCode, foreign.body).toBe(400);
    expect(foreign.json().error.message).toContain('nothing was booked');
    const noPass = await book({ lines: [supervisedLine(familyA.childIds[0]!)] });
    expect(noPass.statusCode, noPass.body).toBe(403);
    // The family is told nothing was booked, not that the details "still go on this booking".
    expect(noPass.json().error.message).toContain('nothing was booked');
    expect(noPass.json().error.message).not.toContain('still go on this booking');
    const otherPass = await book({ familyPass: familyB.pass, lines: [supervisedLine(familyA.childIds[0]!)] });
    expect(otherPass.statusCode, otherPass.body).toBe(403);
  });

  it('is family checked with the pass, and its paid stay is linked to the saved child', async () => {
    const made = await book({ familyPass: familyA.pass, lines: [supervisedLine(familyA.childIds[0]!)] });
    expect(made.statusCode, made.body).toBe(200);
    const id = made.json().id as string;
    const [pending] = await ctx.db.select().from(booking).where(eq(booking.id, id));
    const payload = pending!.payload as { familyChecked?: boolean; lines: Array<{ supervision: { savedChildId?: string } }> };
    expect(payload.familyChecked).toBe(true);
    expect(payload.lines[0]!.supervision.savedChildId).toBe(familyA.childIds[0]);
    expect(pending!.memberId).toBe(familyA.memberId);

    const opened = await ctx.app.inject({
      method: 'POST',
      url: `/public/bookings/${id}/checkout`,
      remoteAddress: address(),
      payload: { method: 'card' },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const pressed = await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/2c2p/hosted/${opened.json().attemptId as string}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'action=pay',
    });
    expect(pressed.statusCode, pressed.body).toBe(200);
    const [paid] = await ctx.db.select().from(booking).where(eq(booking.id, id));
    const stayId = (paid!.payload as { lines: Array<{ supervision: { checkinId: string } }> }).lines[0]!.supervision.checkinId;
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, stayId));
    expect(stay!.childId).toBe(familyA.childIds[0]);
  });

  it('a booking with no saved child and no pass is made as before, not family checked', async () => {
    const made = await book({ lines: [supervisedLine()] });
    expect(made.statusCode, made.body).toBe(200);
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, made.json().id as string));
    expect((row!.payload as { familyChecked?: boolean }).familyChecked).toBeUndefined();
  });
});
