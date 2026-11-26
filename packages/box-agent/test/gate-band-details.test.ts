import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GateEventPayloadSchema, mintBandCode, ulidFromUuid, wallClockMinutesInTz } from '@oto/shared';

import {
  GATE_MESSAGES,
  GATE_OVERTIME_GRACE_MINUTES,
  decideGate,
  journalReason,
  playTimeEnded,
} from '../src/gate/decision';
import { bandCopyFrom, createGateHost, type GateHostDeps } from '../src/gate/host';
import { READER_CHECK_CARD_PATH } from '../src/gate/reader-host';
import { GATE_SCREEN_MAX_CHARS, gateScreenMessage, gateTimePart } from '../src/gate/screen';
import type { BoxConfigStation } from '../src/protocol';
import { uuidv7 } from '../src/signing';
import type { QueuedFact } from '../src/store';
import { walletKeyDigestsOf } from '../src/wallet-lane';

/**
 * SCRUM-68 — what the gate's screen says (ticket, time, credit) and the
 * play-time rule (owner's list of 24 November), on a reader-only lane: a
 * Gate station with a reader and no controller board.
 */

const KEY = 'gate-band-details-band-key-0123456789';
const SERIAL = 'GATE-BD-1';
const TZ = 'Asia/Bangkok';
const MIN = 60_000;

function station(): BoxConfigStation {
  return {
    id: uuidv7(),
    name: 'Entrance',
    kind: 'gate',
    codePrefix: 'G1',
    capabilities: [],
    configVersion: 1,
    paymentRouting: null,
    offlineWalletCapSatang: null,
    accessScope: 'branch',
    devices: [
      {
        id: uuidv7(),
        role: 'gate',
        kind: 'gate_reader',
        label: 'Entrance reader',
        transport: 'lan',
        address: null,
        model: null,
        protocol: null,
        serialNumber: SERIAL,
        terminalId: null,
        merchantId: null,
      },
    ],
  };
}

type Row = {
  id: string;
  kind: 'adult' | 'kid';
  status: string;
  gateAccess?: boolean;
  ticketLabel?: string | null;
  stayLabel?: string | null;
  validUntil?: string | null;
};

interface Rig {
  host: ReturnType<typeof createGateHost>;
  journal: QueuedFact[];
  bands: Row[];
  wallets: unknown;
  online: { value: boolean };
  clock: { v: number };
  /** What a band refresh does to the copy: the platform's rows after it. */
  platform: { rows: Row[] | null; pulls: number };
  notes: string[];
}

async function rig(over: Partial<GateHostDeps> = {}): Promise<Rig> {
  const kv = new Map<string, string>();
  const r = {
    journal: [] as QueuedFact[],
    bands: [] as Row[],
    wallets: null as unknown,
    online: { value: false },
    clock: { v: Date.parse('2026-11-26T08:00:00.000Z') },
    platform: { rows: null as Row[] | null, pulls: 0 },
    notes: [] as string[],
  } as Rig;
  r.host = createGateHost({
    boxId: uuidv7(),
    stations: [station()],
    now: () => r.clock.v,
    realNow: () => r.clock.v,
    bandKey: () => KEY,
    readCopy: async () => ({ bands: [...r.bands], deny: [] }),
    isOnline: () => r.online.value,
    refreshBands: async () => {
      r.platform.pulls += 1;
      if (!r.platform.rows) return false;
      r.bands.splice(0, r.bands.length, ...r.platform.rows);
      return true;
    },
    journal: async (fact) => void r.journal.push(fact),
    state: { read: async (k) => kv.get(k) ?? null, write: async (k, v) => void kv.set(k, v) },
    mintId: () => uuidv7(),
    relayDriver: null,
    pollIntervalMs: 60_000,
    timezone: TZ,
    readWallets: async () => r.wallets,
    note: (_level, message) => void r.notes.push(message),
    ...over,
  });
  await r.host.start();
  return r;
}

