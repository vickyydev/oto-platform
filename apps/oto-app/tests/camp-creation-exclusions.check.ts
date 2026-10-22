// seed: its own, disposable ZZ TEST rows; the caller supplies a migrated scratch database.
// Not a Playwright file: it boots the app's real routes (tests/harness/serve-routes.ts).
//
// SCRUM-655 — leave out weekends or chosen days when creating a camp. The
// Create Camp panel works the left-out days out with campCreationExcludedDays
// (client/src/lib/camp-days.ts) and saves them as the camp's cancelled days,
// the list Cancel Day keeps, so nothing downstream needs new logic:
//   - a Fri-Mon camp created with Skip weekends stores Sat and Sun as cancelled
//     days, and the public form (campDaysForParents over the public camp
//     event) lists only Fri and Mon; a sign-up for the Saturday is refused;
//   - unticking a weekday leaves that day out too;
//   - after creation, Cancel Day and Uncancel still change the days, and a
//     save from the edit panel (which sends no cancelled days) keeps them.
//
// Run from apps/oto-app: DATABASE_URL=<scratch> npx tsx tests/camp-creation-exclusions.check.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseISO, eachDayOfInterval, format } from 'date-fns';
import { campCreationExcludedDays, campDaysForParents } from '../client/src/lib/camp-days';

const appDir = fileURLToPath(new URL('../', import.meta.url));
if (!process.env.DATABASE_URL) {
  console.error('camp-creation-exclusions.check: DATABASE_URL is not set');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=otoapp' });
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;
const run = randomBytes(4).toString('hex');
const PASSWORD = 'zz-test-password';
const results: Record<string, boolean> = {};
const failures: Record<string, string> = {};
let origin = '';
let cookie = '';
let child: ReturnType<typeof spawn> | undefined;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results[name] = true;
  } catch (error) {
    results[name] = false;
    failures[name] = error instanceof Error ? error.message : String(error);
  }
}
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

// 2099-01-02 is a Friday; the camp runs Fri-Mon, a second one Fri-Tue.
const days = { fri: '2099-01-02', sat: '2099-01-03', sun: '2099-01-04', mon: '2099-01-05', tue: '2099-01-06' };
const shown = (list: Date[]) => list.map((day) => format(day, 'yyyy-MM-dd'));

