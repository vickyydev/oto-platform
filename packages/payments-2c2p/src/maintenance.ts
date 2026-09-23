import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  sign as signWithKey,
  verify as verifyWithKey,
} from 'node:crypto';
import { toWireAmount, type MaintenanceConfig } from './config';
import { stateForRespCode } from './resp-codes';
import type { RefundInput, RefundResult } from './contract';

/**
 * PAYMENT MAINTENANCE — void and refund (`PAYMENT_GATEWAY.md:389-441`).
 *
 * TWO THINGS ARE DIFFERENT HERE AND BOTH ARE EASY TO MISS.
 *
 * 1. **A different host.** `.../PaymentAction/2.0/action`, not a path on the
 *    payment API. Pointing this at `PGW_BASE_URL` produces a 404 that reads
 *    like a refused refund.
 * 2. **A different crypto envelope.** Not the HS256 secret at all: a
 *    **JWE (RSA-OAEP + A256GCM)** wrapping a **JWS (PS256)**, under an RSA key
 *    pair exchanged with 2C2P (`:124-127`). Our private key signs the request
 *    and decrypts their answer; their public key encrypts the request and
 *    verifies their answer. `PGW_SECRET_KEY` is not used on this path and must
 *    not be: a merchant who put it here would be signing refunds with the key
 *    that verifies notifications.
 *
 * WHERE OUR PUBLIC KEY IS UPLOADED AND HOW THEIRS IS OBTAINED IS NOT ON THE
 * PUBLIC DOCS — UNCERTAIN, and it comes from 2C2P onboarding (`:128-130`).
 * That is why this class is constructed only when both PEMs are configured and
 * why `TwoC2PQrPayment.refund` reports the absence rather than throwing: a
 * park without the key pair still takes payments, it just cannot refund one
 * through the gateway yet.
 *
 * NO REFUND BUTTON EXISTS IN THIS SLICE. S2-11 owns the UI and the ledger
 * entry; what is built here is the API, and the simulator honours the same two
 * process types so the path can be exercised (the ticket asks for exactly
 * that).
 *
 * THE ENVELOPE IS HAND-BUILT ON `node:crypto` for the same reason the HS256
 * one is: JWE compact serialisation is five dot-separated segments and AES-GCM
 * with the protected header as additional authenticated data. Node 22 has
 * RSA-OAEP, AES-256-GCM and RSASSA-PSS. A dependency in the refund path buys
 * nothing and has to be audited.
 */

export interface MaintenanceDeps {
  merchantId: string;
  fetch: typeof globalThis.fetch;
  now: () => Date;
  timeoutMs: number;
}

export class MaintenanceClient {
  private readonly url: string;

  constructor(
    private readonly config: MaintenanceConfig,
    private readonly deps: MaintenanceDeps,
  ) {
    // Already resolved against `PGW_ENV` by whoever built the config — this
    // class never guesses which environment it is talking to, because the two
    // hosts are on different domains and a wrong guess refunds against the
    // wrong ledger.
    this.url = config.baseUrl;
  }

  async action({ invoiceNo, amountSatang, processType }: RefundInput): Promise<RefundResult> {
    const request = {
      version: '4.3',
      /** `ddmmyyhhmmss` — the maintenance API's own stamp format, not ISO. */
      timestamp: stamp(this.deps.now()),
      merchantID: this.deps.merchantId,
      invoiceNo,
      actionAmount: toWireAmount(amountSatang),
      processType,
    };

    const jws = signJws(request, this.config.privateKeyPem);
    const jwe = encryptJwe(jws, this.config.partnerPublicKeyPem);

    const res = await this.deps.fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', accept: 'text/plain' },
      body: jwe,
      signal: AbortSignal.timeout(this.deps.timeoutMs),
    });
    const body = (await res.text()).trim();
    if (!body) throw new Error(`the maintenance host answered ${res.status} with an empty body`);

    const innerJws = decryptJwe(body, this.config.privateKeyPem);
    const claims = verifyJws(innerJws, this.config.partnerPublicKeyPem);

    const respCode = typeof claims.respCode === 'string' ? claims.respCode : '';
    return {
      /**
       * `00` is success on THIS API and `0000` is success on the payment one.
       * Two different vocabularies on two different hosts, which is exactly the
       * kind of thing that becomes a silent bug when one function reads both.
       */
      state: respCode === '00' ? (processType === 'R' ? 'refunded' : 'cancelled') : stateForRespCode(respCode),
      respCode,
      respDesc: typeof claims.respDesc === 'string' ? claims.respDesc : null,
      providerRefundRef:
        typeof claims.refundReferenceNo === 'string'
          ? claims.refundReferenceNo
          : typeof claims.referenceNo === 'string'
            ? claims.referenceNo
            : null,
    };
  }
}

