import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, scryptSync, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@oto/db/testing';

/**
 * S2-17b round 7 payroll (SCRUM-191 / SCRUM-516), independent ownership review.
 * Reviewed payroll base 3377ac07 against d7a05e79; the arithmetic/export
 * service files are pinned separately. All records and files here are generated
 * fixtures in one disposable database; no payroll calculation is invoked.
 * Each FINDING has a passing arrangement control and a prescribed park boundary.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const HAS_APP = existsSync(join(APP, 'node_modules/tsx/dist/loader.mjs'));
const routes = readFileSync(join(APP, 'server/routes.ts'), 'utf8');
const door = (method: string, path: string) => {
  const start = routes.indexOf(`app.${method}("${path}"`);
  expect(start >= 0).toBe(true);
  const next = routes.indexOf('\n  app.', start + 10);
  return routes.slice(start, next < 0 ? undefined : next);
};
type Group = { tenant: string; branch: string; operator: string; user: string; cookie: string; employee: string; period: string; run: string };
type Answer = { status: number; data: Record<string, unknown> | Record<string, unknown>[] | null };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: pg.Client;
let child: ChildProcess;
let origin = '';
let setupStage = 'not started';
const setup = (stage: string) => { setupStage = stage; console.info('ZZ TEST payroll setup: ' + stage); };
const harnessOutputHash = createHash('sha256');
const harnessErrorClasses = new Set<string>();
let harnessOutputBytes = 0;
let a: Group, b: Group;
let staffCookie = '', ownSlip = '';
const files = new Set<string>();
const proof: Record<string, unknown> = {};
// Ground-truthed from d7a05e79, normalized to LF; independent of CI checkout depth.
// The statutory fingerprint omits only its separately exercised lookup wrapper.
const serviceFingerprints = {
  'payroll-calculation.ts': '24faa7a2ab9204cc312fab6647449363465bba9417952450d2ecb12a714c56aa',
  'payroll-reconciliation.ts': '0d12f8f3d6432775c65e2e8afa6de537d6984d33f5b6475808b95f1f56db7282',
  'payroll-statutory.ts': 'a66a9a43874fa88c8ce8db505584c74fe909112d0fece47b24aaae76f6eed727',
  'payroll-exports.ts': '534d5b363d86f923a81a451e8759da46594599e1b60864d4c17906b2368d471e',
  'payroll-payslip.ts': 'd32657e749267673327721e3e2839e5bd7ffe586685d8d8d452fdd552f380c51',
};
const password = randomBytes(20).toString('hex');
const salt = randomBytes(16).toString('hex');
const passwordHash = scryptSync(password, salt, 64).toString('hex') + '.' + salt;
const q = async (sql: string, values: unknown[] = []) => (await client.query(sql, values)).rows;

async function boundedCleanup(action: () => Promise<unknown> | undefined, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ZZ TEST payroll cleanup deadline: ' + label)), 5_000); }),
    ]);
  } catch {
    throw new Error('ZZ TEST payroll cleanup did not complete: ' + label);
  } finally { clearTimeout(timer!); }
}

async function call(method: string, path: string, cookie = '', body?: unknown): Promise<Answer> {
  const response = await fetch(origin + path, {
    method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let data: Answer['data'] = null;
  if (response.headers.get('content-type')?.includes('application/json')) data = JSON.parse(text) as Answer['data'];
  return { status: response.status, data };
}

async function seedUser(user: string, email: string, role: string, tenant: string): Promise<void> {
  await q('insert into users(id,email,password,full_name,role) values($1,$2,$3,$4,$5)', [user, email, passwordHash, 'ZZ TEST Payroll ' + role, role]);
  await q("insert into user_branch_access(tenant_id,user_id,access_scope) values($1,$2,'all_branches')", [tenant, user]);
}

async function sign(user: string, email: string, role: string, tenant: string, seeded = false): Promise<string> {
  if (!seeded) await seedUser(user, email, role, tenant);
  const response = await fetch(origin + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(response.status).toBe(200);
  return response.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
}

async function group(label: string): Promise<Group> {
  const tenant = randomUUID(), user = randomUUID();
  await q('insert into tenants(id,name,slug) values($1,$2,$3)', [tenant, 'ZZ TEST Payroll ' + label, 'zz-test-payroll-' + tenant]);
  const operator = (await q("insert into operators(tenant_id,name) values($1,$2) returning id", [tenant, 'ZZ TEST Payroll Operator ' + label]))[0].id as string;
  const branch = (await q("insert into branches(tenant_id,operator_id,name,address) values($1,$2,$3,'ZZ TEST Address') returning id", [tenant, operator, 'ZZ TEST Payroll Branch ' + label]))[0].id as string;
  await seedUser(user, `${user}@zz-test.invalid`, 'admin', tenant);
  const employee = (await q("insert into employees(tenant_id,branch_id,full_name,nickname,email) values($1,$2,'ZZ TEST Payroll Employee','ZZ TEST',$3) returning id", [tenant, branch, `${randomUUID()}@zz-test.invalid`]))[0].id as string;
  const period = (await q("insert into payroll_periods(tenant_id,operator_id,start_date,end_date) values($1,$2,'2099-01-01','2099-01-31') returning id", [tenant, operator]))[0].id as string;
  const run = (await q("insert into payroll_runs(payroll_period_id,run_number,status,created_by,notes) values($1,1,'DRAFT',$2,'ZZ TEST Payroll Run') returning id", [period, user]))[0].id as string;
  await q('insert into payroll_employee_summaries(payroll_run_id,employee_id) values($1,$2)', [run, employee]);
  return { tenant, branch, operator, user, cookie: '', employee, period, run };
}

describe.skipIf(!HAS_APP)('round 7 independent payroll ownership review', () => {
  beforeAll(async () => {
    setup('disposable database');
    database = await createTestDatabase();
    setup('database connection');
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query('set search_path to otoapp');
    setup('app migrations');
    await migrate(drizzle(client), { migrationsFolder: join(APP, 'migrations'), migrationsSchema: 'otoapp' });
    setup('park A fixture'); a = await group('A');
    setup('park B fixture'); b = await group('B');
    setup('app harness');
    child = spawn(process.execPath, [join(APP, 'node_modules/tsx/dist/cli.mjs'), 'tests/harness/serve-routes.ts'], {
      cwd: APP, env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: 'test', APP_ENV: 'dev', DEPLOY_ENV: 'local',
        OBJECT_STORAGE: 'local', STORAGE_ENV_PREFIX: 'zz-payroll-review', OTOAPP_LEGACY_LOGIN: 'true', OTOAPP_JOBS: 'platform',
        USE_AWS_REKOGNITION: 'false', LOG_LEVEL: 'warn', SESSION_SECRET: randomBytes(32).toString('hex'), SESSION_PEPPER: randomBytes(32).toString('hex') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    origin = await new Promise<string>((resolvePort, reject) => {
      let tail = '';
      const timer = setTimeout(() => reject(new Error('ZZ TEST payroll harness did not start; child output was kept private')), 180_000);
      const read = (part: Buffer) => {
        harnessOutputHash.update(part); harnessOutputBytes += part.byteLength;
        for (const match of part.toString().matchAll(/\b(?:ReferenceError|SyntaxError|TypeError|MODULE_NOT_FOUND|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EROFS)\b/g)) harnessErrorClasses.add(match[0]);
        tail = (tail + part.toString()).slice(-400);
        const match = /HARNESS_PORT=(\d+)/.exec(tail);
        if (match) { clearTimeout(timer); resolvePort('http://127.0.0.1:' + match[1]); }
      };
      child.stdout!.on('data', read); child.stderr!.on('data', read);
      child.once('exit', () => { clearTimeout(timer); reject(new Error('ZZ TEST payroll harness exited; child output was kept private')); });
    });
    setup('admin sign-ins');
    a.cookie = await sign(a.user, `${a.user}@zz-test.invalid`, 'admin', a.tenant, true);
    b.cookie = await sign(b.user, `${b.user}@zz-test.invalid`, 'admin', b.tenant, true);
    setup('staff fixture');
    const staff = randomUUID();
    staffCookie = await sign(staff, `${staff}@zz-test.invalid`, 'staff', a.tenant);
    await q('update employees set user_id=$1 where id=$2', [staff, a.employee]);
    ownSlip = (await q("insert into payslips(payroll_run_id,payroll_period_id,employee_id,slip_number,issued_at,slip_data) values($1,$2,$3,'ZZ TEST Own Slip',now(),'{}') returning id", [a.run, a.period, a.employee]))[0].id as string;
    setup('complete');
  }, 240_000);

  afterAll(async () => {
    if (setupStage !== 'complete') console.info('ZZ TEST payroll incomplete setup: ' + setupStage);
    if (setupStage !== 'complete') console.info('ZZ TEST payroll private harness output: ' + JSON.stringify({ bytes: harnessOutputBytes, errorClasses: [...harnessErrorClasses], sha256: harnessOutputHash.copy().digest('hex') }));
    if (child?.pid && child.exitCode === null && process.platform === 'win32') {
      // Terminate only this fixture's captured process tree before DB drop.
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 }); }
      catch { child.kill(); }
    } else child?.kill();
    for (const file of files) {
      const absolute = resolve(file), within = relative(resolve(APP, 'uploads'), absolute);
      if (!within || within.startsWith('..') || within.includes(':')) throw new Error('ZZ TEST payroll file cleanup refused');
      rmSync(absolute, { force: true });
    }
    try { await boundedCleanup(() => client?.end(), 'client'); }
    finally { await boundedCleanup(() => database?.drop(), 'scratch database'); }
    console.info('ZZ TEST payroll cleanup: client closed and scratch database dropped');
  });

  it('censuses all 45 registrations, their guard families and two inherited shadows', () => {
    const names = [...routes.matchAll(/app\.(get|post|put|patch|delete)\(\s*["'](\/api\/payroll[^"']*)["']/g)].map((match) => `${match[1]} ${match[2]}`);
    const disposition = [
      ['get /api/payroll/periods', 'operator'], ['get /api/payroll/periods/:id', 'period'],
      ['post /api/payroll/periods', 'operator'], ['patch /api/payroll/periods/:id', 'period'],
      ['get /api/payroll/runs/:id', 'run'], ['post /api/payroll/runs', 'period'],
      ['patch /api/payroll/runs/:id', 'run'], ['get /api/payroll/runs/:runId/exceptions', 'run'],
      ['get /api/payroll/exceptions/:id', 'exception parent run'], ['post /api/payroll/exceptions/:id/approve', 'exception parent run'],
      ['post /api/payroll/exceptions/:id/reject', 'exception parent run'], ['get /api/payroll/runs/:runId/summaries', 'run'],
      ['get /api/payroll/runs/:runId/line-items', 'run'], ['get /api/payroll/my-payslips', 'self plus run'],
      ['get /api/payroll/payslips/:id', 'slip parent run'], ['get /api/payroll/employees/:employeeId/advances', 'employee and advance finding'],
      ['post /api/payroll/advances', 'inherited field mapper refuses a required tenant'],
      ['get /api/payroll/policy', 'operator and policy finding'], ['post /api/payroll/policy', 'operator and policy finding'],
      ['get /api/payroll/statutory-rules', 'caller tenant list'], ['get /api/payroll/employees/:employeeId/profile', 'employee and profile finding'],
      ['post /api/payroll/employees/:employeeId/profile', 'employee'], ['post /api/payroll/runs/:id/reconcile', 'run'],
      ['get /api/payroll/runs/:id/reconciliation-summary', 'run'], ['get /api/payroll/runs/:runId/reconciliations', 'run'],
      ['post /api/payroll/runs/:id/calculate', 'run'], ['get /api/payroll/runs/:id/employee-summaries', 'run'],
      ['get /api/payroll/runs/:id/employees/:employeeId/details', 'employee and run'], ['post /api/payroll/runs/:id/statutory', 'run'],
      ['get /api/payroll/statutory-rules/:countryCode', 'existing country dictionary'], ['get /api/payroll/statutory-rule-sets', 'caller tenant list'],
      ['get /api/payroll/statutory-rule-sets/:id', 'rule tenant'], ['post /api/payroll/statutory-rule-sets', 'rule parents finding'],
      ['put /api/payroll/statutory-rule-sets/:id', 'rule tenant and parents finding'], ['delete /api/payroll/statutory-rule-sets/:id', 'rule tenant'],
      ['post /api/payroll/statutory-rule-sets/seed', 'caller tenant writer'], ['post /api/payroll/runs/:id/payslips/:employeeId', 'employee and run'],
      ['post /api/payroll/runs/:id/payslips/bulk', 'shadowed by preceding employee parameter'], ['get /api/payroll/payslip-files/:filename', 'filename run and self'],
      ['get /api/payroll/my-payslips', 'shadowed by preceding self handler'], ['post /api/payroll/runs/:id/export/bank-transfer', 'run'],
      ['post /api/payroll/runs/:id/export/journal', 'run'], ['post /api/payroll/runs/:id/export/sso-filing', 'run'],
      ['post /api/payroll/runs/:id/export/pit-filing', 'run'], ['get /api/payroll/exports/:type/:filename', 'filename run'],
    ];
    expect(names).toEqual(disposition.map(([path]) => path));
    expect(disposition).toHaveLength(45);
    expect(names.filter((name) => name === 'get /api/payroll/my-payslips')).toHaveLength(2);
    expect(door('get', '/api/payroll/my-payslips')).toContain('verifyRunAccess');
    // Both dispatch orders were verified in d7a05e79 before this record was saved.
    expect(routes.indexOf('app.post("/api/payroll/runs/:id/payslips/:employeeId"')).toBeLessThan(routes.indexOf('app.post("/api/payroll/runs/:id/payslips/bulk"'));
  });

  it('own/foreign/anonymous parents and operator lists reach their intended guards', async () => {
    expect((await call('GET', '/api/payroll/periods?operatorId=' + a.operator, a.cookie)).status).toBe(200);
    expect((await call('GET', '/api/payroll/periods?operatorId=' + a.operator, b.cookie)).status).toBe(403);
    expect((await call('GET', '/api/payroll/periods/' + a.period, a.cookie)).status).toBe(200);
    expect((await call('GET', '/api/payroll/periods/' + a.period, b.cookie)).status).toBe(403);
    expect((await call('GET', '/api/payroll/runs/' + a.run, a.cookie)).status).toBe(200);
    expect((await call('GET', '/api/payroll/runs/' + a.run, b.cookie)).status).toBe(403);
    expect((await call('GET', '/api/payroll/runs/' + a.run)).status).toBe(401);
    expect((await call('POST', '/api/payroll/runs', b.cookie, { payrollPeriodId: a.period })).status).toBe(403);
    expect((await call('GET', '/api/payroll/payslips/' + ownSlip, staffCookie)).status).toBe(200);
    const staff = await call('GET', '/api/user', staffCookie);
    expect((staff.data as Record<string, unknown>).operatorId).toBeNull();
    proof.parents = true;
  });

  it('foreign reads, replays and actions stop before reconciliation, calculation or document generation', async () => {
    const matrix: [string, string, unknown?][] = [
      ['PATCH', '/periods/' + a.period, { status: 'CLOSED' }],
      ['POST', '/periods', { name: 'ZZ TEST Refused Period', operatorId: a.operator, startDate: '2099-02-01', endDate: '2099-02-28' }],
      ['PATCH', '/runs/' + a.run, { status: 'APPROVED' }],
      ...['exceptions', 'summaries', 'line-items', 'reconciliation-summary', 'reconciliations', 'employee-summaries'].map((name): [string, string] => ['GET', `/runs/${a.run}/${name}`]),
      ...['reconcile', 'calculate', 'statutory', 'payslips/bulk', 'export/bank-transfer', 'export/journal', 'export/sso-filing', 'export/pit-filing'].map((name): [string, string, unknown] => ['POST', `/runs/${a.run}/${name}`, {}]),
      ['GET', `/runs/${a.run}/employees/${a.employee}/details`],
      ['POST', `/runs/${a.run}/payslips/${a.employee}`, {}],
      ['GET', `/employees/${a.employee}/profile`], ['POST', `/employees/${a.employee}/profile`, {}],
      ['GET', `/employees/${a.employee}/advances`], ['GET', '/policy?operatorId=' + a.operator],
      ['POST', '/policy', { operatorId: a.operator }],
    ];
    for (const [method, path, body] of matrix) {
      for (let replay = 0; replay < 2; replay++) {
        expect([403, 404], method + ' ' + path).toContain((await call(method, '/api/payroll' + path, b.cookie, body)).status);
      }
    }
    expect((await call('POST', `/api/payroll/runs/${a.run}/payslips/bulk`, a.cookie, {})).status).toBe(404);
    expect((await q('select count(*)::int as count from payroll_day_reconciliations where payroll_run_id=$1', [a.run]))[0].count).toBe(0);
    expect((await q('select status from payroll_runs where id=$1', [a.run]))[0].status).toBe('DRAFT');
  });

  it('disjoint park run requests and replay retain the existing versioned-run behavior', async () => {
    for (const owner of [a, b]) {
      for (let replay = 0; replay < 2; replay++) {
        const result = await call('POST', '/api/payroll/runs', owner.cookie, { payrollPeriodId: owner.period });
        expect(result.status).toBe(201);
        const row = result.data as Record<string, unknown>;
        expect(row.payrollPeriodId).toBe(owner.period); expect(row.runNumber).toBe(replay + 2);
        expect(row.status).toBe('DRAFT');
      }
    }
  });

  it('owned zero-value exports, file names, self PDF and replay leave arithmetic/date/status intact', async () => {
    for (const [type, body] of [['bank-transfer', { bankFormat: 'GENERIC' }], ['journal', { format: 'CSV' }], ['sso-filing', {}], ['pit-filing', {}]] as const) {
      const path = `/api/payroll/runs/${a.run}/export/${type}`;
      const exported = await call('POST', path, a.cookie, body);
      expect(exported.status).toBe(200);
      const url = (exported.data as Record<string, unknown>).filePath as string;
      expect(url.includes(a.run)).toBe(true);
      const filename = url.slice(url.lastIndexOf('/') + 1);
      files.add(join(APP, 'uploads/payroll-exports', filename));
      expect((await call('GET', url, a.cookie)).status).toBe(200);
      expect((await call('GET', url, b.cookie)).status).toBe(403);
      const replayed = await call('POST', path, a.cookie, body);
      expect(replayed.status).toBe(200);
      const replayUrl = (replayed.data as Record<string, unknown>).filePath as string;
      expect(replayUrl.includes(a.run)).toBe(true);
      files.add(join(APP, 'uploads/payroll-exports', replayUrl.slice(replayUrl.lastIndexOf('/') + 1)));
    }
    const filename = `payslip_${a.run}_${a.employee}.pdf`, path = join(APP, 'uploads/payroll-payslips', filename);
    expect(existsSync(path)).toBe(false);
    mkdirSync(join(APP, 'uploads/payroll-payslips'), { recursive: true });
    writeFileSync(path, '%PDF-1.4\nZZ TEST private ownership marker\n'); files.add(path);
    expect((await call('GET', '/api/payroll/payslip-files/' + filename, staffCookie)).status).toBe(200);
    expect((await call('GET', '/api/payroll/payslip-files/' + filename, b.cookie)).status).toBe(403);
    expect((await call('GET', '/api/payroll/payslip-files/' + `payslip_${b.run}_${a.employee}.pdf`, staffCookie)).status).toBe(403);
    expect((await call('GET', '/api/payroll/exports/bank-transfers/not-a-run.csv', a.cookie)).status).toBe(400);
    const summary = (await q('select gross_pay,net_pay from payroll_employee_summaries where payroll_run_id=$1 and employee_id=$2', [a.run, a.employee]))[0];
    expect(Number(summary.gross_pay)).toBe(0); expect(Number(summary.net_pay)).toBe(0);
    expect((await q('select status from payroll_runs where id=$1', [a.run]))[0].status).toBe('DRAFT');
    expect((await q('select start_date::text,end_date::text from payroll_periods where id=$1', [a.period]))[0]).toEqual({ start_date: '2099-01-01', end_date: '2099-01-31' });
    proof.files = true;
  }, 90_000);

  it('FINDING 1 (high): mixed payslip employee/period children are refused; prescribed fix: include payslips in whole-run ownership and require its period to match the run parent', async () => {
    const slips: string[] = [];
    try {
      const results: number[] = [];
      let correctParents = true;
      for (const [period, employee] of [[b.period, a.employee], [a.period, b.employee]]) {
        const slip = (await q("insert into payslips(payroll_run_id,payroll_period_id,employee_id,slip_number,issued_at,slip_data) values($1,$2,$3,'ZZ TEST Mixed Slip',now(),'{}') returning id", [a.run, period, employee]))[0].id as string;
        slips.push(slip);
        const row = (await q('select payroll_run_id,payroll_period_id,employee_id from payslips where id=$1', [slip]))[0];
        correctParents &&= row.payroll_run_id === a.run && row.payroll_period_id === period && row.employee_id === employee;
        results.push((await call('GET', '/api/payroll/payslips/' + slip, a.cookie)).status);
        await q('delete from payslips where id=$1', [slip]);
      }
      proof.mixedSlip = { statuses: results, correctParents };
      expect(results).toEqual([403, 403]);
    } finally { await q('delete from payslips where id=any($1)', [slips]); }
  });

  it('mixed payslip probe uses the owned run plus genuine foreign employee/period parents', () => {
    const pin = proof.mixedSlip as { correctParents: boolean; statuses: number[] };
    expect(pin.correctParents).toBe(true); expect(pin.statuses.every((status) => status === 200 || status === 403)).toBe(true);
  });

  it('a profile using another operator inside the same park remains available to that park admin', async () => {
    const operator = (await q("insert into operators(tenant_id,name) values($1,'ZZ TEST Other Owned Operator') returning id", [a.tenant]))[0].id as string;
    await q('insert into employee_payroll_profiles(tenant_id,operator_id,employee_id) values($1,$2,$3)', [a.tenant, operator, a.employee]);
    try {
      expect((await call('GET', `/api/payroll/employees/${a.employee}/profile`, a.cookie)).status).toBe(200);
      expect((await call('GET', '/api/payroll/runs/' + a.run, a.cookie)).status).toBe(200);
    } finally { await q('delete from employee_payroll_profiles where employee_id=$1', [a.employee]); await q('delete from operators where id=$1', [operator]); }
  });

  it('FINDING 2 (medium): a profile with a foreign operator is refused; prescribed fix: require profile operator ownership without requiring the same in-park operator', async () => {
    await q('insert into employee_payroll_profiles(tenant_id,operator_id,employee_id) values($1,$2,$3)', [a.tenant, b.operator, a.employee]);
    try {
      const result = await call('GET', '/api/payroll/employees/' + a.employee + '/profile', a.cookie);
      const run = await call('GET', '/api/payroll/runs/' + a.run, a.cookie);
      proof.profile = { profile: result.status, run: run.status, foreignOperator: (await q('select operator_id from employee_payroll_profiles where employee_id=$1', [a.employee]))[0].operator_id === b.operator };
      expect([result.status, run.status]).toEqual([403, 403]);
    } finally { await q('delete from employee_payroll_profiles where employee_id=$1', [a.employee]); }
  });

  it('profile probe keeps employee/profile tenants owned while only its operator is foreign', () => {
    const pin = proof.profile as { foreignOperator: boolean; profile: number; run: number };
    expect(pin.foreignOperator).toBe(true); expect([200, 403]).toContain(pin.profile); expect([200, 403]).toContain(pin.run);
  });

  it('new profiles stamp caller ownership and resolved operator without requiring a user operator context', async () => {
    const user = await call('GET', '/api/user', a.cookie);
    expect((user.data as Record<string, unknown>).operatorId).toBeNull();
    try {
      const path = `/api/payroll/employees/${a.employee}/profile`;
      expect((await call('POST', path, a.cookie, { operatorId: b.operator })).status).toBe(403);
      expect((await call('POST', path, a.cookie, { operatorId: a.operator, tenantId: b.tenant })).status).toBe(403);
      expect((await q('select count(*)::int as count from employee_payroll_profiles where employee_id=$1', [a.employee]))[0].count).toBe(0);
      const own = await call('POST', path, a.cookie, { operatorId: a.operator });
      expect(own.status).toBe(201);
      const row = own.data as Record<string, unknown>;
      expect(row.tenantId).toBe(a.tenant); expect(row.operatorId).toBe(a.operator); expect(row.employeeId).toBe(a.employee);
      expect((await call('GET', path, a.cookie)).status).toBe(200);
      expect((await call('GET', '/api/payroll/runs/' + a.run, a.cookie)).status).toBe(200);
    } finally { await q('delete from employee_payroll_profiles where employee_id=$1', [a.employee]); }
  });

  it('FINDING 3 (medium): statutory doors refuse foreign operator/branch links; prescribed fix: park-check both parents on writes, lists and existing record access for every payroll admin', async () => {
    const created: string[] = [];
    try {
      const statuses: number[] = [], historicalStatuses: number[] = [], listStatuses: number[] = [], removedStatuses: number[] = [];
      let listSafe = true;
      for (const [operatorId, branchId] of [[b.operator, a.branch], [a.operator, b.branch]]) {
        const data = { countryCode: 'TH', name: 'ZZ TEST Foreign Statutory Links', effectiveFrom: '2099-01-01', rules: {}, operatorId, branchId };
        const result = await call('POST', '/api/payroll/statutory-rule-sets', a.cookie, data);
        if (result.status === 201) created.push((result.data as Record<string, unknown>).id as string);
        const own = await call('POST', '/api/payroll/statutory-rule-sets', a.cookie, { ...data, operatorId: a.operator, branchId: a.branch });
        expect(own.status).toBe(201); created.push((own.data as Record<string, unknown>).id as string);
        const id = created.at(-1)!;
        const updated = await call('PUT', '/api/payroll/statutory-rule-sets/' + id, a.cookie, { operatorId, branchId });
        await q('update statutory_rule_sets set operator_id=$1,branch_id=$2 where id=$3', [operatorId, branchId, id]);
        const historical = await call('GET', '/api/payroll/statutory-rule-sets/' + id, a.cookie);
        const list = await call('GET', '/api/payroll/statutory-rule-sets', a.cookie);
        listSafe &&= list.status === 403 || (list.status === 200 && !(list.data as Record<string, unknown>[]).some((row) => row.id === id));
        const removed = await call('DELETE', '/api/payroll/statutory-rule-sets/' + id, a.cookie);
        statuses.push(result.status, updated.status, historical.status, removed.status);
        historicalStatuses.push(historical.status); listStatuses.push(list.status); removedStatuses.push(removed.status);
        await q('delete from statutory_rule_sets where id=$1', [id]);
      }
      proof.rules = { own: 201, historicalStatuses, listStatuses, removedStatuses };
      expect(statuses.every((status) => status === 403 || status === 404) && listSafe).toBe(true);
    } finally { for (const id of created) await q('delete from statutory_rule_sets where id=$1', [id]); }
  });

  it('statutory-link probe first creates the same own-parent rule shape successfully', () => {
    const pin = proof.rules as { own: number; historicalStatuses: number[]; listStatuses: number[]; removedStatuses: number[] };
    expect(pin.own).toBe(201); expect(pin.historicalStatuses).toHaveLength(2);
    expect(pin.historicalStatuses.every((status) => [200, 403, 404].includes(status))).toBe(true);
    expect(pin.listStatuses.every((status) => [200, 403].includes(status))).toBe(true);
    expect(pin.removedStatuses.every((status) => [200, 204, 403, 404].includes(status))).toBe(true);
  });

  it('FINDING 4 (high): an own employee lookup never returns another park advance; prescribed fix: scope advance tenant/operator ownership or refuse an inconsistent set', async () => {
    const ids: string[] = [];
    try {
      ids.push((await q("insert into salary_advances(tenant_id,operator_id,employee_id,principal_amount,issued_date,repayment_type,remaining_balance,status) values($1,$2,$3,0,'2099-01-01','FIXED_AMOUNT',0,'CLOSED') returning id", [a.tenant, a.operator, a.employee]))[0].id as string);
      const own = await call('GET', `/api/payroll/employees/${a.employee}/advances`, a.cookie);
      expect(own.status).toBe(200); expect((own.data as Record<string, unknown>[]).map((row) => row.id)).toEqual(ids);
      for (const [tenant, operator] of [[b.tenant, b.operator], [a.tenant, b.operator], [b.tenant, a.operator]]) {
        ids.push((await q("insert into salary_advances(tenant_id,operator_id,employee_id,principal_amount,issued_date,repayment_type,remaining_balance,status) values($1,$2,$3,0,'2099-01-01','FIXED_AMOUNT',0,'CLOSED') returning id", [tenant, operator, a.employee]))[0].id as string);
      }
      const result = await call('GET', '/api/payroll/employees/' + a.employee + '/advances', a.cookie);
      const rows = Array.isArray(result.data) ? result.data : [];
      proof.advances = { own: own.status, status: result.status, count: rows.length, ownPresent: rows.some((row) => row.id === ids[0]), foreignPresent: rows.some((row) => row.id === ids[1]) };
      expect(result.status === 403 || (result.status === 200 && rows.every((row) => row.tenantId === a.tenant && row.operatorId === a.operator))).toBe(true);
    } finally { await q('delete from salary_advances where id=any($1)', [ids]); }
  });

  it('advance read uses CLOSED zero-value fixtures only, with no repayments/calculation', () => {
    expect((proof.advances as { own: number }).own).toBe(200);
    if ((proof.advances as { status: number }).status === 200) expect((proof.advances as { ownPresent: boolean }).ownPresent).toBe(true);
    expect((proof.advances as { status: number }).status === 200 || (proof.advances as { status: number }).status === 403).toBe(true);
    expect(proof.parents).toBe(true); expect(proof.files).toBe(true);
  });

  it('FINDING 5 (medium): run reads refuse foreign reconciliation/exception branches; prescribed fix: park-check required/optional branch parents in the whole-run guard', async () => {
    const reconciliation = (await q("insert into payroll_day_reconciliations(payroll_run_id,employee_id,branch_id,work_date) values($1,$2,$3,'2099-01-01') returning id", [a.run, a.employee, a.branch]))[0].id as string;
    const exception = (await q("insert into payroll_exceptions(payroll_run_id,employee_id,branch_id,exception_type,severity,message) values($1,$2,$3,'MISSING_PUNCH','INFO','ZZ TEST Branch Parent') returning id", [a.run, a.employee, a.branch]))[0].id as string;
    try {
      const own = [await call('GET', `/api/payroll/runs/${a.run}/reconciliations`, a.cookie), await call('GET', '/api/payroll/exceptions/' + exception, a.cookie)];
      expect(own.map((row) => row.status)).toEqual([200, 200]);
      await q('update payroll_day_reconciliations set branch_id=$1 where id=$2', [b.branch, reconciliation]);
      const recon = await call('GET', `/api/payroll/runs/${a.run}/reconciliations`, a.cookie);
      await q('update payroll_day_reconciliations set branch_id=$1 where id=$2', [a.branch, reconciliation]);
      await q('update payroll_exceptions set branch_id=$1 where id=$2', [b.branch, exception]);
      const exceptional = await call('GET', '/api/payroll/exceptions/' + exception, a.cookie);
      proof.branches = { own: own.map((row) => row.status), statuses: [recon.status, exceptional.status] };
      expect([recon.status, exceptional.status]).toEqual([403, 403]);
    } finally {
      await q('delete from payroll_day_reconciliations where id=$1', [reconciliation]);
      await q('delete from payroll_exceptions where id=$1', [exception]);
    }
  });

  it('branch probes reach the same owned run and employee before only the branch parent changes', () => {
    const pin = proof.branches as { own: number[]; statuses: number[] };
    expect(pin.own).toEqual([200, 200]); expect(pin.statuses.every((status) => status === 200 || status === 403)).toBe(true);
  });

  it('FINDING 6 (high): an owned operator never exposes or updates another park policy; prescribed fix: check the policy tenant before the existing policy read/update', async () => {
    const policy = (await q('insert into payroll_policy_settings(tenant_id,operator_id) values($1,$2) returning id', [a.tenant, a.operator]))[0].id as string;
    try {
      const own = await call('GET', '/api/payroll/policy?operatorId=' + a.operator, a.cookie);
      expect(own.status).toBe(200); expect((own.data as Record<string, unknown>).tenantId).toBe(a.tenant);
      await q('update payroll_policy_settings set tenant_id=$1 where id=$2', [b.tenant, policy]);
      const read = await call('GET', '/api/payroll/policy?operatorId=' + a.operator, a.cookie);
      const write = await call('POST', '/api/payroll/policy', a.cookie, { operatorId: a.operator });
      proof.policy = { own: own.status, read: read.status, write: write.status, foreignParent: (await q('select tenant_id from payroll_policy_settings where id=$1', [policy]))[0].tenant_id === b.tenant };
      expect([read.status, write.status]).toEqual([403, 403]);
    } finally { await q('delete from payroll_policy_settings where id=$1', [policy]); }
  });

  it('policy probe uses an existing own operator and a genuine foreign policy tenant', () => {
    const pin = proof.policy as { own: number; read: number; write: number; foreignParent: boolean };
    expect(pin.own).toBe(200); expect(pin.foreignParent).toBe(true); expect([200, 403]).toContain(pin.read); expect([200, 403]).toContain(pin.write);
  });

  it('FINDING 7 (medium): country rules never return another park custom configuration; prescribed fix: pass caller ownership to the country rule lookup while preserving its date selection and rule values', async () => {
    const marker = 'ZZ TEST private payroll rule ' + randomUUID();
    const rule = (await q("insert into statutory_rule_sets(tenant_id,country_code,name,effective_from,rules) values($1,'TH','ZZ TEST Country Rule','2099-03-01',$2) returning id", [a.tenant, JSON.stringify({ parkMarker: marker })]))[0].id as string;
    try {
      const path = '/api/payroll/statutory-rules/TH?asOfDate=2099-03-15';
      const own = await call('GET', path, a.cookie), foreign = await call('GET', path, b.cookie);
      proof.country = { own: own.status, ownMarker: (own.data as Record<string, unknown> | null)?.parkMarker === marker, foreign: foreign.status, foreignMarker: (foreign.data as Record<string, unknown> | null)?.parkMarker === marker };
      expect(own.status).toBe(200); expect((own.data as Record<string, unknown>).parkMarker).toBe(marker);
      expect(foreign.status === 404 || (foreign.status === 200 && (foreign.data as Record<string, unknown>).parkMarker !== marker)).toBe(true);
    } finally { await q('delete from statutory_rule_sets where id=$1', [rule]); }
  });

  it('country rule probe reaches an owned custom configuration at the same explicit date', () => {
    const pin = proof.country as { own: number; ownMarker: boolean; foreign: number };
    expect(pin.own).toBe(200); expect(pin.ownMarker).toBe(true); expect([200, 404]).toContain(pin.foreign);
  });

  it('exception and rule record doors enforce their foreign parent before any action', async () => {
    const exception = (await q("insert into payroll_exceptions(payroll_run_id,employee_id,exception_type,severity,message) values($1,$2,'MISSING_PUNCH','INFO','ZZ TEST Foreign Record') returning id", [a.run, a.employee]))[0].id as string;
    const rule = (await q("insert into statutory_rule_sets(tenant_id,operator_id,branch_id,country_code,name,effective_from,rules) values($1,$2,$3,'TH','ZZ TEST Owned Rule','2099-01-01','{}') returning id", [a.tenant, a.operator, a.branch]))[0].id as string;
    try {
      expect((await call('GET', '/api/payroll/exceptions/' + exception, a.cookie)).status).toBe(200);
      expect((await call('GET', '/api/payroll/statutory-rule-sets/' + rule, a.cookie)).status).toBe(200);
      for (const [method, path, body] of [
        ['GET', '/exceptions/' + exception, undefined], ['POST', '/exceptions/' + exception + '/approve', {}], ['POST', '/exceptions/' + exception + '/reject', {}],
        ['GET', '/statutory-rule-sets/' + rule, undefined], ['PUT', '/statutory-rule-sets/' + rule, { name: 'ZZ TEST Refused Update' }], ['DELETE', '/statutory-rule-sets/' + rule, undefined],
      ] as const) expect((await call(method, '/api/payroll' + path, b.cookie, body)).status).toBe(403);
      expect((await q('select status from payroll_exceptions where id=$1', [exception]))[0].status).toBe('OPEN');
      for (const path of ['/api/payroll/statutory-rules?country=TH', '/api/payroll/statutory-rule-sets']) {
        const result = await call('GET', path, b.cookie); expect(result.status).toBe(200);
        expect((result.data as Record<string, unknown>[]).every((row) => row.tenantId === b.tenant)).toBe(true);
      }
    } finally { await q('delete from payroll_exceptions where id=$1', [exception]); await q('delete from statutory_rule_sets where id=$1', [rule]); }
  });

  it('advance create retains its inherited no-write result and the repayment recorder has one consumer, the calculation', async () => {
    const response = await call('POST', '/api/payroll/advances', a.cookie, { employeeId: a.employee, amount: 1, issuedDate: '2099-01-01', reason: 'ZZ TEST Mapper Control' });
    expect(response.status).toBe(500);
    expect((await q('select count(*)::int as count from salary_advances where employee_id=$1', [a.employee]))[0].count).toBe(0);
    // The repayment ledger has no current HTTP, private PDF or export reader.
    // This census does not declare unused helpers to be exercised crossings.
    const files = ['routes.ts', 'payroll-calculation.ts', 'payroll-payslip.ts', 'payroll-exports.ts', 'payroll-reconciliation.ts', 'payroll-statutory.ts'];
    const source = files.map((name) => readFileSync(join(APP, 'server', name), 'utf8')).join('\n');
    expect([...source.matchAll(/getSalaryAdvanceRepayments\s*\(/g)]).toHaveLength(0);
    // SCRUM-276: the definition and its one call inside the payroll calculation.
    expect([...source.matchAll(/recordAdvanceRepayment\s*\(/g)]).toHaveLength(2);
  });

  it('arithmetic service source remains byte-identical to the reviewed base outside the country lookup ownership wrapper', () => {
    // Per-file fingerprints were ground-truthed with git before this review;
    // no salary, statutory, export or date algorithm is edited by the slice.
    for (const [name, fingerprint] of Object.entries(serviceFingerprints)) {
      let current = readFileSync(join(REPO, 'apps/oto-app/server', name), 'utf8').replace(/\r\n/g, '\n');
      if (name === 'payroll-statutory.ts') {
        // These exact binding aliases retain the imported module and calculation text.
        // No other source changes are normalized away.
        for (const binding of ['statutoryRuleSets', 'statutoryCalculationResults', 'payrollLineItems', 'payrollEmployeeSummaries', 'and', 'eq', 'lte', 'gte', 'isNull', 'or']) {
          current = current.replace(`${binding} as _${binding}`, binding);
        }
        current = current.replace(/\nvoid getDefaultThailandRules;\n\n?/, '\n');
        const withoutLookup = (source: string) => {
          const start = source.indexOf('export async function getStatutoryRules('), end = source.indexOf('export async function seedThailandRulesPublic(');
          expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
          return source.slice(0, start) + source.slice(end);
        };
        // FINDING 7 exercises the complete lookup wrapper over HTTP separately.
        // Its tenant context can change while every calculation/seed value stays pinned.
        current = withoutLookup(current);
      }
      expect(createHash('sha256').update(current).digest('hex')).toBe(fingerprint);
    }
  });
});
