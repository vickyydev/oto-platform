/**
 * What a payment terminal is, to the box (S2-10a).
 *
 * Two EDCs sit on the counter at HKT Central and neither of them speaks the
 * other's language: a NEXGO N5 on GHL LinkPOS XML and a PAX A920Pro on Digio's
 * BER-TLV, both on a USB serial cable to the box (`DEVICE_INVENTORY.md:38-41`,
 * §4 D3 at `:79`). This file is the one shape the rest of the platform sees of
 * both of them, so that `apps/api` asks for a tender without knowing which
 * dialect answered and the till never learns either vendor's vocabulary.
 *
 * It lives on the BOX, beside `printing/`, for the reason printing does: the
 * link is a device node on a Raspberry Pi in Phuket, and `packages/box-agent`
 * is the package with no database and no Fastify in it, so the same file runs
 * on the Pi and inside the api process as the virtual box (`agent.ts:51-58`).
 *
 * THREE THINGS THIS CONTRACT IS SHAPED BY, each of them a fact about the
 * vendors rather than a preference:
 *
 *  1. **A tender can take two minutes.** The customer-interaction budget is
 *     120 seconds (`DEVICE_INVENTORY.md:948`) — a guest finding a card, a PIN
 *     typed slowly, a banking app opened. Nothing here may assume an answer
 *     comes back in the time a print job takes, and the command that starts a
 *     tender cannot be held open for it: the outcome travels on its own route,
 *     exactly as a print job's does (`agent.ts:474-484`).
 *  2. **"No answer" is a real outcome, not an error.** Neither vendor document
 *     defines a timeout, a retry or an ACK layer, so the rule is ours — and the
 *     only honest thing to report when a terminal says nothing is that we do
 *     not know whether the money moved. That is `no_response`, and it is what
 *     makes the till block and the inquiry rule run. Anything that turned it
 *     into `declined` would be a sale taken twice.
 *  3. **A QR sale answers twice.** Digio sends the payload first (`A18`) and
 *     the payment second (`A3`), which is what lets our own display draw the
 *     QR — so `sale()` reports progress before it resolves.
 *
 * WHAT IS DELIBERATELY NOT HERE: the raw frame. A GHL response carries a
 * masked PAN and a Digio `A1` carries a masked PAN and the cardholder's name,
 * and neither has any business leaving this package. Two rules keep it that
 * way, and they are two because there are two ways out of here:
 *
 *  - `TerminalResult` is the only shape a caller is given, and the parsers
 *    reduce the masked PAN to `last4` and drop the cardholder's name where
 *    they read it, so nothing that reaches an `ops_run` detail or a log line
 *    has ever held either.
 *  - The simulators' tape (`TerminalSimulatorEvent`, read by a Console panel
 *    through `TerminalController.events`) records what a panel needs — the
 *    action, the response code, the amounts and the references — and never the
 *    bytes. Hex is not something a redactor downstream could sweep, so it is
 *    not written down in the first place.
 */

import { z } from 'zod';

/** The two dialects, spelled as `core.device.protocol` spells them. */
export const TERMINAL_PROTOCOLS = ['ghl_linkpos', 'digio_tlv'] as const;
export type TerminalProtocol = (typeof TERMINAL_PROTOCOLS)[number];

/**
 * What is being taken, as the terminal thinks of it.
 *
 * Not `PaymentMethod` from `@oto/shared`: that vocabulary is the ledger's and
 * has words a terminal has never heard of (`voucher`, `transfer`), while this
 * one has a distinction the ledger does not need — `qr` is the terminal's own
 * QR and `wallet` is Alipay or WeChat, and the two take different paths on both
 * dialects. C2 maps between them where the attempt is written.
 */
export const TERMINAL_TENDERS = ['card', 'qr', 'wallet'] as const;
export type TerminalTender = (typeof TERMINAL_TENDERS)[number];

/**
 * The three exchanges, and why an answer is read knowing which one asked.
 *
 * "Approved for an amount that is not the amount asked" is a fact about a
 * SALE. The other two answer with an amount that is the terminal's rather than
 * ours — a void echoes what it took back, an inquiry may be sent with no
 * amount at all — so a reader that applied the rule to all three would read a
 * successful void of a partial approval as another partial approval, and a
 * caller acting on that would leave a guest charged with nobody chasing it.
 * Both adapters therefore carry this word into their answer-reader.
 */
