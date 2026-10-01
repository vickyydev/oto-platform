import {
  DisplayFnbCartSchema, DisplayTotalsSchema, DisplayPaymentSchema,
  type DisplayFnbCart, type DisplayTotals, type StationSessionStage,
} from '@oto/shared';
import type { ApiSale, CartQuote } from '@/api/sales';
import type { FnbOrder, FnbOrderLine, ManualDiscount } from '@/types';
import type { PaymentDisplayState } from '@/lib/usePaymentStage';
import { useStationDisplay } from '@/lib/displaySession';

export interface FnbDisplayState {
  sessionKey: string;
  stage: 'welcome' | 'order' | 'payment' | 'thankyou';
  online: boolean;
  excluded: boolean;
  lines: readonly FnbOrderLine[];
  orderNote: string;
  manualDiscounts: readonly ManualDiscount[];
  quote: CartQuote;
  pending: boolean;
  quoteFailed: boolean;
  payment: PaymentDisplayState;
  completedOrder: FnbOrder | null;
  platformSale: ApiSale | null;
}

const satang = (value: number) => Math.round(value * 100);
const validMoney = (value: number) => Number.isFinite(value) && value >= 0
  && Number.isSafeInteger(satang(value)) && Math.abs(value * 100 - satang(value)) < 0.001;
const emptyCart = (): DisplayFnbCart => ({ kind: 'fnb', supported: false,
  lines: [], orderNote: '', manualDiscounts: [], completion: null });

/** Only server-captured guest rows cross the display boundary. */
export function fnbDisplayPresentation(state: FnbDisplayState) {
  const fallback = { stage: state.stage as StationSessionStage, step: null,
    cart: emptyCart(), member: null, prompt: null, totals: null, payment: null };
  if (!state.online || state.excluded) return fallback;
  if (state.stage === 'welcome') return { ...fallback, cart: { ...emptyCart(), supported: true } };
  if (state.quote.source !== 'platform' || state.pending || state.quoteFailed || !state.lines.length) return fallback;
  const lines: DisplayFnbCart['lines'] = [];
  for (const line of state.lines) {
    const captured = state.quote.itemPresentation?.[line.id];
    const lineTotal = state.quote.lineTotals?.[line.id];
    if (!captured || typeof captured.name !== 'string' || !Array.isArray(captured.modifiers)
      || lineTotal === undefined || !validMoney(captured.basePrice) || !validMoney(lineTotal)
      || captured.modifiers.some(modifier => !modifier || !validMoney(modifier.price))
      || (satang(captured.basePrice) + captured.modifiers.reduce((sum, modifier) => sum + satang(modifier.price), 0)) * line.qty !== satang(lineTotal)) return fallback;
    lines.push({ id: line.id, name: captured.name, qty: line.qty, basePrice: captured.basePrice, lineTotal,
      modifiers: captured.modifiers.map(({ groupName, optionName, price }) => ({ groupName, optionName, price })),
      ...(captured.name === line.menuItem.name && line.menuItem.translations ? {
        translations: Object.fromEntries(Object.entries(line.menuItem.translations)
          .filter((entry): entry is [string, { name: string }] => !!entry[1]).map(([language, value]) => [language, value.name])),
      } : {}), note: line.note, variantLabel: line.variantLabel });
  }
  const totals = DisplayTotalsSchema.safeParse(state.quote.totals);
  if (!totals.success) return fallback;
  let completion: DisplayFnbCart['completion'] = null;
  if (state.stage === 'thankyou') {
    const { platformSale, completedOrder } = state;
    if (!platformSale || platformSale.status !== 'finalised' || !completedOrder
      || completedOrder.status !== 'paid' || platformSale.totals.grossSatang !== satang(totals.data.total)
      || satang(completedOrder.total) !== platformSale.totals.grossSatang) return fallback;
    // S2-14a round 2 — the credit the platform took is a settled figure of its
    // own; the schema's sum check holds the four to the total.
    completion = { saleId: platformSale.id, pickupCode: completedOrder.pickupCode, total: completedOrder.total,
      payment: { cash: completedOrder.payment.cash, card: completedOrder.payment.card, promptpay: completedOrder.payment.promptpay,
        ...(completedOrder.payment.creditUsed > 0 ? { credit: completedOrder.payment.creditUsed } : {}) } };
  }
  const cart = DisplayFnbCartSchema.safeParse({ kind: 'fnb', supported: true, lines, orderNote: state.orderNote,
    manualDiscounts: state.manualDiscounts.map(({ id, scope, targetLineId, targetLabel, type, value }) => ({ id, scope, targetLineId, targetLabel, type, value })),
    completion });
  if (!cart.success) return fallback;
  const payment = state.stage === 'payment' ? DisplayPaymentSchema.safeParse({ ...state.payment, online: state.online }) : null;
  if (payment && !payment.success) return fallback;
  return { ...fallback, cart: cart.data, totals: totals.data, payment: payment?.success ? payment.data : null };
}

export function useFnbDisplay(stationId: string | null, state: FnbDisplayState, active = true) {
  const presentation = fnbDisplayPresentation(state);
  const publisher = useStationDisplay(stationId, { key: `${state.sessionKey}:${state.stage}`,
    supported: presentation.cart.supported, presentation: () => presentation }, active);
  const captured: { cart: DisplayFnbCart; totals: DisplayTotals } | undefined = presentation.cart.supported && presentation.totals
    ? { cart: presentation.cart, totals: presentation.totals } : undefined;
  return { ...publisher, presentation: captured };
}
