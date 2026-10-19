import { describe, expect, it } from 'vitest';
import { ChannelError } from '../src/contract';
import { WhatsAppCloudChannel, parseWhatsAppPayload } from '../src/whatsapp-cloud';
import { signMetaPayload } from '../src/webhook';
import { APP_SECRET, PHONE_NUMBER_ID, VERIFY_TOKEN, fixtureJson, signedDelivery } from './support';

const channel = new WhatsAppCloudChannel(
  {
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    accessToken: 'test-token',
    phoneNumberId: PHONE_NUMBER_ID,
  },
  { now: () => new Date('2026-10-20T03:00:00.000Z') },
);
const parse = (name: string) => channel.parseWebhook(signedDelivery(name));

describe('inbound messages, normalised', () => {
  it('reads a text message: handle, E.164 phone, name, words, time and the dedupe id', () => {
    expect(parse('inbound-text')).toEqual([
      {
        kind: 'message',
        providerEventId: 'msg:wamid.FIXTURE.TEXT.0001',
        channelExternalId: PHONE_NUMBER_ID,
        externalMessageId: 'wamid.FIXTURE.TEXT.0001',
        handle: '66800000001',
        displayName: 'Fictional Parent A',
        phone: '+66800000001',
        type: 'text',
        text: 'Hello, what time do you open on Saturday?',
        media: [],
        replyToExternalId: null,
        timestamp: new Date(1760925600 * 1000),
        hint: null,
      },
    ]);
  });

  it('reads an image as a media ref, with its caption as the text', () => {
    const [e] = parse('inbound-image');
    expect(e).toMatchObject({
      kind: 'message',
      type: 'image',
      text: 'Is this the birthday room?',
      media: [
        {
          kind: 'image',
          providerMediaId: '300000000000001',
          mimeType: 'image/jpeg',
          sha256: 'Zml4dHVyZS1kaWdlc3Qtbm90LWEtcmVhbC1maWxl',
          caption: 'Is this the birthday room?',
          filename: null,
          voice: false,
        },
      ],
    });
  });

  it('marks a recorded voice note apart from an audio file', () => {
    const [e] = parse('inbound-voice');
    expect(e).toMatchObject({
      type: 'audio',
      text: null,
      media: [{ kind: 'audio', voice: true, mimeType: 'audio/ogg; codecs=opus' }],
    });
  });

  it('keeps a document filename', () => {
    const [e] = parse('inbound-document');
    expect(e).toMatchObject({
      type: 'document',
      media: [{ kind: 'document', filename: 'class-list.pdf' }],
    });
  });

  it('reads a button reply as its title, and the quoted message', () => {
    const [e] = parse('inbound-interactive-reply');
    expect(e).toMatchObject({
      type: 'interactive',
      text: 'Central',
      replyToExternalId: 'wamid.FIXTURE.OUT.0001',
    });
  });

  it('splits a batched delivery into one event per message, each with its own sender name', () => {
    const events = parse('inbound-batch');
    expect(
      events.map((e) => (e.kind === 'message' ? [e.handle, e.displayName, e.phone] : null)),
    ).toEqual([
      ['66800000005', 'Fictional Parent E', '+66800000005'],
      ['79000000006', 'Fictional Parent F', '+79000000006'],
    ]);
  });

  it('keeps an unsupported message as a message, so the customer still reopens the thread', () => {
    const [e] = parse('inbound-unsupported');
    expect(e).toMatchObject({ kind: 'message', type: 'unsupported', text: null, media: [] });
  });

  it('never takes a classification hint from a live delivery', () => {
    const body = fixtureJson('inbound-text') as {
      entry: { changes: { value: { messages: Record<string, unknown>[] } }[] }[];
    };
    body.entry[0]!.changes[0]!.value.messages[0]!['oto_hint'] = { category: 'marketing' };
    const [e] = parseWhatsAppPayload(body);
    expect(e).toMatchObject({ kind: 'message', hint: null });
  });
});

describe('status callbacks', () => {
  it('gives each step of one message its own dedupe id, and echoes our client reference', () => {
    const events = parse('status-sent-delivered-read');
    expect(
      events.map((e) =>
        e.kind === 'status' ? [e.providerEventId, e.status, e.clientRef, e.error] : null,
      ),
    ).toEqual([
      ['status:wamid.FIXTURE.OUT.0001:sent', 'sent', '0199f000-0000-7000-8000-000000000001', null],
      [
        'status:wamid.FIXTURE.OUT.0001:delivered',
        'delivered',
        '0199f000-0000-7000-8000-000000000001',
        null,
      ],
      ['status:wamid.FIXTURE.OUT.0001:read', 'read', '0199f000-0000-7000-8000-000000000001', null],
    ]);
    expect(events[2]).toMatchObject({
      externalMessageId: 'wamid.FIXTURE.OUT.0001',
      recipientHandle: '66800000001',
      timestamp: new Date(1760926030 * 1000),
    });
  });

  it('reads a failure as a refusal word, keeping the provider code for the ops row', () => {
    const [e] = parse('status-failed');
    expect(e).toMatchObject({
      kind: 'status',
      status: 'failed',
      clientRef: '0199f000-0000-7000-8000-000000000002',
      error: { refusal: 'OUT_OF_WINDOW', providerCode: '131047', title: 'Re-engagement message' },
    });
  });
});

describe('what the parser does not read', () => {
  it('records a change it does not read as an unknown event with a stable id', () => {
    const a = parse('account-update');
    const b = parse('account-update');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      kind: 'unknown',
      field: 'account_update',
      channelExternalId: null,
    });
    expect(a[0]!.providerEventId).toBe(b[0]!.providerEventId);
  });

  it('throws on a body that is not a WhatsApp delivery at all', () => {
    expect(() => parseWhatsAppPayload({ object: 'page', entry: [] })).toThrow(ChannelError);
    expect(() => parseWhatsAppPayload('nope')).toThrow(/not a WhatsApp/);
  });

  it('refuses to parse an unverified delivery: verify, then read', () => {
    try {
      channel.parseWebhook(signedDelivery('inbound-text', 'somebody-else'));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ChannelError);
      expect((err as ChannelError).code).toBe('UNVERIFIED');
    }
  });

  it('refuses a signed body that is not JSON', () => {
    const rawBody = 'not json';
    expect(() =>
      channel.parseWebhook({
        method: 'POST',
        headers: { 'x-hub-signature-256': signMetaPayload(rawBody, APP_SECRET) },
        query: {},
        rawBody,
      }),
    ).toThrow(/not JSON/);
  });

  it('falls back to the receive time for an unreadable timestamp, never an invalid date', () => {
    const body = fixtureJson('inbound-text') as {
      entry: { changes: { value: { messages: Record<string, unknown>[] } }[] }[];
    };
    body.entry[0]!.changes[0]!.value.messages[0]!['timestamp'] = 'soon';
    const receivedAt = new Date('2026-10-20T01:02:03.000Z');
    const [e] = parseWhatsAppPayload(body, { receivedAt });
    expect(e).toMatchObject({ timestamp: receivedAt });
  });
});
