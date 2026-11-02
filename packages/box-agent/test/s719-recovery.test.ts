import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { JOURNAL_EPOCH_KEY, JournalEpochAwaitedError, type BoxAgent } from '../src/agent';
import { createBridgeServer } from '../src/runner/bridge-server';
import { main } from '../src/runner/cli';
import { claimBox, startRunner } from '../src/runner/runtime';
import {
  RECEIPT_RESTORE_MARGIN,
  RestoreRefusal,
  TERMINAL_REF_RESTORE_MARGIN,
  restoreStore,
} from '../src/runner/store-restore';
import { generateSyncKeyPair, sealEnvelope } from '../src/signing';
import { StorageHealth } from '../src/storage-health';
import {
  MIRROR_AFTER_UNSENT_MS,
  MIRROR_INTERVAL_MS,
  MIRROR_NAME,
  MIRROR_STUCK_AFTER_MS,
  StoreMirror,
  copyStoreMirror,
  copiesHoldingUnsent,
} from '../src/store-mirror';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import { BOX_ID, fakeBoxCloud, openTestAgent, tillBundle, type TestStore } from './_support';

const OTHER_BOX = '018f0000-0000-7000-8000-00000000b0c6';
const STATION = '018f0000-0000-7000-8000-0000000057a1';
const TERMINAL = '018f0000-0000-7000-8000-00000000ed01';
const noService = async () => {};

/** A box home with an open store, its mirror directory, and helpers to seal facts into it. */
async function box(t: TestContext, boxId: string = BOX_ID) {
  const root = await mkdtemp(join(tmpdir(), 'oto-s719-'));
  const home = join(root, 'home');
  const directory = join(root, 'second-drive');
  await mkdir(home, { recursive: true });
  const database = join(home, 'box.sqlite');
  const db = new DatabaseSync(database);
  prepareSqliteBoxStore(db);
  const keys = generateSyncKeyPair();
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });
  await store.init(boxId);
  const seal = (draft: Parameters<typeof sealEnvelope>[0]) =>
    sealEnvelope(draft, boxId, keys.privateKeyPem);
  const fact = (n: number) =>
    store.enqueue(boxId, { type: 'member.created', payload: { n } }, seal);
  t.after(async () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, directory, database, db, store, seal, fact, boxId, allowSameDevice: true };
}

function open(file: string) {
  return new DatabaseSync(file, { readOnly: true });
}
function rows(file: string): number {
  const db = open(file);
  try {
    return Number(db.prepare('select count(*) as n from box_outbox').get()!.n);
  } finally {
    db.close();
  }
}
const copies = (directory: string) =>
  [MIRROR_NAME, `${MIRROR_NAME}.1`, `${MIRROR_NAME}.2`].map((name) => rows(join(directory, name)));

/** A blank store on a new drive, as an unclaimed runner makes one. */
async function blankHome(root: string, name = 'blank') {
  const home = join(root, name);
  await mkdir(home, { recursive: true });
  const database = join(home, 'box.sqlite');
  const db = new DatabaseSync(database);
  prepareSqliteBoxStore(db);
  db.close();
  return { home, database };
}

// --- M1: a blank store must never eat the copies --------------------------------

test('M1: a blank store on a new drive leaves all three copies alone and says so', async (t) => {
  const f = await box(t);
  for (let n = 1; n <= 5; n++) await f.fact(n);
  // Three agents' worth of first rounds: a running one would not write an unchanged store again.
  for (let round = 0; round < 3; round++) assert.equal(await new StoreMirror(f).run(), 'mirrored');
  assert.deepEqual(copies(f.directory), [5, 5, 5]);
  const before = (await readdir(f.directory)).map((name) => statSync(join(f.directory, name)).mtimeMs);

  const blank = await blankHome(f.root);
  let told = 0;
  const onBlank = new StoreMirror({
    database: blank.database,
    directory: f.directory,
    allowSameDevice: true,
    onFailure: () => {
      told += 1;
    },
  });
  for (let round = 0; round < 3; round++) assert.equal(await onBlank.run(), 'holds_unsent');
  assert.deepEqual(copies(f.directory), [5, 5, 5], 'three rounds on a blank store change nothing');
  assert.deepEqual(
    (await readdir(f.directory)).map((name) => statSync(join(f.directory, name)).mtimeMs),
    before,
  );
  assert.equal(onBlank.problem, 'holds_unsent');
  assert.equal(onBlank.failures, 3, 'each refused round counts as a mirror error');
  assert.equal(told, 3);
  assert.equal((await copiesHoldingUnsent(blank.database, f.directory)), 5);
});

test('M1: a store claimed as a new journal does not replace copies holding what it lacks', async (t) => {
  const f = await box(t);
  await f.fact(1);
  await f.fact(2);
  const mirror = new StoreMirror(f);
  assert.equal(await mirror.run(), 'mirrored');

  // The same box on a blank drive, with its own new facts at the same addresses.
  const other = await blankHome(f.root, 'claimed-first');
  const db = new DatabaseSync(other.database);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });
  await store.init(BOX_ID);
  await store.setEpoch(BOX_ID, 2);
  await store.enqueue(BOX_ID, { type: 'member.created', payload: { fresh: true } }, f.seal);
  const onClaimed = new StoreMirror({ database: other.database, directory: f.directory, allowSameDevice: true });
  assert.equal(await onClaimed.run(), 'holds_unsent');
  db.close();
  assert.equal(rows(join(f.directory, MIRROR_NAME)), 2);
});

