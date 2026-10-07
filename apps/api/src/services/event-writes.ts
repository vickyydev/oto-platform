import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  account,
  branch,
  child,
  employee,
  eventAttendeeLink,
  eventDropInPricing,
  member,
  sale,
  saleLine,
  station,
  type Db,
} from '@oto/db';
import {
  EVENT_DROP_IN_PRICING_NONE,
  businessDate,
  eventPassService,
  parseDayStart,
  resolveRate,
  walkUpAttendanceDays,
  walkUpBillingOf,
  walkUpNotes,
  walkUpStamp,
  type EventAttendeeCreateBody,
  type EventAttendeeInput,
  type EventAttendeeLinkView,
  type EventAttendeeWriteAnswer,
  type EventDropInPricing,
  type EventDropInPricingAnswer,
  type EventPartyWalkUpCharge,
  type EventPassSellBody,
  type EventWalkUpBilling,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import type { BranchReach } from './access-control';
import { audit } from './audit';
import { recordRun } from './ops';
import { OtoAppSeamNotGrantedError, getBranchEvent, type SeamEvent } from './otoapp-events';
import type {
  DirectoryAttendeeAnswer,
  DirectoryAttendeeBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from './otoapp-directory';
import type { DrawerKick } from './payments/drawer';
import { commitSale, finaliseSale, resolvePricingScope, type ActorContext } from './sale';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * S2-20 E2 — ATTENDEE CREATE AND PASS SALE (SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md §3, §5, §8 and the E2 row of §9).
 *
 * The port of `sellEventPass` (lib/eventPass.ts) and `addEventAttendee`
 * (mockApi.ts:3726), on the platform:
 *
 *   - a PAID camp or event pass is an ordinary sale — committed and paid in
 *     one transaction through `commitSale` and `finaliseSale`, one kid at the
 *     event's flat price under the `tickets` category with the svc id kept —
 *     and nothing at all is written without its tender (H2);
 *   - a FREE event (price ฿0) adds the child with no sale;
 *   - a PARTY walk-up adds the child and owes the branch's party-guest price on
 *     the party's tab, with no door payment;
 *   - a camp walk-up is registered for today, or with "Also register for the
 *     full camp" for every remaining day (Q5's default), and every walk-up's
 *     note is stamped with who added it and how.
 *
 * THE CHILD IS THE OTO APP'S (C10). The POS records its half — the sale, the
 * price, who and where — in `pos.event_attendee_link`, commits, and only then
 * writes the child to the app through its directory API, under the attendee id
 * the till minted. That write is an `ops_run` of kind `integration` named
 * `otoapp:attendee.create`. A write that fails leaves the link `pending` (no
 * answer, a fault) or `failed` (the app refused), the roster shows the child
 * from the POS's record, and the run can be retried from the Failures page —
 * a replay of the same id, so the app never holds the child twice (H3).
 *
 * The event is read through the seam (`otoapp-events.ts`) and nothing else:
 * this file names no OTO App table and no view (H1).
 */

/** The ops run every directory write is recorded under — the Failures page's name for it. */
export const ATTENDEE_CREATE_RUN = 'otoapp:attendee.create';

/** What the route hands the service. */
export interface EventWriteDeps {
  db: Db;
  directory: OtoAppDirectory;
  log?: FastifyBaseLogger;
}

/** What a write answers, and the drawer a cash pass opens once it has committed. */
export interface EventWriteResult {
  answer: EventAttendeeWriteAnswer;
  drawerKick: DrawerKick | null;
}

export interface BranchClock {
  id: string;
  timezone: string;
  dayStartMinutes: number;
}

export async function branchClockOf(db: Exec, operatorId: string, branchId: string): Promise<BranchClock> {
  const [row] = await db
    .select({ id: branch.id, timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Branch not found');
  return { id: row.id, timezone: row.timezone, dayStartMinutes: parseDayStart(row.dayStart) };
}

/** The seam installed but not granted: a fault to say, as the read routes say it. */
export async function seamRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof OtoAppSeamNotGrantedError) {
      throw new AppError(503, 'EVENTS_SEAM_NOT_GRANTED', err.message, { missing: err.missing });
    }
    throw err;
  }
}

/** What the park calls a member of staff: their nickname, then their name. */
export async function staffNameOf(db: Exec, accountId: string): Promise<string> {
  const [row] = await db
    .select({ name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(account.employeeId, employee.id))
    .where(eq(account.id, accountId))
    .limit(1);
  // Bounded to what the OTO App's directory takes as `createdBy` (255) with room
  // to spare in the note it stamps (2000).
  return (row?.nickname?.trim() || row?.name?.trim() || 'Staff').slice(0, 120);
}

type LinkRow = typeof eventAttendeeLink.$inferSelect;

function linkView(row: LinkRow): EventAttendeeLinkView {
  return {
    id: row.id,
    eventId: row.otoappEventId,
    eventType: row.eventType,
    otoappAttendeeId: row.otoappAttendeeId,
    merged: row.merged,
    billing: row.billing,
    priceSatang: row.priceSnapshotSatang,
    attendanceDays: [...row.attendanceDays].sort(),
    parentAttending: row.parentAttending,
    syncState: row.syncState,
    syncError: row.syncError,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The child as the directory takes it. Nothing the till captured is dropped:
 *
 *   - an allergy or diet flag with no words beside it is sent as the form's own
 *     label, because the OTO App flags a child on any text and on none — a
 *     ticked switch must not arrive as nothing;
 *   - the emergency contact has no field in the directory, so it rides in the
 *     note, ahead of the walk-up stamp.
 */
export function directoryBodyOf(
  attendeeId: string,
  input: EventAttendeeInput,
  days: string[],
  stamp: string,
  createdBy: string,
): DirectoryAttendeeBody {
  const emergency = input.emergencyContact?.trim();
  const own = [input.notes?.trim(), emergency ? `Emergency contact: ${emergency}` : null]
    .filter((part): part is string => Boolean(part))
    .join(' — ');
  return {
    id: attendeeId,
    childFullName: input.name.trim(),
    dateOfBirth: input.dateOfBirth ?? null,
    ageYears: input.age ?? null,
    primaryLanguage: input.language?.trim() || null,
    allergies: input.allergyFlag ? input.allergyDetail?.trim() || 'Allergy / medical note' : null,
    foodRestrictions: input.dietaryFlag ? input.dietaryDetail?.trim() || 'Dietary restriction' : null,
    parentName: input.parentName.trim(),
    parentPhone: input.parentPhone?.trim() || null,
    parentAttending: input.parentAttending ?? false,
    attendanceDays: days,
    notes: walkUpNotes(own, stamp),
    source: 'pos',
    createdBy,
  };
}

/** The branch's walk-up prices; ฿0 everywhere for a branch nobody priced. */
async function dropInPricingOf(db: Exec, branchId: string): Promise<{
  pricing: EventDropInPricing;
  configured: boolean;
  updatedAt: Date | null;
}> {
  const [row] = await db
    .select()
    .from(eventDropInPricing)
    .where(eq(eventDropInPricing.branchId, branchId))
    .limit(1);
  if (!row) return { pricing: EVENT_DROP_IN_PRICING_NONE, configured: false, updatedAt: null };
  return {
    pricing: {
      campDay: { weekday: row.campDayWeekdaySatang, weekend: row.campDayWeekendSatang },
      eventDay: { weekday: row.eventDayWeekdaySatang, weekend: row.eventDayWeekendSatang },
      partyGuest: { weekday: row.partyGuestWeekdaySatang, weekend: row.partyGuestWeekendSatang },
    },
    configured: true,
    updatedAt: row.updatedAt,
  };
}

/** Is the camp running on `day`? Every day of its range; an open-ended camp from its first. */
const campRunsOn = (event: SeamEvent, day: string) =>
  event.startDate <= day && (event.endDate === null || event.endDate >= day);

interface WriteInput {
  kind: 'attendee' | 'pass';
  eventId: string;
  body: EventAttendeeCreateBody;
  pass?: Pick<EventPassSellBody, 'saleId' | 'tender' | 'expectedTotalSatang'>;
}

/**
 * `POST /events/:id/attendees` — a party walk-up, or a child on a free event.
 * A camp or event that costs money is refused here: it is sold as a pass, with
 * its tender, and nothing is written for it without one (H2).
 */
export async function addEventAttendee(
  deps: EventWriteDeps,
  ctx: OpContext,
  actor: ActorContext,
  eventId: string,
  body: EventAttendeeCreateBody,
  now: Date = new Date(),
): Promise<EventWriteResult> {
  return writeAttendee(deps, ctx, actor, { kind: 'attendee', eventId, body }, now);
}

/** `POST /events/:id/passes` — a paid camp or event pass: the sale, its tender, then the child. */
export async function sellEventPass(
  deps: EventWriteDeps,
  ctx: OpContext,
  actor: ActorContext,
  eventId: string,
  body: EventPassSellBody,
  now: Date = new Date(),
): Promise<EventWriteResult> {
  return writeAttendee(
    deps,
    ctx,
    actor,
    {
      kind: 'pass',
      eventId,
      body,
      pass: { saleId: body.saleId, tender: body.tender, expectedTotalSatang: body.expectedTotalSatang },
    },
    now,
  );
}

/** The answer for a link that already exists: the same request, answered again. */
async function replayOf(
  deps: EventWriteDeps,
  actor: ActorContext,
  row: LinkRow,
  eventId: string,
): Promise<EventWriteResult> {
  if (row.operatorId !== actor.operatorId || row.otoappEventId !== eventId.toLowerCase()) {
    throw errors.conflict('ATTENDEE_ID_IN_USE', 'That attendee id already belongs to another child', {
      attendeeId: row.id,
    });
  }
  await actor.assertBranchAllowed?.(row.branchId);
  // A retry after a lost answer is also the till's chance to finish a write
  // the OTO App never confirmed. The same id, so the app replays it.
  const current = row.syncState === 'synced' ? row : await pushAttendee(deps, row.id, { requestId: actor.requestId ?? null });
  return { answer: await answerOf(deps.db, current, true, []), drawerKick: null };
}

async function answerOf(
  db: Exec,
  row: LinkRow,
  replayed: boolean,
  printingNotes: string[],
): Promise<EventAttendeeWriteAnswer> {
  let paid: EventAttendeeWriteAnswer['sale'] = null;
  if (row.saleId) {
    const [s] = await db
      .select({ id: sale.id, receiptNumber: sale.receiptNumber, grossSatang: sale.grossSatang, status: sale.status })
      .from(sale)
      .where(eq(sale.id, row.saleId))
      .limit(1);
    if (s) paid = s;
  }
  return { attendee: linkView(row), replayed, sale: paid, printingNotes };
}

async function writeAttendee(
  deps: EventWriteDeps,
  ctx: OpContext,
  actor: ActorContext,
  input: WriteInput,
  now: Date,
): Promise<EventWriteResult> {
  const { body, kind } = input;
  const db = deps.db;
  const clock = await branchClockOf(db, actor.operatorId, body.branchId);
  await actor.assertBranchAllowed?.(clock.id);
  const event = await seamRead(() => getBranchEvent(db, { branchId: clock.id, eventId: input.eventId }));
  if (!event) throw errors.notFound('Event not found');

  // The same attendee id again: the request that made it, answered again —
  // before any rule that moves with the clock, so a retry tomorrow of
  // yesterday's camp walk-up is still yesterday's answer.
  const [prior] = await db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, body.attendeeId)).limit(1);
  if (prior) return replayOf(deps, actor, prior, event.id);

  if (event.archived) throw errors.conflict('EVENT_ARCHIVED', 'This event has been archived in the OTO App');
  const today = businessDate(now, clock.timezone, clock.dayStartMinutes);
  if (event.type === 'camp' && !campRunsOn(event, today)) {
    throw errors.conflict('CAMP_NOT_RUNNING_TODAY', 'This camp is not running today, so nobody can be added to it here');
  }
  if (kind === 'pass' && event.type === 'party') {
    throw errors.conflict(
      'EVENT_PASS_NOT_FOR_PARTY',
      "A party has no pass: a walk-up guest is added to the party's tab instead",
    );
  }

  // The price, at the day's rate mode, never tiered (R-98): the event's own
  // flat pair for a camp or an event, the branch's party-guest price for a party.
  const scope = await resolvePricingScope(db, clock.id, actor.operatorId, now);
  let pair: { weekday: number; weekend: number };
  if (event.type === 'party') {
    pair = (await dropInPricingOf(db, clock.id)).pricing.partyGuest;
  } else {
    if (event.entryPriceWeekdaySatang === null || event.entryPriceWeekendSatang === null) {
      throw errors.conflict(
        'EVENT_NOT_PRICED',
        'This event has no entry price in the OTO App yet, so nobody can be added to it at the till',
      );
    }
    pair = { weekday: event.entryPriceWeekdaySatang, weekend: event.entryPriceWeekendSatang };
  }
  const fee = resolveRate(pair, scope.pricingMode);
  const billing: EventWalkUpBilling = walkUpBillingOf(event.type, fee);
  if (kind === 'attendee' && billing === 'sale') {
    throw errors.conflict(
      'EVENT_PASS_NEEDS_PAYMENT',
      `This pass costs ฿${(fee / 100).toLocaleString('en-US')}, so it is sold with a payment — nothing was saved`,
      { feeSatang: fee },
    );
  }
  if (kind === 'pass' && billing === 'free') {
    throw errors.conflict('EVENT_PASS_IS_FREE', 'This event is free: add the child without a payment');
  }

  // Where it was done, and for whom — each checked inside the caller's operator.
  let boxId: string | null = null;
  if (body.stationId) {
    const [st] = await db
      .select({ id: station.id, branchId: station.branchId, boxId: station.boxId, archivedAt: station.archivedAt })
      .from(station)
      .where(and(eq(station.id, body.stationId), eq(station.operatorId, actor.operatorId)))
      .limit(1);
    if (!st || st.archivedAt) throw errors.notFound('Station not found');
    if (st.branchId !== clock.id) throw errors.badRequest('That station belongs to another branch');
    boxId = st.boxId;
  }
  if (body.memberId) {
    const [m] = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.id, body.memberId), eq(member.operatorId, actor.operatorId)))
      .limit(1);
    if (!m) throw errors.notFound('Member not found');
  }
  if (body.childId) {
    if (!body.memberId) throw errors.badRequest('A saved child is named with the member they belong to');
    const [c] = await db
      .select({ id: child.id })
      .from(child)
      .where(and(eq(child.id, body.childId), eq(child.memberId, body.memberId)))
      .limit(1);
    if (!c) throw errors.notFound('Child not found');
  }

  const staffName = await staffNameOf(db, actor.accountId);
  const days = walkUpAttendanceDays(event, body.registerProperly, today);
  const writeback = directoryBodyOf(
    body.attendeeId,
    body.attendee,
    days,
    walkUpStamp(staffName, body.registerProperly),
    staffName,
  );
  const actionId = body.actionId ?? null;
  const opName = kind === 'pass' ? 'event.pass_sell' : 'event.attendee_create';

  // Filled inside the transaction; a holder, because a callback's assignments
  // are invisible to the narrowing of a plain `let`.
  const done: { drawerKick: DrawerKick | null; printingNotes: string[]; raced: LinkRow | null } = {
    drawerKick: null,
    printingNotes: [],
    raced: null,
  };
  // The answer is built after the commit and the write-back, so nothing is
  // returned from the transaction: what the idempotency store keeps is the
  // final answer, sync state included, never this half of it.
  await withTx(db, ctx, opName, async (tx) => {
    // Two presses of one attendee id at once: the second waits for the first
    // and then finds its row.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`event-attendee:${body.attendeeId}`}, 0))`);
    const [again] = await tx.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, body.attendeeId)).limit(1);
    if (again) {
      done.raced = again;
      return undefined;
    }

    let saleId: string | null = null;
    let saleLineId: string | null = null;
    let receiptNumber: string | null = null;
    if (kind === 'pass') {
      const pass = input.pass!;
      const service = eventPassService(event.type as 'camp' | 'event');
      // The ordinary sale path (S2-09a, S2-10a): priced by the engine, numbered,
      // printed and paid like any ticket sale — the one thing it cannot be is
      // anything but this pass.
      const committed = await commitSale(
        tx,
        actor,
        {
          id: pass.saleId,
          branchId: clock.id,
          stationId: body.stationId!,
          channel: 'till',
          actionId,
          ...(pass.expectedTotalSatang !== undefined ? { expectedTotalSatang: pass.expectedTotalSatang } : {}),
          eventPass: {
            lineId: body.attendeeId,
            serviceId: service.serviceId,
            label: service.label,
            price: pair,
            eventId: event.id,
          },
        },
        now,
      );
      if (committed.replay) {
        throw errors.conflict('SALE_ID_IN_USE', 'That sale id already belongs to another sale — nothing was saved');
      }
      const closed = await finaliseSale(
        tx,
        actor,
        pass.saleId,
        { tender: pass.tender, actionId, prepaidGate: 'refuse' },
        now,
      );
      if (!closed.finalised) {
        throw errors.conflict(
          'EVENT_PASS_PART_PAID',
          'An event pass is paid in one tender: take the whole fee — nothing was saved',
          { outstandingSatang: closed.outstandingSatang },
        );
      }
      done.drawerKick = closed.drawerKick;
      done.printingNotes = closed.printing?.notes ?? [];
      saleId = pass.saleId;
      receiptNumber = closed.sale.receiptNumber;
      const [line] = await tx
        .select({ id: saleLine.id })
        .from(saleLine)
        .where(and(eq(saleLine.saleId, pass.saleId), eq(saleLine.cartLineId, body.attendeeId)))
        .limit(1);
      saleLineId = line?.id ?? null;
    }

    await tx.insert(eventAttendeeLink).values({
      id: body.attendeeId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      otoappEventId: event.id,
      eventType: event.type,
      childId: body.childId ?? null,
      memberId: body.memberId ?? null,
      saleId,
      saleLineId,
      billing,
      priceSnapshotSatang: fee,
      parentAttending: body.attendee.parentAttending ?? false,
      attendanceDays: days,
      source: 'till',
      syncState: 'pending',
      writeback,
      accountId: actor.accountId,
      stationId: body.stationId ?? null,
      boxId,
      actionId,
      createdAt: now,
      updatedAt: now,
    });
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      action: opName,
      entityType: 'event_attendee_link',
      entityId: body.attendeeId,
      actionId,
      requestId: actor.requestId,
      // The station and box ride in the row's detail, as other station actions'
      // do (plan §10): the audit table has no column for either.
      after: {
        eventId: event.id,
        eventType: event.type,
        billing,
        priceSatang: fee,
        pricingMode: scope.pricingMode,
        saleId,
        receiptNumber,
        stationId: body.stationId ?? null,
        boxId,
        registerProperly: body.registerProperly,
        attendanceDays: days.length,
        memberId: body.memberId ?? null,
        childId: body.childId ?? null,
      },
    });
    return undefined;
  });

  if (done.raced) return replayOf(deps, actor, done.raced, event.id);

  const pushed = await pushAttendee(deps, body.attendeeId, { requestId: actor.requestId ?? null });
  return { answer: await answerOf(db, pushed, false, done.printingNotes), drawerKick: done.drawerKick };
}

