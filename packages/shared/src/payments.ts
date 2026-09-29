import { z } from 'zod';

/**
 * The tender vocabulary (S2-10a, SCRUM-206).
 *
 * Every word below is a CHECK constraint in `pos.payment_attempt` or
 * `pos.payment_method`, so this file and `packages/db/src/schema/sales.ts` are
 * two copies of one list and `packages/db/test/migration-0019.test.ts` compares
 * them character for character. They are kept apart because `@oto/db` is a
 * server package and the till, the Console and the box agent all need to name a
 * tender without pulling a database driver in behind it.
 *
 * WHY THE STATUS LIST IS LONGER THAN "approved / declined". A card terminal on
 * a serial cable and a QR on somebody's banking app both have a state the sale
 * ledger has never had to hold before: *we do not know yet*. The park's
 * acceptance criteria are written about exactly those states — a terminal that
 * answers nothing, an inquiry that cannot be made, a QR paid after the till
 * gave up — and a status column that cannot say "unknown" forces every one of
 * them to be recorded as a lie in one direction or the other.
 */

/**
 * How the money was taken.
 *
 * `wallet`, `voucher` and `transfer` are named now and written later
 * (S2-10b vouchers, S2-14a wallets): the CHECK is a migration per addition, and
 * the point of landing the whole vocabulary in one migration is that no later
 * slice of this ticket — or of the two after it — has to write a second one.
 */
