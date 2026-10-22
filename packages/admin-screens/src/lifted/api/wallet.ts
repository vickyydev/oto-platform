import type { WalletView,WalletEntryView,WalletPolicyViewDto,WalletReportSummary,WalletReportRow } from '@oto/shared';
import type { LiftedAdminApi } from '../../api/lifted-api';
import {idemKey} from './client';


export interface ApiWalletRead {
  wallet: WalletView;
  /** Oldest first: every grant, spend, refund and expiry, with the balance each left. */
  ledger: WalletEntryView[];
}


/** The read after a reactivation: the wallet live again and its ledger with the new entry. */
export interface ApiWalletReactivated extends ApiWalletRead {
  replayed: boolean;
}


export interface ApiWalletReport {
  summary: WalletReportSummary;
  rows: WalletReportRow[];
}
export function createWalletAdminApi(api: LiftedAdminApi) {


/** The wallet a scanned or typed key names: a voucher `QR-…`, a band's code or short code. */
function lookupWallet(key: string): Promise<ApiWalletRead> {
  return api.get<ApiWalletRead>(`/wallets/lookup?key=${encodeURIComponent(key.trim())}`);
}


/** One wallet by id. */
function getWallet(id: string): Promise<ApiWalletRead> {
  return api.get<ApiWalletRead>(`/wallets/${encodeURIComponent(id)}`);
}


/**
 * Bring a wallet's expired credit back (`pos:wallet:reactivate`), with the
 * reason the manager typed. One key per gesture, so a retried press is the
 * same reactivation.
 */
function reactivateWallet(walletId: string, reason: string, idempotencyKey: string = idemKey()): Promise<ApiWalletReactivated> {
  return api.post<ApiWalletReactivated>(`/wallets/${encodeURIComponent(walletId)}/reactivate`, { reason }, { idempotencyKey });
}


/** The branch's wallet rules (expiry, the offline cap, unused prepaid food). */
function getWalletPolicy(branchApiId: string): Promise<WalletPolicyViewDto> {
  return api.get<WalletPolicyViewDto>(`/wallets/policy?branchId=${encodeURIComponent(branchApiId)}`);
}


/** The Wallet & Promo report's credit half, for a business-date range; no branch = every park this account reads. */
function getWalletReport(params: { branchApiId?: string | null; from: string; to: string; limit?: number }): Promise<ApiWalletReport> {
  const q = new URLSearchParams({ from: params.from, to: params.to, limit: String(params.limit ?? 100) });
  if (params.branchApiId) q.set('branchId', params.branchApiId);
  return api.get<ApiWalletReport>(`/wallets/report?${q}`);
}
return { lookupWallet, getWallet, reactivateWallet, getWalletPolicy, getWalletReport };
}
