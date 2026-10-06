import {
  PAYMENT_API_VERSION,
  formatPaymentExpiry,
  fromWireAmount,
  maintenanceHostFor,
  paymentHostFor,
  toWireAmount,
  type GatewayConfig,
} from './config';
import { envelope, payloadOf, signJwt, verifyJwt } from './envelope';
import { MaintenanceClient } from './maintenance';
import { RESP_CODE_PAID, stateForRespCode } from './resp-codes';
import type {
  CancelResult,
  CreateHostedPaymentInput,
  CreateHostedPaymentResult,
  CreateQrInput,
  CreateQrResult,
  QrPayment,
  QrPaymentFacts,
  RefundInput,
  RefundResult,
} from './contract';

/**
 * THE REAL GATEWAY (`PAYMENT_GATEWAY.md` §2).
 *
 * Payment Token, then Do Payment on the PromptPay QR channel, then Payment
 * Inquiry — three plain HTTPS POSTs, each carrying one JWT. There is no
 * official Node SDK and none is needed (`:110-112`).
 *
 * WHAT THIS CLASS REFUSES TO DO, and why each refusal is here rather than in
 * the caller:
 *
 *  - It never believes a response it has not verified. Every answer is a
 *    `{"payload": "<jwt>"}` signed with our own secret, and `verifyJwt` runs
 *    before a single claim is read (`:117-123`).
 *  - It never proceeds past a Payment Token whose `respCode` is not `0000`
 *    (`:182-183`). A token call that answered `9015` has not minted anything,
 *    and sending Do Payment with the token field it did not return is how a
 *    sale ends as `9041` with nothing to show a guest.
 *  - It never converts money through a float. `toWireAmount` is the only
 *    place a decimal string exists.
 *
 * TIMEOUTS ARE THE CALLER'S BUDGET, not a default. A guest is standing at a
 * counter: `requestTimeoutMs` is short on purpose, and a gateway that has not
 * answered in that time is reported as such rather than held open while the
 * till looks hung.
 */

export interface TwoC2PDeps {
  /** Injected in tests. Defaults to the platform `fetch` (Node 22 has it). */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  requestTimeoutMs?: number;
}

interface PostResult {
  claims: Record<string, unknown>;
  httpStatus: number;
}

export class TwoC2PQrPayment implements QrPayment {
  readonly provider = '2c2p' as const;

  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly host: string;
  private readonly maintenance: MaintenanceClient | null;

  constructor(
    private readonly config: GatewayConfig,
    deps: TwoC2PDeps = {},
  ) {
    if (!config.merchantId || !config.secretKey) {
      // Reached only through a mis-wired caller: `gatewayFor` in the api picks
      // the simulator when either is absent. Stated as a throw anyway, because
      // the alternative is signing with an empty key and calling the answer a
      // payment.
      throw new Error('the 2C2P client needs a merchant id and a secret key');
    }
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs = deps.requestTimeoutMs ?? 10_000;
    this.host = paymentHostFor(config.environment, config.baseUrl);
    this.maintenance = config.maintenance
      ? new MaintenanceClient(
          {
            ...config.maintenance,
            baseUrl: maintenanceHostFor(config.environment, config.maintenance.baseUrl),
          },
          {
            merchantId: config.merchantId,
            fetch: this.fetchImpl,
            now: this.now,
            timeoutMs: this.timeoutMs,
          },
        )
      : null;
  }

