import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { account, employee, partySlipPrint, prepSlipPrint, printJob, sale, station } from '@oto/db';
import {
  PRINTING_PREP_STATIONS,
  clockOf,
  newId,
  partySlipFingerprint,
  prepSlipTargets,
  refundPrepSlips,
  salePrintRequests,
  wallClockMinutesInTz,
  type PartySlipDocument,
  type PartySlipHeld,
  type PartySlipStation,
  type PrepSlipDocument,
  type PrepSlipSource,
  type PrepSlipVariant,
  type PrintKind,
  type PrintingPrepStation,
  type SalePrintSnapshot,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { boxCompletedSale } from './band-food';
import { salePrintSnapshotOf, writeJob, type JobScope, type SalePrintJobView } from './sale-printing';
import type { Exec, Tx } from './tx';

/**
 * SCRUM-861 — THE VOID AND UPDATED-ITEMS SLIPS, queued (the owner, 8 and 12
 * November: "When an order, or an item in a birthday package, is cancelled,
 * send a void receipt and an updated-items receipt to the kitchen and bar").
 *
 * What goes on the slips is composed in `@oto/shared` (`prep-slips.ts`). This
 * file puts them on paper and on the record: one `pos.prep_slip_print` row per
 * slip, and for each a print job on the station's printer of its kind, written
 * exactly as a sale's prep ticket is (`writeJob`) — a job row and the box
 * command, the content fetched by the box from the record (`buildPrintDocument`
 * reads the row's document). A station with no box, or no printer of that
 * kind, gets the row as `no_printer` and nothing is queued, which is what a
 * sale's own ticket does (`NO_DEVICE_FOR_ROLE`).
 *
 * TWO SENDERS, one writer:
 *   - a REFUND (`queueRefundPrepSlips`, from `refundSale`): the stations that
 *     received a ticket for the sale — those with a kitchen or bar ticket job
 *     that was not skipped, or, for a sale the box closed offline, those the
 *     box printed one for — get their slips on the station that ticket printed
 *     on. Under a savepoint and never throwing: a slip that cannot be queued is
 *     a note and an audit row, and the refund stands;
 *   - a PARTY's plan changing after its slips printed (`party-slips.ts`,
 *     through `writePrepSlips` and the "last given" reader here).
 */

type SlipRow = typeof prepSlipPrint.$inferSelect;
type StationRow = typeof station.$inferSelect;
type SaleRow = typeof sale.$inferSelect;

/** The printout each prep station prints. */
export const KIND_OF_STATION: Record<PrintingPrepStation, PrintKind> = {
  kitchen: 'kitchen_ticket',
  bar: 'bar_ticket',
};

export interface PrepSlipTarget {
  station: PrintingPrepStation;
  variant: PrepSlipVariant;
  document: PrepSlipDocument;
  /** Where it prints; null when no station holds a printer for it (the row is `no_printer`). */
  stationRow: StationRow | null;
}

export interface WritePrepSlipsScope {
  operatorId: string;
  branchId: string;
  source: PrepSlipSource;
  saleId?: string | null;
  refundId?: string | null;
  eventId?: string | null;
  partyDate?: string | null;
  run?: number | null;
  /** A party's: the fingerprint of the plain slip each station now holds. */
  planFingerprintOf?: (station: PrintingPrepStation) => string;
  actorAccountId: string | null;
  actionId: string;
  requestId?: string;
  now: Date;
}

/**
 * Write the slips: a row each and, where the station has a printer for it,
 * the job and the box command. Kitchen before bar, each station's VOID before
 * its UPDATED, so a box that polls the oldest first hands the kitchen the void
 * before the correction.
 */
export async function writePrepSlips(
  tx: Tx,
  scope: WritePrepSlipsScope,
  targets: readonly PrepSlipTarget[],
): Promise<{ rows: SlipRow[]; jobs: SalePrintJobView[] }> {
  const rows: SlipRow[] = [];
  const jobs: SalePrintJobView[] = [];
  for (const [index, target] of targets.entries()) {
    const id = newId();
    let job: SalePrintJobView | null = null;
    if (target.stationRow?.boxId) {
      const jobScope: JobScope = {
        operatorId: scope.operatorId,
        branchId: scope.branchId,
        // Not the sale's own paper: a box that printed the sale offline refuses
        // a late FIRST print of a job carrying its id (`JobScope.saleId`), and
        // a void slip is exactly the paper it must not refuse.
        saleId: null,
        stationRow: target.stationRow,
        actorAccountId: scope.actorAccountId,
        actionId: scope.actionId,
        requestId: scope.requestId,
        now: scope.now,
      };
      job = await writeJob(
        tx,
        jobScope,
        { kind: KIND_OF_STATION[target.station], subjectType: 'prep_slip', subjectId: id },
        index,
      );
      jobs.push(job);
    }
    const printed = job?.status === 'queued';
    const [row] = await tx
      .insert(prepSlipPrint)
      .values({
        id,
        operatorId: scope.operatorId,
        branchId: scope.branchId,
        source: scope.source,
        saleId: scope.saleId ?? null,
        refundId: scope.refundId ?? null,
        eventId: scope.eventId ?? null,
        partyDate: scope.partyDate ?? null,
        run: scope.run ?? null,
        planFingerprint: scope.planFingerprintOf ? scope.planFingerprintOf(target.station) : null,
        station: target.station,
        variant: target.variant,
        status: printed ? 'printed' : 'no_printer',
        printJobId: printed && job ? job.id : null,
        document: target.document,
        printedAt: printed ? scope.now : null,
        requestedByAccountId: scope.actorAccountId,
        actionId: scope.actionId,
      })
      .returning();
    if (!row) throw new Error('the prep slip was not written');
    rows.push(row);
  }
  return { rows, jobs };
}

/** What the till's note says of a slip that was not queued. */
export function prepSlipNote(row: Pick<SlipRow, 'station' | 'variant' | 'status'>, stationName: string | null): string | null {
  if (row.status !== 'no_printer') return null;
  const word = row.variant === 'void' ? 'Void' : 'Updated';
  return `${word} slip for the ${row.station} not printed — no ${row.station} printer at ${stationName ?? 'this station'}`;
}

// --- A refund's slips -----------------------------------------------------------------

/** The newest kitchen or bar ticket job of a sale that reached a box: where that station's slips go. */
async function ticketJobOf(db: Exec, saleId: string, station: PrintingPrepStation) {
  const [row] = await db
    .select({ id: printJob.id, stationId: printJob.stationId })
    .from(printJob)
    .where(
      and(
        eq(printJob.subjectType, 'sale'),
        eq(printJob.subjectId, saleId),
        eq(printJob.kind, KIND_OF_STATION[station]),
        ne(printJob.status, 'skipped'),
      ),
    )
    .orderBy(desc(printJob.queuedAt), desc(printJob.id))
    .limit(1);
  return row ?? null;
}

/** Whether the platform ever queued a kitchen or bar ticket of this sale, skipped or not. */
async function platformRoutedTickets(db: Exec, saleId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: printJob.id })
    .from(printJob)
    .where(
      and(
        eq(printJob.subjectType, 'sale'),
        eq(printJob.subjectId, saleId),
        inArray(printJob.kind, [KIND_OF_STATION.kitchen, KIND_OF_STATION.bar]),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * A sale the box closed OFFLINE printed its kitchen and bar tickets on the box
 * itself, from `salePrintRequests` of its snapshot (`box-agent` `sale-queue.ts`),
 * and was filed here with `printing: 'skip'`: no ticket job of the platform's
 * says which stations had it. The same composer says it here, on the sale's own
 * station — the one the box printed the tickets on.
 */
async function boxPrintedTickets(
  db: Exec,
  saleRow: SaleRow,
  snapshot: () => Promise<SalePrintSnapshot>,
): Promise<PrintingPrepStation[]> {
  if (!saleRow.stationId) return [];
  if (saleRow.origin !== 'box' && !(await boxCompletedSale(db, saleRow.id))) return [];
  if (await platformRoutedTickets(db, saleRow.id)) return [];
  const kinds = new Set<PrintKind>(salePrintRequests(await snapshot()).map((r) => r.kind));
  return PRINTING_PREP_STATIONS.filter((st) => kinds.has(KIND_OF_STATION[st]));
}

/** The person as the slip names them: the employee's nickname, else their name; null when nothing names the account. */
async function staffNameOf(db: Exec, accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(eq(account.id, accountId))
    .limit(1);
  return row?.nickname ?? row?.name ?? null;
}

export interface RefundPrepSlipsInput {
  saleRow: SaleRow;
  refund: {
    id: string;
    number: string;
    coveredLineIds: readonly string[];
    earlierLineIds: readonly string[];
    full: boolean;
  };
  actor: { accountId: string; operatorId: string; requestId?: string };
  actionId?: string | null;
  now: Date;
}

export interface RefundPrepSlipsResult {
  rows: SlipRow[];
  /** The non-blocking sentences the till may show; empty when every slip was queued or none was due. */
  notes: string[];
}

/**
 * THE REFUND'S SLIPS: for each station that received a ticket for the sale, a
 * VOID slip of the lines this refund cancelled there and an UPDATED slip of
 * what it still has to make, on the station the ticket printed on. A station
 * whose ticket was skipped for want of a printer never had the order and gets
 * nothing; a sale with no kitchen or bar lines queues nothing and reads
 * nothing. Replaying the refund (its action id) never reaches here, and the
 * record refuses a second slip of a kind per refund and station regardless.
 *
 * Under a savepoint and never throws: the refund stands whatever the slips do.
 */
export async function queueRefundPrepSlips(tx: Tx, input: RefundPrepSlipsInput): Promise<RefundPrepSlipsResult> {
  const { saleRow, refund, actor, now } = input;
  try {
    return await tx.transaction(async (sp) => {
      let snapshot: SalePrintSnapshot | null = null;
      const snapshotOf = async () => (snapshot ??= await salePrintSnapshotOf(sp, saleRow));
      const tickets: Partial<Record<PrintingPrepStation, { stationId: string | null }>> = {};
      for (const st of PRINTING_PREP_STATIONS) {
        const job = await ticketJobOf(sp, saleRow.id, st);
        if (job) tickets[st] = job;
      }
      // Closed offline: the box printed the tickets, on the sale's station.
      if (PRINTING_PREP_STATIONS.some((st) => !tickets[st])) {
        for (const st of await boxPrintedTickets(sp, saleRow, snapshotOf)) {
          tickets[st] ??= { stationId: saleRow.stationId };
        }
      }
      if (Object.keys(tickets).length === 0) return { rows: [], notes: [] };

      const slips = refundPrepSlips({
        snapshot: await snapshotOf(),
        refund: {
          number: refund.number,
          coveredLineIds: refund.coveredLineIds,
          earlierLineIds: refund.earlierLineIds,
          full: refund.full,
          byName: await staffNameOf(sp, actor.accountId),
        },
        time: clockOf(wallClockMinutesInTz(now, saleRow.timezone)),
      });
      const wanted = prepSlipTargets(slips).filter((t) => tickets[t.station]);
      if (wanted.length === 0) return { rows: [], notes: [] };

      const stationIds = [...new Set(wanted.map((t) => tickets[t.station]?.stationId).filter((id): id is string => !!id))];
      const stations = stationIds.length
        ? await sp.select().from(station).where(inArray(station.id, stationIds))
        : [];
      const targets: PrepSlipTarget[] = wanted.map((t) => ({
        ...t,
        stationRow: stations.find((s) => s.id === tickets[t.station]?.stationId) ?? null,
      }));
      const { rows } = await writePrepSlips(
        sp,
        {
          operatorId: saleRow.operatorId,
          branchId: saleRow.branchId,
          source: 'refund',
          saleId: saleRow.id,
          refundId: refund.id,
          actorAccountId: actor.accountId,
          actionId: input.actionId ?? newId(),
          requestId: actor.requestId,
          now,
        },
        targets,
      );
      const notes = rows
        .map((r, i) => prepSlipNote(r, targets[i]?.stationRow?.name ?? null))
        .filter((n): n is string => n !== null);
      await audit.record(sp, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        branchId: saleRow.branchId,
        action: 'sale.void_slips',
        entityType: 'sale',
        entityId: saleRow.id,
        actionId: input.actionId ?? null,
        requestId: actor.requestId,
        after: {
          refundId: refund.id,
          slips: rows.map((r) => ({ id: r.id, station: r.station, variant: r.variant, status: r.status, printJobId: r.printJobId })),
          notes,
        },
      });
      return { rows, notes };
    });
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'PREP_SLIPS_FAILED';
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: saleRow.branchId,
      action: 'sale.void_slips_failed',
      entityType: 'sale',
      entityId: saleRow.id,
      actionId: input.actionId ?? null,
      requestId: actor.requestId,
      after: { refundId: refund.id, error: code },
    });
    return { rows: [], notes: ['Void slips could not be queued for the kitchen and bar — tell them by hand'] };
  }
}

