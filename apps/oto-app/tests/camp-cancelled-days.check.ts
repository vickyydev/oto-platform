// seed: its own, disposable ZZ TEST rows; the caller supplies a migrated scratch database.
// Not a Playwright file: it boots the app's real routes (tests/harness/serve-routes.ts).
//
// SCRUM-600 — a camp day staff cancelled is not a day parents can pick:
//   - the public form's day list leaves cancelled days out and lists each
//     open day once (client/src/lib/camp-days.ts, used by camp-register.tsx);
//   - a new sign-up that picks a cancelled day is refused (409) and saves nothing;
//   - adding dates that picks a newly cancelled day is refused and changes nothing;
//   - adding dates still works when the registration already holds a day that
//     was cancelled later (old saved days are left for staff to review).
//
// Run from apps/oto-app: DATABASE_URL=<scratch> npx tsx tests/camp-cancelled-days.check.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseISO, eachDayOfInterval, format } from 'date-fns';
import { campDaysForParents } from '../client/src/lib/camp-days';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=otoapp' });
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;
const sessionSecret = randomBytes(24).toString('hex');
const run = randomBytes(4).toString('hex');
const results: Record<string, boolean> = {};
const failures: Record<string, string> = {};
let origin = '';
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
async function post(path: string, body: unknown, grant?: string) {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(grant ? { 'x-camp-family-grant': grant } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

const days = { mon: '2099-01-05', tue: '2099-01-06', wed: '2099-01-07', thu: '2099-01-08' };
const phone = '+66 81 600 ' + String(1000 + (parseInt(run, 16) % 9000));

try {
  await check('formList', () => {
    const campDays = eachDayOfInterval({ start: parseISO(days.mon), end: parseISO(days.thu) });
    const shown = (list: Date[]) => list.map((day) => format(day, 'yyyy-MM-dd'));
    const fresh = campDaysForParents(campDays, [days.tue, days.thu]);
    assert.deepEqual(shown(fresh.available), [days.mon, days.wed], 'a new sign-up lists only open days');
    assert.equal(new Set(shown(fresh.available)).size, fresh.available.length, 'each day listed once');
    const adding = campDaysForParents(campDays, [days.tue, days.thu], [days.mon]);
    assert.deepEqual(shown(adding.open), [days.mon, days.wed]);
    assert.deepEqual(shown(adding.available), [days.wed], 'adding dates lists open days not yet registered');
    assert.deepEqual(shown(campDaysForParents(campDays, null).available), Object.values(days));
  });

  const tenant = (
    await q('insert into tenants(name,slug) values($1,$2) returning id', ['ZZ TEST camp days', 'zz-camp-days-' + run])
  )[0].id;
  const branch = (
    await q("insert into branches(tenant_id,name,address) values($1,'ZZ TEST camp days','ZZ TEST address') returning id", [
      tenant,
    ])
  )[0].id;
  const eventId = (
    await q(
      "insert into core_events(tenant_id,branch_id,event_type,title,event_date,start_time,camp_end_date,camp_cancelled_days) values($1,$2,'camp','ZZ TEST camp days',$3,'10:00',$4,$5::jsonb) returning id",
      [tenant, branch, days.mon, days.thu, JSON.stringify([days.tue])],
    )
  )[0].id;

  const start = spawn(process.execPath, [join(appDir, 'node_modules/tsx/dist/cli.mjs'), 'tests/harness/serve-routes.ts'], {
    cwd: appDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      APP_ENV: 'dev',
      STORAGE_ENV_PREFIX: 'zz-camp-days',
      OBJECT_STORAGE: 'local',
      DEPLOY_ENV: 'local',
      OTOAPP_LEGACY_LOGIN: 'true',
      OTOAPP_JOBS: 'platform',
      USE_AWS_REKOGNITION: 'false',
      LOG_LEVEL: 'warn',
      SESSION_SECRET: sessionSecret,
      SESSION_PEPPER: randomBytes(24).toString('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = start;
  origin = await new Promise<string>((resolve, reject) => {
    let output = '';
    const scrub = () => output.slice(-3000).replaceAll(process.env.DATABASE_URL ?? '[absent]', '[database]');
    const timer = setTimeout(() => reject(new Error('Camp days harness start timed out: ' + scrub())), 180000);
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
      reject(new Error('Camp days harness exited before listening: ' + scrub()));
    });
  });

  const registration = (childFullName: string, attendanceDays: string[], extra: Record<string, unknown> = {}) => ({
    eventId,
    childFullName,
    dateOfBirth: '2018-01-01',
    parentContacts: [{ name: 'ZZ TEST parent', phone }],
    authorizedPickupPersons: 'ZZ TEST pickup',
    attendanceDays,
    agreedCampRules: true,
    agreedChildHealthy: true,
    parentSignature: 'ZZ TEST signature',
    signatureDate: '2099-01-01',
    ...extra,
  });
  const rowsFor = (name: string) =>
    q('select id, attendance_days from camp_registrations where event_id=$1 and child_full_name=$2', [eventId, name]);

  await check('newSignUpRefused', async () => {
    const name = 'ZZ TEST refused ' + run;
    const answer = await post('/api/public/camp-registrations/batch', {
      registrations: [registration(name, [days.mon, days.tue])],
    });
    assert.equal(answer.status, 409, JSON.stringify(answer.data));
    assert.equal(answer.data?.message, 'One of the chosen days has been cancelled. Please refresh and choose again.');
    assert.equal((await rowsFor(name)).length, 0, 'nothing saved');
  });

  const savedName = 'ZZ TEST saved ' + run;
  let savedId = '';
  await check('newSignUpOpenDays', async () => {
    const answer = await post('/api/public/camp-registrations/batch', {
      registrations: [registration(savedName, [days.mon])],
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    const rows = await rowsFor(savedName);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].attendance_days, [days.mon]);
    savedId = rows[0].id;
  });

  // Later, staff cancel Monday too, a day already saved on this registration.
  await q('update core_events set camp_cancelled_days=$2::jsonb where id=$1', [
    eventId,
    JSON.stringify([days.mon, days.tue]),
  ]);
  // A verified family grant for the add-dates form, made here: no message is sent.
  const grant = randomBytes(32).toString('hex');
  await q(
    "insert into camp_family_challenges(tenant_id,event_id,phone,phone_e164,provider_id,state,registration_ids,grant_hash,grant_purpose,expires_at) values($1,$2,$3,$4,'zz-test','verified',$5::jsonb,$6,'write',now()+interval '10 minutes')",
    [
      tenant,
      eventId,
      phone,
      phone.replaceAll(' ', ''),
      JSON.stringify([savedId]),
      createHmac('sha256', sessionSecret).update('camp-family:' + grant).digest('hex'),
    ],
  );

  await check('addDatesCancelledRefused', async () => {
    const answer = await post(
      '/api/public/camp-registrations/batch',
      { registrations: [registration(savedName, [days.tue], { existingRegistrationId: savedId })] },
      grant,
    );
    assert.equal(answer.status, 409, JSON.stringify(answer.data));
    assert.deepEqual((await rowsFor(savedName))[0].attendance_days, [days.mon], 'unchanged');
  });

  await check('addDatesKeepsOldSavedDay', async () => {
    const answer = await post(
      '/api/public/camp-registrations/batch',
      { registrations: [registration(savedName, [days.mon, days.wed], { existingRegistrationId: savedId })] },
      grant,
    );
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.deepEqual((await rowsFor(savedName))[0].attendance_days, [days.mon, days.wed]);
  });

  if (
    ['formList', 'newSignUpRefused', 'newSignUpOpenDays', 'addDatesCancelledRefused', 'addDatesKeepsOldSavedDay'].some(
      (name) => results[name] !== true,
    )
  )
    process.exitCode = 1;
  console.log('CAMP_CANCELLED_DAYS_RESULTS=' + JSON.stringify({ results, failures }));
} finally {
  child?.kill();
  await pool.end();
}
