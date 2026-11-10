import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, box, otoappUsers, partySettlement, paymentAttempt, sale, station } from '@oto/db';
import {
  PartyBillingAnswerSchema,
  newId,
  type PartyBillingAnswer,
  type PartySettleAnswer,
  type PartySettlePreviewAnswer,
} from '@oto/shared';
import { otoAppProvisionKeyDigest } from '../src/lib/otoapp-provision-keys';
import type {
  DirectoryEventEditAnswer,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-822 — ONE PLACE FOR A PARTY'S MONEY: the OTO App reads it from the till.
 *
 * The app's server asks with its provisioning key, `GET
 * /otoapp/parties/:eventId/billing`, and the BEO's Billing section, Party
 * Details box, Day-of view and Quote PDF show what it answers. Held here
 * against a real database with the OTO App's own tables and views built by
 * its migrations (the plan through `otoapp_v.event_packages`, 0047), with the
 * staging proof's party: the Floresta package on a weekday, ten children and
 * four adults, a ฿3,000 deposit in the BEO's billing, and a ฿125 item the BEO
 * added (SCRUM-828's door):
 *
 *   - the door is the key's: no key, a wrong key or a till session alone is
 *     401; another operator's key does not find the party (404);
 *   - before settlement it answers the QUOTE the till's own preview gives for
 *     the counts its Settle form opens with: ฿16,900 + ฿125 = ฿17,025, the
 *     deposit, the balance ฿14,025, each line with its label — and writes
 *     nothing, the same figures twice;
 *   - a party with no package answers `no_quote` in the till's own words;
 *   - once settled at a till it answers the SALE: open with the balance to
 *     take, then paid in cash — the receipt number, the lines, the deposit and
 *     the cash as the receipt words them, the totals, when and at which till.
 */

const KEY = 'zz-test-private-party-billing-key-822';
const OTHER_KEY = 'zz-test-other-operator-party-billing-key-822';
const PARTY_MENU_KEY_URL = '/otoapp/party-menu/products';

/** A Wednesday: the Floresta weekday price. */
const WEDNESDAY = '2026-11-18';

let ctx: TestContext;
let operatorId: string;
let otherOperatorId: string;
let central: string;
let till: string;
let tillName: string;
let reception: string;
let appTenant: string;
let appPark: string;
let presser: string;

const directory: OtoAppDirectory = {
  configured: true,
  async checkinAttendee() {
    return { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true as const };
  },
  async addAttendee() {
    return { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true as const };
  },
  async editEvent(): Promise<DirectoryOutcome<DirectoryEventEditAnswer>> {
    return { ok: true, status: 200, body: { replayed: false } as unknown as DirectoryEventEditAnswer };
  },
};

const billing = (eventId: string, key: string | null = KEY, extra: Record<string, string> = {}) =>
  ctx.app.inject({
    method: 'GET',
    url: `/otoapp/parties/${eventId}/billing`,
    headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...extra },
  });

async function read(eventId: string): Promise<PartyBillingAnswer> {
  const res = await billing(eventId);
  expect(res.statusCode, res.body).toBe(200);
  return PartyBillingAnswerSchema.parse(res.json());
}

/** A birthday in the OTO App, its package applied as the BEO applies Floresta, and its deposit paid in the BEO's billing. */
async function floresta(eventId: string, o: { depositThb?: number; withPackage?: boolean } = {}) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
      num_children, num_adults, location_text, status, created_at, updated_at)
    values (
      ${eventId}, ${appTenant}, ${appPark}, 'birthday', 'ZZ TEST Floresta party 822', ${WEDNESDAY}, '13:00', '16:00',
      10, 4, 'Party room 1', 'upcoming', now() at time zone 'UTC', now() at time zone 'UTC')`);
  if (o.withPackage !== false) {
    const snapshot = newId();
    await ctx.db.execute(sql`
      insert into otoapp.beo_package_snapshots (
        id, event_id, package_name, base_price, kids_included, adults_included, socks_included, hours,
        price_weekday, price_weekend, extra_child_weekday, extra_child_weekend, extra_adult_weekday, extra_adult_weekend, slips_time)
      values (
        ${snapshot}, ${eventId}, 'ZZ TEST Floresta Birthday', 1690000, 10, 4, -1, 3,
        1690000, 2090000, 130000, 150000, 35000, 50000, '11:00'::time)`);
    await ctx.db.execute(sql`
      insert into otoapp.beo_package_snapshot_items (id, snapshot_id, label, included, unit_price, billable, sort_order)
      values (${newId()}, ${snapshot}, 'Kids'' table reserved for 3 hours', true, 0, false, 1),
             (${newId()}, ${snapshot}, 'Ice-cream cake with candles', true, 0, false, 2)`);
  }
  if (o.depositThb) {
    await ctx.db.execute(sql`
      insert into otoapp.beo_event_billing (id, event_id, deposit_paid, deposit_paid_amount, deposit_paid_at)
      values (${newId()}, ${eventId}, true, ${o.depositThb}, '2026-11-01T00:00:00Z')`);
  }
}

