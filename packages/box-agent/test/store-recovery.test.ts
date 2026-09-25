import assert from 'node:assert/strict';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { JOURNAL_EPOCH_KEY } from '../src/agent';
import { main, type CliStreams } from '../src/runner/cli';
import { runnerPaths } from '../src/runner/home';
import {
  claimBox,
  startRunner,
  type OpenDatabase,
  type RunningBox,
  type SalvageDocument,
} from '../src/runner/runtime';
import { prepareSqliteBoxStore, UNSENT_OUTBOX_SQL } from '../src/store-sqlite';
import type { AgentFetch, AgentLog, AgentResponse } from '../src/transport';
import { BRANCH_ID, OPERATOR_ID } from './_support';

/**
 * SCRUM-403 (closing audit M16) — a store the box cannot use.
 *
 * A card that loses writes it said were saved leaves `box.sqlite` unreadable
 * or damaged. The box used to exit on it in about 160 ms, systemd restarted it
 * every 3 s, the television showed Chromium's error page and the Console heard
 * no heartbeat. Here the runner is the real one, on real SQLite files damaged
 * the way a card damages them, against a cloud faked at the HTTP boundary:
 *
 *  - the kiosk listens first, says the box needs service, and the process
 *    stays up — health 503 with the reason, presses refused by name;
 *  - the unsent outbox is copied out of the damaged file, once, and nothing
 *    is moved or deleted;
 *  - the store is tried again on a timer, and a good one is picked up without
 *    a restart;
 *  - a new store seals nothing before the platform has named its epoch.
 */

const CODE = 'BENCH-CLAIM-403';
const BOX = '018f1d2c-0000-7000-8000-00000403b0c1';
const OTHER_BOX = '018f1d2c-0000-7000-8000-00000403b0c2';
const STATION = '018f1d2c-0000-7000-8000-00000403057a';
const ACCOUNT = '018f1d2c-0000-7000-8000-00000403fb21';
const quiet = { info() {}, warn() {}, error() {} };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'oto-box-recovery-'));
}

/** A port nothing is listening on, for a server whose address a test needs before it starts. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function pageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oto-box-page-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><meta name="oto-booth-host" content="paired" /><title>Booth</title></head><body><div id="root"></div></body></html>',
  );
  return dir;
}

interface Line {
  level: string;
  msg: string;
  obj: Record<string, unknown>;
}

function capture(): { log: AgentLog; lines: Line[] } {
  const lines: Line[] = [];
  const at = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    lines.push({ level, msg, obj });
  };
  return { log: { info: at('info'), warn: at('warn'), error: at('error') }, lines };
}

interface FakeCloud {
  fetch: AgentFetch;
  /** The box id and the epoch the next registration answers with. */
  registersAs: string;
  registerEpoch: number;
  /** `core.box.current_epoch`: what heartbeats and command results carry. */
  epoch: number;
  heartbeats: Array<Record<string, unknown>>;
  /** Every heartbeat is refused as an unknown credential while this is set. */
  refuseHeartbeats: boolean;
  /** Commands the next poll hands out. */
  queued: Array<{ id: string; kind: string }>;
  results: Array<{ id: string; body: unknown }>;
}

/** A cloud with one booth on the box, a wheel with one prize, and no push. */
function fakeCloud(): FakeCloud {
  const cloud: FakeCloud = {
    registersAs: BOX,
    registerEpoch: 1,
    epoch: 1,
    heartbeats: [],
    refuseHeartbeats: false,
    queued: [],
    results: [],
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const reply = (status: number, json: unknown, etag?: string): AgentResponse => ({
        status,
        json: async () => json,
        text: async () => JSON.stringify(json),
        header: (name) => (name.toLowerCase() === 'etag' ? (etag ?? null) : null),
      });
      const bundle = {
        configVersion: 'cfg-403',
        box: { id: cloud.registersAs, name: 'Bench box', slot: 'bench-1', role: 'booth', epoch: cloud.epoch, status: 'online' },
        branch: {
          id: BRANCH_ID,
          code: 'hkt-central',
          name: 'Oto Play Park, Central Floresta',
          operatorId: OPERATOR_ID,
          timezone: 'Asia/Bangkok',
          openingHours: null,
          businessDayStart: '05:00',
        },
        stations: [
          {
            id: STATION,
            name: 'Bench Booth',
            kind: 'booth',
            codePrefix: 'BR',
            capabilities: [],
            configVersion: 1,
            paymentRouting: null,
            offlineWalletCapSatang: null,
            accessScope: 'all_staff',
            devices: [],
          },
        ],
        printTemplates: [],
        signingKeys: [],
        heartbeatIntervalS: 60,
        minSupportedAgentVersion: '0.1.0',
      };
      if (path.startsWith('/box/v1/commands/') && path.endsWith('/result')) {
        const id = path.split('/')[4] ?? '';
        cloud.results.push({ id, body });
        // `completeCommand`: a store reset that succeeded mints the next epoch.
        if (body?.state === 'succeeded' && id.startsWith('reset-')) cloud.epoch += 1;
        return reply(200, { id, state: String(body?.state), replayed: false, epoch: cloud.epoch });
      }
      switch (path) {
        case '/box/v1/register': {
          if ((body as { claimCode?: string } | undefined)?.claimCode !== CODE) {
            return reply(401, { error: { code: 'BOX_CLAIM_INVALID' } });
          }
          cloud.epoch = cloud.registerEpoch;
          return reply(200, {
            boxId: cloud.registersAs,
            secret: 'fake-secret-for-tests-only',
            name: 'Bench box',
            slot: 'bench-1',
            role: 'booth',
            branchId: BRANCH_ID,
            operatorId: OPERATOR_ID,
            epoch: cloud.registerEpoch,
            heartbeatIntervalS: 60,
            minSupportedAgentVersion: '0.1.0',
          });
        }
        case '/box/v1/config':
          return reply(200, bundle, `"${bundle.configVersion}"`);
        case '/box/v1/cache':
          return reply(200, {
            schemaVersion: 1,
            bundleVersion: 'cache-403',
            cursorSeq: 4,
            truncated: [],
            scopes: {
              deny_list: { items: [{ revokedAccountIds: [], revokedTokenIds: [] }], nextCursor: null },
              staff: { items: [], nextCursor: null },
              booth: {
                items: [
                  {
                    stationId: STATION,
                    configVersionId: '018f1d2c-0000-7000-8000-00000403fc01',
                    version: 2,
                    bundleHash: 'c'.repeat(64),
                    allowedStaff: [ACCOUNT],
                    voucherDefinitions: [],
                    bundle: {
                      schemaVersion: 1,
                      settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
                      layout: {
                        id: '018f1d2c-0000-7000-8000-00000403fa00',
                        name: 'Classic wheel',
                        version: 1,
                        design: {},
                        assetManifest: {},
                      },
                      prizes: [
                        {
                          id: '018f1d2c-0000-7000-8000-00000403e001',
                          nameEn: 'Ice cream voucher',
                          nameTh: null,
                          wheelLabel: null,
                          weightBp: 10_000,
                          active: true,
                          dailyCap: null,
                          expiryDays: 14,
                          costSatang: 5_000,
                          sliceColor: null,
                          textColor: null,
                          sortOrder: 0,
                          voucherDefinitionId: '018f1d2c-0000-7000-8000-00000403fd01',
                        },
                      ],
                    },
                  },
                ],
                nextCursor: null,
              },
              receipt_series: { items: [], nextCursor: null },
            },
          });
        case '/box/v1/heartbeat':
          if (cloud.refuseHeartbeats) return reply(401, { error: { code: 'BOX_UNAUTHORIZED' } });
          if (body) cloud.heartbeats.push(body);
          return reply(200, {
            receivedAt: new Date().toISOString(),
            serverTime: new Date().toISOString(),
            clockOffsetMs: 0,
            configVersion: bundle.configVersion,
            minSupportedAgentVersion: '0.1.0',
            heartbeatIntervalS: 60,
            // As the api answers: the box polls when this is above zero.
            commandsPending: cloud.queued.length,
            epoch: cloud.epoch,
            devicesMatched: 0,
            devicesUnknown: 0,
          });
        case '/box/v1/commands/poll': {
          const commands = cloud.queued.splice(0).map((command) => ({
            id: command.id,
            kind: command.kind,
            payload: null,
            actionId: null,
            attempts: 1,
            expiresAt: null,
            createdAt: new Date().toISOString(),
          }));
          return reply(200, { commands, serverTime: new Date().toISOString() });
        }
        default:
          // The outbox push: kept on the box, so every fact can be read back.
          return reply(503, { error: { code: 'NOT_HERE' } });
      }
    },
  };
  return cloud;
}

