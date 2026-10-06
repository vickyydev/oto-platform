import {
  BRIDGE_CART_QUOTE_INTENT,
  BRIDGE_RECEIPT_OBSERVED_INTENT,
  BRIDGE_SALE_INTENTS,
  BRIDGE_WALLET_INTENTS,
  type BridgeSaleAnswer,
  type BridgeSaleView,
  type BridgeWalletSpendAnswer,
} from '@oto/shared';
import { bridgeApi, bridgeStaffName } from './bridge';
import type { ApiSaleBand, ApiSaleLine } from './history';
import type { PaymentAttemptRead, PaymentConfirmationBody, PaymentStartBody, PaymentStartResult } from './payments';
import type { ApiSale, ApiSaleQuote, SaleCartPayload, SaleTenderPayload } from './sales';

/**
 * SELLING ON THE BOX LANE — the till's half (offline plan §2.4, Round 4).
 *
 * The same cart a till commits to the platform commits through its box when
 * the lane arbiter says box (`lib/lane.ts`), under the ids the till minted
 * (OD-12): the sale, every line, the press. The box prices it again, numbers
 * it, bands it, prints it and queues it for the platform in one transaction
 * (`SaleQueue.record`), and the till reads the answer in the platform's own
 * shapes — an `ApiSale`, a `PaymentAttemptView` — so the screens that show a
 * sale do not know which lane took it.
 *
 * A SALE STAYS ON THE LANE IT WAS RUNG UP ON. What the box holds for a sale is
 * kept here by its id, so every call about it — the cash, a card on the
 * counter's own terminal, a read while a guest finds a card, a staff
 * confirmation — goes back to the box that holds it, whatever the lane says by
 * then. An electronic tender started on the platform is never moved to the
 * box: its outcome may be unknown, and a second charge must not follow an
 * unknown one (plan §2.1). Cash has no unknown outcome, so a sale rung up on
 * the platform that loses its link at the cash press is closed on the box,
 * under the same ids, and meets itself on replay.
 */

/** A sale the till rang up, as the box lane needs it: what was sold and under which ids. */
export interface BoxLaneSale {
  stationId: string;
  saleId: string;
  /** The Pay press — the sale's own action id. */
  actionId: string;
  /** The till's clock when Pay was pressed. */
  occurredAt: string;
  cart: SaleCartPayload;
  visitId: string | null;
  note: string | null;
  /** Which lane it was rung up on. Only a box-lane sale takes a terminal tender on the box. */
  lane: 'platform' | 'box';
  /** The box's last answer about it, once it has closed or holds a tender. */
  answer: BridgeSaleAnswer | null;
}

const sales = new Map<string, BoxLaneSale>();
const attempts = new Map<string, string>();

/** Keep what the till rang up, so a later call about it knows where it lives. */
export function holdLaneSale(sale: Omit<BoxLaneSale, 'answer'> & { answer?: BridgeSaleAnswer | null }): BoxLaneSale {
  const kept: BoxLaneSale = { ...sale, answer: sale.answer ?? sales.get(sale.saleId)?.answer ?? null };
  sales.set(sale.saleId, kept);
  return kept;
}

export function laneSale(saleId: string): BoxLaneSale | null {
  return sales.get(saleId) ?? null;
}

/** The box-lane sale a terminal attempt belongs to, or null for a platform attempt. */
export function boxSaleOfAttempt(attemptId: string): BoxLaneSale | null {
  const saleId = attempts.get(attemptId);
  return saleId ? (sales.get(saleId) ?? null) : null;
}

export function forgetLaneSale(saleId: string): void {
  const held = sales.get(saleId);
  if (!held) return;
  sales.delete(saleId);
  for (const [attemptId, owner] of attempts) if (owner === saleId) attempts.delete(attemptId);
}

function remember(sale: BoxLaneSale, answer: BridgeSaleAnswer): BridgeSaleAnswer {
  sale.answer = answer;
  if (answer.attempt) attempts.set(answer.attempt.id, sale.saleId);
  return answer;
}

/** The box's sale in the till's `ApiSale` shape. */
export function apiSaleOfBox(view: BridgeSaleView): ApiSale {
  return {
    id: view.id,
    status: view.status,
    businessDate: view.businessDate,
    occurredAt: view.occurredAt,
    receiptNumber: view.receiptNumber,
    receiptSeries: view.receiptSeries,
    receiptSeq: view.receiptSeq,
    stationId: view.stationId,
    boxId: view.boxId,
    pricingMode: view.pricingMode,
    customerTier: view.customerTier,
    totals: view.totals,
    engineVersion: view.engineVersion,
  };
}