  /**
   * Mint a QR: Payment Token, then Do Payment.
   *
   * `invoiceNo` is the caller's and is ONE PER ATTEMPT — 2C2P refuses a reused
   * one with `5005`/`9015` and that refusal reaches a counter (`:616-637`).
   * Nothing here retries a token call with the same number for that reason.
   */
  async createQr(input: CreateQrInput): Promise<CreateQrResult> {
    const expiresAt = new Date(this.now().getTime() + input.expiryMinutes * 60_000);

    const token = await this.post('paymentToken', {
      merchantID: this.config.merchantId,
      invoiceNo: input.invoiceNo,
      description: input.description,
      amount: toWireAmount(input.amountSatang),
      currencyCode: this.config.currencyCode,
      paymentExpiry: formatPaymentExpiry(expiresAt),
      backendReturnUrl: this.config.backendReturnUrl || undefined,
      frontendReturnUrl: this.config.frontendReturnUrl || undefined,
      /**
       * Ours, echoed back on every notification and every inquiry. The attempt
       * id is what ties a support case to a row; nothing identifying a guest
       * goes in these fields (`DEVELOPMENT_PLAN.md`, no PII on a wire we do
       * not control).
       */
      userDefined1: input.attemptId,
      userDefined2: input.userDefined?.stationCode,
      userDefined3: input.userDefined?.businessDate,
      /** "used to recognize subsequent retries of the same request" — C 100. */
      idempotencyID: input.attemptId,
    });

    const tokenCode = stringOf(token.claims.respCode) ?? '';
    if (tokenCode !== RESP_CODE_PAID) {
      return {
        qrPayload: null,
        qrImageUrl: null,
        expiresAt,
        expiryTimerMs: null,
        providerRef: null,
        state: stateForRespCode(tokenCode),
        respCode: tokenCode,
        respDesc: stringOf(token.claims.respDesc),
      };
    }

    const paymentToken = stringOf(token.claims.paymentToken);
    if (!paymentToken) {
      throw new Error('the payment token call answered 0000 with no token');
    }

    const payment = await this.post('payment', {
      paymentToken,
      payment: {
        code: { channelCode: this.config.qrChannelCode },
        data: {
          qrType: this.config.qrType,
          paymentExpiry: formatPaymentExpiry(expiresAt),
        },
      },
    });

    const extras = objectOf(payment.claims.extras);
    const respCode = stringOf(payment.claims.respCode) ?? '';
    return {
      /**
       * `extras.qrData` is the EMVCo string, present because `qrType` is RAW.
       * `data` is the fallback — a URL or a deeplink — and is used only when
       * the raw payload is absent (`:688-693`).
       */
      qrPayload: stringOf(extras?.qrData) ?? null,
      qrImageUrl: stringOf(payment.claims.data) ?? null,
      expiresAt,
      expiryTimerMs: numberOf(payment.claims.expiryTimer),
      providerRef: stringOf(extras?.referenceNo) ?? null,
      state: stateForRespCode(respCode),
      respCode,
      respDesc: stringOf(payment.claims.respDesc),
    };
  }

  /**
   * The booking site's checkout: a Payment Token, and nothing after it
   * (`PAYMENT_GATEWAY.md` §2.8, steps 1-3).
   *
   * There is no Do Payment here. The guest does that on 2C2P's own page, which
   * is what keeps card numbers off this platform entirely (PCI stays with
   * 2C2P). The token call carries both return URLs: the BACKEND one is the
   * webhook that can make a booking paid; the FRONTEND one is where the
   * browser lands, and what it carries is a hint for the page and nothing
   * more. `paymentChannel` restricts the page to what the booking site offered
   * the guest, so the page cannot take money through a channel the park has
   * never reconciled.
   */
  async createHostedPayment(input: CreateHostedPaymentInput): Promise<CreateHostedPaymentResult> {
    if (input.paymentChannels.length === 0) {
      throw new Error('a hosted payment page has to be restricted to at least one channel');
    }
    const expiresAt = new Date(this.now().getTime() + input.expiryMinutes * 60_000);
    const token = await this.post('paymentToken', {
      merchantID: this.config.merchantId,
      invoiceNo: input.invoiceNo,
      description: input.description,
      amount: toWireAmount(input.amountSatang),
      currencyCode: this.config.currencyCode,
      paymentChannel: [...input.paymentChannels],
      paymentExpiry: formatPaymentExpiry(expiresAt),
      backendReturnUrl: this.config.backendReturnUrl || undefined,
      frontendReturnUrl: input.frontendReturnUrl,
      locale: input.locale,
      userDefined1: input.attemptId,
      userDefined2: input.userDefined?.stationCode,
      userDefined3: input.userDefined?.businessDate,
      idempotencyID: input.attemptId,
    });
    const respCode = stringOf(token.claims.respCode) ?? '';
    const respDesc = stringOf(token.claims.respDesc);
    if (respCode !== RESP_CODE_PAID) {
      return { webPaymentUrl: null, expiresAt, state: stateForRespCode(respCode), respCode, respDesc };
    }
    const webPaymentUrl = stringOf(token.claims.webPaymentUrl);
    if (!webPaymentUrl) {
      throw new Error('the payment token call answered 0000 with no webPaymentUrl');
    }
    // `0000` on a token is "the page is open", not "paid". The state says so.
    return { webPaymentUrl, expiresAt, state: 'pending', respCode, respDesc };
  }

  /** The truth. One call, `invoiceNo` only (`:345-360`). */
  async inquire({ invoiceNo }: { invoiceNo: string }): Promise<QrPaymentFacts> {
    const answer = await this.post('paymentInquiry', {
      merchantID: this.config.merchantId,
      invoiceNo,
    });
    return factsOf(answer.claims, invoiceNo);
  }

