import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { escposProfile, renderJob, type PrintJob as RenderPrintJob } from '@oto/print';
import { createBoxAgent, type BoxAgent } from '../src/agent';
import type { SpinResponse } from '@oto/shared';
import { BoothRefusal, type Booth } from '../src/booth';
import { memoryCredentialStore, type CredentialStore } from '../src/credentials';
import type { SyncPushRequest, SyncPushResponse } from '../src/contract';
import {
  BOX_CLOCK_SKEW_ERROR,
  BOX_HEARTBEAT_STALE_ERROR,
  type BoxHeartbeatRequest,
  type BoxHeartbeatStaleDetails,
} from '../src/protocol';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { AgentFetch, AgentResponse } from '../src/transport';
import { BRANCH_ID, OPERATOR_ID, seededIndex } from './_support';

/**
 * SCRUM-402 — the box measures its own clock against the platform.
 *
 * The agent is the real one, on a real SQLite store, behind a cloud faked at
 * the HTTP boundary that keeps the api's two heartbeat rules: fifteen minutes
 * of skew is refused as `BOX_CLOCK_SKEW` with the cloud's time in the details,
 * and a `reportedAt` at or before the last one accepted is refused as stale,
 * with the cloud's time and that last one in the details.
 * The cloud's clock is the machine's unless a case pins it; the box's is set
 * per case, from the cloud's. What is read back is what the box wrote down —
 * the outbox rows, as they will be sent, and the slip, rendered as the
 * printer receives it — so every assertion is about the box's own record
 * rather than about its answers.
 *
 * The same scenario against the real api, with Health and the ledger, is
 * `apps/api/test/box-clock.test.ts`.
 */

const BOX = '018f1d2c-0000-7000-8000-0000000c1c01';
const STATION = '018f1d2c-0000-7000-8000-0000000c1571';
const PRINTER = '018f1d2c-0000-7000-8000-0000000c1de1';
const PRIZE = '018f1d2c-0000-7000-8000-0000000c1e11';
const TIME_ZONE = 'Asia/Bangkok';
const HOUR = 3_600_000;
const quiet = { info() {}, warn() {}, error() {} };

/**
 * 06:30 on 25 September 2026 at the park, which is 23:30 UTC on the 24th: an
 * hour and a half into the trading day that starts at 05:00. A Pi twelve
 * hours behind believes it is 18:30 on the 24th.
 */
const PINNED_AT = Date.parse('2026-09-24T23:30:00.000Z');

/** The platform's clock, at `PINNED_AT` from the moment this is called and running on from there. */
function pinnedPlatformClock(): () => number {
  const startedAt = Date.now();
  return () => PINNED_AT + (Date.now() - startedAt);
}

/**
 * The slip's issue time at the pinned moment, as the slip prints it: "Sept"
 * or "Sep" is the runtime's own word for the month, and either is right.
 */
const ISSUED_AT_0630_ON_THE_25TH = /^25 Sept? 2026 06:30$/;

/** What the booth prints as the issue time: its own `formatStamp`, in the branch's zone. */
function issuedWords(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(ms))
    .replace(',', '');
}

