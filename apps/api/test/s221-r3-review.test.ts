import { createHash, generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  benefitApplication,
  benefitUsage,
  box,
  branch,
  employee,
  idempotencyKey,
  paymentAttempt,
  product,
  productCategory,
  sale,
  saleDiscount,
  station,
  syncQuarantine,
} from '@oto/db';
import {
  applyStaffBenefits,
  benefitPeriodKey,
  businessDate,
  canonicalSyncBytes,
  LEGACY_SATANG_ENGINE_VERSION,
  newId,
  normalizePhone,
  parseDayStart,
  PRICING_ENGINE_VERSION,
  SYNC_EVENT_SCHEMA_VERSION,
  type BenefitLine,
  type BenefitProfile,
  type BenefitUsageState,
  type OfflineBenefitRecord,
  type SyncEventEnvelope,
  type SyncPushResponse,
} from '@oto/shared';
import { boxCredential } from '@oto/box-agent';
import {
  ADMIN,
  CHALONG_MANAGER,
  OTO_OPERATOR_NAME,
  RECEPTION,
  boxBySlot,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { commitSale } from '../src/services/sale';
import { effectiveBenefitOn } from '../src/services/benefits';
import { issueClaimCode } from '../src/services/box';
import { openQrAttempt } from '../src/services/payments/gateway';

/**
 * S2-21 (SCRUM-218) round 3 — THE REVIEW: the money, attacked.
 *
 *   (1) the server recompute: a doctored benefit body is ignored, and the four
 *       amounts are the shared engine's on the same cart, profile and usage —
 *       with Q11's order (the order's manual discounts, then the benefit, then
 *       a promo code) held on one sale;
 *   (2) H1 for real: the conditional claim is made to WAIT on the other till's
 *       uncommitted claim (pg_stat_activity), for the last coffee, the first
 *       coffees of the day and the last satang of credit; a commit replayed
 *       across a restart claims once; the same scan under two sale ids at once
 *       holds one claim; removal gives it back exactly once;
 *   (3) refusals: an unlinked "Staff benefit" row, a QR revoked between the
 *       preview and the commit, a quota exhausted between them;
 *   (4) offline, END TO END through `/box/v1/sync/push` (the builder's gap):
 *       a comp and a standing percent replay; an older engine and a smuggled
 *       free coffee are quarantined, never repriced;
 *   (6) audit rows carry the station and the box, and no table anywhere holds
 *       a benefit QR's signature;
 *   (7) resolve's echo, a few more shapes, and the commit's own refusal.
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
let t2: typeof station.$inferSelect;
let coffeeCategoryId: string;
let today = '';
const item = { espresso: '', hotdog: '', water: '' };
const price = { espresso: 6_000, hotdog: 0, water: 0 };
const people = { anan: '', som: '', nok: '', lek: '' };
const codes = { anan: '', som: '', nok: '', lek: '' };
const credentialIds = { anan: '', som: '', nok: '', lek: '' };
/** Every QR issued in this file, for the "no table holds it" sweep. */
const issued: string[] = [];

let n = 0;
const idem = () => `s221-r3-review-${process.pid}-${Date.now()}-${n++}`;

interface Envelope {
  error?: { code: string; message: string; details?: Record<string, unknown> };
}
interface Breakdown {
  applicationId: string;
  isComp: boolean;
  compedSatang: number;
  freeItemsSatang: number;
  creditSatang: number;
  discountSatang: number;
  totalReliefSatang: number;
  appliedSatang: number;
  source: string;
}

async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  cookie: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T & Envelope; raw: string; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}), ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    body: (res.body ? res.json() : {}) as T & Envelope,
    raw: res.body,
    headers: res.headers as Record<string, unknown>,
  };
}

const line = (productId: string, quantity = 1) => ({ id: newId(), productId, quantity });
type Line = ReturnType<typeof line>;

let pickup = 40;
function cart(
  items: Line[],
  benefit?: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
  stationId: string = t1.id,
) {
  return {
    stationId,
    channel: 'fnb',
    pickupCode: String(pickup++),
    items,
    ...(benefit ? { benefit } : {}),
    ...extra,
  };
}

const benefitOf = (code: string, over: Record<string, unknown> = {}) => ({
  applicationId: newId(),
  code,
  ...over,
});

async function quote(body: Record<string, unknown>, cookie = reception) {
  return call<{ benefit: Breakdown | null; totals: { grossSatang: number } }>('POST', '/sales/quote', cookie, body);
}

async function commit(body: Record<string, unknown>, id: string = newId(), cookie = reception, headers: Record<string, string> = {}) {
  return call<{ sale: { id: string; status: string; totals: { grossSatang: number } }; benefit: Breakdown | null; replay: boolean }>(
    'POST',
    '/sales',
    cookie,
    { id, actionId: newId(), ...body },
    headers,
  );
}

async function usageOf(employeeId: string) {
  return ctx.db.select().from(benefitUsage).where(eq(benefitUsage.employeeId, employeeId));
}
async function counter(employeeId: string, itemKey: string) {
  return (await usageOf(employeeId)).filter((u) => u.itemKey === itemKey);
}
async function resetUsage(employeeId: string) {
  await ctx.db.delete(benefitUsage).where(eq(benefitUsage.employeeId, employeeId));
}
/** A counter as another order left it, keyed exactly as the platform keys it today. */
async function seedUsage(employeeId: string, itemKey: string, kind: 'daily' | 'monthly', qty: number, credit: number) {
  await ctx.db.insert(benefitUsage).values({
    id: newId(),
    operatorId,
    employeeId,
    itemKey,
    periodKind: kind,
    periodKey: benefitPeriodKey(kind, today),
    qtyUsed: qty,
    creditUsedSatang: credit,
  });
}
async function applicationsOf(saleId: string) {
  return ctx.db.select().from(benefitApplication).where(eq(benefitApplication.saleId, saleId));
}
async function liveByClient(clientId: string) {
  return (await ctx.db.select().from(benefitApplication).where(eq(benefitApplication.clientId, clientId))).filter(
    (a) => a.removedAt === null,
  );
}
async function auditOf(action: string, entityIds: string[]) {
  if (entityIds.length === 0) return [];
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), inArray(auditLog.entityId, entityIds)));
}

/** The engine's lines for a cart of espressos (Coffee) and hot dogs, as the platform reads them. */
function engineLines(lines: { productId: string; quantity: number }[]): BenefitLine[] {
  return lines.map((l) => {
    const isCoffee = l.productId === item.espresso;
    const unit = isCoffee ? price.espresso : price.hotdog;
    return {
      itemId: l.productId,
      categoryIds: isCoffee ? [coffeeCategoryId] : [],
      qty: l.quantity,
      lineTotal: unit * l.quantity,
    };
  });
}

