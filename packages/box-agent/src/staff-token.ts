import { createPublicKey, sign, timingSafeEqual, verify } from 'node:crypto';

/**
 * The signed staff token, as a box sees it (S2-06).
 *
 * The cloud mints one when somebody picks a station; this file is everything
 * that happens to it afterwards, on a machine that may not have spoken to the
 * cloud since the morning. It lives in `@oto/box-agent` rather than in the api
 * because the verifier is the half that has to run with no internet — and
 * because the api can import this package, so one implementation signs and
 * verifies rather than two agreeing by memory.
 *
 * **Why the box holds a public key and not a secret.** A Raspberry Pi in a
 * mall storeroom can be unplugged and carried out (OWNER_DIRECTION: box
 * theft). With a shared secret, whoever holds the disk can MINT tokens — every
 * station, every account, for as long as the secret lives. With Ed25519 the
 * box holds only the public half, in its config bundle, so the worst a stolen
 * disk yields is the ability to CHECK tokens, which is a thing anybody may do.
 * The private half stays in `STAFF_TOKEN_PRIVATE_KEY` on the api and never
 * touches the database: `core.signing_key` stores public halves and its column
 * is called `public_key` so that writing one there would have to be deliberate.
 *
 * **What a stolen token can do, and for how long.** It is a bearer credential
 * for exactly one thing: unlocking one station, on one box, at one branch, by
 * somebody who ALSO knows the account's password. It carries no permissions —
 * those come from the cache bundle and the cloud's own session — and it cannot
 * open a sale, a refund or a drawer on its own. Its blast radius is its
 * expiry, sixteen hours by default, and the deny-list closes it earlier
 * wherever the box can still hear the cloud.
 *
 * **What happens when access is revoked while the box is offline.** Nothing,
 * until the box next pulls its cache — and that is a property of offline
 * working rather than a defect in this file. The honest statement is the one
 * the code makes: a revocation is effective on a box from the moment the box
 * learns of it, and until then the token's own expiry is the only bound. That
 * is why the expiry is hours rather than days, why the deny-list is pulled
 * with every cache refresh rather than on a schedule of its own, and why a
 * box that has not pulled for longer than the token lifetime is visibly stale
 * on the Console's Health page.
 *
 * **What happens when the box cannot check revocation at all.** It refuses.
 * Holding a stale deny-list and holding NO deny-list are different states and
 * were once treated as one: a box that had applied the staff list without the
 * deny-list beside it admitted every token that verified, including one a
 * manager had ended that morning, and said nothing about having skipped the
 * check. An absent deny-list is now its own refusal —
 * `STAFF_TOKEN_REVOCATION_UNKNOWN` here and `OFFLINE_REVOCATION_UNKNOWN` in
 * the unlock — so the invariant is the one the name claims: a token this file
 * admits has been checked against a deny-list the box actually holds. The cost
 * is a till that cannot unlock offline until its next complete pull; the
 * alternative was a dismissed employee working the till for the life of their
 * token with nothing on the box aware of it. The two ways that state used to
 * be reachable are closed at their sources as well — `syncCache` in `agent.ts`
 * will not apply a staff list without the deny-list of the same pull, and
 * `GET /box/v1/cache` serves the two together.
 *
 * **Working past midnight.** The expiry is a duration from the pick, not a
 * wall-clock hour, so a shift that starts at 16:00 and ends at 02:00 is inside
 * one token. What sixteen hours does NOT survive is a person who picked a
 * station at 09:00, left the till offline, and came back the following
 * morning: that token is dead, the till says "shift token expired, connect to
 * sign in", and the fix is one minute of internet. The alternative — a token
 * long enough that this never happens — is a credential sitting on a disk for
 * days, which is the failure with no floor.
 */

