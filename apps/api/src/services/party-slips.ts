import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  account,
  branch,
  employee,
  partySlipPrint,
  prepSlipPrint,
  printJob,
  product,
  station,
  type Db,
} from '@oto/db';
import {
  PARTY_SLIP_STATIONS,
  businessDate,
  clockMinutes,
  clockOf,
  composePartySlips,
  newId,
  parseDayStart,
  partySlipsTime,
  reprintRootOf,
  wallClockMinutesInTz,
  type PartyPlan,
  type PartySlipRecordView,
  type PartySlipStation,
  type PartySlipStatus,
  type PartySlipTrigger,
  type PartySlipsPrintAnswer,
  type PartySlipsView,
  type PrintJobStatus,
  partyPrepSlips,
  partySlipFingerprint,
  prepSlipTargets,
  type PartySlipDocument,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { JobFailedError } from './job-failure';
import { resolveItemPrepStations } from './menu';
import { getBranchEvent, listEventPackagesOn, OtoAppSeamNotGrantedError, type SeamEvent } from './otoapp-events';
import { partyPlanOfRow, readPartyPlan } from './party-plan';
import { overlayPartyEdits, partyLedgersOf } from './party-tab';
import { nextPartyChangeRun, partySlipsLastGiven, writePrepSlips } from './prep-slips';
import { routeOnBox } from './print';
import { writeJob, type JobScope } from './sale-printing';
import { withTx, type Exec, type OpContext, type Tx } from './tx';

/**
 * SCRUM-805 — A PARTY'S KITCHEN AND BAR SLIPS AT A SET TIME (birthday plan §5;
 * the owner's decision 3 of 2026-11-09).
 *
 * At each party's slip time on its day — the BEO's own, 11:00 when it names
 * none — `job:parties.slips` prints the party's kitchen slip and bar slip once,
 * from the set menu and bar plan the OTO App publishes for it
 * (`readPartyPlan`, the SCRUM-804 reader), to the kitchen and bar printers of
 * the station the branch names (`core.branch.party_slips_station_id`). "Print
 * party slips now" on the party page prints them again.
 *
 * ONE RUN, ONE ROW PER STATION (`pos.party_slip_print`), under a transaction
 * lock on the party's day, so the job on two instances, or the job and a press
 * at the same moment, make one run each and never the same run twice:
 *
 *   - `printed` — queued to the station's printer of its kind, exactly as a
 *     sale's prep ticket is (`writeJob`): a print job row and the box command,
 *     the content fetched by the box from the record (`buildPrintDocument`);
 *   - `no_printer` — no station named for the park, or the named station has
 *     no printer of that kind: nothing is queued, the party page says so (the
 *     owner: "until a station is tagged for a park, the job records no
 *     printer");
 *   - `nothing_to_print` — the plan has nothing for that station.
 *
 * The job prints a party once a day: once its own scheduled run is recorded
 * for the party's day, it leaves the party alone. A press of "Print party
 * slips now" is a reprint and never stands in for that run: the plan prints at
 * the slip time and keeps the button for a reprint (§5). A press always prints.
 */

/** Named once: the runner, the tests, the Health page. */
export const PARTY_SLIPS_JOB = 'job:parties.slips';

type SlipRow = typeof partySlipPrint.$inferSelect;
type StationRow = typeof station.$inferSelect;

interface BranchRow {
  id: string;
  operatorId: string;
  name: string;
  timezone: string;
  businessDayStart: string;
  partySlipsStationId: string | null;
}

async function branchOf(db: Exec, operatorId: string, branchId: string): Promise<BranchRow> {
  const [row] = await db
    .select({
      id: branch.id,
      operatorId: branch.operatorId,
      name: branch.name,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
      partySlipsStationId: branch.partySlipsStationId,
    })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Branch not found');
  return row;
}

/** The station the branch names for its party slips, while it stands; null when none is named. */
async function slipStationOf(db: Exec, b: BranchRow): Promise<StationRow | null> {
  if (!b.partySlipsStationId) return null;
  const [row] = await db
    .select()
    .from(station)
    .where(
      and(
        eq(station.id, b.partySlipsStationId),
        eq(station.branchId, b.id),
        eq(station.operatorId, b.operatorId),
        isNull(station.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The party as the party page shows it: the OTO App's event with the till's edits laid over. */
async function partyShown(db: Exec, branchId: string, eventId: string): Promise<SeamEvent | null> {
  const event = await getBranchEvent(db, { branchId, eventId });
  if (!event || event.type !== 'party') return null;
  const ledgers = (await partyLedgersOf(db, { branchId, eventIds: [event.id] })).get(event.id);
  return ledgers ? overlayPartyEdits(event, ledgers.edits) : event;
}

/**
 * Where each till product the set menu names prints, by its code: the item's
 * override, else its category's — `resolveItemPrepStations`, the rule a sale's
 * prep ticket is routed by. A code no live product of the operator carries is
 * absent, and its line is the kitchen's by name.
 */
async function prepStationsByCode(
  db: Exec,
  operatorId: string,
  codes: readonly string[],
): Promise<Map<string, 'kitchen' | 'bar' | 'none'>> {
  const wanted = [...new Set(codes)];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), inArray(product.code, wanted), isNull(product.archivedAt)));
  const resolved = await resolveItemPrepStations(db, rows);
  const out = new Map<string, 'kitchen' | 'bar' | 'none'>();
  for (const row of rows) {
    const prep = resolved.get(row.id);
    if (row.code && prep) out.set(row.code, prep);
  }
  return out;
}

/** "HH:MM" of an instant on the park's clock. */
const clockAt = (instant: Date, timezone: string): string => clockOf(wallClockMinutesInTz(instant, timezone));

/** Kitchen first, then bar, newest run first. */
const STATION_ORDER: Record<PartySlipStation, number> = { kitchen: 0, bar: 1 };

/** A party's slips on its day, newest run first, as the party page shows them. */
async function slipRecordsOf(
  db: Exec,
  q: { eventId: string; partyDate: string; timezone: string },
): Promise<PartySlipRecordView[]> {
  const rows = await db
    .select({
      slip: partySlipPrint,
      jobStatus: printJob.status,
      name: employee.name,
      nickname: employee.nickname,
    })
    .from(partySlipPrint)
    .leftJoin(printJob, eq(printJob.id, partySlipPrint.printJobId))
    .leftJoin(account, eq(account.id, partySlipPrint.requestedByAccountId))
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(and(eq(partySlipPrint.eventId, q.eventId.toLowerCase()), eq(partySlipPrint.partyDate, q.partyDate)));
  return rows
    .sort((a, b) => b.slip.run - a.slip.run || STATION_ORDER[a.slip.station] - STATION_ORDER[b.slip.station])
    .map((r) => recordViewOf(r.slip, q.timezone, (r.jobStatus as PrintJobStatus | null) ?? null, r.nickname ?? r.name ?? null));
}

function recordViewOf(
  slip: SlipRow,
  timezone: string,
  jobStatus: PrintJobStatus | null,
  requestedByName: string | null,
): PartySlipRecordView {
  return {
    id: slip.id,
    station: slip.station,
    run: slip.run,
    trigger: slip.trigger,
    status: slip.status,
    at: clockAt(slip.printedAt ?? slip.createdAt, timezone),
    printJobId: slip.printJobId,
    jobStatus,
    requestedByName,
    createdAt: slip.createdAt.toISOString(),
  };
}

/**
 * A party's slips on its day: its slip time, the station the park names, the
 * newest run's slip per station and every run. For `GET /parties/:id` and the
 * print answer.
 */
export async function partySlipsView(
  db: Exec,
  q: { operatorId: string; branchId: string; eventId: string; plan: Pick<PartyPlan, 'partyDate' | 'kitchen'> },
): Promise<PartySlipsView> {
  const b = await branchOf(db, q.operatorId, q.branchId);
  const named = await slipStationOf(db, b);
  const records = await slipRecordsOf(db, { eventId: q.eventId, partyDate: q.plan.partyDate, timezone: b.timezone });
  const latestOf = (st: PartySlipStation) => records.find((r) => r.station === st) ?? null;
  return {
    partyDate: q.plan.partyDate,
    slipsTime: partySlipsTime(q.plan),
    station: named ? { id: named.id, name: named.name } : null,
    latest: { kitchen: latestOf('kitchen'), bar: latestOf('bar') },
    records,
  };
}

// --- Printing one run --------------------------------------------------------------

export interface PrintPartySlipsInput {
  operatorId: string;
  branchId: string;
  eventId: string;
  trigger: PartySlipTrigger;
  /** Who pressed "Print party slips now"; null for the job. */
  actorAccountId: string | null;
  /** The press, or the job's tick: a press again under the same id answers the run it made. */
  actionId: string;
  requestId?: string;
  now: Date;
}

export type PrintPartySlipsResult =
  | { outcome: 'printed'; run: number; partyDate: string; plan: PartyPlan; slips: SlipRow[]; replayed: boolean }
  /** The job found its own scheduled run already recorded for the party's day. */
  | { outcome: 'already' }
  /** The job leaves a cancelled or archived party alone. */
  | { outcome: 'skipped' };

/** Refused: the OTO App publishes no plan for this party, so there is nothing to print. */
export const PARTY_NO_PLAN = {
  code: 'PARTY_NO_PLAN',
  message: 'The OTO App has no birthday package for this party, so it has no kitchen or bar slips to print',
} as const;

/**
 * ONE RUN of a party's slips, inside the caller's transaction: the kitchen
 * slip and the bar slip composed from the plan, each queued to the named
 * station's printer of its kind or recorded as not queued, and an audit row.
 */
export async function printPartySlips(tx: Tx, input: PrintPartySlipsInput): Promise<PrintPartySlipsResult> {
  const read = await readPartyPlan(tx, { branchId: input.branchId, eventId: input.eventId });
  if (read.status === 'seam_not_granted') {
    const missing = new OtoAppSeamNotGrantedError(['SELECT on the OTO App event packages view']);
    throw new AppError(503, 'EVENTS_SEAM_NOT_GRANTED', missing.message, { missing: missing.missing });
  }
  const plan = read.plan;
  if (!plan) throw new AppError(409, PARTY_NO_PLAN.code, PARTY_NO_PLAN.message);
  const eventId = plan.eventId.toLowerCase();
  const partyDate = plan.partyDate;

  // One run at a time per party and day: the job on two instances, or the job
  // and a press, decide one after the other on what the last one recorded.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`party-slips:${eventId}:${partyDate}`}, 0))`);
  const earlier = await tx
    .select()
    .from(partySlipPrint)
    .where(and(eq(partySlipPrint.eventId, eventId), eq(partySlipPrint.partyDate, partyDate)));
  const pressed = earlier.filter((r) => r.trigger === 'reprint' && r.actionId === input.actionId);
  if (input.trigger === 'reprint' && pressed.length > 0) {
    const run = pressed[0]!.run;
    return { outcome: 'printed', run, partyDate, plan, slips: earlier.filter((r) => r.run === run), replayed: true };
  }
  // The job's own run for the day, never a press, is what it does once.
  if (input.trigger === 'schedule' && earlier.some((r) => r.trigger === 'schedule')) return { outcome: 'already' };

  const party = await partyShown(tx, input.branchId, eventId);
  if (!party) throw errors.notFound('Party not found');
  if (input.trigger === 'schedule' && (party.archived || party.status === 'cancelled')) return { outcome: 'skipped' };

  const b = await branchOf(tx, input.operatorId, input.branchId);
  const named = await slipStationOf(tx, b);
  const codes = plan.setMenu.map((m) => m.productCode).filter((c): c is string => !!c);
  const prep = await prepStationsByCode(tx, input.operatorId, codes);
  const documents = composePartySlips({
    plan,
    partyName: party.title,
    location: party.location,
    prepStationOf: (code) => prep.get(code) ?? null,
    printedAt: clockAt(input.now, b.timezone),
  });

  const run = earlier.reduce((most, r) => Math.max(most, r.run), 0) + 1;
  const slips: SlipRow[] = [];
  for (const [index, st] of PARTY_SLIP_STATIONS.entries()) {
    const document = documents[st];
    const id = newId();
    const base = {
      id,
      operatorId: input.operatorId,
      branchId: input.branchId,
      eventId,
      partyDate,
      station: st,
      run,
      trigger: input.trigger,
      requestedByAccountId: input.actorAccountId,
      actionId: input.actionId,
    };
    const routed =
      document && named?.boxId ? await routeOnBox(tx, named.boxId, st, named.id) : null;
    let status: PartySlipStatus;
    let printJobId: string | null = null;
    if (!document) status = 'nothing_to_print';
    else if (!routed || !named) status = 'no_printer';
    else {
      // A press after a slip that printed is a copy of it, named as History names one.
      const before = earlier
        .filter((r) => r.station === st && r.printJobId)
        .sort((a, b2) => b2.run - a.run)[0];
      const [original] = before?.printJobId
        ? await tx.select().from(printJob).where(eq(printJob.id, before.printJobId)).limit(1)
        : [];
      const scope: JobScope = {
        operatorId: input.operatorId,
        branchId: input.branchId,
        saleId: null,
        stationRow: named,
        actorAccountId: input.actorAccountId,
        actionId: input.actionId,
        requestId: input.requestId,
        now: input.now,
      };
      const job = await writeJob(
        tx,
        scope,
        {
          kind: st === 'kitchen' ? 'kitchen_ticket' : 'bar_ticket',
          subjectType: 'party_slip',
          subjectId: id,
          ...(input.trigger === 'reprint'
            ? {
                reprintOf: original ? reprintRootOf({ id: original.id, reprintOf: original.reprintOf }) : null,
                reprintReason: 'Print party slips now',
              }
            : {}),
        },
        index,
      );
      status = job.status === 'queued' ? 'printed' : 'no_printer';
      printJobId = status === 'printed' ? job.id : null;
    }
    const [row] = await tx
      .insert(partySlipPrint)
      .values({
        ...base,
        status,
        printJobId,
        document: document ?? null,
        printedAt: status === 'printed' ? input.now : null,
      })
      .returning();
    slips.push(row!);
  }

  await audit.record(tx, {
    actorAccountId: input.actorAccountId,
    operatorId: input.operatorId,
    branchId: input.branchId,
    action: 'party.slips_print',
    entityType: 'party',
    entityId: eventId,
    actionId: input.actionId,
    requestId: input.requestId,
    after: {
      partyDate,
      run,
      trigger: input.trigger,
      stationId: named?.id ?? null,
      slips: slips.map((s) => ({ id: s.id, station: s.station, status: s.status, printJobId: s.printJobId })),
    },
  });
  return { outcome: 'printed', run, partyDate, plan, slips, replayed: false };
}

/**
 * `POST /parties/:id/slips/print` — "Print party slips now": a new run,
 * whatever ran before. The answer is made inside the run's transaction, so an
 * `Idempotency-Key` stores the answer the route gives and nothing else.
 */
export async function printPartySlipsNow(
  db: Db,
  ctx: OpContext,
  q: { operatorId: string; branchId: string; eventId: string; actorAccountId: string; actionId: string; requestId?: string; now: Date },
): Promise<PartySlipsPrintAnswer> {
  return withTx(db, ctx, 'party.slips_print', async (tx) => {
    const result = await printPartySlips(tx, { ...q, trigger: 'reprint' });
    if (result.outcome !== 'printed') throw new Error('a press of Print party slips now always makes a run');
    const slips = await partySlipsView(tx, {
      operatorId: q.operatorId,
      branchId: q.branchId,
      eventId: q.eventId,
      plan: result.plan,
    });
    return { printed: slips.records.filter((r) => r.run === result.run), slips, replayed: result.replayed };
  });
}

// --- A plan changed after the slips printed (SCRUM-861) ---------------------------------

type PrepSlipRow = typeof prepSlipPrint.$inferSelect;

export interface PrintPartySlipChangesInput {
  operatorId: string;
  branchId: string;
  eventId: string;
  /** The day the slips printed for, as the record dates it. */
  partyDate: string;
  /** The job's tick. */
  actionId: string;
  now: Date;
}

export type PrintPartySlipChangesResult =
  /** No slip of the party's has printed for the day: the slip time will print the plan as it then is. */
  | { outcome: 'not_printed_yet' }
  /** Every station holds the slip the plan would print now. */
  | { outcome: 'unchanged' }
  | { outcome: 'printed'; run: number; cancelled: boolean; slips: PrepSlipRow[] };

/**
 * ONE LOOK at a party whose slips printed today (the owner, 12 November:
 * "when an order, or an item in a birthday package, is cancelled, send a void
 * receipt and an updated-items receipt to the kitchen and bar"): the slips
 * the plan would print now are composed exactly as the slip time composed
 * them, and each station holding something else is sent a VOID slip of what
 * it lost and an UPDATED slip of what it now makes (`partyPrepSlips`). A
 * cancelled, archived, deleted or moved party sends every station holding
 * lines its VOID slip and nothing else. The slips go to the printers of the
 * station the branch names, as the party's own slips did.
 *
 * ONE PAIR PER STATION PER CHANGE, never a storm: the job looks once a
 * minute, so however many saves the BEO makes in between, the kitchen gets
 * one correction; the row keeps the fingerprint of the slip the station now
 * holds, and the next look finds it unchanged and writes nothing. Under the
 * same lock as the slip time's run and a press of "Print party slips now".
 */
export async function printPartySlipChanges(
  tx: Tx,
  input: PrintPartySlipChangesInput,
): Promise<PrintPartySlipChangesResult> {
  const eventId = input.eventId.toLowerCase();
  const partyDate = input.partyDate;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`party-slips:${eventId}:${partyDate}`}, 0))`);
  const [given] = await tx
    .select({ id: partySlipPrint.id })
    .from(partySlipPrint)
    .where(and(eq(partySlipPrint.eventId, eventId), eq(partySlipPrint.partyDate, partyDate)))
    .limit(1);
  if (!given) return { outcome: 'not_printed_yet' };

  const read = await readPartyPlan(tx, { branchId: input.branchId, eventId });
  if (read.status === 'seam_not_granted') {
    const missing = new OtoAppSeamNotGrantedError(['SELECT on the OTO App event packages view']);
    throw new AppError(503, 'EVENTS_SEAM_NOT_GRANTED', missing.message, { missing: missing.missing });
  }
  const plan = read.plan;
  const party = await partyShown(tx, input.branchId, eventId);
  // No package any more, moved to another day, cancelled, archived or gone:
  // whatever the kitchen holds for today is not to be made.
  const cancelled =
    !plan || plan.partyDate !== partyDate || !party || party.archived || party.status === 'cancelled';
  const b = await branchOf(tx, input.operatorId, input.branchId);
  const time = clockAt(input.now, b.timezone);
  let after: Record<PartySlipStation, PartySlipDocument | null> = { kitchen: null, bar: null };
  if (!cancelled && plan && party) {
    const codes = plan.setMenu.map((m) => m.productCode).filter((c): c is string => !!c);
    const prep = await prepStationsByCode(tx, input.operatorId, codes);
    after = composePartySlips({
      plan,
      partyName: party.title,
      location: party.location,
      prepStationOf: (code) => prep.get(code) ?? null,
      printedAt: time,
    });
  }
  const before = await partySlipsLastGiven(tx, { eventId, partyDate });
  const targets = prepSlipTargets(partyPrepSlips({ before, after, cancelled, time }));
  if (targets.length === 0) return { outcome: 'unchanged' };

  const named = await slipStationOf(tx, b);
  const run = await nextPartyChangeRun(tx, { eventId, partyDate });
  const { rows } = await writePrepSlips(
    tx,
    {
      operatorId: input.operatorId,
      branchId: input.branchId,
      source: 'party',
      eventId,
      partyDate,
      run,
      planFingerprintOf: (st) => partySlipFingerprint(cancelled ? null : after[st]),
      actorAccountId: null,
      actionId: input.actionId,
      now: input.now,
    },
    targets.map((t) => ({ ...t, stationRow: named })),
  );
  await audit.record(tx, {
    actorAccountId: null,
    operatorId: input.operatorId,
    branchId: input.branchId,
    action: 'party.slips_change',
    entityType: 'party',
    entityId: eventId,
    actionId: input.actionId,
    after: {
      partyDate,
      run,
      cancelled,
      stationId: named?.id ?? null,
      slips: rows.map((s) => ({ id: s.id, station: s.station, variant: s.variant, status: s.status, printJobId: s.printJobId })),
    },
  });
  return { outcome: 'printed', run, cancelled, slips: rows };
}

/** The branch's parties whose slips printed for a day, by the OTO App's id. */
async function partiesWithSlipsOn(db: Exec, q: { branchId: string; date: string }): Promise<string[]> {
  const rows = await db
    .selectDistinct({ eventId: partySlipPrint.eventId })
    .from(partySlipPrint)
    .where(and(eq(partySlipPrint.branchId, q.branchId), eq(partySlipPrint.partyDate, q.date)));
  return rows.map((r) => r.eventId).sort();
}

// --- The job -------------------------------------------------------------------------

export interface PartySlipsJobSummary extends Record<string, unknown> {
  branches: number;
  parties: number;
  notDue: number;
  alreadyPrinted: number;
  skipped: number;
  runs: number;
  printed: number;
  noPrinter: number;
  nothingToPrint: number;
  /** SCRUM-861 — the parties whose slips printed today that were looked at, and the changes found. */
  changesLooked: number;
  changes: number;
  changePrinted: number;
  changeNoPrinter: number;
  failed: number;
}

/**
 * `job:parties.slips` — every live branch's parties of its trading day
 * (`businessDate` in the branch's zone, the day the till's party list shows)
 * whose slip time has passed on the park's clock and which have no scheduled
 * run recorded for the day yet (a press before it does not count): one run
 * each, the slips queued or recorded as not.
 * A party that cannot be printed is counted and the job fails naming how many,
 * after every other party has had its turn. Counts only in the detail.
 */
export async function runPartySlipsJob(db: Db, now: Date): Promise<PartySlipsJobSummary> {
  const branches = await db
    .select({
      id: branch.id,
      operatorId: branch.operatorId,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
    })
    .from(branch)
    .where(isNull(branch.archivedAt));
  const summary: PartySlipsJobSummary = {
    branches: branches.length,
    parties: 0,
    notDue: 0,
    alreadyPrinted: 0,
    skipped: 0,
    runs: 0,
    printed: 0,
    noPrinter: 0,
    nothingToPrint: 0,
    changesLooked: 0,
    changes: 0,
    changePrinted: 0,
    changeNoPrinter: 0,
    failed: 0,
  };
  for (const b of branches) {
    const date = businessDate(now, b.timezone, parseDayStart(b.businessDayStart));
    const clock = wallClockMinutesInTz(now, b.timezone);
    for (const row of await listEventPackagesOn(db, { branchId: b.id, date })) {
      summary.parties += 1;
      const plan = partyPlanOfRow(row);
      if (!plan) {
        summary.skipped += 1;
        continue;
      }
      if (clockMinutes(partySlipsTime(plan))! > clock) {
        summary.notDue += 1;
        continue;
      }
      // A cheap look for the job's own run before the lock; the run itself decides under it.
      const [done] = await db
        .select({ id: partySlipPrint.id })
        .from(partySlipPrint)
        .where(
          and(
            eq(partySlipPrint.eventId, plan.eventId.toLowerCase()),
            eq(partySlipPrint.partyDate, plan.partyDate),
            eq(partySlipPrint.trigger, 'schedule'),
          ),
        )
        .limit(1);
      if (done) {
        summary.alreadyPrinted += 1;
        continue;
      }
      try {
        const result = await withTx(
          db,
          { actorAccountId: null, operatorId: b.operatorId, branchId: b.id },
          'party.slips_print',
          (tx) =>
            printPartySlips(tx, {
              operatorId: b.operatorId,
              branchId: b.id,
              eventId: plan.eventId,
              trigger: 'schedule',
              actorAccountId: null,
              actionId: newId(),
              now,
            }),
        );
        if (result.outcome === 'already') summary.alreadyPrinted += 1;
        else if (result.outcome === 'skipped') summary.skipped += 1;
        else {
          summary.runs += 1;
          for (const s of result.slips) {
            if (s.status === 'printed') summary.printed += 1;
            else if (s.status === 'no_printer') summary.noPrinter += 1;
            else summary.nothingToPrint += 1;
          }
        }
      } catch {
        summary.failed += 1;
      }
    }
    // SCRUM-861 — the parties whose slips printed today: a plan that changed
    // since sends its stations VOID and UPDATED slips, one pair per change.
    for (const eventId of await partiesWithSlipsOn(db, { branchId: b.id, date })) {
      summary.changesLooked += 1;
      try {
        const result = await withTx(
          db,
          { actorAccountId: null, operatorId: b.operatorId, branchId: b.id },
          'party.slips_change',
          (tx) =>
            printPartySlipChanges(tx, {
              operatorId: b.operatorId,
              branchId: b.id,
              eventId,
              partyDate: date,
              actionId: newId(),
              now,
            }),
        );
        if (result.outcome !== 'printed') continue;
        summary.changes += 1;
        for (const s of result.slips) {
          if (s.status === 'printed') summary.changePrinted += 1;
          else summary.changeNoPrinter += 1;
        }
      } catch {
        summary.failed += 1;
      }
    }
  }
  if (summary.failed > 0) {
    throw new JobFailedError(
      'PARTY_SLIPS_FAILED',
      `${summary.failed} ${summary.failed === 1 ? "party's" : "parties'"} kitchen and bar slips could not be printed`,
      summary,
    );
  }
  return summary;
}
