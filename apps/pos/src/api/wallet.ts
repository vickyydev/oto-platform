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
// Round 2: the F&B and shop counters scan a band or voucher here
// (`scanWallet`), and the till's tab is built from the platform's wallet
// (`wristbandOfWallet`) — the balance, the ledger popover and the key the
// confirm press sends to spend it (`api/sales.ts`, `spendWalletOnSale`).
import {
  BOX_WALLET_REFUSALS,
  BRIDGE_WALLET_INTENTS,
  walletOfflineCapMessage,
  type BandStayView,
  type BridgeWalletBalance,
  type WalletCreditDay,
  type WalletEntryView,
  type WalletGrantView,
  type WalletPolicyViewDto,
  type WalletReportRow,
  type WalletReportSummary,
  type WalletView,
} from '@oto/shared';
import type { ChildFoodProvision, Wristband, WalletEntry } from '@/types';
import { bridgeApi } from './bridge';
import { ApiError, api, idemKey } from './client';

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

// --- Round 2: the counter's scan ------------------------------------------------

/**
 * The platform's ledger as the till's wallet popover reads it (`WalletEntry`,
 * prototype `types.ts:432`): signed baht, oldest first. A `reactivate` entry is
 * shown as a grant — the prototype's popover has four words, and putting credit
 * back reads the same to the guest.
 */
export function walletEntriesOf(ledger: readonly WalletEntryView[]): WalletEntry[] {
  return ledger.map((entry) => ({
    kind: entry.kind === 'reactivate' ? 'grant' : entry.kind,
    amountTHB: entry.amountSatang / 100,
    source: entry.source,
    at: entry.at,
    ...(entry.actorName ? { by: entry.actorName } : {}),
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
  }));
}

/**
 * THE TILL'S TAB FOR A PLATFORM WALLET. `code` is the key the counter scanned —
 * the one the confirm press sends back to spend it — and `qrCode` the wallet's
 * voucher QR. The balance is the platform's, never a figure this till kept;
 * an expired wallet reads ฿0 here so the station never offers credit the
 * platform will refuse.
 */
export function wristbandOfWallet(read: ApiWalletRead, scannedKey: string): Wristband {
  const qr = read.wallet.keys.find((k) => k.kind === 'voucher_qr')?.display;
  return {
    id: read.wallet.id,
    code: scannedKey.trim(),
    ...(qr ? { qrCode: qr } : {}),
    ...(read.wallet.memberId ? { memberId: read.wallet.memberId } : {}),
    customerNickname: read.wallet.holderName ?? 'Guest',
    ...(read.wallet.holderName ? { holderName: read.wallet.holderName } : {}),
    creditBalanceTHB: walletSpendableSatang(read.wallet) / 100,
    ledger: walletEntriesOf(read.ledger),
    // Only the gate reader consults this (types.ts), never a counter; a
    // wallet's tab opens nothing at the entrance.
    gateAccess: false,
  };
}

/** The key the confirm press sends for a tab: what the counter scanned. */
export function walletKeyOf(wristband: Pick<Wristband, 'code' | 'qrCode'>): string {
  return wristband.code || wristband.qrCode || '';
}

/**
 * Look a scanned key up on the platform. Null when no wallet carries it (the
 * station then falls back to its own band list); any other failure is thrown,
 * so a network fault is never read as "no credit".
 */