/** The calendar date `days` after the one `ms` falls on in the branch's zone, as the slip prints it. */
function expiryWords(ms: number, days: number): string {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
  const at = new Date(`${ymd}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
    .format(at)
    .replace(',', '');
}

/** The park's calendar date of an instant, as yyyy-mm-dd. */
function parkDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/**
 * What becomes of one heartbeat on the wire (see `CloudOptions.onHeartbeat`):
 *
 *  - `'no-answer'`: it never gets one — the router has no line yet after a
 *    power cut;
 *  - `'answer-lost'`: the cloud takes it and accepts it, and the answer
 *    never comes back;
 *  - a status: the edge answers for the cloud with a page that is not JSON —
 *    a 502 or 503 during a deploy.
 */
type HeartbeatFate = 'no-answer' | 'answer-lost' | number;

interface CloudOptions {
  /** The platform's clock: the machine's unless a case pins it. */
  now?: () => number;
  /** The booth's "Spins per day": none unless a case sets it. */
  dailySpinCap?: number | null;
  /**
   * Runs as heartbeat number `n` (from 1) reaches the cloud, before the cloud
   * takes its time. A case gives it a fate here, or moves a clock here to
   * have it move while the heartbeat is on the wire.
   */
  onHeartbeat?: (n: number) => HeartbeatFate | void;
  /** Runs once the cloud has taken its time, before its answer goes back. */
  afterServerTime?: (n: number) => void;
  /**
   * False: a heartbeat refused as stale carries no details, as a platform from
   * before the stale refusal said what time it was.
   */
  staleDetails?: boolean;
  /**
   * Whether the push is answered: accepted in full while this says so, a 503
   * otherwise — which is the default, and keeps every fact on the box.
   */
  push?: () => boolean;
}

interface FakeCloud {
  fetch: AgentFetch;
  /**
   * Every heartbeat the box sent: what it carried, and the status the cloud
   * or its edge gave it — 0 for one that got no answer at all.
   */
  heartbeats: Array<{ sent: BoxHeartbeatRequest; status: number; answer: unknown }>;
  /** Every event the cloud accepted from a push, by id. */
  pushed: string[];
}

/** The edge answering for the cloud: its own page, which is not JSON. */
function edgePage(status: number): AgentResponse {
  return {
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
    text: async () => `<html><body><h1>${status}</h1></body></html>`,
    header: () => null,
  };
}

/** The cloud side of the wire, keeping the api's clock rules. */
function fakeCloud(options: CloudOptions = {}): FakeCloud {
  const now = options.now ?? ((): number => Date.now());
  let watermark: number | null = null;
  const cloud: FakeCloud = {
    heartbeats: [],
    pushed: [],
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body ? (JSON.parse(init.body) as unknown) : undefined;
      const reply = (status: number, json: unknown, etag?: string): AgentResponse => ({
        status,
        json: async () => json,
        text: async () => JSON.stringify(json),
        header: (name) => (name.toLowerCase() === 'etag' ? (etag ?? null) : null),
      });
      switch (path) {
        case '/box/v1/register':
          return reply(200, {
            boxId: BOX,
            secret: 'fake-secret-for-tests-only',
            name: 'Clock box',
            slot: 'clock-1',
            role: 'booth',
            branchId: BRANCH_ID,
            operatorId: OPERATOR_ID,
            epoch: 1,
            heartbeatIntervalS: 60,
            minSupportedAgentVersion: '0.1.0',
          });
        case '/box/v1/config':
          return reply(200, configBundle(), '"cfg-clock"');
        case '/box/v1/cache':
          return reply(200, cacheBundle(options.dailySpinCap ?? null));
        case '/box/v1/heartbeat': {
          const sent = body as BoxHeartbeatRequest;
          const n = cloud.heartbeats.length + 1;
          const fate = options.onHeartbeat?.(n);
          if (fate === 'no-answer') {
            cloud.heartbeats.push({ sent, status: 0, answer: null });
            throw new Error('connect ETIMEDOUT: the router has no line yet');
          }
          if (typeof fate === 'number') {
            cloud.heartbeats.push({ sent, status: fate, answer: null });
            return edgePage(fate);
          }
          const receivedAt = now();
          options.afterServerTime?.(n);
          const reported = Date.parse(sent.reportedAt);
          const offset = reported - receivedAt;
          let status = 200;
          let answer: unknown;
          if (Math.abs(offset) > 900_000) {
            status = 400;
            answer = {
              error: {
                code: BOX_CLOCK_SKEW_ERROR,
                message: 'clock skew',
                details: {
                  serverTime: new Date(receivedAt).toISOString(),
                  clockOffsetMs: offset,
                  maxClockSkewS: 900,
                },
              },
            };
          } else if (watermark !== null && reported <= watermark) {
            status = 409;
            const details: BoxHeartbeatStaleDetails = {
              serverTime: new Date(receivedAt).toISOString(),
              lastAcceptedReportedAt: new Date(watermark).toISOString(),
            };
            answer = {
              error: {
                code: BOX_HEARTBEAT_STALE_ERROR,
                message: 'stale',
                ...(options.staleDetails === false ? {} : { details }),
              },
            };
          } else {
            watermark = reported;
            answer = {
              receivedAt: new Date(receivedAt).toISOString(),
              serverTime: new Date(receivedAt).toISOString(),
              clockOffsetMs: offset,
              configVersion: 'cfg-clock',
              minSupportedAgentVersion: '0.1.0',
              heartbeatIntervalS: 60,
              commandsPending: 0,
              epoch: 1,
              devicesMatched: 1,
              devicesUnknown: 0,
            };
          }
          cloud.heartbeats.push({ sent, status, answer });
          if (fate === 'answer-lost') throw new Error('socket hang up: the answer was lost');
          return reply(status, answer);
        }
        case '/box/v1/commands/poll':
          return reply(200, { commands: [], serverTime: new Date(now()).toISOString() });
        case '/box/v1/sync/push': {
          if (!options.push?.()) return reply(503, { error: { code: 'NOT_HERE' } });
          const request = body as SyncPushRequest;
          cloud.pushed.push(...request.events.map((event) => event.eventId));
          const accepted: SyncPushResponse = {
            applied: request.events.length,
            duplicates: 0,
            quarantined: 0,
            rejected: 0,
            results: request.events.map((event) => ({
              eventId: event.eventId,
              boxSeq: event.boxSeq,
              result: 'applied' as const,
            })),
            cursorSeq: request.events.at(-1)?.boxSeq ?? 0,
            epoch: 1,
            batchId: 'clock-batch',
            serverTime: new Date(now()).toISOString(),
          };
          return reply(200, accepted);
        }
        default:
          // The push and the print-result route: a 503 keeps every fact on the
          // box, which is where this file reads them.
          return reply(503, { error: { code: 'NOT_HERE' } });
      }
    },
  };
  return cloud;
}

function configBundle() {
  return {
    configVersion: 'cfg-clock',
    box: { id: BOX, name: 'Clock box', slot: 'clock-1', role: 'booth', epoch: 1, status: 'online' },
    branch: {
      id: BRANCH_ID,
      code: 'hkt-central',
      name: 'Oto Play Park, Central Floresta',
      operatorId: OPERATOR_ID,
      timezone: TIME_ZONE,
      openingHours: null,
      businessDayStart: '05:00',
    },
    stations: [
      {
        id: STATION,
        name: 'Clock Booth',
        kind: 'booth',
        codePrefix: 'CB',
        capabilities: [],
        configVersion: 1,
        paymentRouting: null,
        offlineWalletCapSatang: null,
        accessScope: 'all_staff',
        devices: [
          {
            id: PRINTER,
            role: 'receipt',
            kind: 'receipt_printer',
            label: 'Booth printer',
            transport: 'simulated',
            address: '192.168.88.207:9100',
            model: 'Xprinter XP-80',
            protocol: 'escpos',
            serialNumber: null,
            terminalId: null,
            merchantId: null,
            settings: {},
          },
        ],
      },
    ],
    printTemplates: [],
    signingKeys: [],
    heartbeatIntervalS: 60,
    minSupportedAgentVersion: '0.1.0',
  };
}

function cacheBundle(dailySpinCap: number | null) {
  return {
    schemaVersion: 1,
    bundleVersion: 'cache-clock',
    cursorSeq: 1,
    truncated: [],
    scopes: {
      deny_list: { items: [{ revokedAccountIds: [], revokedTokenIds: [] }], nextCursor: null },
      staff: { items: [], nextCursor: null },
      booth: {
        items: [
          {
            stationId: STATION,
            configVersionId: '018f1d2c-0000-7000-8000-0000000c1f01',
            version: 3,
            bundleHash: 'c'.repeat(64),
            allowedStaff: [],
            voucherDefinitions: [],
            bundle: {
              schemaVersion: 1,
              settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap },
              layout: {
                id: '018f1d2c-0000-7000-8000-0000000c1a00',
                name: 'Classic wheel',
                version: 1,
                design: {},
                assetManifest: {},
              },
              prizes: [
                {
                  id: PRIZE,
                  nameEn: 'Clock voucher',
                  nameTh: null,
                  wheelLabel: null,
                  weightBp: 10_000,
                  active: true,
                  dailyCap: null,
                  expiryDays: 14,
                  costSatang: 10_000,
                  sliceColor: null,
                  textColor: null,
                  sortOrder: 0,
                  voucherDefinitionId: '018f1d2c-0000-7000-8000-0000000c1d01',
                },
              ],
            },
          },
        ],
        nextCursor: null,
      },
      receipt_series: { items: [], nextCursor: null },
    },
  };
}

interface Box {
  agent: BoxAgent;
  booth: Booth;
  store: SqlBoxStore;
  stop(): void;
}

/**
 * One process of a box: the agent on `db`, its raw clock `offsetMs` from
 * `base` — the platform's clock, the machine's unless a case pins it — and
 * the boot `bootId`. Nothing is started: every heartbeat and every press
 * below is made by hand.
 */
async function openBox(
  db: DatabaseSync,
  cloud: FakeCloud,
  credentials: CredentialStore,
  opts: {
    offsetMs: () => number;
    bootId: string;
    base?: () => number;
    monotonic?: () => number;
  },
): Promise<Box> {
  const base = opts.base ?? ((): number => Date.now());
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });
  const agent = createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials,
    claimCode: async () => 'CLOCK-CLAIM',
    hostname: 'clock-test',
    fetch: cloud.fetch,
    log: quiet,
    store,
    now: () => base() + opts.offsetMs(),
    ...(opts.monotonic ? { monotonic: opts.monotonic } : {}),
    bootId: opts.bootId,
    booth: { randomIndex: seededIndex(402) },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  await agent.syncCache();
  const booth = agent.booth();
  assert.ok(booth, 'the agent built no booth module');
  await booth.start();
  assert.ok(booth.config(), 'the booth adopted no wheel from the cache');
  return {
    agent,
    booth,
    store,
    stop() {
      booth.stop();
      agent.stop();
    },
  };
}

function newDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  return db;
}

interface OutboxRow {
  eventId: string;
  type: string;
  occurredAt: string;
  clockTrust: string;
  clockOffsetMs: number | null;
  payload: Record<string, unknown>;
}

/** The outbox as it will be sent, read without taking a batch. */
function outboxRows(db: DatabaseSync): OutboxRow[] {
  const rows = db
    .prepare(
      `select event_id, type, occurred_at, clock_trust, clock_offset_ms, payload
         from box_outbox where box_id = ? order by journal_epoch, box_seq`,
    )
    .all(BOX) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    eventId: String(row.event_id),
    type: String(row.type),
    occurredAt: String(row.occurred_at),
    clockTrust: String(row.clock_trust),
    clockOffsetMs: row.clock_offset_ms === null ? null : Number(row.clock_offset_ms),
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
  }));
}

/** When each event still waiting to go is next to be tried: null for one never deferred. */
function retryTimes(db: DatabaseSync): Array<string | null> {
  const rows = db
    .prepare(
      `select next_attempt_at from box_outbox
        where box_id = ? and state in ('queued', 'failed')
        order by journal_epoch, box_seq`,
    )
    .all(BOX) as Array<Record<string, unknown>>;
  return rows.map((row) => (row.next_attempt_at === null ? null : String(row.next_attempt_at)));
}

/** The two facts a press queued, found by its spin id. */
function factsOf(db: DatabaseSync, spin: SpinResponse): OutboxRow[] {
  return outboxRows(db).filter(
    (row) =>
      (row.type === 'booth.spin_recorded' || row.type === 'promo.voucher_issued') &&
      row.payload.spinId === spin.spinId,
  );
}

/** One of those two facts. */
function factOf(db: DatabaseSync, spin: SpinResponse, type: string): OutboxRow {
  const fact = factsOf(db, spin).find((row) => row.type === type);
  assert.ok(fact, `the press queued no ${type}`);
  return fact;
}

/** Every line of text the slip for this press puts on paper, rendered as the printer gets it. */
async function slipText(store: SqlBoxStore, spin: SpinResponse): Promise<string[]> {
  const jobs = await store.loadPendingPrintJobs(BOX);
  const record = jobs.find((job) => {
    const printed = job.job as RenderPrintJob;
    return printed.kind === 'booth_voucher' && printed.data.voucherCode === spin.voucherCode;
  });
  assert.ok(record, 'the press left no slip on the box');
  const rendered = renderJob(record.job as RenderPrintJob, {
    device: escposProfile({ id: 'booth-printer', label: 'Booth printer', model: 'test', widthDots: 576 }),
  });
  assert.ok(rendered.bytes.length > 0, 'the slip renders to nothing a printer could burn');
  return rendered.layout.items
    .filter((item) => item.k === 'text')
    .map((item) => (item as { text: string }).text);
}

/** Within the few seconds a test takes, whichever side of a minute it lands. */
function assertNear(actualMs: number, expectedMs: number, what: string): void {
  assert.ok(
    Math.abs(actualMs - expectedMs) < 10_000,
    `${what}: ${new Date(actualMs).toISOString()} is not within seconds of ${new Date(expectedMs).toISOString()}`,
  );
}

/** The slip's issue time for a press made between `before` and `after`, on the clock that stamped it. */
function assertIssued(lines: string[], before: number, after: number, what: string): void {
  const expected = new Set([issuedWords(before), issuedWords(after)]);
  assert.ok(
    lines.some((line) => expected.has(line)),
    `${what}: the slip says ${JSON.stringify(lines)}, expected one of ${[...expected].join(' / ')}`,
  );
}

/** A whole line of the slip matching `pattern`. */
function assertSlipSays(lines: string[], pattern: RegExp, what: string): void {
  assert.ok(
    lines.some((line) => pattern.test(line)),
    `${what}: the slip says ${JSON.stringify(lines)}, expected a line matching ${pattern}`,
  );
}

test('a box that has not heard the platform stamps untrusted and prints its own time; the first answer corrects both', async () => {
  const db = newDb();
  const cloud = fakeCloud();
  const behind = -3 * HOUR;
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    offsetMs: () => behind,
    bootId: 'boot-b',
  });
  try {
    assert.equal(box.agent.state.clockOffsetMs, null, 'nothing measured before the platform answers');

    // Before any heartbeat: the machine's clock, untrusted, no offset.
    const before = Date.now();
    const early = await box.booth.spin({ idempotencyKey: 'press-early' });
    const after = Date.now();
    const earlyFacts = factsOf(db, early);
    assert.equal(earlyFacts.length, 2, 'a press queues its spin and its voucher');
    for (const fact of earlyFacts) {
      assert.equal(fact.clockTrust, 'untrusted', `${fact.type} claimed a clock nobody measured`);
      assert.equal(fact.clockOffsetMs, null, `${fact.type} carried an offset the box does not have`);
      assertNear(Date.parse(fact.occurredAt), before + behind, `${fact.type} is not on the machine's clock`);
    }
    assert.equal(early.clockSuspect, false, 'nothing measured, and nothing lived through is later');
    assertIssued(await slipText(box.store, early), before + behind, after + behind, 'the early slip');

    // The first heartbeat is refused for the clock, and measured all the same.
    assert.equal(await box.agent.heartbeat(), null);
    assert.equal(cloud.heartbeats.at(-1)?.status, 400);
    assert.deepEqual(cloud.heartbeats.at(-1)?.sent.clock, { offsetMs: null, measuredAt: null });
    const measured = box.agent.state.clockOffsetMs;
    assert.ok(measured !== null && Math.abs(measured - behind) < 5_000, `measured ${measured}`);

    // From here: the platform's time, trusted, nothing left over — and the
    // spin is flagged, because the machine's clock is hours out.
    const before2 = Date.now();
    const late = await box.booth.spin({ idempotencyKey: 'press-late' });
    const after2 = Date.now();
    for (const fact of factsOf(db, late)) {
      assert.equal(fact.clockTrust, 'trusted', `${fact.type} is not trusted after the measurement`);
      assert.equal(fact.clockOffsetMs, 0, `${fact.type} carried the raw offset, not what is left of it`);
      assertNear(Date.parse(fact.occurredAt), before2, `${fact.type} is not on the platform's time`);
    }
    assert.equal(late.clockSuspect, true, 'three hours out is past the ten-minute tolerance');
    const lines = await slipText(box.store, late);
    assertIssued(lines, before2, after2, 'the corrected slip');
    assert.ok(
      lines.includes(expiryWords(before2, 14)) || lines.includes(expiryWords(after2, 14)),
      `expiry: ${JSON.stringify(lines)}`,
    );

    // The next heartbeat carries the platform's time, is accepted, and says what was measured.
    assert.ok(await box.agent.heartbeat(), 'the corrected heartbeat was refused');
    const declared = cloud.heartbeats.at(-1)!.sent;
    assertNear(Date.parse(declared.reportedAt), Date.now(), 'reportedAt');
    assert.equal(declared.clock?.offsetMs, measured);
    assert.ok(declared.clock?.measuredAt, 'a declared offset with no time it was measured');
  } finally {
    box.stop();
    db.close();
  }
});