// --- Mirrored from `@oto/shared/staff-token` --------------------------------
//
// A copy rather than an import, like `contract.ts`, and for a reason that no
// longer holds: it was written before this package depended on `@oto/shared`.
// It does now, and its tests load `@oto/shared` as the shipped code does
// (`booth.ts` imports values from it), so this block could become a re-export.
// Until it does, `test/contract-drift.test.ts` imports both copies by relative
// path and asserts they match item for item.

/** Bumped when a claim changes MEANING, not when one is added. */
export const STAFF_TOKEN_SCHEMA_VERSION = 1;

/** Ed25519, matching `core.signing_key.algorithm`. */
export const STAFF_TOKEN_ALGORITHM = 'ed25519';

/** The ticket's default: a person the box has seen this recently may sign in cold. */
export const STAFF_OFFLINE_SIGN_IN_DAYS = 30;

/** Why an offline unlock was refused. One code per distinguishable cause. */
export const STAFF_TOKEN_REFUSALS = {
  EXPIRED: 'STAFF_TOKEN_EXPIRED',
  INVALID: 'STAFF_TOKEN_INVALID',
  UNKNOWN_KEY: 'STAFF_TOKEN_UNKNOWN_KEY',
  REVOKED: 'STAFF_TOKEN_REVOKED',
  /**
   * The box holds no deny-list, so it cannot say whether this token was
   * revoked. Distinct from `REVOKED` on purpose: one is a decision, the other
   * is the absence of one, and only the first should ever be reported as "a
   * manager ended this shift".
   */
  REVOCATION_UNKNOWN: 'STAFF_TOKEN_REVOCATION_UNKNOWN',
  WRONG_AUDIENCE: 'STAFF_TOKEN_WRONG_AUDIENCE',
  SCHEMA_TOO_NEW: 'STAFF_TOKEN_SCHEMA_TOO_NEW',
} as const;
export type StaffTokenRefusal =
  (typeof STAFF_TOKEN_REFUSALS)[keyof typeof STAFF_TOKEN_REFUSALS];

/** The claims, as `StaffTokenClaimsSchema` in `@oto/shared` validates them. */
export interface StaffTokenClaims {
  /** Schema version. A box refusing a version it cannot read is a clear failure. */
  v: number;
  /** The token's id, and the value a revocation names. */
  jti: string;
  /** The account. */
  sub: string;
  /** The branch this token is good at. */
  aud: string;
  /** The platform session it was minted from, so signing out revokes it. */
  sid: string;
  /** The station picked. */
  sta: string;
  /** The box that station sits on. */
  box: string;
  iat: number;
  exp: number;
}

/** The deny-list as it travels in the cache bundle's `deny_list` scope. */
export interface StaffDenyList {
  revokedAccountIds: string[];
  revokedTokenIds: string[];
}

// --- The wire format --------------------------------------------------------

/**
 * `base64url(header).base64url(claims).base64url(signature)`.
 *
 * Shaped like a JWS and deliberately NOT one: there is no `alg` negotiation
 * and no `none`, the algorithm is a constant this file checks, and the header
 * carries the schema version so a box too old to read a token says so instead
 * of guessing. The three-part shape is kept because it is what everything that
 * handles tokens already expects — a header, a body, a signature over both.
 */
export interface StaffTokenHeader {
  /** Always `STAFF_TOKEN_SCHEMA_VERSION` at mint time. */
  v: number;
  /** Always `STAFF_TOKEN_ALGORITHM`. A token naming another is refused. */
  alg: string;
  /** Which `core.signing_key` row verifies it. */
  kid: string;
}

