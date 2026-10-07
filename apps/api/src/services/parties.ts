import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { branch, partyCharge, partyEdit, partyPayment, station, type Db } from '@oto/db';
import {
  PARTY_EDITABLE_FIELDS,
  PARTY_PATCH_ENVELOPE,
  businessDate,
  normalizePhone,
  parseDayStart,
  type EventDetailAnswer,
  type EventView,
  type PartyChargeBody,
  type PartyEditFields,
  type PartyPatchBody,
  type PartyPaymentBody,
  type PartyWriteAnswer,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import type { BranchReach } from './access-control';
import { audit } from './audit';
import { eventById } from './events';
import { linksOfEvents } from './event-writes';
import { recordRun } from './ops';
import { OtoAppSeamNotGrantedError, getBranchEvent, type SeamEvent } from './otoapp-events';
import {
  DIRECTORY_NOT_CONFIGURED,
  type DirectoryEventEditAnswer,
  type DirectoryEventEditFields,
  type DirectoryOutcome,
  type OtoAppDirectory,
} from './otoapp-directory';
import {
  billOfParty,
  editStillShown,
  lockParty,
  overlayPartyEdits,
  partyFieldsOf,
  partyLedgersOf,
} from './party-tab';
import { openAttempt, settleAttempt, tenderMethodOf } from './payments/attempt';
import { resolveDrawerKick, type DrawerKick } from './payments/drawer';
import type { ActorContext } from './sale';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * S2-20 E4 — THE PARTY TAB (SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md §3, §4, §8, §10, the E4 row of §9
 * and Q3's default).
 *
 * The ports of the prototype's three party mutators (mockApi.ts 3874-3966):
 *
 *   - `updateParty` → `PATCH /parties/:id`. The till edits the party's own
 *     fields; its identity, its branch and the two POS ledgers are protected
 *     and never change through an edit (H12). The edit is the OTO App's to
 *     keep (C10), so it is recorded here (`pos.party_edit`), committed, and
 *     then written back through the app's directory API under the edit's own
 *     id — an `ops_run` of kind `integration` named `otoapp:party.update`,
 *     retried from the Failures page like a child's write-back (E2);
 *   - `addPartyExtraCharge` → `POST /parties/:id/charges`. A ledger entry and
 *     nothing more (Q3): no sale, no kitchen ticket, no stock, no bands. Its
 *     total is never negative;
 *   - `addPartyPayment` → `POST /parties/:id/payments`. Real money, recorded
 *     through the tender machine (`openAttempt` then `settleAttempt`, the
 *     path every tender takes) with no sale behind it — it is not a sale of
 *     goods (Q3). Whole baht, capped at the outstanding balance and refused
 *     at ฿0; the cap is worked out inside the transaction under the party's
 *     lock, so two tills cannot both take the last of a balance (H11). End of
 *     Day counts it on its own `party_prepay` line, on the day it is taken,
 *     for that day's party, and never on the cash, card or QR line (H10).
 *
 * Every write is keyed by the id the till minted (the charge's, the payment's,
 * the edit's): the same id again answers what it made, and writes nothing.
 * The party is read through the seam (`otoapp-events.ts`) and nothing else:
 * this file names no OTO App table and no view (H1).
 */

/** The ops run every party write-back is recorded under — the Failures page's name for it. */
export const PARTY_UPDATE_RUN = 'otoapp:party.update';

/** What the routes hand the services. */
export interface PartyDeps {
  db: Db;
  directory: OtoAppDirectory;
  log?: FastifyBaseLogger;
}

interface BranchClock {
  id: string;
  timezone: string;
  dayStartMinutes: number;
}

async function branchClockOf(db: Exec, operatorId: string, branchId: string): Promise<BranchClock> {
  const [row] = await db
    .select({ id: branch.id, timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Branch not found');
  return { id: row.id, timezone: row.timezone, dayStartMinutes: parseDayStart(row.dayStart) };
}

/** The seam installed but not granted: a fault to say, as the read routes say it. */
async function seamRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof OtoAppSeamNotGrantedError) {
      throw new AppError(503, 'EVENTS_SEAM_NOT_GRANTED', err.message, { missing: err.missing });
    }
    throw err;
  }
}

const partyNotFound = () => errors.notFound('Party not found');

/** The branch's party, from the seam; 404 for anything that is not one of its parties. */
async function partyOf(db: Exec, branchId: string, partyId: string): Promise<SeamEvent> {
  const event = await seamRead(() => getBranchEvent(db, { branchId, eventId: partyId }));
  if (!event || event.type !== 'party') throw partyNotFound();
  return event;
}

/** Where it was done — checked inside the caller's operator and at this branch. */
async function stationAt(db: Exec, operatorId: string, branchId: string, stationId: string | undefined) {
  if (!stationId) return null;
  const [row] = await db
    .select()
    .from(station)
    .where(and(eq(station.id, stationId), eq(station.operatorId, operatorId)))
    .limit(1);
  if (!row || row.archivedAt) throw errors.notFound('Station not found');
  if (row.branchId !== branchId) throw errors.badRequest('That station belongs to another branch');
  return row;
}

/**
 * The party as the till sees it, with its bill — read inside a write's
 * transaction, after the party's lock, so what the cap is measured against is
 * what was committed before this write and nothing can land in between.
 */
async function liveBill(tx: Exec, branchId: string, partyId: string) {
  const event = await partyOf(tx, branchId, partyId);
  const ledgers = (await partyLedgersOf(tx, { branchId, eventIds: [event.id] })).get(event.id)!;
  const party = overlayPartyEdits(event, ledgers.edits);
  const walkUps = (await linksOfEvents(tx, { branchId, eventIds: [event.id] }))
    .filter((l) => l.billing === 'party_tab')
    .reduce((sum, l) => sum + l.priceSnapshotSatang, 0);
  return { party, ledgers, bill: billOfParty(party, walkUps, ledgers) };
}

/** `GET /parties/:id` — the party with its bill, its ledgers and the till's edit stamp. */
export async function getParty(
  db: Exec,
  q: { operatorId: string; branchId: string; partyId: string; date?: string; now: Date },
): Promise<EventDetailAnswer> {
  const answer = await eventById(db, {
    operatorId: q.operatorId,
    branchId: q.branchId,
    eventId: q.partyId,
    date: q.date,
    now: q.now,
  }).catch((err: unknown) => {
    // The events read says "Event not found"; at this address it is a party.
    if (err instanceof AppError && err.statusCode === 404 && err.message === 'Event not found') throw partyNotFound();
    throw err;
  });
  if (answer.event.type !== 'party') throw partyNotFound();
  return answer;
}

async function partyNow(db: Exec, actor: ActorContext, branchId: string, partyId: string): Promise<EventView> {
  return (await getParty(db, { operatorId: actor.operatorId, branchId, partyId, now: new Date() })).event;
}

// --- Charges ---------------------------------------------------------------------

/**
 * `POST /parties/:id/charges` — `addPartyExtraCharge`: extra tickets or F&B on
 * the party's tab. A ledger entry: nothing is sold, printed for the kitchen,
 * taken from stock or banded. The total is clamped at ฿0, never negative.
 */
export async function chargeParty(
  deps: PartyDeps,
  ctx: OpContext,
  actor: ActorContext,
  partyId: string,
  body: PartyChargeBody,
  now: Date = new Date(),
): Promise<PartyWriteAnswer> {
  const db = deps.db;
  const clock = await branchClockOf(db, actor.operatorId, body.branchId);
  await actor.assertBranchAllowed?.(clock.id);
  const event = await partyOf(db, clock.id, partyId);

  const replay = async (row: typeof partyCharge.$inferSelect): Promise<PartyWriteAnswer> => {
    if (row.operatorId !== actor.operatorId || row.otoappEventId !== event.id) {
      throw errors.conflict('CHARGE_ID_IN_USE', 'That charge id already belongs to another charge', { chargeId: row.id });
    }
    await actor.assertBranchAllowed?.(row.branchId);
    const party = await partyNow(db, actor, row.branchId, event.id);
    const charge = party.party?.charges?.find((c) => c.id === row.id);
    return { replayed: true, party, ...(charge ? { charge } : {}) };
  };

  const [prior] = await db.select().from(partyCharge).where(eq(partyCharge.id, body.chargeId)).limit(1);
  if (prior) return replay(prior);
  if (event.archived) throw errors.conflict('EVENT_ARCHIVED', 'This party has been archived in the OTO App');
  const at = await stationAt(db, actor.operatorId, clock.id, body.stationId);
  const total = Math.max(0, body.totalSatang);
  const actionId = body.actionId ?? null;

  const done: { raced: typeof partyCharge.$inferSelect | null } = { raced: null };
  await withTx(db, ctx, 'party.charge', async (tx) => {
    await lockParty(tx, event.id);
    const [again] = await tx.select().from(partyCharge).where(eq(partyCharge.id, body.chargeId)).limit(1);
    if (again) {
      done.raced = again;
      return undefined;
    }
    await tx.insert(partyCharge).values({
      id: body.chargeId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      otoappEventId: event.id,
      kind: body.kind,
      items: body.items,
      totalSatang: total,
      accountId: actor.accountId,
      stationId: at?.id ?? null,
      boxId: at?.boxId ?? null,
      actionId,
      chargedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      action: 'party.charge',
      entityType: 'party_charge',
      entityId: body.chargeId,
      actionId,
      requestId: actor.requestId,
      // The station and box ride in the row's detail (plan §10): the audit
      // table has no column for either.
      after: {
        eventId: event.id,
        kind: body.kind,
        totalSatang: total,
        ...(total !== body.totalSatang ? { requestedTotalSatang: body.totalSatang } : {}),
        items: body.items.length,
        stationId: at?.id ?? null,
        boxId: at?.boxId ?? null,
      },
    });
    return undefined;
  });
  if (done.raced) return replay(done.raced);

  const party = await partyNow(db, actor, clock.id, event.id);
  const charge = party.party?.charges?.find((c) => c.id === body.chargeId);
  return { replayed: false, party, ...(charge ? { charge } : {}) };
}

// --- Payments --------------------------------------------------------------------

export interface PartyPaymentResult {
  answer: PartyWriteAnswer;
  /** The drawer a cash payment opens, once it has committed. */
  drawerKick: DrawerKick | null;
}

/**
 * `POST /parties/:id/payments` — `addPartyPayment`: money against the party's
 * balance, through the tender machine.
 *
 * The prototype's rules, kept: whole baht (the amount is floored), capped at
 * what is outstanding, refused when that leaves ฿0, any configured tender. The
 * cap is measured inside the transaction, under the party's lock, against the
 * party as committed (H11). A till that says what balance it showed
 * (`expectedOutstandingSatang`) and finds it moved is refused with nothing
 * taken, rather than recording less than it collected.
 *
 * The money is a `pos.payment_attempt` opened and settled as the counter's
 * tender always is, with no sale — so it is in the trading day's money, the
 * card terminal's batch reconciliation and the drawer, but in no sale, no
 * receipt and no VAT line (Q3). Its trading day is the branch's business day
 * when it is taken; the party's day is kept beside it for End of Day.
 */
export async function payParty(
  deps: PartyDeps,
  ctx: OpContext,
  actor: ActorContext,
  partyId: string,
  body: PartyPaymentBody,
  now: Date = new Date(),
): Promise<PartyPaymentResult> {
  const db = deps.db;
  const clock = await branchClockOf(db, actor.operatorId, body.branchId);
  await actor.assertBranchAllowed?.(clock.id);
  const event = await partyOf(db, clock.id, partyId);

  const replay = async (row: typeof partyPayment.$inferSelect): Promise<PartyPaymentResult> => {
    if (row.operatorId !== actor.operatorId || row.otoappEventId !== event.id) {
      throw errors.conflict('PAYMENT_ID_IN_USE', 'That payment id already belongs to another payment', {
        paymentId: row.id,
      });
    }
    await actor.assertBranchAllowed?.(row.branchId);
    const party = await partyNow(db, actor, row.branchId, event.id);
    const payment = party.party?.payments?.find((p) => p.id === row.id);
    // The drawer opened on the first answer; a retry must not open it again.
    return { answer: { replayed: true, party, ...(payment ? { payment } : {}) }, drawerKick: null };
  };

  const [prior] = await db.select().from(partyPayment).where(eq(partyPayment.id, body.paymentId)).limit(1);
  if (prior) return replay(prior);
  if (event.archived) throw errors.conflict('EVENT_ARCHIVED', 'This party has been archived in the OTO App');
  const counter = await stationAt(db, actor.operatorId, clock.id, body.stationId);
  if (!counter) throw errors.badRequest('A payment is taken at a counter: name the station');
  const tradingDay = businessDate(now, clock.timezone, clock.dayStartMinutes);
  const actionId = body.actionId ?? null;

  const done: { raced: typeof partyPayment.$inferSelect | null; drawerKick: DrawerKick | null } = {
    raced: null,
    drawerKick: null,
  };
  await withTx(db, ctx, 'party.payment', async (tx) => {
    await lockParty(tx, event.id);
    const [again] = await tx.select().from(partyPayment).where(eq(partyPayment.id, body.paymentId)).limit(1);
    if (again) {
      done.raced = again;
      return undefined;
    }

    const { party, bill } = await liveBill(tx, clock.id, event.id);
    if (body.expectedOutstandingSatang !== undefined && body.expectedOutstandingSatang !== bill.outstandingSatang) {
      throw errors.conflict(
        'PARTY_BALANCE_CHANGED',
        `The balance changed to ฿${(bill.outstandingSatang / 100).toLocaleString('en-US')} since it was shown — nothing was taken. Check the bill and take the payment again.`,
        { outstandingSatang: bill.outstandingSatang },
      );
    }
    // `Math.min(Math.floor(amount), outstanding)` (addPartyPayment), in satang.
    const requested = body.amountSatang - (body.amountSatang % 100);
    const amount = Math.min(requested, bill.outstandingSatang);
    if (amount <= 0) {
      throw bill.outstandingSatang <= 0
        ? errors.conflict('PARTY_NOTHING_OWED', 'This party is fully paid — nothing was taken', {
            outstandingSatang: bill.outstandingSatang,
          })
        : errors.badRequest('A party payment is whole baht, at least ฿1', { amountSatang: body.amountSatang });
    }

    const tender = body.tender;
    const method = await tenderMethodOf(tx, actor.operatorId, tender.method, tender.kind);
    let changeSatang: number | null = null;
    if (tender.tenderedSatang !== undefined) {
      if (method !== 'cash') throw errors.badRequest('Only cash is handed over: send what was tendered with a cash payment only');
      if (tender.tenderedSatang < amount) {
        throw errors.badRequest('The cash taken is less than the amount being paid, so this would leave negative change', {
          amountSatang: amount,
          tenderedSatang: tender.tenderedSatang,
        });
      }
      changeSatang = tender.tenderedSatang - amount;
    }

    // The tender machine's own two steps, as a counter's tender always takes
    // them: opened, then settled — money taken at the counter is paid as it is
    // recorded. Keyed by the payment's id, so it cannot be written twice.
    const opened = await openAttempt(tx, {
      saleId: null,
      operatorId: actor.operatorId,
      branchId: clock.id,
      stationId: counter.id,
      businessDate: tradingDay,
      method,
      methodCode: tender.method,
      amountSatang: amount,
      ...(tender.tenderedSatang === undefined ? {} : { tenderedSatang: tender.tenderedSatang, changeSatang }),
      actionId: `party-payment:${body.paymentId}`,
      payload: {
        partyPayment: true,
        partyEventId: event.id,
        partyPaymentId: body.paymentId,
        ...(tender.kind ? { kind: tender.kind } : {}),
        ...(tender.reference ? { reference: tender.reference } : {}),
        takenByAccountId: actor.accountId,
        ...(actionId ? { actionId } : {}),
      },
    });
    await settleAttempt(tx, opened.id, { paidAt: now });
    await tx.insert(partyPayment).values({
      id: body.paymentId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      otoappEventId: event.id,
      paymentAttemptId: opened.id,
      partyDate: party.startDate,
      accountId: actor.accountId,
      stationId: counter.id,
      boxId: counter.boxId,
      actionId,
      createdAt: now,
      updatedAt: now,
    });
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      action: 'party.payment',
      entityType: 'party_payment',
      entityId: body.paymentId,
      actionId,
      requestId: actor.requestId,
      before: { outstandingSatang: bill.outstandingSatang },
      after: {
        eventId: event.id,
        amountSatang: amount,
        ...(amount !== body.amountSatang ? { requestedSatang: body.amountSatang } : {}),
        method: tender.method,
        kind: method,
        attemptId: opened.id,
        businessDate: tradingDay,
        partyDate: party.startDate,
        outstandingSatang: bill.outstandingSatang - amount,
        ...(tender.tenderedSatang === undefined ? {} : { tenderedSatang: tender.tenderedSatang, changeSatang }),
        stationId: counter.id,
        boxId: counter.boxId,
      },
    });
    // Cash in the till opens the till (S2-10a O-4), once the money has committed.
    if (method === 'cash') {
      done.drawerKick = await resolveDrawerKick(tx, {
        stationRow: counter,
        saleId: null,
        attemptId: opened.id,
        actionId,
      });
    }
    return undefined;
  });
  if (done.raced) return replay(done.raced);

  const party = await partyNow(db, actor, clock.id, event.id);
  const payment = party.party?.payments?.find((p) => p.id === body.paymentId);
  return { answer: { replayed: false, party, ...(payment ? { payment } : {}) }, drawerKick: done.drawerKick };
}

