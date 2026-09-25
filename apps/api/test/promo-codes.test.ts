import {
  createHash,
  generateKeyPairSync,
  randomInt,
  sign as signDetached,
  type KeyObject,
} from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  alert,
  auditLog,
  box,
  branch,
  discountDefinition,
  member,
  product,
  sale,
  saleDiscount,
  saleLine,
  station,
  ticketPackage,
  voucher,
  voucherDefinition,
} from '@oto/db';
import {
  SYNC_EVENT_SCHEMA_VERSION,
  businessDate,
  canonicalSyncBytes,
  mintBoothCode,
  newId,
  parseDayStart,
  type SyncEventEnvelope,
  type SyncPushResponse,
} from '@oto/shared';
import { boxCredential } from '@oto/box-agent';
import {
  ADMIN,
  CHALONG_MANAGER,
  RECEPTION,
  boxBySlot,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { issueClaimCode } from '../src/services/box';
import { commitSale, quoteSale, type ActorContext } from '../src/services/sale';

/**
 * SCRUM-401 — A PROMO CODE IS PRICED FROM THE PARK'S DEFINITION, NEVER FROM THE
 * TILL'S DESCRIPTION OF IT.
 *
 * The closing audit's M13: a reception session sending
 * `promos: [{ code: 'NOSUCHCODE', type: 'fixed', value: 89000 }]` got a free
 * ticket, and STAFF10 sent as 100 % was filed under the park's own code. Every
 * case here goes in through the real routes with real sessions at real tills
 * (or, where the case is about a clock, through the service at a chosen
 * instant), and then reads the rows that landed.
 *
 * THE TILL'S DESCRIPTION IS WRONG ON PURPOSE in most cases below — worth ten
 * tickets (`described`) — so a code priced at the definition's value cannot be
 * mistaken for one priced at the till's.
 *
 * THE FIXTURES are the seeded park: Reception Till 1 (T1) at Central Floresta,
 * Reception Till 1 (T3) at Robinson Chalong; 2 Hours Play at ฿890 a kid at the
 * tourist rate; the seeded codes STAFF10 (10 %, stackable), MEMBER20 (20 %,
 * stackable) and ICECREAM (a free Ice Cream Cone). James is the seeded expat
 * member, Mali the thai one.
 */

let ctx: TestContext;
/** Reception, standing at Reception Till 1 (Central Floresta). */
let tillA: string;
/** The Chalong manager, standing at Chalong's till. */
let chalongTill: string;

let operatorId: string;
let hktId: string;
let chalongId: string;
let hktName: string;
let chalongName: string;
let timezone: string;
let dayStart: string;
let t1: typeof station.$inferSelect;
let t3: typeof station.$inferSelect;
let receptionAccountId: string;
let twoHoursHkt: string;
let twoHoursChalong: string;
let iceCreamId: string;
let iceCreamName: string;
let iceCreamSatang: number;
let juiceId: string;
let juiceSatang: number;
let jamesId: string;
let maliId: string;

/** Satang from baht, so the fixtures read like the price list. */
const b = (baht: number): number => Math.round(baht * 100);
const KID = b(890);

/**
 * A code set up nowhere — unknown, archived or switched off alike — in the
 * till's own words for a code its copy does not hold (SCRUM-441).
 */
const unknown = (code: string): string => `Code "${code}" was not found.`;
/** A live code set up for another branch: not here, and where it is (SCRUM-441). */
const elsewhere = (code: string, branchName: string): string =>
  `Code "${code}" isn't set up at this branch yet — it is only valid at ${branchName}.`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "26 Sep 2026", the way a refusal names a date. */
const day = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};
/** A yyyy-mm-dd moved by whole days. */
const shift = (iso: string, days: number): string => {
  const at = new Date(`${iso}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

async function pick(cookie: string, stationId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: '/me/session/station',
    headers: { cookie },
    payload: { stationId },
  });
  if (res.statusCode !== 200)
    throw new Error(`station pick failed (${res.statusCode}): ${res.body}`);
}

/** A discount code as the Discounts panel would save one: 10 % off the order unless told otherwise. */
async function define(
  code: string,
  values: Partial<typeof discountDefinition.$inferInsert> = {},
): Promise<string> {
  const id = newId();
  await ctx.db.insert(discountDefinition).values({
    id,
    operatorId,
    code,
    label: code,
    kind: 'percent',
    valueBp: 1000,
    ...values,
  } as typeof discountDefinition.$inferInsert);
  return id;
}

/** A fixed-amount definition's values. */
const fixed = (satang: number): Partial<typeof discountDefinition.$inferInsert> => ({
  kind: 'fixed',
  valueBp: null,
  valueSatang: satang,
});

/**
 * A code as a till might describe it — worth ten tickets. None of it is meant
 * to reach the money: every accepted case below comes out at the definition.
 */
const described = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  label: code,
  type: 'fixed',
  value: KID * 10,
  ...over,
});

const quote = (cookie: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/sales/quote', headers: { cookie }, payload });

const commit = (cookie: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie }, payload });

/** The till's cash step with nothing typed: the balance, in cash. */
const finalise = (cookie: string, saleId: string) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie } });

const voidSale = (cookie: string, saleId: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/void`,
    headers: { cookie },
    payload: { reason: 'Guest left before paying' },
  });

const kidLine = (packageId = twoHoursHkt) => ({ id: newId(), packageId, kids: 1, adults: 0 });

/** A walk-in's ticket cart at a till. */
const kids = (opts: { stationId?: string; packageId?: string } = {}) => ({
  stationId: opts.stationId ?? t1.id,
  lines: [kidLine(opts.packageId)],
});

async function saleRow(saleId: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId)).limit(1);
  return row;
}

async function promoRows(saleId: string) {
  return ctx.db
    .select()
    .from(saleDiscount)
    .where(and(eq(saleDiscount.saleId, saleId), eq(saleDiscount.kind, 'promo')))
    .orderBy(asc(saleDiscount.sequence));
}

interface QuotedPromo {
  code: string;
  label: string;
  type: string;
  amountSatang: number;
}

interface QuoteBody {
  businessDate: string;
  totals: { subtotalSatang: number; promoDiscountSatang: number; grossSatang: number };
  appliedPromos: QuotedPromo[];
  rejectedPromoCodes: { code: string; reason: string }[];
}

/**
 * Quote a cart, then commit the same cart — and hold the two to the same money
 * to the satang (case h): the same gross, the same promo total, the same
 * amount per code, and the same refusals.
 */
async function quoteAndCommit(cookie: string, cart: Record<string, unknown>) {
  const quoted = await quote(cookie, cart);
  expect(quoted.statusCode, quoted.body).toBe(200);
  const q = quoted.json() as QuoteBody;
  const saleId = newId();
  const rung = await commit(cookie, { id: saleId, ...cart });
  expect(rung.statusCode, rung.body).toBe(200);
  const row = (await saleRow(saleId))!;
  const rows = await promoRows(saleId);
  expect({
    subtotal: row.subtotalSatang,
    promo: row.promoDiscountSatang,
    gross: row.grossSatang,
  }).toEqual({
    subtotal: q.totals.subtotalSatang,
    promo: q.totals.promoDiscountSatang,
    gross: q.totals.grossSatang,
  });
  expect(rows.map((r) => [r.code, r.amountSatang])).toEqual(
    q.appliedPromos.map((p) => [p.code, p.amountSatang]),
  );
  expect(rung.json().rejectedPromoCodes).toEqual(q.rejectedPromoCodes);
  return { quote: q, commit: rung.json(), saleId, sale: row, rows };
}