export const PAYMENT_METHODS = ['cash', 'card', 'qr', 'wallet', 'voucher', 'transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * WHO answered, which is a different question from how the money was taken.
 *
 * A card can be `ghl` (the NEXGO on the serial cable), `simulator` (the same
 * messages with nothing on the other end of the cable) or `manual` (staff read
 * the approval code off the terminal's own screen and keyed it in). Reading
 * that off `method` alone is impossible, and the difference is what a
 * reconciliation asks about first.
 */
export const PAYMENT_PROVIDERS = ['simulator', 'ghl', 'digio', '2c2p', 'manual'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/**
 * THE LIFE OF ONE ATTEMPT.
 *
 *   created                     the row exists; nothing has been asked of any
 *                               device yet. This is what makes the attempt the
 *                               idempotency key rather than a record of the
 *                               past: it is written BEFORE the money is asked
 *                               for, so a retry finds it.
 *   sent_to_terminal            the command is with the box, or the QR is on
 *                               the display. The till is waiting.
 *   approved                    the money is ours. The only status
 *                               `outstandingOf` counts (Slice B).
 *   declined                    the terminal or the gateway said no. The sale
 *                               is untouched and the till offers the methods
 *                               again.
 *   cancelled                   staff or the guest abandoned it; an expired QR
 *                               lands here too, with `payload.expired` saying
 *                               which of the two it was.
 *   unknown                     the terminal never gave a final answer. The
 *                               till BLOCKS here — this is the state the
 *                               inquiry rule exists for.
 *   inquiring                   an inquiry is in flight against the terminal
 *                               or the gateway.
 *   not_found                   the inquiry was made and the terminal has no
 *                               such transaction: the sale did not happen.
 *   awaiting_staff_confirmation no inquiry is possible (a NEXGO card sale has
 *                               no QUERY at all) or the amounts disagree, so a
 *                               person reads the terminal's own screen and
 *                               says. The answer is audited with their account
 *                               id — that is the whole reason this is a status
 *                               and not a flag on `unknown`.
 *   awaiting_settlement         taken on the terminal's own 4G while the box
 *                               or the cloud was unreachable (the PAX QR
 *                               fallback). Real money, not yet reconciled to a
 *                               settlement file.
 */
export const PAYMENT_ATTEMPT_STATUSES = [
  'created',
  'sent_to_terminal',
  'approved',
  'declined',
  'cancelled',
  'unknown',
  'inquiring',
  'not_found',
  'awaiting_staff_confirmation',
  'awaiting_settlement',
] as const;
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

/**
 * The statuses that mean money was taken.
 *
 * `awaiting_settlement` counts: the guest's card was charged on the terminal's
 * own connection, and a till that asked for the balance again would take it
 * twice. What is unsettled about it is the reconciliation, not the payment.
 */
export const PAYMENT_ATTEMPT_TAKEN_STATUSES: readonly PaymentAttemptStatus[] = [
  'approved',
  'awaiting_settlement',
];

/**
 * The statuses nothing more will happen to on its own.
 *
 * `job:payments.pending` (Slice D) flags anything NOT in this list that is
 * older than `PAYMENT_PENDING_MIN`; the inquiry poller stops when an attempt
 * reaches one of these.
 */
export const PAYMENT_ATTEMPT_TERMINAL_STATUSES: readonly PaymentAttemptStatus[] = [
  'approved',
  'declined',
  'cancelled',
  'not_found',
  'awaiting_settlement',
];

/** A refused partial approval is still charged until its rescue VOID succeeds. */
export function isPaymentReversalPending(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const facts = payload as { void?: unknown; exchange?: unknown };
  if (!facts.void || typeof facts.void !== 'object' || Array.isArray(facts.void)) return false;
  const reversal = facts.void as { reason?: unknown; amountSatang?: unknown; result?: unknown };
  if (reversal.reason !== 'partial_approval') return false;
  if (reversal.result && typeof reversal.result === 'object' && !Array.isArray(reversal.result)
    && (reversal.result as { outcome?: unknown }).outcome === 'approved') return false;
  // Missing approvedSatang is saved as amountSatang: 0 by the terminal path.
  // Only an explicit zero approval proves there is no money to reverse.
  if (reversal.amountSatang === 0 && facts.exchange && typeof facts.exchange === 'object'
    && !Array.isArray(facts.exchange)
    && (facts.exchange as { approvedSatang?: unknown }).approvedSatang === 0) return false;
  return true;
}

/**
 * What a tender DOES, as against what it is called.
 *
 * The prototype's rule, ported: behaviour keys off the kind and never off the
 * token (`apps/pos/src/lib/payments.ts:41,56,65`), so the park renaming
 * "PromptPay" to "QR" or adding a second card acquirer changes a label and
 * nothing else. `other` is what an unknown token resolves to — the prototype
 * does the same (`paymentMethodKind`, `:44`).
 */
export const PAYMENT_METHOD_KINDS = ['cash', 'card', 'qr', 'other'] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

// --- Station routing --------------------------------------------------------

/**
 * `card_terminal` takes it on the tethered EDC; `manual` means staff key the
 * approval code in from the terminal's own screen.
 */
export const CARD_ROUTES = ['card_terminal', 'manual'] as const;
/**
 * `gateway` is 2C2P on the customer display; `qr_terminal` is the EDC's own QR
 * (the PAX, on its own 4G, which is also the offline fallback).
 */
export const QR_ROUTES = ['gateway', 'qr_terminal', 'none'] as const;
/** The drawer is a station DEVICE ROLE, which is why the word is `cash_drawer`. */
export const CASH_ROUTES = ['cash_drawer', 'none'] as const;

/**
 * `core.station.payment_routing`, typed.
 *
 * WHY IT PASSES UNKNOWN KEYS THROUGH rather than being a closed object: the
 * document is shared with tenders that are not built yet (wallet, voucher),
 * the Console merges rather than replaces when it writes one field
 * (`mergeRouting`, `apps/console/src/api/fleet.ts:573`), and a response schema
 * that dropped a key would silently delete the routing of a tender the next
 * ticket adds. The three keys named here are validated; the rest are carried.
 *
 * The VALUES are "which of this station's assigned devices takes it" rather
 * than device ids, so moving a terminal between stations cannot silently
 * re-route money — that decision is the Console's and this only writes it down.
 */
export const PaymentRoutingSchema = z
  .object({
    card: z.enum(CARD_ROUTES).optional(),
    qr: z.enum(QR_ROUTES).optional(),
    cash: z.enum(CASH_ROUTES).optional(),
  })
  .passthrough();
export type PaymentRouting = z.infer<typeof PaymentRoutingSchema>;

// --- The gateway invoice number ---------------------------------------------

/**
 * 2C2P refuses a reused `invoiceNo` (`5005`, `9015`), so the number is per
 * ATTEMPT and unique for ever — a re-shown QR is a new attempt with a new
 * number. `PAYMENT_GATEWAY.md:616-637` fixes the form; this is the generator.
 *
 *     [PREFIX]  STATION  YYMMDD  SEQ        ≤ 20 characters, A-Z0-9 only
 *      ≤5       3        6       6
 *      ""       T01      260920  000147  ->  T01260920000147      (15)
 *      "SBX"    T01      260920  000147  ->  SBXT01260920000147   (18)
 */
export const INVOICE_NO_MAX_LENGTH = 20;
export const INVOICE_NO_PATTERN = /^[A-Z0-9]{1,20}$/;
/** SEQ is six digits, so a station cannot issue more than this in one day. */
export const INVOICE_NO_MAX_SEQ = 999_999;

export interface InvoiceNoParts {
  /** `PGW_INVOICE_PREFIX` — empty in production, set in sandbox so test invoices can never collide with real ones. */
  prefix?: string | null;
  /** `core.station.code_prefix` — "T1", "B1". Encoded to exactly three characters. */
  stationCode: string;
  /** The branch business date, `YYYY-MM-DD`. Not the calendar date and not UTC — see `businessDate`. */
  businessDate: string;
  /** Per-station, per-day counter, 1-based. */
  seq: number;
}

const ALNUM_ONLY = /[^A-Z0-9]/g;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** "T1" -> "T01": the doc's own example, and how every station prefix the park uses is spelled. */
const LETTERS_THEN_DIGITS = /^([A-Z]+)(\d+)$/;

/**
 * Encode a station code to exactly three characters.
 *
 * The park's prefixes are two characters (`T1`, `B1`, `T3`) and the format
 * wants three, so the zero goes where it reads as a station number —
 * `T1` -> `T01`, which is the spelling `PAYMENT_GATEWAY.md` already uses.
 * Anything that is not letters-then-digits is left-padded instead, and a code
 * of more than three characters is REFUSED rather than truncated: two stations
 * whose codes differ only in the part that was cut off would mint the same
 * invoice number, and 2C2P would refuse the second sale of the day with no
 * explanation anybody at a counter could act on.
 */
function encodeStationCode(raw: string): string {
  const clean = raw.toUpperCase().replace(ALNUM_ONLY, '');
  if (clean.length === 0) throw new Error('An invoice number needs a station code');
  if (clean.length > 3) {
    throw new Error(
      `Station code "${raw}" is longer than the three characters an invoice number has room for`,
    );
  }
  if (clean.length === 3) return clean;
  const split = LETTERS_THEN_DIGITS.exec(clean);
  if (split) return `${split[1]}${split[2]!.padStart(3 - split[1]!.length, '0')}`;
  return clean.padStart(3, '0');
}

/** Build one gateway invoice number. Throws rather than minting one that cannot be honoured. */
export function buildInvoiceNo({ prefix, stationCode, businessDate, seq }: InvoiceNoParts): string {
  const cleanPrefix = (prefix ?? '').toUpperCase().replace(ALNUM_ONLY, '');
  if (cleanPrefix.length > 5) {
    throw new Error(`Invoice prefix "${prefix}" is longer than five characters`);
  }
  const date = ISO_DATE.exec(businessDate);
  if (!date) throw new Error(`Unparseable business date "${businessDate}" (expected YYYY-MM-DD)`);
  if (!Number.isInteger(seq) || seq < 1 || seq > INVOICE_NO_MAX_SEQ) {
    // Not wrapped to zero: a seventh digit would silently overflow the 20-char
    // QR limit, and a wrap would reuse a number 2C2P has already seen today.
    throw new Error(`Invoice sequence ${seq} is outside 1…${INVOICE_NO_MAX_SEQ}`);
  }
  const yymmdd = `${date[1]!.slice(2)}${date[2]}${date[3]}`;
  const invoiceNo = `${cleanPrefix}${encodeStationCode(stationCode)}${yymmdd}${String(seq).padStart(6, '0')}`;
  if (invoiceNo.length > INVOICE_NO_MAX_LENGTH || !INVOICE_NO_PATTERN.test(invoiceNo)) {
    throw new Error(`Built an invoice number the gateway would refuse: "${invoiceNo}"`);
  }
  return invoiceNo;
}

// --- What may be kept off an adapter's answer -------------------------------

/**
 * THE ONLY KEYS AN ADAPTER PAYLOAD MAY KEEP (`DEVELOPMENT_PLAN.md:421-423`).
 *
 * A GHL `<xml>` response and a Digio `A1` frame both carry a masked PAN and a
 * cardholder name, and neither has any business in our database: no PAN and no
 * track data is ever stored, and the raw frame stays inside the simulator. The
 * projection is an ALLOW-list rather than a deny-list because the next firmware
 * version adds a field nobody here has heard of, and a deny-list would store it.
 *
 * `packages/telemetry/src/redact.ts` is the second net, under every `ops_run`
 * detail; this is the first, applied where the frame is parsed. Note what the
 * two together mean and do not try to "fix" it: an approval code on the attempt
 * row is correct and the same code in an `ops_run.detail` is redacted, because
 * one is the money record and the other is a page in a browser.
 */
export const ATTEMPT_ALLOW_LIST = [
  'tid',
  'mid',
  'approvalCode',
  'last4',
  'amountSatang',
  'status',
  'invoiceNo',
] as const;
export type AttemptAllowedKey = (typeof ATTEMPT_ALLOW_LIST)[number];

/** Keep only the allow-listed keys of an adapter's parsed answer. Undefined values are dropped. */
export function projectAttemptPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of ATTEMPT_ALLOW_LIST) {
    if (raw[key] !== undefined && raw[key] !== null) kept[key] = raw[key];
  }
  return kept;
}

// --- The shape every read answers with --------------------------------------

/**
 * One attempt as the Attempts list on the Sale detail shows it, and as the
 * till reads its own tender back.
 *
 * It is deliberately NOT the row: `payload`, `qr_payload` and the tenancy
 * columns are not here. What is here is what the acceptance criterion names —
 * "status, provider and reference" — plus the fields a person at a counter or
 * an accountant at the end of a month asks about.
 */
export interface PaymentAttemptView {
  id: string;
  saleId: string | null;
  method: PaymentMethod;
  provider: PaymentProvider;
  status: PaymentAttemptStatus;
  amountSatang: number;
  tenderedSatang: number | null;
  changeSatang: number | null;
  /** The terminal's own reference — 12-char `pos_ref_no` (GHL) or 6-digit (Digio). */
  terminalRef: string | null;
  /** Whether the frozen terminal protocol and reference support inquiry. */
  inquirySupported?: boolean;
  /** A refused partial approval has not yet been successfully reversed. */
  reversalPending?: boolean;
  tid: string | null;
  approvalCode: string | null;
  last4: string | null;
  /** The gateway's, one per attempt, unique for ever. */
  invoiceNo: string | null;
  tranRef: string | null;
  /** `x-oto-action-id` — what ties this row to the Box log line and the adapter's `ops_run`. */
  actionId: string | null;
  offline: boolean;
  paidAt: string | null;
  createdAt: string;
}

// --- The box's per-terminal reference counter -------------------------------

/**
 * D-1: the terminal reference counter is a SCOPE on `edge.box_counter`, not a
 * table of its own.
 *
 * `box_counter`'s primary key is `(box_id, scope, counter_key, business_date)`
 * and `BoxStore.bumpCounter` already mints atomically against it. With
 * `counter_key` set to the device id, that key IS "unique per terminal per
 * day", which is the ticket's test — and the per-day reset comes free, with no
 * migration and no change to the store.
 */
export const TERMINAL_REF_COUNTER_SCOPE = 'terminal_ref';