test('M1: a blank store with copies holding nothing unsent writes nothing and is not an error', async (t) => {
  const f = await box(t);
  await f.fact(1);
  const mirror = new StoreMirror(f);
  assert.equal(await mirror.run(), 'mirrored');
  // The cloud has it: the row is acknowledged, in the store and in the next copy.
  f.db.exec("update box_outbox set state = 'acked', acked_at = '2026-11-02T00:00:00.000Z'");
  assert.equal(await mirror.run(), 'mirrored');
  const blank = await blankHome(f.root);
  const onBlank = new StoreMirror({ database: blank.database, directory: f.directory, allowSameDevice: true });
  const stamped = statSync(join(f.directory, MIRROR_NAME)).mtimeMs;
  // Two more rounds rotate out the copy that still held the row as unsent.
  f.db.exec("insert into box_runtime (box_id, runtime_key, value, updated_at) values ('" + BOX_ID + "', 'x', '1', '2026-11-02T00:00:00.000Z')");
  assert.equal(await mirror.run(), 'mirrored');
  f.db.exec("insert into box_runtime (box_id, runtime_key, value, updated_at) values ('" + BOX_ID + "', 'y', '1', '2026-11-02T00:00:00.000Z')");
  assert.equal(await mirror.run(), 'mirrored');
  const settled = statSync(join(f.directory, MIRROR_NAME)).mtimeMs;
  assert.ok(settled >= stamped);
  assert.equal(await onBlank.run(), 'nothing_to_copy');
  assert.equal(onBlank.problem, null);
  assert.equal(onBlank.failures, 0);
  assert.equal(statSync(join(f.directory, MIRROR_NAME)).mtimeMs, settled, 'nothing was written');
});

test('M1: a restored store passes the check, and acknowledged rows stay accounted for', async (t) => {
  const f = await box(t);
  await f.fact(1);
  await f.fact(2);
  const mirror = new StoreMirror(f);
  assert.equal(await mirror.run(), 'mirrored');
  // Drained after the copy: unsent in the copy, acknowledged in the store.
  f.db.exec("update box_outbox set state = 'acked', acked_at = '2026-11-02T00:00:00.000Z'");
  await f.fact(3);
  assert.equal(await mirror.run(), 'mirrored');
  assert.deepEqual([rows(join(f.directory, MIRROR_NAME)), rows(join(f.directory, `${MIRROR_NAME}.1`))], [3, 2]);
  // Acknowledged and pruned long after a copy was taken: the journal has passed that
  // address and holds nothing else at it, so the copy holds nothing the store lacks.
  f.db.exec('delete from box_outbox where box_seq = 1');
  assert.equal(await copiesHoldingUnsent(f.database, f.directory), 0);
  await f.fact(4);
  assert.equal(await mirror.run(), 'mirrored');
});

test('M1: a damaged copy holds nothing readable and does not stop the round', async (t) => {
  const f = await box(t);
  await f.fact(1);
  const mirror = new StoreMirror(f);
  assert.equal(await mirror.run(), 'mirrored');
  await writeFile(join(f.directory, `${MIRROR_NAME}.2`), 'not a database at all, and long enough to be read as one');
  await f.fact(2);
  assert.equal(await mirror.run(), 'mirrored');
});

test('M1: an unclaimed runner on a blank drive leaves the copies alone from start to stop', async (t) => {
  const f = await box(t);
  for (let n = 1; n <= 5; n++) await f.fact(n);
  // Three agents' worth of first rounds: a running one would not write an unchanged store again.
  for (let round = 0; round < 3; round++) assert.equal(await new StoreMirror(f).run(), 'mirrored');
  const blank = await blankHome(f.root, 'runner-home');
  await rm(blank.database);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const runner = await startRunner({
    home: blank.home,
    mirrorDirectory: f.directory,
    mirrorAllowSameDevice: true,
    apiBaseUrl: 'https://invalid.example',
    listen: false,
    verifySecret: null,
    fetch: async () => {
      throw new Error('no network here');
    },
  });
  try {
    for (let round = 0; round < 3; round++) t.mock.timers.tick(MIRROR_INTERVAL_MS);
    // A worker round runs on its own thread; the lock and the checks settle in real time.
    await new Promise((done) => setTimeout(done, 500));
    assert.deepEqual(copies(f.directory), [5, 5, 5]);
  } finally {
    await runner.stop();
  }
});

// --- Wear: hard links, and nothing written when nothing changed ------------------

test('rotation hard-links the outgoing copy, and an unchanged store writes no copy', async (t) => {
  const f = await box(t);
  await f.fact(1);
  const mirror = new StoreMirror(f);
  assert.equal(await mirror.run(), 'mirrored');
  const first = statSync(join(f.directory, MIRROR_NAME));
  const old = (Date.now() - 300_000) / 1000;
  await utimes(join(f.directory, MIRROR_NAME), old, old);

  // Nothing changed: the same file is kept and its time moves, so its age stays honest.
  assert.equal(await mirror.run(), 'unchanged');
  const kept = statSync(join(f.directory, MIRROR_NAME));
  assert.equal(kept.ino, first.ino);
  assert.ok(Date.now() - kept.mtimeMs < 5_000);
  assert.equal(existsSync(join(f.directory, `${MIRROR_NAME}.1`)), false, 'no rotation for an unchanged round');

  await f.fact(2);
  assert.equal(await mirror.run(), 'mirrored');
  const rotated = statSync(join(f.directory, `${MIRROR_NAME}.1`));
  if (process.platform !== 'win32') assert.equal(rotated.ino, first.ino, 'the old copy moved by link, not by copy');
  assert.equal(rotated.nlink, 1);
  assert.notEqual(statSync(join(f.directory, MIRROR_NAME)).ino, first.ino);
  assert.deepEqual([rows(join(f.directory, MIRROR_NAME)), rows(join(f.directory, `${MIRROR_NAME}.1`))], [2, 1]);
});

test('a heartbeat-style write that changes no record does not cost a copy; a sealed record does', async (t) => {
  const f = await box(t);
  await f.fact(1);
  const mirror = new StoreMirror(f);
  assert.equal(await mirror.run(), 'mirrored');
  // What a running box writes while idle, measured on the real agent: its clock
  // measurement, the last time it trusts, and the receipt mark.
  await f.store.writeRuntimeValue(BOX_ID, 'box.clock_measurement', '{"offsetMs":1}');
  await f.store.markTimeSeen(BOX_ID, new Date(Date.now() + 60_000).toISOString());
  f.db.exec(`insert into box_cache (box_id, scope, payload, applied_at) values ('${BOX_ID}', 'receipt_series', '{}', '2026-11-02T00:00:00.000Z')
    on conflict (box_id, scope) do update set applied_at = excluded.applied_at`);
  assert.equal(await mirror.run(), 'unchanged');
  await f.fact(2);
  assert.equal(await mirror.run(), 'mirrored');
});

