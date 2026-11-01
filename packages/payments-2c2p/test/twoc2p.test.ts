import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { envelope, payloadOf, signJwt, verifyJwt } from '../src/envelope';
import { TwoC2PQrPayment } from '../src/twoc2p';
import type { GatewayConfig } from '../src/config';

/**
 * The real client, against a fake 2C2P.
 *
 * Every key here is minted in this process. No credential of the park's, of
 * its sandbox merchant or of 2C2P's public demo pair appears in this
 * repository — the document names the demo pair and is the only place it may
 * (`PAYMENT_GATEWAY.md:17-24`, `:136-149`).
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

/** `signed` is the `{"payload": "<jwt>"}` envelope; `plain` is the fields as JSON. */
type Wire = 'signed' | 'plain';

interface Call {
  url: string;
  /** How the request arrived. */
  wire: Wire;
  claims: Record<string, unknown>;
}

/**
 * How the sandbox wanted each call on 29 Oct 2026 (Thailand demo merchant,
 * Payment API 4.3, SCRUM-685), and how it answered: Payment Token and Payment
 * Inquiry signed both ways, Do Payment plain both ways. The cancel call was not
 * probed and stays as the client sends it.
 */
const SANDBOX_WIRE: Record<string, Wire> = {
  paymentToken: 'signed',
  paymentInquiry: 'signed',
  canceltransaction: 'signed',
  payment: 'plain',
};

/**
 * A 2C2P that answers whatever the test tells it to, on the sandbox's wire.
 *
 * A request on the wrong wire is refused the way the sandbox refused a signed
 * Do Payment: `9005`, in plain JSON. `replies` overrides how a path is
 * ANSWERED, for a gateway that signs its Do Payment answer as the
 * documentation describes.
 */
