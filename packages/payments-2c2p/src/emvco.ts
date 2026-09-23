/**
 * A LOCALLY GENERATED EMVCo PAYLOAD, for the simulator only.
 *
 * `PAYMENT_GATEWAY.md:726-734` asks the simulator to answer with "the same
 * shapes" as the gateway — including "a locally generated EMVCo-shaped
 * payload". That is what this builds: a merchant-presented QR in the real
 * EMVCo TLV grammar with a real CRC-16/CCITT-FALSE, so the customer display
 * renders a QR that scans, parses and carries the right amount, and the
 * rendering path is exercised for real rather than against a placeholder
 * string.
 *
 * IT IS NOT PAYABLE AND MUST NOT BE. The merchant account template below
 * carries a reserved proxy value rather than any real PromptPay identifier, so
 * a phone that scans a simulator QR is told the merchant is unknown. A
 * simulator that minted a QR somebody could actually pay would move real money
 * during a demo.
 *
 * The grammar and the CRC are the same as `apps/pos/src/lib/promptpay.ts`, the
 * prototype's own builder, deliberately: two spellings of one standard is how
 * a payload passes one and fails the other. That file stays where it is — it
 * is the PAX terminal's and the booking site's path (Slice F's note) — and
 * this is the package's copy, which is reachable from a package that must not
 * import an app.
 */

function field(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over the payload including `6304`. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i += 1) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * The PromptPay application id, and a proxy that resolves to nothing.
 *
 * `A000000677010111` is the Bank of Thailand's published AID. The proxy is the
 * e-wallet tag (`03`) carrying a value in the reserved 0000-prefixed range: it
 * is well-formed, so a scanner parses it, and it belongs to no merchant, so
 * nothing can be sent to it.
 */
const PROMPTPAY_AID = 'A000000677010111';
const UNPAYABLE_PROXY = '000000000000000';

export interface SimulatedQrInput {
  amountSatang: number;
  /** Written into the additional-data template (tag 62, bill number) so the QR is traceable. */
  invoiceNo: string;
}

/**
 * Build one dynamic (amount-carrying) merchant-presented payload.
 *
 * Tag order follows the EMVCo specification's ascending-id convention, which
 * is what every Thai banking app's parser expects even though the standard
 * permits any order.
 */
export function buildSimulatedEmvcoPayload({ amountSatang, invoiceNo }: SimulatedQrInput): string {
  const merchantAccount = field('00', PROMPTPAY_AID) + field('03', UNPAYABLE_PROXY);
  const additional = field('01', invoiceNo.slice(0, 25));
  const body =
    field('00', '01') + // payload format indicator
    field('01', '12') + // dynamic: the amount is in the code, one payment only
    field('29', merchantAccount) +
    field('53', '764') + // THB, numeric here — EMVCo uses ISO 4217 numbers
    field('54', amountOf(amountSatang)) +
    field('58', 'TH') +
    field('59', 'OTO PARK SIMULATOR') +
    field('60', 'PHUKET') +
    field('62', additional) +
    '6304';
  return body + crc16(body);
}

/** Major units with two decimals, from integer satang. No float arithmetic. */
function amountOf(amountSatang: number): string {
  const baht = Math.trunc(amountSatang / 100);
  const satang = amountSatang % 100;
  return `${baht}.${String(satang).padStart(2, '0')}`;
}

/** True when the payload's trailing CRC matches its own body. The test's assertion. */
export function emvcoCrcIsValid(payload: string): boolean {
  if (payload.length < 8) return false;
  const body = payload.slice(0, -4);
  return body.endsWith('6304') && crc16(body) === payload.slice(-4);
}
