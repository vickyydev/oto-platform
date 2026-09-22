import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  branch,
  member,
  sale,
  saleLine,
  saleTierClaim,
  station,
  ticketPackage,
} from '@oto/db';
import { newId } from '@oto/shared';
import { resetDemoData } from '../src/services/demo-reset';
import { TIER_CLAIM_ENTITY, TIER_CLAIM_WINDOW_MS } from '../src/services/sale-tier';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-307 / SCRUM-311 — the tier claim, driven through the real routes with
 * a real reception session.
 *
 * WHAT IT IS PROVING. A visitor whose passport reception has just checked is
 * not a member yet, so there was nothing for the platform to read a tier from:
 * the quote came back tourist, the till showed expat, and the commit refused
 * the difference as `SALE_LINE_PRICE_MISMATCH` — no Expat or Thai sale could
 * complete at all. The fix must close that WITHOUT letting the tier come from
 * the request body, which is the rule the whole money path stands on, so every
 * case below is the same question from a different angle: whose word is the
 * tier taken on?
 *
 * SCRUM-311 adds the second question — how MANY sales one answer buys. The
 * claim is a row in `pos.sale_tier_claim` now rather than an audit entry, the
 * sale names it, and it is spent when it prices one.
 *
 * THE FIXTURE'S PRICES, from the seeded catalogue:
 *   2 Hours Play  tourist ฿890 flat · expat ฿623 weekday / ฿712 weekend
 *   adults        ฿350 weekday / ฿500 weekend on every tier
 * Both rate modes are computed below rather than assumed, because the suite
 * runs on whatever day it runs on.
 */

let ctx: TestContext;
let cookie: string;
let managerCookie: string;
let adminCookie: string;
let operatorId: string;
let branchId: string;
let chalongId: string;
let stationId: string;
let twoHoursId: string;
let receptionAccountId: string;
let maliId: string;

/** Satang from baht, so the fixtures read like the price list. */
const b = (baht: number): number => Math.round(baht * 100);

/** A document that is still valid, and one that is not. */
const VALID_UNTIL = '2099-12-31';
const EXPIRED_ON = '2000-01-01';

const line = (packageId: string, kids: number, adults: number) => ({
  id: newId(),
  packageId,
  kids,
  adults,
});

async function claim(
  payload: Record<string, unknown>,
  as: string = cookie,
): Promise<ReturnType<TestContext['app']['inject']>> {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales/tier-claims',
    headers: { cookie: as },
    payload: { branchId, evidenceType: 'Passport', evidenceExpiresAt: VALID_UNTIL, ...payload },
  });
}

async function quote(payload: Record<string, unknown>, as: string = cookie) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales/quote',
    headers: { cookie: as },
    payload,
  });
}

