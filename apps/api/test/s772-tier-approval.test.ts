import { and, eq } from 'drizzle-orm';
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
import { TIER_APPROVAL_EVIDENCE, TIER_APPROVAL_PROBLEMS, newId } from '@oto/shared';
import { CLAIM_APPROVE_BY_HAND_ACTION, TIER_CLAIM_ENTITY } from '../src/services/sale-tier';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-772 — the Thai rate approved by hand, through the real routes with a
 * real reception session.
 *
 * The document check stays the normal path. For the special cases it does not
 * fit, the staff member on the till approves the Thai rate alone — no manager,
 * no PIN — with a reason from a short list and an optional note. What makes it
 * answerable is the record: the approver from the session, the reason, the
 * note, the time, the sale it priced, its own audit action, and the Console's
 * count per staff member. It applies to that sale only: the member is never
 * marked as a verified tier, so the next visit asks again.
 */

let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let chalongManagerCookie: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;
let receptionAccountId: string;
let memberId: string;

const PHONE = '0637720772';

function approve(payload: Record<string, unknown>, as: string = cookie, key?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales/tier-approvals',
    headers: { cookie: as, ...(key ? { 'idempotency-key': key } : {}) },
    payload: { branchId, toTier: 'thai', ...payload },
  });
}

const line = (kids: number, adults: number) => ({ id: newId(), packageId: twoHoursId, kids, adults });

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  chalongManagerCookie = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  const [reception] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  receptionAccountId = reception!.id;

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/members',
    headers: { cookie },
    payload: { phone: PHONE, nickname: 'ZZ TEST Hand Approval' },
  });
  expect(created.statusCode, created.body).toBeLessThan(300);
  memberId = created.json().member.id as string;
  expect(created.json().member.tierCode).toBe('tourist');
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-772 — approving the Thai rate by hand', () => {
  it('records the approver from the session, the reason and the note, with its own audit action', async () => {
    const actionId = newId();
    const res = await approve({
      actionId,
      reason: 'thai_child_foreign_parent',
      note: '  Mother is Thai, father British ',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().claim).toMatchObject({
      actionId,
      branchId,
      toTier: 'thai',
      evidenceType: TIER_APPROVAL_EVIDENCE,
      evidenceExpiresAt: null,
      note: null,
      approval: { reason: 'thai_child_foreign_parent', reasonText: null, note: 'Mother is Thai, father British' },
      verifiedByAccountId: receptionAccountId,
      spentBySaleId: null,
    });

    const [row] = await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.actionId, actionId));
    expect(row).toMatchObject({
      accountId: receptionAccountId,
      evidenceType: TIER_APPROVAL_EVIDENCE,
      approvalReason: 'thai_child_foreign_parent',
      approvalReasonText: null,
      approvalNote: 'Mother is Thai, father British',
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
    expect(logged!.after).toMatchObject({
      toTier: 'thai',
      approvalReason: 'thai_child_foreign_parent',
      approvalNote: 'Mother is Thai, father British',
    });
  });

  it('records Other with the reason staff typed', async () => {
    const res = await approve({ actionId: newId(), reason: 'other', reasonText: ' Thai grandparent present ' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().claim.approval).toEqual({
      reason: 'other',
      reasonText: 'Thai grandparent present',
      note: null,
    });
  });

  it('answers the same press with the same claim, and refuses a different decision under it', async () => {
    const actionId = newId();
    const first = await approve({ actionId, reason: 'thai_id_seen_not_to_hand' });
    expect(first.statusCode, first.body).toBe(200);
    const again = await approve({ actionId, reason: 'thai_id_seen_not_to_hand' });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().claim.id).toBe(first.json().claim.id);
    const changed = await approve({ actionId, reason: 'thai_child_foreign_parent' });
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().error.code).toBe('TIER_CLAIM_ACTION_REUSED');
    const rows = await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.actionId, actionId));
    expect(rows).toHaveLength(1);
  });

  it('replays an Idempotency-Key with the stored answer, and refuses the key on a different body', async () => {
    const key = newId();
    const actionId = newId();
    const body = { actionId, reason: 'thai_id_seen_not_to_hand' };
    const first = await approve(body, cookie, key);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await approve(body, cookie, key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.body).toBe(first.body);
    const other = await approve({ ...body, note: 'Different press' }, cookie, key);
    expect(other.statusCode, other.body).toBe(409);
    const rows = await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.actionId, actionId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a rate other than Thai, a one-word Other, and a document number', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ toTier: 'expat', reason: 'thai_child_foreign_parent' }, TIER_APPROVAL_PROBLEMS.tier],
      [{ reason: 'other', reasonText: 'Grandma' }, TIER_APPROVAL_PROBLEMS.reasonMissing],
      [{ reason: 'other' }, TIER_APPROVAL_PROBLEMS.reasonMissing],
      [{ reason: 'thai_child_foreign_parent', reasonText: 'Father Thai' }, TIER_APPROVAL_PROBLEMS.reasonNotOther],
      [{ reason: 'other', reasonText: 'Thai ID 1101700203451' }, TIER_APPROVAL_PROBLEMS.number],
      [{ reason: 'thai_id_seen_not_to_hand', note: 'card 1101700203451' }, TIER_APPROVAL_PROBLEMS.number],
    ];
    for (const [payload, message] of cases) {
      const actionId = newId();
      const res = await approve({ actionId, ...payload });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'TIER_APPROVAL', message });
      const rows = await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.actionId, actionId));
      expect(rows).toHaveLength(0);
    }
  });

  it('takes no reason off the list, and no field saying who approved it', async () => {
    for (const payload of [
      { reason: 'looks_thai' },
      { reason: 'thai_child_foreign_parent', verifiedByAccountId: newId() },
      { reason: 'thai_child_foreign_parent', evidenceType: 'Passport' },
    ]) {
      const res = await approve({ actionId: newId(), ...payload });
      expect(res.statusCode, res.body).toBe(400);
    }
  });

  it('refuses a session that holds no member permission at the branch', async () => {
    // Chalong's manager holds pos:member:update at Chalong only.
    const res = await approve({ actionId: newId(), reason: 'thai_child_foreign_parent' }, chalongManagerCookie);
    expect(res.statusCode, res.body).toBe(403);
  });

  it('refuses with no session', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales/tier-approvals',
      payload: { actionId: newId(), branchId, toTier: 'thai', reason: 'other', reasonText: 'Two words' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('SCRUM-772 — the approval prices this sale only', () => {
  it("prices a tourist member's cart at Thai, records the sale, and leaves the member unverified", async () => {
    const actionId = newId();
    const made = await approve({ actionId, reason: 'thai_child_foreign_parent' });
    expect(made.statusCode, made.body).toBe(200);

    const cartLine = line(2, 1);
    const quoted = await ctx.app.inject({
      method: 'POST',
      url: '/sales/quote',
      headers: { cookie },
      payload: { branchId, memberId, tierClaimActionId: actionId, lines: [cartLine] },
    });
    expect(quoted.statusCode, quoted.body).toBe(200);
    expect(quoted.json().tier).toBe('thai');
    expect(quoted.json().tierSource).toBe('claim');

    const saleId = newId();
    const committed = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: {
        id: saleId,
        stationId,
        branchId,
        memberId,
        tierClaimActionId: actionId,
        lines: [{ ...cartLine, lineTotalSatang: quoted.json().lineTotals[cartLine.id] }],
        expectedTotalSatang: quoted.json().totals.grossSatang,
      },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const [saleRow] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(saleRow).toMatchObject({ customerTier: 'thai', memberId });
    const [claimRow] = await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.actionId, actionId));
    expect(saleRow!.tierClaimId).toBe(claimRow!.id);
    expect(claimRow!.spentBySaleId).toBe(saleId);

    // The sale's document check reads who approved it and why.
    const read = await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie } });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().sale.tierClaim).toMatchObject({
      documentKind: TIER_APPROVAL_EVIDENCE,
      toTier: 'thai',
      approval: {
        reason: 'thai_child_foreign_parent',
        reasonLabel: 'Thai child with a foreign parent',
        note: null,
        approvedByAccountId: receptionAccountId,
      },
    });
    expect(read.json().sale.tierClaim.approval.approvedBy).toEqual(expect.any(String));

    // The member is not marked: still tourist, no verification, so the next visit asks again.
    const [after] = await ctx.db.select().from(member).where(eq(member.id, memberId));
    expect(after!.tierCode).toBe('tourist');
    const verifications = await ctx.db
      .select()
      .from(memberTierVerification)
      .where(eq(memberTierVerification.memberId, memberId));
    expect(verifications).toHaveLength(0);
    const lookup = await ctx.app.inject({
      method: 'GET',
      url: `/members/lookup?phone=${PHONE}`,
      headers: { cookie },
    });
    expect(lookup.json().member.tierCode).toBe('tourist');
    expect(lookup.json().member.tierVerification ?? null).toBeNull();

    // The next sale for the same member, with no new approval, is the tourist rate again.
    const next = await ctx.app.inject({
      method: 'POST',
      url: '/sales/quote',
      headers: { cookie },
      payload: { branchId, memberId, lines: [line(2, 1)] },
    });
    expect(next.json().tier).toBe('tourist');
    expect(next.json().tierSource).toBe('member');
  });

  it('is spent by one sale, as a document check is', async () => {
    const actionId = newId();
    expect((await approve({ actionId, reason: 'thai_id_seen_not_to_hand' })).statusCode).toBe(200);
    const commit = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/sales',
        headers: { cookie },
        payload: { id: newId(), stationId, branchId, tierClaimActionId: actionId, lines: [line(1, 1)] },
      });
    expect((await commit()).statusCode).toBe(200);
    const second = await commit();
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe('TIER_CLAIM_SPENT');
  });
});

describe('SCRUM-772 — the Console count per staff member', () => {
  it('counts each account’s hand approvals, recent and in total', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/sales/tier-approvals/by-staff',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.days).toBe(30);
    const mine = body.staff.find((row: { accountId: string }) => row.accountId === receptionAccountId);
    const rows = await ctx.db
      .select()
      .from(saleTierClaim)
      .where(eq(saleTierClaim.accountId, receptionAccountId));
    const approvals = rows.filter((row) => row.approvalReason !== null).length;
    expect(approvals).toBeGreaterThan(0);
    expect(mine).toMatchObject({ recent: approvals, total: approvals, name: expect.any(String) });
    // Document checks are not counted.
    expect(rows.length).toBeGreaterThanOrEqual(approvals);
  });

  it('is a manager’s read, closed to the counter as the verification records are', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/sales/tier-approvals/by-staff',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