function fakeGateway(
  answers: Record<string, Record<string, unknown>>,
  replies: Partial<Record<string, Wire>> = {},
): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const path = href.slice(href.lastIndexOf('/') + 1);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const jwt = payloadOf(body);
    // A signed request is verified with the same key, which is what proves the
    // client signed with the configured secret.
    const wire: Wire = jwt ? 'signed' : 'plain';
    calls.push({ url: href, wire, claims: jwt ? verifyJwt(jwt, SECRET) : body });
    if (wire !== (SANDBOX_WIRE[path] ?? 'signed')) {
      return new Response(
        JSON.stringify({ respCode: '9005', respDesc: 'Invalid Request (PaymentToken)' }),
        { status: 200 },
      );
    }
    const answer = answers[path];
    if (!answer) throw new Error(`the test gateway has no answer for ${path}`);
    const reply = replies[path] ?? SANDBOX_WIRE[path] ?? 'signed';
    return new Response(
      JSON.stringify(reply === 'signed' ? envelope(signJwt(answer, SECRET)) : answer),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

const QR_INPUT = {
  attemptId: '01a0cdcc-0000-7000-8000-000000000001',
  invoiceNo: 'T01260923000001',
  amountSatang: 144000,
  description: 'OTO Park admission',
  expiryMinutes: 20,
  userDefined: { stationCode: 'T1', businessDate: '2026-09-23' },
};

const NOW = new Date('2026-09-23T03:00:00.000Z');

describe('createQr — Payment Token, then Do Payment', () => {
  it('sends PPQR, qrType RAW and a D(12,5) amount, and returns the EMVCo payload', async () => {
    const { fetch, calls } = fakeGateway(
      {
        paymentToken: { respCode: '0000', respDesc: 'Success', paymentToken: 'tok_abc' },
        payment: {
          respCode: '1005',
          respDesc: 'Pending for user scan QR.',
          channelCode: 'PPQR',
          type: 'RAW',
          expiryTimer: 1_200_000,
          extras: { qrData: '00020101021229...6304ABCD', referenceNo: 'REF123' },
        },
      },
      // The documentation's shape: a signed answer, the QR in `extras.qrData`.
      { payment: 'signed' },
    );
    const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });

    const result = await client.createQr(QR_INPUT);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://gateway.invalid/payment/4.3/paymentToken');
    expect(calls[0]!.claims).toMatchObject({
      merchantID: 'TESTMERCHANT',
      invoiceNo: 'T01260923000001',
      amount: '1440.00000',
      // Alphabetic, not the numeric 764 the legacy 3.x API used.
      currencyCode: 'THB',
      userDefined1: '01a0cdcc-0000-7000-8000-000000000001',
      idempotencyID: '01a0cdcc-0000-7000-8000-000000000001',
      backendReturnUrl: 'https://api.invalid/webhooks/2c2p/payment',
    });
    // 03:00Z plus twenty minutes is 10:20 in Phuket.
    expect(calls[0]!.claims.paymentExpiry).toBe('2026-09-23 10:20:00');

    expect(calls[1]!.url).toBe('https://gateway.invalid/payment/4.3/payment');
    expect(calls[1]!.claims).toMatchObject({
      paymentToken: 'tok_abc',
      payment: { code: { channelCode: 'PPQR' }, data: { qrType: 'RAW' } },
    });

    expect(result.state).toBe('qr_shown');
    // No `data` on this answer: the documented `extras.qrData` is the fallback.
    expect(result.qrPayload).toBe('00020101021229...6304ABCD');
    expect(result.qrImageUrl).toBeNull();
    expect(result.expiryTimerMs).toBe(1_200_000);
    expect(result.providerRef).toBe('REF123');
    expect(result.expiresAt.toISOString()).toBe('2026-09-23T03:20:00.000Z');
  });

  /**
   * "Proceed only when `respCode` is `0000`" (`PAYMENT_GATEWAY.md:182-183`).
   * Sending Do Payment with a token the mint did not return is how a sale ends
   * as `9041` with nothing to show a guest.
   */
  it('stops at a token that did not mint, and never calls Do Payment', async () => {
    const { fetch, calls } = fakeGateway({
      paymentToken: { respCode: '9015', respDesc: 'Existing Invoice Number' },
    });
    const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });
    const result = await client.createQr({
      attemptId: 'a',
      invoiceNo: 'T01260923000001',
      amountSatang: 100,
      description: 'x',
      expiryMinutes: 20,
    });
    expect(calls).toHaveLength(1);
    expect(result.state).toBe('duplicate_invoice');
    expect(result.qrPayload).toBeNull();
  });

  it('falls back to the image URL only when no raw payload came back', async () => {
    const { fetch } = fakeGateway({
      paymentToken: { respCode: '0000', paymentToken: 'tok' },
      payment: { respCode: '1005', type: 'URL', data: 'https://example.invalid/qr.png' },
    });
    const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });
    const result = await client.createQr({
      attemptId: 'a',
      invoiceNo: 'T01260923000002',
      amountSatang: 100,
      description: 'x',
      expiryMinutes: 20,
    });
    expect(result.qrPayload).toBeNull();
    expect(result.qrImageUrl).toBe('https://example.invalid/qr.png');
  });
});

/**
 * SCRUM-685. The sandbox refused a signed Do Payment with `9005` and answered
 * a plain one in plain JSON, while Payment Token and Payment Inquiry stayed
 * signed both ways. Each test below fails on the client as it was before.
 */
