import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTERNAL_LINES } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { ASSISTANT_TOOLS, newId } from '@oto/shared';
import { identityOf, otoAppEnvelope, sessionCookieOf } from '../src/services/assistant/call-otoapp';
import { matchesRoute } from '../src/services/assistant/call-platform';
import { otoAppToolsOffered, resolveLinks } from '../src/services/assistant/engine';
import { clockOf, dayWords, daysInclusive, hoursBetween, monthWords, periodSentence, weekdayWords } from '../src/services/assistant/tools';
import { OTOAPP_TOOLS, OTOAPP_TOOL_ADAPTERS, nameKey, nameMatches } from '../src/services/assistant/tools-otoapp';
import { resolveEffectivePermissions } from '../src/services/permissions';
import {
  ASK_SENTINEL,
  NO_ASK_LEAKS,
  ask,
  askLeaks,
  askWorld,
  final,
  grantOtoAppTile,
  script,
  staff,
  tool,
  toolResultsSeen,
  toolRows,
  type AskWorld,
} from './assistant-support';
import {
  FakeOtoApp,
  OTOAPP_WORDS,
  fakeAttendanceThisMonth,
  fakeEmployee,
  fakeShifts,
  fakeUser,
  isoDay,
  seedFakeOtoAppWorld,
  type FakeOtoAppEmployee,
  type FakeOtoAppWorld,
} from './fake-otoapp';
import { teardownAll } from './helpers';

/**
 * SCRUM-591 — THE OTO APP TOOLS, round I4 (plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §B.3, §F.2, owner G1;
 * G2 open: nothing over the three fence gaps).
 *
 * The real platform api runs in process; a FAKE OTO App (`fake-otoapp.ts`)
 * listens on a loopback port and exchanges every hand-off at the REAL api
 * under test, so the jti is spent, the `auth.handoff_*` rows are real and a
 * revoked platform session is refused where the app would refuse it. The
 * proofs §F.2 asks for before the switch is turned on:
 *
 *   - `not_provisioned`, `disabled`, and a platform session revoked between
 *     the hand-off and the tool call each give the refusal line, never data;
 *   - the app session is logged out after the ask — a tool that throws
 *     included;
 *   - `auth.handoff_issue` carries the ask's request id;
 *   - the switch off: no `oto.*` tool offered, no hand-off minted;
 *   - the fences pass through verbatim; the sentinel holds; the cookie and
 *     the token reach no log and no row.
 */

const KID = 'k1';
const SECRET = 'assistant-otoapp-handoff-secret-0123456789abcdef';
const API_SRC = fileURLToPath(new URL('../src', import.meta.url));
const OTOAPP_SRC = fileURLToPath(new URL('../../oto-app/server', import.meta.url));

let fake: FakeOtoApp;
let w: AskWorld;
let world: FakeOtoAppWorld;
let manager: { accountId: string; sessionId: string; cookie: string };
let staffer: { accountId: string; sessionId: string; cookie: string };
let admin: { accountId: string; sessionId: string; cookie: string };
let nobody: { accountId: string; sessionId: string; cookie: string };
let disabled: { accountId: string; sessionId: string; cookie: string };
let elsewhere: { accountId: string; sessionId: string; cookie: string };
let anan: FakeOtoAppEmployee;
let chai: FakeOtoAppEmployee;
let beam: FakeOtoAppEmployee;
let krit: FakeOtoAppEmployee;
let sentinelPerson: FakeOtoAppEmployee;
let attendance: { days: number; hours: number };
const today = isoDay(new Date());
const firstOfMonth = `${today.slice(0, 7)}-01`;
const tomorrow = isoDay(new Date(), 1);