/** The usage a person's counters say, in the engine's shape. */
async function usageState(employeeId: string, profile: BenefitProfile): Promise<BenefitUsageState> {
  const rows = await usageOf(employeeId);
  const state: BenefitUsageState = { freeItemsUsed: {}, creditUsedSatang: 0 };
  for (const f of profile.freeItems ?? []) {
    const row = rows.find((r) => r.itemKey === `free:${f.id}` && r.periodKey === benefitPeriodKey(f.period, today));
    state.freeItemsUsed[f.id] = row?.qtyUsed ?? 0;
  }
  if (profile.credit) {
    const row = rows.find((r) => r.itemKey === 'credit' && r.periodKey === benefitPeriodKey(profile.credit!.period, today));
    state.creditUsedSatang = Number(row?.creditUsedSatang ?? 0);
  }
  return state;
}

/** Wait until some session is queued on a lock while touching `promo.benefit_usage`. */
async function waitForUsageLockWait(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const waiting = await ctx.db.execute(
      sql`select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'
             and query ilike '%benefit_usage%'`,
    );
    if (Number((waiting.rows[0] as { n: number }).n) > 0) return;
    if (Date.now() > deadline) throw new Error('the second claim never queued on the usage counter');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const serviceActor = () => ({ accountId: receptionId, operatorId, branchId: null });

/**
 * Two tills at the same counter, for real: the first commits a sale that
 * claims the last of something and HOLDS its transaction open; the second's
 * commit is priced inside its own transaction while the first is uncommitted
 * (so it is shown the same relief), reaches the conditional claim, and is made
 * to wait on the first's row or index entry. Then the first commits.
 */
async function raceTwoTills(employeeCode: string, items: () => Line[]) {
  let letFirstCommit!: () => void;
  const gate = new Promise<void>((resolve) => (letFirstCommit = resolve));
  let firstClaimed!: () => void;
  const claimed = new Promise<void>((resolve) => (firstClaimed = resolve));
  const ids = { a: newId(), b: newId() };
  const first = ctx.db.transaction(async (tx) => {
    const out = await commitSale(tx, serviceActor(), {
      id: ids.a,
      ...cart(items(), benefitOf(employeeCode), {}, t1.id),
    } as never);
    firstClaimed();
    await gate;
    return out;
  });
  await claimed;
  const second = ctx.db.transaction(async (tx) =>
    commitSale(tx, serviceActor(), { id: ids.b, ...cart(items(), benefitOf(employeeCode), {}, t2.id) } as never),
  );
  await waitForUsageLockWait();
  letFirstCommit();
  const [a, b] = await Promise.allSettled([first, second]);
  return { ids, a, b };
}

// --- A box with a till of its own, for the sync push ----------------------------

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
async function freshBox(): Promise<TestBox> {
  const seeded = await boxBySlot(ctx.db, 'virtual-1');
  const k = (boxCounter += 1);
  const boxId = newId();
  await ctx.db.insert(box).values({
    id: boxId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    name: `Benefit review box ${k}`,
    slot: `benefit-review-${k}`,
    role: 'virtual',
    status: 'unclaimed',
  });
  const stationId = newId();
  const prefix = `BR${k}`;
  await ctx.db.insert(station).values({
    id: stationId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    boxId,
    name: `Benefit review counter ${k}`,
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
      hostname: `benefit-review-${k}`,
      syncPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      syncKeyAlgorithm: 'ed25519',
    },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  const body = registered.json() as { boxId: string; secret: string };
  return { boxId, credential: boxCredential(body.boxId, body.secret), privateKey, stationId, prefix, nextSeq: 1 };
}

function mint(b: TestBox, type: string, payload: Record<string, unknown>): SyncEventEnvelope {
  const base = {
    eventId: newId(),
    journalEpoch: 1,
    boxSeq: b.nextSeq++,
    type,
    schemaVersion: SYNC_EVENT_SCHEMA_VERSION,
    occurredAt: new Date().toISOString(),
    clockTrust: 'trusted' as const,
    stationId: b.stationId,
    actorKind: 'account' as const,
    actorAccountId: receptionId,
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

// ---------------------------------------------------------------------------------

beforeAll(async () => {
  ctx = await createTestContext({ env: { BENEFIT_QR_PRIVATE_KEY: PRIVATE_KEY } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  const [rec] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
  receptionId = rec!.id;

  const tills = await ctx.db.select().from(station).where(eq(station.operatorId, operatorId));
  t1 = tills.find((s) => s.kind === 'till' && s.codePrefix === 'T1')!;
  branchId = t1.branchId;
  t2 = tills.find(
    (s) =>
      s.kind === 'till' &&
      s.branchId === t1.branchId &&
      s.id !== t1.id &&
      s.codePrefix &&
      !s.archivedAt &&
      ((s.capabilities ?? []).length === 0 || (s.capabilities ?? []).includes('fnb')),
  )!;
  expect(t2, 'a second F&B-capable till at the same branch').toBeTruthy();
  expect(t1.boxId, 'Till 1 sits on a box: the audit rows must name it').toBeTruthy();

  const [br] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
  today = businessDate(new Date(), br!.timezone, parseDayStart(String(br!.businessDayStart).slice(0, 5)));

  const [coffee] = await ctx.db
    .select({ id: productCategory.id })
    .from(productCategory)
    .where(and(eq(productCategory.operatorId, operatorId), eq(productCategory.code, 'DRINKS-COFFEE')));
  coffeeCategoryId = coffee!.id;
  item.espresso = newId();
  await ctx.db.insert(product).values({
    id: item.espresso,
    operatorId,
    kind: 'menu',
    name: 'Espresso (r3 review)',
    code: 'FB-ESPRESSO-R3R',
    priceSatang: price.espresso,
    categoryId: coffeeCategoryId,
  });
  const menu = await ctx.db.select().from(product).where(eq(product.operatorId, operatorId));
  const hotdog = menu.find((p) => p.code === 'FB-HOTDOG')!;
  item.hotdog = hotdog.id;
  price.hotdog = hotdog.priceSatang;
  const water = menu.find((p) => p.code === 'FB-WATER')!;
  item.water = water.id;
  price.water = water.priceSatang;
  // The hot dog is not a coffee, whatever the menu seed files it under.
  expect(hotdog.categoryId).not.toBe(coffeeCategoryId);

  const staff = await ctx.db
    .select({ id: employee.id, name: employee.name })
    .from(employee)
    .where(eq(employee.operatorId, operatorId));
  const byName = (name: string) => staff.find((r) => r.name === name)!.id;
  people.anan = byName('Khun Anan (Owner)');
  people.som = byName('Som (Reception)');
  people.nok = byName('Nok (Reception)');
  people.lek = byName('Khun Lek (Manager)');
  for (const who of ['anan', 'som', 'nok', 'lek'] as const) {
    const made = await call<{ credential: { id: string } }>('POST', '/benefits/credentials', admin, {
      employeeId: people[who],
    });
    expect(made.status, made.raw).toBe(200);
    credentialIds[who] = made.body.credential.id;
    codes[who] = (
      await call<{ code: string }>('GET', `/benefits/credentials/${made.body.credential.id}/qr`, admin)
    ).body.code;
    issued.push(codes[who]);
  }
}, 240_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

const signatureOf = (code: string) => code.slice(code.lastIndexOf('.') + 1);

// --- (1) the server recompute --------------------------------------------------

describe('(1) the figures are the platform’s, and they are the shared engine’s', () => {
  it('a doctored benefit body is ignored: quote, preview and commit give the engine’s four amounts on the same cart, profile and usage', async () => {
    await resetUsage(people.lek);
    // Lek has used one of today's two coffees and ฿420 of this month's ฿500.
    await seedUsage(people.lek, 'free:coffee', 'daily', 1, 0);
    await seedUsage(people.lek, 'credit', 'monthly', 0, 42_000);
    const effective = await effectiveBenefitOn(ctx.db, operatorId, people.lek, today);
    expect(effective.profile.freeItems?.[0]?.id).toBe('coffee');
    const items = () => [line(item.espresso, 3), line(item.hotdog, 2)];
    const sample = items();
    const expected = applyStaffBenefits(
      effective.profile,
      await usageState(people.lek, effective.profile),
      engineLines(sample),
    );
    // Something to relieve at every stage, so a doctored figure has a place to land.
    expect(expected.freeItemsSatang).toBe(6_000);
    expect(expected.creditSatang).toBe(8_000);
    expect(expected.discountSatang).toBeGreaterThan(0);

    const doctored = {
      ...benefitOf(codes.lek),
      // Fields a till has no business sending: never read.
      isComp: true,
      compedSatang: 99_999_00,
      totalReliefSatang: 99_999_00,
      freeItemsSatang: 1,
      profile: { comp: true },
      usage: { freeItemsUsed: { coffee: 0 }, creditUsedSatang: 0 },
      // Lower than the truth: the only thing it can do is nothing.
      expectedReliefSatang: 1,
    };
    // And the box's own record, which only the offline replay may carry.
    const offlineComp = {
      applicationId: newId(),
      credentialId: credentialIds.anan,
      employeeId: people.anan,
      name: 'Khun Anan (Owner)',
      benefitRole: 'owner',
      day: today,
      isComp: true,
      compedSatang: 30_000,
      discountSatang: 0,
      totalReliefSatang: 30_000,
      onlineOnly: [],
      standingDiscount: null,
      engineVersion: PRICING_ENGINE_VERSION,
    };
    const four = (b: Breakdown | null) => ({
      isComp: b?.isComp,
      compedSatang: b?.compedSatang,
      freeItemsSatang: b?.freeItemsSatang,
      creditSatang: b?.creditSatang,
      discountSatang: b?.discountSatang,
      totalReliefSatang: b?.totalReliefSatang,
    });
    const engine = {
      isComp: false,
      compedSatang: 0,
      freeItemsSatang: expected.freeItemsSatang,
      creditSatang: expected.creditSatang,
      discountSatang: expected.discountSatang,
      totalReliefSatang: expected.totalReliefSatang,
    };
    const gross = engineLines(sample).reduce((s, l) => s + l.lineTotal, 0);

    const q = await quote(cart(sample, doctored, { benefitOffline: offlineComp }));
    expect(q.status, q.raw).toBe(200);
    expect(four(q.body.benefit)).toEqual(engine);
    expect(q.body.benefit!.source).toBe('platform');
    expect(q.body.totals.grossSatang).toBe(gross - expected.totalReliefSatang);

    const preview = await call<{ benefit: Breakdown }>(
      'POST',
      `/sales/${newId()}/benefit/preview`,
      reception,
      cart(items(), doctored, { benefitOffline: offlineComp }),
    );
    expect(preview.status, preview.raw).toBe(200);
    expect(four(preview.body.benefit)).toEqual(engine);

    const saleId = newId();
    const res = await commit(cart(items(), doctored, { benefitOffline: offlineComp }), saleId);
    expect(res.status, res.raw).toBe(200);
    expect(four(res.body.benefit)).toEqual(engine);
    expect(res.body.sale.totals.grossSatang).toBe(gross - expected.totalReliefSatang);
    const [app] = await applicationsOf(saleId);
    expect(app).toMatchObject({
      origin: 'cloud',
      employeeId: people.lek,
      isComp: false,
      freeItemsSatang: expected.freeItemsSatang,
      creditSatang: expected.creditSatang,
      discountSatang: expected.discountSatang,
      totalReliefSatang: expected.totalReliefSatang,
      appliedSatang: expected.totalReliefSatang,
    });
    // The counters moved by exactly the engine's deltas.
    expect(app!.usageDeltas.map((d) => [d.itemKey, d.qty, d.creditSatang])).toEqual([
      ['free:coffee', 1, 0],
      ['credit', 0, expected.creditUsedDelta],
    ]);
    expect((await counter(people.lek, 'free:coffee'))[0]!.qtyUsed).toBe(2);
    expect(Number((await counter(people.lek, 'credit'))[0]!.creditUsedSatang)).toBe(50_000);
    // One "Staff benefit" row, at the application's applied figure, linked.
    const rows = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: 'Staff benefit',
      discountType: 'fixed',
      amountSatang: app!.appliedSatang,
      benefitApplicationId: app!.id,
    });
    // Nobody's comp leaked in from the box's record.
    expect(await ctx.db.select().from(benefitApplication).where(eq(benefitApplication.clientId, offlineComp.applicationId))).toEqual([]);
  });

  it('Q11 on one sale: the order’s own manual discount, then the benefit (on the raw lines, capped), then the promo code on what is left', async () => {
    await resetUsage(people.som);
    const items = () => [line(item.espresso, 1), line(item.hotdog, 2)];
    const sample = items();
    const effective = await effectiveBenefitOn(ctx.db, operatorId, people.som, today);
    const expected = applyStaffBenefits(effective.profile, { freeItemsUsed: {}, creditUsedSatang: 0 }, engineLines(sample));
    const raw = engineLines(sample).reduce((s, l) => s + l.lineTotal, 0);
    const manual = 5_000;
    // The engine reads the raw lines, before the manual discount (plan §9): a
    // free coffee and 30 % off the hot dogs.
    expect(expected.freeItemsSatang).toBe(6_000);
    expect(expected.totalReliefSatang).toBe(6_000 + Math.round((price.hotdog * 2 * 30) / 10_000) * 100);
    const extra = {
      manualDiscounts: [{ id: newId(), scope: 'order', type: 'fixed', value: manual, reason: 'Service recovery' }],
      promos: [{ code: 'STAFF10', label: 'Staff Discount', type: 'percent', value: 10 }],
    };
    const q = await quote(cart(sample, benefitOf(codes.som), extra));
    expect(q.status, q.raw).toBe(200);

    const saleId = newId();
    const res = await commit(cart(items(), benefitOf(codes.som), extra), saleId);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.sale.totals.grossSatang).toBe(q.body.totals.grossSatang);
    const rows = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    const manualRows = rows.filter((r) => r.kind === 'manual').sort((a, b) => a.sequence - b.sequence);
    expect(manualRows.map((r) => [r.sequence, r.reason, r.amountSatang])).toEqual([
      [1, 'Service recovery', manual],
      [2, 'Staff benefit', expected.totalReliefSatang],
    ]);
    const promo = rows.find((r) => r.kind !== 'manual');
    expect(promo, JSON.stringify(rows)).toBeTruthy();
    expect(promo!.code).toBe('STAFF10');
    // 10 % of what the manual discount AND the benefit left (฿104), not of
    // what the manual discount alone left (฿230) or of the raw ฿280.
    const left = raw - manual - expected.totalReliefSatang;
    expect(Math.abs(promo!.amountSatang - left / 10)).toBeLessThanOrEqual(100);
    expect(res.body.sale.totals.grossSatang).toBe(left - promo!.amountSatang);
    const [app] = await applicationsOf(saleId);
    expect(app).toMatchObject({ totalReliefSatang: expected.totalReliefSatang, appliedSatang: expected.totalReliefSatang });
    const off = await call('DELETE', `/sales/${saleId}/benefit`, reception);
    expect(off.status, off.raw).toBe(200);
  });

  it('H15 with a promo too: a manual discount that leaves less than the relief caps the row, and the application stores the cap', async () => {
    await resetUsage(people.som);
    const saleId = newId();
    // ฿60 espresso, ฿55 off by hand: the free coffee can take only ฿5, and STAFF10 has nothing left.
    const res = await commit(
      cart([line(item.espresso)], benefitOf(codes.som), {
        manualDiscounts: [{ id: newId(), scope: 'order', type: 'fixed', value: 5_500, reason: 'Service recovery' }],
        promos: [{ code: 'STAFF10', label: 'Staff Discount', type: 'percent', value: 10 }],
      }),
      saleId,
    );
    expect(res.status, res.raw).toBe(200);
    expect(res.body.sale.totals.grossSatang).toBe(0);
    const [app] = await applicationsOf(saleId);
    const [row] = await ctx.db
      .select()
      .from(saleDiscount)
      .where(and(eq(saleDiscount.saleId, saleId), eq(saleDiscount.reason, 'Staff benefit')));
    expect(app).toMatchObject({ totalReliefSatang: 6_000, appliedSatang: 500 });
    expect(row!.amountSatang).toBe(app!.appliedSatang);
    // The quota claimed is what the engine worked out (plan §9's known effect).
    expect((await counter(people.som, 'free:coffee'))[0]!.qtyUsed).toBe(1);
    expect((await call('DELETE', `/sales/${saleId}/benefit`, reception)).status).toBe(200);
  });
});

// --- (3) refusals --------------------------------------------------------------

describe('(3) refusals', () => {
  it('a till’s own "Staff benefit" row is refused however it is spaced, and beside a real scan too — nothing claimed', async () => {
    await resetUsage(people.som);
    for (const reason of ['Staff\u00a0benefit', '\tSTAFF   BENEFIT\n', 'staff Benefit']) {
      const forged = { id: newId(), scope: 'order', type: 'comp', value: 0, reason };
      const q = await quote(cart([line(item.espresso)], null, { manualDiscounts: [forged] }));
      expect(q.status, reason).toBe(409);
      expect(q.body.error!.code).toBe('BENEFIT_DISCOUNT_UNLINKED');
      const saleId = newId();
      const c = await commit(cart([line(item.espresso)], benefitOf(codes.som), { manualDiscounts: [forged] }), saleId);
      expect(c.status, reason).toBe(409);
      expect(c.body.error!.code).toBe('BENEFIT_DISCOUNT_UNLINKED');
      expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);
    }
    expect(await usageOf(people.som)).toEqual([]);
  });

  it('a manual discount keyed on the scan’s own id cannot ride on the benefit row: refused, nothing written', async () => {
    await resetUsage(people.som);
    const scan = benefitOf(codes.som);
    const twin = { id: scan.applicationId, scope: 'order', type: 'fixed', value: 1_000, reason: 'Service recovery' };
    const saleId = newId();
    const c = await commit(cart([line(item.espresso)], scan, { manualDiscounts: [twin] }), saleId);
    expect(c.status, c.raw).not.toBe(200);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);
    expect(await applicationsOf(saleId)).toEqual([]);
    expect(await usageOf(people.som)).toEqual([]);
  });

  it('an exhausted quota at the commit after the preview said yes: refused in the platform’s words, nothing claimed, and the next preview says so', async () => {
    await resetUsage(people.som);
    await seedUsage(people.som, 'free:coffee', 'daily', 1, 0);
    const previewed = await call<{ benefit: Breakdown }>(
      'POST',
      `/sales/${newId()}/benefit/preview`,
      reception,
      cart([line(item.espresso)], benefitOf(codes.som)),
    );
    expect(previewed.status, previewed.raw).toBe(200);
    expect(previewed.body.benefit.freeItemsSatang).toBe(6_000);
    const shown = previewed.body.benefit.totalReliefSatang;

    // Another till takes the last coffee.
    const other = await commit(cart([line(item.espresso)], benefitOf(codes.som), {}, t2.id));
    expect(other.status, other.raw).toBe(200);
    expect((await counter(people.som, 'free:coffee'))[0]!.qtyUsed).toBe(2);

    const saleId = newId();
    const late = await commit(cart([line(item.espresso)], benefitOf(codes.som, { expectedReliefSatang: shown })), saleId);
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({ code: 'BENEFIT_QUOTA_EXHAUSTED' });
    expect(late.body.error!.message).toMatch(/^Som \(Reception\)'s free items or staff credit were used at another till/);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);
    expect((await counter(people.som, 'free:coffee'))[0]!.qtyUsed).toBe(2);
    const again = await call<{ benefit: Breakdown }>(
      'POST',
      `/sales/${newId()}/benefit/preview`,
      reception,
      cart([line(item.espresso)], benefitOf(codes.som)),
    );
    expect(again.body.benefit).toMatchObject({ freeItemsSatang: 0, discountSatang: 1_800 });
  });

  it('a QR revoked between the preview and the commit: refused, no sale, no application, no claim', async () => {
    await resetUsage(people.nok);
    const ok = await call<{ benefit: Breakdown }>(
      'POST',
      `/sales/${newId()}/benefit/preview`,
      reception,
      cart([line(item.espresso)], benefitOf(codes.nok)),
    );
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.body.benefit.totalReliefSatang).toBeGreaterThan(0);
    const revoked = await call('POST', `/benefits/credentials/${credentialIds.nok}/revoke`, admin, {});
    expect(revoked.status, revoked.raw).toBe(200);
    const saleId = newId();
    const c = await commit(
      cart([line(item.espresso)], benefitOf(codes.nok, { expectedReliefSatang: ok.body.benefit.totalReliefSatang })),
      saleId,
    );
    expect(c.status).toBe(409);
    expect(c.body.error!.code).toBe('BENEFIT_REVOKED');
    expect(c.raw).not.toContain(signatureOf(codes.nok).slice(0, 16));
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);
    expect(await applicationsOf(saleId)).toEqual([]);
    expect(await usageOf(people.nok)).toEqual([]);
  });
});

// --- (2) H1, driven for real ---------------------------------------------------

describe('(2) H1 — the claim decides, under a real wait', () => {
  it('the last coffee: the second till’s claim waits on the first’s row, then is refused; one row at the quota', async () => {
    await resetUsage(people.som);
    await seedUsage(people.som, 'free:coffee', 'daily', 1, 0);
    const { ids, a, b } = await raceTwoTills(codes.som, () => [line(item.espresso)]);
    expect(a.status, String((a as PromiseRejectedResult).reason)).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toMatchObject({ code: 'BENEFIT_QUOTA_EXHAUSTED' });
    const rows = await counter(people.som, 'free:coffee');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qtyUsed).toBe(2);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, ids.b))).toEqual([]);
    expect(await applicationsOf(ids.b)).toEqual([]);
    expect(await applicationsOf(ids.a)).toHaveLength(1);
  });

  it('the first coffees of the day: two inserts of the same counter meet on its unique key; one row, one refusal', async () => {
    await resetUsage(people.som);
    const { a, b } = await raceTwoTills(codes.som, () => [line(item.espresso, 2)]);
    expect(a.status, String((a as PromiseRejectedResult).reason)).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toMatchObject({ code: 'BENEFIT_QUOTA_EXHAUSTED' });
    const rows = await counter(people.som, 'free:coffee');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qtyUsed).toBe(2);
  });

  it('the last satang of credit: one till has it, the other is refused; one credit row at the limit', async () => {
    await resetUsage(people.lek);
    // ฿500 a month, of which ฿499.99 is used. A hot dog each: 1 satang of credit, then 30 %.
    await seedUsage(people.lek, 'credit', 'monthly', 0, 49_999);
    const effective = await effectiveBenefitOn(ctx.db, operatorId, people.lek, today);
    const shown = applyStaffBenefits(
      effective.profile,
      await usageState(people.lek, effective.profile),
      engineLines([{ productId: item.hotdog, quantity: 1 }]),
    );
    expect(shown.creditSatang).toBe(1);
    const { ids, a, b } = await raceTwoTills(codes.lek, () => [line(item.hotdog)]);
    expect(a.status, String((a as PromiseRejectedResult).reason)).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toMatchObject({ code: 'BENEFIT_QUOTA_EXHAUSTED' });
    const rows = await counter(people.lek, 'credit');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.creditUsedSatang)).toBe(50_000);
    const [won] = await applicationsOf(ids.a);
    expect(won).toMatchObject({ creditSatang: 1, totalReliefSatang: shown.totalReliefSatang });
  });

  it('a commit replayed across a restart claims once, under its key and under a new one', async () => {
    await resetUsage(people.som);
    const saleId = newId();
    const scan = benefitOf(codes.som);
    const body = { id: saleId, actionId: newId(), ...cart([line(item.espresso)], scan) };
    const key = idem();
    const first = await call<{ benefit: Breakdown }>('POST', '/sales', reception, body, { 'idempotency-key': key });
    expect(first.status, first.raw).toBe(200);
    await ctx.restart();
    reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const sameKey = await call<{ benefit: Breakdown }>('POST', '/sales', reception, body, { 'idempotency-key': key });
    expect(sameKey.status, sameKey.raw).toBe(200);
    const newKey = await call<{ benefit: Breakdown; replay: boolean }>('POST', '/sales', reception, body);
    expect(newKey.status, newKey.raw).toBe(200);
    expect(newKey.body.replay).toBe(true);
    expect(newKey.body.benefit).toMatchObject({ applicationId: scan.applicationId, freeItemsSatang: 6_000 });
    // And straight through the service, as a box's re-queued event would reach it.
    await ctx.db.transaction((tx) => commitSale(tx, serviceActor(), body as never));
    expect((await counter(people.som, 'free:coffee'))[0]!.qtyUsed).toBe(1);
    const apps = await applicationsOf(saleId);
    expect(apps).toHaveLength(1);
    expect(await auditOf('benefit.apply', [apps[0]!.id])).toHaveLength(1);
    expect((await call('DELETE', `/sales/${saleId}/benefit`, reception)).status).toBe(200);
  });

  it('the same scan committed under two sale ids at the same instant: one live application and one claim', async () => {
    await resetUsage(people.som);
    const scan = benefitOf(codes.som);
    const [x, y] = await Promise.all([
      commit(cart([line(item.espresso)], scan, {}, t1.id)),
      commit(cart([line(item.espresso)], scan, {}, t2.id)),
    ]);
    // Either the second moved the first's claim (both 200), or both met at the
    // live-id index and one was refused — never two claims.
    const statuses = [x.status, y.status].sort();
    expect([[200, 200], [200, 409]]).toContainEqual(statuses);
    for (const r of [x, y]) if (r.status === 409) expect(r.body.error!.code).toBe('BENEFIT_QUOTA_EXHAUSTED');
    expect(await liveByClient(scan.applicationId)).toHaveLength(1);
    expect((await counter(people.som, 'free:coffee'))[0]!.qtyUsed).toBe(1);
  });

  it('removal gives the quota back exactly once, however often it is asked and whatever races it', async () => {
    await resetUsage(people.som);
    // One coffee on a CLOSED sale stays used; one on an open sale is to be given back.
    const closedId = newId();
    expect((await commit(cart([line(item.espresso)], benefitOf(codes.som)), closedId)).status).toBe(200);
    const paid = await call('POST', `/sales/${closedId}/finalise`, reception, {});
    expect(paid.status, paid.raw).toBe(200);
    const openId = newId();
    expect((await commit(cart([line(item.espresso)], benefitOf(codes.som)), openId)).status).toBe(200);
    expect((await counter(people.som, 'free:coffee'))[0]!.qtyUsed).toBe(2);
    const [app] = await applicationsOf(openId);

    const answers = await Promise.all([
      call('DELETE', `/sales/${openId}/benefit`, reception),
      call('DELETE', `/sales/${openId}/benefit`, reception),
      call('POST', `/sales/${openId}/void`, reception, { reason: 'Cancelled at the till' }),
      call('DELETE', `/sales/${openId}/benefit`, reception),
    ]);
    for (const a of answers) expect(a.status, a.raw).toBe(200);
    expect((await counter(people.som, 'free:coffee'))[0]!.qtyUsed).toBe(1);
    expect(await auditOf('benefit.remove', [app!.id])).toHaveLength(1);
    // The closed sale's benefit stays used.
    const closedOff = await call('DELETE', `/sales/${closedId}/benefit`, reception);
    expect(closedOff.status).toBe(409);
    expect((await counter(people.som, 'free:coffee'))[0]!.qtyUsed).toBe(1);
  });
});