test('an unchanged store still gets a real copy once an hour, and a replaced drive gets one at once', async (t) => {
  const f = await box(t);
  await f.fact(1);
  let now = Date.now();
  const mirror = new StoreMirror({ ...f, now: () => now });
  assert.equal(await mirror.run(), 'mirrored');
  now += 59 * 60_000;
  assert.equal(await mirror.run(), 'unchanged');
  now += 61 * 60_000;
  assert.equal(await mirror.run(), 'mirrored');
  // Another drive at the same path: the last copy is not ours, so it is not vouched for.
  await rm(join(f.directory, MIRROR_NAME));
  await rm(join(f.directory, `${MIRROR_NAME}.1`));
  assert.equal(await mirror.run(), 'mirrored');
  await writeFile(join(f.directory, MIRROR_NAME), 'another drive');
  assert.notEqual(await mirror.run(), 'unchanged');
});

test('temporary files a kill or a power cut left behind are swept under the lock', async (t) => {
  const f = await box(t);
  await f.fact(1);
  await mkdir(f.directory, { recursive: true });
  for (const name of [
    `${MIRROR_NAME}.tmp-dead`,
    `${MIRROR_NAME}.tmp-dead-journal`,
    `${MIRROR_NAME}.tmp-dead.previous`,
  ])
    await writeFile(join(f.directory, name), 'left behind');
  await writeFile(join(f.directory, 'not-ours.txt'), 'keep me');
  assert.equal(await new StoreMirror(f).run(), 'mirrored');
  assert.deepEqual((await readdir(f.directory)).sort(), [MIRROR_NAME, 'not-ours.txt']);
});

// --- The drive must be another drive ---------------------------------------------

test('a mirror directory on the store’s own device writes nothing, however it got there', async (t) => {
  const f = await box(t);
  await f.fact(1);
  let told = 0;
  const unmounted = new StoreMirror({
    database: f.database,
    directory: join(f.root, 'mnt', 'oto-mirror', 'box'),
    onFailure: () => {
      told += 1;
    },
  });
  assert.equal(await unmounted.run(), 'same_device');
  assert.equal(unmounted.problem, 'same_device');
  assert.equal(unmounted.failures, 1);
  assert.equal(told, 1);
  assert.equal(existsSync(join(f.root, 'mnt')), false, 'an unmounted path is never created on the store’s drive');

  await mkdir(f.directory, { recursive: true });
  const same = new StoreMirror({ database: f.database, directory: f.directory });
  assert.equal(await same.run(), 'same_device');
  assert.deepEqual(await readdir(f.directory), []);
});

test('the same-device allowance is a test-only variable, ignored in production', async (t) => {
  const f = await box(t);
  await f.fact(1);
  const asRun = (env: NodeJS.ProcessEnv) =>
    new StoreMirror({ database: f.database, directory: f.directory, env });
  assert.equal(await asRun({ NODE_ENV: 'production', OTO_BOX_TEST_MIRROR_SAME_DEVICE: '1' }).run(), 'same_device');
  assert.equal(await asRun({ OTO_BOX_TEST_MIRROR_SAME_DEVICE: '1' }).run(), 'same_device');
  assert.equal(await asRun({ NODE_ENV: 'test', OTO_BOX_TEST_MIRROR_SAME_DEVICE: '1' }).run(), 'mirrored');
});

test('a different device passes', async (t) => {
  const f = await box(t);
  await f.fact(1);
  await mkdir(f.directory, { recursive: true });
  const real = await stat(f.home);
  const mirror = new StoreMirror({
    database: f.database,
    directory: f.directory,
    deviceOf: async (path) => (path === f.directory ? real.dev + 1 : real.dev),
  });
  assert.equal(await mirror.run(), 'mirrored');
});

// --- The window ------------------------------------------------------------------

test('the window: a record inside the floor gets a trailing round, about ten seconds plus the round', async (t) => {
  const f = await box(t);
  await f.fact(1);
  let now = Date.now();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const copied: number[] = [];
  const mirror = new StoreMirror({
    ...f,
    now: () => now,
    copy: async () => {
      copied.push(now);
      await writeFile(join(f.directory, MIRROR_NAME), 'stamp');
      await utimes(join(f.directory, MIRROR_NAME), now / 1000, now / 1000);
      return { fingerprint: String(copied.length) };
    },
  });
  const started = now;
  assert.equal(await mirror.run(), 'mirrored');
  // The last sale of the rush lands one second after that round, and nothing follows it.
  now += 1_000;
  mirror.acceptedUnsent();
  await settle();
  assert.equal(copied.length, 1, 'inside the floor, so no round yet');
  now = started + MIRROR_AFTER_UNSENT_MS - 1;
  t.mock.timers.tick(MIRROR_AFTER_UNSENT_MS - 1_000 - 1);
  await settle();
  assert.equal(copied.length, 1);
  now = started + MIRROR_AFTER_UNSENT_MS + 2;
  t.mock.timers.tick(3);
  await settle();
  assert.equal(copied.length, 2, 'the trailing round comes as soon as the floor has passed');
  assert.ok(copied[1]! - started <= MIRROR_AFTER_UNSENT_MS + 2);
  await mirror.stop();
});

test('the window: a record during a round gets a round after it, not the next minute', async (t) => {
  const f = await box(t);
  await f.fact(1);
  let now = Date.now();
  let release!: () => void;
  const work = new Promise<void>((done) => {
    release = done;
  });
  let copies_ = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mirror = new StoreMirror({
    ...f,
    now: () => now,
    copy: async () => {
      copies_ += 1;
      if (copies_ === 1) await work;
      return { fingerprint: String(copies_) };
    },
  });
  const first = mirror.run();
  await settle();
  mirror.acceptedUnsent();
  now += 12_000;
  release();
  assert.equal(await first, 'mirrored');
  await settle();
  t.mock.timers.tick(1);
  await settle();
  assert.equal(copies_, 2, 'a round slower than the floor is followed at once');
  await mirror.stop();
});

