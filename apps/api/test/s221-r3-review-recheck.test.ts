import { generateKeyPairSync } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  benefitApplication,
  benefitUsage,
  branch,
  employee,
  paymentAttempt,
  product,
  productCategory,
  sale,
  saleDiscount,
  station,
} from '@oto/db';
import { businessDate, newId, normalizePhone, parseDayStart } from '@oto/shared';
import {
  ADMIN,
  OTO_OPERATOR_NAME,
  RECEPTION,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { openQrAttempt } from '../src/services/payments/gateway';
import { recordManualTender } from '../src/services/payments/terminal';
import { removeSaleBenefit } from '../src/services/benefit-checkout';

/**
 * S2-21 (SCRUM-218) round 3 — THE RE-CHECK of the fix round (head d3c64fa3).
 *
 * REJECT 1 was that a sale whose staff benefit had been taken off (or moved to
 * the order rung up again) could still take a card or a QR, leaving money on a
 * sale that cannot close. The fix calls `assertSaleBenefitsLive` on every
 * tender road and holds the application FOR SHARE. This file attacks the fix
 * from the sides the first review did not:
 *
 *   - every road after a MOVE (the first review pinned only the keyed-in card
 *     after a move), and the wallet-credit road, which the first review did not
 *     name, after a removal and after a move;
 *   - the removal racing a card, both ways round, on the sale lock;
 *   - an attempt still in flight holds the benefit against both release roads,
 *     and a declined one gives it up — after which the card is refused;
 *   - the guard refuses nothing it should not: a live benefit sale takes a card
 *     in part, closes by cash with its benefit, and opens a QR;
 *   - voiding the order a benefit was moved off gives nothing back a second
 *     time;
 *   - findings 2 and 4 re-checked with shapes the builder's tests did not use.
 */

const keys = generateKeyPairSync('ed25519');
const PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let ctx: TestContext;
let admin: string;
let reception: string;
let operatorId: string;
let branchId: string;
let receptionId: string;
let t1: typeof station.$inferSelect;
let today = '';
const item = { espresso: '', hotdog: '', water: '' };
let som = '';
let somCode = '';

let n = 0;
const idem = () => `s221-r3-recheck-${process.pid}-${Date.now()}-${n++}`;

interface Envelope {
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  cookie: string,
  payload?: unknown,
): Promise<{ status: number; body: T & Envelope; raw: string }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : {}) as T & Envelope, raw: res.body };
}

const line = (productId: string, quantity = 1) => ({ id: newId(), productId, quantity });
type Line = ReturnType<typeof line>;
let pickup = 60;
const cart = (items: Line[], benefit?: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  stationId: t1.id,
  channel: 'fnb',
  pickupCode: String(pickup++),
  items,
  ...(benefit ? { benefit } : {}),
  ...extra,
});
const scanOf = (code: string) => ({ applicationId: newId(), code });

async function commit(body: Record<string, unknown>, id: string = newId()) {
  return call<{ sale: { id: string; status: string; totals: { grossSatang: number } } }>('POST', '/sales', reception, {
    id,
    actionId: newId(),
    ...body,
  });
}
const applicationsOf = (saleId: string) =>
  ctx.db.select().from(benefitApplication).where(eq(benefitApplication.saleId, saleId));
const attemptsOf = (saleId: string) => ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
async function coffeesUsed(): Promise<number> {
  const rows = await ctx.db
    .select()
    .from(benefitUsage)
    .where(and(eq(benefitUsage.employeeId, som), eq(benefitUsage.itemKey, 'free:coffee')));
  return rows.reduce((s, r) => s + r.qtyUsed, 0);
}
const resetUsage = () => ctx.db.delete(benefitUsage).where(eq(benefitUsage.employeeId, som));

/** A rung-up F&B sale with Som's free coffee on it. */
async function rungUp(): Promise<{ saleId: string; scan: ReturnType<typeof scanOf> }> {
  await resetUsage();
  const saleId = newId();
  const scan = scanOf(somCode);
  const rung = await commit(cart([line(item.espresso), line(item.hotdog)], scan), saleId);
  expect(rung.status, rung.raw).toBe(200);
  expect((await applicationsOf(saleId))[0]!.removedAt).toBeNull();
  expect(await coffeesUsed()).toBe(1);
  return { saleId, scan };
}

