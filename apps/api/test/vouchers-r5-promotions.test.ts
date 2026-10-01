import { randomInt } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  box,
  boxCommand,
  branch,
  member,
  paymentAttempt,
  printJob,
  product,
  productCategory,
  redemptionThrottle,
  sale,
  saleDiscount,
  station,
  ticketPackage,
  voucher,
  voucherCampaign,
  voucherDefinition,
  voucherMiss,
  wallet,
  walletEntry,
} from '@oto/db';
import {
  addDaysToIsoDate,
  businessDate as businessDateOf,
  businessDayEndsAt,
  countsAsTillTakings,
  mintBoothCode,
  newId,
  parseDayStart,
  verifyBoothCode,
} from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { buildPrintDocument } from '../src/services/sale-printing';
import { definitionLockId, promoWindowRefusal } from '../src/services/voucher-promotions';
import { loadWalletFromVoucher, voucherLoadActionId } from '../src/services/wallet';

/**
 * S2-14a ROUND 5 — PROMOTIONAL VOUCHERS (plan docs/progress/plans/wallet/PLAN.md
 * §2.7; SPRINT_2_PLAN §S2-14a, the promotional-vouchers paragraph), through the
 * real routes with real sessions standing at real tills.
 *
 *   - a definition's promotional rules are checked whole on save;
 *   - a discount voucher aimed at a CATEGORY or an ITEM comes off that and
 *     nothing else, and the tax falls where the S2-09a engine puts it;
 *   - a GLOBAL limit holds under the real race — two tills on the last use:
 *     one success, one honest refusal — and a hold that lapsed is caught at
 *     Pay, before any money;
 *   - a PER-CUSTOMER limit is keyed by the member; a walk-in is not held to it;
 *   - the WINDOW is judged on the branch's trading day, boundary included;
 *   - issue at the till prints on the voucher slip's template; a campaign
 *     mints unique, auditable codes;
 *   - a WALLET CREDIT voucher loads a wallet exactly once, however often its
 *     close is replayed, through the wallet service's own grant;
 *   - FOREGONE REVENUE is its own line and reconciles with the redemptions.
 *
 * Every refusal is asserted by its code AND its words: the words are what the
 * counter shows.
 */

let ctx: TestContext;
let tillA: string;
let tillB: string;
let manager: string;
let admin: string;
let operatorId: string;
let hktId: string;
let tz: string;
let dayStart: number;
let t1: typeof station.$inferSelect;
let t2: typeof station.$inferSelect;
let twoHours: string;
let juiceId: string;
let pizzaId: string;
let plushId: string;
let drinksId: string;
let drinksName: string;
let memberId: string;
let receptionAccountId: string;

const b = (baht: number): number => Math.round(baht * 100);

async function pick(cookie: string, stationId: string): Promise<void> {
  const res = await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie }, payload: { stationId } });
  if (res.statusCode !== 200) throw new Error(`station pick failed (${res.statusCode}): ${res.body}`);
}

async function define(values: Partial<typeof voucherDefinition.$inferInsert>): Promise<string> {
  const id = newId();
  await ctx.db.insert(voucherDefinition).values({
    id,
    operatorId,
    code: `r5-${id}`,
    nameEn: '100 THB promotion',
    kind: 'discount',
    valueType: 'amount',
    valueSatang: b(100),
    ...values,
  } as typeof voucherDefinition.$inferInsert);
  return id;
}

/** A voucher as a campaign files one: a fresh code, issued now, never expiring. */
async function issue(definitionId: string, opts: { memberId?: string | null } = {}): Promise<{ id: string; code: string }> {
  const id = newId();
  const code = mintBoothCode('CP', (max) => randomInt(max));
  await ctx.db.insert(voucher).values({
    id,
    operatorId,
    branchId: hktId,
    voucherDefinitionId: definitionId,
    code,
    source: 'campaign',
    status: 'issued',
    issuedAt: new Date(),
    expiresAt: null,
    memberId: opts.memberId ?? null,
  });
  return { id, code };
}

const lookup = (cookie: string, code: string) =>
  ctx.app.inject({ method: 'GET', url: `/vouchers/lookup?code=${encodeURIComponent(code)}`, headers: { cookie } });
