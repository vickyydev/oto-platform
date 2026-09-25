import { randomInt } from 'node:crypto';
import pg from 'pg';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  alert,
  auditLog,
  boxState,
  branch,
  discountDefinition,
  employee,
  member,
  paymentAttempt,
  product,
  redemptionThrottle,
  sale,
  saleDiscount,
  saleLine,
  station,
  ticketPackage,
  voucher,
  voucherDefinition,
  voucherRedemption,
} from '@oto/db';
import {
  BOOTH_CODE_ALPHABET,
  boothCodeCheckCharacter,
  boothStaffCode,
  mintBoothCode,
  newId,
} from '@oto/shared';
import {
  CHALONG_MANAGER,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { resetDemoData } from '../src/services/demo-reset';
import { commitSale } from '../src/services/sale';
import { openQrAttempt, simulateGatewayEvent } from '../src/services/payments/gateway';
import {
  OfflineSalePayloadSchema,
  replayOfflineSale,
  type ReplayScope,
} from '../src/services/payments/offline';
import { consumeSaleVouchers } from '../src/services/vouchers';

/**
 * S2-10b (SCRUM-207) — a voucher at the counter, through the real routes with
 * real sessions standing at real tills, asserting the rows that land.
 *
 * THE OWNER'S RULES (24 September) are the headings below. Every refusal is
 * asserted by its code AND its exact words, because the words are what the
 * counter shows a guest.
 *
 * THE FIXTURES are the seeded park: Reception Till 1 (T1) and Counter 2 (T2)
 * at Central Floresta, Reception Till 1 (T3) at Robinson Chalong. 2 Hours Play
 * is ฿890 a kid at the tourist rate on every day of the week, and a walk-in is
 * priced at the tourist rate. The vouchers are written straight into
 * `promo.voucher` as the booth sync would write them; the booth end is proved
 * by the local run against the virtual box.
 */

let ctx: TestContext;
/** Reception, standing at Reception Till 1. */
let tillA: string;
/** Reception again, in a second session standing at Counter 2. */
let tillB: string;
/** The Chalong manager, standing at Chalong's till. */
let chalongTill: string;
/** Reception with no till picked. */
let seatless: string;

let operatorId: string;
let hktId: string;
let chalongId: string;
let t1: typeof station.$inferSelect;
let t2: typeof station.$inferSelect;
let t3: typeof station.$inferSelect;
let receptionAccountId: string;
let twoHoursHkt: string;
let twoHoursChalong: string;
let eatPlayHkt: string;
let juiceId: string;
let pizzaId: string;
let plushId: string;

const defs: Record<string, string> = {};

/** Satang from baht, so the fixtures read like the price list. */
const b = (baht: number): number => Math.round(baht * 100);
const KID = b(890);

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

async function define(values: Partial<typeof voucherDefinition.$inferInsert>): Promise<string> {
  const id = newId();
  await ctx.db.insert(voucherDefinition).values({
    id,
    operatorId,
    code: `test-${id}`,
    nameEn: 'Test voucher',
    kind: 'discount',
    ...values,
  } as typeof voucherDefinition.$inferInsert);
  return id;
}

/** A voucher as the booth sync files one: a fresh eleven-character code, issued now, 14 days. */
async function issue(
  definitionId: string,
  opts: {
    code?: string;
    source?: 'booth' | 'legacy' | 'manual';
    issuedAt?: Date;
    expiresAt?: Date | null;
    branchId?: string;
    /** Who was signed in at the booth; left out, the spin was unattributed. */
    issuedByAccountId?: string | null;
  } = {},
): Promise<{ id: string; code: string }> {
  const id = newId();
  const code = opts.code ?? mintBoothCode('B1', (max) => randomInt(max));
  const issuedAt = opts.issuedAt ?? new Date();
  await ctx.db.insert(voucher).values({
    id,
    operatorId,
    branchId: opts.branchId ?? hktId,
    voucherDefinitionId: definitionId,
    code,
    source: opts.source ?? 'booth',
    status: 'issued',
    issuedByAccountId: opts.issuedByAccountId ?? null,
    issuedAt,
    expiresAt:
      opts.expiresAt === undefined
        ? new Date(issuedAt.getTime() + 14 * 86_400_000)
        : opts.expiresAt,
  });
  return { id, code };
}

const lookup = (cookie: string, code: string) =>
  ctx.app.inject({
    method: 'GET',
    url: `/vouchers/lookup?code=${encodeURIComponent(code)}`,
    headers: { cookie },
  });

const hold = (cookie: string, saleId: string, code: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/vouchers`,
    headers: { cookie },
    payload: { code },
  });

const release = (cookie: string, saleId: string, voucherId: string) =>
  ctx.app.inject({
    method: 'DELETE',
    url: `/sales/${saleId}/vouchers/${voucherId}`,
    headers: { cookie },
  });

const quote = (cookie: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/sales/quote', headers: { cookie }, payload });

const commit = (cookie: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie }, payload });

const finalise = (cookie: string, saleId: string, payload?: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });

/** A walk-in's ticket cart: kids on one package, rung up at a till. */
const kids = (
  count: number,
  opts: {
    packageId?: string;
    stationId?: string;
    codes?: string[];
    extra?: Record<string, unknown>;
  } = {},
): Record<string, unknown> => ({
  stationId: opts.stationId ?? t1.id,
  lines: [{ id: newId(), packageId: opts.packageId ?? twoHoursHkt, kids: count, adults: 0 }],
  ...(opts.codes ? { promoCodes: opts.codes } : {}),
  ...opts.extra,
});

async function voucherRow(id: string) {
  const [row] = await ctx.db.select().from(voucher).where(eq(voucher.id, id)).limit(1);
  return row!;
}

async function ledgerOf(voucherId: string) {
  return (
    ctx.db
      .select()
      .from(voucherRedemption)
      .where(eq(voucherRedemption.voucherId, voucherId))
      // `created_at` is the transaction's clock, so two rows written in one
      // transaction share it; their UUIDv7 ids are minted in order.
      .orderBy(asc(voucherRedemption.createdAt), asc(voucherRedemption.id))
  );
}

/** Hold a voucher on a fresh cart at a till and ring it up. Returns the sale id. */
async function holdAndCommit(
  cookie: string,
  code: string,
  cart: Record<string, unknown>,
): Promise<string> {
  const saleId = newId();
  const held = await hold(cookie, saleId, code);
  expect(held.statusCode, held.body).toBe(200);
  const rung = await commit(cookie, { id: saleId, ...cart, promoCodes: [code] });
  expect(rung.statusCode, rung.body).toBe(200);
  return saleId;
}

/** The till's cancel. */
const voidSale = (
  cookie: string,
  saleId: string,
  reason = 'Guest left before paying',
  key?: string,
) =>
  ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/void`,
    headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
    payload: { reason },
  });

/** A card keyed in off the terminal's slip (`POST /payments/manual`). */
const manualCard = (cookie: string, saleId: string, extra: Record<string, unknown> = {}) =>
  ctx.app.inject({
    method: 'POST',
    url: '/payments/manual',
    headers: { cookie },
    payload: { saleId, approvalCode: '123456', tid: '12345678', last4: '4242', ...extra },
  });

/** Card pressed at the till: the tender sent to the station's terminal (`POST /payments/attempts`). */
const terminalTender = (cookie: string, saleId: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/payments/attempts',
    headers: { cookie },
    payload: { saleId },
  });

/**
 * A gateway QR on a sale, opened the way the 2C2P suite opens one: the till's
 * QR route is not built yet, and `openQrAttempt` is what it will call.
 */
async function showQr(saleId: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  return openQrAttempt(
    ctx.db,
    ctx.app.env,
    ctx.app.log,
    { operatorId, branchId: hktId, requestId: `test-${newId()}` },
    {
      operatorId,
      branchId: hktId,
      saleId,
      stationId: row!.stationId,
      businessDate: row!.businessDate,
      amountSatang: row!.grossSatang,
      methodCode: 'promptpay',
      actionId: newId(),
      accountId: receptionAccountId,
      description: 'Voucher test',
    },
  );
}

/** What the gateway simulator reports when the guest pays, or the bank says no. */
const gatewaySays = (attemptId: string, event: 'paid' | 'decline') =>
  simulateGatewayEvent(ctx.db, ctx.app.env, ctx.app.log, { attemptId, event, operatorId });

async function attemptsOf(saleId: string) {
  return ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
}

async function saleRow(saleId: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  return row!;
}

/**
 * A correction made outside the api: the hold taken off a rung-up sale in psql.
 *
 * A sale rung up with a voucher is never taken over and its line is never taken
 * off, even by a removal racing Pay (`releaseRace`), so this is the only way
 * left to reach the state the tender guard exists for — a sale priced with a
 * voucher that is no longer its own.
 */
async function dropHoldOutOfBand(voucherId: string): Promise<void> {
  await ctx.db
    .update(voucher)
    .set({ heldSaleId: null, heldStationId: null, heldByAccountId: null, heldAt: null })
    .where(eq(voucher.id, voucherId));
}

/** Backdate a rung-up sale and its hold, past any lapse window. */
async function ageHold(saleId: string | null, voucherId: string, minutes: number): Promise<void> {
  const then = new Date(Date.now() - minutes * 60_000);
  await ctx.db.update(voucher).set({ heldAt: then }).where(eq(voucher.id, voucherId));
  if (saleId) await ctx.db.update(sale).set({ createdAt: then }).where(eq(sale.id, saleId));
}

beforeAll(async () => {
  ctx = await createTestContext();

  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central')!;
  const chalong = branches.find((row) => row.code === 'robinson-chalong')!;
  hktId = hkt.id;
  chalongId = chalong.id;
  operatorId = hkt.operatorId;

  const stations = await ctx.db.select().from(station).where(eq(station.operatorId, operatorId));
  t1 = stations.find((s) => s.branchId === hktId && s.codePrefix === 'T1')!;
  t2 = stations.find((s) => s.branchId === hktId && s.codePrefix === 'T2')!;
  t3 = stations.find((s) => s.branchId === chalongId && s.codePrefix === 'T3')!;

  const packages = await ctx.db
    .select()
    .from(ticketPackage)
    .where(eq(ticketPackage.operatorId, operatorId));
  twoHoursHkt = packages.find((p) => p.branchId === hktId && p.name === '2 Hours Play')!.id;
  twoHoursChalong = packages.find((p) => p.branchId === chalongId && p.name === '2 Hours Play')!.id;
  eatPlayHkt = packages.find((p) => p.branchId === hktId && p.name === 'Eat & Play Kids Pass')!.id;

  const products = await ctx.db.select().from(product).where(eq(product.operatorId, operatorId));
  juiceId = products.find((p) => p.code === 'FB-JUICE')!.id;
  pizzaId = products.find((p) => p.code === 'FB-PIZZA')!.id;
  plushId = products.find((p) => p.code === 'MR-PLUSH' && p.branchId === hktId)!.id;

  const [reception] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.operatorId, operatorId), eq(account.phone, RECEPTION.phone)));
  receptionAccountId = reception!.id;

  const seeded = await ctx.db
    .select()
    .from(voucherDefinition)
    .where(eq(voucherDefinition.operatorId, operatorId));
  for (const row of seeded) defs[row.code] = row.id;
  defs.huge = await define({
    nameEn: '5000 THB Voucher',
    valueType: 'amount',
    valueSatang: b(5000),
  });
  defs.percent = await define({ nameEn: '20% off', valueType: 'percent', valueBp: 2000 });
  defs.pizza = await define({
    nameEn: 'Kids Pizza',
    nameTh: 'พิซซ่าสำหรับเด็ก',
    kind: 'free_item',
    valueType: 'item',
    productId: pizzaId,
  });
  defs.oneplusone = await define({
    nameEn: '1+1 Kids Ticket',
    kind: 'free_ticket',
    valueType: 'item',
    ticketPackageId: twoHoursHkt,
  });
  defs.mystery = await define({ nameEn: 'Mystery Gift', kind: 'manual', valueType: 'none' });
  defs.wallet = await define({
    nameEn: 'Wallet credit',
    kind: 'wallet_credit',
    valueType: 'amount',
    valueSatang: b(100),
  });
  defs.allow = await define({
    nameEn: '100 THB (old code)',
    valueType: 'amount',
    valueSatang: b(100),
  });
  defs.refuse = await define({
    nameEn: '100 THB (online only)',
    valueType: 'amount',
    valueSatang: b(100),
    offlinePolicy: 'refuse',
  });

  tillA = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await pick(tillA, t1.id);
  tillB = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await pick(tillB, t2.id);
  chalongTill = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  await pick(chalongTill, t3.id);
  seatless = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
}, 180_000);