/** The same rung-up sale, its benefit then moved to the order rung up again. */
async function movedOff(): Promise<{ saleId: string; movedId: string }> {
  const { saleId, scan } = await rungUp();
  const movedId = newId();
  const again = await commit(cart([line(item.espresso), line(item.hotdog), line(item.water)], scan), movedId);
  expect(again.status, again.raw).toBe(200);
  expect((await applicationsOf(saleId))[0]!.removedReason).toBe('moved');
  expect(await coffeesUsed()).toBe(1);
  return { saleId, movedId };
}

async function removedOff(): Promise<string> {
  const { saleId } = await rungUp();
  const off = await call<{ removed: boolean }>('DELETE', `/sales/${saleId}/benefit`, reception);
  expect(off.status, off.raw).toBe(200);
  expect(off.body.removed).toBe(true);
  expect(await coffeesUsed()).toBe(0);
  return saleId;
}

type Road = { status: number; body: Envelope };
async function qrOn(saleId: string): Promise<Road> {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
  return openQrAttempt(
    ctx.db,
    ctx.app.env,
    ctx.app.log,
    { operatorId, branchId, requestId: `recheck-${newId()}` },
    {
      operatorId,
      branchId,
      saleId,
      stationId: row!.stationId,
      businessDate: row!.businessDate,
      amountSatang: row!.grossSatang,
      methodCode: 'promptpay',
      actionId: newId(),
      accountId: receptionId,
      description: 'Benefit re-check',
    },
  ).then(
    () => ({ status: 200, body: {} }),
    (err: { statusCode?: number; code?: string }) => ({
      status: err.statusCode ?? 500,
      body: { error: { code: err.code ?? 'THROWN', message: '' } },
    }),
  );
}
const roads: Record<string, (saleId: string) => Promise<Road>> = {
  cash: (saleId) => call('POST', `/sales/${saleId}/finalise`, reception, { method: 'cash' }),
  'part payment': (saleId) => call('POST', `/sales/${saleId}/finalise`, reception, { method: 'cash', amountSatang: 1_000 }),
  'keyed-in card': (saleId) =>
    call('POST', '/payments/manual', reception, {
      saleId,
      approvalCode: '123456',
      tid: '12345678',
      last4: '4242',
      amountSatang: 1_000,
    }),
  terminal: (saleId) => call('POST', '/payments/attempts', reception, { saleId }),
  qr: qrOn,
  // The wallet credit is written by the platform inside `finaliseSale`: a road
  // the first review did not name. A wallet key that resolves to nothing is
  // enough — the guard must answer before the wallet is even looked up.
  'wallet credit': (saleId) =>
    call('POST', `/sales/${saleId}/finalise`, reception, { wallet: { key: `OTO-W-${newId()}`, useCredit: true } }),
};

/** Wait until some session is queued on a lock while touching `pos.sale`. */
async function waitForSaleLockWait(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const waiting = await ctx.db.execute(
      sql`select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'
             and query ilike '%"sale"%' and query ilike '%for update%'`,
    );
    if (Number((waiting.rows[0] as { n: number }).n) > 0) return;
    if (Date.now() > deadline) throw new Error('nothing ever queued on the sale row');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { BENEFIT_QR_PRIVATE_KEY: PRIVATE_KEY } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  const [rec] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
  receptionId = rec!.id;
  const tills = await ctx.db.select().from(station).where(eq(station.operatorId, operatorId));
  t1 = tills.find((s) => s.kind === 'till' && s.codePrefix === 'T1')!;
  branchId = t1.branchId;
  const [br] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
  today = businessDate(new Date(), br!.timezone, parseDayStart(String(br!.businessDayStart).slice(0, 5)));

  const [coffee] = await ctx.db
    .select({ id: productCategory.id })
    .from(productCategory)
    .where(and(eq(productCategory.operatorId, operatorId), eq(productCategory.code, 'DRINKS-COFFEE')));
  item.espresso = newId();
  await ctx.db.insert(product).values({
    id: item.espresso,
    operatorId,
    kind: 'menu',
    name: 'Espresso (r3 re-check)',
    code: 'FB-ESPRESSO-R3C',
    priceSatang: 6_000,
    categoryId: coffee!.id,
  });
  const menu = await ctx.db.select().from(product).where(eq(product.operatorId, operatorId));
  item.hotdog = menu.find((p) => p.code === 'FB-HOTDOG')!.id;
  item.water = menu.find((p) => p.code === 'FB-WATER')!.id;

  const [person] = await ctx.db
    .select({ id: employee.id })
    .from(employee)
    .where(and(eq(employee.operatorId, operatorId), eq(employee.name, 'Som (Reception)')));
  som = person!.id;
  const made = await call<{ credential: { id: string } }>('POST', '/benefits/credentials', admin, { employeeId: som });
  expect(made.status, made.raw).toBe(200);
  somCode = (await call<{ code: string }>('GET', `/benefits/credentials/${made.body.credential.id}/qr`, admin)).body.code;
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
}, 240_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// --- REJECT 1, from the sides the first review did not take ----------------------------

