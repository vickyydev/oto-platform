import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  OfflineAuth,
  encodeStaffToken,
  type OfflineAuthSnapshot,
  type OfflineStaffRecord,
  type OfflineThrottle,
  type OfflineUnlockResult,
  type StaffSigningKey,
  type SqlBoxStore,
} from '@oto/box-agent';
import { verify as verifyArgon } from '@node-rs/argon2';
import { newId, STAFF_OFFLINE_SIGN_IN_DAYS } from '@oto/shared';
import {
  authThrottle,
  session as sessionTable,
  signingKey,
  staffToken,
  station,
  type Db,
} from '@oto/db';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { boxStoreFor } from '../lib/box-store';
import { parseStaffTokenKey, staffTokenKid } from '../lib/staff-token-key';
import { audit } from './audit';
import { throttleClear, throttleFail } from './auth';
import type { Exec } from './tx';

/**
 * The signed staff token, minted (S2-06).
 *
 * The verifier lives in `@oto/box-agent` because it has to run on a box with
 * no internet; this file is the other half — the private key, the row that
 * makes a token revocable, and the two questions the cache bundle answers from
 * it. Both ends import ONE codec (`encodeStaffToken` / `verifyStaffToken`), so
 * there is no second description of the format to drift from.
 *
 * **Where the key lives.** `STAFF_TOKEN_PRIVATE_KEY`, an Ed25519 PKCS#8 PEM,
 * in the environment and nowhere else. Its public half is published to
 * `core.signing_key` at boot, travels to every box in its config bundle, and
 * is the only half a box ever holds — so a Pi carried out of a storeroom can
 * CHECK tokens and cannot mint them.
 *
 * **Why the key is not generated when it is missing.** A key minted at boot
 * would differ between instances and between restarts, and every token
 * outstanding would stop verifying the moment somebody deployed — including
 * on a till that has been offline since the morning, which is the exact
 * situation the token exists for. So an unset variable means the mint refuses
 * with 503 and says what to set, the same contract `HANDOFF_SIGNING_KEY` has.
 */

export interface StaffTokenSettings {
  privateKeyPem: string;
  publicKeyPem: string;
  /** Derived from the public half, so the same key always gets the same id. */
  kid: string;
  ttlS: number;
  /** Whether a recognised person may unlock offline with no live token. */
  offlineSignIn: boolean;
}

/** Sixteen hours. The reasoning is in `@oto/shared/staff-token`. */
const DEFAULT_TTL_S = 16 * 60 * 60;

const settingsCache = new WeakMap<object, StaffTokenSettings | null>();

export function staffTokenSettings(env: Env): StaffTokenSettings | null {
  const key = env as unknown as object;
  if (settingsCache.has(key)) return settingsCache.get(key) ?? null;
  const raw = env.STAFF_TOKEN_PRIVATE_KEY?.trim();
  if (!raw) {
    settingsCache.set(key, null);
    return null;
  }
  const { privateKeyPem, publicKeyPem } = parseStaffTokenKey(raw);
  const settings: StaffTokenSettings = {
    privateKeyPem,
    publicKeyPem,
    kid: staffTokenKid(publicKeyPem),
    ttlS: env.STAFF_TOKEN_TTL_S ?? DEFAULT_TTL_S,
    offlineSignIn: env.STAFF_OFFLINE_SIGN_IN,
  };
  settingsCache.set(key, settings);
  return settings;
}

function requireSettings(env: Env): StaffTokenSettings {
  const settings = staffTokenSettings(env);
  if (!settings) {
    throw new AppError(
      503,
      'STAFF_TOKEN_UNAVAILABLE',
      'This deployment has no staff-token key: set STAFF_TOKEN_PRIVATE_KEY to an ed25519 private key in PKCS#8 PEM. Until it is set, a till can only unlock with the internet.',
    );
  }
  return settings;
}

/**
 * Publish the public half so every box gets it in its config bundle.
 *
 * Idempotent on `(purpose, kid)`, so a redeploy with the same key writes
 * nothing and a redeploy with a NEW key adds a row beside the old one rather
 * than replacing it — which is what a rotation needs: the old key must keep
 * verifying until the last token minted under it has expired. Retiring it is
 * then a deliberate act, not a side effect of a deploy.
 */