/**
 * WRITE ONE CHILD TO THE OTO APP — the first time, and every retry.
 *
 * Reads the link, sends its stored body under its own id, and records what
 * happened twice over: on the link (`sync_state`, the attempt count, the
 * error) and as an `ops_run` of kind `integration` that the Failures page
 * groups and offers to retry. A link already synced is left alone; anything
 * else is sent again, which the app answers as a replay when it already has
 * the child. Never throws for the app's answer: the sale and the link are
 * committed before this runs, and a write-back that failed is a fact to show,
 * not an error to raise.
 */
export async function pushAttendee(
  deps: EventWriteDeps,
  linkId: string,
  meta: { requestId?: string | null } = {},
): Promise<LinkRow> {
  return (await sendAttendee(deps, linkId, meta)).row;
}

/**
 * One send, and what came of it: the link as it now stands, and the
 * directory's answer — null when nothing was sent because the link was
 * already synced. The sweep below reads the answer to know when to stop.
 */
async function sendAttendee(
  deps: EventWriteDeps,
  linkId: string,
  meta: { requestId?: string | null },
): Promise<{ row: LinkRow; outcome: DirectoryOutcome<DirectoryAttendeeAnswer> | null }> {
  const db = deps.db;
  const [row] = await db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, linkId)).limit(1);
  if (!row) throw errors.notFound('That attendee is not on record');
  if (row.syncState === 'synced') return { row, outcome: null };
  const body = row.writeback as DirectoryAttendeeBody | null;
  if (!body) throw new Error(`event attendee link ${row.id} is not synced and holds no write-back body`);

  const startedAt = new Date();
  const outcome = await deps.directory.addAttendee(row.otoappEventId, body);
  const finishedAt = new Date();
  const attempts = row.syncAttempts + 1;

  const detail = {
    linkId: row.id,
    eventId: row.otoappEventId,
    eventType: row.eventType,
    attempt: attempts,
    status: outcome.status,
    ...(outcome.ok ? { replayed: outcome.body.replayed, merged: outcome.body.merged } : {}),
  };
  const runBase = {
    kind: 'integration' as const,
    name: ATTENDEE_CREATE_RUN,
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
    const [updated] = await db
      .update(eventAttendeeLink)
      .set({
        syncState: 'synced',
        otoappAttendeeId: outcome.body.attendee.id,
        merged: outcome.body.merged,
        syncAttempts: attempts,
        syncError: null,
        lastSyncAt: finishedAt,
        syncedAt: finishedAt,
        updatedAt: finishedAt,
      })
      .where(and(eq(eventAttendeeLink.id, row.id), sql`${eventAttendeeLink.syncState} <> 'synced'`))
      .returning();
    await recordRun(db, { ...runBase, outcome: 'ok' }).catch((err: unknown) =>
      deps.log?.error({ err, linkId: row.id }, 'the attendee write-back ran but its ops run could not be written'),
    );
    if (updated) return { row: updated, outcome };
    // Another retry finished first; its row is the answer.
    const [now] = await db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, row.id)).limit(1);
    return { row: now ?? row, outcome };
  }

  const state = outcome.retryable ? 'pending' : 'failed';
  const [updated] = await db
    .update(eventAttendeeLink)
    .set({
      syncState: state,
      syncAttempts: attempts,
      syncError: `${outcome.code}: ${outcome.message}`.slice(0, 500),
      lastSyncAt: finishedAt,
      updatedAt: finishedAt,
    })
    .where(and(eq(eventAttendeeLink.id, row.id), sql`${eventAttendeeLink.syncState} <> 'synced'`))
    .returning();
  await recordRun(db, {
    ...runBase,
    outcome: 'failed',
    error: new AppError(outcome.status ?? 503, outcome.code, outcome.message),
  }).catch((err: unknown) =>
    deps.log?.error({ err, linkId: row.id }, 'the attendee write-back failed and its ops run could not be written'),
  );
  if (updated) return { row: updated, outcome };
  const [now] = await db.select().from(eventAttendeeLink).where(eq(eventAttendeeLink.id, row.id)).limit(1);
  return { row: now ?? row, outcome };
}

