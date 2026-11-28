import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GATE_SCREEN_PARTS,
  composeGateScreen,
  composeGuestGateScreen,
  defaultGateMessages,
  mintBandCode,
  ulidFromUuid,
  type GateMessageTexts,
} from '@oto/shared';

import { bandCopyFrom, createGateHost, type GateHostDeps } from '../src/gate/host';
import { GATE_MESSAGES } from '../src/gate/decision';
import { READER_CHECK_CARD_PATH } from '../src/gate/reader-host';
import { readerScreen } from '../src/gate/reader-layout';
import { gateScreenMessage } from '../src/gate/screen';
import type { BoxConfigStation } from '../src/protocol';
import { uuidv7 } from '../src/signing';

/**
 * SCRUM-1077 — the gate in the language the guest chose at the till.
 *
 * A band whose `bands` row carries `guestLanguage` is shown in that language
 * only, its small words too, with one English line under a refusal (none for
 * English) and no Thai line added; the park's wording for that language
 * first, then the built-in one, and the park's own list when that language
 * has no text for the case. A band with no language — and every answer that
 * names no band of ours — is EXACTLY what the gate showed before. Wording
 * only: the code the reader opens on, the logged message and the journal
 * never change.
 */

const KEY = 'gate-guest-language-band-key-0123456789';
const SERIAL = 'GATE-LANG-1';
const TZ = 'Asia/Bangkok';
const NOW = Date.parse('2026-11-26T09:10:00.000Z'); // 16:10 in Bangkok
const UNTIL = NOW + 80 * 60_000; // 17:30 in Bangkok

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