beforeAll(async () => {
  fake = await FakeOtoApp.start();
  w = await askWorld({
    env: {
      INTERNAL_AI_OTOAPP_TOOLS: 'true',
      HANDOFF_SIGNING_KEY: `${KID}:${SECRET}`,
      // The token's own audience origin is where the api posts it: no second setting names the app.
      HANDOFF_APP_ORIGINS: `oto_app=${fake.origin}`,
      // The fake exchanges with its own Origin, which the api's write check must allow.
      ALLOWED_ORIGINS: fake.origin,
    },
  });
  fake.platform = w.ctx.app;
  world = seedFakeOtoAppWorld(fake);

  const branch = { scopeType: 'branch' as const, scopeId: w.central };
  manager = await staff(w, 'ZZ Oto Manager', 'branch_manager', branch, w.central);
  staffer = await staff(w, 'ZZ Oto Staff', 'staff', branch, w.central);
  nobody = await staff(w, 'ZZ Oto Nobody', 'staff', branch, w.central);
  disabled = await staff(w, 'ZZ Oto Disabled', 'staff', branch, w.central);
  admin = await staff(w, 'ZZ Oto Admin', 'operator_admin', { scopeType: 'operator', scopeId: w.oto }, w.central);
  // The tile at Chalong only, seated at Central: the launcher refuses this seat.
  elsewhere = await staff(w, 'ZZ Oto Elsewhere', 'staff', branch, w.central);
  for (const a of [manager, staffer, nobody, disabled]) await grantOtoAppTile(w, a.accountId, w.central);
  await grantOtoAppTile(w, elsewhere.accountId, w.chalong);

  anan = fakeEmployee(fake, world, { fullName: 'ZZ Anan Fixture', nickname: 'Anan', branchId: world.central });
  chai = fakeEmployee(fake, world, { fullName: 'ZZ Chalong Person', nickname: 'Chai', branchId: world.chalong });
  beam = fakeEmployee(fake, world, { fullName: 'ZZ Oto Staff', nickname: 'Beam', branchId: world.central });
  krit = fakeEmployee(fake, world, { fullName: 'ZZ Oto Manager', nickname: 'Krit', branchId: world.central });
  sentinelPerson = fakeEmployee(fake, world, { fullName: 'ZZ Sentinel Person', nickname: `ZZ ${ASK_SENTINEL}`, branchId: world.central });
  fakeUser(fake, world, { platformAccountId: manager.accountId, role: 'manager', branchId: world.central, employeeId: krit.id });
  fakeUser(fake, world, { platformAccountId: staffer.accountId, role: 'staff', branchId: world.central, employeeId: beam.id });
  fakeUser(fake, world, { platformAccountId: disabled.accountId, role: 'staff', branchId: world.central, isActive: false });
  fakeUser(fake, world, { platformAccountId: admin.accountId, role: 'admin', branchId: null });
  attendance = fakeAttendanceThisMonth(fake, anan.id, new Date());
  fakeShifts(fake, world.central, [anan.id, beam.id, krit.id], new Date(Date.now() - 86_400_000), new Date(Date.now() + 2 * 86_400_000));
  fake.data.timeOff.push({
    id: newId(),
    tenantId: world.tenantId,
    employeeId: beam.id,
    branchId: world.central,
    type: 'annual',
    startDate: `${isoDay(new Date(), 20)}T00:00:00.000Z`,
    endDate: `${isoDay(new Date(), 22)}T00:00:00.000Z`,
    isHalfDay: false,
    halfDayPeriod: null,
    // A note is never projected: the sentinel here must stay in the fake.
    note: `ZZ note ${ASK_SENTINEL}`,
  });
  fake.data.payslips.set(beam.id, [
    { fileId: newId(), entityName: 'ZZ Payer Co', month: '2026-09', version: 1, status: 'paid', net: 28400, lockedAt: '2026-10-01T03:00:00.000Z' },
  ]);
  fake.data.payrollHistory.push({
    snapshotId: newId(),
    entityId: newId(),
    entityName: 'ZZ Payer Co',
    month: '2026-09',
    version: 1,
    status: 'paid',
    lockedAt: '2026-10-01T03:00:00.000Z',
    lockedBy: 'ZZ Owner',
    gmActor: 'ZZ GM',
    people: 12,
    totals: { gross: 480000, deductions: 36000, net: 444000, employer: 24000, totalCost: 504000 },
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await fake?.stop();
  await teardownAll();
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

async function handoffRows(action: string) {
  return w.ctx.db.select().from(s.auditLog).where(eq(s.auditLog.action, action));
}

/** The ask's own request id, as its opening audit row recorded it. */
async function askRequestId(askId: string): Promise<string> {
  const [row] = await w.ctx.db
    .select({ requestId: s.auditLog.requestId })
    .from(s.auditLog)
    .where(and(eq(s.auditLog.action, 'assistant.ask.open'), sql`${s.auditLog.after}->>'askId' = ${askId}`));
  if (!row?.requestId) throw new Error('the ask has no opening audit row');
  return row.requestId;
}

const attendanceCall = (employeeId: string) => tool('oto.attendance', { employeeId, startDate: firstOfMonth, endDate: today });

describe('the census (§B.3, R4)', () => {
  it('call-otoapp.ts is the only assistant file that reaches for fetch', () => {
    const dir = join(API_SRC, 'services', 'assistant');
    const fetching = sourceFiles(dir)
      .filter((f) => /\bfetch\s*\(|from 'undici'|require\('undici'\)/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(dir, f).replace(/\\/g, '/'));
    expect(fetching).toEqual(['call-otoapp.ts']);
  });

  it('call-otoapp.ts GETs the tools and POSTs only the exchange and the logout, both literals', () => {
    const src = readFileSync(join(API_SRC, 'services/assistant/call-otoapp.ts'), 'utf8');
    // Call sites (`method: 'X',`), not the request helper's type (`'GET' | 'POST'`).
    const methods = [...src.matchAll(/method:\s*'([A-Z]+)'\s*,/g)].map((m) => m[1]).sort();
    expect(methods).toEqual(['GET', 'GET', 'POST', 'POST']);
    expect(src).toContain("'/api/auth/handoff'");
    expect(src).toContain("'/api/logout'");
  });

  it('registers an adapter for exactly the seven OTO App tools, none over a fence gap (G2)', () => {
    const oto = ASSISTANT_TOOLS.filter((t) => t.system === 'oto_app').map((t) => t.name);
    expect(OTOAPP_TOOL_ADAPTERS.map((a) => a.name).sort()).toEqual([...oto].sort());
    expect(oto).toEqual([
      'oto.attendance',
      'oto.employee_leave',
      'oto.employees.find',
      'oto.my_leave',
      'oto.my_payslips',
      'oto.payroll_summary',
      'oto.rota',
    ]);
    // C1–C3: leave balances, clock events, today's checklists — no tool, by the owner's open G2.
    for (const a of OTOAPP_TOOL_ADAPTERS) {
      for (const r of a.routes) expect(r, a.name).not.toMatch(/time-events|checklists|balance/);
    }
  });

  it('builds every adapter URL inside its own route templates, from validated input only', () => {
    const who = { userId: 'u1', role: 'manager' as const, permissions: [], homeBranchId: 'b-central', allBranches: false };
    const samples: Record<string, unknown> = {
      'oto.attendance': { employeeId: 'e-1', startDate: '2026-10-01', endDate: '2026-10-20' },
      'oto.employee_leave': { employeeId: 'e-1', from: '2026-10-01' },
      'oto.employees.find': { name: 'Anan' },
      'oto.my_leave': {},
      'oto.my_payslips': {},
      'oto.payroll_summary': { month: '2026-09' },
      'oto.rota': { scope: 'branch', from: '2026-10-21', to: '2026-10-21' },
    };
    for (const a of OTOAPP_TOOL_ADAPTERS) {
      const input = a.input.parse(samples[a.name]);
      const urls = a.urls(input as never, who);
      expect(urls.length, a.name).toBe(a.routes.length);
      for (const url of urls) expect(a.routes.some((r) => matchesRoute(url, r)), `${a.name}: ${url}`).toBe(true);
    }
    expect(OTOAPP_TOOLS.get('oto.attendance')!.input.safeParse({ employeeId: '../user', startDate: '2026-10-01', endDate: '2026-10-20' }).success).toBe(false);
    expect(OTOAPP_TOOLS.get('oto.rota')!.input.safeParse({ scope: 'all', from: '2026-10-21', to: '2026-10-21' }).success).toBe(false);
  });

  it("the fake speaks the app's own sentences: every refusal it answers is in the app's source", () => {
    const files = [
      'middleware/platformSignOn.ts',
      'lib/platformSession.ts',
      'auth.ts',
      'auth-middleware.ts',
      'routes.ts',
      'payroll/routes.ts',
      'schedule-scope.ts',
    ].map((f) => readFileSync(join(OTOAPP_SRC, f), 'utf8').replace(/\s+/g, ' '));
    const everywhere = files.join('\n');
    const said = (fragment: string) => expect(everywhere, fragment).toContain(fragment);
    for (const line of [
      'nobody has said which OTO App user you are',
      'link OTO App with the id of your OTO App user',
      OTOAPP_WORDS.disabled,
      OTOAPP_WORDS.crossOrigin,
      OTOAPP_WORDS.passwordChange,
      OTOAPP_WORDS.refusalFallback,
      ...Object.values(OTOAPP_WORDS.refusals),
      OTOAPP_WORDS.authRequired,
      OTOAPP_WORDS.accountDisabled,
      OTOAPP_WORDS.insufficient,
      OTOAPP_WORDS.employeeNotFound,
      OTOAPP_WORDS.employeeBranchDenied,
      OTOAPP_WORDS.employeeTimeOffBranchDenied,
      OTOAPP_WORDS.tenantRequired,
      OTOAPP_WORDS.noEmployeeRecord,
      OTOAPP_WORDS.rotaRequired,
      OTOAPP_WORDS.rotaBranchDenied,
      OTOAPP_WORDS.parkGroupRequired,
      'Payroll is for payroll roles only',
      'required).',
    ]) {
      said(line.replace(/\s+/g, ' '));
    }
  });

  it('reads the app’s envelopes, cookie and identity as the app writes them', () => {
    expect(otoAppEnvelope({ reason: 'not_provisioned', message: 'x' })).toEqual({ code: 'not_provisioned', message: 'x' });
    expect(otoAppEnvelope({ message: 'Employee not found' })).toEqual({ code: null, message: 'Employee not found' });
    expect(otoAppEnvelope({ error: 'Insufficient permissions' })).toEqual({ code: null, message: 'Insufficient permissions' });
    expect(otoAppEnvelope('nope')).toEqual({ code: null, message: null });
    expect(sessionCookieOf(['connect.sid=s%3Aabc.def; Path=/; HttpOnly', 'other=1'])).toBe('connect.sid=s%3Aabc.def');
    expect(sessionCookieOf(['other=1'])).toBeNull();
    expect(identityOf({ id: 'u', role: 'manager', hasAllBranchesAccess: false, allowedBranchIds: ['b'] })).toEqual({
      userId: 'u',
      role: 'manager',
      permissions: [],
      homeBranchId: 'b',
      allBranches: false,
    });
    expect(identityOf({ id: 'u', role: 'admin', hasAllBranchesAccess: true, allowedBranchIds: [] })).toMatchObject({
      role: 'admin',
      permissions: ['hr.view_salary'],
      homeBranchId: null,
      allBranches: true,
    });
    // A role the map does not know (an advisor's raw value) is offered nothing a manager would get.
    expect(identityOf({ id: 'u', role: 'advisor', hasAllBranchesAccess: false, allowedBranchIds: ['a', 'b'] })).toMatchObject({
      role: 'staff',
      homeBranchId: null,
    });
    expect(identityOf({ role: 'staff' })).toBeNull();
  });

  it('states the figures an answer will use: HH:MM from a database time, a shift’s hours, a period and a day in words', () => {
    expect(clockOf('10:00:00')).toBe('10:00');
    expect(clockOf('9:30')).toBe('09:30');
    expect(clockOf('10.00')).toBe('10:00');
    expect(clockOf('19:00:00.000')).toBe('19:00');
    expect(clockOf('25:00')).toBeNull();
    expect(clockOf('soon')).toBeNull();
    expect(hoursBetween('10:00', '19:00')).toBe(9);
    expect(hoursBetween('10:00', '18:30')).toBe(8.5);
    expect(hoursBetween('22:00', '02:00')).toBe(4);
    expect(hoursBetween(null, '02:00')).toBeNull();
    expect(daysInclusive('2026-11-09', '2026-11-11')).toBe(3);
    expect(daysInclusive('2026-11-09', '2026-11-09')).toBe(1);
    expect(daysInclusive('2026-11-11', '2026-11-09')).toBeNull();
    expect(periodSentence('2026-10-01', '2026-10-20')).toBe('1 to 20 October 2026 / 1 ถึง 20 ตุลาคม 2569 / с 1 по 20 октября 2026');
    expect(periodSentence('2026-09-30', '2026-10-20')).toBe(
      '30 September 2026 to 20 October 2026 / 30 กันยายน 2569 ถึง 20 ตุลาคม 2569 / с 30 сентября 2026 по 20 октября 2026',
    );
    expect(periodSentence('2026-10-21', '2026-10-21')).toBe(dayWords('2026-10-21'));
    expect(weekdayWords('2026-10-21')).toBe('Wednesday / วันพุธ / среда');
    expect(weekdayWords('2026-10-21T00:00:00Z')).toBeNull();
  });

  it('matches a colleague by name or nickname, case- and diacritic-insensitive, Thai and Latin', () => {
    expect(nameKey('Zoë Ñandú')).toBe('zoenandu');
    expect(nameMatches('anan', ['ZZ Anan Fixture', 'Anan'])).toBe(true);
    expect(nameMatches('ANAN fixture', ['ZZ Anan Fixture', null])).toBe(true);
    expect(nameMatches('anan', ['ZZ Somchai', 'Chai'])).toBe(false);
    expect(nameMatches('อนันต์', ['อนันต์ ทดสอบ', null])).toBe(true);
    expect(nameMatches('อนัน', ['อนันต์ ทดสอบ', null])).toBe(true);
    expect(nameMatches('', ['Anan'])).toBe(false);
  });
});

describe('the hand-off, as the person (§B.3, §F.2)', () => {
  it('a manager: one hand-off with the ask’s request id, one app session, the figures, the logout', async () => {
    fake.resetObservations();
    const issuedBefore = (await handoffRows('auth.handoff_issue')).length;
    const fakeClient = script(
      w,
      tool('oto.employees.find', { name: 'Anan' }),
      attendanceCall(anan.id),
      final(`ZZ Anan Fixture worked ${attendance.days} days, ${attendance.hours} hours this month.`, [
        { key: 'oto.timekeeping.employee', params: [{ name: 'employeeId', value: anan.id }] },
      ]),
    );
    const res = await ask(w, manager.cookie, "Anan's attendance this month");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.state).toBe('answered');
    expect(res.body.refusals).toEqual([]);
    expect(res.body.answer).toContain(String(attendance.days));

    // The rows: both calls the app's own routes, as oto_app.
    const rows = await toolRows(w.ctx.db, res.body.id);
    expect(rows.map((r) => [r.tool, r.system, r.status, r.route])).toEqual([
      ['oto.employees.find', 'oto_app', 200, 'GET /api/employees'],
      ['oto.attendance', 'oto_app', 200, 'GET /api/timekeeping/employee/:employeeId'],
    ]);
    // The summaries: one candidate, then the figures with the month in words.
    const seen = toolResultsSeen(fakeClient);
    expect((seen[0]!.data as { data: { candidates: Array<{ id: string }>; matches: number } }).data).toMatchObject({
      matches: 1,
      candidates: [{ id: anan.id, name: 'ZZ Anan Fixture', nickname: 'Anan', branchId: world.central }],
    });
    const summary = (seen[1]!.data as { data: Record<string, unknown> }).data;
    expect(summary).toMatchObject({ daysWorked: attendance.days, totalHours: attendance.hours, lateArrivals: 1, noShows: 0 });
    expect((summary.period as { months: string[] }).months).toContain(monthWords(today.slice(0, 7)));
    // The link the model asked for is a manager's screen, and this ask knows the asker is one.
    expect(res.body.links).toEqual([
      {
        key: 'oto.timekeeping.employee',
        app: 'oto_app',
        path: `/timekeeping-review/employee/${anan.id}`,
        shows: "One person's clock review",
      },
    ]);

    // §F.2: the mint's audit row carries the ask's request id (and the ask's id), and the exchange was real.
    const reqId = await askRequestId(res.body.id);
    const issued = (await handoffRows('auth.handoff_issue')).filter((r) => (r.after as { askId?: string }).askId === res.body.id);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.requestId).toBe(reqId);
    expect(issued[0]!.after).toMatchObject({ audience: 'oto_app', askId: res.body.id });
    expect((issued[0]!.after as { jti?: string }).jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(issued[0]!.after)).not.toContain('eyJ');
    expect((await handoffRows('auth.handoff_issue')).length).toBe(issuedBefore + 1);
    const claimed = (await handoffRows('auth.handoff_claim')).filter((r) => r.requestId === `${reqId}.h`);
    expect(claimed).toHaveLength(1);

    // What the app saw: the Origin-less exchange, the identity read, the two tool calls, the logout — each with the ask's id.
    expect(fake.requests.map((r) => [r.method, r.path, r.requestId, r.origin])).toEqual([
      ['POST', '/api/auth/handoff', `${reqId}.h`, null],
      ['GET', '/api/user', `${reqId}.u`, null],
      ['GET', '/api/employees', `${reqId}.t1`, null],
      ['GET', `/api/timekeeping/employee/${anan.id}`, `${reqId}.t2`, null],
      ['POST', '/api/logout', `${reqId}.x`, null],
    ]);
    expect(fake.sidsIssued).toHaveLength(1);
    expect(fake.logouts).toEqual([{ sid: fake.sidsIssued[0], requestId: `${reqId}.x`, hadSession: true }]);
    expect(fake.sessions.size).toBe(0);
    // The app asked the platform whether the session was alive on every call it served.
    expect(fake.livenessProbes).toBeGreaterThanOrEqual(3);

    // The closing audit row says the ask signed into the app, and as which role: a word, no id.
    const [closing] = await w.ctx.db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'assistant.ask'), sql`${s.auditLog.after}->>'askId' = ${res.body.id}`));
    expect(closing!.after).toMatchObject({ state: 'answered', tools: ['oto.employees.find', 'oto.attendance'], otoApp: { role: 'manager' } });
  });

  it('not_provisioned (Q16): the app’s own sentence, verbatim; no session, nothing logged out', async () => {
    fake.resetObservations();
    const exchangedBefore = (await handoffRows('auth.handoff_exchange')).length;
    script(w, tool('oto.employees.find', { name: 'Anan' }), final("I can't open the OTO App for you."));
    const res = await ask(w, nobody.cookie, "Anan's attendance this month");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('refused');
    expect(res.body.reason).toBe('TOOL_REFUSED');
    expect(res.body.refusals).toEqual([
      {
        tool: 'oto.employees.find',
        system: 'oto_app',
        status: 403,
        code: 'not_provisioned',
        message: OTOAPP_WORDS.notProvisioned,
        line: `OTO App: ${OTOAPP_WORDS.notProvisioned}`,
      },
    ]);
    expect((await toolRows(w.ctx.db, res.body.id)).map((r) => [r.status, r.code])).toEqual([[403, 'not_provisioned']]);
    // The hand-off was minted and spent (the app exchanged it before looking for a user), no session opened.
    expect((await handoffRows('auth.handoff_exchange')).length).toBe(exchangedBefore + 1);
    expect(fake.sidsIssued).toEqual([]);
    expect(fake.logouts).toEqual([]);
    expect(fake.requests.map((r) => r.path)).toEqual(['/api/auth/handoff']);
  });

  it('disabled: the app’s own sentence, verbatim', async () => {
    script(w, tool('oto.my_leave', {}), final('No.'));
    const res = await ask(w, disabled.cookie, 'How much leave do I have?');
    expect(res.body.refusals).toEqual([
      expect.objectContaining({ system: 'oto_app', status: 403, code: 'disabled', line: `OTO App: ${OTOAPP_WORDS.disabled}` }),
    ]);
    expect(res.body.state).toBe('refused');
  });

  it('a second oto.* call in the same ask reuses the session, and a refused opening is not retried', async () => {
    fake.resetObservations();
    const issuedBefore = (await handoffRows('auth.handoff_issue')).length;
    script(w, tool('oto.my_leave', {}), tool('oto.my_payslips', {}), final('Done.'));
    const ok = await ask(w, staffer.cookie, 'My leave and my payslips');
    expect(ok.body.state).toBe('answered');
    expect((await toolRows(w.ctx.db, ok.body.id)).map((r) => r.status)).toEqual([200, 200]);
    expect((await handoffRows('auth.handoff_issue')).length).toBe(issuedBefore + 1);
    expect(fake.sidsIssued).toHaveLength(1);
    expect(fake.logouts).toHaveLength(1);

    fake.resetObservations();
    script(w, tool('oto.my_leave', {}), tool('oto.my_payslips', {}), final('No.'));
    const refused = await ask(w, nobody.cookie, 'My leave and my payslips');
    expect(refused.body.refusals.map((r) => r.code)).toEqual(['not_provisioned', 'not_provisioned']);
    // One mint for the ask, not one per call.
    expect((await handoffRows('auth.handoff_issue')).length).toBe(issuedBefore + 2);
    expect(fake.requests.map((r) => r.path)).toEqual(['/api/auth/handoff']);
  });

  it('the tile held at another park only: the launcher’s own refusal as a platform line, no hand-off, the app never contacted', async () => {
    fake.resetObservations();
    const issuedBefore = (await handoffRows('auth.handoff_issue')).length;
    const [central] = await w.ctx.db.select({ name: s.branch.name }).from(s.branch).where(eq(s.branch.id, w.central)).limit(1);
    const fakeClient = script(w, tool('oto.my_leave', {}), final('No.'));
    const res = await ask(w, elsewhere.cookie, 'My leave');
    // Offered (held somewhere in the operator), refused at the seat — the same answer POST /auth/handoff gives this session.
    expect((fakeClient.calls[0]?.tools ?? []).some((t) => t.name.startsWith('oto_'))).toBe(true);
    expect(res.body.refusals).toEqual([
      expect.objectContaining({
        tool: 'oto.my_leave',
        system: 'platform',
        status: 403,
        code: 'OUT_OF_BRANCH_SCOPE',
        line: `Platform: You hold app:oto_app:access, but not at ${central!.name}`,
      }),
    ]);
    const direct = await w.ctx.app.inject({ method: 'POST', url: '/auth/handoff', headers: { cookie: elsewhere.cookie }, payload: { app: 'oto_app' } });
    expect(direct.statusCode).toBe(403);
    expect(direct.json().error.message).toBe(`You hold app:oto_app:access, but not at ${central!.name}`);
    expect((await handoffRows('auth.handoff_issue')).length).toBe(issuedBefore);
    expect(fake.requests).toEqual([]);
  });

  it('a platform session revoked between the hand-off and the tool call: the app’s own 401, never data', async () => {
    fake.resetObservations();
    const me = await staff(w, 'ZZ Oto Revoked', 'staff', { scopeType: 'branch', scopeId: w.central }, w.central);
    await grantOtoAppTile(w, me.accountId, w.central);
    const mine = fakeEmployee(fake, world, { fullName: 'ZZ Oto Revoked', nickname: 'Rev', branchId: world.central });
    fakeUser(fake, world, { platformAccountId: me.accountId, role: 'staff', branchId: world.central, employeeId: mine.id });
    const fakeClient = script(
      w,
      tool('oto.my_leave', {}),
      tool('oto.my_payslips', {}, {
        during: async () => {
          await w.ctx.db.update(s.session).set({ revokedAt: new Date() }).where(eq(s.session.id, me.sessionId));
        },
      }),
      final('You were signed out.'),
    );
    const res = await ask(w, me.cookie, 'My leave, then my payslips');
    expect(res.status).toBe(200);
    expect((await toolRows(w.ctx.db, res.body.id)).map((r) => r.status)).toEqual([200, 401]);
    expect(res.body.refusals).toEqual([
      expect.objectContaining({ tool: 'oto.my_payslips', system: 'oto_app', status: 401, line: `OTO App: ${OTOAPP_WORDS.authRequired}` }),
    ]);
    expect(toolResultsSeen(fakeClient)[1]!.isError).toBe(true);
    // The app's liveness check ended its session before the route ran; the engine's logout still ran.
    expect(fake.sessions.size).toBe(0);
    expect(fake.logouts).toHaveLength(1);
    expect(fake.requests.map((r) => [r.path, r.status])).toEqual([
      ['/api/auth/handoff', 200],
      ['/api/user', 200],
      ['/api/my-time-off', 200],
      ['/api/payroll/me/payslips', 401],
      ['/api/logout', 200],
    ]);
  });

  it('a platform session revoked before the first oto.* call: the exchange refuses it, the app’s own sentence', async () => {
    fake.resetObservations();
    const me = await staff(w, 'ZZ Oto Revoked Early', 'staff', { scopeType: 'branch', scopeId: w.central }, w.central);
    await grantOtoAppTile(w, me.accountId, w.central);
    fakeUser(fake, world, { platformAccountId: me.accountId, role: 'staff', branchId: world.central });
    script(
      w,
      tool('oto.my_leave', {}, {
        during: async () => {
          await w.ctx.db.update(s.session).set({ revokedAt: new Date() }).where(eq(s.session.id, me.sessionId));
        },
      }),
      final('You were signed out.'),
    );
    const res = await ask(w, me.cookie, 'My leave');
    expect(res.body.refusals).toEqual([
      expect.objectContaining({ system: 'oto_app', status: 401, code: 'revoked', line: `OTO App: ${OTOAPP_WORDS.refusals['revoked']}` }),
    ]);
    expect(fake.sidsIssued).toEqual([]);
    const rejected = await handoffRows('auth.handoff_rejected');
    expect(rejected.some((r) => (r.after as { reason?: string }).reason === 'revoked' && (r.after as { accountId?: string }).accountId === me.accountId)).toBe(true);
  });

  it('the app session is logged out when a tool throws: a 5xx from the app closes the ask as TOOL_ERROR', async () => {
    fake.resetObservations();
    fake.data.broken.add(anan.id);
    try {
      const fakeClient = script(w, attendanceCall(anan.id), final('never reached'));
      const res = await ask(w, manager.cookie, "Anan's attendance this month");
      expect(res.body).toMatchObject({ state: 'failed', reason: 'TOOL_ERROR', answer: INTERNAL_LINES.failed.en });
      expect((await toolRows(w.ctx.db, res.body.id)).map((r) => [r.status, r.code])).toEqual([[500, null]]);
      expect(fakeClient.remaining).toBe(1);
    } finally {
      fake.data.broken.delete(anan.id);
    }
    // §F.2: the logout ran in the `finally`; no session is left behind.
    expect(fake.sidsIssued).toHaveLength(1);
    expect(fake.logouts).toEqual([expect.objectContaining({ sid: fake.sidsIssued[0], hadSession: true })]);
    expect(fake.sessions.size).toBe(0);
  });

  it('the app giving no answer at the exchange is OTOAPP_UNAVAILABLE, recorded, and the ask fails without a guess', async () => {
    fake.resetObservations();
    const platform = fake.platform;
    fake.platform = null;
    try {
      script(w, tool('oto.my_leave', {}), final('never reached'));
      const res = await ask(w, staffer.cookie, 'My leave');
      expect(res.body).toMatchObject({ state: 'failed', reason: 'TOOL_ERROR', answer: INTERNAL_LINES.failed.en, refusals: [] });
      expect((await toolRows(w.ctx.db, res.body.id)).map((r) => [r.status, r.code])).toEqual([[503, 'OTOAPP_UNAVAILABLE']]);
    } finally {
      fake.platform = platform;
    }
    expect(fake.logouts).toEqual([]);
  });

  it('INTERNAL_AI_OTOAPP_TOOLS=false (Q14’s shape): no oto.* tool offered, no hand-off minted, the app never contacted', async () => {
    fake.resetObservations();
    const cfg = w.ctx.app.internalAi.config;
    const issuedBefore = (await handoffRows('auth.handoff_issue')).length;
    cfg.otoAppTools = false;
    try {
      const fakeClient = script(w, final("The OTO App's attendance figures are not available here."));
      const res = await ask(w, manager.cookie, "Anan's attendance this month");
      expect(res.body.state).toBe('answered');
      expect((fakeClient.calls[0]?.tools ?? []).map((t) => t.name).filter((n) => n.startsWith('oto_'))).toEqual([]);
      expect(fakeClient.calls[0]!.tools).toHaveLength(10);
    } finally {
      cfg.otoAppTools = true;
    }
    expect((await handoffRows('auth.handoff_issue')).length).toBe(issuedBefore);
    expect(fake.requests).toEqual([]);
    // The offer needs the switch, a configured hand-off and the tile; the engine's own rule.
    const effective = await resolveEffectivePermissions(w.ctx.db, manager.accountId);
    const caller = { auth: { operatorId: w.oto } as never, effective, requestId: 'r', token: 't' };
    expect(otoAppToolsOffered(w.ctx.app.internalAi, caller)).toBe(true);
    expect(otoAppToolsOffered({ ...w.ctx.app.internalAi, config: { ...cfg, otoAppTools: false } }, caller)).toBe(false);
    expect(otoAppToolsOffered({ ...w.ctx.app.internalAi, config: { ...cfg, handoff: { ...cfg.handoff, appOrigins: '' } } }, caller)).toBe(false);
    const nobodyEffective = await resolveEffectivePermissions(w.ctx.db, (await staff(w, 'ZZ No Tile', 'staff', { scopeType: 'branch', scopeId: w.central })).accountId);
    expect(otoAppToolsOffered(w.ctx.app.internalAi, { ...caller, effective: nobodyEffective })).toBe(false);
  });
});

