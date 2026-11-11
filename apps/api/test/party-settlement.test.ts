import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  band,
  box,
  branch,
  partyEdit,
  partySettlement,
  paymentAttempt,
  paymentMethod,
  product,
  refund,
  sale,
  saleLine,
  station,
  stockItem,
  stockLevel,
} from '@oto/db';
import {
  PARTY_DEPOSIT_TENDER,
  PartyDetailAnswerSchema,
  PartySettleAnswerSchema,
  composePartySettlement,
  countsAsTillTakings,
  newId,
  saleReceiptDocument,
  type PartyDetailAnswer,
  type PartyPlan,
  type PartySettleAnswer,
  type PartySettlePreviewAnswer,
} from '@oto/shared';
import type {
  DirectoryEventEditAnswer,
  DirectoryEventEditBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import { createPartyMenuProduct } from '../src/services/party-menu';
import { salePrintSnapshotOf } from '../src/services/sale-printing';
import { simulateGatewayEvent } from '../src/services/payments/gateway';
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
 * SCRUM-804 — A BIRTHDAY PARTY SETTLED AS ONE REAL SALE (birthday plan §4,
 * Lane 2; the owner's rules of 9 November 2026).
 *
 * The OTO App publishes each party's plan in `otoapp_v.event_packages`
 * (SCRUM-803, built in its own lane). Until that view is on every database the
 * suite lays the contract's shape itself: a fixture table with the contract's
 * columns, and the view over it, so the platform reads exactly what the
 * contract says it will. The party itself is the app's own `core_events` row,
 * read through `otoapp_v.events` as every party is.
 *
 * The packages are the owner's, in satang as the contract carries them:
 * Floresta Birthday 16,900 weekday / 20,900 weekend, up to 10 children (extra
 * child 1,300 / 1,500), 4 adults (extra adult 350 / 500, the package's price,
 * not the tier rate), socks for all children; After School 10 kids 10,900 with
 * its 10 parents and no socks (sold at the Regular Socks price), its extra-child
 * price a fixture figure (the contract names the field; the owner's text names
 * no figure). The reserved table for adults is 5,000 of F&B credit in full.
 */

let ctx: TestContext;
let central: string;
let operatorId: string;
let till: string;
let reception: string;
let admin: string;
let socksItemId: string;
let socksPriceSatang: number;

const appTenant = newId();
const appCentral = newId();
const GATEWAY_SECRET = randomBytes(32).toString('hex');

/** A Wednesday, a Saturday, and a Tuesday inside the seeded Loy Krathong range (24–25 November). */
const WEEKDAY = '2026-11-18';
const SATURDAY = '2026-11-21';
const HOLIDAY_TUESDAY = '2026-11-24';

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

const AFTER_SCHOOL_10 = {
  template_id: '0a8137c3-2775-491d-ac4d-567e7332b3ad',
  name: 'After School Birthday 10 kids',
  hours: 3,
  kids_included: 10,
  adults_included: 10,
  socks_included: 0,
  price_weekday_satang: 1_090_000,
  price_weekend_satang: 1_090_000,
  extra_child_weekday_satang: 109_000,
  extra_child_weekend_satang: 109_000,
  extra_adult_weekday_satang: null,
  extra_adult_weekend_satang: null,
  included_lines: [{ label: 'Table reservation' }, { label: 'Birthday Food Set for Kids' }, { label: 'Ice Cream Cake' }],
};

const TABLE = {
  template_id: 'addon-reserved-table',
  name: 'Reserved table for adults',
  qty: 1,
  unit_price_satang: 500_000,
  fnb_credit_satang: 500_000,
  prints_voucher: true,
};
const BALLOONS = {
  template_id: 'addon-balloons',
  name: 'Classic balloon decoration',
  qty: 1,
  unit_price_satang: 400_000,
  fnb_credit_satang: 0,
  prints_voucher: false,
};
const ZOMBIE = {
  template_id: 'ent-zombie',
  name: 'Zombie game',
  category: 'games',
  duration_minutes: 30,
  age_range: '6+',
  max_kids: 10,
  price_satang: 400_000,
  extra_children: 2,
  extra_child_price_satang: 40_000,
};

// --- The OTO App's directory: every edit taken, and recorded --------------------------

const editCalls: Array<{ eventId: string; body: DirectoryEventEditBody }> = [];
const directory: OtoAppDirectory = {
  configured: true,
  async checkinAttendee() {
    return { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true as const };
  },
  async addAttendee() {
    return { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true as const };
  },
  async editEvent(eventId, body): Promise<DirectoryOutcome<DirectoryEventEditAnswer>> {
    editCalls.push({ eventId, body });
    return { ok: true, status: 200, body: { replayed: false } as unknown as DirectoryEventEditAnswer };
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
async function appParty(id: string, title: string, date: string, totalThb: number, depositThb: number) {
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
          { product_code: 'CF-24', name: 'Margherita', qty: 1, choice_group: 'pizza', chosen_option: 'margherita', note: null },
          { product_code: 'CF-11', name: 'French fries', qty: 2, choice_group: null, chosen_option: null, note: null },
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

const detail = (eventId: string) => call<PartyDetailAnswer>('GET', reception, `/parties/${eventId}?branchId=${central}`);

async function finalise(saleId: string, payload: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    payload,
    headers: { cookie: reception, 'x-oto-action-id': newId() },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> & { finalised: boolean } };
}

async function linesOf(saleId: string) {
  return ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId)).orderBy(asc(saleLine.lineNo));
}

async function socksHeld(): Promise<number> {
  const [row] = await ctx.db
    .select({ total: sql<number>`coalesce(sum(${stockLevel.quantity}), 0)::int` })
    .from(stockLevel)
    .where(eq(stockLevel.stockItemId, socksItemId));
  return row!.total;
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
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  till = t1!.id;
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, t1!.boxId!));
  const [socks] = await ctx.db.select().from(product).where(and(eq(product.code, 'AO-SOCKS'), eq(product.branchId, central)));
  socksPriceSatang = socks!.priceSatang;
  const [item] = await ctx.db.select().from(stockItem).where(and(eq(stockItem.productId, socks!.id), eq(stockItem.branchId, central)));
  socksItemId = item!.id;

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-804')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  // The contract's view, over a table with its columns, until SCRUM-803's own is here.
  await ctx.db.execute(sql.raw(`
    create schema zz_party_contract;
    create table zz_party_contract.event_packages (
      event_id varchar not null, core_branch_id uuid, party_date date, start_time time, end_time time,
      package jsonb, counts jsonb, add_ons jsonb, entertainment jsonb, set_menu jsonb, bar_items jsonb,
      kitchen jsonb, settlement jsonb);
    drop view if exists otoapp_v.event_packages;
    create view otoapp_v.event_packages as select * from zz_party_contract.event_packages;`));
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
// =============================================================================

describe('composePartySettlement — who is inside the package and who is an extra', () => {
  const plan = {
    package: {
      templateId: null,
      name: 'Floresta Birthday',
      hours: 3,
      kidsIncluded: 10,
      adultsIncluded: 4,
      socksIncluded: -1,
      priceWeekdaySatang: 1_690_000,
      priceWeekendSatang: 2_090_000,
      extraChildWeekdaySatang: 130_000,
      extraChildWeekendSatang: 150_000,
      extraAdultWeekdaySatang: 35_000,
      extraAdultWeekendSatang: 50_000,
      includedLines: [],
    },
    addOns: [],
    entertainment: [],
  } satisfies Pick<PartyPlan, 'package' | 'addOns' | 'entertainment'>;
  const base = { addOnIds: [], entertainmentIds: [] };

  it('weekend: 12 children and 6 adults are 2 extra children at 1,500 and 2 extra adults at 500, socks free for all 12', () => {
    const r = composePartySettlement(plan, { ...base, kids: 12, adults: 6, socksGiven: 12 }, 'weekend');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.composition).toMatchObject({
      packageSatang: 2_090_000,
      packageKids: 10,
      extraChildren: 2,
      extraChildUnitSatang: 150_000,
      packageAdults: 4,
      extraAdults: 2,
      extraAdultUnitSatang: 50_000,
      freeSocks: 12,
      paidSocks: 0,
    });
  });

  it('an extra adult the package names no price for is refused, never admitted free', () => {
    const r = composePartySettlement(
      { ...plan, package: { ...plan.package, extraAdultWeekdaySatang: null } },
      { ...base, kids: 10, adults: 5, socksGiven: 0 },
      'weekday',
    );
    expect(r).toMatchObject({ ok: false, code: 'PARTY_EXTRA_ADULT_NOT_PRICED' });
  });

  it("the till's own count of extras is compared, never used", () => {
    const r = composePartySettlement(plan, { ...base, kids: 12, adults: 4, socksGiven: 0, extraChildren: 1 }, 'weekday');
    expect(r).toMatchObject({ ok: false, code: 'PARTY_COUNTS_DIFFER' });
  });
});