/**
 * What the confirmation screen shows for a sale closed on the box lane, when the
 * platform's own sale read cannot be reached (offline finding 3). The box's
 * finalise answer already carries the bands it minted, so the payment-done
 * screen reads its codes from there — the receipt number, the SHORT codes and
 * the children they name — and draws them exactly as the online screen does.
 */
export interface BoxSaleIssue {
  receiptNumber: string | null;
  bands: ApiSaleBand[];
  /** The ledger lines the bands sit on, so `bandsByCartLine` can place them. */
  lines: Pick<ApiSaleLine, 'id' | 'cartLineId'>[];
}

/**
 * The box-lane confirmation's bands, or null when this sale was not closed on
 * the box (the online read serves it) or the box answered without bands.
 */
export function boxSaleIssue(saleId: string): BoxSaleIssue | null {
  const answer = sales.get(saleId)?.answer;
  // An answer exists only when the box answered, so its presence — not the lane
  // the sale was rung up on — is the "closed on the box" fact. A cash press on a
  // platform-rung sale that meets a dropped link closes on the box under the
  // same ids, keeping `lane: 'platform'`; its bands must still show here.
  if (!answer?.finalised || !answer.bands) return null;
  const lines = new Map<string, Pick<ApiSaleLine, 'id' | 'cartLineId'>>();
  for (const band of answer.bands) {
    if (band.saleLineId) lines.set(band.saleLineId, { id: band.saleLineId, cartLineId: band.cartLineId });
  }
  return {
    receiptNumber: answer.sale.receiptNumber,
    bands: answer.bands.map((band) => ({
      id: band.id,
      kind: band.kind,
      status: band.status,
      shortCode: band.shortCode,
      saleLineId: band.saleLineId,
      childId: band.childId,
      childName: band.childName,
      printedJobId: null,
      createdAt: answer.sale.occurredAt,
    })),
    lines: [...lines.values()],
  };
}

/** The sale as rung up on the box: priced there, not yet paid, no number yet. */
export async function rungUpOnBox(sale: Omit<BoxLaneSale, 'answer' | 'lane'>): Promise<ApiSale> {
  const priced = await bridgeApi.intent<{ quote: ApiSaleQuote }>(
    sale.stationId,
    BRIDGE_CART_QUOTE_INTENT,
    sale.cart as unknown as Record<string, unknown>,
  );
  const quote = priced.result!.quote;
  holdLaneSale({ ...sale, lane: 'box' });
  return {
    id: sale.saleId,
    status: 'tendering',
    businessDate: quote.businessDate ?? sale.occurredAt.slice(0, 10),
    occurredAt: sale.occurredAt,
    receiptNumber: null,
    receiptSeries: null,
    receiptSeq: null,
    stationId: sale.stationId,
    pricingMode: quote.pricingMode,
    customerTier: quote.tier ?? sale.cart.tier,
    totals: quote.totals,
    engineVersion: quote.engineVersion,
  };
}

function saleBody(sale: BoxLaneSale): Record<string, unknown> {
  const staffName = bridgeStaffName();
  return {
    saleId: sale.saleId,
    actionId: sale.actionId.slice(0, 200),
    occurredAt: sale.occurredAt,
    ...(sale.visitId ? { visitId: sale.visitId } : {}),
    ...(sale.note ? { note: sale.note } : {}),
    ...(staffName ? { staffName } : {}),
    cart: sale.cart as unknown as Record<string, unknown>,
  };
}

/**
 * Close the sale on the box with cash, or with nothing at all when it owes
 * nothing (a ฿0 comp). `NO_TENDER` — a zero amount — is nothing.
 */
export async function finaliseOnBox(
  sale: BoxLaneSale,
  tender: SaleTenderPayload | undefined,
  actionId: string,
): Promise<BridgeSaleAnswer> {
  const money =
    tender && tender.amountSatang > 0
      ? {
          actionId: actionId.slice(0, 200),
          method: tender.method,
          kind: tender.kind,
          amountSatang: tender.amountSatang,
          tenderedSatang: tender.tenderedSatang,
          changeSatang: tender.changeSatang,
        }
      : null;
  const answer = await bridgeApi.intent<BridgeSaleAnswer>(
    sale.stationId,
    BRIDGE_SALE_INTENTS.finalise,
    { ...saleBody(sale), tender: money },
    { actionId },
  );
  return remember(sale, answer.result!);
}