afterEach(async () => {
  // The guessing limit is per till and would otherwise carry from one test to
  // the next; the offline switch likewise.
  await ctx.db.delete(redemptionThrottle);
  await ctx.db.update(boxState).set({ offline: false, offlineSince: null, offlineReason: null });
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// ---------------------------------------------------------------------------

describe('a scan says at once what the voucher is, and uses nothing up', () => {
  it('answers the prize, what it is worth here and where it came from', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const res = await lookup(tillA, v.code);
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json().voucher;
    expect(view).toMatchObject({
      id: v.id,
      code: v.code,
      source: 'booth',
      state: 'available',
      prize: { nameEn: '150 THB Voucher', nameTh: 'บัตรกำนัล 150 บาท' },
      kind: 'discount',
      effect: { type: 'amount_off', appliesTo: 'tickets', valueSatang: b(150) },
      summary: '150 THB off the ticket order',
      issuedBranch: { id: hktId },
      legacyFormat: false,
      hold: null,
      // Spec §8: never trusted offline, whatever the definition says.
      redeemableOffline: false,
    });
  });

  it('reads the code the way a scanner or a person sends it', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const written = `${v.code.slice(0, 2).toLowerCase()}-${v.code.slice(2, 6)} ${v.code.slice(6)}\r\n`;
    const res = await lookup(tillA, written);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().voucher.id).toBe(v.id);
  });

  it('never consumes: the row, the ledger and the audit trail are exactly as they were', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const before = await voucherRow(v.id);
    for (let i = 0; i < 3; i += 1) {
      expect((await lookup(tillA, v.code)).statusCode).toBe(200);
    }
    expect(await voucherRow(v.id)).toEqual(before);
    expect(await ledgerOf(v.id)).toEqual([]);
    const trail = await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, v.id));
    expect(trail).toEqual([]);
  });

  it('says who printed it, as the slip’s Staff line does — and null when nobody was signed in', async () => {
    // The name the slip prints is the employee's nickname, else their name.
    const [who] = await ctx.db
      .select({ name: employee.name, nickname: employee.nickname })
      .from(account)
      .innerJoin(employee, eq(employee.id, account.employeeId))
      .where(eq(account.id, receptionAccountId));
    const signedIn = await issue(defs['spin-voucher-150']!, {
      issuedByAccountId: receptionAccountId,
    });
    const looked = await lookup(tillA, signedIn.code);
    expect(looked.statusCode, looked.body).toBe(200);
    expect(looked.json().voucher.issuedBy).toEqual({
      name: who!.nickname ?? who!.name,
      code: boothStaffCode(receptionAccountId),
    });
    expect(looked.json().voucher.issuedBy.code).toMatch(/^S-[2-9A-Z]{4}$/);
    // The hold answers with the same view, so the card keeps the line.
    const saleId = newId();
    const held = await hold(tillA, saleId, signedIn.code);
    expect(held.statusCode, held.body).toBe(200);
    expect(held.json().voucher.issuedBy).toEqual(looked.json().voucher.issuedBy);
    expect((await release(tillA, saleId, signedIn.id)).statusCode).toBe(200);

    // An account with no employee behind it still has its code; no name is invented.
    const bareId = newId();
    await ctx.db.insert(account).values({
      id: bareId,
      operatorId,
      phone: `+6689${String(randomInt(1_000_000, 9_999_999))}`,
      status: 'active',
    });
    const bare = await issue(defs['spin-voucher-150']!, { issuedByAccountId: bareId });
    expect((await lookup(tillA, bare.code)).json().voucher.issuedBy).toEqual({
      name: null,
      code: boothStaffCode(bareId),
    });

    // Unattributed: a spin with nobody signed in still printed, and says so.
    const nobody = await issue(defs['spin-voucher-150']!);
    expect((await lookup(tillA, nobody.code)).json().voucher.issuedBy).toBeNull();
  });

  it('says what kind of product a free item is — the menu’s or the shop’s — so a till knows whose it is', async () => {
    const pizza = await issue(defs.pizza!);
    expect((await lookup(tillA, pizza.code)).json().voucher.effect).toMatchObject({
      type: 'free_item',
      product: { name: 'Margherita Pizza', kind: 'menu' },
    });
    const plush = await issue(
      await define({ nameEn: 'Mascot Plush', kind: 'free_item', valueType: 'item', productId: plushId }),
    );
    expect((await lookup(tillA, plush.code)).json().voucher.effect).toMatchObject({
      type: 'free_item',
      product: { id: plushId, name: 'Oto Mascot Plush', kind: 'merch' },
    });
  });
});

describe('the exact words for every refusal', () => {
  it('Invalid code — a code no booth could print', async () => {
    for (const code of ['ZZZZ9', 'hello', 'B1RT7KMQ4O?']) {
      const res = await lookup(tillA, code);
      expect(res.statusCode, code).toBe(422);
      expect(res.json().error).toEqual({ code: 'INVALID_CODE', message: 'Invalid code' });
    }
  });

  it('Invalid code — one altered character, caught by the check character', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const i = 5;
    const replacement = BOOTH_CODE_ALPHABET.split('').find((c) => c !== v.code[i])!;
    const altered = v.code.slice(0, i) + replacement + v.code.slice(i + 1);
    const res = await lookup(tillA, altered);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({ code: 'INVALID_CODE', message: 'Invalid code' });
  });

  it('Invalid code — Radar’s four-character shape that nothing has imported', async () => {
    const res = await lookup(tillA, '4821');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toBe('Invalid code');
  });

  it('Code not found — a well-formed code the platform has not heard of yet', async () => {
    const unsynced = mintBoothCode('B1', (max) => randomInt(max));
    const res = await lookup(tillA, unsynced);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({
      code: 'NOT_FOUND',
      message: 'Code not found — the booth may not have synced yet',
    });
  });

  it('Voucher expired on <date>', async () => {
    const v = await issue(defs['spin-voucher-150']!, {
      issuedAt: new Date('2026-01-01T03:00:00Z'),
      expiresAt: new Date('2026-01-15T05:00:00Z'),
    });
    for (const res of [await lookup(tillA, v.code), await hold(tillA, newId(), v.code)]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EXPIRED');
      // 05:00 UTC is noon in Bangkok, on the 15th.
      expect(res.json().error.message).toBe('Voucher expired on 15 Jan 2026');
    }
    expect((await voucherRow(v.id)).heldSaleId).toBeNull();
  });

  it('This voucher is in use at <station>', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    expect((await hold(tillB, newId(), v.code)).statusCode).toBe(200);
    for (const res of [await lookup(tillA, v.code), await hold(tillA, newId(), v.code)]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('HELD_ELSEWHERE');
      expect(res.json().error.message).toBe('This voucher is in use at Counter 2');
    }
  });

  it("This voucher's item is not set up yet — ask a manager", async () => {
    // The seeded Kids Pizza and 1+1 name no product and no package — as staging's do.
    for (const definition of ['spin-kids-pizza', 'spin-kids-ticket-1-plus-1']) {
      const v = await issue(defs[definition]!);
      for (const res of [await lookup(tillA, v.code), await hold(tillA, newId(), v.code)]) {
        expect(res.statusCode, definition).toBe(409);
        expect(res.json().error.code).toBe('VOUCHER_NOT_SET_UP');
        expect(res.json().error.message).toBe(
          "This voucher's item is not set up yet — ask a manager",
        );
      }
      expect((await voucherRow(v.id)).heldSaleId).toBeNull();
    }
    const wallet = await issue(defs.wallet!);
    expect((await lookup(tillA, wallet.code)).json().error.code).toBe('VOUCHER_NOT_SET_UP');
  });

  it('Already redeemed on <date time> at <branch/station> by <staff>', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    const paid = await finalise(tillA, saleId);
    expect(paid.statusCode, paid.body).toBe(200);
    const receipt = paid.json().sale.receiptNumber as string;

    const res = await lookup(tillB, v.code);
    expect(res.statusCode).toBe(409);
    const error = res.json().error;
    expect(error.code).toBe('ALREADY_REDEEMED');
    expect(error.message).toMatch(
      /^Already redeemed on \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2} at Oto Play Park, Central Floresta \/ Reception Till 1 by Som \(Reception\)$/,
    );
    expect(error.details).toMatchObject({
      stationName: 'Reception Till 1',
      staffName: 'Som (Reception)',
      saleId,
      receiptNumber: receipt,
    });
    // And a second sale cannot put it on a cart at all.
    const again = await hold(tillB, newId(), v.code);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_REDEEMED');
  });
});

