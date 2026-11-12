import { describe, expect, it } from 'vitest';
import {
  ChannelConfigError,
  INBOX_ENV,
  parseAllowedNumbers,
  parsePublicOrigin,
  twilioConfigFrom,
  twilioVariables,
} from '../src/config';
import type { OutboundMessage, RawWebhook } from '../src/contract';
import {
  TWILIO_SANDBOX_NUMBER,
  TWIML_EMPTY,
  TwilioWhatsAppChannel,
  isOwnMediaUrl,
  parseTwilioForm,
  refusalForTwilioError,
  signedUrlCandidates,
  twilioSignature,
  type TwilioConfig,
  type TwilioFetch,
} from '../src/twilio';

/**
 * FIXTURE PROVENANCE (SCRUM-908). Every delivery below is written by hand from
 * the shapes Twilio documents (the adapter's header names the pages, read on
 * 12 November 2026): an incoming WhatsApp message is a form post with
 * `MessageSid`, `AccountSid`, `From`/`To` as `whatsapp:+…` addresses, `Body`,
 * `NumMedia`, `MediaUrl{N}`/`MediaContentType{N}`, `ProfileName`, `WaId`; a
 * status callback carries `MessageStatus` and `ErrorCode`. Nothing was
 * captured from a live account. Every number, SID and token is invented:
 * customers are +668987000NN, SIDs are runs of zeros, the token says it is
 * not real. No check here opens a socket: `fetch` and `sleep` are fakes.
 */

const SID = `AC${'0'.repeat(31)}1`;
const TOKEN = 'test-auth-token-not-a-real-one';
const ORIGIN = 'https://api.staging.example';
const PATH = '/webhooks/inbox/twilio/00000000-0000-7000-8000-000000000001';
const ALLOWED = '+66898700001';
const STRANGER = '+66898700002';
const SM = (n: number) => `SM${String(n).padStart(32, '0')}`;
const NOW = new Date('2026-11-12T05:00:00.000Z');

const config = (over: Partial<TwilioConfig> = {}): TwilioConfig => ({
  accountSid: SID,
  authToken: TOKEN,
  sender: TWILIO_SANDBOX_NUMBER,
  publicUrl: ORIGIN,
  webhookPath: PATH,
  allowedNumbers: [ALLOWED],
  ...over,
});

/** A form post signed as Twilio signs it: over the URL it called and every field. */
function delivery(fields: Array<[string, string]>, opts: { path?: string; token?: string; url?: string } = {}): RawWebhook {
  const path = opts.path ?? PATH;
  const body = new URLSearchParams(fields).toString();
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': twilioSignature(opts.token ?? TOKEN, opts.url ?? `${ORIGIN}${path}`, fields),
    },
    query: {},
    rawBody: Buffer.from(body, 'utf8'),
    publicPath: path,
  };
}

const inbound = (over: Record<string, string> = {}, from = ALLOWED): Array<[string, string]> =>
  Object.entries({
    SmsMessageSid: SM(1),
    NumMedia: '0',
    ProfileName: 'Fictional Tester',
    MessageType: 'text',
    SmsSid: SM(1),
    WaId: from.slice(1),
    SmsStatus: 'received',
    Body: 'Hello, what time do you open today?',
    To: `whatsapp:${TWILIO_SANDBOX_NUMBER}`,
    NumSegments: '1',
    ReferralNumMedia: '0',
    MessageSid: SM(1),
    AccountSid: SID,
    From: `whatsapp:${from}`,
    ApiVersion: '2010-04-01',
    ...over,
  });