describe('REJECT 1 re-checked — every road, after a move as after a removal', () => {
  for (const road of Object.keys(roads)) {
    it(`${road}: refused BENEFIT_APPLICATION_RELEASED on the order the benefit was moved off, nothing written`, async () => {
      const { saleId, movedId } = await movedOff();
      const res = await roads[road]!(saleId);
      expect(`${res.status} ${res.body.error?.code ?? ''}`).toBe('409 BENEFIT_APPLICATION_RELEASED');
      expect(await attemptsOf(saleId)).toEqual([]);
      const [old] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
      expect(old!.status).toBe('tendering');
      // The benefit stays where it went, and the quota is held once.
      expect((await applicationsOf(movedId))[0]!.removedAt).toBeNull();
      expect(await coffeesUsed()).toBe(1);
    });
  }

  it('wallet credit: refused BENEFIT_APPLICATION_RELEASED on a sale whose benefit was taken off', async () => {
    const saleId = await removedOff();
    const res = await roads['wallet credit']!(saleId);
    expect(`${res.status} ${res.body.error?.code ?? ''}`).toBe('409 BENEFIT_APPLICATION_RELEASED');
    expect(await attemptsOf(saleId)).toEqual([]);
  });

  it('the order the benefit was moved off can still be voided, and the void gives nothing back a second time', async () => {
    const { saleId, movedId } = await movedOff();
    const voided = await call('POST', `/sales/${saleId}/void`, admin, { reason: 'Rung up again' });
    expect(voided.status, voided.raw).toBe(200);
    expect((await applicationsOf(movedId))[0]!.removedAt).toBeNull();
    expect(await coffeesUsed()).toBe(1);
    // And the order it moved to closes with it.
    const closed = await call<{ finalised: boolean }>('POST', `/sales/${movedId}/finalise`, reception, { method: 'cash' });
    expect(closed.status, closed.raw).toBe(200);
    expect(closed.body.finalised).toBe(true);
  });
});

describe('REJECT 1 re-checked — the removal and a card, at the same instant', () => {
  const tenderActor = () => ({ accountId: receptionId, operatorId, assertBranchAllowed: async () => {} });

  it('the card first: the removal waits on the sale, then is refused SALE_HAS_PAYMENT; the sale closes with its benefit', async () => {
    const { saleId } = await rungUp();
    let letCardCommit!: () => void;
    const gate = new Promise<void>((resolve) => (letCardCommit = resolve));
    let cardRecorded!: () => void;
    const recorded = new Promise<void>((resolve) => (cardRecorded = resolve));
    const card = ctx.db.transaction(async (tx) => {
      const out = await recordManualTender(tx, tenderActor(), {
        saleId,
        approvalCode: '222222',
        tid: '12345678',
        last4: '4242',
        amountSatang: 1_000,
        actionId: newId(),
      });
      cardRecorded();
      await gate;
      return out;
    });
    await recorded;
    const removal = call('DELETE', `/sales/${saleId}/benefit`, reception);
    await waitForSaleLockWait();
    letCardCommit();
    const [paid, refused] = await Promise.all([card, removal]);
    expect(paid.attempt.status).toBe('approved');
    expect(`${refused.status} ${refused.body.error?.code ?? ''}`).toBe('409 SALE_HAS_PAYMENT');
    expect((await applicationsOf(saleId))[0]!.removedAt).toBeNull();
    expect(await coffeesUsed()).toBe(1);
    const closed = await call<{ finalised: boolean }>('POST', `/sales/${saleId}/finalise`, reception, { method: 'cash' });
    expect(closed.status, closed.raw).toBe(200);
    expect(closed.body.finalised).toBe(true);
  });

  it('the removal first: the card waits on the sale, then is refused RELEASED, and no attempt is written', async () => {
    const { saleId } = await rungUp();
    let letRemovalCommit!: () => void;
    const gate = new Promise<void>((resolve) => (letRemovalCommit = resolve));
    let removed!: () => void;
    const done = new Promise<void>((resolve) => (removed = resolve));
    const removal = ctx.db.transaction(async (tx) => {
      const out = await removeSaleBenefit(tx, { accountId: receptionId, operatorId }, saleId);
      removed();
      await gate;
      return out;
    });
    await done;
    const card = call('POST', '/payments/manual', reception, {
      saleId,
      approvalCode: '333333',
      tid: '12345678',
      last4: '4242',
    });
    await waitForSaleLockWait();
    letRemovalCommit();
    const [off, refused] = await Promise.all([removal, card]);
    expect(off.removed).toBe(true);
    expect(`${refused.status} ${refused.body.error?.code ?? ''}`).toBe('409 BENEFIT_APPLICATION_RELEASED');
    expect(await attemptsOf(saleId)).toEqual([]);
    expect(await coffeesUsed()).toBe(0);
  });
});

