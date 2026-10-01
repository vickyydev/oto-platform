// S2-14a round 3 — the Wallet view's rules (plan docs/progress/plans/wallet/PLAN.md §2.5).
//
// What the admin's Wallets panel shows for a wallet the platform found by a
// scanned or typed key, kept pure so it can be tested without a screen: the
// status in the counter's words, the ledger newest first with the prototype
// popover's columns (kind · source · by · time, the signed amount), and
// whether — and how much — expired credit can be brought back.
import type { WalletEntryView, WalletView } from '@oto/shared';

export type WalletViewStatus = 'active' | 'expired' | 'lapsed';

/**
 * `active`: spendable. `expired`: the day-end job closed it. `lapsed`: its
 * credit's expiry has passed — the newest load's date, or every baht on it
 * dead by its own date (`lapsedSatang`) — and the job has not run yet: a
 * counter is already refused, so the view says so rather than "active".
 */
export function walletViewStatus(view: Pick<WalletView, 'status' | 'expiresAt' | 'balanceSatang' | 'lapsedSatang'>, now: number = Date.now()): WalletViewStatus {
  if (view.status === 'expired') return 'expired';
  if (view.expiresAt && Date.parse(view.expiresAt) <= now) return 'lapsed';
  if (view.balanceSatang > 0 && (view.lapsedSatang ?? 0) >= view.balanceSatang) return 'lapsed';
  return 'active';
}

export const WALLET_STATUS_LABEL: Record<WalletViewStatus, string> = {
  active: 'Active',
  expired: 'Expired',
  lapsed: 'Expired (closing at day end)',
};

/**
 * The part of a live wallet's balance that has lapsed by the clock and goes
 * at the next day end — older credit on a wallet loaded again today. Zero when
 * nothing has, or when the whole wallet has (the status says that instead).
 */
export function lapsedPartSatang(view: Pick<WalletView, 'status' | 'expiresAt' | 'balanceSatang' | 'lapsedSatang'>, now: number = Date.now()): number {
  if (walletViewStatus(view, now) !== 'active') return 0;
  return Math.min(view.balanceSatang, Math.max(0, view.lapsedSatang ?? 0));
}

/** The words a ledger row uses, as the counter's wallet history writes them. */
export function walletEntryLabel(entry: Pick<WalletEntryView, 'kind' | 'source'>): { kind: string; source: string } {
  return { kind: entry.kind, source: entry.source.replace(/_/g, ' ') };
}

/** The ledger as the view lists it: newest first. */
export function ledgerNewestFirst(ledger: readonly WalletEntryView[]): WalletEntryView[] {
  return [...ledger].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}

/**
 * What a reactivation would bring back, in satang: the remainder the LAST
 * expiry took — but only while that expiry is the latest movement of credit on
 * a wallet the job has closed. Null when there is nothing to bring back (the
 * platform would refuse the same way).
 */
export function reactivatableSatang(view: Pick<WalletView, 'status'>, ledger: readonly WalletEntryView[]): number | null {
  if (view.status !== 'expired') return null;
  const latest = ledgerNewestFirst(ledger).find((e) => e.kind === 'expire' || e.kind === 'grant' || e.kind === 'reactivate');
  if (!latest || latest.kind !== 'expire') return null;
  return -latest.amountSatang;
}

/** A reactivation needs a typed reason: blank is refused before any call, as the platform refuses it. */
export function reactivationReasonError(reason: string): string | null {
  return reason.trim() ? null : 'Type why this credit is coming back.';
}

/** Baht with satang only when there are some — the till's money style. */
export function bahtOf(satang: number): string {
  return `฿${(satang / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
