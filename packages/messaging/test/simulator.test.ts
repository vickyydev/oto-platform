import { describe, expect, it } from 'vitest';
import { ChannelError, type InboundEvent, type OutboundMessage } from '../src/contract';
import { SIMULATOR_FIXTURE_IMAGE, SimulatorChannel } from '../src/simulator';
import { WhatsAppCloudChannel } from '../src/whatsapp-cloud';

const NOW = new Date('2026-10-20T03:00:00.000Z');
const HOUR = 3_600_000;
const SECRET = 'simulator-secret-for-tests';

function sim(
  extra: Partial<ConstructorParameters<typeof SimulatorChannel>[0]> = {},
): SimulatorChannel {
  return new SimulatorChannel({
    secret: SECRET,
    phoneNumberId: 'SIM-1',
    now: () => NOW,
    runId: 'r1',
    ...extra,
  });
}

function reply(
  content: OutboundMessage['content'],
  lastCustomerMessageAt: Date | null = new Date(NOW.getTime() - HOUR),
): OutboundMessage {
  return {
    clientRef: '0199f000-0000-7000-8000-0000000000b1',
    to: { handle: '66800000001', phone: '+66800000001' },
    content,
    lastCustomerMessageAt,
  };
}

describe('the round trip: a customer message in', () => {
  it('signs a delivery that verifies and parses into the normalised message, hint included', () => {
    const s = sim();
    const played = s.inbound({
      from: '66800000001',
      name: 'Fictional Parent A',
      text: 'Do you have a birthday slot on the 14th?',
      hint: { category: 'birthdays', intent: 'birthday enquiry', language: 'en' },
    });
    expect(played.externalMessageId).toBe('wamid.SIM.r1.IN.000001');
    expect(played.providerEventId).toBe('msg:wamid.SIM.r1.IN.000001');
    expect(s.verifyWebhook(played.webhook)).toMatchObject({ kind: 'delivery', ok: true });
    expect(s.parseWebhook(played.webhook)).toEqual<InboundEvent[]>([
      {
        kind: 'message',
        providerEventId: 'msg:wamid.SIM.r1.IN.000001',
        channelExternalId: 'SIM-1',
        externalMessageId: 'wamid.SIM.r1.IN.000001',
        handle: '66800000001',
        displayName: 'Fictional Parent A',
        phone: '+66800000001',
        type: 'text',
        text: 'Do you have a birthday slot on the 14th?',
        media: [],
        replyToExternalId: null,
        timestamp: NOW,
        hint: { category: 'birthdays', intent: 'birthday enquiry', language: 'en' },
      },
    ]);
  });

  it('carries the GM queue as a hint category (SCRUM-220 playbook), and drops a category it does not know', () => {
    const s = sim();
    const gm = s.inbound({ from: '66800000001', text: 'I want to complain', hint: { category: 'gm' } });
    expect(s.parseWebhook(gm.webhook)).toEqual([expect.objectContaining({ kind: 'message', hint: { category: 'gm' } })]);
    const unknown = s.inbound({
      from: '66800000001',
      text: 'hi',
      hint: { category: 'ceo' as never, language: 'en' },
    });
    expect(s.parseWebhook(unknown.webhook)).toEqual([expect.objectContaining({ kind: 'message', hint: { language: 'en' } })]);
  });

  it('is the WhatsApp envelope: the live parser reads it too, minus the hint', () => {
    const s = sim();
    const live = new WhatsAppCloudChannel({
      appSecret: SECRET,
      verifyToken: 'v',
      accessToken: 't',
      phoneNumberId: 'SIM-1',
    });
    const { webhook } = s.inbound({
      from: '66800000001',
      text: 'hi',
      hint: { category: 'general' },
    });
    expect(live.parseWebhook(webhook)).toEqual([
      expect.objectContaining({ kind: 'message', text: 'hi', hint: null }),
    ]);
  });

  it('is refused by a channel holding another secret', () => {
    const { webhook } = sim().inbound({ from: '66800000001', text: 'hi' });
    const other = sim({ secret: 'another-deployment' });
    expect(other.verifyWebhook(webhook)).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(() => other.parseWebhook(webhook)).toThrow(ChannelError);
  });

  it('surfaces the same dedupe ids when one delivery is posted twice', () => {
    const s = sim();
    const { webhook } = s.inbound({ from: '66800000001', text: 'hi' });
    const first = s.verifyWebhook(webhook);
    const second = s.verifyWebhook(webhook);
    expect(first).toEqual(second);
    expect(s.parseWebhook(webhook)[0]!.providerEventId).toBe(
      s.parseWebhook(webhook)[0]!.providerEventId,
    );
  });

  it('plays an image the channel can then fetch as the bundled fixture', async () => {
    const s = sim();
    const [e] = s.parseWebhook(
      s.inbound({ from: '66800000002', image: { caption: 'Our cake' } }).webhook,
    );
    expect(e).toMatchObject({
      type: 'image',
      text: 'Our cake',
      media: [{ kind: 'image', providerMediaId: 'SIMMEDIA.r1.000001', mimeType: 'image/png' }],
    });
    const media = await s.fetchMedia({ providerMediaId: 'SIMMEDIA.r1.000001' });
    expect(media.contentType).toBe('image/png');
    expect([...media.bytes]).toEqual([...SIMULATOR_FIXTURE_IMAGE]);
    await expect(s.fetchMedia({ providerMediaId: 'SIMMEDIA.r1.999999' })).rejects.toMatchObject({
      code: 'MEDIA_NOT_FOUND',
    });
  });

  it('plays a scenario as one delivery per message, in order', () => {
    const s = sim();
    const played = s.scenario([
      { from: '66800000001', text: 'one' },
      { from: '79000000002', text: 'два', hint: { language: 'ru' } },
      { from: '66800000003', text: 'สาม', hint: { language: 'th' } },
    ]);
    expect(played.map((p) => p.externalMessageId)).toEqual([
      'wamid.SIM.r1.IN.000001',
      'wamid.SIM.r1.IN.000002',
      'wamid.SIM.r1.IN.000003',
    ]);
    expect(
      played
        .flatMap((p) => s.parseWebhook(p.webhook))
        .map((e) => (e.kind === 'message' ? e.text : null)),
    ).toEqual(['one', 'два', 'สาม']);
  });

  it('refuses a sender that is not a WhatsApp id, and an empty message', () => {
    expect(() => sim().inbound({ from: '+66 80', text: 'x' })).toThrow(/WhatsApp id/);
    expect(() => sim().inbound({ from: '66800000001' })).toThrow(/text or an image/);
  });
});

