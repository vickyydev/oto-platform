import { EdcTerminal, EndOfDay, ReconLine } from '@/types';
import { paymentMethodLabel } from '@/lib/payments';

// A channel is "matched" when actual is within this band of expected. The branch's
// cash-up tolerates rounding/odd-satang noise; anything bigger is a real discrepancy.
export const RECON_TOLERANCE_THB = 1;

// Standard opening float a branch keeps in the drawer. Used as the start-of-day
// float only when there's no prior close to carry one over from (e.g. the very
// first day, or the default amount staff leave at close).
export const DEFAULT_FLOAT_THB = 6000;

export type ReconFlag = 'pending' | 'ok' | 'off';

/** Per-line state: not-yet-counted, matched (green), or off (red). */
export function lineFlag(line: ReconLine): ReconFlag {
  if (line.actualTHB === null) return 'pending';
  return Math.abs(line.differenceTHB) <= RECON_TOLERANCE_THB ? 'ok' : 'off';
}

/** Whole-day verdict: red if anything is off, amber while counts are outstanding,
 *  green only when every channel has been counted and matched. */
export function reconVerdict(eod: EndOfDay): ReconFlag {
  const flags = eod.lines.map(lineFlag);
  if (flags.some((f) => f === 'off')) return 'off';
  if (flags.some((f) => f === 'pending')) return 'pending';
  return 'ok';
}

/**
 * Recompute the derived numbers from the raw inputs so the working record always
 * stays internally consistent (used live on the screen AND when locking the day):
 *  - cash income = counted − float (null until both are entered)
 *  - the cash line's actual is driven by that income (not entered directly)
 *  - each line's difference = actual − expected (0 while un-entered)
 *  - the three totals.
 * Pure: returns a new EndOfDay, never mutates the input.
 */
export function recomputeEndOfDay(eod: EndOfDay): EndOfDay {
  const { countedTHB, floatTHB } = eod.cashCount;
  const cashIncomeTHB =
    countedTHB !== null && floatTHB !== null ? countedTHB - floatTHB : null;

  const lines = eod.lines.map((l) => {
    const actualTHB = l.channel === 'cash' ? cashIncomeTHB : l.actualTHB;
    return {
      ...l,
      actualTHB,
      differenceTHB: actualTHB === null ? 0 : actualTHB - l.expectedTHB,
    };
  });

  return {
    ...eod,
    cashCount: { ...eod.cashCount, cashIncomeTHB },
    lines,
    totalExpectedTHB: lines.reduce((a, l) => a + l.expectedTHB, 0),
    totalActualTHB: lines.reduce((a, l) => a + (l.actualTHB ?? 0), 0),
    totalDifferenceTHB: lines.reduce((a, l) => a + l.differenceTHB, 0),
  };
}

/** Human label for a reconciliation channel, resolving card TIDs to their terminal. */
export function channelLabel(channel: string, terminals: EdcTerminal[]): string {
  if (channel.startsWith('card:')) {
    const tid = channel.slice('card:'.length);
    const term = terminals.find((t) => t.tid === tid);
    return term ? `Card · ${term.label} (${term.tid})` : `Card · ${tid}`;
  }
  // Configurable 'other'-kind tenders reconcile under `method:<token>`.
  if (channel.startsWith('method:')) {
    return paymentMethodLabel(channel.slice('method:'.length));
  }
  switch (channel) {
    case 'cash':
      return 'Cash';
    case 'promptpay':
      return 'PromptPay / QR';
    case 'ewallet':
      return 'E-wallet';
    case 'bank_transfer':
      return 'Bank transfer';
    case 'party_prepay':
      return 'Party prepayments';
    case 'credit':
      return 'Credit';
    default:
      return channel;
  }
}
