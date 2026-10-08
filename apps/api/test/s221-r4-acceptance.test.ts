import { generateKeyPairSync } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  benefitApplication,
  benefitCredential,
  benefitRoleTemplate,
  benefitUsage,
  branch,
  employee,
  product,
  productCategory,
  sale,
  signingKey,
  station,
  wallet,
  walletEntry,
} from '@oto/db';
import { benefitQrKeyOf, benefitSeedFutureFrom, seed } from '@oto/db/seed';
import {
  addDaysToIsoDate,
  BENEFIT_QR_NOT_A_SIGN_IN,
  businessDate,
  newId,
  normalizePhone,
  parseDayStart,
  type BenefitReport,
  type DiscountTransactions,
} from '@oto/shared';
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
import { runDailyRollupJob } from '../src/services/analytics-rollup';

/**
 * S2-21 (SCRUM-218) round 4 — THE ACCEPTANCE, DRIVEN (docs/progress/plans/
 * benefits/PLAN.md §8 round 4: "All 7 checks ... Check 1 says 'seeded' until
 * the mirror exists"), on the seed round 4 writes, at the owner questions'
 * defaults:
 *
 *   check 1  Admin > Staff Benefits: the three templates and the four
 *            employees — here, on a database with no OTO App, READ FROM THE
 *            SEEDED `core.employee` ROWS, source `platform` (the dev seed's).
 *            On the OTO App mirror (S2-17b round 2) the same four are read
 *            from `otoapp_v.employees` through `otoapp:employee.sync`,
 *            adopted with their ids, profiles and Nok's override intact —
 *            driven by the closing audit (s221-r4-closing-audit.test.ts).
 *            The panel cannot create or edit an employee; Nok's override
 *            reads 4 coffees beside the Staff template's 2.
 *   check 2  the Manager credit edited to ฿600 (Q2's default; the ticket's
 *            ฿6,000) from tomorrow leaves today's Manager checkout at ฿500,
 *            keeps both versions, and is audited — `benefit.template_update`,
 *            the action a template edit writes (the ticket says
 *            profile_update, which is a person's).
 *   check 3  Khun Anan's QR comps an order to ฿0 for reception (Q3's default:
 *            no comp permission, the sensitive audit row is the control), the
 *            Activity row names the beneficiary, the processor, the sale and
 *            the amount; a revoked QR is refused "Benefit revoked".
 *   check 4  Khun Lek's QR on a mixed order: two coffees, the credit, 30 % off
 *            the rest; the third coffee the same day finds the quota used and
 *            still gets the 30 %.
 *   check 5  no wallet moves; Discounts & Comps carries the prototype's one
 *            "Staff benefit" row per order (Q10's default) and the benefits
 *            report splits it four ways; a refund keeps the quota used (Q4's
 *            default) and shows what was refunded.
 *   check 6  the cloud's half here — a benefit QR is no sign-in; the box's
 *            half (offline comp and percent, "online only", the gate reader)
 *            is driven by the box suite and the round 3 sync tests, which the
 *            closing audit names (s221-r4-closing-audit.test.ts).
 *   check 7  two tills at the last coffee: one success, one
 *            BENEFIT_QUOTA_EXHAUSTED, one usage row.
 *
 * And the seed's own round 4 promises: the four QRs, issued under the
 * deployment's key and printable and scannable through the api, one Manager
 * edit dated in the future, and a re-run that writes nothing.
 */

const keys = generateKeyPairSync('ed25519');
const PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let ctx: TestContext;
let admin: string;
let reception: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let today = '';
const item = { espresso: '', water: '', hotdog: '' };
const people = { anan: '', som: '', nok: '', lek: '' };
const codes = { anan: '', som: '', nok: '', lek: '' };
const credentialIds = { anan: '', som: '', nok: '', lek: '' };

let n = 0;
const idem = () => `s221-r4-acceptance-${process.pid}-${Date.now()}-${n++}`;