const hold = (cookie: string, saleId: string, code: string) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/vouchers`, headers: { cookie }, payload: { code } });
const quote = (cookie: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/sales/quote', headers: { cookie }, payload });
const commit = (cookie: string, payload: Record<string, unknown>, key?: string) =>
  ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) }, payload });
const finalise = (cookie: string, saleId: string, payload?: Record<string, unknown>, key?: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload ? { payload } : {}),
  });

/** One kid and one adult on 2 Hours Play at a till: a cart that needs no drop-off registration. */
const family = (stationId: string, extra: Record<string, unknown> = {}) => ({
  stationId,
  lines: [{ id: newId(), packageId: twoHours, kids: 1, adults: 1 }],
  ...extra,
});

async function voucherRow(id: string) {
  const [row] = await ctx.db.select().from(voucher).where(eq(voucher.id, id));
  return row!;
}

async function saleRow(id: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, id));
  return row;
}

async function holdCommitPay(cookie: string, stationId: string, code: string, cart: Record<string, unknown>): Promise<string> {
  const saleId = newId();
  const held = await hold(cookie, saleId, code);
  expect(held.statusCode, held.body).toBe(200);
  const rung = await commit(cookie, { id: saleId, ...cart, stationId, promoCodes: [code] });
  expect(rung.statusCode, rung.body).toBe(200);
  const paid = await finalise(cookie, saleId, { method: 'cash', kind: 'cash', actionId: newId() });
  expect(paid.statusCode, paid.body).toBe(200);
  expect(paid.json().finalised).toBe(true);
  return saleId;
}

async function assertLedgerTruth(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select w.id, w.balance_satang::bigint as balance,
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string }[]) {
    expect(Number(r.balance), `wallet ${r.id}`).toBe(Number(r.total));
  }
}

const today = () => businessDateOf(new Date(), tz, dayStart);

beforeAll(async () => {
  ctx = await createTestContext();
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  hktId = hkt!.id;
  operatorId = hkt!.operatorId;
  tz = hkt!.timezone;
  dayStart = parseDayStart(hkt!.businessDayStart);
  const stations = await ctx.db.select().from(station).where(eq(station.branchId, hktId));
  t1 = stations.find((s) => s.codePrefix === 'T1')!;
  t2 = stations.find((s) => s.codePrefix === 'T2')!;
  // Registered boxes: a drawer kick can be queued, so "no kick" means something.
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(inArray(box.id, [t1.boxId!, t2.boxId!]));
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, hktId));
  twoHours = pkgs.find((p) => p.name === '2 Hours Play')!.id;
  const products = await ctx.db.select().from(product).where(eq(product.operatorId, operatorId));
  juiceId = products.find((p) => p.code === 'FB-JUICE')!.id;
  pizzaId = products.find((p) => p.code === 'FB-PIZZA')!.id;
  plushId = products.find((p) => p.code === 'MR-PLUSH' && p.branchId === hktId)!.id;
  const [drinks] = await ctx.db
    .select()
    .from(productCategory)
    .where(and(eq(productCategory.operatorId, operatorId), eq(productCategory.code, 'DRINKS')));
  drinksId = drinks!.id;
  drinksName = drinks!.name;
  const [m] = await ctx.db.select().from(member).where(and(eq(member.operatorId, operatorId), eq(member.phone, '+66844444444')));
  memberId = m!.id;
  const [reception] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone));
  receptionAccountId = reception!.id;

  tillA = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await pick(tillA, t1.id);
  tillB = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await pick(tillB, t2.id);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
}, 180_000);

afterEach(async () => {
  await ctx.db.delete(redemptionThrottle);
  await ctx.db.delete(voucherMiss);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// ---------------------------------------------------------------------------

describe('a definition’s promotional rules are checked whole on save', () => {
  const create = (body: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: '/voucher-definitions', headers: { cookie: admin }, payload: body });
  const base = () => ({
    code: `r5-def-${newId().slice(-8)}`,
    nameEn: '฿50 off drinks',
    kind: 'discount',
    valueType: 'amount',
    valueSatang: b(50),
  });

  it('saves a category target, both limits and the window — audited with the row', async () => {
    const from = today();
    const until = addDaysToIsoDate(from, 30);
    const res = await create({
      ...base(),
      target: { kind: 'fnbCategory', category: drinksId },
      usageLimit: 100,
      perCustomerLimit: 1,
      validFrom: from,
      validUntil: until,
    });
    expect(res.statusCode, res.body).toBe(201);
    const def = res.json().definition;
    expect(def).toMatchObject({
      target: { kind: 'fnbCategory', category: drinksId },
      usageLimit: 100,
      perCustomerLimit: 1,
      validFrom: from,
      validUntil: until,
      redeemedVouchers: 0,
    });
    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, def.id), eq(auditLog.action, 'voucher_definition.create')));
    expect(row!.after).toMatchObject({ usageLimit: 100, perCustomerLimit: 1, validFrom: from, validUntil: until });
  });

  it('the ticket scope is the landed default and is stored as it always was (null)', async () => {
    const res = await create({ ...base(), target: { kind: 'tickets' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().definition.target).toBeNull();
  });

  it('refuses a scope that names nothing of this operator, a shop item as an item, a target on a kind that hands something over, and a window that ends before it starts', async () => {
    const unknown = await create({ ...base(), target: { kind: 'fnbCategory', category: newId() } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatchObject({ code: 'VOUCHER_TARGET_NOT_FOUND', message: 'No menu category with that id at this operator.' });

    const shopItem = await create({ ...base(), target: { kind: 'menuItems', menuItemIds: [plushId] } });
    expect(shopItem.statusCode).toBe(400);
    expect(shopItem.json().error.code).toBe('VOUCHER_TARGET_NOT_MENU');

    const onFreeItem = await create({
      ...base(),
      kind: 'free_item',
      valueType: 'item',
      valueSatang: null,
      productId: pizzaId,
      target: { kind: 'fnb' },
    });
    expect(onFreeItem.statusCode).toBe(400);
    expect(onFreeItem.json().error.code).toBe('VOUCHER_TARGET_NOT_FOR_KIND');

    const reversed = await create({ ...base(), validFrom: '2026-11-30', validUntil: '2026-11-01' });
    expect(reversed.statusCode).toBe(400);
    expect(reversed.json().error).toMatchObject({
      code: 'VOUCHER_WINDOW_INVALID',
      message: "The promotion's last day (1 Nov 2026) is before its first (30 Nov 2026).",
    });

    expect((await create({ ...base(), usageLimit: 0 })).statusCode).toBe(400);
    expect((await create({ ...base(), perCustomerLimit: -1 })).statusCode).toBe(400);
  });

  it('a kind changed away from a discount clears its scope rather than keeping one nobody can see', async () => {
    const made = await create({ ...base(), target: { kind: 'merch' } });
    const id = made.json().definition.id as string;
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/voucher-definitions/${id}`,
      headers: { cookie: admin },
      payload: { kind: 'free_item', valueType: 'item', productId: pizzaId },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().definition).toMatchObject({ kind: 'free_item', target: null, productId: pizzaId });
  });
});