export async function publishStaffTokenKey(exec: Exec, env: Env): Promise<string | null> {
  const settings = staffTokenSettings(env);
  if (!settings) return null;
  await exec
    .insert(signingKey)
    .values({
      id: newId(),
      operatorId: null,
      purpose: 'staff_token',
      kid: settings.kid,
      algorithm: 'ed25519',
      publicKey: settings.publicKeyPem,
      active: true,
    })
    .onConflictDoNothing({ target: [signingKey.purpose, signingKey.kid] });
  return settings.kid;
}

// --- Minting ----------------------------------------------------------------

export interface MintedStaffToken {
  token: string;
  jti: string;
  expiresAt: Date;
  kid: string;
}

export interface MintStaffTokenInput {
  accountId: string;
  sessionId: string;
  operatorId: string;
  branchId: string;
  stationId: string;
  requestId?: string;
}

/**
 * Mint the token for one shift at one station.
 *
 * Called from the station pick, which is the moment the ticket names and the
 * only moment at which all five ids are known and agreed. The box is read from
 * the station rather than taken from the caller: a token is good on the box
 * that will verify it, and letting a request name that box would let a request
 * name a box it is not standing at.
 *
 * Picking a SECOND station ends the first token. Two live tokens for one
 * session would mean a person walking away from Till 1, picking Till 2, and
 * leaving behind a credential that unlocks the till they left — which is the
 * shape of the problem a deny-list exists to solve and should not have to.
 */
export async function mintStaffToken(
  exec: Exec,
  input: MintStaffTokenInput,
  env: Env,
): Promise<MintedStaffToken> {
  const settings = requireSettings(env);

  const [row] = await exec
    .select({ boxId: station.boxId, branchId: station.branchId, name: station.name })
    .from(station)
    .where(eq(station.id, input.stationId))
    .limit(1);
  if (!row) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
  if (!row.boxId) {
    // Not an awkward edge: an offline token is verified BY a box, and a
    // station with no box has none to verify it. Saying so is better than
    // minting a credential nothing can check.
    throw new AppError(
      409,
      'STATION_HAS_NO_BOX',
      `${row.name} is not on a box yet, so there is nothing to check a shift token against`,
    );
  }

  /**
   * The public half is published here as well as at boot, and the reason is
   * an invariant rather than belt and braces: a token minted under a key no
   * box can find verifies nowhere, and the box that would discover it is one
   * with no internet. Publishing inside the same transaction as the mint makes
   * "the key is in `core.signing_key`" true of every token that exists.
   */
  await publishStaffTokenKey(exec, env);

  // Any token this session still holds is done: one session, one station, one
  // live token.
  await revokeStaffTokens(exec, { sessionId: input.sessionId }, 'station_changed');

  const now = new Date();
  const expiresAt = new Date(now.getTime() + settings.ttlS * 1000);
  const jti = newId();
  const token = encodeStaffToken(
    {
      v: 1,
      jti,
      sub: input.accountId,
      aud: row.branchId,
      sid: input.sessionId,
      sta: input.stationId,
      box: row.boxId,
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
    },
    { kid: settings.kid, privateKeyPem: settings.privateKeyPem },
  );

  await exec.insert(staffToken).values({
    jti,
    operatorId: input.operatorId,
    branchId: row.branchId,
    accountId: input.accountId,
    sessionId: input.sessionId,
    stationId: input.stationId,
    boxId: row.boxId,
    kid: settings.kid,
    issuedAt: now,
    expiresAt,
  });

  await audit.record(exec, {
    actorAccountId: input.accountId,
    operatorId: input.operatorId,
    branchId: row.branchId,
    action: 'staff_token.mint',
    entityType: 'staff_token',
    entityId: jti,
    // The claims, never the token: the row says what was minted, and the
    // string itself is a credential that would then be in the audit log.
    after: { stationId: input.stationId, boxId: row.boxId, expiresAt: expiresAt.toISOString() },
    requestId: input.requestId,
  });

  return { token, jti, expiresAt, kid: settings.kid };
}

// --- Revoking ---------------------------------------------------------------

export type StaffTokenScope =
  | { jti: string }
  | { sessionId: string }
  | { accountId: string }
  /** Every token for a station — a till taken out of service. */
  | { stationId: string };

/**
 * End tokens, by whatever names them.
 *
 * Only the ones still inside their own expiry are touched: a token past `exp`
 * is refused on the timestamp alone, and marking it revoked would add it to a
 * deny-list that is deliberately bounded by expiry. Returns the jtis that
 * moved, so a caller can say how many shifts it just ended.
 */
