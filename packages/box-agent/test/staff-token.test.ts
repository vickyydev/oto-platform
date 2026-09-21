import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import {
  OfflineAuth,
  STAFF_TOKEN_REFUSALS,
  decodeStaffToken,
  encodeStaffToken,
  refusalMessage,
  verifyStaffToken,
  type OfflineAuthSnapshot,
  type StaffSigningKey,
  type StaffTokenClaims,
} from '../src/staff-token';
import { BOX_ID, BRANCH_ID, STATION_ID } from './_support';

/**
 * The shift token, verified the way a box verifies it (S2-06).
 *
 * Every case here is a thing that could let somebody into a till they should
 * not be in, or keep somebody out of one they should. The two that matter most
 * are the ones that look like paperwork: a header that names its own algorithm
 * (the oldest failure in token handling — this one is a constant and the
 * header's copy is only ever compared with it), and a token that verifies
 * perfectly but was minted for the till next door.
 */

const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const OTHER_ACCOUNT = '018f0000-0000-7000-8000-0000000000a2';
const SESSION = '018f0000-0000-7000-8000-0000000000e1';
const KID = 'abc0123456789def';

function keypair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const keys = keypair();
const signingKeys: StaffSigningKey[] = [
  { purpose: 'staff_token', kid: KID, algorithm: 'ed25519', publicKey: keys.publicKeyPem },
];

const NOW = new Date('2026-09-21T09:00:00.000Z');

function claims(over: Partial<StaffTokenClaims> = {}): StaffTokenClaims {
  const iat = Math.floor(NOW.getTime() / 1000);
  return {
    v: 1,
    jti: '018f0000-0000-7000-8000-0000000000t1',
    sub: ACCOUNT,
    aud: BRANCH_ID,
    sid: SESSION,
    sta: STATION_ID,
    box: BOX_ID,
    iat,
    exp: iat + 16 * 3600,
    ...over,
  };
}

function token(over: Partial<StaffTokenClaims> = {}): string {
  return encodeStaffToken(claims(over), { kid: KID, privateKeyPem: keys.privateKeyPem });
}

/**
 * A box holding a COMPLETE cache: keys, and a deny-list with nobody on it.
 *
 * The empty deny-list is not decoration. Leaving it out used to verify just as
 * happily, which meant every case in this file proved the token checks while
 * silently exercising the state in which revocation is not checked at all.
 */
const base = {
  keys: signingKeys,
  boxId: BOX_ID,
  branchId: BRANCH_ID,
  deny: { revokedAccountIds: [], revokedTokenIds: [] },
  now: NOW,
};

test('a token this box minted verifies here', () => {
  const result = verifyStaffToken(token(), base);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.claims.sub, ACCOUNT);
});

test('a token for the till next door is refused, however well it verifies', () => {
  const other = verifyStaffToken(token({ box: OTHER_ACCOUNT }), base);
  assert.equal(other.ok, false);
  assert.equal(other.ok === false && other.refusal, STAFF_TOKEN_REFUSALS.WRONG_AUDIENCE);

  const branch = verifyStaffToken(token({ aud: OTHER_ACCOUNT }), base);
  assert.equal(branch.ok === false && branch.refusal, STAFF_TOKEN_REFUSALS.WRONG_AUDIENCE);
});

test('an expired token is refused, and says what to do about it', () => {
  const iat = Math.floor(NOW.getTime() / 1000) - 20 * 3600;
  const result = verifyStaffToken(token({ iat, exp: iat + 16 * 3600 }), base);
  assert.equal(result.ok === false && result.refusal, STAFF_TOKEN_REFUSALS.EXPIRED);
  assert.equal(refusalMessage(STAFF_TOKEN_REFUSALS.EXPIRED), 'Shift token expired, connect to sign in');
});

test('a token from the future is refused, but a Pi whose clock is a minute behind is not', () => {
  const soon = Math.floor(NOW.getTime() / 1000) + 60;
  const inLeeway = verifyStaffToken(token({ iat: soon, exp: soon + 3600 }), base);
  assert.equal(inLeeway.ok, true, 'a minute of skew is an ordinary Pi that has just booted');

  const far = Math.floor(NOW.getTime() / 1000) + 3600;
  const outside = verifyStaffToken(token({ iat: far, exp: far + 3600 }), base);
  assert.equal(outside.ok === false && outside.refusal, STAFF_TOKEN_REFUSALS.EXPIRED);
});