describe('held at the scan, used up when the sale is paid', () => {
  it('records who, when, where and which sale, in one transaction with the payment', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = newId();
    const started = new Date();

    const held = await hold(tillA, saleId, v.code);
    expect(held.statusCode, held.body).toBe(200);
    expect(held.json()).toMatchObject({
      saleId,
      alreadyHeld: false,
      voucher: {
        state: 'held_here',
        hold: { saleId, stationId: t1.id, stationName: 'Reception Till 1' },
      },
    });
    expect(await voucherRow(v.id)).toMatchObject({
      status: 'issued',
      heldSaleId: saleId,
      heldStationId: t1.id,
      heldByAccountId: receptionAccountId,
    });

    // The quote prices it from the definition — the till sends only the code.
    const priced = await quote(tillA, kids(1, { codes: [v.code] }));
    expect(priced.statusCode, priced.body).toBe(200);
    expect(priced.json().totals.grossSatang).toBe(KID - b(150));
    expect(priced.json().voucher).toMatchObject({
      voucherId: v.id,
      amountSatang: b(150),
      applicable: true,
      reason: null,
    });

    const rung = await commit(tillA, {
      id: saleId,
      ...kids(1, { codes: [v.code] }),
      expectedTotalSatang: KID - b(150),
    });
    expect(rung.statusCode, rung.body).toBe(200);
    expect(rung.json().voucher).toMatchObject({ voucherId: v.id, amountSatang: b(150) });
    // Rung up, not paid: still held, not used.
    expect((await voucherRow(v.id)).status).toBe('issued');

    const paid = await finalise(tillA, saleId);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ finalised: true, redeemedVoucherIds: [v.id] });

    const used = await voucherRow(v.id);
    expect(used).toMatchObject({
      status: 'redeemed',
      redeemedByAccountId: receptionAccountId,
      redeemedBranchId: hktId,
      redeemedStationId: t1.id,
      saleId,
      heldSaleId: null,
      heldStationId: null,
      heldAt: null,
    });
    expect(used.redeemedAt!.getTime()).toBeGreaterThanOrEqual(started.getTime() - 1000);

    const ledger = await ledgerOf(v.id);
    expect(ledger.map((r) => [r.kind, r.saleId, r.stationId, r.branchId, r.accountId])).toEqual([
      ['held', saleId, t1.id, hktId, receptionAccountId],
      ['applied', saleId, t1.id, hktId, receptionAccountId],
      ['consumed', saleId, t1.id, hktId, receptionAccountId],
    ]);

    const trail = await ctx.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, v.id))
      .orderBy(asc(auditLog.createdAt));
    expect(trail.map((t) => t.action)).toEqual(['voucher.hold', 'voucher.apply', 'voucher.redeem']);

    const [discount] = await ctx.db
      .select()
      .from(saleDiscount)
      .where(eq(saleDiscount.saleId, saleId));
    expect(discount).toMatchObject({
      kind: 'promo',
      code: v.code,
      discountType: 'fixed',
      valueSatang: b(150),
      amountSatang: b(150),
    });
  });

  it('a repeated scan onto the same cart changes nothing', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    const again = await hold(tillA, saleId, v.code);
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyHeld).toBe(true);
    expect((await ledgerOf(v.id)).map((r) => r.kind)).toEqual(['held']);
  });

  it('is released when the line is removed, and another till may then take it', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);

    const removed = await release(tillA, saleId, v.id);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toEqual({ released: true, voucherId: v.id, saleId });
    expect(await voucherRow(v.id)).toMatchObject({
      status: 'issued',
      heldSaleId: null,
      heldAt: null,
    });
    const ledger = await ledgerOf(v.id);
    expect(ledger.map((r) => [r.kind, r.reason])).toEqual([
      ['held', null],
      ['released', 'line_removed'],
    ]);

    // A second removal is not an error: there is nothing left to release.
    const twice = await release(tillA, saleId, v.id);
    expect(twice.statusCode).toBe(200);
    expect(twice.json().released).toBe(false);

    // The cart that let it go cannot be rung up with it.
    const stale = await commit(tillA, { id: saleId, ...kids(1, { codes: [v.code] }) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VOUCHER_NOT_HELD');

    expect((await hold(tillB, newId(), v.code)).statusCode).toBe(200);
  });

  it('is released when the sale is voided, whatever voided it', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = await holdAndCommit(tillA, v.code, kids(1));

    // Rung up: the line cannot simply be taken off any more.
    const refused = await release(tillA, saleId, v.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('SALE_ALREADY_RUNG_UP');

    // The rule lives in the database, so ANY path that voids a sale lets the
    // voucher go — this one a correction in psql; the till's own void, the
    // route, is under "the till's cancel" below.
    await ctx.db
      .update(sale)
      .set({
        status: 'voided',
        voidedAt: new Date(),
        voidedByAccountId: receptionAccountId,
        voidReason: 'guest changed their mind',
      })
      .where(eq(sale.id, saleId));

    expect(await voucherRow(v.id)).toMatchObject({ status: 'issued', heldSaleId: null });
    const last = (await ledgerOf(v.id)).at(-1)!;
    expect(last).toMatchObject({
      kind: 'released',
      reason: 'sale_voided',
      saleId,
      stationId: t1.id,
    });

    const closed = await finalise(tillA, saleId);
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('SALE_CLOSED');
    expect((await hold(tillB, newId(), v.code)).statusCode).toBe(200);
  });

  it('refuses to be put on a sale that has already been rung up', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = newId();
    expect((await commit(tillA, { id: saleId, ...kids(1) })).statusCode).toBe(200);
    const late = await hold(tillA, saleId, v.code);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('SALE_ALREADY_RUNG_UP');
  });

  it('keeps a part-paid sale’s voucher, and uses it up with the last payment', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    const part = await finalise(tillA, saleId, { amountSatang: b(100) });
    expect(part.statusCode, part.body).toBe(200);
    expect(part.json()).toMatchObject({ finalised: false, redeemedVoucherIds: [] });
    expect((await voucherRow(v.id)).status).toBe('issued');

    // Money has been taken against it, so no other till may take it over —
    // not even after the lapse window.
    await ctx.db
      .update(voucher)
      .set({ heldAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(voucher.id, v.id));
    await ctx.db
      .update(sale)
      .set({ createdAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(sale.id, saleId));
    const elsewhere = await hold(tillB, newId(), v.code);
    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json().error.code).toBe('HELD_ELSEWHERE');
    expect(elsewhere.json().error.message).toBe(
      'This voucher is on a sale already rung up at Reception Till 1 — pay or void that sale first',
    );

    const rest = await finalise(tillA, saleId);
    expect(rest.statusCode, rest.body).toBe(200);
    expect(rest.json()).toMatchObject({ finalised: true, redeemedVoucherIds: [v.id] });
    expect((await voucherRow(v.id)).status).toBe('redeemed');
  });
});

describe('two sales, one voucher — exactly one wins', () => {
  it('two tills scanning it at the same moment: one holds it, the other hears where it is', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleA = newId();
    const saleB = newId();
    const [a, bRes] = await Promise.all([hold(tillA, saleA, v.code), hold(tillB, saleB, v.code)]);
    const statuses = [a.statusCode, bRes.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : bRes;
    expect(loser.json().error.code).toBe('HELD_ELSEWHERE');
    const winnerSale = a.statusCode === 200 ? saleA : saleB;
    expect((await voucherRow(v.id)).heldSaleId).toBe(winnerSale);
    expect((await ledgerOf(v.id)).filter((r) => r.kind === 'held')).toHaveLength(1);
  });

  /**
   * THE RACE THE GUARD EXISTS FOR, run as two real transactions at once.
   *
   * Both call the use-up on one voucher for one sale, past every check before
   * it — the sale lock included, which is what keeps two presses of Pay apart
   * at the counter. The guard is the conditional update in
   * `consumeSaleVouchers`, and it is the only check on the two paths that
   * close a sale without a tender at the counter (the ฿0 close and a gateway
   * settlement). The second transaction is held until it is queued on the
   * voucher's row, then the first commits: exactly one may use it up.
   *
   * Remove the update's conditions and both use it up — this goes red.
   */
  it('two transactions using one voucher up at the same moment: one wins, the other is refused', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    const scope = { saleId, operatorId, branchId: hktId, stationId: t1.id };
    const actor = { accountId: receptionAccountId };

    let letFirstCommit!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => (letFirstCommit = resolve));
    let firstUsedIt!: () => void;
    const firstHasUsedIt = new Promise<void>((resolve) => (firstUsedIt = resolve));
    const first = ctx.db.transaction(async (tx) => {
      const out = await consumeSaleVouchers(tx, scope, actor, new Date());
      firstUsedIt();
      await firstMayCommit;
      return out;
    });
    await firstHasUsedIt;
    const second = ctx.db.transaction(async (tx) =>
      consumeSaleVouchers(tx, scope, actor, new Date()),
    );
    // The second is queued on the voucher's row before the first lets go.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await ctx.db.execute(
        sql`select count(*)::int as n from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock'
               and query ilike '%update "promo"."voucher"%'`,
      );
      if (Number((waiting.rows[0] as { n: number }).n) > 0) break;
      if (Date.now() > deadline) throw new Error('the second use-up never queued on the voucher');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    letFirstCommit();
    const [a, b] = await Promise.allSettled([first, second]);

    expect(a.status).toBe('fulfilled');
    expect(a.status === 'fulfilled' && a.value.consumed).toEqual([v.id]);
    expect(b.status, 'exactly one transaction may use the voucher up').toBe('rejected');
    expect(b.status === 'rejected' && (b.reason as { code?: string }).code).toBe(
      'VOUCHER_NOT_HELD',
    );
    expect((await ledgerOf(v.id)).filter((r) => r.kind === 'consumed')).toHaveLength(1);
    expect((await voucherRow(v.id)).status).toBe('redeemed');
  });

  /**
   * Two sales priced with one voucher — a state no route can reach now (a sale
   * rung up with a voucher is never taken over, and its line is never taken
   * off, even by a removal racing Pay), made here the only way left: a
   * correction in psql moves the hold to a second cart, which is then rung up
   * with it. Both are paid at the same moment: exactly one closes, and the
   * other takes no money and spends no receipt number.
   */
  it('two sales priced with one voucher, paid at the same moment: one closes, the other takes nothing', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const first = await holdAndCommit(tillA, v.code, kids(1));
    const second = newId();
    await ctx.db
      .update(voucher)
      .set({
        heldSaleId: second,
        heldStationId: t1.id,
        heldByAccountId: receptionAccountId,
        heldAt: new Date(),
      })
      .where(eq(voucher.id, v.id));
    const rung = await commit(tillA, { id: second, ...kids(1, { codes: [v.code] }) });
    expect(rung.statusCode, rung.body).toBe(200);

    const [one, two] = await Promise.all([finalise(tillA, first), finalise(tillA, second)]);
    const results = [
      { saleId: first, res: one },
      { saleId: second, res: two },
    ];
    const closed = results.filter(
      (r) => r.res.statusCode === 200 && r.res.json().finalised === true,
    );
    const refused = results.filter((r) => r.res.statusCode === 409);
    expect(closed, 'exactly one sale may close with the voucher').toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.res.json().error.code).toBe('VOUCHER_NOT_HELD');

    const used = await voucherRow(v.id);
    expect(used.status).toBe('redeemed');
    expect(used.saleId).toBe(closed[0]!.saleId);
    expect((await ledgerOf(v.id)).filter((r) => r.kind === 'consumed')).toHaveLength(1);

    // The loser took no money and spent no receipt number.
    const [loser] = await ctx.db.select().from(sale).where(eq(sale.id, refused[0]!.saleId));
    expect(loser).toMatchObject({ status: 'tendering', receiptNumber: null });
    const attempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, refused[0]!.saleId));
    expect(attempts).toEqual([]);
  });

  it('one sale paid twice at once uses its voucher once', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    const [x, y] = await Promise.all([finalise(tillA, saleId), finalise(tillA, saleId)]);
    expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
    expect((await ledgerOf(v.id)).filter((r) => r.kind === 'consumed')).toHaveLength(1);
    expect((await voucherRow(v.id)).status).toBe('redeemed');
  });

  it('a part payment on a sale whose voucher is no longer its own is refused, and takes nothing', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const abandoned = await holdAndCommit(tillA, v.code, kids(1));
    await dropHoldOutOfBand(v.id);
    const part = await finalise(tillA, abandoned, { amountSatang: b(100) });
    expect(part.statusCode).toBe(409);
    expect(part.json().error.code).toBe('VOUCHER_NOT_HELD');
    expect(await attemptsOf(abandoned)).toEqual([]);
  });
});