export async function revokeStaffTokens(
  exec: Exec,
  scope: StaffTokenScope,
  reason: 'sign_out' | 'account_revoked' | 'station_changed' | 'admin',
  byAccountId?: string | null,
): Promise<string[]> {
  const where =
    'jti' in scope
      ? eq(staffToken.jti, scope.jti)
      : 'sessionId' in scope
        ? eq(staffToken.sessionId, scope.sessionId)
        : 'accountId' in scope
          ? eq(staffToken.accountId, scope.accountId)
          : eq(staffToken.stationId, scope.stationId);

  const ended = await exec
    .update(staffToken)
    .set({
      revokedAt: new Date(),
      revokedReason: reason,
      revokedByAccountId: byAccountId ?? null,
    })
    .where(and(where, isNull(staffToken.revokedAt), gt(staffToken.expiresAt, sql`now()`)))
    .returning({ jti: staffToken.jti });
  return ended.map((r) => r.jti);
}

// --- What the cache bundle asks ---------------------------------------------

/**
 * The jtis a box must refuse: revoked, and not yet expired.
 *
 * Bounded by expiry rather than by history — past `exp` the token says it is
 * dead on its own, and keeping it on the list would make the list grow for
 * ever to repeat that.
 */
export async function revokedStaffTokenIds(db: Db, operatorId: string): Promise<string[]> {
  const rows = await db
    .select({ jti: staffToken.jti })
    .from(staffToken)
    .where(
      and(
        eq(staffToken.operatorId, operatorId),
        isNotNull(staffToken.revokedAt),
        gt(staffToken.expiresAt, sql`now()`),
      ),
    );
  return rows.map((r) => r.jti);
}

/**
 * When this box last minted a token for each account — the "seen here" half of
 * the 30-day offline sign-in.
 *
 * Answered from the same row the revocation lives on, so recognition and
 * revocation cannot disagree, which they could if one lived in a cache and the
 * other in a table.
 */
export async function lastTokenByAccountOnBox(
  db: Db,
  boxId: string,
): Promise<Map<string, Date>> {
  const rows = await db
    .select({ accountId: staffToken.accountId, issuedAt: staffToken.issuedAt })
    .from(staffToken)
    .where(
      and(
        eq(staffToken.boxId, boxId),
        // Bounded by the window the answer is FOR. Anything older than thirty
        // days cannot make somebody recognised, so reading it would be sorting
        // a year of picks on every cache pull to reach the same conclusion.
        // `staff_token_box_issued_idx` is exactly this query.
        gt(
          staffToken.issuedAt,
          sql`now() - ${`${STAFF_OFFLINE_SIGN_IN_DAYS} days`}::interval`,
        ),
      ),
    )
    .orderBy(desc(staffToken.issuedAt));
  const seen = new Map<string, Date>();
  for (const row of rows) if (!seen.has(row.accountId)) seen.set(row.accountId, row.issuedAt);
  return seen;
}

// --- Offline unlock ---------------------------------------------------------

/**
 * The throttle the offline path shares with the online one.
 *
 * Same buckets, same keys, so five wrong guesses lock out whichever door they
 * were made at — and an attacker at a locked till cannot get five more tries
 * by switching from `POST /auth/unlock` to this one.
 */
async function cooldownLeft(db: Db, keys: string[]): Promise<number> {
  const rows = await db
    .select({ lockedUntil: authThrottle.lockedUntil })
    .from(authThrottle)
    .where(inArray(authThrottle.key, keys));
  const now = Date.now();
  let left = 0;
  for (const row of rows) {
    if (!row.lockedUntil) continue;
    const seconds = Math.ceil((row.lockedUntil.getTime() - now) / 1000);
    if (seconds > left) left = seconds;
  }
  return left;
}

function sharedThrottle(
  db: Db,
  keys: string[],
  env: Env,
  onLockout: () => Promise<void>,
): OfflineThrottle {
  return {
    check: () => cooldownLeft(db, keys),
    async fail() {
      const locked = await throttleFail(db, keys, env.AUTH_MAX_FAILURES, env.AUTH_COOLDOWN_SECONDS);
      if (locked.length > 0) await onLockout();
      // No `attemptsLeft`: the count is shared with the online unlock and the
      // honest answer to "how many tries are left" is one this side does not
      // have. The till says "password is incorrect" and nothing more, which is
      // also what the online path says.
      return {
        locked: locked.length > 0,
        retryAfterS: locked.length > 0 ? env.AUTH_COOLDOWN_SECONDS : 0,
      };
    },
    async clear() {
      await throttleClear(db, keys);
    },
  };
}