// --- Edits -----------------------------------------------------------------------

type EditRow = typeof partyEdit.$inferSelect;

const ENVELOPE = new Set<string>(PARTY_PATCH_ENVELOPE);
const EDITABLE = new Set<string>(PARTY_EDITABLE_FIELDS);

/** The text fields, where a blank means "none". */
const TEXT_FIELDS = new Set<keyof PartyEditFields>([
  'location',
  'childName',
  'parentName',
  'whatsapp',
  'decoration',
  'activities',
]);

/**
 * What a PATCH may change, and what it carried that it may not. The protected
 * fields — the party's id and branch, the charges, the payments, the stamp —
 * are never editable (`updateParty` keeps them whatever the patch says), and a
 * field the OTO App has no home for is not saved either; both are named back.
 */
function editableOf(body: PartyPatchBody): { fields: PartyEditFields; ignored: string[] } {
  const fields: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (ENVELOPE.has(key)) continue;
    if (!EDITABLE.has(key)) {
      ignored.push(key);
      continue;
    }
    if (value === undefined) continue;
    const name = key as keyof PartyEditFields;
    fields[key] = TEXT_FIELDS.has(name) && typeof value === 'string' && value.trim() === '' ? null : value;
  }
  if (typeof fields.whatsapp === 'string') {
    const e164 = normalizePhone(fields.whatsapp);
    if (!e164) throw errors.badRequest('That WhatsApp number is not a phone number', { whatsapp: fields.whatsapp });
    fields.whatsapp = e164;
  }
  return { fields: fields as PartyEditFields, ignored: ignored.sort() };
}

