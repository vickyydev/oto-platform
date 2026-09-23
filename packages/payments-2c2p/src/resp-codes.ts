import type { QrState } from './contract';

/**
 * 2C2P's `respCode`, read as one of our states (`PAYMENT_GATEWAY.md:361-385`).
 *
 * The table there is long and most of it is about cards. These are the codes
 * this platform acts on, and each line is a decision somebody at a counter
 * will feel:
 *
 *   `0000`          paid — and only ever paid once the amount and the currency
 *                   have been compared as well. This function does not compare
 *                   them; `gateway.ts` does, and it refuses to settle on a
 *                   `0000` that disagrees.
 *   `0001` `2001`   pending. Keep asking.
 *   `1005`          the flow code for "QR on the display", which arrives on Do
 *                   Payment rather than on an inquiry. Keep asking.
 *   `2000`          the flow completed; read the payment's own code beside it.
 *   `0003`          cancelled.
 *   `5009` `9020`   expired.
 *   `5017`          paid after expiry — the guest who scanned the QR on the way
 *                   out. A person decides what happens to it.
 *   `5015` `5016`   paid more / paid less. NEVER paid, whatever the amount
 *                   comparison would say: the document is explicit, and both
 *                   raise an alert and wait (`:612-613`).
 *   `2002`          2C2P has never heard of this invoice — our token call never
 *                   landed, or landed against a different merchant.
 *   `5005` `9015`   we reused an invoice number. Our bug; the attempt is
 *                   refused rather than attached to somebody else's payment.
 *   `9999`          2C2P could not reach OUR webhook. It says nothing about the
 *                   payment and it is not a failure of this attempt — it is a
 *                   report about us, and it is recorded as one.
 *
 * Anything unlisted is `failed`, which maps to the ledger's `unknown`: the
 * honest word for a code nobody here has read.
 */
const MAP: Record<string, QrState> = {
  '0000': 'paid',
  '0001': 'pending',
  '1005': 'qr_shown',
  '2000': 'pending',
  '2001': 'pending',
  '0003': 'cancelled',
  '0004': 'failed',
  '2002': 'not_found',
  '2003': 'failed',
  '4110': 'paid',
  '4120': 'refunded',
  '4121': 'failed',
  '4122': 'failed',
  '5005': 'duplicate_invoice',
  '5009': 'expired',
  '9020': 'expired',
  '5015': 'amount_mismatch',
  '5016': 'amount_mismatch',
  '5017': 'late_paid',
  '9015': 'duplicate_invoice',
  '9041': 'failed',
  '9042': 'failed',
  '9057': 'failed',
  '9058': 'failed',
  '9059': 'failed',
  '9060': 'failed',
  '9900': 'failed',
  '9999': 'failed',
};

/** The codes the park's own reconciliation will want named rather than numbered. */
export const RESP_CODE_PAID = '0000';
export const RESP_CODE_QR_SHOWN = '1005';

export function stateForRespCode(respCode: string | null | undefined): QrState {
  if (!respCode) return 'failed';
  return MAP[respCode] ?? 'failed';
}

/**
 * Whether a code says anything about THIS payment.
 *
 * `9999` is the one that does not: it means 2C2P's delivery to our webhook
 * failed, which is a fact about our availability. Treating it as a failed
 * payment would declare a sale dead because our own service was slow.
 */
export function isAboutTheMerchant(respCode: string | null | undefined): boolean {
  return respCode === '9999';
}

/**
 * The codes that mean OUR invoice number was reused.
 *
 * Kept as a predicate rather than read off the state, because the action is
 * different from every other failure: nothing about the guest changed, a
 * number generator did, and that is an alert about the platform.
 */
export function isDuplicateInvoice(respCode: string | null | undefined): boolean {
  return respCode === '5005' || respCode === '9015';
}

/** `5015` paid more, `5016` paid less. Both wait for a person. */
export function isAmountMismatch(respCode: string | null | undefined): boolean {
  return respCode === '5015' || respCode === '5016';
}
