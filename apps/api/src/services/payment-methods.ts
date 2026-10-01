import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import { paymentAttempt, paymentMethod } from '@oto/db';
import {
  PAID_ONLINE_TENDER_CODE,
  PAYMENT_METHODS,
  PAYMENT_METHOD_KINDS,
  WALLET_TENDER_CODE,
  newId,
  type PaymentMethodKind,
} from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import type { Exec, Tx } from './tx';

/**
 * THE TENDERS A PARK TAKES MONEY IN (S2-10a, SCRUM-206).
 *
 * The prototype keeps this list in browser memory — three rows seeded at
 * `apps/pos/src/store/catalogStore.ts:786-790` behind an admin panel that
 * edits them and loses them on reload. `pos.payment_method` is where they live
 * now, and this service is the whole of the writing.
 *
 * THE PROTOTYPE'S RULES, PORTED RATHER THAN REWRITTEN:
 *
 *   - **the list is data, never hardcoded** (`apps/pos/src/lib/payments.ts:17`).
 *     The till's method grid is sized from it, so a park that stops taking
 *     PromptPay unticks a row and the button goes;
 *   - **behaviour keys off `kind`, never off the token**
 *     (`lib/payments.ts:41,56,65`), which is why a second card acquirer is a
 *     row here and not a branch in the code;
 *   - **a legacy token still resolves** (`normalizePaymentMethod`,
 *     `lib/payments.ts:12`): `credit_card` is read as `card`, and the panel's
 *     `makeId` can never re-mint it (`PaymentMethodsSection.tsx:20-33`);
 *   - **reorder is a swap of two `sortOrder`s** (`PaymentMethodsSection.tsx:69-77`),
 *     which is `movePaymentMethod` below;
 *   - **deleting a tender in use warned and let it through**
 *     (`PaymentMethodsSection.tsx:56-67`). On a real ledger the count is real,
 *     so the refusal is the server's and the warning copy moves to the disable
 *     path — decision O-7.
 *
 * OPERATOR-WIDE, because the prototype says so in as many words: "paymentMethods
 * (same physical tenders everywhere)" (`catalogStore.ts:71`). There is no branch
 * in any signature here.
 */

/**
 * The kinds the ledger has a word for today.
 *
 * `pos.payment_attempt.method` is CHECKed against `PAYMENT_METHODS` — the six
 * words money can be filed under — and `pos.payment_method.kind` is one of four,
 * of which `other` is the one with no word waiting for it. Derived rather than
 * typed out so the day `wallet` becomes a kind, this list grows with the
 * vocabulary instead of being a second place to remember.
 *
 * WHY IT IS ENFORCED HERE. `finaliseSale` resolves a tender's kind through
 * `pos.payment_method` and refuses one it cannot file (`services/sale.ts`,
 * `tenderMethodOf`). A park allowed to create an `other` tender would therefore
 * be allowed to put a button on the till that takes money and then refuses the
 * sale at the counter. Better to refuse the configuration than the customer.
 */
export const LEDGER_BACKED_KINDS: readonly PaymentMethodKind[] = PAYMENT_METHOD_KINDS.filter(
  (kind): kind is PaymentMethodKind => (PAYMENT_METHODS as readonly string[]).includes(kind),
);

/**
 * Tokens an older till may have written for a tender that now has another code.
 *
 * The one entry is the prototype's own: `credit_card` was the token before
 * `card`, `normalizePaymentMethod` has collapsed it on read ever since, and
 * `finaliseSale` normalises it the same way before looking the row up. So
 * attempts filed under `credit_card` ARE the `card` tender's history, and the
 * in-use count below has to say so — otherwise a park is told its card tender
 * has never been used and allowed to delete it.
 */
const LEGACY_CODES: Readonly<Record<string, readonly string[]>> = { card: ['credit_card'] };

/** Every token the money rows may carry for this tender, newest first. */
function codesRecordedAs(code: string): string[] {
  return [code, ...(LEGACY_CODES[code] ?? [])];
}

/**
 * What the admin panel and the till both read.
 *
 * `id` is the CODE, not the row's uuid: the POS store keys its `PaymentMethod`
 * by the token stored on a sale, and the tier routes beside this one answer the
 * same way for the same reason (`routes/catalog.ts`, `GET /tiers`).
 */