test('when rounds keep failing the problem is named after two, and clears on the next good round', async (t) => {
  const f = await box(t);
  await f.fact(1);
  let fail = true;
  const mirror = new StoreMirror({
    ...f,
    copy: async () => {
      if (fail) throw new Error('injected mirror failure');
      return { fingerprint: 'good' };
    },
  });
  assert.equal(mirror.problem, null);
  assert.equal(await mirror.run(), 'failed');
  assert.equal(mirror.problem, null, 'one failed round is not yet a failing drive');
  assert.equal(await mirror.run(), 'failed');
  assert.equal(mirror.problem, 'failing');
  fail = false;
  assert.equal(await mirror.run(), 'mirrored');
  assert.equal(mirror.problem, null);
  assert.equal(mirror.failures, 2);
});

test('a failed round does not hammer the drive: the next try is the minute, or the next sale past the floor', async (t) => {
  const f = await box(t);
  await f.fact(1);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let tries = 0;
  const mirror = new StoreMirror({
    ...f,
    copy: async () => {
      tries += 1;
      throw new Error('injected mirror failure');
    },
  });
  mirror.acceptedUnsent();
  await settle();
  assert.equal(tries, 1);
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(tries, 1, 'no trailing round after a failure');
  await mirror.stop();
});

test('stopping does not wait for ever on a round a dead drive has swallowed', async (t) => {
  const f = await box(t);
  await f.fact(1);
  const mirror = new StoreMirror({
    ...f,
    stopWaitMs: 20,
    copy: () => new Promise(() => {}),
  });
  void mirror.run();
  await settle();
  await mirror.stop();
});

test('a round a dead drive has swallowed is called failing, though it never fails', async (t) => {
  const f = await box(t);
  await f.fact(1);
  let now = Date.now();
  const mirror = new StoreMirror({
    ...f,
    now: () => now,
    stopWaitMs: 10,
    copy: () => new Promise(() => {}),
  });
  void mirror.run();
  await settle();
  assert.equal(mirror.problem, null);
  now += MIRROR_STUCK_AFTER_MS + 1;
  assert.equal(mirror.problem, 'failing');
  assert.equal(await mirror.run(), 'busy', 'and no second round is started beside it');
  await mirror.stop();
});

test('until the first round has had its chance the mirror says it is settling', async (t) => {
  const f = await box(t);
  await f.fact(1);
  const mirror = new StoreMirror(f);
  assert.equal(mirror.settling, true);
  assert.equal(await mirror.run(), 'mirrored');
  assert.equal(mirror.settling, false);
  const failing = new StoreMirror({
    ...f,
    copy: async () => {
      throw new Error('injected');
    },
  });
  assert.equal(failing.settling, true);
  await failing.run();
  assert.equal(failing.settling, false, 'a failed round has had its chance');
});

// --- Storage health: a stuck read --------------------------------------------------

test('a statfs that never answers does not stop the snapshot, and is not asked again meanwhile', async () => {
  let asked = 0;
  const health = new StorageHealth({
    database: '/home/box/box.sqlite',
    mirrorDirectory: '/mirror',
    mirror: { failures: 0, ageSeconds: async () => 5 },
    statfs: () => {
      asked += 1;
      return new Promise(() => {});
    },
    readOnly: async () => false,
    env: {},
    readTimeoutMs: 20,
  });
  const reading = await health.snapshot();
  assert.equal(reading.driveNotAnswering, true);
  assert.equal(reading.freeBytes, null);
  assert.equal(reading.mirrorProblem, 'not_answering');
  assert.equal(asked, 2);
  await health.snapshot();
  assert.equal(asked, 2, 'a stuck read keeps its one thread; another would use up the pool');
});

test('a mirror drive that hangs is the mirror’s problem, and a stuck read that recovers clears', async () => {
  let release!: (value: { bavail: number; blocks: number; bsize: number }) => void;
  let stuck = true;
  const health = new StorageHealth({
    database: '/home/box/box.sqlite',
    mirrorDirectory: '/mirror',
    mirror: { failures: 0, ageSeconds: async () => 5 },
    statfs: (path) =>
      path === '/mirror' && stuck
        ? new Promise((done) => {
            release = done;
          })
        : Promise.resolve({ bavail: 10, blocks: 100, bsize: 4096 }),
    readOnly: async () => false,
    env: {},
    readTimeoutMs: 20,
  });
  const first = await health.snapshot();
  assert.equal(first.mirrorProblem, 'not_answering');
  assert.equal(first.driveNotAnswering, undefined);
  assert.equal(first.freeBytes, 40960);
  stuck = false;
  release({ bavail: 10, blocks: 100, bsize: 4096 });
  await new Promise((done) => setTimeout(done, 5));
  const second = await health.snapshot();
  assert.equal(second.mirrorProblem, undefined);
  assert.equal(second.mirrorFreeBytes, 40960);
});

test('an age read that hangs never holds the heartbeat either', async () => {
  const health = new StorageHealth({
    database: '/home/box/box.sqlite',
    mirrorDirectory: '/mirror',
    mirror: { failures: 0, ageSeconds: () => new Promise(() => {}) },
    statfs: async () => ({ bavail: 10, blocks: 100, bsize: 4096 }),
    readOnly: () => new Promise(() => {}),
    env: {},
    readTimeoutMs: 20,
  });
  const reading = await health.snapshot();
  assert.equal(reading.mirrorProblem, 'not_answering');
  assert.equal(reading.mirrorAgeS, null);
  assert.equal(reading.readOnly, null);
});