test('a measurement from an earlier boot is set aside; one from this boot survives a restart', async () => {
  const db = newDb();
  const cloud = fakeCloud();
  const credentials = memoryCredentialStore();
  const behind = -3 * HOUR;

  const first = await openBox(db, cloud, credentials, { offsetMs: () => behind, bootId: 'boot-1' });
  await first.agent.heartbeat();
  assert.ok(first.agent.state.clockOffsetMs !== null, 'the first process measured nothing');
  first.stop();

  // The machine rebooted: same card, same store, a different boot.
  const rebooted = await openBox(db, cloud, credentials, { offsetMs: () => behind, bootId: 'boot-2' });
  try {
    assert.equal(rebooted.agent.state.clockOffsetMs, null, 'a measurement crossed a reboot');
    const spin = await rebooted.booth.spin({ idempotencyKey: 'after-reboot' });
    for (const fact of factsOf(db, spin)) {
      assert.equal(fact.clockTrust, 'untrusted', `${fact.type} trusted a clock from another boot`);
      assert.equal(fact.clockOffsetMs, null);
    }
    await rebooted.agent.heartbeat();
    assert.deepEqual(cloud.heartbeats.at(-1)?.sent.clock, { offsetMs: null, measuredAt: null });
  } finally {
    rebooted.stop();
  }

  // The service restarted inside the boot the measurement was made in.
  const restarted = await openBox(db, cloud, credentials, { offsetMs: () => behind, bootId: 'boot-2' });
  try {
    const kept = restarted.agent.state.clockOffsetMs;
    assert.ok(kept !== null && Math.abs(kept - behind) < 5_000, `a same-boot measurement was lost: ${kept}`);
    const before = Date.now();
    const spin = await restarted.booth.spin({ idempotencyKey: 'after-restart' });
    for (const fact of factsOf(db, spin)) {
      assert.equal(fact.clockTrust, 'trusted', `${fact.type} forgot the measurement made in this boot`);
      assertNear(Date.parse(fact.occurredAt), before, `${fact.type} is not on the platform's time`);
    }
  } finally {
    restarted.stop();
    db.close();
  }
});