/** The most children one press of Retry sends; the rest wait for the next press. */
export const WRITE_BACK_SWEEP_LIMIT = 50;

/** What one press of Retry did. */
export interface WriteBackSweep {
  /** The child the pressed run names, as it now stands. */
  link: LinkRow;
  /** Children sent to the app by this press, that one included when it was sent. */
  sent: number;
  /** Of those, how many the app now holds. */
  synced: number;
  /**
   * Children this Retry reaches that are still not in the app afterwards:
   * not taken, past the bound, or held back because the app stopped answering.
   */
  waiting: number;
  /** The sweep stopped before the end because the app did not answer, or refused the key. */
  stoppedEarly: boolean;
}

/**
 * Whether one answer says the rest of a sweep would fare no better: no answer
 * or a fault (the app is still down), or the app refusing this deployment's
 * key, which it would refuse for every other child too.
 */
const stopsTheSweep = (outcome: DirectoryOutcome<DirectoryAttendeeAnswer> | null): boolean =>
  outcome !== null && !outcome.ok && (outcome.retryable || outcome.status === 401 || outcome.status === 403);

/**
 * THE FAILURES PAGE'S RETRY of a write-back — every child the outage left
 * waiting, not only the one the pressed run names (E2 review, finding 1).
 *
 * The page groups failures by (kind, name, error code), so every child one
 * outage left behind shares ONE group, and the page offers one Retry per
 * group, on its newest run. Sending only that run's child stranded the others:
 * every later press named a child already synced and sent nothing. So a press
 * sends, under each child's own id (a replay in the app, never a second child):
 *
 *   1. the child the pressed run names, first;
 *   2. then, oldest first and at most `WRITE_BACK_SWEEP_LIMIT` in all, every
 *      other child of the caller's operator, at a branch the caller may manage
 *      ops at, that still owes the app a write: each one `pending` (no answer,
 *      a fault, or never sent at all — the process stopped between the commit
 *      and the send) and each one `failed` with the pressed group's own error
 *      code (a refusal whose cause somebody fixed, such as the directory key);
 *   3. and stops at the first child the app still does not answer, or whose
 *      key it refuses, because every other send would end the same way.
 *
 * A refusal of another kind is left alone: pressing Retry on an outage does
 * not repeat an unrelated refusal. The pressed run's branch was checked by the
 * ops route; the reach given here is the rest of the caller's.
 */
