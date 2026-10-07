import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  BENEFIT_CREDENTIAL_REFUSALS,
  BENEFIT_WORDS,
  businessDate,
  type BenefitScopeItem,
} from '@oto/shared';

import { encodeBenefitCredential } from '../src/benefit-credential';
import type { StationChannelMessage } from '../src/contract';
import { ScanRouter, type ScanResult } from '../src/scan';
import { uuidv7 } from '../src/signing';
import { StationSessionManager } from '../src/station-session';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, STATION_ID } from './_support';

/**
 * SCRUM-218 review of lane I round 2, RE-CHECK of REJECT 1 — a live benefit QR
 * that a box refuses must not reach any screen through the refusal's words.
 *
 * The fix (`benefitCodeShown`) cuts the echo at the signature. This attacks it
 * the way a counter does: a genuine QR read in every shape a scanner, a hand or
 * a pasted message can give it — case changed, padded, prefixed, doubled, one
 * character dropped, swapped or added anywhere — delivered through a real
 * `ScanRouter` into a real `StationSessionManager` with a guest-facing and a
 * staff screen subscribed, on every box state that refuses a genuine QR for a
 * reason of its own (no key yet, no person, no list, no benefit today, revoked,
 * left). The rule held to:
 *
 *   - the guest's screen never hears eight consecutive characters of the
 *     signature, whatever the outcome;
 *   - the staff screen and the router's own answer hear them ONLY as
 *     `detail.benefitCode` of a HANDLED scan — never inside words.
 */

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const kid = createHash('sha256')
    .update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16);
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem,
    kid,
    key: { purpose: 'benefit_qr', kid, algorithm: 'ed25519', publicKey: publicKeyPem },
  };
}