export const TERMINAL_EXCHANGES = ['sale', 'inquire', 'void'] as const;
export type TerminalExchange = (typeof TERMINAL_EXCHANGES)[number];

/**
 * How a terminal exchange ended.
 *
 * Every word is a branch of the ticket's acceptance criteria, and the two that
 * look like near-duplicates are not:
 *
 *   approved          the money is ours for the amount asked.
 *   partial_approval  the terminal approved LESS than was asked (GHL response
 *                     `10`, p.8). The sale is refused and the tender voided —
 *                     the platform has no way to take the difference, and a
 *                     guest charged 500 for a 1,000 sale with the till showing
 *                     paid is the failure this branch exists to prevent. A
 *                     SALE's verdict and only a sale's: the void that follows
 *                     one answers for the amount it took back, and reading
 *                     that as a second shortfall would report the rescue as
 *                     the failure.
 *   declined          the host said no. Nothing was taken.
 *   cancelled         the guest or the staff member abandoned it at the
 *                     terminal (Digio `000`).
 *   no_response       nothing came back inside the budget. Whether money moved
 *                     is UNKNOWN. The till blocks; the inquiry rule runs.
 *   timeout           the terminal answered, and what it said is that its own
 *                     host did not answer IT (Digio `401`). Also unknown, but a
 *                     known unknown — the terminal is alive and can be asked.
 *   not_found         an inquiry was made and the terminal has no such
 *                     transaction (Digio `T3` + `203`). The sale did not happen.
 *   unsupported       the dialect cannot do this at all: there is no QUERY for
 *                     a GHL card sale (p.13) and Thai QR cannot be voided
 *                     (p.15, Digio `333`). Not a failure — a fact about the
 *                     vendor, and the reason the audited staff-confirmation
 *                     dialog is permanent rather than a fallback.
 */
export const TERMINAL_OUTCOME_KINDS = [
  'approved',
  'partial_approval',
  'declined',
  'cancelled',
  'no_response',
  'timeout',
  'not_found',
  'unsupported',
] as const;
export type TerminalOutcomeKind = (typeof TERMINAL_OUTCOME_KINDS)[number];

/**
 * Timeouts, from `DEVICE_INVENTORY.md:948` except where marked ours.
 *
 * `CHANNEL_TIMEOUTS` in `printing/channel.ts:30-37` deliberately has nothing
 * like `customerInteractionMs` — a till waiting on a printer is a queue of
 * people waiting on a till, so those are seconds. A till waiting on a guest's
 * PIN is the guest, so this one is two minutes and the screen says so.
 */
export const TERMINAL_TIMEOUTS = {
  openMs: 2000,
  /** How long to wait for more bytes of a frame already arriving. */
  idleReadMs: 500,
  customerInteractionMs: 120_000,
  /** Ours: a health probe or an inquiry is a machine answering a machine. */
  probeMs: 5000,
} as const;

/** Why a terminal exchange could not be attempted. Short: these reach a screen. */
export type TerminalErrorCode =
  /** Nothing answered on the serial path. Cable, power, or the ECR app closed. */
  | 'TERMINAL_UNREACHABLE'
  /** The port died while the request was going out. */
  | 'TERMINAL_WRITE_FAILED'
  /** A frame arrived and would not parse — a bad CRC, a length that overruns. */
  | 'TERMINAL_BAD_FRAME'
  /** The device row has no address, so there is nothing to open. */
  | 'DEVICE_NO_ADDRESS'
  /** Something the box needs was never configured — a void password, a store. */
  | 'TERMINAL_NOT_CONFIGURED'
  /** This box has no way to open a real serial port. See `serial-channel.ts`. */
  | 'TERMINAL_NO_SERIAL_DRIVER'
  /** The request itself is impossible — an amount of zero, a ref too long. */
  | 'TERMINAL_BAD_REQUEST';

export class TerminalError extends Error {
  readonly code: TerminalErrorCode;
  /**
   * Whether the money could already have moved when this was thrown.
   *
   * The same field `PrinterError.partial` is, for the same reason and with more
   * at stake: bytes that reached the terminal may have reached the host. A
   * caller that sees `partial` must open an inquiry, never re-send the sale.
   */
  readonly partial: boolean;