// --- The tender guard -------------------------------------------------------------

/**
 * REJECT 1 — THE TENDER GUARD IS MISSING ON THE CARD AND QR ROADS.
 *
 * `assertSaleBenefitsLive` runs only in `finaliseSale`, so cash (and a cash
 * part payment) on a sale whose benefit was taken off — `DELETE
 * /sales/:id/benefit`, or moved to the order rung up again — is refused
 * `BENEFIT_APPLICATION_RELEASED`, as the builder's report says. But the roads
 * that record card or QR money before the close do not ask: a keyed-in card
 * (`recordManualTender`) is RECORDED as approved money (probed: 200, one
 * approved attempt), the terminal tender goes on to the box (probed:
 * BOX_UNCLAIMED here, i.e. past where the voucher guard stands), and a QR is
 * opened. The sale then can never close: every finalise is refused RELEASED.
 * Unlike the voucher's stranded state, which the voucher suite can reach only
 * by a correction made in psql, this one is reached through the api itself.
 *
 * The codebase's rule is S2-10b's tender guard (`assertSaleVouchersHeld`, and
 * `assertSaleExtensionCollectable` beside it) "at the start of every road
 * money takes onto a sale": gateway.ts `openQrAttempt` (~l.571) and
 * terminal.ts (~l.570, ~l.1430). The fix is `assertSaleBenefitsLive` beside
 * those calls. This case pins the required behaviour and fails until then.
 */
