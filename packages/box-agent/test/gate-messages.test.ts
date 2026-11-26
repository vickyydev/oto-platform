import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GATE_MESSAGE_CASES,
  GATE_MESSAGE_CASE_INFO,
  GATE_MESSAGE_DEFAULT_CASES,
  GATE_SCREEN_PARTS,
  composeGateScreen,
  defaultGateMessages,
  mintBandCode,
  ulidFromUuid,
  type GateScreenFacts,
} from '@oto/shared';

import { GATE_MESSAGES } from '../src/gate/decision';
import { createGateHost, type GateHostDeps } from '../src/gate/host';
import { READER_CHECK_CARD_PATH, createReaderHost, startReaderServer } from '../src/gate/reader-host';
import { readerScreen } from '../src/gate/reader-layout';
import { gateScreenMessage } from '../src/gate/screen';
import type { BoxConfigStation } from '../src/protocol';
import { uuidv7 } from '../src/signing';

/**
 * SCRUM-1078 — the park's own wording on the gate reader. With nothing saved
 * the gate shows exactly what it showed before; with wording in the config
 * the reader is sent the park's screen, and the code, the logged message and
 * the journal stay as they were.
 */

const KEY = 'gate-messages-band-key-0123456789abcdef';
const SERIAL = 'GATE-MSG-1';
const TZ = 'Asia/Bangkok';
const NOW = Date.parse('2026-11-26T09:10:00.000Z');

const FACTS: Array<[string, GateScreenFacts | undefined]> = [
  ['no facts', undefined],
  ['nothing known but the clock', { now: NOW }],
  [
    'adult, ticket, time and credit',
    { kind: 'adult', ticketLabel: '2 Hours Play', validUntil: NOW + 80 * 60_000, creditSatang: 35_000, now: NOW, timezone: TZ },
  ],
  ['kid, ticket and time', { kind: 'kid', ticketLabel: 'Kids 3 Hours', validUntil: NOW + 45 * 60_000, now: NOW, timezone: TZ }],
  ['time ended', { kind: 'adult', ticketLabel: '2 Hours Play', validUntil: NOW - 20 * 60_000, now: NOW, timezone: TZ }],
  ['no time zone', { kind: 'adult', ticketLabel: '2 Hours Play', validUntil: NOW + 120 * 60_000, now: NOW }],
  ['ended, no time zone', { kind: 'adult', ticketLabel: '2 Hours Play', validUntil: NOW - 60_000, now: NOW }],
  ['credit, no ticket', { kind: 'adult', creditSatang: 12_050, now: NOW, timezone: TZ }],
];

test('the built-in English and Thai are the gate’s wording before SCRUM-1078', () => {
  for (const key of GATE_MESSAGE_CASES) {
    const en = GATE_MESSAGE_DEFAULT_CASES[key].en.split('\n');
    const th = GATE_MESSAGE_DEFAULT_CASES[key].th.split('\n').filter(Boolean);
    const paired: string[] = [];
    for (let i = 0; i < Math.max(en.length, th.length); i += 1) {
      if (en[i]) paired.push(en[i]!);
      if (th[i]) paired.push(th[i]!);
    }
    assert.equal(paired.join(' / '), GATE_MESSAGES[key], key);
  }
});

test('with the built-in wording, the composed screen is exactly the screen the wire laid out before', () => {
  const texts = defaultGateMessages();
  for (const key of GATE_MESSAGE_CASES) {
    const opens = GATE_MESSAGE_CASE_INFO[key].opens;
    const directions = opens ? [key === 'goodbye' ? 'exit' : 'entry'] : ['entry', 'exit'];
    for (const [name, facts] of FACTS) {
      for (const direction of directions as Array<'entry' | 'exit'>) {
        const message = facts ? gateScreenMessage(GATE_MESSAGES[key], facts, GATE_SCREEN_PARTS[key]) : GATE_MESSAGES[key];
        const before = readerScreen(opens ? '1' : '0', message, direction);
        assert.equal(composeGateScreen(texts, key, facts), before, `${key}, ${direction}, ${name}`);
      }
    }
  }
});

// --- The host -----------------------------------------------------------------------

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

