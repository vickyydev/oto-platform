import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  account,
  band,
  branch,
  checkin,
  employee,
  factWalletLiabilityDaily,
  sale,
  saleLine,
  ticketPackage,
  wallet,
  walletEntry,
  walletKey,
  walletPolicy,
  type WalletGrantEntryPayload,
} from '@oto/db';
import {
  DEFAULT_WALLET_POLICY,
  addDaysToIsoDate,
  bandShortCode,
  businessDate as businessDateOf,
  businessDayEndsAt,
  earningPersonsOf,
  formatTHB,
  grantExpiresAt,
  grantLinesOfLedger,
  mintVoucherQr,
  newId,
  normaliseBandCode,
  normaliseWalletKeyValue,
  parseDayStart,
  type WalletEntryKind,
  type WalletEntrySource,
  type WalletEntryView,
  type WalletExpiryPolicy,
  type WalletGrantView,
  type WalletKeyKind,
  type WalletCreditDay,
  type WalletPolicyViewDto,
  type WalletPrepaidUnusedPolicy,
  type WalletReportRow,
  type WalletReportSummary,
  type WalletView,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { findBandsByCode } from './bands';
import type { Exec, Tx } from './tx';

/**
 * S2-14a — STORED VALUE (plan docs/progress/plans/wallet/PLAN.md §2.1-2.2).
 *
 * The one place a wallet is written. Round 1: a wallet is created with its
 * first credit (`createWalletWithGrant`), a child's wallet is loaded with
 * prepaid food (`loadWallet`), and a wallet is found by any of its keys
 * (`walletFor`, `balanceOf`, `ledgerOf`). The tender that spends it, the
 * refund that restores it and the job that expires it build on the same two
 * primitives in later rounds.
 *
 * THE LEDGER IS THE TRUTH. Every movement is a `wallet_entry`; the wallet's
 * `balance_satang` is a projection written only by `applyEntry`, in the same
 * transaction as its entry, after `SELECT … FOR UPDATE` on the wallet row —
 * so two writers to one wallet queue, and the balance is always the sum of
 * the entries (the tests assert it after every flow).
 *
 * EVERY WRITE IS KEYED BY ITS ACTION. `wallet_entry.action_id` is unique per
 * operator: a grant is `sale:<id>:grant:<n>` (the n-th earning person on the
 * sale), a child's prepaid load `checkin:<id>:prepaid`. A replay finds the
 * entry the first call wrote and answers with it; two racing first calls are
 * serialised on a transaction-scoped advisory lock on the key, and the unique
 * index is the net under anything that lock does not cover.
 */

type WalletRow = typeof wallet.$inferSelect;
type EntryRow = typeof walletEntry.$inferSelect;
type SaleRow = typeof sale.$inferSelect;
type BandRow = typeof band.$inferSelect;
type CheckinRow = typeof checkin.$inferSelect;

export interface WalletActor {
  /** Null for a write no person made (a job, a sync). */
  accountId: string | null;
  operatorId: string;
  requestId?: string | null;
}

// --- Policy ----------------------------------------------------------------------

export interface WalletPolicyView {
  expiry: WalletExpiryPolicy;
  expiryDays: number | null;
  offlineCapSatang: number;
  prepaidUnused: WalletPrepaidUnusedPolicy;
}

/** The branch's wallet rules; the seeded defaults where the branch has no row yet. */
export async function walletPolicyOf(db: Exec, branchId: string): Promise<WalletPolicyView> {
  const [row] = await db.select().from(walletPolicy).where(eq(walletPolicy.branchId, branchId)).limit(1);
  if (!row) return { ...DEFAULT_WALLET_POLICY };
  return {
    expiry: row.expiry,
    expiryDays: row.expiryDays,
    offlineCapSatang: row.offlineCapSatang,
    prepaidUnused: row.prepaidUnused,
  };
}

/** When credit granted now at this branch stops being spendable, by its policy. */
async function expiryFor(db: Exec, branchId: string, at: Date): Promise<{ businessDate: string; expiresAt: Date | null }> {
  const [br] = await db
    .select({ timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(eq(branch.id, branchId))
    .limit(1);
  if (!br) throw errors.notFound('Branch not found');
  const dayStart = parseDayStart(br.dayStart);
  const date = businessDateOf(at, br.timezone, dayStart);
  const policy = await walletPolicyOf(db, branchId);
  return { businessDate: date, expiresAt: grantExpiresAt(policy, date, br.timezone, dayStart) };
}

/**
 * THE WALLET LEDGER'S DATE IS THE CLOCK'S (round 3 re-check, R1/R2/R2b): an
 * entry is filed under the branch's trading day of the moment the money MOVES
 * — never under the day of the sale it settles. A tab rung up before the
 * boundary and paid with credit after it spends credit that exists NOW; dating
 * that spend by the sale made the catch-up expiry of the earlier day count it
 * against that day's credit (and under-expire), and sent that day's figures
 * below zero. The payment attempt keeps the sale's date (the cash-up groups
 * on it); the wallet entry keeps the sale backlink and takes the clock's day.
 */
async function tradingDayAt(db: Exec, branchId: string, at: Date): Promise<string> {
  const clock = await branchClockOf(db, branchId);
  return businessDateOf(at, clock.timezone, clock.dayStartMinutes);
}

// --- The two primitives ----------------------------------------------------------

/** Where and why an entry was written — every column an entry carries besides its money. */
export interface EntryContext {
  actionId: string;
  kind: WalletEntryKind;
  source: WalletEntrySource;
  /** Signed: positive adds to the balance, negative takes from it. */
  amountSatang: number;
  branchId: string | null;
  saleId?: string | null;
  refundId?: string | null;
  paymentAttemptId?: string | null;
  stationId?: string | null;
  boxId?: string | null;
  offline?: boolean;
  /**
   * The trading day the entry is filed under. Left out, it is the branch's day
   * of `now` (`tradingDayAt`) — the day the money moved. A caller that passes
   * one passes the day of the same moment (a grant's policy date, a test's
   * clock); the ledger never takes a date earlier than its own instant.
   */
  businessDate?: string | null;
  expiresAt?: Date | null;
  payload?: unknown;
  now?: Date;
  /** Round 3: a person's typed reason (a reactivation), carried into the audit row. */
  reason?: string | null;
}

/**
 * Serialise every writer of one action key, for the rest of this transaction.
 * `hashtextextended` spreads the key over the 64-bit lock space; a collision
 * only makes two unrelated writes wait for each other, never wrong.
 */
async function lockAction(tx: Tx, operatorId: string, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`wallet:${operatorId}:${key}`}, 0))`);
}

async function entryOfAction(db: Exec, operatorId: string, actionId: string): Promise<EntryRow | null> {
  const [row] = await db
    .select()
    .from(walletEntry)
    .where(and(eq(walletEntry.operatorId, operatorId), eq(walletEntry.actionId, actionId)))
    .limit(1);
  return row ?? null;
}

/**
 * THE ONLY WRITER OF A BALANCE: lock the wallet row, move its balance by the
 * entry's amount, and write the entry with the balance it left — or refuse,
 * having written nothing, when it would go below zero.
 */
async function applyEntry(tx: Tx, actor: WalletActor, walletId: string, ctx: EntryContext): Promise<{ wallet: WalletRow; entry: EntryRow }> {
  const [locked] = await tx.select().from(wallet).where(eq(wallet.id, walletId)).for('update').limit(1);
  if (!locked || locked.operatorId !== actor.operatorId) throw errors.notFound('Wallet not found');
  const balanceAfter = locked.balanceSatang + ctx.amountSatang;
  if (balanceAfter < 0) {
    throw errors.conflict(
      'WALLET_INSUFFICIENT',
      `This wallet has ${formatTHB(locked.balanceSatang)} left, not ${formatTHB(-ctx.amountSatang)}.`,
      { balanceSatang: locked.balanceSatang, amountSatang: ctx.amountSatang },
    );
  }
  const now = ctx.now ?? new Date();
  // The day the money moves, on the clock of the park the entry is written at
  // (the wallet's own park when the context names none).
  const dayBranchId = ctx.branchId ?? locked.branchId;
  const businessDate = ctx.businessDate ?? (dayBranchId ? await tradingDayAt(tx, dayBranchId, now) : null);
  const [updated] = await tx
    .update(wallet)
    .set({
      balanceSatang: balanceAfter,
      // Credit loaded onto a wallet makes it spendable again; only the expiry
      // job (round 3) moves one the other way — an expiry that leaves nothing
      // on the wallet closes it.
      ...(ctx.kind === 'grant' || ctx.kind === 'reactivate' ? { status: 'active' as const } : {}),
      ...(ctx.kind === 'expire' && balanceAfter === 0 ? { status: 'expired' as const } : {}),
      updatedAt: now,
    })
    .where(eq(wallet.id, walletId))
    .returning();
  const [entry] = await tx
    .insert(walletEntry)
    .values({
      id: newId(),
      walletId,
      operatorId: actor.operatorId,
      actionId: ctx.actionId,
      amountSatang: ctx.amountSatang,
      kind: ctx.kind,
      source: ctx.source,
      saleId: ctx.saleId ?? null,
      refundId: ctx.refundId ?? null,
      paymentAttemptId: ctx.paymentAttemptId ?? null,
      branchId: ctx.branchId,
      stationId: ctx.stationId ?? null,
      boxId: ctx.boxId ?? null,
      offline: ctx.offline ?? false,
      businessDate,
      actorAccountId: actor.accountId,
      expiresAt: ctx.expiresAt ?? null,
      balanceAfter,
      payload: ctx.payload ?? null,
      createdAt: now,
    })
    .returning();
  if (!updated || !entry) throw new Error('the wallet entry was not written');
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: ctx.branchId,
    action: `wallet.${ctx.kind}`,
    entityType: 'wallet',
    entityId: walletId,
    actionId: ctx.actionId,
    requestId: actor.requestId ?? null,
    before: { balanceSatang: locked.balanceSatang, status: locked.status },
    after: {
      balanceSatang: balanceAfter,
      status: updated.status,
      entryId: entry.id,
      kind: ctx.kind,
      source: ctx.source,
      amountSatang: ctx.amountSatang,
      saleId: ctx.saleId ?? null,
      refundId: ctx.refundId ?? null,
      stationId: ctx.stationId ?? null,
      ...(businessDate ? { businessDate } : {}),
      ...(ctx.reason ? { reason: ctx.reason } : {}),
    },
  });
  return { wallet: updated, entry };
}

/**
 * Attach keys to a wallet. A key another wallet already holds is refused — a
 * key names exactly one wallet — and one this wallet holds is left as it is.
 */
async function attachKeys(tx: Tx, operatorId: string, walletId: string, keys: readonly { kind: WalletKeyKind; value: string }[], now: Date): Promise<void> {
  for (const key of keys) {
    const value = normaliseWalletKeyValue(key.kind, key.value);
    const [held] = await tx
      .select({ walletId: walletKey.walletId })
      .from(walletKey)
      .where(and(eq(walletKey.operatorId, operatorId), eq(walletKey.kind, key.kind), eq(walletKey.value, value)))
      .limit(1);
    if (held) {
      if (held.walletId === walletId) continue;
      throw errors.conflict('WALLET_KEY_TAKEN', `That ${keyWord(key.kind)} already carries another wallet.`, { kind: key.kind });
    }
    await tx.insert(walletKey).values({ id: newId(), operatorId, walletId, kind: key.kind, value, createdAt: now, updatedAt: now });
  }
}

function keyWord(kind: WalletKeyKind): string {
  return kind === 'band' ? 'band' : kind === 'voucher_qr' ? 'voucher' : kind === 'child' ? 'child' : 'phone number';
}

export interface CreateWalletInput {
  actionId: string;
  branchId: string;
  memberId?: string | null;
  holderName?: string | null;
  amountSatang: number;
  source: Extract<WalletEntrySource, 'ticket_sale' | 'prepaid_food' | 'promo_voucher'>;
  keys: readonly { kind: WalletKeyKind; value: string }[];
  saleId?: string | null;
  stationId?: string | null;
  boxId?: string | null;
  businessDate?: string | null;
  expiresAt?: Date | null;
  payload?: unknown;
  now?: Date;
}

export interface WalletWrite {
  wallet: WalletRow;
  entry: EntryRow;
  /** True when this action had already been written and nothing new was. */
  replayed: boolean;
}

/**
 * A NEW WALLET WITH ITS FIRST CREDIT, in one transaction and keyed by its
 * action: the wallet, its keys, the grant entry and the balance. A replay of
 * the same action answers with the wallet it made; two concurrent calls with
 * the same action make ONE wallet (the second waits on the action's lock and
 * then finds the first's entry).
 */
export async function createWalletWithGrant(tx: Tx, actor: WalletActor, input: CreateWalletInput): Promise<WalletWrite> {
  if (!Number.isInteger(input.amountSatang) || input.amountSatang <= 0) {
    throw errors.badRequest('A wallet is created with some credit on it', { amountSatang: input.amountSatang });
  }
  await lockAction(tx, actor.operatorId, input.actionId);
  const done = await entryOfAction(tx, actor.operatorId, input.actionId);
  if (done) {
    const [row] = await tx.select().from(wallet).where(eq(wallet.id, done.walletId)).limit(1);
    return { wallet: row!, entry: done, replayed: true };
  }
  const now = input.now ?? new Date();
  const id = newId();
  await tx.insert(wallet).values({
    id,
    operatorId: actor.operatorId,
    branchId: input.branchId,
    memberId: input.memberId ?? null,
    holderName: input.holderName ?? null,
    balanceSatang: 0,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await attachKeys(tx, actor.operatorId, id, input.keys, now);
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: input.branchId,
    action: 'wallet.create',
    entityType: 'wallet',
    entityId: id,
    actionId: input.actionId,
    requestId: actor.requestId ?? null,
    // The key KINDS, never their values: a voucher QR is a bearer credential
    // and a band code a gate credential.
    after: { holderName: input.holderName ?? null, memberId: input.memberId ?? null, keyKinds: input.keys.map((k) => k.kind) },
  });
  const written = await applyEntry(tx, actor, id, {
    actionId: input.actionId,
    kind: 'grant',
    source: input.source,
    amountSatang: input.amountSatang,
    branchId: input.branchId,
    saleId: input.saleId ?? null,
    stationId: input.stationId ?? null,
    boxId: input.boxId ?? null,
    businessDate: input.businessDate ?? null,
    expiresAt: input.expiresAt ?? null,
    payload: input.payload ?? null,
    now,
  });
  return { ...written, replayed: false };
}

export interface LoadWalletInput {
  walletId: string;
  actionId: string;
  amountSatang: number;
  source: Extract<WalletEntrySource, 'ticket_sale' | 'prepaid_food'>;
  branchId: string;
  saleId?: string | null;
  stationId?: string | null;
  boxId?: string | null;
  businessDate?: string | null;
  expiresAt?: Date | null;
  payload?: unknown;
  now?: Date;
}

/** CREDIT ONTO A WALLET THAT EXISTS (a child's prepaid food), keyed by its action. */
export async function loadWallet(tx: Tx, actor: WalletActor, input: LoadWalletInput): Promise<WalletWrite> {
  if (!Number.isInteger(input.amountSatang) || input.amountSatang <= 0) {
    throw errors.badRequest('A load has to put some credit on the wallet', { amountSatang: input.amountSatang });
  }
  await lockAction(tx, actor.operatorId, input.actionId);
  const done = await entryOfAction(tx, actor.operatorId, input.actionId);
  if (done) {
    if (done.walletId !== input.walletId) {
      throw errors.conflict('ACTION_ID_REUSED', 'That action already loaded another wallet', { actionId: input.actionId });
    }
    const [row] = await tx.select().from(wallet).where(eq(wallet.id, done.walletId)).limit(1);
    return { wallet: row!, entry: done, replayed: true };
  }
  const written = await applyEntry(tx, actor, input.walletId, {
    actionId: input.actionId,
    kind: 'grant',
    source: input.source,
    amountSatang: input.amountSatang,
    branchId: input.branchId,
    saleId: input.saleId ?? null,
    stationId: input.stationId ?? null,
    boxId: input.boxId ?? null,
    businessDate: input.businessDate ?? null,
    expiresAt: input.expiresAt ?? null,
    payload: input.payload ?? null,
    now: input.now,
  });
  return { ...written, replayed: false };
}

/**
 * TAKE CREDIT OFF A WALLET for a reason that is not a sale at a counter —
 * round 1's one case: a child's unused prepaid food refunded in cash at
 * pickup, so the band cannot also spend it. Keyed by its action like every
 * write; refused, having written nothing, when the wallet has less than that.
 */
export async function debitWallet(
  tx: Tx,
  actor: WalletActor,
  input: { walletId: string; actionId: string; amountSatang: number; source: WalletEntrySource; branchId: string; refundId?: string | null; saleId?: string | null; stationId?: string | null; businessDate?: string | null; payload?: unknown; now?: Date },
): Promise<WalletWrite> {
  if (!Number.isInteger(input.amountSatang) || input.amountSatang <= 0) {
    throw errors.badRequest('A debit has to take something off the wallet', { amountSatang: input.amountSatang });
  }
  await lockAction(tx, actor.operatorId, input.actionId);
  const done = await entryOfAction(tx, actor.operatorId, input.actionId);
  if (done) {
    // Round 2 carryover: a replay names the wallet it debited, as a load's does.
    if (done.walletId !== input.walletId) {
      throw errors.conflict('ACTION_ID_REUSED', 'That action already debited another wallet', { actionId: input.actionId });
    }
    const [row] = await tx.select().from(wallet).where(eq(wallet.id, done.walletId)).limit(1);
    return { wallet: row!, entry: done, replayed: true };
  }
  const written = await applyEntry(tx, actor, input.walletId, {
    actionId: input.actionId,
    kind: 'spend',
    source: input.source,
    amountSatang: -input.amountSatang,
    branchId: input.branchId,
    refundId: input.refundId ?? null,
    saleId: input.saleId ?? null,
    stationId: input.stationId ?? null,
    businessDate: input.businessDate ?? null,
    payload: input.payload ?? null,
    now: input.now,
  });
  return { ...written, replayed: false };
}

// --- Spending at a counter, and putting it back (round 2) -------------------------

/** The spend a payment attempt made: one attempt, one entry, for ever. */
export function spendActionId(attemptId: string): string {
  return `attempt:${attemptId}:spend`;
}

/** What one refund put back through one wallet tender. */
export function restoreActionId(refundId: string, attemptId: string): string {
  return `refund:${refundId}:attempt:${attemptId}`;
}

const walletNotFound = () =>
  new AppError(404, 'WALLET_NOT_FOUND', 'No wallet carries that band or voucher — check the code and scan again.');

export interface SaleSpendInput {
  /** The scanned or typed key: a band's code or short code, a voucher's `QR-…`. */
  key: string;
  /** "Use credit": take min(balance, outstanding). */
  useCredit?: boolean;
  /** An exact figure instead — refused, never floored, above the balance. */
  amountSatang?: number;
  /** What the sale still owes, read under the sale's own lock. */
  outstandingSatang: number;
  /** Where it was spent — ONE pool for both counters; only the ledger's word differs. */
  source: Extract<WalletEntrySource, 'fnb_order' | 'merch_order'>;
  branchId: string;
  saleId: string;
  stationId?: string | null;
  boxId?: string | null;
  /**
   * The SALE's trading day, as the caller carries it for the attempt. It is
   * NOT the spend entry's date: the ledger files the spend under the branch's
   * day of `now`, the moment the credit moves (`tradingDayAt`) — a tab opened
   * before the boundary and paid after it spends today's credit, today.
   */
  businessDate?: string | null;
  now?: Date;
  /**
   * Write the payment attempt for the amount decided, UNDER the wallet's row
   * lock — the attempt's id is the spend's action key, so the two are one act.
   */
  openAttempt: (amountSatang: number, walletId: string) => Promise<{ id: string }>;
}

export interface SaleSpendResult {
  walletId: string;
  attemptId: string;
  amountSatang: number;
  balanceBeforeSatang: number;
  balanceAfterSatang: number;
  entryId: string;
}

/**
 * SPEND A WALLET ON A SALE (plan §2.3) — the platform's half of the till's
 * "use credit". Inside the caller's transaction, which already holds the sale:
 *
 *   1. the key names the wallet (404 when it names nothing at this park);
 *   2. `SELECT … FOR UPDATE` on the wallet row — a second till spending the
 *      same wallet waits HERE until the first commits, then reads what is left;
 *   3. the amount: min(balance, outstanding) for "use credit", or the exact
 *      figure asked — REFUSED when the wallet holds less (`WALLET_INSUFFICIENT`),
 *      never floored. A wallet with nothing left is the honest zero
 *      (`WALLET_EMPTY`): refused, nothing written, the till takes cash;
 *   4. the payment attempt (the caller's, via `openAttempt`), then the `spend`
 *      entry keyed `attempt:<id>:spend` with the balance it left.
 *
 * The prototype's `chargeFnbCredit` / `chargeMerchCredit` (`mockApi.ts:397-405`,
 * `:2663-2671`) clamped silently at zero; the requirement corrects that.
 */
export async function debitForSale(tx: Tx, actor: WalletActor, input: SaleSpendInput): Promise<SaleSpendResult> {
  const found = await walletFor(tx, actor.operatorId, input.key);
  // Wallet identity belongs to the operator, not the issuing park. The sale
  // and spend entry below name the park that actually took this credit.
  if (!found) throw walletNotFound();
  const [locked] = await tx.select().from(wallet).where(eq(wallet.id, found.id)).for('update').limit(1);
  if (!locked || locked.operatorId !== actor.operatorId) throw walletNotFound();
  const now = input.now ?? new Date();
  // Round 3: expired by its status (the end-of-day job has run) OR by the
  // clock (credit whose expiry has passed and the job has not taken yet) —
  // the same refusal either way, so no counter spends credit in the gap
  // between the branch's day ending and the job's next tick. The clock reads
  // EACH credit's own expiry (`lapsedCreditOf`, the gate's G1): yesterday's
  // same-day credit is dead at noon today however much was loaded this
  // morning, and only this morning's load is spendable.
  const lapsed = locked.status === 'active' ? await lapsedCreditOf(tx, locked, now) : locked.balanceSatang;
  const balance = locked.balanceSatang - lapsed;
  if (locked.status !== 'active' || (lapsed > 0 && balance <= 0) || (locked.balanceSatang === 0 && (await allCreditExpired(tx, locked.id, now)))) {
    throw errors.conflict(
      'WALLET_EXPIRED',
      `This wallet's credit has expired${locked.balanceSatang > 0 ? ` (${formatTHB(locked.balanceSatang)})` : ''} — only a manager can bring it back. Take the order in cash or card.`,
      { walletId: locked.id, balanceSatang: locked.balanceSatang, lapsedSatang: lapsed },
    );
  }
  if (input.outstandingSatang <= 0) throw errors.badRequest('This order owes nothing, so there is no credit to take');
  let amount: number;
  if (input.amountSatang !== undefined) {
    if (!Number.isInteger(input.amountSatang) || input.amountSatang <= 0) {
      throw errors.badRequest('Credit used has to be some amount', { amountSatang: input.amountSatang });
    }
    if (input.amountSatang > input.outstandingSatang) {
      throw errors.badRequest(`That is more credit than this order owes — it owes ${formatTHB(input.outstandingSatang)}.`, {
        amountSatang: input.amountSatang,
        outstandingSatang: input.outstandingSatang,
      });
    }
    if (input.amountSatang > balance) {
      throw errors.conflict(
        'WALLET_INSUFFICIENT',
        `This wallet has ${formatTHB(balance)} left, not ${formatTHB(input.amountSatang)}.`,
        { walletId: locked.id, balanceSatang: balance, amountSatang: input.amountSatang },
      );
    }
    amount = input.amountSatang;
  } else {
    if (input.useCredit !== true) throw errors.badRequest('Say how much credit to use');
    amount = Math.min(balance, input.outstandingSatang);
    if (amount <= 0) {
      throw errors.conflict('WALLET_EMPTY', 'This wallet has ฿0 left — take the order in cash or card.', {
        walletId: locked.id,
        balanceSatang: 0,
      });
    }
  }
  const attempt = await input.openAttempt(amount, locked.id);
  const written = await applyEntry(tx, actor, locked.id, {
    actionId: spendActionId(attempt.id),
    kind: 'spend',
    source: input.source,
    amountSatang: -amount,
    branchId: input.branchId,
    saleId: input.saleId,
    paymentAttemptId: attempt.id,
    stationId: input.stationId ?? null,
    boxId: input.boxId ?? null,
    // The day the credit moves, not the sale's (`tradingDayAt`): the attempt
    // keeps `input.businessDate`; the wallet ledger belongs to the clock.
    businessDate: await tradingDayAt(tx, input.branchId, now),
    now,
  });
  return {
    walletId: locked.id,
    attemptId: attempt.id,
    amountSatang: amount,
    balanceBeforeSatang: locked.balanceSatang,
    balanceAfterSatang: written.entry.balanceAfter,
    entryId: written.entry.id,
  };
}

