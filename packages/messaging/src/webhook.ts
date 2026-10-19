import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { RawWebhook, WebhookVerdict } from './contract';

/**
 * THE WEBHOOK ENVELOPE — Meta's, shared by the WhatsApp Cloud skeleton and the
 * simulator (plan §2.1: the simulator signs "in the same envelope shape the
 * WhatsApp parser reads", so a simulator press goes through the same verify
 * and parse as a real delivery, as the 2C2P simulator signs its own
 * notification).
 *
 * Meta signs every POST with `X-Hub-Signature-256: sha256=<hex>`, an
 * HMAC-SHA256 of the RAW BODY BYTES under the app secret. VERIFY, THEN READ:
 * the MAC is computed and compared before the body is parsed, so a forged
 * delivery never becomes an object this process reasons about.
 *
 * REPLAY. The signature carries no timestamp and no nonce — a captured
 * delivery verifies again for ever, and Meta itself retries the identical body
 * for up to seven days when we do not answer 200. Rejecting by age would lose
 * real messages. Replay is stopped one step later, by the ingest's unique
 * receipt key: `deliveryId` below for the whole delivery and each event's
 * `providerEventId` for what is inside it.
 *
 * NO LIBRARY: `node:crypto` has HMAC-SHA256 and a constant-time compare.
 */

export const SIGNATURE_HEADER = 'x-hub-signature-256';

export function headerOf(req: Pick<RawWebhook, 'headers'>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return typeof value === 'string' ? value : value[0];
  }
  return undefined;
}

export function bodyBytes(raw: string | Uint8Array): Buffer {
  return typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
}

/**
 * The identity of one DELIVERY: the SHA-256 of its raw bytes. Meta retries a
 * delivery byte for byte, so a retry has the same id. The ingest can key the
 * `webhook_receipt` on it where a delivery carries several events, and dedupe
 * each event on its own `providerEventId`.
 */
export function deliveryIdOf(raw: string | Uint8Array): string {
  return createHash('sha256').update(bodyBytes(raw)).digest('hex');
}

/** `sha256=<hex>` over the bytes. Used by the simulator to sign, and by tests to build signed fixtures. */
export function signMetaPayload(raw: string | Uint8Array, secret: string): string {
  if (!secret) throw new Error('no secret is configured to sign with');
  return `sha256=${createHmac('sha256', secret).update(bodyBytes(raw)).digest('hex')}`;
}

/** The POST half of `verifyWebhook` for any Meta-shaped channel. */
export function verifyMetaDelivery(req: RawWebhook, secret: string): WebhookVerdict {
  const deliveryId = deliveryIdOf(req.rawBody);
  const header = headerOf(req, SIGNATURE_HEADER);
  if (!header) return { kind: 'delivery', ok: false, reason: 'MISSING_SIGNATURE', deliveryId };
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return { kind: 'delivery', ok: false, reason: 'MALFORMED_SIGNATURE', deliveryId };
  if (!secret) return { kind: 'delivery', ok: false, reason: 'BAD_SIGNATURE', deliveryId };
  const expected = createHmac('sha256', secret).update(bodyBytes(req.rawBody)).digest();
  const given = Buffer.from(match[1]!.toLowerCase(), 'hex');
  const ok = given.length === expected.length && timingSafeEqual(given, expected);
  return ok
    ? { kind: 'delivery', ok: true, deliveryId }
    : { kind: 'delivery', ok: false, reason: 'BAD_SIGNATURE', deliveryId };
}

/**
 * The GET half: Meta's subscription challenge. `hub.mode=subscribe` and the
 * verify token we configured on the app answer with `hub.challenge` echoed as
 * the body; anything else is refused. The token is compared in constant time.
 */
export function verifyMetaChallenge(
  req: Pick<RawWebhook, 'query'>,
  verifyToken: string,
): WebhookVerdict {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode !== 'subscribe') return { kind: 'challenge', ok: false, reason: 'BAD_MODE' };
  if (!challenge) return { kind: 'challenge', ok: false, reason: 'MISSING_CHALLENGE' };
  const a = Buffer.from(token ?? '', 'utf8');
  const b = Buffer.from(verifyToken, 'utf8');
  if (!verifyToken || a.length !== b.length || !timingSafeEqual(a, b)) {
    return { kind: 'challenge', ok: false, reason: 'BAD_VERIFY_TOKEN' };
  }
  return { kind: 'challenge', ok: true, respondWith: challenge };
}

export function verifyMetaWebhook(
  req: RawWebhook,
  secrets: { appSecret: string; verifyToken: string },
): WebhookVerdict {
  return req.method === 'GET'
    ? verifyMetaChallenge(req, secrets.verifyToken)
    : verifyMetaDelivery(req, secrets.appSecret);
}
