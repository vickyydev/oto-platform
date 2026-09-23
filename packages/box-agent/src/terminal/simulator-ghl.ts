/**
 * A NEXGO N5 that is not there (S2-10a).
 *
 * It answers the same XML the real SmartEDC answers, on the same wire, behind
 * the same adapter — so a test that drives this is a test of `ghl.ts`, which is
 * the file that goes to Phuket. What it cannot be is a stub: the six outcomes
 * the Console's panel offers are all branches of the ticket's acceptance, and
 * the two that a stub cannot have are the two that matter most — `no_response`
 * writes nothing back at all, and `inquiry_unavailable` also declines to answer
 * the QUERY, which for a card on this dialect is not a fault but the permanent
 * state of the vendor's protocol.
 *
 * Every response here is RECONSTRUCTED from the parameter tables: the vendor
 * PDF prints no response XML anywhere (p.18 is a request builder). The element
 * names, types and requiredness are the document's; the envelope is the
 * sample's convention. The fixtures say so in their headers.
 */

import {
  TerminalError,
  type SimulatedOutcome,
  type SimulatedOutcomeOptions,
  type SimulatedTransaction,
  type TerminalChannel,
  type TerminalSimulator,
  type TerminalSimulatorEvent,
  type TerminalSimulatorEventKind,
  type TerminalSimulatorOptions,
} from './contract';
import {
  GHL_CARD_TRADE_TYPE,
  GHL_POS_REF_MAX,
  GHL_SHOWQR_ONLY,
  encodeGhlResponse,
  ghlAmount,
  ghlFrameScanner,
  ghlSatang,
  parseGhl,
  type GhlFields,
} from './ghl';
import { loopbackChannel } from './serial-channel';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/**
 * A masked card number and a cardholder name, because the real one sends both.
 *
 * `card_no` is String(19) and already masked by the terminal (p.8). A simulator
 * that left it out would never exercise the one rule that matters about it —
 * that the adapter keeps four digits and drops the rest — and would give the
 * redaction fixture nothing to redact. The value is a recognisable test number
 * with its middle starred: it is a placeholder, not a card.
 */
const SIM_MASKED_PAN = '424242******4242';

/** How long a simulated guest takes, when the panel asks for a slow one. */
export interface GhlSimulatorOptions extends TerminalSimulatorOptions {
  /** Milliseconds before the answer comes back. §9.5's 30-90 second guest. */
  answerDelayMs?: number;
}