export async function retryAttendeeWriteBack(
  deps: EventWriteDeps,
  q: {
    operatorId: string;
    linkId: string;
    /** The pressed run's error code — its Failures group. */
    errorCode: string | null;
    /** Where the caller holds `admin:ops:manage`, inside the operator. */
    reach: BranchReach;
    requestId?: string | null;
    limit?: number;
  },
): Promise<WriteBackSweep> {
  const db = deps.db;
  const limit = Math.max(1, q.limit ?? WRITE_BACK_SWEEP_LIMIT);
  const meta = { requestId: q.requestId ?? null };
  const [row] = await db
    .select({ id: eventAttendeeLink.id, operatorId: eventAttendeeLink.operatorId })
    .from(eventAttendeeLink)
    .where(eq(eventAttendeeLink.id, q.linkId))
    .limit(1);
  if (!row || row.operatorId !== q.operatorId) throw errors.notFound('That attendee is not on record');

  let sent = 0;
  let synced = 0;
  const own = await sendAttendee(deps, row.id, meta);
  if (own.outcome) {
    sent += 1;
    if (own.row.syncState === 'synced') synced += 1;
  }
  let stoppedEarly = stopsTheSweep(own.outcome);

  // What this Retry reaches. `sync_state <> 'synced'` is the partial index's
  // own predicate, so the scan stays on the few rows that owe a write.
  const reachClause =
    q.reach.kind === 'operator'
      ? undefined
      : q.reach.branchIds.length === 0
        ? sql`false`
        : inArray(eventAttendeeLink.branchId, q.reach.branchIds);
  const sameGroupRefusal = q.errorCode
    ? and(
        eq(eventAttendeeLink.syncState, 'failed'),
        sql`starts_with(${eventAttendeeLink.syncError}, ${`${q.errorCode}:`})`,
      )
    : undefined;
  const waitingClause = and(
    eq(eventAttendeeLink.operatorId, q.operatorId),
    isNull(eventAttendeeLink.archivedAt),
    sql`${eventAttendeeLink.syncState} <> 'synced'`,
    sameGroupRefusal ? or(eq(eventAttendeeLink.syncState, 'pending'), sameGroupRefusal) : eq(eventAttendeeLink.syncState, 'pending'),
    reachClause,
  );

  if (!stoppedEarly && sent < limit) {
    const others = await db
      .select({ id: eventAttendeeLink.id })
      .from(eventAttendeeLink)
      // A waiting row with no stored body cannot be sent (`sendAttendee`
      // refuses one loudly), and the schema allows it for rounds this one
      // has not built. The sweep walks past such a row — it stays counted
      // as waiting below — rather than turning every press into an error
      // and stranding the children behind it.
      .where(and(waitingClause, ne(eventAttendeeLink.id, row.id), isNotNull(eventAttendeeLink.writeback)))
      .orderBy(asc(eventAttendeeLink.createdAt), asc(eventAttendeeLink.id))
      .limit(limit - sent);
    for (const other of others) {
      const pushed = await sendAttendee(deps, other.id, meta);
      if (!pushed.outcome) continue;
      sent += 1;
      if (pushed.row.syncState === 'synced') synced += 1;
      if (stopsTheSweep(pushed.outcome)) {
        stoppedEarly = true;
        break;
      }
    }
  }

  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(eventAttendeeLink)
    .where(waitingClause);
  return { link: own.row, sent, synced, waiting: left?.n ?? 0, stoppedEarly };
}