/** `ddmmyyhhmmss`, the maintenance request's own timestamp. */
function stamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${p(at.getUTCDate())}${p(at.getUTCMonth() + 1)}${p(at.getUTCFullYear() % 100)}` +
    `${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`
  );
}

const b64u = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

// --- JWS, PS256 --------------------------------------------------------------

export function signJws(claims: Record<string, unknown>, privateKeyPem: string): string {
  const header = b64u(JSON.stringify({ alg: 'PS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify(claims));
  const signature = signWithKey('sha256', Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey(privateKeyPem),
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return `${header}.${payload}.${b64u(signature)}`;
}

export function verifyJws(compact: string, publicKeyPem: string): Record<string, unknown> {
  const parts = compact.split('.');
  if (parts.length !== 3) throw new Error('the maintenance answer is not a compact JWS');
  const [header, payload, signature] = parts as [string, string, string];
  const alg = (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: unknown }).alg;
  if (alg !== 'PS256') throw new Error(`the maintenance answer is signed ${String(alg)}, not PS256`);
  const ok = verifyWithKey(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    {
      key: createPublicKey(publicKeyPem),
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
    Buffer.from(signature, 'base64url'),
  );
  // Same order as the HS256 envelope: refused before the claims are read.
  if (!ok) throw new Error('the maintenance answer carries a bad signature');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

// --- JWE, RSA-OAEP + A256GCM -------------------------------------------------

/**
 * Compact serialisation: `header.encryptedKey.iv.ciphertext.tag`.
 *
 * `alg: RSA-OAEP` is OAEP with **SHA-1**, which is what RFC 7518 names and
 * what `RSA_PKCS1_OAEP_PADDING` does by default. `RSA-OAEP-256` would be the
 * SHA-256 variant and is a different `alg` value; the document names the
 * former, so the former is what is sent.
 */
export function encryptJwe(plaintext: string, publicKeyPem: string): string {
  const header = b64u(JSON.stringify({ alg: 'RSA-OAEP', enc: 'A256GCM' }));
  const cek = randomBytes(32);
  const iv = randomBytes(12);
  const encryptedKey = publicEncrypt(
    { key: createPublicKey(publicKeyPem), padding: constants.RSA_PKCS1_OAEP_PADDING },
    cek,
  );
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  // The protected header is the additional authenticated data, as ASCII of its
  // own base64url form — not as the decoded JSON.
  cipher.setAAD(Buffer.from(header, 'ascii'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [header, b64u(encryptedKey), b64u(iv), b64u(ciphertext), b64u(cipher.getAuthTag())].join('.');
}

export function decryptJwe(compact: string, privateKeyPem: string): string {
  const parts = compact.split('.');
  if (parts.length !== 5) throw new Error('the maintenance answer is not a compact JWE');
  const [header, encryptedKey, iv, ciphertext, tag] = parts as [string, string, string, string, string];
  const parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
    alg?: unknown;
    enc?: unknown;
  };
  if (parsed.alg !== 'RSA-OAEP' || parsed.enc !== 'A256GCM') {
    throw new Error(`the maintenance answer is ${String(parsed.alg)}/${String(parsed.enc)}`);
  }
  const cek = privateDecrypt(
    { key: createPrivateKey(privateKeyPem), padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(encryptedKey, 'base64url'),
  );
  const decipher = createDecipheriv('aes-256-gcm', cek, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(header, 'ascii'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