interface Hit {
  status: number;
  json: () => Record<string, unknown>;
  body: string;
}

function hit(port: number, method: string, path: string, body?: unknown): Promise<Hit> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            json: () => JSON.parse(text) as Record<string, unknown>,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function run(
  home: string,
  cloud: FakeCloud,
  extra: Partial<Parameters<typeof startRunner>[0]> = {},
): Promise<RunningBox> {
  return startRunner({
    home,
    apiBaseUrl: 'http://cloud.test',
    port: 0,
    pageDir: pageDir(),
    fetch: cloud.fetch,
    log: quiet,
    verifySecret: null,
    ...extra,
  });
}

/** A box that has run: claimed, its config and its wheel on the card, stopped. */
async function ranOnce(cloud: FakeCloud): Promise<string> {
  const home = tempHome();
  await claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet });
  const first = await run(home, cloud);
  await first.stop();
  return home;
}

/**
 * Damage one b-tree page the way a card does — its header overwritten — in a
 * store no process has open. Returns the page. The WAL is folded in first, so
 * the page on disk is the page SQLite reads.
 */
function damagePage(file: string, objectName: string): number {
  const db = new DatabaseSync(file);
  const root = (
    db.prepare('select rootpage from sqlite_master where name = ?').all(objectName)[0] as {
      rootpage: number;
    }
  ).rootpage;
  const pageSize = (db.prepare('pragma page_size').all()[0] as { page_size: number }).page_size;
  db.exec('pragma wal_checkpoint(TRUNCATE)');
  db.close();
  const fd = openSync(file, 'r+');
  try {
    writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, (root - 1) * pageSize);
  } finally {
    closeSync(fd);
  }
  return root;
}

/**
 * Put a good store in place while a box that needs service may be looking at
 * the file: on Windows a look holds it open for a moment.
 */
async function copyGoodSoon(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      copyFileSync(from, to);
      return;
    } catch (err) {
      if (attempt > 20) throw err;
      await wait(20);
    }
  }
}

function rmSyncQuiet(file: string): void {
  rmSync(file, { force: true });
}

/** Rows of a stopped box's store, read directly. */
function readRows<T>(file: string, sql: string): T[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

/**
 * One press's facts in a stopped box's store: the spin and its voucher first
 * (and whatever became of its paper after them), every one at `epoch`, at
 * sequences 1, 2, 3 … with no gap.
 */
function assertJournal(file: string, epoch: number): void {
  const facts = readRows<{ journal_epoch: number; box_seq: number; type: string }>(
    file,
    'select journal_epoch, box_seq, type from box_outbox order by box_seq',
  );
  assert.ok(facts.length >= 2, `the press was recorded (${facts.length} facts)`);
  assert.deepEqual(
    facts.slice(0, 2).map((f) => f.type),
    ['booth.spin_recorded', 'promo.voucher_issued'],
  );
  assert.deepEqual(
    facts.map((f) => [f.journal_epoch, f.box_seq]),
    facts.map((_, index) => [epoch, index + 1]),
  );
}

function lastHeartbeatErrors(cloud: FakeCloud): Array<{ fingerprint: string; code: string; count: number }> {
  const beat = cloud.heartbeats[cloud.heartbeats.length - 1];
  return (beat?.errors ?? []) as Array<{ fingerprint: string; code: string; count: number }>;
}

function lastHeartbeat(cloud: FakeCloud): Record<string, unknown> {
  return cloud.heartbeats[cloud.heartbeats.length - 1] ?? {};
}

/**
 * `count` facts the cloud never had, in a stopped box's store, each big
 * enough that the table runs over many pages.
 */
function queueUnsent(file: string, count: number): void {
  const db = new DatabaseSync(file);
  try {
    const insert = db.prepare(
      `insert into box_outbox (event_id, box_id, journal_epoch, box_seq, type, occurred_at, payload,
                               payload_hash, sig, state, created_at)
       values (?, ?, 1, ?, 'booth.spin_recorded', ?, ?, ?, ?, 'queued', ?)`,
    );
    for (let n = 1; n <= count; n += 1) {
      const at = new Date(Date.UTC(2026, 8, 25, 1, n)).toISOString();
      insert.run(`ev-${n}`, BOX, n, at, JSON.stringify({ n, pad: 'x'.repeat(900) }), `h${n}`, `s${n}`, at);
    }
  } finally {
    db.close();
  }
}

/**
 * Damage the leaf page in the middle of a table, the way `damagePage` damages
 * one: a read of the table gets through the rows before that page and stops
 * at it. The table must be big enough for its root to be an interior page.
 */
function damageMiddleLeaf(file: string, table: string): number {
  const db = new DatabaseSync(file);
  const root = (
    db.prepare('select rootpage from sqlite_master where name = ?').all(table)[0] as { rootpage: number }
  ).rootpage;
  const pageSize = (db.prepare('pragma page_size').all()[0] as { page_size: number }).page_size;
  db.exec('pragma wal_checkpoint(TRUNCATE)');
  db.close();
  // An interior table page: its cells point at the pages below it, and the
  // header's last word at the right-most one.
  const bytes = readFileSync(file);
  const at = (root - 1) * pageSize;
  assert.equal(bytes[at], 0x05, `${table} spans more than one page`);
  const children: number[] = [];
  for (let cell = 0; cell < bytes.readUInt16BE(at + 3); cell += 1) {
    children.push(bytes.readUInt32BE(at + bytes.readUInt16BE(at + 12 + cell * 2)));
  }
  children.push(bytes.readUInt32BE(at + 8));
  const page = children[Math.floor(children.length / 2)]!;
  const fd = openSync(file, 'r+');
  try {
    writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, (page - 1) * pageSize);
  } finally {
    closeSync(fd);
  }
  return page;
}

/** An opener whose read-write store refuses the journal's note once, as a failing card refuses a write. */
function refusingJournalNote(): OpenDatabase {
  let refuse = true;
  return (file: string, options?: { readOnly?: boolean }) => {
    const db = new DatabaseSync(file, options?.readOnly ? { readOnly: true } : {});
    if (options?.readOnly) return db;
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!/insert into "box_runtime"/.test(sql)) return statement;
        return {
          all: (...params: unknown[]) => statement.all(...(params as never[])),
          run: (...params: unknown[]) => {
            if (refuse && params.includes(JOURNAL_EPOCH_KEY)) {
              refuse = false;
              throw sqliteError('disk I/O error', 10);
            }
            return statement.run(...(params as never[]));
          },
        };
      },
      close: () => db.close(),
    };
  };
}

/** What `node:sqlite` throws, with its result code: 11 malformed, 10 a read or write refused. */
function sqliteError(message: string, errcode: number): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });
}

