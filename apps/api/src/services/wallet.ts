import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  account,
  band,
  branch,
  checkin,
  employee,
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
  bandShortCode,
  businessDate as businessDateOf,
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
  type WalletPrepaidUnusedPolicy,
  type WalletView,
} from '@oto/shared';
import { errors } from '../lib/errors';
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
  businessDate?: string | null;
  expiresAt?: Date | null;
  payload?: unknown;
  now?: Date;
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
  const [updated] = await tx
    .update(wallet)
    .set({
      balanceSatang: balanceAfter,
      // Credit loaded onto a wallet makes it spendable again; only the expiry
      // job (round 3) moves one the other way.
      ...(ctx.kind === 'grant' || ctx.kind === 'reactivate' ? { status: 'active' as const } : {}),
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
      businessDate: ctx.businessDate ?? null,
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
  source: Extract<WalletEntrySource, 'ticket_sale' | 'prepaid_food'>;
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
  return {
    id: row.id,
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
export async function prepaidBalanceOf(db: Exec, operatorId: string, checkinId: string): Promise<{ walletId: string; balanceSatang: number } | null> {
  const loaded = await entryOfAction(db, operatorId, prepaidActionId(checkinId));
  if (!loaded) return null;
  const [row] = await db.select().from(wallet).where(eq(wallet.id, loaded.walletId)).limit(1);
  return row ? { walletId: row.id, balanceSatang: row.balanceSatang } : null;
}
