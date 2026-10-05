import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  branch,
  paymentAttempt,
  sale,
  station,
  wallet,
  walletEntry,
  walletKey,
  type Db,
} from '@oto/db';
import { walletKeyDigestsOf } from '@oto/box-agent';
import {
  OfflineWalletSpentSchema,
  WALLET_SNAPSHOT_LIMIT,
  WALLET_SPENT_FACT,
  WALLET_TENDER_CODE,
  businessDate as businessDateOf,
  formatTHB,
  newId,
  parseDayStart,
  type OfflineWalletSpent,
  type WalletSnapshotEntry,
  type WalletSnapshotItem,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import type { BoxAuth } from './box';
import { raiseAlert } from './ops';
import { findAttemptByAction, openAttempt, outstandingAfter, settleAttempt, tenderMethodOf } from './payments/attempt';
import { finaliseSale, type ActorContext } from './sale';
import type { Exec, Tx } from './tx';
// Read-only use of the landed wallet service: the policy, and the expiry rule
// the online counter spends under, so the box and the counter agree.
import { expiredCreditHeld, walletPolicyOf, type CreditLot } from './wallet';
import type { ApplyResult, BatchScope, EventHandler, PreparedEvent } from './sync';

/**
 * S2-14a ROUND 4 — OFFLINE SPEND UNDER THE CAP, the cloud's half (plan
 * `docs/progress/plans/wallet/PLAN.md` §2.6).
 *
 * Two things live here, one for each direction:
 *
 *   - THE `wallets` CACHE SCOPE (`walletCacheItem`): the branch's spendable
 *     wallets as balance SNAPSHOTS, with the policy's offline cap. The box's
 *     old "no wallet balances" rule (`cacheBundle` in `sync.ts`) is widened
 *     deliberately and no further: a balance, a status, an expiry and the KEY
 *     DIGESTS that find each wallet — never a voucher's QR or a band's code,
 *     which are a bearer and a gate credential (`walletKeyDigestsOf`, one
 *     function at both ends). Bounded (`WALLET_SNAPSHOT_LIMIT`), and carrying,
 *     per wallet, what THIS box's offline spends on today's trading day have
 *     already come to here, so the box subtracts only what the balance does
 *     not yet reflect.
 *   - THE `wallet.spent` HANDLER: each credit a box took with the link down,
 *     filed ONCE. The box queues it right behind the `sale.finalised` it pays
 *     for, so the sale is here, committed and part-paid (its cash, if any,
 *     already recorded), and this writes the rest:
 *
 *       1. the wallet tender — an attempt with method `wallet`, code
 *          `wallet_credit`, offline, keyed by the credit press (its action
 *          id): the replay key. The same fact again, under the same envelope
 *          or a new one, meets the attempt it wrote and writes nothing;
 *       2. THE PUT-BACK, when the platform's day end got here first: the box
 *          took the credit while it was live, and `job:wallet.expiry`
 *          (`expireWalletsForDay`) has since expired the whole balance
 *          because the spend was not filed yet — a link down overnight under
 *          the seeded same-day policy. Every `expire` entry on this wallet
 *          dated the spend's own day or later gives back what it took, up to
 *          what the box asked, as a `reactivate` entry keyed
 *          `offline:<press>:unexpire:<expire entry>` that expires at the
 *          cutoff it reverses (so it is never live credit), and the debit
 *          below takes it at once. The ledger then says what happened: ฿300
 *          spent and ฿200 expired, not ฿500 expired and a false overdraft;
 *       3. the `spend` entry, keyed `offline:<press>:spend`, carrying the
 *          offline flag, the station and the box — for what the wallet holds
 *          NOW, the put-back included. The ledger's CHECKs stand: a balance
 *          never goes below zero;
 *       4. AN OVERDRAFT — the box took more than the wallet held AT THE
 *          SPEND'S OWN INSTANT, because another box spent the same wallet in
 *          the same outage (Reception Till 1 and Counter 2), or a counter
 *          online did meanwhile. The money was promised at the counter, so
 *          the sale is paid and filed exactly as taken; the part the wallet
 *          could not cover is named — wallet, box, station, amount — on a
 *          `wallet_overdraft` anomaly and a CRITICAL alert, raised exactly
 *          once (the booking-double pattern, `refuseSecondRedemption`);
 *       5. the close: the sale is finalised under the number the box printed
 *          (OD-4), once its money covers it.
 *
 * Wallet writes go through this file's own writer rather than `wallet.ts`:
 * that file's `debitWallet` has no box, offline or attempt column to carry,
 * and it refuses an overdraft where this must file one. The rule it follows is
 * `applyEntry`'s — row lock, balance and entry in one statement pair, audited.
 */

const retry = (code: string, message: string): AppError =>
  new AppError(409, code, message, { quarantineReason: 'apply_failed' });
const conflict = (code: string, message: string, details: Record<string, unknown> = {}): AppError =>
  new AppError(409, code, message, { ...details, quarantineReason: 'conflict' });
const poison = (code: string, message: string): AppError =>
  new AppError(400, code, message, { quarantineReason: 'poison' });

/** The spend entry an offline credit press writes: one press, one entry, for ever. */
export function offlineSpendActionId(pressActionId: string): string {
  return `offline:${pressActionId}:spend`;
}

/** The alert's identity: one per credit press, so a re-raise is one row with more sightings. */
export function overdraftAlertKey(operatorId: string, pressActionId: string): string {
  return `wallet.offline_overdraft:${operatorId}:${pressActionId}`;
}

/** The put-back an offline press writes against one expiry that beat it to the ledger: one press, one expiry, one entry. */
export function offlineUnexpireActionId(pressActionId: string, expireEntryId: string): string {
  return `offline:${pressActionId}:unexpire:${expireEntryId}`;
}

// --- The `wallets` cache scope ---------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * THE BALANCES A COUNTER SPENDS FROM WITH THE LINK DOWN — one item, applied
 * whole: the branch's active wallets with credit on them, newest first and at
 * most `WALLET_SNAPSHOT_LIMIT`; operator-wide, with this box's own park first
 * so a bounded copy cannot displace its local wallets. Each carries credit it can actually spend
 * (its balance less what has already lapsed by the clock), the expiry its
 * latest credit recorded (a grant or a manager's reactivation, as the online
 * counter shows it), its key digests and this box's filed offline spends on
 * ANY day; and the policy's cap. A version of its own that leaves out when it
 * was built.
 *
 * Read in one repeatable-read transaction, so the balances and the filed sums
 * are one instant's: a spend filed between the two reads would be in the sum
 * and not in the balance, and the box would take it off nothing.
 */
export async function walletCacheItem(db: Db, auth: Pick<BoxAuth, 'boxId' | 'operatorId' | 'branchId'>, now: Date = new Date()): Promise<WalletSnapshotItem> {
  return db.transaction((tx) => walletCacheItemIn(tx, auth, now), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

async function walletCacheItemIn(db: Exec, auth: Pick<BoxAuth, 'boxId' | 'operatorId' | 'branchId'>, now: Date): Promise<WalletSnapshotItem> {
  const policy = await walletPolicyOf(db, auth.branchId);
  const [br] = await db
    .select({ timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(eq(branch.id, auth.branchId))
    .limit(1);
  const today = br ? businessDateOf(now, br.timezone, parseDayStart(br.dayStart)) : now.toISOString().slice(0, 10);
  const rows = await db
    .select({ id: wallet.id, status: wallet.status, balanceSatang: wallet.balanceSatang })
    .from(wallet)
    .where(
      and(
        eq(wallet.operatorId, auth.operatorId),
        eq(wallet.status, 'active'),
        sql`${wallet.balanceSatang} > 0`,
      ),
    )
    .orderBy(sql`case when ${wallet.branchId} = ${auth.branchId} then 0 else 1 end`, desc(wallet.updatedAt), desc(wallet.id))
    .limit(WALLET_SNAPSHOT_LIMIT + 1);
  const truncated = rows.length > WALLET_SNAPSHOT_LIMIT;
  const live = rows.slice(0, WALLET_SNAPSHOT_LIMIT);
  const ids = live.map((w) => w.id);

  // THE LEDGER, per wallet, in the same instant as the balances: every entry
  // for the lapsed rule, and the credit entries for the expiry.
  const lots = ids.length
    ? await db
        .select({
          id: walletEntry.id,
          walletId: walletEntry.walletId,
          kind: walletEntry.kind,
          amountSatang: walletEntry.amountSatang,
          expiresAt: walletEntry.expiresAt,
          createdAt: walletEntry.createdAt,
          unexpire: sql<boolean>`coalesce(${walletEntry.payload}->>'unexpire' = 'true', false)`,
        })
        .from(walletEntry)
        .where(inArray(walletEntry.walletId, ids))
        .orderBy(desc(walletEntry.createdAt), desc(walletEntry.id))
    : [];
  const lotsOf = new Map<string, CreditLot[]>();
  // Expiry: what the online counter shows (`creditExpiresAt`) — the `expires_at`
  // the wallet's LATEST credit recorded, a grant or a manager's reactivation,
  // null for `never`. A wallet a manager brought back is live on its
  // `reactivate` entry's fresh cutoff, not the dead grant's. An offline
  // put-back (`payload.unexpire`) is skipped: it expires at the cutoff it
  // reverses and is never live credit, so it says nothing about the wallet's
  // life. Rows are newest first, so the first credit seen per wallet is the latest.
  const expiryOf = new Map<string, string | null>();
  for (const e of lots) {
    lotsOf.set(e.walletId, [...(lotsOf.get(e.walletId) ?? []), { kind: e.kind, amountSatang: e.amountSatang, expiresAt: e.expiresAt }]);
    if ((e.kind === 'grant' || e.kind === 'reactivate') && !e.unexpire && !expiryOf.has(e.walletId)) {
      expiryOf.set(e.walletId, e.expiresAt?.toISOString() ?? null);
    }
  }
  const keys = ids.length
    ? await db
        .select({ walletId: walletKey.walletId, kind: walletKey.kind, value: walletKey.value })
        .from(walletKey)
        .where(inArray(walletKey.walletId, ids))
    : [];
  const keysOf = new Map<string, WalletSnapshotEntry['keys']>();
  for (const k of keys) {
    keysOf.set(k.walletId, [...(keysOf.get(k.walletId) ?? []), ...walletKeyDigestsOf(k)]);
  }
  // This box's filed offline credit on ANY day, per wallet: the attempts the
  // `wallet.spent` handler wrote, at the amount the box TOOK (an overdraft
  // included), so the box's own all-days counter and this agree. No date
  // filter: the attempt is filed under the sale's day, which a credit held at
  // 04:50 and closed at 05:10 does not share, and the box's count must not
  // read "reflected" what it has not sent.
  const filed = ids.length
    ? await db
        .select({
          walletId: sql<string>`${paymentAttempt.payload}->>'walletId'`,
          amount: sql<number>`coalesce(sum(${paymentAttempt.amountSatang}), 0)`,
        })
        .from(paymentAttempt)
        .where(
          and(
            eq(paymentAttempt.operatorId, auth.operatorId),
            eq(paymentAttempt.branchId, auth.branchId),
            eq(paymentAttempt.methodCode, WALLET_TENDER_CODE),
            eq(paymentAttempt.offline, true),
            sql`${paymentAttempt.payload}->>'boxId' = ${auth.boxId}`,
          ),
        )
        .groupBy(sql`${paymentAttempt.payload}->>'walletId'`)
    : [];
  const filedOf = new Map(filed.map((f) => [f.walletId, Number(f.amount)]));
  // ONLY CREDIT THAT CAN BE SPENT: the balance less what has already lapsed
  // by the clock and the day end has not taken yet — each credit by its own
  // date, the landed rule a counter online spends under (`lapsedCreditOf`).
  // Yesterday's ticket credit on a wallet reloaded today is not the box's to
  // give with the link down.
  const wallets: WalletSnapshotEntry[] = live.map((w) => ({
    id: w.id,
    status: w.status,
    balanceSatang: Math.max(0, w.balanceSatang - expiredCreditHeld(lotsOf.get(w.id) ?? [], now, w.balanceSatang)),
    expiresAt: expiryOf.get(w.id) ?? null,
    boxSpentSatang: filedOf.get(w.id) ?? 0,
    keys: (keysOf.get(w.id) ?? []).sort((a, b) => (a.k + a.d).localeCompare(b.k + b.d)),
  }));
  const body = { branchId: auth.branchId, businessDate: today, capSatang: policy.offlineCapSatang, truncated, wallets };
  return {
    version: sha256Hex(JSON.stringify(body)).slice(0, 16),
    generatedAt: now.toISOString(),
    ...body,
  };
}

// --- The `wallet.spent` handler -------------------------------------------------------

type WalletRow = typeof wallet.$inferSelect;

async function lockKey(tx: Tx, operatorId: string, key: string): Promise<void> {
  // The same lock space `wallet.ts` serialises its action keys in.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`wallet:${operatorId}:${key}`}, 0))`);
}

/**
 * THE ENTRY, for what the wallet holds now — `applyEntry`'s rule: the row is
 * locked by the caller, the balance moves and the entry is written with the
 * balance it left, audited. Never below zero.
 */
async function writeOfflineSpend(
  tx: Tx,
  locked: WalletRow,
  input: {
    actionId: string;
    amountSatang: number;
    source: OfflineWalletSpent['source'];
    branchId: string;
    saleId: string;
    paymentAttemptId: string;
    stationId: string;
    boxId: string;
    businessDate: string;
    actorAccountId: string;
    payload: Record<string, unknown>;
    now: Date;
    sourceEventId: string;
    pressActionId: string;
  },
): Promise<{ entryId: string; balanceAfter: number }> {
  const balanceAfter = locked.balanceSatang - input.amountSatang;
  if (balanceAfter < 0) throw new Error('an offline spend may only write what the wallet holds');
  await tx.update(wallet).set({ balanceSatang: balanceAfter, updatedAt: input.now }).where(eq(wallet.id, locked.id));
  const entryId = newId();
  await tx.insert(walletEntry).values({
    id: entryId,
    walletId: locked.id,
    operatorId: locked.operatorId,
    actionId: input.actionId,
    amountSatang: -input.amountSatang,
    kind: 'spend',
    source: input.source,
    saleId: input.saleId,
    paymentAttemptId: input.paymentAttemptId,
    branchId: input.branchId,
    stationId: input.stationId,
    boxId: input.boxId,
    offline: true,
    businessDate: input.businessDate,
    actorAccountId: input.actorAccountId,
    balanceAfter,
    payload: input.payload as never,
    createdAt: input.now,
  });
  await audit.record(tx, {
    actorAccountId: input.actorAccountId,
    operatorId: locked.operatorId,
    branchId: input.branchId,
    action: 'wallet.spend',
    entityType: 'wallet',
    entityId: locked.id,
    actionId: input.pressActionId,
    requestId: null,
    sourceEventId: input.sourceEventId,
    before: { balanceSatang: locked.balanceSatang, status: locked.status },
    after: {
      balanceSatang: balanceAfter,
      status: locked.status,
      entryId,
      kind: 'spend',
      source: input.source,
      amountSatang: -input.amountSatang,
      saleId: input.saleId,
      stationId: input.stationId,
      boxId: input.boxId,
      offline: true,
    },
  });
  return { entryId, balanceAfter };
}

/** What an `expire` entry still has to give back: what it took, less every put-back and reactivation already drawn on it. */
interface ExpiryToReverse {
  entryId: string;
  businessDate: string;
  /** The cutoff the expiry closed at, as it recorded it (its `payload.expiredAt`), else its own instant. */
  cutoff: Date;
  tookSatang: number;
  availableSatang: number;
}

/**
 * THE EXPIRIES THAT GOT HERE BEFORE THE SPEND: every `expire` entry on this
 * wallet dated the spend's day or later — the credit the box spent was still
 * live at the box's instant, and the day end took it only because the spend
 * had not been filed. Each is read with what has already been drawn back on
 * it (a manager's `reactivate:<expire>` under `reactivateWallet`, or another
 * press's put-back naming it), so two boxes syncing after one expiry cannot
 * both put the same ฿500 back. Oldest first.
 */
async function expiriesAfter(tx: Tx, locked: WalletRow, spendDay: string, clock: { timezone: string; dayStartMinutes: number }): Promise<ExpiryToReverse[]> {
  const entries = await tx
    .select({
      id: walletEntry.id,
      kind: walletEntry.kind,
      actionId: walletEntry.actionId,
      amountSatang: walletEntry.amountSatang,
      businessDate: walletEntry.businessDate,
      createdAt: walletEntry.createdAt,
      payload: walletEntry.payload,
    })
    .from(walletEntry)
    .where(and(eq(walletEntry.walletId, locked.id), inArray(walletEntry.kind, ['expire', 'reactivate'])))
    .orderBy(asc(walletEntry.createdAt), asc(walletEntry.id));
  const drawn = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== 'reactivate') continue;
    const payload = (e.payload ?? {}) as { unexpireOf?: unknown };
    const of =
      typeof payload.unexpireOf === 'string'
        ? payload.unexpireOf
        : e.actionId.startsWith('reactivate:')
          ? e.actionId.slice('reactivate:'.length)
          : null;
    if (of) drawn.set(of, (drawn.get(of) ?? 0) + e.amountSatang);
  }
  const out: ExpiryToReverse[] = [];
  for (const e of entries) {
    if (e.kind !== 'expire') continue;
    const day = e.businessDate ?? businessDateOf(e.createdAt, clock.timezone, clock.dayStartMinutes);
    if (day < spendDay) continue;
    const payload = (e.payload ?? {}) as { expiredAt?: unknown };
    const at = typeof payload.expiredAt === 'string' ? new Date(payload.expiredAt) : e.createdAt;
    const took = -e.amountSatang;
    out.push({
      entryId: e.id,
      businessDate: day,
      cutoff: Number.isNaN(at.getTime()) ? e.createdAt : at,
      tookSatang: took,
      availableSatang: Math.max(0, took - (drawn.get(e.id) ?? 0)),
    });
  }
  return out;
}

/**
 * THE PUT-BACK: a `reactivate` entry for what one expiry took of the credit
 * this press spent, expiring at the cutoff it reverses — never live credit,
 * only the debit's to take. Status is left as the day end left it: the debit
 * that follows takes every satang put back, so a wallet closed at ฿0 ends
 * closed at ฿0 and one still live stays live. Audited as its own action.
 */
async function writeUnexpire(
  tx: Tx,
  locked: WalletRow,
  expiry: ExpiryToReverse,
  input: {
    amountSatang: number;
    branchId: string;
    saleId: string;
    stationId: string;
    boxId: string;
    businessDate: string;
    actorAccountId: string;
    now: Date;
    sourceEventId: string;
    pressActionId: string;
    askedSatang: number;
  },
): Promise<{ entryId: string; balanceAfter: number }> {
  if (input.amountSatang <= 0 || input.amountSatang > expiry.availableSatang) {
    throw new Error('a put-back may only return what the expiry still holds of it');
  }
  const balanceAfter = locked.balanceSatang + input.amountSatang;
  await tx.update(wallet).set({ balanceSatang: balanceAfter, updatedAt: input.now }).where(eq(wallet.id, locked.id));
  const entryId = newId();
  const actionId = offlineUnexpireActionId(input.pressActionId, expiry.entryId);
  await tx.insert(walletEntry).values({
    id: entryId,
    walletId: locked.id,
    operatorId: locked.operatorId,
    actionId,
    amountSatang: input.amountSatang,
    kind: 'reactivate',
    source: 'reactivation',
    saleId: input.saleId,
    branchId: input.branchId,
    stationId: input.stationId,
    boxId: input.boxId,
    offline: true,
    businessDate: input.businessDate,
    actorAccountId: input.actorAccountId,
    expiresAt: expiry.cutoff,
    balanceAfter,
    payload: {
      unexpire: true,
      unexpireOf: expiry.entryId,
      expiryBusinessDate: expiry.businessDate,
      expiredAt: expiry.cutoff.toISOString(),
      expiryTookSatang: expiry.tookSatang,
      pressActionId: input.pressActionId,
      askedSatang: input.askedSatang,
      sourceEventId: input.sourceEventId,
    } as never,
    createdAt: input.now,
  });
  await audit.record(tx, {
    actorAccountId: input.actorAccountId,
    operatorId: locked.operatorId,
    branchId: input.branchId,
    action: 'wallet.offline_unexpire',
    entityType: 'wallet',
    entityId: locked.id,
    actionId: input.pressActionId,
    requestId: null,
    sourceEventId: input.sourceEventId,
    before: { balanceSatang: locked.balanceSatang, status: locked.status },
    after: {
      balanceSatang: balanceAfter,
      status: locked.status,
      entryId,
      kind: 'reactivate',
      source: 'reactivation',
      amountSatang: input.amountSatang,
      unexpireOf: expiry.entryId,
      expiryBusinessDate: expiry.businessDate,
      saleId: input.saleId,
      stationId: input.stationId,
      boxId: input.boxId,
      offline: true,
    },
  });
  return { entryId, balanceAfter };
}

function actorFor(scope: BatchScope, accountId: string): ActorContext {
  const branchId = scope.auth.branchId;
  return {
    accountId,
    operatorId: scope.auth.operatorId,
    branchId,
    async assertBranchAllowed(other) {
      if (other !== branchId) {
        throw poison('SYNC_BRANCH_NOT_OURS', 'That sale is for another branch than the box that sent it');
      }
    },
  };
}

/** Close the sale once its money covers it, under the number the box printed (OD-4). */
async function closeIfCovered(
  tx: Tx,
  scope: BatchScope,
  event: PreparedEvent,
  accountId: string,
  saleId: string,
  receipt: OfflineWalletSpent['receipt'],
  at: Date,
): Promise<ApplyResult['anomalies']> {
  const [row] = await tx.select().from(sale).where(eq(sale.id, saleId)).limit(1);
  if (!row || row.status === 'finalised') return [];
  if ((await outstandingAfter(tx, row)) > 0) return [];
  const result = await finaliseSale(
    tx,
    actorFor(scope, accountId),
    saleId,
    { actionId: event.envelope.actionId ?? null, printing: 'skip', adoptReceipt: receipt ?? null },
    at,
  );
  return result.receiptCollision
    ? [
        {
          kind: 'receipt_collision' as const,
          detail: {
            saleId,
            boxReceiptNumber: result.receiptCollision.box,
            receiptNumber: result.receiptCollision.ledger,
            finalised: result.finalised,
          },
        },
      ]
    : [];
}

async function applyWalletSpent(
  tx: Tx,
  scope: BatchScope,
  event: PreparedEvent,
  payload: OfflineWalletSpent,
): Promise<ApplyResult> {
  const operatorId = scope.auth.operatorId;
  const branchId = scope.auth.branchId;
  const boxId = scope.auth.boxId;
  const stationId = event.envelope.stationId ?? null;
  if (!stationId || !scope.stationIds.has(stationId)) {
    throw poison('SYNC_STATION_MISSING', 'A wallet spend has to name a station of the box that took it');
  }
  const accountId = event.envelope.actorAccountId ?? null;
  if (!accountId) {
    throw new AppError(409, 'SYNC_SALE_ANONYMOUS', 'A wallet spend has to name the account that took it', {
      quarantineReason: 'actor_unknown',
    });
  }
  if (!branchId) throw poison('SYNC_BOX_NO_BRANCH', 'This box is not at a branch, so it cannot spend a wallet');
  // The instant the push settled on (`prepareEvent`): the box's clock when it
  // is believed, the cloud's when it is not.
  const at = event.businessDateSource === 'received_at' ? event.receivedAt : event.occurredAt;
  const done = { entityType: 'wallet', entityId: payload.walletId };

  // ONE PRESS, ONE FILING. Two pushes of the same fact (a replay, a store
  // restored) serialise here; the attempt's own unique index is the net.
  await lockKey(tx, operatorId, offlineSpendActionId(payload.actionId));
  const already = await findAttemptByAction(tx, operatorId, payload.actionId);
  if (already) {
    if (already.saleId !== payload.saleId) {
      throw conflict('ACTION_ID_REUSED', 'That credit press already recorded a tender against another sale', {
        actionId: payload.actionId,
        saleId: already.saleId,
      });
    }
    // Filed before. The sale may still be open if the close was what failed.
    const anomalies = await closeIfCovered(tx, scope, event, accountId, payload.saleId, payload.receipt, at);
    return { ...done, ...(anomalies?.length ? { anomalies } : {}) };
  }

  const [row] = await tx.select().from(sale).where(eq(sale.id, payload.saleId)).for('update').limit(1);
  if (!row) {
    throw retry(
      'SYNC_SALE_ABSENT',
      'The sale this credit paid for is not here yet, so the credit waits for it',
    );
  }
  if (row.operatorId !== operatorId || row.branchId !== branchId) {
    throw poison('SYNC_SALE_NOT_OURS', 'That sale belongs to another park');
  }
  if (row.status === 'voided' || row.status === 'refunded') {
    throw conflict('SALE_CLOSED', `This sale is ${row.status} and cannot take a tender`, { saleId: row.id });
  }
  const [locked] = await tx.select().from(wallet).where(eq(wallet.id, payload.walletId)).for('update').limit(1);
  if (!locked || locked.operatorId !== operatorId) {
    throw poison('SYNC_WALLET_UNKNOWN', 'That wallet does not belong to this operator');
  }
  const owed = await outstandingAfter(tx, row);
  if (payload.amountSatang > owed) {
    throw conflict('SALE_OVERTENDERED', 'That credit is more than this sale still owes, so none of it was recorded', {
      saleId: row.id,
      amountSatang: payload.amountSatang,
      outstandingSatang: Math.max(0, owed),
    });
  }

  // THE SPEND'S OWN DAY: the day the box counted the credit on, when its
  // clock is believed; the day the sale was filed under when it is not (a
  // clock the platform does not trust earns no put-back from an earlier day).
  const spendDay = event.businessDateSource === 'received_at' ? row.businessDate : payload.businessDate;
  const [clockRow] = await tx
    .select({ timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(eq(branch.id, branchId))
    .limit(1);
  const clock = { timezone: clockRow?.timezone ?? 'UTC', dayStartMinutes: parseDayStart(clockRow?.dayStart ?? '00:00') };
  const toReverse = (await expiriesAfter(tx, locked, spendDay, clock)).filter((e) => e.availableSatang > 0);
  const reversible = toReverse.reduce((sum, e) => sum + e.availableSatang, 0);
  // What the wallet held at the box's instant, as far as the ledger can tell:
  // its balance now plus what a later day end took of the credit the box spent.
  const putBackSatang = Math.min(payload.amountSatang, reversible);

  // 1. THE WALLET TENDER, as the box took it — the whole amount the guest was
  //    promised. Credit never counts as till takings (`countsAsTillTakings`).
  const method = await tenderMethodOf(tx, operatorId, WALLET_TENDER_CODE, undefined, { platform: 'wallet' });
  const covered = Math.max(0, Math.min(payload.amountSatang, locked.balanceSatang + putBackSatang));
  const overdraftSatang = payload.amountSatang - covered;
  const attempt = await openAttempt(tx, {
    operatorId,
    branchId,
    stationId,
    businessDate: row.businessDate,
    saleId: row.id,
    method,
    methodCode: WALLET_TENDER_CODE,
    amountSatang: payload.amountSatang,
    actionId: payload.actionId,
    offline: true,
    payload: {
      platformWritten: true,
      offline: true,
      walletId: locked.id,
      boxId,
      source: payload.source,
      spendId: payload.spendId,
      takenByAccountId: accountId,
      actionId: payload.actionId,
      sourceEventId: event.envelope.eventId,
      ...(overdraftSatang > 0 ? { overdraftSatang } : {}),
    },
  });
  await tx.update(paymentAttempt).set({ boxSeq: event.envelope.boxSeq }).where(eq(paymentAttempt.id, attempt.id));
  await settleAttempt(tx, attempt.id, { paidAt: at });

  // 2. THE PUT-BACK, oldest expiry first, for what the box asked and no more.
  const unexpired: Array<{ entryId: string; expireEntryId: string; amountSatang: number }> = [];
  let current: WalletRow = locked;
  let toPutBack = putBackSatang;
  for (const expiry of toReverse) {
    if (toPutBack <= 0) break;
    const amount = Math.min(toPutBack, expiry.availableSatang);
    const back = await writeUnexpire(tx, current, expiry, {
      amountSatang: amount,
      branchId,
      saleId: row.id,
      stationId,
      boxId,
      businessDate: row.businessDate,
      actorAccountId: accountId,
      now: at,
      sourceEventId: event.envelope.eventId,
      pressActionId: payload.actionId,
      askedSatang: payload.amountSatang,
    });
    unexpired.push({ entryId: back.entryId, expireEntryId: expiry.entryId, amountSatang: amount });
    current = { ...current, balanceSatang: back.balanceAfter };
    toPutBack -= amount;
  }

  // 3. THE ENTRY, for what the wallet holds now, the put-back included.
  let balanceAfter = current.balanceSatang;
  let entryId: string | null = null;
  if (covered > 0) {
    const written = await writeOfflineSpend(tx, current, {
      actionId: offlineSpendActionId(payload.actionId),
      amountSatang: covered,
      source: payload.source,
      branchId,
      saleId: row.id,
      paymentAttemptId: attempt.id,
      stationId,
      boxId,
      businessDate: row.businessDate,
      actorAccountId: accountId,
      payload: {
        askedSatang: payload.amountSatang,
        ...(overdraftSatang > 0 ? { overdraftSatang } : {}),
        ...(putBackSatang > 0 ? { unexpiredSatang: putBackSatang, unexpired } : {}),
        spendId: payload.spendId,
        snapshotBalanceSatang: payload.snapshotBalanceSatang,
        capSatang: payload.capSatang,
        spentTodaySatang: payload.spentTodaySatang,
        ...(payload.spentOnBoxSatang != null ? { spentOnBoxSatang: payload.spentOnBoxSatang } : {}),
        boxBusinessDate: payload.businessDate,
        sourceEventId: event.envelope.eventId,
      },
      now: at,
      sourceEventId: event.envelope.eventId,
      pressActionId: payload.actionId,
    });
    balanceAfter = written.balanceAfter;
    entryId = written.entryId;
  }

  // 4. AN OVERDRAFT, filed and raised — exactly once: this branch runs only on
  //    the press's first filing (the attempt above is its replay key).
  const anomalies: NonNullable<ApplyResult['anomalies']> = [];
  let raise: (() => Promise<void>) | null = null;
  if (overdraftSatang > 0) {
    const [st] = await tx.select({ name: station.name }).from(station).where(eq(station.id, stationId)).limit(1);
    const boxName = `${scope.auth.name} (${scope.auth.slot})`;
    const stationName = st?.name ?? 'a counter';
    const detail = {
      walletId: locked.id,
      boxId,
      stationId,
      saleId: row.id,
      spentSatang: payload.amountSatang,
      coveredSatang: covered,
      overdraftSatang,
      balanceBeforeSatang: locked.balanceSatang,
      ...(putBackSatang > 0 ? { unexpiredSatang: putBackSatang } : {}),
      snapshotBalanceSatang: payload.snapshotBalanceSatang,
      capSatang: payload.capSatang,
      boxBusinessDate: payload.businessDate,
    };
    anomalies.push({ kind: 'wallet_overdraft', detail });
    await audit.record(tx, {
      actorAccountId: accountId,
      operatorId,
      branchId,
      action: 'wallet.offline_overdraft',
      entityType: 'wallet',
      entityId: locked.id,
      actionId: payload.actionId,
      requestId: null,
      sourceEventId: event.envelope.eventId,
      before: { balanceSatang: locked.balanceSatang },
      after: { ...detail, balanceSatang: balanceAfter, entryId },
    });
    // On the pool, as every alert a handler raises, once the filing below is
    // done; keyed by the press, so a re-raise is one alert with two sightings.
    raise = async () => {
      try {
        await raiseAlert(
          scope.db,
          {
            key: overdraftAlertKey(operatorId, payload.actionId),
            category: 'wallet.offline_overdraft',
            severity: 'critical',
            subject: `Wallet ${locked.id.slice(-8)} (${boxName})`,
            summary:
              `A wallet was spent offline past what it held: ${formatTHB(payload.amountSatang)} was taken at ${stationName} on ${boxName}, ` +
              `but when it reached the platform the wallet had only ${formatTHB(locked.balanceSatang + putBackSatang)} left — ` +
              `${formatTHB(overdraftSatang)} of credit was given that the wallet did not have. The sale is filed as it was taken; ` +
              'the wallet is at zero, and somebody should look at who spent it where.',
            detail,
            operatorId,
            branchId,
          },
          { flapWindowSeconds: 0 },
        );
      } catch (err) {
        scope.log?.error(
          { err, walletId: locked.id },
          'a wallet overdraft could not be alerted; its anomaly and audit row name it',
        );
      }
    };
  }

  // 5. THE CLOSE, and the row that names the event.
  anomalies.push(...((await closeIfCovered(tx, scope, event, accountId, row.id, payload.receipt, at)) ?? []));
  await audit.record(tx, {
    actorAccountId: accountId,
    operatorId,
    branchId,
    action: 'wallet.spend.offline',
    entityType: 'sale',
    entityId: row.id,
    actionId: payload.actionId,
    requestId: null,
    sourceEventId: event.envelope.eventId,
    before: { outstandingSatang: owed },
    after: {
      walletId: locked.id,
      attemptId: attempt.id,
      entryId,
      amountSatang: payload.amountSatang,
      coveredSatang: covered,
      overdraftSatang,
      unexpiredSatang: putBackSatang,
      boxId,
      stationId,
      receiptNumber: payload.receipt?.number ?? null,
      ...(payload.offlineFresh ? { offlineFresh: true } : {}),
    },
  });
  if (raise) await raise();
  return { ...done, ...(anomalies.length ? { anomalies } : {}) };
}

export const WALLET_HANDLERS: Record<string, EventHandler> = {
  /**
   * A CREDIT A BOX TOOK WITH THE LINK DOWN (S2-14a round 4). Filed once, keyed
   * by its press; over the live balance it is filed AND raised as an
   * overdraft. See the file's head for the four steps.
   */
  [WALLET_SPENT_FACT]: {
    schema: OfflineWalletSpentSchema,
    apply: (tx, scope, event, payload: OfflineWalletSpent) => applyWalletSpent(tx, scope, event, payload),
  },
};

/** The put-backs an offline press wrote against expiries that beat it here — read by tests and the closing audit. */
export async function offlineUnexpiresOf(db: Exec, operatorId: string, walletId: string) {
  return db
    .select()
    .from(walletEntry)
    .where(
      and(
        eq(walletEntry.operatorId, operatorId),
        eq(walletEntry.walletId, walletId),
        eq(walletEntry.kind, 'reactivate'),
        eq(walletEntry.offline, true),
        sql`${walletEntry.payload}->>'unexpire' = 'true'`,
      ),
    );
}

/** A box's filed offline credit on a wallet today — read by tests and the closing audit. */
export async function offlineSpendsOf(db: Exec, operatorId: string, walletId: string) {
  return db
    .select()
    .from(walletEntry)
    .where(and(eq(walletEntry.operatorId, operatorId), eq(walletEntry.walletId, walletId), eq(walletEntry.offline, true)));
}
