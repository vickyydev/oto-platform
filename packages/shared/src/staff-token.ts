import { z } from 'zod';

/**
 * The signed staff token (S2-06): what the cloud mints at station pick and what
 * a box verifies hours later with no network.
 *
 * **Why a token at all, when the box already caches the password hash.** The
 * staff cache bundle carries each account's argon2id hash, which is enough to
 * check a password offline — but it is not enough to know whether that person
 * is still on shift, still employed, or still allowed at this branch. The
 * bundle is a list of who MAY sign in; the token is the statement that this
 * person DID, at this station, at a time the cloud could still vouch for. The
 * two are checked together: the password proves the person, the token proves
 * the shift, and the deny-list revokes either.
 *
 * **The seam.** `apps/api` signs these; `packages/box-agent` verifies them. The
 * two are written by different people at different times, which is the shape
 * that has failed three times this sprint — a fleet API nobody wrote, a session
 * document nothing could reach, an anomalies route the Console called into
 * space. So the claim set lives here, in one file both sides import, rather
 * than being described twice in prose.
 */

/** Bumped when a claim changes MEANING, not when one is added. */
export const STAFF_TOKEN_SCHEMA_VERSION = 1;

/**
 * Ed25519, matching `core.signing_key.algorithm`.
 *
 * The private half lives in `STAFF_TOKEN_PRIVATE_KEY` and never reaches the
 * database; the public half is a `core.signing_key` row with purpose
 * `staff_token` and travels to every box in its cache bundle. A box therefore
 * holds nothing that can mint a token, which is the property that matters when
 * the hardware is a Raspberry Pi in a mall storeroom (OWNER_DIRECTION: box
 * theft).
 */
export const STAFF_TOKEN_ALGORITHM = 'ed25519';

/**
 * How long a token is good for, in seconds. Default: sixteen hours.
 *
 * The ticket says "shift-length" and does not give a number. Sixteen hours is
 * chosen against two failure modes rather than against a roster: a token that
 * expires mid-shift strands a till that has been offline since the morning and
 * cannot ask anybody for a new one, while a token that lives for days is a
 * credential sitting on a disk in a storeroom. A park that opens at 09:00 and
 * closes at 22:00 fits inside sixteen hours with the close-down after it, and
 * a token issued at the start of a double shift still dies before the next
 * morning's.
 *
 * Deployments override it with `STAFF_TOKEN_TTL_S`. Whatever it is set to, it
 * must stay well below `STAFF_TOKEN_RETENTION_DAYS` below, or a revoked token
 * can outlive the row that says it was revoked.
 */
export const STAFF_TOKEN_TTL_S = 16 * 60 * 60;

/**
 * How long a box will let somebody sign in fresh while offline, in days.
 *
 * The ticket's default (S2-06): a person the box has seen in the last 30 days
 * may sign in from cold with their password alone, with a banner saying the
 * box is offline. Somebody the box has never seen cannot, because there is
 * nothing on the box that says they exist.
 *
 * "Seen on that box" is answered from `core.staff_token`: a token was minted
 * for this account, on this box, within the window. That is the same row that
 * carries the revocation, so the two questions cannot disagree.
 */
export const STAFF_OFFLINE_SIGN_IN_DAYS = 30;

/**
 * How long a token row is kept after it expires, in days.
 *
 * **This value has a floor, and it is not a matter of taste.** The row is read
 * for two things after the token has died: the 30-day offline sign-in window
 * above, and the record of who was at which till. Set below
 * `STAFF_OFFLINE_SIGN_IN_DAYS` it would start deleting the evidence the
 * offline sign-in depends on, and staff would quietly stop being recognised by
 * a box that has seen them all month.
 *
 * Forty-five days is thirty plus the longest token life plus room. At roughly
 * one row per station pick — a few dozen a day at a branch — nothing here is
 * ever big enough for the sweep to be about size, so no sweep is wired: every
 * query that matters is bounded by `expires_at > now()` or by an indexed
 * `issued_at` window. The number is recorded so that whoever does wire one
 * knows what it may not go below.
 */
export const STAFF_TOKEN_RETENTION_DAYS = 45;

/**
 * The claims, deliberately short — this is a bearer string typed into nothing
 * and carried in a header, and every byte is printed on a QR in some future
 * ticket.
 *
 * What is NOT here is as considered as what is. No name: the lock screen gets
 * the person's name from the station session document, and a token is a thing
 * that may end up in a log. No permissions: those come from the cache bundle,
 * which can be updated without re-minting every token in the park. No password
 * hash: the bundle carries that, and a token is shown to more things than a
 * bundle is.
 */