describe('REJECT 1 — a sale whose benefit was taken off takes money by no road', () => {
  /** A rung-up sale whose benefit is no longer its own: taken off, or moved to the order rung up again. */
  async function stranded(how: 'removed' | 'moved'): Promise<string> {
    await resetUsage(people.som);
    const saleId = newId();
    const scan = benefitOf(codes.som);
    const rung = await commit(cart([line(item.espresso), line(item.hotdog)], scan), saleId);
    expect(rung.status, rung.raw).toBe(200);
    if (how === 'removed') {
      const off = await call<{ removed: boolean }>('DELETE', `/sales/${saleId}/benefit`, reception);
      expect(off.body.removed).toBe(true);
    } else {
      const again = await commit(cart([line(item.espresso), line(item.hotdog), line(item.water)], scan));
      expect(again.status, again.raw).toBe(200);
      expect((await applicationsOf(saleId))[0]!.removedReason).toBe('moved');
    }
    return saleId;
  }
  type Road = { status: number; body: Envelope };
  const roads: Record<string, (saleId: string) => Promise<Road>> = {
    cash: (saleId) => call('POST', `/sales/${saleId}/finalise`, reception, { method: 'cash' }),
    'part payment': (saleId) =>
      call('POST', `/sales/${saleId}/finalise`, reception, { method: 'cash', amountSatang: 1_000 }),
    'keyed-in card': (saleId) =>
      call('POST', '/payments/manual', reception, {
        saleId,
        approvalCode: '123456',
        tid: '12345678',
        last4: '4242',
        amountSatang: 1_000,
      }),
    terminal: (saleId) => call('POST', '/payments/attempts', reception, { saleId }),
    qr: async (saleId) => {
      const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
      return openQrAttempt(
        ctx.db,
        ctx.app.env,
        ctx.app.log,
        { operatorId, branchId, requestId: `review-${newId()}` },
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
          description: 'Benefit review',
        },
      ).then(
        () => ({ status: 200, body: {} }),
        (err: { statusCode?: number; code?: string }) => ({
          status: err.statusCode ?? 500,
          body: { error: { code: err.code ?? 'THROWN', message: '' } },
        }),
      );
    },
  };

  for (const road of Object.keys(roads)) {
    it(`${road}: refused BENEFIT_APPLICATION_RELEASED on a sale whose benefit was taken off, and no attempt is written`, async () => {
      const saleId = await stranded('removed');
      const res = await roads[road]!(saleId);
      expect(`${res.status} ${res.body.error?.code ?? ''}`).toBe('409 BENEFIT_APPLICATION_RELEASED');
      expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toEqual([]);
    });
  }

  it('keyed-in card: refused on a sale whose benefit was moved to the order rung up again', async () => {
    const saleId = await stranded('moved');
    const res = await roads['keyed-in card']!(saleId);
    expect(`${res.status} ${res.body.error?.code ?? ''}`).toBe('409 BENEFIT_APPLICATION_RELEASED');
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toEqual([]);
  });
});

