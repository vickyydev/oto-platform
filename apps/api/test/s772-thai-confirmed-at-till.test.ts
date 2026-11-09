import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  member,
  memberTierVerification,
  sale,
  saleTierClaim,
  station,
  ticketPackage,
} from '@oto/db';
import {
  TIER_APPROVAL_EVIDENCE,
  TIER_APPROVAL_PROBLEMS,
  TIER_APPROVAL_TILL_REASON,
  newId,
} from '@oto/shared';
import { CLAIM_APPROVE_BY_HAND_ACTION, TIER_CLAIM_ENTITY } from '../src/services/sale-tier';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-772 — THE THAI RATE CONFIRMED AT THE TILL, WITH NO DOCUMENT.
 *
 * The owner's rule of 6 November 2026: "For the Thai rate, we don't need to
 * show document options or expiry date. Just a verification modal with 2
 * buttons and record staff logs." Driven here as the till drives it, through
 * the real routes with a real reception session signed in at a till:
 *
 *   1. Confirm records the sale's tier claim with the one reason
 *      `confirmed_at_till` and the evidence "Approved by hand" — the
 *      approver, the branch and the station from the session, its own action
 *      in the log, no document and no expiry.
 *   2. The rate is saved to the member as a verification whose evidence is
 *      "Approved by hand" — for a member at once, for a walk-in once they give
 *      their details (SCRUM-779) — so the next visit does not ask again.
 *   3. The Expat rate keeps its document: "Approved by hand" is refused for
 *      it, on the claim and on the member.
 *   4. The Console's Tier verifications list carries who, where and when.
 */

let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let branchId: string;
let stationId: string;
let stationName: string;
let twoHoursId: string;
let receptionAccountId: string;

const post = (url: string, payload: Record<string, unknown>, as: string = cookie) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie: as, 'idempotency-key': newId() }, payload });

const confirmThai = (actionId: string = newId()) =>
  post('/sales/tier-approvals', { actionId, branchId, toTier: 'thai', reason: TIER_APPROVAL_TILL_REASON });

async function newMember(phone: string, nickname: string): Promise<string> {
  const created = await post('/members', { phone, nickname });
  expect(created.statusCode, created.body).toBeLessThan(300);
  return (created.json() as { member: { id: string } }).member.id;
}

const saveToMember = (memberId: string, over: Record<string, unknown> = {}) =>
  post(`/members/${memberId}/tier-verification`, {
    toTier: 'thai',
    evidenceType: TIER_APPROVAL_EVIDENCE,
    ...over,
  });

async function verificationsOf(memberId: string) {
  return ctx.db
    .select()
    .from(memberTierVerification)
    .where(eq(memberTierVerification.memberId, memberId))
    .orderBy(desc(memberTierVerification.createdAt));
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  const till = stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!;
  stationId = till.id;
  stationName = till.name;
  // The reception session is signed in at that till, as the counter's is.
  await takeStation(ctx.app, cookie, stationId);
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  const [reception] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  receptionAccountId = reception!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-772 — Confirm Thai rate records the claim, with no document', () => {
  it('stamps the approver, the station and the time from the session, under its own action', async () => {
    const actionId = newId();
    const before = Date.now();
    const res = await confirmThai(actionId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().claim).toMatchObject({
      actionId,
      branchId,
      toTier: 'thai',
      evidenceType: TIER_APPROVAL_EVIDENCE,
      evidenceExpiresAt: null,
      note: null,
      approval: { reason: TIER_APPROVAL_TILL_REASON, reasonText: null, note: null },
      verifiedByAccountId: receptionAccountId,
      stationId,
      spentBySaleId: null,
    });
    expect(new Date(res.json().claim.createdAt).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const [row] = await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.actionId, actionId));
    expect(row).toMatchObject({
      accountId: receptionAccountId,
      stationId,
      branchId,
      evidenceType: TIER_APPROVAL_EVIDENCE,
      evidenceExpiresAt: null,
      approvalReason: TIER_APPROVAL_TILL_REASON,
    });
    const [logged] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, TIER_CLAIM_ENTITY), eq(auditLog.entityId, row!.id)));
    expect(logged).toMatchObject({
      action: CLAIM_APPROVE_BY_HAND_ACTION,
      actorAccountId: receptionAccountId,
      branchId,
    });
    expect(logged!.after).toMatchObject({ toTier: 'thai', approvalReason: TIER_APPROVAL_TILL_REASON });
  });

  it('still refuses the Expat rate: it keeps its document check', async () => {
    const actionId = newId();
    const res = await post('/sales/tier-approvals', {
      actionId,
      branchId,
      toTier: 'expat',
      reason: TIER_APPROVAL_TILL_REASON,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'TIER_APPROVAL', message: TIER_APPROVAL_PROBLEMS.tier });
    expect(await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.actionId, actionId))).toHaveLength(0);
  });

  it('reads on the sale as "Thai rate confirmed at the till", and the sale names the claim', async () => {
    const actionId = newId();
    expect((await confirmThai(actionId)).statusCode).toBe(200);
    const cartLine = { id: newId(), packageId: twoHoursId, kids: 1, adults: 1 };
    const quoted = await post('/sales/quote', { branchId, tierClaimActionId: actionId, lines: [cartLine] });
    expect(quoted.statusCode, quoted.body).toBe(200);
    expect(quoted.json()).toMatchObject({ tier: 'thai', tierSource: 'claim' });
    const saleId = newId();
    const committed = await post('/sales', {
      id: saleId,
      stationId,
      branchId,
      tierClaimActionId: actionId,
      lines: [{ ...cartLine, lineTotalSatang: quoted.json().lineTotals[cartLine.id] }],
      expectedTotalSatang: quoted.json().totals.grossSatang,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const read = await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie } });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().sale.tierClaim).toMatchObject({
      documentKind: TIER_APPROVAL_EVIDENCE,
      evidenceExpiresOn: null,
      toTier: 'thai',
      approval: {
        reason: TIER_APPROVAL_TILL_REASON,
        reasonLabel: 'Confirmed at the till',
        approvedByAccountId: receptionAccountId,
      },
    });
  });
});

