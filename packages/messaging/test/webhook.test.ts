import { describe, expect, it } from 'vitest';
import { WhatsAppCloudChannel } from '../src/whatsapp-cloud';
import {
  deliveryIdOf,
  signMetaPayload,
  verifyMetaChallenge,
  verifyMetaDelivery,
} from '../src/webhook';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, fixtureBytes, signedDelivery } from './support';

const channel = () =>
  new WhatsAppCloudChannel({
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    accessToken: 'test-token',
    phoneNumberId: PHONE_NUMBER_ID,
  });

describe('X-Hub-Signature-256 verification', () => {
  it('accepts a delivery signed over its raw bytes with the app secret', () => {
    const verdict = channel().verifyWebhook(signedDelivery('inbound-text'));
    expect(verdict).toEqual({
      kind: 'delivery',
      ok: true,
      deliveryId: deliveryIdOf(fixtureBytes('inbound-text')),
    });
  });

  it('refuses a delivery signed with another secret', () => {
    const verdict = channel().verifyWebhook(signedDelivery('inbound-text', 'somebody-else'));
    expect(verdict).toMatchObject({ kind: 'delivery', ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('refuses a body changed by one byte after signing', () => {
    const req = signedDelivery('inbound-text');
    const tampered = Buffer.from(req.rawBody);
    tampered[tampered.indexOf('Saturday')] = 'M'.charCodeAt(0);
    expect(channel().verifyWebhook({ ...req, rawBody: tampered })).toMatchObject({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('refuses a body that was re-serialised: the signature is over the bytes sent, not the object', () => {
    const req = signedDelivery('inbound-text');
    const reserialised = JSON.stringify(JSON.parse(Buffer.from(req.rawBody).toString('utf8')));
    expect(channel().verifyWebhook({ ...req, rawBody: reserialised })).toMatchObject({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('names a missing and a malformed header apart', () => {
    const req = signedDelivery('inbound-text');
    expect(channel().verifyWebhook({ ...req, headers: {} })).toMatchObject({
      ok: false,
      reason: 'MISSING_SIGNATURE',
    });
    expect(
      channel().verifyWebhook({ ...req, headers: { 'x-hub-signature-256': 'sha1=abc' } }),
    ).toMatchObject({
      ok: false,
      reason: 'MALFORMED_SIGNATURE',
    });
  });

  it('reads the header in any case and as an array', () => {
    const req = signedDelivery('inbound-text');
    const sig = signMetaPayload(req.rawBody, APP_SECRET);
    expect(
      verifyMetaDelivery({ ...req, headers: { 'X-HUB-SIGNATURE-256': [sig] } }, APP_SECRET).ok,
    ).toBe(true);
  });

  it('refuses everything when no secret is configured, rather than accepting everything', () => {
    expect(verifyMetaDelivery(signedDelivery('inbound-text'), '')).toMatchObject({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });
});

describe('a replayed delivery', () => {
  /**
   * Meta's signature carries no timestamp, so a replay VERIFIES — by design,
   * since Meta itself retries the identical body. What stops it is the
   * ingest's unique receipt key, and these are the keys it will see.
   */
  it('verifies again, with the same delivery id and the same event ids, so the receipt insert is a no-op', () => {
    const ch = channel();
    const first = signedDelivery('inbound-batch');
    const replay = signedDelivery('inbound-batch');
    const a = ch.verifyWebhook(first);
    const b = ch.verifyWebhook(replay);
    expect(a.ok && b.ok).toBe(true);
    expect(a.kind === 'delivery' && b.kind === 'delivery' && a.deliveryId === b.deliveryId).toBe(
      true,
    );
    const ids = (r: typeof first) => ch.parseWebhook(r).map((e) => e.providerEventId);
    expect(ids(replay)).toEqual(ids(first));
    expect(ids(first)).toEqual(['msg:wamid.FIXTURE.BATCH.0001', 'msg:wamid.FIXTURE.BATCH.0002']);
  });

  it('gives two different deliveries different delivery ids', () => {
    expect(deliveryIdOf(fixtureBytes('inbound-text'))).not.toBe(
      deliveryIdOf(fixtureBytes('inbound-image')),
    );
  });
});

describe('the GET subscription challenge', () => {
  const q = (query: Record<string, string>) => ({ query });

  it('echoes hub.challenge for the configured verify token', () => {
    expect(
      verifyMetaChallenge(
        q({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        }),
        VERIFY_TOKEN,
      ),
    ).toEqual({ kind: 'challenge', ok: true, respondWith: '1158201444' });
  });

  it('refuses a wrong token, a wrong mode and a missing challenge', () => {
    expect(
      verifyMetaChallenge(
        q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' }),
        VERIFY_TOKEN,
      ),
    ).toMatchObject({ ok: false, reason: 'BAD_VERIFY_TOKEN' });
    expect(
      verifyMetaChallenge(
        q({ 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' }),
        VERIFY_TOKEN,
      ),
    ).toMatchObject({ ok: false, reason: 'BAD_MODE' });
    expect(
      verifyMetaChallenge(
        q({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN }),
        VERIFY_TOKEN,
      ),
    ).toMatchObject({
      ok: false,
      reason: 'MISSING_CHALLENGE',
    });
  });

  it('is what the adapter answers on a GET', () => {
    expect(
      channel().verifyWebhook({
        method: 'GET',
        headers: {},
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'abc',
        },
        rawBody: '',
      }),
    ).toEqual({ kind: 'challenge', ok: true, respondWith: 'abc' });
  });
});