interface Envelope {
  error?: { code: string; message: string };
}
async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string | null,
  payload?: unknown,
): Promise<{ status: number; body: T & Envelope; raw: string; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) },
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
let pickup = 10;
const cart = (items: ReturnType<typeof line>[], code?: string, expectedReliefSatang?: number) => ({
  stationId,
  channel: 'fnb',
  pickupCode: String(pickup++),
  items,
  ...(code
    ? { benefit: { applicationId: newId(), code, ...(expectedReliefSatang !== undefined ? { expectedReliefSatang } : {}) } }
    : {}),
});
interface Breakdown {
  name: string;
  isComp: boolean;
  compedSatang: number;
  freeItemsSatang: number;
  creditSatang: number;
  discountSatang: number;
  totalReliefSatang: number;
}
const quote = (body: Record<string, unknown>) =>
  call<{ benefit: Breakdown | null; totals: { grossSatang: number } }>('POST', '/sales/quote', reception, body);
const commit = (body: Record<string, unknown>, id: string = newId()) =>
  call<{ sale: { id: string; totals: { grossSatang: number } }; benefit: Breakdown | null }>('POST', '/sales', reception, {
    id,
    actionId: newId(),
    ...body,
  });
const finalise = (saleId: string, gross: number) =>
  call('POST', `/sales/${saleId}/finalise`, reception, gross > 0 ? { method: 'cash', amountSatang: gross } : {});

beforeAll(async () => {
  ctx = await createTestContext({ env: { BENEFIT_QR_PRIVATE_KEY: PRIVATE_KEY } });
  // The test context seeds with no key, as CI does; the demo deployment's
  // seed runs with its key, which is this run.
  await seed(ctx.db, { benefitQrPrivateKey: PRIVATE_KEY });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  const tills = await ctx.db.select().from(station).where(eq(station.operatorId, operatorId));
  const t1 = tills.find((s) => s.kind === 'till' && s.codePrefix === 'T1')!;
  stationId = t1.id;
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
    name: 'Espresso (r4 acceptance)',
    code: 'FB-ESPRESSO-R4A',
    priceSatang: 6_000,
    categoryId: coffee!.id,
  });
  const menu = await ctx.db.select().from(product).where(eq(product.operatorId, operatorId));
  item.water = menu.find((p) => p.code === 'FB-WATER')!.id;
  item.hotdog = menu.find((p) => p.code === 'FB-HOTDOG')!.id;

  const staff = await ctx.db.select({ id: employee.id, name: employee.name }).from(employee).where(eq(employee.operatorId, operatorId));
  const byName = (name: string) => staff.find((r) => r.name === name)!.id;
  people.anan = byName('Khun Anan (Owner)');
  people.som = byName('Som (Reception)');
  people.nok = byName('Nok (Reception)');
  people.lek = byName('Khun Lek (Manager)');
  // The QRs the seed issued, printed as the Staff Benefits dialog prints them.
  for (const who of ['anan', 'som', 'nok', 'lek'] as const) {
    const listed = await call<{ credentials: Array<{ id: string; status: string }> }>(
      'GET',
      `/benefits/credentials?employeeId=${people[who]}`,
      admin,
    );
    expect(listed.body.credentials, who).toHaveLength(1);
    credentialIds[who] = listed.body.credentials[0]!.id;
    const printed = await call<{ code: string }>('GET', `/benefits/credentials/${credentialIds[who]}/qr`, admin);
    expect(printed.status, printed.raw).toBe(200);
    codes[who] = printed.body.code;
  }
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// --- The seed (round 4) -----------------------------------------------------------------------

