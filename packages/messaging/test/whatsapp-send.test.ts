import { describe, expect, it } from 'vitest';
import { ChannelError, type OutboundMessage } from '../src/contract';
import {
  WhatsAppCloudChannel,
  buildMediaMetadataRequest,
  buildSendRequest,
  type WhatsAppCloudConfig,
} from '../src/whatsapp-cloud';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, fakeFetch, fixtureJson } from './support';

const NOW = new Date('2026-10-20T03:00:00.000Z');
const HOUR = 3_600_000;
const CFG: WhatsAppCloudConfig = {
  appSecret: APP_SECRET,
  verifyToken: VERIFY_TOKEN,
  accessToken: 'test-token',
  phoneNumberId: PHONE_NUMBER_ID,
};
const MESSAGES_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

function msg(
  content: OutboundMessage['content'],
  extra: Partial<OutboundMessage> = {},
): OutboundMessage {
  return {
    clientRef: '0199f000-0000-7000-8000-00000000000a',
    to: { handle: '66800000001', phone: '+66800000001' },
    content,
    lastCustomerMessageAt: new Date(NOW.getTime() - HOUR),
    ...extra,
  };
}

describe('the send request, built', () => {
  it('builds a text message with our client reference', () => {
    expect(buildSendRequest(msg({ kind: 'text', text: 'We open at 10:00.' }), CFG)).toEqual({
      url: MESSAGES_URL,
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '66800000001',
        biz_opaque_callback_data: '0199f000-0000-7000-8000-00000000000a',
        type: 'text',
        text: { body: 'We open at 10:00.', preview_url: false },
      },
    });
  });

  it('builds a template with positional body parameters', () => {
    const req = buildSendRequest(
      msg({
        kind: 'template',
        name: 'out_of_hours',
        language: 'th',
        bodyParameters: ['10:00', '20:00'],
      }),
      CFG,
    );
    expect(req.body).toMatchObject({
      type: 'template',
      template: {
        name: 'out_of_hours',
        language: { code: 'th' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '10:00' },
              { type: 'text', text: '20:00' },
            ],
          },
        ],
      },
    });
  });

  it('leaves components off a template with no parameters', () => {
    const req = buildSendRequest(msg({ kind: 'template', name: 'welcome', language: 'en' }), CFG);
    expect(req.body?.['template']).toEqual({ name: 'welcome', language: { code: 'en' } });
  });

  it('builds media by id or link: a caption except on audio, a filename only on a document', () => {
    expect(
      buildSendRequest(
        msg({
          kind: 'media',
          mediaType: 'document',
          link: 'https://example.test/b.pdf',
          caption: 'Packages',
          filename: 'packages.pdf',
        }),
        CFG,
      ).body,
    ).toMatchObject({
      type: 'document',
      document: {
        link: 'https://example.test/b.pdf',
        caption: 'Packages',
        filename: 'packages.pdf',
      },
    });
    expect(
      buildSendRequest(
        msg({
          kind: 'media',
          mediaType: 'audio',
          providerMediaId: '42',
          caption: 'dropped',
          filename: 'dropped',
        }),
        CFG,
      ).body,
    ).toMatchObject({ type: 'audio', audio: { id: '42' } });
    expect(
      buildSendRequest(
        msg({ kind: 'media', mediaType: 'audio', providerMediaId: '42', caption: 'dropped' }),
        CFG,
      ).body?.['audio'],
    ).toEqual({ id: '42' });
  });

  it('quotes the message replied to', () => {
    expect(
      buildSendRequest(msg({ kind: 'text', text: 'Yes' }, { replyToExternalId: 'wamid.X' }), CFG)
        .body,
    ).toMatchObject({
      context: { message_id: 'wamid.X' },
    });
  });

  it('falls back from a non-numeric handle to the E.164 phone, and refuses a message with neither', () => {
    expect(
      buildSendRequest(
        msg({ kind: 'text', text: 'x' }, { to: { handle: 'ig:abc', phone: '+66800000009' } }),
        CFG,
      ).body,
    ).toMatchObject({
      to: '66800000009',
    });
    expect(() =>
      buildSendRequest(
        msg({ kind: 'text', text: 'x' }, { to: { handle: 'ig:abc', phone: null } }),
        CFG,
      ),
    ).toThrow(ChannelError);
  });

  it('builds the media lookup against the media id, scoped to our number', () => {
    expect(buildMediaMetadataRequest('300000000000001', CFG)).toEqual({
      url: `https://graph.facebook.com/v21.0/300000000000001?phone_number_id=${PHONE_NUMBER_ID}`,
      method: 'GET',
      headers: { authorization: 'Bearer test-token' },
      body: null,
    });
  });
});