describe('what a voucher comes off — a category or an item — and where the tax falls (the S2-09a seam)', () => {
  it('a ฿50 Drinks voucher comes off the juice only: the fnb base and its VAT move, the tickets’ do not', async () => {
    const def = await define({ nameEn: '฿50 off drinks', valueSatang: b(50), target: { kind: 'fnbCategory', category: drinksId } });
    const v = await issue(def);
    const looked = await lookup(tillA, v.code);
    expect(looked.statusCode, looked.body).toBe(200);
    expect(looked.json().voucher).toMatchObject({
      effect: { type: 'amount_off', appliesTo: 'category', valueSatang: b(50), label: drinksName },
      summary: `50 THB off ${drinksName}`,
    });

    const cart = family(t1.id, { items: [{ id: newId(), productId: juiceId, quantity: 1 }], pickupCode: 'A1' });
    const plain = await quote(tillA, cart);
    expect(plain.statusCode, plain.body).toBe(200);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    const withVoucher = await quote(tillA, { ...cart, promoCodes: [v.code] });
    expect(withVoucher.statusCode, withVoucher.body).toBe(200);

    const A = plain.json();
    const B = withVoucher.json();
    expect(B.voucher).toMatchObject({ amountSatang: b(50), applicable: true });
    expect(B.totals.grossSatang).toBe(A.totals.grossSatang - b(50));
    const cat = (q: { taxBreakdown: { categories: Array<{ category: string; base: number; tax: number }> } }, c: string) =>
      q.taxBreakdown.categories.find((x) => x.category === c)!;
    // The engine attributed the voucher to the category it covered and nowhere else.
    expect(cat(B, 'tickets')).toEqual(cat(A, 'tickets'));
    expect(cat(B, 'fnb').base).toBe(cat(A, 'fnb').base - b(50));
    expect(cat(B, 'fnb').tax).toBeLessThan(cat(A, 'fnb').tax);
    // The tax the sale lost is exactly the fnb category's, as the engine computed it.
    expect(A.taxBreakdown.taxTotal - B.taxBreakdown.taxTotal).toBe(cat(A, 'fnb').tax - cat(B, 'fnb').tax);
  });

  it('a cart with nothing in the scope: the quote says why, the commit refuses — the voucher is never used for nothing', async () => {
    const def = await define({ nameEn: '฿50 off drinks', valueSatang: b(50), target: { kind: 'fnbCategory', category: drinksId } });
    const v = await issue(def);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    const cart = { stationId: t1.id, lines: [], items: [{ id: newId(), productId: pizzaId, quantity: 1 }], pickupCode: 'A2', promoCodes: [v.code] };
    const q = await quote(tillA, cart);
    expect(q.json().voucher).toMatchObject({
      applicable: false,
      reason: `This voucher comes off ${drinksName}, and this sale has none left to take it off`,
    });
    const rung = await commit(tillA, { id: saleId, ...cart });
    expect(rung.statusCode).toBe(409);
    expect(rung.json().error.code).toBe('VOUCHER_NOT_APPLICABLE');
  });

  it('an item voucher takes off the named item only; a percentage on merch comes off the shop item, in the merch category', async () => {
    const item = await define({ nameEn: '฿20 off juice', valueSatang: b(20), target: { kind: 'menuItems', menuItemIds: [juiceId] } });
    const v = await issue(item);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    const q = await quote(tillA, {
      stationId: t1.id,
      lines: [],
      items: [
        { id: newId(), productId: juiceId, quantity: 1 },
        { id: newId(), productId: pizzaId, quantity: 1 },
      ],
      pickupCode: 'A3',
      promoCodes: [v.code],
    });
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json().voucher).toMatchObject({ amountSatang: b(20), applicable: true });
    expect(q.json().voucher.effect).toMatchObject({ appliesTo: 'items', label: 'Fresh Orange Juice' });

    const merch = await define({ nameEn: '10% off the shop', valueType: 'percent', valueSatang: null, valueBp: 1000, target: { kind: 'merch' } });
    const m = await issue(merch);
    const s2 = newId();
    expect((await hold(tillB, s2, m.code)).statusCode).toBe(200);
    const shop = await quote(tillB, { stationId: t2.id, lines: [], items: [{ id: newId(), productId: plushId, quantity: 1 }], promoCodes: [m.code] });
    expect(shop.statusCode, shop.body).toBe(200);
    const plushPrice = shop.json().totals.subtotalSatang as number;
    expect(shop.json().voucher.amountSatang).toBe(Math.round(plushPrice * 0.1));
    const merchLine = (shop.json().taxBreakdown.categories as Array<{ category: string; base: number }>).find((c) => c.category === 'merch')!;
    expect(merchLine.base).toBe(plushPrice - Math.round(plushPrice * 0.1));
  });
});

