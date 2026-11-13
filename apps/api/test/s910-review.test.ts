import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { box, branch, partySettlement, paymentAttempt, refund, sale, station } from '@oto/db';
import {
  PARTY_DEPOSIT_TENDER,
  newId,
  type PartyDetailAnswer,
  type PartySettleAnswer,
  type PartySettlePreviewAnswer,
} from '@oto/shared';
import type {
  DirectoryEventEditAnswer,
  DirectoryEventEditBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import { saleFactsOf } from '../src/services/analytics-rollup';
import { analyticsSaleRevenueV1 } from '@oto/shared';
import { refundSale } from '../src/services/refunds';
import { salePrintSnapshotOf } from '../src/services/sale-printing';
import { saleReceiptDocument } from '@oto/shared';
import { withTx } from '../src/services/tx';
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
 * SCRUM-910: HTTP/ledger adversarial controls for retained party deposits.
 * The seam fixture follows the published party contract; every mutation uses
 * real sale, payment, manager-refund and replacement-settlement transactions.
 */

let ctx: TestContext;
let central: string;
let operatorId: string;
let till: string;
let reception: string;
let admin: string;

const appTenant = newId();
const appCentral = newId();
const GATEWAY_SECRET = randomBytes(32).toString('hex');

/** A Wednesday, a Saturday, and a Tuesday inside the seeded Loy Krathong range (24–25 November). */
const WEEKDAY = '2026-11-18';

const FLORESTA = {
  template_id: '391b269d-159a-4039-89a2-51ac132da747',
  name: 'Floresta Birthday',
  hours: 3,
  kids_included: 10,
  adults_included: 4,
  socks_included: -1,
  price_weekday_satang: 1_690_000,
  price_weekend_satang: 2_090_000,
  extra_child_weekday_satang: 130_000,
  extra_child_weekend_satang: 150_000,
  extra_adult_weekday_satang: 35_000,
  extra_adult_weekend_satang: 50_000,
  included_lines: [
    { label: "Kids' table reserved for 3 hours" },
    { label: 'Birthday set menu' },
    { label: 'Birthday animation program (30 minutes)' },
    { label: 'Ice-cream cake with candles' },
  ],
};

// --- The OTO App's directory: every edit taken, and recorded --------------------------

const editCalls: Array<{ eventId: string; body: DirectoryEventEditBody }> = [];
const directory: OtoAppDirectory = {
  configured: true,
  async checkinAttendee() {
    return {
      ok: false as const,
      status: null,
      code: 'OTOAPP_DIRECTORY_UNREACHABLE',
      message: 'not used here',
      retryable: true as const,
    };
  },
  async addAttendee() {
    return {
      ok: false as const,
      status: null,
      code: 'OTOAPP_DIRECTORY_UNREACHABLE',
      message: 'not used here',
      retryable: true as const,
    };
  },
  async editEvent(eventId, body): Promise<DirectoryOutcome<DirectoryEventEditAnswer>> {
    editCalls.push({ eventId, body });
    return {
      ok: true,
      status: 200,
      body: { replayed: false } as unknown as DirectoryEventEditAnswer,
    };
  },
};

// --- Helpers ----------------------------------------------------------------------------

async function call<T>(
  method: 'GET' | 'POST',
  cookie: string,
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { cookie },
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

/** A party in the OTO App, as the app writes it. */
async function appParty(
  id: string,
  title: string,
  date: string,
  totalThb: number,
  depositThb: number,
) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
      total_value, prepayment_amount, child_name, parent_name, whatsapp_phone_e164,
      kid_turning_age, num_children, num_adults, location_text, status, created_at, updated_at)
    values (
      ${id}, ${appTenant}, ${appCentral}, 'birthday', ${title}, ${date}, '13:00', '16:00',
      ${totalThb}, ${depositThb}, 'Mali', 'Nok', '+66812345678',
      6, 10, 4, 'Party room 1', 'upcoming',
      (now() at time zone 'UTC') - interval '1 hour', (now() at time zone 'UTC') - interval '1 hour')`);
}

/** Its plan, as `otoapp_v.event_packages` publishes it (the contract's columns). */
async function appPlan(
  eventId: string,
  date: string,
  pkg: Record<string, unknown>,
  o: {
    addOns?: unknown[];
    entertainment?: unknown[];
    depositSatang?: number;
    kids?: number;
    adults?: number;
    setMenu?: unknown[];
  } = {},
) {
  await ctx.db.execute(sql`
    insert into zz_party_contract.event_packages values (
      ${eventId}, ${central}::uuid, ${date}::date, '13:00'::time, '16:00'::time,
      ${JSON.stringify(pkg)}::jsonb,
      ${JSON.stringify({ kids_expected: o.kids ?? 10, adults_expected: o.adults ?? 4 })}::jsonb,
      ${JSON.stringify(o.addOns ?? [])}::jsonb,
      ${JSON.stringify(o.entertainment ?? [])}::jsonb,
      ${JSON.stringify(
        o.setMenu ?? [
          {
            product_code: 'CF-24',
            name: 'Margherita',
            qty: 1,
            choice_group: 'pizza',
            chosen_option: 'margherita',
            note: null,
          },
          {
            product_code: 'CF-11',
            name: 'French fries',
            qty: 2,
            choice_group: null,
            chosen_option: null,
            note: null,
          },
        ],
      )}::jsonb,
      ${JSON.stringify([{ product_code: 'CF-66-1', name: 'Kids juice', qty: 2 }])}::jsonb,
      ${JSON.stringify({ kids_food_time: '14:00', adults_food_time: '14:30', ready_offset_minutes: 20, slips_time: '11:00' })}::jsonb,
      ${JSON.stringify({ deposit_satang: o.depositSatang ?? 0, pos_sale_id: null })}::jsonb)`);
}

const settleBody = (o: Record<string, unknown>) => ({
  branchId: central,
  stationId: till,
  settlementId: newId(),
  saleId: newId(),
  addOnIds: [],
  entertainmentIds: [],
  ...o,
});

const settle = (eventId: string, o: Record<string, unknown>) =>
  call<PartySettleAnswer>('POST', reception, `/parties/${eventId}/settle`, settleBody(o));

const preview = (eventId: string, o: Record<string, unknown>) =>
  call<PartySettlePreviewAnswer>('POST', reception, `/parties/${eventId}/settle/preview`, {
    branchId: central,
    stationId: till,
    addOnIds: [],
    entertainmentIds: [],
    ...o,
  });

const detail = (eventId: string) =>
  call<PartyDetailAnswer>('GET', reception, `/parties/${eventId}?branchId=${central}`);

async function finalise(saleId: string, payload: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    payload,
    headers: { cookie: reception, 'x-oto-action-id': newId() },
  });
  return {
    status: res.statusCode,
    body: res.json() as Record<string, unknown> & { finalised: boolean },
  };
}

beforeAll(async () => {
  // The gateway is the simulator, signed and delivered through the real
  // notification path, as in `scrum-732-routed-tenders.test.ts`.
  ctx = await createTestContext({
    otoapp: true,
    env: {
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: 'OTO804MERCHANT',
      PGW_SECRET_KEY: GATEWAY_SECRET,
      PGW_WEBHOOK_SECRET: 'a-path-filter-not-a-credential',
    },
  });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [t1] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;
  await ctx.db
    .update(box)
    .set({ registeredAt: new Date(), status: 'online' })
    .where(eq(box.id, t1!.boxId!));
  await ctx.db.execute(
    sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-804')`,
  );
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  // The contract's view, over a table with its columns, until SCRUM-803's own is here.
  await ctx.db.execute(
    sql.raw(`
    create schema zz_party_contract;
    create table zz_party_contract.event_packages (
      event_id varchar not null, core_branch_id uuid, party_date date, start_time time, end_time time,
      package jsonb, counts jsonb, add_ons jsonb, entertainment jsonb, set_menu jsonb, bar_items jsonb,
      kitchen jsonb, settlement jsonb);
    drop view if exists otoapp_v.event_packages;
    create view otoapp_v.event_packages as select * from zz_party_contract.event_packages;`),
  );
  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

