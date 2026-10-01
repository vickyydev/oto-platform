import { createHash } from 'node:crypto';
import {
  WALLET_KEY_DIGEST_KINDS,
  WALLET_KEY_DIGEST_PREFIX,
  bandShortCode,
  normaliseBandCode,
  parseBandShortCode,
  type WalletKeyDigestKind,
  type WalletSnapshotEntry,
  type WalletSnapshotItem,
} from '@oto/shared';

/**
 * CREDIT WITH THE LINK DOWN — the arithmetic and the key rule, with no I/O
 * (S2-14a round 4, plan `docs/progress/plans/wallet/PLAN.md` §2.6).
 *
 * Its own module, as `cache-apply.ts` and `booth-draw.ts` are, because the cap
 * is a money rule that deserves a cheap test (`offline-wallet-cap.test.ts`) and
 * because the api builds the `wallets` scope's digests with the SAME function
 * the box looks them up with (`walletKeyDigestsOf`): two implementations of a
 * hash would be two answers to "is this the band".
 */

/** The `box_counter` scope a wallet's offline spends on this box are counted in, per trading day — THE CAP's term. */
export const WALLET_SPEND_COUNTER_SCOPE = 'wallet_offline_spend';

/**
 * The `box_counter` scope a wallet's offline spends on this box are counted
 * in ACROSS ALL DAYS — THE SNAPSHOT's term (round 4 gate, REJECT 2). The cap
 * is a day's rule, but a snapshot is a balance, and the spends it does not
 * yet reflect are every one this box took since, whatever day they fell on:
 * a box that forgot yesterday's unsynced ฿300 at the day's turn would spend
 * ฿600 of a ฿400 snapshot. `box_counter` is keyed by a date, so this counter
 * lives under one fixed day (`WALLET_SPEND_TOTAL_DAY`) and is never pruned.
 */
export const WALLET_SPEND_TOTAL_SCOPE = 'wallet_offline_spend_total';
/** The one "day" the all-days counter is kept under: a date the store's column accepts, for ever. */
export const WALLET_SPEND_TOTAL_DAY = '1970-01-01';

/**
 * How long an unchanged `wallets` copy goes before the agent writes it again
 * anyway, to keep its `appliedAt` near what the platform last confirmed — far
 * inside `WALLET_SNAPSHOT_REFUSE_AFTER_S`, and far from a write every tick.
 */
export const WALLET_SNAPSHOT_REWRITE_AFTER_MS = 15 * 60 * 1000;

/** `sha256hex(prefix + kind + ':' + value)` — the one digest both ends compute. */
export function walletKeyDigest(kind: WalletKeyDigestKind, value: string): string {
  return createHash('sha256').update(`${WALLET_KEY_DIGEST_PREFIX}${kind}:${value}`, 'utf8').digest('hex');
}

/**
 * The digests a stored `pos.wallet_key` row is found by on a box. A band is
 * found by its full code and by its short code (`T1-7KMQ4X`), as History and
 * the online lookup find it; a phone key ships nothing — nothing scans one.
 */