/** A till's edit in the OTO App's words (`editBodySchema`): money in whole baht. */
function directoryFieldsOf(f: PartyEditFields): DirectoryEventEditFields {
  const out: DirectoryEventEditFields = {};
  if (f.title !== undefined) out.title = f.title;
  if (f.status !== undefined) out.status = f.status;
  if (f.date !== undefined) out.eventDate = f.date;
  if (f.startTime !== undefined) out.startTime = f.startTime;
  if (f.endTime !== undefined) out.endTime = f.endTime;
  if (f.location !== undefined) out.location = f.location;
  if (f.expectedKids !== undefined) out.numChildren = f.expectedKids;
  if (f.expectedAdults !== undefined) out.numAdults = f.expectedAdults;
  if (f.childName !== undefined) out.childName = f.childName;
  if (f.kidAge !== undefined) out.kidTurningAge = f.kidAge;
  if (f.parentName !== undefined) out.parentName = f.parentName;
  if (f.whatsapp !== undefined) out.whatsappPhone = f.whatsapp;
  if (f.decoration !== undefined) out.decoration = f.decoration;
  if (f.activities !== undefined) out.activities = f.activities;
  if (f.basePriceSatang !== undefined) out.totalValueThb = Math.round(f.basePriceSatang / 100);
  if (f.depositSatang !== undefined) out.prepaymentAmountThb = Math.round(f.depositSatang / 100);
  if (f.depositDate !== undefined) out.prepaymentDate = f.depositDate;
  return out;
}