/** The spend one wallet tender made, with what refunds already put back through it. */
export async function walletTenderOf(
  db: Exec,
  operatorId: string,
  attemptId: string,
): Promise<{ walletId: string; usedSatang: number; restoredSatang: number } | null> {
  const rows = await db
    .select({ walletId: walletEntry.walletId, kind: walletEntry.kind, amount: walletEntry.amountSatang })
    .from(walletEntry)
    .where(and(eq(walletEntry.operatorId, operatorId), eq(walletEntry.paymentAttemptId, attemptId)));
  const spend = rows.find((r) => r.kind === 'spend');
  if (!spend) return null;
  const restored = rows
    .filter((r) => r.kind === 'refund' && r.walletId === spend.walletId)
    .reduce((sum, r) => sum + r.amount, 0);
  return { walletId: spend.walletId, usedSatang: -spend.amount, restoredSatang: restored };
}

export interface RestoreResult {
  walletId: string;
  /** What this refund put back on the wallet. */
  restoredSatang: number;
  /** What was asked of this wallet tender and could not go back to it (cash instead). */
  shortSatang: number;
  balanceAfterSatang: number;
  replayed: boolean;
}

/**
 * A REFUND'S WALLET SLICE, SETTLED (plan §2.4): credit back onto the SAME
 * wallet the attempt spent, as a `refund` / `refund` entry keyed by the refund
 * and the attempt — capped at what that tender used less what earlier refunds
 * already put back (the prototype's restorable rule,
 * `TransactionDetail.tsx:134-138`). Anything above the cap is `shortSatang`,
 * and the caller hands it back in cash. Null when the attempt spent no wallet
 * — the slice is then cash. The refund row must already exist (the entry
 * names it).
 */