async function rig(over: Partial<GateHostDeps> = {}) {
  const kv = new Map<string, string>();
  const bands: Array<Record<string, unknown>> = [];
  const journal: unknown[] = [];
  const host = createGateHost({
    boxId: uuidv7(),
    stations: [station()],
    now: () => NOW,
    realNow: () => NOW,
    bandKey: () => KEY,
    readCopy: async () => ({ bands: [...bands], deny: [] }),
    isOnline: () => false,
    journal: async (fact) => void journal.push(fact),
    state: { read: async (k) => kv.get(k) ?? null, write: async (k, v) => void kv.set(k, v) },
    mintId: () => uuidv7(),
    relayDriver: null,
    pollIntervalMs: 60_000,
    timezone: TZ,
    ...over,
  });
  await host.start();
  const band = (kind: 'adult' | 'kid') => {
    const id = uuidv7();
    bands.push({
      id,
      kind,
      status: 'active',
      gateAccess: true,
      ticketLabel: '2 Hours Play',
      validUntil: new Date(NOW + 80 * 60_000).toISOString(),
    });
    return mintBandCode('T1', ulidFromUuid(id), KEY);
  };
  const scan = (code: string, reader: '0' | '1') =>
    host.reader().handle({
      method: 'POST',
      path: READER_CHECK_CARD_PATH,
      body: { card: Buffer.from(code).toString('base64'), type: '1', serial: SERIAL, reader },
    });
  return { host, band, scan, journal };
}

const RUSSIAN_FIRST = (() => {
  const texts = defaultGateMessages();
  texts.languages = ['ru', 'en'];
  texts.cases.welcome.ru = 'Добро пожаловать в парк';
  return texts;
})();

test('with nothing from the platform the answer is exactly as before: no screen of its own', async () => {
  const r = await rig({ messages: () => undefined });
  const res = await r.scan(r.band('adult'), '0');
  assert.equal(res.body.code, '1');
  assert.equal(res.screen, undefined);
  assert.ok(res.body.message.startsWith(GATE_MESSAGES.welcome));
  await r.host.stop();
});

test('with the park’s wording the reader is sent its screen; code, message and journal are unchanged', async () => {
  const plain = await rig();
  const worded = await rig({ messages: () => RUSSIAN_FIRST });
  const a = await plain.scan(plain.band('adult'), '0');
  const b = await worded.scan(worded.band('adult'), '0');
  assert.deepEqual(b.body, a.body);
  assert.equal(b.body.code, '1');
  const lines = b.screen!.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['OTO PLAY PARK', '✅ ДОБРО ПОЖАЛОВАТЬ В ПАРК', 'Welcome']);
  assert.ok(lines.includes('👤 Взрослый'));
  assert.ok(lines.includes('🎟 2 Hours Play'));
  assert.equal(worded.journal.length, plain.journal.length);

  // A refusal: the kid's band, in the park's wording, still refused.
  const kid = await worded.scan(worded.band('kid'), '0');
  assert.equal(kid.body.code, '0');
  assert.equal(kid.body.message.split(' · ')[0], GATE_MESSAGES.KID_BAND);
  assert.ok(kid.screen!.startsWith('\n\n⚠️ ВНИМАНИЕ\n'));
  assert.ok(kid.screen!.includes('Нужен взрослый браслет. Дети проходят со взрослым\nAdult band please. Kids enter with their adult'));

  // Not a band at all: refused, worded.
  const voucher = await worded.scan('NOT-A-BAND-CODE', '0');
  assert.equal(voucher.body.code, '0');
  assert.ok(voucher.screen!.includes('Отсканируйте браслет\nScan your wristband'));
  await plain.host.stop();
  await worded.host.stop();
});

test('wording that cannot be read is ignored, and a change is used at the next scan', async () => {
  let held: unknown = { languages: 'not a list' };
  const r = await rig({ messages: () => held });
  const first = await r.scan(r.band('adult'), '0');
  assert.equal(first.screen, undefined);
  held = RUSSIAN_FIRST;
  const second = await r.scan(r.band('adult'), '0');
  assert.ok(second.screen!.includes('ДОБРО ПОЖАЛОВАТЬ В ПАРК'));
  held = undefined;
  const third = await r.scan(r.band('adult'), '0');
  assert.equal(third.screen, undefined);
  await r.host.stop();
});

test('the wire sends the laid-out screen in place of the message', async () => {
  const reader = createReaderHost({
    onScan: async () => ({ code: '1', message: 'Welcome / ยินดีต้อนรับ', screen: 'PARK SCREEN\nline two' }),
  });
  const server = await startReaderServer(reader, { port: 0, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}${READER_CHECK_CARD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ card: Buffer.from('X').toString('base64'), type: '1', serial: 'S', reader: '0' }),
    });
    assert.deepEqual(await res.json(), { code: '1', message: 'PARK SCREEN\nline two' });
  } finally {
    await server.close();
  }
});