/**
 * Staging F3 — "USE CREDIT" ON THE BOX LANE: the box's own `payment.wallet`
 * (S2-14a round 4), on the sale it holds, under the till's ids. The box takes
 * min(what the wallet holds here, what the offline cap leaves today, what the
 * order owes) — written ahead and counted once per press, so the same press
 * again answers from its log or its hold and spends nothing twice. Credit that
 * covers the order closes it on the box; otherwise the rest is owed to the
 * next press, which is the box lane's cash (`finaliseOnBox`). Refusals arrive
 * as an `ApiError` in the box's words (`WALLET_OFFLINE_CAP`, `WALLET_EXPIRED`,
 * `WALLET_NOT_ON_BOX`, …).
 *
 * From the credit on, the sale lives on the box: a sale rung up on the
 * platform whose till moved to its box takes the rest there too, so the credit
 * and the cash close it together.
 */
export async function spendWalletOnBox(
  sale: BoxLaneSale,
  wallet: { key: string; actionId: string },
): Promise<BridgeWalletSpendAnswer> {
  const answer = await bridgeApi.intent<BridgeWalletSpendAnswer>(
    sale.stationId,
    BRIDGE_WALLET_INTENTS.spend,
    {
      ...saleBody(sale),
      wallet: { key: wallet.key.trim(), actionId: wallet.actionId.slice(0, 200), useCredit: true },
    },
    { actionId: wallet.actionId },
  );
  const result = answer.result!;
  const held = holdLaneSale({ ...sale, lane: 'box' });
  remember(held, result);
  return result;
}

/** A card or the PAX QR on the counter's own terminal, driven by the box. */
export async function startOnBox(sale: BoxLaneSale, body: PaymentStartBody): Promise<PaymentStartResult> {
  const answer = await bridgeApi.intent<BridgeSaleAnswer>(
    sale.stationId,
    BRIDGE_SALE_INTENTS.paymentStart,
    {
      ...saleBody(sale),
      tender: {
        actionId: body.actionId.slice(0, 200),
        method: body.method,
        kind: body.tender === 'qr' ? 'qr' : 'card',
        amountSatang: body.amountSatang ?? sale.cart.expectedTotalSatang,
      },
    },
    { actionId: body.actionId },
  );
  const result = remember(sale, answer.result!);
  return {
    route: 'card_terminal',
    attempt: result.attempt,
    replayed: result.replay,
    outstandingSatang: result.outstandingSatang,
    qrPayload: null,
    qrImageUrl: null,
    expiresAt: null,
    expiryTimerMs: null,
  };
}

async function onHeld(
  attemptId: string,
  type: string,
  extra: Record<string, unknown>,
  actionId?: string,
): Promise<{ sale: BoxLaneSale; answer: BridgeSaleAnswer }> {
  const sale = boxSaleOfAttempt(attemptId);
  if (!sale) throw new Error('That payment is not held by this counter’s box');
  const answer = await bridgeApi.intent<BridgeSaleAnswer>(
    sale.stationId,
    type,
    { saleId: sale.saleId, attemptId, ...extra },
    actionId ? { actionId } : {},
  );
  return { sale, answer: remember(sale, answer.result!) };
}

/** Where a tender the box holds stands — what the payment stage polls. */
export async function readOnBox(attemptId: string): Promise<PaymentAttemptRead> {
  const { answer } = await onHeld(attemptId, BRIDGE_SALE_INTENTS.paymentStatus, {});
  return {
    attempt: answer.attempt!,
    deviceLabel: null,
    responseText: null,
    outstandingSatang: answer.outstandingSatang,
    qrPayload: null,
    qrImageUrl: null,
    expiresAt: null,
    expiryTimerMs: null,
  };
}

/** Ask the terminal what became of a tender with no final answer. */
export async function inquireOnBox(attemptId: string, actionId: string) {
  const { answer } = await onHeld(attemptId, BRIDGE_SALE_INTENTS.paymentInquire, {}, actionId);
  return { attempt: answer.attempt! };
}

/** Staff confirm a GHL card with no answer against the terminal's own screen (OD-3). */
export async function confirmOnBox(attemptId: string, body: PaymentConfirmationBody, actionId: string) {
  const { answer } = await onHeld(
    attemptId,
    BRIDGE_SALE_INTENTS.paymentConfirm,
    {
      took: body.took,
      ...(body.approvalCode ? { approvalCode: body.approvalCode } : {}),
      ...(body.last4 ? { last4: body.last4 } : {}),
      ...(body.note ? { note: body.note } : {}),
    },
    actionId,
  );
  return { attempt: answer.attempt! };
}

/**
 * Tell the box the number the platform gave an online sale at this station
 * (OD-4), so its offline series never re-issues it. Best effort: a box that
 * cannot be told now is told by the next online sale.
 */
export function observeReceipt(stationId: string | null, receiptNumber: string | null | undefined): void {
  if (!stationId || !receiptNumber) return;
  void bridgeApi
    .intent(stationId, BRIDGE_RECEIPT_OBSERVED_INTENT, { receiptNumber })
    .catch(() => undefined);
}