function band(r: Rig, row: Partial<Row> = {}) {
  const id = uuidv7();
  const full: Row = { id, kind: 'adult', status: 'active', gateAccess: true, ...row };
  r.bands.push(full);
  return { id, row: full, code: mintBandCode('T1', ulidFromUuid(id), KEY) };
}

function ticket(r: Rig, minutesLeft: number): Partial<Row> {
  return {
    ticketLabel: '2 Hours Play',
    stayLabel: '2 Hours',
    validUntil: new Date(r.clock.v + minutesLeft * MIN).toISOString(),
  };
}

function walletFor(code: string, balanceSatang: number) {
  return {
    items: [
      {
        version: 'v1',
        generatedAt: new Date().toISOString(),
        branchId: uuidv7(),
        businessDate: '2026-11-26',
        capSatang: 50_000,
        truncated: false,
        wallets: [
          {
            id: uuidv7(),
            status: 'active',
            balanceSatang,
            expiresAt: null,
            boxSpentSatang: 0,
            keys: walletKeyDigestsOf({ kind: 'band', value: code }),
          },
        ],
      },
    ],
  };
}

const hhmm = (ms: number) => {
  const m = wallClockMinutesInTz(new Date(ms), TZ);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

async function scan(r: Rig, code: string, readerNo: '0' | '1') {
  const res = await r.host.reader().handle({
    method: 'POST',
    path: READER_CHECK_CARD_PATH,
    body: { card: Buffer.from(code).toString('base64'), type: '1', serial: SERIAL, reader: readerNo },
  });
  return res.body;
}

const kinds = (r: Rig) => r.journal.map((f) => (f.payload as { kind: string }).kind);
const reasons = (r: Rig) => r.journal.map((f) => (f.payload as { reason: string | null }).reason);

// --- The screen ---------------------------------------------------------------------

test('granted with ticket, time and credit: every part, English first, under the cap', async () => {
  const r = await rig();
  const b = band(r, ticket(r, 80));
  r.wallets = walletFor(b.code, 35_000);
  const until = hhmm(Date.parse(b.row.validUntil!));
  const answer = await scan(r, b.code, '0');
  assert.deepEqual(answer, {
    code: '1',
    message: `Welcome / ยินดีต้อนรับ · Adult · 2 Hours Play · until ${until} · 1 h 20 min left · Credit ฿350`,
  });
  assert.ok(answer.message.length <= GATE_SCREEN_MAX_CHARS);
  assert.deepEqual(kinds(r), ['entry']);
  // The exit says goodbye the same way.
  const out = await scan(r, b.code, '1');
  assert.equal(out.code, '1');
  assert.ok(out.message.startsWith(`${GATE_MESSAGES.goodbye} · Adult · 2 Hours Play · until ${until}`));
  await r.host.stop();
});

test('granted with nothing known (an older platform, no wallet): exactly the greeting, as before', async () => {
  const r = await rig();
  const b = band(r);
  assert.deepEqual(await scan(r, b.code, '0'), { code: '1', message: GATE_MESSAGES.welcome });
  assert.deepEqual(await scan(r, b.code, '1'), { code: '1', message: GATE_MESSAGES.goodbye });
  await r.host.stop();
});

test('a kid band is refused both ways; the screen says to enter with their adult, with ticket and time', async () => {
  const r = await rig();
  const kid = band(r, { kind: 'kid', gateAccess: false, ...ticket(r, 45) });
  const until = hhmm(Date.parse(kid.row.validUntil!));
  for (const readerNo of ['0', '1'] as const) {
    assert.deepEqual(await scan(r, kid.code, readerNo), {
      code: '0',
      message: `Adult band please. Kids enter with their adult / กรุณาใช้สายรัดผู้ใหญ่ · 2 Hours Play · until ${until} · 45 min left`,
    });
  }
  assert.deepEqual(reasons(r), ['KID_BAND', 'KID_BAND']);
  await r.host.stop();
});

test('already inside: the plain "Already entered"', async () => {
  const r = await rig();
  const b = band(r, ticket(r, 60));
  assert.equal((await scan(r, b.code, '0')).code, '1');
  assert.deepEqual(await scan(r, b.code, '0'), { code: '0', message: GATE_MESSAGES.ANTI_PASSBACK });
  await r.host.stop();
});

test('the cap: parts are cut kind, ticket, time — the credit goes last', () => {
  const now = Date.parse('2026-11-26T08:00:00.000Z');
  const facts = {
    now,
    kind: 'adult' as const,
    // Longer than the cap leaves room for, whatever the cap is.
    ticketLabel: `A very long ticket name ${'that the park typed in full '.repeat(Math.ceil(GATE_SCREEN_MAX_CHARS / 28))}`,
    validUntil: now + 80 * MIN,
    creditSatang: 35_000,
    timezone: TZ,
  };
  const all = ['kind', 'ticket', 'time', 'credit'] as const;
  const message = gateScreenMessage(GATE_MESSAGES.welcome, facts, all);
  assert.ok(message.length <= GATE_SCREEN_MAX_CHARS, message);
  assert.ok(!message.includes('A very long'), 'the ticket is cut before the time and the credit');
  assert.ok(message.includes('Credit ฿350'));
  assert.ok(message.includes('1 h 20 min left'));
  // A lead longer than the cap on its own is cut to the cap.
  assert.equal(
    gateScreenMessage('x'.repeat(GATE_SCREEN_MAX_CHARS + 80), { now }, all).length,
    GATE_SCREEN_MAX_CHARS,
  );
  // No zone: the time left without a clock.
  assert.equal(gateTimePart(now + 45 * MIN, now, undefined), '45 min left');
  assert.equal(gateTimePart(now - MIN, now, undefined), 'time ended');
  assert.equal(gateTimePart(undefined, now, TZ), null);
});

// --- The play-time rule ---------------------------------------------------------------

test('the rule: one function, grace 0, nothing refused when the end is not known', () => {
  assert.equal(GATE_OVERTIME_GRACE_MINUTES, 0);
  const now = Date.parse('2026-11-26T08:00:00.000Z');
  assert.equal(playTimeEnded(now - 1, now), true);
  assert.equal(playTimeEnded(now, now), false);
  assert.equal(playTimeEnded(now + MIN, now), false);
  assert.equal(playTimeEnded(undefined, now), false);
  assert.equal(playTimeEnded(now - MIN, undefined), false);
  assert.equal(journalReason('OVER_TIME'), 'NO_GATE_ACCESS');
  assert.equal(journalReason('KID_BAND'), 'KID_BAND');
});

test('over time at the ENTRY: refused, sent to the cashier, journalled as a denial, nothing credited', async () => {
  const r = await rig();
  const b = band(r, ticket(r, -10));
  const ended = hhmm(Date.parse(b.row.validUntil!));
  assert.deepEqual(await scan(r, b.code, '0'), {
    code: '0',
    message: `Your play time has ended. Please see the cashier. · 2 Hours Play · time ended ${ended}`,
  });
  assert.deepEqual(kinds(r), ['denied']);
  assert.deepEqual(reasons(r), ['NO_GATE_ACCESS']);
  assert.equal(GateEventPayloadSchema.safeParse(r.journal[0]!.payload).success, true);
  assert.equal(await r.host.occupancy(), 0);
  assert.ok(r.notes.some((n) => /entry refused, play time ended/.test(n)));
  await r.host.stop();
});

test('over time at the EXIT: refused and sent to the cashier; the band stays inside', async () => {
  const r = await rig();
  const b = band(r, ticket(r, 30));
  assert.equal((await scan(r, b.code, '0')).code, '1');
  r.clock.v += 31 * MIN;
  const out = await scan(r, b.code, '1');
  assert.equal(out.code, '0');
  assert.ok(out.message.startsWith(GATE_MESSAGES.OVER_TIME), out.message);
  assert.match(out.message, /time ended \d\d:\d\d$/);
  assert.deepEqual(kinds(r), ['entry', 'denied']);
  assert.equal(await r.host.occupancy(), 1);
  await r.host.stop();
});

test('after Add time on the till: online, the refused band is asked again and passes on the new end', async () => {
  const r = await rig();
  const b = band(r, ticket(r, 30));
  assert.equal((await scan(r, b.code, '0')).code, '1');
  r.clock.v += 31 * MIN;
  // Offline, the box has only its old copy: refused on time.
  assert.equal((await scan(r, b.code, '1')).code, '0');
  // The till adds an hour; the platform's row now ends an hour later.
  const later = new Date(Date.parse(b.row.validUntil!) + 60 * MIN).toISOString();
  r.platform.rows = [{ ...b.row, validUntil: later }];
  r.online.value = true;
  const out = await scan(r, b.code, '1');
  assert.equal(out.code, '1', out.message);
  assert.match(out.message, new RegExp(`until ${hhmm(Date.parse(later))} · 59 min left`));
  assert.equal(r.platform.pulls, 1);
  assert.deepEqual(kinds(r), ['entry', 'denied', 'exit']);
  assert.equal(await r.host.occupancy(), 0);
  await r.host.stop();
});

test('no end known (an older platform, a line without stay hours): never refused on time, either way', async () => {
  const r = await rig();
  const old = band(r);
  const noStay = band(r, { ticketLabel: 'Party guest', stayLabel: null, validUntil: null });
  r.clock.v += 24 * 60 * MIN;
  for (const b of [old, noStay]) {
    assert.equal((await scan(r, b.code, '0')).code, '1');
    assert.equal((await scan(r, b.code, '1')).code, '1');
  }
  assert.deepEqual(await scan(r, noStay.code, '0'), {
    code: '1',
    message: `${GATE_MESSAGES.welcome} · Adult · Party guest`,
  });
  assert.deepEqual(kinds(r), ['entry', 'exit', 'entry', 'exit', 'entry']);
  await r.host.stop();
});

test('the band copy reads the details defensively; a revoked band has none and is never refused on time', () => {
  const id = uuidv7();
  const revokedId = uuidv7();
  const past = new Date(Date.now() - 60 * MIN).toISOString();
  const copy = bandCopyFrom(
    [
      { id, kind: 'adult', status: 'active', ticketLabel: ' 2 Hours Play ', validUntil: 'not a time' },
      { id: revokedId, kind: 'adult', status: 'active', validUntil: past },
    ],
    [{ revokedBands: [{ id: revokedId, kind: 'adult' }] }],
  );
  assert.deepEqual(copy.lookup(id), {
    state: 'active',
    kind: 'adult',
    details: { ticketLabel: '2 Hours Play' },
  });
  assert.deepEqual(copy.lookup(revokedId), { state: 'revoked', kind: 'adult' });
  const code = mintBandCode('T1', ulidFromUuid(revokedId), KEY);
  const exit = decideGate({
    code,
    direction: 'exit',
    key: KEY,
    lookup: copy.lookup,
    inside: () => true,
    unknownMeans: 'offline',
    now: Date.now(),
  });
  assert.equal(exit.open, true, 'a refunded guest is still let out');
});

test('online, the gate pulls its band copy on its own period; offline it does not', async () => {
  const r = await rig({ bandsRefreshMs: 5 * MIN });
  r.platform.rows = [];
  await r.host.tick();
  assert.equal(r.platform.pulls, 0);
  r.clock.v += 5 * MIN;
  await r.host.tick();
  assert.equal(r.platform.pulls, 0, 'offline: nothing is asked');
  r.online.value = true;
  await r.host.tick();
  assert.equal(r.platform.pulls, 1);
  await r.host.tick();
  assert.equal(r.platform.pulls, 1, 'once a period, not every tick');
  await r.host.stop();
});
