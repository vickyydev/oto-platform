import { signJwt, verifyJwt } from './envelope';

/**
 * THE BROWSER'S RETURN FROM THE HOSTED PAGE (`PAYMENT_GATEWAY.md` §2.8 step 5;
 * S2-12, SCRUM-209).
 *
 * After the guest pays — or gives up — on 2C2P's page, the browser is sent
 * back to `frontendReturnUrl` with one form field, `paymentResponse`: a JWT
 * carrying only `invoiceNo`, `channelCode`, `respCode`, `respDesc` and
 * `locale`. 2C2P's own words for it are "Transaction is completed, please do
 * payment inquiry request for full payment information".
 *
 * IT IS A DISPLAY HINT AND NEVER PROOF, and this file is shaped so that it
 * cannot be anything else:
 *
 *  - it is VERIFIED before a claim is read (`verifyJwt`, the same verify-then-
 *    read the webhook uses), so a forged return is refused rather than shown;
 *  - what comes out is a `FrontendReturnHint` — words for a "checking your
 *    payment" page — and deliberately NOT a `QrState`. Nothing downstream can
 *    hand it to a settlement, because no settlement takes one. A booking is
 *    paid by the backend notification plus a Payment Inquiry, or by the
 *    poller's inquiry, and by nothing a browser carries.
 *
 * Even a genuine, correctly signed `0000` here changes nothing: the browser
 * that carried it could be replaying yesterday's.
 */
export interface FrontendReturnHint {
  invoiceNo: string | null;
  channelCode: string | null;
  respCode: string | null;
  respDesc: string | null;
  locale: string | null;
  /**
   * How the waiting page may word itself. `completed`: the guest finished on
   * the hosted page and the platform is now confirming. `failed`: the page
   * says the payment did not go through. `unknown`: anything else. None of the
   * three is a payment state.
   */
  display: 'completed' | 'failed' | 'unknown';
}

/** The codes a hosted page returns with when the guest finished the flow. */
const COMPLETED = new Set(['0000', '2000']);
/** The codes that mean the page itself gave up, from the same response-code table. */
const FAILED = new Set(['0003', '0004', '2003', '5009', '9020', '9041', '9042']);

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return String(value);
  return null;
}

/**
 * Verify a `paymentResponse` and read it as a hint.
 *
 * @throws `JwtSignatureError` or `JwtClaimsError` when it is not signed with
 *   the merchant key — a forged or mangled return. The caller answers that
 *   with the same "checking your payment" page and nothing else.
 */
export function readFrontendReturn(paymentResponse: string, secretKey: string): FrontendReturnHint {
  const claims = verifyJwt(paymentResponse.trim(), secretKey);
  const respCode = text(claims.respCode);
  return {
    invoiceNo: text(claims.invoiceNo),
    channelCode: text(claims.channelCode),
    respCode,
    respDesc: text(claims.respDesc),
    locale: text(claims.locale),
    display: respCode && COMPLETED.has(respCode) ? 'completed' : respCode && FAILED.has(respCode) ? 'failed' : 'unknown',
  };
}

/**
 * Sign a `paymentResponse` the way 2C2P's page would — for the SIMULATOR's
 * pay / fail page only, which sends the browser back through the same return
 * route so that route is exercised exactly as the real one will be. The key
 * is the api's; this package never holds one.
 */
export function signFrontendReturn(
  hint: { invoiceNo: string; channelCode?: string | null; respCode: string; respDesc?: string | null; locale?: string | null },
  secretKey: string,
): string {
  return signJwt(
    {
      invoiceNo: hint.invoiceNo,
      channelCode: hint.channelCode ?? undefined,
      respCode: hint.respCode,
      respDesc: hint.respDesc ?? undefined,
      locale: hint.locale ?? undefined,
    },
    secretKey,
  );
}