test('the health block carries the mirror’s own problem and that it is settling', async () => {
  const health = new StorageHealth({
    database: '/home/box/box.sqlite',
    mirrorDirectory: '/mirror',
    mirror: { failures: 4, ageSeconds: async () => 900, problem: 'holds_unsent', settling: true },
    statfs: async () => ({ bavail: 10, blocks: 100, bsize: 4096 }),
    readOnly: async () => false,
    env: {},
  });
  const reading = await health.snapshot();
  assert.equal(reading.mirrorProblem, 'holds_unsent');
  assert.equal(reading.mirrorSettling, true);
  assert.equal(reading.mirrorErrors, 4);
});

test('a storage reader that never answers cannot stop the heartbeat', async () => {
  const cloud = fakeBoxCloud(tillBundle());
  const sent: Array<Record<string, unknown>> = [];
  const through = cloud.fetch;
  cloud.fetch = async (url, init) => {
    if (new URL(url).pathname === '/box/v1/heartbeat')
      sent.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
    return through(url, init);
  };
  const { agent, close } = await openTestAgent(cloud, {
    storage: () => new Promise(() => {}),
    storageReadLimitMs: 20,
  });
  try {
    await agent.heartbeat();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.storage, undefined);
  } finally {
    close();
  }
});

// --- Restore ------------------------------------------------------------------------

async function mirrored(t: TestContext, boxId: string = BOX_ID) {
  const f = await box(t, boxId);
  await f.fact(1);
  await f.fact(2);
  f.db.exec(`insert into box_counter (box_id, scope, counter_key, business_date, counter_value, updated_at)
    values ('${boxId}', 'receipt_seq', 'last:${STATION}:T1', '1970-01-01', 41, '2026-11-02T00:00:00.000Z')`);
  assert.equal(await new StoreMirror(f).run(), 'mirrored');
  f.db.close();
  return { ...f, file: join(f.directory, MIRROR_NAME) };
}

