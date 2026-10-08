import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeBenefitCredential } from '@oto/box-agent';
import { account, employee, opsRun } from '@oto/db';
import { benefitQrKeyOf } from '@oto/db/seed';
import { newId } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { loadEnv } from '../src/env';
import { publishBenefitQrKey } from '../src/services/benefit-credentials';
import { buildDefaultJobs, createJobRunner } from '../src/services/jobs';
import {
  OTOAPP_EMPLOYEE_SYNC_JOB,
  OTOAPP_EMPLOYEE_SYNC_RUN,
} from '../src/services/otoapp-employee-sync';

/**
 * S2-21 (SCRUM-218) round 4 — THE CLOSING AUDIT (docs/progress/plans/
 * benefits/PLAN.md §8 round 4, §11).
 *
 *   - every hazard of the plan (§11, H1-H18) is named to tests that exist and
 *     are not todos — the suites themselves are what proves them passing;
 *   - every acceptance check (1-7) is named to the tests that drive it;
 *   - every benefits route is guarded — the admin and till routes by a named
 *     permission, the reports per branch in the handler;
 *   - what remains open is said as a todo below, not left to be found.
 *
 * The POS half — no benefit screen left on a mock path — is
 * apps/pos/test/s221-r4-closing-audit.test.ts.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const FILES = {
  r1: 'apps/api/test/benefits-r1.test.ts',
  r2: 'apps/api/test/benefits-r2.test.ts',
  r3: 'apps/api/test/benefits-r3.test.ts',
  r4: 'apps/api/test/benefits-r4.test.ts',
  acceptance: 'apps/api/test/s221-r4-acceptance.test.ts',
  closing: 'apps/api/test/s221-r4-closing-audit.test.ts',
  r1Review: 'apps/api/test/s221-r1-review.test.ts',
  r3Review: 'apps/api/test/s221-r3-review.test.ts',
  r3Recheck: 'apps/api/test/s221-r3-review-recheck.test.ts',
  boxCredential: 'packages/box-agent/test/benefit-credential.test.ts',
  boxOffline: 'packages/box-agent/test/s221-r3-offline-benefit.test.ts',
  boxBooth: 'packages/box-agent/test/booth.test.ts',
  boxGate: 'packages/box-agent/test/gate-host.test.ts',
  sharedCheckout: 'packages/shared/test/s221-r3-benefit-checkout.test.ts',
  posCheckout: 'apps/pos/test/s221-r3-checkout.test.ts',
  posWords: 'apps/pos/test/s221-r3-review-words.test.ts',
  posClosing: 'apps/pos/test/s221-r4-closing-audit.test.ts',
} as const;
type Suite = keyof typeof FILES;
type Named = [Suite, string];

/** The plan's §11 hazards, each to the tests that hold it. */
const HAZARDS: Record<string, Named[]> = {
  H1: [
    ['r3', 'gives one success, one BENEFIT_QUOTA_EXHAUSTED and one usage row at the quota'],
    ['r3Review', 'the last coffee: the second till’s claim waits on the first’s row, then is refused; one row at the quota'],
    ['r3Review', 'the last satang of credit: one till has it, the other is refused; one credit row at the limit'],
  ],
  H2: [
    ['r3', 'a failure after the claim, in the same transaction, leaves no claim behind'],
    ['r3', 'a void gives the quota back'],
    ['r3Review', 'removal gives the quota back exactly once, however often it is asked and whatever races it'],
  ],
  H3: [
    ['r3', 'a tampered body moves nothing: a till total that disagrees is refused, and nothing is claimed (H3)'],
    ['r3Review', 'a doctored benefit body is ignored: quote, preview and commit give the engine’s four amounts on the same cart, profile and usage'],
  ],
  H4: [
    ['r1', 'saves ฿600 from tomorrow; today stays ฿500'],
    ['acceptance', 'check 2: the edit dated tomorrow keeps today’s ฿500, keeps both versions, and is audited'],
  ],
  H5: [
    ['r1', 'keeps both versions: the seeded row closed on tomorrow, its profile untouched'],
    ['r1Review', '40 random template saves: the database is the model on every day, history intact, audited'],
  ],
  H6: [
    ['boxCredential', 'H6: altered, invented, wrongly keyed, expired and too-new QRs are each refused for what they are'],
    ['r2', 'refuses what this park did not issue in the prototype’s words'],
  ],
  H7: [
    ['boxCredential', 'H7: revoked, left, unknown and not-configured are refused — "Benefit revoked" in the revocation’s own words'],
    ['r2', 'the cloud refuses it from the moment it is revoked; the box from its next pull'],
  ],
  H8: [
    ['r2', 'sign-in: a QR read into the phone field opens no session and is no attempt on anybody'],
    ['r2', 'the till’s badge path: refused before the box sees it — no tape line, nothing handed to a screen'],
    ['boxBooth', 'a staff benefit QR at the badge path is refused as not a badge, signs nobody in and is never counted (S2-21 round 2, H8)'],
    ['boxGate', 'a staff benefit QR at the gate reader is not a band: "scan your wristband", nothing opens, nothing is journalled (S2-21 round 2, H8)'],
    ['boxCredential', 'H8: the gate’s decision refuses a benefit QR as not a band, in either direction'],
  ],
  H9: [['r4', 'H9 — no wallet moves: no wallet entry is written and no balance changes']],
  H10: [['r4', 'H10 — the relief is never revenue nor a tender: the day’s F&B revenue moves by what the guests paid']],
  H11: [
    ['boxOffline', 's221-r3 — offline, free items and credit alone apply nothing and record nothing: “online only”'],
    ['boxOffline', 's221-r3 — offline, the standing percent applies and the free coffee is online only, nothing used'],
    ['r3Review', 'a record that smuggles a free coffee or credit past the box is quarantined as drift: nothing used, nothing filed'],
  ],
  H12: [
    ['r3', 'refuses a record whose figures the platform’s own profile does not give (H12)'],
    ['r3Review', 'a record from an older engine is quarantined, not repriced: no sale, no application'],
  ],
  H13: [
    ['r4', 'the keys follow the branch’s trading day, never the calendar midnight (Q6’s default: the sale’s business date)'],
    ['r4', 'the period keys a sale claims are its own trading day’s'],
    ['boxCredential', 'the agent checks a benefit QR against the scope in its own store, on its branch’s trading day'],
  ],
  H14: [
    ['r3', 'the row’s money sits on the lines it relieved (H14)'],
    ['sharedCheckout', 'where the row’s money sits (H14)'],
  ],
  H15: [
    ['r3', 'after the order’s own manual discount the cascade caps the benefit, and the row records the cap (H15)'],
    ['r3Review', 'H15 with a promo too: a manual discount that leaves less than the relief caps the row, and the application stores the cap'],
  ],
  H16: [
    ['posCheckout', 'finds the imports it is looking for, and none of them is a benefit'],
    ['posClosing', 'no benefit screen imports a benefit function from the mock API or the mock catalogue'],
    ['r3', 'a "Staff benefit" row sent by a till is refused at the quote and the commit (H16)'],
    ['r3Recheck', '"Staff" and "benefit" joined by U+3164 or U+2800 instead of a space are refused BENEFIT_DISCOUNT_UNLINKED'],
  ],
  H17: [
    ['r2', 'a person who has left is refused, and their QR joins the box’s list'],
    ['closing', 'a QR signed with this deployment’s key for somebody the platform does not have is refused, and nothing is written'],
    // S2-17b round 2: the other half, once the mirror exists.
    ['closing', 'H17’s other half: a scan for an employee not yet copied raises ops_run kind integration under otoapp:employee.sync'],
  ],
  H18: [
    ['r1', 'never has two versions in force on one day (H18)'],
    ['r1Review', 'ten simultaneous template saves: every one lands, one version per day, one open end'],
  ],
};

