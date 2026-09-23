/**
 * What the package needs to be configured with, and where the hosts come from.
 *
 * NO VALUE IN THIS FILE IS A CREDENTIAL and none is read from the environment
 * here: `apps/api/src/env.ts` parses the `PGW_*` variables and hands this
 * object over, so the package has no opinion about process state and its tests
 * mint their own synthetic keys. The hosts below are the only literals, and
 * they are published addresses (`PAYMENT_GATEWAY.md:65-90`).
 */

export type GatewayEnvironment = 'sandbox' | 'production';

/** `POST {host}/payment/4.3/…` — the version is fixed and the changelog's newest. */
export const PAYMENT_API_VERSION = '4.3';

export const PAYMENT_HOSTS: Record<GatewayEnvironment, string> = {
  sandbox: 'https://sandbox-pgw.2c2p.com',
  production: 'https://pgw.2c2p.com',
};

/**
 * Maintenance is A DIFFERENT HOST and a different crypto envelope — not a path
 * on the payment API. Getting this wrong produces a 404 that reads like a
 * refused refund (`PAYMENT_GATEWAY.md:74-75`, `:405-406`).
 */
export const MAINTENANCE_HOSTS: Record<GatewayEnvironment, string> = {
  sandbox: 'https://demo2.2c2p.com/PaymentAction/2.0/action',
  production: 'https://t.2c2p.com/PaymentAction/2.0/action',
};

export interface GatewayConfig {
  environment: GatewayEnvironment;
  /** Defaults from `environment`; overridden only to point at a mock. */
  baseUrl: string;
  merchantId: string;
  secretKey: string;
  currencyCode: string;
  /** `PPQR`. `THQR` is a CATEGORY code in the Payment Option answer and is wrong here. */
  qrChannelCode: string;
  /** `RAW`, so the display renders the payload itself and never fetches an image. */
  qrType: 'ALL' | 'RAW' | 'BASE64' | 'URL';
  paymentExpiryMinutes: number;
  /** Where 2C2P posts the notification. Empty is a valid local configuration. */
  backendReturnUrl?: string;
  frontendReturnUrl?: string;
  maintenance?: MaintenanceConfig;
}

export interface MaintenanceConfig {
  baseUrl: string;
  /** Our RSA private key, PEM: decrypts 2C2P's JWE and signs our JWS PS256. */
  privateKeyPem: string;
  /** 2C2P's RSA public key, PEM: encrypts our JWE and verifies their JWS. */
  partnerPublicKeyPem: string;
}

export function paymentHostFor(environment: GatewayEnvironment, override?: string): string {
  return (override ?? '').trim() || PAYMENT_HOSTS[environment];
}

export function maintenanceHostFor(environment: GatewayEnvironment, override?: string): string {
  return (override ?? '').trim() || MAINTENANCE_HOSTS[environment];
}

/**
 * The wire's money format, and the only place a decimal string is produced.
 *
 * `D(12,5)` — `2500.90000` for ฿2,500.90. Built from the integer by digit
 * surgery rather than by dividing: `amountSatang / 100` on 2,500.90 is
 * 2500.8999999999996 in IEEE 754, and `toFixed(5)` on that is right by luck
 * rather than by construction. Nothing here ever holds a float.
 */
export function toWireAmount(amountSatang: number): string {
  if (!Number.isInteger(amountSatang) || amountSatang < 0) {
    throw new Error(`an amount on the wire has to be whole satang, not ${amountSatang}`);
  }
  const baht = Math.trunc(amountSatang / 100);
  const satang = amountSatang % 100;
  return `${baht}.${String(satang).padStart(2, '0')}000`;
}

/**
 * The wire's money format, read back to satang.
 *
 * Deliberately string surgery again, and deliberately strict: a value this
 * cannot read answers null, and `gateway.ts` treats an unreadable amount as a
 * mismatch rather than as agreement. A notification that cannot be compared is
 * not a notification that agrees.
 */
export function fromWireAmount(value: unknown): number | null {
  if (typeof value === 'number') {
    // A JSON number. Rounded, because 2500.9 has no exact binary form and the
    // only question is which whole satang it meant.
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,12})(?:\.(\d{1,5}))?$/.exec(value.trim());
  if (!match) return null;
  const baht = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(5, '0');
  // Beyond two decimal places THB has no unit. A gateway sending 0.00500 is
  // sending half a satang, which cannot be recorded and must not be rounded
  // into existence.
  if (fraction.slice(2).replace(/0/g, '').length > 0) return null;
  return baht * 100 + Number(fraction.slice(0, 2));
}

/**
 * Thailand's offset, fixed. The country has kept +07:00 with no daylight
 * saving since 1952, which is why this is a constant and not a lookup.
 */
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * `yyyy-MM-dd HH:mm:ss`, which is what `paymentExpiry` takes — in the
 * MERCHANT'S wall clock, Asia/Bangkok.
 *
 * WHICH TIMEZONE 2C2P READS THIS IN IS NOT PRINTED ON THE PUBLIC DOCS, and the
 * choice is made in the fail-safe direction rather than left to chance. If
 * they read it as Bangkok time, which is what a Thai merchant account and a
 * Thai portal imply, it is exactly right. If they read it as UTC, the QR lives
 * seven hours longer on their side than we intended — harmless, because the
 * expiry the display and the poller obey is OURS (`payment_attempt.expires_at`),
 * and a late payment against an attempt we have already expired is the
 * `late_paid` case this slice handles anyway. Sending UTC would fail the other
 * way: a QR expiring seven hours before it was minted is a tender that cannot
 * be taken at all.
 *
 * Confirm it in the first sandbox session and delete this paragraph.
 */
export function formatPaymentExpiry(at: Date): string {
  const local = new Date(at.getTime() + BANGKOK_OFFSET_MS);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())} ` +
    `${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}`
  );
}