/** An opener whose read-write store refuses one read of the journal's note, as a failing card refuses a read. */
function refusingJournalNoteRead(): OpenDatabase {
  let refuse = true;
  return (file: string, options?: { readOnly?: boolean }) => {
    const db = new DatabaseSync(file, options?.readOnly ? { readOnly: true } : {});
    if (options?.readOnly) return db;
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!/select value from "box_runtime"/.test(sql)) return statement;
        return {
          all: (...params: unknown[]) => {
            if (refuse && params.includes(JOURNAL_EPOCH_KEY)) {
              refuse = false;
              throw sqliteError('disk I/O error', 10);
            }
            return statement.all(...(params as never[]));
          },
          run: (...params: unknown[]) => statement.run(...(params as never[])),
        };
      },
      close: () => db.close(),
    };
  };
}

/** Somebody "starts clean": the store and its WAL moved aside, the credential kept. */
function moveStoreAside(database: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${database}${suffix}`)) renameSync(`${database}${suffix}`, `${database}${suffix}.moved`);
  }
}

/** The root page of an index or table in a store no process has open, as it stands on disk. */
function readRootPage(file: string, objectName: string): { page: number; bytes: Buffer } {
  const db = new DatabaseSync(file);
  const page = (
    db.prepare('select rootpage from sqlite_master where name = ?').all(objectName)[0] as { rootpage: number }
  ).rootpage;
  const pageSize = (db.prepare('pragma page_size').all()[0] as { page_size: number }).page_size;
  db.exec('pragma wal_checkpoint(TRUNCATE)');
  db.close();
  return { page, bytes: Buffer.from(readFileSync(file).subarray((page - 1) * pageSize, page * pageSize)) };
}

/** Write a page back as it was read: a card that lost the later write of it and kept the writes beside it. */
function writePageBack(file: string, held: { page: number; bytes: Buffer }): void {
  const db = new DatabaseSync(file);
  db.exec('pragma wal_checkpoint(TRUNCATE)');
  db.close();
  const fd = openSync(file, 'r+');
  try {
    writeSync(fd, held.bytes, 0, held.bytes.length, (held.page - 1) * held.bytes.length);
  } finally {
    closeSync(fd);
  }
}

// --- (1) A store that cannot be read at all -----------------------------------

test('a store overwritten with garbage: the kiosk answers, health is 503 with the reason, the log says so, and the process stays up', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);
  const garbage = Buffer.alloc(12_288, 0x5a);
  writeFileSync(paths.database, garbage);

  const { log, lines } = capture();
  let restarts = 0;
  const began = Date.now();
  const box = await run(home, cloud, { log, onRestartNeeded: () => (restarts += 1) });
  try {
    // No exit: the start resolved, and nothing asked for a new process.
    assert.ok(Date.now() - began < 10_000, 'the start did not hang on the store');
    assert.equal(restarts, 0);
    assert.equal(box.storeFault?.store, 'unreadable');

    const health = await hit(box.port, 'GET', '/kiosk/health');
    assert.equal(health.status, 503);
    const said = health.json();
    assert.equal(said.ok, false);
    assert.equal(said.store, 'unreadable');
    assert.equal(said.salvaged, 0, 'nothing could be read out of it');
    assert.equal(said.salvageFile, null);
    assert.match(String(said.salvageError), /not a database/, 'and the reason is given');

    // The television has a page, and the page's state says what to show.
    assert.equal((await hit(box.port, 'GET', '/')).status, 200);
    const state = await hit(box.port, 'GET', '/kiosk/state');
    assert.equal(state.status, 200);
    assert.deepEqual(state.json().service, { store: 'unreadable' });
    assert.deepEqual(state.json().booths, []);

    // A press is refused by name, never tried against the store.
    const spin = await hit(box.port, 'POST', '/booth/spin', { idempotencyKey: 'garbage-1' });
    assert.equal(spin.status, 503);
    assert.equal((spin.json().error as { code: string }).code, 'needs_service');
    // Nor can the box be claimed or pointed at a booth meanwhile.
    assert.equal((await hit(box.port, 'POST', '/kiosk/claim', { code: CODE })).status, 503);

    // The log says what happened, and what to do.
    const needs = lines.find((l) => /could not be read: the booth needs service/.test(l.msg));
    assert.ok(needs, 'the log names the fault');
    assert.equal(needs.level, 'error');
    assert.equal(needs.obj.store, 'unreadable');
    assert.ok(lines.some((l) => /no unsent record could be read/.test(l.msg)));
    assert.ok(lines.some((l) => /sudo oto-box claim --force/.test(l.msg)), 'and the way back');

    // The Console hears it: a heartbeat went out with the fault.
    assert.deepEqual(lastHeartbeatErrors(cloud)[0], {
      fingerprint: 'store:unreadable',
      code: 'box.store_unreadable',
      count: 1,
    });

    // Nothing was moved or deleted: the same bytes, where they were.
    assert.deepEqual(readFileSync(paths.database), garbage);
  } finally {
    await box.stop();
  }
});

// --- (2) A store that opens and is damaged ------------------------------------

test('a store with a damaged page: health 503 "damaged", a press refused with the needs-service answer, the heartbeat carries it', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);
  damagePage(paths.database, 'station_event_station_received_idx');
  // The store still opens and still prepares: before this ticket the box ran
  // on it, health said 200, and every press failed as it wrote.
  const bytes = statSync(paths.database).size;

  const box = await run(home, cloud);
  try {
    const health = await hit(box.port, 'GET', '/kiosk/health');
    assert.equal(health.status, 503);
    assert.equal(health.json().store, 'damaged');

    const spin = await hit(box.port, 'POST', '/booth/spin', { idempotencyKey: 'damaged-1' });
    assert.equal(spin.status, 503);
    assert.equal((spin.json().error as { code: string }).code, 'needs_service');
    assert.deepEqual((await hit(box.port, 'GET', '/kiosk/state')).json().service, { store: 'damaged' });

    // The fault rides the heartbeat as a fingerprint and a count, no contents.
    await box.agent.heartbeat();
    const fault = lastHeartbeatErrors(cloud).find((e) => e.fingerprint === 'store:damaged');
    assert.deepEqual(fault, { fingerprint: 'store:damaged', code: 'box.store_damaged', count: 1 });
    assert.equal(box.agent.state.registered, true, 'the box still reports as itself');
    assert.equal(box.agent.booth(), null, 'and runs no booth on a store it cannot trust');
    assert.equal(statSync(paths.database).size, bytes, 'the file is left as it was');
  } finally {
    await box.stop();
  }
});

test('a store that passes the look and fails as it is prepared, "malformed", is named damaged wherever the error comes from', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  // The read-only look finds nothing wrong; opening it to run on — the WAL
  // switch and the schema — meets a page the look did not reach.
  const openDatabase = (file: string, options?: { readOnly?: boolean }) => {
    const db = new DatabaseSync(file, options?.readOnly ? { readOnly: true } : {});
    if (options?.readOnly) return db;
    return {
      exec: () => {
        throw sqliteError('database disk image is malformed', 11);
      },
      prepare: (sql: string) => db.prepare(sql),
      close: () => db.close(),
    };
  };
  const box = await run(home, cloud, { openDatabase });
  try {
    const health = await hit(box.port, 'GET', '/kiosk/health');
    assert.equal(health.status, 503);
    assert.equal(health.json().store, 'damaged', 'not "unreadable": the same error from the agent is "damaged"');
    assert.equal(box.storeFault?.store, 'damaged');
    await box.agent.heartbeat();
    assert.equal(lastHeartbeatErrors(cloud)[0]?.code, 'box.store_damaged');
  } finally {
    await box.stop();
  }
});

// --- (3) A good store ---------------------------------------------------------

test('a good store: health 200, no notice, a press is recorded, and the heartbeat carries no store fault', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const box = await run(home, cloud);
  try {
    const health = await hit(box.port, 'GET', '/kiosk/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json(), { ok: true });
    assert.equal(box.storeFault, null);
    const state = (await hit(box.port, 'GET', '/kiosk/state')).json();
    assert.equal(state.service, null);
    assert.equal(state.selectedStationId, STATION);
    const spin = await hit(box.port, 'POST', '/booth/spin', { idempotencyKey: 'good-1' });
    assert.equal(spin.status, 200);
    assert.match(String(spin.json().voucherCode), /^BR/);
    assert.equal(
      lastHeartbeatErrors(cloud).some((e) => e.fingerprint.startsWith('store:')),
      false,
    );
    assert.deepEqual(
      readdirSync(home).filter((name) => name.includes('.salvage-')),
      [],
      'nothing to salvage from a good store',
    );
  } finally {
    await box.stop();
  }
});

// --- (4) The unsent outbox, copied out ----------------------------------------

test('the unsent outbox is copied out of a damaged store into a salvage file beside it, once, and health counts it', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);

  // Three facts the cloud never had, one it acknowledged, as the store keeps them.
  const db = new DatabaseSync(paths.database);
  const insert = db.prepare(
    `insert into box_outbox (event_id, box_id, journal_epoch, box_seq, type, occurred_at, payload,
                             payload_hash, sig, state, created_at)
     values (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const at = (minute: number) => `2026-09-25T0${minute}:00:00.000Z`;
  insert.run('ev-acked', BOX, 1, 'booth.spin_recorded', at(1), '{"n":1}', 'h1', 's1', 'acked', at(1));
  insert.run('ev-2', BOX, 2, 'booth.spin_recorded', at(2), '{"n":2}', 'h2', 's2', 'queued', at(2));
  insert.run('ev-3', BOX, 3, 'promo.voucher_issued', at(3), '{"n":3}', 'h3', 's3', 'queued', at(3));
  insert.run('ev-4', BOX, 4, 'booth.spin_recorded', at(4), '{"n":4}', 'h4', 's4', 'sending', at(4));
  db.close();
  damagePage(paths.database, 'station_event_station_received_idx');

  const { log, lines } = capture();
  const box = await run(home, cloud, { log });
  let salvageFile: string;
  try {
    const health = (await hit(box.port, 'GET', '/kiosk/health')).json();
    assert.equal(health.store, 'damaged');
    assert.equal(health.salvaged, 3, 'queued and sending, not acked');
    assert.equal(health.salvageError, null);
    salvageFile = String(health.salvageFile);
    assert.equal(salvageFile.startsWith(`${paths.database}.salvage-`), true, 'beside the store');
    assert.ok(salvageFile.endsWith('.json'));
    assert.ok(
      lines.some((l) => /3 unsent record\(s\) were copied out of the store/.test(l.msg)),
      'the log counts them',
    );

    const saved = JSON.parse(readFileSync(salvageFile, 'utf8')) as SalvageDocument;
    assert.equal(saved.kind, 'oto-box.outbox-salvage');
    assert.equal(saved.store, 'damaged');
    assert.equal(saved.rows, 3);
    assert.equal(saved.complete, true);
    assert.deepEqual(
      saved.events.map((e) => [e.event_id, e.box_seq, e.state]),
      [
        ['ev-2', 2, 'queued'],
        ['ev-3', 3, 'queued'],
        ['ev-4', 4, 'sending'],
      ],
    );
    // Every column as the store held it: the signed envelope is untouched.
    assert.equal(saved.events[1]!.payload, '{"n":3}');
    assert.equal(saved.events[1]!.sig, 's3');
    assert.equal(saved.events[1]!.box_id, BOX);

    // The Console sees three facts waiting, not the none a box with no store would say.
    await box.agent.heartbeat();
    const beat = cloud.heartbeats[cloud.heartbeats.length - 1]!;
    assert.equal(beat.outboxDepth, 3);
    assert.equal(typeof beat.oldestUnackedS, 'number');
    // Nothing moved: the damaged store is still there, for the claim that sets it aside.
    assert.ok(existsSync(paths.database));
  } finally {
    await box.stop();
  }

  // A restart — the nightly reboot, or by hand — does not write the copy again.
  const again = await run(home, cloud);
  try {
    const health = (await hit(again.port, 'GET', '/kiosk/health')).json();
    assert.equal(health.salvaged, 3);
    assert.equal(health.salvageFile, salvageFile);
    assert.equal(readdirSync(home).filter((name) => name.includes('.salvage-')).length, 1);
  } finally {
    await again.stop();
  }

  // `oto-box status` says the same.
  const io = streams();
  assert.equal(await main(['status', '--home', home], io), 0);
  assert.match(io.out(), /^store {7}damaged — the booth needs service \(PI_BOOTH\.md section 7/m);
  assert.match(io.out(), /^salvage {5}3 unsent record\(s\) copied out of the store to .*\.salvage-/m);
});

test('an outbox that could not be read in full keeps the Console refusing Reset the store: at least one unsent record, of unknown age', async () => {
  // The Console refuses Reset the store while the box's last heartbeat says
  // anything is unsent, and that number is all it goes on. A box with no
  // store says none; where nothing, or not everything, could be read out of
  // the file, none is not known — so it says at least one.

  // Nothing could be read: the file is not a database.
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  writeFileSync(runnerPaths(home).database, Buffer.alloc(8192, 0x5a));
  const unreadable = await run(home, cloud);
  try {
    await unreadable.agent.heartbeat();
    assert.equal(lastHeartbeat(cloud).outboxDepth, 1, 'not the none a box with no store would say');
    assert.equal(lastHeartbeat(cloud).oldestUnackedS, null);
  } finally {
    await unreadable.stop();
  }

  // Part of it: the rows before a damaged page of the outbox, and none after.
  const partialCloud = fakeCloud();
  const partialHome = await ranOnce(partialCloud);
  const database = runnerPaths(partialHome).database;
  queueUnsent(database, 60);
  damageMiddleLeaf(database, 'box_outbox');
  const partial = await run(partialHome, partialCloud);
  let read = 0;
  let salvageFile = '';
  try {
    const health = (await hit(partial.port, 'GET', '/kiosk/health')).json();
    assert.equal(health.store, 'damaged');
    read = Number(health.salvaged);
    assert.ok(read > 0 && read < 60, `the rows before the damage were read, and no more (${read})`);
    assert.match(String(health.salvageError), /malformed/);
    salvageFile = String(health.salvageFile);
    assert.equal((JSON.parse(readFileSync(salvageFile, 'utf8')) as SalvageDocument).complete, false);

    await partial.agent.heartbeat();
    assert.equal(lastHeartbeat(partialCloud).outboxDepth, read);
    assert.equal(
      lastHeartbeat(partialCloud).oldestUnackedS,
      null,
      'the oldest may be among the rows that could not be read',
    );
  } finally {
    await partial.stop();
  }

  // Restarted on the same file, the box reuses the copy it made, and says the same.
  const again = await run(partialHome, partialCloud);
  try {
    assert.equal((await hit(again.port, 'GET', '/kiosk/health')).json().salvageFile, salvageFile);
    await again.agent.heartbeat();
    assert.equal(lastHeartbeat(partialCloud).outboxDepth, read);
    assert.equal(lastHeartbeat(partialCloud).oldestUnackedS, null);
  } finally {
    await again.stop();
  }
});

test('the salvage reads the outbox table, not its send index: a damaged index page still gives every unsent row, complete, and the Console hears them all', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);
  queueUnsent(paths.database, 5);
  // The send index's one page, damaged; every row is intact in the table.
  damagePage(paths.database, 'box_outbox_send_idx');

  const box = await run(home, cloud);
  try {
    const health = (await hit(box.port, 'GET', '/kiosk/health')).json();
    assert.equal(health.store, 'damaged');
    assert.equal(health.salvaged, 5, 'every unsent row, where the index gave none');
    assert.equal(health.salvageError, null);
    const saved = JSON.parse(readFileSync(String(health.salvageFile), 'utf8')) as SalvageDocument;
    assert.equal(saved.complete, true);
    assert.deepEqual(
      saved.events.map((e) => e.event_id),
      ['ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5'],
    );

    await box.agent.heartbeat();
    assert.equal(lastHeartbeat(cloud).outboxDepth, 5, 'the Console hears every one');
    assert.equal(typeof lastHeartbeat(cloud).oldestUnackedS, 'number', 'read in full: the oldest is known');
  } finally {
    await box.stop();
  }

  // `oto-box status` counts them in the table too, rather than "could not be read".
  const io = streams();
  assert.equal(await main(['status', '--home', home], io), 0);
  assert.match(io.out(), /^outbox {6}5 fact\(s\) waiting to reach the cloud/m);

  // Why: the unsent rows' condition is exactly the one the partial index
  // `box_outbox_send_idx` is built on, so a plain read walks that index.
  const plain = new DatabaseSync(':memory:');
  try {
    prepareSqliteBoxStore(plain);
    const plan = (plain.prepare(`explain query plan ${UNSENT_OUTBOX_SQL}`).all() as Array<{ detail: string }>).map(
      (row) => row.detail,
    );
    assert.ok(plan.some((detail) => /box_outbox/.test(detail)), plan.join('; '));
    assert.equal(plan.some((detail) => /\bINDEX\b/i.test(detail)), false, `the table itself: ${plan.join('; ')}`);
  } finally {
    plain.close();
  }
});