test('a restart in the same boot after the clock was stepped while the service was down stamps untrusted', async () => {
  const db = newDb();
  const cloud = fakeCloud();
  const credentials = memoryCredentialStore();
  let wall = -3 * HOUR;
  // The kernel's monotonic clock, which runs on across a restart of the service.
  const monotonic = (): number => Date.now();

  const first = await openBox(db, cloud, credentials, {
    offsetMs: () => wall,
    monotonic,
    bootId: 'boot-stepped-while-down',
  });
  assert.equal(await first.agent.heartbeat(), null, 'three hours out is refused');
  assert.ok(Math.abs((first.agent.state.clockOffsetMs ?? 0) + 3 * HOUR) < 5_000);
  first.stop();

  // While the service is down, NTP gets through and steps the clock three
  // hours on. Same boot: the measurement is still in the store, and it
  // describes a clock that is gone.
  wall = 0;
  const restarted = await openBox(db, cloud, credentials, {
    offsetMs: () => wall,
    monotonic,
    bootId: 'boot-stepped-while-down',
  });
  try {
    const before = Date.now();
    const spin = await restarted.booth.spin({ idempotencyKey: 'after-stepped-restart' });
    const after = Date.now();
    assert.equal(
      restarted.agent.state.clockOffsetMs,
      null,
      'a measurement of the clock from before the step was used after it',
    );
    for (const fact of factsOf(db, spin)) {
      assert.equal(fact.clockTrust, 'untrusted', `${fact.type} trusted a measurement the step made wrong`);
      assert.equal(fact.clockOffsetMs, null);
      // The raw clock, which is right now — not three hours ahead of it.
      assertNear(Date.parse(fact.occurredAt), before, `${fact.type} is not on the stepped clock`);
    }
    assertIssued(await slipText(restarted.store, spin), before, after, 'the slip after the restart');

    // The next heartbeat measures the clock as it is now.
    assert.ok(await restarted.agent.heartbeat(), 'the heartbeat after the restart was refused');
    const measured = restarted.agent.state.clockOffsetMs;
    assert.ok(measured !== null && Math.abs(measured) < 5_000, `measured ${measured}`);
    const again = await restarted.booth.spin({ idempotencyKey: 'measured-after-restart' });
    for (const fact of factsOf(db, again)) {
      assert.equal(fact.clockTrust, 'trusted');
      assert.equal(fact.clockOffsetMs, 0);
    }
  } finally {
    restarted.stop();
    db.close();
  }
});

test('a clock within the tolerance is trusted with nothing left over, and no spin is flagged', async () => {
  const db = newDb();
  const cloud = fakeCloud();
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    offsetMs: () => 30_000,
    bootId: 'boot-f',
  });
  try {
    // Thirty seconds out is inside the cloud's fifteen minutes: accepted, and measured.
    assert.ok(await box.agent.heartbeat(), 'a box thirty seconds out was refused');
    const measured = box.agent.state.clockOffsetMs;
    assert.ok(measured !== null && Math.abs(measured - 30_000) < 5_000, `measured ${measured}`);

    const before = Date.now();
    const spin = await box.booth.spin({ idempotencyKey: 'in-step' });
    assert.equal(spin.clockSuspect, false);
    for (const fact of factsOf(db, spin)) {
      assert.equal(fact.clockTrust, 'trusted');
      assert.equal(fact.clockOffsetMs, 0);
      assertNear(Date.parse(fact.occurredAt), before, `${fact.type} is not on the platform's time`);
    }
    assert.equal(factOf(db, spin, 'booth.spin_recorded').payload.clockSuspect, false);
  } finally {
    box.stop();
    db.close();
  }
});

/**
 * The spin flag's boundary: ten minutes of measured offset, either way
 * (`BOOTH_CLOCK_SUSPECT_MS`). Every case here is inside the platform's
 * fifteen, so the first heartbeat is accepted and measures the box, and the
 * press is trusted and corrected whichever side of ten minutes it falls.
 */
for (const [minutes, flagged] of [
  [9, false],
  [11, true],
  [-11, true],
] as const) {
  test(`a spin on a box ${Math.abs(minutes)} minutes ${minutes > 0 ? 'ahead' : 'behind'} is ${flagged ? '' : 'not '}flagged`, async () => {
    const db = newDb();
    const cloud = fakeCloud();
    const box = await openBox(db, cloud, memoryCredentialStore(), {
      offsetMs: () => minutes * 60_000,
      bootId: `boot-boundary-${minutes}`,
    });
    try {
      assert.ok(await box.agent.heartbeat(), 'a box inside the fifteen minutes was refused');
      const before = Date.now();
      const spin = await box.booth.spin({ idempotencyKey: `boundary-${minutes}` });
      assert.equal(spin.clockSuspect, flagged);
      assert.equal(factOf(db, spin, 'booth.spin_recorded').payload.clockSuspect, flagged);
      for (const fact of factsOf(db, spin)) {
        assert.equal(fact.clockTrust, 'trusted');
        assert.equal(fact.clockOffsetMs, 0);
        assertNear(Date.parse(fact.occurredAt), before, `${fact.type} is not on the platform's time`);
      }
    } finally {
      box.stop();
      db.close();
    }
  });
}

test('the measurement is taken against the midpoint of the exchange', async () => {
  // Both sides' clocks run on this; the cloud moves it while a heartbeat is on the wire.
  let extra = 0;
  const shared = (): number => Date.now() + extra;
  const db = newDb();
  const cloud = fakeCloud({
    now: shared,
    // Two seconds on the way there and two on the way back: the platform's
    // time is taken in the middle of a four-second exchange.
    onHeartbeat: () => {
      extra += 2_000;
    },
    afterServerTime: () => {
      extra += 2_000;
    },
  });
  const ahead = 3 * 60_000;
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    base: shared,
    offsetMs: () => ahead,
    bootId: 'boot-midpoint',
  });
  try {
    // Three minutes is inside the platform's fifteen: an accepted answer.
    assert.ok(await box.agent.heartbeat(), 'a box three minutes out was refused');
    const measured = box.agent.state.clockOffsetMs;
    assert.ok(measured !== null, 'nothing was measured');
    // The box read its clock two seconds before the platform took its time
    // and two seconds after: either reading alone is two seconds out.
    assert.ok(
      Math.abs(measured - ahead) < 500,
      `measured ${measured} ms against ${ahead} ms: not the midpoint of the exchange`,
    );
  } finally {
    box.stop();
    db.close();
  }
});