export async function restoreForRefund(
  tx: Tx,
  actor: WalletActor,
  input: { refundId: string; saleId: string; attemptId: string; amountSatang: number; branchId: string; stationId?: string | null; now?: Date },
): Promise<RestoreResult | null> {
  const actionId = restoreActionId(input.refundId, input.attemptId);
  await lockAction(tx, actor.operatorId, actionId);
  const done = await entryOfAction(tx, actor.operatorId, actionId);
  if (done) {
    return {
      walletId: done.walletId,
      restoredSatang: done.amountSatang,
      shortSatang: Math.max(0, input.amountSatang - done.amountSatang),
      balanceAfterSatang: done.balanceAfter,
      replayed: true,
    };
  }
  const tender = await walletTenderOf(tx, actor.operatorId, input.attemptId);
  if (!tender) return null;
  // Under the wallet's lock, so the cap is read with the balance it moves.
  const [locked] = await tx.select().from(wallet).where(eq(wallet.id, tender.walletId)).for('update').limit(1);
  if (!locked) return null;
  const cap = Math.max(0, tender.usedSatang - tender.restoredSatang);
  const amount = Math.min(input.amountSatang, cap);
  if (amount <= 0) {
    return { walletId: tender.walletId, restoredSatang: 0, shortSatang: input.amountSatang, balanceAfterSatang: locked.balanceSatang, replayed: false };
  }
  const written = await applyEntry(tx, actor, tender.walletId, {
    actionId,
    kind: 'refund',
    source: 'refund',
    amountSatang: amount,
    branchId: input.branchId,
    saleId: input.saleId,
    refundId: input.refundId,
    paymentAttemptId: input.attemptId,
    stationId: input.stationId ?? null,
    now: input.now,
  });
  return {
    walletId: tender.walletId,
    restoredSatang: amount,
    shortSatang: input.amountSatang - amount,
    balanceAfterSatang: written.entry.balanceAfter,
    replayed: false,
  };
}

// --- Finding a wallet ------------------------------------------------------------

export async function walletByKey(db: Exec, operatorId: string, kind: WalletKeyKind, value: string): Promise<WalletRow | null> {
  const [row] = await db
    .select({ wallet })
    .from(walletKey)
    .innerJoin(wallet, eq(wallet.id, walletKey.walletId))
    .where(
      and(
        eq(walletKey.operatorId, operatorId),
        eq(walletKey.kind, kind),
        eq(walletKey.value, normaliseWalletKeyValue(kind, value)),
      ),
    )
    .limit(1);
  return row?.wallet ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE WALLET A SCANNED OR TYPED KEY NAMES, inside one operator: a voucher's
 * `QR-…`, a band's full signed code or its short code (`T1-7KMQ4X`, matched
 * the way History matches it), or a child's id. Null when nothing matches —
 * and null, too, when a short code matches more than one band, rather than a
 * guess.
 */
export async function walletFor(db: Exec, operatorId: string, raw: string): Promise<WalletRow | null> {
  const key = raw.trim();
  if (!key) return null;
  const byQr = await walletByKey(db, operatorId, 'voucher_qr', key);
  if (byQr) return byQr;
  const bands = await findBandsByCode(db, operatorId, key);
  if (bands.length > 0) {
    const found = await db
      .selectDistinct({ wallet })
      .from(walletKey)
      .innerJoin(wallet, eq(wallet.id, walletKey.walletId))
      .where(
        and(
          eq(walletKey.operatorId, operatorId),
          eq(walletKey.kind, 'band'),
          inArray(walletKey.value, bands.map((b) => normaliseBandCode(b.code))),
        ),
      )
      .limit(2);
    if (found.length === 1) return found[0]!.wallet;
    if (found.length > 1) return null;
  }
  if (UUID.test(key)) return walletByKey(db, operatorId, 'child', key.toLowerCase());
  return null;
}

/** The balance a key's wallet holds, or null when the key names no wallet. */
export async function balanceOf(db: Exec, operatorId: string, raw: string): Promise<number | null> {
  return (await walletFor(db, operatorId, raw))?.balanceSatang ?? null;
}

async function namesOf(db: Exec, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: account.id, name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(inArray(account.id, unique));
  return new Map(rows.map((r) => [r.id, r.nickname ?? r.name ?? '']).filter(([, n]) => !!n) as [string, string][]);
}

/** A wallet's ledger, oldest first, as a statement. */
export async function ledgerOf(db: Exec, operatorId: string, walletId: string): Promise<WalletEntryView[]> {
  const rows = await db
    .select()
    .from(walletEntry)
    .where(and(eq(walletEntry.operatorId, operatorId), eq(walletEntry.walletId, walletId)))
    .orderBy(asc(walletEntry.createdAt), asc(walletEntry.id));
  const names = await namesOf(db, rows.map((r) => r.actorAccountId).filter((id): id is string => !!id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    source: r.source,
    amountSatang: r.amountSatang,
    balanceAfterSatang: r.balanceAfter,
    saleId: r.saleId,
    refundId: r.refundId,
    branchId: r.branchId,
    stationId: r.stationId,
    offline: r.offline,
    businessDate: r.businessDate,
    actorName: r.actorAccountId ? (names.get(r.actorAccountId) ?? null) : null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    at: r.createdAt.toISOString(),
  }));
}