/**
 * `PATCH /parties/:id` — `updateParty`: the till edits the party's own fields.
 *
 * Recorded here first — what the edit changed, who and when (the stamp) — and
 * committed; then written back to the OTO App under the edit's own id
 * (`pushPartyEdit`). Until the app takes it the party is shown as the till
 * edited it, marked; a write the app refuses is not shown, and waits on the
 * Failures page.
 */
export async function updateParty(
  deps: PartyDeps,
  ctx: OpContext,
  actor: ActorContext,
  partyId: string,
  body: PartyPatchBody,
  now: Date = new Date(),
): Promise<PartyWriteAnswer> {
  const db = deps.db;
  const clock = await branchClockOf(db, actor.operatorId, body.branchId);
  await actor.assertBranchAllowed?.(clock.id);
  const event = await partyOf(db, clock.id, partyId);
  const { fields, ignored } = editableOf(body);

  const replay = async (row: EditRow): Promise<PartyWriteAnswer> => {
    if (row.operatorId !== actor.operatorId || row.otoappEventId !== event.id) {
      throw errors.conflict('EDIT_ID_IN_USE', 'That edit id already belongs to another edit', { editId: row.id });
    }
    await actor.assertBranchAllowed?.(row.branchId);
    // A retry after a lost answer is also the till's chance to finish a
    // write-back the OTO App never confirmed: the same edit, the same id.
    const current = row.syncState === 'synced' ? row : await pushPartyEdit(deps, row.id, { requestId: actor.requestId ?? null });
    return {
      replayed: true,
      party: await partyNow(db, actor, row.branchId, event.id),
      edit: { id: current.id, syncState: current.syncState, syncError: current.syncError, ignored },
    };
  };

  const [prior] = await db.select().from(partyEdit).where(eq(partyEdit.id, body.editId)).limit(1);
  if (prior) return replay(prior);
  if (event.archived) throw errors.conflict('EVENT_ARCHIVED', 'This party has been archived in the OTO App');
  if (Object.keys(fields).length === 0) {
    throw new AppError(400, 'PARTY_EDIT_EMPTY', 'Nothing that can be changed from the till was sent', { ignored });
  }
  const at = await stationAt(db, actor.operatorId, clock.id, body.stationId);
  const actionId = body.actionId ?? null;

  const done: { raced: EditRow | null } = { raced: null };
  await withTx(db, ctx, 'party.update', async (tx) => {
    await lockParty(tx, event.id);
    const [again] = await tx.select().from(partyEdit).where(eq(partyEdit.id, body.editId)).limit(1);
    if (again) {
      done.raced = again;
      return undefined;
    }
    const { party } = await liveBill(tx, clock.id, event.id);
    const current = partyFieldsOf(party);
    const before = Object.fromEntries(Object.keys(fields).map((key) => [key, current[key as keyof PartyEditFields]]));
    await tx.insert(partyEdit).values({
      id: body.editId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      otoappEventId: event.id,
      fields,
      syncState: 'pending',
      accountId: actor.accountId,
      stationId: at?.id ?? null,
      boxId: at?.boxId ?? null,
      actionId,
      createdAt: now,
      updatedAt: now,
    });
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      action: 'party.update',
      entityType: 'party_edit',
      entityId: body.editId,
      actionId,
      requestId: actor.requestId,
      before,
      after: {
        ...fields,
        eventId: event.id,
        ...(ignored.length > 0 ? { ignored } : {}),
        stationId: at?.id ?? null,
        boxId: at?.boxId ?? null,
      },
    });
    return undefined;
  });
  if (done.raced) return replay(done.raced);

  // After the commit, as the child's write-back is: the edit stands here
  // whatever the OTO App answers, and the answer says what it made of it.
  const pushed = await pushPartyEdit(deps, body.editId, { requestId: actor.requestId ?? null });
  return {
    replayed: false,
    party: await partyNow(db, actor, clock.id, event.id),
    edit: { id: pushed.id, syncState: pushed.syncState, syncError: pushed.syncError, ignored },
  };
}

