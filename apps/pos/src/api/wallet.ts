// Stored value — S2-14a round 1 (plan docs/progress/plans/wallet/PLAN.md §2.2).
//
// WHAT THE TILL READS OF A WALLET. The platform grants a sale's credit as it
// closes it — one wallet per person the tickets' credit rules pay, each with
// ONE voucher QR — and answers with those grants on the finalise and on
// `GET /sales/:id`. The payment-done screen's "Credit Grants to Print" block
// shows that QR (the prototype seeded its on-screen QR from the grant id and
// printed `QR-<band id>`: two codes for one wallet, plan §6), and the round-3
// Wallet view looks a wallet up by any key through `GET /wallets/lookup`.
//
// Reads only. Credit is written by closing a sale and by checking a child in;
// spending it is round 2's tender.
import type { WalletEntryView, WalletGrantView, WalletView } from '@oto/shared';
import { api } from './client';

export type ApiWalletGrant = WalletGrantView;

export interface ApiWalletRead {
  wallet: WalletView;
  /** Oldest first: every grant, spend, refund and expiry, with the balance each left. */
  ledger: WalletEntryView[];
}

/** The wallet a scanned or typed key names: a voucher `QR-…`, a band's code or short code. */
export function lookupWallet(key: string): Promise<ApiWalletRead> {
  return api.get<ApiWalletRead>(`/wallets/lookup?key=${encodeURIComponent(key.trim())}`);
}

/** One wallet by id. */
export function getWallet(id: string): Promise<ApiWalletRead> {
  return api.get<ApiWalletRead>(`/wallets/${encodeURIComponent(id)}`);
}

/**
 * The grants a sale answer carries — the finalise's or `GET /sales/:id`'s — or
 * null when the answer has no such field (a deployment from before S2-14a).
 */
export function grantsOf(answer: unknown): ApiWalletGrant[] | null {
  if (!answer || typeof answer !== 'object') return null;
  const grants = (answer as { grants?: unknown }).grants;
  return Array.isArray(grants) ? (grants as ApiWalletGrant[]) : null;
}

/**
 * The QR the i-th F&B-credit grant on the till's sale shows: the platform
 * wallet's ONE voucher key, paired by person order — the till's
 * `buildCreditGrants` and the platform's grants both list earning persons
 * adults-then-kids per line. Null when the platform has not answered, so the
 * caller falls back to what it showed before.
 */
export function walletQrFor(grants: readonly ApiWalletGrant[] | null, creditIndex: number): string | null {
  if (!grants) return null;
  const ordered = [...grants].sort((a, b) => a.personIndex - b.personIndex);
  return ordered[creditIndex]?.qrCode || null;
}
