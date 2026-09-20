import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import {
  account,
  handoffToken,
  session as sessionTable,
  HANDOFF_AUDIENCES,
  type Db,
  type HandoffAudience,
} from '@oto/db';
import { newId, type Permission } from '@oto/shared';
import { AppError } from '../lib/errors';
import type { Exec } from './tx';

/**
 * The signed hand-off (S2-02).
 *
 * One platform session has to open several apps on several origins. A cookie
 * cannot cross them — `*.onrender.com` is on the public suffix list, and a
 * parent-domain cookie would still not reach the booking site's own domain —
 * so the launcher asks for a short-lived token aimed at ONE app, the browser
 * carries it there, and the app posts it back for a cookie of its own bound
 * to the same session row.
 *
 * Three properties carry the whole design:
 *
 *  - **The fragment, never the query string.** `https://app/#handoff=…` is
 *    the reason the URL may carry a credential at all: a fragment is never
 *    sent to a server, so it reaches no access log, no proxy and no
 *    `Referer` on the next click. A token in `?handoff=` would be written
 *    down by every hop between the two apps.
 *  - **A signature proves minting, not freshness.** Replay is stopped by the
 *    jti row, claimed in one statement, not by the signature.
 *  - **One session row.** The app's cookie carries the session's own opaque
 *    token, so revoking the session ends every app at once — there is no
 *    second credential to remember to revoke.
 */

// --- The apps a token can be aimed at ---------------------------------------

export type HandoffApp = HandoffAudience;
export const HANDOFF_APPS = HANDOFF_AUDIENCES;

/**
 * Typed so the two lists cannot drift: if an app is added to
 * `HANDOFF_AUDIENCES` without its `app:<name>:access` permission, this stops
 * compiling.
 */
export function appAccessPermission(app: HandoffApp): Permission {
  return `app:${app}:access`;
}

// --- Configuration ----------------------------------------------------------

export interface HandoffKey {
  kid: string;
  secret: string;
}

export interface HandoffSettings {
  signingKey: string;
  appOrigins: string;
  ttlSeconds: number;
}

export interface HandoffConfig {
  /** Verification keys, newest first. The first one signs. */
  keys: HandoffKey[];
  origins: Map<HandoffApp, string>;
  ttlSeconds: number;
}

const KEY_ENTRY = /^([A-Za-z0-9_-]{1,16}):(.{32,})$/;

/**
 * `<kid>:<secret>,<kid>:<secret>` — newest first.
 *
 * Rotation is the same expand/contract as a migration: prepend the new key,
 * deploy, and drop the old entry once nothing alive can still be carrying it
 * (one token lifetime — a minute at the default TTL). A `kid` in the header
 * is what lets the old key keep verifying in the meantime instead of every
 * launch failing at the moment of the swap.
 */
export function parseHandoffKeys(raw: string): HandoffKey[] {
  const keys = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = KEY_ENTRY.exec(entry);
      if (!m) {
        throw new Error(
          'each entry must be "<kid>:<secret>" — kid up to 16 of [A-Za-z0-9_-], ' +
            'secret at least 32 characters, newest key first',
        );
      }
      return { kid: m[1]!, secret: m[2]! };
    });
  const kids = new Set(keys.map((k) => k.kid));
  if (kids.size !== keys.length) throw new Error('two keys share a kid — a kid must identify one key');
  return keys;
}

const ORIGIN_ENTRY = /^([a-z_]+)=(https?:\/\/[^/,\s]+)$/;

/** `pos=https://…,console=https://…` — one origin per app. */
export function parseAppOrigins(raw: string): Map<HandoffApp, string> {
  const origins = new Map<HandoffApp, string>();
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const m = ORIGIN_ENTRY.exec(entry);
    if (!m) {
      throw new Error(
        `"${entry}" is not "<app>=<origin>" — e.g. pos=https://oto-pos-staging.onrender.com, ` +
          'scheme and host only, no path and no trailing slash',
      );
    }
    const app = m[1] as HandoffApp;
    if (!HANDOFF_APPS.includes(app)) {
      throw new Error(`"${m[1]}" is not one of the suite's apps (${HANDOFF_APPS.join(', ')})`);
    }
    if (origins.has(app)) throw new Error(`${app} is named twice — one origin per app`);
    origins.set(app, normaliseOrigin(m[2]!));
  }
  return origins;
}