export interface StaffSigningKey {
  purpose: string;
  kid: string;
  algorithm: string;
  /** SPKI PEM. The PUBLIC half — this package never sees the other one. */
  publicKey: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

/**
 * Sign a claim set.
 *
 * Exported from the BOX package although only the api calls it, so that the
 * bytes that are signed and the bytes that are verified are produced by one
 * function. The seam this ticket sits on has failed three times this sprint by
 * having two sides describe one format; there is no second description here to
 * drift from.
 */
export function encodeStaffToken(
  claims: StaffTokenClaims,
  key: { kid: string; privateKeyPem: string },
): string {
  const header: StaffTokenHeader = {
    v: STAFF_TOKEN_SCHEMA_VERSION,
    alg: STAFF_TOKEN_ALGORITHM,
    kid: key.kid,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign(null, Buffer.from(signingInput, 'ascii'), key.privateKeyPem);
  return `${signingInput}.${signature.toString('base64url')}`;
}

export interface DecodedStaffToken {
  header: StaffTokenHeader;
  claims: StaffTokenClaims;
  signingInput: string;
  signature: Buffer;
}

/**
 * Split a token and parse its two documents. **Nothing here is trusted**: the
 * claims are attacker-controlled until `verifyStaffToken` has checked the
 * signature, and this function is exported only so a caller can read the `kid`
 * in order to find the key to check it with.
 */
export function decodeStaffToken(token: string): DecodedStaffToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawClaims, rawSig] = parts as [string, string, string];
  try {
    const header = JSON.parse(fromB64url(rawHeader).toString('utf8')) as StaffTokenHeader;
    const claims = JSON.parse(fromB64url(rawClaims).toString('utf8')) as StaffTokenClaims;
    if (typeof header?.kid !== 'string' || typeof claims?.jti !== 'string') return null;
    return {
      header,
      claims,
      signingInput: `${rawHeader}.${rawClaims}`,
      signature: fromB64url(rawSig),
    };
  } catch {
    // A token that is not two JSON documents is a refusal, not a crash at the
    // lock screen of a till with a queue in front of it.
    return null;
  }
}

export interface StaffTokenVerifyOptions {
  /** The public halves from the config bundle. Usually one; two during a rotation. */
  keys: readonly StaffSigningKey[];
  /** This box. A token minted for another box is refused however well it verifies. */
  boxId: string;
  /** This box's branch — the token's `aud`. */
  branchId: string;
  /**
   * The deny-list from the cache bundle.
   *
   * Absent or null means **this box cannot check revocation**, which is not
   * the same as nothing being revoked, and is refused rather than waved
   * through. A list that is merely old is a different thing and is accepted:
   * its age is on the unlock's audit row and under the till's banner.
   */
  deny?: StaffDenyList | null;
  now?: Date;
  /** Clock tolerance, in seconds, for `iat` in the future. */
  leewayS?: number;
}

export type StaffTokenVerification =
  | { ok: true; claims: StaffTokenClaims; expiresAt: Date }
  | { ok: false; refusal: StaffTokenRefusal };

/**
 * Check a token against this box, in the order that makes a refusal cheapest
 * and most honest: shape, version, key, signature, audience, expiry,
 * revocation. The signature is checked BEFORE anything the claims say, because
 * until it has been, the claims are just a string somebody handed us.
 */