/**
 * What the box has cached about who may work at it.
 *
 * Read from the BOX's store, never from the tables beside it — that is the
 * whole claim being tested. The one thing taken from outside is the public
 * signing key, and only when this process is not running that box's agent: a
 * box holds its keys in the config bundle it already has, and an api instance
 * standing in for a box it hosts is reading its own copy of the same thing.
 * A Raspberry Pi never takes that branch, because on a Pi the agent IS the
 * process answering.
 */
async function snapshotForBox(
  db: Db,
  store: SqlBoxStore,
  boxId: string,
): Promise<OfflineAuthSnapshot | null> {
  const staffBundle = await store.readBundle(boxId, 'staff');
  if (!staffBundle) return null;
  const denyBundle = await store.readBundle(boxId, 'deny_list');
  const items = (staffBundle.payload as { items?: unknown[] }).items ?? [];
  const deny =
    ((denyBundle?.payload as { items?: unknown[] })?.items?.[0] as OfflineAuthSnapshot['deny']) ??
    null;

  /**
   * The public halves, read from `core.signing_key`.
   *
   * On a Raspberry Pi these come from the config bundle the box is already
   * holding — which is where these same rows travel — and no database is
   * involved. Here the api is standing in for a box it hosts, and this is the
   * one part of the check that is not literally read off the box's own store:
   * `SqlBoxStore` keeps its bundles in memory on Postgres because the `edge`
   * schema has no `box_cache` table yet, so a config bundle does not survive a
   * restart to be read from. That gap is worth closing and is recorded rather
   * than papered over; it does not change what is being proved here, which is
   * that the STAFF LIST and the DENY-LIST — the parts that say who may come in
   * — are read from the box and from nowhere else.
   */
  const keys: StaffSigningKey[] = await db
    .select({
      purpose: signingKey.purpose,
      kid: signingKey.kid,
      algorithm: signingKey.algorithm,
      publicKey: signingKey.publicKey,
    })
    .from(signingKey)
    .where(and(eq(signingKey.purpose, 'staff_token'), eq(signingKey.active, true)));

  return {
    keys,
    staff: items as OfflineStaffRecord[],
    deny,
    cachedAt: staffBundle.appliedAt,
  };
}

export interface OfflineUnlockInput {
  sessionId: string;
  accountId: string;
  operatorId: string;
  branchId: string | null;
  stationId: string;
  token?: string | null;
  password: string;
  requestId?: string;
}

export interface OfflineUnlockView {
  locked: false;
  /** `offline_token` or `offline_sign_in` — what the audit row records. */
  authMethod: string;
  /** When the box last took its copy of the staff list. The banner reads it. */
  cachedAt: string | null;
  /** How old that copy is, in seconds. */
  cacheAgeSeconds: number | null;
}

/**
 * Unlock a locked till against the BOX's cache, with the cloud unreachable.
 *
 * This is the api standing in for the box it hosts: it verifies the token with
 * the box's own verifier, against the box's own cached staff list and
 * deny-list, and touches no `core.account` row to decide anything. What it
 * does afterwards — clearing `locked_at` and writing the audit row — is the
 * cloud's own bookkeeping, and is the one part a Raspberry Pi would do
 * differently: there it is a local unlock plus a fact in the outbox, and that
 * local surface arrives with the box's own HTTP server. Until then this route
 * proves the half that has to be right — that the CHECK needs nothing but what
 * is on the box.
 */