// =============================================================================
// The plan, read through the seam
// =============================================================================

describe('GET /parties/:id — the plan the OTO App published, in place of the stubbed line items and kitchen', () => {
  const withPlan = newId();
  const without = newId();

  it('reads the package with its limits and prices, the counts, the add-ons, the entertainment, the set menu and the food times', async () => {
    await appParty(withPlan, "Mali's 6th", WEEKDAY, 16_900, 3_000);
    await appPlan(withPlan, WEEKDAY, FLORESTA, { addOns: [TABLE, BALLOONS], entertainment: [ZOMBIE], depositSatang: 300_000 });
    const res = await detail(withPlan);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(PartyDetailAnswerSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.planStatus).toBe('ready');
    expect(res.body.plan).toMatchObject({
      eventId: withPlan,
      partyDate: WEEKDAY,
      startTime: '13:00',
      package: {
        name: 'Floresta Birthday',
        hours: 3,
        kidsIncluded: 10,
        adultsIncluded: 4,
        socksIncluded: -1,
        priceWeekdaySatang: 1_690_000,
        priceWeekendSatang: 2_090_000,
        extraAdultWeekendSatang: 50_000,
        includedLines: FLORESTA.included_lines,
      },
      counts: { kidsExpected: 10, adultsExpected: 4 },
      addOns: [
        { id: TABLE.template_id, name: TABLE.name, qty: 1, unitPriceSatang: 500_000, fnbCreditSatang: 500_000, printsVoucher: true },
        { id: BALLOONS.template_id, unitPriceSatang: 400_000, fnbCreditSatang: 0 },
      ],
      entertainment: [{ id: ZOMBIE.template_id, priceSatang: 400_000, extraChildren: 2, extraChildPriceSatang: 40_000 }],
      setMenu: [{ productCode: 'CF-24', name: 'Margherita', qty: 1, chosenOption: 'margherita' }, { productCode: 'CF-11', qty: 2 }],
      barItems: [{ productCode: 'CF-66-1', qty: 2 }],
      kitchen: { kidsFoodTime: '14:00', adultsFoodTime: '14:30', readyOffsetMinutes: 20, slipsTime: '11:00' },
      settlement: { depositSatang: 300_000, posSaleId: null },
    });
    expect(res.body.event.party?.settlement).toBeNull();
  });

  it('answers a party the app has no package for with no plan, and says so', async () => {
    await appParty(without, "Ton's 5th", WEEKDAY, 5_000, 0);
    const res = await detail(without);
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeNull();
    expect(res.body.planStatus).toBe('no_package');
    // And it cannot be settled.
    const refused = await settle(without, { kids: 10, adults: 2, socksGiven: 0 });
    expect(refused.status).toBe(409);
    expect((refused.body as unknown as { error: { code: string } }).error.code).toBe('PARTY_NO_PACKAGE');
  });
});

// =============================================================================
// Floresta, weekday: 10 children, 4 adults, socks for all, the deposit
// =============================================================================