beforeAll(async () => {
  ctx = await createTestContext();

  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central')!;
  const chalong = branches.find((row) => row.code === 'robinson-chalong')!;
  hktId = hkt.id;
  hktName = hkt.name;
  chalongId = chalong.id;
  chalongName = chalong.name;
  operatorId = hkt.operatorId;
  timezone = hkt.timezone;
  dayStart = hkt.businessDayStart;

  const stations = await ctx.db.select().from(station).where(eq(station.operatorId, operatorId));
  t1 = stations.find((s) => s.branchId === hktId && s.codePrefix === 'T1')!;
  t3 = stations.find((s) => s.branchId === chalongId && s.codePrefix === 'T3')!;

  const packages = await ctx.db
    .select()
    .from(ticketPackage)
    .where(eq(ticketPackage.operatorId, operatorId));
  twoHoursHkt = packages.find((p) => p.branchId === hktId && p.name === '2 Hours Play')!.id;
  twoHoursChalong = packages.find((p) => p.branchId === chalongId && p.name === '2 Hours Play')!.id;

  const products = await ctx.db.select().from(product).where(eq(product.operatorId, operatorId));
  const iceCream = products.find((p) => p.code === 'FB-ICECREAM')!;
  iceCreamId = iceCream.id;
  iceCreamName = iceCream.name;
  iceCreamSatang = iceCream.priceSatang;
  const juice = products.find((p) => p.code === 'FB-JUICE')!;
  juiceId = juice.id;
  juiceSatang = juice.priceSatang;

  const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
  jamesId = members.find((m) => m.phone === '+66822222222')!.id;
  maliId = members.find((m) => m.phone === '+66811111111')!.id;

  const [reception] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.operatorId, operatorId), eq(account.phone, RECEPTION.phone)));
  receptionAccountId = reception!.id;

  tillA = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await pick(tillA, t1.id);
  chalongTill = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  await pick(chalongTill, t3.id);
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- (a) ---------------------------------------------------------------------

describe('a code the park has not set up, has archived or has switched off', () => {
  it('is refused by name on the quote and on the commit, and nothing comes off', async () => {
    await define('RETIRED1', { valueBp: 5000, archivedAt: new Date() });
    await define('PAUSED1', { valueBp: 5000, active: false });
    for (const code of ['NOSUCHCODE', 'RETIRED1', 'PAUSED1']) {
      const run = await quoteAndCommit(tillA, { ...kids(), promos: [described(code)] });
      expect(run.quote.rejectedPromoCodes, code).toEqual([{ code, reason: unknown(code) }]);
      expect(run.quote.appliedPromos, code).toEqual([]);
      expect(run.sale.promoDiscountSatang, code).toBe(0);
      expect(run.sale.grossSatang, code).toBe(KID);
      expect(run.rows, code).toEqual([]);
    }
  });

  it('stops being honoured the moment the park withdraws it, on a till still holding it', async () => {
    const id = await define('WITHDRAWN', fixed(b(100)));
    const cart = () => ({ ...kids(), promos: [described('WITHDRAWN')] });
    const before = await quoteAndCommit(tillA, cart());
    expect(before.quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'WITHDRAWN', amountSatang: b(100) }),
    ]);

    const admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const withdrawn = await ctx.app.inject({
      method: 'DELETE',
      url: `/menu/discounts/${id}`,
      headers: { cookie: admin },
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);

    // The till never reloaded and still sends it.
    const after = await quoteAndCommit(tillA, cart());
    expect(after.quote.rejectedPromoCodes).toEqual([
      { code: 'WITHDRAWN', reason: unknown('WITHDRAWN') },
    ]);
    expect(after.sale.grossSatang).toBe(KID);
  });
});

// --- (b) ---------------------------------------------------------------------