describe('REJECT 1 re-checked — an attempt in flight holds the benefit; a declined one lets it go', () => {
  it('in flight: the removal and the move are both refused; declined: the removal goes through and the next card is refused', async () => {
    const { saleId, scan } = await rungUp();
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const attemptId = newId();
    // A card the terminal has been asked for and has not answered.
    await ctx.db.insert(paymentAttempt).values({
      id: attemptId,
      operatorId,
      branchId,
      saleId,
      stationId: row!.stationId,
      businessDate: row!.businessDate,
      method: 'card',
      methodCode: 'card',
      provider: 'simulator',
      status: 'sent_to_terminal',
      amountSatang: row!.grossSatang,
    });
    const off = await call('DELETE', `/sales/${saleId}/benefit`, reception);
    expect(`${off.status} ${off.body.error?.code ?? ''}`).toBe('409 PAYMENT_IN_FLIGHT');
    const movedId = newId();
    const move = await commit(cart([line(item.espresso), line(item.water)], scan), movedId);
    expect(`${move.status} ${move.body.error?.code ?? ''}`).toBe('409 BENEFIT_APPLICATION_USED');
    expect(await ctx.db.select().from(sale).where(eq(sale.id, movedId))).toEqual([]);
    expect((await applicationsOf(saleId))[0]!.removedAt).toBeNull();
    expect(await coffeesUsed()).toBe(1);

    // The terminal declines it: nothing was taken, and the benefit may come off.
    await ctx.db.update(paymentAttempt).set({ status: 'declined' }).where(eq(paymentAttempt.id, attemptId));
    const offNow = await call<{ removed: boolean }>('DELETE', `/sales/${saleId}/benefit`, reception);
    expect(offNow.status, offNow.raw).toBe(200);
    expect(offNow.body.removed).toBe(true);
    expect(await coffeesUsed()).toBe(0);
    const card = await roads['keyed-in card']!(saleId);
    expect(`${card.status} ${card.body.error?.code ?? ''}`).toBe('409 BENEFIT_APPLICATION_RELEASED');
    expect((await attemptsOf(saleId)).map((a) => a.status)).toEqual(['declined']);
  });
});

describe('the guard refuses nothing it should not', () => {
  it('a live benefit sale takes a keyed-in card in part, then closes by cash with its benefit; the benefit then stays used', async () => {
    const { saleId } = await rungUp();
    const card = await roads['keyed-in card']!(saleId);
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    const closed = await call<{ finalised: boolean }>('POST', `/sales/${saleId}/finalise`, reception, { method: 'cash' });
    expect(closed.status, closed.raw).toBe(200);
    expect(closed.body.finalised).toBe(true);
    const [app] = await applicationsOf(saleId);
    expect(app!.removedAt).toBeNull();
    const [row] = await ctx.db
      .select()
      .from(saleDiscount)
      .where(and(eq(saleDiscount.saleId, saleId), eq(saleDiscount.reason, 'Staff benefit')));
    expect(row!.benefitApplicationId).toBe(app!.id);
    expect(row!.amountSatang).toBe(app!.appliedSatang);
    const off = await call('DELETE', `/sales/${saleId}/benefit`, reception);
    expect(`${off.status} ${off.body.error?.code ?? ''}`).toBe('409 SALE_FINALISED');
    expect(await coffeesUsed()).toBe(1);
  });

  it('a live benefit sale opens a QR, and the terminal road goes past the guard', async () => {
    const { saleId } = await rungUp();
    const terminal = await roads.terminal!(saleId);
    expect(terminal.body.error?.code).not.toBe('BENEFIT_APPLICATION_RELEASED');
    const qr = await qrOn(saleId);
    expect(qr.status, JSON.stringify(qr.body)).toBe(200);
    expect((await attemptsOf(saleId)).some((a) => a.method === 'qr')).toBe(true);
  });
});