describe('SCRUM-772 — the rate is saved to the member, with no document', () => {
  it('records the verification with the approver, the station and no expiry, and the next visit skips the step', async () => {
    const memberId = await newMember('0637720781', 'ZZ TEST Thai Confirmed');
    const res = await saveToMember(memberId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().member).toMatchObject({
      tierCode: 'thai',
      tierVerification: {
        tier: 'thai',
        proofType: TIER_APPROVAL_EVIDENCE,
        note: null,
        expiresAt: null,
        reverifyDue: false,
      },
    });
    expect(res.json().member.tierVerification.verifiedBy).toEqual(expect.any(String));

    const [row] = await verificationsOf(memberId);
    expect(row).toMatchObject({
      fromTier: 'tourist',
      toTier: 'thai',
      evidenceType: TIER_APPROVAL_EVIDENCE,
      evidenceExpiresAt: null,
      note: null,
      verifiedByAccountId: receptionAccountId,
      branchId,
      stationId,
    });
    const [logged] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'member.tier_verify'), eq(auditLog.entityId, row!.id)));
    expect(logged).toMatchObject({ actorAccountId: receptionAccountId, branchId });
    expect(logged!.after).toMatchObject({
      memberId,
      toTier: 'thai',
      evidenceType: TIER_APPROVAL_EVIDENCE,
      evidenceExpiresAt: null,
      stationId,
    });

    // The next visit: the member holds the Thai rate, so the cart is priced
    // from the member and the till skips the step.
    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0637720781',
      headers: { cookie },
    });
    expect(lookup.json().member).toMatchObject({
      tierCode: 'thai',
      tierVerification: { tier: 'thai', proofType: TIER_APPROVAL_EVIDENCE },
    });
    const quoted = await post('/sales/quote', {
      branchId,
      memberId,
      lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
    });
    expect(quoted.json()).toMatchObject({ tier: 'thai', tierSource: 'member' });
  });

  it('takes no expiry and no note on a till confirmation', async () => {
    const memberId = await newMember('0637720782', 'ZZ TEST Thai Nothing To Fill');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ evidenceExpiresAt: '2030-01-01' }, TIER_APPROVAL_PROBLEMS.expiry],
      [{ note: 'Mother is Thai' }, TIER_APPROVAL_PROBLEMS.confirmationNote],
    ];
    for (const [over, message] of cases) {
      const res = await saveToMember(memberId, over);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'TIER_APPROVAL', message });
    }
    expect(await verificationsOf(memberId)).toHaveLength(0);
    const [after] = await ctx.db.select().from(member).where(eq(member.id, memberId));
    expect(after!.tierCode).toBe('tourist');
  });

  it('keeps the Expat document check: no till confirmation, and no rate without a document', async () => {
    const memberId = await newMember('0637720783', 'ZZ TEST Expat Still Checked');
    const byHand = await saveToMember(memberId, { toTier: 'expat' });
    expect(byHand.statusCode, byHand.body).toBe(400);
    expect(byHand.json().error).toMatchObject({ code: 'TIER_APPROVAL', message: TIER_APPROVAL_PROBLEMS.tier });
    const noDocument = await post(`/members/${memberId}/tier-verification`, { toTier: 'expat' });
    expect(noDocument.statusCode, noDocument.body).toBe(400);
    expect(await verificationsOf(memberId)).toHaveLength(0);

    // The document check is as it was: a kind, and an expiry when it has one.
    const checked = await post(`/members/${memberId}/tier-verification`, {
      toTier: 'expat',
      evidenceType: 'Passport',
      evidenceExpiresAt: '2030-01-01',
    });
    expect(checked.statusCode, checked.body).toBe(200);
    const [row] = await verificationsOf(memberId);
    expect(row).toMatchObject({ toTier: 'expat', evidenceType: 'Passport', stationId });
    expect(row!.evidenceExpiresAt?.toISOString().slice(0, 10)).toBe('2030-01-01');
  });
});

