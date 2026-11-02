import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { StoreMirror, MIRROR_NAME } from '../src/store-mirror';
import { StorageHealth, readOnlyMount } from '../src/storage-health';
import { restoreStore } from '../src/runner/store-restore';
import { holdStoreLock } from '../src/runner/store-lock';
import { main } from '../src/runner/cli';
import { startRunner } from '../src/runner/runtime';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import { SqlBoxStore } from '../src/store-sql';
import { generateSyncKeyPair, sealEnvelope } from '../src/signing';
import { BOX_ID } from './_support';

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'oto-storage-'));
  const directory = join(home, 'second-drive');
  const database = join(home, 'box.sqlite');
  const db = new DatabaseSync(database);
  prepareSqliteBoxStore(db);
  const keys = generateSyncKeyPair();
  const seal = (draft: Parameters<typeof sealEnvelope>[0]) =>
    sealEnvelope(draft, BOX_ID, keys.privateKeyPem);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });
  await store.init(BOX_ID);
  t.after(async () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    await rm(home, { recursive: true, force: true });
  });
  // Everything here is on one test disk (SCRUM-719 refuses that outside a test).
  return { home, database, directory, db, store, seal, allowSameDevice: true };
}

function count(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(Object.values(db.prepare('pragma quick_check').get()!)[0], 'ok');
    return Number(db.prepare('select count(*) as n from box_outbox').get()!.n);
  } finally {
    db.close();
  }
}

test('mirror uses a live WAL snapshot, checks it and rotates the previous two copies', async (t) => {
  const f = await fixture(t);
  const mirror = new StoreMirror(f);
  for (let n = 1; n <= 4; n++) {
    await f.store.enqueue(BOX_ID, { type: 'member.created', payload: { n } }, f.seal);
    assert.equal(await mirror.run(), 'mirrored');
    assert.equal(count(join(f.directory, MIRROR_NAME)), n);
  }
  assert.equal(count(join(f.directory, `${MIRROR_NAME}.1`)), 3);
  assert.equal(count(join(f.directory, `${MIRROR_NAME}.2`)), 2);
  assert.deepEqual((await readdir(f.directory)).sort(), [
    MIRROR_NAME,
    `${MIRROR_NAME}.1`,
    `${MIRROR_NAME}.2`,
  ]);
  assert.equal(Object.values(f.db.prepare('pragma journal_mode').get()!)[0], 'wal');
  assert.equal(Object.values(f.db.prepare('pragma synchronous').get()!)[0], 2);
});

test('busy rounds are skipped; an unsent record waits only until the last mirror is over ten seconds old', async (t) => {
  const f = await fixture(t);
  let now = Date.now();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const work = new Promise<void>((done) => {
    release = done;
  });
  let copies = 0;
  const mirror = new StoreMirror({
    ...f,
    now: () => now,
    copy: async () => {
      copies++;
      entered();
      await work;
      await writeFile(join(f.directory, MIRROR_NAME), 'test timestamp');
      await utimes(join(f.directory, MIRROR_NAME), now / 1000, now / 1000);
    },
  });
  const first = mirror.run();
  await started;
  assert.equal(await mirror.run(), 'busy');
  mirror.acceptedUnsent();
  assert.equal(copies, 1);
  release();
  assert.equal(await first, 'mirrored');
  now += 10_000;
  assert.equal(await mirror.run(true), 'too_soon');
  now += 1_000;
  assert.equal(await mirror.run(true), 'mirrored');
  assert.equal(copies, 2);
  await mirror.stop();
});

test('the periodic mirror starts at sixty seconds and stops without leaving a queued round', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  let copies = 0;
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const mirror = new StoreMirror({
    ...f,
    copy: async () => {
      copies++;
      entered();
    },
  });
  mirror.start();
  t.mock.timers.tick(59_999);
  assert.equal(copies, 0);
  t.mock.timers.tick(1);
  await started;
  await mirror.stop();
  t.mock.timers.tick(120_000);
  assert.equal(copies, 1);
});