test('a box that booted hours AHEAD is accepted on the heartbeat after the refusal', async () => {
  const db = newDb();
  const cloud = fakeCloud();
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    offsetMs: () => 12 * HOUR,
    bootId: 'boot-ahead',
  });
  try {
    assert.equal(await box.agent.heartbeat(), null);
    assert.equal(cloud.heartbeats.at(-1)?.status, 400);
    // The refused future time is not a floor: the next one is the platform's.
    assert.ok(await box.agent.heartbeat(), 'the refused reportedAt held the box out');
    assertNear(Date.parse(cloud.heartbeats.at(-1)!.sent.reportedAt), Date.now(), 'reportedAt');
    const measured = box.agent.state.clockOffsetMs;
    assert.ok(measured !== null && Math.abs(measured - 12 * HOUR) < 5_000, `measured ${measured}`);
  } finally {
    box.stop();
    db.close();
  }
});

/**
 * The first heartbeat of a box hours AHEAD never reaches acceptance — the
 * router has no line yet after the power cut, or the platform is mid-deploy
 * and its edge answers 503 — and still raised the floor under `reportedAt` to
 * its future time. The refusal that follows measures the box; the heartbeat
 * after that has to carry the platform's time and be accepted, not the old
 * future time plus a millisecond, refused until real time caught up with it.
 */
for (const [what, fate, status] of [
  ['got no answer at all', 'no-answer', 0],
  ['got a 503 from the edge', 503, 503],
] as const) {
  test(`a box hours AHEAD whose first heartbeat ${what} is accepted on the heartbeat after the refusal`, async () => {
    const db = newDb();
    const cloud = fakeCloud({ onHeartbeat: (n) => (n === 1 ? fate : undefined) });
    const box = await openBox(db, cloud, memoryCredentialStore(), {
      offsetMs: () => 12 * HOUR,
      bootId: `boot-ahead-${status}`,
    });
    try {
      if (fate === 'no-answer') await assert.rejects(box.agent.heartbeat());
      else assert.equal(await box.agent.heartbeat(), null);
      assert.equal(box.agent.state.clockOffsetMs, null, 'measured off an answer that never came');

      // Refused for the clock, and measured by the refusal.
      assert.equal(await box.agent.heartbeat(), null);
      const measured = box.agent.state.clockOffsetMs;
      assert.ok(measured !== null && Math.abs(measured - 12 * HOUR) < 5_000, `measured ${measured}`);

      // Accepted: the platform's time, and online from here on.
      assert.ok(await box.agent.heartbeat(), 'the unanswered future reportedAt held the box out');
      assertNear(Date.parse(cloud.heartbeats.at(-1)!.sent.reportedAt), Date.now(), 'reportedAt');
      assert.ok(await box.agent.heartbeat(), 'the heartbeat after the accepted one was refused');
      assert.deepEqual(
        cloud.heartbeats.map((h) => h.status),
        [status, 400, 200, 200],
      );
    } finally {
      box.stop();
      db.close();
    }
  });
}

test('a floor that may be the platform’s watermark stays through a refusal for the clock', async () => {
  const db = newDb();
  // The first heartbeat is accepted and its answer lost, so the platform
  // holds its time as the last it accepted and the box has measured nothing.
  const cloud = fakeCloud({ onHeartbeat: (n) => (n === 1 ? 'answer-lost' : undefined) });
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    offsetMs: () => 10 * 60_000,
    bootId: 'boot-answer-lost',
  });
  try {
    // Ten minutes ahead is inside the platform's fifteen.
    await assert.rejects(box.agent.heartbeat());
    assert.equal(box.agent.state.clockOffsetMs, null);

    // The test control moves the raw clock two hours on: refused, and measured.
    await box.agent.advanceClock(2 * HOUR);
    assert.equal(await box.agent.heartbeat(), null);
    const measured = box.agent.state.clockOffsetMs;
    assert.ok(measured !== null && Math.abs(measured - (2 * HOUR + 10 * 60_000)) < 5_000, `measured ${measured}`);

    // Corrected, the box's clock is ten minutes behind the time the platform
    // accepted. The first heartbeat's time was within the platform's bound of
    // the refusal, so it may be the watermark and stays the floor: the next
    // report is after it, and accepted rather than refused as stale.
    assert.ok(await box.agent.heartbeat(), 'the box went back behind a time the platform had accepted');
    const [lost, , accepted] = cloud.heartbeats;
    assert.ok(Date.parse(accepted!.sent.reportedAt) > Date.parse(lost!.sent.reportedAt));
    assert.deepEqual(
      cloud.heartbeats.map((h) => h.status),
      [200, 400, 200],
    );
  } finally {
    box.stop();
    db.close();
  }
});

test('reportedAt keeps rising when a new measurement moves the clock back a few seconds', async () => {
  const db = newDb();
  const cloud = fakeCloud();
  let shift = 0;
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    offsetMs: () => shift,
    bootId: 'boot-d',
  });
  try {
    assert.ok(await box.agent.heartbeat());
    // The machine's clock steps five seconds forward: the next heartbeat reports
    // it, and its answer measures it.
    shift = 5_000;
    assert.ok(await box.agent.heartbeat());
    const high = Date.parse(cloud.heartbeats.at(-1)!.sent.reportedAt);
    // Corrected now, the clock reads five seconds EARLIER than that report.
    assert.ok(await box.agent.heartbeat(), 'a re-measurement made the box repeat an old time');
    const next = Date.parse(cloud.heartbeats.at(-1)!.sent.reportedAt);
    assert.ok(next > high, `reportedAt went from ${high} to ${next}`);
    assert.equal(
      cloud.heartbeats.filter((h) => h.status === 409).length,
      0,
      'a heartbeat was refused as stale',
    );
  } finally {
    box.stop();
    db.close();
  }
});

/**
 * A restart after the correction (SCRUM-402, round 2).
 *
 * A box ten minutes AHEAD is accepted on its raw clock and measured; from
 * then on the floor under `reportedAt` holds its reports after that first one,
 * so the platform's watermark stands ten minutes ahead of real time. The
 * service restarts in the same boot: the measurement is kept, the floor is
 * not, and the first report — the platform's time — is at or before the
 * watermark. It used to be refused as stale on every heartbeat until real
 * time passed the watermark. The refusal now names the watermark and the
 * platform's time, and the heartbeat after it is accepted.
 */
test('a box ten minutes AHEAD that restarts in the same boot is refused as stale at most once, then accepted', async () => {
  const db = newDb();
  const cloud = fakeCloud();
  const credentials = memoryCredentialStore();
  const ahead = 10 * 60_000;

  const first = await openBox(db, cloud, credentials, {
    offsetMs: () => ahead,
    bootId: 'boot-restart-ahead',
  });
  assert.ok(await first.agent.heartbeat(), 'a box ten minutes out was refused');
  assert.ok(await first.agent.heartbeat(), 'the corrected heartbeat was refused');
  const watermark = Date.parse(cloud.heartbeats.at(-1)!.sent.reportedAt);
  assert.ok(watermark > Date.now() + 9 * 60_000, 'the floor did not hold the report ahead');
  first.stop();

  const restarted = await openBox(db, cloud, credentials, {
    offsetMs: () => ahead,
    bootId: 'boot-restart-ahead',
  });
  try {
    const from = cloud.heartbeats.length;
    await restarted.agent.heartbeat();
    await restarted.agent.heartbeat();
    const statuses = cloud.heartbeats.slice(from).map((h) => h.status);
    assert.ok(
      statuses.filter((status) => status === 409).length <= 1,
      `refused as stale more than once after the restart: ${statuses.join(', ')}`,
    );
    assert.equal(statuses.at(-1), 200, `not accepted after the restart: ${statuses.join(', ')}`);
    assert.ok(
      Date.parse(cloud.heartbeats.at(-1)!.sent.reportedAt) > watermark,
      'the accepted report is not after the watermark',
    );
    const measured = restarted.agent.state.clockOffsetMs;
    assert.ok(measured !== null && Math.abs(measured - ahead) < 5_000, `measured ${measured}`);
    assert.ok(await restarted.agent.heartbeat(), 'the heartbeat after the accepted one was refused');
  } finally {
    restarted.stop();
    db.close();
  }
});

