import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberTierVerification, saleTierClaim, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-773 — the tier proof documents, decided on 4 November 2026, through
 * the real routes.
 *
 * Driving licence takes the place of Residence certificate: new checks may
 * name it and may no longer name the retired kind, while a member or a sale
 * checked on a Residence certificate before the change reads as it was filed.
 * Other takes an expiry date again, optional as on every kind.
 */

let ctx: TestContext;
let cookie: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;

const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-06-30`;

async function newMember(phone: string, nickname: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/members',
    headers: { cookie },
    payload: { phone, nickname },
  });
  expect(created.statusCode, created.body).toBeLessThan(300);
  return created.json().member.id as string;
}

function verify(memberId: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/members/${memberId}/tier-verification`,
    headers: { cookie, 'idempotency-key': newId() },
    payload: { toTier: 'thai', ...payload },
  });
}

function claim(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales/tier-claims',
    headers: { cookie },
    payload: { branchId, toTier: 'thai', ...payload },
  });
}

async function rowsOf(memberId: string) {
  return ctx.db
    .select()
    .from(memberTierVerification)
    .where(eq(memberTierVerification.memberId, memberId))
    .orderBy(desc(memberTierVerification.createdAt));
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-773 — the kinds a new check may name', () => {
  it('records a Driving licence with its expiry', async () => {
    const memberId = await newMember('0637730001', 'Licence Holder');
    const res = await verify(memberId, { evidenceType: 'Driving licence', evidenceExpiresAt: NEXT_YEAR });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().member.tierVerification).toMatchObject({
      tier: 'thai',
      proofType: 'Driving licence',
      expiresAt: NEXT_YEAR,
      reverifyDue: false,
    });
    const [row] = await rowsOf(memberId);
    expect(row).toMatchObject({ evidenceType: 'Driving licence' });
  });

  it('no longer records a Residence certificate, on a member or on a walk-in claim', async () => {
    const memberId = await newMember('0637730002', 'Retired Kind');
    const res = await verify(memberId, { evidenceType: 'Residence certificate' });
    expect(res.statusCode, res.body).toBe(400);
    expect(await rowsOf(memberId)).toHaveLength(0);

    const actionId = newId();
    const refused = await claim({ actionId, evidenceType: 'Residence certificate' });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.actionId, actionId))).toHaveLength(0);
  });
});

describe('SCRUM-773 — Other takes an expiry date again', () => {
  it('records Other with its description and its expiry on a member', async () => {
    const memberId = await newMember('0637730003', 'Other Expiry');
    const res = await verify(memberId, {
      evidenceType: 'Other',
      note: 'Work permit',
      evidenceExpiresAt: NEXT_YEAR,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().member.tierVerification).toMatchObject({
      proofType: 'Other',
      note: 'Work permit',
      expiresAt: NEXT_YEAR,
    });
    const [row] = await rowsOf(memberId);
    expect(row!.evidenceExpiresAt?.toISOString().slice(0, 10)).toBe(NEXT_YEAR);
  });

  it('still records Other with no expiry: the date is optional', async () => {
    const memberId = await newMember('0637730004', 'Other No Expiry');
    const res = await verify(memberId, { evidenceType: 'Other', note: 'Work permit' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().member.tierVerification).toMatchObject({ proofType: 'Other', expiresAt: null });
  });

  it('refuses an Other document that has already expired, as every kind', async () => {
    const memberId = await newMember('0637730005', 'Other Expired');
    const res = await verify(memberId, {
      evidenceType: 'Other',
      note: 'Work permit',
      evidenceExpiresAt: '2020-01-01',
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.message).toMatch(/expired/i);
  });

  it('records Other with its expiry on a walk-in claim', async () => {
    const res = await claim({
      actionId: newId(),
      evidenceType: 'Other',
      note: 'Work permit',
      evidenceExpiresAt: NEXT_YEAR,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().claim).toMatchObject({
      evidenceType: 'Other',
      evidenceExpiresAt: NEXT_YEAR,
      note: 'Work permit',
    });
  });
});

describe('SCRUM-773 — a Residence certificate recorded before the change', () => {
  it('reads as it was filed on the member', async () => {
    const memberId = await newMember('0637730006', 'Earlier Check');
    await ctx.db.insert(memberTierVerification).values({
      id: newId(),
      memberId,
      fromTier: 'tourist',
      toTier: 'thai',
      evidenceType: 'Residence certificate',
      evidenceExpiresAt: null,
    });
    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0637730006',
      headers: { cookie },
    });
    expect(lookup.statusCode, lookup.body).toBe(200);
    expect(lookup.json().member.tierVerification).toMatchObject({
      tier: 'thai',
      proofType: 'Residence certificate',
    });
  });

  it('reads as it was filed on the sale it priced', async () => {
    const actionId = newId();
    const made = await claim({ actionId, evidenceType: 'Passport' });
    expect(made.statusCode, made.body).toBe(200);
    // The claim as one filed before 4 November reads.
    await ctx.db
      .update(saleTierClaim)
      .set({ evidenceType: 'Residence certificate' })
      .where(eq(saleTierClaim.actionId, actionId));

    const saleId = newId();
    const committed = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: {
        id: saleId,
        stationId,
        branchId,
        tierClaimActionId: actionId,
        lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
      },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const read = await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie } });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().sale.tierClaim).toMatchObject({ documentKind: 'Residence certificate' });
  });
});