function runtimeValue(file: string, boxId: string, key: string): string | null {
  const db = open(file);
  try {
    const row = db
      .prepare('select value from box_runtime where box_id = ? and runtime_key = ?')
      .get(boxId, key) as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

test('M3: a restore makes the journal wait, in the file it installs, before anything can seal', async (t) => {
  const f = await mirrored(t);
  const target = await blankHome(f.root, 'replaced');
  const restored = await restoreStore(target.home, f.file, noService);
  assert.equal(restored.unsent, 2);
  assert.deepEqual(restored.boxIds, [BOX_ID]);
  const note = JSON.parse(runtimeValue(target.database, BOX_ID, JOURNAL_EPOCH_KEY)!) as { state: string };
  assert.equal(note.state, 'awaiting');
  const db = new DatabaseSync(target.database);
  assert.equal(Object.values(db.prepare('pragma quick_check').get()!)[0], 'ok');
  assert.equal(Object.values(db.prepare('pragma journal_mode').get()!)[0], 'wal');
  db.close();
  for (const tail of ['-wal', '-shm']) {
    assert.equal(
      readdirSync(target.home).some((name) => name.includes('.restore-') && name.endsWith(tail)),
      false,
    );
  }
});

test('the count includes failed rows, as depth() does', async (t) => {
  const f = await box(t);
  await f.fact(1);
  await f.fact(2);
  await f.fact(3);
  await f.fact(4);
  f.db.exec("update box_outbox set state = 'failed' where box_seq = 1");
  f.db.exec("update box_outbox set state = 'sending' where box_seq = 2");
  f.db.exec("update box_outbox set state = 'acked', acked_at = '2026-11-02T00:00:00.000Z' where box_seq = 3");
  const { queued } = await f.store.depth(BOX_ID);
  assert.equal(await new StoreMirror(f).run(), 'mirrored');
  f.db.close();
  const target = await blankHome(f.root, 'count');
  const restored = await restoreStore(target.home, join(f.directory, MIRROR_NAME), noService);
  assert.equal(restored.unsent, queued);
  assert.equal(restored.unsent, 3);
});

test('M4: a restore moves every receipt series on, so a number is never handed out twice', async (t) => {
  const f = await box(t);
  await f.fact(1);
  f.db.exec(`insert into box_cache (box_id, scope, payload, applied_at) values ('${BOX_ID}', 'receipt_series',
    '${JSON.stringify({ items: [
      { stationId: STATION, prefix: 'T1', highWaterMark: 40 },
      { stationId: `${STATION.slice(0, -1)}2`, prefix: 'T2', highWaterMark: 7 },
      { stationId: `${STATION.slice(0, -1)}3`, prefix: null, highWaterMark: 0 },
    ] })}', '2026-11-02T00:00:00.000Z')`);
  // T1 sold 41 on the box; T2 has only ever been told its mark.
  f.db.exec(`insert into box_counter (box_id, scope, counter_key, business_date, counter_value, updated_at)
    values ('${BOX_ID}', 'receipt_seq', 'last:${STATION}:T1', '1970-01-01', 41, '2026-11-02T00:00:00.000Z')`);
  // A till reported a higher number it saw online.
  f.db.exec(`insert into box_runtime (box_id, runtime_key, value, updated_at) values
    ('${BOX_ID}', 'receipt_observed:${STATION.slice(0, -1)}2', '{"prefix":"T2","seq":9}', '2026-11-02T00:00:00.000Z')`);
  assert.equal(await new StoreMirror(f).run(), 'mirrored');
  f.db.close();
  const target = await blankHome(f.root, 'receipts');
  const restored = await restoreStore(target.home, join(f.directory, MIRROR_NAME), noService);
  assert.equal(restored.receiptMargin, RECEIPT_RESTORE_MARGIN);
  assert.equal(restored.receiptSeries, 2);
  const db = open(target.database);
  const counter = (key: string) =>
    Number(
      (
        db
          .prepare(
            `select counter_value as v from box_counter where box_id = ? and scope = 'receipt_seq' and counter_key = ? and business_date = '1970-01-01'`,
          )
          .get(BOX_ID, key) as { v: number } | undefined
      )?.v ?? 0,
    );
  assert.equal(counter(`last:${STATION}:T1`), 41 + RECEIPT_RESTORE_MARGIN);
  assert.equal(counter(`last:${STATION.slice(0, -1)}2:T2`), 9 + RECEIPT_RESTORE_MARGIN);
  db.close();
});

test('M4: restoring twice moves on again, and a terminal reference is not reused that day', async (t) => {
  const f = await box(t);
  await f.fact(1);
  f.db.exec(`insert into box_counter (box_id, scope, counter_key, business_date, counter_value, updated_at) values
    ('${BOX_ID}', 'receipt_seq', 'last:${STATION}:T1', '1970-01-01', 41, '2026-11-02T00:00:00.000Z'),
    ('${BOX_ID}', 'terminal_ref', '${TERMINAL}', '2026-11-01', 90, '2026-11-01T00:00:00.000Z'),
    ('${BOX_ID}', 'terminal_ref', '${TERMINAL}', '2026-11-02', 12, '2026-11-02T00:00:00.000Z')`);
  assert.equal(await new StoreMirror(f).run(), 'mirrored');
  f.db.close();
  const target = await blankHome(f.root, 'twice');
  const file = join(f.directory, MIRROR_NAME);
  await restoreStore(target.home, file, noService);
  const read = () => {
    const db = open(target.database);
    try {
      return db
        .prepare(`select scope, business_date as d, counter_value as v from box_counter order by scope, d`)
        .all() as Array<{ scope: string; d: string; v: number }>;
    } finally {
      db.close();
    }
  };
  assert.deepEqual(
    read().map((row) => [row.scope, row.d, row.v]),
    [
      ['receipt_seq', '1970-01-01', 41 + RECEIPT_RESTORE_MARGIN],
      ['terminal_ref', '2026-11-01', 90],
      ['terminal_ref', '2026-11-02', 12 + TERMINAL_REF_RESTORE_MARGIN],
    ],
  );
});

test('queued print jobs in a copy never print again by themselves, and the restore says how many', async (t) => {
  const f = await box(t);
  await f.fact(1);
  const job = (id: string, state: string) => `('${id}', '${BOX_ID}', 'receipt', '{}', '${state}', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`;
  f.db.exec(`insert into box_print_job (id, box_id, kind, job, state, queued_at, updated_at) values
    ${job('job-queued', 'queued')}, ${job('job-sending', 'sending')}, ${job('job-interrupted', 'interrupted')}`);
  assert.equal(await new StoreMirror(f).run(), 'mirrored');
  f.db.close();
  const target = await blankHome(f.root, 'prints');
  const restored = await restoreStore(target.home, join(f.directory, MIRROR_NAME), noService);
  assert.equal(restored.printJobsHeld, 2);
  const db = open(target.database);
  const held = db
    .prepare('select id, state, last_error_code as code, last_error_message as message from box_print_job order by id')
    .all() as Array<{ id: string; state: string; code: string | null; message: string | null }>;
  db.close();
  assert.deepEqual(held.map((row) => row.state), ['interrupted', 'interrupted', 'interrupted']);
  for (const row of held.filter((r) => r.id !== 'job-interrupted')) {
    assert.equal(row.code, 'PRINT_STORE_RESTORED');
    assert.match(row.message!, /restored/i);
    assert.match(row.message!, /reprint/i);
  }
});

test('a restored job is reported in the restore’s own words and never reaches a printer by itself', async (t) => {
  const f = await box(t);
  await f.fact(1);
  f.db.exec(`insert into box_print_job (id, box_id, kind, job, state, queued_at, updated_at) values
    ('job-restored', '${BOX_ID}', 'receipt', '{}', 'queued', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`);
  assert.equal(await new StoreMirror(f).run(), 'mirrored');
  f.db.close();
  const target = await blankHome(f.root, 'printed-once');
  await restoreStore(target.home, join(f.directory, MIRROR_NAME), noService);
  const db = new DatabaseSync(target.database);
  const keys = generateSyncKeyPair();
  const harness: TestStore = {
    store: new SqlBoxStore({ driver: sqliteBoxDriver(db) }),
    keys,
    seal: (draft) => sealEnvelope(draft, BOX_ID, keys.privateKeyPem),
    setNow() {},
    now: () => new Date(),
    close: () => db.close(),
  };
  const cloud = fakeBoxCloud(tillBundle());
  const { agent, close } = await openTestAgent(cloud, { printing: { durable: true, retryDelayMs: 0 } }, harness);
  try {
    await agent.printing()!.jobs.tick();
    assert.equal(cloud.printResults.length, 1);
    assert.equal(cloud.printResults[0]!.jobId, 'job-restored');
    assert.equal(cloud.printResults[0]!.body.status, 'failed');
    assert.equal(cloud.printResults[0]!.body.errorCode, 'PRINT_STORE_RESTORED');
    assert.match(String(cloud.printResults[0]!.body.errorMessage), /may already have printed/);
    assert.deepEqual(agent.printing()!.jobs.pending(), [], 'nothing waits to print');
    await agent.printing()!.jobs.tick();
    assert.equal(cloud.printResults.length, 1, 'reported once, and gone');
  } finally {
    close();
    db.close();
  }
});

test('identity: a mirror of another box is refused into a home that names a box, unless asked', async (t) => {
  const f = await mirrored(t);
  const target = await blankHome(f.root, 'other-box');
  await writeFile(
    join(target.home, 'credential.json'),
    JSON.stringify({ boxId: OTHER_BOX, secret: 'not used', syncPrivateKeyPem: 'not used' }),
    { mode: 0o600 },
  );
  await assert.rejects(restoreStore(target.home, f.file, noService), (error: unknown) => {
    assert.ok(error instanceof RestoreRefusal);
    assert.equal(error.code, 'other_box');
    assert.match(error.message, new RegExp(OTHER_BOX));
    assert.match(error.message, new RegExp(BOX_ID));
    return true;
  });
  assert.deepEqual(
    readdirSync(target.home).filter((name) => name.includes('.replaced-')),
    [],
    'nothing was moved',
  );
  const allowed = await restoreStore(target.home, f.file, noService, { allowOtherBox: true });
  assert.equal(allowed.unsent, 2);
  assert.deepEqual(allowed.boxIds, [BOX_ID]);
});

test('identity: the store in place names a box even when the credential is gone', async (t) => {
  const f = await mirrored(t);
  const other = await box(t, OTHER_BOX);
  other.db.close();
  await assert.rejects(restoreStore(other.home, f.file, noService), (error: unknown) => {
    assert.ok(error instanceof RestoreRefusal);
    assert.equal(error.code, 'other_box');
    return true;
  });
});

test('identity: a replaced drive names nobody, so the copy names the box and the claim is held to it', async (t) => {
  const f = await mirrored(t);
  const target = await blankHome(f.root, 'replaced-drive');
  const restored = await restoreStore(target.home, f.file, noService);
  assert.deepEqual(restored.boxIds, [BOX_ID]);
  // The next claim must be for that box: the platform is told, and refuses any other
  // code without spending it.
  const bodies: Array<Record<string, unknown>> = [];
  await assert.rejects(
    claimBox({
      home: target.home,
      apiBaseUrl: 'https://platform.test',
      code: 'OTHER-BOX',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
        return {
          status: 409,
          json: async () => ({ error: { code: 'BOX_CLAIM_OTHER_BOX' } }),
          text: async () => '',
          header: () => null,
        };
      },
    }),
    new RegExp(BOX_ID),
  );
  assert.equal(bodies[0]?.expectedBoxId, BOX_ID);
  assert.deepEqual(bodies[0]?.journalsKept, [BOX_ID]);
  // The restored store is where it was, unsent rows and all.
  assert.equal(rows(target.database), 2);
});

test('claim --force on a restored store replaces the credential and keeps the store', async (t) => {
  const f = await mirrored(t);
  const target = await blankHome(f.root, 'forced');
  await restoreStore(target.home, f.file, noService);
  await writeFile(
    join(target.home, 'credential.json'),
    JSON.stringify({ boxId: BOX_ID, secret: 'old secret', syncPrivateKeyPem: 'old key' }),
    { mode: 0o600 },
  );
  await assert.rejects(
    claimBox({
      home: target.home,
      apiBaseUrl: 'https://platform.test',
      code: 'CODE',
      force: true,
      fetch: async () => ({ status: 500, json: async () => null, text: async () => '', header: () => null }),
    }),
  );
  assert.equal(rows(target.database), 2, 'the restored store stays where it is');
});

test('a claim on a blank store is refused while the copies hold sales it lacks', async (t) => {
  const f = await mirrored(t);
  const target = await blankHome(f.root, 'blank-claim');
  let asked = 0;
  await assert.rejects(
    claimBox({
      home: target.home,
      apiBaseUrl: 'https://platform.test',
      code: 'CODE',
      mirrorDirectory: f.directory,
      fetch: async () => {
        asked += 1;
        return { status: 500, json: async () => null, text: async () => '', header: () => null };
      },
    }),
    /restore/i,
  );
  assert.equal(asked, 0, 'refused before the code is spent');
});

test('restore refuses a copy of a box the platform has already moved on from, unless asked', async (t) => {
  const f = await mirrored(t);
  const target = await blankHome(f.root, 'claimed-first');
  const db = new DatabaseSync(target.database);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });
  await store.init(BOX_ID);
  await store.setEpoch(BOX_ID, 2);
  db.close();
  await assert.rejects(restoreStore(target.home, f.file, noService), (error: unknown) => {
    assert.ok(error instanceof RestoreRefusal);
    assert.equal(error.code, 'epoch_passed');
    assert.match(error.message, /refuse/i);
    return true;
  });
  assert.equal(rows(target.database), 0, 'the store in place was not touched');
  const allowed = await restoreStore(target.home, f.file, noService, { acceptRefused: true });
  assert.equal(allowed.unsent, 2);
});