/**
 * A power cut after the correction (SCRUM-402, round 2): the gate's case.
 *
 * A Pi five minutes behind is accepted on its raw clock, measured, and from
 * then on reports the platform's time, which the platform keeps as its
 * watermark. Two minutes without power, and it comes back in a new boot seven
 * minutes behind — the five it was, and the cut. The measurement is set
 * aside, and its raw clock is inside the platform's fifteen minutes and
 * before the watermark: refused as stale. It used to be refused like that on
 * every heartbeat until real time passed the watermark, measuring nothing and
 * stamping every press untrusted. Now the refusal measures it.
 */
test('a corrected box back from a power cut minutes behind is refused as stale once, then measured, trusted and accepted', async () => {
  const startedAt = Date.now();
  let cutMs = 0;
  const platform = (): number => PINNED_AT + (Date.now() - startedAt) + cutMs;
  const db = newDb();
  const cloud = fakeCloud({ now: platform });
  const credentials = memoryCredentialStore();
  let behind = -5 * 60_000;

  const before = await openBox(db, cloud, credentials, {
    base: platform,
    offsetMs: () => behind,
    bootId: 'boot-before-the-cut',
  });
  assert.ok(await before.agent.heartbeat(), 'five minutes behind was refused');
  assert.ok(await before.agent.heartbeat(), 'the corrected heartbeat was refused');
  before.stop();

  cutMs = 2 * 60_000;
  behind = -7 * 60_000;
  const after = await openBox(db, cloud, credentials, {
    base: platform,
    offsetMs: () => behind,
    bootId: 'boot-after-the-cut',
  });
  try {
    assert.equal(after.agent.state.clockOffsetMs, null, 'a measurement crossed the reboot');
    const from = cloud.heartbeats.length;
    assert.equal(await after.agent.heartbeat(), null);
    const refused = cloud.heartbeats.at(-1)!;
    assert.equal(refused.status, 409, 'the case is a stale refusal, or it proves nothing');
    const details = (refused.answer as { error: { details?: BoxHeartbeatStaleDetails } }).error.details;
    assert.ok(details, 'the stale refusal carried nothing to measure by');

    // Measured off the refusal: seven minutes behind, and trusted from here.
    const measured = after.agent.state.clockOffsetMs;
    assert.ok(measured !== null && Math.abs(measured - behind) < 5_000, `measured ${measured}`);
    const pressed = await after.booth.spin({ idempotencyKey: 'after-the-cut' });
    for (const fact of factsOf(db, pressed)) {
      assert.equal(fact.clockTrust, 'trusted', `${fact.type} is untrusted after the measurement`);
      assert.equal(fact.clockOffsetMs, 0);
      assertNear(Date.parse(fact.occurredAt), platform(), `${fact.type} is not on the platform's time`);
    }
    assertSlipSays(await slipText(after.store, pressed), /^25 Sept? 2026 06:3\d$/, 'the slip after the cut');

    assert.ok(await after.agent.heartbeat(), 'the heartbeat after the stale refusal was refused');
    assert.deepEqual(
      cloud.heartbeats.slice(from).map((h) => h.status),
      [409, 200],
    );
    assert.ok(
      Date.parse(cloud.heartbeats.at(-1)!.sent.reportedAt) > Date.parse(details.lastAcceptedReportedAt),
    );
  } finally {
    after.stop();
    db.close();
  }
});

/**
 * A platform from before the stale refusal said anything: the box is refused
 * as it always was, and nothing it holds moves on the strength of an answer
 * that named nothing.
 */
test('a stale refusal that names nothing measures nothing and moves nothing', async () => {
  const db = newDb();
  const cloud = fakeCloud({ staleDetails: false });
  const credentials = memoryCredentialStore();
  const first = await openBox(db, cloud, credentials, { offsetMs: () => 0, bootId: 'boot-old-platform-1' });
  assert.ok(await first.agent.heartbeat());
  assert.ok(await first.agent.heartbeat());
  first.stop();

  // A new boot, a minute behind: before the watermark, inside the fifteen minutes.
  const after = await openBox(db, cloud, credentials, {
    offsetMs: () => -60_000,
    bootId: 'boot-old-platform-2',
  });
  try {
    assert.equal(await after.agent.heartbeat(), null);
    assert.equal(cloud.heartbeats.at(-1)?.status, 409);
    assert.equal(after.agent.state.clockOffsetMs, null, 'measured off a refusal that said no time');
    const pressed = await after.booth.spin({ idempotencyKey: 'old-platform' });
    for (const fact of factsOf(db, pressed)) assert.equal(fact.clockTrust, 'untrusted');
  } finally {
    after.stop();
    db.close();
  }
});

test('the test control moves the raw clock: declared at once, left over on events, corrected by the answer', async () => {
  const db = newDb();
  const cloud = fakeCloud();
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    offsetMs: () => 0,
    bootId: 'boot-e',
  });
  try {
    assert.ok(await box.agent.heartbeat());
    assert.ok(Math.abs(box.agent.state.clockOffsetMs ?? Number.NaN) < 5_000);

    await box.agent.advanceClock(2 * HOUR);
    // Known at once: the box moved its own clock.
    assert.ok(Math.abs((box.agent.state.clockOffsetMs ?? 0) - 2 * HOUR) < 5_000);
    // Until it is measured, what the correction leaves over rides on the event.
    const moved = await box.booth.spin({ idempotencyKey: 'before-measure' });
    for (const fact of factsOf(db, moved)) {
      assert.equal(fact.clockTrust, 'trusted');
      assert.equal(fact.clockOffsetMs, 2 * HOUR, `${fact.type} hid what the correction left over`);
    }
    assert.equal(moved.clockSuspect, true);

    // Two hours is past the cloud's fifteen minutes: refused, and measured by
    // the refusal. The next heartbeat is accepted and declares the two hours.
    assert.equal(await box.agent.heartbeat(), null, 'two hours out is past the fifteen minutes');
    const refused = cloud.heartbeats.at(-1)!;
    assert.equal(refused.status, 400);
    assert.ok(
      Math.abs((refused.sent.clock?.offsetMs ?? 0) - 2 * HOUR) < 5_000,
      'the move was not declared on the heartbeat after it',
    );
    assert.ok(await box.agent.heartbeat(), 'the corrected heartbeat was refused');
    const declared = cloud.heartbeats.at(-1)!.sent.clock?.offsetMs ?? Number.NaN;
    assert.ok(Math.abs(declared - 2 * HOUR) < 5_000, `declared ${declared}`);

    const before = Date.now();
    const corrected = await box.booth.spin({ idempotencyKey: 'after-measure' });
    const after = Date.now();
    for (const fact of factsOf(db, corrected)) {
      assert.equal(fact.clockTrust, 'trusted');
      assert.equal(fact.clockOffsetMs, 0);
      assertNear(Date.parse(fact.occurredAt), before, `${fact.type} is not on the platform's time`);
    }
    assert.equal(corrected.clockSuspect, true, 'the machine is still two hours out');
    // The press made while the move was left over was not remembered as lived
    // through, so this slip is on the platform's time, not two hours on.
    assertIssued(await slipText(box.store, corrected), before, after, 'the slip after the measurement');
  } finally {
    box.stop();
    db.close();
  }
});