test('a send index the card left stale hides no unsent row: the salvage counts the table, not the "none" the index says', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const database = runnerPaths(home).database;
  // The send index's page as it stood with nothing unsent; three facts the
  // cloud never had; that page written back. The index still reads well —
  // the look the box takes does not match an index against its table — and
  // says nothing is unsent. Damage elsewhere is what stops the box.
  const before = readRootPage(database, 'box_outbox_send_idx');
  queueUnsent(database, 3);
  writePageBack(database, before);
  assert.equal(
    readRows<{ n: number }>(database, `select count(*) as n from box_outbox where state in ('queued', 'sending')`)[0]?.n,
    0,
    'read through the index, the store has nothing unsent',
  );
  damagePage(database, 'station_event_station_received_idx');

  const { log, lines } = capture();
  const box = await run(home, cloud, { log });
  try {
    const health = (await hit(box.port, 'GET', '/kiosk/health')).json();
    assert.equal(health.store, 'damaged');
    assert.equal(health.salvaged, 3, 'not the none the index says');
    const saved = JSON.parse(readFileSync(String(health.salvageFile), 'utf8')) as SalvageDocument;
    assert.equal(saved.complete, true);
    assert.deepEqual(
      saved.events.map((e) => e.event_id),
      ['ev-1', 'ev-2', 'ev-3'],
    );
    assert.equal(
      lines.some((l) => /holds no unsent record/.test(l.msg)),
      false,
      'the log does not say there is nothing to save',
    );

    // Three, so the Console goes on refusing Reset the store.
    await box.agent.heartbeat();
    assert.equal(lastHeartbeat(cloud).outboxDepth, 3);
  } finally {
    await box.stop();
  }

  const io = streams();
  assert.equal(await main(['status', '--home', home], io), 0);
  assert.match(io.out(), /^outbox {6}3 fact\(s\) waiting to reach the cloud/m);
});