describe('Floresta weekday: 10 children, 4 adults, socks for all — one sale of 16,900', () => {
  const party = newId();
  let answer: PartySettleAnswer;
  let held: number;

  beforeAll(async () => {
    await appParty(party, "Pim's 7th", WEEKDAY, 16_900, 3_000);
    await appPlan(party, WEEKDAY, FLORESTA, { depositSatang: 300_000 });
    held = await socksHeld();
  });

  it('previews the figures the settlement will charge, writing nothing', async () => {
    const sales = (await ctx.db.select({ id: sale.id }).from(sale)).length;
    const res = await preview(party, { kids: 10, adults: 4, socksGiven: 10 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.quote).toMatchObject({
      partyDate: WEEKDAY,
      rateMode: 'weekday',
      packageName: 'Floresta Birthday',
      packageSatang: 1_690_000,
      extraChildren: 0,
      extraAdults: 0,
      freeSocks: 10,
      paidSocks: 0,
      socksSatang: 0,
      totalSatang: 1_690_000,
      creditSatang: 0,
      depositSatang: 300_000,
      balanceSatang: 1_390_000,
    });
    expect((await ctx.db.select({ id: sale.id }).from(sale)).length).toBe(sales);
  });

  it('settles as one sale: the package fee, the included items at ฿0, the guests at ฿0 and 10 free Regular Socks', async () => {
    const res = await settle(party, { kids: 10, adults: 4, socksGiven: 10, tier: 'thai', expectedTotalSatang: 1_690_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(PartySettleAnswerSchema.safeParse(res.body).success).toBe(true);
    answer = res.body;
    expect(answer.sale).toMatchObject({ status: 'tendering', grossSatang: 1_690_000, outstandingSatang: 1_390_000 });
    expect(answer.settlement).toMatchObject({ state: 'open', depositSatang: 300_000, kids: 10, adults: 4 });

    const lines = await linesOf(answer.sale.id);
    const pkg = lines.find((l) => l.componentKey === 'party_package')!;
    expect(pkg).toMatchObject({ kind: 'addon', label: 'Floresta Birthday', grossSatang: 1_690_000, taxableCategory: 'tickets' });
    const included = lines.filter((l) => l.componentKey === 'party_included');
    expect(included.map((l) => [l.label, l.grossSatang, l.quantity])).toEqual(
      FLORESTA.included_lines.map((l) => [l.label, 0, 1]),
    );
    expect(lines.find((l) => l.kind === 'kids')).toMatchObject({ quantity: 10, unitSatang: 0, grossSatang: 0, stayHours: 3 });
    expect(lines.find((l) => l.kind === 'adults_free')).toMatchObject({ quantity: 4, grossSatang: 0 });
    expect(lines.some((l) => l.kind === 'adults_paid')).toBe(false);
    const socks = lines.filter((l) => l.kind === 'socks');
    expect(socks.map((l) => [l.label, l.quantity, l.grossSatang])).toEqual([['Regular Socks (free)', 10, 0]]);
    expect(socks[0]!.productId).not.toBeNull();
    // The sale's own figures: one sale of 16,900, VAT inside it.
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, answer.sale.id));
    expect(row!.grossSatang).toBe(1_690_000);
    expect(row!.note).toBe("Party: Pim's 7th");
  });

  it('records the deposit as a payment of "Deposit (paid in advance)": no counter, so not the till\'s takings', async () => {
    const attempts = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, answer.sale.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      method: 'other',
      methodCode: PARTY_DEPOSIT_TENDER.code,
      amountSatang: 300_000,
      status: 'approved',
      stationId: null,
    });
    expect(countsAsTillTakings(attempts[0]!)).toBe(false);
  });

  it('refuses a second settlement while the first sale is open', async () => {
    const res = await settle(party, { kids: 10, adults: 4, socksGiven: 10 });
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: { code: string; details: { saleId: string } } }).error).toMatchObject({
      code: 'PARTY_ALREADY_SETTLED',
      details: { saleId: answer.sale.id },
    });
  });

  it('the same settlement id again answers what it made', async () => {
    const res = await call<PartySettleAnswer>('POST', reception, `/parties/${party}/settle`, {
      ...settleBody({ kids: 10, adults: 4, socksGiven: 10 }),
      settlementId: answer.settlement.id,
      saleId: answer.sale.id,
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-oto-replay']).toBe('true');
    expect(res.body.sale.id).toBe(answer.sale.id);
  });

  it('while it is open the tab no longer carries the package: the bill is the tab\'s own', async () => {
    const res = await detail(party);
    expect(res.body.event.party!.settlement).toMatchObject({ state: 'open', saleId: answer.sale.id, outstandingSatang: 1_390_000 });
    expect(res.body.event.party!.bill).toMatchObject({ baseSatang: 0, depositSatang: 0, outstandingSatang: 0 });
  });

  it('the balance is taken on the ordinary payment route; the close prints a band for every child and adult and takes the socks', async () => {
    const res = await finalise(answer.sale.id, { method: 'cash', tenderedSatang: 1_400_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.finalised).toBe(true);
    const bands = await ctx.db.select().from(band).where(eq(band.saleId, answer.sale.id));
    expect(bands.filter((b) => b.kind === 'kid')).toHaveLength(10);
    expect(bands.filter((b) => b.kind === 'adult')).toHaveLength(4);
    // Adults pass the gate, as a party guest's band at check-in does.
    expect(bands.filter((b) => b.kind === 'adult').every((b) => b.gateAccess)).toBe(true);
    expect(await socksHeld()).toBe(held - 10);

    // The receipt lists what the price covers and reads the balance.
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, answer.sale.id));
    const receipt = saleReceiptDocument(await salePrintSnapshotOf(ctx.db, row!));
    expect(receipt.lines.map((l) => l.name)).toEqual(
      expect.arrayContaining(['Floresta Birthday', ...FLORESTA.included_lines.map((l) => l.label), 'Regular Socks (free)']),
    );
    expect(receipt.lines.find((l) => l.name === 'Birthday set menu')!.price).toBe('฿0');
    expect(receipt.tenders!.map((t) => t.label)).toEqual(['Deposit paid in advance', 'Cash', 'Cash tendered', 'Change']);
    expect(receipt.tenders![0]!.amount).toBe('฿3,000');
    expect(receipt.tenders![1]!.amount).toBe('฿13,900');

    // The close's write-back reached the app's directory: the sale's id, under the edit's own id.
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]).toMatchObject({ eventId: party, body: { fields: { posSaleId: answer.sale.id } } });
    expect(Object.keys(editCalls[0]!.body.fields)).toEqual(['posSaleId']);
  });

  it('on the close, the sale id is written back to the OTO App through the party edit path', async () => {
    const [row] = await ctx.db.select().from(partySettlement).where(eq(partySettlement.id, answer.settlement.id));
    expect(row!.settledAt).not.toBeNull();
    const [edit] = await ctx.db.select().from(partyEdit).where(eq(partyEdit.id, row!.writeBackEditId!));
    expect(edit).toMatchObject({ otoappEventId: party, fields: { posSaleId: answer.sale.id }, syncState: 'synced' });
    const res = await detail(party);
    expect(res.body.event.party!.settlement).toMatchObject({
      state: 'settled',
      receiptNumber: expect.any(String),
      writeBack: 'synced',
    });
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'party.settle'), eq(auditLog.entityId, answer.settlement.id)));
    expect(audits).toHaveLength(1);
  });

  it('a retry of the close writes nothing back twice', async () => {
    const again = await finalise(answer.sale.id);
    expect(again.status).toBe(200);
    expect(editCalls).toHaveLength(0);
    const [row] = await ctx.db.select().from(partySettlement).where(eq(partySettlement.id, answer.settlement.id));
    const [edit] = await ctx.db.select().from(partyEdit).where(eq(partyEdit.id, row!.writeBackEditId!));
    expect(edit!.syncAttempts).toBe(1);
  });
});