test('each failure has its own words', async (t) => {
  const f = await mirrored(t);
  const target = await blankHome(f.root, 'messages');
  const lines: string[] = [];
  const io = {
    stdout: { write: (line: string) => lines.push(line) },
    stderr: { write: (line: string) => lines.push(line) },
  };
  const run = async (file: string) => {
    lines.length = 0;
    const code = await main(['store', 'restore', file, '--home', target.home], io);
    return { code, said: lines.join('') };
  };

  const missing = await run(join(f.root, 'no-such-file'));
  assert.equal(missing.code, 1);
  assert.match(missing.said, /could not be read/);
  assert.doesNotMatch(missing.said, /damaged|Stop the/);

  const directory = await run(f.root);
  assert.equal(directory.code, 1);
  assert.match(directory.said, /could not be read/);

  const damaged = join(f.root, 'damaged');
  await writeFile(damaged, 'not sqlite, and long enough that sqlite looks at it properly');
  const broken = await run(damaged);
  assert.equal(broken.code, 1);
  assert.match(broken.said, /damaged/);
  assert.match(broken.said, /\.mirror\.1/);

  const otherDb = join(f.root, 'plain.sqlite');
  const plain = new DatabaseSync(otherDb);
  plain.exec('create table something (id integer)');
  plain.close();
  const notOurs = await run(otherDb);
  assert.equal(notOurs.code, 1);
  assert.match(notOurs.said, /not a box mirror/);

  const release = await startRunner({
    home: target.home,
    apiBaseUrl: 'https://invalid.example',
    listen: false,
    verifySecret: null,
    fetch: async () => {
      throw new Error('no network here');
    },
  });
  try {
    const busy = await run(f.file);
    assert.equal(busy.code, 1);
    assert.match(busy.said, /Stop the oto-box service/);
    assert.doesNotMatch(busy.said, /damaged/);
  } finally {
    await release.stop();
  }

  const good = await run(f.file);
  assert.equal(good.code, 0);
  assert.match(good.said, /2 unsent record/);
  assert.match(good.said, new RegExp(BOX_ID));
  assert.match(good.said, /Reset the store/);
  assert.match(good.said, new RegExp(String(RECEIPT_RESTORE_MARGIN)));
});