describe('a global limit holds under the real race: two tills, the last use — one success, one honest refusal', () => {
  it('both tills scan the last use at once: one holds it, the other is told it is used up, in the counter’s words', async () => {
    for (let round = 0; round < 3; round += 1) {
      const def = await define({ nameEn: 'Last one', usageLimit: 1 });
      const v1 = await issue(def);
      const v2 = await issue(def);
      const [a, bb] = await Promise.all([hold(tillA, newId(), v1.code), hold(tillB, newId(), v2.code)]);
      const answers = [a, bb];
      const won = answers.filter((r) => r.statusCode === 200);
      const lost = answers.filter((r) => r.statusCode !== 200);
      expect(won, `round ${round}`).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]!.statusCode).toBe(409);
      expect(lost[0]!.json().error).toMatchObject({
        code: 'VOUCHER_LIMIT_REACHED',
        message: 'This promotion is used up — its one redemption has been taken',
      });
      const held = (await Promise.all([voucherRow(v1.id), voucherRow(v2.id)])).filter((r) => r.heldSaleId !== null);
      expect(held).toHaveLength(1);
    }
  });

  it('a limit of two, used at two tills, refuses the third at the scan, the hold and from every till', async () => {
    const def = await define({ nameEn: 'Two only', usageLimit: 2 });
    const [v1, v2, v3] = [await issue(def), await issue(def), await issue(def)];
    await holdCommitPay(tillA, t1.id, v1.code, family(t1.id));
    await holdCommitPay(tillB, t2.id, v2.code, family(t2.id));
    for (const res of [await lookup(tillA, v3.code), await hold(tillB, newId(), v3.code)]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'VOUCHER_LIMIT_REACHED',
        message: 'This promotion is used up — all 2 redemptions have been taken',
      });
    }
    const defRow = await ctx.app.inject({ method: 'GET', url: '/voucher-definitions?includeArchived=true', headers: { cookie: admin } });
    const view = (defRow.json().definitions as Array<{ id: string; redeemedVouchers: number }>).find((d) => d.id === def)!;
    expect(view.redeemedVouchers).toBe(2);
  });

  it('a hold that lapsed while its cart sat is caught at Pay — before any money — not at the use-up', async () => {
    const def = await define({ nameEn: 'Lapsed race', usageLimit: 1 });
    const v1 = await issue(def);
    const v2 = await issue(def);
    const saleA = newId();
    expect((await hold(tillA, saleA, v1.code)).statusCode).toBe(200);
    // Till A walks away for twenty minutes: its hold no longer reserves the use.
    await ctx.db.update(voucher).set({ heldAt: new Date(Date.now() - 20 * 60_000) }).where(eq(voucher.id, v1.id));
    const saleB = newId();
    expect((await hold(tillB, saleB, v2.code)).statusCode).toBe(200);
    // Till A comes back and presses Pay first: its sale is rung up with v1.
    const rungA = await commit(tillA, { id: saleA, ...family(t1.id), promoCodes: [v1.code] });
    expect(rungA.statusCode, rungA.body).toBe(200);
    // Till B presses Pay: refused in the counter's words, and no sale is written.
    const rungB = await commit(tillB, { id: saleB, ...family(t2.id), promoCodes: [v2.code] });
    expect(rungB.statusCode).toBe(409);
    expect(rungB.json().error).toMatchObject({
      code: 'VOUCHER_LIMIT_REACHED',
      message: 'This promotion is used up — its one redemption has been taken',
    });
    expect(await saleRow(saleB)).toBeUndefined();
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleB))).toEqual([]);
    // Till A takes the money and the voucher is used once.
    const paid = await finalise(tillA, saleA, { method: 'cash', kind: 'cash', actionId: newId() });
    expect(paid.statusCode, paid.body).toBe(200);
    expect((await voucherRow(v1.id)).status).toBe('redeemed');
    expect((await voucherRow(v2.id)).status).toBe('issued');
  });

  it('the definition lock is one per definition, derived from its id', () => {
    const id = newId();
    expect(definitionLockId(id)).toEqual(definitionLockId(id));
    expect(definitionLockId(id)[0]).toBe(0x070f);
    expect(definitionLockId(id)).not.toEqual(definitionLockId(newId()));
  });
});