test('the worker sees committed WAL rows while the live connection can keep an unfinished sale', async (t) => {
  const f = await fixture(t);
  await f.store.enqueue(BOX_ID, { type: 'member.created', payload: {} }, f.seal);
  f.db.exec('begin immediate');
  f.db.exec('delete from box_outbox');
  try {
    assert.equal(await new StoreMirror(f).run(), 'mirrored');
    assert.equal(count(join(f.directory, MIRROR_NAME)), 1);
    assert.equal(Number(f.db.prepare('select count(*) as n from box_outbox').get()!.n), 0);
  } finally {
    f.db.exec('rollback');
  }
  assert.equal(count(f.database), 1);
});

test('no directory writes nothing; a failed mirror is counted and unsent bursts do not retry in a tight loop', async (t) => {
  const f = await fixture(t);
  const before = await readdir(f.home);
  const disabled = new StoreMirror({ database: f.database });
  disabled.start();
  disabled.acceptedUnsent();
  assert.equal(await disabled.run(), 'disabled');
  assert.deepEqual(await readdir(f.home), before);
  let now = 20_000;
  const failed = new StoreMirror({
    ...f,
    now: () => now,
    copy: async () => {
      throw new Error('injected mirror failure');
    },
  });
  assert.equal(await failed.run(true), 'failed');
  assert.equal(failed.failures, 1);
  assert.equal(await failed.run(true), 'too_soon');
  now += 10_001;
  assert.equal(await failed.run(true), 'failed');
  assert.equal(failed.failures, 2);
});

test('only a committed outer transaction triggers a mirror, without awaiting or failing the sale', async (t) => {
  const f = await fixture(t);
  let copies = 0;
  const store = new SqlBoxStore({
    driver: sqliteBoxDriver(f.db, () => {
      copies++;
      throw new Error('observer failure');
    }),
  });
  await store.init(BOX_ID);
  await assert.rejects(
    store.atomically(async (tx) => {
      await tx.enqueue(BOX_ID, { type: 'member.created', payload: {} }, f.seal);
      assert.equal(copies, 0);
      throw new Error('rollback');
    }),
  );
  assert.equal(copies, 0);
  await store.atomically(async (tx) => {
    await tx.enqueueMany(
      BOX_ID,
      [
        { type: 'member.created', payload: {} },
        { type: 'member.created', payload: {} },
      ],
      f.seal,
    );
    assert.equal(copies, 0);
  });
  await Promise.resolve();
  assert.equal(copies, 1);
  assert.equal(count(f.database), 2);
});

test('restore rejects damage without moving anything, then preserves current files and reports the mirrored unsent count', async (t) => {
  const f = await fixture(t);
  await f.store.enqueue(BOX_ID, { type: 'member.created', payload: { preserved: true } }, f.seal);
  const mirror = new StoreMirror(f);
  assert.equal(await mirror.run(), 'mirrored');
  await f.store.enqueue(BOX_ID, { type: 'member.created', payload: { current: true } }, f.seal);
  f.db.close();
  await writeFile(join(f.home, 'credential.json'), 'credential sentinel');
  await writeFile(join(f.home, 'config.json'), 'config sentinel');
  const before = await readFile(f.database);
  const damaged = join(f.home, 'damaged');
  await writeFile(damaged, 'not sqlite');
  await assert.rejects(restoreStore(f.home, damaged, async () => {}));
  assert.deepEqual(await readFile(f.database), before);
  assert.equal(
    (await readdir(f.home)).some((name) => name.includes('.replaced-')),
    false,
  );
  await writeFile(`${f.database}-wal`, 'old wal');
  await writeFile(`${f.database}-shm`, 'old shm');
  const restored = await restoreStore(f.home, join(f.directory, MIRROR_NAME), async () => {});
  assert.equal(restored.unsent, 1);
  assert.equal(restored.replaced.length, 3);
  assert.deepEqual(await readFile(restored.replaced[0]!), before);
  assert.equal(await readFile(restored.replaced[1]!, 'utf8'), 'old wal');
  assert.equal(count(f.database), 1);
  assert.equal(await readFile(join(f.home, 'credential.json'), 'utf8'), 'credential sentinel');
  assert.equal(await readFile(join(f.home, 'config.json'), 'utf8'), 'config sentinel');
});

test('running agent refuses restore and a second runner; stopping releases the lock', async (t) => {
  const f = await fixture(t);
  f.db.close();
  const runner = await startRunner({
    home: f.home,
    apiBaseUrl: 'https://invalid.example',
    listen: false,
    verifySecret: null,
  });
  try {
    await assert.rejects(
      restoreStore(f.home, f.database, async () => {}),
      /in use/,
    );
    await assert.rejects(
      startRunner({
        home: f.home,
        apiBaseUrl: 'https://invalid.example',
        listen: false,
        verifySecret: null,
      }),
      /in use/,
    );
  } finally {
    await runner.stop();
  }
  const release = await holdStoreLock(f.home);
  await release();
});