test('a step of the machine’s clock after the measurement drops it until the next heartbeat', async () => {
  const db = newDb();
  const cloud = fakeCloud();
  let wall = -3 * HOUR;
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    offsetMs: () => wall,
    // The monotonic clock runs on whatever is done to the wall clock.
    monotonic: () => Date.now(),
    bootId: 'boot-stepped',
  });
  try {
    assert.equal(await box.agent.heartbeat(), null, 'three hours out is refused');
    assert.ok(Math.abs((box.agent.state.clockOffsetMs ?? 0) + 3 * HOUR) < 5_000);
    const measured = await box.booth.spin({ idempotencyKey: 'measured' });
    for (const fact of factsOf(db, measured)) assert.equal(fact.clockTrust, 'trusted');

    // NTP gets through at last and steps the machine's clock three hours on.
    wall = 0;
    const before = Date.now();
    const stepped = await box.booth.spin({ idempotencyKey: 'stepped' });
    assert.equal(box.agent.state.clockOffsetMs, null, 'a measurement outlived the step it no longer describes');
    for (const fact of factsOf(db, stepped)) {
      assert.equal(fact.clockTrust, 'untrusted', `${fact.type} trusted a correction the step made wrong`);
      assert.equal(fact.clockOffsetMs, null);
      // The raw clock, which is right now — not three hours ahead of it.
      assertNear(Date.parse(fact.occurredAt), before, `${fact.type} is not on the stepped clock`);
    }

    // Measured again on the next heartbeat. Nothing read off the wrong
    // correction was remembered as lived through, so the next press is on
    // the platform's time and not held three hours in the future.
    assert.ok(await box.agent.heartbeat(), 'the heartbeat after the step was refused');
    const again = await box.booth.spin({ idempotencyKey: 'again' });
    assert.equal(again.clockSuspect, false);
    for (const fact of factsOf(db, again)) {
      assert.equal(fact.clockTrust, 'trusted');
      assert.equal(fact.clockOffsetMs, 0);
      assertNear(Date.parse(fact.occurredAt), Date.now(), `${fact.type} is not on the platform's time`);
    }
  } finally {
    box.stop();
    db.close();
  }
});

/**
 * NTP gets through at last while the first heartbeat is on the wire. The
 * heartbeat went out twelve hours behind and is refused; the refusal comes
 * back after the step. Read from either side of the step, the exchange's
 * midpoint is six hours out, and adopting that stamped the next press
 * `trusted` six hours AHEAD — 12:30 on a slip at 06:30 — and, remembered as
 * lived through, held later slips there after the next heartbeat had
 * measured the clock right.
 */
test('a step of the machine’s clock while the first heartbeat is on the wire measures nothing', async () => {
  const platform = pinnedPlatformClock();
  let wall = -12 * HOUR;
  const db = newDb();
  const cloud = fakeCloud({
    now: platform,
    onHeartbeat: (n) => {
      if (n === 1) wall = 0;
    },
  });
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    base: platform,
    offsetMs: () => wall,
    monotonic: () => Date.now(),
    bootId: 'boot-step-on-the-wire',
  });
  try {
    assert.equal(await box.agent.heartbeat(), null);
    assert.equal(cloud.heartbeats.at(-1)?.status, 400, 'twelve hours behind was not refused');
    assert.equal(box.agent.state.clockOffsetMs, null, 'an exchange straddling a twelve-hour step was measured');

    // The machine's own clock, which the step put right: untrusted, and not ahead.
    const pressed = await box.booth.spin({ idempotencyKey: 'after-the-step' });
    for (const fact of factsOf(db, pressed)) {
      assert.equal(fact.clockTrust, 'untrusted', `${fact.type} trusted a measurement nobody should have made`);
      assert.equal(fact.clockOffsetMs, null);
      assertNear(Date.parse(fact.occurredAt), platform(), `${fact.type} is not on the stepped clock`);
    }
    assertSlipSays(await slipText(box.store, pressed), ISSUED_AT_0630_ON_THE_25TH, 'the slip after the step');

    // Measured on the next heartbeat: in step, trusted, and the slip still says 06:30.
    assert.ok(await box.agent.heartbeat(), 'the heartbeat after the step was refused');
    const measured = box.agent.state.clockOffsetMs;
    assert.ok(measured !== null && Math.abs(measured) < 5_000, `measured ${measured}`);
    const later = await box.booth.spin({ idempotencyKey: 'measured-after-the-step' });
    assert.equal(later.clockSuspect, false);
    for (const fact of factsOf(db, later)) {
      assert.equal(fact.clockTrust, 'trusted');
      assert.equal(fact.clockOffsetMs, 0);
      assertNear(Date.parse(fact.occurredAt), platform(), `${fact.type} is not on the platform's time`);
    }
    assertSlipSays(await slipText(box.store, later), ISSUED_AT_0630_ON_THE_25TH, 'the slip after the measurement');
  } finally {
    box.stop();
    db.close();
  }
});

test('a step while a later heartbeat is on the wire drops the measurement the box held', async () => {
  const platform = pinnedPlatformClock();
  let wall = -12 * HOUR;
  let stepOn = 0;
  const db = newDb();
  const cloud = fakeCloud({
    now: platform,
    onHeartbeat: (n) => {
      if (n === stepOn) wall = 0;
    },
  });
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    base: platform,
    offsetMs: () => wall,
    monotonic: () => Date.now(),
    bootId: 'boot-step-later',
  });
  try {
    // Measured twelve hours behind by the refusal.
    assert.equal(await box.agent.heartbeat(), null);
    assert.ok(Math.abs((box.agent.state.clockOffsetMs ?? 0) + 12 * HOUR) < 5_000);

    // NTP steps the clock while the next heartbeat is on the wire. That
    // heartbeat carried the corrected time and is accepted; its answer
    // measures nothing, and what the box held describes a clock that is gone.
    stepOn = 2;
    assert.ok(await box.agent.heartbeat(), 'the corrected heartbeat was refused');
    assert.equal(box.agent.state.clockOffsetMs, null, 'the box kept a measurement of the clock before the step');

    const pressed = await box.booth.spin({ idempotencyKey: 'after-the-later-step' });
    for (const fact of factsOf(db, pressed)) {
      assert.equal(fact.clockTrust, 'untrusted');
      assert.equal(fact.clockOffsetMs, null);
      assertNear(Date.parse(fact.occurredAt), platform(), `${fact.type} is not on the stepped clock`);
    }
    assertSlipSays(await slipText(box.store, pressed), ISSUED_AT_0630_ON_THE_25TH, 'the slip after the step');

    assert.ok(await box.agent.heartbeat());
    const measured = box.agent.state.clockOffsetMs;
    assert.ok(measured !== null && Math.abs(measured) < 5_000, `measured ${measured}`);
  } finally {
    box.stop();
    db.close();
  }
});

/**
 * The audit's case on the box's side of the wire, at the hour it bites: 06:30
 * on the 25th at the park, a Pi twelve hours behind that believes it is 18:30
 * on the 24th, and a booth allowed one spin a day. The platform files a spin
 * by its own rule (`sync-booth`); this is the box's own record — its trading
 * day, its slip, and the daily cap it counts by.
 */