/**
 * WRITE ONE EDIT TO THE OTO APP — the first time, and every retry.
 *
 * An edit sets values, so what has to be right is ORDER, not count: the app
 * refuses an edit older than its own latest change of the event
 * (`edit_superseded`), and a newer edit must not overtake an older one the app
 * has not taken yet. So a send carries, under this edit's id and its moment,
 * every older edit of the same party still waiting (`pending`) with this one
 * last — and when the app takes it, all of them are taken. Not carried: a
 * refused older edit (`failed`) — the app said no to it — and an older edit
 * the app changed the party after, which it would refuse on its own; a newer
 * edit must not put either back.
 *
 * Recorded twice over, as a child's write-back is: on the edit (`sync_state`,
 * the attempts, the error) and as an `ops_run` of kind `integration` named
 * `otoapp:party.update`, which the Failures page groups and offers to retry.
 * Never throws for the app's answer: the edit is committed before this runs,
 * and a write-back that failed is a fact to show, not an error to raise.
 */
export async function pushPartyEdit(
  deps: PartyDeps,
  editId: string,
  meta: { requestId?: string | null } = {},
): Promise<EditRow> {
  return (await sendPartyEdit(deps, editId, meta)).row;
}

async function sendPartyEdit(
  deps: PartyDeps,
  editId: string,
  meta: { requestId?: string | null },
): Promise<{ row: EditRow; outcome: DirectoryOutcome<DirectoryEventEditAnswer> | null }> {
  const db = deps.db;
  const [row] = await db.select().from(partyEdit).where(eq(partyEdit.id, editId)).limit(1);
  if (!row) throw errors.notFound('That party edit is not on record');
  if (row.syncState === 'synced') return { row, outcome: null };

  const older = await db
    .select()
    .from(partyEdit)
    .where(
      and(
        eq(partyEdit.operatorId, row.operatorId),
        eq(partyEdit.otoappEventId, row.otoappEventId),
        eq(partyEdit.syncState, 'pending'),
        sql`${partyEdit.createdAt} <= ${row.createdAt}`,
        ne(partyEdit.id, row.id),
      ),
    )
    .orderBy(asc(partyEdit.createdAt), asc(partyEdit.id));
  // An older edit the OTO App changed the party after is not carried: inside
  // this newer edit it would put back values the app has since replaced. Sent
  // on its own it is refused as superseded, which is the truth. (When the
  // party cannot be read, every waiting edit is carried, as it would be shown.)
  const seam = await getBranchEvent(db, { branchId: row.branchId, eventId: row.otoappEventId }).catch(() => null);
  const carried = [...older.filter((e) => !seam || editStillShown(e, seam)), row];
  const merged = Object.assign({}, ...carried.map((e) => e.fields as PartyEditFields)) as PartyEditFields;

  const startedAt = new Date();
  const outcome: DirectoryOutcome<DirectoryEventEditAnswer> = deps.directory.editEvent
    ? await deps.directory.editEvent(row.otoappEventId, {
        id: row.id,
        editedAt: row.createdAt.toISOString(),
        fields: directoryFieldsOf(merged),
      })
    : {
        ok: false,
        status: null,
        code: DIRECTORY_NOT_CONFIGURED,
        message: 'This deployment cannot write party edits to the OTO App yet, so the edit waits',
        retryable: true,
      };
  const finishedAt = new Date();

  const detail = {
    editId: row.id,
    eventId: row.otoappEventId,
    attempt: row.syncAttempts + 1,
    status: outcome.status,
    carried: carried.length,
    ...(outcome.ok ? { replayed: outcome.body.replayed } : {}),
  };
  const runBase = {
    kind: 'integration' as const,
    name: PARTY_UPDATE_RUN,
    startedAt,
    finishedAt,
    detail,
    requestId: meta.requestId ?? null,
    actionId: row.actionId,
    operatorId: row.operatorId,
    branchId: row.branchId,
    stationId: row.stationId,
  };

  if (outcome.ok) {
    await db
      .update(partyEdit)
      .set({
        syncState: 'synced',
        syncAttempts: sql`${partyEdit.syncAttempts} + 1`,
        syncError: null,
        lastSyncAt: finishedAt,
        syncedAt: finishedAt,
        updatedAt: finishedAt,
      })
      .where(and(inArray(partyEdit.id, carried.map((e) => e.id)), sql`${partyEdit.syncState} <> 'synced'`));
    await recordRun(db, { ...runBase, outcome: 'ok' }).catch((err: unknown) =>
      deps.log?.error({ err, editId: row.id }, 'the party edit write-back ran but its ops run could not be written'),
    );
  } else {
    await db
      .update(partyEdit)
      .set({
        syncState: outcome.retryable ? 'pending' : 'failed',
        syncAttempts: sql`${partyEdit.syncAttempts} + 1`,
        syncError: `${outcome.code}: ${outcome.message}`.slice(0, 500),
        lastSyncAt: finishedAt,
        updatedAt: finishedAt,
      })
      .where(and(eq(partyEdit.id, row.id), sql`${partyEdit.syncState} <> 'synced'`));
    await recordRun(db, {
      ...runBase,
      outcome: 'failed',
      error: new AppError(outcome.status ?? 503, outcome.code, outcome.message),
    }).catch((err: unknown) =>
      deps.log?.error({ err, editId: row.id }, 'the party edit write-back failed and its ops run could not be written'),
    );
  }
  const [now] = await db.select().from(partyEdit).where(eq(partyEdit.id, row.id)).limit(1);
  return { row: now ?? row, outcome };
}