// --- (4) offline, end to end through the sync push --------------------------------

describe('(4) a box sale with a benefit, pushed through sync', () => {
  function record(over: Partial<OfflineBenefitRecord> & Pick<OfflineBenefitRecord, 'employeeId' | 'credentialId' | 'name' | 'benefitRole'>): OfflineBenefitRecord {
    return {
      applicationId: newId(),
      day: today,
      isComp: false,
      compedSatang: 0,
      discountSatang: 0,
      totalReliefSatang: 0,
      onlineOnly: [],
      standingDiscount: null,
      engineVersion: PRICING_ENGINE_VERSION,
      ...over,
    };
  }
  const somPercent = (items: { productId: string; quantity: number }[], over: Partial<OfflineBenefitRecord> = {}) => {
    const result = applyStaffBenefits(
      { standingDiscount: { percent: 30, target: { kind: 'fnb' } } },
      { freeItemsUsed: {}, creditUsedSatang: 0 },
      engineLines(items),
    );
    return record({
      employeeId: people.som,
      credentialId: credentialIds.som,
      name: 'Som (Reception)',
      benefitRole: 'staff',
      discountSatang: result.discountSatang,
      totalReliefSatang: result.totalReliefSatang,
      onlineOnly: ['freeItems'],
      standingDiscount: { percent: 30, target: { kind: 'fnb' } },
      ...over,
    });
  };
  const saleFact = (b: TestBox, saleId: string, items: Line[], benefit: OfflineBenefitRecord, total: number, engineVersion?: string) => ({
    saleId,
    ...(engineVersion ? { engineVersion } : {}),
    cart: { channel: 'fnb', pickupCode: String(pickup++), items, expectedTotalSatang: total, benefit },
    tenders:
      total > 0
        ? [{ actionId: `press-${newId()}`, methodCode: 'cash', kind: 'cash', amountSatang: total, tenderedSatang: total, changeSatang: 0 }]
        : [],
    receipt: { series: b.prefix, seq: b.nextSeq, number: `${b.prefix}-${String(b.nextSeq).padStart(6, '0')}` },
  });
  const sold = (b: TestBox, saleId: string, items: Line[], benefit: OfflineBenefitRecord, total: number, engineVersion?: string) =>
    mint(b, 'sale.finalised', saleFact(b, saleId, items, benefit, total, engineVersion));

  it('a standing percent replays as a box application, claims nothing, names the box, and a re-push changes nothing', async () => {
    await resetUsage(people.som);
    const b = await freshBox();
    const items = [line(item.espresso, 2)];
    const rec = somPercent(items);
    expect(rec.discountSatang).toBe(3_600);
    const saleId = newId();
    const fact = saleFact(b, saleId, items, rec, 12_000 - 3_600);
    const event = mint(b, 'sale.finalised', fact);
    const answer = await push(b, [event]);
    expect(answer.applied, JSON.stringify(answer.results)).toBe(1);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row).toMatchObject({ status: 'finalised', grossSatang: 8_400, origin: 'box', boxId: b.boxId });
    const apps = await applicationsOf(saleId);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      origin: 'box',
      boxId: b.boxId,
      stationId: b.stationId,
      clientId: rec.applicationId,
      discountSatang: 3_600,
      usageDeltas: [],
    });
    expect(await usageOf(people.som)).toEqual([]);
    const [applied] = await auditOf('benefit.apply', [apps[0]!.id]);
    expect(applied!.after).toMatchObject({ boxId: b.boxId, stationId: b.stationId, origin: 'box' });
    // The same event again, and the same fact re-queued under a new event id
    // (a box that lost its acknowledgements): one sale, one application.
    expect((await push(b, [event])).duplicates).toBe(1);
    const again = await push(b, [mint(b, 'sale.finalised', fact)]);
    expect(again.quarantined, JSON.stringify(again.results)).toBe(0);
    expect(await applicationsOf(saleId)).toHaveLength(1);
    expect(await auditOf('benefit.apply', [apps[0]!.id])).toHaveLength(1);
  });

  it('an owner’s comp replays to ฿0 with a sensitive comp row naming the box', async () => {
    const b = await freshBox();
    const items = [line(item.espresso), line(item.hotdog)];
    const total = price.espresso + price.hotdog;
    const rec = record({
      employeeId: people.anan,
      credentialId: credentialIds.anan,
      name: 'Khun Anan (Owner)',
      benefitRole: 'owner',
      isComp: true,
      compedSatang: total,
      totalReliefSatang: total,
    });
    const saleId = newId();
    const answer = await push(b, [sold(b, saleId, items, rec, 0)]);
    expect(answer.applied, JSON.stringify(answer.results)).toBe(1);
    const [app] = await applicationsOf(saleId);
    expect(app).toMatchObject({ origin: 'box', isComp: true, compedSatang: total, boxId: b.boxId });
    const [comp] = await auditOf('benefit.comp', [app!.id]);
    expect(comp!.after).toMatchObject({ sensitive: true, boxId: b.boxId, stationId: b.stationId });
  });

  it('a record from an older engine is quarantined, not repriced: no sale, no application', async () => {
    const b = await freshBox();
    const items = [line(item.espresso, 2)];
    const rec = somPercent(items, { engineVersion: LEGACY_SATANG_ENGINE_VERSION });
    const saleId = newId();
    const answer = await push(b, [sold(b, saleId, items, rec, 8_400)]);
    expect(answer.quarantined, JSON.stringify(answer.results)).toBe(1);
    expect(answer.results[0]!.errorCode).toBe('BENEFIT_OFFLINE_ENGINE_UNSUPPORTED');
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);
    expect(await applicationsOf(saleId)).toEqual([]);
    const [held] = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, b.boxId), eq(syncQuarantine.status, 'open')));
    expect(held!.errorCode).toBe('BENEFIT_OFFLINE_ENGINE_UNSUPPORTED');
  });

  it('a record that smuggles a free coffee or credit past the box is quarantined as drift: nothing used, nothing filed', async () => {
    await resetUsage(people.som);
    const b = await freshBox();
    const items = [line(item.espresso, 2)];
    // The percent the box may apply is ฿36; a "free coffee" makes it ฿60 + 30 % of ฿60.
    const rec = somPercent(items, { discountSatang: 6_000 + 1_800, totalReliefSatang: 6_000 + 1_800, onlineOnly: [] });
    const saleId = newId();
    const answer = await push(b, [sold(b, saleId, items, rec, 12_000 - 7_800)]);
    expect(answer.quarantined, JSON.stringify(answer.results)).toBe(1);
    expect(answer.results[0]!.errorCode).toBe('BENEFIT_OFFLINE_DRIFT');
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);
    expect(await usageOf(people.som)).toEqual([]);
    // Lek has credit; a box record of a comp for him is not his to have.
    const lekComp = record({
      employeeId: people.lek,
      credentialId: credentialIds.lek,
      name: 'Khun Lek (Manager)',
      benefitRole: 'manager',
      isComp: true,
      compedSatang: 12_000,
      totalReliefSatang: 12_000,
    });
    const second = await push(b, [sold(b, newId(), [line(item.espresso, 2)], lekComp, 0)]);
    expect(second.results[0]!.errorCode).toBe('BENEFIT_OFFLINE_DRIFT');
  });
});