// --- (5) No new fact before a fresh epoch -------------------------------------

test('a store made by a claim seals under the epoch the registration named, never the default', async () => {
  const cloud = fakeCloud();
  cloud.registerEpoch = 3;
  const home = tempHome();
  await claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet });
  const box = await run(home, cloud);
  try {
    assert.equal(box.agent.state.journalAwaitingEpoch, false);
    const spin = await hit(box.port, 'POST', '/booth/spin', { idempotencyKey: 'epoch-3' });
    assert.equal(spin.status, 200);
  } finally {
    await box.stop();
  }
  const database = runnerPaths(home).database;
  assertJournal(database, 3);
  const [noted] = readRows<{ value: string }>(
    database,
    `select value from box_runtime where runtime_key = '${JOURNAL_EPOCH_KEY}'`,
  );
  assert.deepEqual(
    { ...(JSON.parse(noted!.value) as Record<string, unknown>), at: null },
    { state: 'taken', epoch: 3, from: 'register', at: null },
  );
});

test('a new store under the identity the box already had records nothing until the platform mints a new epoch', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);
  // The old store's journal: facts at epoch 1 that the cloud may already hold.
  const first = await run(home, cloud);
  assert.equal((await hit(first.port, 'POST', '/booth/spin', { idempotencyKey: 'old-1' })).status, 200);
  await first.stop();

  // Somebody "starts clean": the store moved aside, the credential kept.
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${paths.database}${suffix}`)) {
      renameSync(`${paths.database}${suffix}`, `${paths.database}${suffix}.moved`);
    }
  }

  const { log, lines } = capture();
  const box = await run(home, cloud, { log });
  try {
    assert.equal((await hit(box.port, 'GET', '/kiosk/health')).status, 200, 'the store itself is fine');
    assert.equal(box.agent.state.journalAwaitingEpoch, true);
    assert.ok(lines.some((l) => /records nothing until the platform gives it a new journal epoch/.test(l.msg)));

    // A press before the new epoch is refused as "not ready", and seals nothing.
    const spin = await hit(box.port, 'POST', '/booth/spin', { idempotencyKey: 'early-1' });
    assert.equal(spin.status, 409);
    const refusal = spin.json().error as { code: string; message: string };
    assert.equal(refusal.code, 'booth_not_ready');
    assert.match(refusal.message, /journal epoch/);
    assert.equal((await box.agent.outbox()!.depth()).queued, 0);

    // The Console hears that it waits.
    await box.agent.heartbeat();
    assert.deepEqual(
      lastHeartbeatErrors(cloud).find((e) => e.fingerprint === 'journal:awaiting_epoch'),
      { fingerprint: 'journal:awaiting_epoch', code: 'box.journal_awaiting_epoch', count: 1 },
    );
  } finally {
    await box.stop();
  }

  // A restart keeps waiting: the wait is on the card, not in memory.
  const restarted = await run(home, cloud);
  try {
    assert.equal(restarted.agent.state.journalAwaitingEpoch, true);
    assert.equal(
      (await hit(restarted.port, 'POST', '/booth/spin', { idempotencyKey: 'early-2' })).status,
      409,
    );

    // A heartbeat names the platform's current epoch: not a new one, so no way out.
    await restarted.agent.heartbeat();
    assert.equal(restarted.agent.state.journalAwaitingEpoch, true);

    // Console → Devices → the box → Reset the store: the command, its result, the new epoch.
    cloud.queued.push({ id: 'reset-1', kind: 'reset_store' });
    assert.equal(await restarted.agent.runPendingCommands(), 1);
    assert.equal(cloud.epoch, 2);
    assert.equal(restarted.agent.state.journalAwaitingEpoch, false);

    const spin = await hit(restarted.port, 'POST', '/booth/spin', { idempotencyKey: 'after-reset-1' });
    assert.equal(spin.status, 200);
    await restarted.agent.heartbeat();
    assert.equal(lastHeartbeatErrors(cloud).some((e) => e.fingerprint === 'journal:awaiting_epoch'), false);
  } finally {
    await restarted.stop();
  }
  // The new store's journal starts at the new epoch, at sequence 1.
  assertJournal(paths.database, 2);
});

test('a claim that registers the same box again onto a new store waits for a new epoch; a new box does not', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  // The same box id comes back: a claim code issued again for the same row.
  await claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet, force: true });
  const same = await run(home, cloud);
  try {
    assert.equal(same.agent.state.journalAwaitingEpoch, true);
    assert.equal((await hit(same.port, 'POST', '/booth/spin', { idempotencyKey: 'same-1' })).status, 409);
  } finally {
    await same.stop();
  }

  // The guide's way: a new box in the Console, so a new identity.
  cloud.registersAs = OTHER_BOX;
  await claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet, force: true });
  const fresh = await run(home, cloud);
  try {
    assert.equal(fresh.agent.state.boxId, OTHER_BOX);
    assert.equal(fresh.agent.state.journalAwaitingEpoch, false);
    assert.equal((await hit(fresh.port, 'POST', '/booth/spin', { idempotencyKey: 'new-1' })).status, 200);
  } finally {
    await fresh.stop();
  }
});

test('a same-box claim whose new store the running box made in the moment after the set-aside still waits for a new epoch', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);
  // The old store's journal: a press at epoch 1, sequence 1, which the cloud may already hold.
  const first = await run(home, cloud);
  try {
    assert.equal((await hit(first.port, 'POST', '/booth/spin', { idempotencyKey: 'old-1' })).status, 200);
  } finally {
    await first.stop();
  }

  // The claim sets the old identity aside, and in that moment the running box
  // — its store tried again while it needs service, or a start whose look for
  // a claim under way came just before this one marked itself — opens the
  // store where the old one was, and so makes an empty one there before the
  // claim makes its own.
  let madeInTheWindow = false;
  const log: AgentLog = {
    info() {},
    warn(_obj, msg) {
      if (msg !== 'the previous identity was set aside') return;
      const db = new DatabaseSync(paths.database);
      prepareSqliteBoxStore(db);
      db.close();
      madeInTheWindow = true;
    },
    error() {},
  };
  // The same box id comes back: a claim code issued again for the same row.
  await claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log, force: true });
  assert.equal(madeInTheWindow, true);
  const [noted] = readRows<{ value: string }>(
    paths.database,
    `select value from box_runtime where runtime_key = '${JOURNAL_EPOCH_KEY}'`,
  );
  assert.equal((JSON.parse(noted!.value) as { state: string }).state, 'awaiting', 'the row waits, from the claim on');

  const same = await run(home, cloud);
  try {
    assert.equal(same.agent.state.boxId, BOX);
    assert.equal(same.agent.state.journalAwaitingEpoch, true);
    const spin = await hit(same.port, 'POST', '/booth/spin', { idempotencyKey: 'same-window-1' });
    assert.equal(spin.status, 409);
    assert.equal((spin.json().error as { code: string }).code, 'booth_not_ready');
  } finally {
    await same.stop();
  }
  assert.deepEqual(
    readRows(paths.database, 'select box_seq from box_outbox'),
    [],
    'nothing sealed at an address the set-aside store already used',
  );
});

test('the row and its "awaiting" note land together: a note the card refuses takes the row back with it, and the store still waits, after a restart too', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);
  // Somebody "starts clean": the store moved aside, the credential kept.
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${paths.database}${suffix}`)) {
      renameSync(`${paths.database}${suffix}`, `${paths.database}${suffix}.moved`);
    }
  }
  // The card refuses the write of the journal's note, once.
  const openDatabase = refusingJournalNote();

  const { log, lines } = capture();
  const box = await run(home, cloud, { log, openDatabase, storeRetryMs: 100 });
  try {
    // A write the card refused is a store the box cannot use: said so, not
    // swallowed — and the next try, which the card takes, waits as it should.
    let status = 0;
    for (let i = 0; i < 200 && status !== 200; i += 1) {
      status = (await hit(box.port, 'GET', '/kiosk/health')).status;
      if (status !== 200) await wait(25);
    }
    assert.equal(status, 200);
    assert.ok(lines.some((l) => /the booth needs service/.test(l.msg)), 'the refused write was a store fault');
    assert.ok(lines.some((l) => /can be used again: the booth starts/.test(l.msg)));
    assert.equal(box.agent.state.journalAwaitingEpoch, true);
  } finally {
    await box.stop();
  }

  // A restart reads the note off the card: the wait was never only in memory.
  const restarted = await run(home, cloud);
  try {
    assert.equal(restarted.agent.state.journalAwaitingEpoch, true);
    const spin = await hit(restarted.port, 'POST', '/booth/spin', { idempotencyKey: 'refused-note-1' });
    assert.equal(spin.status, 409);
    assert.equal((spin.json().error as { code: string }).code, 'booth_not_ready');
  } finally {
    await restarted.stop();
  }
  assert.deepEqual(readRows(paths.database, 'select box_seq from box_outbox'), [], 'nothing was sealed');
});

