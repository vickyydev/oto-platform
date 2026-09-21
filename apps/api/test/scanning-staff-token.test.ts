import { generateKeyPairSync } from 'node:crypto';
import { hash as argonHash } from '@node-rs/argon2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import {
  account,
  auditLog,
  boxCommand,
  signingKey,
  staffToken,
  station,
  stationEvent,
  BOX_COMMAND_KINDS as DB_COMMAND_KINDS,
} from '@oto/db';
import {
  BOX_COMMAND_KINDS as AGENT_COMMAND_KINDS,
  createBoxAgent,
  encodeStaffToken,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { provisionVirtualBox } from '../src/services/box';
import { boxStoreFor } from '../src/lib/box-store';
import { staffTokenKid } from '../src/lib/staff-token-key';
import { _resetThrottle } from '../src/services/auth';

/**
 * S2-06 — scanning, and the shift token with its offline unlock, driven
 * through the real routes.
 *
 * The claim this file exists to prove is narrow and load-bearing: **who may
 * unlock, and whether they are still allowed to, is decided from the box's
 * own copy of the staff list and the deny-list — never from the `account`
 * table sitting next to it.** A unit test of the verifier proves the signature
 * maths; it proves nothing about which copy the route consults, which is
 * exactly the shape of seam that has failed three times this sprint. So the
 * decisive case here CHANGES THE CLOUD'S COPY and shows the offline unlock
 * still answering from the box's.
 *
 * The claim is scoped to those two lists on purpose. The PUBLIC signing keys
 * are read live from `core.signing_key`, and that is the point rather than an
 * exception: it is how retiring a leaked key stops the tokens it signed
 * without waiting for every box to pull. The retired-key case below passes
 * *because* of that live read, so a wider claim here would be contradicted by
 * the test standing underneath it.
 *
 * **What it does NOT prove, said here so nobody reads it as more.**
 * `agent.setOffline(true)` stops the agent talking to the cloud; this suite
 * still posts to the route in the same process with the same database open. A
 * till whose mall link is down cannot reach `POST /auth/unlock-offline` at
 * all, because the session plugin ahead of it reads `core.session`. Serving
 * that till means a local HTTP surface on the box calling `OfflineAuth`
 * directly — the next ticket's work, recorded in SPRINT_2_PROGRESS.md. A test
 * that talks to Fastify does not prove a browser with no network can reach a
 * route, and this one does not pretend to.
 *
 * The scanning cases do the same for the other half: the route exists, the box
 * classifies, the tape gets a fingerprint, and the raw code is nowhere on the
 * row.
 */

const keypair = generateKeyPairSync('ed25519');
const PRIVATE_KEY = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_KEY = keypair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KID = staffTokenKid(PUBLIC_KEY);

let ctx: TestContext;
let receptionCookie: string;
let adminCookie: string;
let tillId: string;
let boxId: string;
let receptionAccountId: string;
let agent: BoxAgent;

/** Whatever the station pick handed back most recently. */
let heldToken = '';
let heldJti = '';

beforeAll(async () => {
  ctx = await createTestContext({ env: { STAFF_TOKEN_PRIVATE_KEY: PRIVATE_KEY } });
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const stations = await ctx.db.select().from(station);
  const till = stations.find((s) => s.name === 'Reception Till 1')!;
  tillId = till.id;
  boxId = till.boxId!;

  const accounts = await ctx.db.select({ id: account.id, phone: account.phone }).from(account);
  receptionAccountId = accounts.find((a) => a.phone === RECEPTION.phone)!.id;

  agent = createBoxAgent({
    apiBaseUrl: 'http://virtual-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'scan-test',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
    /**
     * The SAME store the routes read.
     *
     * Not a detail: `SqlBoxStore` keeps its cache bundles in memory when it is
     * on Postgres, because the `edge` schema has no table for them yet, so two
     * instances would mean the agent filling a cache the routes never see —
     * and every offline case here would pass for the wrong reason. The real
     * virtual box uses `boxStoreFor(db)` for this reason too.
     */
    store: boxStoreFor(ctx.db),
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  expect(agent.state.boxId).toBe(boxId);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** `app.inject` behind the agent's transport, as the S2-05 suite does it. */
function injectTransport(): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    return {
      status: res.statusCode,
      json: async () => (res.body ? JSON.parse(res.body) : null),
      text: async () => res.body,
      header: (name) => {
        const value = res.headers[name.toLowerCase()];
        return typeof value === 'string' ? value : null;
      },
    };
  };
}

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  opts: { cookie?: string; payload?: unknown; headers?: Record<string, string> } = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    payload: opts.payload as never,
  });
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

async function pickTill(): Promise<Record<string, unknown>> {
  const res = await call('PUT', '/me/session/station', {
    cookie: receptionCookie,
    payload: { stationId: tillId },
  });
  expect(res.statusCode).toBe(200);
  const token = res.body.staffToken as { token: string; jti: string } | null;
  if (token) {
    heldToken = token.token;
    heldJti = token.jti;
  }
  return res.body;
}

async function lastAudit(action: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await ctx.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, action))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row as unknown as Record<string, unknown> | undefined;
}