// --- (6) the audit rows, and the QR stays out of every table ----------------------

describe('(6) audit rows name the station and the box; no table holds a benefit QR', () => {
  it('apply, comp and remove each carry the station and Till 1’s box', async () => {
    await resetUsage(people.som);
    const somSale = newId();
    expect((await commit(cart([line(item.espresso)], benefitOf(codes.som)), somSale)).status).toBe(200);
    const ananSale = newId();
    expect((await commit(cart([line(item.water)], benefitOf(codes.anan)), ananSale)).status).toBe(200);
    expect((await call('DELETE', `/sales/${somSale}/benefit`, reception)).status).toBe(200);
    const [somApp] = await applicationsOf(somSale);
    const [ananApp] = await applicationsOf(ananSale);
    const where = { stationId: t1.id, boxId: t1.boxId };
    expect((await auditOf('benefit.apply', [somApp!.id]))[0]!.after).toMatchObject(where);
    expect((await auditOf('benefit.remove', [somApp!.id]))[0]!.after).toMatchObject(where);
    expect((await auditOf('benefit.comp', [ananApp!.id]))[0]!.after).toMatchObject({ ...where, sensitive: true });
    expect(somApp!.boxId).toBe(t1.boxId);
  });

  it('no audit row says OTO-BEN, and no table anywhere holds any issued QR’s signature', async () => {
    const audited = await ctx.db.execute(
      sql`select count(*)::int as n from ${auditLog} a where a::text ilike '%OTO-BEN%'`,
    );
    expect(Number((audited.rows[0] as { n: number }).n)).toBe(0);
    const tables = await ctx.db.execute(
      sql`select table_schema, table_name from information_schema.tables
           where table_type = 'BASE TABLE'
             and table_schema not in ('pg_catalog', 'information_schema', 'drizzle')`,
    );
    expect(tables.rows.length).toBeGreaterThan(50);
    const signatures = issued.map((code) => `%${signatureOf(code).slice(0, 24)}%`);
    expect(signatures).toHaveLength(4);
    const holders: string[] = [];
    for (const t of tables.rows as { table_schema: string; table_name: string }[]) {
      const found = await ctx.db.execute(
        sql`select count(*)::int as n from ${sql.identifier(t.table_schema)}.${sql.identifier(t.table_name)} x
             where x::text like any (${sql.raw(`array[${signatures.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')}]`)})`,
      );
      if (Number((found.rows[0] as { n: number }).n) > 0) holders.push(`${t.table_schema}.${t.table_name}`);
    }
    expect(holders).toEqual([]);
  });
});

// --- (7) resolve's echo, and the commit's -----------------------------------------

describe('(7) a refused QR is echoed short of its signature, and nothing keeps it', () => {
  it('resolve: a lower-case header, a header twice, a line break in front', async () => {
    const code = codes.lek;
    const sig = signatureOf(code).slice(0, 16);
    for (const sent of [`x${code.toLowerCase()}`, `OTO-BEN: ${code}`, `\n\r${code}`, `${code}\u200b`]) {
      const key = idem();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/benefits/resolve',
        headers: { cookie: reception, 'idempotency-key': key },
        payload: { code: sent },
      });
      // A line break in front is trimmed and the QR resolves; the rest are refused.
      expect([200, 404, 409], JSON.stringify(sent).slice(0, 16)).toContain(res.statusCode);
      expect(res.body.toLowerCase()).not.toContain(sig.toLowerCase());
      expect(await ctx.db.select().from(idempotencyKey).where(eq(idempotencyKey.key, key))).toEqual([]);
    }
  });

  it('the commit and the quote refuse a prefixed QR without its signature, and keep no copy of it', async () => {
    const code = codes.lek;
    const sig = signatureOf(code).slice(0, 16);
    const key = idem();
    const saleId = newId();
    const c = await commit(cart([line(item.espresso)], benefitOf(`]Q1${code}`)), saleId, reception, {
      'idempotency-key': key,
    });
    expect(c.status).toBe(404);
    expect(c.raw).not.toContain(sig);
    const stored = await ctx.db.select().from(idempotencyKey).where(eq(idempotencyKey.key, key));
    expect(JSON.stringify(stored)).not.toContain(sig);
    const q = await quote(cart([line(item.espresso)], benefitOf(`QR: ${code}`)));
    expect(q.status).toBe(404);
    expect(q.raw).not.toContain(sig);
  });
});