test('an "awaiting" note and one read of it the card refuses: no press is ever answered 200 — the box needs service, then waits for its epoch', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);
  // The old store's journal: a press at epoch 1, sequence 1.
  const first = await run(home, cloud);
  try {
    assert.equal((await hit(first.port, 'POST', '/booth/spin', { idempotencyKey: 'old-1' })).status, 200);
  } finally {
    await first.stop();
  }
  // A new store under the same identity: its row is made with an "awaiting" note.
  moveStoreAside(paths.database);
  const waiting = await run(home, cloud);
  try {
    assert.equal(waiting.agent.state.journalAwaitingEpoch, true);
  } finally {
    await waiting.stop();
  }

  // The card refuses the one read of that note. A read that fails is not "no
  // note": a store that cannot say whether its journal waits is one the box
  // cannot use, and the next try reads the note and waits.
  const { log, lines } = capture();
  const box = await run(home, cloud, { log, openDatabase: refusingJournalNoteRead(), storeRetryMs: 100 });
  const answers: number[] = [];
  try {
    // Read before anything yields to the retry timer: the start met a store it could not use.
    assert.equal(box.storeFault?.store, 'unreadable');
    let status = 0;
    for (let i = 0; i < 200 && status !== 200; i += 1) {
      answers.push((await hit(box.port, 'POST', '/booth/spin', { idempotencyKey: `refused-read-${i}` })).status);
      status = (await hit(box.port, 'GET', '/kiosk/health')).status;
      if (status !== 200) await wait(25);
    }
    assert.equal(status, 200, 'the next try runs');
    assert.ok(lines.some((l) => /could not say whether its journal waits/.test(l.msg)));
    assert.ok(lines.some((l) => /the booth needs service/.test(l.msg)));
    assert.equal(box.agent.state.journalAwaitingEpoch, true);
    const spin = await hit(box.port, 'POST', '/booth/spin', { idempotencyKey: 'refused-read-after' });
    answers.push(spin.status);
    assert.equal(spin.status, 409);
    assert.equal((spin.json().error as { code: string }).code, 'booth_not_ready');
  } finally {
    await box.stop();
  }
  assert.equal(answers.includes(200), false, `no press answered 200 (${answers.join(', ')})`);
  assert.deepEqual(readRows(paths.database, 'select box_seq from box_outbox'), [], 'nothing was sealed');
});

test('a journal note that is there and cannot be read as one holds the journal, as "awaiting" does', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const database = runnerPaths(home).database;
  // The claim's note says "taken". The card keeps half of it, or none of its text.
  for (const garbled of ['{"state":"tak', '']) {
    const db = new DatabaseSync(database);
    try {
      const changed = db
        .prepare('update box_runtime set value = ? where runtime_key = ?')
        .run(garbled, JOURNAL_EPOCH_KEY) as { changes: number | bigint };
      assert.equal(Number(changed.changes), 1);
    } finally {
      db.close();
    }
    const box = await run(home, cloud);
    try {
      assert.equal((await hit(box.port, 'GET', '/kiosk/health')).status, 200, 'the store itself reads');
      assert.equal(box.agent.state.journalAwaitingEpoch, true, JSON.stringify(garbled));
      const spin = await hit(box.port, 'POST', '/booth/spin', { idempotencyKey: `garbled-${garbled.length}` });
      assert.equal(spin.status, 409);
      assert.equal((spin.json().error as { code: string }).code, 'booth_not_ready');
    } finally {
      await box.stop();
    }
  }
  assert.deepEqual(readRows(database, 'select box_seq from box_outbox'), [], 'nothing was sealed');
});