describe('the shift token is minted where a station is picked (S2-06)', () => {
  it('hands the token back with the pick and records a revocable row', async () => {
    const body = await pickTill();
    const token = body.staffToken as { token: string; jti: string; expiresAt: string };
    expect(token).toBeTruthy();
    expect(body.staffTokenUnavailable).toBeNull();
    // Three parts, and the middle one is the claim set — not an opaque blob
    // somebody has to reverse-engineer when a till starts refusing.
    expect(token.token.split('.')).toHaveLength(3);

    const [row] = await ctx.db.select().from(staffToken).where(eq(staffToken.jti, token.jti));
    expect(row).toBeTruthy();
    expect(row!.accountId).toBe(receptionAccountId);
    expect(row!.stationId).toBe(tillId);
    expect(row!.boxId).toBe(boxId);
    expect(row!.revokedAt).toBeNull();
    expect(row!.kid).toBe(KID);
  });

  it('publishes the PUBLIC half, and only the public half', async () => {
    const [key] = await ctx.db
      .select()
      .from(signingKey)
      .where(and(eq(signingKey.purpose, 'staff_token'), eq(signingKey.kid, KID)));
    expect(key).toBeTruthy();
    expect(key!.publicKey).toContain('BEGIN PUBLIC KEY');
    // The half that mints is in the environment and must never be in a row.
    expect(key!.publicKey).not.toContain('PRIVATE');
  });

  it('a second pick ends the first token: one session, one live token', async () => {
    const first = heldJti;
    await pickTill();
    expect(heldJti).not.toBe(first);
    const [old] = await ctx.db.select().from(staffToken).where(eq(staffToken.jti, first));
    expect(old!.revokedAt).not.toBeNull();
    expect(old!.revokedReason).toBe('station_changed');
  });

  it('says what it can do, and never the key', async () => {
    const res = await call('GET', '/staff-tokens/settings', { cookie: adminCookie });
    expect(res.statusCode).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.kid).toBe(KID);
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE');
  });
});