describe('a per-customer limit is keyed by the member; a walk-in is not held to it', () => {
  it('a member who used it once is refused a second, at the hold or at Pay; a walk-in is not', async () => {
    const def = await define({ nameEn: 'Once per guest', perCustomerLimit: 1 });
    // Issued at the till to the member — the issue route records whose it is.
    const issued = await ctx.app.inject({ method: 'POST', url: '/vouchers/issue', headers: { cookie: tillA }, payload: { definitionId: def, memberId } });
    expect(issued.statusCode, issued.body).toBe(200);
    const first = issued.json().voucher as { id: string; code: string };
    await holdCommitPay(tillA, t1.id, first.code, family(t1.id, { memberId }));

    const second = await issue(def, { memberId });
    const refusedAtHold = await hold(tillB, newId(), second.code);
    expect(refusedAtHold.statusCode).toBe(409);
    expect(refusedAtHold.json().error).toMatchObject({
      code: 'VOUCHER_CUSTOMER_LIMIT',
      message: 'This guest has already used this promotion once — the limit per guest',
    });

    // Anonymous paper: held freely, refused at Pay when the sale names the member…
    const third = await issue(def);
    const saleM = newId();
    expect((await hold(tillB, saleM, third.code)).statusCode).toBe(200);
    const rung = await commit(tillB, { id: saleM, ...family(t2.id, { memberId }), promoCodes: [third.code] });
    expect(rung.statusCode).toBe(409);
    expect(rung.json().error.code).toBe('VOUCHER_CUSTOMER_LIMIT');
    expect(await saleRow(saleM)).toBeUndefined();
    // …and used by a walk-in, who has nobody to count against.
    const walkIn = await commit(tillB, { id: saleM, ...family(t2.id), promoCodes: [third.code] });
    expect(walkIn.statusCode, walkIn.body).toBe(200);
  });
});

