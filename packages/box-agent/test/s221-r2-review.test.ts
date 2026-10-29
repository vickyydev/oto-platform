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

import { checkBenefitOnBox, encodeBenefitCredential } from '../src/benefit-credential';
import { ScanRouter } from '../src/scan';
import { uuidv7 } from '../src/signing';
import { redactScanForCustomer } from '../src/station-session';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { StationScanMessage } from '../src/contract';
import { BOX_ID, STATION_ID } from './_support';

/**
 * SCRUM-218 review of lane I round 2 — the benefit QR on the box, attacked
 * from outside the builder's suites (`benefit-credential.test.ts`, the gate
 * host and booth cases):
 *
 *   - the verifier is not fooled by a key of another PURPOSE or ALGORITHM under
 *     the right key id, nor by a re-encoded signature that dodges revocation;
 *   - expiry is exact to the second;
 *   - no handler registered later can take a benefit QR from the router;
 *   - the screen facing the guest never hears a scannable QR — not in
 *     `benefitCode`, and not inside a refusal's words either.
 *
 * (The booth's badge path went with booth sign-in, SCRUM-694: nobody signs in
 * at the booth, so there is no badge path for a benefit QR to be tried at.)
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
const LEFT_ROLE = { employeeId: uuidv7(), credentialId: uuidv7() };

const qr = (
  who: { employeeId: string; credentialId: string },
  exp = NOW_S + 365 * 86_400,
  key = PARK,
) => encodeBenefitCredential({ ...who, exp }, { kid: key.kid, privateKeyPem: key.privateKeyPem });

function scope(over: Partial<BenefitScopeItem> = {}): BenefitScopeItem {
  return {
    version: 'review',
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
    ],
    ...over,
  };
}

const refusal = (code: string, s: BenefitScopeItem, now = NOW) => {
  const v = checkBenefitOnBox(code, { scope: s, today: TODAY, now });
  return v.ok ? 'ok' : v.refusal;
};

// --- The verifier -----------------------------------------------------------------

test('the right key id is not enough: a key of another purpose or algorithm under it verifies nothing', () => {
  const code = qr(ANAN);
  assert.equal(refusal(code, scope()), 'ok');
  // The very same public half, published for the shift token rather than for
  // benefit QRs: a box must not let one purpose's key vouch for another's.
  assert.equal(
    refusal(code, scope({ keys: [{ ...PARK.key, purpose: 'staff_token' }] })),
    BENEFIT_CREDENTIAL_REFUSALS.UNKNOWN_KEY,
  );
  assert.equal(
    refusal(code, scope({ keys: [{ ...PARK.key, purpose: 'booking_qr' }] })),
    BENEFIT_CREDENTIAL_REFUSALS.UNKNOWN_KEY,
  );
  assert.equal(
    refusal(code, scope({ keys: [{ ...PARK.key, algorithm: 'es256' }] })),
    BENEFIT_CREDENTIAL_REFUSALS.UNKNOWN_KEY,
  );
  // No keys at all: refused, never admitted on the strength of the shape.
  assert.equal(refusal(code, scope({ keys: [] })), BENEFIT_CREDENTIAL_REFUSALS.UNKNOWN_KEY);
});

test('expiry is exact to the second, by the box’s clock', () => {
  const at = qr(ANAN, NOW_S);
  assert.equal(refusal(at, scope()), BENEFIT_CREDENTIAL_REFUSALS.EXPIRED, 'exp == now is expired');
  assert.equal(refusal(qr(ANAN, NOW_S + 1), scope()), 'ok');
  const verdict = checkBenefitOnBox(at, { scope: scope(), today: TODAY, now: NOW });
  assert.equal(!verdict.ok && verdict.message, BENEFIT_WORDS.expired);
});

test('re-encoding the signature cannot dodge a revocation: the list is by credential, not by string', () => {
  const code = qr(ANAN);
  const dot = code.lastIndexOf('.');
  const signature = code.slice(dot + 1);
  // The last of 86 base64url characters carries two bits of the signature and
  // four of padding; a different character with the same two bits decodes to
  // the same 64 bytes. Whatever a decoder makes of it, a revoked credential
  // stays revoked.
  const last = signature[85]!;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const index = alphabet.indexOf(last);
  const sibling = alphabet[(index & ~0x0f) | ((index + 1) & 0x0f)]!;
  const variant = `${code.slice(0, dot + 1)}${signature.slice(0, 85)}${sibling}`;
  assert.notEqual(variant, code);
  const revoked = scope({ revokedCredentialIds: [ANAN.credentialId] });
  for (const c of [code, variant]) {
    const r = refusal(c, revoked);
    assert.ok(
      r === BENEFIT_CREDENTIAL_REFUSALS.REVOKED || r === BENEFIT_CREDENTIAL_REFUSALS.INVALID,
      `a revoked credential re-encoded is still refused (${r})`,
    );
  }
  // Upper-casing the ids is not a way round the list either: it is not a QR
  // the platform printed.
  const upper = code.replace(ANAN.credentialId, ANAN.credentialId.toUpperCase());
  assert.equal(refusal(upper, revoked), BENEFIT_CREDENTIAL_REFUSALS.MALFORMED);
});

// --- The router -------------------------------------------------------------------

function open(read: () => { scope: BenefitScopeItem | null; today: string | null }) {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });
  const published: StationScanMessage[] = [];
  const router = new ScanRouter({
    boxId: BOX_ID,
    store,
    now: () => NOW,
    benefits: read,
    publish: (_station, message) => published.push(message),
  });
  return { router, published, close: () => db.close() };
}

test('no handler registered later takes a benefit QR from the router, however broad it is', async () => {
  const t = open(() => ({ scope: scope(), today: TODAY }));
  let stolen = 0;
  // What S2-07b's staff badge handler could look like: it claims anything.
  t.router.register({
    name: 'everything',
    kind: 'staff_badge',
    matches: () => true,
    handle: async () => {
      stolen += 1;
      return { outcome: 'handled' };
    },
  });
  const result = await t.router.deliver(STATION_ID, { code: qr(ANAN), source: 'box_hid' });
  assert.equal(result.handler, 'benefit');
  assert.equal(result.outcome, 'handled');
  // And a forged one is refused by the benefit handler, not handed on.
  const forged = await t.router.deliver(STATION_ID, {
    code: qr(ANAN).replace(ANAN.employeeId, uuidv7()),
    source: 'box_hid',
  });
  assert.equal(forged.handler, 'benefit');
  assert.equal(forged.outcome, 'refused');
  assert.equal(stolen, 0);
  t.close();
});

test('the screen facing the guest never hears a scannable QR — handled, or refused for a reason that is not the QR’s fault', async () => {
  // A genuine QR this box has no person for (their role was taken away, or
  // the box's copy has not caught up) and one under a key the box has not
  // pulled yet: both are live credentials, refused here for reasons of the
  // box's own, and both still verify somewhere else.
  const t = open(() => ({ scope: scope(), today: TODAY }));
  const handled = qr(ANAN);
  const noPerson = qr(LEFT_ROLE);
  const NEXT = keypair();
  const notPulledYet = qr(ANAN, undefined, NEXT);
  for (const code of [handled, noPerson, notPulledYet]) {
    await t.router.deliver(STATION_ID, { code, source: 'box_hid' });
  }
  assert.equal(t.published.length, 3);
  assert.equal(t.published[0]!.outcome, 'handled');
  assert.equal(t.published[1]!.errorCode, BENEFIT_CREDENTIAL_REFUSALS.NOT_FOUND);
  assert.equal(t.published[2]!.errorCode, BENEFIT_CREDENTIAL_REFUSALS.UNKNOWN_KEY);
  const signatureOf = (c: string) => c.slice(c.lastIndexOf('.') + 1);
  for (const [i, code] of [handled, noPerson, notPulledYet].entries()) {
    const customer = JSON.stringify(redactScanForCustomer(t.published[i]!));
    assert.equal(
      customer.includes(signatureOf(code)),
      false,
      `scan ${i}: the customer view carries the QR's signature: ${customer.slice(0, 160)}`,
    );
  }
  t.close();
});