export interface PaymentMethodView {
  id: string;
  label: string;
  kind: PaymentMethodKind;
  enabled: boolean;
  sortOrder: number;
  /**
   * How many money rows name this tender — the count the panel needs before it
   * offers a delete, so a manager is not told no by trying. It is a fact about
   * the ledger and not part of the configured tender, which is why it rides on
   * the read rather than on the row (the holiday list answers `pricedSales` in
   * the same place for the same reason).
   */
  attempts: number;
}

export interface PaymentMethodActor {
  accountId: string;
  operatorId: string;
  branchId: string | null;
  requestId?: string;
}

interface MethodRow {
  id: string;
  code: string;
  label: string;
  kind: PaymentMethodKind;
  enabled: boolean;
  sortOrder: number;
}

/** The operator's live tenders, in the order the till shows them. */
async function liveRows(db: Exec, operatorId: string): Promise<MethodRow[]> {
  return db
    .select({
      id: paymentMethod.id,
      code: paymentMethod.code,
      label: paymentMethod.label,
      kind: paymentMethod.kind,
      enabled: paymentMethod.enabled,
      sortOrder: paymentMethod.sortOrder,
    })
    .from(paymentMethod)
    .where(and(eq(paymentMethod.operatorId, operatorId), isNull(paymentMethod.archivedAt)))
    // `code` breaks a tie, so two rows that share a sort order still have ONE
    // order rather than whichever one the planner felt like — the method grid
    // must not rearrange itself between two reads.
    .orderBy(asc(paymentMethod.sortOrder), asc(paymentMethod.code));
}

async function loadRow(db: Exec, operatorId: string, code: string): Promise<MethodRow> {
  const [row] = await db
    .select({
      id: paymentMethod.id,
      code: paymentMethod.code,
      label: paymentMethod.label,
      kind: paymentMethod.kind,
      enabled: paymentMethod.enabled,
      sortOrder: paymentMethod.sortOrder,
    })
    .from(paymentMethod)
    .where(
      and(
        eq(paymentMethod.operatorId, operatorId),
        eq(paymentMethod.code, code),
        isNull(paymentMethod.archivedAt),
      ),
    )
    .limit(1);
  if (!row) throw errors.notFound('Payment method not found');
  return row;
}

/** How many money rows each token has, for one operator. */
async function attemptsByCode(db: Exec, operatorId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ code: paymentAttempt.methodCode, used: count() })
    .from(paymentAttempt)
    .where(eq(paymentAttempt.operatorId, operatorId))
    .groupBy(paymentAttempt.methodCode);
  const byCode = new Map<string, number>();
  for (const row of rows) {
    if (row.code) byCode.set(row.code, Number(row.used));
  }
  return byCode;
}

const usedCount = (byCode: Map<string, number>, code: string): number =>
  codesRecordedAs(code).reduce((sum, token) => sum + (byCode.get(token) ?? 0), 0);

export async function listPaymentMethods(
  db: Exec,
  operatorId: string,
): Promise<PaymentMethodView[]> {
  const [rows, byCode] = await Promise.all([liveRows(db, operatorId), attemptsByCode(db, operatorId)]);
  return rows.map((row) => ({
    id: row.code,
    label: row.label,
    kind: row.kind,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    attempts: usedCount(byCode, row.code),
  }));
}

/**
 * The refusal a kind with no ledger word earns, in words a manager can act on.
 *
 * It names the kinds that ARE available rather than only the one that is not:
 * "other is not allowed" leaves somebody guessing, and the guess is usually a
 * second attempt with the same answer.
 */
function assertLedgerBackedKind(kind: PaymentMethodKind): void {
  if (LEDGER_BACKED_KINDS.includes(kind)) return;
  throw errors.badRequest(
    `A tender has to be one the platform can file money under, and today those are ` +
      `${LEDGER_BACKED_KINDS.join(', ')}. Nothing records money against a “${kind}” tender yet, ` +
      `so the till would take the payment and then refuse the sale.`,
    { kind, allowed: [...LEDGER_BACKED_KINDS] },
  );
}