/** The ฿125 item the BEO added through SCRUM-828's door, on the party's adults' food lines. */
async function beoItem(eventId: string): Promise<string> {
  const made = await ctx.app.inject({
    method: 'POST',
    url: PARTY_MENU_KEY_URL,
    headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': newId() },
    payload: {
      branchId: central,
      name: 'ZZ TEST bubble tea',
      station: 'bar',
      priceSatang: 12_500,
      free: false,
      source: { eventId, lineLabel: 'ZZ TEST bubble tea' },
      actorAppUserId: presser,
    },
  });
  expect(made.statusCode, made.body).toBe(200);
  const code = (made.json() as { code: string }).code;
  const menus = {
    kids: [],
    adults: [{ id: `party_${newId()}`, itemName: 'ZZ TEST bubble tea', quantity: 1, notes: '', included: false, price: 125, productCode: code }],
  };
  await ctx.db.execute(sql`
    insert into otoapp.beo_kitchen_plans (id, event_id, set_menu_enabled, menus, kitchen_ready_offset_minutes)
    values (${newId()}, ${eventId}, false, ${JSON.stringify(menus)}::jsonb, 20)`);
  return code;
}

beforeAll(async () => {
  const env: Record<string, string> = {};
  ctx = await createTestContext({ otoapp: true, env });
  operatorId = await operatorIdByName(ctx.db, 'OTO');
  otherOperatorId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  env.OTOAPP_PROVISION_KEYS = `${operatorId}:${otoAppProvisionKeyDigest(KEY)},${otherOperatorId}:${otoAppProvisionKeyDigest(OTHER_KEY)}`;
  await ctx.restart();
  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;
  tillName = t1!.name;
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, t1!.boxId!));

  appTenant = newId();
  appPark = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'ZZ TEST 822', ${`zz-822-${appTenant}`})`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appPark}, ${appTenant}, 'ZZ TEST 822 park', 'Phuket', ${central})`);
  presser = newId();
  await ctx.db.insert(otoappUsers).values({
    id: presser,
    email: `zz-822-${presser}@example.test`,
    password: 'not-a-real-hash',
    fullName: 'ZZ TEST 822 staff',
    role: 'staff',
    isActive: true,
    mustChangePassword: false,
    platformUserId: null,
  });
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the door is the OTO App server’s, by its key', () => {
  const party = newId();

  it('no key, a key this platform does not hold, or a till session alone: 401', async () => {
    await floresta(party, { depositThb: 3_000 });
    expect((await billing(party, null)).statusCode).toBe(401);
    expect((await billing(party, 'zz-not-a-key')).statusCode).toBe(401);
    expect((await billing(party, null, { cookie: reception })).statusCode).toBe(401);
    const route = ctx.app.routeRegistry.find((r) => r.method === 'GET' && r.url === '/otoapp/parties/:eventId/billing');
    expect(route?.config.credential).toBe('otoapp-provision');
    expect(route?.config.public).not.toBe(true);
  });

  it('the operator is the key’s: another operator’s key does not find the party; an id that is no party is 404', async () => {
    const theirs = await billing(party, OTHER_KEY);
    expect(theirs.statusCode, theirs.body).toBe(404);
    expect(theirs.json().error.message).toBe('Party not found');
    expect((await billing(newId())).statusCode).toBe(404);
    expect((await billing('not-a-uuid')).statusCode).toBe(400);
  });
});