describe('a forgotten hold does not keep a family’s voucher for ever', () => {
  it('another till may take a hold on a cart not rung up, once it is older than the lapse window', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    expect((await hold(tillB, newId(), v.code)).statusCode).toBe(200);
    expect((await hold(tillA, newId(), v.code)).json().error.code).toBe('HELD_ELSEWHERE');

    await ctx.db
      .update(voucher)
      .set({ heldAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(voucher.id, v.id));
    const taken = await hold(tillA, newId(), v.code);
    expect(taken.statusCode, taken.body).toBe(200);
    expect((await ledgerOf(v.id)).map((r) => [r.kind, r.reason])).toEqual([
      ['held', null],
      ['released', 'lapsed'],
      ['held', null],
    ]);
  });

  it('the same till moves it to its new cart at once', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    expect((await hold(tillA, newId(), v.code)).statusCode).toBe(200);
    const moved = await hold(tillA, newId(), v.code);
    expect(moved.statusCode).toBe(200);
    expect((await ledgerOf(v.id)).map((r) => r.reason)).toEqual([null, 'moved', null]);
  });
});

describe('the value comes from the platform, never from the till', () => {
  it('refuses a till that describes a voucher’s discount itself, and writes nothing', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = newId();
    for (const res of [
      await quote(tillA, {
        ...kids(1),
        promos: [{ code: v.code, label: '150 off', type: 'fixed', value: b(150) }],
      }),
      await commit(tillA, {
        id: saleId,
        ...kids(1),
        promos: [{ code: v.code, label: '150 off', type: 'fixed', value: b(150) }],
      }),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('VOUCHER_CLAIM_REFUSED');
    }
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);

    // Held first makes no difference: the till still does not name the value.
    const heldSale = newId();
    expect((await hold(tillA, heldSale, v.code)).statusCode).toBe(200);
    const claimed = await commit(tillA, {
      id: heldSale,
      ...kids(1),
      promos: [{ code: v.code, label: '890 off', type: 'fixed', value: KID }],
    });
    expect(claimed.statusCode).toBe(409);
    expect(claimed.json().error.code).toBe('VOUCHER_CLAIM_REFUSED');
  });

  it('prices only a voucher held for this sale at this till', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    // Not held anywhere: refused, and the answer is the same as for a code
    // that does not exist — a quote is not a way to test codes.
    const nowhere = await quote(tillA, kids(1, { codes: [v.code] }));
    expect(nowhere.statusCode).toBe(409);
    expect(nowhere.json().error.code).toBe('VOUCHER_NOT_HELD');
    expect(nowhere.json().error.message).toBe(
      'Scan the voucher at this till first — it is not held for this sale',
    );
    const invented = await quote(
      tillA,
      kids(1, { codes: [mintBoothCode('B1', (m) => randomInt(m))] }),
    );
    expect(invented.statusCode).toBe(409);
    expect(invented.json().error.code).toBe('VOUCHER_NOT_HELD');
    expect(invented.json().error.message).toBe(nowhere.json().error.message);

    // Held at Counter 2: Till 1's cart cannot use it.
    const saleAtB = newId();
    expect((await hold(tillB, saleAtB, v.code)).statusCode).toBe(200);
    const fromA = await commit(tillA, { id: saleAtB, ...kids(1, { codes: [v.code] }) });
    expect(fromA.statusCode).toBe(409);
    expect(fromA.json().error.code).toBe('VOUCHER_NOT_HELD');

    // Held for another sale at this till: that sale's, not this one's.
    const w = await issue(defs['spin-voucher-150']!);
    expect((await hold(tillA, newId(), w.code)).statusCode).toBe(200);
    const other = await commit(tillA, { id: newId(), ...kids(1, { codes: [w.code] }) });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('VOUCHER_NOT_HELD');
  });

  it('refuses a mistyped voucher code on the cart with the counter’s own words', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const bad = v.code.slice(0, 10) + (v.code[10] === 'Z' ? 'Y' : 'Z');
    const res = await quote(tillA, kids(1, { codes: [bad] }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({ code: 'INVALID_CODE', message: 'Invalid code' });
  });
});

describe('what each kind of voucher does to the bill', () => {
  it('a THB amount comes off the ticket lines, never more than the ticket total, with no change', async () => {
    const v = await issue(defs.huge!);
    const cart = {
      ...kids(1),
      items: [{ id: newId(), productId: juiceId, quantity: 1 }],
      // Food on the order, so the kitchen's pick-up code (S2-09b).
      pickupCode: 'A12',
    };
    const saleId = await holdAndCommit(tillA, v.code, cart);
    const [written] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    // ฿5,000 against one ฿890 kid: ฿890 comes off, the ฿70 juice is still paid,
    // and nothing is left over to hand back.
    expect(written).toMatchObject({
      subtotalSatang: KID + b(70),
      promoDiscountSatang: KID,
      grossSatang: b(70),
    });
    const [row] = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    expect(row).toMatchObject({ code: v.code, valueSatang: b(5000), amountSatang: KID });
    const paid = await finalise(tillA, saleId);
    expect(paid.json()).toMatchObject({ finalised: true, outstandingSatang: 0 });
  });

  it('a THB voucher on a sale with no tickets is refused rather than used up for nothing', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    const cart = {
      stationId: t1.id,
      items: [{ id: newId(), productId: juiceId, quantity: 1 }],
      promoCodes: [v.code],
    };
    const priced = await quote(tillA, cart);
    expect(priced.statusCode).toBe(200);
    expect(priced.json().voucher).toMatchObject({
      amountSatang: 0,
      applicable: false,
      reason: 'This voucher comes off tickets, and this sale has no tickets left to take it off',
    });
    const rung = await commit(tillA, { id: saleId, ...cart });
    expect(rung.statusCode).toBe(409);
    expect(rung.json().error.code).toBe('VOUCHER_NOT_APPLICABLE');
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);
  });

  it('a percentage comes off the ticket lines', async () => {
    const v = await issue(defs.percent!);
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    const [written] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(written!.promoDiscountSatang).toBe(b(178));
    const [row] = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    expect(row).toMatchObject({ discountType: 'percent', percentBp: 2000, amountSatang: b(178) });
  });

  it('a free item goes on the bill at its price and comes off again: handed over, booked, net nothing', async () => {
    const v = await issue(defs.pizza!);
    const looked = await lookup(tillA, v.code);
    expect(looked.json().voucher).toMatchObject({
      effect: {
        type: 'free_item',
        product: { id: pizzaId, name: 'Margherita Pizza', kind: 'menu' },
      },
      // Nothing is used up at the scan, so the card says to ring it up first.
      summary: 'Ring up to use it, then hand over: Margherita Pizza',
    });
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    const free = lines.find((l) => l.kind === 'promo_item')!;
    expect(free).toMatchObject({
      cartLineId: v.id,
      productId: pizzaId,
      label: 'Margherita Pizza',
      baseSatang: b(220),
      discountSatang: b(220),
      grossSatang: 0,
      taxableCategory: 'fnb',
      payload: { voucher: { id: v.id, code: v.code } },
    });
    const [written] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(written).toMatchObject({ grossSatang: KID, promoDiscountSatang: b(220) });
    const [row] = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    expect(row).toMatchObject({
      scope: 'line',
      targetLineId: v.id,
      valueSatang: b(220),
      amountSatang: b(220),
    });
    expect((await finalise(tillA, saleId)).json().redeemedVoucherIds).toEqual([v.id]);
  });

  it('1+1 kids ticket: the second kids ticket of the linked package is free', async () => {
    const v = await issue(defs.oneplusone!);
    const saleId = await holdAndCommit(tillA, v.code, kids(2));
    const [written] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(written).toMatchObject({
      subtotalSatang: 2 * KID,
      promoDiscountSatang: KID,
      grossSatang: KID,
    });
  });

  it('1+1 needs two kids tickets of that package — and Eat & Play is never it', async () => {
    const v = await issue(defs.oneplusone!);
    for (const cart of [kids(1), kids(2, { packageId: eatPlayHkt })]) {
      const saleId = newId();
      expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
      const priced = await quote(tillA, { ...cart, promoCodes: [v.code] });
      expect(priced.json().voucher).toMatchObject({
        applicable: false,
        reason: 'The 1+1 kids ticket needs two kids tickets of 2 Hours Play on this sale',
      });
      const rung = await commit(tillA, { id: saleId, ...cart, promoCodes: [v.code] });
      expect(rung.statusCode).toBe(409);
      expect(rung.json().error.code).toBe('VOUCHER_NOT_APPLICABLE');
      expect((await release(tillA, saleId, v.id)).json().released).toBe(true);
    }
  });

  it('a hand-over prize puts nothing on the bill and is still used up with the sale', async () => {
    const v = await issue(defs.mystery!);
    const looked = await lookup(tillA, v.code);
    expect(looked.json().voucher).toMatchObject({
      effect: { type: 'hand_over' },
      // Nothing is used up at the scan, so the card says to ring it up first.
      summary: 'Ring up to use it, then hand over: Mystery Gift',
    });
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    const [written] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(written).toMatchObject({ grossSatang: KID, promoDiscountSatang: 0 });
    // Beside a ticket: the ticket's line only, and the voucher's ฿0 row naming it.
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    expect(lines.map((l) => l.kind)).toEqual(['kids']);
    const discounts = await ctx.db
      .select()
      .from(saleDiscount)
      .where(eq(saleDiscount.saleId, saleId));
    expect(discounts).toHaveLength(1);
    expect(discounts[0]).toMatchObject({
      kind: 'promo',
      code: v.code,
      label: `Mystery Gift (voucher ${v.code})`,
      discountType: 'fixed',
      valueSatang: 0,
      amountSatang: 0,
      scope: 'order',
      exhaustedReason: null,
    });
    expect((await finalise(tillA, saleId)).json().redeemedVoucherIds).toEqual([v.id]);
    expect((await voucherRow(v.id)).status).toBe('redeemed');
  });

  /**
   * C2 of the booth's closing audit: a family brings only the slip. Before,
   * the quote and the commit answered "The cart is empty", Cancel let the hold
   * go, and the same slip was good for a second prize at any till.
   */
  it('a hand-over prize on its own is a ฿0 sale: rung up, closed at the confirm press, used once', async () => {
    const v = await issue(defs.mystery!);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    // The slip is the whole cart: no ticket line and no item line.
    const cart = { stationId: t1.id, lines: [], items: [], promoCodes: [v.code] };

    const priced = await quote(tillA, cart);
    expect(priced.statusCode, priced.body).toBe(200);
    expect(priced.json().voucher).toMatchObject({
      voucherId: v.id,
      effect: { type: 'hand_over' },
      amountSatang: 0,
      applicable: true,
      reason: null,
    });
    expect(priced.json().totals).toMatchObject({ subtotalSatang: 0, grossSatang: 0 });
    expect(priced.json().appliedPromos).toEqual([
      { code: v.code, label: `Mystery Gift (voucher ${v.code})`, type: 'fixed', amountSatang: 0 },
    ]);

    // Pay: rung up at ฿0 and left open, as the ticket and F&B tills leave every sale.
    const rung = await commit(tillA, { id: saleId, ...cart, expectedTotalSatang: 0 });
    expect(rung.statusCode, rung.body).toBe(200);
    expect(rung.json()).toMatchObject({ finalised: false, outstandingSatang: 0 });
    expect(await saleRow(saleId)).toMatchObject({
      status: 'tendering',
      grossSatang: 0,
      receiptNumber: null,
    });
    // No line is made up for the prize; the discount row names the voucher at ฿0.
    expect(await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId))).toEqual([]);
    const discounts = await ctx.db
      .select()
      .from(saleDiscount)
      .where(eq(saleDiscount.saleId, saleId));
    expect(discounts).toHaveLength(1);
    expect(discounts[0]).toMatchObject({
      kind: 'promo',
      code: v.code,
      label: `Mystery Gift (voucher ${v.code})`,
      discountType: 'fixed',
      valueSatang: 0,
      amountSatang: 0,
      scope: 'order',
      exhaustedReason: null,
    });
    expect(await voucherRow(v.id)).toMatchObject({ status: 'issued', heldSaleId: saleId });

    // Confirm: nothing is owed, so no payment is recorded, and the close uses it up.
    const closed = await finalise(tillA, saleId);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({
      finalised: true,
      outstandingSatang: 0,
      redeemedVoucherIds: [v.id],
    });
    expect((await saleRow(saleId)).receiptNumber).toBeTruthy();
    expect(await attemptsOf(saleId)).toEqual([]);
    expect(await voucherRow(v.id)).toMatchObject({
      status: 'redeemed',
      saleId,
      heldSaleId: null,
      redeemedStationId: t1.id,
    });
    expect((await ledgerOf(v.id)).map((r) => r.kind)).toEqual(['held', 'applied', 'consumed']);

    // Used once: the same slip at the next till is refused, at the scan and at the hold.
    const again = await lookup(tillB, v.code);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_REDEEMED');
    expect(again.json().error.message).toMatch(
      /^Already redeemed on \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2} at Oto Play Park, Central Floresta \/ Reception Till 1 by Som \(Reception\)$/,
    );
    const reheld = await hold(tillB, newId(), v.code);
    expect(reheld.statusCode).toBe(409);
    expect(reheld.json().error.code).toBe('ALREADY_REDEEMED');
  });

  it('only a hand-over prize is a cart on its own: any other voucher with nothing to come off is still an empty cart', async () => {
    for (const definition of [defs['spin-voucher-150']!, defs.oneplusone!]) {
      const v = await issue(definition);
      const saleId = newId();
      expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
      const cart = { stationId: t1.id, lines: [], items: [], promoCodes: [v.code] };
      const priced = await quote(tillA, cart);
      expect(priced.statusCode).toBe(400);
      expect(priced.json().error.message).toBe('The cart is empty');
      const rung = await commit(tillA, { id: saleId, ...cart });
      expect(rung.statusCode).toBe(400);
      expect(rung.json().error.message).toBe('The cart is empty');
      expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);
      expect((await release(tillA, saleId, v.id)).json().released).toBe(true);
    }
  });
});