beforeEach(() => {
  editCalls.length = 0;
});

// =============================================================================
// The composer — the owner's counting rules, before any money

describe('SCRUM-910 adversarial review: returned money never becomes another deposit', () => {
  const counts = { kids: 10, adults: 4, socksGiven: 0 };
  async function fixture(deposit = 200_000) {
    const id = newId();
    await appParty(id, 'ZZ TEST 910 retained deposit', WEEKDAY, 16_900, deposit / 100);
    await appPlan(id, WEEKDAY, FLORESTA, { depositSatang: deposit });
    const opened = await settle(id, counts);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const saleId = opened.body.sale.id;
    if (deposit < 1_690_000) {
      const paid = await finalise(saleId, { method: 'cash', tenderedSatang: 1_690_000 - deposit });
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      expect(paid.body.finalised).toBe(true);
    }
    return { id, saleId };
  }
  const giveBack = (
    saleId: string,
    body: Record<string, unknown> = {},
    cookie = admin,
    key = newId(),
  ) =>
    ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/refunds`,
      headers: { cookie, 'idempotency-key': key },
      payload: { mode: 'whole', reason: 'ZZ TEST 910 cancellation', actionId: newId(), ...body },
    });
  const read = (saleId: string) =>
    ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie: admin } });

  it('HIGH: returns only till money, closes/readbacks consistently, and replays one retained allocation', async () => {
    const { id, saleId } = await fixture();
    expect((await read(saleId)).json().refundableSatang).toBe(1_490_000);
    const actionId = newId();
    const key = newId();
    const first = await giveBack(saleId, { actionId }, admin, key);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      refund: { amountSatang: 1_490_000, retainedPartyDepositSatang: 200_000 },
      sale: { status: 'refunded', totals: { grossSatang: 1_690_000, refundedSatang: 1_490_000 } },
      refundStatus: 'refunded',
      refundableSatang: 0,
    });
    expect(first.json().refund.tenderAllocation).toEqual([
      expect.objectContaining({ method: 'cash', amountSatang: 1_490_000 }),
    ]);
    expect((await read(saleId)).json()).toMatchObject({
      refundStatus: 'refunded',
      refundableSatang: 0,
    });
    expect((await giveBack(saleId, { actionId }, admin, key)).json()).toEqual(first.json());
    expect((await giveBack(saleId, { actionId })).json()).toMatchObject({
      replay: true,
      refund: { id: first.json().refund.id, retainedPartyDepositSatang: 200_000 },
    });
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, saleId))).toHaveLength(1);
    const [old] = await ctx.db
      .select()
      .from(partySettlement)
      .where(eq(partySettlement.saleId, saleId));
    const [deposit] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.id, old!.depositAttemptId!));
    expect(deposit).toMatchObject({ status: 'cancelled', amountSatang: 200_000 });
    expect((await giveBack(saleId, { actionId }, reception)).statusCode).toBe(403);
    const candidates = [settleBody(counts), settleBody(counts)];
    const settling = await Promise.all(candidates.map((body) => call<PartySettleAnswer>('POST', reception, `/parties/${id}/settle`, body)));
    expect(settling.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = settling.findIndex((r) => r.status === 200);
    const second = settling[winner]!;
    const replayed = await call<PartySettleAnswer>('POST', reception, `/parties/${id}/settle`, candidates[winner]);
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    expect(replayed.body).toMatchObject({ replayed: true, settlement: { id: second.body.settlement.id } });
    expect((await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, second.body.sale.id))).filter((a) => a.methodCode === PARTY_DEPOSIT_TENDER.code)).toHaveLength(1);
    expect(second.body.sale.outstandingSatang).toBe(1_490_000);
    expect(second.body.quote.depositSatang).toBe(200_000);
    const again = await finalise(second.body.sale.id, {
      method: 'cash',
      tenderedSatang: 1_490_000,
    });
    expect(again.status).toBe(200);
    expect((await giveBack(second.body.sale.id)).statusCode).toBe(200);
    const third = await settle(id, counts);
    expect(third.body.quote.depositSatang).toBe(200_000);
    expect(third.body.sale.outstandingSatang).toBe(1_490_000);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const snapshot = await salePrintSnapshotOf(ctx.db, row!);
    expect(snapshot.tenders.reduce((n, t) => n + t.amountSatang, 0)).toBe(1_690_000);
    const copy = saleReceiptDocument(snapshot, true);
    expect(copy.title).toBe('Receipt (copy)');
    expect(copy.tenders?.find((t) => /Deposit.*advance/.test(t.label))).toMatchObject({ amount: '\u0e3f2,000' });
    const facts = await saleFactsOf(ctx.db, central, row!.businessDate);
    const fact = facts.find((f) => f.saleId === saleId)!;
    expect(fact.refundedSatang).toBe(1_490_000);
    expect(fact.retainedPartyDepositSatang).toBe(200_000);
    expect(analyticsSaleRevenueV1(fact).amountSatang).toBe(0);
    const integrity = await ctx.app.inject({ method: 'GET', url: `/console/money/integrity?branches=${central}&from=${row!.businessDate}&to=${row!.businessDate}`, headers: { cookie: admin } });
    expect(integrity.statusCode, integrity.body).toBe(200);
    const unpaid = integrity.json().checks.find((c: { key: string }) => c.key === 'sales_without_payment');
    expect(unpaid.rows.some((r: { saleId: string }) => r.saleId === saleId)).toBe(false);
  });

  it('HIGH: partial then whole clamps at till money and releases the deposit only once', async () => {
    const { saleId } = await fixture();
    const partial = await giveBack(saleId, { mode: 'custom', amountSatang: 100_000 });
    expect(partial.statusCode, partial.body).toBe(200);
    expect(partial.json()).toMatchObject({
      refund: { amountSatang: 100_000, retainedPartyDepositSatang: 0 },
      sale: { status: 'finalised' },
      refundableSatang: 1_390_000,
    });
    const whole = await giveBack(saleId, { mode: 'custom', amountSatang: 9_999_999 });
    expect(whole.statusCode, whole.body).toBe(200);
    expect(whole.json()).toMatchObject({
      clamped: true,
      refund: { amountSatang: 1_390_000, retainedPartyDepositSatang: 200_000 },
      sale: { status: 'refunded' },
    });
    expect((await giveBack(saleId)).statusCode).toBe(409);
  });

  it('HIGH: zero-money whole closure has a numbered retention document and no money slice', async () => {
    const { id, saleId } = await fixture(1_690_000);
    expect((await read(saleId)).json()).toMatchObject({
      refundableSatang: 0,
      canCloseWithRetainedDeposit: true,
    });
    expect((await giveBack(saleId, { mode: 'custom', amountSatang: 1 })).statusCode).toBe(409);
    const result = await giveBack(saleId);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      refund: { amountSatang: 0, retainedPartyDepositSatang: 1_690_000, tenderAllocation: [] },
      sale: { status: 'refunded', totals: { refundedSatang: 0 } },
      refundStatus: 'refunded',
      refundableSatang: 0,
    });
    expect(result.json().refund.number).toMatch(/-R-/);
    expect((await read(saleId)).json()).toMatchObject({
      refundStatus: 'refunded',
      canCloseWithRetainedDeposit: false,
    });
    const [closedRow] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect((await salePrintSnapshotOf(ctx.db, closedRow!)).tenders).toEqual([expect.objectContaining({ method: PARTY_DEPOSIT_TENDER.code, amountSatang: 1_690_000 })]);
    expect((await settle(id, counts)).body.quote.depositSatang).toBe(1_690_000);
  });

  async function legacy(
    saleId: string,
    depositReturned: number,
    status: 'done' | 'pending' | 'failed' = 'done',
    cashReturned = 1_490_000,
  ) {
    const [settlement] = await ctx.db
      .select()
      .from(partySettlement)
      .where(eq(partySettlement.saleId, saleId));
    const attempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    const cash = attempts.find((a) => a.method === 'cash')!;
    const amount = cashReturned + depositReturned;
    const [r] = await ctx.db
      .insert(refund)
      .values({
        id: newId(),
        operatorId,
        branchId: central,
        saleId,
        stationId: till,
        number: `ZZ910-R-${newId()}`,
        mode: 'custom',
        amountSatang: amount,
        reason: 'ZZ TEST 910 historical handback',
        approvedByAccountId: (await ctx.db.select().from(sale).where(eq(sale.id, saleId)))[0]!
          .createdByAccountId!,
        createdByAccountId: (await ctx.db.select().from(sale).where(eq(sale.id, saleId)))[0]!
          .createdByAccountId!,
        tenderAllocation: [
          ...(cashReturned > 0
            ? [
                {
                  attemptId: cash.id,
                  method: 'cash',
                  methodCode: null,
                  provider: 'manual',
                  route: 'cash' as const,
                  amountSatang: cashReturned,
                  status: 'done' as const,
                },
              ]
            : []),
          {
            attemptId: settlement!.depositAttemptId,
            method: 'other',
            methodCode: PARTY_DEPOSIT_TENDER.code,
            provider: null,
            route: 'manual',
            amountSatang: depositReturned,
            status,
          },
        ],
      })
      .returning();
    await ctx.db
      .update(sale)
      .set({
        refundedSatang: amount,
        ...(amount === 1_690_000 ? { status: 'refunded' as const, refundedAt: new Date() } : {}),
      })
      .where(eq(sale.id, saleId));
    return r!;
  }

  it('HIGH: a completed historical partial deposit return is subtracted once across replacement settlements', async () => {
    const { id, saleId } = await fixture();
    await legacy(saleId, 50_000);
    const closed = await giveBack(saleId);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({
      refund: { amountSatang: 0, retainedPartyDepositSatang: 150_000 },
      sale: { totals: { refundedSatang: 1_540_000 }, status: 'refunded' },
    });
    expect((await preview(id, counts)).body.quote).toMatchObject({
      depositSatang: 150_000,
      balanceSatang: 1_540_000,
    });
    expect((await settle(id, counts)).body.quote).toMatchObject({
      depositSatang: 150_000,
      balanceSatang: 1_540_000,
    });
  });

  it('HIGH: a wholly returned legacy deposit cannot support another settlement', async () => {
    const { id, saleId } = await fixture();
    await legacy(saleId, 200_000);
    const next = await settle(id, counts);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.quote).toMatchObject({ depositSatang: 0, balanceSatang: 1_690_000 });
  });

  it.each(['pending', 'failed'] as const)(
    'HIGH: %s old deposit return fences only its party while authenticated reads remain available',
    async (status) => {
      const bad = await fixture();
      const good = await fixture();
      await legacy(bad.saleId, 200_000, status);
      const denied = await settle(bad.id, counts);
      expect(denied.status, JSON.stringify(denied.body)).toBe(409);
      expect((denied.body as unknown as { error: { code: string } }).error.code).toBe(
        'PARTY_DEPOSIT_REVIEW_REQUIRED',
      );
      expect((await read(bad.saleId)).statusCode).toBe(200);
      expect((await read(bad.saleId)).json().partyDepositReviewRequired).toBe(true);
      expect((await detail(good.id)).status).toBe(200);
      expect((await read(good.saleId)).json().refundableSatang).toBe(1_490_000);
    },
  );

  it('HIGH: malformed history fences only its party without breaking authenticated lists', async () => {
    const bad = await fixture();
    const historical = await legacy(bad.saleId, 50_000, 'done', 100_000);
    await ctx.db.update(refund).set({ tenderAllocation: [] }).where(eq(refund.id, historical.id));
    const denied = await giveBack(bad.saleId);
    expect(denied.statusCode, denied.body).toBe(409);
    expect(denied.json().error.code).toBe('PARTY_DEPOSIT_REVIEW_REQUIRED');
    const reading = await detail(bad.id);
    expect(reading.status, JSON.stringify(reading.body)).toBe(200);
    expect(reading.body.event.party!.bill!.depositReviewRequired).toBe(true);
    expect((await read(bad.saleId)).statusCode).toBe(200);
  });

  it('HIGH: approval and branch checks precede release and replay; a transaction rollback releases nothing', async () => {
    const { saleId } = await fixture();
    expect((await giveBack(saleId, {}, reception)).statusCode).toBe(403);
    const elsewhere = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    expect((await giveBack(saleId, {}, elsewhere)).statusCode).toBe(403);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    await expect(
      withTx(
        ctx.db,
        { actorAccountId: row!.createdByAccountId!, operatorId, requestId: newId() },
        'review.rollback',
        async (tx) => {
          await refundSale(
            tx,
            {
              accountId: row!.createdByAccountId!,
              operatorId,
              stationId: till,
              assertBranchAllowed: async () => {},
              assertCanApprove: async () => {},
            },
            saleId,
            { mode: 'whole', reason: 'ZZ TEST rollback', actionId: newId() },
          );
          throw new Error('ZZ TEST forced outer rollback');
        },
      ),
    ).rejects.toThrow('forced outer rollback');
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, saleId))).toHaveLength(0);
    const [held] = await ctx.db.select().from(partySettlement).where(eq(partySettlement.saleId, saleId));
    const [allocation] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, held!.depositAttemptId!));
    expect(held!.releasedAt).toBeNull();
    expect(allocation).toMatchObject({ status: 'approved', amountSatang: 200_000 });
    expect((await read(saleId)).json()).toMatchObject({
      sale: { status: 'finalised' },
      refundableSatang: 1_490_000,
    });
    const raced = await Promise.all([giveBack(saleId), giveBack(saleId)]);
    expect(raced.map((x) => x.statusCode).sort()).toEqual([200, 409]);
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, saleId))).toHaveLength(1);
  });
});
