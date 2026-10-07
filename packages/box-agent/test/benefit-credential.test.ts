import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  BENEFIT_CREDENTIAL_REFUSALS,
  businessDate,
  hasBenefitCredentialHeader,
  isBandCodeShape,
  isLegacyBoothCode,
  parseBenefitCredential,
  parseBookingQr,
  type BenefitScopeItem,
} from '@oto/shared';

import {
  BENEFIT_CODE_HANDLER,
  benefitCredentialHash,
  checkBenefitOnBox,
  encodeBenefitCredential,
  readBenefitScope,
  verifyBenefitCredential,
} from '../src/benefit-credential';
import { decideGate, GATE_MESSAGES } from '../src/gate/decision';
import { ScanRouter, isBandCodeCandidate, isBoothVoucherCode, isProductBarcode } from '../src/scan';
import { uuidv7 } from '../src/signing';
import { redactScanForCustomer } from '../src/station-session';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { StationScanMessage } from '../src/contract';
import { BOX_ID, STATION_ID, fakeBoxCloud, openTestAgent, tillBundle } from './_support';

/**
 * S2-21 (SCRUM-218) round 2 — the staff benefit QR on the box.
 *
 * The plan's hazards this file holds (docs/progress/plans/benefits/PLAN.md §11):
 *
 *   - H6: a forged, expired or wrongly-keyed QR is refused — altered claims, a
 *     key nobody holds, another key under a borrowed `kid`, an expired one, a
 *     newer format, a string with the header and nothing else;
 *   - H7: a revoked QR is refused once the box's `benefits` scope carries the
 *     revocation, and a box with no scope admits nothing;
 *   - H8: a benefit QR is not a band — the gate refuses it in its own words;
 *   - the box answers with the person's comp and standing percent for the day
 *     and never applies the quota-bearing stages (plan §4, §7).
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
const OTHER = keypair();
const NOW = new Date('2026-10-07T06:00:00.000Z');
const IN_A_YEAR = Math.floor(NOW.getTime() / 1000) + 365 * 86_400;
const TODAY = businessDate(NOW, 'Asia/Bangkok', 5 * 60);

const ANAN = { employeeId: uuidv7(), credentialId: uuidv7() };
const LEK = { employeeId: uuidv7(), credentialId: uuidv7() };
const DAO = { employeeId: uuidv7(), credentialId: uuidv7() };
const NOBODY = { employeeId: uuidv7(), credentialId: uuidv7() };

const qr = (who: { employeeId: string; credentialId: string }, exp = IN_A_YEAR, key = PARK) =>
  encodeBenefitCredential({ ...who, exp }, { kid: key.kid, privateKeyPem: key.privateKeyPem });

function scope(over: Partial<BenefitScopeItem> = {}): BenefitScopeItem {
  return {
    version: 'v-test',
    keys: [PARK.key],
    revokedCredentialIds: [],
    revokedEmployeeIds: [],
    employees: [
      {
        employeeId: ANAN.employeeId,
        name: 'Khun Anan (Owner)',
        days: [
          {
            from: '2026-01-01',
            to: null,
            benefitRole: 'owner',
            comp: true,
            standingDiscount: null,
            onlineOnly: [],
          },
        ],
      },
      {
        employeeId: LEK.employeeId,
        name: 'Khun Lek (Manager)',
        days: [
          {
            from: '2026-01-01',
            to: null,
            benefitRole: 'manager',
            comp: false,
            standingDiscount: { percent: 30, target: { kind: 'fnb' } },
            onlineOnly: ['freeItems', 'credit'],
          },
        ],
      },
      {
        // A role from tomorrow only: nothing today.
        employeeId: DAO.employeeId,
        name: 'Khun Dao (Manager)',
        days: [
          {
            from: TODAY,
            to: '2099-01-01',
            benefitRole: null,
            comp: false,
            standingDiscount: null,
            onlineOnly: [],
          },
          {
            from: '2099-01-01',
            to: null,
            benefitRole: 'manager',
            comp: false,
            standingDiscount: { percent: 30 },
            onlineOnly: [],
          },
        ],
      },
    ],
    ...over,
  };
}

// --- The codec ------------------------------------------------------------------

test('a benefit QR is the plan’s payload, its key id and a signature — deterministic, and parsed back', () => {
  const code = qr(ANAN);
  assert.ok(
    code.startsWith(`OTO-BEN:v1:${ANAN.employeeId}:${ANAN.credentialId}:${IN_A_YEAR}:${PARK.kid}.`),
  );
  assert.equal(code, qr(ANAN), 'Ed25519 is deterministic: the same claims print the same QR');
  assert.equal(benefitCredentialHash(code), benefitCredentialHash(`  ${code}\r\n`.trim()));
  const parsed = parseBenefitCredential(code);
  assert.equal(parsed.ok, true);
  const verified = verifyBenefitCredential(code, { keys: [PARK.key], now: NOW });
  assert.deepEqual(verified.ok && verified.credential.employeeId, ANAN.employeeId);
  assert.deepEqual(verified.ok && verified.credential.credentialId, ANAN.credentialId);
});

test('H6: altered, invented, wrongly keyed, expired and too-new QRs are each refused for what they are', () => {
  const code = qr(LEK);
  const verify = (c: string) => verifyBenefitCredential(c, { keys: [PARK.key], now: NOW });
  const refusal = (c: string) => {
    const v = verify(c);
    return v.ok ? 'ok' : v.refusal;
  };
  // Somebody else's id swapped in: the signature no longer covers it.
  assert.equal(
    refusal(code.replace(LEK.employeeId, ANAN.employeeId)),
    BENEFIT_CREDENTIAL_REFUSALS.INVALID,
  );
  // An expiry pushed out.
  assert.equal(
    refusal(code.replace(`:${IN_A_YEAR}:`, `:${IN_A_YEAR + 1}:`)),
    BENEFIT_CREDENTIAL_REFUSALS.INVALID,
  );
  // Signed by another key, and claimed under ours.
  const forged = qr(LEK, IN_A_YEAR, OTHER).replace(OTHER.kid, PARK.kid);
  assert.equal(refusal(forged), BENEFIT_CREDENTIAL_REFUSALS.INVALID);
  // Signed by a key this box does not hold.
  assert.equal(refusal(qr(LEK, IN_A_YEAR, OTHER)), BENEFIT_CREDENTIAL_REFUSALS.UNKNOWN_KEY);
  // Expired.
  assert.equal(
    refusal(qr(LEK, Math.floor(NOW.getTime() / 1000) - 1)),
    BENEFIT_CREDENTIAL_REFUSALS.EXPIRED,
  );
  // A newer format.
  assert.equal(
    refusal(code.replace('OTO-BEN:v1:', 'OTO-BEN:v2:')),
    BENEFIT_CREDENTIAL_REFUSALS.SCHEMA_TOO_NEW,
  );
  // The header and nothing a QR carries; the prototype's own readable code.
  assert.equal(refusal('OTO-BEN:v1:nothing'), BENEFIT_CREDENTIAL_REFUSALS.MALFORMED);
  assert.equal(
    refusal(code.slice(0, code.lastIndexOf('.'))),
    BENEFIT_CREDENTIAL_REFUSALS.MALFORMED,
  );
  assert.equal(refusal('OTO-BENEFIT-OP-4'), BENEFIT_CREDENTIAL_REFUSALS.MALFORMED);
  // A key that is not a key at all: a refusal, never a throw.
  const broken = verifyBenefitCredential(code, {
    keys: [{ ...PARK.key, publicKey: 'not a pem' }],
    now: NOW,
  });
  assert.equal(broken.ok ? 'ok' : broken.refusal, BENEFIT_CREDENTIAL_REFUSALS.INVALID);
});

test('nothing else the platform prints is read as a benefit QR, and a benefit QR is read as nothing else', () => {
  const code = qr(ANAN);
  assert.equal(hasBenefitCredentialHeader(code), true);
  assert.equal(hasBenefitCredentialHeader(code.toLowerCase()), true);
  assert.equal(isBandCodeShape(code), false);
  assert.equal(isBandCodeCandidate(code), false);
  assert.equal(isBoothVoucherCode(code), false);
  assert.equal(isProductBarcode(code), false);
  assert.equal(isLegacyBoothCode(code), false);
  assert.equal(parseBookingQr(code), null);
  for (const other of [
    'BK1:01J9ZK3Q7M4QXXXXXXXXXXXXXX.7M4QXXXXXXXXXXXX',
    '8850000000017',
    'OTO-BENEFIT-OP-4',
  ]) {
    assert.equal(hasBenefitCredentialHeader(other), false, other);
  }
});

// --- On the box -----------------------------------------------------------------

test('the box answers with the day’s comp and standing percent, and names what stays online only', () => {
  const owner = checkBenefitOnBox(qr(ANAN), { scope: scope(), today: TODAY, now: NOW });
  assert.equal(owner.ok, true);
  assert.equal(owner.ok && owner.benefit.comp, true);
  assert.equal(owner.ok && owner.benefit.name, 'Khun Anan (Owner)');

  const manager = checkBenefitOnBox(qr(LEK), { scope: scope(), today: TODAY, now: NOW });
  assert.equal(manager.ok, true);
  if (manager.ok) {
    assert.equal(manager.benefit.comp, false);
    assert.deepEqual(manager.benefit.standingDiscount, { percent: 30, target: { kind: 'fnb' } });
    assert.deepEqual(manager.benefit.onlineOnly, ['freeItems', 'credit']);
    assert.equal(manager.benefit.day, TODAY);
  }
});

test('H7: revoked, left, unknown and not-configured are refused — "Benefit revoked" in the revocation’s own words', () => {
  const revoked = checkBenefitOnBox(qr(LEK), {
    scope: scope({ revokedCredentialIds: [LEK.credentialId] }),
    today: TODAY,
    now: NOW,
  });
  assert.equal(revoked.ok, false);
  if (!revoked.ok) {
    assert.equal(revoked.refusal, BENEFIT_CREDENTIAL_REFUSALS.REVOKED);
    assert.match(revoked.message, /^Benefit revoked/);
  }
  const left = checkBenefitOnBox(qr(LEK), {
    scope: scope({ revokedEmployeeIds: [LEK.employeeId] }),
    today: TODAY,
    now: NOW,
  });
  assert.equal(!left.ok && left.refusal, BENEFIT_CREDENTIAL_REFUSALS.EMPLOYEE_LEFT);

  const unknown = checkBenefitOnBox(qr(NOBODY), { scope: scope(), today: TODAY, now: NOW });
  assert.equal(!unknown.ok && unknown.refusal, BENEFIT_CREDENTIAL_REFUSALS.NOT_FOUND);
  assert.equal(!unknown.ok && unknown.message, `No staff benefit found for "${qr(NOBODY)}".`);

  const nothingToday = checkBenefitOnBox(qr(DAO), { scope: scope(), today: TODAY, now: NOW });
  assert.equal(
    !nothingToday.ok && nothingToday.refusal,
    BENEFIT_CREDENTIAL_REFUSALS.NOT_CONFIGURED,
  );
  assert.equal(
    !nothingToday.ok && nothingToday.message,
    'Khun Dao (Manager) has no benefit configured.',
  );
  // From the day the role starts, the same QR applies.
  const later = checkBenefitOnBox(qr(DAO), { scope: scope(), today: '2099-01-02', now: NOW });
  assert.equal(later.ok, true);

  // No list at all: never admitted unchecked.
  const blind = checkBenefitOnBox(qr(ANAN), { scope: null, today: TODAY, now: NOW });
  assert.equal(!blind.ok && blind.refusal, BENEFIT_CREDENTIAL_REFUSALS.REVOCATION_UNKNOWN);
});

test('the scope is read defensively: a damaged payload is no scope, not a guess', () => {
  assert.equal(readBenefitScope({ items: [{ keys: 'nope' }] }), null);
  assert.equal(readBenefitScope(null), null);
  assert.deepEqual(readBenefitScope({ items: [scope()] })?.employees.length, 3);
});

// --- Through the router -----------------------------------------------------------

function open(read: (() => { scope: BenefitScopeItem | null; today: string | null }) | null) {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });
  const published: StationScanMessage[] = [];
  const router = new ScanRouter({
    boxId: BOX_ID,
    store,
    now: () => NOW,
    ...(read ? { benefits: read } : {}),
    publish: (_station, message) => published.push(message),
  });
  return { router, published, db, close: () => db.close() };
}

test('the router claims a benefit QR, checks it on the box, and the code reaches staff screens only', async () => {
  const t = open(() => ({ scope: scope(), today: TODAY }));
  const code = qr(LEK);
  const result = await t.router.deliver(STATION_ID, { code: `${code}\r\n`, source: 'box_hid' });
  assert.equal(result.kind, 'benefit');
  assert.equal(result.handler, BENEFIT_CODE_HANDLER);
  assert.equal(result.outcome, 'handled');
  assert.equal((result.detail?.benefit as { name: string }).name, 'Khun Lek (Manager)');
  assert.equal(result.detail?.benefitCode, code);

  // The tape: a fingerprint, never the code.
  const rows = t.db.prepare('select payload from station_event').all() as Array<{
    payload: string;
  }>;
  assert.equal(rows.length, 1);
  assert.ok(!rows[0]!.payload.includes(code));
  assert.ok(!rows[0]!.payload.includes(LEK.credentialId));

  // The customer display never receives the QR.
  const customer = redactScanForCustomer(t.published[0]!);
  assert.equal((customer.detail as Record<string, unknown>).benefitCode, undefined);
  assert.equal(t.published[0]!.detail?.benefitCode, code);
  t.close();
});

test('a revoked QR is refused through the router, and a box with no list says it cannot check', async () => {
  const revoked = open(() => ({
    scope: scope({ revokedCredentialIds: [ANAN.credentialId] }),
    today: TODAY,
  }));
  const r = await revoked.router.deliver(STATION_ID, { code: qr(ANAN), source: 'camera' });
  assert.equal(r.outcome, 'refused');
  assert.equal(r.errorCode, BENEFIT_CREDENTIAL_REFUSALS.REVOKED);
  assert.match(String(r.detail?.message), /^Benefit revoked/);
  assert.equal(r.detail?.benefitCode, undefined, 'a refused QR goes nowhere');
  revoked.close();

  const blind = open(null);
  const b = await blind.router.deliver(STATION_ID, { code: qr(ANAN), source: 'camera' });
  assert.equal(b.kind, 'benefit', 'still classified as a benefit QR, never unknown');
  assert.equal(b.outcome, 'error');
  assert.equal(b.errorCode, BENEFIT_CREDENTIAL_REFUSALS.REVOCATION_UNKNOWN);
  blind.close();
});

test('the agent checks a benefit QR against the scope in its own store, on its branch’s trading day', async () => {
  const cloud = fakeBoxCloud(tillBundle());
  const box = await openTestAgent(cloud);
  const scanner = box.agent.scanner()!;
  // Before any pull: no list, so nothing is admitted.
  const before = await scanner.deliver(STATION_ID, { code: qr(ANAN), source: 'simulator' });
  assert.equal(before.errorCode, BENEFIT_CREDENTIAL_REFUSALS.REVOCATION_UNKNOWN);

  await box.harness.store.writeBundle(BOX_ID, {
    scope: 'benefits',
    schemaVersion: 1,
    cursorSeq: 0,
    payload: { items: [scope()] },
    appliedAt: new Date().toISOString(),
  });
  const owner = await scanner.deliver(STATION_ID, { code: qr(ANAN), source: 'simulator' });
  assert.equal(owner.outcome, 'handled');
  assert.equal((owner.detail?.benefit as { comp: boolean }).comp, true);

  // The next pull carries the revocation: refused from the next scan.
  await box.harness.store.writeBundle(BOX_ID, {
    scope: 'benefits',
    schemaVersion: 1,
    cursorSeq: 0,
    payload: { items: [scope({ revokedCredentialIds: [ANAN.credentialId] })] },
    appliedAt: new Date().toISOString(),
  });
  const after = await scanner.deliver(STATION_ID, { code: qr(ANAN), source: 'simulator' });
  assert.equal(after.outcome, 'refused');
  assert.equal(after.errorCode, BENEFIT_CREDENTIAL_REFUSALS.REVOKED);
  box.close();
});

// --- H8 at the gate ----------------------------------------------------------------

test('H8: the gate’s decision refuses a benefit QR as not a band, in either direction', () => {
  for (const direction of ['entry', 'exit'] as const) {
    const d = decideGate({
      code: qr(ANAN),
      direction,
      key: 'gate-test-band-key-0123456789abcdef',
      lookup: () => ({ state: 'active', kind: 'adult' }),
      inside: () => true,
      unknownMeans: 'offline',
    });
    assert.equal(d.open, false);
    assert.equal(!d.open && d.reason, 'NOT_A_BAND');
    assert.equal(d.message, GATE_MESSAGES.NOT_A_BAND);
  }
});