describe('one voucher per sale, and not beside any other code', () => {
  it('refuses a second voucher on a cart that holds one', async () => {
    const saleId = newId();
    const first = await issue(defs['spin-voucher-150']!);
    const second = await issue(defs['spin-voucher-100']!);
    expect((await hold(tillA, saleId, first.code)).statusCode).toBe(200);
    const res = await hold(tillA, saleId, second.code);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'ONE_VOUCHER_PER_SALE',
      message: 'Only one voucher can be used on a sale',
    });
    const both = await quote(tillA, kids(1, { codes: [first.code, second.code] }));
    expect(both.statusCode).toBe(409);
    expect(both.json().error.code).toBe('ONE_VOUCHER_PER_SALE');
  });

  it('refuses a voucher beside a promo code of any kind', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    for (const extra of [
      { promoCodes: [v.code, 'SUMMER10'] },
      {
        promoCodes: [v.code],
        promos: [{ code: 'KIDS10', label: 'Kids 10%', type: 'percent', value: 10 }],
      },
    ]) {
      const res = await commit(tillA, { id: saleId, ...kids(1), ...extra });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'VOUCHER_NOT_COMBINABLE',
        message: 'A voucher cannot be combined with another voucher or promo code on the same sale',
      });
    }
  });

  it('leaves member tier prices alone — the tier is who the guest is, not an offer', async () => {
    const [james] = await ctx.db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.operatorId, operatorId), eq(member.phone, '+66822222222')));
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = await holdAndCommit(tillA, v.code, { ...kids(1), memberId: james!.id });
    const [written] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(written!.customerTier).toBe('expat');
    expect(written!.promoDiscountSatang).toBe(b(150));
  });
});

describe('any branch, with the branch recorded', () => {
  it('a Central Floresta voucher is used up at Robinson Chalong, and says so', async () => {
    const v = await issue(defs.oneplusone!, { branchId: hktId });
    const saleId = await holdAndCommit(
      chalongTill,
      v.code,
      kids(2, { packageId: twoHoursChalong, stationId: t3.id }),
    );
    // The 1+1 was linked to Central Floresta's 2 Hours Play; Chalong's is the
    // same product under its own row, matched by name.
    const [written] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(written!.promoDiscountSatang).toBeGreaterThan(0);
    expect((await finalise(chalongTill, saleId)).statusCode).toBe(200);
    expect(await voucherRow(v.id)).toMatchObject({
      status: 'redeemed',
      branchId: hktId,
      redeemedBranchId: chalongId,
      redeemedStationId: t3.id,
    });
  });

  it('a free item this branch does not sell is refused by name', async () => {
    const v = await issue(defs.pizza!);
    const res = await hold(chalongTill, newId(), v.code);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'VOUCHER_ITEM_UNAVAILABLE',
      message: "This voucher's item is not sold at this branch — ask a manager",
    });
  });
});

describe('booth vouchers are redeemed online only, whatever the definition says', () => {
  it('ignores the offline policy for a booth voucher, and honours it for any other', async () => {
    const [defined] = await ctx.db
      .select({ offlinePolicy: voucherDefinition.offlinePolicy })
      .from(voucherDefinition)
      .where(eq(voucherDefinition.id, defs['spin-voucher-150']!));
    // The seeded definition says a till with no internet may accept it …
    expect(defined!.offlinePolicy).toBe('allow');
    const booth = await issue(defs['spin-voucher-150']!);
    const oldCode = await issue(defs.allow!, { source: 'legacy' });
    const strict = await issue(defs.refuse!, { source: 'legacy' });
    expect((await lookup(tillA, booth.code)).json().voucher.redeemableOffline).toBe(false);
    expect((await lookup(tillA, oldCode.code)).json().voucher.redeemableOffline).toBe(true);

    await ctx.db
      .insert(boxState)
      .values({
        boxId: t1.boxId!,
        offline: true,
        offlineSince: new Date(),
        offlineReason: 'console',
      })
      .onConflictDoUpdate({
        target: boxState.boxId,
        set: { offline: true, offlineSince: new Date(), offlineReason: 'console' },
      });

    // … and a booth voucher is still refused at a till working offline.
    const refused = await hold(tillA, newId(), booth.code);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toEqual({
      code: 'VOUCHER_OFFLINE',
      message: 'Vouchers can only be redeemed online — this till is working offline',
    });
    expect((await voucherRow(booth.id)).heldSaleId).toBeNull();
    expect((await hold(tillA, newId(), strict.code)).json().error.code).toBe('VOUCHER_OFFLINE');
    expect((await hold(tillA, newId(), oldCode.code)).statusCode).toBe(200);
    // Counter 2 is on another box, which is online.
    expect((await hold(tillB, newId(), booth.code)).statusCode).toBe(200);
  });
});

describe('codes printed before the check character', () => {
  it('a ten-character code resolves as it is, and redeems once', async () => {
    let legacy = 'B1';
    for (let i = 0; i < 8; i += 1) legacy += BOOTH_CODE_ALPHABET[randomInt(30)];
    const v = await issue(defs['spin-voucher-150']!, { code: legacy });
    const res = await lookup(tillA, legacy);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().voucher).toMatchObject({ id: v.id, legacyFormat: true });
    const saleId = await holdAndCommit(tillA, legacy, kids(1));
    expect((await finalise(tillA, saleId)).json().redeemedVoucherIds).toEqual([v.id]);
    expect((await lookup(tillA, legacy)).json().error.code).toBe('ALREADY_REDEEMED');
  });

  it('an unknown ten-character code is Invalid code — no box mints ten any more', async () => {
    let legacy = 'B1';
    for (let i = 0; i < 8; i += 1) legacy += BOOTH_CODE_ALPHABET[randomInt(30)];
    const res = await lookup(tillA, legacy);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({ code: 'INVALID_CODE', message: 'Invalid code' });
    // Still a miss against the till: it counts towards the guessing limit.
    const [row] = await ctx.db
      .select()
      .from(redemptionThrottle)
      .where(eq(redemptionThrottle.stationId, t1.id));
    expect(row!.recentMisses).toHaveLength(1);
  });

  it('a real code with any one character dropped is Invalid code, never "not synced"', async () => {
    // Every deletion from an eleven-character code leaves a well-formed ten:
    // the prefix survives and the rest is still of the alphabet. So each of the
    // eleven is a mistake, and says so.
    const v = await issue(defs['spin-voucher-150']!);
    for (let i = 0; i < v.code.length; i += 1) {
      const dropped = v.code.slice(0, i) + v.code.slice(i + 1);
      const res = await lookup(tillA, dropped);
      expect(res.statusCode, `${v.code} without position ${i}: ${dropped}`).toBe(422);
      expect(res.json().error.code).toBe('INVALID_CODE');
      // Eleven mistakes would lock the till; this is about the words, not the limit.
      await ctx.db.delete(redemptionThrottle);
    }
    // And the code itself, whole, is still the voucher.
    expect((await lookup(tillA, v.code)).json().voucher.id).toBe(v.id);
  });
});

describe('expiry', () => {
  it('a voucher with no expiry never expires', async () => {
    const v = await issue(defs['spin-voucher-150']!, {
      issuedAt: new Date('2021-01-01T03:00:00Z'),
      expiresAt: null,
    });
    const res = await lookup(tillA, v.code);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().voucher.expiresAt).toBeNull();
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    expect((await finalise(tillA, saleId)).json().redeemedVoucherIds).toEqual([v.id]);
  });
});

