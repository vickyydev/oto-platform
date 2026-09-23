import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * THE JWT ENVELOPE (`PAYMENT_GATEWAY.md:117-123`).
 *
 * Every request body and every response body 2C2P exchanges is
 * `{"payload": "<jwt>"}` — header `{"alg":"HS256","typ":"JWT"}`, claims are
 * the fields, signed HMAC-SHA256 with the merchant Secret Key. 2C2P signs its
 * answers with the same key, which is what makes a notification proof of
 * anything at all: `PGW_WEBHOOK_SECRET` in the URL is a filter for internet
 * noise and is NOT authentication (said twice in the document, `:775` and
 * `DEVELOPMENT_PLAN.md:1222-1223`). This signature is.
 *
 * THE ORDER IS THE POINT: VERIFY, THEN READ. `verifyJwt` computes the MAC over
 * the encoded header and payload as bytes and compares it before anything is
 * base64-decoded or JSON-parsed. A forged notification is therefore refused
 * without its claims ever being turned into objects this process then reasons
 * about — no "which invoice did the attacker name" in a log line, no parser
 * reached by a body nobody signed. `decodeUnverified` exists for exactly one
 * purpose, says so on its own name, and is used only to record what arrived
 * when the signature has ALREADY failed.
 *
 * NO LIBRARY. `node:crypto` has HMAC-SHA256 and a constant-time compare, and a
 * JWT is two base64url segments and a MAC. A dependency here would be a third
 * party in the path of every payment for forty lines of code.
 */

/** Thrown before any claim is read. The message never quotes the token. */
export class JwtSignatureError extends Error {
  constructor(public readonly reason: 'malformed' | 'algorithm' | 'signature') {
    super(`payment envelope refused: ${reason}`);
    this.name = 'JwtSignatureError';
  }
}

export class JwtClaimsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtClaimsError';
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Sign one set of claims.
 *
 * Numbers and booleans are sent as they are; `undefined` values are dropped so
 * an optional field nobody set is absent rather than null — 2C2P's validator
 * treats those differently on several fields, and an explicit null on an
 * optional string is a `9900` nobody can read.
 */
export function signJwt(claims: Record<string, unknown>, secretKey: string): string {
  if (!secretKey) throw new JwtClaimsError('no secret key is configured to sign with');
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(dropUndefined(claims)));
  const signature = mac(`${header}.${payload}`, secretKey);
  return `${header}.${payload}.${signature}`;
}

function mac(signingInput: string, secretKey: string): string {
  return createHmac('sha256', secretKey).update(signingInput).digest('base64url');
}

/**
 * Verify, then decode. In that order, and the order is enforced by the shape
 * of the function rather than by a comment asking for it.
 *
 * A token whose payload segment is not even JSON is refused as a SIGNATURE
 * failure when it is unsigned, because the signature is checked first and
 * nothing gets as far as the parser. `test/envelope.test.ts` pins that, since
 * it is the one property a later "tidy-up" would quietly reverse.
 */
export function verifyJwt(token: string, secretKey: string): Record<string, unknown> {
  if (!secretKey) throw new JwtClaimsError('no secret key is configured to verify with');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtSignatureError('malformed');
  const [header, payload, signature] = parts as [string, string, string];
  if (!header || !payload || !signature) throw new JwtSignatureError('malformed');

  /**
   * The algorithm is read from the header before the MAC, and only to REFUSE
   * anything that is not HS256. That is the `alg: none` defence and the
   * algorithm-confusion defence in one line: we never select a verifier from
   * the token, we only check the token agrees with the one verifier we have.
   */
  let alg: unknown;
  try {
    alg = (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: unknown }).alg;
  } catch {
    throw new JwtSignatureError('malformed');
  }
  if (alg !== 'HS256') throw new JwtSignatureError('algorithm');

  const expected = Buffer.from(mac(`${header}.${payload}`, secretKey), 'base64url');
  const actual = Buffer.from(signature, 'base64url');
  // Length first: `timingSafeEqual` throws on a mismatch rather than answering.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new JwtSignatureError('signature');
  }

  // Only now.
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new JwtClaimsError('the signed payload is not JSON');
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new JwtClaimsError('the signed payload is not an object');
  }
  return claims as Record<string, unknown>;
}

/**
 * What arrived, without believing any of it.
 *
 * Used in one place: recording the `ops_run` for a delivery whose signature
 * has already failed, so that a dispute has something to look at. Nothing
 * downstream may branch on this — the name is the warning.
 */
export function decodeUnverified(token: string): { header: unknown; claims: unknown } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const read = (segment: string): unknown => {
    try {
      return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  };
  return { header: read(parts[0]!), claims: read(parts[1]!) };
}

/** `{"payload": "<jwt>"}` — the only body shape on either side of the wire. */
export function envelope(jwt: string): { payload: string } {
  return { payload: jwt };
}

/** Read the `payload` out of a body that may be anything at all. */
export function payloadOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as { payload?: unknown }).payload;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function dropUndefined(claims: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(claims)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