/** A wallet as the lookup shows it. A band appears by its short code, never its signed code. */
export async function walletViewOf(db: Exec, row: WalletRow): Promise<WalletView> {
  const keys = await db
    .select({ kind: walletKey.kind, value: walletKey.value })
    .from(walletKey)
    .where(eq(walletKey.walletId, row.id))
    .orderBy(asc(walletKey.createdAt));
  const expiresAt = await creditExpiresAt(db, row.id);
  const lapsedSatang = row.status === 'active' ? await lapsedCreditOf(db, row, new Date()) : 0;
  return {
    id: row.id,
    expiresAt: expiresAt?.toISOString() ?? null,
    lapsedSatang,
    branchId: row.branchId,
    memberId: row.memberId,
    holderName: row.holderName,
    status: row.status,
    balanceSatang: row.balanceSatang,
    keys: keys.map((k) => ({
      kind: k.kind,
      display:
        k.kind === 'band'
          ? (bandShortCode(k.value) ?? 'Band')
          : k.kind === 'phone'
            ? `•••${k.value.slice(-4)}`
            : k.value,
    })),
    createdAt: row.createdAt.toISOString(),
  };
}

// --- Grants at finalise ----------------------------------------------------------

export function grantActionId(saleId: string, personIndex: number): string {
  return `sale:${saleId}:grant:${personIndex}`;
}

/**
 * THE SALE'S CREDIT, granted as it closes — called by `finaliseSale` and by
 * `commitSale`'s ฿0 close inside their transaction, after the sale is numbered
 * and before its paper is routed, so a walk-in, a booking's redemption and an
 * offline replay all earn through this one door (plan §2.2).
 *
 * The law is the prototype's (`@oto/shared` `wallet.ts`, from
 * `lib/sale.ts:146-264`), read off the FROZEN ledger: each ticket line's list
 * units and counts, each package's `creditRule` and `gateAccess`. Promo,
 * drop-off and supervised children's lines earn nothing here. One wallet per
 * earning person, with ONE voucher QR — the same value the till shows, the
 * display shows and the voucher prints. Its band key follows when the band is
 * minted (`attachSaleBandKeys`).
 *
 * Idempotent: each person's grant is keyed `sale:<id>:grant:<n>`, so a
 * re-finalised sale (a retry, a replay) answers with the wallets it already
 * made and never grants twice.
 */
export async function grantSaleCredit(
  tx: Tx,
  actor: WalletActor,
  saleRow: SaleRow,
  now: Date = new Date(),
): Promise<WalletGrantView[]> {
  const lines = await tx
    .select({
      cartLineId: saleLine.cartLineId,
      kind: saleLine.kind,
      ticketPackageId: saleLine.ticketPackageId,
      quantity: saleLine.quantity,
      unitSatang: saleLine.unitSatang,
      lineNo: saleLine.lineNo,
    })
    .from(saleLine)
    .where(eq(saleLine.saleId, saleRow.id));
  const packageIds = [...new Set(lines.map((l) => l.ticketPackageId).filter((id): id is string => !!id))];
  if (packageIds.length === 0) return [];
  const packages = await tx
    .select({ id: ticketPackage.id, creditRule: ticketPackage.creditRule, gateAccess: ticketPackage.gateAccess })
    .from(ticketPackage)
    .where(inArray(ticketPackage.id, packageIds));
  // A drop-off or nanny child's cart line is minted under its check-in's id
  // (`bands.ts`, `supervisedCheckinsOf`): their food is their own wallet.
  const cartLineIds = [...new Set(lines.map((l) => l.cartLineId))];
  const supervised = await tx
    .select({ id: checkin.id })
    .from(checkin)
    .where(and(eq(checkin.operatorId, saleRow.operatorId), inArray(checkin.id, cartLineIds)));
  const persons = earningPersonsOf(
    grantLinesOfLedger(
      lines,
      new Map(packages.map((p) => [p.id, { creditRule: p.creditRule, gateAccess: p.gateAccess }])),
      new Set(supervised.map((s) => s.id)),
    ),
  );
  if (persons.length === 0) return [];
  const { expiresAt } = await expiryFor(tx, saleRow.branchId, saleRow.occurredAt);
  for (const [personIndex, person] of persons.entries()) {
    const payload: WalletGrantEntryPayload = {
      cartLineId: person.cartLineId,
      role: person.role,
      ordinal: person.ordinal,
      personIndex,
      gateAccess: person.gateAccess,
      listUnitSatang: person.listSatang,
    };
    await createWalletWithGrant(tx, actor, {
      actionId: grantActionId(saleRow.id, personIndex),
      branchId: saleRow.branchId,
      memberId: saleRow.memberId,
      // The prototype's names for these wallets (`ensureSaleGrantWallet`,
      // `issueBookingBands`): a walk-in is a "Walk-in guest" whoever earned it.
      holderName: saleRow.bookingId
        ? person.role === 'adult'
          ? 'Booking guest'
          : 'Booking child'
        : 'Walk-in guest',
      amountSatang: person.creditSatang,
      source: 'ticket_sale',
      keys: [{ kind: 'voucher_qr', value: mintVoucherQr() }],
      saleId: saleRow.id,
      stationId: saleRow.stationId,
      boxId: saleRow.boxId,
      businessDate: saleRow.businessDate,
      expiresAt,
      payload,
      now,
    });
  }
  return grantsOfSale(tx, saleRow.id);
}

/** The wallets a sale's grants made, in person order, as the till and the display show them. */
export async function grantsOfSale(db: Exec, saleId: string): Promise<WalletGrantView[]> {
  const rows = await db
    .select({ entry: walletEntry, wallet })
    .from(walletEntry)
    .innerJoin(wallet, eq(wallet.id, walletEntry.walletId))
    .where(and(eq(walletEntry.saleId, saleId), eq(walletEntry.kind, 'grant'), eq(walletEntry.source, 'ticket_sale')));
  if (rows.length === 0) return [];
  const keys = await db
    .select({ walletId: walletKey.walletId, kind: walletKey.kind, value: walletKey.value })
    .from(walletKey)
    .where(inArray(walletKey.walletId, rows.map((r) => r.wallet.id)))
    .orderBy(asc(walletKey.createdAt));
  return rows
    .map(({ entry, wallet: w }) => {
      const p = (entry.payload ?? {}) as Partial<WalletGrantEntryPayload>;
      const qr = keys.find((k) => k.walletId === w.id && k.kind === 'voucher_qr');
      const bandKey = keys.find((k) => k.walletId === w.id && k.kind === 'band');
      return {
        walletId: w.id,
        role: p.role ?? 'adult',
        personIndex: p.personIndex ?? 0,
        creditSatang: entry.amountSatang,
        qrCode: qr?.value ?? '',
        holderName: w.holderName,
        gateAccess: p.gateAccess ?? false,
        bandShortCode: bandKey ? bandShortCode(bandKey.value) : null,
        expiresAt: entry.expiresAt?.toISOString() ?? null,
      };
    })
    .sort((a, b) => a.personIndex - b.personIndex);
}

/**
 * PUT EACH GRANT WALLET ON ITS PERSON'S BAND, once the sale's bands exist.
 *
 * The prototype's credit wallet WAS that person's band (`ensureSaleGrantWallet`
 * / `issueBookingBands`). Here the band is minted when the paper is routed,
 * and the pairing is by place: the i-th adult (paid first) on a cart line
 * takes the i-th adult band minted on that line, and the same for kids —
 * which is the order `planLedgerBands` mints them in. Idempotent: a wallet
 * that already carries a band, and a band already on a wallet, are left.
 */