export function walletKeyDigestsOf(key: { kind: string; value: string }): Array<{ k: WalletKeyDigestKind; d: string }> {
  const value = key.value.trim();
  if (!value) return [];
  switch (key.kind) {
    case 'voucher_qr':
      return [{ k: 'q', d: walletKeyDigest('q', value.toUpperCase()) }];
    case 'band': {
      const full = normaliseBandCode(value);
      const short = bandShortCode(full);
      return [
        { k: 'b', d: walletKeyDigest('b', full) },
        ...(short ? [{ k: 's' as const, d: walletKeyDigest('s', short) }] : []),
      ];
    }
    case 'child':
      return [{ k: 'c', d: walletKeyDigest('c', value.toLowerCase()) }];
    default:
      return [];
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a scanned or typed key could be, in the order the online lookup tries (`walletFor`). */
export function scannedKeyDigests(raw: string): Array<{ k: WalletKeyDigestKind; d: string }> {
  const key = raw.trim();
  if (!key) return [];
  const out: Array<{ k: WalletKeyDigestKind; d: string }> = [
    { k: 'q', d: walletKeyDigest('q', key.toUpperCase()) },
    { k: 'b', d: walletKeyDigest('b', normaliseBandCode(key)) },
  ];
  const short = parseBandShortCode(key);
  if (short) out.push({ k: 's', d: walletKeyDigest('s', `${short.prefix}-${short.tail}`) });
  if (UUID.test(key)) out.push({ k: 'c', d: walletKeyDigest('c', key.toLowerCase()) });
  return out;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

/** The `wallets` scope's one item as the box holds it, read defensively; null when it is not one. */
export function readWalletSnapshot(payload: unknown): WalletSnapshotItem | null {
  const items = rec(payload)?.items;
  const item = rec(Array.isArray(items) ? items[0] : null);
  if (!item) return null;
  const cap = int(item.capSatang);
  const businessDate = typeof item.businessDate === 'string' ? item.businessDate : null;
  if (cap === null || cap < 0 || !businessDate) return null;
  const wallets: WalletSnapshotEntry[] = [];
  for (const raw of Array.isArray(item.wallets) ? item.wallets : []) {
    const w = rec(raw);
    const id = typeof w?.id === 'string' ? w.id : null;
    const balance = int(w?.balanceSatang);
    if (!w || !id || balance === null || balance < 0) continue;
    const keys = (Array.isArray(w.keys) ? w.keys : []).flatMap((k) => {
      const key = rec(k);
      const kind = key?.k;
      const digest = key?.d;
      return typeof digest === 'string' && (WALLET_KEY_DIGEST_KINDS as readonly unknown[]).includes(kind)
        ? [{ k: kind as WalletKeyDigestKind, d: digest }]
        : [];
    });
    wallets.push({
      id,
      status: w.status === 'expired' ? 'expired' : 'active',
      balanceSatang: balance,
      expiresAt: typeof w.expiresAt === 'string' ? w.expiresAt : null,
      boxSpentSatang: Math.max(0, int(w.boxSpentSatang) ?? 0),
      keys,
    });
  }
  return {
    version: typeof item.version === 'string' ? item.version : '',
    generatedAt: typeof item.generatedAt === 'string' ? item.generatedAt : '',
    branchId: typeof item.branchId === 'string' ? item.branchId : '',
    businessDate,
    capSatang: cap,
    truncated: item.truncated === true,
    wallets,
  };
}

/** What a scanned key names in a snapshot: one wallet, more than one (a short code two bands share), or nothing. */
export type SnapshotMatch =
  | { found: WalletSnapshotEntry }
  | { ambiguous: true }
  | null;

/**
 * THE WALLET A SCANNED KEY NAMES, in the snapshot: a voucher QR first, then a
 * band's full code, then its short code, then a child's id — the online
 * lookup's order. A short code that names more than one wallet names none,
 * rather than a guess, as online.
 */
export function findSnapshotWallet(snapshot: WalletSnapshotItem, raw: string): SnapshotMatch {
  const byDigest = new Map<string, WalletSnapshotEntry[]>();
  for (const wallet of snapshot.wallets) {
    for (const key of wallet.keys) {
      const at = `${key.k}:${key.d}`;
      const list = byDigest.get(at) ?? [];
      if (!list.includes(wallet)) list.push(wallet);
      byDigest.set(at, list);
    }
  }
  for (const candidate of scannedKeyDigests(raw)) {
    const hits = byDigest.get(`${candidate.k}:${candidate.d}`) ?? [];
    if (hits.length === 1) return { found: hits[0]! };
    if (hits.length > 1) return { ambiguous: true };
  }
  return null;
}

export interface OfflineAllowanceInput {
  /** What the snapshot said the wallet held. */
  snapshotBalanceSatang: number;
  /**
   * This box's offline spends on this wallet that the snapshot ALREADY
   * reflects: the platform's `boxSpentSatang` — everything this box has
   * filed against the wallet, on any day.
   */
  reflectedSatang: number;
  /**
   * This wallet's spends on THIS box on EVERY day, as the box's own all-days
   * counter reads (held credit included): the snapshot's term. Never less
   * than today's.
   */
  spentOnBoxSatang: number;
  /** This wallet's spends on THIS box today, as the box's own day counter reads (held credit included): the cap's term. */
  spentTodaySatang: number;
  /** The cap per wallet per day: the station's own override, else the branch policy's. */
  capSatang: number;
}

export interface OfflineAllowance {
  /** What the wallet holds as far as this box can tell: the snapshot less what it does not yet reflect. */
  balanceLeftSatang: number;
  /** What the cap still allows on this box today. */
  capLeftSatang: number;
  /** min of the two — the most "use credit" may take. */
  allowedSatang: number;
}

/**
 * min(snapshot balance less the spends on this box the snapshot does not yet
 * reflect — on ANY day, cap less today's spends on this box). Pure, and never
 * negative.
 */
export function offlineWalletAllowance(input: OfflineAllowanceInput): OfflineAllowance {
  const today = Math.max(0, input.spentTodaySatang);
  // The all-days count can never be below today's: a store whose all-days
  // counter is missing (written before it existed) still owes today's.
  const onBox = Math.max(today, Math.max(0, input.spentOnBoxSatang));
  const unreflected = Math.max(0, onBox - Math.max(0, input.reflectedSatang));
  const balanceLeftSatang = Math.max(0, input.snapshotBalanceSatang - unreflected);
  const capLeftSatang = Math.max(0, input.capSatang - today);
  return { balanceLeftSatang, capLeftSatang, allowedSatang: Math.min(balanceLeftSatang, capLeftSatang) };
}

/** Why a box-lane credit press takes nothing. */
export type OfflineSpendRefusal = 'cap' | 'empty' | 'insufficient' | 'over_order';

/**
 * HOW MUCH THIS PRESS TAKES, or why it takes nothing.
 *
 *   - "use credit": min(what the wallet holds here, what the cap allows,
 *     what the order owes). A wallet with nothing left is the honest zero
 *     (`empty`); one with credit but no cap left today is `cap` — "online only
 *     above ฿300 per day";
 *   - an exact figure: refused, never floored — `over_order` above what the
 *     order owes, `cap` above what the cap allows, `insufficient` above what
 *     the wallet holds.
 */
export function decideOfflineSpend(
  allowance: OfflineAllowance,
  ask: { useCredit?: boolean; amountSatang?: number; outstandingSatang: number },
): { amountSatang: number } | { refusal: OfflineSpendRefusal } {
  const owed = Math.max(0, ask.outstandingSatang);
  if (ask.amountSatang !== undefined) {
    if (ask.amountSatang > owed) return { refusal: 'over_order' };
    if (ask.amountSatang > allowance.capLeftSatang) return { refusal: 'cap' };
    if (ask.amountSatang > allowance.balanceLeftSatang) return { refusal: 'insufficient' };
    return { amountSatang: ask.amountSatang };
  }
  if (allowance.balanceLeftSatang <= 0) return { refusal: 'empty' };
  if (allowance.capLeftSatang <= 0) return { refusal: 'cap' };
  const amount = Math.min(allowance.allowedSatang, owed);
  if (amount <= 0) return { refusal: 'over_order' };
  return { amountSatang: amount };
}