describe('the audit’s probe', () => {
  it('prices STAFF10 at the park’s 10 % when the till sends it as 100 %', async () => {
    const run = await quoteAndCommit(tillA, {
      ...kids(),
      promos: [{ code: 'STAFF10', label: 'Everything free', type: 'percent', value: 100 }],
    });
    expect(run.quote.appliedPromos).toEqual([
      { code: 'STAFF10', label: 'Staff Discount', type: 'percent', amountSatang: b(89) },
    ]);
    expect(run.quote.totals.grossSatang).toBe(KID - b(89));
    expect(run.rows).toEqual([
      expect.objectContaining({
        code: 'STAFF10',
        label: 'Staff Discount',
        discountType: 'percent',
        percentBp: 1000,
        valueSatang: null,
        amountSatang: b(89),
        scope: 'order',
      }),
    ]);
  });

  it('refuses a made-up code worth a whole ticket, so the sale cannot close at ฿0', async () => {
    const probe = { code: 'NOSUCHCODE', label: 'Free ticket', type: 'fixed', value: 89000 };

    // As the probe sent it: close it now, and no total of its own to compare.
    const saleId = newId();
    const rung = await commit(tillA, { id: saleId, ...kids(), promos: [probe], finalise: true });
    expect(rung.statusCode, rung.body).toBe(200);
    expect(rung.json()).toMatchObject({
      finalised: false,
      outstandingSatang: KID,
      rejectedPromoCodes: [{ code: 'NOSUCHCODE', reason: unknown('NOSUCHCODE') }],
    });
    expect(await saleRow(saleId)).toMatchObject({
      status: 'tendering',
      grossSatang: KID,
      promoDiscountSatang: 0,
      receiptNumber: null,
    });
    expect(await promoRows(saleId)).toEqual([]);

    // A till that believed the code and says the guest owes nothing: refused
    // outright, and nothing written.
    const believed = newId();
    const refused = await commit(tillA, {
      id: believed,
      ...kids(),
      promos: [probe],
      expectedTotalSatang: 0,
      finalise: true,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('SALE_TOTAL_MISMATCH');
    expect(await saleRow(believed)).toBeUndefined();
  });
});

// --- (c) ---------------------------------------------------------------------

describe('a code’s window, on the sale’s trading day at its branch', () => {
  it('refuses the day before valid_from and the day after valid_until, and takes both ends', async () => {
    const today = businessDate(new Date(), timezone, parseDayStart(dayStart));
    await define('WINAHEAD', { validFrom: shift(today, 1) });
    await define('WINSTART', { validFrom: today });
    await define('WINLAST', { validUntil: today });
    await define('WINOVER', { validUntil: shift(today, -1) });

    for (const code of ['WINSTART', 'WINLAST']) {
      const run = await quoteAndCommit(tillA, { ...kids(), promos: [described(code)] });
      expect(run.quote.appliedPromos, code).toEqual([
        expect.objectContaining({ code, amountSatang: b(89) }),
      ]);
      expect(run.quote.rejectedPromoCodes, code).toEqual([]);
    }
    const ahead = await quoteAndCommit(tillA, { ...kids(), promos: [described('WINAHEAD')] });
    expect(ahead.quote.rejectedPromoCodes).toEqual([
      { code: 'WINAHEAD', reason: `Code "WINAHEAD" is not valid until ${day(shift(today, 1))}.` },
    ]);
    const over = await quoteAndCommit(tillA, { ...kids(), promos: [described('WINOVER')] });
    expect(over.quote.rejectedPromoCodes).toEqual([
      { code: 'WINOVER', reason: `Code "WINOVER" expired on ${day(shift(today, -1))}.` },
    ]);
    for (const run of [ahead, over]) {
      expect(run.sale.grossSatang).toBe(KID);
      expect(run.rows).toEqual([]);
    }
  });

  it('judges the window on the branch’s trading day, not the UTC day', async () => {
    // 05:30 in Phuket on the 15th: the park has been trading on the 15th since
    // 05:00, and it is still the 14th in UTC.
    const trading = '2026-10-15';
    const instant = new Date(`${trading}T05:30:00+07:00`);
    expect(instant.toISOString().slice(0, 10)).toBe('2026-10-14');
    expect(businessDate(instant, timezone, parseDayStart(dayStart))).toBe(trading);

    await define('UTCFROM', { validFrom: trading });
    await define('UTCUNTIL', { validUntil: '2026-10-14' });
    const actor: ActorContext = { accountId: receptionAccountId, operatorId, branchId: hktId };
    const cartOf = (code: string) => ({
      branchId: hktId,
      stationId: t1.id,
      lines: [kidLine()],
      promos: [described(code) as never],
    });

    // Valid from the 15th: taken, although the UTC day is the 14th.
    const from = (await quoteSale(
      ctx.db,
      actor,
      cartOf('UTCFROM'),
      instant,
    )) as unknown as QuoteBody;
    expect(from.businessDate).toBe(trading);
    expect(from.appliedPromos).toEqual([
      expect.objectContaining({ code: 'UTCFROM', amountSatang: b(89) }),
    ]);
    // Valid until the 14th: refused, although the UTC day is still the 14th.
    const until = (await quoteSale(
      ctx.db,
      actor,
      cartOf('UTCUNTIL'),
      instant,
    )) as unknown as QuoteBody;
    expect(until.rejectedPromoCodes).toEqual([
      { code: 'UTCUNTIL', reason: 'Code "UTCUNTIL" expired on 14 Oct 2026.' },
    ]);

    // The commit at the same instant prices it the same, to the satang.
    const saleId = newId();
    const committed = await ctx.db.transaction((tx) =>
      commitSale(tx, actor, { id: saleId, ...cartOf('UTCFROM') }, instant),
    );
    expect(committed.sale.businessDate).toBe(trading);
    expect(committed.sale.totals.promoDiscountSatang).toBe(from.totals.promoDiscountSatang);
    expect(committed.sale.totals.grossSatang).toBe(from.totals.grossSatang);
    const refusedAtCommit = await ctx.db.transaction((tx) =>
      commitSale(tx, actor, { id: newId(), ...cartOf('UTCUNTIL') }, instant),
    );
    expect(refusedAtCommit.rejectedPromoCodes).toEqual(until.rejectedPromoCodes);
    expect(refusedAtCommit.sale.totals.promoDiscountSatang).toBe(0);
  });

  it('judges the window on the trading day, not the branch’s calendar date', async () => {
    // 00:30 in Phuket on the 16th: the calendar there says the 16th, but the
    // park's trading day runs to 05:00, so this sale is still the 15th's.
    const trading = '2026-10-15';
    const instant = new Date('2026-10-16T00:30:00+07:00');
    expect(businessDate(instant, timezone, parseDayStart(dayStart))).toBe(trading);

    await define('CALUNTIL', { validUntil: trading });
    await define('CALFROM', { validFrom: '2026-10-16' });
    const actor: ActorContext = { accountId: receptionAccountId, operatorId, branchId: hktId };
    const cartOf = (code: string) => ({
      branchId: hktId,
      stationId: t1.id,
      lines: [kidLine()],
      promos: [described(code) as never],
    });

    // Valid until the 15th: taken, although the branch's calendar says the 16th.
    const until = (await quoteSale(
      ctx.db,
      actor,
      cartOf('CALUNTIL'),
      instant,
    )) as unknown as QuoteBody;
    expect(until.businessDate).toBe(trading);
    expect(until.rejectedPromoCodes).toEqual([]);
    expect(until.appliedPromos).toEqual([
      expect.objectContaining({ code: 'CALUNTIL', amountSatang: b(89) }),
    ]);
    // Valid from the 16th: not yet, although the branch's calendar says the 16th.
    const from = (await quoteSale(
      ctx.db,
      actor,
      cartOf('CALFROM'),
      instant,
    )) as unknown as QuoteBody;
    expect(from.rejectedPromoCodes).toEqual([
      { code: 'CALFROM', reason: 'Code "CALFROM" is not valid until 16 Oct 2026.' },
    ]);

    // The commit at the same instant agrees, to the satang.
    const taken = await ctx.db.transaction((tx) =>
      commitSale(tx, actor, { id: newId(), ...cartOf('CALUNTIL') }, instant),
    );
    expect(taken.sale.businessDate).toBe(trading);
    expect(taken.sale.totals.promoDiscountSatang).toBe(until.totals.promoDiscountSatang);
    expect(taken.sale.totals.grossSatang).toBe(until.totals.grossSatang);
    const refused = await ctx.db.transaction((tx) =>
      commitSale(tx, actor, { id: newId(), ...cartOf('CALFROM') }, instant),
    );
    expect(refused.rejectedPromoCodes).toEqual(from.rejectedPromoCodes);
    expect(refused.sale.totals.promoDiscountSatang).toBe(0);
  });
});

// --- (d) ---------------------------------------------------------------------

describe('a code set up for one branch', () => {
  it('is refused at another branch, naming the one it belongs to; an operator-wide code works at both', async () => {
    await define('HKTONLY', { branchId: hktId });
    await define('CHALONGONLY', { branchId: chalongId, ...fixed(b(100)) });
    await define('ANYPARK', fixed(b(50)));

    const atHkt = (code: string) => quoteAndCommit(tillA, { ...kids(), promos: [described(code)] });
    const atChalong = (code: string) =>
      quoteAndCommit(chalongTill, {
        ...kids({ stationId: t3.id, packageId: twoHoursChalong }),
        promos: [described(code)],
      });

    const wrongPark = await atHkt('CHALONGONLY');
    expect(wrongPark.quote.rejectedPromoCodes).toEqual([
      { code: 'CHALONGONLY', reason: elsewhere('CHALONGONLY', chalongName) },
    ]);
    expect(wrongPark.rows).toEqual([]);
    const otherWay = await atChalong('HKTONLY');
    expect(otherWay.quote.rejectedPromoCodes).toEqual([
      { code: 'HKTONLY', reason: elsewhere('HKTONLY', hktName) },
    ]);
    expect(otherWay.rows).toEqual([]);

    expect((await atHkt('HKTONLY')).quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'HKTONLY', amountSatang: b(89) }),
    ]);
    expect((await atChalong('CHALONGONLY')).quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'CHALONGONLY', amountSatang: b(100) }),
    ]);
    for (const run of [await atHkt('ANYPARK'), await atChalong('ANYPARK')]) {
      expect(run.quote.rejectedPromoCodes).toEqual([]);
      expect(run.quote.appliedPromos).toEqual([
        expect.objectContaining({ code: 'ANYPARK', amountSatang: b(50) }),
      ]);
    }
  });
});

/**
 * SCRUM-441 — A CODE REFUSED AS UNKNOWN READS AS THE TILL'S OWN REFUSAL.
 *
 * The till's copy of the codes says "Code X was not found." for a code it does
 * not hold (`handleApplyPromoCode`, apps/pos/src/pages/Till.tsx). The platform,
 * refusing the same code for a till whose copy is stale or on a quote made
 * directly, said "isn't set up at this branch yet", which tells a guest the code
 * works at another park when it works at none. That sentence is kept for the
 * code it is true of — a live code set up for another branch — and names it.
 */
describe('a refused code, in the till’s words (SCRUM-441)', () => {
  it('reads "was not found" for a code set up at no branch, on the quote and on the commit', async () => {
    const run = await quoteAndCommit(tillA, { ...kids(), promos: [described('NOWHERE441')] });
    expect(run.quote.rejectedPromoCodes).toEqual([
      { code: 'NOWHERE441', reason: 'Code "NOWHERE441" was not found.' },
    ]);
    expect(run.commit.rejectedPromoCodes).toEqual(run.quote.rejectedPromoCodes);
    expect(run.rows).toEqual([]);
    expect(run.sale.grossSatang).toBe(KID);
  });

  it('keeps the branch sentence for a code set up at another branch, and names that branch', async () => {
    await define('CHALONG441', { branchId: chalongId });
    const here = await quoteAndCommit(tillA, { ...kids(), promos: [described('CHALONG441')] });
    expect(here.quote.rejectedPromoCodes).toEqual([
      {
        code: 'CHALONG441',
        reason: `Code "CHALONG441" isn't set up at this branch yet — it is only valid at ${chalongName}.`,
      },
    ]);
    expect(here.rows).toEqual([]);
    // At the branch it is set up for, it is simply applied.
    const there = await quoteAndCommit(chalongTill, {
      ...kids({ stationId: t3.id, packageId: twoHoursChalong }),
      promos: [described('CHALONG441')],
    });
    expect(there.quote.rejectedPromoCodes).toEqual([]);
    expect(there.quote.appliedPromos.map((p) => p.code)).toEqual(['CHALONG441']);
  });

  it('reads "was not found" for a code switched off at another branch: it is set up nowhere', async () => {
    await define('PAUSED441', { branchId: chalongId, active: false });
    const run = await quoteAndCommit(tillA, { ...kids(), promos: [described('PAUSED441')] });
    expect(run.quote.rejectedPromoCodes).toEqual([
      { code: 'PAUSED441', reason: 'Code "PAUSED441" was not found.' },
    ]);
  });
});

