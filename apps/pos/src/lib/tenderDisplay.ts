import { useEffect, useMemo } from 'react';
import { DisplayPaymentSchema, DisplayTenderCartSchema, type DisplayPayment, type DisplayTenderCart, type DisplayTenderLine } from '@oto/shared';
import { paymentMethodKind } from './payments';
import { useStationDisplay, type StationDisplayHandoff, type StationDisplayState } from './displaySession';

/** Routes with no ticket cart return to the ordinary welcome screen. */
const welcome: StationDisplayState = { key: 'tender-host:welcome', supported: false,
  presentation: () => ({ stage: 'welcome', step: null, cart: null, member: null, totals: null, payment: null, prompt: null }) };

export function useTenderDisplay(stationId: string | null, active = true) {
  return useStationDisplay(stationId, welcome, active);
}

/**
 * Read-only presentation of the existing tender controller; it cannot start or confirm payment.
 *
 * SCRUM-859 — `lines` is what the tender is for, as the family reads it beside
 * the amount (the pass by the event's title, the extra hour by its option);
 * it rides on the cart only when it is well formed, and a caller with none
 * (the party balance) publishes the cart as before.
 */
export function useTenderPresentation(handover: StationDisplayHandoff | undefined,
  subject: DisplayTenderCart['subject'], method: string | null, payment: DisplayPayment, visible: boolean,
  lines?: readonly DisplayTenderLine[]) {
  const kind = method ? paymentMethodKind(method) : null;
  const encoded = JSON.stringify(payment);
  const encodedLines = lines && lines.length > 0 ? JSON.stringify(lines) : null;
  const state = useMemo<StationDisplayState | null>(() => {
    const parsed = DisplayPaymentSchema.safeParse(JSON.parse(encoded));
    if (!visible || !parsed.success || parsed.data.status === 'paid' || kind !== 'qr' && kind !== 'card') return null;
    const shown = encodedLines ? DisplayTenderCartSchema.shape.lines.safeParse(JSON.parse(encodedLines)) : null;
    const cart: DisplayTenderCart = { kind: 'tender', supported: true, subject, method: kind,
      ...(shown?.success && shown.data ? { lines: shown.data } : {}) };
    return { key: `tender:${subject}:${kind}:${parsed.data.saleId ?? ''}`, supported: true,
      presentation: () => ({ stage: 'payment', step: null, cart, payment: parsed.data, member: null, totals: null, prompt: null }) };
  }, [subject, kind, encoded, encodedLines, visible]);
  useEffect(() => state ? handover?.(state) : undefined, [handover, state]);
}