describe('send, against recorded answers', () => {
  const adapter = (answers: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(answers);
    return {
      ch: new WhatsAppCloudChannel(CFG, { fetch: f.fetch, now: () => NOW }),
      calls: f.calls,
    };
  };

  it('returns the wamid when Meta accepts', async () => {
    const { ch, calls } = adapter([{ status: 200, json: fixtureJson('send-response-ok') }]);
    expect(await ch.send(msg({ kind: 'text', text: 'Hi' }))).toEqual({
      ok: true,
      externalMessageId: 'wamid.FIXTURE.OUT.0003',
      acceptedAt: NOW,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: MESSAGES_URL,
      method: 'POST',
      body: { to: '66800000001', type: 'text' },
    });
  });

  it('refuses free text outside the 24-hour window without calling Meta, and lets a template through', async () => {
    const { ch, calls } = adapter([{ status: 200, json: fixtureJson('send-response-ok') }]);
    const stale = new Date(NOW.getTime() - 24 * HOUR);
    expect(
      await ch.send(msg({ kind: 'text', text: 'Hi' }, { lastCustomerMessageAt: stale })),
    ).toMatchObject({
      ok: false,
      refusal: 'TEMPLATE_REQUIRED',
      retryable: false,
    });
    expect(calls).toHaveLength(0);
    expect(
      await ch.send(
        msg(
          { kind: 'template', name: 'welcome', language: 'en' },
          { lastCustomerMessageAt: stale },
        ),
      ),
    ).toMatchObject({
      ok: true,
    });
  });

  it('maps Meta’s re-engagement error to OUT_OF_WINDOW', async () => {
    const { ch } = adapter([{ status: 400, json: fixtureJson('send-response-error-131047') }]);
    expect(await ch.send(msg({ kind: 'text', text: 'Hi' }))).toEqual({
      ok: false,
      refusal: 'OUT_OF_WINDOW',
      retryable: false,
      providerCode: '131047',
      detail: 'OAuthException',
    });
  });

  it('maps a throughput limit to a retryable RATE_LIMITED', async () => {
    const { ch } = adapter([{ status: 400, json: fixtureJson('send-response-error-rate') }]);
    expect(await ch.send(msg({ kind: 'text', text: 'Hi' }))).toMatchObject({
      refusal: 'RATE_LIMITED',
      retryable: true,
      providerCode: '130429',
    });
  });

  it('maps a refused token to REJECTED, for good', async () => {
    const { ch } = adapter([{ status: 401, json: fixtureJson('send-response-error-token') }]);
    expect(await ch.send(msg({ kind: 'text', text: 'Hi' }))).toMatchObject({
      refusal: 'REJECTED',
      retryable: false,
      providerCode: '190',
    });
  });

  it('maps no answer, and a 5xx with no body, to a retryable UNREACHABLE', async () => {
    const { ch } = adapter(['network-error', { status: 503 }]);
    expect(await ch.send(msg({ kind: 'text', text: 'Hi' }))).toMatchObject({
      refusal: 'UNREACHABLE',
      retryable: true,
      providerCode: null,
    });
    expect(await ch.send(msg({ kind: 'text', text: 'Hi' }))).toMatchObject({
      refusal: 'UNREACHABLE',
      retryable: true,
      providerCode: 'http_503',
    });
  });

  it('refuses an unbuildable message without calling Meta', async () => {
    const { ch, calls } = adapter([]);
    expect(
      await ch.send(
        msg({ kind: 'media', mediaType: 'image', providerMediaId: '1', link: 'https://x.test/a' }),
      ),
    ).toMatchObject({
      refusal: 'REJECTED',
    });
    expect(
      await ch.send(msg({ kind: 'text', text: 'x' }, { to: { handle: '', phone: null } })),
    ).toMatchObject({ refusal: 'REJECTED' });
    expect(calls).toHaveLength(0);
  });
});