// --- Who may read the Audit log ----------------------------------------------------

describe('the Staff Benefits Audit log route (pulled forward from round 4)', () => {
  it('reads every recorded application of the operator, newest first, for the back office', async () => {
    const own = await call<{ applications: { branchId: string; origin: string }[] }>('GET', '/benefits/applications', admin);
    expect(own.status).toBe(200);
    expect(own.body.applications.some((a) => a.branchId === branchId)).toBe(true);
    // Box applications filed by the sync push are entries too.
    expect(own.body.applications.some((a) => a.origin === 'box')).toBe(true);
  });

  /**
   * NOT BLOCKING, for round 4 (which owns the Audit log). Probed in review: a
   * manager whose `branch_manager` grant is scoped to Robinson Chalong reads
   * Central Floresta's applications — receipt numbers, stations, boxes and the
   * amounts — because `listBenefitApplications` filters by operator only and
   * the route names no branch target. The templates and the staff list are
   * operator-wide configuration; these rows are one branch's sales.
   */
  it.todo('a manager scoped to another park does not read this park’s benefit applications');
  it('(the probe behind the todo above) a Chalong-scoped manager is answered with Central Floresta rows today', async () => {
    const chalong = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const res = await call<{ applications: { branchId: string }[] }>('GET', '/benefits/applications', chalong);
    expect(res.status).toBe(200);
    expect(res.body.applications.some((a) => a.branchId === branchId)).toBe(true);
  });
});