test('twelve hours behind at 06:30: the trading day, the slip and the daily cap follow the corrected clock', async () => {
  const platform = pinnedPlatformClock();
  const db = newDb();
  const cloud = fakeCloud({ now: platform, dailySpinCap: 1 });
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    base: platform,
    offsetMs: () => -12 * HOUR,
    bootId: 'boot-trading-day',
  });
  try {
    // Before the platform has answered: the Pi's own evening of the 24th.
    const early = await box.booth.spin({ idempotencyKey: 'on-the-pi-clock' });
    assert.equal(factOf(db, early, 'booth.spin_recorded').payload.businessDate, '2026-09-24');
    assertSlipSays(await slipText(box.store, early), /^24 Sept? 2026 18:30$/, 'the slip before the measurement');

    assert.equal(await box.agent.heartbeat(), null, 'twelve hours behind was not refused');
    const measured = box.agent.state.clockOffsetMs;
    assert.ok(measured !== null && Math.abs(measured + 12 * HOUR) < 5_000, `measured ${measured}`);

    // 06:30 on the 25th, inside the trading day that began at 05:00.
    const pressed = await box.booth.spin({ idempotencyKey: 'on-the-platform-clock' });
    assert.equal(pressed.clockSuspect, true, 'twelve hours out and the spin was not flagged');
    const spinFact = factOf(db, pressed, 'booth.spin_recorded');
    assert.equal(spinFact.payload.businessDate, '2026-09-25');
    assert.equal(spinFact.clockTrust, 'trusted');
    assert.equal(factOf(db, pressed, 'promo.voucher_issued').payload.businessDate, '2026-09-25');
    const lines = await slipText(box.store, pressed);
    assertSlipSays(lines, ISSUED_AT_0630_ON_THE_25TH, 'the corrected issue time');
    assertSlipSays(lines, /^09 Oct 2026$/, 'the expiry, fourteen days from the corrected day');
    assert.ok(pressed.expiresAt !== null && parkDate(pressed.expiresAt) === '2026-10-09', `expires ${pressed.expiresAt}`);

    // One spin a day, counted on the corrected day: the Pi-clock spin above
    // was the 24th's, this was the 25th's first, and a second is refused.
    await assert.rejects(
      box.booth.spin({ idempotencyKey: 'second-on-the-25th' }),
      (err: unknown) => err instanceof BoothRefusal && err.code === 'daily_spin_cap_reached',
    );
  } finally {
    box.stop();
    db.close();
  }
});

/**
 * The same hour on a box AHEAD, which pressed before it measured itself
 * (SCRUM-402, gate round 3).
 *
 * 03:30 on the 25th at the park, still the 24th's trading day; a Pi three
 * hours ahead believes it is 06:30, the 25th's. Its press before the
 * measurement is stamped by that clock, untrusted — and must not be
 * remembered as a time lived through, because only a corrected time is
 * (`believable` in the booth). Remembered, it would hold every press after
 * the measurement at 06:30: the slip printing a time three hours ahead, and
 * the box's own trading day and daily cap the 25th's, while the platform
 * files the spin on the 24th.
 */
test('three hours AHEAD at 03:30: a press before the measurement does not hold later slips, days or caps ahead', async () => {
  const startedAt = Date.now();
  const platform = (): number => Date.parse('2026-09-24T20:30:00.000Z') + (Date.now() - startedAt);
  const db = newDb();
  const cloud = fakeCloud({ now: platform, dailySpinCap: 1 });
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    base: platform,
    offsetMs: () => 3 * HOUR,
    bootId: 'boot-ahead-before-the-measurement',
  });
  try {
    // Before the platform has answered: the Pi's own 06:30 on the 25th.
    const early = await box.booth.spin({ idempotencyKey: 'ahead-on-the-pi-clock' });
    const earlyFact = factOf(db, early, 'booth.spin_recorded');
    assert.equal(earlyFact.clockTrust, 'untrusted');
    assert.equal(earlyFact.payload.businessDate, '2026-09-25');
    assertSlipSays(await slipText(box.store, early), /^25 Sept? 2026 06:3\d$/, 'the slip before the measurement');

    assert.equal(await box.agent.heartbeat(), null, 'three hours ahead was not refused');
    const measured = box.agent.state.clockOffsetMs;
    assert.ok(measured !== null && Math.abs(measured - 3 * HOUR) < 5_000, `measured ${measured}`);

    // 03:30 on the 25th, the 24th's trading day — and the 24th's first spin,
    // so the cap of one does not refuse it.
    const pressed = await box.booth.spin({ idempotencyKey: 'ahead-on-the-platform-clock' });
    const spinFact = factOf(db, pressed, 'booth.spin_recorded');
    assert.equal(spinFact.clockTrust, 'trusted');
    assert.equal(spinFact.clockOffsetMs, 0);
    assert.equal(spinFact.payload.businessDate, '2026-09-24', 'held on the unmeasured trading day');
    assertSlipSays(
      await slipText(box.store, pressed),
      /^25 Sept? 2026 03:3\d$/,
      'the slip after the measurement',
    );
    assert.equal(pressed.clockSuspect, true, 'three hours out and the spin was not flagged');

    // The 24th's one spin is given: a second is refused on the 24th.
    await assert.rejects(
      box.booth.spin({ idempotencyKey: 'second-on-the-24th' }),
      (err: unknown) => err instanceof BoothRefusal && err.code === 'daily_spin_cap_reached',
    );
  } finally {
    box.stop();
    db.close();
  }
});

/**
 * Facts deferred before a box that booted hours AHEAD heard the platform
 * (SCRUM-402, round 2): the gate's case.
 *
 * The push failed before the first measurement, so the facts' retry times
 * were counted from the Pi's clock, twelve hours ahead. The measurement moves
 * the box's clock back by those twelve hours, and those retry times, compared
 * with it, held the facts for as long: filed twelve hours late — untrusted,
 * so by the time the platform received them, which can be the next trading
 * day — and overtaken by everything queued after them.
 */
test('facts deferred before a box twelve hours AHEAD measured itself go on the next flush', async () => {
  const db = newDb();
  let linkUp = false;
  const cloud = fakeCloud({ push: () => linkUp });
  const box = await openBox(db, cloud, memoryCredentialStore(), {
    offsetMs: () => 12 * HOUR,
    bootId: 'boot-ahead-deferred',
  });
  try {
    const pressed = await box.booth.spin({ idempotencyKey: 'ahead-before-the-measurement' });
    const facts = factsOf(db, pressed);
    assert.equal(facts.length, 2, 'a press queues its spin and its voucher');

    // The push fails: deferred, with a backoff counted from the Pi's clock.
    const deferred = await box.agent.outbox()!.flush();
    assert.equal(deferred.state, 'deferred');
    const held = retryTimes(db);
    assert.ok(held.length >= 2, 'nothing is waiting to be sent');
    for (const at of held) {
      assert.ok(at !== null && Date.parse(at) > Date.now() + 11 * HOUR, `a retry at ${at} is not ahead`);
    }

    // Refused for its clock, and measured: the box's clock goes back twelve hours.
    assert.equal(await box.agent.heartbeat(), null);
    const measured = box.agent.state.clockOffsetMs;
    assert.ok(measured !== null && Math.abs(measured - 12 * HOUR) < 5_000, `measured ${measured}`);

    // The link is back: the facts go now, not in twelve hours.
    linkUp = true;
    const sent = await box.agent.outbox()!.flush();
    assert.equal(sent.state, 'pushed', `the deferred facts were held back: ${JSON.stringify(sent)}`);
    for (const fact of facts) {
      assert.ok(cloud.pushed.includes(fact.eventId), `${fact.type} was not sent`);
    }
    assert.equal((await box.agent.outbox()!.depth()).queued, 0, 'something is still waiting');
  } finally {
    box.stop();
    db.close();
  }
});