describe('the seed: the four QRs, one Manager edit dated in the future, convergent on re-run', () => {
  it('issued each of the four one QR under the deployment’s key, by the demo administrator, and published the key', async () => {
    const key = benefitQrKeyOf(PRIVATE_KEY);
    const rows = await ctx.db
      .select()
      .from(benefitCredential)
      .where(inArray(benefitCredential.employeeId, Object.values(people)));
    expect(rows).toHaveLength(4);
    const [adminAccount] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, normalizePhone(ADMIN.phone)!));
    for (const row of rows) {
      expect(row).toMatchObject({ kid: key.kid, version: 1, revokedAt: null, issuedByAccountId: adminAccount!.id, operatorId });
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 300 * 86_400_000);
    }
    const [published] = await ctx.db
      .select()
      .from(signingKey)
      .where(and(eq(signingKey.purpose, 'benefit_qr'), eq(signingKey.kid, key.kid)));
    expect(published).toMatchObject({ algorithm: 'ed25519', active: true });
  });

  it('a seeded QR is the api’s own: printed and resolved through the routes, to its person', async () => {
    for (const who of ['anan', 'som', 'nok', 'lek'] as const) {
      const res = await call<{ employeeId: string; credentialId: string }>('POST', '/benefits/resolve', reception, {
        code: codes[who],
      });
      expect(res.status, `${who} ${res.raw}`).toBe(200);
      expect(res.body).toMatchObject({ employeeId: people[who], credentialId: credentialIds[who] });
    }
  });

  it('wrote the Manager’s ฿600 credit from the first of the month after next, beside today’s ฿500', async () => {
    const res = await call<{ templates: Array<{ role: string; current: { profile: { credit?: { amountSatang: number } } }; upcoming: Array<{ effectiveFrom: string; profile: { credit?: { amountSatang: number } } }> }> }>(
      'GET',
      '/benefits/templates',
      admin,
    );
    const manager = res.body.templates.find((t) => t.role === 'manager')!;
    expect(manager.current.profile.credit?.amountSatang).toBe(50_000);
    expect(manager.upcoming.map((v) => [v.effectiveFrom, v.profile.credit?.amountSatang])).toEqual([
      [benefitSeedFutureFrom(today), 60_000],
    ]);
    expect(benefitSeedFutureFrom('2026-10-07')).toBe('2026-12-01');
    expect(benefitSeedFutureFrom('2026-11-30')).toBe('2027-01-01');
    expect(benefitSeedFutureFrom('2026-12-31')).toBe('2027-02-01');
  });

  it('a re-run, with or without the key, writes nothing: no QR, no template version', async () => {
    const credentials = await ctx.db.select().from(benefitCredential);
    const templates = await ctx.db.select().from(benefitRoleTemplate);
    await seed(ctx.db, { benefitQrPrivateKey: PRIVATE_KEY });
    await seed(ctx.db);
    const sorted = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(sorted(await ctx.db.select().from(benefitCredential))).toEqual(sorted(credentials));
    expect(sorted(await ctx.db.select().from(benefitRoleTemplate))).toEqual(sorted(templates));
  }, 240_000);
});

// --- Check 1 — "seeded" --------------------------------------------------------------------------