  /**
   * Staff abandoned the tender.
   *
   * Whether `canceltransaction` supports a QR at all is UNCERTAIN (U4), so a
   * refusal is reported and never thrown: the attempt is cancelled on our side
   * either way, and a gateway that would not cancel simply leaves a QR nobody
   * will scan to expire on its own.
   */
  async cancel({ invoiceNo }: { invoiceNo: string }): Promise<CancelResult> {
    try {
      const answer = await this.post('canceltransaction', {
        merchantID: this.config.merchantId,
        invoiceNo,
      });
      const respCode = stringOf(answer.claims.respCode) ?? '';
      if (respCode === RESP_CODE_PAID || respCode === '0003') return { ok: true };
      return { ok: false, reason: 'failed', detail: respCode };
    } catch (err) {
      return { ok: false, reason: 'failed', detail: (err as Error).name };
    }
  }

  /** Maintenance: a different host, a different envelope (`:389-441`). S2-11 calls it. */
  async refund(input: RefundInput): Promise<RefundResult> {
    if (!this.maintenance) {
      return {
        state: 'failed',
        respCode: '',
        respDesc: 'no maintenance key pair is configured (PGW_MAINT_*)',
        providerRefundRef: null,
      };
    }
    return this.maintenance.action(input);
  }

  private async post(path: string, claims: Record<string, unknown>): Promise<PostResult> {
    const url = `${this.host}/payment/${PAYMENT_API_VERSION}/${path}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(envelope(signJwt(claims, this.config.secretKey))),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`the gateway answered ${res.status} with something that is not JSON`);
    }
    const jwt = payloadOf(body);
    if (!jwt) {
      throw new Error(`the gateway answered ${res.status} with no payload`);
    }
    // Verified before read, on our way in as well as on the webhook's.
    return { claims: verifyJwt(jwt, this.config.secretKey), httpStatus: res.status };
  }
}

/**
 * One set of claims — a notification or an inquiry answer — read into facts.
 *
 * Exported because the WEBHOOK reads exactly the same field set: the document
 * says the notification and the inquiry response are one shape (`:345-360`),
 * and two readers of one shape is two places for `channelCode` to be spelled
 * differently.
 *
 * WHAT IS DROPPED HERE. `accountNo` arrives masked and is not kept at all —
 * this platform stores four digits or nothing, and a masked PAN in a `raw`
 * column is a masked PAN on a screen. The card conditionals, the FX block and
 * the installment block are not read because no QR carries them.
 */
export function factsOf(claims: Record<string, unknown>, fallbackInvoiceNo: string): QrPaymentFacts {
  const respCode = stringOf(claims.respCode) ?? '';
  return {
    state: stateForRespCode(respCode),
    respCode,
    respDesc: stringOf(claims.respDesc),
    invoiceNo: stringOf(claims.invoiceNo) ?? fallbackInvoiceNo,
    amountSatang: fromWireAmount(claims.amount),
    currencyCode: stringOf(claims.currencyCode),
    tranRef: stringOf(claims.tranRef),
    paymentId: stringOf(claims.paymentID),
    approvalCode: stringOf(claims.approvalCode),
    channelCode: stringOf(claims.channelCode),
    agentCode: stringOf(claims.agentCode),
    transactionDateTime: stringOf(claims.transactionDateTime),
    raw: keepReadable(claims),
  };
}

/**
 * The claims worth keeping on the record, by name.
 *
 * An allow-list, for the reason `ATTEMPT_ALLOW_LIST` is one: the next version
 * of the API adds a field nobody here has heard of, and a deny-list would
 * store it. `merchantID` is kept because a dispute starts with "whose payment
 * was this"; `accountNo` is not, masked or otherwise.
 */
const READABLE = [
  'merchantID',
  'invoiceNo',
  'amount',
  'currencyCode',
  'transactionDateTime',
  'agentCode',
  'channelCode',
  'approvalCode',
  'referenceNo',
  'tranRef',
  'paymentID',
  'userDefined1',
  'userDefined2',
  'userDefined3',
  'acquirerReferenceNo',
  'acquirerResponseCode',
  'idempotencyID',
  'paymentScheme',
  'respCode',
  'respDesc',
] as const;

function keepReadable(claims: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of READABLE) {
    if (claims[key] !== undefined && claims[key] !== null) kept[key] = claims[key];
  }
  return kept;
}

function stringOf(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return String(value);
  return null;
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
