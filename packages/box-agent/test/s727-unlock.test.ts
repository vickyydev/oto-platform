import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { hash, verify } from '@node-rs/argon2';
import { encodeStaffToken, type OfflineStaffRecord, type StaffTokenClaims } from '../src/staff-token';
import { createBridgeServer } from '../src/runner/bridge-server';
import { BOX_ID, BRANCH_ID, STATION_ID, fakeBoxCloud, openTestAgent, tillBundle } from './_support';

// Actual agent + SQLite + real HTTP + argon2; the cloud boundary supplies config only.
test('SCRUM-727 HIGH: the complete local-agent session matrix; no rejected token becomes a fresh sign-in', async t => {
  const keys = generateKeyPairSync('ed25519');
  const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const accountId = randomUUID(), stranger = randomUUID(), jti = randomUUID();
  const now = Date.now(), iat = Math.floor(now / 1000);
  const password = 'ZZ TEST local-only password';
  const mint = (over: Partial<StaffTokenClaims> = {}) => encodeStaffToken({
    v: 1, jti, sub: accountId, aud: BRANCH_ID, sid: randomUUID(), sta: STATION_ID,
    box: BOX_ID, iat, exp: iat + 3600, ...over,
  }, { kid: 'zz-test-727-key', privateKeyPem });
  const token = mint(), expired = mint({ iat: iat - 7200, exp: iat - 1 });
  const cloud = fakeBoxCloud(tillBundle({ staffOfflineSignIn: true, signingKeys: [
    { purpose: 'staff_token', kid: 'zz-test-727-key', algorithm: 'ed25519', publicKey },
  ] }));
  const rig = await openTestAgent(cloud, { bridge: { verifyPassword: verify } });
  const server = createBridgeServer({ agent: () => rig.agent, origins: ['https://pos.example.test'], port: 0 });
  const { port } = await server.listen();
  const url = `http://127.0.0.1:${port}/box/v1/station/${STATION_ID}/unlock`;
  const record = { accountId, passwordHash: await hash(password), status: 'active', mustChangePassword: false,
    lastTokenAt: new Date(now - 86400000).toISOString(), lastTokenId: jti, lastTokenRevoked: false, managerEndedAt: null };
  const write = (scope: 'staff' | 'deny_list', items: unknown[], appliedAt = new Date().toISOString()) =>
    rig.harness.store.writeBundle(BOX_ID, { scope, schemaVersion: 1, cursorSeq: 0, payload: { items }, appliedAt });
  type Row = { name: string; body: object; status: number; code?: string; fresh?: boolean; origin?: string;
    revokedToken?: boolean; revokedAccount?: boolean; ended?: boolean; stale?: boolean; oldStaff?: boolean; legacyStaff?: boolean };
  const rows: Row[] = [
    { name: 'token alone', body: { token }, status: 400, code: 'VALIDATION' },
    { name: 'password without account', body: { password }, status: 401, code: 'STAFF_TOKEN_INVALID' },
    { name: 'password and account without token', body: { password, accountId }, status: 200, fresh: true },
    { name: 'old cache without shift metadata, token omitted', body: { password, accountId }, legacyStaff: true, status: 401, code: 'OFFLINE_REVOCATION_UNKNOWN' },
    { name: 'old cache without shift metadata, expired token', body: { token: expired, password, accountId }, legacyStaff: true, status: 401, code: 'OFFLINE_REVOCATION_UNKNOWN' },
    { name: 'foreign Origin', body: { token, password }, origin: 'https://evil.example', status: 403 },
    { name: 'token and wrong password', body: { token, password: 'wrong' }, status: 401, code: 'OFFLINE_WRONG_PASSWORD' },
    { name: 'token and password', body: { token, password }, status: 200, fresh: false },
    { name: 'expired token and password', body: { token: expired, password }, status: 200, fresh: true },
    { name: 'expired token, password and account', body: { token: expired, password, accountId }, status: 200, fresh: true },
    ...[false, true].flatMap(withAccount => [
      { name: `another station, account=${withAccount}`, token: mint({ sta: stranger }) },
      { name: `another box, account=${withAccount}`, token: mint({ box: stranger }) },
      { name: `another operator branch, account=${withAccount}`, token: mint({ aud: stranger }) },
      { name: `expired foreign station, account=${withAccount}`, token: mint({ sta: stranger, iat: iat - 7200, exp: iat - 1 }) },
    ].map(row => ({ name: row.name, body: { token: row.token, password, ...(withAccount ? { accountId } : {}) }, status: 401, code: 'STAFF_TOKEN_WRONG_AUDIENCE' }))),
    { name: 'another account token', body: { token: mint({ sub: stranger }), password, accountId }, status: 401, code: 'STAFF_TOKEN_WRONG_AUDIENCE' },
    { name: 'forged token and account', body: { token: token.slice(0, -12) + 'aaaaaaaaaaaa', password, accountId }, status: 401, code: 'STAFF_TOKEN_INVALID' },
    { name: 'revoked token', body: { token, password }, revokedToken: true, status: 401, code: 'STAFF_TOKEN_REVOKED' },
    { name: 'expired revoked token', body: { token: expired, password, accountId }, revokedToken: true, status: 401, code: 'STAFF_TOKEN_REVOKED' },
    { name: 'ended shift with token left out', body: { password, accountId }, ended: true, status: 401, code: 'STAFF_TOKEN_REVOKED' },
    { name: 'ended shift with token', body: { token, password }, ended: true, status: 401, code: 'STAFF_TOKEN_REVOKED' },
    { name: 'cached manager-ended token, token left out', body: { password, accountId }, revokedToken: true, ended: true, status: 401, code: 'STAFF_TOKEN_REVOKED' },
    { name: 'account revoked, token left out', body: { password, accountId }, revokedAccount: true, status: 401, code: 'OFFLINE_ACCOUNT_INACTIVE' },
    { name: 'account revoked with token', body: { token, password }, revokedAccount: true, status: 401, code: 'STAFF_TOKEN_REVOKED' },
    { name: 'stale deny-list and fresh sign-in', body: { password, accountId }, stale: true, status: 401, code: 'OFFLINE_DENY_LIST_STALE' },
    { name: 'stale deny-list and expired token', body: { token: expired, password }, stale: true, status: 401, code: 'OFFLINE_DENY_LIST_STALE' },
    { name: 'staff not seen in thirty days', body: { password, accountId }, oldStaff: true, status: 401, code: 'OFFLINE_NOT_RECOGNISED' },
  ];
  try {
    for (const row of rows) await t.test(row.name, async () => {
      const cached: OfflineStaffRecord = { ...record, lastTokenRevoked: !!row.ended, managerEndedAt: row.ended ? new Date(now + 1).toISOString() : null,
        ...(row.oldStaff ? { lastTokenAt: new Date(now - 31 * 86400000).toISOString() } : {}) };
      if (row.legacyStaff) { delete cached.lastTokenId; delete cached.lastTokenRevoked; }
      await write('staff', [cached]);
      await write('deny_list', [{ revokedTokenIds: row.revokedToken ? [jti] : [], revokedAccountIds: row.revokedAccount ? [accountId] : [] }],
        new Date(now - (row.stale ? 73 * 3600000 : 0)).toISOString());
      const response = await fetch(url, { method: 'POST', headers: { origin: row.origin ?? 'https://pos.example.test', 'content-type': 'application/json' }, body: JSON.stringify(row.body) });
      const result = await response.json() as { error?: { code: string }; offlineFresh?: boolean; session?: string };
      assert.equal(response.status, row.status, row.name);
      if (row.code) assert.equal(result.error?.code, row.code);
      if (row.fresh !== undefined) assert.equal(result.offlineFresh, row.fresh);
      if (result.session) rig.agent.bridge()!.end(result.session);
    });
    await t.test('configuration false and true both reach a running physical agent without a restart', async () => {
      await write('staff', [record]); await write('deny_list', [{ revokedTokenIds: [], revokedAccountIds: [] }]);
      for (const enabled of [false, true]) {
        cloud.bundle = { ...cloud.bundle, configVersion: `zz-test-${enabled}`, staffOfflineSignIn: enabled };
        await rig.agent.syncConfig();
        const response = await fetch(url, { method: 'POST', headers: { origin: 'https://pos.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ password, accountId }) });
        assert.equal(response.status, enabled ? 200 : 401);
        const result = await response.json() as { session?: string };
        if (result.session) rig.agent.bridge()!.end(result.session);
      }
    });
  } finally { await server.close(); rig.close(); }
});