export function verifyStaffToken(
  token: string,
  options: StaffTokenVerifyOptions,
): StaffTokenVerification {
  const decoded = decodeStaffToken(token);
  if (!decoded) return { ok: false, refusal: STAFF_TOKEN_REFUSALS.INVALID };
  const { header, claims } = decoded;

  if (header.v > STAFF_TOKEN_SCHEMA_VERSION) {
    return { ok: false, refusal: STAFF_TOKEN_REFUSALS.SCHEMA_TOO_NEW };
  }
  if (header.alg !== STAFF_TOKEN_ALGORITHM) {
    // Naming the algorithm in the header and then accepting whatever it says
    // is the oldest failure in token handling. It is a fixed constant here and
    // the header's copy is only ever compared with it.
    return { ok: false, refusal: STAFF_TOKEN_REFUSALS.INVALID };
  }

  const key = options.keys.find(
    (k) => k.purpose === 'staff_token' && k.kid === header.kid && k.algorithm === header.alg,
  );
  if (!key) return { ok: false, refusal: STAFF_TOKEN_REFUSALS.UNKNOWN_KEY };

  let signatureOk = false;
  try {
    signatureOk = verify(
      null,
      Buffer.from(decoded.signingInput, 'ascii'),
      createPublicKey(key.publicKey),
      decoded.signature,
    );
  } catch {
    // A malformed key in the bundle, or a signature that is not base64url.
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, refusal: STAFF_TOKEN_REFUSALS.INVALID };

  if (claims.box !== options.boxId || claims.aud !== options.branchId) {
    return { ok: false, refusal: STAFF_TOKEN_REFUSALS.WRONG_AUDIENCE };
  }

  const now = options.now ?? new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const leeway = options.leewayS ?? 120;
  // `iat` in the future by more than the leeway is a box whose clock is behind
  // the cloud's, which is the ordinary state of a Pi that has just booted
  // without NTP. Refusing on `exp` alone would let that box unlock; refusing
  // on `iat` with no leeway would stop it unlocking for the first minute.
  if (claims.iat - leeway > nowS) return { ok: false, refusal: STAFF_TOKEN_REFUSALS.EXPIRED };
  if (claims.exp <= nowS) return { ok: false, refusal: STAFF_TOKEN_REFUSALS.EXPIRED };

  // Not being able to check revocation is not the same as nothing being
  // revoked. A box with no deny-list refuses here rather than admitting a
  // token it has no way to have an opinion about.
  const deny = options.deny;
  if (!deny) return { ok: false, refusal: STAFF_TOKEN_REFUSALS.REVOCATION_UNKNOWN };
  if (deny.revokedTokenIds.includes(claims.jti) || deny.revokedAccountIds.includes(claims.sub)) {
    return { ok: false, refusal: STAFF_TOKEN_REFUSALS.REVOKED };
  }

  return { ok: true, claims, expiresAt: new Date(claims.exp * 1000) };
}

// --- Offline unlock ---------------------------------------------------------

/** One person, as the `staff` cache bundle carries them. */
export interface OfflineStaffRecord {
  accountId: string;
  /** argon2id. Never a password; never anything naming the person. */
  passwordHash: string | null;
  status: string;
  mustChangePassword: boolean;
  /**
   * When this box last minted a token for this account, if ever.
   *
   * The cloud computes it from `core.staff_token` for THIS box, so the 30-day
   * offline sign-in question is answerable from cached data alone and the
   * answer cannot disagree with the revocation, which is on the same row.
   */
  lastTokenAt?: string | null;
}

/** What the box has cached about who may work here. */
export interface OfflineAuthSnapshot {
  keys: readonly StaffSigningKey[];
  staff: readonly OfflineStaffRecord[];
  /**
   * The deny-list, or null when this box holds none — an incomplete cache,
   * never "nobody is revoked". `unlock` refuses on null: see the note at the
   * top of this file.
   */
  deny: StaffDenyList | null;
  /** When the cache was applied. What the till's "working offline" banner reads. */
  cachedAt: string | null;
}

/**
 * Where wrong passwords are counted.
 *
 * Injectable because the right answer differs by deployment and neither is a
 * mock of the other. The api passes the SAME Postgres buckets the online
 * unlock uses (`unlock:<session>`, `unlock-account:<account>`), so five wrong
 * guesses lock out whichever path they were made on and an attacker cannot
 * reset the count by switching between them. A Pi has no Postgres and gets the
 * in-memory default below, which is honest about what it is: a counter that a
 * restart clears.
 */
export interface OfflineThrottle {
  /** Seconds of cooldown left for this account, or 0. */
  check(accountId: string): Promise<number>;
  /**
   * Count one wrong password. `attemptsLeft` is optional because a shared
   * counter cannot always say — and a number invented for the sake of the
   * field would be shown to a person as if it were true.
   */
  fail(accountId: string): Promise<{ locked: boolean; retryAfterS: number; attemptsLeft?: number }>;
  clear(accountId: string): Promise<void>;
}