const PARK = keypair();
const NOW = new Date('2026-10-07T06:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const TODAY = businessDate(NOW, 'Asia/Bangkok', 5 * 60);
const ANAN = { employeeId: uuidv7(), credentialId: uuidv7() };

const GENUINE = encodeBenefitCredential(
  { ...ANAN, exp: NOW_S + 365 * 86_400 },
  { kid: PARK.kid, privateKeyPem: PARK.privateKeyPem },
);
const DOT = GENUINE.lastIndexOf('.');
const SIGNATURE = GENUINE.slice(DOT + 1);
/** Every run of eight characters of the signature: a screen holding one holds part of the QR. */
const WINDOWS = Array.from({ length: SIGNATURE.length - 7 }, (_, i) => SIGNATURE.slice(i, i + 8));
const carriesSignature = (text: string) => WINDOWS.some((w) => text.includes(w));

function day(benefitRole: 'owner' | null) {
  return {
    from: '2026-01-01',
    to: null,
    benefitRole,
    comp: benefitRole !== null,
    standingDiscount: null,
    onlineOnly: [] as Array<'freeItems' | 'credit'>,
  };
}

function scope(over: Partial<BenefitScopeItem> = {}): BenefitScopeItem {
  return {
    version: 'recheck',
    keys: [PARK.key],
    revokedCredentialIds: [],
    revokedEmployeeIds: [],
    employees: [{ employeeId: ANAN.employeeId, name: 'Khun Anan (Owner)', days: [day('owner')] }],
    ...over,
  };
}

/** Each box state that refuses a GENUINE, still-live QR for a reason of its own. */
const STATES: Array<{ what: string; held: BenefitScopeItem | null; genuine: string }> = [
  { what: 'admits it', held: scope(), genuine: 'handled' },
  {
    what: 'has not pulled its key yet',
    held: scope({ keys: [] }),
    genuine: BENEFIT_CREDENTIAL_REFUSALS.UNKNOWN_KEY,
  },
  {
    what: 'holds nobody of that name (role gone today)',
    held: scope({ employees: [] }),
    genuine: BENEFIT_CREDENTIAL_REFUSALS.NOT_FOUND,
  },
  {
    what: 'holds no benefits list at all',
    held: null,
    genuine: BENEFIT_CREDENTIAL_REFUSALS.REVOCATION_UNKNOWN,
  },
  {
    what: 'holds the person with nothing today',
    held: scope({
      employees: [{ employeeId: ANAN.employeeId, name: 'Khun Anan (Owner)', days: [day(null)] }],
    }),
    genuine: BENEFIT_CREDENTIAL_REFUSALS.NOT_CONFIGURED,
  },
  {
    what: 'holds it as revoked',
    held: scope({ revokedCredentialIds: [ANAN.credentialId] }),
    genuine: BENEFIT_CREDENTIAL_REFUSALS.REVOKED,
  },
  {
    what: 'holds its holder as left',
    held: scope({ revokedEmployeeIds: [ANAN.employeeId] }),
    genuine: BENEFIT_CREDENTIAL_REFUSALS.EMPLOYEE_LEFT,
  },
];

/** The shapes a live QR arrives in at a counter, every one of them recoverable by eye. */
function shapes(): Array<{ what: string; code: string }> {
  const g = GENUINE;
  const ch = (point: number) => String.fromCharCode(point);
  const NBSP = ch(0xa0);
  const BOM = ch(0xfeff);
  const ZWSP = ch(0x200b);
  const NUL = ch(0);
  const out: Array<{ what: string; code: string }> = [
    { what: 'as printed', code: g },
    { what: 'all lower case', code: g.toLowerCase() },
    { what: 'all upper case (caps lock on a keyboard-wedge scanner)', code: g.toUpperCase() },
    { what: 'header lower case', code: `oto-ben:v1:${g.slice('OTO-BEN:v1:'.length)}` },
    { what: 'padded with spaces and CRLF', code: `  ${g}  \r\n` },
    { what: 'wrapped in no-break spaces', code: `${NBSP}${g}${NBSP}` },
    { what: 'after a byte-order mark', code: `${BOM}${g}` },
    { what: 'after a zero-width space', code: `${ZWSP}${g}` },
    { what: 'with the QR symbology id in front', code: `]Q1${g}` },
    { what: 'in quotes', code: `"${g}"` },
    { what: 'read twice in one burst', code: `${g}${g}` },
    { what: 'with a tab and more after it', code: `${g}\tTABLE 4` },
    { what: 'with a NUL after it', code: `${g}${NUL}` },
    { what: 'with a newline in the middle', code: `${g.slice(0, 60)}\n${g.slice(60)}` },
    { what: 'the dot dropped', code: `${g.slice(0, DOT)}${g.slice(DOT + 1)}` },
  ];
  // A middle dot and a full-width full stop: what a non-US layout or an IME makes of '.'.
  for (const sep of [',', ':', '>', ' ', ch(0xb7), ch(0xff0e), '..']) {
    out.push({
      what: `the dot read as ${JSON.stringify(sep)}`,
      code: `${g.slice(0, DOT)}${sep}${SIGNATURE}`,
    });
  }
  // One character dropped, swapped or added, at every position.
  for (let i = 0; i < g.length; i += 1) {
    out.push({ what: `char ${i} dropped`, code: `${g.slice(0, i)}${g.slice(i + 1)}` });
    out.push({
      what: `char ${i} swapped`,
      code: `${g.slice(0, i)}${g[i] === 'A' ? 'B' : 'A'}${g.slice(i + 1)}`,
    });
    out.push({ what: `char ${i} -> dot`, code: `${g.slice(0, i)}.${g.slice(i + 1)}` });
    out.push({ what: `'A' added at ${i}`, code: `${g.slice(0, i)}A${g.slice(i)}` });
    out.push({ what: `'.' added at ${i}`, code: `${g.slice(0, i)}.${g.slice(i)}` });
  }
  return out;
}

function station() {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => NOW });
  let held: BenefitScopeItem | null = null;
  const sessions = new StationSessionManager({
    store,
    boxId: BOX_ID,
    resolveStation: (id) =>
      id === STATION_ID
        ? ({ stationId: STATION_ID, operatorId: OPERATOR_ID, branchId: BRANCH_ID } as never)
        : null,
    now: () => NOW,
  });
  const router = new ScanRouter({
    boxId: BOX_ID,
    store,
    now: () => NOW,
    benefits: () => ({ scope: held, today: TODAY }),
    publish: (id, message) => sessions.emitScan(id, message),
  });
  const guest: StationChannelMessage[] = [];
  const staff: StationChannelMessage[] = [];
  sessions.subscribe(STATION_ID, 'customer', (m) => guest.push(m));
  sessions.subscribe(STATION_ID, 'staff', (m) => staff.push(m));
  return {
    router,
    guest,
    staff,
    hold: (s: BenefitScopeItem | null) => {
      held = s;
    },
    close: () => db.close(),
  };
}

