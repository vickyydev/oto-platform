import { DisplayMerchCartSchema, DisplayTotalsSchema, DisplayPaymentSchema,
  type DisplayMerchCart, type DisplayTotals, type StationSessionStage } from '@oto/shared';
import type { ApiSale, CartQuote } from '@/api/sales';
import type { MerchOrder, MerchOrderLine, ManualDiscount } from '@/types';
import type { PaymentDisplayState } from '@/lib/usePaymentStage';
import { useStationDisplay } from '@/lib/displaySession';

export interface MerchDisplayState {
  sessionKey: string;
  stage: 'welcome' | 'order' | 'payment' | 'thankyou';
  online: boolean;
  excluded: boolean;
  lines: readonly MerchOrderLine[];
  manualDiscounts: readonly ManualDiscount[];
  quote: CartQuote;
  pending: boolean;
  quoteFailed: boolean;
  payment: PaymentDisplayState;
  completedOrder: MerchOrder | null;
  platformSale: ApiSale | null;
}

const satang = (value: number) => Math.round(value * 100);
const validMoney = (value: number) => Number.isFinite(value) && value >= 0
  && Number.isSafeInteger(satang(value)) && Math.abs(value * 100 - satang(value)) < 0.001;
const emptyCart = (): DisplayMerchCart => ({ kind: 'merch', supported: false,
  lines: [], manualDiscounts: [], completion: null });

/** The shop sends only the quoted guest presentation through the existing lease. */
export function merchDisplayPresentation(state: MerchDisplayState) {
  const fallback = { stage: state.stage as StationSessionStage, step: null,
    cart: emptyCart(), member: null, prompt: null, totals: null, payment: null };
  if (!state.online || state.excluded) return fallback;
  if (state.stage === 'welcome') return { ...fallback, cart: { ...emptyCart(), supported: true } };
  if (state.quote.source !== 'platform' || state.pending || state.quoteFailed || !state.lines.length) return fallback;
  const lines: DisplayMerchCart['lines'] = [];
  for (const line of state.lines) {
    const captured = state.quote.itemPresentation?.[line.id];
    const lineTotal = state.quote.lineTotals?.[line.id];
    if (!captured || typeof captured.name !== 'string' || !Array.isArray(captured.modifiers)
      || captured.modifiers.length || lineTotal === undefined || !validMoney(captured.basePrice)
      || !validMoney(lineTotal) || satang(captured.basePrice) * line.qty !== satang(lineTotal)) return fallback;
    // The captured name already contains the platform's size label when sold.
    lines.push({ id: line.id, name: captured.name, qty: line.qty, unitPrice: captured.basePrice, lineTotal });
  }
  const totals = DisplayTotalsSchema.safeParse(state.quote.totals);
  if (!totals.success) return fallback;
  let completion: DisplayMerchCart['completion'] = null;
  if (state.stage === 'thankyou') {
    const { platformSale, completedOrder } = state;
    if (!platformSale || platformSale.status !== 'finalised' || !completedOrder || completedOrder.status !== 'paid'
      || completedOrder.wristband || completedOrder.payment.creditUsed !== 0
      || platformSale.totals.grossSatang !== satang(totals.data.total)
      || satang(completedOrder.total) !== platformSale.totals.grossSatang) return fallback;
    completion = { saleId: platformSale.id, total: completedOrder.total,
      payment: { cash: completedOrder.payment.cash, card: completedOrder.payment.card, promptpay: completedOrder.payment.promptpay } };
  }
  const cart = DisplayMerchCartSchema.safeParse({ kind: 'merch', supported: true, lines,
    manualDiscounts: state.manualDiscounts.map(({ id, scope, targetLineId, targetLabel, type, value }) => ({ id, scope, targetLineId, targetLabel, type, value })),
    completion });
  if (!cart.success) return fallback;
  const payment = state.stage === 'payment' ? DisplayPaymentSchema.safeParse({ ...state.payment, online: state.online }) : null;
  if (payment && !payment.success) return fallback;
  return { ...fallback, cart: cart.data, totals: totals.data, payment: payment?.success ? payment.data : null };
}

export function useMerchDisplay(stationId: string | null, state: MerchDisplayState, active = true) {
  const presentation = merchDisplayPresentation(state);
  const publisher = useStationDisplay(stationId, { key: `${state.sessionKey}:${state.stage}`,
    supported: presentation.cart.supported, presentation: () => presentation }, active);
  const captured: { cart: DisplayMerchCart; totals: DisplayTotals } | undefined = presentation.cart.supported && presentation.totals
    ? { cart: presentation.cart, totals: presentation.totals } : undefined;
  return { ...publisher, presentation: captured };
}