/** The most party edits one press of Retry sends; the rest wait for the next press. */
export const PARTY_EDIT_SWEEP_LIMIT = 50;

/** What one press of Retry did. */
export interface PartyEditSweep {
  /** The edit the pressed run names, as it now stands. */
  edit: EditRow;
  /** Edits sent to the app by this press, that one included when it was sent. */
  sent: number;
  /** Of those, how many the app now holds. */
  synced: number;
  /** Edits this Retry reaches that are still not in the app afterwards. */
  waiting: number;
  /** The sweep stopped before the end because the app did not answer, or refused the key. */
  stoppedEarly: boolean;
}

const stopsTheSweep = (outcome: DirectoryOutcome<DirectoryEventEditAnswer> | null): boolean =>
  outcome !== null && !outcome.ok && (outcome.retryable || outcome.status === 401 || outcome.status === 403);

/**
 * THE FAILURES PAGE'S RETRY of a party edit's write-back — every edit the
 * outage left waiting, as a child's Retry is (`retryAttendeeWriteBack`): the
 * pressed run's edit first, then, oldest first and bounded, every other edit
 * of the caller's operator, at a branch the caller may manage ops at, that is
 * still `pending` or was refused with the pressed group's own error code; and
 * it stops at the first one the app still does not answer, or whose key it
 * refuses. Oldest first keeps each party's edits in the order they were made.
 */