// --- Reads the roster and the party bill take from the POS's own record ---------

/**
 * The links of some events, not archived, oldest first — what a day's roster
 * adds to the seam's answer: the children the POS added that the OTO App does
 * not have yet, and the party walk-up charges.
 */
export async function linksOfEvents(
  db: Exec,
  q: { branchId: string; eventIds: readonly string[] },
): Promise<Array<LinkRow & { staffName: string | null }>> {
  if (q.eventIds.length === 0) return [];
  const rows = await db
    .select({ link: eventAttendeeLink, name: employee.name, nickname: employee.nickname })
    .from(eventAttendeeLink)
    .leftJoin(account, eq(account.id, eventAttendeeLink.accountId))
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(
      and(
        eq(eventAttendeeLink.branchId, q.branchId),
        inArray(eventAttendeeLink.otoappEventId, [...q.eventIds]),
        isNull(eventAttendeeLink.archivedAt),
      ),
    )
    .orderBy(asc(eventAttendeeLink.createdAt), asc(eventAttendeeLink.id));
  return rows.map((r) => ({ ...r.link, staffName: r.nickname?.trim() || r.name?.trim() || null }));
}

/** A party walk-up, as the party's bill shows it: "Walk-up guest — name" at the party-guest price. */
export function walkUpChargeOf(link: LinkRow & { staffName: string | null }, name: string): EventPartyWalkUpCharge {
  return {
    id: link.id,
    name,
    amountSatang: link.priceSnapshotSatang,
    chargedBy: link.staffName,
    chargedById: link.accountId,
    chargedAt: link.createdAt.toISOString(),
  };
}