  constructor(
    code: TerminalErrorCode,
    message: string,
    opts: { partial?: boolean; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'TerminalError';
    this.code = code;
    this.partial = opts.partial ?? false;
  }
}

// --- The wire ---------------------------------------------------------------

/** Where one complete frame sits in the buffered bytes. */
export interface FrameSpan {
  /** First byte of the frame. Anything before it is noise and is dropped. */
  start: number;
  /** One past the last byte. */
  end: number;
}

/**
 * Find one complete frame in what has arrived so far, or say "not yet".
 *
 * A scanner rather than a fixed byte count because neither dialect has a
 * framing layer worth the name: GHL has none at all — the C# sample writes an
 * XML string at the port and reads with `ReadExisting()` (vendor PDF p.18), so
 * the end of a message is the characters `</xml>` and nothing else — and Digio
 * has a header and a BER length but no delimiter, so the end is arithmetic.
 */
export type FrameScanner = (buffered: Uint8Array) => FrameSpan | null;

export interface TerminalChannel {
  /** Hand bytes to the terminal. */
  write(bytes: Uint8Array): Promise<void>;
  /**
   * Wait for one complete frame, or for the deadline.
   *
   * Resolves null when the deadline passes with no frame, which is not an
   * error: it is `no_response`, the state this whole design is built around.
   * Bytes after the frame stay buffered, which is what makes Digio's
   * two-response QR exchange one connection and two reads.
   */
  readFrame(scan: FrameScanner, timeoutMs: number): Promise<Uint8Array | null>;
  /** Throw away anything buffered. Called before a fresh request goes out. */
  discard(): void;
  close(): Promise<void>;
}

/** Open one session to one terminal. */
export type TerminalChannelFactory = () => Promise<TerminalChannel>;

// --- Requests ---------------------------------------------------------------

export interface TerminalSaleRequest {
  /** The `pos.payment_attempt` row this tender belongs to. Echoed on the result. */
  attemptId: string;
  amountSatang: number;
  tender: TerminalTender;
  /**
   * The vendor's own word for a wallet or QR tender — `THAIQRCODE`, `ALIPAY`,
   * `WECHATPAY` on GHL; the payment-type action code on Digio. Ignored for a
   * card. Left as the vendor's spelling on purpose: translating it here would
   * mean this file holding a table that goes stale the day either vendor adds a
   * wallet, and the cloud already stores what it asked for.
   */
  wallet?: string | null;
  /** Who is at the till. GHL stamps it; Digio requires it (tag `03`). */
  cashier?: string | null;
  /**
   * Ask the terminal to hand the QR payload back so OUR display draws it.
   *
   * Digio only (tag `06` = `02`, answered on an `A18` frame). GHL renders its
   * QR on the terminal's own screen and never returns a payload, so this is
   * ignored there rather than refused.
   */
  requestQrPayload?: boolean;
  /**
   * Which way the QR goes, for a wallet or QR tender.
   *
   * `show` is our display drawing a code the guest scans; `scan` is the staff
   * member reading the code off the guest's phone. Both vendors carry it and
   * neither infers it: GHL calls it `service_type` (`SHOWQR` / `SCAN`, p.11)
   * and Digio calls it `CN` (`02` C-scan-B / `01` B-scan-C). `show` is the
   * default because that is what the customer display is for.
   */
  qrDirection?: 'show' | 'scan';
  /** `x-oto-action-id`, carried for the log line and the `ops_run`. */
  actionId?: string | null;
  /** Told about the QR payload the moment it arrives, before the guest pays. */
  onProgress?: (event: TerminalProgress) => void;
}

/** Something worth knowing before the exchange is over. */
export interface TerminalProgress {
  kind: 'sent' | 'qr_payload';
  attemptId: string;
  deviceId: string;
  /** The EMVCo payload or wallet URL, on a `qr_payload` event. */
  qrPayload?: string;
  /** The terminal's handle for the transaction, as soon as it has one. */
  tranRef?: string | null;
  at: string;
}

export interface TerminalInquiryRequest {
  attemptId: string;
  tender: TerminalTender;
  wallet?: string | null;
  /**
   * The SALE's own reference.
   *
   * Required, and it is not a fresh one: GHL's QUERY is keyed on it
   * ("Same as Original Sale", p.13), so minting a new reference for an inquiry
   * would ask the terminal about a transaction that never existed.
   */
  terminalRef: string;
  /** Digio's tag `05` Transaction ID. Optional there, unused on GHL. */
  tranRef?: string | null;
  cashier?: string | null;
  /**
   * OPTIONAL, AND AN INQUIRY NEEDS NO AMOUNT.
   *
   * An inquiry asks what happened to a transaction; the terminal answers with
   * the amount it took, and that answer is the fact being sought rather than
   * something to check a request against. Pass the sale's amount if the caller
   * has it and it lands on `TerminalResult.requestedSatang` for the comparison
   * the CLOUD makes; leave it out and the result simply reports the approved
   * amount against `0`. Either way the answer-reader does not reclassify it:
   * the shortfall rule belongs to `sale` (`TERMINAL_EXCHANGES`).
   */
  amountSatang?: number;
}

export interface TerminalVoidRequest {
  attemptId: string;
  tender: TerminalTender;
  wallet?: string | null;
  /**
   * THE AMOUNT TO VOID, WHICH IS THE AMOUNT THE TERMINAL TOOK.
   *
   * Not the amount the sale asked for. After a partial approval the two
   * differ, and the one that belongs here is the sale's
   * `TerminalResult.approvedSatang` — what is actually being handed back, and
   * what both dialects answer the void with, on the void result's
   * `approvedSatang`.
   *
   * Passing the requested amount instead is not fatal — the void is keyed on
   * `tranRef` below and not on this field, and the answer-reader does not
   * treat the difference as a shortfall (`TERMINAL_EXCHANGES`) — but it is
   * still the wrong number to put on a record of money handed back.
   */
  amountSatang: number;
  /**
   * THE VOID KEY, and it is never the sale's `terminalRef`.
   *
   * GHL: the EDC's own `invoice_no` (p.16/p.17) — which is why the sale's
   * invoice number has to be persisted or the sale can never be voided. Digio:
   * tag `05` Transaction ID, `TID(8)+yyMMddHHmmss(12)+random(4)`. Both vendors
   * want a FRESH reference on the void itself, and the counter mints it.
   */
  tranRef: string;
  /** GHL cards need this as well as the invoice number (p.16). */
  approvalCode?: string | null;
  cashier?: string | null;
}

// --- Answers ----------------------------------------------------------------

/**
 * One exchange, as the cloud records it.
 *
 * Every field maps to a `pos.payment_attempt` column or to the `ops_run` the
 * adapter call writes. `ATTEMPT_ALLOW_LIST` in `@oto/shared` is applied on top
 * of this by C2 — this shape is already narrow, and the allow-list is the
 * second net rather than the first.
 */
export interface TerminalResult {
  attemptId: string;
  deviceId: string;
  protocol: TerminalProtocol;
  outcome: TerminalOutcomeKind;
  /** What we asked for. Kept beside the approval so the comparison is on the row. */
  requestedSatang: number;
  /**
   * What the terminal says it took, in satang, AFTER the round-trip.
   *
   * GHL sends decimal major units (`100.25`, p.8) and Digio sends satang as
   * ASCII digits, so this is the one number both are turned into — and the
   * "approved amount ≠ requested" check compares these integers, never the
   * strings. Null when nothing was approved.
   */
  approvedSatang: number | null;
  /** Our reference: 12 characters on GHL, six digits on Digio. */
  terminalRef: string | null;
  /** The vendor's handle for the transaction — the void key. */
  tranRef: string | null;
  /** GHL's EDC invoice number. Null on Digio, which has no such field. */
  invoiceNo: string | null;
  approvalCode: string | null;
  /** The last four digits of the masked PAN. The PAN itself is never kept. */
  last4: string | null;
  tid: string | null;
  mid: string | null;
  /** The EMVCo payload or wallet URL, when the terminal minted one for us. */
  qrPayload: string | null;
  /** The vendor's code, as sent, zero-padded where the vendor pads. */
  responseCode: string | null;
  /** The vendor's message, or ours where the vendor sends none. */
  responseText: string | null;
  elapsedMs: number;
  at: string;
}

export interface TerminalHealth {
  reachability: 'unknown' | 'reachable' | 'unreachable';
  /** Digio's `T1` reports both; GHL reports neither. */
  serialNumber: string | null;
  softwareVersion: string | null;
  /**
   * The identities, where this exchange learned them.
   *
   * On GHL they are never on the card wire at all (p.8) and come from the
   * device row; on Digio they arrive on tags `13`/`14` and are worth writing
   * BACK onto the device row, because the park's two PAX terminals have no
   * TID or MID on file (`DEVICE_INVENTORY.md:40-41`).
   */
  tid: string | null;
  mid: string | null;
  lastError: string | null;
  checkedAt: string;
}

/**
 * The one shape both dialects answer to.
 *
 * `void` is spelled as the plan spells it. It is a legal method name and the
 * word every person at a counter uses for the thing it does; calling it
 * `voidSale` would be this file being clever about a reserved word that is not
 * reserved here.
 */
export interface PaymentTerminal {
  readonly deviceId: string;
  readonly label: string;
  readonly protocol: TerminalProtocol;
  sale(request: TerminalSaleRequest): Promise<TerminalResult>;
  inquire(request: TerminalInquiryRequest): Promise<TerminalResult>;
  void(request: TerminalVoidRequest): Promise<TerminalResult>;
  /** Ask the machine whether it is there. Never throws. */
  health(): Promise<TerminalHealth>;
}

// --- The command the cloud sends --------------------------------------------

/**
 * The payload of an `edge.box_command` of kind `terminal_sale`.
 *
 * One kind for three exchanges rather than three kinds, because a command kind
 * is a CHECK constraint in four files (`protocol.ts:407-418`) and because the
 * three are one conversation: a tender, the inquiry that chases it when nothing
 * came back, and the void that undoes a partial approval. The discrimination is
 * `mode`, which costs nothing to read.
 *
 * `amountSatang` is on every mode. Only a `sale` is checked against it — an
 * approval for less than it reads `partial_approval`; on `inquire` it lands on
 * the result's `requestedSatang` for the cloud to compare and the answer is the
 * fact sought (`TerminalInquiryRequest`), and on `void` it is the amount being
 * handed back (`TerminalVoidRequest`).
 */
export const TerminalCommandPayloadSchema = z.object({
  mode: z.enum(TERMINAL_EXCHANGES).default('sale'),
  /** The attempt the outcome is reported against. */
  attemptId: z.string().uuid(),
  /** Which station's terminal. The box re-resolves it and its answer wins. */
  stationId: z.string().uuid().nullable().optional(),
  /** `card_terminal` or `qr_terminal`. Defaulted from the tender when absent. */
  role: z.string().max(32).nullable().optional(),
  /** Name the device outright, for a Console panel acting on one terminal. */
  deviceId: z.string().uuid().nullable().optional(),
  amountSatang: z.number().int().min(0),
  tender: z.enum(TERMINAL_TENDERS).default('card'),
  wallet: z.string().max(32).nullable().optional(),
  cashier: z.string().max(64).nullable().optional(),
  requestQrPayload: z.boolean().optional(),
  qrDirection: z.enum(['show', 'scan']).optional(),
  /** `inquire` only: the sale's own reference, which is the lookup key. */
  terminalRef: z.string().max(32).nullable().optional(),
  /** `inquire` and `void`: the vendor's handle for the transaction. */
  tranRef: z.string().max(64).nullable().optional(),
  /** `void` of a GHL card: required beside the invoice number. */
  approvalCode: z.string().max(12).nullable().optional(),
});
export type TerminalCommandPayload = z.infer<typeof TerminalCommandPayloadSchema>;

// --- The simulator's side of the same contract ------------------------------

/**
 * A simulated terminal, and what makes one worth having.
 *
 * Not a stub that answers "approved": a byte-stream device that takes exactly
 * the bytes the adapter writes to the real terminal and answers with exactly
 * the frames the vendor documents, so that whatever the simulator proves about
 * the adapter is a claim about the code that will drive the machine in Phuket —
 * because it IS that code. The same argument `printing/index.ts:112-118` makes
 * for the printers, and the same reason both seeded EDC rows are
 * `transport: 'simulated'` while the adapters are written against the truth.
 */
export interface TerminalSimulator {
  readonly deviceId: string;
  readonly label: string;
  readonly protocol: TerminalProtocol;
  /** What the NEXT exchange will do. Set before the tender, never after. */
  readonly outcome: SimulatedOutcome;
  setOutcome(outcome: SimulatedOutcome, opts?: SimulatedOutcomeOptions): void;
  /** Move the terminal's own clock, which is what makes the void windows real. */
  advanceClock(minutes: number): void;
  /** Open a session. The adapter cannot tell this from a serial port. */
  connect(): TerminalChannel;
  /** What this terminal has taken, for an inquiry or a void to find. */
  transactions(): SimulatedTransaction[];
  events(limit?: number): TerminalSimulatorEvent[];
}

/**
 * The six answers a terminal can be made to give.
 *
 * The words are `TERMINAL_OUTCOMES` in `@oto/shared`, which is what the
 * Console's panel sends; they are re-stated here as a type rather than
 * imported as one so this contract stays readable on its own, and the union is
 * compared against the shared list in the tests.
 */
export type SimulatedOutcome =
  | 'approved'
  | 'declined'
  | 'partial'
  | 'no_response'
  | 'inquiry_unavailable'
  | 'timeout';

export interface SimulatedOutcomeOptions {
  /** For `partial`: what the terminal approves instead of what was asked. */
  approvedSatang?: number;
  /** The approval code it prints. Minted when none is given. */
  approvalCode?: string;
}

/** One transaction a simulated terminal is holding. */
export interface SimulatedTransaction {
  /** Our reference, as it arrived. */
  ref: string;
  /** The terminal's own handle: an invoice number (GHL) or a transaction id. */
  tranRef: string;
  approvalCode: string | null;
  amountSatang: number;
  /** `CARD`, `THAIQRCODE`, `A1`, `A3` — the vendor's own word for what it was. */
  kind: string;
  /** The simulated clock when it was taken. */
  at: string;
  voided: boolean;
}

export type TerminalSimulatorEventKind =
  | 'request'
  | 'response'
  | 'withheld'
  | 'refused'
  | 'outcome.set'
  | 'clock.advanced';

/**
 * One line of a simulated terminal's tape.
 *
 * WHAT A `detail` MAY CARRY: the action or trade type, the response code, the
 * amounts, the references, and the reason a frame was withheld or refused —
 * what a Console panel needs to show what the terminal did. WHAT IT MAY NOT:
 * the frame. A Digio `A1` carries a masked PAN on tag `09` and the
 * cardholder's name on tag `0A`, a GHL card response carries `card_no`, and a
 * tape is read by a panel and can be copied into a ticket. The simulators
 * therefore summarise every message as they send it and never write the bytes
 * down — see `simulator-digio.ts`'s `tapeOf` and `simulator-ghl.ts`'s.
 */
export interface TerminalSimulatorEvent {
  at: string;
  kind: TerminalSimulatorEventKind;
  detail: Record<string, unknown>;
}

export interface TerminalSimulatorOptions {
  deviceId: string;
  label: string;
  /** The identities this terminal reports, from its device row. */
  terminalId?: string | null;
  merchantId?: string | null;
  serialNumber?: string | null;
  now?: () => Date;
  /** How many transactions and events to keep. A Pi has finite memory. */
  keep?: number;
  /**
   * When the terminal's day ends, in its own local time.
   *
   * OURS, and a simplification of two vendor sentences that are not quite the
   * same: GHL says a card must be voided "before cashier settlement" and a
   * wallet "before 11PM" (p.15), and Digio answers `205` "already settled" to a
   * void after its own settlement. Neither document says when settlement runs,
   * so the simulator treats the clock passing this hour as the settlement — it
   * is the only thing "Advance terminal clock" can mean that reproduces both
   * refusals, and it is what the park's staff will recognise.
   */
  settlementHourLocal?: number;
  /** Minutes east of UTC for that hour. Asia/Bangkok, so +420. */
  timezoneOffsetMinutes?: number;
}

/** Which station-device role takes which tender. */
export function roleForTender(tender: TerminalTender): 'card_terminal' | 'qr_terminal' {
  return tender === 'card' ? 'card_terminal' : 'qr_terminal';
}

/** The protocol on a device row, or null when it is not a terminal we speak. */
export function terminalProtocolOf(protocol: string | null | undefined): TerminalProtocol | null {
  return (TERMINAL_PROTOCOLS as readonly string[]).includes(protocol ?? '')
    ? (protocol as TerminalProtocol)
    : null;
}

/**
 * The last four digits of a masked PAN, and nothing else.
 *
 * Both vendors mask before we see it — `444433XXXXXX9887` on GHL (p.8),
 * `49215911****6014` on Digio (tag `09`) — so this is not redaction, it is
 * refusing to carry what we were handed. Anything that is not four trailing
 * digits answers null rather than a guess.
 */
export function last4Of(maskedPan: string | null | undefined): string | null {
  if (!maskedPan) return null;
  const tail = maskedPan.trim().slice(-4);
  return /^\d{4}$/.test(tail) ? tail : null;
}
