// seed: its own, disposable ZZ TEST rows; the caller supplies a migrated scratch database.
// Not a Playwright file: it boots the app's real routes (tests/harness/serve-routes.ts).
//
// SCRUM-836 — a party has a start time; the routes' half (the BEO form's is
// tests/event-start-time-ui.check.ts). `core_events.start_time` is NOT NULL,
// yet the event routes wrote whatever they were sent: an empty string emptied
// the column and a null answered 500.
//
//   - the rule on its own (shared/eventStartTime.ts): a start that is named is
//     HH:MM on the 24-hour clock; nothing, "" and anything else are refused in
//     plain words; a value sent back exactly as the event holds it is no change;
//   - POST /api/admin/events without a start, or with "" or a word, is a 400
//     in words and makes nothing;
//   - PATCH /api/admin/events/:id with startTime null, "" or a malformed value
//     is a 400 in words — never a 500 — and the party keeps its time; a clock
//     time is written; the other fields of the same body are not written by a
//     refused save;
//   - PUT /api/events/:id/beo (the BEO form's Save) the same, under `event`;
//   - a row from before the rule that already holds an empty start (the one
//     SCRUM-827's one-pass fill answers `no_start_time` for) still saves its
//     other fields when the form echoes the empty start, is not given a time
//     by anyone, cannot be nulled, and takes a real time when one is set.
//
// Run from apps/oto-app: DATABASE_URL=<scratch> npx tsx tests/event-start-time.check.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  EVENT_NEEDS_START_TIME,
  PARTY_NEEDS_START_TIME,
  START_TIME_NOT_A_TIME,
  isStartTime,
  needsStartTimeLine,
  refuseStartTime,
} from '../shared/eventStartTime';

const appDir = fileURLToPath(new URL('../', import.meta.url));
if (!process.env.DATABASE_URL) {
  console.error('event-start-time.check: DATABASE_URL is not set');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=otoapp' });
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;
const run = randomBytes(4).toString('hex');
const PASSWORD = 'zz-test-password';
let origin = '';
let cookie = '';
let child: ReturnType<typeof spawn> | undefined;
let checks = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
}
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}
const stored = async (eventId: string) =>
  (await q('select start_time, end_time, title, activities from core_events where id=$1', [eventId]))[0] as {
    start_time: string;
    end_time: string | null;
    title: string;
    activities: string | null;
  };

