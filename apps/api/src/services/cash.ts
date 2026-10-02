import { verify, hash } from '@node-rs/argon2';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  account,
  branch,
  cashMovement,
  cashSession,
  paymentAttempt,
  station,
  type Db,
} from '@oto/db';
import {
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  CASH_MOVEMENT_LABELS,
  PaymentRoutingSchema,
  businessDate,
  countsAsTillTakings,
  expectedCashOf,
  floatSourceLabel,
  formatTHB,
  newId,
  normalizePhone,
  parseDayStart,
  type CashDrawerView,
  type CashExpectedParts,
  type CashExpectedView,
  type CashManualMovementKind,
  type CashMovementKind,
  type CashMovementView,
  type CashSecondPerson,
  type CashSessionView,
  type Permission,
  type RefundAllocationEntry,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { throttleCheck, throttleClear, throttleFail } from './auth';
import { hasPermission, resolveEffectivePermissions } from './permissions';
import { accountNames } from './account-names';
import type { Exec, Tx } from './tx';

/**
 * S2-15a round 1 — CASH SESSIONS AND THE DRAWER (plan
 * docs/progress/plans/cash/PLAN.md §2.1-§2.2, OD-CS1..CS6).
 *
 * A session is one station's drawer, open to close (OD-CS1). It opens with the
 * float the drawer was left with at its last close, else the branch's standard
 * float (`core.branch.cash_default_float_satang`, the prototype's ฿6,000). Its
 * ledger is `pos.cash_movement`, append-only and action-keyed: the opening
 * float, paid-outs (an approver who is not the actor, with pos:cash:approve),
 * safe drops (a witness who is not the actor), top-ups, and the refund slices
 * handed back in cash.
 *
 * EXPECTED CASH is read, never typed: the float, plus the cash attempts taken
 * AT THAT STATION inside the session's window that pass `countsAsTillTakings`
 * (the one gate — wallet credit, paid-online, a booking-site attempt with no
 * station, card and QR never count), minus refund_out, paid_out and safe_drop,
 * plus top_up. Read from `pos.payment_attempt` (the sale's tender block writes
 * it; this file only reads it), scoped to the session's branch AND station, so
 * neither another park's money nor another counter's ever reaches this drawer
 * (the prototype's branch leak, §6, is not ported).
 *
 * CLOSING takes the count in satang, stores the expected figure and the
 * variance (counted − expected), freezes the branch tolerance in force (OD-CS3,
 * the prototype's ฿1), and is signed off by — held against — the person who
 * closed it. A count outside the tolerance needs a note (the prototype closed
 * without one: §6, not ported).
 *
 * Every write is one transaction, audited (`cash_session.open`,
 * `cash_session.close`, `cash_movement.<kind>`).
 */

type SessionRow = typeof cashSession.$inferSelect;
type MovementRow = typeof cashMovement.$inferSelect;
type StationRow = typeof station.$inferSelect;
type BranchRow = typeof branch.$inferSelect;

export interface CashActor {
  accountId: string;
  operatorId: string;
  requestId?: string;
}

// --- Reading the drawer ------------------------------------------------------------

/** The station and its branch, scoped to the caller's operator. A station elsewhere is not found. */
export async function loadCashStation(
  db: Exec,
  operatorId: string,
  stationId: string,
): Promise<{ station: StationRow; branch: BranchRow }> {
  const [row] = await db
    .select({ s: station, b: branch })
    .from(station)
    .innerJoin(branch, eq(branch.id, station.branchId))
    .where(and(eq(station.id, stationId), eq(station.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Station not found');
  return { station: row.s, branch: row.b };
}

/** A station whose routing says `cash: 'none'` has no drawer, so no session. */
export function stationHasDrawer(row: Pick<StationRow, 'paymentRouting'>): boolean {
  const routing = PaymentRoutingSchema.safeParse(row.paymentRouting ?? {});
  return !(routing.success && routing.data.cash === 'none');
}

/** The trading day an instant falls on at a branch, from its day start. */
export function branchBusinessDate(row: Pick<BranchRow, 'timezone' | 'businessDayStart'>, at: Date): string {
  return businessDate(at, row.timezone, parseDayStart(row.businessDayStart));
}

async function openSessionOf(db: Exec, stationId: string, lock = false): Promise<SessionRow | null> {
  const q = db
    .select()
    .from(cashSession)
    .where(and(eq(cashSession.stationId, stationId), eq(cashSession.status, 'open')))
    .limit(1);
  const [row] = lock ? await q.for('update') : await q;
  return row ?? null;
}

async function lastClosedOf(db: Exec, stationId: string): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(cashSession)
    .where(and(eq(cashSession.stationId, stationId), eq(cashSession.status, 'closed')))
    .orderBy(desc(cashSession.closedAt), desc(cashSession.id))
    .limit(1);
  return row ?? null;
}

/**
 * What a session opened now would start with: the drawer's last close's
 * float-left, else the branch's standard float — `getFloatCarryover`'s rule,
 * per drawer rather than per branch (OD-CS1).
 */
export async function carryOverOf(
  db: Exec,
  stationId: string,
  branchRow: Pick<BranchRow, 'cashDefaultFloatSatang'>,
): Promise<{ floatSatang: number; fromSessionId: string | null; fromDate: string | null }> {
  const last = await lastClosedOf(db, stationId);
  if (last && last.floatLeftSatang !== null) {
    return { floatSatang: last.floatLeftSatang, fromSessionId: last.id, fromDate: last.businessDate };
  }
  return { floatSatang: branchRow.cashDefaultFloatSatang, fromSessionId: null, fromDate: null };
}

/**
 * THE EXPECTED FIGURE, from the ledger. Attempts are read at the session's
 * station and branch, taken (approved or awaiting settlement), paid inside the
 * window — from the open to the close, or to now while open — and each one is
 * put through `countsAsTillTakings`, the one gate on what a drawer counts.
 */
export async function expectedCashPartsOf(db: Exec, row: SessionRow): Promise<CashExpectedParts> {
  const paidAt = sql`coalesce(${paymentAttempt.paidAt}, ${paymentAttempt.createdAt})`;
  const attempts = await db
    .select({
      method: paymentAttempt.method,
      methodCode: paymentAttempt.methodCode,
      stationId: paymentAttempt.stationId,
      amountSatang: paymentAttempt.amountSatang,
    })
    .from(paymentAttempt)
    .where(
      and(
        eq(paymentAttempt.branchId, row.branchId),
        eq(paymentAttempt.stationId, row.stationId),
        inArray(paymentAttempt.status, [...PAYMENT_ATTEMPT_TAKEN_STATUSES]),
        gte(paidAt, row.openedAt),
        ...(row.closedAt ? [lt(paidAt, row.closedAt)] : []),
      ),
    );
  const cashInSatang = attempts.filter((a) => countsAsTillTakings(a)).reduce((sum, a) => sum + a.amountSatang, 0);

  const sums = await db
    .select({ kind: cashMovement.kind, total: sql<string>`coalesce(sum(${cashMovement.amountSatang}), 0)` })
    .from(cashMovement)
    .where(eq(cashMovement.sessionId, row.id))
    .groupBy(cashMovement.kind);
  const of = (kind: CashMovementKind) => Number(sums.find((s) => s.kind === kind)?.total ?? 0);
  return {
    floatSatang: of('float'),
    cashInSatang,
    refundOutSatang: of('refund_out'),
    paidOutSatang: of('paid_out'),
    safeDropSatang: of('safe_drop'),
    topUpSatang: of('top_up'),
  };
}

/** expectedCash(session): the figure the count is held against. */
export async function expectedCash(db: Exec, row: SessionRow): Promise<number> {
  return expectedCashOf(await expectedCashPartsOf(db, row));
}

function movementViewOf(row: MovementRow, nameOf: (id: string) => string | null): CashMovementView {
  const person = (id: string | null) => (id ? { accountId: id, name: nameOf(id) } : null);
  return {
    id: row.id,
    kind: row.kind,
    amountSatang: row.amountSatang,
    reason: row.reason,
    actor: { accountId: row.actorAccountId, name: nameOf(row.actorAccountId) },
    approver: person(row.approverAccountId),
    witness: person(row.witnessAccountId),
    refundId: row.refundId,
    businessDate: row.businessDate,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function sessionViewOf(db: Exec, row: SessionRow): Promise<CashSessionView> {
  const movements = await db
    .select()
    .from(cashMovement)
    .where(eq(cashMovement.sessionId, row.id))
    .orderBy(asc(cashMovement.createdAt), asc(cashMovement.id));
  const [st] = await db.select({ name: station.name }).from(station).where(eq(station.id, row.stationId)).limit(1);
  const [br] = await db
    .select({ toleranceSatang: branch.cashToleranceSatang })
    .from(branch)
    .where(eq(branch.id, row.branchId))
    .limit(1);
  const [source] = row.floatSourceSessionId
    ? await db
        .select({ id: cashSession.id, businessDate: cashSession.businessDate })
        .from(cashSession)
        .where(eq(cashSession.id, row.floatSourceSessionId))
        .limit(1)
    : [];
  const nameOf = await accountNames(db, [
    row.openedByAccountId,
    ...(row.closedByAccountId ? [row.closedByAccountId] : []),
    ...(row.signedOffByAccountId ? [row.signedOffByAccountId] : []),
    ...movements.flatMap((m) => [m.actorAccountId, m.approverAccountId, m.witnessAccountId].filter((x): x is string => !!x)),
  ]);
  const parts = await expectedCashPartsOf(db, row);
  const expected: CashExpectedView = {
    ...parts,
    // A closed session answers with what its close froze, not a re-reading.
    expectedSatang: row.status === 'closed' && row.expectedSatang !== null ? row.expectedSatang : expectedCashOf(parts),
  };
  const person = (id: string | null) => (id ? { accountId: id, name: nameOf(id) } : null);
  return {
    id: row.id,
    branchId: row.branchId,
    stationId: row.stationId,
    stationName: st?.name ?? null,
    businessDate: row.businessDate,
    status: row.status,
    openedAt: row.openedAt.toISOString(),
    openedBy: { accountId: row.openedByAccountId, name: nameOf(row.openedByAccountId) },
    openingFloatSatang: row.openingFloatSatang,
    floatSource: source ? { sessionId: source.id, businessDate: source.businessDate } : null,
    floatSourceLabel: floatSourceLabel(source?.businessDate ?? null),
    expected,
    toleranceSatang: row.toleranceSatang ?? br?.toleranceSatang ?? 0,
    closedAt: row.closedAt?.toISOString() ?? null,
    closedBy: person(row.closedByAccountId),
    countedSatang: row.countedSatang,
    varianceSatang: row.varianceSatang,
    floatLeftSatang: row.floatLeftSatang,
    notes: row.notes,
    signedOffAt: row.signedOffAt?.toISOString() ?? null,
    signedOffBy: person(row.signedOffByAccountId),
    movements: movements.map((m) => movementViewOf(m, nameOf)),
  };
}

/**
 * The till's Cash action reads this: the station's drawer, its open session
 * (or none), its latest close, and what a session opened now would start with.
 * With `date`, the session shown is the latest one opened on that business
 * date (the End of Day screen's day), else the open one.
 */
export async function drawerViewOf(
  db: Exec,
  operatorId: string,
  stationId: string,
  date?: string,
): Promise<CashDrawerView> {
  const { station: st, branch: br } = await loadCashStation(db, operatorId, stationId);
  let session: SessionRow | null = await openSessionOf(db, stationId);
  if (date && session?.businessDate !== date) {
    const [onDate] = await db
      .select()
      .from(cashSession)
      .where(and(eq(cashSession.stationId, stationId), eq(cashSession.businessDate, date)))
      .orderBy(desc(cashSession.openedAt), desc(cashSession.id))
      .limit(1);
    session = onDate ?? null;
  }
  const last = await lastClosedOf(db, stationId);
  const carry = await carryOverOf(db, stationId, br);
  return {
    station: { id: st.id, name: st.name, branchId: st.branchId, hasDrawer: stationHasDrawer(st) },
    session: session ? await sessionViewOf(db, session) : null,
    lastClosed: last ? await sessionViewOf(db, last) : null,
    carryOver: { ...carry, label: floatSourceLabel(carry.fromDate) },
    settings: { defaultFloatSatang: br.cashDefaultFloatSatang, toleranceSatang: br.cashToleranceSatang },
  };
}

/** A session by id, scoped to the operator; the branch is checked by the caller. */
export async function loadCashSession(db: Exec, operatorId: string, sessionId: string): Promise<SessionRow> {
  const [row] = await db
    .select()
    .from(cashSession)
    .where(and(eq(cashSession.id, sessionId), eq(cashSession.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Cash session not found');
  return row;
}

// --- Opening -----------------------------------------------------------------------

export async function openSession(
  tx: Tx,
  actor: CashActor,
  stationId: string,
  input: { id?: string | null; actionId?: string | null },
  now: Date = new Date(),
): Promise<{ replayed: boolean; session: CashSessionView }> {
  // The station row is the lock two tills racing to open one drawer meet on.
  const [locked] = await tx
    .select()
    .from(station)
    .where(and(eq(station.id, stationId), eq(station.operatorId, actor.operatorId)))
    .for('update')
    .limit(1);
  if (!locked) throw errors.notFound('Station not found');
  const { branch: br } = await loadCashStation(tx, actor.operatorId, stationId);

  if (input.actionId) {
    const [already] = await tx
      .select()
      .from(cashSession)
      .where(and(eq(cashSession.operatorId, actor.operatorId), eq(cashSession.openActionId, input.actionId)))
      .limit(1);
    if (already) {
      if (already.stationId !== stationId) {
        throw errors.conflict('ACTION_ID_REUSED', 'That action id already opened another drawer');
      }
      return { replayed: true, session: await sessionViewOf(tx, already) };
    }
  }
  if (locked.archivedAt) throw errors.conflict('STATION_ARCHIVED', 'This counter has been taken off the floor');
  if (!stationHasDrawer(locked)) {
    throw errors.conflict('CASH_NO_DRAWER', 'This counter has no cash drawer, so there is nothing to open');
  }
  const open = await openSessionOf(tx, stationId, true);
  if (open) {
    throw errors.conflict(
      'CASH_SESSION_ALREADY_OPEN',
      'This drawer is already open — count it and close it before opening it again',
      { sessionId: open.id },
    );
  }

  const carry = await carryOverOf(tx, stationId, br);
  const date = branchBusinessDate(br, now);
  // Client-namable (CLAUDE.md §3, offline): the till may mint the session's id.
  const id = input.id ?? newId();
  const [row] = await tx
    .insert(cashSession)
    .values({
      id,
      operatorId: actor.operatorId,
      branchId: br.id,
      stationId,
      businessDate: date,
      status: 'open',
      openedByAccountId: actor.accountId,
      openedAt: now,
      openingFloatSatang: carry.floatSatang,
      floatSourceSessionId: carry.fromSessionId,
      openActionId: input.actionId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('the cash session was not written');
  await tx.insert(cashMovement).values({
    id: newId(),
    operatorId: actor.operatorId,
    branchId: br.id,
    sessionId: id,
    stationId,
    kind: 'float',
    amountSatang: carry.floatSatang,
    reason: floatSourceLabel(carry.fromDate),
    actorAccountId: actor.accountId,
    businessDate: date,
    actionId: `cash:open:${id}`,
    createdAt: now,
    updatedAt: now,
  });
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: br.id,
    action: 'cash_session.open',
    entityType: 'cash_session',
    entityId: id,
    actionId: input.actionId ?? null,
    requestId: actor.requestId,
    before: null,
    after: {
      stationId,
      businessDate: date,
      openingFloatSatang: carry.floatSatang,
      floatSourceSessionId: carry.fromSessionId,
    },
  });
  return { replayed: false, session: await sessionViewOf(tx, row) };
}

// --- The second person -----------------------------------------------------------

/** A precomputed hash, so a phone that names nobody costs the same as a wrong password. */
let dummyHash: Promise<string> | null = null;
const equalize = async (password: string): Promise<void> => {
  dummyHash ??= hash('oto-cash-second-person-never-matches');
  await verify(await dummyHash, password).catch(() => false);
};

/**
 * WHO IS STANDING THERE: the approver of a paid-out or the witness of a safe
 * drop types their own phone and password on the till. Throttled per phone
 * like a sign-in; a refusal is 403, never 401 — the till's own session is fine
 * and must not be sent to the lock screen. Runs on the pool, before the
 * movement's transaction: a failure counter must survive the refusal.
 */
export async function verifySecondPerson(
  db: Db,
  operatorId: string,
  who: CashSecondPerson,
  limits: { maxFailures: number; cooldownSeconds: number },
): Promise<string> {
  const phone = normalizePhone(who.phone);
  const refused = () =>
    new AppError(403, 'CASH_SECOND_PERSON_REFUSED', 'That phone number and password do not match a member of staff');
  if (!phone) {
    await equalize(who.password);
    throw refused();
  }
  const keys = [`cash-second:${phone}`];
  await throttleCheck(db, keys);
  const [acc] = await db
    .select({ id: account.id, passwordHash: account.passwordHash, status: account.status })
    .from(account)
    .where(and(eq(account.phone, phone), eq(account.operatorId, operatorId)))
    .limit(1);
  const ok = acc?.passwordHash ? await verify(acc.passwordHash, who.password).catch(() => false) : false;
  if (!acc?.passwordHash) await equalize(who.password);
  if (!acc || !ok || acc.status !== 'active') {
    await throttleFail(db, keys, limits.maxFailures, limits.cooldownSeconds);
    throw refused();
  }
  await throttleClear(db, keys);
  return acc.id;
}

async function assertSecondPerson(
  tx: Tx,
  input: {
    role: 'approver' | 'witness';
    accountId: string;
    actorAccountId: string;
    operatorId: string;
    branchId: string;
  },
): Promise<void> {
  if (input.accountId === input.actorAccountId) {
    throw new AppError(
      403,
      input.role === 'approver' ? 'CASH_APPROVER_IS_ACTOR' : 'CASH_WITNESS_IS_ACTOR',
      input.role === 'approver'
        ? 'A paid-out needs a second person to approve it — not you'
        : 'A safe drop needs a second person to witness it — not you',
    );
  }
  const [acc] = await tx
    .select({ id: account.id, operatorId: account.operatorId, status: account.status })
    .from(account)
    .where(eq(account.id, input.accountId))
    .limit(1);
  const effective = acc && acc.operatorId === input.operatorId && acc.status === 'active'
    ? await resolveEffectivePermissions(tx, acc.id)
    : [];
  const target = { operatorId: input.operatorId, branchId: input.branchId };
  /**
   * One right for both roles: `pos:cash:approve` is "countersign a paid-out, a
   * safe drop or a close variance" (packages/shared/src/permissions.ts). A
   * witness who only needed `pos:cash:movement` let two receptionists witness
   * each other's drop — no countersignature at all.
   */
  const needs: Permission = 'pos:cash:approve';
  if (!hasPermission(effective, needs, target)) {
    throw new AppError(
      403,
      input.role === 'approver' ? 'CASH_APPROVER_NOT_ALLOWED' : 'CASH_WITNESS_NOT_ALLOWED',
      input.role === 'approver'
        ? 'That person cannot approve a paid-out at this park — ask a manager'
        : 'That person cannot witness a safe drop at this park',
    );
  }
}

// --- Movements ---------------------------------------------------------------------

export interface RecordMovementInput {
  kind: CashManualMovementKind;
  amountSatang: number;
  reason: string;
  approverAccountId?: string | null;
  witnessAccountId?: string | null;
  actionId?: string | null;
}

export async function recordMovement(
  tx: Tx,
  actor: CashActor,
  sessionId: string,
  input: RecordMovementInput,
  now: Date = new Date(),
): Promise<{ replayed: boolean; movement: CashMovementView; session: CashSessionView }> {
  const [row] = await tx
    .select()
    .from(cashSession)
    .where(and(eq(cashSession.id, sessionId), eq(cashSession.operatorId, actor.operatorId)))
    .for('update')
    .limit(1);
  if (!row) throw errors.notFound('Cash session not found');
  const actionId = input.actionId ?? newId();

  const [already] = await tx
    .select()
    .from(cashMovement)
    .where(and(eq(cashMovement.operatorId, actor.operatorId), eq(cashMovement.actionId, actionId)))
    .limit(1);
  if (already) {
    if (already.sessionId !== sessionId || already.kind !== input.kind) {
      throw errors.conflict('ACTION_ID_REUSED', 'That action id already recorded another cash movement');
    }
    // Same key, same body is the till retrying; same key, a different body is
    // a second, different movement wearing the first one's key — refused.
    const differs =
      already.amountSatang !== input.amountSatang ||
      already.reason !== input.reason.trim() ||
      (input.approverAccountId != null && already.approverAccountId !== input.approverAccountId) ||
      (input.witnessAccountId != null && already.witnessAccountId !== input.witnessAccountId);
    if (differs) {
      throw errors.conflict(
        'ACTION_ID_REUSED',
        `That ${CASH_MOVEMENT_LABELS[input.kind].toLowerCase()} was already recorded as ${formatTHB(already.amountSatang)} for “${already.reason}” — start a new one to record something different`,
        { actionId, amountSatang: already.amountSatang },
      );
    }
    const nameOf = await accountNames(tx, [already.actorAccountId, already.approverAccountId, already.witnessAccountId].filter((x): x is string => !!x));
    return { replayed: true, movement: movementViewOf(already, nameOf), session: await sessionViewOf(tx, row) };
  }

  if (row.status !== 'open') {
    throw errors.conflict('CASH_SESSION_CLOSED', 'This drawer is closed — open it before moving cash in or out');
  }
  const reason = input.reason.trim();
  if (!reason) throw errors.badRequest('Say what the cash is for');
  if (!Number.isInteger(input.amountSatang) || input.amountSatang <= 0) {
    throw errors.badRequest('Enter an amount above ฿0');
  }

  let approverAccountId: string | null = null;
  let witnessAccountId: string | null = null;
  if (input.kind === 'paid_out') {
    if (!input.approverAccountId) {
      throw new AppError(403, 'CASH_APPROVAL_REQUIRED', 'A paid-out needs a manager to approve it');
    }
    await assertSecondPerson(tx, { role: 'approver', accountId: input.approverAccountId, actorAccountId: actor.accountId, operatorId: actor.operatorId, branchId: row.branchId });
    approverAccountId = input.approverAccountId;
  }
  if (input.kind === 'safe_drop') {
    if (!input.witnessAccountId) {
      throw new AppError(403, 'CASH_WITNESS_REQUIRED', 'A safe drop needs a witness');
    }
    await assertSecondPerson(tx, { role: 'witness', accountId: input.witnessAccountId, actorAccountId: actor.accountId, operatorId: actor.operatorId, branchId: row.branchId });
    witnessAccountId = input.witnessAccountId;
  }
  if (input.kind === 'paid_out' || input.kind === 'safe_drop') {
    const holds = await expectedCash(tx, row);
    if (input.amountSatang > holds) {
      throw errors.conflict(
        'CASH_DRAWER_SHORT',
        `The drawer should only hold ${formatTHB(holds)} — you cannot take out ${formatTHB(input.amountSatang)}`,
        { expectedSatang: holds },
      );
    }
  }

  const [br] = await tx.select().from(branch).where(eq(branch.id, row.branchId)).limit(1);
  if (!br) throw new Error('the session’s branch is missing');
  const [written] = await tx
    .insert(cashMovement)
    .values({
      id: newId(),
      operatorId: actor.operatorId,
      branchId: row.branchId,
      sessionId,
      stationId: row.stationId,
      kind: input.kind,
      amountSatang: input.amountSatang,
      reason,
      actorAccountId: actor.accountId,
      approverAccountId,
      witnessAccountId,
      businessDate: branchBusinessDate(br, now),
      actionId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!written) throw new Error('the cash movement was not written');
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: row.branchId,
    action: `cash_movement.${input.kind}`,
    entityType: 'cash_movement',
    entityId: written.id,
    actionId,
    requestId: actor.requestId,
    before: null,
    after: {
      sessionId,
      stationId: row.stationId,
      kind: input.kind,
      amountSatang: input.amountSatang,
      reason,
      approverAccountId,
      witnessAccountId,
      businessDate: written.businessDate,
    },
  });
  const nameOf = await accountNames(tx, [actor.accountId, approverAccountId, witnessAccountId].filter((x): x is string => !!x));
  return { replayed: false, movement: movementViewOf(written, nameOf), session: await sessionViewOf(tx, row) };
}

// --- Closing -----------------------------------------------------------------------

export interface CloseSessionInput {
  countedSatang: number;
  floatLeftSatang?: number | null;
  note?: string | null;
  actionId?: string | null;
}

export async function closeSession(
  tx: Tx,
  actor: CashActor,
  sessionId: string,
  input: CloseSessionInput,
  now: Date = new Date(),
): Promise<{ replayed: boolean; session: CashSessionView }> {
  const [row] = await tx
    .select()
    .from(cashSession)
    .where(and(eq(cashSession.id, sessionId), eq(cashSession.operatorId, actor.operatorId)))
    .for('update')
    .limit(1);
  if (!row) throw errors.notFound('Cash session not found');
  if (input.actionId && row.closeActionId === input.actionId) {
    return { replayed: true, session: await sessionViewOf(tx, row) };
  }
  if (row.status !== 'open') {
    throw errors.conflict('CASH_SESSION_CLOSED', 'This drawer was already counted and closed');
  }
  if (!Number.isInteger(input.countedSatang) || input.countedSatang < 0) {
    throw errors.badRequest('Enter the cash you counted');
  }
  const [br] = await tx.select().from(branch).where(eq(branch.id, row.branchId)).limit(1);
  if (!br) throw new Error('the session’s branch is missing');

  // The expected figure, read up to the moment of the close and frozen there.
  const parts = await expectedCashPartsOf(tx, { ...row, closedAt: now });
  const expectedSatang = expectedCashOf(parts);
  const varianceSatang = input.countedSatang - expectedSatang;
  const toleranceSatang = br.cashToleranceSatang;
  const note = input.note?.trim() || null;
  if (Math.abs(varianceSatang) > toleranceSatang && !note) {
    throw new AppError(
      400,
      'CASH_VARIANCE_NOTE_REQUIRED',
      `The count is ${formatTHB(Math.abs(varianceSatang))} ${varianceSatang > 0 ? 'over' : 'short'} — add a note saying why before closing`,
      { expectedSatang, varianceSatang, toleranceSatang },
    );
  }
  const floatLeftSatang = input.floatLeftSatang ?? Math.min(br.cashDefaultFloatSatang, input.countedSatang);
  if (floatLeftSatang > input.countedSatang) {
    throw errors.badRequest(
      `You counted ${formatTHB(input.countedSatang)} — you cannot leave ${formatTHB(floatLeftSatang)} in the drawer`,
    );
  }

  const [closed] = await tx
    .update(cashSession)
    .set({
      status: 'closed',
      closedByAccountId: actor.accountId,
      closedAt: now,
      countedSatang: input.countedSatang,
      expectedSatang,
      varianceSatang,
      toleranceSatang,
      floatLeftSatang,
      notes: note,
      signedOffByAccountId: actor.accountId,
      signedOffAt: now,
      closeActionId: input.actionId ?? null,
      updatedAt: now,
    })
    .where(eq(cashSession.id, row.id))
    .returning();
  if (!closed) throw new Error('the cash session was not closed');
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: row.branchId,
    action: 'cash_session.close',
    entityType: 'cash_session',
    entityId: row.id,
    actionId: input.actionId ?? null,
    requestId: actor.requestId,
    before: { status: row.status, openingFloatSatang: row.openingFloatSatang },
    after: {
      status: 'closed',
      ...parts,
      expectedSatang,
      countedSatang: input.countedSatang,
      varianceSatang,
      toleranceSatang,
      floatLeftSatang,
      notes: note,
      signedOffByAccountId: actor.accountId,
    },
  });
  return { replayed: false, session: await sessionViewOf(tx, closed) };
}

// --- Refunds handed back in cash -------------------------------------------------------

/** The slices of a refund that left a drawer in cash: the cash route, settled. */
export function cashSlicesOf(slices: readonly RefundAllocationEntry[]): RefundAllocationEntry[] {
  return slices.filter((s) => s.route === 'cash' && s.status === 'done' && s.amountSatang > 0);
}

/** The refusal a cash refund meets at a counter whose drawer is not open, in the counter's words. */
export const cashSessionNotOpen = () =>
  errors.conflict(
    'CASH_SESSION_NOT_OPEN',
    'Open the cash drawer at this counter before handing a refund back in cash',
  );

/**
 * THE MONEY LEAVES THE DRAWER: one `refund_out` movement per cash slice, on
 * the open session of the drawer the refund was made at (`refund.station_id`),
 * keyed `refund:<refundId>:<n>` so a replay writes nothing twice. With no open
 * session, `strict` refuses (the refund itself, in the same transaction, is
 * not written); otherwise nothing is written and null comes back, for the
 * caller to record against the day (round 2's correction).
 */
export async function recordRefundOut(
  tx: Tx,
  input: {
    operatorId: string;
    branchId: string;
    stationId: string;
    refundId: string;
    slices: readonly RefundAllocationEntry[];
    /** Distinguishes a later fallback's movement from the refund's own. */
    keySuffix?: string;
    businessDate: string;
    actorAccountId: string;
    requestId?: string;
    now: Date;
    strict: boolean;
  },
): Promise<MovementRow[] | null> {
  const cash = cashSlicesOf(input.slices);
  if (cash.length === 0) return [];
  const open = await openSessionOf(tx, input.stationId, true);
  if (!open || open.branchId !== input.branchId) {
    if (input.strict) throw cashSessionNotOpen();
    return null;
  }
  const written: MovementRow[] = [];
  for (const [n, slice] of cash.entries()) {
    const actionId = `refund:${input.refundId}:${input.keySuffix ?? n}`;
    const [row] = await tx
      .insert(cashMovement)
      .values({
        id: newId(),
        operatorId: input.operatorId,
        branchId: input.branchId,
        sessionId: open.id,
        stationId: input.stationId,
        kind: 'refund_out',
        amountSatang: slice.amountSatang,
        reason: slice.detail ?? 'Refund handed back in cash',
        actorAccountId: input.actorAccountId,
        refundId: input.refundId,
        businessDate: input.businessDate,
        actionId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: [cashMovement.operatorId, cashMovement.actionId] })
      .returning();
    if (!row) continue;
    written.push(row);
    await audit.record(tx, {
      actorAccountId: input.actorAccountId,
      operatorId: input.operatorId,
      branchId: input.branchId,
      action: 'cash_movement.refund_out',
      entityType: 'cash_movement',
      entityId: row.id,
      actionId,
      requestId: input.requestId,
      before: null,
      after: {
        sessionId: open.id,
        stationId: input.stationId,
        refundId: input.refundId,
        attemptId: slice.attemptId,
        amountSatang: slice.amountSatang,
        businessDate: input.businessDate,
      },
    });
  }
  return written;
}