describe('SCRUM-772 with SCRUM-779 — a Thai walk-in confirmed at the till becomes a member after Pay', () => {
  it('keeps one sale under the member, priced by the till confirmation, with the rate saved on the member', async () => {
    const actionId = newId();
    expect((await confirmThai(actionId)).statusCode).toBe(200);
    const cartLine = { id: newId(), packageId: twoHoursId, kids: 1, adults: 1 };
    const quoted = await post('/sales/quote', { branchId, tierClaimActionId: actionId, lines: [cartLine] });
    expect(quoted.statusCode, quoted.body).toBe(200);
    const gross = quoted.json().totals.grossSatang as number;
    const saleId = newId();
    const rungUp = await post('/sales', {
      id: saleId,
      stationId,
      branchId,
      tierClaimActionId: actionId,
      customerPhone: '+66637720784',
      lines: [{ ...cartLine, lineTotalSatang: quoted.json().lineTotals[cartLine.id] }],
      expectedTotalSatang: gross,
    });
    expect(rungUp.statusCode, rungUp.body).toBe(200);
    const [rung] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(rung).toMatchObject({ memberId: null, customerTier: 'thai' });

    // The till's deferred save: the member from the display's details, then
    // the rate on them with the till confirmation's evidence.
    const memberId = await newMember('+66637720784', 'ZZ TEST Thai Walk-in');
    const saved = await saveToMember(memberId);
    expect(saved.statusCode, saved.body).toBe(200);
    const attached = await post(`/sales/${saleId}/member`, { memberId });
    expect(attached.statusCode, attached.body).toBe(200);
    expect(attached.json()).toMatchObject({ saleId, memberId, customerTier: 'thai', tierClaimId: rung!.tierClaimId });

    const paid = await post(`/sales/${saleId}/finalise`, {
      method: 'cash',
      kind: 'cash',
      amountSatang: gross,
      tenderedSatang: gross,
    });
    expect(paid.statusCode, paid.body).toBe(200);
    const [closed] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(closed).toMatchObject({ status: 'finalised', memberId, customerTier: 'thai', tierClaimId: rung!.tierClaimId });
    const [claim] = await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.id, rung!.tierClaimId!));
    expect(claim).toMatchObject({ spentBySaleId: saleId, evidenceType: TIER_APPROVAL_EVIDENCE, stationId });
    const [m] = await ctx.db.select().from(member).where(eq(member.id, memberId));
    expect(m!.tierCode).toBe('thai');
    const [verification] = await verificationsOf(memberId);
    expect(verification).toMatchObject({ evidenceType: TIER_APPROVAL_EVIDENCE, evidenceExpiresAt: null, stationId });
  });
});

describe('SCRUM-772 — the Console lists who confirmed it, where and when', () => {
  it('carries the station beside the staff member and the branch', async () => {
    const memberId = await newMember('0637720785', 'ZZ TEST Thai Console Row');
    expect((await saveToMember(memberId)).statusCode).toBe(200);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members/tier-verifications',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const record = (res.json().verifications as Array<{ member: { id: string } }>).find(
      (r) => r.member.id === memberId,
    );
    expect(record).toMatchObject({
      fromTier: 'tourist',
      toTier: 'thai',
      evidenceType: TIER_APPROVAL_EVIDENCE,
      evidenceExpiresAt: null,
      expired: false,
      verifiedBy: expect.any(String),
      branch: expect.any(String),
      station: stationName,
      note: null,
      verifiedAt: expect.any(String),
    });
  });
});