// --- A party's slips: what each station was last given -----------------------------

/**
 * What each station holds for a party on its day: the newest of the party's
 * printed slips (`pos.party_slip_print`, SCRUM-805) and of the change slips
 * here. A change run that sent a station a VOID slip and no UPDATED slip left
 * it holding nothing. Null for a station that was last given nothing.
 */
export async function partySlipsLastGiven(
  db: Exec,
  q: { eventId: string; partyDate: string },
): Promise<Record<PartySlipStation, PartySlipHeld | null>> {
  const eventId = q.eventId.toLowerCase();
  const printed = await db
    .select()
    .from(partySlipPrint)
    .where(and(eq(partySlipPrint.eventId, eventId), eq(partySlipPrint.partyDate, q.partyDate)))
    .orderBy(asc(partySlipPrint.createdAt), asc(partySlipPrint.run));
  const changed = await db
    .select()
    .from(prepSlipPrint)
    .where(and(eq(prepSlipPrint.eventId, eventId), eq(prepSlipPrint.partyDate, q.partyDate)))
    .orderBy(asc(prepSlipPrint.createdAt), asc(prepSlipPrint.run));

  const out: Record<PartySlipStation, PartySlipHeld | null> = { kitchen: null, bar: null };
  for (const st of PRINTING_PREP_STATIONS) {
    const lastPrinted = printed.filter((r) => r.station === st).at(-1);
    const runs = changed.filter((r) => r.station === st);
    const lastRun = runs.at(-1)?.run ?? null;
    const lastChange = lastRun === null ? [] : runs.filter((r) => r.run === lastRun);
    const changeAt = lastChange[0]?.createdAt ?? null;
    const printedAt = lastPrinted?.createdAt ?? null;
    if (changeAt && (!printedAt || changeAt.getTime() >= printedAt.getTime())) {
      const updated = lastChange.find((r) => r.variant === 'updated');
      const fingerprint = lastChange[0]?.planFingerprint ?? partySlipFingerprint(null);
      if (!updated) {
        out[st] = null;
        continue;
      }
      const document = updated.document as PrepSlipDocument;
      out[st] = { fingerprint, lines: document.lines, orderRef: document.orderRef };
      continue;
    }
    const document = (lastPrinted?.document ?? null) as PartySlipDocument | null;
    out[st] = document
      ? { fingerprint: partySlipFingerprint(document), lines: document.lines, orderRef: document.orderRef }
      : null;
  }
  return out;
}

/** The next change run of a party on its day: one more than the last, 1 for the first. */
export async function nextPartyChangeRun(db: Exec, q: { eventId: string; partyDate: string }): Promise<number> {
  const rows = await db
    .select({ run: prepSlipPrint.run })
    .from(prepSlipPrint)
    .where(and(eq(prepSlipPrint.eventId, q.eventId.toLowerCase()), eq(prepSlipPrint.partyDate, q.partyDate)));
  return rows.reduce((most, r) => Math.max(most, r.run ?? 0), 0) + 1;
}

/** The slips of one refund, kitchen before bar, void before updated: for a read of the sale. */
export async function prepSlipsOfRefund(db: Exec, refundId: string): Promise<SlipRow[]> {
  const rows = await db.select().from(prepSlipPrint).where(eq(prepSlipPrint.refundId, refundId));
  const order = (r: SlipRow) => (r.station === 'kitchen' ? 0 : 2) + (r.variant === 'void' ? 0 : 1);
  return rows.sort((a, b) => order(a) - order(b));
}