describe('the fences pass through verbatim (§D.4, X3, X4)', () => {
  it('staff asking for a colleague’s attendance (Q3): the manager-only refusal, word for word, no figure', async () => {
    const fakeClient = script(w, tool('oto.employees.find', { name: 'Anan' }), attendanceCall(anan.id), final("I can't read Anan's attendance from your role."));
    const res = await ask(w, staffer.cookie, "Anan's attendance this month");
    expect((await toolRows(w.ctx.db, res.body.id)).map((r) => [r.tool, r.status])).toEqual([
      ['oto.employees.find', 200],
      ['oto.attendance', 403],
    ]);
    expect(res.body.refusals).toEqual([
      expect.objectContaining({ tool: 'oto.attendance', system: 'oto_app', status: 403, code: null, line: `OTO App: ${OTOAPP_WORDS.insufficient}` }),
    ]);
    expect(JSON.stringify(toolResultsSeen(fakeClient)[1]!.data)).not.toContain('daysWorked');
  });

  it('a manager at Central asking about a Chalong person, or an id that is not there: the route’s own 403 and 404', async () => {
    script(w, attendanceCall(chai.id), attendanceCall('e-not-there'), final('Neither.'));
    const res = await ask(w, manager.cookie, 'Chai, and someone else');
    expect(res.body.refusals.map((r) => r.line)).toEqual([
      `OTO App: ${OTOAPP_WORDS.employeeBranchDenied}`,
      `OTO App: ${OTOAPP_WORDS.employeeNotFound}`,
    ]);
    expect(res.body.state).toBe('refused');
  });

  it('salary (Q2): the payroll routes’ refusal for a manager, verbatim, and no payroll link; the figures for an admin', async () => {
    script(
      w,
      tool('oto.payroll_summary', { month: '2026-09' }),
      final('Payroll is not mine to see.', [{ key: 'oto.payroll.month', params: [{ name: 'month', value: '2026-09' }, { name: 'tab', value: 'preview' }] }]),
    );
    const refused = await ask(w, manager.cookie, "What is Anan's salary?");
    expect(refused.body.refusals).toEqual([
      expect.objectContaining({ tool: 'oto.payroll_summary', system: 'oto_app', status: 403, line: `OTO App: ${OTOAPP_WORDS.payrollRoles}` }),
    ]);
    expect(refused.body.state).toBe('refused');
    expect(refused.body.links).toEqual([]);

    const fakeClient = script(
      w,
      tool('oto.payroll_summary', { month: '2026-09' }),
      final('September 2026: net 444000 for 12 people.', [{ key: 'oto.payroll.month', params: [{ name: 'month', value: '2026-09' }, { name: 'tab', value: 'preview' }] }]),
    );
    const allowed = await ask(w, admin.cookie, "Why does September's payroll look wrong?");
    expect(allowed.body.state, JSON.stringify(allowed.body)).toBe('answered');
    const summary = (toolResultsSeen(fakeClient)[0]!.data as { data: { runs: Array<Record<string, unknown>>; monthWords: string } }).data;
    expect(summary.monthWords).toBe(monthWords('2026-09'));
    // The lock instant carries its day in words: "locked on 1 October" is grounded, as the month-end figures are.
    expect(summary.runs[0]).toMatchObject({ month: '2026-09', net: 444000, people: 12, lockedAt: `2026-10-01 10:00 (${dayWords('2026-10-01')})` });
    // The payroll screen is worth offering to an admin (hr.view_salary), and the month is grounded.
    expect(allowed.body.links).toEqual([
      { key: 'oto.payroll.month', app: 'oto_app', path: '/payroll/month-end?month=2026-09&tab=preview', shows: 'One month-end' },
    ]);
  });

  it('the link gate follows the role the app gave this ask: manager screens for a manager, none without an app session', async () => {
    const effective = await resolveEffectivePermissions(w.ctx.db, manager.accountId);
    const schedule = [{ key: 'oto.scheduling', params: {} }];
    expect(resolveLinks(schedule, effective, w.oto, null)).toEqual([]);
    expect(resolveLinks(schedule, effective, w.oto, { role: 'staff', permissions: [] })).toEqual([]);
    expect(resolveLinks(schedule, effective, w.oto, { role: 'manager', permissions: [] })).toEqual([{ key: 'oto.scheduling', params: {} }]);
    expect(resolveLinks([{ key: 'oto.payroll.hub', params: {} }], effective, w.oto, { role: 'manager', permissions: [] })).toEqual([]);
    expect(resolveLinks([{ key: 'oto.payroll.hub', params: {} }], effective, w.oto, { role: 'admin', permissions: ['hr.view_salary'] })).toHaveLength(1);

    // Through an ask: a staff member's model links — the rota (everyone) stays, the scheduling board (manager) goes.
    script(
      w,
      tool('oto.rota', { scope: 'branch', from: tomorrow, to: tomorrow }),
      final('Tomorrow: Anan, Beam, Krit, 10:00 to 19:00.', [
        { key: 'oto.scheduling', params: [] },
        { key: 'oto.rota', params: [] },
      ]),
    );
    const res = await ask(w, staffer.cookie, "Who's on shift with me tomorrow?");
    expect(res.body.state, JSON.stringify(res.body)).toBe('answered');
    expect(res.body.links.map((l) => l.key)).toEqual(['oto.rota']);
  });
});