export interface OfflineAuthOptions {
  boxId: string;
  branchId: string;
  /** Reads the cached bundles. Called per attempt: a pull mid-shift must count. */
  snapshot: () => Promise<OfflineAuthSnapshot | null>;
  /** argon2id verification. Injected so this package needs no native dependency. */
  verifyPassword: (hash: string, password: string) => Promise<boolean>;
  now?: () => Date;
  /** Where failures are counted. Defaults to an in-memory bucket per account. */
  throttle?: OfflineThrottle;
  /** Wrong attempts before the cooldown. Same number as the online sign-in. */
  maxFailures?: number;
  cooldownS?: number;
  /**
   * Whether somebody the box has seen in the last 30 days may unlock with the
   * password alone once their token has expired.
   *
   * **Off by default, and that is the acceptance criterion**: an expired token
   * is refused with "shift token expired, connect to sign in". Turning it on
   * trades that for a till that keeps working through a long outage, and the
   * unlock is then recorded as `offline_sign_in` rather than `offline_token`
   * so the two are never confused in the record.
   */
  allowOfflineSignIn?: boolean;
  offlineSignInDays?: number;
}

export const OFFLINE_UNLOCK_REFUSALS = {
  /** The box has never pulled a cache, so it knows nobody. */
  NO_CACHE: 'OFFLINE_NO_CACHE',
  /**
   * The box holds a staff list but no deny-list, so it cannot tell whether
   * anybody's access has been withdrawn.
   *
   * Its own code rather than `NO_CACHE`, because the two send whoever is
   * standing there after different things: `NO_CACHE` is a box that has never
   * pulled, and this is a box whose last pull was incomplete — which is a
   * fault, is reported in the heartbeat as one, and is fixed by a pull rather
   * than by a first sign-in.
   */
  REVOCATION_UNKNOWN: 'OFFLINE_REVOCATION_UNKNOWN',
  /** The token verified, but this box holds no password hash for its account. */
  NOT_CACHED: 'OFFLINE_ACCOUNT_NOT_CACHED',
  /** The account is not `active` in the last bundle this box pulled. */
  INACTIVE: 'OFFLINE_ACCOUNT_INACTIVE',
  WRONG_PASSWORD: 'OFFLINE_WRONG_PASSWORD',
  /** Too many wrong passwords. Same shape as the online cooldown. */
  LOCKED_OUT: 'OFFLINE_LOCKED_OUT',
  /** No usable token and the box has not seen this account recently enough. */
  NOT_RECOGNISED: 'OFFLINE_NOT_RECOGNISED',
  /**
   * The till had no token to present at all — a deployment with no signing
   * key, or a session that never picked a station.
   *
   * Its own code because "expired" would be a lie: saying a shift token ran
   * out when none was ever issued sends whoever is standing there looking for
   * the wrong fix.
   */
  NO_TOKEN: 'OFFLINE_NO_TOKEN',
} as const;
export type OfflineUnlockRefusal =
  | (typeof OFFLINE_UNLOCK_REFUSALS)[keyof typeof OFFLINE_UNLOCK_REFUSALS]
  | StaffTokenRefusal;

/**
 * `ok: true` carries one guarantee beyond the password: the box held a
 * deny-list at the moment of the check and this account and token were not on
 * it. There is no field saying so because there is no other way to reach this
 * branch — an absent deny-list refuses above, which is what makes the
 * statement worth anything. How OLD that list was is a separate question, and
 * `cachedAt` is the answer to it.
 */