export function normaliseOrigin(origin: string): string {
  return origin.trim().replace(/\/$/, '').toLowerCase();
}

/**
 * Unset means the hand-off is unavailable, not that a fallback is invented:
 * a key nobody chose is a key nobody can rotate, and one minted at boot would
 * differ between instances and between restarts.
 */
export function handoffConfig(settings: HandoffSettings): HandoffConfig {
  if (!settings.signingKey || !settings.appOrigins) {
    throw new AppError(
      503,
      'HANDOFF_NOT_CONFIGURED',
      'Suite hand-off is not configured on this deployment — set HANDOFF_SIGNING_KEY and HANDOFF_APP_ORIGINS',
    );
  }
  return {
    keys: parseHandoffKeys(settings.signingKey),
    origins: parseAppOrigins(settings.appOrigins),
    ttlSeconds: settings.ttlSeconds,
  };
}

// --- The token: a compact JWS, HS256 ----------------------------------------

const ISSUER = 'oto-platform';
/**
 * Deliberately not `JWT`. Nothing else here signs a JWT, and a distinct type
 * means a token minted for some later purpose under the same key can never be
 * replayed as a hand-off.
 */
const TYPE = 'oto-handoff+jws';

export interface HandoffClaims {
  jti: string;
  /** The session this token is bound to. */
  sid: string;
  sub: string;
  aud: HandoffApp;
  iss: string;
  iat: number;
  exp: number;
}

export const HANDOFF_ISSUER = ISSUER;

const b64url = (b: Buffer): string => b.toString('base64url');

/** Exported so the tests can forge what the issuer would never mint. */
export function signHandoffToken(key: HandoffKey, claims: HandoffClaims): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: TYPE, kid: key.kid })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(createHmac('sha256', key.secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

/** Claims of a token whose signature we minted, or null. Never throws. */
export function verifyToken(keys: HandoffKey[], token: string): HandoffClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  const header = decodeJson(rawHeader);
  // `alg` is pinned: accepting what the token asks for is how `none` and the
  // RS256-verified-as-HS256 confusion get in.
  if (!header || header.alg !== 'HS256' || header.typ !== TYPE || typeof header.kid !== 'string') {
    return null;
  }
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) return null;

  const expected = createHmac('sha256', key.secret).update(`${rawHeader}.${rawPayload}`).digest();
  const given = Buffer.from(rawSignature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const claims = decodeJson(rawPayload);
  if (!claims || claims.iss !== ISSUER) return null;
  if (typeof claims.jti !== 'string' || typeof claims.sid !== 'string' || typeof claims.sub !== 'string') {
    return null;
  }
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return null;
  if (!HANDOFF_APPS.includes(claims.aud as HandoffApp)) return null;
  return claims as unknown as HandoffClaims;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// --- Sealing the session's own cookie token ---------------------------------

/**
 * A key per token, derived from the signing secret with the jti as salt, so
 * one leaked ciphertext is not a key to every other row.
 */
function sealingKey(key: HandoffKey, jti: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key.secret, jti, 'oto-handoff-session-token', 32));
}