describe('check 1 — the templates and the four employees, read from the SEEDED core.employee rows', () => {
  interface Staff {
    employeeId: string;
    name: string;
    source: string;
    current: { benefitRole: string | null; override: { freeItems?: Array<{ quotaPerPeriod: number }> } | null } | null;
    effectiveProfile: { freeItems?: Array<{ quotaPerPeriod: number }> };
  }

  it('lists the three templates and the four employees, every one a seeded platform row where no OTO App copies them', async () => {
    const t = await call<{ templates: Array<{ role: string; name: string }> }>('GET', '/benefits/templates', admin);
    expect(t.body.templates.map((x) => [x.role, x.name])).toEqual([
      ['owner', 'Owner'],
      ['manager', 'Manager'],
      ['staff', 'Staff'],
    ]);
    const s = await call<{ staff: Staff[] }>('GET', '/benefits/profiles', admin);
    expect(s.status).toBe(200);
    const roster = s.body.staff.filter((p) => Object.values(people).includes(p.employeeId));
    expect(roster.map((p) => [p.name, p.current?.benefitRole]).sort()).toEqual(
      [
        ['Khun Anan (Owner)', 'owner'],
        ['Khun Lek (Manager)', 'manager'],
        ['Nok (Reception)', 'staff'],
        ['Som (Reception)', 'staff'],
      ].sort(),
    );
    // "Seeded": every staff member is a platform row. This database has no
    // OTO App, so the copy (S2-17b round 2) has nobody to write as `otoapp`.
    expect(s.body.staff.every((p) => p.source === 'platform')).toBe(true);
    expect(await ctx.db.select().from(employee).where(eq(employee.source, 'otoapp'))).toEqual([]);
  });

  it('Nok’s card reads 4 coffees from her override while the Staff template still reads 2', async () => {
    const s = await call<{ staff: Staff[] }>('GET', '/benefits/profiles', admin);
    const nok = s.body.staff.find((p) => p.employeeId === people.nok)!;
    expect(nok.current!.override!.freeItems![0]!.quotaPerPeriod).toBe(4);
    expect(nok.effectiveProfile.freeItems![0]!.quotaPerPeriod).toBe(4);
    const staffTemplate = await call<{ template: { current: { profile: { freeItems: Array<{ quotaPerPeriod: number }> } } } }>(
      'GET',
      '/benefits/templates/staff',
      admin,
    );
    expect(staffTemplate.body.template.current.profile.freeItems[0]!.quotaPerPeriod).toBe(2);
  });

  it('the panel cannot create or edit an employee: no route writes one, and a name sent with a benefit is not a rename', async () => {
    const writes = ctx.app.routeRegistry
      .filter((r) => r.url.startsWith('/benefits') && !['GET', 'HEAD'].includes(r.method))
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(writes).toEqual(
      [
        'PUT /benefits/templates/:role',
        'PUT /benefits/profiles/:employeeId',
        'POST /benefits/credentials',
        'POST /benefits/credentials/:credentialId/revoke',
        'POST /benefits/resolve',
      ].sort(),
    );
    expect((await call('POST', '/benefits/profiles', admin, { name: 'New person' })).status).toBe(404);
    expect((await call('PATCH', `/benefits/profiles/${people.som}`, admin, { name: 'Renamed' })).status).toBe(404);
    const res = await call('PUT', `/benefits/profiles/${people.som}`, admin, {
      benefitRole: 'staff',
      override: null,
      name: 'Renamed',
    });
    expect([200, 400]).toContain(res.status);
    const [som] = await ctx.db.select().from(employee).where(eq(employee.id, people.som));
    expect(som!.name).toBe('Som (Reception)');
  });
});

// --- Checks 2 and 4 — the Manager ------------------------------------------------------------------

