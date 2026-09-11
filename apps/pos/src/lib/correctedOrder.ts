import { CartLine, CustomerTier, FnbOrderLine, Wristband } from '@/types';

// Cross-route handoff for "Start corrected order" after a refund. When staff
// choose to redo a botched transaction, History stashes a prefill payload here
// and navigates to the till (/) or F&B station (/order-station), which consume
// it once on mount. Module-memory only — no storage, cleared after one read.

export interface TicketCorrection {
  kind: 'ticket';
  tier: CustomerTier;
  lines: CartLine[];
  memberId?: string;
  customerPhone?: string;
  customerNickname?: string;
}

export interface FnbCorrection {
  kind: 'fnb';
  lines: FnbOrderLine[];
  wristband?: Wristband;
}

export type Correction = TicketCorrection | FnbCorrection;

let pending: Correction | null = null;

export const setCorrectedOrder = (correction: Correction): void => {
  pending = correction;
};

// Returns the pending correction (if any) and clears it so it's consumed once.
export const takeCorrectedOrder = (): Correction | null => {
  const current = pending;
  pending = null;
  return current;
};