// --- The branch's walk-up prices (Q8) ----------------------------------------------

/** `GET /branches/:branchId/event-drop-in-pricing`. */
export async function getEventDropInPricing(
  db: Exec,
  q: { operatorId: string; branchId: string },
): Promise<EventDropInPricingAnswer> {
  const clock = await branchClockOf(db, q.operatorId, q.branchId);
  const found = await dropInPricingOf(db, clock.id);
  return {
    branchId: clock.id,
    pricing: found.pricing,
    configured: found.configured,
    updatedAt: found.updatedAt?.toISOString() ?? null,
  };
}

/** `PUT /branches/:branchId/event-drop-in-pricing` — all three pairs, audited before and after. */
export async function putEventDropInPricing(
  db: Db,
  ctx: OpContext,
  q: { operatorId: string; accountId: string; branchId: string; pricing: EventDropInPricing; requestId?: string },
): Promise<EventDropInPricingAnswer> {
  const clock = await branchClockOf(db, q.operatorId, q.branchId);
  return withTx(db, ctx, 'event_pricing.update', async (tx) => {
    const before = await dropInPricingOf(tx, clock.id);
    const at = new Date();
    const values = {
      campDayWeekdaySatang: q.pricing.campDay.weekday,
      campDayWeekendSatang: q.pricing.campDay.weekend,
      eventDayWeekdaySatang: q.pricing.eventDay.weekday,
      eventDayWeekendSatang: q.pricing.eventDay.weekend,
      partyGuestWeekdaySatang: q.pricing.partyGuest.weekday,
      partyGuestWeekendSatang: q.pricing.partyGuest.weekend,
      updatedByAccountId: q.accountId,
      updatedAt: at,
    };
    await tx
      .insert(eventDropInPricing)
      .values({ branchId: clock.id, operatorId: q.operatorId, ...values })
      .onConflictDoUpdate({ target: eventDropInPricing.branchId, set: values });
    await audit.record(tx, {
      actorAccountId: q.accountId,
      operatorId: q.operatorId,
      branchId: clock.id,
      action: 'event_pricing.update',
      entityType: 'event_drop_in_pricing',
      entityId: clock.id,
      requestId: q.requestId,
      before: before.configured ? before.pricing : null,
      after: q.pricing,
    });
    return { branchId: clock.id, pricing: q.pricing, configured: true, updatedAt: at.toISOString() };
  });
}