// --- (e) ---------------------------------------------------------------------

describe('codes on one sale', () => {
  it('refuses a code that cannot be combined, naming the one already on the sale', async () => {
    await define('SOLO10');
    const stackableFirst = await quoteAndCommit(tillA, {
      ...kids(),
      promos: [described('STAFF10'), described('SOLO10')],
    });
    expect(stackableFirst.quote.appliedPromos.map((p) => p.code)).toEqual(['STAFF10']);
    expect(stackableFirst.quote.rejectedPromoCodes).toEqual([
      {
        code: 'SOLO10',
        reason: 'Code "SOLO10" can\'t be combined with "STAFF10" on the same sale.',
      },
    ]);

    const soloFirst = await quoteAndCommit(tillA, {
      ...kids(),
      promos: [described('SOLO10'), described('STAFF10')],
    });
    expect(soloFirst.quote.appliedPromos.map((p) => p.code)).toEqual(['SOLO10']);
    expect(soloFirst.quote.rejectedPromoCodes).toEqual([
      {
        code: 'STAFF10',
        reason: 'Code "STAFF10" can\'t be combined with "SOLO10" on the same sale.',
      },
    ]);

    const twice = await quoteAndCommit(tillA, {
      ...kids(),
      promos: [described('STAFF10'), described('STAFF10')],
    });
    expect(twice.quote.appliedPromos.map((p) => p.code)).toEqual(['STAFF10']);
    expect(twice.quote.rejectedPromoCodes).toEqual([
      { code: 'STAFF10', reason: 'Code "STAFF10" is already applied.' },
    ]);
  });

  it('combines two stackable codes, each against what the one before it left', async () => {
    const run = await quoteAndCommit(tillA, {
      ...kids(),
      promos: [described('STAFF10'), described('MEMBER20')],
    });
    // 10 % of ฿890 is ฿89; 20 % of the ฿801 left is ฿160.20.
    expect(run.quote.appliedPromos.map((p) => [p.code, p.amountSatang])).toEqual([
      ['STAFF10', b(89)],
      ['MEMBER20', b(160.2)],
    ]);
    expect(run.quote.totals.grossSatang).toBe(KID - b(89) - b(160.2));
  });

  it('refuses a promo code beside a held booth voucher — the voucher’s own rule', async () => {
    const [definition] = await ctx.db
      .select()
      .from(voucherDefinition)
      .where(
        and(
          eq(voucherDefinition.operatorId, operatorId),
          eq(voucherDefinition.code, 'spin-voucher-150'),
        ),
      );
    const code = mintBoothCode('B1', (max) => randomInt(max));
    await ctx.db.insert(voucher).values({
      id: newId(),
      operatorId,
      branchId: hktId,
      voucherDefinitionId: definition!.id,
      code,
      source: 'booth',
      status: 'issued',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 14 * 86_400_000),
    });
    const saleId = newId();
    const held = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/vouchers`,
      headers: { cookie: tillA },
      payload: { code },
    });
    expect(held.statusCode, held.body).toBe(200);

    const cart = { ...kids(), promoCodes: [code], promos: [described('STAFF10')] };
    for (const res of [await quote(tillA, cart), await commit(tillA, { id: saleId, ...cart })]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'VOUCHER_NOT_COMBINABLE',
        message: 'A voucher cannot be combined with another voucher or promo code on the same sale',
      });
    }
    expect(await saleRow(saleId)).toBeUndefined();
  });
});

// --- (f) ---------------------------------------------------------------------

describe('a code’s usage limits, counted from the sales that carried it', () => {
  it('usage_limit 2: two finalised sales use it up; a voided sale, or one still unpaid, does not count', async () => {
    await define('LIMIT2', { ...fixed(b(100)), usageLimit: 2 });
    const cart = () => ({ ...kids(), promos: [described('LIMIT2')] });

    const first = await quoteAndCommit(tillA, cart());
    expect(first.quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'LIMIT2', amountSatang: b(100) }),
    ]);
    expect((await finalise(tillA, first.saleId)).statusCode).toBe(200);

    // Rung up and voided: never paid, never counted.
    const voided = await quoteAndCommit(tillA, cart());
    expect((await voidSale(tillA, voided.saleId)).statusCode).toBe(200);
    // Rung up and still being paid for: not counted yet.
    const open = await quoteAndCommit(tillA, cart());
    expect(open.quote.rejectedPromoCodes).toEqual([]);

    const second = await quoteAndCommit(tillA, cart());
    expect(second.quote.rejectedPromoCodes).toEqual([]);
    expect((await finalise(tillA, second.saleId)).statusCode).toBe(200);

    const third = await quoteAndCommit(tillA, cart());
    expect(third.quote.rejectedPromoCodes).toEqual([
      {
        code: 'LIMIT2',
        reason: 'Code "LIMIT2" is used up — all 2 of its uses have been taken.',
      },
    ]);
    expect(third.sale.promoDiscountSatang).toBe(0);
    expect(third.rows).toEqual([]);
  });

  it('per_customer_limit 1: the same member twice is refused; another member, or nobody, is not', async () => {
    await define('ONCEEACH', { ...fixed(b(100)), perCustomerLimit: 1 });
    const cart = (memberId: string | null) => ({
      ...kids(),
      ...(memberId ? { memberId } : {}),
      promos: [described('ONCEEACH')],
    });

    const james = await quoteAndCommit(tillA, cart(jamesId));
    expect(james.quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'ONCEEACH', amountSatang: b(100) }),
    ]);
    expect((await finalise(tillA, james.saleId)).statusCode).toBe(200);

    const again = await quoteAndCommit(tillA, cart(jamesId));
    expect(again.quote.rejectedPromoCodes).toEqual([
      { code: 'ONCEEACH', reason: 'Code "ONCEEACH" can only be used once per customer.' },
    ]);
    expect(again.rows).toEqual([]);

    const mali = await quoteAndCommit(tillA, cart(maliId));
    expect(mali.quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'ONCEEACH', amountSatang: b(100) }),
    ]);

    // No member on the cart: nothing to count against, so no limit — twice over.
    for (let visit = 0; visit < 2; visit += 1) {
      const walkIn = await quoteAndCommit(tillA, cart(null));
      expect(walkIn.quote.rejectedPromoCodes).toEqual([]);
      expect((await finalise(tillA, walkIn.saleId)).statusCode).toBe(200);
    }
  });

  it('per_customer_limit 1: a member’s voided sale, or one still unpaid, is not one of their uses', async () => {
    await define('ONCEPAID', { ...fixed(b(100)), perCustomerLimit: 1 });
    const cart = () => ({ ...kids(), memberId: jamesId, promos: [described('ONCEPAID')] });

    // Rung up for James and voided: never paid, never counted.
    const voided = await quoteAndCommit(tillA, cart());
    expect(voided.quote.rejectedPromoCodes).toEqual([]);
    expect((await voidSale(tillA, voided.saleId)).statusCode).toBe(200);
    // Rung up for James and still being paid for: not counted yet.
    const open = await quoteAndCommit(tillA, cart());
    expect(open.quote.rejectedPromoCodes).toEqual([]);

    // So the sale he pays for is still his first use.
    const paid = await quoteAndCommit(tillA, cart());
    expect(paid.quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'ONCEPAID', amountSatang: b(100) }),
    ]);
    expect((await finalise(tillA, paid.saleId)).statusCode).toBe(200);

    const again = await quoteAndCommit(tillA, cart());
    expect(again.quote.rejectedPromoCodes).toEqual([
      { code: 'ONCEPAID', reason: 'Code "ONCEPAID" can only be used once per customer.' },
    ]);
    expect(again.rows).toEqual([]);
  });
});

// --- (g) ---------------------------------------------------------------------

describe('what a code takes off', () => {
  it('a percentage from value_bp, rounded to the satang by the cart’s own rule', async () => {
    await define('PCT125', { valueBp: 1250 });
    await define('TINY1', { valueBp: 1 });
    const oneEighth = await quoteAndCommit(tillA, { ...kids(), promos: [described('PCT125')] });
    expect(oneEighth.quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'PCT125', amountSatang: 11125 }),
    ]);
    expect(oneEighth.rows[0]).toMatchObject({ discountType: 'percent', percentBp: 1250 });
    // 0.01 % of ฿890 is 8.9 satang: half up, 9.
    const tiny = await quoteAndCommit(tillA, { ...kids(), promos: [described('TINY1')] });
    expect(tiny.quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'TINY1', amountSatang: 9 }),
    ]);
  });

  it('an amount from value_satang, capped at what is on the cart — no change is given', async () => {
    await define('BIGFIXED', fixed(b(5000)));
    const run = await quoteAndCommit(tillA, {
      ...kids(),
      promos: [described('BIGFIXED', { value: b(1) })],
      // The definition gives the whole ticket away, so this sale may close at ฿0.
      expectedTotalSatang: 0,
      finalise: true,
    });
    expect(run.quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'BIGFIXED', amountSatang: KID }),
    ]);
    expect(run.quote.totals.grossSatang).toBe(0);
    expect(run.commit).toMatchObject({ finalised: true, outstandingSatang: 0 });
    expect(run.rows).toEqual([
      expect.objectContaining({ discountType: 'fixed', valueSatang: b(5000), amountSatang: KID }),
    ]);
  });

  it('a free item takes the line that holds it to nothing', async () => {
    const freeLine = newId();
    const kid = kidLine();
    const run = await quoteAndCommit(tillA, {
      stationId: t1.id,
      lines: [
        kid,
        // The ticket till's own free-item line, as it puts one on the bill for the code.
        {
          id: freeLine,
          packageId: twoHoursHkt,
          kids: 0,
          adults: 0,
          promoItem: {
            itemId: iceCreamId,
            itemKind: 'menu',
            name: iceCreamName,
            priceSatang: iceCreamSatang,
          },
        },
      ],
      promos: [
        {
          code: 'ICECREAM',
          label: 'Ice cream',
          type: 'free_item',
          value: KID,
          freeItemId: iceCreamId,
        },
      ],
    });
    expect(run.quote.appliedPromos).toEqual([
      {
        code: 'ICECREAM',
        label: 'Free Ice Cream',
        type: 'free_item',
        amountSatang: iceCreamSatang,
      },
    ]);
    expect(run.quote.totals).toMatchObject({
      subtotalSatang: KID + iceCreamSatang,
      grossSatang: KID,
    });
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, run.saleId));
    expect(lines.find((l) => l.cartLineId === freeLine)).toMatchObject({
      kind: 'promo_item',
      baseSatang: iceCreamSatang,
      discountSatang: iceCreamSatang,
      grossSatang: 0,
    });
    expect(lines.filter((l) => l.cartLineId === kid.id).map((l) => l.discountSatang)).toEqual([0]);
    expect(run.rows).toEqual([
      expect.objectContaining({
        code: 'ICECREAM',
        discountType: 'free_item',
        valueSatang: iceCreamSatang,
        amountSatang: iceCreamSatang,
        scope: 'line',
        targetLineId: freeLine,
      }),
    ]);
  });

  it('a free item is refused, naming it, when there is none on the order', async () => {
    const run = await quoteAndCommit(tillA, {
      ...kids(),
      promos: [{ code: 'ICECREAM', label: 'Ice cream', type: 'free_item', value: KID }],
    });
    expect(run.quote.rejectedPromoCodes).toEqual([
      {
        code: 'ICECREAM',
        reason: `Code "ICECREAM" gives a free ${iceCreamName}, and there is no ${iceCreamName} on this order.`,
      },
    ]);
    expect(run.sale.grossSatang).toBe(KID);
    expect(run.rows).toEqual([]);
  });

  it('a free item on a line of two of it takes one of them off', async () => {
    const twoCones = newId();
    const run = await quoteAndCommit(tillA, {
      stationId: t1.id,
      channel: 'fnb',
      items: [{ id: twoCones, productId: iceCreamId, quantity: 2 }],
      pickupCode: 'A2',
      promos: [{ code: 'ICECREAM', label: 'Ice cream', type: 'free_item', value: KID }],
    });
    expect(run.quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'ICECREAM', amountSatang: iceCreamSatang }),
    ]);
    expect(run.quote.totals).toMatchObject({
      subtotalSatang: 2 * iceCreamSatang,
      grossSatang: iceCreamSatang,
    });
    // Committed the same: one cone off, aimed at the line that holds them.
    expect(run.rows).toEqual([
      expect.objectContaining({
        code: 'ICECREAM',
        discountType: 'free_item',
        valueSatang: iceCreamSatang,
        amountSatang: iceCreamSatang,
        scope: 'line',
        targetLineId: twoCones,
      }),
    ]);
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, run.saleId));
    const cones = lines.filter((l) => l.cartLineId === twoCones);
    expect(cones.reduce((sum, l) => sum + l.discountSatang, 0)).toBe(iceCreamSatang);
    expect(cones.reduce((sum, l) => sum + l.grossSatang, 0)).toBe(iceCreamSatang);
  });

  it('the definition’s scope decides what it comes off, never the scope the till sends', async () => {
    await define('TIX20', { valueBp: 2000, target: { kind: 'tickets' } });
    const juiceLine = newId();
    const run = await quoteAndCommit(tillA, {
      stationId: t1.id,
      lines: [kidLine()],
      items: [{ id: juiceLine, productId: juiceId, quantity: 1 }],
      pickupCode: 'A1',
      promos: [described('TIX20', { type: 'percent', value: 20, target: { kind: 'everything' } })],
    });
    expect(run.quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'TIX20', amountSatang: b(178) }),
    ]);
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, run.saleId));
    expect(lines.find((l) => l.cartLineId === juiceLine)!.discountSatang).toBe(0);
  });

  it('a scope the platform cannot price is refused by name, never guessed at', async () => {
    await define('CATS10', { target: { kind: 'categories', categoryIds: [newId()] } });
    await define('NOITEMS10', { target: { kind: 'menuItems' } });
    for (const [code, kind] of [
      ['CATS10', 'categories'],
      ['NOITEMS10', 'menuItems'],
    ] as const) {
      const run = await quoteAndCommit(tillA, { ...kids(), promos: [described(code)] });
      expect(run.quote.rejectedPromoCodes, code).toEqual([
        {
          code,
          reason: `Code "${code}" is limited to "${kind}", which this platform cannot price yet.`,
        },
      ]);
      expect(run.sale.grossSatang, code).toBe(KID);
    }
  });
});

// --- (i) ---------------------------------------------------------------------

const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

interface TestBox {
  boxId: string;
  credential: string;
  privateKey: KeyObject;
  stationId: string;
  prefix: string;
  nextSeq: number;
}

let boxCounter = 0;

/** A box with one till of its own and a receipt series nothing else touches (as `sync-sales`). */
async function freshBox(): Promise<TestBox> {
  const seeded = await boxBySlot(ctx.db, 'virtual-1');
  expect(seeded.branchId).toBe(hktId);
  const n = (boxCounter += 1);
  const boxId = newId();
  await ctx.db.insert(box).values({
    id: boxId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    name: `Promo box ${n}`,
    slot: `promo-${n}`,
    role: 'virtual',
    status: 'unclaimed',
  });
  const stationId = newId();
  const prefix = `P${n}`;
  await ctx.db.insert(station).values({
    id: stationId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    boxId,
    name: `Offline till ${n}`,
    kind: 'till',
    codePrefix: prefix,
  });

  const { code: claimCode } = await issueClaimCode(ctx.db, boxId);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const registered = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: {
      claimCode,
      agentVersion: '0.1.0',
      hostname: `promo-${n}`,
      syncPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      syncKeyAlgorithm: 'ed25519',
    },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  const body = registered.json() as { boxId: string; secret: string };
  return {
    boxId,
    credential: boxCredential(body.boxId, body.secret),
    privateKey,
    stationId,
    prefix,
    nextSeq: 1,
  };
}

/**
 * An envelope minted the way a box mints one: canonical bytes, then the hash and
 * the signature. `occurredAt` is when the box's trusted clock says it happened.
 */
function mint(
  b: TestBox,
  type: string,
  payload: Record<string, unknown>,
  occurredAt: Date = new Date(),
): SyncEventEnvelope {
  const base = {
    eventId: newId(),
    journalEpoch: 1,
    boxSeq: b.nextSeq++,
    type,
    schemaVersion: SYNC_EVENT_SCHEMA_VERSION,
    occurredAt: occurredAt.toISOString(),
    clockTrust: 'trusted' as const,
    stationId: b.stationId,
    actorKind: 'account' as const,
    actorAccountId: receptionAccountId,
    actorCredentialId: null,
    actionId: `act-${newId()}`,
    payload,
  };
  const canonical = canonicalSyncBytes({ ...base, boxId: b.boxId });
  return {
    ...base,
    payloadHash: sha256(canonical),
    sig: signDetached(null, Buffer.from(canonical, 'utf8'), b.privateKey).toString('base64'),
    sigAlg: 'ed25519',
  } as SyncEventEnvelope;
}

async function push(b: TestBox, events: SyncEventEnvelope[]): Promise<SyncPushResponse> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/sync/push',
    headers: { authorization: `Bearer ${b.credential}` },
    payload: { events },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SyncPushResponse;
}

/** A sale the till took with the link down: its cart as composed, paid in cash at the till's total. */
function offlineSaleOf(saleId: string, cart: Record<string, unknown>, totalSatang: number) {
  return {
    saleId,
    cart: { ...cart, expectedTotalSatang: totalSatang },
    tenders: [
      {
        actionId: `press-${newId()}`,
        methodCode: 'cash',
        kind: 'cash',
        amountSatang: totalSatang,
        tenderedSatang: totalSatang,
        changeSatang: 0,
      },
    ],
  };
}

/** A one-kid sale the till took with the link down, with one code as it applied it. */
function offlineSale(
  saleId: string,
  promo: { code: string; label: string; type: string; value: number },
  totalSatang: number,
) {
  return offlineSaleOf(saleId, { lines: [kidLine()], promos: [promo] }, totalSatang);
}

/**
 * The ticket till's cart for a free-item code, as `buildCartPayload` composes
 * it: one kid, and the code's own line holding the item at the till's shelf
 * price (`applyFreeItemPromo`), each line with the figure the till showed.
 */
function freeItemCart(
  freeLineId: string,
  item: { id: string; name: string; satang: number },
  code: string,
) {
  return {
    lines: [
      { ...kidLine(), lineTotalSatang: KID },
      {
        id: freeLineId,
        packageId: twoHoursHkt,
        kids: 0,
        adults: 0,
        socks: 0,
        promoItem: { itemId: item.id, itemKind: 'menu', name: item.name, priceSatang: item.satang },
        lineTotalSatang: item.satang,
      },
    ],
    promos: [
      {
        code,
        label: 'Free Ice Cream',
        type: 'free_item',
        value: item.satang,
        freeItemId: item.id,
        freeItemKind: 'menu',
      },
    ],
  };
}

async function replayAudit(saleId: string) {
  const [row] = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.offline_replay')));
  return row;
}

async function alertFor(saleId: string, code: string) {
  const [row] = await ctx.db
    .select()
    .from(alert)
    .where(eq(alert.key, `sale.offline_promo:${saleId}:${code}`));
  return row;
}

describe('an offline sale is filed as the till recorded it, and flagged', () => {
  it('files a code the park now prices differently at the value the till applied, flags it and counts the use', async () => {
    await define('OFFONCE', { ...fixed(b(100)), usageLimit: 1, label: 'Offline once' });
    const theBox = await freshBox();
    const saleId = newId();
    // The till's copy had OFFONCE at ฿150 off; the park's definition says ฿100.
    const total = KID - b(150);
    const answer = await push(theBox, [
      mint(
        theBox,
        'sale.finalised',
        offlineSale(
          saleId,
          { code: 'OFFONCE', label: 'Offline once', type: 'fixed', value: b(150) },
          total,
        ),
      ),
    ]);
    expect(answer).toMatchObject({ applied: 1, quarantined: 0 });

    // Filed as recorded: the money the till took is the money on the sale.
    const row = (await saleRow(saleId))!;
    expect(row).toMatchObject({
      status: 'finalised',
      origin: 'box',
      promoDiscountSatang: b(150),
      grossSatang: total,
    });
    expect(await promoRows(saleId)).toEqual([
      expect.objectContaining({ code: 'OFFONCE', valueSatang: b(150), amountSatang: b(150) }),
    ]);

    // Flagged: the sale, the code, and both values.
    const raised = await alertFor(saleId, 'OFFONCE');
    expect(raised).toMatchObject({
      category: 'sale.offline_promo',
      severity: 'warning',
      status: 'open',
      operatorId,
      branchId: hktId,
    });
    expect(raised!.summary).toBe(
      `Offline sale ${row.receiptNumber} was filed with code OFFONCE at ฿150 off, as the till ` +
        "applied it; the park's definition gives ฿100 off now.",
    );
    expect(raised!.detail).toMatchObject({
      saleId,
      code: 'OFFONCE',
      recorded: { type: 'fixed', value: b(150) },
      definition: { type: 'fixed', value: b(100) },
      reason: null,
    });
    // The replay's own audit row carries the same facts, inside the transaction that filed it.
    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.offline_replay')));
    expect(audited!.after).toMatchObject({
      promoDifferences: [
        {
          code: 'OFFONCE',
          recorded: { type: 'fixed', value: b(150) },
          definition: { type: 'fixed', value: b(100) },
          reason: null,
        },
      ],
    });

    // Counted: the code's one use has been taken, so the next sale is refused.
    const next = (await quote(tillA, { ...kids(), promos: [described('OFFONCE')] })).json();
    expect(next.rejectedPromoCodes).toEqual([
      { code: 'OFFONCE', reason: 'Code "OFFONCE" is used up — its one use has been taken.' },
    ]);
  });

  it('files a code the park has not set up, flags it as unknown, and never refuses the sale', async () => {
    const theBox = await freshBox();
    const saleId = newId();
    const total = KID - b(100);
    const answer = await push(theBox, [
      mint(
        theBox,
        'sale.finalised',
        offlineSale(
          saleId,
          { code: 'NOSUCHCODE', label: 'Mystery', type: 'fixed', value: b(100) },
          total,
        ),
      ),
    ]);
    expect(answer).toMatchObject({ applied: 1, quarantined: 0 });
    const row = (await saleRow(saleId))!;
    expect(row).toMatchObject({
      status: 'finalised',
      promoDiscountSatang: b(100),
      grossSatang: total,
    });

    const raised = await alertFor(saleId, 'NOSUCHCODE');
    expect(raised!.summary).toBe(
      `Offline sale ${row.receiptNumber} was filed with code NOSUCHCODE at ฿100 off, as the till ` +
        'applied it; the park has no such code set up (unknown code).',
    );
    expect(raised!.detail).toMatchObject({
      saleId,
      code: 'NOSUCHCODE',
      recorded: { type: 'fixed', value: b(100) },
      definition: null,
      reason: 'unknown code',
    });
  });

  it('flags nothing when the till applied what the park’s definition gives', async () => {
    const theBox = await freshBox();
    const saleId = newId();
    const total = KID - b(89);
    const answer = await push(theBox, [
      mint(
        theBox,
        'sale.finalised',
        offlineSale(
          saleId,
          { code: 'STAFF10', label: 'Staff Discount', type: 'percent', value: 10 },
          total,
        ),
      ),
    ]);
    expect(answer).toMatchObject({ applied: 1, quarantined: 0 });
    expect(await saleRow(saleId)).toMatchObject({
      status: 'finalised',
      promoDiscountSatang: b(89),
    });
    expect(await alertFor(saleId, 'STAFF10')).toBeUndefined();
  });

  it('files a scoped code at the till’s figure, and flags a scope the park’s definition does not give', async () => {
    // TIXOFF20 is 20 % off the tickets, in the park's definition and in the
    // till's copy. ALLOFF20 was the same in the till's copy; the park has since
    // made it 20 % off the whole order.
    await define('TIXOFF20', { valueBp: 2000, target: { kind: 'tickets' } });
    await define('ALLOFF20', { valueBp: 2000 });
    // 20 % of the ฿890 ticket is ฿178, and the juice is not a ticket: 78200.
    const total = KID - b(178) + juiceSatang;
    const theBox = await freshBox();
    const filed = async (code: string) => {
      const saleId = newId();
      const juiceLine = newId();
      const answer = await push(theBox, [
        mint(
          theBox,
          'sale.finalised',
          offlineSaleOf(
            saleId,
            {
              lines: [kidLine()],
              items: [{ id: juiceLine, productId: juiceId, quantity: 1 }],
              pickupCode: 'B1',
              promos: [
                { code, label: code, type: 'percent', value: 20, target: { kind: 'tickets' } },
              ],
            },
            total,
          ),
        ),
      ]);
      expect(answer, code).toMatchObject({ applied: 1, quarantined: 0 });
      const row = (await saleRow(saleId))!;
      expect(row, code).toMatchObject({
        status: 'finalised',
        promoDiscountSatang: b(178),
        grossSatang: total,
      });
      const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
      expect(lines.find((l) => l.cartLineId === juiceLine)!.discountSatang, code).toBe(0);
      return { saleId, row };
    };

    // The scope the till applied is the definition's: filed, and nothing to flag.
    const agreed = await filed('TIXOFF20');
    expect(await alertFor(agreed.saleId, 'TIXOFF20')).toBeUndefined();

    // A scope the definition no longer gives: still filed at the till's
    // figure, and flagged with both scopes named.
    const widened = await filed('ALLOFF20');
    const raised = await alertFor(widened.saleId, 'ALLOFF20');
    expect(raised!.summary).toBe(
      `Offline sale ${widened.row.receiptNumber} was filed with code ALLOFF20 at 20% off ` +
        '(limited to "tickets"), as the till applied it; the park\'s definition gives 20% off now.',
    );
    expect(raised!.detail).toMatchObject({
      recorded: { type: 'percent', value: 20, target: { kind: 'tickets' } },
      definition: { type: 'percent', value: 20 },
      reason: null,
    });
    expect((raised!.detail as { definition: object }).definition).not.toHaveProperty('target');
  });

  it('files a free item as the ticket till rang it, on its own line, and flags nothing when the park gives the same item', async () => {
    const theBox = await freshBox();
    const saleId = newId();
    const freeLine = newId();
    const answer = await push(theBox, [
      mint(
        theBox,
        'sale.finalised',
        offlineSaleOf(
          saleId,
          freeItemCart(
            freeLine,
            { id: iceCreamId, name: iceCreamName, satang: iceCreamSatang },
            'ICECREAM',
          ),
          KID,
        ),
      ),
    ]);
    expect(answer).toMatchObject({ applied: 1, quarantined: 0 });
    expect(await saleRow(saleId)).toMatchObject({
      status: 'finalised',
      subtotalSatang: KID + iceCreamSatang,
      promoDiscountSatang: iceCreamSatang,
      grossSatang: KID,
    });
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    expect(lines.find((l) => l.cartLineId === freeLine)).toMatchObject({
      kind: 'promo_item',
      baseSatang: iceCreamSatang,
      discountSatang: iceCreamSatang,
      grossSatang: 0,
    });
    expect(await promoRows(saleId)).toEqual([
      expect.objectContaining({
        code: 'ICECREAM',
        discountType: 'free_item',
        valueSatang: iceCreamSatang,
        amountSatang: iceCreamSatang,
        scope: 'line',
        targetLineId: freeLine,
      }),
    ]);
    expect(await alertFor(saleId, 'ICECREAM')).toBeUndefined();
    expect((await replayAudit(saleId))!.after).not.toHaveProperty('promoDifferences');
  });

  it('files a free item that is another product than the park’s code gives, and flags it', async () => {
    // The till's copy of ICECREAM gave a juice; the park's definition gives an ice cream.
    const theBox = await freshBox();
    const saleId = newId();
    const freeLine = newId();
    const answer = await push(theBox, [
      mint(
        theBox,
        'sale.finalised',
        offlineSaleOf(
          saleId,
          freeItemCart(freeLine, { id: juiceId, name: 'Juice', satang: juiceSatang }, 'ICECREAM'),
          KID,
        ),
      ),
    ]);
    expect(answer).toMatchObject({ applied: 1, quarantined: 0 });
    const row = (await saleRow(saleId))!;
    expect(row).toMatchObject({
      status: 'finalised',
      promoDiscountSatang: juiceSatang,
      grossSatang: KID,
    });
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    expect(lines.find((l) => l.cartLineId === freeLine)!.grossSatang).toBe(0);

    const raised = await alertFor(saleId, 'ICECREAM');
    const reason = `Code "ICECREAM" gives a free ${iceCreamName}, not the item the till gave.`;
    expect(raised!.summary).toBe(
      `Offline sale ${row.receiptNumber} was filed with code ICECREAM at a free item worth ` +
        `฿${juiceSatang / 100}, as the till applied it; the park's definition would not give it ` +
        `today: ${reason}`,
    );
    expect(raised!.detail).toMatchObject({
      recorded: { type: 'free_item', value: juiceSatang },
      definition: null,
      reason,
    });
  });

  it('files a sale that arrives after its code was used up, and flags it as used up', async () => {
    await define('LASTUSE', { ...fixed(b(100)), usageLimit: 1 });
    const online = await quoteAndCommit(tillA, { ...kids(), promos: [described('LASTUSE')] });
    expect(online.quote.appliedPromos).toEqual([
      expect.objectContaining({ code: 'LASTUSE', amountSatang: b(100) }),
    ]);
    expect((await finalise(tillA, online.saleId)).statusCode).toBe(200);

    // The box took the money for it with the link down, before it heard.
    const theBox = await freshBox();
    const saleId = newId();
    const total = KID - b(100);
    const answer = await push(theBox, [
      mint(
        theBox,
        'sale.finalised',
        offlineSale(
          saleId,
          { code: 'LASTUSE', label: 'LASTUSE', type: 'fixed', value: b(100) },
          total,
        ),
      ),
    ]);
    expect(answer).toMatchObject({ applied: 1, quarantined: 0 });
    const row = (await saleRow(saleId))!;
    expect(row).toMatchObject({
      status: 'finalised',
      promoDiscountSatang: b(100),
      grossSatang: total,
    });

    const reason = 'Code "LASTUSE" is used up — its one use has been taken.';
    const raised = await alertFor(saleId, 'LASTUSE');
    expect(raised!.summary).toBe(
      `Offline sale ${row.receiptNumber} was filed with code LASTUSE at ฿100 off, as the till ` +
        `applied it; the park's definition would not give it today: ${reason}`,
    );
    expect(raised!.detail).toMatchObject({
      recorded: { type: 'fixed', value: b(100) },
      definition: null,
      reason,
    });
  });

  it('judges the window on the day the sale was rung up, not the day it arrives: nothing to flag', async () => {
    // The box took the money at noon on the code's last day; the push arrives
    // today, after the window has closed.
    const today = businessDate(new Date(), timezone, parseDayStart(dayStart));
    const lastDay = shift(today, -1);
    const rungUp = new Date(`${lastDay}T12:00:00+07:00`);
    expect(businessDate(rungUp, timezone, parseDayStart(dayStart))).toBe(lastDay);
    await define('LASTDAY', { ...fixed(b(100)), validUntil: lastDay });

    // Rung up today, it would be refused.
    const now = (await quote(tillA, { ...kids(), promos: [described('LASTDAY')] })).json();
    expect(now.rejectedPromoCodes).toEqual([
      { code: 'LASTDAY', reason: `Code "LASTDAY" expired on ${day(lastDay)}.` },
    ]);

    const theBox = await freshBox();
    const saleId = newId();
    const total = KID - b(100);
    const answer = await push(theBox, [
      mint(
        theBox,
        'sale.finalised',
        offlineSale(
          saleId,
          { code: 'LASTDAY', label: 'LASTDAY', type: 'fixed', value: b(100) },
          total,
        ),
        rungUp,
      ),
    ]);
    expect(answer).toMatchObject({ applied: 1, quarantined: 0 });
    expect(await saleRow(saleId)).toMatchObject({
      status: 'finalised',
      businessDate: lastDay,
      promoDiscountSatang: b(100),
      grossSatang: total,
    });
    // The park's definition gave ฿100 off on that day, which is what was applied.
    expect(await alertFor(saleId, 'LASTDAY')).toBeUndefined();
    expect((await replayAudit(saleId))!.after).not.toHaveProperty('promoDifferences');
  });

  it('files the sale when its flag cannot be written, and the replay’s audit row still names the difference', async () => {
    await define('NOFLAG', fixed(b(100)));
    const theBox = await freshBox();
    const saleId = newId();
    const total = KID - b(150);
    // For this one push the alert table refuses the flag, the way a write on a
    // pool that timed out fails: the flag is lost, and only the flag.
    await ctx.db.execute(
      sql`alter table core.alert add constraint refuse_offline_promo_alert check (category <> 'sale.offline_promo') not valid`,
    );
    const answer = await push(theBox, [
      mint(
        theBox,
        'sale.finalised',
        offlineSale(
          saleId,
          { code: 'NOFLAG', label: 'NOFLAG', type: 'fixed', value: b(150) },
          total,
        ),
      ),
    ]).finally(() =>
      ctx.db.execute(sql`alter table core.alert drop constraint refuse_offline_promo_alert`),
    );

    // Filed, not quarantined: the money was taken.
    expect(answer).toMatchObject({ applied: 1, quarantined: 0 });
    expect(await saleRow(saleId)).toMatchObject({
      status: 'finalised',
      promoDiscountSatang: b(150),
      grossSatang: total,
    });
    expect(await alertFor(saleId, 'NOFLAG')).toBeUndefined();
    expect((await replayAudit(saleId))!.after).toMatchObject({
      promoDifferences: [
        {
          code: 'NOFLAG',
          recorded: { type: 'fixed', value: b(150) },
          definition: { type: 'fixed', value: b(100) },
          reason: null,
        },
      ],
    });
  });

  it('files a code typed in lower case at the park’s own value under the park’s code, and counts the use', async () => {
    await define('OFFCASE', { ...fixed(b(100)), usageLimit: 1, label: 'Offline case' });
    const theBox = await freshBox();
    const saleId = newId();
    // The till applied the park's own ฿100 off, with the code typed in lower case.
    const total = KID - b(100);
    const answer = await push(theBox, [
      mint(
        theBox,
        'sale.finalised',
        offlineSale(
          saleId,
          { code: 'offcase', label: 'Offline case', type: 'fixed', value: b(100) },
          total,
        ),
      ),
    ]);
    expect(answer).toMatchObject({ applied: 1, quarantined: 0 });
    expect(await saleRow(saleId)).toMatchObject({
      status: 'finalised',
      promoDiscountSatang: b(100),
      grossSatang: total,
    });
    // Filed under the park's own code, at the value the till applied.
    expect(await promoRows(saleId)).toEqual([
      expect.objectContaining({ code: 'OFFCASE', valueSatang: b(100), amountSatang: b(100) }),
    ]);
    // The value is the definition's, so there is nothing to flag.
    expect(await alertFor(saleId, 'OFFCASE')).toBeUndefined();
    expect(await alertFor(saleId, 'offcase')).toBeUndefined();
    expect((await replayAudit(saleId))!.after).not.toHaveProperty('promoDifferences');

    // Counted: its one use is taken, whichever way the next till types it.
    for (const typed of ['OFFCASE', 'offcase']) {
      const next = (await quote(tillA, { ...kids(), promos: [described(typed)] })).json();
      expect(next.rejectedPromoCodes, typed).toEqual([
        { code: typed, reason: `Code "${typed}" is used up — its one use has been taken.` },
      ]);
    }
  });

  it('flags a code typed in lower case at another value under the park’s code', async () => {
    await define('OFFCASE2', { ...fixed(b(100)), label: 'Offline case two' });
    const theBox = await freshBox();
    const saleId = newId();
    // The till's copy had the code at ฿150 off; the park's definition says ฿100.
    const total = KID - b(150);
    const answer = await push(theBox, [
      mint(
        theBox,
        'sale.finalised',
        offlineSale(
          saleId,
          { code: 'offcase2', label: 'Offline case two', type: 'fixed', value: b(150) },
          total,
        ),
      ),
    ]);
    expect(answer).toMatchObject({ applied: 1, quarantined: 0 });
    const row = (await saleRow(saleId))!;
    expect(row).toMatchObject({ status: 'finalised', promoDiscountSatang: b(150) });
    expect(await promoRows(saleId)).toEqual([
      expect.objectContaining({ code: 'OFFCASE2', valueSatang: b(150), amountSatang: b(150) }),
    ]);
    // The flag names the code the sale carries.
    const raised = await alertFor(saleId, 'OFFCASE2');
    expect(raised!.summary).toBe(
      `Offline sale ${row.receiptNumber} was filed with code OFFCASE2 at ฿150 off, as the till ` +
        "applied it; the park's definition gives ฿100 off now.",
    );
    expect(await alertFor(saleId, 'offcase2')).toBeUndefined();
    expect((await replayAudit(saleId))!.after).toMatchObject({
      promoDifferences: [
        {
          code: 'OFFCASE2',
          recorded: { type: 'fixed', value: b(150) },
          definition: { type: 'fixed', value: b(100) },
          reason: null,
        },
      ],
    });
  });
});

