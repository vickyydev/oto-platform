import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { envelope, JwtSignatureError, payloadOf, signJwt, verifyJwt } from '../src/envelope';
import { readFrontendReturn, signFrontendReturn } from '../src/redirect';
import { SimulatorQrPayment } from '../src/simulator';
import { TwoC2PQrPayment } from '../src/twoc2p';
import { QR_STATES } from '../src/contract';
import type { GatewayConfig } from '../src/config';

/**
 * THE BOOKING SITE'S CHECKOUT — the Redirect API (S2-12, SCRUM-209, round 1).
 *
 * Three things are pinned here, in the package that owns the wire:
 *
 *  1. the Payment Token for a hosted page carries the channels the booking
 *     page offered, both return URLs and a `D(12,5)` amount, and nothing is
 *     sent after it — the guest pays on 2C2P's page, not through us;
 *  2. the browser's `paymentResponse` is VERIFIED before it is read, and what
 *     comes out is a display hint that has no payment state in it at all;
 *  3. the simulator's hosted page moves between the states its pay / fail
 *     page drives, and runs out on the clock like the gateway's would.
 *
 * Every key here is minted in this process. No credential of the park's, of
 * its sandbox merchant or of 2C2P's public demo pair appears in this file.
 */
const SECRET = randomBytes(32).toString('hex');

const CONFIG: GatewayConfig = {
  environment: 'sandbox',
  baseUrl: 'https://gateway.invalid',
  merchantId: 'TESTMERCHANT',
  secretKey: SECRET,
  currencyCode: 'THB',
  qrChannelCode: 'PPQR',
  qrType: 'RAW',
  paymentExpiryMinutes: 20,
  backendReturnUrl: 'https://api.invalid/webhooks/2c2p/payment',
};

const NOW = new Date('2026-11-20T03:00:00.000Z');

const HOSTED = {
  attemptId: '01a0cdcc-0000-7000-8000-00000000b001',
  invoiceNo: 'WEB261120000001',
  amountSatang: 247000,
  description: 'OTO Park booking OTO-AB12-3456',
  expiryMinutes: 10,
  paymentChannels: ['CC'],
  frontendReturnUrl: 'https://book.invalid/api/public/bookings/return',
  locale: 'th',
};

interface Call {
  url: string;
  claims: Record<string, unknown>;
}