describe('the box takes a copy of what it needs (S2-06)', () => {
  it('pulls the cache that nothing was pulling before', async () => {
    const applied = await agent.syncCache();
    // `GET /box/v1/cache` existed since S2-05 with no caller at all.
    expect(applied).toContain('staff');
    expect(applied).toContain('deny_list');

    const store = boxStoreFor(ctx.db);
    const staff = await store.readBundle(boxId, 'staff');
    const items = (staff!.payload as { items: Array<Record<string, unknown>> }).items;
    const mine = items.find((s) => s.accountId === receptionAccountId);
    expect(mine).toBeTruthy();
    expect(String(mine!.passwordHash)).toContain('$argon2');
    // "Seen on this box", which is what the 30-day offline sign-in reads.
    expect(mine!.lastTokenAt).toBeTruthy();
    // And nothing that names the person to whoever holds the disk.
    expect(JSON.stringify(mine)).not.toContain(RECEPTION.phone);
  });

  it('drops staff who are not in the latest bundle', async () => {
    const store = boxStoreFor(ctx.db);
    const before = (
      (await store.readBundle(boxId, 'staff'))!.payload as { items: Array<{ accountId: string }> }
    ).items;
    const adminId = (
      await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, ADMIN.phone))
    )[0]!.id;
    expect(before.map((s) => s.accountId)).toContain(adminId);
    // Somebody leaves: deactivated in the cloud, gone from the next bundle.
    await ctx.db
      .update(account)
      .set({ status: 'inactive' })
      .where(eq(account.phone, ADMIN.phone));
    await agent.syncCache();
    const after = (
      (await store.readBundle(boxId, 'staff'))!.payload as { items: Array<{ accountId: string }> }
    ).items;
    // The scope is replaced whole, so somebody who has left is GONE from the
    // box at its next pull rather than lingering until something expires.
    expect(after.map((s) => s.accountId)).not.toContain(adminId);
    expect(after.length).toBeLessThan(before.length);

    const deny = (
      (await store.readBundle(boxId, 'deny_list'))!.payload as {
        items: Array<{ revokedAccountIds: string[] }>;
      }
    ).items[0]!;
    expect(deny.revokedAccountIds).toContain(adminId);

    // Put the park back: this account signs the rest of the file's admin calls.
    await ctx.db.update(account).set({ status: 'active' }).where(eq(account.phone, ADMIN.phone));
    await agent.syncCache();
  });
});

/**
 * Put the park back: the account's real hash, an empty throttle, an unlocked
 * session and a box that is online again. In a helper rather than at the end
 * of each case, because a case that FAILS half way through must not leave the
 * next one signing in against a password nobody knows — a cascade of red is
 * how a single real failure gets buried.
 */
async function restore(passwordHash: string | null): Promise<void> {
  if (passwordHash) {
    await ctx.db
      .update(account)
      .set({ passwordHash })
      .where(eq(account.id, receptionAccountId));
  }
  await agent.setOffline(false);
  await _resetThrottle(ctx.db);
  await call('POST', '/auth/unlock', {
    cookie: receptionCookie,
    payload: { password: RECEPTION.password },
  });
}