describe('Do Payment on the sandbox wire', () => {
  it('sends Do Payment as plain JSON and keeps the signed envelope for the token', async () => {
    const { fetch, calls } = fakeGateway(
      {
        paymentToken: { respCode: '0000', paymentToken: 'tok_abc' },
        payment: { respCode: '1005', type: 'RAW', extras: { qrData: '000201...6304ABCD' } },
      },
      { payment: 'signed' },
    );
    const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });

    const result = await client.createQr(QR_INPUT);

    expect(calls.map((call) => call.wire)).toEqual(['signed', 'plain']);
    // The fields themselves, with no envelope and no merchant secret around them.
    expect(calls[1]!.claims).toEqual({
      paymentToken: 'tok_abc',
      payment: {
        code: { channelCode: 'PPQR' },
        data: { qrType: 'RAW', paymentExpiry: '2026-09-23 10:20:00' },
      },
    });
    expect(result.respCode).toBe('1005');
    expect(result.state).toBe('qr_shown');
  });

  it('accepts the plain-JSON answer the sandbox gives to Do Payment', async () => {
    const { fetch } = fakeGateway({
      paymentToken: { respCode: '0000', paymentToken: 'tok_abc' },
      payment: {
        respCode: '1005',
        respDesc: 'Pending for user scan QR',
        channelCode: 'PPQR',
        type: 'RAW',
        expiryTimer: 1_200_000,
        extras: { qrData: '000201...6304ABCD' },
      },
    });
    const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });

    const result = await client.createQr(QR_INPUT);

    expect(result.state).toBe('qr_shown');
    expect(result.respCode).toBe('1005');
    expect(result.respDesc).toBe('Pending for user scan QR');
    expect(result.qrPayload).toBe('000201...6304ABCD');
    expect(result.expiryTimerMs).toBe(1_200_000);
  });

  it('still verifies a Do Payment answer that does arrive signed', async () => {
    const otherKey = randomBytes(32).toString('hex');
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = String(url).slice(String(url).lastIndexOf('/') + 1);
      const answer =
        path === 'paymentToken'
          ? envelope(signJwt({ respCode: '0000', paymentToken: 'tok' }, SECRET))
          : envelope(signJwt({ respCode: '1005', type: 'RAW', data: '000201' }, otherKey));
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = new TwoC2PQrPayment(CONFIG, { fetch: fetchImpl, now: () => NOW });
    await expect(client.createQr(QR_INPUT)).rejects.toThrow(/signature/);
  });

  /**
   * The sandbox's answer: the EMVCo string in `data`, `type: "RAW"`, no
   * `extras`. Read as an image address it would show the guest nothing to
   * scan. Checked on both wires so it does not lean on the plain-reply fix.
   */
  it('reads the QR from data when the answer says RAW, on either wire', async () => {
    for (const reply of ['plain', 'signed'] as const) {
      const { fetch } = fakeGateway(
        {
          paymentToken: { respCode: '0000', paymentToken: 'tok_abc' },
          payment: {
            respCode: '1005',
            respDesc: 'Pending for user scan QR',
            channelCode: 'PPQR',
            type: 'RAW',
            data: '00020101021230810016A00000067701011201150107536000315080214KB0000019012345303764540540.005802TH6304ABCD',
            expiryTimer: 1_200_000,
          },
        },
        { payment: reply },
      );
      const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });

      const result = await client.createQr(QR_INPUT);

      expect(result.state, reply).toBe('qr_shown');
      expect(result.qrPayload, reply).toMatch(/^000201.*6304ABCD$/);
      expect(result.qrImageUrl, reply).toBeNull();
      // No `extras` came back, so there is no slip reference yet.
      expect(result.providerRef, reply).toBeNull();
    }
  });

  /**
   * The plain answer is Do Payment's only. An unsigned `0000` on an inquiry is
   * exactly the forgery the envelope exists to refuse.
   */
  it('refuses a plain-JSON answer to Payment Token and to Payment Inquiry', async () => {
    const plain = (answer: Record<string, unknown>) =>
      (async () => new Response(JSON.stringify(answer), { status: 200 })) as unknown as typeof globalThis.fetch;

    const minting = new TwoC2PQrPayment(CONFIG, {
      fetch: plain({ respCode: '0000', paymentToken: 'tok' }),
      now: () => NOW,
    });
    await expect(minting.createQr(QR_INPUT)).rejects.toThrow(/no payload/);

    const asking = new TwoC2PQrPayment(CONFIG, {
      fetch: plain({ respCode: '0000', invoiceNo: 'X', amount: '1440.00000' }),
      now: () => NOW,
    });
    await expect(asking.inquire({ invoiceNo: 'X' })).rejects.toThrow(/no payload/);
  });
});