function fakeFetch(answers: Array<{ status: number; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } | 'network-error'>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string; redirect?: string }> = [];
  const queue = [...answers];
  const fetch: TwilioFetch = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), ...(init.redirect ? { redirect: init.redirect } : {}) });
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error(`fakeFetch: no answer queued for ${url}`));
    if (next === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    const headers = new Map(Object.entries(next.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return Promise.resolve({
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      json: () => (next.json === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(next.json)),
      arrayBuffer: () => {
        const b = next.bytes ?? new Uint8Array();
        return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      },
    });
  };
  return { fetch, calls };
}

const channel = (over: Partial<TwilioConfig> = {}, deps: ConstructorParameters<typeof TwilioWhatsAppChannel>[1] = {}) =>
  new TwilioWhatsAppChannel(config(over), { now: () => NOW, sleep: () => Promise.resolve(), ...deps });

const textTo = (phone: string, text = 'We open at 10:00.'): OutboundMessage => ({
  clientRef: '00000000-0000-7000-8000-0000000000aa',
  to: { handle: phone.slice(1), phone },
  content: { kind: 'text', text },
  lastCustomerMessageAt: new Date(NOW.getTime() - 60_000),
});

describe('the Twilio signature (https://www.twilio.com/docs/usage/security)', () => {
  it("reproduces the documentation's own worked example", () => {
    expect(
      twilioSignature('12345', 'https://example.com/myapp.php?foo=1&bar=2', [
        ['Digits', '1234'],
        ['To', '+18005551212'],
        ['From', '+14158675310'],
        ['Caller', '+14158675310'],
        ['CallSid', 'CA1234567890ABCDE'],
      ]),
    ).toBe('L/OH5YylLD5NRKLltdqwSvS0BnU=');
  });

  it('verifies a delivery over the configured origin and the route path, never a header', () => {
    const c = channel();
    expect(c.verifyWebhook(delivery(inbound()))).toMatchObject({ kind: 'delivery', ok: true });
    // Signed for another host — what a forged Host header would claim.
    expect(c.verifyWebhook(delivery(inbound(), { url: `https://evil.example${PATH}` }))).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
    // Signed with another token.
    expect(c.verifyWebhook(delivery(inbound(), { token: 'another-token' }))).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('covers every field: one changed byte in the body fails', () => {
    const d = delivery(inbound());
    const tampered = { ...d, rawBody: Buffer.from(Buffer.from(d.rawBody as Buffer).toString('utf8').replace('open', 'shut')) };
    expect(channel().verifyWebhook(tampered)).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('accepts the default port written out, as Twilio keeps a port on an https callback', () => {
    expect(signedUrlCandidates(ORIGIN, PATH)).toEqual([`${ORIGIN}${PATH}`, `https://api.staging.example:443${PATH}`]);
    expect(channel().verifyWebhook(delivery(inbound(), { url: `https://api.staging.example:443${PATH}` }))).toMatchObject({ ok: true });
  });

  it('refuses a missing, a malformed and an unanchored signature, and a GET', () => {
    const d = delivery(inbound());
    const c = channel();
    expect(c.verifyWebhook({ ...d, headers: {} })).toMatchObject({ ok: false, reason: 'MISSING_SIGNATURE' });
    expect(c.verifyWebhook({ ...d, headers: { 'x-twilio-signature': 'not base64!' } })).toMatchObject({ ok: false, reason: 'MALFORMED_SIGNATURE' });
    const { publicPath: _dropped, ...noPath } = d;
    expect(c.verifyWebhook(noPath)).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(c.verifyWebhook({ ...d, method: 'GET' })).toEqual({ kind: 'challenge', ok: false, reason: 'BAD_MODE' });
  });

  it('never parses an unverified body', () => {
    expect(() => channel().parseWebhook(delivery(inbound(), { token: 'x' }))).toThrow(/signature/);
  });

  it('is the same delivery id for the same bytes', () => {
    const a = channel().verifyWebhook(delivery(inbound()));
    const b = channel().verifyWebhook(delivery(inbound()));
    expect(a.kind === 'delivery' && b.kind === 'delivery' && a.deliveryId === b.deliveryId).toBe(true);
  });
});

describe('an incoming WhatsApp message', () => {
  it('is the allowed customer: phone, handle, profile name, the message SID as the dedupe key', () => {
    const [e] = channel().parseWebhook(delivery(inbound()));
    expect(e).toEqual({
      kind: 'message',
      providerEventId: `msg:${SM(1)}`,
      channelExternalId: TWILIO_SANDBOX_NUMBER,
      externalMessageId: SM(1),
      handle: ALLOWED.slice(1),
      displayName: 'Fictional Tester',
      phone: ALLOWED,
      type: 'text',
      text: 'Hello, what time do you open today?',
      media: [],
      replyToExternalId: null,
      timestamp: NOW,
      hint: null,
    });
  });

  it('from any other number is an unknown event: no contact, no message, no words', () => {
    const events = channel().parseWebhook(delivery(inbound({}, STRANGER)));
    expect(events).toEqual([
      { kind: 'unknown', providerEventId: `unknown:messages.not_allowed:${SM(1)}`, channelExternalId: TWILIO_SANDBOX_NUMBER, field: 'messages.not_allowed' },
    ]);
    expect(JSON.stringify(events)).not.toContain(STRANGER.slice(1));
    expect(JSON.stringify(events)).not.toContain('open today');
  });

  it("is never the sandbox's own join or stop chatter", () => {
    for (const body of ['join fictional-words', 'JOIN  fictional-words ', 'stop', 'Stop']) {
      expect(channel().parseWebhook(delivery(inbound({ Body: body })))).toEqual([
        expect.objectContaining({ kind: 'unknown', field: 'sandbox.control' }),
      ]);
    }
    // Off the sandbox number, "stop" is a customer's word like any other.
    const own = channel({ sender: '+66898700099' });
    const [e] = own.parseWebhook(delivery(inbound({ Body: 'stop', To: 'whatsapp:+66898700099' })));
    expect(e).toMatchObject({ kind: 'message', text: 'stop' });
    // And "join us for a party?" is a question, not a join.
    expect(channel().parseWebhook(delivery(inbound({ Body: 'Can 20 kids join a party on Sunday?' }))))
      .toEqual([expect.objectContaining({ kind: 'message' })]);
  });

  it('takes only "join <word>-<word>" as the join code: "join us" and the like reach the conversation', () => {
    for (const body of ['join us', 'join the party', 'Join us at 3', 'JOIN US', 'join', 'join a-b-c', 'join -words']) {
      const [e] = channel().parseWebhook(delivery(inbound({ Body: body })));
      expect(e).toMatchObject({ kind: 'message', type: 'text', text: body });
    }
    for (const body of ['join fictional-words', 'Join Fictional-Words', 'join fictional-2words']) {
      expect(channel().parseWebhook(delivery(inbound({ Body: body })))).toEqual([
        expect.objectContaining({ kind: 'unknown', field: 'sandbox.control' }),
      ]);
    }
  });

  it('carries its media by URL with the content type; an OGG audio is a voice note', () => {
    const media = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/MM${'0'.repeat(32)}/Media/ME${'0'.repeat(31)}1`;
    const [voice] = channel().parseWebhook(
      delivery(inbound({ NumMedia: '1', Body: '', MessageType: 'audio', MediaUrl0: media, MediaContentType0: 'audio/ogg' })),
    );
    expect(voice).toMatchObject({
      type: 'audio',
      text: null,
      media: [{ kind: 'audio', providerMediaId: media, mimeType: 'audio/ogg', voice: true, sha256: null }],
    });
    const [photo] = channel().parseWebhook(
      delivery(inbound({ NumMedia: '1', Body: 'our party room?', MediaUrl0: media, MediaContentType0: 'image/jpeg' })),
    );
    expect(photo).toMatchObject({ type: 'image', text: 'our party room?', media: [{ kind: 'image', voice: false }] });
    const [pdf] = channel().parseWebhook(
      delivery(inbound({ NumMedia: '1', Body: '', MediaUrl0: media, MediaContentType0: 'application/pdf' })),
    );
    expect(pdf).toMatchObject({ type: 'document', media: [{ kind: 'document' }] });
  });

  it('reads a location, a button press and a quoted reply', () => {
    const [loc] = channel().parseWebhook(delivery(inbound({ Body: '', Latitude: '7.88', Longitude: '98.39', Label: 'Fictional Mall' })));
    expect(loc).toMatchObject({ type: 'location', text: 'Fictional Mall' });
    const [btn] = channel().parseWebhook(delivery(inbound({ ButtonText: 'Yes', ButtonPayload: 'yes' })));
    expect(btn).toMatchObject({ type: 'button', text: 'Yes' });
    const [reply] = channel().parseWebhook(delivery(inbound({ OriginalRepliedMessageSid: SM(9) })));
    expect(reply).toMatchObject({ replyToExternalId: SM(9) });
  });

  it('for another Twilio account is never filed', () => {
    expect(channel().parseWebhook(delivery(inbound({ AccountSid: `AC${'0'.repeat(31)}9` })))).toEqual([
      expect.objectContaining({ kind: 'unknown', field: 'account.foreign', channelExternalId: null }),
    ]);
  });
});

describe('a status callback', () => {
  const status = (s: string, over: Record<string, string> = {}): Array<[string, string]> =>
    Object.entries({
      ChannelPrefix: 'whatsapp',
      ApiVersion: '2010-04-01',
      MessageStatus: s,
      SmsSid: SM(2),
      SmsStatus: s,
      ChannelInstallSid: `XE${'0'.repeat(32)}`,
      To: `whatsapp:${ALLOWED}`,
      From: `whatsapp:${TWILIO_SANDBOX_NUMBER}`,
      MessageSid: SM(2),
      AccountSid: SID,
      ...over,
    });

  it('moves the outbound message: sent, delivered, read', () => {
    for (const s of ['sent', 'delivered', 'read'] as const) {
      expect(channel().parseWebhook(delivery(status(s)))).toEqual([
        {
          kind: 'status',
          providerEventId: `status:${SM(2)}:${s}`,
          channelExternalId: TWILIO_SANDBOX_NUMBER,
          externalMessageId: SM(2),
          status: s,
          recipientHandle: ALLOWED.slice(1),
          timestamp: NOW,
          clientRef: null,
          error: null,
        },
      ]);
    }
  });

  it('names a failure by its refusal word and Twilio code: 63015 not joined, 63016 the window', () => {
    const [notJoined] = channel().parseWebhook(delivery(status('failed', { ErrorCode: '63015', ChannelStatusMessage: 'words the channel wrote' })));
    expect(notJoined).toMatchObject({ status: 'failed', error: { refusal: 'REJECTED', providerCode: '63015', title: null } });
    expect(JSON.stringify(notJoined)).not.toContain('words the channel wrote');
    const [window] = channel().parseWebhook(delivery(status('undelivered', { ErrorCode: '63016' })));
    expect(window).toMatchObject({ status: 'failed', error: { refusal: 'OUT_OF_WINDOW', providerCode: '63016' } });
  });

  it('keeps the steps it does not read as unknown events', () => {
    expect(channel().parseWebhook(delivery(status('queued')))).toEqual([expect.objectContaining({ kind: 'unknown', field: 'status.queued' })]);
  });
});

describe('the refusal words', () => {
  it('maps the codes Twilio documents', () => {
    expect(refusalForTwilioError(63016, 400)).toEqual({ refusal: 'OUT_OF_WINDOW', retryable: false });
    expect(refusalForTwilioError(63015, 400)).toEqual({ refusal: 'REJECTED', retryable: false });
    expect(refusalForTwilioError(63018, 429)).toEqual({ refusal: 'RATE_LIMITED', retryable: true });
    expect(refusalForTwilioError(NaN, 429)).toEqual({ refusal: 'RATE_LIMITED', retryable: true });
    expect(refusalForTwilioError(NaN, 503)).toEqual({ refusal: 'UNREACHABLE', retryable: true });
    expect(refusalForTwilioError(20003, 401)).toEqual({ refusal: 'REJECTED', retryable: false });
  });
});

describe('sending', () => {
  it('posts the form Twilio documents, with the status callback, and answers the message SID', async () => {
    const { fetch, calls } = fakeFetch([{ status: 201, json: { sid: SM(3), status: 'queued' } }]);
    const result = await channel({}, { fetch }).send(textTo(ALLOWED));
    expect(result).toEqual({ ok: true, externalMessageId: SM(3), acceptedAt: NOW });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(calls[0]!.headers['authorization']).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
    expect([...new URLSearchParams(calls[0]!.body)]).toEqual([
      ['To', `whatsapp:${ALLOWED}`],
      ['From', `whatsapp:${TWILIO_SANDBOX_NUMBER}`],
      ['Body', 'We open at 10:00.'],
      ['StatusCallback', `${ORIGIN}${PATH}`],
    ]);
  });

  it('refuses any number not on the allow-list before any network: NOT_ALLOWED', async () => {
    const { fetch, calls } = fakeFetch([]);
    expect(await channel({}, { fetch }).send(textTo(STRANGER))).toEqual({
      ok: false,
      refusal: 'NOT_ALLOWED',
      retryable: false,
      providerCode: null,
      detail: 'the test line writes only to its allowed numbers',
    });
    expect(calls).toHaveLength(0);
  });

  it('keeps the 24-hour rule locally, and refuses a template honestly on the sandbox', async () => {
    const { fetch, calls } = fakeFetch([]);
    const c = channel({}, { fetch });
    expect(await c.send({ ...textTo(ALLOWED), lastCustomerMessageAt: new Date(NOW.getTime() - 25 * 3_600_000) })).toMatchObject({
      ok: false,
      refusal: 'TEMPLATE_REQUIRED',
    });
    expect(
      await c.send({ ...textTo(ALLOWED), content: { kind: 'template', name: 'out_of_hours', language: 'en' } }),
    ).toMatchObject({ ok: false, refusal: 'REJECTED', retryable: false, providerCode: 'TEMPLATE_UNAVAILABLE' });
    expect(calls).toHaveLength(0);
  });

  it('sends media by its https link, a caption only with an image or a video', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 201, json: { sid: SM(4) } },
      { status: 201, json: { sid: SM(5) } },
    ]);
    const c = channel({}, { fetch });
    await c.send({ ...textTo(ALLOWED), content: { kind: 'media', mediaType: 'image', link: 'https://files.example/a.jpg', caption: 'the room' } });
    await c.send({ ...textTo(ALLOWED), content: { kind: 'media', mediaType: 'document', link: 'https://files.example/b.pdf', caption: 'menu' } });
    expect(new URLSearchParams(calls[0]!.body).get('Body')).toBe('the room');
    expect(new URLSearchParams(calls[0]!.body).get('MediaUrl')).toBe('https://files.example/a.jpg');
    expect(new URLSearchParams(calls[1]!.body).get('Body')).toBeNull();
    expect(
      await c.send({ ...textTo(ALLOWED), content: { kind: 'media', mediaType: 'image', providerMediaId: 'abc' } }),
    ).toMatchObject({ ok: false, refusal: 'REJECTED' });
  });

  it("reads Twilio's error envelope, and a lost answer is retryable", async () => {
    const { fetch } = fakeFetch([
      { status: 400, json: { code: 63015, message: 'Channel Sandbox can only send…', status: 400 } },
      { status: 429, json: { code: 20429, message: 'Too Many Requests', status: 429 } },
      'network-error',
    ]);
    const c = channel({}, { fetch });
    expect(await c.send(textTo(ALLOWED))).toEqual({ ok: false, refusal: 'REJECTED', retryable: false, providerCode: '63015', detail: null });
    expect(await c.send(textTo(ALLOWED))).toMatchObject({ ok: false, refusal: 'RATE_LIMITED', retryable: true, providerCode: '20429' });
    expect(await c.send(textTo(ALLOWED))).toMatchObject({ ok: false, refusal: 'UNREACHABLE', retryable: true });
  });

  it("paces the sandbox: one message every three seconds, waiting when close and queuing when far", async () => {
    const waits: number[] = [];
    let clock = NOW.getTime();
    const { fetch, calls } = fakeFetch(Array.from({ length: 3 }, (_, i) => ({ status: 201, json: { sid: SM(10 + i) } })));
    const c = new TwilioWhatsAppChannel(config(), {
      fetch,
      now: () => new Date(clock),
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const sent = await Promise.all([c.send(textTo(ALLOWED)), c.send(textTo(ALLOWED)), c.send(textTo(ALLOWED)), c.send(textTo(ALLOWED))]);
    expect(sent.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(sent[3]).toMatchObject({ refusal: 'RATE_LIMITED', retryable: true, providerCode: 'SANDBOX_PACE' });
    expect(waits).toEqual([3000, 6000]);
    expect(calls).toHaveLength(3);
    // Off the sandbox number there is no pace.
    clock += 60_000;
    const { fetch: f2 } = fakeFetch([{ status: 201, json: { sid: SM(20) } }, { status: 201, json: { sid: SM(21) } }]);
    const own = new TwilioWhatsAppChannel(config({ sender: '+66898700099' }), { fetch: f2, now: () => new Date(clock), sleep: () => Promise.reject(new Error('no wait expected')) });
    expect((await Promise.all([own.send(textTo(ALLOWED)), own.send(textTo(ALLOWED))])).map((r) => r.ok)).toEqual([true, true]);
  });
});

describe('fetching media', () => {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/MM${'0'.repeat(32)}/Media/ME${'0'.repeat(31)}1`;

  it("sends the credentials to this account's media on Twilio's API host only", async () => {
    expect(isOwnMediaUrl(url, SID)).toBe(true);
    expect(isOwnMediaUrl(url.replace('api.twilio.com', 'api.twilio.com.evil.example'), SID)).toBe(false);
    expect(isOwnMediaUrl(url.replace(SID, `AC${'0'.repeat(31)}9`), SID)).toBe(false);
    expect(isOwnMediaUrl(url.replace('https:', 'http:'), SID)).toBe(false);
    const { fetch, calls } = fakeFetch([]);
    await expect(channel({}, { fetch }).fetchMedia({ providerMediaId: 'https://evil.example/Media/ME1' })).rejects.toMatchObject({ code: 'MEDIA_FETCH_FAILED' });
    expect(calls).toHaveLength(0);
  });

  it('follows a redirect without the credentials', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const { fetch, calls } = fakeFetch([
      { status: 307, headers: { location: 'https://media.cdn.example/abc' } },
      { status: 200, bytes, headers: { 'content-type': 'image/jpeg' } },
    ]);
    const got = await channel({}, { fetch }).fetchMedia({ providerMediaId: url });
    expect(got).toEqual({ contentType: 'image/jpeg', bytes });
    expect(calls[0]).toMatchObject({ url, redirect: 'manual' });
    expect(calls[0]!.headers['authorization']).toMatch(/^Basic /);
    expect(calls[1]).toMatchObject({ url: 'https://media.cdn.example/abc' });
    expect(calls[1]!.headers['authorization']).toBeUndefined();
  });

  it('reads the bytes directly, and a 404 is MEDIA_NOT_FOUND', async () => {
    const { fetch } = fakeFetch([{ status: 200, bytes: Uint8Array.from([9]) }, { status: 404 }]);
    const c = channel({}, { fetch });
    expect(await c.fetchMedia({ providerMediaId: url, mimeType: 'audio/ogg' })).toEqual({ contentType: 'audio/ogg', bytes: Uint8Array.from([9]) });
    await expect(c.fetchMedia({ providerMediaId: url })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
  });
});

describe('health', () => {
  it("reads the account's own record, and names refused credentials", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { status: 'active' } }, { status: 401, json: { code: 20003 } }, 'network-error']);
    const c = channel({}, { fetch });
    expect(await c.health()).toEqual({ status: 'active', checkedAt: NOW, detail: 'the WhatsApp sandbox' });
    expect(await c.health()).toEqual({ status: 'error', checkedAt: NOW, detail: 'the Twilio credentials were refused' });
    expect(await c.health()).toEqual({ status: 'error', checkedAt: NOW, detail: 'Twilio did not answer' });
    expect(calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}.json`);
  });
});

describe('the INBOX_TWILIO_* variables', () => {
  const account = { credentialRef: 'SANDBOX', sender: TWILIO_SANDBOX_NUMBER, webhookPath: PATH };
  const full = {
    INBOX_TWILIO_ENABLED: 'true',
    INBOX_TWILIO_PUBLIC_URL: `${ORIGIN}/`,
    INBOX_TWILIO_ACCOUNT_SID_SANDBOX: SID,
    INBOX_TWILIO_AUTH_TOKEN_SANDBOX: TOKEN,
    INBOX_TWILIO_ALLOWED_NUMBERS_SANDBOX: '+66 89 870 0001',
  };

  it('names the variables', () => {
    expect(INBOX_ENV.twilioEnabled).toBe('INBOX_TWILIO_ENABLED');
    expect(twilioVariables('SANDBOX')).toEqual({
      accountSid: 'INBOX_TWILIO_ACCOUNT_SID_SANDBOX',
      authToken: 'INBOX_TWILIO_AUTH_TOKEN_SANDBOX',
      allowedNumbers: 'INBOX_TWILIO_ALLOWED_NUMBERS_SANDBOX',
    });
  });

  it('leaves the line off unless the switch is exactly true', () => {
    expect(twilioConfigFrom({}, account)).toBeNull();
    expect(twilioConfigFrom({ ...full, INBOX_TWILIO_ENABLED: 'on' }, account)).toBeNull();
  });

  it('builds the configuration with everything set', () => {
    expect(twilioConfigFrom(full, account)).toEqual({
      accountSid: SID,
      authToken: TOKEN,
      sender: TWILIO_SANDBOX_NUMBER,
      publicUrl: ORIGIN,
      webhookPath: PATH,
      allowedNumbers: [ALLOWED],
    });
  });

  it('refuses without an allow-list, naming every missing and unusable variable and no value', () => {
    let err: unknown;
    try {
      twilioConfigFrom({ INBOX_TWILIO_ENABLED: 'true', INBOX_TWILIO_PUBLIC_URL: 'http://api.staging.example', INBOX_TWILIO_ACCOUNT_SID_SANDBOX: 'not-a-sid' }, account);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ChannelConfigError);
    expect((err as ChannelConfigError).missing).toEqual(['INBOX_TWILIO_AUTH_TOKEN_SANDBOX', 'INBOX_TWILIO_ALLOWED_NUMBERS_SANDBOX']);
    expect((err as ChannelConfigError).invalid).toEqual(['INBOX_TWILIO_PUBLIC_URL', 'INBOX_TWILIO_ACCOUNT_SID_SANDBOX']);
    expect((err as Error).message).not.toContain('not-a-sid');
    expect((err as Error).message).not.toContain('api.staging.example');
  });

  it('reads an allow-list as typed, and refuses one it cannot read', () => {
    expect(parseAllowedNumbers('+66 89 870 0001, whatsapp:+66-89-870-0002;+66898700001')).toEqual([ALLOWED, STRANGER]);
    expect(parseAllowedNumbers(' , ')).toBeNull();
    expect(parseAllowedNumbers('+66898700001, everyone')).toBeNull();
  });

  it("reads each number by the platform's phone rules: every way of writing one number is that number", () => {
    for (const typed of ['+66 89 870 0001', '+66898700001', '0898700001', '+66 (0)89 870 0001', '0066 89 870 0001', 'whatsapp:+66 (0)89-870-0001']) {
      expect(parseAllowedNumbers(typed)).toEqual([ALLOWED]);
    }
    // One number written four ways is one entry; a second number keeps its place.
    expect(parseAllowedNumbers('+66 89 870 0001\n0898700001; +66 (0)89 870 0001, 0898700002')).toEqual([ALLOWED, STRANGER]);
    // Not a phone number: the whole list allows nobody.
    for (const typed of ['everyone', '12', '+66', '0898700001, +1 2']) expect(parseAllowedNumbers(typed)).toBeNull();
  });

  it('the line built from "+66 (0)89 870 0001" lets that tester in', () => {
    const cfg = twilioConfigFrom({ ...full, INBOX_TWILIO_ALLOWED_NUMBERS_SANDBOX: '+66 (0)89 870 0001' }, account);
    expect(cfg?.allowedNumbers).toEqual([ALLOWED]);
    const [e] = new TwilioWhatsAppChannel(cfg!, { now: () => NOW }).parseWebhook(delivery(inbound()));
    expect(e).toMatchObject({ kind: 'message', phone: ALLOWED });
  });

  it('refuses a value that is not a phone number, naming the variable and never the value', () => {
    let err: unknown;
    try {
      twilioConfigFrom({ ...full, INBOX_TWILIO_ALLOWED_NUMBERS_SANDBOX: '+66898700001, the-whole-world' }, account);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ChannelConfigError);
    expect((err as ChannelConfigError).missing).toEqual([]);
    expect((err as ChannelConfigError).invalid).toEqual(['INBOX_TWILIO_ALLOWED_NUMBERS_SANDBOX']);
    expect((err as Error).message).toContain('INBOX_TWILIO_ALLOWED_NUMBERS_SANDBOX');
    expect((err as Error).message).not.toContain('the-whole-world');
    expect((err as Error).message).not.toContain('898700001');
  });

  it('reads the public origin as an https origin only', () => {
    expect(parsePublicOrigin('https://api.staging.example/')).toBe(ORIGIN);
    expect(parsePublicOrigin('https://api.staging.example/webhooks')).toBeNull();
    expect(parsePublicOrigin('http://api.staging.example')).toBeNull();
    expect(parsePublicOrigin('https://user:pw@api.staging.example')).toBeNull();
    expect(parsePublicOrigin('http://localhost:4000')).toBe('http://localhost:4000');
  });

  it('answers webhooks with an empty TwiML document', () => {
    expect(TWIML_EMPTY).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('the parser reads a form with an unknown AccountSid shape without throwing', () => {
    expect(parseTwilioForm([], { accountSid: SID, sender: TWILIO_SANDBOX_NUMBER, allowedNumbers: [ALLOWED], receivedAt: NOW })).toEqual([
      expect.objectContaining({ kind: 'unknown', field: 'account.foreign' }),
    ]);
  });
});