export async function scanWallet(key: string): Promise<Wristband | null> {
  const trimmed = key.trim();
  if (!trimmed) return null;
  try {
    return wristbandOfWallet(await lookupWallet(trimmed), trimmed);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

// --- SCRUM-494: the band's child at the F&B and shop counters ----------------------

/** `GET /wallets/scan`: the wallet a key names and the child's in-park stay behind the band. */
export interface ApiBandScan {
  wallet: WalletView | null;
  ledger: WalletEntryView[];
  stay: BandStayView | null;
}

export function scanBandOnPlatform(key: string, branchApiId: string | null): Promise<ApiBandScan> {
  const q = new URLSearchParams({ key: key.trim() });
  if (branchApiId) q.set('branchId', branchApiId);
  return api.get<ApiBandScan>(`/wallets/scan?${q}`);
}

/**
 * The stay's food, in the design's band fields (`types.ts:Wristband`): the
 * allergy / medical alert, the restriction, whether the parent authorised
 * food, and the prepaid food with each item's served count — baht at this
 * edge, as the design's `ChildFoodProvision` carries it.
 */
export function bandFoodOf(stay: BandStayView): Pick<
  Wristband,
  'holderName' | 'allergiesMedical' | 'foodRestrictions' | 'mayOrderFood' | 'foodProvision' | 'stayId'
> {
  const fp = stay.foodProvision;
  const foodProvision: ChildFoodProvision | undefined = fp
    ? {
        mode: fp.mode,
        paidTHB: fp.paidSatang / 100,
        ...(fp.creditSatang !== null ? { creditAmountTHB: fp.creditSatang / 100 } : {}),
        ...(fp.mode === 'prepaid_items'
          ? {
              items: fp.items.map((it) => ({
                menuItemId: it.menuItemId,
                menuItemName: it.menuItemName,
                unitPriceTHB: it.unitSatang / 100,
                qty: it.qty,
                redeemedQty: it.redeemedQty,
              })),
            }
          : {}),
      }
    : undefined;
  return {
    holderName: stay.childName,
    ...(stay.allergiesMedical ? { allergiesMedical: stay.allergiesMedical } : {}),
    ...(stay.foodRestrictions ? { foodRestrictions: stay.foodRestrictions } : {}),
    mayOrderFood: stay.mayOrderFood,
    ...(foodProvision ? { foodProvision } : {}),
    stayId: stay.checkinId,
  };
}

/**
 * THE TILL'S TAB FOR A COUNTER SCAN: the wallet's tab (`wristbandOfWallet`)
 * with the child's stay folded in, or — a band with no wallet — a tab with ฿0
 * credit carrying the stay alone, so the safety banners and the prepaid items
 * still reach the order.
 */
export function wristbandOfScan(read: ApiBandScan, scannedKey: string): Wristband | null {
  const food = read.stay ? bandFoodOf(read.stay) : null;
  if (read.wallet) {
    const tab = wristbandOfWallet({ wallet: read.wallet, ledger: read.ledger }, scannedKey);
    return food ? { ...tab, ...food } : tab;
  }
  if (!read.stay || !food) return null;
  return {
    id: read.stay.checkinId,
    code: scannedKey.trim(),
    customerNickname: read.stay.childName,
    creditBalanceTHB: 0,
    gateAccess: false,
    ...food,
  };
}

/**
 * The F&B and shop counters' scan: the platform's wallet and stay for a key.
 * Null when it names neither (the station then falls back to its own band
 * list); any other failure is thrown, so a fault is never read as "no tab".
 */
export async function scanBand(key: string, branchApiId: string | null): Promise<Wristband | null> {
  const trimmed = key.trim();
  if (!trimmed) return null;
  try {
    return wristbandOfScan(await scanBandOnPlatform(trimmed, branchApiId), trimmed);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

// --- Staging F3: the box lane's scan ----------------------------------------------

/**
 * The box's refusals of credit at a counter with no internet, in its words
 * (`BOX_WALLET_REFUSALS`, and the box's `WALLET_EXPIRED`). The tab still
 * opens — the order can be taken in cash or card — and the words are shown on
 * the credit card rather than replaced by the till's own.
 */
export const BOX_CREDIT_REFUSAL_CODES: readonly string[] = [
  BOX_WALLET_REFUSALS.cap.code,
  BOX_WALLET_REFUSALS.unknown.code,
  BOX_WALLET_REFUSALS.stale.code,
  BOX_WALLET_REFUSALS.noCounter.code,
  'WALLET_EXPIRED',
];

/** `wallet.lookup` on the station's box: what a scanned key can spend at this counter now. */
export async function lookupWalletOnBox(stationId: string, key: string): Promise<BridgeWalletBalance> {
  const answer = await bridgeApi.intent<{ wallet: BridgeWalletBalance }>(stationId, BRIDGE_WALLET_INTENTS.lookup, {
    key: key.trim(),
  });
  return answer.result!.wallet;
}

/**
 * THE TILL'S TAB FOR A WALLET THE BOX ANSWERED. The credit offered is what the
 * box will really take here now (`spendableSatang`: the snapshot less this
 * box's spends, under the day's offline cap), so the card never offers credit
 * the box then refuses. A wallet that still holds credit but has none left
 * under the cap today carries the box's cap sentence, so the card says why.
 * `base` is the station's own copy of the band, when it has one.
 */
export function wristbandOfBoxWallet(read: BridgeWalletBalance, scannedKey: string, base?: Wristband | null): Wristband {
  return {
    ...(base ?? {}),
    id: read.walletId,
    code: scannedKey.trim(),
    customerNickname: base?.customerNickname ?? 'Guest',
    creditBalanceTHB: read.spendableSatang / 100,
    gateAccess: false,
    ...(read.spendableSatang === 0 && read.balanceSatang > 0 ? { creditNote: walletOfflineCapMessage(read.capSatang) } : {}),
  };
}

// --- Round 3: expiry, reactivation, the figures ---------------------------------

/**
 * What a wallet can spend right now, in satang: nothing unless it is active
 * and its credit's expiry (round 3) has not passed; and never the part the
 * platform says has lapsed by the clock (`lapsedSatang` — older credit on a
 * reloaded wallet, dead on its own date) before the day-end job takes it. The
 * platform refuses past either, so the counter offers no more than this.
 */
export function walletSpendableSatang(view: Pick<WalletView, 'status' | 'expiresAt' | 'balanceSatang' | 'lapsedSatang'>, now: number = Date.now()): number {
  if (view.status !== 'active') return 0;
  if (view.expiresAt && Date.parse(view.expiresAt) <= now) return 0;
  return Math.max(0, view.balanceSatang - (view.lapsedSatang ?? 0));
}

/** Whether a wallet has any credit a counter may spend right now. */
export function walletSpendable(view: Pick<WalletView, 'status' | 'expiresAt' | 'balanceSatang' | 'lapsedSatang'>, now: number = Date.now()): boolean {
  if (view.status !== 'active') return false;
  if (view.expiresAt && Date.parse(view.expiresAt) <= now) return false;
  // A wallet with nothing on it is still "spendable" in kind — the platform
  // answers WALLET_EMPTY, the counter shows ฿0 — unless what it holds has lapsed.
  return view.balanceSatang === 0 || walletSpendableSatang(view, now) > 0;
}

/** The read after a reactivation: the wallet live again and its ledger with the new entry. */
export interface ApiWalletReactivated extends ApiWalletRead {
  replayed: boolean;
}

/**
 * Bring a wallet's expired credit back (`pos:wallet:reactivate`), with the
 * reason the manager typed. One key per gesture, so a retried press is the
 * same reactivation.
 */
export function reactivateWallet(walletId: string, reason: string, idempotencyKey: string = idemKey()): Promise<ApiWalletReactivated> {
  return api.post<ApiWalletReactivated>(`/wallets/${encodeURIComponent(walletId)}/reactivate`, { reason }, { idempotencyKey });
}

/** The branch's wallet rules (expiry, the offline cap, unused prepaid food). */
export function getWalletPolicy(branchApiId: string): Promise<WalletPolicyViewDto> {
  return api.get<WalletPolicyViewDto>(`/wallets/policy?branchId=${encodeURIComponent(branchApiId)}`);
}

export interface ApiWalletReport {
  summary: WalletReportSummary;
  rows: WalletReportRow[];
}

/** The Wallet & Promo report's credit half, for a business-date range; no branch = every park this account reads. */
export function getWalletReport(params: { branchApiId?: string | null; from: string; to: string; limit?: number }): Promise<ApiWalletReport> {
  const q = new URLSearchParams({ from: params.from, to: params.to, limit: String(params.limit ?? 100) });
  if (params.branchApiId) q.set('branchId', params.branchApiId);
  return api.get<ApiWalletReport>(`/wallets/report?${q}`);
}

/** The End of day `credit` line for one business date: counter credit redeemed, net of restores. */
export function getCreditDay(branchApiId: string, date: string): Promise<WalletCreditDay> {
  return api.get<WalletCreditDay>(`/wallets/credit-day?branchId=${encodeURIComponent(branchApiId)}&date=${encodeURIComponent(date)}`);
}