test('storage reports free bytes, a read-only mount and deduplicated IO errors, including extended SQLite codes', async () => {
  const mirror = { failures: 3, ageSeconds: async () => 700 };
  const health = new StorageHealth({
    database: '/home/box/box.sqlite',
    mirrorDirectory: '/mirror',
    mirror,
    statfs: async () => ({ bavail: 10, blocks: 100, bsize: 4096 }),
    readOnly: async () => true,
    env: {},
  });
  for (const error of [
    { code: 'EIO' },
    { code: 'EROFS' },
    { code: 'SQLITE_IOERR_READ' },
    { code: 'SQLITE_READONLY' },
    { code: 'ERR_SQLITE_ERROR', errcode: 266 },
  ]) {
    health.recordError(error);
    health.recordError(error);
  }
  health.recordError({ code: 'SQLITE_BUSY' });
  assert.deepEqual(await health.snapshot(), {
    freeBytes: 40960,
    totalBytes: 409600,
    readOnly: true,
    ioErrors: 5,
    mirrorConfigured: true,
    mirrorAgeS: 700,
    mirrorFreeBytes: 40960,
    mirrorErrors: 3,
  });
  const error = Object.assign(new Error('injected'), { code: 'EIO' });
  const observed = health.observe({
    exec() {
      throw error;
    },
    prepare() {
      throw error;
    },
    close() {},
  });
  assert.throws(() => observed.exec('commit'));
  assert.equal((await health.snapshot()).ioErrors, 6);
});

test('low-space override is test-only; missing readings stay unknown and no mirror means null', async () => {
  const options = {
    database: '/home/box/box.sqlite',
    mirror: { failures: 0, ageSeconds: async () => null },
    statfs: async () => ({ bavail: 9, blocks: 10, bsize: 4096 }),
    readOnly: async () => null,
  };
  const production = new StorageHealth({
    ...options,
    env: { NODE_ENV: 'production', OTO_BOX_TEST_STORAGE_FREE_BYTES: '1' },
  });
  assert.equal((await production.snapshot()).freeBytes, 9 * 4096);
  const simulated = new StorageHealth({
    ...options,
    env: { NODE_ENV: 'test', OTO_BOX_TEST_STORAGE_FREE_BYTES: '1' },
  });
  assert.equal((await simulated.snapshot()).freeBytes, 1);
  const unknown = new StorageHealth({
    ...options,
    statfs: async () => {
      throw new Error('unavailable');
    },
    env: {},
  });
  assert.deepEqual(await unknown.snapshot(), {
    freeBytes: null,
    totalBytes: null,
    readOnly: null,
    ioErrors: 0,
    mirrorConfigured: false,
    mirrorAgeS: null,
    mirrorFreeBytes: null,
    mirrorErrors: 0,
  });
  const mounts = '1 0 8:1 / / rw - ext4 /dev/a rw\n2 1 8:2 / /home/box ro - ext4 /dev/b rw';
  assert.equal(readOnlyMount('/home/box', mounts), true);
  assert.equal(readOnlyMount('/home/boxes', mounts), false);
});

test('CLI restore prints the count and status explains an unconfigured mirror', async (t) => {
  const f = await fixture(t);
  await f.store.enqueue(BOX_ID, { type: 'member.created', payload: {} }, f.seal);
  assert.equal(await new StoreMirror(f).run(), 'mirrored');
  f.db.close();
  const lines: string[] = [];
  const io = {
    stdout: { write: (line: string) => lines.push(line) },
    stderr: { write: (line: string) => lines.push(line) },
  };
  assert.equal(
    await main(['store', 'restore', join(f.directory, MIRROR_NAME), '--home', f.home], io),
    0,
  );
  assert.match(lines.join(''), /1 unsent record/);
  assert.equal(await main(['status', '--home', f.home], io), 0);
  if (!process.env.OTO_BOX_MIRROR_DIR)
    assert.match(lines.join(''), /not mirrored: OTO_BOX_MIRROR_DIR is not configured/);
});