try {
  await check('the rule on its own: a clock time or a refusal in words; the held value echoed is no change', () => {
    for (const ok of ['00:00', '09:30', '14:00', '23:59']) assert.equal(isStartTime(ok), true, ok);
    for (const bad of ['', ' ', '24:00', '9:30', '14:60', '14.00', '2pm', '14:00:00', ' 14:00', null, undefined, 14, {}]) {
      assert.equal(isStartTime(bad), false, String(bad));
    }
    // Not named: nothing to refuse on an event that exists; an event being made must name one.
    assert.equal(refuseStartTime(undefined, '14:00'), null);
    assert.equal(refuseStartTime(undefined, undefined), PARTY_NEEDS_START_TIME);
    // Nothing and blank: the party's line; a camp's is the event's.
    for (const blank of [null, '', '   ']) assert.equal(refuseStartTime(blank, '14:00', 'birthday'), PARTY_NEEDS_START_TIME);
    assert.equal(refuseStartTime(null, '10:00', 'camp'), EVENT_NEEDS_START_TIME);
    assert.equal(needsStartTimeLine('private_event'), PARTY_NEEDS_START_TIME);
    assert.equal(needsStartTimeLine('school_group'), PARTY_NEEDS_START_TIME);
    assert.equal(needsStartTimeLine('workshop'), EVENT_NEEDS_START_TIME);
    assert.equal(needsStartTimeLine(undefined), PARTY_NEEDS_START_TIME);
    // Anything else: not a time.
    for (const bad of ['2pm', '25:00', '9:30', '14:00:00', 14, true, { h: 14 }]) assert.equal(refuseStartTime(bad, '14:00'), START_TIME_NOT_A_TIME);
    // A clock time is taken.
    assert.equal(refuseStartTime('15:30', '14:00'), null);
    assert.equal(refuseStartTime('15:30', undefined), null);
    // The held value sent back is no change: a row from before the rule still saves its other fields.
    assert.equal(refuseStartTime('', ''), null);
    assert.equal(refuseStartTime('9:30', '9:30'), null);
    // But an empty start is never WRITTEN over a time, and an event is never made with one.
    assert.equal(refuseStartTime('', '14:00'), PARTY_NEEDS_START_TIME);
    assert.equal(refuseStartTime('', undefined), PARTY_NEEDS_START_TIME);
  });

  const tenant = (await q('insert into tenants(name,slug) values($1,$2) returning id', ['ZZ TEST start time', 'zz-start-time-' + run]))[0].id;
  const branch = (
    await q(
      "insert into branches(tenant_id,name,address,timezone) values($1,'ZZ TEST start time','ZZ TEST address','Asia/Bangkok') returning id",
      [tenant],
    )
  )[0].id;
  const email = `zz-start-time-${run}@example.com`;
  const salt = randomBytes(16).toString('hex');
  const userId = randomUUID();
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, 'ZZ TEST start time admin', 'admin', true, false)`,
    [userId, email, `${scryptSync(PASSWORD, salt, 64).toString('hex')}.${salt}`],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, userId]);

  const start = spawn(process.execPath, [join(appDir, 'node_modules/tsx/dist/cli.mjs'), 'tests/harness/serve-routes.ts'], {
    cwd: appDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      APP_ENV: 'dev',
      STORAGE_ENV_PREFIX: 'zz-start-time',
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
    const timer = setTimeout(() => reject(new Error('Start time harness start timed out: ' + scrub())), 180000);
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
      reject(new Error('Start time harness exited before listening: ' + scrub()));
    });
  });

  const login = await fetch(origin + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(login.status, 200, `sign-in: ${login.status} ${await login.text()}`);
  cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const partyBody = (title: string, over: Record<string, unknown> = {}) => ({
    eventType: 'birthday',
    title,
    eventDate: '2099-01-02',
    startTime: '14:00',
    endTime: '17:00',
    branchId: branch,
    status: 'upcoming',
    ...over,
  });
  const eventsNamed = async (title: string) => (await q('select count(*)::int as n from core_events where tenant_id=$1 and title=$2', [tenant, title]))[0].n;

  let party = '';
  await check('POST /api/admin/events: no start, "" or a word is a 400 in words and makes nothing; a clock time makes the party', async () => {
    const title = 'ZZ TEST 836 refused ' + run;
    const { startTime: _none, ...noStart } = partyBody(title);
    for (const [body, line] of [
      [noStart, PARTY_NEEDS_START_TIME],
      [partyBody(title, { startTime: null }), PARTY_NEEDS_START_TIME],
      [partyBody(title, { startTime: '' }), PARTY_NEEDS_START_TIME],
      [partyBody(title, { startTime: '2pm' }), START_TIME_NOT_A_TIME],
      [partyBody(title, { eventType: 'camp', startTime: '', campEndDate: '2099-01-05' }), EVENT_NEEDS_START_TIME],
    ] as const) {
      const answer = await call('POST', '/api/admin/events', body);
      assert.equal(answer.status, 400, JSON.stringify(answer.data));
      assert.equal(answer.data.message, line);
    }
    assert.equal(await eventsNamed(title), 0, 'nothing made');
    const made = await call('POST', '/api/admin/events', partyBody('ZZ TEST 836 party ' + run));
    assert.equal(made.status, 201, JSON.stringify(made.data));
    party = made.data.id;
    assert.equal((await stored(party)).start_time, '14:00');
  });

  await check('PATCH /api/admin/events/:id: null, "" and a malformed start are a 400 in words, never a 500; the party keeps its time and the rest of the body is not written', async () => {
    for (const [sent, line] of [
      [null, PARTY_NEEDS_START_TIME],
      ['', PARTY_NEEDS_START_TIME],
      ['  ', PARTY_NEEDS_START_TIME],
      ['2pm', START_TIME_NOT_A_TIME],
      ['25:00', START_TIME_NOT_A_TIME],
      ['9:30', START_TIME_NOT_A_TIME],
      [1400, START_TIME_NOT_A_TIME],
    ] as const) {
      const answer = await call('PATCH', `/api/admin/events/${party}`, { startTime: sent, title: 'ZZ TEST 836 must not be written' });
      assert.equal(answer.status, 400, `${JSON.stringify(sent)} → ${answer.status} ${JSON.stringify(answer.data)}`);
      assert.equal(answer.data.message, line);
    }
    const row = await stored(party);
    assert.equal(row.start_time, '14:00', 'the start is not cleared');
    assert.equal(row.title, 'ZZ TEST 836 party ' + run, 'a refused save writes nothing');
  });

  await check('PATCH /api/admin/events/:id: a clock time is written; the same time sent back and a body that names no start still save', async () => {
    let answer = await call('PATCH', `/api/admin/events/${party}`, { startTime: '15:30' });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.equal(answer.data.startTime, '15:30');
    answer = await call('PATCH', `/api/admin/events/${party}`, { startTime: '15:30', title: 'ZZ TEST 836 renamed ' + run });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    answer = await call('PATCH', `/api/admin/events/${party}`, { activities: 'ZZ TEST games' });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    const row = await stored(party);
    assert.deepEqual([row.start_time, row.title, row.activities], ['15:30', 'ZZ TEST 836 renamed ' + run, 'ZZ TEST games']);
  });

  await check('PUT /api/events/:id/beo (the BEO form\'s Save): the same refusals under `event`, in words; a clock time and a save with no start named are written', async () => {
    for (const [sent, line] of [
      [null, PARTY_NEEDS_START_TIME],
      ['', PARTY_NEEDS_START_TIME],
      ['4 o\'clock', START_TIME_NOT_A_TIME],
      ['24:00', START_TIME_NOT_A_TIME],
    ] as const) {
      const answer = await call('PUT', `/api/events/${party}/beo`, { event: { startTime: sent, activities: 'ZZ TEST must not be written' } });
      assert.equal(answer.status, 400, `${JSON.stringify(sent)} → ${answer.status} ${JSON.stringify(answer.data)}`);
      assert.equal(answer.data.error, line);
    }
    let row = await stored(party);
    assert.deepEqual([row.start_time, row.activities], ['15:30', 'ZZ TEST games'], 'nothing cleared, nothing written');
    let answer = await call('PUT', `/api/events/${party}/beo`, { event: { startTime: '16:00', endTime: '18:00' } });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    // The form with its Start Time emptied sends no start at all (and is stopped before it sends): a body without one saves the rest.
    answer = await call('PUT', `/api/events/${party}/beo`, { event: { activities: 'ZZ TEST treasure hunt' } });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    row = await stored(party);
    assert.deepEqual([row.start_time, row.end_time, row.activities], ['16:00', '18:00', 'ZZ TEST treasure hunt']);
    const read = await call('GET', `/api/events/${party}/beo`);
    assert.equal(read.status, 200);
    assert.equal(read.data.startTime, '16:00');
  });

  await check('a row from before the rule with an empty start: its other fields still save, nobody gives it a time, it cannot be nulled, and it takes a real one', async () => {
    const made = await call('POST', '/api/admin/events', partyBody('ZZ TEST 836 no start yet ' + run));
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const legacy = made.data.id as string;
    await q("update core_events set start_time = '' where id = $1", [legacy]);
    // The Events form and the BEO form echo what the event holds.
    let answer = await call('PATCH', `/api/admin/events/${legacy}`, { startTime: '', title: 'ZZ TEST 836 no start, renamed ' + run });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    answer = await call('PUT', `/api/events/${legacy}/beo`, { event: { startTime: '', activities: 'ZZ TEST legacy games' } });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    let row = await stored(legacy);
    assert.deepEqual([row.start_time, row.title, row.activities], ['', 'ZZ TEST 836 no start, renamed ' + run, 'ZZ TEST legacy games']);
    // The BEO's read still answers it, with no start (what the one-pass fill's `no_start_time` branch reads).
    const read = await call('GET', `/api/events/${legacy}/beo`);
    assert.equal(read.status, 200, JSON.stringify(read.data));
    assert.equal(read.data.startTime, '');
    // Null is still no start.
    answer = await call('PATCH', `/api/admin/events/${legacy}`, { startTime: null });
    assert.equal(answer.status, 400, JSON.stringify(answer.data));
    assert.equal(answer.data.message, PARTY_NEEDS_START_TIME);
    // A real time is taken, and from then on cannot be emptied.
    answer = await call('PUT', `/api/events/${legacy}/beo`, { event: { startTime: '10:00' } });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    answer = await call('PATCH', `/api/admin/events/${legacy}`, { startTime: '' });
    assert.equal(answer.status, 400, JSON.stringify(answer.data));
    row = await stored(legacy);
    assert.equal(row.start_time, '10:00');
  });

  console.log(`event-start-time.check: ${checks} checks passed`);
  if (checks !== 6) process.exitCode = 1;
} catch (error) {
  console.error('event-start-time.check FAILED:', error);
  process.exitCode = 1;
} finally {
  child?.kill();
  await pool.end();
}