// --- (j) ---------------------------------------------------------------------

describe('the record of an accepted code', () => {
  it('is on the sale with the definition’s value, and the sale is under the account that rang it up', async () => {
    const run = await quoteAndCommit(tillA, { ...kids(), promos: [described('STAFF10')] });
    const [row] = run.rows;
    expect(row).toMatchObject({
      code: 'STAFF10',
      label: 'Staff Discount',
      discountType: 'percent',
      percentBp: 1000,
      amountSatang: b(89),
      scope: 'order',
    });
    expect(row!.appliedAt).toBeInstanceOf(Date);
    expect(run.sale.createdByAccountId).toBe(receptionAccountId);
    const [created] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, run.saleId), eq(auditLog.action, 'sale.create')));
    expect(created).toMatchObject({ actorAccountId: receptionAccountId, entityType: 'sale' });
    expect(created!.after).toMatchObject({ discountSatang: b(89), grossSatang: KID - b(89) });
  });

  it('is the park’s code however it was typed: priced, recorded under the definition’s code, and counted', async () => {
    await define('LCASE1', { ...fixed(b(100)), usageLimit: 1, label: 'Lower case' });
    const run = await quoteAndCommit(tillA, { ...kids(), promos: [described('lcase1')] });
    expect(run.quote.rejectedPromoCodes).toEqual([]);
    expect(run.quote.appliedPromos).toEqual([
      { code: 'LCASE1', label: 'Lower case', type: 'fixed', amountSatang: b(100) },
    ]);
    expect(run.rows).toEqual([
      expect.objectContaining({ code: 'LCASE1', valueSatang: b(100), amountSatang: b(100) }),
    ]);
    expect((await finalise(tillA, run.saleId)).statusCode).toBe(200);

    // Its one use is taken, whichever way the next till types it.
    for (const typed of ['LCASE1', 'lcase1']) {
      const next = (await quote(tillA, { ...kids(), promos: [described(typed)] })).json();
      expect(next.rejectedPromoCodes, typed).toEqual([
        { code: typed, reason: `Code "${typed}" is used up — its one use has been taken.` },
      ]);
    }
  });
});