/**
 * `credit_card` is refused as a code because it is the one token that cannot be
 * tendered: every reader normalises it to `card` before looking the row up —
 * the POS on read (`normalizePaymentMethod`) and `finaliseSale` before it
 * resolves the kind — so a tender carrying it would be invisible to both. The
 * panel's `makeId` has never been able to mint it; this is the same rule at the
 * door, for a caller that is not the panel.
 */
function assertTenderableCode(code: string): void {
  if (code === 'credit_card') {
    throw errors.badRequest(
      '“credit_card” is the legacy token for a card tender and is always read as “card”, ' +
        'so a tender with that code could never be selected. Use “card”, or another code.',
      { code },
    );
  }
  /**
   * S2-12 / S2-14a — the two tenders the PLATFORM writes by itself: a booking's
   * "paid online" settlement and stored-value credit (`PAID_ONLINE_TENDER_CODE`,
   * `WALLET_TENDER_CODE`). Neither is ever chosen from the grid — `tenderMethodOf`
   * refuses them before a row is looked up — so a row under either code would
   * be a dead button the counter can press and get nothing from.
   */
  if (code === PAID_ONLINE_TENDER_CODE || code === WALLET_TENDER_CODE) {
    throw errors.badRequest(
      `“${code}” is written by the platform itself — ${code === WALLET_TENDER_CODE ? 'stored-value credit, taken by scanning a wallet' : 'a booking paid on the booking site, settled when it is redeemed'} — ` +
        'and is never chosen from the tender grid, so a tender under that code could take no money. Use another code.',
      { code, reserved: [PAID_ONLINE_TENDER_CODE, WALLET_TENDER_CODE] },
    );
  }
}

export async function createPaymentMethod(
  tx: Tx,
  actor: PaymentMethodActor,
  input: { code: string; label: string; kind: PaymentMethodKind; sortOrder?: number },
): Promise<{ id: string }> {
  assertTenderableCode(input.code);
  assertLedgerBackedKind(input.kind);

  const rows = await liveRows(tx, actor.operatorId);
  if (rows.some((row) => row.code === input.code)) {
    throw errors.conflict(
      'PAYMENT_METHOD_CODE_EXISTS',
      `This park already takes a tender called “${input.code}”`,
      { code: input.code },
    );
  }

  // The prototype puts a new tender at the end of the list
  // (`PaymentMethodsSection.tsx:48`), which is where staff expect to find it.
  const sortOrder =
    input.sortOrder ?? (rows.length ? Math.max(...rows.map((row) => row.sortOrder)) + 1 : 0);
  const id = newId();
  await tx.insert(paymentMethod).values({
    id,
    operatorId: actor.operatorId,
    code: input.code,
    label: input.label,
    kind: input.kind,
    enabled: true,
    sortOrder,
  });
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'payment_method.create',
    entityType: 'payment_method',
    entityId: id,
    after: { code: input.code, label: input.label, kind: input.kind, enabled: true, sortOrder },
    requestId: actor.requestId,
  });
  return { id };
}

export async function updatePaymentMethod(
  tx: Tx,
  actor: PaymentMethodActor,
  code: string,
  patch: { label?: string; kind?: PaymentMethodKind; enabled?: boolean; sortOrder?: number },
): Promise<{ ok: true }> {
  const before = await loadRow(tx, actor.operatorId, code);
  if (patch.kind !== undefined) assertLedgerBackedKind(patch.kind);

  const set: Partial<typeof paymentMethod.$inferInsert> = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
  if (Object.keys(set).length === 0) return { ok: true };

  await tx.update(paymentMethod).set(set).where(eq(paymentMethod.id, before.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'payment_method.update',
    entityType: 'payment_method',
    entityId: before.id,
    before: {
      code: before.code,
      label: before.label,
      kind: before.kind,
      enabled: before.enabled,
      sortOrder: before.sortOrder,
    },
    after: set,
    requestId: actor.requestId,
  });
  return { ok: true };
}