/**
 * The ticket's seven acceptance checks, each to the tests that drive it (Q
 * defaults). Check 1 on the OTO App mirror from S2-17b round 2, beside the
 * seeded-row test, which stays for the dev seed.
 */
const CHECKS: Record<string, Named[]> = {
  'check 1': [
    ['closing', 'check 1 on the OTO App mirror: the four employees read from otoapp_v.employees through otoapp:employee.sync'],
    ['acceptance', 'lists the three templates and the four employees, every one a seeded platform row where no OTO App copies them'],
    ['acceptance', 'Nok’s card reads 4 coffees from her override while the Staff template still reads 2'],
    ['acceptance', 'the panel cannot create or edit an employee: no route writes one, and a name sent with a benefit is not a rename'],
  ],
  'check 2': [
    ['acceptance', 'check 2: the edit dated tomorrow keeps today’s ฿500, keeps both versions, and is audited'],
    ['acceptance', 'check 4 (and check 2’s checkout): two coffees, the ฿500 credit, then 30 % off the rest, to the satang'],
    ['r1', 'audits benefit.template_update with what was in force and what replaces it'],
  ],
  'check 3': [
    ['acceptance', 'comps the order to ฿0 for reception; the Activity log’s benefit.comp row names the beneficiary, processor, sale and amount'],
    ['acceptance', 'a revoked QR is refused "Benefit revoked" and changes nothing'],
    ['r3', 'comps the F&B order to ฿0 for reception, with a sensitive `benefit.comp` row'],
  ],
  'check 4': [
    ['acceptance', 'check 4 (and check 2’s checkout): two coffees, the ฿500 credit, then 30 % off the rest, to the satang'],
    ['acceptance', 'check 4: the third coffee the same day finds the quota used and still gets the 30 %'],
    ['posCheckout', 'the order station builds its payload from its own discounts, the benefit row drawn only for the screen'],
    ['posWords', 'online, the four rows in the engine’s order, under the prototype’s labels, only where they relieved'],
  ],
  'check 5': [
    ['acceptance', 'check 5: no wallet moved; Discounts & Comps has the one "Staff benefit" row; the report splits it four ways'],
    ['acceptance', 'check 5: a refund of the order keeps the coffees and the credit used, and says what was refunded'],
    ['r4', 'GET /analytics/reports/benefits splits the relief four ways, per role, per beneficiary and per day'],
    ['r4', 'the sale is refunded; the coffees stay used, and the application is neither removed nor reversed'],
  ],
  'check 6': [
    ['acceptance', 'sign-in refuses a seeded QR in the phone field: no cookie, no attempt on anybody'],
    ['boxOffline', 's221-r3 — offline, an owner’s comp takes the order to ฿0 and closes with no tender'],
    ['boxOffline', 's221-r3 — offline, the standing percent applies and the free coffee is online only, nothing used'],
    ['r3Review', 'a standing percent replays as a box application, claims nothing, names the box, and a re-push changes nothing'],
    ['r3Review', 'an owner’s comp replays to ฿0 with a sensitive comp row naming the box'],
    ['boxGate', 'a staff benefit QR at the gate reader is not a band: "scan your wristband", nothing opens, nothing is journalled (S2-21 round 2, H8)'],
  ],
  'check 7': [
    ['acceptance', 'one success, one BENEFIT_QUOTA_EXHAUSTED and exactly one usage row'],
    ['r3', 'gives one success, one BENEFIT_QUOTA_EXHAUSTED and one usage row at the quota'],
  ],
};