describe('before settlement: the quote the till’s Settle form would show today', () => {
  const party = newId();
  let code: string;

  it('Floresta on a weekday with a ฿125 item the BEO added: ฿17,025, the ฿3,000 deposit, ฿14,025 outstanding, line by line', async () => {
    await floresta(party, { depositThb: 3_000 });
    code = await beoItem(party);
    const answer = await read(party);
    expect(answer).toMatchObject({
      eventId: party,
      state: 'quote',
      park: { name: 'OTO', branchName: expect.any(String) },
      party: { title: 'ZZ TEST Floresta party 822', date: WEDNESDAY, startTime: '13:00', packageName: 'ZZ TEST Floresta Birthday', kids: 10, adults: 4 },
      sale: null,
      noQuote: null,
    });
    expect(answer.quote).toMatchObject({
      partyDate: WEDNESDAY,
      rateMode: 'weekday',
      packageName: 'ZZ TEST Floresta Birthday',
      packageSatang: 1_690_000,
      addOnsSatang: 12_500,
      extraChildren: 0,
      extraAdults: 0,
      freeSocks: 10,
      paidSocks: 0,
      totalSatang: 1_702_500,
      depositSatang: 300_000,
      balanceSatang: 1_402_500,
    });
    const lines = answer.quote!.lines.map((l) => [l.role, l.label, l.quantity, l.totalSatang]);
    expect(lines).toEqual(
      expect.arrayContaining([
        ['package', 'ZZ TEST Floresta Birthday', 1, 1_690_000],
        ['included', "Kids' table reserved for 3 hours", 1, 0],
        ['included', 'Ice-cream cake with candles', 1, 0],
        ['add_on', 'ZZ TEST bubble tea', 1, 12_500],
      ]),
    );
    expect(code).toMatch(/^PARTY-/);
  });

  it('is the till’s own preview for the same counts, figure for figure', async () => {
    const answer = await read(party);
    const preview = await ctx.app.inject({
      method: 'POST',
      url: `/parties/${party}/settle/preview`,
      headers: { cookie: reception },
      payload: { branchId: central, stationId: till, kids: 10, adults: 4, socksGiven: 10, addOnIds: [], entertainmentIds: [] },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(answer.quote).toEqual((preview.json() as PartySettlePreviewAnswer).quote);
  });

  it('is a read: the same figures twice, and nothing written', async () => {
    const counts = async () => ({
      sales: (await ctx.db.select({ id: sale.id }).from(sale)).length,
      settlements: (await ctx.db.select({ id: partySettlement.id }).from(partySettlement)).length,
      attempts: (await ctx.db.select({ id: paymentAttempt.id }).from(paymentAttempt)).length,
      audits: (await ctx.db.select({ id: auditLog.id }).from(auditLog)).length,
    });
    const before = await counts();
    const first = await read(party);
    const second = await read(party);
    expect(second).toEqual(first);
    expect(await counts()).toEqual(before);
  });

  it('the deposit is the BEO’s one figure: changed there, the quote reads the new one', async () => {
    await ctx.db.execute(sql`update otoapp.beo_event_billing set deposit_paid_amount = 5000 where event_id = ${party}`);
    const answer = await read(party);
    expect(answer.quote).toMatchObject({ totalSatang: 1_702_500, depositSatang: 500_000, balanceSatang: 1_202_500 });
    await ctx.db.execute(sql`update otoapp.beo_event_billing set deposit_paid_amount = 3000 where event_id = ${party}`);
  });

  it('a party with no package answers no quote, in the till’s own words', async () => {
    const bare = newId();
    await floresta(bare, { withPackage: false });
    const answer = await read(bare);
    expect(answer).toMatchObject({
      state: 'no_quote',
      quote: null,
      sale: null,
      noQuote: { code: 'PARTY_NO_PACKAGE', message: 'This party has no package in the OTO App, so it cannot be settled here' },
      party: { packageName: null, kids: 10, adults: 4 },
    });
  });
});

describe('after settlement: the sale, read live', () => {
  const party = newId();
  let settled: PartySettleAnswer;

  it('settled at the till and still open: the sale with the deposit taken and the balance to take', async () => {
    await floresta(party, { depositThb: 3_000 });
    await beoItem(party);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/parties/${party}/settle`,
      headers: { cookie: reception },
      payload: {
        branchId: central,
        stationId: till,
        settlementId: newId(),
        saleId: newId(),
        kids: 10,
        adults: 4,
        socksGiven: 10,
        addOnIds: [],
        entertainmentIds: [],
        expectedTotalSatang: 1_702_500,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    settled = res.json() as PartySettleAnswer;
    const answer = await read(party);
    expect(answer).toMatchObject({ state: 'sale', quote: null, noQuote: null, party: { packageName: 'ZZ TEST Floresta Birthday', kids: 10, adults: 4 } });
    expect(answer.sale).toMatchObject({
      saleId: settled.sale.id,
      settlementId: settled.settlement.id,
      state: 'open',
      grossSatang: 1_702_500,
      paidSatang: 300_000,
      depositSatang: 300_000,
      outstandingSatang: 1_402_500,
      settledAt: null,
      stationName: tillName,
    });
    expect(answer.sale!.payments).toEqual([
      expect.objectContaining({ label: 'Deposit paid in advance', amountSatang: 300_000, deposit: true }),
    ]);
  });

  it('paid in cash: the receipt, every line, the deposit and the cash as the receipt words them, settled, at which till', async () => {
    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${settled.sale.id}/finalise`,
      payload: { method: 'cash', tenderedSatang: 1_402_500 },
      headers: { cookie: reception, 'x-oto-action-id': newId() },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const answer = await read(party);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, settled.sale.id));
    expect(answer.state).toBe('sale');
    expect(answer.sale).toMatchObject({
      state: 'settled',
      receiptNumber: row!.receiptNumber,
      grossSatang: 1_702_500,
      paidSatang: 1_702_500,
      outstandingSatang: 0,
      settledAt: expect.any(String),
      stationName: tillName,
    });
    expect(row!.receiptNumber).toBeTruthy();
    expect(answer.sale!.payments.map((p) => [p.label, p.amountSatang, p.deposit])).toEqual([
      ['Deposit paid in advance', 300_000, true],
      ['Cash', 1_402_500, false],
    ]);
    const lines = answer.sale!.lines.map((l) => [l.role, l.label, l.totalSatang]);
    expect(lines).toEqual(
      expect.arrayContaining([
        ['package', 'ZZ TEST Floresta Birthday', 1_690_000],
        ['included', 'Ice-cream cake with candles', 0],
        ['add_on', 'ZZ TEST bubble tea', 12_500],
      ]),
    );
    expect(answer.sale!.lines.reduce((sum, l) => sum + l.totalSatang, 0)).toBe(1_702_500);
  });
});