describe('the window is judged on the branch’s trading day', () => {
  it('the boundary is the day start (05:00), not midnight: 04:59 on the next calendar day is still the last day', async () => {
    const last = '2026-10-01';
    const def = { validFrom: null, validUntil: last };
    const endOfLast = businessDayEndsAt(last, tz, dayStart);
    expect(await promoWindowRefusal(ctx.db, def, hktId, new Date(endOfLast.getTime() - 60_000))).toBeNull();
    const after = await promoWindowRefusal(ctx.db, def, hktId, endOfLast);
    expect(after).toMatchObject({ code: 'VOUCHER_PROMOTION_ENDED', message: 'This promotion ended on 1 Oct 2026' });

    const first = { validFrom: '2026-10-05', validUntil: null };
    const startOfFirst = businessDayEndsAt('2026-10-04', tz, dayStart);
    const before = await promoWindowRefusal(ctx.db, first, hktId, new Date(startOfFirst.getTime() - 60_000));
    expect(before).toMatchObject({ code: 'VOUCHER_NOT_YET_VALID', message: 'This voucher can be used from 5 Oct 2026' });
    expect(await promoWindowRefusal(ctx.db, first, hktId, startOfFirst)).toBeNull();
  });

  it('at the till: ended yesterday is refused, starting tomorrow is refused, ending today is honoured', async () => {
    const t = today();
    const ended = await issue(await define({ nameEn: 'Ended', validUntil: addDaysToIsoDate(t, -1) }));
    const future = await issue(await define({ nameEn: 'Future', validFrom: addDaysToIsoDate(t, 1) }));
    const lastDay = await issue(await define({ nameEn: 'Last day', validUntil: t }));
    const e = await lookup(tillA, ended.code);
    expect(e.statusCode).toBe(409);
    expect(e.json().error.code).toBe('VOUCHER_PROMOTION_ENDED');
    const f = await hold(tillA, newId(), future.code);
    expect(f.statusCode).toBe(409);
    expect(f.json().error.code).toBe('VOUCHER_NOT_YET_VALID');
    expect((await lookup(tillA, lastDay.code)).statusCode).toBe(200);
    // An ended promotion is not issued either.
    const endedDef = (await voucherRow(ended.id)).voucherDefinitionId;
    const refused = await ctx.app.inject({ method: 'POST', url: '/vouchers/issue', headers: { cookie: tillA }, payload: { definitionId: endedDef } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('VOUCHER_PROMOTION_ENDED');
  });
});

describe('issue at the till, and minted for a campaign', () => {
  it('printed at the till: a check-charactered code on the till’s prefix, issued by the person, audited without the code, queued on the voucher slip', async () => {
    const def = await define({ nameEn: 'Birthday treat', termsEn: 'One per guest\nNot for cash' });
    const key = newId();
    const send = () =>
      ctx.app.inject({ method: 'POST', url: '/vouchers/issue', headers: { cookie: tillA, 'idempotency-key': key }, payload: { definitionId: def } });
    const res = await send();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(verifyBoothCode(body.voucher.code)).toEqual({ ok: true, prefix: 'T1' });
    const row = await voucherRow(body.voucher.id);
    expect(row).toMatchObject({ source: 'manual', status: 'issued', issuedByAccountId: receptionAccountId, branchId: hktId });
    // A replay of the press is the same voucher, not a second one.
    const again = await send();
    expect(again.json().voucher.id).toBe(body.voucher.id);
    expect(await ctx.db.select().from(voucher).where(eq(voucher.voucherDefinitionId, def))).toHaveLength(1);

    const [audited] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, 'voucher.issue')));
    expect(audited!.after).toMatchObject({ codeLast4: row.code.slice(-4), stationId: t1.id });
    expect(JSON.stringify(audited!.after)).not.toContain(row.code);

    const [job] = await ctx.db.select().from(printJob).where(and(eq(printJob.subjectType, 'voucher'), eq(printJob.subjectId, row.id)));
    expect(job).toMatchObject({ kind: 'booth_voucher', role: 'receipt', stationId: t1.id });
    expect(body.print.jobId).toBe(job!.id);
    if (job!.status === 'queued') {
      const [cmd] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.actionId, `voucher:${row.id}:print`));
      expect((cmd!.payload as { printJobId: string }).printJobId).toBe(job!.id);
    }
    // The box asks for the document: the voucher slip, the code twice from one string.
    const doc = await buildPrintDocument(ctx.db, { boxId: job!.boxId, operatorId }, job!.id);
    expect(doc.job.kind).toBe('booth_voucher');
    expect(doc.job.data).toMatchObject({
      voucherCode: row.code,
      prizeLine: 'Birthday treat',
      terms: ['One per guest', 'Not for cash'],
      booth: expect.stringContaining(t1.name),
    });
    // And it redeems like any voucher.
    expect((await lookup(tillB, row.code)).statusCode).toBe(200);
  });

  it('the till’s picker lists what may be issued today: an ended promotion and a switched-off type are not offered', async () => {
    const t = today();
    const open = await define({ nameEn: 'Open promotion', validUntil: addDaysToIsoDate(t, 3) });
    const ended = await define({ nameEn: 'Ended promotion', validUntil: addDaysToIsoDate(t, -1) });
    const off = await define({ nameEn: 'Switched off', active: false });
    const res = await ctx.app.inject({ method: 'GET', url: '/vouchers/issuable', headers: { cookie: tillA } });
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json().definitions as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toContain(open);
    expect(ids).not.toContain(ended);
    expect(ids).not.toContain(off);
    const refused = await ctx.app.inject({ method: 'POST', url: '/vouchers/issue', headers: { cookie: tillA }, payload: { definitionId: off } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'VOUCHER_DEFINITION_INACTIVE', message: 'Switched off cannot be issued — this voucher type is switched off' });
  });

  it('a campaign: every code unique, the batch audited once, the codes never in an answer, replay mints nothing', async () => {
    const def = await define({ nameEn: 'Mall campaign' });
    const key = newId();
    const mint = (k: string, quantity: number) =>
      ctx.app.inject({
        method: 'POST',
        url: '/voucher-campaigns',
        headers: { cookie: admin, 'idempotency-key': k },
        payload: { definitionId: def, branchId: hktId, name: 'October mall', quantity },
      });
    const res = await mint(key, 300);
    expect(res.statusCode, res.body).toBe(200);
    const campaign = res.json().campaign;
    expect(campaign).toMatchObject({ quantity: 300, redeemed: 0, definitionId: def });
    const codes = await ctx.db.select().from(voucher).where(eq(voucher.campaignId, campaign.id));
    expect(codes).toHaveLength(300);
    expect(new Set(codes.map((c) => c.code)).size).toBe(300);
    expect(codes.every((c) => verifyBoothCode(c.code).ok && c.source === 'campaign')).toBe(true);
    for (const c of codes) expect(res.body).not.toContain(c.code);
    // Replayed: the same campaign, nothing minted twice.
    const again = await mint(key, 300);
    expect(again.json().campaign.id).toBe(campaign.id);
    expect(await ctx.db.select().from(voucherCampaign).where(eq(voucherCampaign.voucherDefinitionId, def))).toHaveLength(1);
    // A second batch: still unique across both.
    const second = await mint(newId(), 300);
    const all = await ctx.db.select().from(voucher).where(eq(voucher.voucherDefinitionId, def));
    expect(all).toHaveLength(600);
    expect(new Set(all.map((c) => c.code)).size).toBe(600);
    expect(second.json().campaign.id).not.toBe(campaign.id);
    const audits = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, campaign.id), eq(auditLog.action, 'voucher_campaign.create')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ quantity: 300, definitionId: def });

    // The manager reads the codes through the export, and one redeems at a till.
    const csv = await ctx.app.inject({ method: 'GET', url: `/voucher-campaigns/${campaign.id}/codes`, headers: { cookie: admin } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['cache-control']).toBe('no-store');
    const lines = csv.body.trim().split('\n');
    expect(lines).toHaveLength(301);
    const one = lines[1]!.split(',')[0]!;
    expect((await lookup(tillA, one)).statusCode).toBe(200);
    // Reception cannot mint.
    const refused = await ctx.app.inject({
      method: 'POST',
      url: '/voucher-campaigns',
      headers: { cookie: tillA },
      payload: { definitionId: def, branchId: hktId, name: 'Nope', quantity: 1 },
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe('a wallet-credit voucher loads a wallet — exactly once — through the wallet service', () => {
  it('rung up on its own at ฿0, the close loads ฿100 onto a new wallet: a promo_voucher grant, action-keyed, no takings, no drawer', async () => {
    const def = await define({ nameEn: '฿100 food credit', kind: 'wallet_credit', valueType: 'amount', valueSatang: b(100) });
    const issued = await ctx.app.inject({ method: 'POST', url: '/vouchers/issue', headers: { cookie: tillA }, payload: { definitionId: def } });
    expect(issued.statusCode, issued.body).toBe(200);
    const v = issued.json().voucher as { id: string; code: string };
    const looked = await lookup(tillA, v.code);
    expect(looked.json().voucher).toMatchObject({
      effect: { type: 'wallet_credit', valueSatang: b(100) },
      summary: 'Ring up to load 100 THB of credit onto a new wallet',
      redeemableOffline: false,
    });

    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    const cart = { stationId: t1.id, lines: [], items: [], promoCodes: [v.code] };
    const rung = await commit(tillA, { id: saleId, ...cart, expectedTotalSatang: 0 });
    expect(rung.statusCode, rung.body).toBe(200);
    expect(rung.json()).toMatchObject({ outstandingSatang: 0 });
    // Nothing loaded until the sale closes.
    expect(await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, saleId))).toEqual([]);

    const kicks = (await ctx.db.select().from(boxCommand).where(and(eq(boxCommand.boxId, t1.boxId!), eq(boxCommand.kind, 'drawer_kick')))).length;
    const key = newId();
    const closed = await finalise(tillA, saleId, undefined, key);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({ finalised: true, redeemedVoucherIds: [v.id] });

    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, saleId));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'grant',
      source: 'promo_voucher',
      amountSatang: b(100),
      balanceAfter: b(100),
      actionId: voucherLoadActionId(v.id),
      stationId: t1.id,
      branchId: hktId,
    });
    expect(entries[0]!.expiresAt).not.toBeNull();
    // No money moved: no attempt, nothing counted as takings, no drawer.
    const attempts = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    expect(attempts.filter((a) => countsAsTillTakings(a))).toEqual([]);
    expect((await ctx.db.select().from(boxCommand).where(and(eq(boxCommand.boxId, t1.boxId!), eq(boxCommand.kind, 'drawer_kick')))).length).toBe(kicks);

    // The till reads the wallet and its ONE QR.
    const credit = await ctx.app.inject({ method: 'GET', url: `/vouchers/${v.id}/credit`, headers: { cookie: tillA } });
    expect(credit.statusCode, credit.body).toBe(200);
    expect(credit.json().wallet).toMatchObject({ balanceSatang: b(100), holderName: 'Voucher credit', status: 'active' });
    const qr = credit.json().qrCode as string;
    expect(qr).toMatch(/^QR-/);

    // REPLAYED: the close with the same key, the close again, the load called again — one entry.
    expect((await finalise(tillA, saleId, undefined, key)).statusCode).toBe(200);
    await finalise(tillA, saleId);
    const replay = await ctx.db.transaction((tx) =>
      loadWalletFromVoucher(tx, { accountId: receptionAccountId, operatorId }, {
        voucherId: v.id,
        amountSatang: b(100),
        branchId: hktId,
        saleId,
        stationId: t1.id,
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(await ctx.db.select().from(walletEntry).where(eq(walletEntry.actionId, voucherLoadActionId(v.id)))).toHaveLength(1);
    expect(await ctx.db.select().from(wallet).where(eq(wallet.id, replay.wallet.id))).toHaveLength(1);
    await assertLedgerTruth();

    // The credit voucher prints on the landed template, subject the wallet.
    const printed = await ctx.app.inject({ method: 'POST', url: `/vouchers/${v.id}/credit/print`, headers: { cookie: tillA } });
    expect(printed.statusCode, printed.body).toBe(200);
    const [job] = await ctx.db.select().from(printJob).where(and(eq(printJob.subjectType, 'wallet'), eq(printJob.subjectId, replay.wallet.id)));
    expect(job!.kind).toBe('credit_voucher');

    // And it spends at the F&B counter like any credit.
    const fnb = newId();
    const rungFnb = await commit(tillA, { id: fnb, stationId: t1.id, channel: 'fnb', pickupCode: 'C1', items: [{ id: newId(), productId: juiceId, quantity: 1 }] });
    expect(rungFnb.statusCode, rungFnb.body).toBe(200);
    const spent = await finalise(tillA, fnb, { wallet: { key: qr, useCredit: true }, actionId: newId() });
    expect(spent.statusCode, spent.body).toBe(200);
    expect(spent.json().finalised).toBe(true);
    const walletAttempts = await ctx.db.select().from(paymentAttempt).where(and(eq(paymentAttempt.saleId, fnb), eq(paymentAttempt.method, 'wallet')));
    expect(walletAttempts).toHaveLength(1);
    expect(countsAsTillTakings(walletAttempts[0]!)).toBe(false);
    await assertLedgerTruth();
  });

  it('beside other things on a paid sale, a wallet-credit voucher still loads once, when that sale closes', async () => {
    const def = await define({ nameEn: '฿60 credit', kind: 'wallet_credit', valueType: 'amount', valueSatang: b(60) });
    const v = await issue(def);
    const saleId = await holdCommitPay(tillB, t2.id, v.code, { lines: [], items: [{ id: newId(), productId: juiceId, quantity: 1 }], pickupCode: 'C2' });
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, saleId));
    expect(entries.filter((e) => e.source === 'promo_voucher').map((e) => e.amountSatang)).toEqual([b(60)]);
  });
});