function seal(key: HandoffKey, jti: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(key, jti), iv);
  // The jti as associated data: a ciphertext copied onto another row fails.
  cipher.setAAD(Buffer.from(jti, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function open(key: HandoffKey, jti: string, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', sealingKey(key, jti), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(jti, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// --- Issuing ----------------------------------------------------------------

export interface IssuedHandoff {
  jti: string;
  /** The credential. Belongs in the issue response and nowhere else. */
  token: string;
  audience: HandoffApp;
  origin: string;
  expiresAt: Date;
  /** Where the launcher sends the browser; the token rides in the fragment. */
  launchUrl: string;
}

export async function issueHandoff(
  exec: Exec,
  config: HandoffConfig,
  opts: {
    sessionId: string;
    accountId: string;
    /** The session's own cookie token, read from the caller's request. */
    sessionToken: string;
    audience: HandoffApp;
  },
): Promise<IssuedHandoff> {
  const origin = config.origins.get(opts.audience);
  if (!origin) {
    throw new AppError(
      400,
      'HANDOFF_APP_UNKNOWN',
      `No origin is configured for the ${opts.audience} app on this deployment`,
    );
  }
  const key = config.keys[0]!;
  const jti = newId();
  const now = Date.now();
  const expiresAt = new Date(now + config.ttlSeconds * 1000);

  await exec.insert(handoffToken).values({
    jti,
    sessionId: opts.sessionId,
    accountId: opts.accountId,
    audience: opts.audience,
    audienceOrigin: origin,
    keyId: key.kid,
    sessionSecret: seal(key, jti, opts.sessionToken),
    expiresAt,
  });

  const token = signHandoffToken(key, {
    jti,
    sid: opts.sessionId,
    sub: opts.accountId,
    aud: opts.audience,
    iss: ISSUER,
    iat: Math.floor(now / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
  });

  return {
    jti,
    token,
    audience: opts.audience,
    origin,
    expiresAt,
    launchUrl: `${origin}/#handoff=${token}`,
  };
}

// --- Exchanging -------------------------------------------------------------

/** The exact vocabulary the audit row and the account page use. */
export type HandoffRejection = 'replayed' | 'expired' | 'audience' | 'origin' | 'revoked' | 'signature';

export class HandoffRejected extends AppError {
  constructor(
    readonly reason: HandoffRejection,
    message: string,
    /** Whatever was established before the refusal, for the audit row. */
    readonly context: { jti?: string; sessionId?: string; accountId?: string; audience?: HandoffApp } = {},
  ) {
    super(401, 'HANDOFF_REJECTED', message, { reason });
    this.name = 'HandoffRejected';
  }
}

export interface ExchangedHandoff {
  jti: string;
  sessionId: string;
  accountId: string;
  operatorId: string;
  audience: HandoffApp;
  /** The session's opaque token — goes into the app's cookie, nowhere else. */
  sessionToken: string;
  sessionExpiresAt: Date;
  mustChangePassword: boolean;
  sessionLocked: boolean;
}

/**
 * Verify, consume and resolve — in that order, and deliberately NOT inside one
 * transaction.
 *
 * The consumption has to survive every refusal that follows it. Wrapping the
 * whole thing would roll the claim back when a token turns out to be aimed at
 * another origin, and hand an attacker the one thing this is built to prevent:
 * a second go with the same token.
 */
export async function exchangeHandoff(
  db: Db,
  config: HandoffConfig,
  opts: { token: string; origin: string },
): Promise<ExchangedHandoff> {
  const claims = verifyToken(config.keys, opts.token);
  if (!claims) {
    throw new HandoffRejected('signature', 'This hand-off was not issued by us');
  }
  const seen = { jti: claims.jti, sessionId: claims.sid, accountId: claims.sub, audience: claims.aud };

  const now = new Date();
  if (claims.exp * 1000 <= now.getTime()) {
    throw new HandoffRejected('expired', 'This hand-off has expired — open the app from the launcher again', seen);
  }

  // The claim. One statement decides the winner, so two tabs racing the same
  // fragment cannot both be served — the same rule as the idempotency claim
  // in plugins/idempotency.ts. The expiry guard repeats the check above
  // against the database's own clock rather than the token's.
  const [row] = await db
    .update(handoffToken)
    .set({ consumedAt: now })
    .where(
      and(
        eq(handoffToken.jti, claims.jti),
        isNull(handoffToken.consumedAt),
        gt(handoffToken.expiresAt, now),
      ),
    )
    .returning();

  if (!row) throw await classifyLostClaim(db, claims.jti, seen);

  // Spent is spent, whatever the checks below decide: the sealed session has
  // no further use, and a row that cannot be opened is a row that cannot
  // leak. The value needed to finish is the one the claim already returned.
  await db.update(handoffToken).set({ sessionSecret: null }).where(eq(handoffToken.jti, row.jti));

  if (row.audience !== claims.aud) {
    // Only reachable if a row and a signed token disagree, which means one of
    // them was written by something that is not this code.
    throw new HandoffRejected('audience', 'This hand-off is for a different app', seen);
  }
  if (row.audienceOrigin !== normaliseOrigin(opts.origin)) {
    throw new HandoffRejected('origin', 'This hand-off was not issued for this app', seen);
  }

  const [live] = await db
    .select({ s: sessionTable, a: account })
    .from(sessionTable)
    .innerJoin(account, eq(sessionTable.accountId, account.id))
    .where(eq(sessionTable.id, row.sessionId))
    .limit(1);

  // A dead session covers three cases — revoked, expired, deactivated account
  // — and they share one reason on purpose: which one it was is the session's
  // business, not the browser's, and a hand-off must never resurrect any of
  // them.
  if (!live || live.s.revokedAt || live.s.expiresAt <= now || live.a.status !== 'active') {
    throw new HandoffRejected('revoked', 'The session behind this hand-off has ended — sign in again', seen);
  }

  const key = config.keys.find((k) => k.kid === row.keyId);
  const sessionToken = key && row.sessionSecret ? open(key, row.jti, row.sessionSecret) : null;
  if (!sessionToken) {
    // The signing key verified the token, so its sealing key is present too;
    // this is a row we can no longer open, which is a key problem either way.
    throw new HandoffRejected('signature', 'This hand-off can no longer be opened', seen);
  }

  return {
    jti: row.jti,
    sessionId: live.s.id,
    accountId: live.a.id,
    operatorId: live.a.operatorId,
    audience: row.audience,
    sessionToken,
    sessionExpiresAt: live.s.expiresAt,
    mustChangePassword: live.a.mustChangePassword,
    sessionLocked: live.s.lockedAt !== null,
  };
}

/** Nothing was claimed: say which of the three reasons it was. */
async function classifyLostClaim(
  db: Db,
  jti: string,
  seen: HandoffRejected['context'],
): Promise<HandoffRejected> {
  const [existing] = await db.select().from(handoffToken).where(eq(handoffToken.jti, jti)).limit(1);
  if (existing?.consumedAt) {
    return new HandoffRejected('replayed', 'This hand-off has already been used', seen);
  }
  if (existing) {
    return new HandoffRejected('expired', 'This hand-off has expired — open the app from the launcher again', seen);
  }
  // Signed by us but no row: swept after expiry, or a jti that never existed.
  // Either way the claim cannot be established, and refusing it as a replay is
  // the only answer that is never too generous.
  return new HandoffRejected('replayed', 'This hand-off has already been used', seen);
}

// --- Housekeeping -----------------------------------------------------------

/** Delete tokens whose window has passed. Called by the housekeeping job. */
export async function purgeExpiredHandoffTokens(db: Db): Promise<number> {
  const gone = await db
    .delete(handoffToken)
    .where(lte(handoffToken.expiresAt, new Date()))
    .returning({ jti: handoffToken.jti });
  return gone.length;
}

/**
 * Keeping the issue response out of the replay store used to be a line in the
 * hand-off route, giving the claimed key back by hand. It is now a property of
 * the route — `config: { secretResponse: true }` — so no key is claimed at all
 * and the next route that mints a credential inherits the rule instead of
 * having to remember this one. See `plugins/idempotency.ts`.
 */