describe('an eleven-character code with a bad check is refused without asking the database', () => {
  /**
   * Every query the api sends while it answers, captured at the driver. The
   * look-up of a mistyped code must not name `promo.voucher` at all; the same
   * look-up of the real code, the control, must.
   */
  async function queriesDuring(work: () => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    const original = pg.Client.prototype.query;
    pg.Client.prototype.query = function patched(this: pg.Client, ...args: unknown[]) {
      const first = args[0] as string | { text?: string } | undefined;
      seen.push(typeof first === 'string' ? first : (first?.text ?? ''));
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof original;
    try {
      await work();
    } finally {
      pg.Client.prototype.query = original;
    }
    return seen;
  }
  const touchesVouchers = (text: string): boolean => /"promo"\."voucher"(?!_)/.test(text);

  it('answers Invalid code, reads no voucher row, and changes none', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const before = await voucherRow(v.id);
    const i = 10;
    const wrong = BOOTH_CODE_ALPHABET.split('').find((c) => c !== v.code[i])!;
    const mistyped = v.code.slice(0, i) + wrong;
    expect(boothCodeCheckCharacter(mistyped.slice(0, 10))).not.toBe(mistyped[10]);

    let answer: Awaited<ReturnType<typeof lookup>> | undefined;
    const queries = await queriesDuring(async () => {
      answer = await lookup(tillA, mistyped);
    });
    expect(answer!.statusCode).toBe(422);
    expect(answer!.json().error.message).toBe('Invalid code');
    expect(queries.length, 'the spy saw the request at all').toBeGreaterThan(0);
    expect(queries.filter(touchesVouchers)).toEqual([]);
    expect(await voucherRow(v.id)).toEqual(before);

    // The control: the real code does read the voucher table.
    const control = await queriesDuring(async () => {
      expect((await lookup(tillA, v.code)).statusCode).toBe(200);
    });
    expect(control.some(touchesVouchers)).toBe(true);
  });
});

describe('guessing is limited: five misses in a minute lock the till for ten minutes', () => {
  it('locks on the fifth miss, answers LOCKED to the sixth — even for a real code — and raises an alert', async () => {
    const real = await issue(defs['spin-voucher-150']!);
    for (let i = 0; i < 5; i += 1) {
      const miss =
        i % 2 === 0
          ? await lookup(tillA, 'ZZZZ9')
          : await lookup(
              tillA,
              mintBoothCode('B1', (m) => randomInt(m)),
            );
      expect([422, 404], `miss ${i + 1}`).toContain(miss.statusCode);
    }
    const sixth = await lookup(tillA, real.code);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.code).toBe('LOCKED');
    expect(sixth.json().error.message).toBe('Too many wrong codes — try again in 10 minutes');
    // A hold is the same act and is locked with it.
    expect((await hold(tillA, newId(), real.code)).json().error.code).toBe('LOCKED');

    const [raised] = await ctx.db
      .select()
      .from(alert)
      .where(
        and(eq(alert.category, 'redemption.probing'), eq(alert.key, `redemption.probing:${t1.id}`)),
      );
    expect(raised, 'no redemption.probing alert').toBeTruthy();
    expect(raised!.branchId).toBe(hktId);
    const locked = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'voucher.redemption_locked'), eq(auditLog.entityId, t1.id)));
    expect(locked).toHaveLength(1);

    // Per till: Counter 2 is not locked.
    expect((await lookup(tillB, real.code)).statusCode).toBe(200);

    // A restart does not clear it — the lock is in the database.
    await ctx.restart();
    expect((await lookup(tillA, real.code)).json().error.code).toBe('LOCKED');

    // After the window, the till works again.
    await ctx.db
      .update(redemptionThrottle)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(redemptionThrottle.stationId, t1.id));
    expect((await lookup(tillA, real.code)).statusCode).toBe(200);
  });

  it('in a burst, every wrong code after the fifth answers LOCKED, not its own refusal', async () => {
    // Eight wrong codes at once, as a script would send them. They may all pass
    // the lock check before the fifth locks the till; the four counted after
    // that must still say LOCKED, or the burst learns more than the limit allows.
    const burst = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        lookup(tillB, i % 2 ? 'ZZZZ9' : mintBoothCode('B1', (m) => randomInt(m))),
      ),
    );
    const own = burst.filter((r) => r.statusCode === 422 || r.statusCode === 404);
    const locked = burst.filter((r) => r.statusCode === 429);
    expect(own, 'the five misses the limit allows').toHaveLength(5);
    expect(locked, 'every one after them').toHaveLength(3);
    for (const r of locked) expect(r.json().error.code).toBe('LOCKED');
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'voucher.redemption_locked'), eq(auditLog.entityId, t2.id)));
    expect(audits).toHaveLength(1);
  });

  it('counts misses inside a minute only', async () => {
    for (let i = 0; i < 4; i += 1) expect((await lookup(tillA, 'ZZZZ9')).statusCode).toBe(422);
    // The four fall out of the window …
    await ctx.db
      .update(redemptionThrottle)
      .set({
        recentMisses: [1, 2, 3, 4].map((n) => new Date(Date.now() - 61_000 - n * 1000)),
      })
      .where(eq(redemptionThrottle.stationId, t1.id));
    // … so a fifth is the first of a new minute, not the one that locks.
    expect((await lookup(tillA, 'ZZZZ9')).statusCode).toBe(422);
    const v = await issue(defs['spin-voucher-150']!);
    expect((await lookup(tillA, v.code)).statusCode).toBe(200);
  });

  it('does not count a real voucher’s refusal as a miss', async () => {
    const v = await issue(defs['spin-voucher-150']!, {
      issuedAt: new Date('2026-01-01T03:00:00Z'),
      expiresAt: new Date('2026-01-15T05:00:00Z'),
    });
    for (let i = 0; i < 6; i += 1)
      expect((await lookup(tillA, v.code)).json().error.code).toBe('EXPIRED');
    const [row] = await ctx.db
      .select()
      .from(redemptionThrottle)
      .where(eq(redemptionThrottle.stationId, t1.id));
    expect(row).toBeUndefined();
  });
});

describe('a sale rung up with a voucher keeps it until it is paid or voided', () => {
  /**
   * The gate's `movedThenCard`, first half. Before this round the till that
   * rang the sale up could move the voucher to a new cart at once ("moved"),
   * and another till could take it after fifteen minutes ("lapsed"), and the
   * rung-up sale could then still be paid by card — money on a sale that could
   * never close. Now neither takeover happens, at any age.
   */
  it('the same till cannot move it to a new cart, and another till cannot take it at any age', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const rungUp = await holdAndCommit(tillA, v.code, kids(1));

    const sameTill = await hold(tillA, newId(), v.code);
    expect(sameTill.statusCode).toBe(409);
    expect(sameTill.json().error).toMatchObject({
      code: 'HELD_ELSEWHERE',
      message:
        'This voucher is on a sale already rung up at Reception Till 1 — pay or void that sale first',
      // The till that rang it up is told which sale, so it can offer the void.
      details: { rungUp: true, saleId: rungUp, stationId: t1.id },
    });

    await ageHold(rungUp, v.id, 120);
    const otherTillLater = await hold(tillB, newId(), v.code);
    expect(otherTillLater.statusCode).toBe(409);
    expect(otherTillLater.json().error.code).toBe('HELD_ELSEWHERE');
    // Another till hears where, not which.
    expect(otherTillLater.json().error.details).toMatchObject({ rungUp: true, saleId: null });
    // A look-up says the same, and consumes nothing.
    expect((await lookup(tillB, v.code)).json().error.code).toBe('HELD_ELSEWHERE');

    expect(await voucherRow(v.id)).toMatchObject({ heldSaleId: rungUp, status: 'issued' });
    // No takeover was written: held, applied, and nothing else.
    expect((await ledgerOf(v.id)).map((r) => [r.kind, r.reason])).toEqual([
      ['held', null],
      ['applied', null],
    ]);
  });

  it('movedThenCard: the card keyed in on the rung-up sale pays it, and it closes with its voucher', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const s1 = await holdAndCommit(tillA, v.code, kids(1));
    expect((await saleRow(s1)).grossSatang).toBe(KID - b(150));
    expect((await hold(tillA, newId(), v.code)).statusCode).toBe(409);

    const card = await manualCard(tillA, s1);
    expect(card.statusCode, card.body).toBe(200);
    expect(card.json().attempt).toMatchObject({ status: 'approved', amountSatang: KID - b(150) });

    const close = await finalise(tillA, s1);
    expect(close.statusCode, close.body).toBe(200);
    expect(close.json()).toMatchObject({ finalised: true, redeemedVoucherIds: [v.id] });
    expect(await voucherRow(v.id)).toMatchObject({ status: 'redeemed', saleId: s1 });
    expect((await ledgerOf(v.id)).map((r) => r.kind)).toEqual(['held', 'applied', 'consumed']);
  });

  it('movedThenQr: a QR paid on the rung-up sale settles it and uses the voucher up', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const s1 = await holdAndCommit(tillA, v.code, kids(1));
    expect((await hold(tillA, newId(), v.code)).statusCode).toBe(409);

    const shown = await showQr(s1);
    const paid = await gatewaySays(shown.attempt.id, 'paid');
    expect(paid.webhookOutcome).toBe('settled');

    const [attempt] = await attemptsOf(s1);
    expect(attempt).toMatchObject({ status: 'approved' });
    expect(attempt!.paidAt).not.toBeNull();
    expect(await saleRow(s1)).toMatchObject({ status: 'finalised' });
    expect(await voucherRow(v.id)).toMatchObject({ status: 'redeemed', saleId: s1 });
  });

  /**
   * The gate's `releaseRace`: Pay and the removal of the voucher's line
   * arriving together for one cart, run the way the use-up race is run — real
   * transactions, the second queued on the voucher's row before the first
   * commits.
   *
   * Pay locks the voucher while it prices the cart (`resolveCartVoucher`) and
   * keeps it until the sale is written. The removal reads "not rung up yet",
   * then queues on that lock; by the time it gets it, the sale has been rung
   * up with the voucher on its price. A removal that decided on its first
   * read let the voucher go — a sale priced with a voucher no longer its own,
   * which Counter 2 then took. The removal must decide on the sale as it
   * stands once it holds the lock: refused, and the sale is paid with it.
   */
  it('releaseRace: a line removal queued behind the Pay that rings the sale up is refused, and the sale keeps its voucher', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);

    let letPayCommit!: () => void;
    const payMayCommit = new Promise<void>((resolve) => (letPayCommit = resolve));
    let payWrote!: () => void;
    const payHasWritten = new Promise<void>((resolve) => (payWrote = resolve));
    const pay = ctx.db.transaction(async (tx) => {
      const out = await commitSale(
        tx,
        {
          accountId: receptionAccountId,
          operatorId,
          branchId: hktId,
          requestId: `test-${newId()}`,
        },
        {
          id: saleId,
          stationId: t1.id,
          lines: [{ id: newId(), packageId: twoHoursHkt, kids: 1, adults: 0 }],
          promoCodes: [v.code],
        },
      );
      payWrote();
      await payMayCommit;
      return out;
    });
    await payHasWritten;

    // The same till takes the line off while Pay is still open.
    const removal = release(tillA, saleId, v.id);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await ctx.db.execute(
        sql`select count(*)::int as n from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock'
               and query ilike '%from "promo"."voucher"%for update%'`,
      );
      if (Number((waiting.rows[0] as { n: number }).n) > 0) break;
      if (Date.now() > deadline) throw new Error('the removal never queued on the voucher');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    letPayCommit();
    const rung = await pay;
    const removed = await removal;

    expect(rung.sale.status).toBe('tendering');
    expect(rung.voucher).toMatchObject({ voucherId: v.id, amountSatang: b(150) });
    expect(removed.statusCode, removed.body).toBe(409);
    expect(removed.json().error).toMatchObject({
      code: 'SALE_ALREADY_RUNG_UP',
      message:
        'This sale has already been rung up with the voucher on it — void the sale to release it',
    });
    expect(await voucherRow(v.id)).toMatchObject({
      status: 'issued',
      heldSaleId: saleId,
      heldStationId: t1.id,
    });
    expect((await ledgerOf(v.id)).map((r) => [r.kind, r.reason])).toEqual([
      ['held', null],
      ['applied', null],
    ]);

    // Still the rung-up sale's: Counter 2 cannot take it, and the cash that pays the sale uses it up.
    expect((await hold(tillB, newId(), v.code)).json().error.code).toBe('HELD_ELSEWHERE');
    const paid = await finalise(tillA, saleId);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ finalised: true, redeemedVoucherIds: [v.id] });
  });
});