// =============================================================================
// Floresta, weekend: 12 children and 6 adults
// =============================================================================

describe('Floresta weekend: 12 children and 6 adults are 20,900 + 2 × 1,500 + 2 × 500', () => {
  const party = newId();

  it('prices the extras at the package\'s own weekend prices, never the tier rate', async () => {
    await appParty(party, "Ploy's 8th", SATURDAY, 20_900, 0);
    await appPlan(party, SATURDAY, FLORESTA, { kids: 12, adults: 6 });
    const res = await settle(party, { kids: 12, adults: 6, socksGiven: 12, extraChildren: 2, extraAdults: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.quote).toMatchObject({
      rateMode: 'weekend',
      packageSatang: 2_090_000,
      extraChildren: 2,
      extraChildrenSatang: 300_000,
      extraAdults: 2,
      extraAdultsSatang: 100_000,
      freeSocks: 12,
      totalSatang: 2_490_000,
      depositSatang: 0,
      balanceSatang: 2_490_000,
    });
    const lines = await linesOf(res.body.sale.id);
    expect(lines.filter((l) => l.kind === 'kids').map((l) => [l.label, l.quantity, l.unitSatang])).toEqual([
      ['Children (in the package)', 10, 0],
      ['Extra child', 2, 150_000],
    ]);
    expect(lines.find((l) => l.kind === 'adults_paid')).toMatchObject({ label: 'Extra adult', quantity: 2, unitSatang: 50_000 });
    // Socks for all children: the extras' too, all free.
    expect(lines.filter((l) => l.kind === 'socks').reduce((n, l) => n + l.quantity, 0)).toBe(12);
    expect(lines.filter((l) => l.kind === 'socks').every((l) => l.grossSatang === 0)).toBe(true);

    const closed = await finalise(res.body.sale.id);
    expect(closed.body.finalised).toBe(true);
    const bands = await ctx.db.select().from(band).where(eq(band.saleId, res.body.sale.id));
    expect(bands.filter((b) => b.kind === 'kid')).toHaveLength(12);
    expect(bands.filter((b) => b.kind === 'adult')).toHaveLength(6);
  });

  it('a weekday inside a branch holiday is priced at the weekend rate', async () => {
    const holiday = newId();
    await appParty(holiday, 'Holiday party', HOLIDAY_TUESDAY, 20_900, 0);
    await appPlan(holiday, HOLIDAY_TUESDAY, FLORESTA);
    const res = await preview(holiday, { kids: 10, adults: 4, socksGiven: 0 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.quote).toMatchObject({ rateMode: 'weekend', packageSatang: 2_090_000 });
  });
});

// =============================================================================
// After School 10: parents included, no socks, the extra-child rule it carries
// =============================================================================

describe('After School 10 with 12 children: parents included, socks sold, the package\'s extra-child rule', () => {
  it('charges the 2 children beyond 10 at the package\'s extra-child price, its 10 parents nothing, and the socks at the shelf price', async () => {
    const party = newId();
    await appParty(party, 'After school party', WEEKDAY, 10_900, 0);
    await appPlan(party, WEEKDAY, AFTER_SCHOOL_10, { kids: 12, adults: 10 });
    const res = await settle(party, { kids: 12, adults: 10, socksGiven: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.quote).toMatchObject({
      packageSatang: 1_090_000,
      extraChildren: 2,
      extraChildrenSatang: 218_000,
      extraAdults: 0,
      freeSocks: 0,
      paidSocks: 2,
      socksSatang: 2 * socksPriceSatang,
      totalSatang: 1_090_000 + 218_000 + 2 * socksPriceSatang,
    });
    const lines = await linesOf(res.body.sale.id);
    expect(lines.find((l) => l.kind === 'adults_free')).toMatchObject({ quantity: 10, grossSatang: 0 });
    expect(lines.filter((l) => l.kind === 'socks').map((l) => [l.label, l.quantity])).toEqual([['Regular Socks', 2]]);
  });

  it('an eleventh adult on a package with no extra-adult price is refused by name', async () => {
    const party = newId();
    await appParty(party, 'After school, eleven adults', WEEKDAY, 10_900, 0);
    await appPlan(party, WEEKDAY, AFTER_SCHOOL_10);
    const res = await preview(party, { kids: 10, adults: 11, socksGiven: 0 });
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: { code: string } }).error.code).toBe('PARTY_EXTRA_ADULT_NOT_PRICED');
  });
});

// =============================================================================
// The add-ons: the reserved table is F&B credit in full
// =============================================================================

