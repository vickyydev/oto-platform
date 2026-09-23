import { describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import {
  JwtClaimsError,
  JwtSignatureError,
  decodeUnverified,
  envelope,
  payloadOf,
  signJwt,
  verifyJwt,
} from '../src/envelope';

/**
 * The JWT envelope — the one thing between a stranger on the internet and a
 * sale marked paid.
 *
 * The secret below is minted per run and exists only inside this process. No
 * `PGW_*` value of the park's, of the sandbox's or of 2C2P's public demo
 * merchants appears in this repository (`PAYMENT_GATEWAY.md:17-24`).
 */
const SECRET = randomBytes(32).toString('hex');

const CLAIMS = {
  merchantID: 'TESTMERCHANT',
  invoiceNo: 'T01260923000001',
  amount: '144.00000',
  currencyCode: 'THB',
  respCode: '0000',
};

describe('sign -> verify -> decode', () => {
  it('round-trips the claims exactly', () => {
    const token = signJwt(CLAIMS, SECRET);
    expect(verifyJwt(token, SECRET)).toEqual(CLAIMS);
  });

  it('is the shape 2C2P sends: three base64url segments, HS256', () => {
    const token = signJwt(CLAIMS, SECRET);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    // The MAC really is HMAC-SHA256 over `header.payload`, not over the claims
    // object or over the payload alone.
    expect(parts[2]).toBe(
      createHmac('sha256', SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url'),
    );
  });

  it('drops undefined optional fields rather than sending nulls', () => {
    const token = signJwt({ merchantID: 'M', frontendReturnUrl: undefined }, SECRET);
    expect(verifyJwt(token, SECRET)).toEqual({ merchantID: 'M' });
  });

  it('carries the body shape both sides use', () => {
    const token = signJwt(CLAIMS, SECRET);
    expect(payloadOf(envelope(token))).toBe(token);
    expect(payloadOf({})).toBeNull();
    expect(payloadOf('nonsense')).toBeNull();
    expect(payloadOf(null)).toBeNull();
  });
});

describe('a bad signature is refused BEFORE its claims are read', () => {
  it('refuses a token signed with another key', () => {
    const token = signJwt(CLAIMS, randomBytes(32).toString('hex'));
    expect(() => verifyJwt(token, SECRET)).toThrow(JwtSignatureError);
    try {
      verifyJwt(token, SECRET);
    } catch (err) {
      expect((err as JwtSignatureError).reason).toBe('signature');
      // The refusal never quotes the token or anything in it.
      expect((err as Error).message).not.toContain(CLAIMS.invoiceNo);
    }
  });

  it('refuses a tampered payload even though the tampering is valid JSON', () => {
    const token = signJwt(CLAIMS, SECRET);
    const [header, , signature] = token.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...CLAIMS, amount: '1.00000' })).toString(
      'base64url',
    );
    expect(() => verifyJwt(`${header}.${forged}.${signature}`, SECRET)).toThrow(JwtSignatureError);
  });

  /**
   * THE ORDER, PROVED. The payload here is not JSON at all. If the function
   * parsed before it verified, the failure would be a claims failure; because
   * it verifies first, an unsigned body never reaches the parser.
   */
  it('reports a signature failure, not a parse failure, on an unsigned body', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const garbage = Buffer.from('not json at all').toString('base64url');
    let caught: unknown;
    try {
      verifyJwt(`${header}.${garbage}.${Buffer.from('nope').toString('base64url')}`, SECRET);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JwtSignatureError);
    expect((caught as JwtSignatureError).reason).toBe('signature');
  });

  it('refuses alg:none and never selects a verifier from the token', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(CLAIMS)).toString('base64url');
    let caught: unknown;
    try {
      verifyJwt(`${header}.${payload}.`, SECRET);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JwtSignatureError);
    // `malformed` for the empty third segment, `algorithm` if one is supplied.
    const withSignature = `${header}.${payload}.${Buffer.from('x').toString('base64url')}`;
    expect(() => verifyJwt(withSignature, SECRET)).toThrow(/algorithm/);
  });

  it('refuses anything that is not three segments', () => {
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d']) {
      expect(() => verifyJwt(bad, SECRET)).toThrow(JwtSignatureError);
    }
  });

  it('refuses a correctly signed body that is not an object', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify([1, 2, 3])).toString('base64url');
    const signature = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
    expect(() => verifyJwt(`${header}.${payload}.${signature}`, SECRET)).toThrow(JwtClaimsError);
  });

  it('refuses to sign or verify with no key at all', () => {
    expect(() => signJwt(CLAIMS, '')).toThrow(JwtClaimsError);
    expect(() => verifyJwt(signJwt(CLAIMS, SECRET), '')).toThrow(JwtClaimsError);
  });
});

describe('decodeUnverified', () => {
  it('reads a refused delivery for the record, believing nothing', () => {
    const token = signJwt(CLAIMS, randomBytes(32).toString('hex'));
    expect(decodeUnverified(token)?.claims).toEqual(CLAIMS);
    expect(decodeUnverified('rubbish')).toBeNull();
    expect(decodeUnverified('a.b.c')).toEqual({ header: null, claims: null });
  });
});