/**
 * Move a tender one place up or down the till's method grid.
 *
 * The prototype does this by swapping two `sortOrder` values
 * (`PaymentMethodsSection.tsx:69-77`) and that is exactly what happens here —
 * one transaction, one audit row, so the two rows can never be seen half
 * swapped by a till reading the list between them.
 *
 * The renumber branch is for data the panel could not have produced: two rows
 * sharing a sort order swap to no visible effect, so the list is compacted to
 * its positions instead. Seeded data has 0, 1, 2 and never takes it.
 */
export async function movePaymentMethod(
  tx: Tx,
  actor: PaymentMethodActor,
  code: string,
  direction: 'up' | 'down',
): Promise<{ ok: true; moved: boolean }> {
  const rows = await liveRows(tx, actor.operatorId);
  const at = rows.findIndex((row) => row.code === code);
  if (at < 0) throw errors.notFound('Payment method not found');
  const to = at + (direction === 'up' ? -1 : 1);
  // Already at the end it is being moved towards. The panel disables the
  // button there, so this is a caller that did not look — not an error.
  if (to < 0 || to >= rows.length) return { ok: true, moved: false };

  const moving = rows[at]!;
  const neighbour = rows[to]!;
  const written: Array<{ code: string; sortOrder: number }> = [];

  if (moving.sortOrder !== neighbour.sortOrder) {
    written.push(
      { code: moving.code, sortOrder: neighbour.sortOrder },
      { code: neighbour.code, sortOrder: moving.sortOrder },
    );
  } else {
    const reordered = [...rows];
    reordered[at] = neighbour;
    reordered[to] = moving;
    reordered.forEach((row, index) => {
      if (row.sortOrder !== index) written.push({ code: row.code, sortOrder: index });
    });
  }

  for (const row of written) {
    await tx
      .update(paymentMethod)
      .set({ sortOrder: row.sortOrder })
      .where(
        and(
          eq(paymentMethod.operatorId, actor.operatorId),
          eq(paymentMethod.code, row.code),
          isNull(paymentMethod.archivedAt),
        ),
      );
  }

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'payment_method.reorder',
    entityType: 'payment_method',
    entityId: moving.id,
    before: { code: moving.code, sortOrder: moving.sortOrder, direction },
    after: { order: written },
    requestId: actor.requestId,
  });
  return { ok: true, moved: true };
}

/**
 * Remove a tender the park no longer takes — refused once money has been taken
 * in it (decision O-7).
 *
 * The prototype warned and let the delete through, and on browser-memory
 * transactions that was harmless. On a real ledger it is not: every attempt
 * filed under the token would be left with a code nothing can name, and a
 * day-end report would show money taken by a tender that no longer exists. So
 * the count comes from `pos.payment_attempt` and the refusal is the server's;
 * the prototype's warning copy moves to the panel's disable path, which is the
 * thing it was recommending all along.
 *
 * Archived rather than deleted, and unticked with it: `payment_method_code_unique`
 * is partial on `archived_at is null`, so the token is free for a later tender,
 * and a reader that forgets the archive filter still sees a tender nobody can
 * pick.
 */
export async function archivePaymentMethod(
  tx: Tx,
  actor: PaymentMethodActor,
  code: string,
): Promise<{ ok: true }> {
  const before = await loadRow(tx, actor.operatorId, code);
  const [used] = await tx
    .select({ used: count() })
    .from(paymentAttempt)
    .where(
      and(
        eq(paymentAttempt.operatorId, actor.operatorId),
        inArray(paymentAttempt.methodCode, codesRecordedAs(code)),
      ),
    );
  const attempts = Number(used?.used ?? 0);
  if (attempts > 0) {
    throw errors.conflict(
      'PAYMENT_METHOD_IN_USE',
      `“${before.label}” has taken money on ${attempts} payment${attempts === 1 ? '' : 's'}, ` +
        `so it cannot be deleted — those records have to keep saying what they were paid in. ` +
        `Disable it instead: that hides it at checkout and keeps reporting clean.`,
      { code, attempts },
    );
  }

  await tx
    .update(paymentMethod)
    .set({ archivedAt: new Date(), enabled: false })
    .where(eq(paymentMethod.id, before.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'payment_method.archive',
    entityType: 'payment_method',
    entityId: before.id,
    before: { code: before.code, label: before.label, kind: before.kind },
    requestId: actor.requestId,
  });
  return { ok: true };
}