const texts = new Map<Suite, string>();
const textOf = (suite: Suite): string => {
  if (!texts.has(suite)) texts.set(suite, readFileSync(join(ROOT, FILES[suite]), 'utf8'));
  return texts.get(suite)!;
};

/** Is `title` the title of a test (or suite) in this source that is not a todo, a skip or an only? */
function liveTitleIn(text: string, title: string): boolean {
  for (const quote of ["'", '"', '`']) {
    let at = text.indexOf(`${quote}${title}${quote}`);
    while (at >= 0) {
      const head = text.slice(Math.max(0, at - 24), at);
      if (/(^|[^.\w])(it|test|describe)\(\s*$/.test(head)) return true;
      at = text.indexOf(`${quote}${title}${quote}`, at + 1);
    }
  }
  return false;
}
const isLiveTest = (suite: Suite, title: string): boolean => liveTitleIn(textOf(suite), title);

describe('the closing audit — every hazard and every check named to a live test', () => {
  it('names all eighteen hazards of the plan', () => {
    expect(Object.keys(HAZARDS)).toEqual(Array.from({ length: 18 }, (_, i) => `H${i + 1}`));
  });

  for (const [hazard, named] of Object.entries(HAZARDS)) {
    it(`${hazard} is held by tests that exist and are not todos`, () => {
      for (const [suite, title] of named) expect(isLiveTest(suite, title), `${FILES[suite]}: ${title}`).toBe(true);
    });
  }

  it('names all seven acceptance checks', () => {
    expect(Object.keys(CHECKS)).toEqual(Array.from({ length: 7 }, (_, i) => `check ${i + 1}`));
  });

  for (const [check, named] of Object.entries(CHECKS)) {
    it(`${check} is driven by tests that exist and are not todos`, () => {
      for (const [suite, title] of named) expect(isLiveTest(suite, title), `${FILES[suite]}: ${title}`).toBe(true);
    });
  }

  it('the audit can tell a todo, a skip or a mere mention from a test', () => {
    const source = [
      "it.todo('a pending thing');",
      "it.skip('a skipped thing', () => {});",
      "const words = 'a mentioned thing';",
      "it('a real thing', () => {});",
      "test(\"a node test\", () => {});",
    ].join('\n');
    expect(liveTitleIn(source, 'a pending thing')).toBe(false);
    expect(liveTitleIn(source, 'a skipped thing')).toBe(false);
    expect(liveTitleIn(source, 'a mentioned thing')).toBe(false);
    expect(liveTitleIn(source, 'a real thing')).toBe(true);
    expect(liveTitleIn(source, 'a node test')).toBe(true);
  });
});

// --- The routes, and H17's cloud half ----------------------------------------------------------

const keys = generateKeyPairSync('ed25519');
const PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
let ctx: TestContext;

beforeAll(async () => {
  // With the OTO App's schema (S2-17b round 2): check 1 is driven on the
  // mirror here, from the app's own tables through `otoapp_v.employees`.
  ctx = await createTestContext({ otoapp: true, env: { BENEFIT_QR_PRIVATE_KEY: PRIVATE_KEY } });
}, 240_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('the closing audit — every benefits route is guarded', () => {
  it('each /benefits route and each sale’s benefit route names its permission; the reports decide per branch', () => {
    const routes = ctx.app.routeRegistry
      .filter((r) => r.method !== 'HEAD' && /\/benefits?\b|\/benefit\//.test(r.url))
      .map((r) => ({
        route: `${r.method} ${r.url}`,
        guard:
          r.config.permission ??
          (r.config.dynamicPermission
            ? 'per branch, in the handler'
            : r.config.credential
              ? 'a device credential'
              : r.config.auth === 'session'
                ? 'a session'
                : 'UNGUARDED'),
      }))
      .sort((a, b) => a.route.localeCompare(b.route));
    // Thirteen under /benefits (rounds 1-3), the sale's preview and removal
    // (round 3) and the two reports (round 4).
    expect(routes).toHaveLength(17);
    expect(routes.filter((r) => r.guard === 'UNGUARDED')).toEqual([]);
    const byRoute = Object.fromEntries(routes.map((r) => [r.route, r.guard]));
    expect(byRoute).toMatchObject({
      'GET /benefits/applications': 'admin:benefit:read',
      'PUT /benefits/templates/:role': 'admin:benefit:manage',
      'PUT /benefits/profiles/:employeeId': 'admin:benefit:manage',
      'POST /benefits/credentials': 'admin:benefit:credential_issue',
      'POST /benefits/resolve': 'pos:benefit:apply',
      'GET /analytics/reports/benefits': 'per branch, in the handler',
      'GET /analytics/reports/benefits/transactions': 'per branch, in the handler',
    });
    // The till's own: the preview and the removal on a sale.
    expect(routes.some((r) => r.route === 'POST /sales/:id/benefit/preview' && r.guard !== 'UNGUARDED')).toBe(true);
    expect(routes.some((r) => r.route === 'DELETE /sales/:id/benefit' && r.guard !== 'UNGUARDED')).toBe(true);
  });

  it('nobody signed in reaches any of them', async () => {
    for (const url of ['/benefits/templates', '/benefits/applications', '/analytics/reports/benefits?from=2026-10-01&to=2026-10-07']) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });
});

describe('H17 (the cloud’s half) — somebody the platform does not have', () => {
  it('a QR signed with this deployment’s key for somebody the platform does not have is refused, and nothing is written', async () => {
    await publishBenefitQrKey(ctx.db, ctx.app.env);
    const key = benefitQrKeyOf(PRIVATE_KEY);
    const code = encodeBenefitCredential(
      { employeeId: newId(), credentialId: newId(), exp: Math.floor(Date.now() / 1000) + 3_600 },
      { kid: key.kid, privateKeyPem: key.privateKeyPem },
    );
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/benefits/resolve',
      headers: { cookie: reception, 'idempotency-key': `closing-${newId()}` },
      payload: { code },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/^No staff benefit found for "/);
  });
});

/**
 * S2-17b round 2 — THE MIRROR, the two todos this audit carried until it
 * existed (benefits plan §0, §5; lift PLAN section 5 "The swap"). No benefits
 * query changed: the panel lists the operator's `core.employee` rows with
 * their `source`, and the copy fills them.
 */
describe('check 1 and H17 on the OTO App mirror (S2-17b round 2)', () => {
  const run = async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://oto:oto@localhost:1/unused',
      PROCESS_ROLES: 'api,jobs',
    });
    const job = buildDefaultJobs({ db: ctx.db, env, log: ctx.app.log, channels: [] }).find(
      (j) => j.name === OTOAPP_EMPLOYEE_SYNC_JOB,
    )!;
    const runner = createJobRunner({ db: ctx.db, env, log: ctx.app.log, channels: [], jobs: [job] });
    expect(await runner.runJob(OTOAPP_EMPLOYEE_SYNC_JOB, { force: true })).toBe('ok');
    const [last] = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, OTOAPP_EMPLOYEE_SYNC_JOB), eq(opsRun.outcome, 'ok')))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    return last!.detail as Record<string, number>;
  };

  it('check 1 on the OTO App mirror: the four employees read from otoapp_v.employees through otoapp:employee.sync', async () => {
    const operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
    const central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
    const byName = async (name: string) =>
      (
        await ctx.db
          .select({ id: employee.id })
          .from(employee)
          .where(and(eq(employee.operatorId, operatorId), eq(employee.name, name)))
      )[0]!.id;
    const seeded = {
      anan: await byName('Khun Anan (Owner)'),
      som: await byName('Som (Reception)'),
      nok: await byName('Nok (Reception)'),
      lek: await byName('Khun Lek (Manager)'),
    };
    const accountOf = async (phone: string) =>
      (await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, phone)))[0]!.id;
    // Nok has no account in the dev seed; on staging hers is provisioned like
    // the others'. Made here pointing at her seeded row.
    const nokAccount = newId();
    await ctx.db.insert(account).values({
      id: nokAccount,
      operatorId,
      employeeId: seeded.nok,
      phone: '+66900000003',
      status: 'active',
    });
    const accounts = {
      anan: await accountOf('+66900000001'),
      som: await accountOf('+66900000002'),
      nok: nokAccount,
      lek: await accountOf('+66900000004'),
    };

    // The park group in the OTO App, holding Central Floresta.
    const tenantId = newId();
    const appCentral = newId();
    await ctx.db.execute(
      sql`insert into otoapp.tenants (id, name, slug) values (${tenantId}, 'ZZ closing audit park group', 'zz-closing-audit')`,
    );
    await ctx.db.execute(
      sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id) values (${appCentral}, ${tenantId}, 'Central Floresta', '', ${central})`,
    );
    // The four, created as employees in the OTO App, their logins provisioned
    // with the same emails: three linked by the employee's own login, Nok by
    // the app's email match alone.
    const appIds: Record<keyof typeof seeded, string> = { anan: '', som: '', nok: '', lek: '' };
    const names = { anan: 'Khun Anan', som: 'Som', nok: 'Nok', lek: 'Khun Lek' };
    for (const who of ['anan', 'som', 'nok', 'lek'] as const) {
      const userId = newId();
      const email = `zz-closing-${who}@otopark.test`;
      await ctx.db.execute(
        sql`insert into otoapp.users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
            values (${userId}, ${email}, 'x', ${names[who]}, 'staff', true, false, ${accounts[who]})`,
      );
      appIds[who] = newId();
      await ctx.db.execute(
        sql`insert into otoapp.employees (id, tenant_id, branch_id, full_name, nickname, email, user_id)
            values (${appIds[who]}, ${tenantId}, ${appCentral}, ${names[who]}, ${names[who]}, ${email}, ${who === 'nok' ? null : userId})`,
      );
    }

    const first = await run();
    expect(first).toMatchObject({ installed: true, adopted: 4, created: 0, archived: 0 });

    // The four rows were adopted: the same ids, now the OTO App's.
    const rows = await ctx.db
      .select()
      .from(employee)
      .where(inArray(employee.id, Object.values(seeded)));
    expect(rows).toHaveLength(4);
    for (const who of ['anan', 'som', 'nok', 'lek'] as const) {
      const row = rows.find((r) => r.id === seeded[who])!;
      expect(row, who).toMatchObject({ source: 'otoapp', externalId: appIds[who], archivedAt: null });
    }
    expect(
      await ctx.db.select({ id: employee.id }).from(employee).where(eq(employee.source, 'otoapp')),
    ).toHaveLength(4);

    // The panel reads them, with their source, and Nok's override is still hers.
    const admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const res = await ctx.app.inject({ method: 'GET', url: '/benefits/profiles', headers: { cookie: admin } });
    expect(res.statusCode, res.body).toBe(200);
    const staff = (res.json() as {
      staff: Array<{
        employeeId: string;
        name: string;
        source: string;
        current: { benefitRole: string | null; override: { freeItems?: Array<{ quotaPerPeriod: number }> } | null } | null;
      }>;
    }).staff;
    const four = staff.filter((p) => Object.values(seeded).includes(p.employeeId));
    expect(four.map((p) => [p.name, p.source, p.current?.benefitRole]).sort()).toEqual(
      [
        ['Khun Anan', 'otoapp', 'owner'],
        ['Khun Lek', 'otoapp', 'manager'],
        ['Nok', 'otoapp', 'staff'],
        ['Som', 'otoapp', 'staff'],
      ].sort(),
    );
    const nok = four.find((p) => p.employeeId === seeded.nok)!;
    expect(nok.current!.override!.freeItems![0]!.quotaPerPeriod).toBe(4);

    // A second run with nothing changed in the app changes nothing.
    const second = await run();
    expect(second).toMatchObject({ adopted: 0, created: 0, updated: 0, archived: 0, restored: 0, accountsLinked: 0 });
  });

  it('H17’s other half: a scan for an employee not yet copied raises ops_run kind integration under otoapp:employee.sync', async () => {
    await publishBenefitQrKey(ctx.db, ctx.app.env);
    const key = benefitQrKeyOf(PRIVATE_KEY);
    const nobody = newId();
    const code = encodeBenefitCredential(
      { employeeId: nobody, credentialId: newId(), exp: Math.floor(Date.now() / 1000) + 3_600 },
      { kid: key.kid, privateKeyPem: key.privateKeyPem },
    );
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/benefits/resolve',
      headers: { cookie: reception, 'idempotency-key': `closing-${newId()}` },
      payload: { code },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/^No staff benefit found for "/);
    const raised = await ctx.db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.kind, 'integration'), eq(opsRun.name, OTOAPP_EMPLOYEE_SYNC_RUN)));
    const mine = raised.filter((r) => (r.detail as { employeeId?: string } | null)?.employeeId === nobody);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      outcome: 'failed',
      errorCode: 'OTOAPP_EMPLOYEE_UNKNOWN',
      operatorId: await operatorIdByName(ctx.db, OTO_OPERATOR_NAME),
    });
  });
});

describe('what remains open, named', () => {
  /**
   * H13's box half as the plan words it — a skewed box clock refused under
   * low clock trust — is not driven: a box claims no quota offline, so it keys
   * no period; the trading day it priced on is the record's `day`, re-checked
   * against the platform's profile on replay (H12).
   */
  it.todo('H13 with a skewed box clock: an offline benefit priced under low clock trust is refused');
  /**
   * H7's alert half: a box's revocation list is as old as its last
   * `benefits` pull; a box that stops calling home is raised (fleet health),
   * and a pull that lands incomplete is `box.cache_incomplete`, but no
   * expectation measures the revocation-to-pull lag on its own.
   */
  it.todo('H7’s lag: the time between a revocation and every box’s next pull alerted on by an ops expectation');
  /**
   * `benefit.comp` is written sensitive (`after.sensitive`) and reads on the
   * Activity log by its action, but the Console's "Admin log" preset filters
   * by a category the audit rows do not carry yet — the platform-wide audit
   * classification work — so the preset cannot select it on its own.
   */
  it.todo('benefit.comp on the Activity “Admin log” preset, once audit rows carry a category');
  /**
   * The owner's questions stay at the prototype's defaults (plan §10): Q1
   * whole-profile override, Q2 ฿500 / 30 % / 2 coffees, Q3 no comp permission,
   * Q4 a refund keeps the quota used, Q5 F&B only, Q6 the sale's business
   * date, Q7 no badge sign-in, Q8 whole baht, Q9 your own QR allowed, Q10 the
   * prototype's rows on Discounts & Comps, Q11 the benefit after the order's
   * own manual discounts, Q12 the staff name on the guest's refusal; and the
   * Cyrillic lookalike in a "Staff benefit" reason.
   */
  it.todo('the owner’s answers to Q1-Q12 and the lookalike-letter reason, each applied where it differs from its default');
});