export const StaffTokenClaimsSchema = z.object({
  /** Schema version. A box refusing a version it cannot read is a clear failure. */
  v: z.number().int().min(1),
  /** The token's id, and the value a revocation names. UUIDv7. */
  jti: z.string().uuid(),
  /** The account. */
  sub: z.string().uuid(),
  /** The branch this token is good at — the "branch audience" the ticket asks for. */
  aud: z.string().uuid(),
  /** The platform session it was minted from, so signing out revokes it. */
  sid: z.string().uuid(),
  /** The station picked. */
  sta: z.string().uuid(),
  /** The box that station sits on. A token presented to another box is refused. */
  box: z.string().uuid(),
  /** Issued at, seconds since the epoch. */
  iat: z.number().int().min(0),
  /** Expires at, seconds since the epoch. */
  exp: z.number().int().min(0),
});
export type StaffTokenClaims = z.infer<typeof StaffTokenClaimsSchema>;

/**
 * The deny-list as it travels in the cache bundle's `deny_list` scope.
 *
 * This shape is already produced by `buildCacheBundle` in
 * `apps/api/src/services/sync.ts`, where it is an object literal with no schema
 * behind it and `revokedTokenIds` left empty with a comment saying S2-06 fills
 * it. Writing it down here is the point: two sides now parse the same
 * definition instead of agreeing by memory.
 *
 * **`revokedTokenIds` is bounded by expiry, not by history.** It carries the
 * jti of every token that was revoked and has not yet expired — past its `exp`
 * a box refuses it on the timestamp alone, so keeping it on the list would make
 * the list grow for ever to say something the token already says about itself.
 */
export const StaffDenyListSchema = z.object({
  /** Accounts that are no longer `active`. Refused offline from the next pull. */
  revokedAccountIds: z.array(z.string().uuid()),
  /** Individually revoked tokens that have not yet expired. */
  revokedTokenIds: z.array(z.string().uuid()),
});
export type StaffDenyList = z.infer<typeof StaffDenyListSchema>;

/** Why a token stopped being good. Recorded on the row; not carried in the bundle. */
export const STAFF_TOKEN_REVOKE_REASONS = [
  /** The person signed out, or was signed out everywhere. */
  'sign_out',
  /** The account was deactivated or its password reset. */
  'account_revoked',
  /** The person picked a different station; the old station's token is done. */
  'station_changed',
  /** An administrator ended this token by hand from the Console. */
  'admin',
] as const;
export type StaffTokenRevokeReason = (typeof STAFF_TOKEN_REVOKE_REASONS)[number];

/** Why an offline unlock or sign-in was refused. One code per distinguishable cause. */
export const STAFF_TOKEN_REFUSALS = {
  /** Past `exp`. The till says "shift token expired, connect to sign in". */
  EXPIRED: 'STAFF_TOKEN_EXPIRED',
  /** Signature did not verify against any known public key. */
  INVALID: 'STAFF_TOKEN_INVALID',
  /** `kid` names a key this box does not hold. */
  UNKNOWN_KEY: 'STAFF_TOKEN_UNKNOWN_KEY',
  /** The jti, or the account, is on the deny-list in the current cache bundle. */
  REVOKED: 'STAFF_TOKEN_REVOKED',
  /**
   * The box holds no deny-list at all, so it cannot say whether this token was
   * revoked — and refuses rather than assume it was not.
   *
   * Separate from `REVOKED` because the two are different facts and one of
   * them is a fault: `REVOKED` is a decision a manager made, this is a box
   * whose last cache pull was incomplete, which is reported in its heartbeat
   * and fixed by a complete pull.
   */
  REVOCATION_UNKNOWN: 'STAFF_TOKEN_REVOCATION_UNKNOWN',
  /** `box` or `aud` names somewhere else. */
  WRONG_AUDIENCE: 'STAFF_TOKEN_WRONG_AUDIENCE',
  /** `v` is newer than this box can read. */
  SCHEMA_TOO_NEW: 'STAFF_TOKEN_SCHEMA_TOO_NEW',
} as const;
export type StaffTokenRefusal =
  (typeof STAFF_TOKEN_REFUSALS)[keyof typeof STAFF_TOKEN_REFUSALS];

/**
 * How an unlock was authenticated, stamped on the `session.unlock` audit row.
 *
 * The acceptance criterion names `offline_token` explicitly, so the vocabulary
 * is fixed here rather than spelled out at each call site.
 */
export const AUTH_METHODS = ['password', 'offline_token', 'offline_sign_in'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];