interface BandRow {
  kind: 'adult' | 'kid';
  validUntil?: number;
  /** Absent: a row as the platform sent it before this ticket. */
  language?: unknown;
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
  const band = (row: BandRow) => {
    const id = uuidv7();
    bands.push({
      id,
      kind: row.kind,
      status: 'active',
      gateAccess: true,
      ticketLabel: '2 Hours Play',
      validUntil: new Date(row.validUntil ?? UNTIL).toISOString(),
      ...('language' in row ? { guestLanguage: row.language } : {}),
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

type Rig = Awaited<ReturnType<typeof rig>>;

/** What the reader is sent, as the wire lays it out (`startReaderServer`). */
const sent = (res: Awaited<ReturnType<Rig['scan']>>, direction: 'entry' | 'exit') =>
  res.screen ?? readerScreen(res.body.code === '1' ? '1' : '0', res.body.message, direction);

const lines = (screen: string | undefined) => (screen ?? '').replace(/\n+$/, '').split('\n');

const facts = (over: { kind: 'adult' | 'kid'; validUntil?: number; creditSatang?: number }) => ({
  now: NOW,
  timezone: TZ,
  ticketLabel: '2 Hours Play',
  validUntil: UNTIL,
  ...over,
});

/** The scans every scenario runs: entry, entry again, exit, a kid, time ended, not a band. */
async function walk(r: Rig, language?: unknown) {
  const own = (row: Omit<BandRow, 'language'>): BandRow => (language === undefined ? row : { ...row, language });
  const adult = r.band(own({ kind: 'adult' }));
  const kid = r.band(own({ kind: 'kid' }));
  const ended = r.band(own({ kind: 'adult', validUntil: NOW - 20 * 60_000 }));
  return {
    entry: await r.scan(adult, '0'),
    again: await r.scan(adult, '0'),
    exit: await r.scan(adult, '1'),
    kid: await r.scan(kid, '0'),
    ended: await r.scan(ended, '0'),
    voucher: await r.scan('NOT-A-BAND-CODE', '0'),
  };
}

const RUSSIAN_PARK: GateMessageTexts = (() => {
  const texts = defaultGateMessages();
  texts.languages = ['en', 'th'];
  texts.cases.welcome.ru = 'Добро пожаловать в парк';
  texts.labels.until.ru = 'играем до {time}';
  return texts;
})();

test('PIN: a band with no saved language shows exactly what the gate showed before, wording or none', async () => {
  for (const messages of [undefined, RUSSIAN_PARK]) {
    const before = await walk(await rig({ messages: () => messages }));
    for (const language of [null, 'de', '', 7]) {
      const now = await walk(await rig({ messages: () => messages }), language);
      for (const key of Object.keys(before) as Array<keyof typeof before>) {
        assert.deepEqual(now[key], before[key], `${String(language)}: ${key}, ${messages ? 'park wording' : 'built-in'}`);
      }
    }
    // And "before" is the gate's screen from before SCRUM-1077, laid out as main laid it out.
    if (!messages) {
      assert.equal(before.entry.screen, undefined);
      assert.equal(
        sent(before.entry, 'entry'),
        readerScreen('1', gateScreenMessage(GATE_MESSAGES.welcome, facts({ kind: 'adult' }), ['kind', 'ticket', 'time', 'credit']), 'entry'),
      );
      assert.equal(sent(before.kid, 'entry'), readerScreen('0', gateScreenMessage(GATE_MESSAGES.KID_BAND, facts({ kind: 'kid' }), ['ticket', 'time']), 'entry'));
      assert.equal(sent(before.voucher, 'entry'), readerScreen('0', GATE_MESSAGES.NOT_A_BAND, 'entry'));
    } else {
      assert.equal(before.entry.screen, composeGateScreen(RUSSIAN_PARK, 'welcome', facts({ kind: 'adult' })));
      assert.equal(before.voucher.screen, composeGateScreen(RUSSIAN_PARK, 'NOT_A_BAND'));
    }
  }
});

test('a Russian guest is greeted, let out and refused in Russian, with one English line under a refusal', async () => {
  const plain = await walk(await rig());
  const r = await rig();
  const ru = await walk(r, 'ru');

  // Wording only: the code, the logged message and the journal are as for a band with no language.
  for (const key of Object.keys(plain) as Array<keyof typeof plain>) {
    assert.deepEqual(ru[key].body, plain[key].body, key);
  }
  assert.equal(ru.entry.body.code, '1');
  assert.equal(ru.again.body.code, '0');
  assert.equal(ru.kid.body.code, '0');

  assert.equal(ru.entry.screen, composeGuestGateScreen(null, 'welcome', 'ru', facts({ kind: 'adult' })));
  assert.deepEqual(lines(ru.entry.screen).slice(0, 4), ['OTO PLAY PARK', '✅ ДОБРО ПОЖАЛОВАТЬ', '— — — — —', '👤 Взрослый']);
  assert.ok(lines(ru.entry.screen).includes('⏰ до 17:30'));
  assert.ok(!/Welcome|ยินดี/.test(ru.entry.screen!));

  assert.deepEqual(lines(ru.exit.screen).slice(0, 3), ['OTO PLAY PARK', '👋 СПАСИБО', 'До новых встреч']);
  assert.ok(lines(ru.exit.screen).includes('⏰ вернитесь до 17:30'));

  // The reader-only lane's own refusal of the same band at the entrance again.
  assert.deepEqual(lines(ru.again.screen).slice(2, 6), ['⚠️ ВНИМАНИЕ', '— — — — —', 'Уже вошли', 'Already entered']);

  const kid = lines(ru.kid.screen);
  assert.deepEqual(kid.slice(4, 6), ['Нужен взрослый браслет. Дети проходят со взрослым', 'Adult band please. Kids enter with their adult']);
  assert.ok(!/[฀-๿]/.test(ru.kid.screen!), 'no Thai line for a Russian guest');
  assert.ok(ru.kid.screen!.endsWith('\n'.repeat(14)), 'still padded for the reader app');

  assert.deepEqual(lines(ru.ended.screen).slice(4, 6), ['Ваше время игры закончилось. Обратитесь в кассу.', 'Your play time has ended. Please see the cashier.']);

  // Not a band of ours: the park's own list, exactly as before.
  assert.deepEqual(ru.voucher, plain.voucher);
  await r.host.stop();
});

test('a guest who chose English sees English only, and no extra line on a refusal', async () => {
  const r = await rig();
  const en = await walk(r, 'en');
  assert.deepEqual(lines(en.entry.screen).slice(0, 2), ['OTO PLAY PARK', '✅ WELCOME']);
  assert.ok(!/ยินดี/.test(en.entry.screen!));
  assert.deepEqual(lines(en.kid.screen).slice(4), [
    'Adult band please. Kids enter with their adult',
    '— — — — —',
    '🎟 2 Hours Play',
    '⏰ until 17:30',
    '⏳ 1 h 20 min left',
  ]);
  await r.host.stop();
});

test('the park’s wording for the language first; with no text in it, the park’s own list', async () => {
  const worded = await rig({ messages: () => RUSSIAN_PARK });
  const ru = await walk(worded, 'ru');
  assert.equal(lines(ru.entry.screen)[1], '✅ ДОБРО ПОЖАЛОВАТЬ В ПАРК');
  assert.ok(lines(ru.entry.screen).includes('⏰ играем до 17:30'));

  // Thai has no built-in text for play time ended: the park's own list, as for a band with no language.
  const thai = await walk(await rig(), 'th');
  const none = await walk(await rig());
  assert.deepEqual(thai.ended, none.ended);
  assert.deepEqual(lines(thai.entry.screen).slice(0, 2), ['OTO PLAY PARK', '✅ ยินดีต้อนรับ']);
  const thaiWorded = await walk(await rig({ messages: () => RUSSIAN_PARK }), 'th');
  assert.equal(
    thaiWorded.ended.screen,
    composeGateScreen(RUSSIAN_PARK, 'OVER_TIME', { ...facts({ kind: 'adult', validUntil: NOW - 20 * 60_000 }) }),
  );
  assert.deepEqual(GATE_SCREEN_PARTS.OVER_TIME, ['ticket', 'time']);
  await worded.host.stop();
});

test('the band copy reads the language only when it is one of the five', () => {
  const id = uuidv7();
  const copy = (guestLanguage: unknown) =>
    bandCopyFrom([{ id, kind: 'adult', status: 'active', gateAccess: true, guestLanguage }], []).lookup(id);
  assert.deepEqual(copy('fr'), { state: 'active', kind: 'adult', gateAccess: true, details: { guestLanguage: 'fr' } });
  for (const other of [null, undefined, 'de', 'FR', 3]) {
    assert.deepEqual(copy(other), { state: 'active', kind: 'adult', gateAccess: true }, String(other));
  }
});