export async function attachSaleBandKeys(tx: Tx, saleRow: SaleRow, bands: readonly BandRow[], now: Date = new Date()): Promise<number> {
  if (bands.length === 0) return 0;
  const grants = await tx
    .select({ walletId: walletEntry.walletId, payload: walletEntry.payload })
    .from(walletEntry)
    .where(and(eq(walletEntry.saleId, saleRow.id), eq(walletEntry.kind, 'grant'), eq(walletEntry.source, 'ticket_sale')));
  if (grants.length === 0) return 0;
  const lineIds = [...new Set(bands.map((b) => b.saleLineId).filter((id): id is string => !!id))];
  const cartOf = new Map(
    lineIds.length
      ? (
          await tx.select({ id: saleLine.id, cartLineId: saleLine.cartLineId }).from(saleLine).where(inArray(saleLine.id, lineIds))
        ).map((l) => [l.id, l.cartLineId])
      : [],
  );
  const ordered = [...bands].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const slot = new Map<string, BandRow>();
  const seen = new Map<string, number>();
  for (const b of ordered) {
    const cartLineId = b.saleLineId ? cartOf.get(b.saleLineId) : undefined;
    if (!cartLineId) continue;
    const role = b.kind === 'kid' ? 'kid' : 'adult';
    const k = `${cartLineId}:${role}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    slot.set(`${k}:${n}`, b);
  }
  const held = await tx
    .select({ walletId: walletKey.walletId, value: walletKey.value })
    .from(walletKey)
    .where(and(eq(walletKey.operatorId, saleRow.operatorId), eq(walletKey.kind, 'band'), inArray(walletKey.walletId, grants.map((g) => g.walletId))));
  const walletsWithBand = new Set(held.map((h) => h.walletId));
  let attached = 0;
  for (const g of grants) {
    if (walletsWithBand.has(g.walletId)) continue;
    const p = (g.payload ?? {}) as Partial<WalletGrantEntryPayload>;
    if (!p.cartLineId || !p.role || p.ordinal === undefined) continue;
    const b = slot.get(`${p.cartLineId}:${p.role}:${p.ordinal}`);
    if (!b || b.status !== 'active') continue;
    const inserted = await tx
      .insert(walletKey)
      .values({ id: newId(), operatorId: saleRow.operatorId, walletId: g.walletId, kind: 'band', value: normaliseBandCode(b.code), createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning({ id: walletKey.id });
    attached += inserted.length;
  }
  return attached;
}

/** The sale's grant wallets, in person order — one credit voucher each. */
export async function creditVoucherWalletsOf(db: Exec, saleId: string): Promise<string[]> {
  return (await grantsOfSale(db, saleId)).map((g) => g.walletId);
}

/**
 * WHAT A CREDIT VOUCHER PRINTS for one wallet (prototype `CreditVoucherData`,
 * `printRouting.tsx:18-26`): the wallet's ONE QR, the credit the voucher was
 * issued for, and the holder's name. `balance` is the figure pre-formatted the
 * way every printout carries money; `balanceTHB` the prototype's number. The
 * template's toggles (balance, QR) are the renderer's to honour.
 */
export async function creditVoucherDocumentOf(
  db: Exec,
  walletId: string,
): Promise<{ balance: string; balanceTHB: number; qrCode?: string; holderName?: string } | null> {
  const [row] = await db.select().from(wallet).where(eq(wallet.id, walletId)).limit(1);
  if (!row) return null;
  const [grant] = await db
    .select({ amount: walletEntry.amountSatang })
    .from(walletEntry)
    .where(and(eq(walletEntry.walletId, walletId), eq(walletEntry.kind, 'grant')))
    .orderBy(asc(walletEntry.createdAt))
    .limit(1);
  const [qr] = await db
    .select({ value: walletKey.value })
    .from(walletKey)
    .where(and(eq(walletKey.walletId, walletId), eq(walletKey.kind, 'voucher_qr')))
    .limit(1);
  const amount = grant?.amount ?? row.balanceSatang;
  return {
    balance: formatTHB(amount),
    balanceTHB: amount / 100,
    ...(qr ? { qrCode: qr.value } : {}),
    ...(row.holderName ? { holderName: row.holderName } : {}),
  };
}

// --- A promotional voucher's credit (round 5) ---------------------------------------

/** The one load a wallet-credit voucher makes, for ever: its action key. */
export function voucherLoadActionId(voucherId: string): string {
  return `voucher:${voucherId}:load`;
}

export interface VoucherCreditInput {
  voucherId: string;
  amountSatang: number;
  /** The park redeeming it: the wallet's park, whose policy dates the credit. */
  branchId: string;
  saleId: string;
  stationId: string | null;
  boxId?: string | null;
  /** The sale's member, else the member the voucher was issued to (a backlink; OD-W5 adds no phone key). */
  memberId?: string | null;
  now?: Date;
}

/**
 * S2-14a round 5 — A WALLET-CREDIT VOUCHER, REDEEMED: a new wallet loaded with
 * the voucher's credit, through the landed door (`createWalletWithGrant`) — a
 * `grant` entry from `promo_voucher`, its expiry from the branch's
 * `wallet_policy` as every grant's, and ONE voucher QR for the wallet, which the
 * till shows and the credit voucher prints. Keyed `voucher:<id>:load`: a replay
 * answers with the wallet it made and never loads twice. Called by
 * `consumeSaleVouchers` inside the transaction that closes the sale.
 */
export async function loadWalletFromVoucher(tx: Tx, actor: WalletActor, input: VoucherCreditInput): Promise<WalletWrite> {
  const now = input.now ?? new Date();
  const { businessDate, expiresAt } = await expiryFor(tx, input.branchId, now);
  return createWalletWithGrant(tx, actor, {
    actionId: voucherLoadActionId(input.voucherId),
    branchId: input.branchId,
    memberId: input.memberId ?? null,
    holderName: 'Voucher credit',
    amountSatang: input.amountSatang,
    source: 'promo_voucher',
    keys: [{ kind: 'voucher_qr', value: mintVoucherQr() }],
    saleId: input.saleId,
    stationId: input.stationId,
    boxId: input.boxId ?? null,
    businessDate,
    expiresAt,
    payload: { voucherId: input.voucherId },
    now,
  });
}

/** The wallet a wallet-credit voucher loaded, or null while it has loaded none. */
export async function voucherCreditWalletOf(db: Exec, operatorId: string, voucherId: string): Promise<WalletRow | null> {
  const entry = await entryOfAction(db, operatorId, voucherLoadActionId(voucherId));
  if (!entry) return null;
  const [row] = await db.select().from(wallet).where(eq(wallet.id, entry.walletId)).limit(1);
  return row ?? null;
}

// --- A child's prepaid food --------------------------------------------------------

export function prepaidActionId(checkinId: string): string {
  return `checkin:${checkinId}:prepaid`;
}

/**
 * WHAT THE SALE CHARGED FOR A STAY'S PREPAID FOOD, off the sale's own ledger:
 * the `food_provision` line whose cart line is the stay's id (`priceLedgerLines`
 * makes exactly one per line that carries food). `baseSatang` is the figure the
 * till put on the line, `grossSatang` the money the line actually charged.
 * Null when the sale carried no food for this stay.
 */
export async function prepaidChargeOf(
  db: Exec,
  saleId: string,
  checkinId: string,
): Promise<{ lineId: string; baseSatang: number; grossSatang: number } | null> {
  const [line] = await db
    .select({ lineId: saleLine.id, baseSatang: saleLine.baseSatang, grossSatang: saleLine.grossSatang })
    .from(saleLine)
    .where(and(eq(saleLine.saleId, saleId), eq(saleLine.cartLineId, checkinId), eq(saleLine.kind, 'food_provision')))
    .orderBy(asc(saleLine.lineNo))
    .limit(1);
  return line ?? null;
}

/**
 * CHECK-IN-NOW LOADS THE CHILD'S OWN WALLET with their prepaid food credit
 * (prototype `checkInFamilyWithPayment`, `mockApi.ts:5030-5065`: top the band
 * up and write a `grant` / `prepaid_food` ledger entry). One wallet per child
 * — found by the child's key, made the first time — carrying the stay's band
 * and a voucher QR; a walk-in child with no saved record gets a wallet of
 * their own on their band. Keyed `checkin:<id>:prepaid`: a retried check-in
 * loads once.
 *
 * THE MONEY BEHIND THE CREDIT IS THE SALE'S, NOT THE REGISTRATION'S (gate
 * round 1, finding 1). The registration row arrives from the till with a
 * `paidSatang` / `creditSatang` it asserts; the wallet is loaded with what the
 * sale's `food_provision` line for this stay charged (`prepaidChargeOf`), so
 * no stored value exists that nobody paid for. The prototype loads credit
 * equal to what was paid (`ChildFoodProvisionPicker.tsx:83,97` sets
 * `paidTHB = creditAmountTHB`), so the two agree on every honest path; where
 * the registration disagrees with the ledger — a different figure, or a sale
 * that charged nothing for the food — the check-in is refused rather than
 * loading either figure, and nobody goes in the park.
 */
export async function loadChildPrepaid(
  tx: Tx,
  actor: WalletActor,
  input: { stay: CheckinRow; saleRow: SaleRow; bandCode: string | null; now?: Date },
): Promise<WalletWrite | null> {
  const { stay, saleRow } = input;
  const fp = stay.foodProvision;
  if (!fp || fp.mode !== 'prepaid_credit') return null;
  const charged = await prepaidChargeOf(tx, saleRow.id, stay.id);
  const lineSatang = charged?.baseSatang ?? 0;
  const claimedSatang = fp.creditSatang ?? fp.paidSatang;
  if (lineSatang !== fp.paidSatang || claimedSatang !== lineSatang) {
    throw errors.conflict(
      'PREPAID_FOOD_MISMATCH',
      `${stay.childName}'s registration says ${formatTHB(claimedSatang)} of prepaid food, but this sale charged ${
        charged ? formatTHB(lineSatang) : 'nothing'
      } for it — correct the registration or the sale, then check in again.`,
    );
  }
  if (!charged || charged.grossSatang <= 0) return null;
  const amount = charged.grossSatang;
  const now = input.now ?? new Date();
  const actionId = prepaidActionId(stay.id);
  const { businessDate, expiresAt } = await expiryFor(tx, stay.branchId, now);
  const common = {
    actionId,
    amountSatang: amount,
    source: 'prepaid_food' as const,
    branchId: stay.branchId,
    saleId: saleRow.id,
    stationId: saleRow.stationId,
    boxId: saleRow.boxId,
    businessDate,
    expiresAt,
    payload: { checkinId: stay.id, childId: stay.childId, saleLineId: charged.lineId },
    now,
  };
  const bandKey = input.bandCode ? [{ kind: 'band' as const, value: input.bandCode }] : [];
  if (stay.childId) {
    // One wallet per child: the child's key finds it, and a concurrent first
    // load for the same child waits here rather than making two.
    await lockAction(tx, actor.operatorId, `child:${stay.childId}`);
    const existing = await walletByKey(tx, actor.operatorId, 'child', stay.childId);
    if (existing) {
      await attachKeys(tx, actor.operatorId, existing.id, bandKey, now);
      if (stay.childName && existing.holderName !== stay.childName) {
        await tx.update(wallet).set({ holderName: stay.childName, updatedAt: now }).where(eq(wallet.id, existing.id));
      }
      return loadWallet(tx, actor, { walletId: existing.id, ...common });
    }
  }
  return createWalletWithGrant(tx, actor, {
    ...common,
    memberId: saleRow.memberId,
    holderName: stay.childName,
    keys: [
      ...(stay.childId ? [{ kind: 'child' as const, value: stay.childId }] : []),
      ...bandKey,
      { kind: 'voucher_qr' as const, value: mintVoucherQr() },
    ],
  });
}

/**
 * WHAT IS LEFT ON A PREPAID-CREDIT CHILD'S WALLET, for the release's
 * reconciliation: the wallet this stay's load went onto, as it stands now —
 * every spend against it already taken off. Null when the stay loaded nothing
 * — a stay checked in before S2-14a, one the box's offline replay put in the
 * park (round 4 loads there), or one with no prepaid credit. A null is "no
 * load", never "nothing left": the caller falls back to what was paid.
 */
export async function prepaidBalanceOf(
  db: Exec,
  operatorId: string,
  checkinId: string,
  options: { lock?: boolean } = {},
): Promise<{
  walletId: string;
  balanceSatang: number;
  /** What this stay's check-in loaded. */
  loadedSatang: number;
  /** This stay's net spending since its load: spends, less refunds put back. */
  spentSatang: number;
  /**
   * What the release may hand back in cash for THIS stay (round 2 carryover):
   * its own load less its own spending, and never more than the wallet holds.
   * A leftover from an earlier stay stays on the wallet — the child's own pool.
   */
  refundableSatang: number;
} | null> {
  const loaded = await entryOfAction(db, operatorId, prepaidActionId(checkinId));
  if (!loaded) return null;
  const base = db.select().from(wallet).where(eq(wallet.id, loaded.walletId));
  // Locked inside the release's savepoint, so the figure refunded is the figure
  // a counter's spend cannot change before the debit lands.
  const [row] = options.lock ? await base.for('update').limit(1) : await base.limit(1);
  if (!row) return null;
  // Round 3 (the r2 re-check's kept failure): only COUNTER spending is this
  // stay's — a spend at F&B or the shop, and the restores refunds put back
  // through those tenders. Another stay's release debit (kind `spend`, source
  // `refund`) is that stay's cash going home, not this stay's food, and an
  // expiry is neither.
  const since = await db
    .select({ id: walletEntry.id, kind: walletEntry.kind, amount: walletEntry.amountSatang, createdAt: walletEntry.createdAt })
    .from(walletEntry)
    .where(
      and(
        eq(walletEntry.walletId, row.id),
        sql`((${walletEntry.kind} = 'spend' and ${walletEntry.source} in ('fnb_order','merch_order')) or (${walletEntry.kind} = 'refund' and ${walletEntry.source} = 'refund'))`,
      ),
    );
  const spentSatang = since
    .filter((e) => e.id !== loaded.id && (e.createdAt > loaded.createdAt || (e.createdAt.getTime() === loaded.createdAt.getTime() && e.id > loaded.id)))
    .reduce((sum, e) => sum - e.amount, 0);
  const refundableSatang = Math.max(0, Math.min(row.balanceSatang, loaded.amountSatang - Math.max(0, spentSatang)));
  return { walletId: row.id, balanceSatang: row.balanceSatang, loadedSatang: loaded.amountSatang, spentSatang, refundableSatang };
}

// --- Round 3: expiry, reactivation, the figures (plan §2.5) -------------------------

/**
 * WHEN THE WALLET'S NEWEST CREDIT STOPS BEING SPENDABLE: the `expires_at` its
 * LATEST credit recorded — a ticket grant, a child's prepaid load or a
 * reactivation — which each wrote from the branch's `wallet_policy` at the
 * time (same day, N business days, or null for `never`). The view's date.
 * It is NOT the rule a spend or the day end goes by: each credit expires by
 * its own date (`expiredCreditHeld`), so older credit on a reloaded wallet
 * dies on time whatever the newest load says.
 */
export async function creditExpiresAt(db: Exec, walletId: string): Promise<Date | null> {
  const [latest] = await db
    .select({ expiresAt: walletEntry.expiresAt })
    .from(walletEntry)
    .where(and(eq(walletEntry.walletId, walletId), inArray(walletEntry.kind, ['grant', 'reactivate'])))
    .orderBy(desc(walletEntry.createdAt), desc(walletEntry.id))
    .limit(1);
  return latest?.expiresAt ?? null;
}

/** What the expiry rule reads of an entry. */
export interface CreditLot {
  kind: WalletEntryKind;
  amountSatang: number;
  expiresAt: Date | null;
}

/**
 * HOW MUCH OF WHAT A WALLET HOLDS HAS EXPIRED, as at `at` (the gate's G1).
 *
 * The ledger is one pool, not lots, so the rule is the kindest reading that
 * still lets no credit outlive its policy: a spend is taken from the credit
 * that dies FIRST, so whatever is still live is attributed to the credit that
 * has not expired yet, and the rest has. In figures: `held` is what the
 * entries given sum to; `live` is the credit entries (grant, reactivate) whose
 * own `expires_at` is after `at`, or null (`never`); and the expired part is
 * `held - live`, floored at zero and capped at what the wallet holds now.
 *
 *   - same_day: every credit dated yesterday or before is dead today, and only
 *     today's load is spendable — a reload never revives it;
 *   - days_n: a lot taken by its own last day, however many came after it;
 *   - never: nothing, ever, since every credit is live.
 *
 * Pure, so the spend's clock check, the day-end job and the view agree by
 * construction: the job passes the entries dated through the day with the
 * day's cutoff; a spend passes them all with "now".
 */
export function expiredCreditHeld(entries: readonly CreditLot[], at: Date, balanceNow: number): number {
  let held = 0;
  let live = 0;
  for (const e of entries) {
    held += e.amountSatang;
    if ((e.kind === 'grant' || e.kind === 'reactivate') && (!e.expiresAt || e.expiresAt.getTime() > at.getTime())) live += e.amountSatang;
  }
  return Math.min(balanceNow, Math.max(0, held - live));
}

async function lotsOf(db: Exec, walletId: string): Promise<(CreditLot & { businessDate: string | null; createdAt: Date })[]> {
  return db
    .select({ kind: walletEntry.kind, amountSatang: walletEntry.amountSatang, expiresAt: walletEntry.expiresAt, businessDate: walletEntry.businessDate, createdAt: walletEntry.createdAt })
    .from(walletEntry)
    .where(eq(walletEntry.walletId, walletId));
}

/**
 * THE CREDIT ON A WALLET THAT HAS LAPSED BY THE CLOCK and the day-end job has
 * not taken yet: what a counter may NOT spend of the balance, right now. Zero
 * on a closed wallet (its balance is a refund's, live until the next day end).
 */
export async function lapsedCreditOf(db: Exec, row: Pick<WalletRow, 'id' | 'balanceSatang' | 'status'>, now: Date): Promise<number> {
  if (row.status !== 'active' || row.balanceSatang <= 0) return 0;
  return expiredCreditHeld(await lotsOf(db, row.id), now, row.balanceSatang);
}

/** True when the wallet has had credit and every piece of it has expired by `at`. */
async function allCreditExpired(db: Exec, walletId: string, at: Date): Promise<boolean> {
  const credits = (await lotsOf(db, walletId)).filter((e) => e.kind === 'grant' || e.kind === 'reactivate');
  return credits.length > 0 && credits.every((e) => e.expiresAt !== null && e.expiresAt.getTime() <= at.getTime());
}

/** A branch's clock, as the day-end work reads it. */
export interface WalletBranchClock {
  id: string;
  operatorId: string;
  timezone: string;
  dayStartMinutes: number;
}

async function branchClockOf(db: Exec, branchId: string): Promise<WalletBranchClock> {
  const [br] = await db
    .select({ id: branch.id, operatorId: branch.operatorId, timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(eq(branch.id, branchId))
    .limit(1);
  if (!br) throw errors.notFound('Branch not found');
  return { id: br.id, operatorId: br.operatorId, timezone: br.timezone, dayStartMinutes: parseDayStart(br.dayStart) };
}

/** Every live branch, for the day-end jobs. */
export async function walletBranchClocks(db: Exec): Promise<WalletBranchClock[]> {
  const rows = await db
    .select({ id: branch.id, operatorId: branch.operatorId, timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(isNull(branch.archivedAt));
  return rows.map((br) => ({ id: br.id, operatorId: br.operatorId, timezone: br.timezone, dayStartMinutes: parseDayStart(br.dayStart) }));
}

/**
 * The business date an entry belongs to: the one it carries (the clock's day
 * of its moment, `applyEntry`), else — a row written before the ledger carried
 * one — the day its instant fell in at its branch. Both are the day the money
 * moved, never the day of the sale it settled.
 */
function entryDay(entry: { businessDate: string | null; createdAt: Date }, clock: WalletBranchClock): string {
  return entry.businessDate ?? businessDateOf(entry.createdAt, clock.timezone, clock.dayStartMinutes);
}

/** One expiry per wallet per business day per branch, for ever. */
export function expiryActionId(branchId: string, businessDate: string, walletId: string): string {
  return `expiry:${branchId}:${businessDate}:${walletId}`;
}

export interface WalletDayExpiry {
  branchId: string;
  businessDate: string;
  /** False when the day has not ended yet at this branch — nothing was looked at. */
  ended: boolean;
  /** Wallets an `expire` entry was written for, and what they held. */
  expiredWallets: number;
  expiredSatang: number;
  /** Wallets already at ฿0 whose credit had run out: closed, no entry (no money moved). */
  closedAtZero: number;
}

/**
 * THE BRANCH'S DAY ENDS — ITS CREDIT EXPIRES (plan §2.5; prototype
 * `expireFnbCredit`, `mockApi.ts:2645-2654`: zero the balance, write an
 * `expire` / `expiry` entry for what was left).
 *
 * For one branch and one ENDED business day: every wallet issued there that
 * holds credit which had expired by that day's end — EACH credit by its OWN
 * `expires_at` (`expiredCreditHeld`), never the newest load's — loses that
 * credit as it stood through that day: an `expire` entry keyed
 * `expiry:<branch>:<date>:<wallet>`, dated that business day. A wallet that
 * leaves nothing on the wallet closes (`status = expired`). A child's prepaid
 * food is a wallet like any other and expires with it. `never` credit has no
 * expiry and is never touched; `days_n` credit is touched at its last day's
 * end, and a same-day load made on a LATER day neither saves the older credit
 * nor is taken with it (the gate's G1: a job that catches up a missed day
 * takes that day's credit and leaves the day after's).
 *
 * WHAT A DAY'S EXPIRY TAKES is read off the entries dated that day or before
 * — never more than the wallet holds now. An entry's date is the day its
 * money MOVED (`entryDay`), so a spend made today on a tab from yesterday is
 * today's and a catch-up of yesterday neither nets it off yesterday's credit
 * nor under-expires (the re-check's R1). Credit a refund put back after the
 * boundary belongs to the next day's figures and expires at the next day's
 * end — ALSO on a wallet the job had already closed (the gate's G2): a closed
 * wallet with money on it is a candidate like a live one, so nothing is ever
 * credit nobody can spend, bring back or expire.
 *
 * Idempotent: a rerun finds the action written (or the wallet closed) and
 * writes nothing new; two job instances racing one wallet queue on the
 * action's lock.
 */
export async function expireWalletsForDay(db: Exec, branchId: string, businessDate: string, now: Date = new Date()): Promise<WalletDayExpiry> {
  const clock = await branchClockOf(db, branchId);
  const cutoff = businessDayEndsAt(businessDate, clock.timezone, clock.dayStartMinutes);
  const result: WalletDayExpiry = {
    branchId,
    businessDate,
    ended: cutoff.getTime() <= now.getTime(),
    expiredWallets: 0,
    expiredSatang: 0,
    closedAtZero: 0,
  };
  if (!result.ended) return result;
  // A live wallet with ANY credit that had expired by the cutoff, or a closed
  // one a refund has put money back on since.
  const candidates = await db.execute<{ id: string }>(sql`
    select w.id from pos.wallet w
    where w.branch_id = ${branchId}
      and ((w.status = 'active'
            and exists (select 1 from pos.wallet_entry e
                        where e.wallet_id = w.id and e.kind in ('grant','reactivate')
                          and e.expires_at <= ${cutoff.toISOString()}::timestamptz))
           or (w.status = 'expired' and w.balance_satang > 0))
    order by w.id`);
  const actor: WalletActor = { accountId: null, operatorId: clock.operatorId };
  for (const { id } of candidates.rows) {
    await db.transaction(async (tx) => {
      const actionId = expiryActionId(branchId, businessDate, id);
      await lockAction(tx, clock.operatorId, actionId);
      if (await entryOfAction(tx, clock.operatorId, actionId)) return;
      const [locked] = await tx.select().from(wallet).where(eq(wallet.id, id)).for('update').limit(1);
      if (!locked) return;
      if (locked.status !== 'active' && locked.balanceSatang === 0) return;
      // Read under the lock: credit loaded since the candidates were read is
      // dated after this day and counts for neither side of the rule.
      const lots = (await lotsOf(tx, id)).filter((e) => entryDay(e, clock) <= businessDate);
      const credits = lots.filter((e) => e.kind === 'grant' || e.kind === 'reactivate');
      // Nothing of this wallet's credit had expired by this day's end.
      if (locked.status === 'active' && !credits.some((e) => e.expiresAt && e.expiresAt.getTime() <= cutoff.getTime())) return;
      const amount = expiredCreditHeld(lots, cutoff, locked.balanceSatang);
      if (amount > 0) {
        await applyEntry(tx, actor, id, {
          actionId,
          kind: 'expire',
          source: 'expiry',
          amountSatang: -amount,
          branchId,
          businessDate,
          payload: {
            expiredAt: cutoff.toISOString(),
            // The dates of the credit this took, oldest first — the lots, for the books.
            creditExpiresAt: [...new Set(credits.filter((e) => e.expiresAt && e.expiresAt.getTime() <= cutoff.getTime()).map((e) => e.expiresAt!.toISOString()))].sort(),
          },
          now,
        });
        result.expiredWallets += 1;
        result.expiredSatang += amount;
      } else if (
        locked.balanceSatang === 0 &&
        locked.status === 'active' &&
        // Closed only once no credit on it is still live — a `days_n` wallet
        // spent to ฿0 with a lot still in date stays open for a refund.
        !credits.some((e) => !e.expiresAt || e.expiresAt.getTime() > cutoff.getTime())
      ) {
        await tx.update(wallet).set({ status: 'expired', updatedAt: now }).where(eq(wallet.id, id));
        await audit.record(tx, {
          actorAccountId: null,
          operatorId: clock.operatorId,
          branchId,
          action: 'wallet.expire',
          entityType: 'wallet',
          entityId: id,
          actionId,
          before: { balanceSatang: 0, status: locked.status },
          after: { balanceSatang: 0, status: 'expired', businessDate, amountSatang: 0 },
        });
        result.closedAtZero += 1;
      }
    });
  }
  return result;
}

/** How many ended days back the day-end jobs look, so a job that was down closes the days it missed. */
export const WALLET_DAY_END_LOOKBACK_DAYS = 7;

/** The ended business days a branch's day-end work covers at `now`, oldest first. */
export function endedWalletDays(clock: WalletBranchClock, now: Date, lookback = WALLET_DAY_END_LOOKBACK_DAYS): string[] {
  const today = businessDateOf(now, clock.timezone, clock.dayStartMinutes);
  const days: string[] = [];
  for (let d = lookback; d >= 1; d -= 1) days.push(addDaysToIsoDate(today, -d));
  return days;
}

/** `job:wallet.expiry` — every branch's ended days, expired by its policy. */
export async function runWalletExpiryJob(db: Exec, now: Date): Promise<Record<string, number>> {
  let days = 0;
  let wallets = 0;
  let satang = 0;
  let closed = 0;
  for (const clock of await walletBranchClocks(db)) {
    for (const date of endedWalletDays(clock, now)) {
      const done = await expireWalletsForDay(db, clock.id, date, now);
      days += 1;
      wallets += done.expiredWallets;
      satang += done.expiredSatang;
      closed += done.closedAtZero;
    }
  }
  return { days, expiredWallets: wallets, expiredSatang: satang, closedAtZero: closed };
}

/** One reactivation per expiry: bringing the same expired credit back twice is a replay. */
export function reactivateActionId(expireEntryId: string): string {
  return `reactivate:${expireEntryId}`;
}

/**
 * A MANAGER BRINGS EXPIRED CREDIT BACK (plan §2.5): its own entry
 * (`reactivate` / `reactivation`), exactly the remainder the last expiry
 * took, the wallet active again with a fresh expiry from today's policy, and
 * the typed reason on the entry and on the audit row (before/after). The
 * caller holds `pos:wallet:reactivate` at the wallet's park — the route
 * checks it.
 *
 * Refused, having written nothing: no reason typed; a wallet whose credit has
 * not expired; a wallet that ran out before it expired (nothing to bring back).
 */
export async function reactivateWallet(
  tx: Tx,
  actor: WalletActor,
  input: { walletId: string; reason: string; stationId?: string | null; now?: Date },
): Promise<WalletWrite> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError(400, 'REASON_REQUIRED', 'Type why this credit is coming back — a reactivation is kept with its reason.');
  }
  const notExpired = () =>
    errors.conflict('WALLET_NOT_EXPIRED', "This wallet's credit has not expired — there is nothing to bring back.", {
      walletId: input.walletId,
    });
  const nothingBack = () =>
    errors.conflict('NOTHING_TO_REACTIVATE', 'This wallet ran out before its credit expired — there is nothing to bring back.', {
      walletId: input.walletId,
    });
  const [current] = await tx.select().from(wallet).where(eq(wallet.id, input.walletId)).limit(1);
  if (!current || current.operatorId !== actor.operatorId) throw walletNotFound();
  // THE EXPIRY THAT CAN COME BACK IS THE WALLET'S LATEST MOVEMENT OF CREDIT
  // (the gate's G3, the view's `reactivatableSatang`): the newest of its
  // expire, grant and reactivate entries. Credit loaded after an expiry
  // started a new life for the wallet; if that ran out before its own day
  // end, the wallet closed taking nothing, and an OLDER expiry's remainder is
  // not "the expired remainder" — nothing comes back.
  const [latest] = await tx
    .select()
    .from(walletEntry)
    .where(and(eq(walletEntry.operatorId, actor.operatorId), eq(walletEntry.walletId, input.walletId), inArray(walletEntry.kind, ['expire', 'grant', 'reactivate'])))
    .orderBy(desc(walletEntry.createdAt), desc(walletEntry.id))
    .limit(1);
  if (latest?.kind === 'reactivate') {
    // The newest movement IS a reactivation: a replayed press (the same
    // gesture retried, or a second manager a moment later) answers with it
    // while the wallet is live; one that has since run out and closed again
    // has nothing to return.
    await lockAction(tx, actor.operatorId, latest.actionId);
    const [locked] = await tx.select().from(wallet).where(eq(wallet.id, input.walletId)).for('update').limit(1);
    if (!locked) throw walletNotFound();
    if (locked.status === 'active') return { wallet: locked, entry: latest, replayed: true };
    throw nothingBack();
  }
  if (!latest || latest.kind !== 'expire') {
    if (current.status !== 'expired') throw notExpired();
    // A closed wallet with money on it: a refund put it back after the day
    // end (the gate's G2). It is live until the next day end takes it.
    if (current.balanceSatang > 0) {
      throw errors.conflict(
        'NOTHING_TO_REACTIVATE',
        `This wallet's ${formatTHB(current.balanceSatang)} came back from a refund after its credit expired — it goes with the next day end; there is nothing to bring back.`,
        { walletId: input.walletId, balanceSatang: current.balanceSatang },
      );
    }
    throw nothingBack();
  }
  const expiry = latest;
  const actionId = reactivateActionId(expiry.id);
  await lockAction(tx, actor.operatorId, actionId);
  const done = await entryOfAction(tx, actor.operatorId, actionId);
  const [locked] = await tx.select().from(wallet).where(eq(wallet.id, input.walletId)).for('update').limit(1);
  if (!locked) throw walletNotFound();
  if (done) {
    // The same expiry brought back already: a replay while the wallet is live;
    // a wallet that has since run out and closed again has nothing to return.
    if (locked.status === 'active') return { wallet: locked, entry: done, replayed: true };
    throw nothingBack();
  }
  if (locked.status !== 'expired') throw notExpired();
  const branchId = locked.branchId ?? expiry.branchId;
  if (!branchId) throw walletNotFound();
  const now = input.now ?? new Date();
  const { businessDate, expiresAt } = await expiryFor(tx, branchId, now);
  const written = await applyEntry(tx, actor, locked.id, {
    actionId,
    kind: 'reactivate',
    source: 'reactivation',
    amountSatang: -expiry.amountSatang,
    branchId,
    stationId: input.stationId ?? null,
    businessDate,
    expiresAt,
    payload: { reason, expireEntryId: expiry.id },
    reason,
    now,
  });
  return { ...written, replayed: false };
}