/** An expat claim made by reception at Central, ready to price a cart. */
async function expatClaim(): Promise<string> {
  const actionId = newId();
  const res = await claim({ actionId, toTier: 'expat' });
  expect(res.statusCode, res.body).toBe(200);
  return actionId;
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalongId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
  operatorId = central!.operatorId;

  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;

  const packages = await ctx.db
    .select()
    .from(ticketPackage)
    .where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;

  const [receptionAccount] = await ctx.db
    .select()
    .from(account)
    .where(and(eq(account.operatorId, operatorId), eq(account.phone, RECEPTION.phone)));
  receptionAccountId = receptionAccount!.id;

  const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
  maliId = members.find((m) => m.phone === '+66811111111')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** What 2 kids and 1 adult come to at a tier, in whichever mode today is. */
function expected(tier: 'tourist' | 'expat', weekend: boolean): number {
  const adult = weekend ? b(500) : b(350);
  if (tier === 'expat') return 2 * (weekend ? b(712) : b(623)) + adult;
  return 2 * b(890) + adult;
}

describe('a document check prices the cart it was taken for', () => {
  it("quotes an expat walk-in at the expat rate, and the sale lands at expat", async () => {
    const actionId = await expatClaim();
    const cartLine = line(twoHoursId, 2, 1);

    const quoted = await quote({ branchId, tierClaimActionId: actionId, lines: [cartLine] });
    expect(quoted.statusCode, quoted.body).toBe(200);
    const body = quoted.json();
    const weekend = body.pricingMode === 'weekend';
    expect(body.tier).toBe('expat');
    // Not `member` — there is no member — and not `default`, which is the
    // answer that made this sale impossible to complete.
    expect(body.tierSource).toBe('claim');
    expect(body.totals.grossSatang).toBe(expected('expat', weekend));

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
        lines: [{ ...cartLine, lineTotalSatang: body.lineTotals[cartLine.id] }],
        expectedTotalSatang: body.totals.grossSatang,
      },
    });
    expect(committed.statusCode, committed.body).toBe(200);

    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    // The tier the sale was PRICED at is on the row, which is what a report,
    // a refund and a receipt reprint all answer from.
    expect(row!.customerTier).toBe('expat');
    expect(row!.memberId).toBeNull();
    expect(row!.grossSatang).toBe(expected('expat', weekend));
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    expect(lines.every((l) => l.customerTier === 'expat')).toBe(true);

    /**
     * THE JOIN, which is what SCRUM-311 added and what the version of this
     * test before it said it could not assert: the sale names the document
     * check that priced it, and the claim names the sale it paid for. Both
     * halves, because either one alone is a pointer nothing corroborates.
     */
    const [claimRow] = await ctx.db
      .select()
      .from(saleTierClaim)
      .where(eq(saleTierClaim.actionId, actionId));
    expect(row!.tierClaimId).toBe(claimRow!.id);
    expect(claimRow!.spentBySaleId).toBe(saleId);
    expect(claimRow!.spentAt).not.toBeNull();
    // And what the claim was for is what the sale was charged at.
    expect(claimRow!.toTier).toBe(row!.customerTier);
    expect(claimRow!.branchId).toBe(row!.branchId);
    expect(claimRow!.accountId).toBe(receptionAccountId);
  });

  it('prices a cart at tourist when the body claims expat and nothing was checked', async () => {
    // The whole rule in one case: `tier` in the body is a price list anybody
    // could pick from, so it is ignored, and a cart with no claim and no
    // member is priced at the operator's default.
    const res = await quote({ branchId, tier: 'expat', lines: [line(twoHoursId, 2, 1)] });
    const body = res.json();
    expect(body.tier).toBe('tourist');
    expect(body.tierSource).toBe('default');
    expect(body.totals.grossSatang).toBe(expected('tourist', body.pricingMode === 'weekend'));
  });

  it('refuses the unclaimed cart the till priced at expat, as staging did', async () => {
    // The symptom this ticket started from, kept as a case: without a claim
    // the platform still prices tourist and still refuses to charge a figure
    // it did not stand behind.
    const cartLine = line(twoHoursId, 2, 1);
    const res = await quote({
      branchId,
      tier: 'expat',
      lines: [{ ...cartLine, lineTotalSatang: expected('expat', false) }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SALE_LINE_PRICE_MISMATCH');
  });

  it('lets a member with a verified tier decide, not the claim', async () => {
    // Mali is thai. A claim naming expat does not move her off her own record:
    // a verification filed against a person is the stronger fact.
    const actionId = await expatClaim();
    const res = await quote({
      branchId,
      memberId: maliId,
      tierClaimActionId: actionId,
      lines: [line(twoHoursId, 2, 1)],
    });
    const body = res.json();
    expect(body.tier).toBe('thai');
    expect(body.tierSource).toBe('member');
  });
});

describe('a claim prices nothing but the cart it belongs to', () => {
  it('is not honoured for another session', async () => {
    const actionId = await expatClaim();
    // The branch manager holds the same permissions at the same branch — and
    // still cannot price from a claim reception made.
    const res = await quote(
      { branchId, tierClaimActionId: actionId, lines: [line(twoHoursId, 2, 1)] },
      managerCookie,
    );
    const body = res.json();
    expect(body.tier).toBe('tourist');
    expect(body.tierSource).toBe('default');
  });

  it('is not honoured for another action', async () => {
    await expatClaim();
    const res = await quote({
      branchId,
      tierClaimActionId: newId(),
      lines: [line(twoHoursId, 2, 1)],
    });
    expect(res.json().tier).toBe('tourist');
  });

  it('is not honoured at another branch', async () => {
    // The administrator holds both branches, so the branch is the only thing
    // separating these two requests.
    const actionId = newId();
    const made = await claim({ actionId, toTier: 'expat', branchId: chalongId }, adminCookie);
    expect(made.statusCode, made.body).toBe(200);

    const res = await quote(
      { branchId, tierClaimActionId: actionId, lines: [line(twoHoursId, 2, 1)] },
      adminCookie,
    );
    expect(res.json().tier).toBe('tourist');
  });

  it('stops pricing once its window has passed', async () => {
    const actionId = await expatClaim();
    const stale = new Date(Date.now() - TIER_CLAIM_WINDOW_MS - 60_000);
    await ctx.db
      .update(saleTierClaim)
      .set({ createdAt: stale })
      .where(eq(saleTierClaim.actionId, actionId));

    const res = await quote({
      branchId,
      tierClaimActionId: actionId,
      lines: [line(twoHoursId, 2, 1)],
    });
    expect(res.json().tier).toBe('tourist');
  });
});

describe('one document check prices one sale (SCRUM-311)', () => {
  /** Ring the cart up at whatever the platform says it costs. */
  async function commit(payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: { id: newId(), stationId, branchId, ...payload },
    });
  }

  it('refuses a second cart that names a claim already spent, and says which sale spent it', async () => {
    const actionId = await expatClaim();
    const first = await commit({ tierClaimActionId: actionId, lines: [line(twoHoursId, 2, 1)] });
    expect(first.statusCode, first.body).toBe(200);
    const firstSaleId = first.json().sale.id;

    // The till is still holding the action id of the last document it checked,
    // and the person in front of it is the next visitor. Before this ticket
    // the claim was still inside its window, so this second cart was priced at
    // the expat rate on a passport that was never theirs.
    const second = await commit({ tierClaimActionId: actionId, lines: [line(twoHoursId, 2, 1)] });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe('TIER_CLAIM_SPENT');
    // Which sale spent it, so reception can see what they are looking at.
    expect(second.json().error.details.saleId).toBe(firstSaleId);

    // Nothing was written for the refused cart.
    const sales = await ctx.db
      .select()
      .from(sale)
      .where(eq(sale.tierClaimId, second.json().error.details.claimId));
    expect(sales).toHaveLength(1);
    expect(sales[0]!.id).toBe(firstSaleId);
  });

  it('still answers a retry of that same Pay as the replay it is', async () => {
    const actionId = await expatClaim();
    // The action id of the PAY tap, which is not the document check's: one tap
    // on Pay, however many HTTP attempts it took to land.
    const payTap = newId();
    const first = await commit({
      actionId: payTap,
      tierClaimActionId: actionId,
      lines: [line(twoHoursId, 2, 1)],
    });
    expect(first.statusCode, first.body).toBe(200);

    // A retry that minted a new sale id but kept the tap's id is the SAME
    // sale. Telling reception to check the document again would be a lie —
    // the sale recorded — so the claim's refusal must not get in front of
    // this one.
    const retry = await commit({
      actionId: payTap,
      tierClaimActionId: actionId,
      lines: [line(twoHoursId, 2, 1)],
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe('SALE_ACTION_REPLAY');
    expect(retry.json().error.details.saleId).toBe(first.json().sale.id);
  });

  it('prices the second cart at the default tier and tells the till why', async () => {
    const actionId = await expatClaim();
    const first = await commit({ tierClaimActionId: actionId, lines: [line(twoHoursId, 2, 1)] });
    expect(first.statusCode, first.body).toBe(200);

    // A QUOTE is not refused — nothing is being taken — but it prices what it
    // can stand behind, and carries the reason rather than leaving staff to
    // work out why a passport they watched being checked stopped counting.
    const res = await quote({ branchId, tierClaimActionId: actionId, lines: [line(twoHoursId, 2, 1)] });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.tier).toBe('tourist');
    expect(body.tierSource).toBe('default');
    expect(body.tierClaimRefusal.code).toBe('TIER_CLAIM_SPENT');
    expect(body.totals.grossSatang).toBe(expected('tourist', body.pricingMode === 'weekend'));
  });

  it('refuses the spent claim’s cart at the first sale’s money as a price mismatch, as today', async () => {
    const actionId = await expatClaim();
    const cartLine = line(twoHoursId, 2, 1);
    const quoted = await quote({ branchId, tierClaimActionId: actionId, lines: [cartLine] });
    const expatLineTotal = quoted.json().lineTotals[cartLine.id];
    const first = await commit({
      tierClaimActionId: actionId,
      lines: [{ ...cartLine, lineTotalSatang: expatLineTotal }],
    });
    expect(first.statusCode, first.body).toBe(200);

    // A till that never re-priced still holds the expat figures. It is told
    // about the money, which is the more specific answer and the one it
    // already knows how to recover from — re-price and show the guest.
    const again = await commit({
      tierClaimActionId: actionId,
      lines: [{ ...line(twoHoursId, 2, 1), lineTotalSatang: expatLineTotal }],
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('SALE_LINE_PRICE_MISMATCH');
  });

  it('leaves an unspent claim unspent, so one refusal does not burn the next visitor’s check', async () => {
    const actionId = await expatClaim();
    const [before] = await ctx.db
      .select()
      .from(saleTierClaim)
      .where(eq(saleTierClaim.actionId, actionId));
    expect(before!.spentBySaleId).toBeNull();

    // A cart the platform refuses for its own reasons — here the till and the
    // platform disagreeing about the total — must not consume the document
    // check that was made for it. The spend is inside the sale's transaction,
    // so a sale that is not written leaves the claim exactly as it was.
    const refused = await commit({
      tierClaimActionId: actionId,
      lines: [line(twoHoursId, 2, 1)],
      expectedTotalSatang: 1,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('SALE_TOTAL_MISMATCH');

    const [after] = await ctx.db
      .select()
      .from(saleTierClaim)
      .where(eq(saleTierClaim.actionId, actionId));
    expect(after!.spentBySaleId).toBeNull();
    expect(after!.spentAt).toBeNull();
  });
});

describe('what may be claimed, and by whom', () => {
  it('refuses a document that has already expired', async () => {
    const res = await claim({
      actionId: newId(),
      toTier: 'expat',
      evidenceExpiresAt: EXPIRED_ON,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/expired/i);
  });

  it('refuses a tier this operator does not sell', async () => {
    const res = await claim({ actionId: newId(), toTier: 'diplomat' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/unknown tier/i);
  });

  it('refuses a claim at a branch the caller does not hold', async () => {
    const res = await claim({ actionId: newId(), toTier: 'expat', branchId: chalongId });
    expect(res.statusCode).toBe(403);
  });

  it('answers the same tap twice with one claim, and refuses a second decision under it', async () => {
    const actionId = newId();
    const first = await claim({ actionId, toTier: 'expat' });
    const again = await claim({ actionId, toTier: 'expat' });
    expect(again.statusCode).toBe(200);
    expect(again.json().claim.id).toBe(first.json().claim.id);

    // One claim ROW, and one audit row beside it: the table is the record and
    // the log is the trail, so a second tap must not double either.
    const rows = await ctx.db
      .select()
      .from(saleTierClaim)
      .where(eq(saleTierClaim.actionId, actionId));
    expect(rows).toHaveLength(1);
    const trail = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, TIER_CLAIM_ENTITY), eq(auditLog.actionId, actionId)));
    expect(trail).toHaveLength(1);

    const different = await claim({ actionId, toTier: 'thai' });
    expect(different.statusCode).toBe(409);
    expect(different.json().error.code).toBe('TIER_CLAIM_ACTION_REUSED');
  });
});

describe('the record the claim leaves', () => {
  it('names the verifier and the branch from the session, and carries no document number', async () => {
    const actionId = newId();
    const res = await claim({ actionId, toTier: 'expat' });
    expect(res.statusCode).toBe(200);

    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, TIER_CLAIM_ENTITY), eq(auditLog.actionId, actionId)));
    expect(row!.action).toBe('sale_tier_claim.create');
    // WHO checked it is the session's account, and WHERE is the session's
    // branch. Neither was in the request body, and neither can be.
    expect(row!.actorAccountId).toBe(receptionAccountId);
    expect(row!.branchId).toBe(branchId);
    expect(row!.operatorId).toBe(operatorId);
    // The kind of document and its expiry, and nothing that identifies it.
    expect(Object.keys(row!.after as object).sort()).toEqual([
      'evidenceExpiresAt',
      'evidenceType',
      'expiresAt',
      'toTier',
    ]);
    expect(JSON.stringify(row!.after)).not.toMatch(/\d{6,}/);
  });

  it('gives a document number nowhere to be sent', async () => {
    // The body is strict, so the claim row cannot come to hold an identity
    // document's number in a table that is never swept.
    const res = await claim({
      actionId: newId(),
      toTier: 'expat',
      documentNumber: 'AA1234567',
    });
    expect(res.statusCode).toBe(400);

    // Nor through the one free-looking field: the kind of document is one of
    // the four names the till offers, so "Passport AA1234567" is refused and
    // nothing of it is written. Found by the gate — the comment above claimed
    // this while `evidenceType` was still free text.
    const smuggled = await claim({
      actionId: newId(),
      toTier: 'expat',
      evidenceType: 'Passport AA1234567',
    });
    expect(smuggled.statusCode).toBe(400);
    const [row] = await ctx.db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(eq(auditLog.entityType, TIER_CLAIM_ENTITY))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(JSON.stringify(row?.after ?? {})).not.toMatch(/AA1234567/);
  });

  it('refuses a caller with no permission to check a document', async () => {
    const anon = await ctx.app.inject({
      method: 'POST',
      url: '/sales/tier-claims',
      payload: { actionId: newId(), branchId, toTier: 'expat', evidenceExpiresAt: VALID_UNTIL, evidenceType: 'Passport' },
    });
    expect(anon.statusCode).toBe(401);
  });
});

/**
 * Last in the file, because it wipes the day: everything above has already
 * asserted what it came for.
 */
describe('the day can still be cleared afterwards', () => {
  it('lets the demo reset take a sale and the document check that priced it', async () => {
    const actionId = await expatClaim();
    const done = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: { id: newId(), stationId, branchId, tierClaimActionId: actionId, lines: [line(twoHoursId, 2, 1)] },
    });
    expect(done.statusCode, done.body).toBe(200);

    /**
     * A sale and its claim point at each other, and BOTH keys restrict. A
     * cycle of restricting keys cannot be deleted from either end, so the
     * reset has to cut one edge first — and if it ever stops doing that, a
     * staging deployment that has taken one discounted sale can never be
     * cleared again. That is not a failure anybody would attribute to this
     * ticket a month later, so it is asserted here where it was introduced.
     */
    await resetDemoData(ctx.db);
    expect(await ctx.db.select().from(sale)).toHaveLength(0);
    expect(await ctx.db.select().from(saleTierClaim)).toHaveLength(0);
  });
});