test('a service that is running refuses in its own words', async (t) => {
  const f = await mirrored(t);
  const target = await blankHome(f.root, 'service');
  await assert.rejects(
    restoreStore(target.home, f.file, async () => {
      throw new Error('Stop the oto-box service before restoring.');
    }),
    /Stop the oto-box service/,
  );
});

test('status counts failed rows, and says when the journal waits and why', async (t) => {
  const f = await mirrored(t);
  const target = await blankHome(f.root, 'status');
  await restoreStore(target.home, f.file, noService);
  const db = new DatabaseSync(target.database);
  db.exec("update box_outbox set state = 'failed' where box_seq = 1");
  db.close();
  const lines: string[] = [];
  const io = {
    stdout: { write: (line: string) => lines.push(line) },
    stderr: { write: (line: string) => lines.push(line) },
  };
  assert.equal(await main(['status', '--home', target.home], io), 0);
  const said = lines.join('');
  assert.match(said, /outbox\s+2 fact/);
  assert.match(said, /journal\s+waits/);
  assert.match(said, /restored/);
});

test('copy helper keeps working on a directory it did not make, and a read-only copy is never opened for writing', async (t) => {
  const f = await box(t);
  await f.fact(1);
  await mkdir(f.directory, { recursive: true });
  await copyStoreMirror(f.database, f.directory);
  const bytes = await readFile(join(f.directory, MIRROR_NAME));
  await copiesHoldingUnsent(f.database, f.directory);
  assert.deepEqual(await readFile(join(f.directory, MIRROR_NAME)), bytes);
  assert.equal(dirname(f.database), f.home);
});

test('a sale during the hold is refused at the till by name, not as a fault in the box', async () => {
  const server = createBridgeServer({
    origins: ['https://pos.test'],
    port: 0,
    agent: () =>
      ({
        bridge: () => ({
          authenticate: async () => ({ kind: 'till', accountId: 'a', can: () => true }),
          intent: async () => {
            throw new JournalEpochAwaitedError();
          },
        }),
      }) as unknown as BoxAgent,
  });
  const { port } = await server.listen();
  try {
    const answer = await fetch(`http://127.0.0.1:${port}/box/v1/station/${STATION}/intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer bs_test' },
      body: JSON.stringify({ type: 'sale.finalise', lastSeenSequence: 0, payload: {} }),
    });
    assert.equal(answer.status, 409);
    const body = (await answer.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'JOURNAL_AWAITING_EPOCH');
    assert.match(body.error.message, /reset the store/i);
  } finally {
    await server.close();
  }
});

// --- The installer, by its text: it cannot run here, and the bench list says so -------

const piFile = (name: string) => readFile(new URL(`../../../scripts/pi/${name}`, import.meta.url), 'utf8');

test('the service may write the mirror, and a missing mirror cannot stop the service', async () => {
  const unit = await piFile('oto-box.service');
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/oto-box -\/mnt\/oto-mirror\/box$/m);
  assert.match(unit, /^Wants=mnt-oto\\x2dmirror\.mount$/m);
  assert.match(unit, /^After=mnt-oto\\x2dmirror\.mount$/m);
  assert.doesNotMatch(unit, /^RequiresMountsFor=/m);
  // The store lock is an abstract socket.
  assert.doesNotMatch(unit, /^PrivateNetwork=/m);
  assert.doesNotMatch(unit, /^RestrictAddressFamilies=/m);
  for (const path of ['/home', '/root', '/run/user', '/tmp']) {
    assert.ok(!/^ReadWritePaths=.*$/m.exec(unit)![0].includes(path));
  }
});

test('the installer names the drive by UUID, never fails a boot on it, and gives every reader the directory', async () => {
  const script = await piFile('install.sh');
  assert.ok(script.includes('UUID=$MIRROR_UUID $MIRROR_MOUNT ext4 defaults,noatime,nofail,x-systemd.device-timeout=10s 0 2'));
  assert.ok(script.includes('MIRROR_MOUNT="/mnt/oto-mirror"'));
  assert.ok(script.includes('MIRROR_DIR="$MIRROR_MOUNT/box"'));
  // The directory is made on the drive or not at all.
  assert.match(script, /if mountpoint -q "\$MIRROR_MOUNT"; then\n\s+install -d -m 0700 -o oto-box -g oto-box "\$MIRROR_DIR"/);
  // New config file, existing config file, and the wrapper `status` and `mirror-now` run through.
  assert.ok(script.includes('${MIRROR_UUID:+OTO_BOX_MIRROR_DIR=$MIRROR_DIR}'));
  assert.ok(script.includes('config_set OTO_BOX_MIRROR_DIR "$MIRROR_DIR"'));
  assert.ok(script.includes('OTO_BOX_MIRROR_DIR="\\$OTO_BOX_MIRROR_DIR"'));
  // Swap off, on Bookworm's own terms.
  for (const step of ['dphys-swapfile swapoff', 'dphys-swapfile uninstall', 'systemctl disable --now dphys-swapfile']) {
    assert.ok(script.includes(step), step);
  }
  const journal = await piFile('oto-box-journald.conf');
  assert.match(journal, /^SystemMaxUse=200M$/m);
  assert.match(journal, /^Storage=persistent$/m);
});

test('the display scale is written the same everywhere: 1.25', async () => {
  const script = await piFile('install.sh');
  const kiosk = await piFile('oto-kiosk.sh');
  assert.doesNotMatch(script, /\b1\.6\b/);
  assert.doesNotMatch(kiosk, /\b1\.6\b/);
  assert.ok(script.includes('customer display uses 1.25'));
  assert.ok(kiosk.includes('1920 x 1080 at 1.25 is 1536 x 864'));
});

/** Long enough for a round's file calls, on Node's pool, and not on any timer a test holds. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await stat(tmpdir());
}