test('a claim typed on the television whose store refuses what the registration writes: the box needs service, never half claimed', async () => {
  const cloud = fakeCloud();
  const home = tempHome();
  const box = await run(home, cloud, {
    openDatabase: refusingJournalNote(),
    storeRetryMs: 600_000,
  });
  try {
    assert.equal((await hit(box.port, 'GET', '/kiosk/state')).json().registered, false);
    const claimed = await hit(box.port, 'POST', '/kiosk/claim', { code: CODE });
    // The code was taken: the credential is on the card. The page looks again and finds the notice.
    assert.deepEqual(claimed.json(), { ok: true });
    const health = await hit(box.port, 'GET', '/kiosk/health');
    assert.equal(health.status, 503);
    assert.equal(health.json().store, 'unreadable');
    assert.deepEqual((await hit(box.port, 'GET', '/kiosk/state')).json().service, { store: 'unreadable' });
    // And the Console hears the new box, with its fault.
    await box.agent.heartbeat();
    assert.equal(box.agent.state.boxId, BOX);
    assert.equal(lastHeartbeatErrors(cloud)[0]?.code, 'box.store_unreadable');
    // The row went back with the note it was written beside.
    assert.deepEqual(readRows(runnerPaths(home).database, 'select box_id from box_state'), []);
  } finally {
    await box.stop();
  }
});

test('a claim in a terminal whose new store refuses the journal note, written or read back, says the card may be failing', async () => {
  // The write refused in the registration's transaction, and the read of the
  // note refused as the store is attached: either way the claim names the
  // card, and never goes on as if the journal had no note.
  for (const [made, openDatabase] of [
    ['written', refusingJournalNote()],
    ['read', refusingJournalNoteRead()],
  ] as const) {
    const cloud = fakeCloud();
    const home = tempHome();
    await assert.rejects(
      claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet, openDatabase }),
      (err: unknown) =>
        err instanceof Error &&
        /could not be written or read \(disk I\/O error\): the memory card may be failing/.test(err.message),
      `the note ${made}`,
    );
  }
});

// --- (6) The card recovers ----------------------------------------------------

test('a store that cannot be read and is then replaced by a good one is picked up by the next try, without a restart', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);
  const good = join(home, 'good.sqlite');
  copyFileSync(paths.database, good);
  // Zeros: a card that lost the writes it said were saved.
  writeFileSync(paths.database, Buffer.alloc(8192, 0x00));

  const { log, lines } = capture();
  let restarts = 0;
  const box = await run(home, cloud, {
    log,
    storeRetryMs: 150,
    onRestartNeeded: () => (restarts += 1),
  });
  try {
    assert.equal((await hit(box.port, 'GET', '/kiosk/health')).status, 503);
    const reporter = box.agent;
    // Another failed try is counted before the card comes back.
    for (let i = 0; i < 40 && (box.storeFault?.checks ?? 0) < 2; i += 1) await wait(25);
    assert.ok((box.storeFault?.checks ?? 0) >= 2, 'the store was tried again');

    // The card comes back (or an engineer puts a good copy in place).
    await copyGoodSoon(good, paths.database);
    let status = 0;
    for (let i = 0; i < 100 && status !== 200; i += 1) {
      status = (await hit(box.port, 'GET', '/kiosk/health')).status;
      if (status !== 200) await wait(25);
    }
    assert.equal(status, 200, 'the box runs again');
    assert.equal(restarts, 0, 'in the same process');
    assert.equal(box.storeFault, null);
    assert.notEqual(box.agent, reporter, 'on a new agent, with the store');
    assert.ok(lines.some((l) => /can be used again: the booth starts/.test(l.msg)));

    const state = (await hit(box.port, 'GET', '/kiosk/state')).json();
    assert.equal(state.service, null);
    assert.equal(state.registered, true);
    const spin = await hit(box.port, 'POST', '/booth/spin', { idempotencyKey: 'recovered-1' });
    assert.equal(spin.status, 200);
  } finally {
    await box.stop();
  }
});

test('the way back the notice names: claim --force onto a new box while the service needs service; the next try runs as the new box', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);
  const garbage = Buffer.alloc(8192, 0x5a);
  writeFileSync(paths.database, garbage);

  const box = await run(home, cloud, { storeRetryMs: 200 });
  try {
    assert.equal(box.agent.state.boxId, BOX, 'still reporting as the old box');
    assert.equal((await hit(box.port, 'GET', '/kiosk/health')).status, 503);

    // PI_BOOTH §7 steps 1 and 2: a new box in the Console, its code typed at the prompt.
    cloud.registersAs = OTHER_BOX;
    await claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet, force: true });

    let status = 0;
    for (let i = 0; i < 200 && status !== 200; i += 1) {
      status = (await hit(box.port, 'GET', '/kiosk/health')).status;
      if (status !== 200) await wait(25);
    }
    assert.equal(status, 200, 'step 3: the service picks the new box up by itself');
    assert.equal(box.agent.state.boxId, OTHER_BOX);
    assert.equal(box.agent.state.journalAwaitingEpoch, false, 'a new box’s journal is clean');
    const state = (await hit(box.port, 'GET', '/kiosk/state')).json();
    assert.equal(state.service, null);
    assert.equal(state.registered, true);
    // The new box's store is empty until its first pull brings the wheel,
    // a moment after the box runs.
    let version: unknown = null;
    for (let i = 0; i < 200 && version === null; i += 1) {
      version = (await hit(box.port, 'GET', '/booth/config')).json().version ?? null;
      if (version === null) await wait(25);
    }
    assert.equal(version, 2, 'the wheel arrived');
    assert.equal((await hit(box.port, 'POST', '/booth/spin', { idempotencyKey: 'new-box-1' })).status, 200);

    // The damaged store was set aside by the claim, not deleted.
    const aside = readdirSync(home).filter((name) => name.startsWith('box.sqlite.replaced-'));
    assert.equal(aside.length, 1);
    assert.deepEqual(readFileSync(join(home, aside[0]!)), garbage);
  } finally {
    await box.stop();
  }
});

test('a claim under way holds the pickup and the start; one that died holding its lock does not', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);
  const lock = join(home, 'claiming.json');
  const good = join(home, 'good.sqlite');
  copyFileSync(paths.database, good);
  writeFileSync(paths.database, Buffer.alloc(8192, 0x5a));

  const box = await run(home, cloud, { storeRetryMs: 100 });
  try {
    // A claim in a terminal is making the store: a good store, but half made
    // as far as this process can tell.
    writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: new Date().toISOString() }));
    await copyGoodSoon(good, paths.database);
    await wait(600);
    assert.equal((await hit(box.port, 'GET', '/kiosk/health')).status, 503, 'not picked up mid-claim');

    rmSyncQuiet(lock);
    let status = 0;
    for (let i = 0; i < 200 && status !== 200; i += 1) {
      status = (await hit(box.port, 'GET', '/kiosk/health')).status;
      if (status !== 200) await wait(25);
    }
    assert.equal(status, 200, 'picked up once the claim is done');
  } finally {
    await box.stop();
  }

  // A box that starts while a claim runs waits for it, saying "starting".
  const port = await freePort();
  writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: new Date().toISOString() }));
  const booting = run(home, cloud, { port });
  try {
    let answered = 0;
    for (let i = 0; i < 100 && answered === 0; i += 1) {
      answered = await hit(port, 'GET', '/kiosk/health').then(
        (r) => r.status,
        () => 0,
      );
      if (answered === 0) await wait(20);
    }
    assert.equal(answered, 503, 'listening, and starting');
    assert.equal(
      ((await hit(port, 'GET', '/kiosk/state')).json().error as { code: string }).code,
      'starting',
    );
    rmSyncQuiet(lock);
    const started = await booting;
    assert.equal((await hit(started.port, 'GET', '/kiosk/health')).status, 200);
  } finally {
    await booting.then(
      (started) => started.stop(),
      () => undefined,
    );
  }

  // A lock from a claim that died ten minutes ago holds nothing.
  writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: new Date(Date.now() - 600_000).toISOString() }));
  const unheld = await run(home, cloud);
  try {
    assert.equal((await hit(unheld.port, 'GET', '/kiosk/health')).status, 200);
  } finally {
    await unheld.stop();
    rmSyncQuiet(lock);
  }
});