describe('checks 2 and 4 — the Manager’s ฿600 from tomorrow, and today’s mixed order at ฿500', () => {
  let lekSaleId = '';
  let walletBefore = 0;
  const walletTotal = async () =>
    (await ctx.db.select({ b: wallet.balanceSatang }).from(wallet)).reduce((sum, w) => sum + w.b, 0);

  beforeAll(async () => {
    walletBefore = await walletTotal();
  });

  it('check 2: the edit dated tomorrow keeps today’s ฿500, keeps both versions, and is audited', async () => {
    const tomorrow = addDaysToIsoDate(today, 1);
    const before = await call<{ templates: Array<{ role: string; current: { id: string; profile: Record<string, unknown> } }> }>(
      'GET',
      '/benefits/templates',
      admin,
    );
    const manager = before.body.templates.find((t) => t.role === 'manager')!;
    const res = await call<{ changed: boolean; template: { current: { id: string }; upcoming: Array<{ id: string; effectiveFrom: string }> } }>(
      'PUT',
      '/benefits/templates/manager',
      admin,
      { profile: { ...manager.current.profile, credit: { amountSatang: 60_000, period: 'monthly' } }, effectiveFrom: tomorrow },
    );
    expect(res.status, res.raw).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.template.current.id).toBe(manager.current.id);
    expect(res.body.template.upcoming[0]!.effectiveFrom).toBe(tomorrow);
    const history = await call<{ versions: Array<{ id: string }> }>('GET', '/benefits/templates/manager', admin);
    expect(history.body.versions.map((v) => v.id)).toEqual(expect.arrayContaining([manager.current.id, res.body.template.upcoming[0]!.id]));
    const audited = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'benefit.template_update'), eq(auditLog.entityId, res.body.template.upcoming[0]!.id)));
    expect(audited).toHaveLength(1);
  });

  it('check 4 (and check 2’s checkout): two coffees, the ฿500 credit, then 30 % off the rest, to the satang', async () => {
    // 3 espressos and 5 hot dogs, ฿730: 2 coffees ฿120, credit ฿500, 30 % of ฿110.
    const lines = [line(item.espresso, 3), line(item.hotdog, 5)];
    const q = await quote(cart(lines, codes.lek));
    expect(q.body.benefit).toMatchObject({ freeItemsSatang: 12_000, creditSatang: 50_000, discountSatang: 3_300, totalReliefSatang: 65_300 });
    lekSaleId = newId();
    const c = await commit(cart(lines, codes.lek, 65_300), lekSaleId);
    expect(c.status, c.raw).toBe(200);
    // The till's breakdown and the receipt's total agree to the satang.
    expect(c.body.benefit).toMatchObject({ freeItemsSatang: 12_000, creditSatang: 50_000, discountSatang: 3_300 });
    expect(c.body.sale.totals.grossSatang).toBe(73_000 - 65_300);
    expect((await finalise(lekSaleId, 7_700)).status).toBe(200);
  });

  it('check 4: the third coffee the same day finds the quota used and still gets the 30 %', async () => {
    const q = await quote(cart([line(item.espresso)], codes.lek));
    expect(q.body.benefit).toMatchObject({ freeItemsSatang: 0, creditSatang: 0, discountSatang: 1_800 });
  });

  // --- Check 5, on Khun Lek's order -------------------------------------------------------------

  it('check 5: no wallet moved; Discounts & Comps has the one "Staff benefit" row; the report splits it four ways', async () => {
    // No wallet entry names the benefited sale, and no wallet holds a satang
    // more or less than before it (the round's full H9 is benefits-r4's).
    expect(await ctx.db.select().from(walletEntry).where(inArray(walletEntry.saleId, [lekSaleId]))).toEqual([]);
    expect(await walletTotal()).toBe(walletBefore);
    await runDailyRollupJob(ctx.db, new Date());
    const discounts = await call<DiscountTransactions>(
      'GET',
      `/analytics/reports/discounts/transactions?branches=${branchId}&from=${today}&to=${today}`,
      admin,
    );
    const rows = discounts.body.rows.filter((r) => r.note === 'Scanned: Khun Lek (Manager) (manager)');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'Staff benefit', type: 'fixed', amountSatang: 65_300 });
    const split = await call<BenefitReport>(
      'GET',
      `/analytics/reports/benefits?branches=${branchId}&from=${today}&to=${today}&employeeId=${people.lek}`,
      admin,
    );
    expect(split.body.totals).toMatchObject({ freeItemsSatang: 12_000, creditSatang: 50_000, discountSatang: 3_300, compedSatang: 0 });
  });

  it('check 5: a refund of the order keeps the coffees and the credit used, and says what was refunded', async () => {
    const usageBefore = await ctx.db.select().from(benefitUsage).where(eq(benefitUsage.employeeId, people.lek));
    const refund = await call('POST', `/sales/${lekSaleId}/refunds`, admin, { mode: 'whole', reason: 'Wrong order', actionId: newId() });
    expect(refund.status, refund.raw).toBe(200);
    const usageAfter = await ctx.db.select().from(benefitUsage).where(eq(benefitUsage.employeeId, people.lek));
    expect(usageAfter.map((u) => [u.itemKey, u.qtyUsed, u.creditUsedSatang]).sort()).toEqual(
      usageBefore.map((u) => [u.itemKey, u.qtyUsed, u.creditUsedSatang]).sort(),
    );
    const log = await call<{ applications: Array<{ saleId: string; saleStatus: string; refundedSatang: number }> }>(
      'GET',
      '/benefits/applications',
      admin,
    );
    expect(log.body.applications.find((a) => a.saleId === lekSaleId)).toMatchObject({ saleStatus: 'refunded', refundedSatang: 7_700 });
  });
});