export function createGhlSimulator(options: GhlSimulatorOptions): TerminalSimulator {
  const now = options.now ?? (() => new Date());
  const keep = options.keep ?? 20;
  const settlementHour = options.settlementHourLocal ?? 23;
  const tzOffsetMinutes = options.timezoneOffsetMinutes ?? 420;
  const log: TerminalSimulatorEvent[] = [];
  const taken: SimulatedTransaction[] = [];
  let outcome: SimulatedOutcome = 'approved';
  let outcomeOpts: SimulatedOutcomeOptions = {};
  let clockSkewMs = 0;
  let invoiceSeq = 0;
  let approvalSeq = 0;

  const at = (): string => new Date(now().getTime() + clockSkewMs).toISOString();

  function note(kind: TerminalSimulatorEventKind, detail: Record<string, unknown> = {}): void {
    log.push({ at: at(), kind, detail });
    if (log.length > keep * 4) log.splice(0, log.length - keep * 4);
  }

  /** The next invoice number the SmartEDC would print. Six digits (p.8). */
  function nextInvoice(): string {
    invoiceSeq += 1;
    return String(invoiceSeq).padStart(6, '0');
  }

  function nextApproval(): string {
    approvalSeq += 1;
    // String(6) from the SCB host (p.8). Letters and digits, so it can never be
    // read as an amount or a reference by something scanning a log.
    return `R${String(approvalSeq).padStart(5, '0')}`;
  }

  /**
   * Has this terminal's day ended since the transaction was taken?
   *
   * The void window, in one place: a card must be voided before settlement and
   * a wallet before 11PM (p.15), and the simulator treats its clock passing the
   * settlement hour as both. This is what "Advance terminal clock" is for.
   */
  function settledSince(transactionAt: string): boolean {
    const local = (iso: string): Date => new Date(Date.parse(iso) + tzOffsetMinutes * 60_000);
    const from = local(transactionAt);
    const to = local(at());
    const boundary = new Date(from.getTime());
    boundary.setUTCHours(settlementHour, 0, 0, 0);
    if (boundary.getTime() <= from.getTime()) boundary.setUTCDate(boundary.getUTCDate() + 1);
    return to.getTime() >= boundary.getTime();
  }

  function remember(entry: SimulatedTransaction): void {
    taken.push(entry);
    if (taken.length > keep) taken.splice(0, taken.length - keep);
  }

  function respond(emit: (bytes: Uint8Array, afterMs?: number) => void, fields: GhlFields): void {
    const xml = encodeGhlResponse(fields);
    note('response', tapeOf(fields));
    emit(encoder.encode(xml), options.answerDelayMs ?? 0);
  }

  /**
   * What a response puts on the tape, and it is not the message.
   *
   * A card response carries `card_no` — masked by the terminal, and still a
   * card number — and the tape is read by a Console panel through
   * `TerminalController.events` and can be copied out of one into a ticket.
   * So the message goes out without being written down and the tape carries
   * what a panel needs: which trade type answered what, with which code, for
   * how much, against which reference. `card_approval_code` is left off with
   * `card_no`: it is a void key, it belongs on the result where the void is
   * made from it, and a panel has no use for it.
   */
  function tapeOf(fields: GhlFields): Record<string, unknown> {
    const detail: Record<string, unknown> = {};
    const put = (key: string, value: string | undefined): void => {
      if (value) detail[key] = value;
    };
    put('tradeType', fields.trade_type);
    put('transactionType', fields.transaction_type);
    put('ref', fields.pos_ref_no);
    put('responseCode', fields.response_code);
    put('responseMsg', fields.response_msg);
    put('amount', fields.amount);
    put('invoiceNo', fields.invoice_no);
    put('transactionId', fields.transaction_id);
    return detail;
  }

  function handleSale(
    request: GhlFields,
    emit: (bytes: Uint8Array, afterMs?: number) => void,
  ): void {
    const tradeType = (request.trade_type ?? '').toUpperCase();
    const ref = request.pos_ref_no ?? '';
    const card = tradeType === GHL_CARD_TRADE_TYPE;
    const requested = ghlSatang(request.amount) ?? 0;

    if (ref.length > GHL_POS_REF_MAX) {
      /**
       * The reference-length constraint, enforced.
       *
       * The document gives three different lengths for this field across three
       * tables; twelve is the one that fits all of them, and a simulator that
       * accepted more would let an adapter ship a reference the QUERY table
       * cannot hold. `30` is the document's own format error (p.9).
       */
      note('refused', { reason: 'pos_ref_no longer than 12', ref });
      respond(emit, {
        pos_ref_no: ref,
        response_code: card ? '30' : '01',
        response_msg: 'FAIL',
        amount: request.amount ?? '',
      });
      return;
    }
    if (
      !card &&
      (request.service_type ?? '') === 'SCAN' &&
      GHL_SHOWQR_ONLY.includes(tradeType)
    ) {
      note('refused', { reason: 'this wallet is show-QR only', tradeType });
      respond(emit, { pos_ref_no: ref, response_code: '01', response_msg: 'FAIL' });
      return;
    }

    if (outcome === 'no_response' || outcome === 'inquiry_unavailable' || outcome === 'timeout') {
      /**
       * Nothing goes back. Three outcomes look the same on this wire and are
       * three different situations, so the tape says which: the vendor
       * documents no timeout, retry or ACK semantics anywhere, so there is no
       * frame that could mean "I gave up".
       */
      note('withheld', { because: outcome, tradeType, ref });
      return;
    }

    if (outcome === 'declined') {
      respond(emit, {
        pos_ref_no: ref,
        // `05` Do not honor for a card; `01` FAILED in the wallet space.
        response_code: card ? '05' : '01',
        response_msg: 'FAIL',
        amount: request.amount ?? '',
      });
      return;
    }

    const approvedSatang =
      outcome === 'partial'
        ? (outcomeOpts.approvedSatang ?? Math.max(0, requested - 100))
        : requested;
    const invoiceNo = nextInvoice();
    const approvalCode = card ? (outcomeOpts.approvalCode ?? nextApproval()) : null;
    // A card response has no transaction_id (p.8); a wallet's does (p.11).
    const transactionId = card ? undefined : `${Date.parse(at())}${invoiceNo}`;
    remember({
      ref,
      tranRef: invoiceNo,
      approvalCode,
      amountSatang: approvedSatang,
      kind: tradeType,
      at: at(),
      voided: false,
    });
    respond(emit, {
      pos_ref_no: ref,
      // `10` Partial approval is a card code; the wallet space has no such
      // thing, so there the lower amount is the only evidence — which is
      // exactly the case the adapter's integer comparison exists for.
      response_code: outcome === 'partial' && card ? '10' : '00',
      response_msg: 'SUCCESS',
      invoice_no: invoiceNo,
      transaction_id: transactionId,
      card_no: card ? SIM_MASKED_PAN : undefined,
      amount: ghlAmount(approvedSatang),
      card_approval_code: approvalCode ?? undefined,
    });
  }

  function handleQuery(
    request: GhlFields,
    emit: (bytes: Uint8Array, afterMs?: number) => void,
  ): void {
    const tradeType = (request.trade_type ?? '').toUpperCase();
    if (tradeType === GHL_CARD_TRADE_TYPE) {
      /**
       * "***Cannot QUERY for trade type CARD" (p.13).
       *
       * The adapter refuses this before a byte goes out; if one arrives anyway
       * the terminal has nothing to say, and the silence is the vendor's answer
       * rather than the simulator's shrug.
       */
      note('refused', { reason: 'this dialect has no QUERY for a card sale' });
      return;
    }
    if (outcome === 'inquiry_unavailable' || outcome === 'no_response') {
      note('withheld', { because: outcome, transactionType: 'QUERY' });
      return;
    }
    const ref = request.pos_ref_no ?? '';
    const found = taken.find((entry) => entry.ref === ref && !entry.voided);
    if (!found) {
      respond(emit, {
        pos_ref_no: ref,
        transaction_type: 'QUERY',
        trade_type: tradeType,
        response_code: '01',
        response_msg: 'FAIL',
      });
      return;
    }
    respond(emit, {
      pos_ref_no: ref,
      transaction_type: 'QUERY',
      trade_type: found.kind,
      amount: ghlAmount(found.amountSatang),
      response_code: '00',
      response_msg: 'Success',
      // TID and MID reach us only through a QUERY on this dialect (p.14).
      terminal_id: options.terminalId ?? '',
      merchant_id: options.merchantId ?? '',
      transaction_id: found.tranRef,
      invoice_no: found.tranRef,
    });
  }

  function handleVoid(
    request: GhlFields,
    emit: (bytes: Uint8Array, afterMs?: number) => void,
  ): void {
    const tradeType = (request.trade_type ?? '').toUpperCase();
    const invoiceNo = request.invoice_no ?? '';
    const fail = (reason: string): void => {
      note('refused', { reason, invoiceNo });
      // Every VOID answers in the `00`/`01` space, whatever the trade type
      // (pp.16-17) — not the ISO space a card SALE answers in.
      respond(emit, {
        pos_ref_no: request.pos_ref_no ?? '',
        response_code: '01',
        response_msg: 'FAIL',
        invoice_no: invoiceNo,
        amount: request.amount ?? '',
      });
    };
    if (tradeType === 'THAIQRCODE') {
      fail('Thai QR cannot be voided (p.15)');
      return;
    }
    const found = taken.find((entry) => entry.tranRef === invoiceNo);
    if (!found) {
      fail('no such invoice number');
      return;
    }
    if (found.voided) {
      fail('already voided');
      return;
    }
    if (tradeType === GHL_CARD_TRADE_TYPE && found.approvalCode !== (request.card_approval_code ?? null)) {
      fail('the approval code does not match the invoice number');
      return;
    }
    if (settledSince(found.at)) {
      fail(
        tradeType === GHL_CARD_TRADE_TYPE
          ? 'a card must be voided before settlement (p.15)'
          : 'a wallet must be voided before 11PM (p.15)',
      );
      return;
    }
    found.voided = true;
    respond(emit, {
      pos_ref_no: request.pos_ref_no ?? '',
      response_code: '00',
      response_msg: 'SUCCESS',
      invoice_no: invoiceNo,
      transaction_id: found.kind === GHL_CARD_TRADE_TYPE ? undefined : found.tranRef,
      amount: ghlAmount(found.amountSatang),
    });
  }

  function handle(request: GhlFields, emit: (bytes: Uint8Array, afterMs?: number) => void): void {
    const transactionType = (request.transaction_type ?? '').toUpperCase();
    note('request', { transactionType, tradeType: request.trade_type, ref: request.pos_ref_no });
    if (transactionType === 'SALE') return handleSale(request, emit);
    if (transactionType === 'QUERY') return handleQuery(request, emit);
    if (transactionType === 'VOID') return handleVoid(request, emit);
    note('refused', { reason: `no such transaction_type: ${transactionType}` });
  }

  return {
    deviceId: options.deviceId,
    label: options.label,
    protocol: 'ghl_linkpos',
    get outcome() {
      return outcome;
    },
    setOutcome(next, opts = {}) {
      outcome = next;
      outcomeOpts = opts;
      note('outcome.set', { outcome: next, approvedSatang: opts.approvedSatang ?? null });
    },
    advanceClock(minutes) {
      clockSkewMs += minutes * 60_000;
      note('clock.advanced', { minutes, clockSkewMs });
    },
    connect(): TerminalChannel {
      /**
       * The simulator frames its own input with the SAME scanner the adapter
       * reads with, rather than assuming one write is one message. A real
       * terminal reads a stream; so does this, and the scanner is proved in
       * both directions by being used in both.
       */
      let buffer = new Uint8Array(0);
      return loopbackChannel((bytes, emit) => {
        const merged = new Uint8Array(buffer.length + bytes.length);
        merged.set(buffer);
        merged.set(bytes, buffer.length);
        buffer = merged;
        for (;;) {
          const span = ghlFrameScanner(buffer);
          if (!span) return;
          const frame = buffer.slice(span.start, span.end);
          buffer = buffer.slice(span.end);
          try {
            handle(parseGhl(decoder.decode(frame)), emit);
          } catch (err) {
            if (err instanceof TerminalError) {
              note('refused', { reason: err.message, code: err.code });
              continue;
            }
            throw err;
          }
        }
      });
    },
    transactions: () => taken.slice(),
    events: (limit = keep * 2) => log.slice(-limit),
  };
}