describe('add-ons and entertainment from the plan', () => {
  it('the reserved table grants 5,000 of F&B credit at the close and prints its credit voucher on the receipt', async () => {
    const party = newId();
    await appParty(party, 'Party with a table', WEEKDAY, 16_900, 0);
    await appPlan(party, WEEKDAY, FLORESTA, { addOns: [TABLE, BALLOONS], entertainment: [ZOMBIE] });
    const res = await settle(party, {
      kids: 10,
      adults: 4,
      socksGiven: 0,
      addOnIds: [TABLE.template_id],
      entertainmentIds: [ZOMBIE.template_id],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.quote).toMatchObject({
      addOnsSatang: 500_000,
      entertainmentSatang: 400_000 + 2 * 40_000,
      creditSatang: 500_000,
      totalSatang: 1_690_000 + 500_000 + 480_000,
    });
    // The balloons were not kept, so they are not on the sale.
    const lines = await linesOf(res.body.sale.id);
    expect(lines.some((l) => l.label === BALLOONS.name)).toBe(false);
    expect(lines.find((l) => l.label === 'Zombie game — extra child')).toMatchObject({ quantity: 2, unitSatang: 40_000 });

    const closed = await finalise(res.body.sale.id);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const grants = closed.body.grants as Array<{ creditSatang: number; holderName: string | null; qrCode: string }>;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ creditSatang: 500_000, holderName: 'Reserved table for adults · Nok' });
    expect(grants[0]!.qrCode).not.toBe('');
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, res.body.sale.id));
    const receipt = saleReceiptDocument(await salePrintSnapshotOf(ctx.db, row!));
    expect(receipt.creditVouchers).toEqual([
      expect.objectContaining({ balance: '฿5,000', holderName: 'Reserved table for adults · Nok' }),
    ]);
  });

  it('refuses an add-on that is not in the plan', async () => {
    const party = newId();
    await appParty(party, 'Party, stale add-on', WEEKDAY, 16_900, 0);
    await appPlan(party, WEEKDAY, FLORESTA, { addOns: [TABLE] });
    const res = await preview(party, { kids: 10, adults: 4, socksGiven: 0, addOnIds: ['not-in-the-plan'] });
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: { code: string } }).error.code).toBe('PARTY_PLAN_LINE_UNKNOWN');
  });
});

// =============================================================================
// Void and settle again; the deposit tender row
// =============================================================================