// --- Check 3 — the owner's comp ---------------------------------------------------------------------

describe('check 3 — Khun Anan’s comp, the Activity row, and a revoked QR', () => {
  it('comps the order to ฿0 for reception; the Activity log’s benefit.comp row names the beneficiary, processor, sale and amount', async () => {
    const saleId = newId();
    const c = await commit(cart([line(item.water, 2), line(item.hotdog, 1)], codes.anan), saleId);
    expect(c.status, c.raw).toBe(200);
    expect(c.body.sale.totals.grossSatang).toBe(0);
    expect(c.body.benefit).toMatchObject({ name: 'Khun Anan (Owner)', isComp: true, compedSatang: 16_000 });
    expect((await finalise(saleId, 0)).status).toBe(200);
    // The Activity screen reads the audit route: the sensitive comp row.
    const activity = await call<{ entries: Array<{ action: string; entityType: string; after: Record<string, unknown> }> }>(
      'GET',
      '/audit?action=benefit.comp',
      admin,
    );
    expect(activity.status).toBe(200);
    const row = activity.body.entries.find((e) => e.after.saleId === saleId)!;
    const [receptionAccount] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
    expect(row).toMatchObject({ entityType: 'benefit_application' });
    expect(row.after).toMatchObject({
      sensitive: true,
      employeeId: people.anan,
      processedByAccountId: receptionAccount!.id,
      saleId,
      compedSatang: 16_000,
      stationId,
    });
    // The application row is the Audit log's entry for it.
    const [app] = await ctx.db.select().from(benefitApplication).where(eq(benefitApplication.saleId, saleId));
    expect(app).toMatchObject({ isComp: true, compedSatang: 16_000, employeeId: people.anan });
  });

  it('a revoked QR is refused "Benefit revoked" and changes nothing', async () => {
    const revoked = await call('POST', `/benefits/credentials/${credentialIds.nok}/revoke`, admin, {});
    expect(revoked.status).toBe(200);
    const saleId = newId();
    const c = await commit(cart([line(item.espresso)], codes.nok), saleId);
    expect(c.status).toBe(409);
    expect(c.body.error!.message).toMatch(/^Benefit revoked/);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);
    expect(await ctx.db.select().from(benefitUsage).where(eq(benefitUsage.employeeId, people.nok))).toEqual([]);
  });
});

// --- Check 6 — the cloud's half ---------------------------------------------------------------------

describe('check 6 (the cloud’s half) — a benefit QR opens no session', () => {
  it('sign-in refuses a seeded QR in the phone field: no cookie, no attempt on anybody', async () => {
    const res = await call('POST', '/auth/sign-in', null, { phone: codes.anan, password: 'anything' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'BENEFIT_NOT_A_SIGN_IN', message: BENEFIT_QR_NOT_A_SIGN_IN });
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

// --- Check 7 — two tills, the last coffee -------------------------------------------------------------

describe('check 7 — two tills claiming Som’s last coffee at the same instant', () => {
  it('one success, one BENEFIT_QUOTA_EXHAUSTED and exactly one usage row', async () => {
    const first = await commit(cart([line(item.espresso)], codes.som));
    expect(first.status, first.raw).toBe(200);
    const ids = [newId(), newId()];
    const [a, b] = await Promise.all(ids.map((id) => commit(cart([line(item.espresso)], codes.som, 6_000), id)));
    expect([a!.status, b!.status].sort()).toEqual([200, 409]);
    const loser = a!.status === 409 ? a! : b!;
    expect(loser.body.error!.code).toBe('BENEFIT_QUOTA_EXHAUSTED');
    const rows = await ctx.db
      .select()
      .from(benefitUsage)
      .where(and(eq(benefitUsage.employeeId, people.som), eq(benefitUsage.itemKey, 'free:coffee')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qtyUsed).toBe(2);
  });
});