export type OfflineUnlockResult =
  | {
      ok: true;
      accountId: string;
      /** `offline_token` when a live token carried it; `offline_sign_in` otherwise. */
      method: 'offline_token' | 'offline_sign_in';
      claims: StaffTokenClaims | null;
      /** What the banner says: how old the cache is, and how this was allowed. */
      cachedAt: string | null;
      mustChangePassword: boolean;
    }
  | {
      ok: false;
      refusal: OfflineUnlockRefusal;
      message: string;
      /** Seconds until another attempt is accepted, when the cooldown is on. */
      retryAfterS?: number;
      /** How many attempts are left before the cooldown. Absent once it is on. */
      attemptsLeft?: number;
    };

interface Bucket {
  failures: number;
  lockedUntil: number;
}

/**
 * The default throttle: one bucket per account, in this process's memory.
 *
 * A locked till with nobody at it is the one place a password can be guessed
 * at all afternoon, so the count has to exist even on a box with nothing else.
 * What it does NOT survive is a restart — which is the same property the
 * platform's own throttle had before it moved into Postgres, and is stated
 * here rather than quietly assumed otherwise.
 */
export function memoryThrottle(options: {
  maxFailures: number;
  cooldownS: number;
  now: () => Date;
}): OfflineThrottle {
  const buckets = new Map<string, Bucket>();
  return {
    async check(accountId) {
      const bucket = buckets.get(accountId);
      if (!bucket) return 0;
      const left = Math.ceil((bucket.lockedUntil - options.now().getTime()) / 1000);
      return left > 0 ? left : 0;
    },
    async fail(accountId) {
      const bucket = buckets.get(accountId) ?? { failures: 0, lockedUntil: 0 };
      bucket.failures += 1;
      if (bucket.failures >= options.maxFailures) {
        bucket.lockedUntil = options.now().getTime() + options.cooldownS * 1000;
        bucket.failures = 0;
        buckets.set(accountId, bucket);
        return { locked: true, attemptsLeft: 0, retryAfterS: options.cooldownS };
      }
      buckets.set(accountId, bucket);
      return {
        locked: false,
        attemptsLeft: options.maxFailures - bucket.failures,
        retryAfterS: 0,
      };
    },
    async clear(accountId) {
      buckets.delete(accountId);
    },
  };
}

/**
 * The offline half of the lock screen.
 *
 * It is a class with state because the throttle is state: a locked till with
 * nobody at it is the one place a password can be guessed at all afternoon,
 * and the count that stops that has to live somewhere the guesser cannot
 * clear. On a Pi that is this object, for the life of the agent process; a
 * restart clears it, which is the same property the online throttle had before
 * it moved into Postgres, and is recorded here rather than claimed otherwise.
 */
export class OfflineAuth {
  private readonly options: OfflineAuthOptions;
  private readonly throttle: OfflineThrottle;