describe('a locked till unlocks with no internet (S2-06)', () => {
  // Whatever a case did, the next one starts at an unlocked till on a box that
  // can hear the cloud.
  afterEach(async () => {
    await restore(null);
  });
  it('unlocks from the box’s cache, with the cloud’s own copy changed underneath', async () => {
    await pickTill();
    await agent.syncCache();
    // The box is cut off from the cloud: no heartbeat, no pull, no push.
    await agent.setOffline(true, { reason: 'test' });

    /**
     * The decisive part. The password on the ACCOUNT ROW is replaced with one
     * nobody knows, so anything reading `core.account` would refuse. The box
     * cached the old hash before the link dropped, and that is what an offline
     * unlock is: a decision made from a copy of a known age.
     */
    const [before] = await ctx.db
      .select({ hash: account.passwordHash })
      .from(account)
      .where(eq(account.id, receptionAccountId));
    await ctx.db
      .update(account)
      .set({ passwordHash: await argonHash('a-password-nobody-knows') })
      .where(eq(account.id, receptionAccountId));

    await call('POST', '/auth/lock', { cookie: receptionCookie });
    // `/me/permissions` is on the locked-exempt list, so it proves nothing
    // here; `/me/stations` is ordinary business and is refused while locked.
    const locked = await call('GET', '/me/stations', { cookie: receptionCookie });
    expect(locked.statusCode).toBe(423);

    const res = await call('POST', '/auth/unlock-offline', {
      cookie: receptionCookie,
      payload: { token: heldToken, password: RECEPTION.password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.authMethod).toBe('offline_token');
    expect(res.body.cachedAt).toBeTruthy();

    // The session really is open again.
    const open = await call('GET', '/me/stations', { cookie: receptionCookie });
    expect(open.statusCode).toBe(200);

    // And the record says how they got in.
    const audit = await lastAudit('session.unlock');
    expect((audit!.after as Record<string, unknown>).authMethod).toBe('offline_token');
    expect((audit!.after as Record<string, unknown>).jti).toBe(heldJti);

    // The ONLINE unlock would have refused the same password, which is what
    // makes the case above a statement about the cache rather than a
    // coincidence.
    await call('POST', '/auth/lock', { cookie: receptionCookie });
    const online = await call('POST', '/auth/unlock', {
      cookie: receptionCookie,
      payload: { password: RECEPTION.password },
    });
    expect(online.statusCode).toBe(401);

    await restore(before!.hash);
  });

  it('refuses an expired token with the words the till shows', async () => {
    await call('POST', '/auth/lock', { cookie: receptionCookie });
    const past = Math.floor(Date.now() / 1000) - 20 * 3600;
    const stale = encodeStaffToken(
      {
        v: 1,
        jti: heldJti,
        sub: receptionAccountId,
        aud: (await ctx.db.select().from(station).where(eq(station.id, tillId)))[0]!.branchId,
        sid: '018f0000-0000-7000-8000-0000000000e9',
        sta: tillId,
        box: boxId,
        iat: past,
        exp: past + 3600,
      },
      { kid: KID, privateKeyPem: PRIVATE_KEY },
    );
    const res = await call('POST', '/auth/unlock-offline', {
      cookie: receptionCookie,
      payload: { token: stale, password: RECEPTION.password },
    });
    expect(res.statusCode).toBe(401);
    const error = res.body.error as { code: string; message: string };
    expect(error.code).toBe('STAFF_TOKEN_EXPIRED');
    expect(error.message).toMatch(/connect to sign in/i);

    await _resetThrottle(ctx.db);
    await call('POST', '/auth/unlock', {
      cookie: receptionCookie,
      payload: { password: RECEPTION.password },
    });
  });

  it('a box that cannot check revocation unlocks nobody (S2-06)', async () => {
    await pickTill();
    await agent.syncCache();
    const store = boxStoreFor(ctx.db);
    const complete = (await store.readBundle(boxId, 'deny_list'))!;

    /**
     * The state a partial cache apply used to leave behind: the staff list
     * applied, the deny-list not. Written here rather than simulated by
     * breaking the store, because it is the STATE that was dangerous — a box
     * in it admitted every token that verified, including one a manager had
     * ended that morning, and nothing on the box or in the cloud said the
     * check had been skipped.
     */
    await store.writeBundle(boxId, { ...complete, payload: { items: [] } });
    await agent.setOffline(true, { reason: 'test' });
    await call('POST', '/auth/lock', { cookie: receptionCookie });

    const res = await call('POST', '/auth/unlock-offline', {
      cookie: receptionCookie,
      payload: { token: heldToken, password: RECEPTION.password },
    });
    expect(res.statusCode).toBe(401);
    // Not "your shift was ended" — the box does not know that. It knows it
    // cannot tell, which is a different sentence and a different fix.
    expect((res.body.error as { code: string }).code).toBe('OFFLINE_REVOCATION_UNKNOWN');
    expect((res.body.error as { message: string }).message).toMatch(/connect to the internet/i);

    // The right password is not a way round it.
    const refusedAgain = await call('POST', '/auth/unlock-offline', {
      cookie: receptionCookie,
      payload: { password: RECEPTION.password },
    });
    expect((refusedAgain.body.error as { code: string }).code).toBe('OFFLINE_REVOCATION_UNKNOWN');

    // And a complete pull is the fix: the same token, the same password.
    await agent.setOffline(false);
    await agent.syncCache();
    await agent.setOffline(true, { reason: 'test' });
    const after = await call('POST', '/auth/unlock-offline', {
      cookie: receptionCookie,
      payload: { token: heldToken, password: RECEPTION.password },
    });
    expect(after.statusCode).toBe(200);
    expect(after.body.authMethod).toBe('offline_token');
  });

  it('a signing key retired after a leak stops the tokens it signed (S2-06)', async () => {
    await pickTill();
    await agent.syncCache();
    await agent.setOffline(true, { reason: 'test' });
    await call('POST', '/auth/lock', { cookie: receptionCookie });

    const works = await call('POST', '/auth/unlock-offline', {
      cookie: receptionCookie,
      payload: { token: heldToken, password: RECEPTION.password },
    });
    expect(works.statusCode).toBe(200);

    /**
     * The documented response to a leaked private half: retire the key. Every
     * Raspberry Pi honoured it — the config bundle drops a retired key — while
     * the unlock path that answers today read `purpose` and `active` alone and
     * went on verifying. Both now ask `usableSigningKeys`.
     */
    await call('POST', '/auth/lock', { cookie: receptionCookie });
    await ctx.db
      .update(signingKey)
      .set({ retiredAt: new Date() })
      .where(and(eq(signingKey.purpose, 'staff_token'), eq(signingKey.kid, KID)));

    const refused = await call('POST', '/auth/unlock-offline', {
      cookie: receptionCookie,
      payload: { token: heldToken, password: RECEPTION.password },
    });
    expect(refused.statusCode).toBe(401);
    // Named for what it is: the box has no key that can check this token.
    expect((refused.body.error as { code: string }).code).toBe('STAFF_TOKEN_UNKNOWN_KEY');

    await ctx.db
      .update(signingKey)
      .set({ retiredAt: null })
      .where(and(eq(signingKey.purpose, 'staff_token'), eq(signingKey.kid, KID)));
  });

  it('a key that no longer signs still verifies what it signed (S2-06)', async () => {
    await pickTill();
    await agent.syncCache();
    await agent.setOffline(true, { reason: 'test' });
    await call('POST', '/auth/lock', { cookie: receptionCookie });

    /**
     * The other half of the case above, and the reason `usableSigningKeys` does
     * not read `active`.
     *
     * A rotation is two keys live at once: `active` moves to the new key while
     * the old one goes on verifying the tokens already in people's pockets —
     * which is what `core.signing_key` says the column is for. That query read
     * it until S2-06, so the first rotation the park ever did would have
     * refused every pocket at the moment the new key went live, and a shift
     * token is hours long. Ending a key is `retired_at`, and that is the case
     * above; this one is the same key merely no longer the one signing.
     */
    await ctx.db
      .update(signingKey)
      .set({ active: false })
      .where(and(eq(signingKey.purpose, 'staff_token'), eq(signingKey.kid, KID)));

    const res = await call('POST', '/auth/unlock-offline', {
      cookie: receptionCookie,
      payload: { token: heldToken, password: RECEPTION.password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.authMethod).toBe('offline_token');

    await ctx.db
      .update(signingKey)
      .set({ active: true })
      .where(and(eq(signingKey.purpose, 'staff_token'), eq(signingKey.kid, KID)));
  });

  it('a manager ending the shift reaches the box at its next pull', async () => {
    await pickTill();
    await agent.syncCache();
    const ended = await call('DELETE', `/staff-tokens/${heldJti}`, { cookie: adminCookie });
    expect(ended.statusCode).toBe(200);
    expect(ended.body.revoked).toBe(1);

    // Still offline-usable until the box hears about it — which is the honest
    // property of offline working, and the reason the expiry is hours.
    await agent.syncCache();
    const store = boxStoreFor(ctx.db);
    const deny = (
      (await store.readBundle(boxId, 'deny_list'))!.payload as {
        items: Array<{ revokedTokenIds: string[] }>;
      }
    ).items[0]!;
    expect(deny.revokedTokenIds).toContain(heldJti);

    await agent.setOffline(true, { reason: 'test' });
    await call('POST', '/auth/lock', { cookie: receptionCookie });
    const res = await call('POST', '/auth/unlock-offline', {
      cookie: receptionCookie,
      payload: { token: heldToken, password: RECEPTION.password },
    });
    expect(res.statusCode).toBe(401);
    expect((res.body.error as { code: string }).code).toBe('STAFF_TOKEN_REVOKED');

    await agent.setOffline(false);
    await _resetThrottle(ctx.db);
    await call('POST', '/auth/unlock', {
      cookie: receptionCookie,
      payload: { password: RECEPTION.password },
    });
  });

  it('five wrong passwords close the till, online and offline alike', async () => {
    await _resetThrottle(ctx.db);
    await pickTill();
    await agent.syncCache();
    await call('POST', '/auth/lock', { cookie: receptionCookie });

    for (let i = 0; i < 4; i += 1) {
      const wrong = await call('POST', '/auth/unlock-offline', {
        cookie: receptionCookie,
        payload: { token: heldToken, password: 'not-the-password' },
      });
      expect(wrong.statusCode).toBe(401);
    }
    const fifth = await call('POST', '/auth/unlock-offline', {
      cookie: receptionCookie,
      payload: { token: heldToken, password: 'not-the-password' },
    });
    expect(fifth.statusCode).toBe(429);

    // The same bucket as the online door: an attacker at a locked till does not
    // get five more tries by switching routes.
    const online = await call('POST', '/auth/unlock', {
      cookie: receptionCookie,
      payload: { password: RECEPTION.password },
    });
    expect(online.statusCode).toBe(429);

    await _resetThrottle(ctx.db);
    const after = await call('POST', '/auth/unlock', {
      cookie: receptionCookie,
      payload: { password: RECEPTION.password },
    });
    expect(after.statusCode).toBe(200);
  });

  it('signing out ends the shift token as well as the session', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const picked = await call('PUT', '/me/session/station', {
      cookie,
      payload: { stationId: tillId },
    });
    const jti = (picked.body.staffToken as { jti: string }).jti;
    await call('POST', '/auth/sign-out', { cookie });
    const [row] = await ctx.db.select().from(staffToken).where(eq(staffToken.jti, jti));
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.revokedReason).toBe('sign_out');

    // This file's own session was ended by the sign-out above only if it was
    // the same one; it was not, so re-establish the till's session for the
    // scanning cases below.
    receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    await pickTill();
  });
});

describe('scanning reaches the box, and the code stops there (S2-06)', () => {
  it('routes a scan and writes a fingerprint, never the code', async () => {
    const code = 'T1-01J8ZQ4F7KSECRET';
    const res = await call('POST', `/stations/${tillId}/scan`, {
      cookie: receptionCookie,
      payload: { code, source: 'camera' },
      headers: { 'x-oto-action-id': 'scan-abcd1234' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.accepted).toBe(true);
    // No handler is registered on this build: band, booking and voucher
    // handlers arrive with the tickets that own them, and "that code means
    // nothing here" is shown rather than swallowed.
    expect(res.body.outcome).toBe('unhandled');
    expect(res.body.handlers).toEqual([]);
    expect(res.body.codeFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(res.body)).not.toContain(code);

    const [row] = await ctx.db
      .select()
      .from(stationEvent)
      .where(and(eq(stationEvent.stationId, tillId), eq(stationEvent.kind, 'scan')))
      .orderBy(desc(stationEvent.receivedAt))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row!.actionId).toBe('scan-abcd1234');
    const payload = row!.payload as Record<string, unknown>;
    expect(payload.codeFingerprint).toBe(res.body.codeFingerprint);
    expect(payload.codePrefix).toBe('T1');
    expect(JSON.stringify(row)).not.toContain('SECRET');
  });

  it('the simulator drives the real reader: a burst is a scan, typing is not', async () => {
    const fast = await call('POST', `/stations/${tillId}/scan/simulate`, {
      cookie: receptionCookie,
      payload: { code: 'T1-01J8ZQ4F7K', mode: 'hid', interCharDelayMs: 0 },
    });
    expect(fast.statusCode).toBe(200);
    expect(fast.body.recognised).toBe(true);

    const slow = await call('POST', `/stations/${tillId}/scan/simulate`, {
      cookie: receptionCookie,
      // 200 ms per key is a person at a keyboard, four times the threshold.
      payload: { code: 'T1-01J8ZQ4F7K', mode: 'hid', interCharDelayMs: 200 },
    });
    expect(slow.statusCode).toBe(422);
    expect((slow.body.error as { code: string }).code).toBe('SCAN_NOT_RECOGNISED');

    // And the CDC path, where a record may arrive with no terminator at all.
    const serial = await call('POST', `/stations/${tillId}/scan/simulate`, {
      cookie: receptionCookie,
      payload: { code: 'T1-01J8ZQ4F7K', mode: 'serial', withSuffix: false, codeId: ']Q1' },
    });
    expect(serial.statusCode).toBe(200);
    expect(serial.body.mode).toBe('serial');
  });

  it('the counter button may not be Enter', async () => {
    const enter = await call('POST', `/stations/${tillId}/button`, {
      cookie: receptionCookie,
      payload: { key: 'Enter' },
    });
    expect(enter.statusCode).toBe(400);
    expect((enter.body.error as { code: string }).code).toBe('BUTTON_KEY_NOT_ALLOWED');

    const f9 = await call('POST', `/stations/${tillId}/button`, {
      cookie: receptionCookie,
      payload: { key: 'F9' },
    });
    expect(f9.statusCode).toBe(200);
    expect(f9.body.pressed).toBe(true);
  });

  it('a badge can be presented at a LOCKED till, and says what it did', async () => {
    await call('POST', '/auth/lock', { cookie: receptionCookie });
    const res = await call('POST', '/auth/badge', {
      cookie: receptionCookie,
      payload: { value: 'BADGE-0001', source: 'keyboard' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.outcome).toBe('unhandled');
    expect(String(res.body.message)).toMatch(/not linked to accounts/i);

    // The value reached the scanning service and left a fingerprint behind —
    // and the badge itself is nowhere on the row.
    const [row] = await ctx.db
      .select()
      .from(stationEvent)
      .where(and(eq(stationEvent.stationId, tillId), eq(stationEvent.kind, 'scan')))
      .orderBy(desc(stationEvent.receivedAt))
      .limit(1);
    expect(JSON.stringify(row)).not.toContain('BADGE-0001');

    await _resetThrottle(ctx.db);
    await call('POST', '/auth/unlock', {
      cookie: receptionCookie,
      payload: { password: RECEPTION.password },
    });
  });

  it('a till may not scan into another branch’s station', async () => {
    const other = (await ctx.db.select().from(station)).find((s) => s.id !== tillId)!;
    const res = await call('POST', `/stations/${other.id}/scan`, {
      cookie: receptionCookie,
      payload: { code: 'T1-01J8ZQ4F7K' },
    });
    // Reception is not standing there, so it needs the fleet's read permission
    // at that station's branch — which reception does not hold.
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('the Console’s Simulators panel reaches the scanning service (S2-06)', () => {
  /**
   * The seam this sprint keeps failing at, closed from both ends.
   *
   * `apps/console/.../SimulatorPanel.tsx` sends `scanner.scan` and
   * `button.press` to `POST /boxes/:id/simulate`, which queues them as one
   * `simulate` box command; the agent answered `SIMULATOR_NOT_BUILT` for both,
   * so the Scan button on that panel was a control wired to nothing. These
   * cases drive the REAL route and then run the REAL agent, which is the only
   * arrangement that can tell the difference.
   */
  it('a queued scanner.scan runs on the box and lands on the station tape', async () => {
    const queued = await call('POST', `/boxes/${boxId}/simulate`, {
      cookie: adminCookie,
      payload: {
        action: 'scanner.scan',
        input: { code: 'T1-SIMULATED-0001', source: 'simulator' },
      },
      headers: { 'x-oto-action-id': 'sim-scan-0001' },
    });
    expect(queued.statusCode).toBe(200);

    const ran = await agent.runPendingCommands();
    expect(ran).toBeGreaterThan(0);

    const [row] = await ctx.db
      .select()
      .from(boxCommand)
      .where(eq(boxCommand.id, String(queued.body.commandId)));
    expect(row!.state).toBe('succeeded');
    const result = row!.result as Record<string, unknown>;
    expect(result.outcome).toBe('unhandled');
    expect(result.codeFingerprint).toMatch(/^[0-9a-f]{16}$/);
    // The command row is stored and rendered in the Console's history, so the
    // code must not be in the answer either.
    expect(JSON.stringify(result)).not.toContain('SIMULATED-0001');

    const [event] = await ctx.db
      .select()
      .from(stationEvent)
      .where(and(eq(stationEvent.kind, 'scan'), eq(stationEvent.actionId, 'sim-scan-0001')))
      .limit(1);
    expect(event).toBeTruthy();
    expect((event!.payload as Record<string, unknown>).source).toBe('simulator');
    // The tape's own `source` is the SCREEN vocabulary, and a scanner on the
    // box — simulated or not — is `box`.
    expect(event!.source).toBe('box');
  });

  it('the counter button is refused Enter by the box, not just by the panel', async () => {
    const queued = await call('POST', `/boxes/${boxId}/simulate`, {
      cookie: adminCookie,
      payload: { action: 'button.press', press: { key: 'Enter' } },
    });
    expect(queued.statusCode).toBe(200);
    await agent.runPendingCommands();
    const [row] = await ctx.db
      .select()
      .from(boxCommand)
      .where(eq(boxCommand.id, String(queued.body.commandId)));
    expect(row!.state).toBe('failed');
    expect(row!.errorCode).toBe('BUTTON_KEY_NOT_ALLOWED');
  });

  it('a badge may not travel through the command queue at all', async () => {
    const refused = await call('POST', `/boxes/${boxId}/simulate`, {
      cookie: adminCookie,
      payload: { action: 'badge.present', stationId: tillId, badge: 'BADGE-0002' },
    });
    // `edge.box_command.payload` is stored and shown; a badge is a credential.
    // It has its own door — `POST /auth/badge` — which stores nothing.
    expect(refused.statusCode).toBe(409);
    expect((refused.body.error as { code: string }).code).toBe('SIMULATOR_ACTION_CARRIES_SECRET');
  });
});

describe('the command vocabulary agrees across the copies it has to (S2-06)', () => {
  it('the agent understands exactly the kinds the database accepts', () => {
    /**
     * `edge.box_command.kind` is a CHECK constraint, and the same list lives in
     * the schema, in `@oto/box-agent` and in the Console. A kind the database
     * accepts and the agent does not understand is a command answered
     * `UNKNOWN_COMMAND`, which is survivable; a kind the Console offers and the
     * database refuses is a 500 on a button press. This test is in the api's
     * suite because it is the one place both copies can be imported.
     */
    expect([...AGENT_COMMAND_KINDS].sort()).toEqual([...DB_COMMAND_KINDS].sort());
  });
});