describe('the two-step media download', () => {
  it('looks the id up, then downloads from Meta’s media host with the token', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const f = fakeFetch([
      { status: 200, json: fixtureJson('media-metadata') },
      { status: 200, bytes },
    ]);
    const ch = new WhatsAppCloudChannel(CFG, { fetch: f.fetch });
    const media = await ch.fetchMedia({ providerMediaId: '300000000000001' });
    expect(media.contentType).toBe('image/jpeg');
    expect([...media.bytes]).toEqual([1, 2, 3, 4]);
    expect(f.calls.map((c) => c.url)).toEqual([
      `https://graph.facebook.com/v21.0/300000000000001?phone_number_id=${PHONE_NUMBER_ID}`,
      (fixtureJson('media-metadata') as { url: string }).url,
    ]);
    expect(f.calls[1]!.headers).toEqual({ authorization: 'Bearer test-token' });
  });

  it('never sends the token to a host that is not Meta’s', async () => {
    const f = fakeFetch([
      { status: 200, json: { url: 'https://evil.example/steal', mime_type: 'image/jpeg' } },
    ]);
    const ch = new WhatsAppCloudChannel(CFG, { fetch: f.fetch });
    await expect(ch.fetchMedia({ providerMediaId: '1' })).rejects.toMatchObject({
      code: 'MEDIA_FETCH_FAILED',
    });
    expect(f.calls).toHaveLength(1);
  });

  it('answers MEDIA_NOT_FOUND for an id Meta does not know', async () => {
    const f = fakeFetch([{ status: 404, json: {} }]);
    const ch = new WhatsAppCloudChannel(CFG, { fetch: f.fetch });
    await expect(ch.fetchMedia({ providerMediaId: '1' })).rejects.toMatchObject({
      code: 'MEDIA_NOT_FOUND',
    });
  });
});

describe('identity and health', () => {
  it('speaks for its phone-number id, with a 24-hour window', () => {
    const ch = new WhatsAppCloudChannel(CFG);
    expect(ch.identity).toEqual({
      provider: 'meta_cloud',
      channel: 'whatsapp',
      externalId: PHONE_NUMBER_ID,
      displayName: 'WhatsApp',
    });
    expect(ch.capabilities).toEqual({ reply: true, media: true, freeTextWindowHours: 24 });
  });

  it('reads the number’s record as active, and a refused token as error', async () => {
    const f = fakeFetch([
      {
        status: 200,
        json: { verified_name: 'Fictional Park', quality_rating: 'GREEN', id: PHONE_NUMBER_ID },
      },
      { status: 401, json: fixtureJson('send-response-error-token') },
      'network-error',
    ]);
    const ch = new WhatsAppCloudChannel(CFG, { fetch: f.fetch, now: () => NOW });
    expect(await ch.health()).toEqual({
      status: 'active',
      checkedAt: NOW,
      detail: 'quality rating GREEN',
    });
    expect(await ch.health()).toEqual({
      status: 'error',
      checkedAt: NOW,
      detail: 'the access token was refused',
    });
    expect(await ch.health()).toEqual({
      status: 'error',
      checkedAt: NOW,
      detail: 'the Graph API did not answer',
    });
  });

  it('cannot be constructed without its four settings', () => {
    expect(() => new WhatsAppCloudChannel({ ...CFG, accessToken: '' })).toThrow(/accessToken/);
  });
});