describe('a settlement left unpaid is voided, and the party may be settled again', () => {
  it('voids the open sale with its deposit record, and a second settlement then goes through', async () => {
    const party = newId();
    await appParty(party, 'Party settled twice', WEEKDAY, 16_900, 2_000);
    await appPlan(party, WEEKDAY, FLORESTA, { depositSatang: 200_000 });
    const first = await settle(party, { kids: 10, adults: 4, socksGiven: 0 });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const voided = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${first.body.sale.id}/void`,
      payload: { reason: 'Party settled with the wrong count' },
      headers: { cookie: reception },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    const [deposit] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, first.body.sale.id));
    expect(deposit!.status).toBe('cancelled');

    const second = await settle(party, { kids: 9, adults: 4, socksGiven: 0 });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.sale.outstandingSatang).toBe(1_690_000 - 200_000);
    const [old] = await ctx.db.select().from(partySettlement).where(eq(partySettlement.id, first.body.settlement.id));
    expect(old!.releasedAt).not.toBeNull();
  });

  it('refuses to settle a party whose tab already took money for the package, so it is never charged twice', async () => {
    const party = newId();
    await appParty(party, 'Party paid on the tab', WEEKDAY, 16_900, 0);
    await appPlan(party, WEEKDAY, FLORESTA);
    const paid = await call('POST', reception, `/parties/${party}/payments`, {
      branchId: central,
      stationId: till,
      paymentId: newId(),
      actionId: newId(),
      amountSatang: 100_000,
      tender: { method: 'cash', kind: 'cash' },
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const res = await settle(party, { kids: 10, adults: 4, socksGiven: 0 });
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: { code: string; details: unknown } }).error).toMatchObject({
      code: 'PARTY_PAID_ON_TAB',
      details: { paidOnTabSatang: 100_000, tabChargesSatang: 0 },
    });
  });

  it('the deposit tender is the platform\'s own, as paid-online and credit are: never a row, never a tender a till names', async () => {
    // The settlements above recorded their deposits with no row under the code.
    expect(await ctx.db.select().from(paymentMethod).where(eq(paymentMethod.code, PARTY_DEPOSIT_TENDER.code))).toHaveLength(0);
    // The park's tender list refuses the code, so it can never become a button on the grid.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/payment-methods',
      payload: { code: PARTY_DEPOSIT_TENDER.code, label: 'Deposit', kind: 'other' },
      headers: { cookie: admin },
    });
    expect(created.statusCode, created.body).toBe(400);
    expect(created.json().error.details).toMatchObject({ code: PARTY_DEPOSIT_TENDER.code, reserved: [PARTY_DEPOSIT_TENDER.code] });
    expect(await ctx.db.select().from(paymentMethod).where(eq(paymentMethod.code, PARTY_DEPOSIT_TENDER.code))).toHaveLength(0);
    // A till naming it as the tender it took money in is refused, whatever kind it declares.
    const party = newId();
    await appParty(party, 'Party paid with the deposit word', WEEKDAY, 16_900, 0);
    for (const kind of ['other', 'cash']) {
      const paid = await call<{ error: { message: string } }>('POST', reception, `/parties/${party}/payments`, {
        branchId: central,
        stationId: till,
        paymentId: newId(),
        actionId: newId(),
        amountSatang: 100_000,
        tender: { method: PARTY_DEPOSIT_TENDER.code, kind },
      });
      expect(paid.status, kind).toBe(400);
      expect(paid.body.error.message).toContain("party's deposit");
    }
    expect((await detail(party)).body.event.party!.payments).toHaveLength(0);
  });
});

// =============================================================================
// Walk-ups the board already put on the tab
// =============================================================================

describe('a party with walk-up guests already on its tab', () => {
  const party = newId();

  beforeAll(async () => {
    await appParty(party, 'Party with a walk-up', WEEKDAY, 16_900, 3_000);
    await appPlan(party, WEEKDAY, FLORESTA, { depositSatang: 300_000 });
    const walkUp = await call<{ attendee: { billing: string; priceSatang: number } }>('POST', reception, `/events/${party}/attendees`, {
      branchId: central,
      stationId: till,
      attendeeId: newId(),
      actionId: newId(),
      registerProperly: false,
      attendee: { name: 'ZZ TEST Walk-up', parentName: 'May' },
    });
    expect(walkUp.status, JSON.stringify(walkUp.body)).toBe(200);
    expect(walkUp.body.attendee.billing).toBe('party_tab');
  });

  it('the preview names them and what they came to on the tab, and prices the package without them', async () => {
    const [link] = (await detail(party)).body.event.party!.walkUpCharges;
    const res = await preview(party, { kids: 11, adults: 4, socksGiven: 11 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.quote).toMatchObject({ walkUps: 1, walkUpsSatang: link!.amountSatang, extraChildren: 1 });
    expect(link!.amountSatang).toBeGreaterThan(0);
  });

  it('the settlement is refused by name with nothing written, so no guest is charged or banded twice', async () => {
    const sales = (await ctx.db.select({ id: sale.id }).from(sale)).length;
    const body = settleBody({ kids: 11, adults: 4, socksGiven: 11 });
    const res = await call<{ error: { code: string; details: Record<string, unknown> } }>('POST', reception, `/parties/${party}/settle`, body);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'PARTY_WALK_UPS_ON_TAB', details: { walkUps: 1 } });
    expect((await ctx.db.select({ id: sale.id }).from(sale)).length).toBe(sales);
    expect(await ctx.db.select().from(partySettlement).where(eq(partySettlement.id, body.settlementId as string))).toHaveLength(0);
    // The party's balance stays on its tab, as before: the package, the walk-up, less the deposit.
    const bill = (await detail(party)).body.event.party!.bill!;
    expect(bill).toMatchObject({ baseSatang: 1_690_000, depositSatang: 300_000 });
    expect(bill.chargesSatang).toBeGreaterThan(0);
  });
});

// =============================================================================
// The balance paid by QR, with the till gone
// =============================================================================

describe('a settlement balance paid by QR through the gateway, with no till close after it', () => {
  it('the gateway closes the sale and the OTO App is told which sale settled the party', async () => {
    const party = newId();
    await appParty(party, 'Party paid by QR', WEEKDAY, 16_900, 3_000);
    await appPlan(party, WEEKDAY, FLORESTA, { depositSatang: 300_000 });
    const [before] = await ctx.db.select({ routing: station.paymentRouting }).from(station).where(eq(station.id, till));
    await ctx.db.update(station).set({ paymentRouting: { qr: 'gateway' } }).where(eq(station.id, till));
    try {
      const settled = await settle(party, { kids: 10, adults: 4, socksGiven: 0 });
      expect(settled.status, JSON.stringify(settled.body)).toBe(200);
      const saleId = settled.body.sale.id;
      expect(settled.body.sale).toMatchObject({ status: 'tendering', outstandingSatang: 1_390_000 });

      const started = await call<{ route: string; attempt: { id: string; amountSatang: number } | null }>(
        'POST',
        reception,
        '/payments/attempts',
        { saleId, tender: 'qr', method: 'promptpay', kind: 'qr', requestQrPayload: true, qrDirection: 'show', actionId: newId() },
      );
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      expect(started.body.route).toBe('gateway');
      expect(started.body.attempt).toMatchObject({ amountSatang: 1_390_000 });
      expect(editCalls).toHaveLength(0);

      // Nobody presses anything more: only the gateway answers.
      await simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId: started.body.attempt!.id, event: 'paid', operatorId });
      const [closed] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
      expect(closed).toMatchObject({ status: 'finalised' });
      expect(closed!.receiptNumber).toBeTruthy();
      expect(editCalls).toEqual([expect.objectContaining({ eventId: party, body: expect.objectContaining({ fields: { posSaleId: saleId } }) })]);
      const [row] = await ctx.db.select().from(partySettlement).where(eq(partySettlement.id, settled.body.settlement.id));
      expect(row!.settledAt).not.toBeNull();
      const [edit] = await ctx.db.select().from(partyEdit).where(eq(partyEdit.id, row!.writeBackEditId!));
      expect(edit).toMatchObject({ fields: { posSaleId: saleId }, syncState: 'synced' });
    } finally {
      await ctx.db.update(station).set({ paymentRouting: before!.routing }).where(eq(station.id, till));
    }
  });
});

// =============================================================================
// SCRUM-828 — the items the BEO added that the catalogue did not have
// =============================================================================

describe('SCRUM-828: a priced item the BEO added is charged on the settlement; a free one is a 0-baht line', () => {
  const party = newId();
  const plain = newId();
  let cake: { code: string; productId: string };
  let juice: { code: string; productId: string };
  const PIZZA_CODE = 'ZZ-828-PIZZA';
  let plainTotal: number;

  const setMenuLine = (code: string, name: string, qty: number | null) => ({
    product_code: code,
    name,
    qty,
    choice_group: null,
    chosen_option: null,
    note: null,
  });

  beforeAll(async () => {
    // Made as the BEO's "New item" makes them, by the platform's own service.
    const made = (name: string, station: 'kitchen' | 'bar', priceSatang: number | null) =>
      createPartyMenuProduct(
        ctx.db,
        { requestId: 'zz-test-828-settlement' },
        {
          operatorId,
          idempotencyKey: newId(),
          branchId: central,
          name,
          station,
          priceSatang,
          free: priceSatang === null,
          source: { eventId: party, lineLabel: name },
          // Nobody the platform knows: the item is made all the same.
          actorAppUserId: 'zz-test-828-app-user',
        },
      );
    cake = await made('ZZ TEST unicorn cake', 'kitchen', 45_000);
    juice = await made('ZZ TEST free juice', 'bar', null);
    // A catalogue item the Console flagged BEO-only, named by the set menu: part of the package, never charged.
    await ctx.db.insert(product).values({
      id: newId(),
      operatorId,
      branchId: central,
      kind: 'menu',
      code: PIZZA_CODE,
      name: 'ZZ TEST party pizza',
      priceSatang: 30_000,
      beoOnly: true,
    });

    await appParty(party, 'Party with a special cake', WEEKDAY, 16_900, 3_000);
    await appPlan(party, WEEKDAY, FLORESTA, {
      depositSatang: 300_000,
      setMenu: [
        setMenuLine(PIZZA_CODE, 'ZZ TEST party pizza', 1),
        setMenuLine(cake.code, 'ZZ TEST unicorn cake', 1),
        setMenuLine(juice.code, 'ZZ TEST free juice', 3),
        // The same cake on the adults' list too: one charge, the quantities added up.
        setMenuLine(cake.code, 'ZZ TEST unicorn cake', 1),
      ],
    });
    // The same party with none of them, to measure against.
    await appParty(plain, 'Party without a special cake', WEEKDAY, 16_900, 3_000);
    await appPlan(plain, WEEKDAY, FLORESTA, { depositSatang: 300_000 });
    const base = await preview(plain, { kids: 10, adults: 4, socksGiven: 0 });
    expect(base.status, JSON.stringify(base.body)).toBe(200);
    plainTotal = base.body.quote.totalSatang;
  });

  it('the preview adds the priced item at its product\'s price, names the free one at ฿0, and leaves the catalogue item out', async () => {
    const res = await preview(party, { kids: 10, adults: 4, socksGiven: 0 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const q = res.body.quote;
    expect(q.lines.filter((l) => l.label.startsWith('ZZ TEST'))).toEqual([
      { role: 'add_on', label: 'ZZ TEST unicorn cake', quantity: 2, unitSatang: 45_000, totalSatang: 90_000 },
      { role: 'included', label: 'ZZ TEST free juice', quantity: 3, unitSatang: 0, totalSatang: 0 },
    ]);
    expect(q.addOnsSatang).toBe(90_000);
    expect(q.totalSatang).toBe(plainTotal + 90_000);
    expect(q.balanceSatang).toBe(plainTotal + 90_000 - 300_000);
  });

  it('settles with them on the sale: the cake as F&B at 2 × 450, the juice at ฿0, the receipt naming both', async () => {
    const res = await settle(party, { kids: 10, adults: 4, socksGiven: 0, expectedTotalSatang: plainTotal + 90_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sale.grossSatang).toBe(plainTotal + 90_000);
    const lines = await linesOf(res.body.sale.id);
    expect(lines.find((l) => l.componentKey === `party_menu:${cake.code}`)).toMatchObject({
      kind: 'addon',
      label: 'ZZ TEST unicorn cake',
      quantity: 2,
      unitSatang: 45_000,
      grossSatang: 90_000,
      taxableCategory: 'fnb',
    });
    expect(lines.find((l) => l.componentKey === `party_menu:${juice.code}`)).toMatchObject({
      label: 'ZZ TEST free juice',
      quantity: 3,
      grossSatang: 0,
    });
    expect(lines.some((l) => l.label === 'ZZ TEST party pizza')).toBe(false);

    const closed = await finalise(res.body.sale.id, { method: 'cash', tenderedSatang: res.body.sale.outstandingSatang });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, res.body.sale.id));
    const receipt = saleReceiptDocument(await salePrintSnapshotOf(ctx.db, row!));
    expect(receipt.lines.find((l) => l.name === 'ZZ TEST unicorn cake')).toBeDefined();
    expect(receipt.lines.find((l) => l.name === 'ZZ TEST free juice')!.price).toBe('฿0');
  });
});

// =============================================================================
// SCRUM-876 — a settlement left before its balance is taken
// =============================================================================

/**
 * Staff press Settle party, confirm the counts, and leave the "Take the
 * balance" step before any tender: the sale stays `tendering` with only the
 * party's deposit on it. The deposit was paid in the OTO App and is not money
 * the till took, so the sale is UNPAID — not part-paid: it never stands in the
 * End of Day's way, History voids it, the party page cancels it, and the
 * party may be settled again with the same deposit. Nothing is refunded by
 * any of this; the deposit stays exactly as it was.
 */
describe('SCRUM-876 — a settlement left before its balance', () => {
  const voidSale = (cookie: string, saleId: string, reason: string, key = newId()) =>
    ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/void`,
      payload: { reason },
      headers: { cookie, 'idempotency-key': key },
    });
  type OpenRow = { saleId: string; kind: string; paidSatang: number; balanceSatang: number; held: boolean };
  const endOfDay = async (saleId: string) => {
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${central}/end-of-day?date=${row!.businessDate}`,
      headers: { cookie: admin },
    });
    expect(res.statusCode, res.body).toBe(200);
    return { date: row!.businessDate, record: res.json() as { openSales?: { partPaid: number; rows: OpenRow[] } } };
  };
  const closeDay = (date: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/branches/${central}/end-of-day/close`,
      headers: { cookie: admin, 'idempotency-key': newId() },
      payload: { date, actuals: [], countedSatang: null, floatLeftSatang: null, override: { reason: 'ZZ TEST rehearsal day' } },
    });
  const depositOf = async (saleId: string) =>
    (await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).filter(
      (a) => a.methodCode === PARTY_DEPOSIT_TENDER.code,
    );

  it('with only the deposit on it, the open settlement is not a part-paid sale: End of Day does not list it', async () => {
    const party = newId();
    await appParty(party, 'ZZ TEST party left at the balance', WEEKDAY, 16_900, 2_000);
    await appPlan(party, WEEKDAY, FLORESTA, { depositSatang: 200_000 });
    const opened = await settle(party, { kids: 10, adults: 4, socksGiven: 0 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body.sale).toMatchObject({ status: 'tendering', outstandingSatang: 1_490_000 });
    const [deposit] = await depositOf(opened.body.sale.id);
    expect(deposit).toMatchObject({ status: 'approved', amountSatang: 200_000, stationId: null });

    // History reads the deposit as the party's, not the till's.
    const read = await call<{ attempts: { id: string; partyDeposit?: boolean }[] }>('GET', reception, `/sales/${opened.body.sale.id}`);
    expect(read.status).toBe(200);
    expect(read.body.attempts).toEqual([expect.objectContaining({ id: deposit!.id, partyDeposit: true })]);

    const { record } = await endOfDay(opened.body.sale.id);
    expect(record.openSales!.rows.find((r) => r.saleId === opened.body.sale.id)).toBeUndefined();
  });

  it('voided from History or the party page, the deposit stays as it was and the next settlement uses it; nothing is refunded', async () => {
    const party = newId();
    await appParty(party, 'ZZ TEST party cancelled and settled again', WEEKDAY, 16_900, 2_000);
    await appPlan(party, WEEKDAY, FLORESTA, { depositSatang: 200_000 });
    const first = await settle(party, { kids: 10, adults: 4, socksGiven: 0 });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const saleId = first.body.sale.id;
    const [before] = await depositOf(saleId);

    const key = newId();
    const voided = await voidSale(reception, saleId, 'ZZ TEST parent will pay later', key);
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json()).toMatchObject({ replay: false, sale: { status: 'voided' }, void: { reason: 'ZZ TEST parent will pay later' } });
    // The same press again is answered as the press it was, and a void of a voided sale is a replay.
    const again = await voidSale(reception, saleId, 'ZZ TEST parent will pay later', key);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(voided.json());
    expect((await voidSale(reception, saleId, 'ZZ TEST once more')).json().replay).toBe(true);

    // THE MONEY RULE: the deposit's record is cancelled with the sale and nothing was refunded.
    const [after] = await depositOf(saleId);
    expect(after).toMatchObject({ id: before!.id, status: 'cancelled', amountSatang: 200_000 });
    expect((after!.payload as { cancelledWithSale?: { reason: string } }).cancelledWithSale?.reason).toBe('ZZ TEST parent will pay later');
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, saleId))).toHaveLength(0);
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.void')))).toHaveLength(1);

    // The party page: the settlement is released, the party's deposit untouched.
    const read = await detail(party);
    expect(read.body.event.party!.settlement).toMatchObject({ id: first.body.settlement.id, state: 'voided' });
    expect(read.body.event.party!.depositSatang).toBe(200_000);
    expect(read.body.event.party!.payments).toHaveLength(0);

    // The next settlement takes the same deposit again, on its own sale.
    const second = await settle(party, { kids: 10, adults: 4, socksGiven: 0 });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.sale.id).not.toBe(saleId);
    expect(second.body.sale.outstandingSatang).toBe(1_690_000 - 200_000);
    expect(second.body.settlement).toMatchObject({ state: 'open', depositSatang: 200_000, paidSatang: 200_000 });
    const [onSecond] = await depositOf(second.body.sale.id);
    expect(onSecond).toMatchObject({ status: 'approved', amountSatang: 200_000 });
    const [old] = await ctx.db.select().from(partySettlement).where(eq(partySettlement.id, first.body.settlement.id));
    expect(old!.releasedAt).not.toBeNull();
  });

  it("is voided only by an account allowed to void a sale at the party's branch", async () => {
    const party = newId();
    await appParty(party, 'ZZ TEST party another park cannot cancel', WEEKDAY, 16_900, 2_000);
    await appPlan(party, WEEKDAY, FLORESTA, { depositSatang: 200_000 });
    const opened = await settle(party, { kids: 10, adults: 4, socksGiven: 0 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const elsewhere = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const refused = await voidSale(elsewhere, opened.body.sale.id, 'ZZ TEST not my park');
    expect(refused.statusCode).toBe(403);
    const [deposit] = await depositOf(opened.body.sale.id);
    expect(deposit!.status).toBe('approved');
    expect((await detail(party)).body.event.party!.settlement).toMatchObject({ state: 'open' });
  });

  it('a settlement that took part of its balance in cash is part-paid by that cash alone, and a whole refund gives back the cash only', async () => {
    const party = newId();
    await appParty(party, 'ZZ TEST party part-paid then refunded', WEEKDAY, 16_900, 2_000);
    await appPlan(party, WEEKDAY, FLORESTA, { depositSatang: 200_000 });
    const opened = await settle(party, { kids: 10, adults: 4, socksGiven: 0 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const saleId = opened.body.sale.id;
    const part = await finalise(saleId, { method: 'cash', amountSatang: 100_000, tenderedSatang: 100_000 });
    expect(part.status, JSON.stringify(part.body)).toBe(200);
    expect(part.body).toMatchObject({ finalised: false, outstandingSatang: 1_390_000 });

    const { record } = await endOfDay(saleId);
    expect(record.openSales!.rows.find((r) => r.saleId === saleId)).toMatchObject({
      kind: 'part_paid',
      held: false,
      paidSatang: 100_000,
      balanceSatang: 1_390_000,
    });

    const refunded = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/refunds`,
      headers: { cookie: admin, 'idempotency-key': newId() },
      payload: { mode: 'whole', reason: 'ZZ TEST party cancelled', actionId: newId() },
    });
    expect(refunded.statusCode, refunded.body).toBe(200);
    expect(refunded.json()).toMatchObject({ refund: { amountSatang: 100_000 }, sale: { status: 'voided' }, refundStatus: 'refunded', refundableSatang: 0 });
    const slices = refunded.json().refund.tenderAllocation as { route: string; amountSatang: number; method: string }[];
    expect(slices.reduce((sum, s) => sum + s.amountSatang, 0)).toBe(100_000);
    expect(slices.every((s) => s.method === 'cash')).toBe(true);
    const [deposit] = await depositOf(saleId);
    expect(deposit).toMatchObject({ status: 'cancelled', amountSatang: 200_000 });
    expect((await detail(party)).body.event.party!.settlement).toMatchObject({ state: 'voided' });
    const second = await settle(party, { kids: 10, adults: 4, socksGiven: 0 });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.sale.outstandingSatang).toBe(1_490_000);
  });

  it('Close Day is not refused over a settlement left with only its deposit', async () => {
    const party = newId();
    await appParty(party, 'ZZ TEST party left open at close', WEEKDAY, 16_900, 2_000);
    await appPlan(party, WEEKDAY, FLORESTA, { depositSatang: 200_000 });
    const opened = await settle(party, { kids: 10, adults: 4, socksGiven: 0 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const { date, record } = await endOfDay(opened.body.sale.id);
    expect(record.openSales!.rows.find((r) => r.saleId === opened.body.sale.id)).toBeUndefined();
    const closed = await closeDay(date);
    expect(closed.statusCode, closed.body).toBe(200);
  });
});