test('changed claims do not verify', () => {
  const original = token();
  const decoded = decodeStaffToken(original)!;
  const forged = { ...decoded.claims, sub: OTHER_ACCOUNT };
  const [header, , signature] = original.split('.');
  const tampered = `${header}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
  const result = verifyStaffToken(tampered, base);
  assert.equal(result.ok === false && result.refusal, STAFF_TOKEN_REFUSALS.INVALID);
});

test('a header naming another algorithm is refused rather than obeyed', () => {
  const original = token();
  const [, payload, signature] = original.split('.');
  const header = Buffer.from(JSON.stringify({ v: 1, alg: 'none', kid: KID })).toString('base64url');
  const result = verifyStaffToken(`${header}.${payload}.${signature}`, base);
  assert.equal(result.ok === false && result.refusal, STAFF_TOKEN_REFUSALS.INVALID);
});

test('a key this box does not hold is named as that, not as a bad signature', () => {
  const stranger = keypair();
  const signed = encodeStaffToken(claims(), { kid: 'ffff', privateKeyPem: stranger.privateKeyPem });
  const result = verifyStaffToken(signed, base);
  assert.equal(result.ok === false && result.refusal, STAFF_TOKEN_REFUSALS.UNKNOWN_KEY);
});

test('a rotation keeps the old tokens working while both keys are shipped', () => {
  const next = keypair();
  const NEW_KID = 'aaaa111122223333';
  const older = token();
  const newer = encodeStaffToken(claims({ jti: '018f0000-0000-7000-8000-0000000000t2' }), {
    kid: NEW_KID,
    privateKeyPem: next.privateKeyPem,
  });
  const both = {
    ...base,
    keys: [
      ...signingKeys,
      { purpose: 'staff_token', kid: NEW_KID, algorithm: 'ed25519', publicKey: next.publicKeyPem },
    ],
  };
  assert.equal(verifyStaffToken(older, both).ok, true);
  assert.equal(verifyStaffToken(newer, both).ok, true);
});

test('the deny-list refuses a jti and an account', () => {
  const byToken = verifyStaffToken(token(), {
    ...base,
    deny: { revokedAccountIds: [], revokedTokenIds: [claims().jti] },
  });
  assert.equal(byToken.ok === false && byToken.refusal, STAFF_TOKEN_REFUSALS.REVOKED);

  const byAccount = verifyStaffToken(token(), {
    ...base,
    deny: { revokedAccountIds: [ACCOUNT], revokedTokenIds: [] },
  });
  assert.equal(byAccount.ok === false && byAccount.refusal, STAFF_TOKEN_REFUSALS.REVOKED);
});

test('a box that cannot check revocation refuses, and says which', () => {
  // The whole finding in two assertions. The same token, the same keys, the
  // same clock: the only difference is whether the box holds a deny-list.
  const withList = verifyStaffToken(token(), base);
  assert.equal(withList.ok, true);

  const { deny: _dropped, ...withoutList } = base;
  const blind = verifyStaffToken(token(), withoutList);
  assert.equal(blind.ok, false);
  assert.equal(
    blind.ok === false && blind.refusal,
    STAFF_TOKEN_REFUSALS.REVOCATION_UNKNOWN,
    'no deny-list must not read as an empty one',
  );
  // And it is a different sentence from a revocation, because it is a
  // different fact: the box does not know that a manager ended anything.
  assert.notEqual(
    refusalMessage(STAFF_TOKEN_REFUSALS.REVOCATION_UNKNOWN),
    refusalMessage(STAFF_TOKEN_REFUSALS.REVOKED),
  );
});

test('an expired token is still named expired on a box with no deny-list', () => {
  // Order matters for the message the till shows: the cheaper, more useful
  // refusal comes first, and "connect to sign in" is the fix for both.
  const iat = Math.floor(NOW.getTime() / 1000) - 20 * 3600;
  const { deny: _dropped, ...withoutList } = base;
  const result = verifyStaffToken(token({ iat, exp: iat + 16 * 3600 }), withoutList);
  assert.equal(result.ok === false && result.refusal, STAFF_TOKEN_REFUSALS.EXPIRED);
});

test('a token from a newer platform is refused by name', () => {
  const ahead = encodeStaffToken(
    { ...claims(), v: 99 } as StaffTokenClaims,
    { kid: KID, privateKeyPem: keys.privateKeyPem },
  );
  // The header carries the version, so this is the header's `v` rather than
  // the claim's; encode always stamps the current one, so the shape is forged
  // by hand the way a newer platform would produce it.
  const [, payload, signature] = ahead.split('.');
  const header = Buffer.from(JSON.stringify({ v: 99, alg: 'ed25519', kid: KID })).toString(
    'base64url',
  );
  const result = verifyStaffToken(`${header}.${payload}.${signature}`, base);
  assert.equal(result.ok === false && result.refusal, STAFF_TOKEN_REFUSALS.SCHEMA_TOO_NEW);
});

test('rubbish is refused and does not throw', () => {
  for (const bad of ['', 'x', 'a.b', 'a.b.c', '...', 'not-a-token-at-all']) {
    const result = verifyStaffToken(bad, base);
    assert.equal(result.ok, false);
  }
});

// --- Offline unlock ---------------------------------------------------------

const HASH = 'argon2:correct-horse';

function snapshot(over: Partial<OfflineAuthSnapshot> = {}): OfflineAuthSnapshot {
  return {
    keys: signingKeys,
    staff: [
      {
        accountId: ACCOUNT,
        passwordHash: HASH,
        status: 'active',
        mustChangePassword: false,
        lastTokenAt: NOW.toISOString(),
      },
    ],
    deny: { revokedAccountIds: [], revokedTokenIds: [] },
    cachedAt: '2026-09-21T08:00:00.000Z',
    ...over,
  };
}

function auth(
  over: Partial<ConstructorParameters<typeof OfflineAuth>[0]> = {},
  snap: OfflineAuthSnapshot | null = snapshot(),
): OfflineAuth {
  return new OfflineAuth({
    boxId: BOX_ID,
    branchId: BRANCH_ID,
    snapshot: async () => snap,
    verifyPassword: async (hash, password) => hash === HASH && password === 'correct-horse',
    now: () => NOW,
    ...over,
  });
}

test('the token and the password are BOTH required, and the unlock is named', async () => {
  const ok = await auth().unlock({ token: token(), password: 'correct-horse' });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.method, 'offline_token');
  assert.equal(ok.ok && ok.cachedAt, '2026-09-21T08:00:00.000Z');

  const wrong = await auth().unlock({ token: token(), password: 'guess' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.ok === false && wrong.refusal, 'OFFLINE_WRONG_PASSWORD');
});

test('a box that has never pulled a cache knows nobody, and says which', async () => {
  const cold = await auth({}, null).unlock({ token: token(), password: 'correct-horse' });
  assert.equal(cold.ok === false && cold.refusal, 'OFFLINE_NO_CACHE');
  assert.match(cold.ok === false ? cold.message : '', /connect to the internet/i);
});

test('an account the box has not cached cannot unlock, even with a good token', async () => {
  const empty = await auth({}, snapshot({ staff: [] })).unlock({
    token: token(),
    password: 'correct-horse',
  });
  assert.equal(empty.ok === false && empty.refusal, 'OFFLINE_NO_CACHE');

  const somebodyElse = await auth(
    {},
    snapshot({
      staff: [
        { accountId: OTHER_ACCOUNT, passwordHash: HASH, status: 'active', mustChangePassword: false },
      ],
    }),
  ).unlock({ token: token(), password: 'correct-horse' });
  assert.equal(somebodyElse.ok === false && somebodyElse.refusal, 'OFFLINE_ACCOUNT_NOT_CACHED');
});

test('an account the last bundle deactivated cannot unlock', async () => {
  const inactive = await auth(
    {},
    snapshot({
      staff: [
        { accountId: ACCOUNT, passwordHash: HASH, status: 'inactive', mustChangePassword: false },
      ],
    }),
  ).unlock({ token: token(), password: 'correct-horse' });
  assert.equal(inactive.ok === false && inactive.refusal, 'OFFLINE_ACCOUNT_INACTIVE');

  const denied = await auth(
    {},
    snapshot({ deny: { revokedAccountIds: [ACCOUNT], revokedTokenIds: [] } }),
  ).unlock({ token: token(), password: 'correct-horse' });
  // The deny-list is checked on the token first, so this is REVOKED rather
  // than INACTIVE — both refuse, and the distinction is what the till shows.
  assert.equal(denied.ok === false && denied.refusal, STAFF_TOKEN_REFUSALS.REVOKED);
});

test('a box whose cache lost the deny-list unlocks nobody, by either door', async () => {
  const blind = snapshot({ deny: null });

  // The token path: a shift the park may have ended that morning.
  const byToken = await auth({}, blind).unlock({ token: token(), password: 'correct-horse' });
  assert.equal(byToken.ok, false);
  assert.equal(byToken.ok === false && byToken.refusal, 'OFFLINE_REVOCATION_UNKNOWN');
  assert.match(byToken.ok === false ? byToken.message : '', /connect to the internet/i);

  // And the 30-day sign-in path, which reads the same list for the account.
  const bySignIn = await auth({ allowOfflineSignIn: true }, blind).unlock({
    password: 'correct-horse',
    accountId: ACCOUNT,
  });
  assert.equal(bySignIn.ok === false && bySignIn.refusal, 'OFFLINE_REVOCATION_UNKNOWN');

  // It is distinct from a box that has never pulled at all: the two send
  // whoever is standing there after different fixes.
  const cold = await auth({}, null).unlock({ token: token(), password: 'correct-horse' });
  assert.equal(cold.ok === false && cold.refusal, 'OFFLINE_NO_CACHE');

  // The right password is not enough, and the wrong one is not even counted:
  // nothing here is a judgement about the person.
  const wrong = await auth({}, blind).unlock({ token: token(), password: 'guess' });
  assert.equal(wrong.ok === false && wrong.refusal, 'OFFLINE_REVOCATION_UNKNOWN');
});

test('five wrong passwords close the till, and the sixth is refused without checking', async () => {
  const guard = auth();
  for (let i = 0; i < 4; i += 1) {
    const attempt = await guard.unlock({ token: token(), password: 'guess' });
    assert.equal(attempt.ok === false && attempt.refusal, 'OFFLINE_WRONG_PASSWORD');
  }
  const fifth = await guard.unlock({ token: token(), password: 'guess' });
  assert.equal(fifth.ok === false && fifth.refusal, 'OFFLINE_LOCKED_OUT');

  // And the RIGHT password is refused while the cooldown is on: a guesser who
  // learns nothing from the answer is the point.
  const during = await guard.unlock({ token: token(), password: 'correct-horse' });
  assert.equal(during.ok === false && during.refusal, 'OFFLINE_LOCKED_OUT');
  assert.ok(during.ok === false && (during.retryAfterS ?? 0) > 0);
});

test('an expired token is refused by default, whoever is standing there', async () => {
  const iat = Math.floor(NOW.getTime() / 1000) - 20 * 3600;
  const stale = token({ iat, exp: iat + 16 * 3600 });
  const refused = await auth().unlock({ token: stale, password: 'correct-horse' });
  assert.equal(refused.ok === false && refused.refusal, STAFF_TOKEN_REFUSALS.EXPIRED);
  assert.match(refused.ok === false ? refused.message : '', /connect to sign in/i);
});

test('with offline sign-in on, somebody the box has seen this month gets in by password', async () => {
  const iat = Math.floor(NOW.getTime() / 1000) - 20 * 3600;
  const stale = token({ iat, exp: iat + 16 * 3600 });
  const guard = auth({ allowOfflineSignIn: true });
  // The account comes from the CALLER — the locked session — and never from
  // the dead token: a token that did not verify names nobody, and letting it
  // choose which cached account to attack would be handing an attacker the
  // pick of the staff list.
  const ok = await guard.unlock({ token: stale, password: 'correct-horse', accountId: ACCOUNT });
  assert.equal(ok.ok, true);
  // Recorded as what it is. An unlock allowed by a month-old recognition is
  // not the same statement as one carried by a live token.
  assert.equal(ok.ok && ok.method, 'offline_sign_in');
  assert.equal(ok.ok && ok.claims, null);
});

test('and somebody the box has not seen for thirty-one days does not', async () => {
  const old = new Date(NOW.getTime() - 31 * 24 * 3600 * 1000).toISOString();
  const guard = auth(
    { allowOfflineSignIn: true },
    snapshot({
      staff: [
        {
          accountId: ACCOUNT,
          passwordHash: HASH,
          status: 'active',
          mustChangePassword: false,
          lastTokenAt: old,
        },
      ],
    }),
  );
  const refused = await guard.unlock({ password: 'correct-horse', accountId: ACCOUNT });
  assert.equal(refused.ok === false && refused.refusal, 'OFFLINE_NOT_RECOGNISED');
});

test('a box that has never minted a token for somebody has never seen them', async () => {
  const guard = auth(
    { allowOfflineSignIn: true },
    snapshot({
      staff: [
        { accountId: ACCOUNT, passwordHash: HASH, status: 'active', mustChangePassword: false },
      ],
    }),
  );
  const refused = await guard.unlock({ password: 'correct-horse', accountId: ACCOUNT });
  assert.equal(refused.ok === false && refused.refusal, 'OFFLINE_NOT_RECOGNISED');
});

test('a shared throttle is used when one is given, and the memory one is not', async () => {
  const calls: string[] = [];
  const guard = auth({
    throttle: {
      check: async () => {
        calls.push('check');
        return 0;
      },
      fail: async () => {
        calls.push('fail');
        return { locked: false, retryAfterS: 0 };
      },
      clear: async () => {
        calls.push('clear');
      },
    },
  });
  await guard.unlock({ token: token(), password: 'guess' });
  await guard.unlock({ token: token(), password: 'correct-horse' });
  assert.deepEqual(calls, ['check', 'fail', 'check', 'clear']);
});