describe('inquire', () => {
  it('reads the notification field set and converts the amount to satang', async () => {
    const { fetch, calls } = fakeGateway({
      paymentInquiry: {
        merchantID: 'TESTMERCHANT',
        invoiceNo: 'T01260923000001',
        amount: '1440.00000',
        currencyCode: 'THB',
        transactionDateTime: '20260923101500',
        agentCode: 'SCB',
        channelCode: 'PPQR',
        tranRef: 'TR99',
        paymentID: 'ccpp_12345678',
        // Masked by 2C2P and dropped by us: four digits or nothing.
        accountNo: '411111XXXXXX1111',
        respCode: '0000',
        respDesc: 'Successful',
      },
    });
    const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });
    const facts = await client.inquire({ invoiceNo: 'T01260923000001' });

    expect(calls[0]!.claims).toEqual({
      merchantID: 'TESTMERCHANT',
      invoiceNo: 'T01260923000001',
    });
    expect(facts.state).toBe('paid');
    expect(facts.amountSatang).toBe(144000);
    expect(facts.currencyCode).toBe('THB');
    expect(facts.tranRef).toBe('TR99');
    expect(facts.paymentId).toBe('ccpp_12345678');
    expect(facts.channelCode).toBe('PPQR');
    // The masked PAN is not kept, in any form.
    expect(JSON.stringify(facts.raw)).not.toContain('411111');
    expect(facts.raw).not.toHaveProperty('accountNo');
  });

  it('refuses an answer this merchant did not sign, before reading it', async () => {
    const otherKey = randomBytes(32).toString('hex');
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify(envelope(signJwt({ respCode: '0000', invoiceNo: 'X' }, otherKey))),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;
    const client = new TwoC2PQrPayment(CONFIG, { fetch: fetchImpl, now: () => NOW });
    await expect(client.inquire({ invoiceNo: 'X' })).rejects.toThrow(/signature/);
  });

  it('refuses a body that is not the envelope at all', async () => {
    const fetchImpl = (async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof globalThis.fetch;
    const client = new TwoC2PQrPayment(CONFIG, { fetch: fetchImpl, now: () => NOW });
    await expect(client.inquire({ invoiceNo: 'X' })).rejects.toThrow(/not JSON/);
  });
});

describe('construction and maintenance', () => {
  it('refuses to exist without a merchant id and a secret', () => {
    expect(() => new TwoC2PQrPayment({ ...CONFIG, secretKey: '' })).toThrow();
    expect(() => new TwoC2PQrPayment({ ...CONFIG, merchantId: '' })).toThrow();
  });

  it('reports the absence of a maintenance key pair rather than throwing', async () => {
    const { fetch } = fakeGateway({});
    const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });
    const answer = await client.refund({ invoiceNo: 'X', amountSatang: 100, processType: 'V' });
    expect(answer.state).toBe('failed');
    expect(answer.respDesc).toContain('PGW_MAINT_');
  });
});

describe('cancel', () => {
  it('reports a refusal rather than throwing, because QR support is UNCERTAIN', async () => {
    const { fetch } = fakeGateway({ canceltransaction: { respCode: '9057' } });
    const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });
    expect(await client.cancel({ invoiceNo: 'X' })).toEqual({
      ok: false,
      reason: 'failed',
      detail: '9057',
    });
  });

  it('accepts 0000 and 0003 as cancelled', async () => {
    for (const respCode of ['0000', '0003']) {
      const { fetch } = fakeGateway({ canceltransaction: { respCode } });
      const client = new TwoC2PQrPayment(CONFIG, { fetch, now: () => NOW });
      expect(await client.cancel({ invoiceNo: 'X' })).toEqual({ ok: true });
    }
  });
});
