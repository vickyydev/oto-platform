/* global AbortSignal */
// Sandbox probe for the till's PromptPay QR mint (SCRUM-685).
//
//   node scripts/agent/probe-2c2p.mjs
//
// From the repo root, locally or on the api image, for example as a one-off
// job on staging:
//
//   node scripts/agent/render.mjs job "node scripts/agent/probe-2c2p.mjs"
//
// It mints a Payment Token for a 1 THB test, calls Do Payment the way
// packages/payments-2c2p/src/twoc2p.ts does (plain JSON, qrType from
// PGW_QR_TYPE, RAW by default), then asks Payment Inquiry once. Token and
// Inquiry go in the signed {"payload": "<jwt>"} envelope and their answers
// are verified before they are read.
//
// WHAT IT PRINTS, AND NOTHING ELSE: the response codes, how each answer
// arrived (signed or plain), whether a RAW QR string came back with its length
// and whether its EMVCo CRC holds, the pending state, and the first two
// characters of the merchant id. Never a key, a token, a full merchant id, the
// QR string or a response body.
//
// SANDBOX ONLY. It refuses PGW_ENV=production and the production host. The
// QR is never paid: nobody scans it, and the sandbox cannot simulate a payment
// (supportPaySimulate is false), so pending is the expected end state. No
// backendReturnUrl is sent, so staging's webhook hears nothing about it.
//
// Environment, read from the process only (no .env file is loaded):
//   PGW_MERCHANT_ID, PGW_SECRET_KEY     required
//   PGW_ENV                             sandbox (default); production is refused
//   PGW_BASE_URL                        empty uses the sandbox host
//   PGW_CURRENCY_CODE                   THB
//   PGW_QR_CHANNEL_CODE                 PPQR
//   PGW_QR_TYPE                         RAW
//
// Plain Node 22: fetch and node:crypto, no workspace imports, no build step.
// The HS256 envelope and the CRC are copied from packages/payments-2c2p
// (envelope.ts, emvco.ts) so this file runs on its own.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const API_VERSION = '4.3';
const SANDBOX_HOST = 'https://sandbox-pgw.2c2p.com';
const PRODUCTION_HOSTNAME = 'pgw.2c2p.com';
const TIMEOUT_MS = 15_000;
const AMOUNT = '1.00000'; // 1 THB, D(12,5)
const EXPIRY_MINUTES = 5;

const env = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;

function refuse(message) {
  console.log(`refused: ${message}`);
  process.exit(2);
}

const merchantId = env('PGW_MERCHANT_ID');
const secretKey = env('PGW_SECRET_KEY');
const missing = [
  ['PGW_MERCHANT_ID', merchantId],
  ['PGW_SECRET_KEY', secretKey],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length > 0) refuse(`${missing.join(' and ')} not set in the environment`);

const environment = env('PGW_ENV', 'sandbox');
if (environment !== 'sandbox') refuse(`PGW_ENV is ${environment}; this probe runs against the sandbox only`);

const host = env('PGW_BASE_URL', SANDBOX_HOST).replace(/\/+$/, '');
let hostname;
try {
  hostname = new URL(host).hostname;
} catch {
  refuse('PGW_BASE_URL is not a URL');
}
if (hostname === PRODUCTION_HOSTNAME) refuse('PGW_BASE_URL names the production host');

const currencyCode = env('PGW_CURRENCY_CODE', 'THB');
const channelCode = env('PGW_QR_CHANNEL_CODE', 'PPQR');
const qrType = env('PGW_QR_TYPE', 'RAW');

// --- the HS256 envelope, as packages/payments-2c2p/src/envelope.ts ----------

const b64url = (input) => Buffer.from(input).toString('base64url');
const mac = (input) => createHmac('sha256', secretKey).update(input).digest('base64url');

function signJwt(claims) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  return `${header}.${payload}.${mac(`${header}.${payload}`)}`;
}

/** Verify, then decode. Throws a message that never quotes the token. */
function verifyJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('signed answer is malformed');
  const [header, payload, signature] = parts;
  let alg;
  try {
    alg = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')).alg;
  } catch {
    throw new Error('signed answer is malformed');
  }
  if (alg !== 'HS256') throw new Error('signed answer is not HS256');
  const expected = Buffer.from(mac(`${header}.${payload}`), 'base64url');
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('signed answer failed its signature check');
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    // Our own words: the parser's message would quote the signed claims.
    throw new Error('signed answer is not JSON');
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Error('signed answer is not an object');
  }
  return claims;
}

// --- the EMVCo CRC, as packages/payments-2c2p/src/emvco.ts -------------------

function crc16(input) {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i += 1) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function emvcoCrcIsValid(payload) {
  if (payload.length < 8) return false;
  const body = payload.slice(0, -4);
  return body.endsWith('6304') && crc16(body) === payload.slice(-4);
}

// --- the wire ------------------------------------------------------------------

/**
 * One POST. `wire` is how the request goes out. A payload on the answer is
 * always verified before it is read. A plain-JSON answer is returned as
 * `answer: 'plain'`; only Do Payment's is believed, and for a signed call the
 * caller prints its respCode (how the gateway reports a malformed request) and
 * stops.
 */
async function post(path, claims, wire) {
  const res = await fetch(`${host}/payment/${API_VERSION}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(wire === 'signed' ? { payload: signJwt(claims) } : claims),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} answered http ${res.status} with something that is not JSON`);
  }
  const jwt = body && typeof body === 'object' && typeof body.payload === 'string' ? body.payload : '';
  if (jwt) return { http: res.status, answer: 'signed', claims: verifyJwt(jwt) };
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return { http: res.status, answer: 'plain', claims: body };
  }
  throw new Error(`${path} answered http ${res.status} with JSON that is not an object`);
}