test('the old box refused while a claim is picked up: the new box’s credential is neither taken nor wiped', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);
  writeFileSync(paths.database, Buffer.alloc(8192, 0x5a));
  // No try of the store inside this test: the window between the claim and
  // the pickup is held open.
  const box = await run(home, cloud, { storeRetryMs: 600_000 });
  try {
    assert.equal(box.agent.state.boxId, BOX);
    cloud.registersAs = OTHER_BOX;
    await claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet, force: true });

    // Somebody retires the old box in that minute: its credential is refused.
    cloud.refuseHeartbeats = true;
    await box.agent.heartbeat();
    assert.equal(box.agent.state.registered, false, 'the reporter lets go of the old box');
    assert.notEqual(box.agent.state.boxId, OTHER_BOX, 'and does not take the new one for its own');
    const held = JSON.parse(readFileSync(paths.credential, 'utf8')) as { boxId: string };
    assert.equal(held.boxId, OTHER_BOX, 'the new credential is still on the card');
  } finally {
    await box.stop();
  }

  // The next process runs as the new box.
  cloud.refuseHeartbeats = false;
  const next = await run(home, cloud);
  try {
    assert.equal((await hit(next.port, 'GET', '/kiosk/health')).status, 200);
    assert.equal(next.agent.state.boxId, OTHER_BOX);
  } finally {
    await next.stop();
  }
});

test('a start that fails for a reason other than the store closes the kiosk it opened, so the process can end', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const port = await freePort();
  // The store is fine; what breaks is not SQLite's (no result code on it).
  const openDatabase = (file: string, options?: { readOnly?: boolean }) => {
    const db = new DatabaseSync(file, options?.readOnly ? { readOnly: true } : {});
    if (options?.readOnly) return db;
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        if (/insert into "box_state"/.test(sql)) throw new Error('not a store fault');
        return db.prepare(sql);
      },
      close: () => db.close(),
    };
  };
  await assert.rejects(
    () => run(home, cloud, { port, openDatabase }),
    /not a store fault/,
  );
  await assert.rejects(() => hit(port, 'GET', '/kiosk/health'), /ECONNREFUSED/, 'nothing left listening');
});

// --- The Console's commands while the box needs service -------------------------

test('Reset the store pressed while the box needs service waits for the store: no result, no new epoch; once the store is back it runs there, and the next press seals at the new epoch from 1', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const paths = runnerPaths(home);
  const good = join(home, 'good.sqlite');
  copyFileSync(paths.database, good);
  // Damaged, with nothing unsent in it: the one kind of fault for which the
  // Console lets Reset the store through (it refuses while the box reports
  // anything unsent), and the fault its text invites the press for.
  damagePage(paths.database, 'station_event_station_received_idx');

  const box = await run(home, cloud, { storeRetryMs: 100, pollIntervalMs: 50 });
  try {
    assert.equal((await hit(box.port, 'GET', '/kiosk/health')).json().store, 'damaged');
    const reporter = box.agent;
    await reporter.heartbeat();
    assert.equal(lastHeartbeat(cloud).outboxDepth, 0, 'read in full, nothing unsent: the Console allows the press');

    // Console → Devices → the box → Reset the store.
    cloud.queued.push({ id: 'reset-1', kind: 'reset_store' });
    // The heartbeat's answer says a command waits, which makes the box ask
    // for it — and its timer asks every 50 ms here.
    await reporter.heartbeat();
    assert.equal(await reporter.runPendingCommands(), 0, 'a box that needs service runs no command');
    await wait(300);
    assert.equal(cloud.results.length, 0, 'no result: the command was never handed out');
    assert.equal(cloud.epoch, 1, 'no new epoch while the store seals under the one it has');
    assert.deepEqual(
      cloud.queued.map((c) => c.id),
      ['reset-1'],
      'still queued, for the box that has the store',
    );
    assert.equal(box.storeFault?.store, 'damaged');

    // The card recovers.
    await copyGoodSoon(good, paths.database);
    let status = 0;
    for (let i = 0; i < 200 && status !== 200; i += 1) {
      status = (await hit(box.port, 'GET', '/kiosk/health')).status;
      if (status !== 200) await wait(25);
    }
    assert.equal(status, 200, 'the box runs on its store again');
    assert.notEqual(box.agent, reporter);

    // Its first poll takes the reset and runs it on the store.
    for (let i = 0; i < 200 && box.agent.state.epoch !== 2; i += 1) await wait(25);
    assert.deepEqual(
      cloud.results.map((r) => [r.id, (r.body as { state?: string }).state]),
      [['reset-1', 'succeeded']],
    );
    assert.equal(cloud.epoch, 2);
    assert.equal(box.agent.state.epoch, 2);
    assert.equal(box.agent.state.journalAwaitingEpoch, false);
    const spin = await hit(box.port, 'POST', '/booth/spin', { idempotencyKey: 'after-reset-1' });
    assert.equal(spin.status, 200);
  } finally {
    await box.stop();
  }
  // Sealed under the epoch the reset minted, at sequence 1 — not under the
  // closed one, where the platform would quarantine every fact.
  assertJournal(paths.database, 2);
});

// --- The way back: claim --force on a box that needs service -------------------

test('claim --force sets a store it cannot use aside even with no identity to replace; without --force it says why', async () => {
  const cloud = fakeCloud();
  const home = tempHome();
  const paths = runnerPaths(home);
  // A box never claimed, whose store the card spoiled.
  writeFileSync(paths.database, Buffer.alloc(4096, 0x5a));
  await assert.rejects(
    () => claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet }),
    (err: unknown) => err instanceof Error && /could not be read .*--force/.test(err.message),
  );
  const { boxId } = await claimBox({
    home,
    apiBaseUrl: 'http://cloud.test',
    code: CODE,
    fetch: cloud.fetch,
    log: quiet,
    force: true,
  });
  assert.equal(boxId, BOX);
  assert.equal(existsSync(join(home, 'claiming.json')), false, 'the claim lets go of its lock');
  const aside = readdirSync(home).filter((name) => name.startsWith('box.sqlite.replaced-'));
  assert.equal(aside.length, 1, 'set aside, not deleted');
  assert.deepEqual(readFileSync(join(home, aside[0]!)), Buffer.alloc(4096, 0x5a));
  const box = await run(home, cloud);
  try {
    assert.equal((await hit(box.port, 'GET', '/kiosk/health')).status, 200);
  } finally {
    await box.stop();
  }
});

test('oto-box status names a store that could not be read, and a good one', async () => {
  const cloud = fakeCloud();
  const home = await ranOnce(cloud);
  const ok = streams();
  assert.equal(await main(['status', '--home', home], ok), 0);
  assert.match(ok.out(), /^store {7}ok$/m);
  assert.match(ok.out(), /^outbox {6}0 fact\(s\) waiting/m);

  writeFileSync(runnerPaths(home).database, Buffer.alloc(4096, 0x5a));
  const bad = streams();
  assert.equal(await main(['status', '--home', home], bad), 0);
  assert.match(bad.out(), /^store {7}could not be read — the booth needs service/m);
  assert.match(bad.out(), /^outbox {6}\(the store could not be read\)/m);
});

function streams(): CliStreams & { out(): string } {
  let out = '';
  const stdin = new PassThrough();
  stdin.end();
  return {
    stdin,
    stdout: { write: (chunk: string) => ((out += chunk), true) },
    stderr: { write: () => true },
    out: () => out,
  };
}