/** A scan's answer with a handled benefit's own `benefitCode` taken out: what is left are words. */
function withoutHandedCode(value: unknown): unknown {
  const v = value as { outcome?: string; detail?: Record<string, unknown> };
  if (v?.outcome !== 'handled' || !v.detail || !('benefitCode' in v.detail)) return value;
  const { benefitCode: _handed, ...rest } = v.detail;
  return { ...v, detail: rest };
}

test('the genuine QR, on every box state: handled where admitted and refused otherwise, each in its own words', async () => {
  const t = station();
  for (const s of STATES) {
    t.hold(s.held);
    const result = await t.router.deliver(STATION_ID, { code: GENUINE, source: 'box_hid' });
    assert.equal(result.kind, 'benefit', s.what);
    if (s.genuine === 'handled') {
      assert.equal(result.outcome, 'handled', s.what);
      assert.equal(result.detail?.benefitCode, GENUINE, s.what);
    } else {
      assert.equal(result.errorCode, s.genuine, s.what);
      assert.equal(result.detail?.benefitCode, undefined, s.what);
    }
  }
  // The two refusals that echo, echo up to the signature and stop.
  t.hold(scope({ keys: [] }));
  const unknownKey = await t.router.deliver(STATION_ID, { code: GENUINE, source: 'box_hid' });
  assert.equal(unknownKey.detail?.message, BENEFIT_WORDS.notFound(GENUINE));
  assert.equal(
    unknownKey.detail?.message,
    `No staff benefit found for "${GENUINE.slice(0, DOT)}".`,
  );
  t.close();
});

test('every shape a counter reads a live QR in, on every box state: the guest never hears its signature, and staff hear it only as a handled benefitCode', async () => {
  const t = station();
  const all = shapes();
  let handled = 0;
  let refused = 0;
  let notOurs = 0;
  for (const s of STATES) {
    t.hold(s.held);
    for (const shape of all) {
      t.guest.length = 0;
      t.staff.length = 0;
      const result: ScanResult = await t.router.deliver(STATION_ID, {
        code: shape.code,
        source: 'box_hid',
      });
      const where = `${s.what} / ${shape.what}`;
      if (result.kind !== 'benefit') notOurs += 1;
      else if (result.outcome === 'handled') handled += 1;
      else refused += 1;

      assert.equal(t.guest.length, 1, `${where}: one message to the guest`);
      assert.equal(t.staff.length, 1, `${where}: one message to the staff screen`);
      const guest = JSON.stringify(t.guest[0]);
      assert.equal(
        carriesSignature(guest),
        false,
        `${where}: the guest hears the signature: ${guest.slice(0, 300)}`,
      );

      const staffWords = JSON.stringify(withoutHandedCode(t.staff[0]));
      assert.equal(
        carriesSignature(staffWords),
        false,
        `${where}: the staff screen hears the signature outside benefitCode: ${staffWords.slice(0, 300)}`,
      );
      const answerWords = JSON.stringify(withoutHandedCode(result));
      assert.equal(
        carriesSignature(answerWords),
        false,
        `${where}: the router's answer carries the signature outside benefitCode: ${answerWords.slice(0, 300)}`,
      );
      if (result.outcome !== 'handled') {
        assert.equal(
          result.detail?.benefitCode,
          undefined,
          `${where}: a refusal hands the code over`,
        );
      }
    }
  }
  // The sweep reached all three kinds of outcome, so it tested something.
  assert.ok(handled > 0, 'some shapes were admitted');
  assert.ok(refused > 1000, `most shapes were refused as benefit QRs (${refused})`);
  assert.ok(notOurs > 0, 'some shapes were not read as benefit QRs at all');
  t.close();
});
