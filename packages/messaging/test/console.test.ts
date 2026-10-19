import { describe, expect, it } from 'vitest';
import { ConsoleChannel, type ConsoleRecord } from '../src/console';
import { ChannelError, type OutboundMessage } from '../src/contract';

const NOW = new Date('2026-10-20T03:00:00.000Z');

/** Stands in for the api's console `SmsSender`: captures what it was asked to deliver. */
function capture() {
  const delivered: Array<[string, string]> = [];
  const records: ConsoleRecord[] = [];
  const sender = {
    send(phone: string, message: string) {
      delivered.push([phone, message]);
      return Promise.resolve();
    },
  };
  return { delivered, records, sender };
}

function notice(
  content: OutboundMessage['content'],
  to: OutboundMessage['to'] = { handle: '66800000001', phone: '+66800000001' },
): OutboundMessage {
  return { clientRef: 'reg-0001', to, content, lastCustomerMessageAt: null };
}

describe('the console channel captures instead of sending', () => {
  it('hands the text to the injected sender and records it, with a deterministic id', async () => {
    const c = capture();
    const ch = new ConsoleChannel({
      sender: c.sender,
      channel: 'line',
      now: () => NOW,
      onSend: (r) => c.records.push(r),
    });
    const text = 'OTO Park: your check-in is confirmed.';
    expect(await ch.send(notice({ kind: 'text', text }))).toEqual({
      ok: true,
      externalMessageId: 'console:reg-0001',
      acceptedAt: NOW,
    });
    expect(c.delivered).toEqual([['+66800000001', text]]);
    expect(c.records).toEqual([
      {
        clientRef: 'reg-0001',
        externalMessageId: 'console:reg-0001',
        channel: 'line',
        phone: '+66800000001',
        text,
        at: NOW,
      },
    ]);
  });

  it('is not limited by a window: a notice to someone who never wrote goes out', async () => {
    const c = capture();
    const ch = new ConsoleChannel({ sender: c.sender });
    expect(ch.capabilities.freeTextWindowHours).toBeNull();
    expect(await ch.send(notice({ kind: 'text', text: 'x' }))).toMatchObject({ ok: true });
  });

  it('sends a template only when it was rendered', async () => {
    const c = capture();
    const ch = new ConsoleChannel({ sender: c.sender });
    expect(
      await ch.send(
        notice({
          kind: 'template',
          name: 'welcome',
          language: 'en',
          renderedText: 'Welcome to OTO.',
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await ch.send(notice({ kind: 'template', name: 'welcome', language: 'en' })),
    ).toMatchObject({ ok: false, refusal: 'REJECTED', retryable: false });
    expect(c.delivered).toEqual([['+66800000001', 'Welcome to OTO.']]);
  });

  it('refuses media: there is nowhere to put it', async () => {
    const c = capture();
    const ch = new ConsoleChannel({ sender: c.sender });
    expect(
      await ch.send(notice({ kind: 'media', mediaType: 'image', link: 'https://x.test/a.png' })),
    ).toMatchObject({ ok: false, refusal: 'REJECTED' });
    expect(c.delivered).toEqual([]);
  });

  it('falls back to the handle when no phone is known', async () => {
    const c = capture();
    await new ConsoleChannel({ sender: c.sender }).send(
      notice({ kind: 'text', text: 'x' }, { handle: 'tg:somebody', phone: null }),
    );
    expect(c.delivered[0]![0]).toBe('tg:somebody');
  });

  it('turns a failing sender into a retryable refusal, without quoting its error', async () => {
    const ch = new ConsoleChannel({
      sender: { send: () => Promise.reject(new Error('to +66800000001 failed')) },
    });
    const res = await ch.send(notice({ kind: 'text', text: 'x' }));
    expect(res).toEqual({
      ok: false,
      refusal: 'UNREACHABLE',
      retryable: true,
      providerCode: null,
      detail: 'the console sender failed',
    });
    expect(JSON.stringify(res)).not.toContain('66800000001');
  });
});

describe('the console channel receives nothing', () => {
  const ch = new ConsoleChannel({ sender: capture().sender, channel: 'telegram' });

  it('cannot reply, and says who it is', () => {
    expect(ch.capabilities).toEqual({ reply: false, media: false, freeTextWindowHours: null });
    expect(ch.identity).toEqual({
      provider: 'console',
      channel: 'telegram',
      externalId: 'console:telegram',
      displayName: 'Console (telegram)',
    });
  });

  it('throws NOT_A_RECEIVING_CHANNEL on a webhook and on media', async () => {
    const raw = { method: 'POST' as const, headers: {}, query: {}, rawBody: '{}' };
    for (const call of [() => ch.verifyWebhook(raw), () => ch.parseWebhook(raw)]) {
      expect(call).toThrow(ChannelError);
    }
    await expect(ch.fetchMedia({ providerMediaId: 'x' })).rejects.toMatchObject({
      code: 'NOT_A_RECEIVING_CHANNEL',
    });
  });

  it('is always healthy', async () => {
    expect(await ch.health()).toMatchObject({ status: 'active' });
  });
});