// --- Findings 2 and 4, re-checked -------------------------------------------------------

describe('finding 2 re-checked — "Staff benefit" spelled with what prints as nothing', () => {
  const forged = (reason: string) => ({
    id: newId(),
    scope: 'order',
    type: 'comp',
    value: 0,
    reason,
    note: 'Scanned: Khun Anan (owner)',
  });

  it('default-ignorable fillers and joiners the builder’s tests did not use are refused on quote and commit', async () => {
    const shapes = [
      'Staff benefitᅟ', // HANGUL CHOSEONG FILLER
      'Staffﾠ benefit', // HALFWIDTH HANGUL FILLER (NFKC → U+3164)
      'Staff ㅤbenefit', // HANGUL FILLER beside a real space
      'Staff͏ benefit', // COMBINING GRAPHEME JOINER
      'Staff᠎ benefit', // MONGOLIAN VOWEL SEPARATOR
      'Staff benefit\u{E0020}', // TAG SPACE
      'Staff benefit️', // VARIATION SELECTOR-16
      'Ｓtaff　benefit', // full-width S and an ideographic space
    ];
    for (const reason of shapes) {
      const q = await call('POST', '/sales/quote', reception, cart([line(item.water)], null, { manualDiscounts: [forged(reason)] }));
      expect(`${q.status} ${q.body.error?.code ?? ''}`, JSON.stringify(reason)).toBe('409 BENEFIT_DISCOUNT_UNLINKED');
      const saleId = newId();
      const c = await commit(cart([line(item.water)], null, { manualDiscounts: [forged(reason)] }), saleId);
      expect(`${c.status} ${c.body.error?.code ?? ''}`, JSON.stringify(reason)).toBe('409 BENEFIT_DISCOUNT_UNLINKED');
      expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);
    }
  });

  /**
   * NOT BLOCKING, same class and same stakes as finding 2. The fold DROPS a
   * default-ignorable character instead of reading it as the blank it prints
   * as, and U+2800 is neither ignorable nor `\s`. So a reason with the space
   * itself replaced is not refused: 'Staffㅤbenefit' (HANGUL FILLER, the
   * well-known blank-looking "invisible" letter) folds to 'staffbenefit', and
   * 'Staff⠀benefit' (BRAILLE PATTERN BLANK) is kept as it is. Both print
   * as "Staff benefit" in most fonts. Probed through POST /sales at d3c64fa3,
   * type comp, note 'Scanned: Khun Anan (owner)': both 200, each recorded as a
   * ฿25 comp row with that reason and no application behind it, audited to
   * the signed-in account (no rights gained, as in finding 2). A fold that
   * compares the letters alone —
   * `.replace(/[^\p{L}]/gu, '')` against 'staffbenefit' after NFKC — closes
   * every spacing, on the platform and on the box, which share the function.
   */
  it.todo('"Staff" and "benefit" joined by U+3164 or U+2800 instead of a space are refused BENEFIT_DISCOUNT_UNLINKED');
});

describe('finding 4 re-checked — a manual discount on the scan’s id, spelled another way', () => {
  it('the scan’s id in capitals: recorded as an ordinary manual discount, and the benefit row stays the platform’s own', async () => {
    await resetUsage();
    const scan = scanOf(somCode);
    const twin = {
      id: scan.applicationId.toUpperCase(),
      scope: 'order',
      type: 'fixed',
      value: 1_000,
      reason: 'Service recovery',
    };
    const saleId = newId();
    const c = await commit(cart([line(item.espresso), line(item.hotdog)], scan, { manualDiscounts: [twin] }), saleId);
    // Probed at d3c64fa3: recorded (200). The two ids are different strings to
    // the engine and to every comparison on the way, so this is an ordinary
    // manual discount — reception's to give (R-08) — beside the benefit's own
    // row, and only the benefit's row links the application.
    expect(c.status, c.raw).toBe(200);
    const [app] = await ctx.db
      .select()
      .from(benefitApplication)
      .where(and(eq(benefitApplication.saleId, saleId), isNull(benefitApplication.removedAt)));
    const rows = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    const linked = rows.filter((r) => r.benefitApplicationId !== null);
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ reason: 'Staff benefit', amountSatang: app!.appliedSatang });
    const plain = rows.filter((r) => r.kind === 'manual' && r.benefitApplicationId === null);
    expect(plain.map((r) => [r.reason, r.amountSatang])).toEqual([['Service recovery', 1_000]]);
    expect(await coffeesUsed()).toBe(1);
  });
});