describe('the summaries (§B.4)', () => {
  it('a colleague by name is the asker’s own park: Anan at Central is found, the Chalong person is not, and pay never passes', async () => {
    let fakeClient = script(w, tool('oto.employees.find', { name: 'chai' }), tool('oto.employees.find', { name: 'anan fixture' }), final('Only Anan.'));
    await ask(w, manager.cookie, 'Find Chai and Anan');
    const seen = toolResultsSeen(fakeClient);
    expect((seen[0]!.data as { data: { matches: number } }).data.matches).toBe(0);
    expect((seen[1]!.data as { data: { candidates: Array<{ id: string }> } }).data.candidates.map((c) => c.id)).toEqual([anan.id]);

    // An all-parks admin lists every park and is handed pay by the app; the summary still carries none.
    fakeClient = script(w, tool('oto.employees.find', { name: 'chai' }), final('Chai is at Chalong.'));
    await ask(w, admin.cookie, 'Find Chai');
    const text = JSON.stringify(toolResultsSeen(fakeClient)[0]!.data);
    expect(text).toContain(chai.id);
    expect(text).not.toMatch(/salary|31000/i);
    // The hand-off, the identity read, the list — with no branch filter for an all-parks admin — then the logout.
    expect(fake.requests.slice(-4).map((r) => r.path)).toEqual(['/api/auth/handoff', '/api/user', '/api/employees', '/api/logout']);
  });

  it('the rota: the shifts of the day, grounded names and times, the period in words', async () => {
    const fakeClient = script(w, tool('oto.rota', { scope: 'branch', from: tomorrow, to: tomorrow }), final('Three on tomorrow.'));
    const res = await ask(w, staffer.cookie, "Who's on shift tomorrow?");
    expect(res.body.state).toBe('answered');
    const data = (toolResultsSeen(fakeClient)[0]!.data as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ scope: 'branch', branchId: world.central, shifts: 3, days: 1, people: 3 });
    expect((data.list as Array<{ employee: string; start: string }>).map((x) => `${x.employee} ${x.start}`).sort()).toEqual(['Anan 10:00', 'Beam 10:00', 'Krit 10:00']);
    expect(JSON.stringify(data.period)).toContain(tomorrow);
  });

  it('the rota as a deployment shapes it (a Postgres `time`, 10:00:00): the date spelled out, the hours and the headcount are grounded', async () => {
    // The proof round's miss: the fixture's `10:00` grounded the answer's `10:00`; the app's shift rows carry
    // `10:00:00`, which did not, and the rota answer was set aside as GUARD_NUMBER. A day the fixture shifts do not cover.
    const day = isoDay(new Date(), 5);
    for (const employeeId of [anan.id, krit.id]) {
      fake.data.shifts.push({ date: day, start: '10:00:00', end: '19:00:00', employeeId, department: 'Floor', branchId: world.central });
    }
    const [dayEn] = dayWords(day).split(' / ');
    const [weekdayEn] = weekdayWords(day)!.split(' / ');
    const fakeClient = script(
      w,
      tool('oto.rota', { scope: 'branch', from: day, to: day }),
      final(`On ${weekdayEn} ${dayEn}, 2 people are on shift at Central: Anan and Krit, 10:00–19:00, 9 hours each.`, [{ key: 'oto.rota', params: [] }]),
    );
    const res = await ask(w, staffer.cookie, `Who's on shift with me on ${day}?`);
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ state: 'answered', reason: null });
    expect(res.body.answer).toContain('10:00–19:00, 9 hours');
    const data = (toolResultsSeen(fakeClient)[0]!.data as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ shifts: 2, days: 1, people: 2 });
    expect((data.list as Array<Record<string, unknown>>)[0]).toMatchObject({
      date: day,
      day: dayWords(day),
      weekday: weekdayWords(day),
      start: '10:00',
      end: '19:00',
      hours: 9,
    });
    expect(JSON.stringify(data)).not.toContain('10:00:00');
  });

  it('my leave: the records and the weekly off days, never the note, and no balance (G2)', async () => {
    const fakeClient = script(w, tool('oto.my_leave', {}), final('One annual leave booked; the balance is on the screen.'));
    const res = await ask(w, staffer.cookie, 'วันลาของฉันเหลือกี่วัน');
    expect(res.body.state).toBe('answered');
    const data = (toolResultsSeen(fakeClient)[0]!.data as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ employeeId: beam.id, records: 1, weeklyOffDays: ['monday'], balanceAvailable: false });
    // The length an answer states ("3 days") is a figure the summary carries, with the days by name.
    expect((data.leave as Array<{ type: string; halfDay: unknown; days: number; weekdays: string }>)[0]).toMatchObject({
      type: 'annual',
      halfDay: false,
      days: 3,
      weekdays: `${weekdayWords(isoDay(new Date(), 20))} – ${weekdayWords(isoDay(new Date(), 22))}`,
    });
    expect(JSON.stringify(data)).not.toContain(ASK_SENTINEL);
    expect(res.body.links.map((l) => l.key)).toEqual([]);
  });

  it('my payslips: months, never figures', async () => {
    const fakeClient = script(w, tool('oto.my_payslips', {}), final('One payslip, September 2026.'));
    const res = await ask(w, staffer.cookie, 'My payslips');
    expect(res.body.state).toBe('answered');
    const text = JSON.stringify(toolResultsSeen(fakeClient)[0]!.data);
    expect(text).toContain('2026-09');
    expect(text).not.toContain('28400');
  });

  it('a manager’s leave read for a colleague: the records, the employee-file link', async () => {
    script(w, tool('oto.employee_leave', { employeeId: beam.id, from: firstOfMonth }), final('Beam has one leave booked.'));
    const res = await ask(w, manager.cookie, 'Beam’s leave');
    expect(res.body.state).toBe('answered');
    const rows = await toolRows(w.ctx.db, res.body.id);
    expect(rows[0]).toMatchObject({ tool: 'oto.employee_leave', status: 200, rows: 1 });
    // Not asked for by the model; the engine gathered it from the tool, and a manager may open it.
    expect(res.body.links).toEqual([]);
  });
});