/** What the parents' form offers for a camp, read through its public door. */
async function publicFormDays(eventId: string) {
  const answer = await call('GET', `/api/public/camp-events/${eventId}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.data));
  const campDays = eachDayOfInterval({ start: parseISO(answer.data.eventDate), end: parseISO(answer.data.campEndDate) });
  return shown(campDaysForParents(campDays, answer.data.campCancelledDays).available);
}
const storedCancelled = async (eventId: string) =>
  (await q('select camp_cancelled_days from core_events where id=$1', [eventId]))[0].camp_cancelled_days;

/** The body the Create Camp panel posts (events.tsx), left-out days included. */
const createBody = (branchId: string, title: string, end: string, excluded: string[]) => ({
  eventType: 'camp',
  title,
  eventDate: days.fri,
  campEndDate: end,
  startTime: '10:00',
  endTime: '15:00',
  programName: null,
  specialRequests: null,
  numChildren: null,
  branchId,
  campDayHosts: {},
  ...(excluded.length > 0 ? { campCancelledDays: excluded } : {}),
  status: 'upcoming',
});

try {
  await check('excludedDaysRule', () => {
    assert.deepEqual(campCreationExcludedDays(days.fri, days.mon, true, []), [days.sat, days.sun], 'Skip weekends');
    assert.deepEqual(campCreationExcludedDays(days.fri, days.mon, false, []), [], 'nothing left out by default');
    assert.deepEqual(campCreationExcludedDays(days.fri, days.tue, true, [days.mon]), [days.sat, days.sun, days.mon]);
    assert.deepEqual(campCreationExcludedDays(days.fri, days.mon, false, [days.fri, '2099-02-01']), [days.fri], 'a day outside the range is ignored');
    assert.deepEqual(campCreationExcludedDays(days.mon, days.fri, true, []), [], 'an end before the start leaves nothing out');
  });

  const tenant = (
    await q('insert into tenants(name,slug) values($1,$2) returning id', ['ZZ TEST camp exclusions', 'zz-camp-excl-' + run])
  )[0].id;
  const branch = (
    await q(
      "insert into branches(tenant_id,name,address,timezone) values($1,'ZZ TEST camp exclusions','ZZ TEST address','Asia/Bangkok') returning id",
      [tenant],
    )
  )[0].id;
  const email = `zz-camp-excl-${run}@example.com`;
  const salt = randomBytes(16).toString('hex');
  const userId = randomUUID();
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, 'ZZ TEST camp exclusions admin', 'admin', true, false)`,
    [userId, email, `${scryptSync(PASSWORD, salt, 64).toString('hex')}.${salt}`],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [
    tenant,
    userId,
  ]);

  const start = spawn(process.execPath, [join(appDir, 'node_modules/tsx/dist/cli.mjs'), 'tests/harness/serve-routes.ts'], {
    cwd: appDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      APP_ENV: 'dev',
      STORAGE_ENV_PREFIX: 'zz-camp-excl',
      OBJECT_STORAGE: 'local',
      DEPLOY_ENV: 'local',
      OTOAPP_LEGACY_LOGIN: 'true',
      OTOAPP_JOBS: 'platform',
      USE_AWS_REKOGNITION: 'false',
      LOG_LEVEL: 'warn',
      TZ: 'UTC',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = start;
  origin = await new Promise<string>((resolve, reject) => {
    let output = '';
    const scrub = () => output.slice(-3000).replaceAll(process.env.DATABASE_URL ?? '[absent]', '[database]');
    const timer = setTimeout(() => reject(new Error('Camp exclusions harness start timed out: ' + scrub())), 180000);
    const read = (part: Buffer) => {
      output += part.toString();
      const match = /HARNESS_PORT=(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve('http://127.0.0.1:' + match[1]);
      }
    };
    start.stdout!.on('data', read);
    start.stderr!.on('data', read);
    start.on('exit', () => {
      clearTimeout(timer);
      reject(new Error('Camp exclusions harness exited before listening: ' + scrub()));
    });
  });

  const login = await fetch(origin + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(login.status, 200, `sign-in: ${login.status} ${await login.text()}`);
  cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  let weekendCamp = '';
  await check('skipWeekendsCreate', async () => {
    const excluded = campCreationExcludedDays(days.fri, days.mon, true, []);
    const answer = await call('POST', '/api/admin/events', createBody(branch, 'ZZ TEST skip weekends ' + run, days.mon, excluded));
    assert.equal(answer.status, 201, JSON.stringify(answer.data));
    weekendCamp = answer.data.id;
    assert.deepEqual(await storedCancelled(weekendCamp), [days.sat, days.sun], 'Sat and Sun saved as cancelled days');
    assert.deepEqual(await publicFormDays(weekendCamp), [days.fri, days.mon], 'the public form lists only Fri and Mon');
  });

  await check('skippedDayRefusedOnSignUp', async () => {
    const name = 'ZZ TEST weekend pick ' + run;
    const answer = await call('POST', '/api/public/camp-registrations/batch', {
      registrations: [
        {
          eventId: weekendCamp,
          childFullName: name,
          dateOfBirth: '2018-01-01',
          parentContacts: [{ name: 'ZZ TEST parent', phone: '+66 81 655 ' + String(1000 + (parseInt(run, 16) % 9000)) }],
          authorizedPickupPersons: 'ZZ TEST pickup',
          attendanceDays: [days.fri, days.sat],
          agreedCampRules: true,
          agreedChildHealthy: true,
          parentSignature: 'ZZ TEST signature',
          signatureDate: '2099-01-01',
        },
      ],
    });
    assert.equal(answer.status, 409, JSON.stringify(answer.data));
    assert.equal(
      (await q('select count(*)::int as n from camp_registrations where event_id=$1 and child_full_name=$2', [weekendCamp, name]))[0].n,
      0,
      'nothing saved',
    );
  });

  await check('untickedWeekdayCreate', async () => {
    const excluded = campCreationExcludedDays(days.fri, days.tue, true, [days.mon]);
    const answer = await call('POST', '/api/admin/events', createBody(branch, 'ZZ TEST unticked day ' + run, days.tue, excluded));
    assert.equal(answer.status, 201, JSON.stringify(answer.data));
    assert.deepEqual(await storedCancelled(answer.data.id), [days.sat, days.sun, days.mon]);
    assert.deepEqual(await publicFormDays(answer.data.id), [days.fri, days.tue]);
  });

  await check('noExclusionsCreate', async () => {
    const answer = await call('POST', '/api/admin/events', createBody(branch, 'ZZ TEST every day ' + run, days.mon, []));
    assert.equal(answer.status, 201, JSON.stringify(answer.data));
    assert.equal(await storedCancelled(answer.data.id), null, 'no cancelled days written');
    assert.deepEqual(await publicFormDays(answer.data.id), [days.fri, days.sat, days.sun, days.mon]);
  });

  await check('editAfterCreate', async () => {
    // Cancel Day on the camp page sends the whole list (camp-detail.tsx cancelDayMutation).
    let answer = await call('PATCH', `/api/admin/events/${weekendCamp}`, { campCancelledDays: [days.sat, days.sun, days.mon] });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.deepEqual(await publicFormDays(weekendCamp), [days.fri]);
    // Uncancel brings a skipped weekend day back.
    answer = await call('PATCH', `/api/admin/events/${weekendCamp}`, { campCancelledDays: [days.sun, days.mon] });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.deepEqual(await publicFormDays(weekendCamp), [days.fri, days.sat]);
    // A save from the edit panel sends no cancelled days and keeps them.
    answer = await call('PATCH', `/api/admin/events/${weekendCamp}`, { title: 'ZZ TEST renamed ' + run, startTime: '09:00' });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.deepEqual(await storedCancelled(weekendCamp), [days.sun, days.mon]);
  });

  const names = ['excludedDaysRule', 'skipWeekendsCreate', 'skippedDayRefusedOnSignUp', 'untickedWeekdayCreate', 'noExclusionsCreate', 'editAfterCreate'];
  if (names.some((name) => results[name] !== true)) process.exitCode = 1;
  console.log('CAMP_CREATION_EXCLUSIONS_RESULTS=' + JSON.stringify({ results, failures }));
} catch (error) {
  console.error('camp-creation-exclusions.check FAILED:', error);
  process.exitCode = 1;
} finally {
  child?.kill();
  await pool.end();
}