describe('the round trip: a reply out', () => {
  it('acknowledges a send with a deterministic id and schedules delivered then read', async () => {
    const s = sim();
    expect(await s.send(reply({ kind: 'text', text: 'Yes, we do.' }))).toEqual({
      ok: true,
      externalMessageId: 'wamid.SIM.r1.OUT.000001',
      acceptedAt: NOW,
    });
    const receipts = s.takeScheduled().flatMap((w) => s.parseWebhook(w));
    expect(
      receipts.map((e) =>
        e.kind === 'status' ? [e.providerEventId, e.status, e.clientRef] : null,
      ),
    ).toEqual([
      [
        'status:wamid.SIM.r1.OUT.000001:delivered',
        'delivered',
        '0199f000-0000-7000-8000-0000000000b1',
      ],
      ['status:wamid.SIM.r1.OUT.000001:read', 'read', '0199f000-0000-7000-8000-0000000000b1'],
    ]);
    expect(s.takeScheduled()).toEqual([]);
    expect(s.sent()).toEqual([
      {
        clientRef: '0199f000-0000-7000-8000-0000000000b1',
        externalMessageId: 'wamid.SIM.r1.OUT.000001',
        to: '66800000001',
        kind: 'text',
        at: NOW,
      },
    ]);
  });

  it('honours the 24-hour window: free text refused, a template accepted', async () => {
    const s = sim();
    const stale = new Date(NOW.getTime() - 25 * HOUR);
    expect(await s.send(reply({ kind: 'text', text: 'late' }, stale))).toMatchObject({
      ok: false,
      refusal: 'TEMPLATE_REQUIRED',
    });
    expect(await s.send(reply({ kind: 'text', text: 'never wrote' }, null))).toMatchObject({
      ok: false,
      refusal: 'TEMPLATE_REQUIRED',
    });
    expect(
      await s.send(reply({ kind: 'template', name: 'welcome', language: 'en' }, stale)),
    ).toMatchObject({ ok: true });
    expect(s.sent()).toHaveLength(1);
  });

  it('refuses the next send on request, retryable only where the word is', async () => {
    const s = sim();
    s.refuseNext('RATE_LIMITED', '130429');
    s.refuseNext('REJECTED');
    expect(await s.send(reply({ kind: 'text', text: 'a' }))).toMatchObject({
      ok: false,
      refusal: 'RATE_LIMITED',
      retryable: true,
      providerCode: '130429',
    });
    expect(await s.send(reply({ kind: 'text', text: 'b' }))).toMatchObject({
      ok: false,
      refusal: 'REJECTED',
      retryable: false,
    });
    expect(await s.send(reply({ kind: 'text', text: 'c' }))).toMatchObject({
      ok: true,
      externalMessageId: 'wamid.SIM.r1.OUT.000001',
    });
  });

  it('pushes a failed receipt on demand', () => {
    const s = sim();
    const [e] = s.parseWebhook(s.statusWebhook('wamid.SIM.r1.OUT.000001', 'failed'));
    expect(e).toMatchObject({
      kind: 'status',
      status: 'failed',
      error: { refusal: 'REJECTED', providerCode: '131026' },
    });
  });
});

describe('determinism', () => {
  it('mints the same ids from the same inputs, and different ids under another run id', async () => {
    const a = sim();
    const b = sim();
    const c = sim({ runId: 'r2' });
    const play = async (s: SimulatorChannel) => [
      s.inbound({ from: '66800000001', text: 'x' }).webhook.rawBody,
      (await s.send(reply({ kind: 'text', text: 'y' }))).ok,
      s.sent()[0]!.externalMessageId,
    ];
    expect(await play(a)).toEqual(await play(b));
    expect((await play(c))[2]).toBe('wamid.SIM.r2.OUT.000001');
  });
});

describe('identity, health and configuration', () => {
  it('stands in for a WhatsApp account, and reaches no one', async () => {
    const s = sim();
    expect(s.identity).toEqual({
      provider: 'simulator',
      channel: 'whatsapp',
      externalId: 'SIM-1',
      displayName: 'Simulator',
    });
    expect(s.capabilities).toEqual({ reply: true, media: true, freeTextWindowHours: 24 });
    expect(await s.health()).toMatchObject({ status: 'active' });
  });

  it('answers the GET challenge with its verify token', () => {
    expect(
      sim({ verifyToken: 'vt' }).verifyWebhook({
        method: 'GET',
        headers: {},
        query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': 'c' },
        rawBody: '',
      }),
    ).toEqual({ kind: 'challenge', ok: true, respondWith: 'c' });
  });

  it('cannot be built without a secret', () => {
    expect(() => new SimulatorChannel({ secret: '' })).toThrow(/INBOX_SIMULATOR_SECRET/);
  });
});