function fakeGateway(answers: Record<string, Record<string, unknown>>): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const path = href.slice(href.lastIndexOf('/') + 1);
    const jwt = payloadOf(JSON.parse(String(init?.body)));
    calls.push({ url: href, claims: verifyJwt(jwt!, SECRET) });
    const answer = answers[path];
    if (!answer) throw new Error(`the test gateway has no answer for ${path}`);
    return new Response(JSON.stringify(envelope(signJwt(answer, SECRET))), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

describe('createHostedPayment — the Payment Token for the booking page', () => {
  it('restricts the page to the offered channels and sends both return URLs', async () => {
    const { fetch, calls } = fakeGateway({
      paymentToken: {
        respCode: '0000',
        respDesc: 'Success',
        paymentToken: 'tok_hosted',
        webPaymentUrl: 'https://sandbox-pgw-ui.invalid/payment/tok_hosted',
      },
    });
    const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });

    const result = await client.createHostedPayment(HOSTED);

    // ONE call: the token. Do Payment happens on 2C2P's page, never here.
    expect(calls).toHaveLength(1);
    const token = calls[0]!;
    expect(token.url).toBe('https://gateway.invalid/payment/4.3/paymentToken');
    expect(token.claims).toMatchObject({
      merchantID: 'TESTMERCHANT',
      invoiceNo: 'WEB261120000001',
      amount: '2470.00000',
      currencyCode: 'THB',
      paymentChannel: ['CC'],
      backendReturnUrl: 'https://api.invalid/webhooks/2c2p/payment',
      frontendReturnUrl: 'https://book.invalid/api/public/bookings/return',
      locale: 'th',
      userDefined1: HOSTED.attemptId,
      idempotencyID: HOSTED.attemptId,
    });
    // Bangkok wall clock, ten minutes on — the booking's own hold.
    expect(token.claims.paymentExpiry).toBe('2026-11-20 10:10:00');
    // Nothing identifying a guest travels on a wire we do not control.
    expect(JSON.stringify(token.claims)).not.toMatch(/phone|parentName/i);

    expect(result.webPaymentUrl).toBe('https://sandbox-pgw-ui.invalid/payment/tok_hosted');
    // `0000` on a TOKEN is "the page is open". It is not, and never reads as, paid.
    expect(result.state).toBe('pending');
    expect(result.expiresAt.toISOString()).toBe('2026-11-20T03:10:00.000Z');
  });

  it('answers a refused token with no page, and never calls anything after it', async () => {
    const { fetch, calls } = fakeGateway({
      paymentToken: { respCode: '9015', respDesc: 'Invoice No. already exists.' },
    });
    const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });
    const result = await client.createHostedPayment(HOSTED);
    expect(calls).toHaveLength(1);
    expect(result.webPaymentUrl).toBeNull();
    expect(result.state).toBe('duplicate_invoice');
    expect(result.respCode).toBe('9015');
  });

  it('refuses a 0000 token that carries no page address rather than inventing one', async () => {
    const { fetch } = fakeGateway({ paymentToken: { respCode: '0000', paymentToken: 'tok' } });
    const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });
    await expect(client.createHostedPayment(HOSTED)).rejects.toThrow(/webPaymentUrl/);
  });

  it('refuses an unrestricted page — every channel the merchant has is not an offer', async () => {
    const { fetch, calls } = fakeGateway({});
    const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });
    await expect(client.createHostedPayment({ ...HOSTED, paymentChannels: [] })).rejects.toThrow(
      /at least one channel/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('the browser return is verified, and is a hint — never a state', () => {
  const RESPONSE = {
    invoiceNo: 'WEB261120000001',
    channelCode: 'CC',
    respCode: '2000',
    respDesc: 'Transaction is completed, please do payment inquiry request for full payment information.',
    locale: 'en',
  };

  it('reads a signed paymentResponse as words for the waiting page', () => {
    const hint = readFrontendReturn(signFrontendReturn(RESPONSE, SECRET), SECRET);
    expect(hint).toEqual({
      invoiceNo: 'WEB261120000001',
      channelCode: 'CC',
      respCode: '2000',
      respDesc: RESPONSE.respDesc,
      locale: 'en',
      display: 'completed',
    });
  });

  it('has no payment state in it, even for a signed 0000', () => {
    const hint = readFrontendReturn(signFrontendReturn({ ...RESPONSE, respCode: '0000' }, SECRET), SECRET);
    expect(hint.display).toBe('completed');
    // The shape is words, not a state: no field of it is one of the gateway's
    // state words, so nothing downstream can hand it to a settlement.
    expect(Object.keys(hint).sort()).toEqual(
      ['channelCode', 'display', 'invoiceNo', 'locale', 'respCode', 'respDesc'].sort(),
    );
    expect(Object.values(hint).filter((v) => (QR_STATES as readonly unknown[]).includes(v))).toEqual([]);
  });

  it('words a failed page as failed and anything unread as unknown', () => {
    expect(readFrontendReturn(signFrontendReturn({ ...RESPONSE, respCode: '0003' }, SECRET), SECRET).display).toBe(
      'failed',
    );
    expect(readFrontendReturn(signFrontendReturn({ ...RESPONSE, respCode: '7777' }, SECRET), SECRET).display).toBe(
      'unknown',
    );
  });

  it('refuses a forged return before a claim is read', () => {
    const forged = signFrontendReturn({ ...RESPONSE, respCode: '0000' }, randomBytes(32).toString('hex'));
    expect(() => readFrontendReturn(forged, SECRET)).toThrow(JwtSignatureError);
    // And a tampered body under the right key's signature.
    const [header, , signature] = signFrontendReturn(RESPONSE, SECRET).split('.');
    const body = Buffer.from(JSON.stringify({ ...RESPONSE, respCode: '0000' })).toString('base64url');
    expect(() => readFrontendReturn(`${header}.${body}.${signature}`, SECRET)).toThrow(JwtSignatureError);
    expect(() => readFrontendReturn('not-a-jwt', SECRET)).toThrow(JwtSignatureError);
  });
});

describe('the simulator\'s hosted page', () => {
  const at = (iso: string) => ({ now: () => new Date(iso) });

  it('opens pending at the api\'s pay / fail page and remembers what it shows', async () => {
    const sim = new SimulatorQrPayment(at('2026-11-20T03:00:00.000Z'));
    const opened = await sim.createHostedPayment(HOSTED);
    expect(opened.webPaymentUrl).toBe(`/webhooks/2c2p/hosted/${HOSTED.attemptId}`);
    expect(opened.state).toBe('pending');
    const page = sim.hostedPage(HOSTED.invoiceNo)!;
    expect(page).toMatchObject({
      attemptId: HOSTED.attemptId,
      amountSatang: 247000,
      channels: ['CC'],
      state: 'pending',
      frontendReturnUrl: HOSTED.frontendReturnUrl,
    });
    const facts = await sim.inquire({ invoiceNo: HOSTED.invoiceNo });
    expect(facts.state).toBe('pending');
    expect(facts.channelCode).toBe('CC');
  });

  it('pay moves it to paid, and the inquiry then says so with the amount', async () => {
    const sim = new SimulatorQrPayment(at('2026-11-20T03:00:00.000Z'));
    await sim.createHostedPayment(HOSTED);
    const facts = sim.apply(HOSTED.invoiceNo, 'paid')!;
    expect(facts.state).toBe('paid');
    const truth = await sim.inquire({ invoiceNo: HOSTED.invoiceNo });
    expect(truth).toMatchObject({ state: 'paid', respCode: '0000', amountSatang: 247000, currencyCode: 'THB' });
    expect(sim.hostedPage(HOSTED.invoiceNo)!.state).toBe('paid');
  });

  it('fail moves it to cancelled, with no money', async () => {
    const sim = new SimulatorQrPayment(at('2026-11-20T03:00:00.000Z'));
    await sim.createHostedPayment(HOSTED);
    expect(sim.apply(HOSTED.invoiceNo, 'decline')!.state).toBe('cancelled');
    expect((await sim.inquire({ invoiceNo: HOSTED.invoiceNo })).state).toBe('cancelled');
  });

  it('runs out on the clock like the gateway\'s would', async () => {
    let clock = new Date('2026-11-20T03:00:00.000Z');
    const sim = new SimulatorQrPayment({ now: () => clock });
    await sim.createHostedPayment(HOSTED);
    clock = new Date('2026-11-20T03:10:00.000Z');
    expect(sim.hostedPage(HOSTED.invoiceNo)!.state).toBe('expired');
    expect((await sim.inquire({ invoiceNo: HOSTED.invoiceNo })).respCode).toBe('9020');
  });

  it('knows nothing about a page this process never opened', async () => {
    const sim = new SimulatorQrPayment();
    expect(sim.hostedPage('WEB261120000099')).toBeNull();
    // And a till QR is not a hosted page, though the simulator knows it.
    await sim.createQr({ ...HOSTED, invoiceNo: 'T01261120000001' });
    expect(sim.knows('T01261120000001')).toBe(true);
    expect(sim.hostedPage('T01261120000001')).toBeNull();
  });

  it('refuses an unrestricted page, as the real client does', async () => {
    const sim = new SimulatorQrPayment();
    await expect(sim.createHostedPayment({ ...HOSTED, paymentChannels: [] })).rejects.toThrow(/at least one channel/);
  });
});
