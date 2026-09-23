import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { MaintenanceClient, decryptJwe, encryptJwe, signJws, verifyJws } from '../src/maintenance';

/**
 * The maintenance envelope: JWE (RSA-OAEP + A256GCM) around a JWS (PS256).
 *
 * Both key pairs are generated inside this process. Nothing here is a key of
 * the park's, and `PGW_SECRET_KEY` is deliberately absent from this whole file
 * — the maintenance path does not use it, and a merchant who put it here would
 * be signing refunds with the key that verifies notifications.
 */
function keyPair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

const ours = keyPair();
const theirs = keyPair();

describe('JWS PS256', () => {
  it('round-trips and refuses a bad signature before reading the claims', () => {
    const jws = signJws({ invoiceNo: 'T01260923000001', processType: 'R' }, ours.privateKey);
    expect(verifyJws(jws, ours.publicKey)).toEqual({
      invoiceNo: 'T01260923000001',
      processType: 'R',
    });
    // Signed by somebody else.
    expect(() => verifyJws(jws, theirs.publicKey)).toThrow(/bad signature/);
  });

  it('refuses an algorithm it was not built for', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ a: 1 })).toString('base64url');
    expect(() => verifyJws(`${header}.${payload}.x`, ours.publicKey)).toThrow(/not PS256/);
  });

  it('refuses anything that is not a compact JWS', () => {
    expect(() => verifyJws('a.b', ours.publicKey)).toThrow(/compact JWS/);
  });
});

describe('JWE RSA-OAEP + A256GCM', () => {
  it('round-trips', () => {
    const jwe = encryptJwe('the inner jws', theirs.publicKey);
    expect(jwe.split('.')).toHaveLength(5);
    expect(decryptJwe(jwe, theirs.privateKey)).toBe('the inner jws');
  });

  it('binds the protected header as additional authenticated data', () => {
    const jwe = encryptJwe('secret', theirs.publicKey);
    const parts = jwe.split('.');
    // Swap the header for another well-formed one: the GCM tag no longer
    // verifies, which is what AAD is for.
    parts[0] = Buffer.from(JSON.stringify({ alg: 'RSA-OAEP', enc: 'A256GCM', x: 1 })).toString(
      'base64url',
    );
    expect(() => decryptJwe(parts.join('.'), theirs.privateKey)).toThrow();
  });

  it('refuses another algorithm pair and anything that is not five segments', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A128CBC-HS256' })).toString(
      'base64url',
    );
    expect(() => decryptJwe(`${header}.a.b.c.d`, theirs.privateKey)).toThrow(/dir/);
    expect(() => decryptJwe('a.b.c', theirs.privateKey)).toThrow(/compact JWE/);
  });
});

describe('the maintenance call', () => {
  it('sends V and R to the maintenance host in the double envelope', async () => {
    let sentTo = '';
    let sentBody = '';
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      sentTo = String(url);
      sentBody = String(init?.body);
      // 2C2P answers in the mirror image: their JWS, encrypted to our key.
      const answer = signJws(
        { respCode: '00', respDesc: 'Success', refundReferenceNo: 'RF-1', processType: 'R' },
        theirs.privateKey,
      );
      return new Response(encryptJwe(answer, ours.publicKey), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const client = new MaintenanceClient(
      {
        baseUrl: 'https://maintenance.invalid/PaymentAction/2.0/action',
        privateKeyPem: ours.privateKey,
        partnerPublicKeyPem: theirs.publicKey,
      },
      {
        merchantId: 'TESTMERCHANT',
        fetch: fetchImpl,
        now: () => new Date('2026-09-23T03:04:05.000Z'),
        timeoutMs: 5_000,
      },
    );

    const answer = await client.action({
      invoiceNo: 'T01260923000001',
      amountSatang: 144000,
      processType: 'R',
    });

    expect(sentTo).toBe('https://maintenance.invalid/PaymentAction/2.0/action');
    // What went out is a JWE; inside it is a JWS signed by us.
    expect(sentBody.split('.')).toHaveLength(5);
    const inner = verifyJws(decryptJwe(sentBody, theirs.privateKey), ours.publicKey);
    expect(inner).toEqual({
      version: '4.3',
      timestamp: '230926030405',
      merchantID: 'TESTMERCHANT',
      invoiceNo: 'T01260923000001',
      actionAmount: '1440.00000',
      processType: 'R',
    });

    // `00` is success on THIS api; `0000` is success on the payment one.
    expect(answer.respCode).toBe('00');
    expect(answer.state).toBe('refunded');
    expect(answer.providerRefundRef).toBe('RF-1');
  });

  it('calls a successful V a cancellation, not a refund', async () => {
    const fetchImpl = (async () =>
      new Response(
        encryptJwe(signJws({ respCode: '00', respDesc: 'Success' }, theirs.privateKey), ours.publicKey),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;
    const client = new MaintenanceClient(
      {
        baseUrl: 'https://maintenance.invalid/PaymentAction/2.0/action',
        privateKeyPem: ours.privateKey,
        partnerPublicKeyPem: theirs.publicKey,
      },
      { merchantId: 'M', fetch: fetchImpl, now: () => new Date(), timeoutMs: 5_000 },
    );
    const answer = await client.action({ invoiceNo: 'X', amountSatang: 1, processType: 'V' });
    expect(answer.state).toBe('cancelled');
  });

  it('refuses an empty body rather than reporting a refund that did not happen', async () => {
    const fetchImpl = (async () =>
      new Response('', { status: 500 })) as unknown as typeof globalThis.fetch;
    const client = new MaintenanceClient(
      {
        baseUrl: 'https://maintenance.invalid/PaymentAction/2.0/action',
        privateKeyPem: ours.privateKey,
        partnerPublicKeyPem: theirs.publicKey,
      },
      { merchantId: 'M', fetch: fetchImpl, now: () => new Date(), timeoutMs: 5_000 },
    );
    await expect(
      client.action({ invoiceNo: 'X', amountSatang: 1, processType: 'V' }),
    ).rejects.toThrow(/empty body/);
  });
});