describe('foregone revenue is its own line, separate from discounts, and reconciles with the redemptions', () => {
  it('the report’s rows equal the vouchers used and their own discount rows, to the satang; manual discounts and promo codes are not in it', async () => {
    // A voucher sale that also carries a manual discount: only the voucher's ฿100 is foregone revenue here.
    const def = await define({ nameEn: 'Report voucher' });
    const v = await issue(def);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    const rung = await commit(tillA, {
      id: saleId,
      ...family(t1.id),
      promoCodes: [v.code],
      manualDiscounts: [{ id: newId(), scope: 'order', type: 'fixed', value: b(30), reason: 'Birthday' }],
    });
    expect(rung.statusCode, rung.body).toBe(200);
    expect((await finalise(tillA, saleId, { method: 'cash', kind: 'cash', actionId: newId() })).statusCode).toBe(200);
    // A promo-code sale: a discount, never foregone voucher revenue.
    const coded = newId();
    const codeSale = await commit(tillB, { id: coded, ...family(t2.id), promos: [{ code: 'STAFF10', label: 'Staff', type: 'percent', value: 10 }] });
    expect(codeSale.statusCode, codeSale.body).toBe(200);

    const day = today();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/vouchers/promotions/report?branchId=${hktId}&from=${day}&to=${day}`,
      headers: { cookie: manager },
    });
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json();

    // By hand, from the ledger the redemptions wrote.
    const { rows } = await ctx.db.execute<{ definition_id: string; n: number; foregone: string; credit: string }>(sql`
      select v.voucher_definition_id as definition_id, count(*)::int as n,
        coalesce(sum((select coalesce(sum(sd.amount_satang),0) from pos.sale_discount sd where sd.sale_id = v.sale_id and sd.kind = 'promo' and sd.code = v.code)),0)::bigint as foregone,
        coalesce(sum((select coalesce(sum(e.amount_satang),0) from pos.wallet_entry e where e.action_id = 'voucher:' || v.id::text || ':load')),0)::bigint as credit
      from promo.voucher v join pos.sale s on s.id = v.sale_id
      where v.status = 'redeemed' and s.branch_id = ${hktId}::uuid and s.business_date = ${day}::date
      group by v.voucher_definition_id`);
    const consumed = await ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from promo.voucher_redemption r join pos.sale s on s.id = r.sale_id
      where r.kind = 'consumed' and s.branch_id = ${hktId}::uuid and s.business_date = ${day}::date`);
    expect(report.summary.redemptions).toBe(Number(consumed.rows[0]!.n));
    expect(report.summary.redemptions).toBe(rows.reduce((s, r) => s + Number(r.n), 0));
    expect(report.summary.foregoneSatang).toBe(rows.reduce((s, r) => s + Number(r.foregone), 0));
    expect(report.summary.creditLoadedSatang).toBe(rows.reduce((s, r) => s + Number(r.credit), 0));
    expect(report.summary.creditLoadedSatang).toBe(b(160));
    for (const r of rows) {
      const line = (report.rows as Array<{ definitionId: string; redemptions: number; foregoneSatang: number }>).find((x) => x.definitionId === r.definition_id)!;
      expect(line).toMatchObject({ redemptions: Number(r.n), foregoneSatang: Number(r.foregone) });
    }
    const mine = (report.rows as Array<{ definitionId: string; foregoneSatang: number; redemptions: number }>).find((x) => x.definitionId === def)!;
    expect(mine).toMatchObject({ redemptions: 1, foregoneSatang: b(100) });
    // The manual discount and the promo code are discounts, not in this line.
    const [manualRow] = await ctx.db.select().from(saleDiscount).where(and(eq(saleDiscount.saleId, saleId), eq(saleDiscount.kind, 'manual')));
    expect(manualRow!.amountSatang).toBe(b(30));
    expect(report.summary.foregoneSatang).toBe(rows.reduce((s, r) => s + Number(r.foregone), 0));
  });

  it('reception cannot read it; a range the wrong way round is refused', async () => {
    const day = today();
    expect((await ctx.app.inject({ method: 'GET', url: `/vouchers/promotions/report?from=${day}&to=${day}`, headers: { cookie: tillA } })).statusCode).toBe(403);
    const back = await ctx.app.inject({
      method: 'GET',
      url: `/vouchers/promotions/report?from=${day}&to=${addDaysToIsoDate(day, -1)}`,
      headers: { cookie: manager },
    });
    expect(back.statusCode).toBe(400);
  });
});