describe('the record (§E.1): the sentinel, the cookie and the token', () => {
  it('a name the app returned travels to the answer and nowhere else; no sid, no token, in any row or log line', async () => {
    const fakeClient = script(w, tool('oto.employees.find', { name: 'Sentinel Person' }), final(`Found ZZ ${ASK_SENTINEL}.`));
    const res = await ask(w, manager.cookie, `Who is the sentinel person? ${ASK_SENTINEL}`);
    expect(res.body.state).toBe('answered');
    expect(res.body.answer).toContain(ASK_SENTINEL);
    expect(JSON.stringify(toolResultsSeen(fakeClient)[0]!.data)).toContain(sentinelPerson.id);
    expect(await askLeaks(w.ctx.db, ASK_SENTINEL, w.logLines)).toEqual(NO_ASK_LEAKS);
    // Every app session cookie and every hand-off token the app was handed: in no row, in no log.
    expect(fake.sidsIssued.length + fake.tokensSeen.length).toBeGreaterThan(0);
    for (const value of [...fake.sidsIssued, ...fake.tokensSeen]) {
      expect(await askLeaks(w.ctx.db, value, w.logLines), 'a credential leaked').toEqual(NO_ASK_LEAKS);
    }
    expect(w.logLines.filter((l) => l.includes('connect.sid'))).toEqual([]);
    expect(w.logLines.filter((l) => /oto-handoff\+jws|eyJhbGci/.test(l))).toEqual([]);
  });

  it('no tool call of any ask reached a fence-gap route (G2)', () => {
    expect(fake.requests.filter((r) => /time-events|checklists|balance/.test(r.path))).toEqual([]);
  });
});