describe("the till's cancel: POST /sales/:id/void", () => {
  it('voids a rung-up sale that took no money, frees its voucher, and the sale can never be paid', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = await holdAndCommit(tillA, v.code, kids(1));

    const voided = await voidSale(tillA, saleId, 'Guest left before paying');
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json()).toMatchObject({
      replay: false,
      sale: { id: saleId, status: 'voided', receiptNumber: null },
      void: { reason: 'Guest left before paying', voidedByAccountId: receptionAccountId },
      releasedVoucherIds: [v.id],
    });

    // The voucher is free, released by the database in the same statement.
    expect(await voucherRow(v.id)).toMatchObject({
      status: 'issued',
      heldSaleId: null,
      heldStationId: null,
    });
    expect((await ledgerOf(v.id)).at(-1)).toMatchObject({
      kind: 'released',
      reason: 'sale_voided',
      saleId,
      stationId: t1.id,
      accountId: receptionAccountId,
    });
    // Audited: the void, and the release it caused, under one request.
    const [voidAudit] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sale.void'), eq(auditLog.entityId, saleId)));
    expect(voidAudit).toMatchObject({ before: { status: 'tendering' } });
    const releases = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'voucher.release'), eq(auditLog.entityId, v.id)));
    expect(releases).toHaveLength(1);
    expect(releases[0]!.requestId).toBe(voidAudit!.requestId);

    // Another cart, at another till, may now take it.
    expect((await hold(tillB, newId(), v.code)).statusCode).toBe(200);

    // And the voided sale takes no money by any road.
    for (const refused of [
      await finalise(tillA, saleId),
      await manualCard(tillA, saleId),
      await terminalTender(tillA, saleId),
    ]) {
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('SALE_CLOSED');
    }
    await expect(showQr(saleId)).rejects.toMatchObject({ code: 'SALE_CLOSED' });
    expect(await attemptsOf(saleId)).toEqual([]);
  });

  it('is idempotent: a second void answers the sale as it is, and a retried request replays', async () => {
    const saleId = newId();
    expect((await commit(tillA, { id: saleId, ...kids(1) })).statusCode).toBe(200);
    const key = `void-${newId()}`;
    const first = await voidSale(tillA, saleId, 'Rung up twice', key);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ replay: false, releasedVoucherIds: [] });
    const retried = await voidSale(tillA, saleId, 'Rung up twice', key);
    expect(retried.statusCode).toBe(200);
    expect(retried.headers['x-oto-replay']).toBe('true');
    expect(retried.json()).toEqual(first.json());
    // A fresh request on a void sale changes nothing and says so.
    const again = await voidSale(tillA, saleId, 'Pressed again');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      replay: true,
      void: { reason: 'Rung up twice' },
      releasedVoucherIds: [],
    });
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sale.void'), eq(auditLog.entityId, saleId)));
    expect(audits).toHaveLength(1);
  });

  /**
   * The gate's `declinedPins`. A declined or cancelled tender took no money, so
   * it does not stand in the way: the void is the way out, and the family's
   * voucher is free again.
   */
  it('declinedPins: after a declined QR the voucher stays with the sale until the void frees it', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const s1 = await holdAndCommit(tillA, v.code, kids(1));
    const shown = await showQr(s1);
    await gatewaySays(shown.attempt.id, 'decline');
    const [declined] = await attemptsOf(s1);
    expect(declined).toMatchObject({ status: 'cancelled', paidAt: null });

    const sameTill = await hold(tillA, newId(), v.code);
    expect(sameTill.statusCode).toBe(409);
    expect(sameTill.json().error.message).toBe(
      'This voucher is on a sale already rung up at Reception Till 1 — pay or void that sale first',
    );
    await ageHold(s1, v.id, 120);
    expect((await hold(tillB, newId(), v.code)).statusCode).toBe(409);
    const removeLine = await release(tillA, s1, v.id);
    expect(removeLine.statusCode).toBe(409);
    expect(removeLine.json().error.code).toBe('SALE_ALREADY_RUNG_UP');

    const voided = await voidSale(tillA, s1, 'QR declined, guest left');
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json().releasedVoucherIds).toEqual([v.id]);
    expect(await voucherRow(v.id)).toMatchObject({ status: 'issued', heldSaleId: null });
    const next = await holdAndCommit(tillB, v.code, kids(1, { stationId: t2.id }));
    expect((await finalise(tillB, next)).json().redeemedVoucherIds).toEqual([v.id]);
  });

  it('refuses a sale with money taken — that is a refund — and keeps its voucher', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    expect((await finalise(tillA, saleId, { amountSatang: b(100) })).statusCode).toBe(200);
    const refused = await voidSale(tillA, saleId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: 'SALE_HAS_PAYMENT',
      message: 'Money has been taken on this sale — it is refunded, not voided',
      details: { takenSatang: b(100) },
    });
    expect(await saleRow(saleId)).toMatchObject({ status: 'tendering' });
    expect(await voucherRow(v.id)).toMatchObject({ heldSaleId: saleId });
  });

  it('refuses a sale with a tender still in flight, and voids it once the tender has failed', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    const shown = await showQr(saleId);
    const refused = await voidSale(tillA, saleId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: 'PAYMENT_IN_FLIGHT',
      details: { attempts: [{ id: shown.attempt.id, status: 'sent_to_terminal' }] },
    });
    expect(await voucherRow(v.id)).toMatchObject({ heldSaleId: saleId });
    await gatewaySays(shown.attempt.id, 'decline');
    expect((await voidSale(tillA, saleId)).statusCode).toBe(200);
  });

  it('refuses a finalised sale; another operator cannot reach the sale at all; a reason is required', async () => {
    const saleId = newId();
    expect((await commit(tillA, { id: saleId, ...kids(1) })).statusCode).toBe(200);
    expect((await finalise(tillA, saleId)).statusCode).toBe(200);
    const closed = await voidSale(tillA, saleId);
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('SALE_FINALISED');

    const open = newId();
    expect((await commit(tillA, { id: open, ...kids(1) })).statusCode).toBe(200);
    const foreign = await signInAs(
      ctx.app,
      SECOND_OPERATOR_ADMIN.phone,
      SECOND_OPERATOR_ADMIN.password,
    );
    const theirs = await voidSale(foreign, open);
    expect(theirs.statusCode).toBe(404);
    const noReason = await voidSale(tillA, open, '   ');
    expect(noReason.statusCode).toBe(400);
    expect(await saleRow(open)).toMatchObject({ status: 'tendering' });
  });
});

describe('every tender refuses a sale whose voucher is no longer its own', () => {
  /**
   * The tender guard (`assertSaleVouchersHeld`), at the start of every road
   * money takes onto a sale: cash at the counter, a card sent to the terminal,
   * a card keyed in off a slip, and a gateway QR. The state it guards against
   * is reachable now only by a correction outside the api, so that is how it is
   * made here. Nothing may be written: no attempt, no QR, no instruction.
   */
  it('cash, a part payment, a keyed-in card, the terminal and a QR are all refused before any money moves', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    await dropHoldOutOfBand(v.id);
    const words =
      'The voucher on this sale is no longer held for it — void this sale and ring it up again';

    for (const [road, res] of [
      ['cash', await finalise(tillA, saleId)],
      ['part payment', await finalise(tillA, saleId, { amountSatang: b(100) })],
      ['keyed-in card', await manualCard(tillA, saleId)],
      ['terminal', await terminalTender(tillA, saleId)],
    ] as const) {
      expect(res.statusCode, `${road}: ${res.body}`).toBe(409);
      expect(res.json().error, road).toMatchObject({ code: 'VOUCHER_NOT_HELD', message: words });
    }
    await expect(showQr(saleId)).rejects.toMatchObject({ code: 'VOUCHER_NOT_HELD' });
    expect(await attemptsOf(saleId)).toEqual([]);

    // The way out is the void; the voucher is no longer this sale's to release.
    const voided = await voidSale(tillA, saleId);
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json().releasedVoucherIds).toEqual([]);
  });

  it('says who used it, when and where, if another sale has used it since', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const stranded = await holdAndCommit(tillA, v.code, kids(1));
    await dropHoldOutOfBand(v.id);
    const other = await holdAndCommit(tillB, v.code, kids(1, { stationId: t2.id }));
    expect((await finalise(tillB, other)).json().redeemedVoucherIds).toEqual([v.id]);

    const res = await manualCard(tillA, stranded);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VOUCHER_NOT_HELD');
    expect(res.json().error.message).toMatch(
      /^The voucher on this sale is no longer held for it: already redeemed on .+ at Oto Play Park, Central Floresta \/ Counter 2 by .+ — void this sale and ring it up again$/,
    );
    expect(res.json().error.details.redeemed).toMatchObject({ saleId: other });
    expect(await attemptsOf(stranded)).toEqual([]);
  });

  it('the control: the same tenders on a sale whose voucher is held are not refused by the guard', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    // The terminal answers for its own reasons (this test runs no box), but
    // never with the guard's.
    const card = await terminalTender(tillA, saleId);
    expect(card.json().error?.code).not.toBe('VOUCHER_NOT_HELD');
    const part = await manualCard(tillA, saleId, { amountSatang: b(100) });
    expect(part.statusCode, part.body).toBe(200);
    const rest = await finalise(tillA, saleId);
    expect(rest.json()).toMatchObject({ finalised: true, redeemedVoucherIds: [v.id] });
  });
});