  constructor(options: OfflineAuthOptions) {
    this.options = options;
    this.throttle =
      options.throttle ??
      memoryThrottle({
        maxFailures: options.maxFailures ?? 5,
        cooldownS: options.cooldownS ?? 300,
        now: () => this.now(),
      });
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  /** Seconds of cooldown left for this account, or 0. */
  cooldownFor(accountId: string): Promise<number> {
    return this.throttle.check(accountId);
  }

  /**
   * Whether this box has minted a token for an account recently enough to
   * admit them with their password alone.
   *
   * The window is `STAFF_OFFLINE_SIGN_IN_DAYS`, measured from the last token
   * this box minted — which is the same row the revocation lives on, so
   * "recognised here" and "revoked" cannot disagree.
   */
  recognises(record: OfflineStaffRecord | undefined, now = this.now()): boolean {
    if (!record?.lastTokenAt) return false;
    const days = this.options.offlineSignInDays ?? STAFF_OFFLINE_SIGN_IN_DAYS;
    const seen = Date.parse(record.lastTokenAt);
    if (!Number.isFinite(seen)) return false;
    return now.getTime() - seen <= days * 24 * 60 * 60 * 1000;
  }

  /**
   * Unlock a locked till with no internet.
   *
   * Two ways in, and they are never confused in the record:
   *
   *  - a token that still verifies, plus the password → `offline_token`. This
   *    is the ordinary path and the one the acceptance criterion names;
   *  - no usable token, but this box minted one for the account inside the
   *    30-day window and `allowOfflineSignIn` is on → `offline_sign_in`, with
   *    the banner. Off by default, so an expired token is refused.
   *
   * The password is checked in BOTH, always. A token is a statement about a
   * shift, not about the person standing at the till.
   */
  async unlock(request: {
    token?: string | null;
    /** Checked even when a token is present; the two prove different things. */
    password: string;
    /** When the caller already knows whose session is locked. */
    accountId?: string | null;
  }): Promise<OfflineUnlockResult> {
    const snapshot = await this.options.snapshot();
    if (!snapshot || snapshot.staff.length === 0) {
      return {
        ok: false,
        refusal: OFFLINE_UNLOCK_REFUSALS.NO_CACHE,
        message:
          'This box has not taken a copy of the staff list yet — connect to the internet once and sign in.',
      };
    }
    /**
     * Before anything that could admit somebody, and before the password is
     * looked at: a box holding a staff list with no deny-list beside it cannot
     * answer "has this person's access been withdrawn", and the honest thing
     * to do with a question it cannot answer is refuse it.
     *
     * Both paths through this method depend on the answer — the token path
     * through `verifyStaffToken`, the 30-day sign-in through the account check
     * below — so the refusal is here once rather than in each of them.
     */
    if (!snapshot.deny) {
      return {
        ok: false,
        refusal: OFFLINE_UNLOCK_REFUSALS.REVOCATION_UNKNOWN,
        message:
          'This till has only part of its offline copy and cannot check whether access has been withdrawn — connect to the internet and sign in.',
      };
    }

    const now = this.now();
    let claims: StaffTokenClaims | null = null;
    let tokenRefusal: StaffTokenRefusal | null = null;

    if (request.token) {
      const verified = verifyStaffToken(request.token, {
        keys: snapshot.keys,
        boxId: this.options.boxId,
        branchId: this.options.branchId,
        deny: snapshot.deny,
        now,
      });
      if (verified.ok) claims = verified.claims;
      else tokenRefusal = verified.refusal;
    }

    /**
     * A REVOKED token is a decision somebody made — a manager ended that
     * shift — and it is never a way into the thirty-day sign-in below, which
     * exists for a token that merely ran out (offline plan OD-6). Without this
     * a person whose shift had been ended could type their password and be
     * let straight back in as a "fresh" sign-in, which is the deny-list
     * refusing nothing.
     */
    if (tokenRefusal === STAFF_TOKEN_REFUSALS.REVOKED) {
      return { ok: false, refusal: tokenRefusal, message: refusalMessage(tokenRefusal) };
    }

    /**
     * Whose till this is.
     *
     * From the VERIFIED claims, or from the caller — the locked session — and
     * never from a token that did not verify. An unverified token names
     * nobody: its `sub` is a string somebody handed us, and letting it choose
     * which cached account to attack would hand an attacker the pick of the
     * staff list and a fresh throttle bucket for each name.
     */
    const accountId = claims?.sub ?? request.accountId ?? null;
    if (!accountId) {
      return {
        ok: false,
        refusal: tokenRefusal ?? STAFF_TOKEN_REFUSALS.INVALID,
        message: refusalMessage(tokenRefusal ?? STAFF_TOKEN_REFUSALS.INVALID),
      };
    }

    // The cooldown is checked before the password and before the token's own
    // refusal is reported: a guesser must learn nothing from the answer except
    // that they are locked out.
    const cooling = await this.throttle.check(accountId);
    if (cooling > 0) {
      return {
        ok: false,
        refusal: OFFLINE_UNLOCK_REFUSALS.LOCKED_OUT,
        message: `Too many wrong passwords. Try again in ${Math.ceil(cooling / 60)} minutes.`,
        retryAfterS: cooling,
      };
    }

    const record = snapshot.staff.find((s) => s.accountId === accountId);
    if (!record) {
      return {
        ok: false,
        refusal: OFFLINE_UNLOCK_REFUSALS.NOT_CACHED,
        message: 'This box does not have your details yet — connect to the internet to sign in.',
      };
    }
    if (record.status !== 'active' || snapshot.deny.revokedAccountIds.includes(accountId)) {
      return {
        ok: false,
        refusal: OFFLINE_UNLOCK_REFUSALS.INACTIVE,
        message: 'This account cannot be used. Ask a manager.',
      };
    }

    const method: 'offline_token' | 'offline_sign_in' = claims ? 'offline_token' : 'offline_sign_in';
    if (!claims) {
      // No usable token. Either the ticket's expiry message, or — with the
      // flag on — the 30-day recognition path.
      if (!this.options.allowOfflineSignIn) {
        if (!tokenRefusal) {
          return {
            ok: false,
            refusal: OFFLINE_UNLOCK_REFUSALS.NO_TOKEN,
            message:
              'This till has no shift token — connect to the internet and sign in to start a shift.',
          };
        }
        return { ok: false, refusal: tokenRefusal, message: refusalMessage(tokenRefusal) };
      }
      if (!this.recognises(record, now)) {
        return {
          ok: false,
          refusal: OFFLINE_UNLOCK_REFUSALS.NOT_RECOGNISED,
          message:
            'This till has not seen you in the last 30 days — connect to the internet to sign in.',
        };
      }
    }

    const hash = record.passwordHash;
    const passwordOk = hash ? await this.options.verifyPassword(hash, request.password) : false;
    if (!passwordOk) {
      const outcome = await this.throttle.fail(accountId);
      return outcome.locked
        ? {
            ok: false,
            refusal: OFFLINE_UNLOCK_REFUSALS.LOCKED_OUT,
            message: `Too many wrong passwords. Try again in ${Math.ceil(outcome.retryAfterS / 60)} minutes.`,
            retryAfterS: outcome.retryAfterS,
          }
        : {
            ok: false,
            refusal: OFFLINE_UNLOCK_REFUSALS.WRONG_PASSWORD,
            message: 'Password is incorrect',
            attemptsLeft: outcome.attemptsLeft,
          };
    }

    await this.throttle.clear(accountId);
    return {
      ok: true,
      accountId,
      method,
      claims,
      cachedAt: snapshot.cachedAt,
      mustChangePassword: record.mustChangePassword,
    };
  }
}

/** What the till says, one message per distinguishable cause. */
export function refusalMessage(refusal: StaffTokenRefusal): string {
  switch (refusal) {
    case STAFF_TOKEN_REFUSALS.EXPIRED:
      return 'Shift token expired, connect to sign in';
    case STAFF_TOKEN_REFUSALS.REVOKED:
      return 'This shift was ended by a manager — connect to sign in';
    case STAFF_TOKEN_REFUSALS.REVOCATION_UNKNOWN:
      // Not "your shift was ended": the box does not know that and must not
      // say it. What it knows is that it cannot check, and the fix is a pull.
      return 'This till cannot check whether that shift is still valid — connect to sign in';
    case STAFF_TOKEN_REFUSALS.WRONG_AUDIENCE:
      return 'That shift belongs to another till';
    case STAFF_TOKEN_REFUSALS.UNKNOWN_KEY:
      return 'This box cannot check that shift token — connect to sign in';
    case STAFF_TOKEN_REFUSALS.SCHEMA_TOO_NEW:
      return 'This box needs updating before it can read that shift token';
    default:
      return 'That shift token is not valid here';
  }
}

/**
 * Constant-time comparison for the short opaque strings this package compares
 * outside the signature check. Length differences leak, as they always do; the
 * values compared with it are ids rather than secrets.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