export async function retryPartyEditWriteBack(
  deps: PartyDeps,
  q: {
    operatorId: string;
    editId: string;
    errorCode: string | null;
    reach: BranchReach;
    requestId?: string | null;
    limit?: number;
  },
): Promise<PartyEditSweep> {
  const db = deps.db;
  const limit = Math.max(1, q.limit ?? PARTY_EDIT_SWEEP_LIMIT);
  const meta = { requestId: q.requestId ?? null };
  const [row] = await db
    .select({ id: partyEdit.id, operatorId: partyEdit.operatorId })
    .from(partyEdit)
    .where(eq(partyEdit.id, q.editId))
    .limit(1);
  if (!row || row.operatorId !== q.operatorId) throw errors.notFound('That party edit is not on record');

  let sent = 0;
  let synced = 0;
  const own = await sendPartyEdit(deps, row.id, meta);
  if (own.outcome) {
    sent += 1;
    if (own.row.syncState === 'synced') synced += 1;
  }
  let stoppedEarly = stopsTheSweep(own.outcome);

  const reachClause =
    q.reach.kind === 'operator'
      ? undefined
      : q.reach.branchIds.length === 0
        ? sql`false`
        : inArray(partyEdit.branchId, q.reach.branchIds);
  const sameGroupRefusal = q.errorCode
    ? and(eq(partyEdit.syncState, 'failed'), sql`starts_with(${partyEdit.syncError}, ${`${q.errorCode}:`})`)
    : undefined;
  const waitingClause = and(
    eq(partyEdit.operatorId, q.operatorId),
    sql`${partyEdit.syncState} <> 'synced'`,
    sameGroupRefusal ? or(eq(partyEdit.syncState, 'pending'), sameGroupRefusal) : eq(partyEdit.syncState, 'pending'),
    reachClause,
  );

  if (!stoppedEarly && sent < limit) {
    const others = await db
      .select({ id: partyEdit.id })
      .from(partyEdit)
      .where(and(waitingClause, ne(partyEdit.id, row.id)))
      .orderBy(asc(partyEdit.createdAt), asc(partyEdit.id))
      .limit(limit - sent);
    for (const other of others) {
      const pushed = await sendPartyEdit(deps, other.id, meta);
      // Carried by an edit sent before it in this sweep, and taken with it.
      if (!pushed.outcome) continue;
      sent += 1;
      if (pushed.row.syncState === 'synced') synced += 1;
      if (stopsTheSweep(pushed.outcome)) {
        stoppedEarly = true;
        break;
      }
    }
  }

  const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(partyEdit).where(waitingClause);
  return { edit: own.row, sent, synced, waiting: left?.n ?? 0, stoppedEarly };
}