describe('the park’s own discount codes are never voucher claims, whatever they look like', () => {
  /**
   * The gate's `discountShapes`. SONGKRAN25, MOTHERSDAY and BIRTHDAY25 have the
   * shape of a ten-character booth code and MEMBERDAY25 the shape of an
   * eleven-character one. As the park's own discount codes — active, archived
   * or switched off — they quote and commit exactly as they did before
   * vouchers existed.
   */
  const lookalike = mintBoothCode('XM', (m) => randomInt(m));
  const DEFINED = ['SONGKRAN25', 'MOTHERSDAY', 'BIRTHDAY25', 'MEMBERDAY25', lookalike];

  beforeAll(async () => {
    await ctx.db.insert(discountDefinition).values([
      {
        id: newId(),
        operatorId,
        code: 'SONGKRAN25',
        label: 'Songkran',
        kind: 'percent',
        valueBp: 1000,
      },
      {
        id: newId(),
        operatorId,
        code: 'MOTHERSDAY',
        label: "Mother's Day",
        kind: 'percent',
        valueBp: 1000,
      },
      {
        id: newId(),
        operatorId,
        code: 'BIRTHDAY25',
        label: 'Birthday',
        kind: 'percent',
        valueBp: 1000,
        archivedAt: new Date(),
      },
      {
        id: newId(),
        operatorId,
        code: 'MEMBERDAY25',
        label: 'Member day',
        kind: 'percent',
        valueBp: 1000,
        active: false,
      },
      // One that even passes the check character: still the park's code.
      {
        id: newId(),
        operatorId,
        code: lookalike,
        label: 'Lookalike',
        kind: 'percent',
        valueBp: 1000,
      },
    ]);
  });

  const tenPercent = (code: string) => ({ code, label: code, type: 'percent', value: 10 });

  it('quote and commit with each of them, as before', async () => {
    for (const code of DEFINED) {
      const priced = await quote(tillA, { ...kids(1), promos: [tenPercent(code)] });
      expect(priced.statusCode, `${code}: ${priced.body}`).toBe(200);
      expect(priced.json().totals.promoDiscountSatang).toBe(b(89));

      const saleId = newId();
      const rung = await commit(tillA, { id: saleId, ...kids(1), promos: [tenPercent(code)] });
      expect(rung.statusCode, `${code}: ${rung.body}`).toBe(200);
      expect((await saleRow(saleId)).promoDiscountSatang).toBe(b(89));
      const [row] = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
      expect(row).toMatchObject({ code, amountSatang: b(89) });
    }
  });

  it('named with no definition attached, each is refused by name and takes nothing, as before', async () => {
    for (const code of DEFINED) {
      const priced = await quote(tillA, kids(1, { codes: [code] }));
      expect(priced.statusCode, `${code}: ${priced.body}`).toBe(200);
      expect(priced.json().rejectedPromoCodes).toEqual([
        { code, reason: `Code "${code}" isn't set up at this branch yet.` },
      ]);
    }
  });

  it('the same shapes, when they are not the park’s codes, are still refused as a voucher claim', async () => {
    // A code a booth could have printed — ten characters of the old shape, or
    // eleven with a right check — that the park never defined is a voucher's,
    // and the till does not describe a voucher's value.
    for (const code of ['SONGKRAN26', mintBoothCode('XM', (m) => randomInt(m))]) {
      const res = await quote(tillA, { ...kids(1), promos: [tenPercent(code)] });
      expect(res.statusCode, code).toBe(409);
      expect(res.json().error.code).toBe('VOUCHER_CLAIM_REFUSED');
    }
    // Eleven characters with a wrong check are nobody's voucher.
    const res = await quote(tillA, { ...kids(1), promos: [tenPercent('MEMBERDAY26')] });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('the offline replay banks such a sale instead of quarantining it', async () => {
    const replay = (code: string) => {
      const saleId = newId();
      const scope: ReplayScope = {
        operatorId,
        branchId: hktId,
        boxId: t1.boxId!,
        stationId: t1.id,
        actorAccountId: receptionAccountId,
        occurredAt: new Date(),
        boxSeq: 1,
        eventId: newId(),
        actionId: newId(),
      };
      const payload = OfflineSalePayloadSchema.parse({
        saleId,
        cart: {
          lines: [{ id: newId(), packageId: twoHoursHkt, kids: 1, adults: 0 }],
          promos: [tenPercent(code)],
          expectedTotalSatang: KID - b(89),
        },
        tenders: [{ actionId: newId(), methodCode: 'cash', amountSatang: KID - b(89) }],
      });
      return { saleId, run: ctx.db.transaction((tx) => replayOfflineSale(tx, scope, payload)) };
    };
    const banked = replay('SONGKRAN25');
    await expect(banked.run).resolves.toMatchObject({ saleId: banked.saleId, finalised: true });
    expect((await saleRow(banked.saleId)).promoDiscountSatang).toBe(b(89));
    // The control: a booth-shaped code the park never defined is still refused
    // — which is what sends an event to quarantine.
    await expect(replay('SONGKRAN26').run).rejects.toMatchObject({
      code: 'VOUCHER_CLAIM_REFUSED',
    });
  });
});

describe('a voucher’s markdown lands on the line it belongs to', () => {
  /**
   * The gate's `freeItemBesidePaidOne`. The total was always right; the
   * receipt lines were not — the markdown was spread over both pizzas, so a
   * refund of the paid one would have returned ฿110.
   */
  it('a free pizza beside a paid one: the paid pizza is full price, the voucher’s is ฿220 off', async () => {
    const v = await issue(defs.pizza!);
    const paidLine = newId();
    const saleId = await holdAndCommit(tillA, v.code, {
      ...kids(1),
      items: [{ id: paidLine, productId: pizzaId, quantity: 1 }],
      pickupCode: 'A12',
    });
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    const paid = lines.find((l) => l.cartLineId === paidLine)!;
    const free = lines.find((l) => l.cartLineId === v.id)!;
    expect(paid).toMatchObject({
      kind: 'fnb_item',
      baseSatang: b(220),
      discountSatang: 0,
      grossSatang: b(220),
    });
    expect(free).toMatchObject({
      kind: 'promo_item',
      baseSatang: b(220),
      discountSatang: b(220),
      grossSatang: 0,
      taxSatang: 0,
    });
    // The pizza's tax is the paid pizza's, all of it.
    expect(paid.taxSatang).toBeGreaterThan(0);
    const [row] = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    expect(row).toMatchObject({
      scope: 'line',
      targetLineId: v.id,
      targetComponent: null,
      amountSatang: b(220),
    });
    expect(await saleRow(saleId)).toMatchObject({ grossSatang: KID + b(220) });
  });

  it('a 1+1 takes one kid’s ticket off one line — never the adults, never a share of every line', async () => {
    const v = await issue(defs.oneplusone!);
    const family = newId();
    const friend = newId();
    const saleId = await holdAndCommit(tillA, v.code, {
      stationId: t1.id,
      lines: [
        { id: family, packageId: twoHoursHkt, kids: 1, adults: 1 },
        { id: friend, packageId: twoHoursHkt, kids: 1, adults: 0 },
      ],
    });
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    const unit = (cartLineId: string, key: string) =>
      lines.find((l) => l.cartLineId === cartLineId && l.componentKey === key)!;
    expect(unit(family, 'kids')).toMatchObject({ baseSatang: KID, discountSatang: KID });
    const adults = lines.filter((l) => l.cartLineId === family && l.componentKey !== 'kids');
    expect(adults.length).toBeGreaterThan(0);
    for (const adult of adults) expect(adult.discountSatang).toBe(0);
    expect(unit(friend, 'kids')).toMatchObject({ baseSatang: KID, discountSatang: 0 });
    const [row] = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    expect(row).toMatchObject({
      scope: 'component',
      targetLineId: family,
      targetComponent: 'kids',
      amountSatang: KID,
    });
  });
});

describe('a voucher that takes the whole bill', () => {
  it('closes the sale at Pay and is used up there (the gate’s zeroClose)', async () => {
    const v = await issue(defs.huge!);
    const saleId = newId();
    expect((await hold(tillA, saleId, v.code)).statusCode).toBe(200);
    const rung = await commit(tillA, {
      id: saleId,
      ...kids(1, { codes: [v.code] }),
      finalise: true,
    });
    expect(rung.statusCode, rung.body).toBe(200);
    expect(rung.json().finalised).toBe(true);
    expect(await saleRow(saleId)).toMatchObject({ status: 'finalised', grossSatang: 0 });
    expect(await voucherRow(v.id)).toMatchObject({ status: 'redeemed', saleId, heldSaleId: null });
    expect((await ledgerOf(v.id)).map((r) => r.kind)).toEqual(['held', 'applied', 'consumed']);
    expect((await lookup(tillB, v.code)).json().error.code).toBe('ALREADY_REDEEMED');
  });
});

describe('only the till holding a voucher takes it off its cart', () => {
  it('refuses another till naming the cart, and the voucher stays where it was', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const cart = newId();
    expect((await hold(tillA, cart, v.code)).statusCode).toBe(200);
    const intruder = await release(tillB, cart, v.id);
    expect(intruder.statusCode).toBe(409);
    expect(intruder.json().error).toMatchObject({
      code: 'HELD_ELSEWHERE',
      message: 'This voucher is in use at Reception Till 1',
    });
    expect(await voucherRow(v.id)).toMatchObject({ heldSaleId: cart, heldStationId: t1.id });
    expect((await release(tillA, cart, v.id)).json().released).toBe(true);
  });
});

describe('where the till is', () => {
  it('refuses a session that is not standing at a till', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const res = await lookup(seatless, v.code);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NO_STATION_PICKED');
  });

  it('refuses a caller with no session at all', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/vouchers/lookup?code=ZZZZ9' });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * RUNS LAST IN THIS FILE: the reset deletes every sale on the deployment.
 */
describe('the staging demo reset, after a redemption', () => {
  it('succeeds, keeps the voucher redeemed and unlinked, and leaves the redemption ledger alone', async () => {
    const v = await issue(defs['spin-voucher-150']!);
    const saleId = await holdAndCommit(tillA, v.code, kids(1));
    expect((await finalise(tillA, saleId)).json().redeemedVoucherIds).toEqual([v.id]);
    // One more held by a cart that was rung up, and one by a cart that was not.
    const w = await issue(defs['spin-voucher-150']!);
    await holdAndCommit(tillA, w.code, kids(1));
    const x = await issue(defs['spin-voucher-150']!);
    expect((await hold(tillB, newId(), x.code)).statusCode).toBe(200);
    const ledger = () => ctx.db.select().from(voucherRedemption).orderBy(asc(voucherRedemption.id));
    const ledgerBefore = await ledger();

    const counts = await ctx.db.transaction((tx) => resetDemoData(tx));
    expect(counts.sale).toBeGreaterThan(0);
    expect(await ctx.db.select().from(sale)).toEqual([]);

    expect(await voucherRow(v.id)).toMatchObject({
      status: 'redeemed',
      saleId: null,
      redeemedStationId: t1.id,
      heldSaleId: null,
    });
    expect(await voucherRow(w.id)).toMatchObject({ status: 'issued', heldSaleId: null });
    expect(await voucherRow(x.id)).toMatchObject({ status: 'issued', heldSaleId: null });
    // Append-only, and the reset leaves every row exactly as it was.
    expect(await ledger()).toEqual(ledgerBefore);
    // Still used up: a second scan says so, with no sale left to name.
    const again = await lookup(tillB, v.code);
    expect(again.json().error).toMatchObject({
      code: 'ALREADY_REDEEMED',
      details: { saleId: null, receiptNumber: null },
    });
  });
});