// --- The figures --------------------------------------------------------------------

/**
 * Each entry with the business date it belongs to at its wallet's park: the
 * date it carries, else the day its instant fell in on that park's clock (the
 * SQL twin of `entryDay`). Either way it is the day the money MOVED — a spend
 * on a tab from an earlier day is filed under the day it was paid, so no
 * day's figures carry spending of credit that did not exist yet and the
 * ledger's running sum through any day is never below zero (the re-check's
 * R2/R2b; the liability fact's CHECK). `w.branch_id` is the park the figures
 * are filed under — a wallet spends only at the park that issued it.
 */
const ENTRIES = sql`(
  select e.id, e.wallet_id, e.operator_id, e.kind, e.source, e.amount_satang, e.payment_attempt_id,
         e.actor_account_id, e.created_at, w.branch_id, w.holder_name,
         coalesce(e.business_date, ((e.created_at at time zone b.timezone) - (b.business_day_start - time '00:00'))::date) as day
  from pos.wallet_entry e
  join pos.wallet w on w.id = e.wallet_id
  join core.branch b on b.id = coalesce(w.branch_id, e.branch_id)
)`;

function branchFilter(column: SQL, branchIds: readonly string[] | null): SQL {
  if (branchIds === null) return sql`true`;
  if (branchIds.length === 0) return sql`false`;
  return sql`${column} in (${sql.join(
    branchIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

interface Movements {
  grantedSatang: number;
  spentSatang: number;
  refundedSatang: number;
  expiredSatang: number;
  reactivatedSatang: number;
  entryCount: number;
}

async function movementsOf(db: Exec, operatorId: string, branchIds: readonly string[] | null, from: string, to: string): Promise<Movements> {
  const { rows } = await db.execute<Record<string, string | number | null>>(sql`
    select
      coalesce(sum(case when x.kind = 'grant' then x.amount_satang end), 0)::bigint as granted,
      coalesce(sum(case when x.kind = 'spend' then -x.amount_satang end), 0)::bigint as spent,
      coalesce(sum(case when x.kind = 'refund' then x.amount_satang end), 0)::bigint as refunded,
      coalesce(sum(case when x.kind = 'expire' then -x.amount_satang end), 0)::bigint as expired,
      coalesce(sum(case when x.kind = 'reactivate' then x.amount_satang end), 0)::bigint as reactivated,
      count(*)::bigint as entries
    from ${ENTRIES} x
    where x.operator_id = ${operatorId} and x.day between ${from}::date and ${to}::date
      and ${branchFilter(sql.raw('x.branch_id'), branchIds)}`);
  const r = rows[0] ?? {};
  return {
    grantedSatang: Number(r.granted ?? 0),
    spentSatang: Number(r.spent ?? 0),
    refundedSatang: Number(r.refunded ?? 0),
    expiredSatang: Number(r.expired ?? 0),
    reactivatedSatang: Number(r.reactivated ?? 0),
    entryCount: Number(r.entries ?? 0),
  };
}

/** What the ledger says was outstanding as a day closed: every entry dated that day or before (null: all of it). */
async function ledgerOutstandingThrough(db: Exec, operatorId: string, branchIds: readonly string[] | null, through: string | null): Promise<number> {
  const { rows } = await db.execute<{ total: string | number | null }>(sql`
    select coalesce(sum(x.amount_satang), 0)::bigint as total
    from ${ENTRIES} x
    where x.operator_id = ${operatorId}
      and ${through === null ? sql`true` : sql`x.day <= ${through}::date`}
      and ${branchFilter(sql.raw('x.branch_id'), branchIds)}`);
  return Number(rows[0]?.total ?? 0);
}

/** The live balances, summed: the guarded projection, now. */
async function liveOutstanding(db: Exec, operatorId: string, branchIds: readonly string[] | null): Promise<number> {
  const { rows } = await db.execute<{ total: string | number | null }>(sql`
    select coalesce(sum(w.balance_satang), 0)::bigint as total from pos.wallet w
    where w.operator_id = ${operatorId} and ${branchFilter(sql.raw('w.branch_id'), branchIds)}`);
  return Number(rows[0]?.total ?? 0);
}

/**
 * THE WALLET & PROMO REPORT'S CREDIT HALF, off the ledger (prototype
 * `walletCreditSummary` + `walletLedgerRows`, `lib/reporting.ts:482-549`):
 * granted / spent / refunded / expired (and reactivated) over the range's
 * business dates, the outstanding snapshot (live balances, not date-ranged)
 * beside the ledger's own sum of it, and the newest rows. `branchIds` null is
 * every park of the operator.
 */
export async function walletReportOf(
  db: Exec,
  operatorId: string,
  filters: { branchIds: readonly string[] | null; from: string; to: string; limit?: number },
): Promise<{ summary: WalletReportSummary; rows: WalletReportRow[] }> {
  const movements = await movementsOf(db, operatorId, filters.branchIds, filters.from, filters.to);
  const outstandingSatang = await liveOutstanding(db, operatorId, filters.branchIds);
  const ledgerOutstandingSatang = await ledgerOutstandingThrough(db, operatorId, filters.branchIds, null);
  const { rows } = await db.execute<{
    id: string;
    wallet_id: string;
    kind: WalletEntryKind;
    source: WalletEntrySource;
    amount_satang: string | number;
    actor_account_id: string | null;
    created_at: Date | string;
    holder_name: string | null;
    day: string;
  }>(sql`
    select x.id, x.wallet_id, x.kind, x.source, x.amount_satang, x.actor_account_id, x.created_at, x.holder_name, x.day::text as day
    from ${ENTRIES} x
    where x.operator_id = ${operatorId} and x.day between ${filters.from}::date and ${filters.to}::date
      and ${branchFilter(sql.raw('x.branch_id'), filters.branchIds)}
    order by x.created_at desc, x.id desc
    limit ${filters.limit ?? 100}`);
  const walletIds = [...new Set(rows.map((r) => r.wallet_id))];
  const keys = walletIds.length
    ? await db
        .select({ walletId: walletKey.walletId, kind: walletKey.kind, value: walletKey.value })
        .from(walletKey)
        .where(inArray(walletKey.walletId, walletIds))
        .orderBy(asc(walletKey.createdAt))
    : [];
  const keyOf = (walletId: string): string => {
    const bandKey = keys.find((k) => k.walletId === walletId && k.kind === 'band');
    if (bandKey) return bandShortCode(bandKey.value) ?? 'Band';
    return keys.find((k) => k.walletId === walletId && k.kind === 'voucher_qr')?.value ?? '—';
  };
  const names = await namesOf(db, rows.map((r) => r.actor_account_id).filter((id): id is string => !!id));
  return {
    summary: { ...movements, outstandingSatang, ledgerOutstandingSatang },
    rows: rows.map((r) => ({
      entryId: r.id,
      walletId: r.wallet_id,
      keyDisplay: keyOf(r.wallet_id),
      holderName: r.holder_name,
      kind: r.kind,
      source: r.source,
      amountSatang: Number(r.amount_satang),
      businessDate: String(r.day).slice(0, 10),
      at: new Date(r.created_at).toISOString(),
      by: r.actor_account_id ? (names.get(r.actor_account_id) ?? null) : null,
    })),
  };
}

/**
 * THE END OF DAY `credit` LINE (prototype `getEndOfDay`, `mockApi.ts:2228-2324`:
 * "F&B credit redeemed, net of F&B credit restored on refund", per order on
 * the date): what the F&B and shop counters took from wallets on the business
 * date — the day the credit MOVED, so a tab from yesterday paid today counts
 * today — less what refunds have put back through THOSE spends — whenever
 * the refund was — so the line never reads below zero.
 */
export async function creditRedeemedOn(db: Exec, operatorId: string, branchId: string, businessDate: string): Promise<WalletCreditDay> {
  const { rows } = await db.execute<{ redeemed: string | number | null; restored: string | number | null }>(sql`
    with spends as (
      select x.id, x.payment_attempt_id, -x.amount_satang as amount
      from ${ENTRIES} x
      where x.operator_id = ${operatorId} and x.branch_id = ${branchId}::uuid and x.day = ${businessDate}::date
        and x.kind = 'spend' and x.source in ('fnb_order','merch_order')
    )
    select
      (select coalesce(sum(amount), 0) from spends)::bigint as redeemed,
      (select coalesce(sum(r.amount_satang), 0) from pos.wallet_entry r
        where r.kind = 'refund' and r.operator_id = ${operatorId}
          and r.payment_attempt_id in (select s.payment_attempt_id from spends s where s.payment_attempt_id is not null))::bigint as restored`);
  const redeemedSatang = Number(rows[0]?.redeemed ?? 0);
  const restoredSatang = Number(rows[0]?.restored ?? 0);
  return { branchId, businessDate, redeemedSatang, restoredSatang, netSatang: Math.max(0, redeemedSatang - restoredSatang) };
}

export interface WalletLiabilityDay {
  branchId: string;
  businessDate: string;
  grantedSatang: number;
  spentSatang: number;
  refundedSatang: number;
  expiredSatang: number;
  reactivatedSatang: number;
  outstandingSatang: number;
}

/**
 * ONE BRANCH'S STORED-VALUE DAY, from the ledger. Sign-exact by construction:
 *
 *   outstanding(D) = outstanding(D-1) + granted - spent + refunded - expired + reactivated
 *
 * where every figure is the positive sum of that kind's entries dated D, and
 * outstanding is the sum of every entry dated D or before — so the identity
 * is the ledger's own arithmetic, and `refunded` (credit a refund put BACK on
 * a wallet) adds to what is owed rather than taking from it.
 */
export async function walletLiabilityOf(db: Exec, branchId: string, businessDate: string): Promise<WalletLiabilityDay & { operatorId: string }> {
  const clock = await branchClockOf(db, branchId);
  const m = await movementsOf(db, clock.operatorId, [branchId], businessDate, businessDate);
  const outstandingSatang = await ledgerOutstandingThrough(db, clock.operatorId, [branchId], businessDate);
  return {
    operatorId: clock.operatorId,
    branchId,
    businessDate,
    grantedSatang: m.grantedSatang,
    spentSatang: m.spentSatang,
    refundedSatang: m.refundedSatang,
    expiredSatang: m.expiredSatang,
    reactivatedSatang: m.reactivatedSatang,
    outstandingSatang,
  };
}

/**
 * WRITE THE DAY'S FACT (`analytics.fact_wallet_liability_daily`), idempotent
 * per branch and date: recomputed from the ledger and upserted, and an
 * unchanged day writes nothing (the update only fires when a figure moved —
 * an offline spend synced late, a refund put back into a past day).
 */
export async function writeWalletLiabilityFact(
  db: Exec,
  branchId: string,
  businessDate: string,
  now: Date = new Date(),
): Promise<{ written: boolean; fact: WalletLiabilityDay }> {
  const { operatorId, ...fact } = await walletLiabilityOf(db, branchId, businessDate);
  const values = {
    grantedSatang: fact.grantedSatang,
    spentSatang: fact.spentSatang,
    refundedSatang: fact.refundedSatang,
    expiredSatang: fact.expiredSatang,
    reactivatedSatang: fact.reactivatedSatang,
    outstandingSatang: fact.outstandingSatang,
  };
  const f = factWalletLiabilityDaily;
  const written = await db
    .insert(f)
    .values({ id: newId(), operatorId, branchId, businessDate, ...values, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [f.branchId, f.businessDate],
      set: { ...values, updatedAt: now },
      setWhere: sql`(${f.grantedSatang}, ${f.spentSatang}, ${f.refundedSatang}, ${f.expiredSatang}, ${f.reactivatedSatang}, ${f.outstandingSatang})
        is distinct from (excluded.granted_satang, excluded.spent_satang, excluded.refunded_satang, excluded.expired_satang, excluded.reactivated_satang, excluded.outstanding_satang)`,
    })
    .returning({ id: f.id });
  return { written: written.length > 0, fact };
}

/**
 * `job:wallet.liability` — every branch's ended days, written. A day that
 * cannot be written (the CHECK refuses a negative — a ledger that does not
 * add up) does not stop the other branches; the job then fails loudly with
 * the count, so the Failures page carries it.
 */
export async function runWalletLiabilityJob(db: Exec, now: Date): Promise<Record<string, number>> {
  let days = 0;
  let written = 0;
  let failed = 0;
  let firstError: unknown = null;
  for (const clock of await walletBranchClocks(db)) {
    for (const date of endedWalletDays(clock, now)) {
      days += 1;
      try {
        if ((await writeWalletLiabilityFact(db, clock.id, date, now)).written) written += 1;
      } catch (err) {
        failed += 1;
        firstError ??= err;
      }
    }
  }
  if (failed > 0) {
    throw new Error(`wallet liability: ${failed} of ${days} branch-days could not be written`, { cause: firstError });
  }
  return { days, written };
}

/** The branch's wallet rules as the policy read answers them. */
export async function walletPolicyViewOf(db: Exec, branchId: string): Promise<WalletPolicyViewDto> {
  return { branchId, ...(await walletPolicyOf(db, branchId)) };
}
