import { useEffect, useMemo } from 'react';
import { DisplayPaymentSchema, type DisplayPayment, type DisplayTenderCart } from '@oto/shared';
import { paymentMethodKind } from './payments';
import { useStationDisplay, type StationDisplayHandoff, type StationDisplayState } from './displaySession';

/** Routes with no ticket cart return to the ordinary welcome screen. */
const welcome: StationDisplayState = { key: 'tender-host:welcome', supported: false,
  presentation: () => ({ stage: 'welcome', step: null, cart: null, member: null, totals: null, payment: null, prompt: null }) };

export function useTenderDisplay(stationId: string | null, active = true) {
  return useStationDisplay(stationId, welcome, active);
}

/** Read-only presentation of the existing tender controller; it cannot start or confirm payment. */
export function useTenderPresentation(handover: StationDisplayHandoff | undefined,
  subject: DisplayTenderCart['subject'], method: string | null, payment: DisplayPayment, visible: boolean) {
  const kind = method ? paymentMethodKind(method) : null;
  const encoded = JSON.stringify(payment);
  const state = useMemo<StationDisplayState | null>(() => {
    const parsed = DisplayPaymentSchema.safeParse(JSON.parse(encoded));
    if (!visible || !parsed.success || parsed.data.status === 'paid' || kind !== 'qr' && kind !== 'card') return null;
    const cart: DisplayTenderCart = { kind: 'tender', supported: true, subject, method: kind };
    return { key: `tender:${subject}:${kind}:${parsed.data.saleId ?? ''}`, supported: true,
      presentation: () => ({ stage: 'payment', step: null, cart, payment: parsed.data, member: null, totals: null, prompt: null }) };
  }, [subject, kind, encoded, visible]);
  useEffect(() => state ? handover?.(state) : undefined, [handover, state]);
}