export async function offlineUnlock(
  db: Db,
  env: Env,
  input: OfflineUnlockInput,
): Promise<OfflineUnlockView> {
  const [stationRow] = await db
    .select({ boxId: station.boxId, branchId: station.branchId, name: station.name })
    .from(station)
    .where(eq(station.id, input.stationId))
    .limit(1);
  if (!stationRow?.boxId) {
    throw new AppError(
      409,
      'STATION_HAS_NO_BOX',
      'This station is not on a box, so there is nothing holding an offline copy of your details',
    );
  }

  const store = boxStoreFor(db);
  const keys = [`unlock:${input.sessionId}`, `unlock-account:${input.accountId}`];
  const auth = new OfflineAuth({
    boxId: stationRow.boxId,
    branchId: stationRow.branchId,
    snapshot: () => snapshotForBox(db, store, stationRow.boxId!),
    verifyPassword: (hash, password) => verifyArgon(hash, password),
    allowOfflineSignIn: env.STAFF_OFFLINE_SIGN_IN,
    maxFailures: env.AUTH_MAX_FAILURES,
    cooldownS: env.AUTH_COOLDOWN_SECONDS,
    throttle: sharedThrottle(db, keys, env, async () => {
      await audit.record(db, {
        actorAccountId: input.accountId,
        operatorId: input.operatorId,
        branchId: input.branchId,
        action: 'auth.locked_out',
        entityType: 'session',
        entityId: input.sessionId,
        after: { bucket: 'unlock', offline: true, cooldownSeconds: env.AUTH_COOLDOWN_SECONDS },
        requestId: input.requestId,
      });
    }),
  });

  const result: OfflineUnlockResult = await auth.unlock({
    token: input.token ?? null,
    password: input.password,
    accountId: input.accountId,
  });

  if (!result.ok) {
    await audit.record(db, {
      actorAccountId: input.accountId,
      operatorId: input.operatorId,
      branchId: input.branchId,
      action: 'session.unlock_failed',
      entityType: 'session',
      entityId: input.sessionId,
      after: { authMethod: 'offline_token', refusal: result.refusal },
      requestId: input.requestId,
    });
    throw new AppError(
      result.refusal === 'OFFLINE_LOCKED_OUT' ? 429 : 401,
      result.refusal,
      result.message,
      result.retryAfterS ? { retryAfterSeconds: result.retryAfterS } : undefined,
    );
  }

  if (result.accountId !== input.accountId) {
    // The token named somebody other than the person whose session is locked.
    // Refused rather than honoured: unlocking Mali's till with Nok's token
    // would put Mali's name on everything Nok then did.
    throw new AppError(
      403,
      'STAFF_TOKEN_WRONG_ACCOUNT',
      'That shift token belongs to another account — sign out and sign in instead',
    );
  }
  if (result.claims && result.claims.sta !== input.stationId) {
    throw new AppError(
      403,
      'STAFF_TOKEN_WRONG_AUDIENCE',
      'That shift token was issued at another station',
    );
  }

  await db
    .update(sessionTable)
    .set({ lockedAt: null, lastSeenAt: new Date() })
    .where(eq(sessionTable.id, input.sessionId));

  await audit.record(db, {
    actorAccountId: input.accountId,
    operatorId: input.operatorId,
    branchId: input.branchId,
    action: 'session.unlock',
    entityType: 'session',
    entityId: input.sessionId,
    after: {
      authMethod: result.method,
      stationId: input.stationId,
      boxId: stationRow.boxId,
      jti: result.claims?.jti ?? null,
      cachedAt: result.cachedAt,
    },
    requestId: input.requestId,
  });

  const cachedAt = result.cachedAt;
  return {
    locked: false,
    authMethod: result.method,
    cachedAt,
    cacheAgeSeconds: cachedAt
      ? Math.max(0, Math.round((Date.now() - Date.parse(cachedAt)) / 1000))
      : null,
  };
}

/** Live tokens for one account, newest first — what the Console's panel shows. */
export async function listStaffTokens(
  db: Db,
  opts: { operatorId: string; accountId?: string; boxId?: string; limit?: number },
): Promise<
  Array<{
    jti: string;
    accountId: string;
    stationId: string;
    boxId: string;
    issuedAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
    revokedReason: string | null;
  }>
> {
  const filters = [eq(staffToken.operatorId, opts.operatorId)];
  if (opts.accountId) filters.push(eq(staffToken.accountId, opts.accountId));
  if (opts.boxId) filters.push(eq(staffToken.boxId, opts.boxId));
  return db
    .select({
      jti: staffToken.jti,
      accountId: staffToken.accountId,
      stationId: staffToken.stationId,
      boxId: staffToken.boxId,
      issuedAt: staffToken.issuedAt,
      expiresAt: staffToken.expiresAt,
      revokedAt: staffToken.revokedAt,
      revokedReason: staffToken.revokedReason,
    })
    .from(staffToken)
    .where(and(...filters))
    .orderBy(desc(staffToken.issuedAt))
    .limit(opts.limit ?? 50);
}