/** A signed call answered in plain JSON: its code is printed, nothing else is believed. */
function unsignedAnswer(label, result) {
  line(label, { http: result.http, respCode: code(result.claims), answer: 'plain (refused: not signed)' });
}

const str = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
const code = (claims) => str(claims.respCode) ?? (typeof claims.respCode === 'number' ? String(claims.respCode) : '-');

/** `yyyy-MM-dd HH:mm:ss` in Asia/Bangkok (+07:00, no daylight saving), as config.ts. */
function bangkokWallClock(at) {
  const local = new Date(at.getTime() + 7 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())} ` +
    `${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}`
  );
}

/** Twenty alphanumerics at most for a QR invoice: PRB + yyMMddHHmmss + four digits. */
function probeInvoiceNo(now) {
  const stamp = bangkokWallClock(now).replace(/\D/g, '').slice(2);
  const tail = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  return `PRB${stamp}${tail}`;
}

/** Where the QR is in a Do Payment answer, as twoc2p.ts reads it. */
function rawQrOf(claims) {
  const extras = claims.extras && typeof claims.extras === 'object' ? claims.extras : {};
  const isRaw = (str(claims.type) ?? '').toUpperCase() === 'RAW';
  return isRaw ? (str(claims.data) ?? str(extras.qrData)) : str(extras.qrData);
}

const PENDING_WORDS = {
  '1005': 'qr shown, waiting for a scan',
  '0001': 'pending',
  '2000': 'pending',
  '2001': 'pending',
  '0000': 'PAID (not expected on the sandbox)',
  '2002': 'not found',
};

const masked = `${merchantId.slice(0, 2)}***`;
const line = (label, fields) =>
  console.log(`${label.padEnd(15)}${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('  ')}`);

async function main() {
  line('2c2p probe', { env: environment, host: hostname, api: API_VERSION, merchant: masked });

  const now = new Date();
  const invoiceNo = probeInvoiceNo(now);
  const expiry = bangkokWallClock(new Date(now.getTime() + EXPIRY_MINUTES * 60_000));

  const token = await post(
    'paymentToken',
    {
      merchantID: merchantId,
      invoiceNo,
      description: 'OTO till QR probe',
      amount: AMOUNT,
      currencyCode,
      paymentExpiry: expiry,
      userDefined1: 'scrum-685-probe',
      idempotencyID: randomUUID(),
    },
    'signed',
  );
  if (token.answer !== 'signed') {
    unsignedAnswer('paymentToken', token);
    line('result', { ok: 'no', reason: 'the token answer was not signed' });
    return 1;
  }
  const tokenCode = code(token.claims);
  line('paymentToken', { http: token.http, respCode: tokenCode, answer: token.answer });
  const paymentToken = str(token.claims.paymentToken);
  if (tokenCode !== '0000' || !paymentToken) {
    line('result', { ok: 'no', reason: 'the token did not mint' });
    return 1;
  }

  const payment = await post(
    'payment',
    {
      paymentToken,
      payment: {
        code: { channelCode },
        data: { qrType, paymentExpiry: expiry },
      },
    },
    'plain',
  );
  const paymentCode = code(payment.claims);
  const qr = rawQrOf(payment.claims);
  line('doPayment', {
    http: payment.http,
    respCode: paymentCode,
    answer: payment.answer,
    qrType,
    type: str(payment.claims.type) ?? '-',
    rawQr: qr ? 'yes' : 'no',
    rawQrLength: qr ? qr.length : 0,
    emvcoCrc: qr ? (emvcoCrcIsValid(qr) ? 'valid' : 'invalid') : '-',
  });

  let inquiryCode = '-';
  try {
    const inquiry = await post('paymentInquiry', { merchantID: merchantId, invoiceNo }, 'signed');
    if (inquiry.answer === 'signed') {
      inquiryCode = code(inquiry.claims);
      line('paymentInquiry', { http: inquiry.http, respCode: inquiryCode, answer: inquiry.answer });
    } else {
      unsignedAnswer('paymentInquiry', inquiry);
    }
  } catch (err) {
    line('paymentInquiry', { error: safeMessage(err) });
  }

  line('state', {
    doPayment: PENDING_WORDS[paymentCode] ?? 'other',
    inquiry: PENDING_WORDS[inquiryCode] ?? (inquiryCode === '-' ? '-' : 'other'),
  });

  const ok = paymentCode === '1005' && Boolean(qr);
  line('result', ok ? { ok: 'yes', reason: 'a RAW QR string came back, pending a scan' } : { ok: 'no', reason: 'no RAW QR on Do Payment' });
  return ok ? 0 : 1;
}

/** Our own messages, or the error's class and a network cause code. Never a body. */
function safeMessage(err) {
  if (!(err instanceof Error)) return 'unknown error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `timed out after ${TIMEOUT_MS} ms`;
  const causeCode = err.cause?.code ?? err.cause?.errors?.[0]?.code;
  const cause = typeof causeCode === 'string' ? ` (${causeCode})` : '';
  return err.message.startsWith('fetch failed') ? `network: fetch failed${cause}` : err.message;
}

main().then(
  (exitCode) => process.exit(exitCode),
  (err) => {
    line('result', { ok: 'no', error: safeMessage(err) });
    process.exit(1);
  },
);
