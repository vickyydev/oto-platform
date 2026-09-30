import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  account,
  band,
  boxCommand,
  branch,
  child,
  device,
  employee,
  member,
  operator,
  paymentAttempt,
  printJob,
  printTemplate,
  sale,
  saleLine,
  station,
  visitChild,
} from '@oto/db';
import {
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  bandShortCode,
  formatTHB,
  groupPrepTickets,
  isoDateInTz,
  newId,
  reprintRootOf,
  summarizeTax,
  wallClockMinutesInTz,
  type PrintKind,
  type SaleReprintKind,
  type TaxBreakdown,
} from '@oto/shared';
import type {
  BandData,
  ItemVoucherData,
  PrepTicketData,
  PrintJob as RenderJob,
  ReceiptData,
} from '@oto/print';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { boxSettings } from './box';
import {
  BandKeyMissingError,
  bandsOfSale,
  mintSaleBands,
  recordBandReprint,
  type BandView,
} from './bands';
import { routeOnBox, templateTypeFor } from './print';
import type { Exec, Tx } from './tx';

/**
 * S2-11 — what a finalised sale puts on paper, and the paper History asks for
 * again.
 *
 * THE ROUTING IS THE PROTOTYPE'S, `lib/printRouting.tsx`, ported rule by rule:
 *
 *   - a TICKET sale (`ticketPrintJobs`): one receipt; a kids band per child
 *     and an adult band per adult (`sale.bracelets`, minted in `bands.ts`);
 *     one item voucher per socks / add-on / free-item grant, aggregated by
 *     label (`buildCreditGrants`), on the receipt printer. Credit vouchers and
 *     wallet grants are S2-14a and are not printed here;
 *   - an F&B order (`fnbPrintJobs`): one receipt carrying only the whole-order
 *     note, and one prep ticket per station that has items — kitchen, then
 *     bar (`groupPrepTickets`) — each with the allergy line, its own items'
 *     notes and the order note;
 *   - a SHOP sale: the receipt.
 *
 * A job whose station has no printer for its role is SKIPPED, not failed — the
 * prototype's "No printer assigned — Kitchen ticket not printed" note — and
 * the row says so (`NO_DEVICE_FOR_ROLE`), which is the `recordSkippedPrint`
 * shape (`services/print.ts`) written inside this transaction.
 *
 * PRINTING NEVER STOPS A SALE. Everything here runs under a SAVEPOINT inside
 * finalisation: a failure rolls back the printing and nothing else, the sale
 * closes with its money and its receipt number, and the answer carries a note
 * saying what did not print. The jobs themselves are rows and box commands
 * the box collects on its next poll; a printer out of paper is the box's
 * retry, long after this request has answered.
 *
 * NOTHING RENDERED IS STORED, and neither is anything a printout says. The job
 * row names its subject (`sale`, `band`, `sale_line`) and the command names
 * the job; the box asks `GET /box/v1/print-jobs/:id/document` for the content
 * when it prints (`buildPrintDocument` below). A receipt carries a member's
 * name, a kids band a child's allergy and a gate credential, and the command
 * history is a stored table rendered on a Console page — the reason
 * `edge.print_job` itself keeps no document (`schema/print.ts`). It is also
 * what makes a reprint pick up a correction: the document is built from the
 * ledger at the moment it prints.
 */

type SaleRow = typeof sale.$inferSelect;
type SaleLineRow = typeof saleLine.$inferSelect;
type StationRow = typeof station.$inferSelect;
type PrintJobRow = typeof printJob.$inferSelect;

/** The station-device role each kind prints on (`ROLE_FOR_KIND` in the box agent). */
const ROLE_OF: Record<PrintKind, string> = {
  receipt: 'receipt',
  kitchen_ticket: 'kitchen',
  bar_ticket: 'bar',
  kids_wristband: 'kids_band',
  adult_wristband: 'adult_band',
  credit_voucher: 'receipt',
  item_voucher: 'receipt',
  booth_voucher: 'receipt',
  test_page: 'receipt',
};

/** What each printout is called on the till's "not printed" note. */
const LABEL_OF: Record<PrintKind, string> = {
  receipt: 'Receipt',
  kitchen_ticket: 'Kitchen ticket',
  bar_ticket: 'Bar ticket',
  kids_wristband: 'Kids band',
  adult_wristband: 'Adult band',
  credit_voucher: 'Credit voucher',
  item_voucher: 'Item voucher',
  booth_voucher: 'Voucher',
  test_page: 'Test page',
};

/** The ticket units that are things to collect rather than admission (`buildCreditGrants`). */
const ITEM_VOUCHER_KINDS = new Set(['socks', 'addon', 'promo_item']);

// --- The jobs -------------------------------------------------------------------

/** One print job as the finalise answer, a reprint and the sale detail show it. */
export interface SalePrintJobView {
  id: string;
  kind: PrintKind;
  role: string | null;
  status: string;
  stationId: string | null;
  deviceId: string | null;
  deviceLabel: string | null;
  subjectType: string | null;
  subjectId: string | null;
  /** The ORIGINAL job this is a copy of, flattened (`reprintRootOf`). Null on a first print. */
  reprintOf: string | null;
  reprintReason: string | null;
  /**
   * Who asked for this printout, as a display name. A reprint carries the
   * account that requested it; a first print queued by the sale itself carries
   * none, so this is null there.
   */
  requestedByName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: string;
  finishedAt: string | null;
}

function jobViewOf(
  row: PrintJobRow,
  deviceLabel: string | null = null,
  requestedByName: string | null = null,
): SalePrintJobView {
  return {
    id: row.id,
    kind: row.kind,
    role: row.role,
    status: row.status,
    stationId: row.stationId,
    deviceId: row.deviceId,
    deviceLabel,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    reprintOf: row.reprintOf,
    reprintReason: row.reprintReason,
    requestedByName,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    queuedAt: row.queuedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** What printing a sale did, for the finalise answer. */
export interface SalePrintingResult {
  jobs: SalePrintJobView[];
  bands: BandView[];
  /**
   * The non-blocking sentences the till shows, as the prototype's
   * `dispatchPrintJobs` does: "Kitchen ticket not printed — no kitchen printer
   * at this station". Empty when everything was queued.
   */
  notes: string[];
  /** Set when printing itself failed and was rolled back; the sale is unaffected. */
  failed: { code: string; message: string } | null;
}

interface JobRequest {
  kind: PrintKind;
  subjectType: 'sale' | 'band' | 'sale_line';
  subjectId: string;
  reprintOf?: string | null;
  reprintReason?: string | null;
}

interface JobScope {
  operatorId: string;
  branchId: string;
  stationRow: StationRow;
  actorAccountId: string | null;
  actionId: string;
  requestId?: string;
  now: Date;
}

/**
 * Write one job: the row, and — when the station has a printer for its role —
 * the box command that makes the box print it. With no printer the row is
 * `skipped` and no command is written, which is `recordSkippedPrint`'s rule:
 * there is nothing for the box to try and no reason to wake it.
 *
 * The command is `test_print`, the box's one print command, carrying
 * `document: 'platform'`: the box fetches the content for this job id before it
 * prints (`GET /box/v1/print-jobs/:id/document`). Written with the CALLER'S
 * transaction handle, as the terminal's commands are (`payments/terminal.ts`),
 * so a box can never collect a command for a sale that rolled back.
 */
async function writeJob(tx: Tx, scope: JobScope, request: JobRequest, offsetMs: number): Promise<SalePrintJobView> {
  const role = ROLE_OF[request.kind];
  const boxId = scope.stationRow.boxId;
  if (!boxId) throw new Error('the station has no box');
  const routed = await routeOnBox(tx, boxId, role, scope.stationRow.id);
  const templateType = templateTypeFor(request.kind);
  const [template] = templateType
    ? await tx
        .select({ id: printTemplate.id, version: printTemplate.version })
        .from(printTemplate)
        .where(
          and(
            eq(printTemplate.branchId, scope.branchId),
            eq(printTemplate.type, templateType as never),
            isNull(printTemplate.archivedAt),
          ),
        )
        .limit(1)
    : [];
  const at = new Date(scope.now.getTime() + offsetMs);
  const id = newId();
  const [row] = await tx
    .insert(printJob)
    .values({
      id,
      operatorId: scope.operatorId,
      branchId: scope.branchId,
      boxId,
      stationId: scope.stationRow.id,
      deviceId: routed?.deviceId ?? null,
      role,
      kind: request.kind,
      templateId: template?.id ?? null,
      templateVersion: template?.version ?? null,
      copies: 1,
      status: routed ? 'queued' : 'skipped',
      ...(routed
        ? {}
        : {
            errorCode: 'NO_DEVICE_FOR_ROLE',
            errorMessage: `No ${role} printer is assigned to this station`,
            finishedAt: at,
          }),
      subjectType: request.subjectType,
      subjectId: request.subjectId,
      reprintOf: request.reprintOf ?? null,
      reprintReason: request.reprintReason ?? null,
      requestedByAccountId: scope.actorAccountId,
      actionId: scope.actionId,
      queuedAt: at,
    })
    .returning();
  if (!row) throw new Error('the print job was not written');
  if (routed) {
    await tx.insert(boxCommand).values({
      id: newId(),
      boxId,
      kind: 'test_print',
      payload: {
        printJobId: id,
        kind: request.kind,
        role,
        stationId: scope.stationRow.id,
        deviceId: routed.deviceId,
        copies: 1,
        /** The box fetches this job's content from the platform before it prints. */
        document: 'platform',
        subjectType: request.subjectType,
        ...(request.reprintOf ? { reprintOf: request.reprintOf } : {}),
      } as never,
      requestedByAccountId: scope.actorAccountId,
      actionId: scope.actionId,
      expiresAt: new Date(at.getTime() + boxSettings().commandTtlS * 1000),
      // Created in the order the jobs were asked for, so a box that polls the
      // oldest first prints the receipt before the vouchers behind it.
      createdAt: at,
      updatedAt: at,
    });
  }
  return jobViewOf(row);
}

function noteFor(job: SalePrintJobView): string | null {
  if (job.status !== 'skipped') return null;
  const role = job.role ?? 'printer';
  return `${LABEL_OF[job.kind]} not printed — no ${role.replace('_', ' ')} printer at this station`;
}

async function linesOf(db: Exec, saleId: string): Promise<SaleLineRow[]> {
  return db.select().from(saleLine).where(eq(saleLine.saleId, saleId)).orderBy(asc(saleLine.lineNo));
}

/** The item vouchers a ticket sale's lines owe: one per label, the first line standing for the group. */
function itemVoucherGroups(lines: readonly SaleLineRow[]): { lineId: string; label: string; quantity: number }[] {
  const groups = new Map<string, { lineId: string; label: string; quantity: number }>();
  for (const line of lines) {
    if (!ITEM_VOUCHER_KINDS.has(line.kind) || line.quantity <= 0) continue;
    const found = groups.get(line.label);
    if (found) found.quantity += line.quantity;
    else groups.set(line.label, { lineId: line.id, label: line.label, quantity: line.quantity });
  }
  return [...groups.values()];
}

/**
 * THE FINALISATION HOOK: mint the sale's bands and queue everything it prints.
 *
 * Called by `finaliseSale` and by `commitSale`'s ฿0 close, inside their
 * transaction, after the receipt number is allocated. Runs under a savepoint
 * and never throws: whatever goes wrong comes back in `failed` and `notes`,
 * and an audit row records it beside the sale.
 */
export async function routeSalePrinting(
  tx: Tx,
  saleRow: SaleRow,
  opts: { actorAccountId: string | null; operatorId: string; actionId?: string | null; requestId?: string; now?: Date },
): Promise<SalePrintingResult> {
  const now = opts.now ?? new Date();
  try {
    return await tx.transaction(async (sp) => {
      const [stationRow] = await sp.select().from(station).where(eq(station.id, saleRow.stationId)).limit(1);
      if (!stationRow?.boxId) {
        return {
          jobs: [],
          bands: [],
          notes: ['Nothing printed — this station is not attached to a box'],
          failed: null,
        };
      }
      const lines = await linesOf(sp, saleRow.id);
      const scope: JobScope = {
        operatorId: saleRow.operatorId,
        branchId: saleRow.branchId,
        stationRow,
        actorAccountId: opts.actorAccountId,
        actionId: opts.actionId ?? newId(),
        requestId: opts.requestId,
        now,
      };
      const requests: JobRequest[] = [{ kind: 'receipt', subjectType: 'sale', subjectId: saleRow.id }];
      const notes: string[] = [];

      const ticketLines = lines.filter((l) => l.ticketPackageId !== null);
      let bandRows: (typeof band.$inferSelect)[] = [];
      if (ticketLines.length > 0) {
        try {
          bandRows = (
            await mintSaleBands(sp, saleRow, stationRow.codePrefix ?? '', {
              stationId: stationRow.id,
              boxId: stationRow.boxId,
              now,
            })
          ).bands;
        } catch (err) {
          // Band minting must never take the receipt and the prep tickets down
          // with it. A missing key is the known case; anything else — a station
          // prefix from before the prefix rule, a band row refused — is noted
          // the same way, and the sale closes with its other printouts intact.
          if (err instanceof BandKeyMissingError) {
            notes.push('Bands not issued — this deployment has no band key');
          } else {
            const reason = err instanceof Error ? err.message : String(err);
            notes.push(`Bands not issued — ${reason}. Reprint them from History once it is put right`);
          }
        }
        for (const b of bandRows.filter((r) => r.kind === 'kid')) {
          requests.push({ kind: 'kids_wristband', subjectType: 'band', subjectId: b.id });
        }
        for (const b of bandRows.filter((r) => r.kind === 'adult')) {
          requests.push({ kind: 'adult_wristband', subjectType: 'band', subjectId: b.id });
        }
        for (const group of itemVoucherGroups(ticketLines)) {
          requests.push({ kind: 'item_voucher', subjectType: 'sale_line', subjectId: group.lineId });
        }
      }

      const fnbLines = lines.filter((l) => l.kind === 'fnb_item');
      for (const ticket of groupPrepTickets(fnbLines.map((l) => ({ id: l.id, prepStation: prepStationOf(l) })))) {
        requests.push({
          kind: ticket.station === 'kitchen' ? 'kitchen_ticket' : 'bar_ticket',
          subjectType: 'sale',
          subjectId: saleRow.id,
        });
      }

      const jobs: SalePrintJobView[] = [];
      for (const [index, request] of requests.entries()) {
        const job = await writeJob(sp, scope, request, index);
        jobs.push(job);
        const note = noteFor(job);
        if (note) notes.push(note);
        if (request.subjectType === 'band') {
          await sp
            .update(band)
            .set({ printedJobId: job.id, updatedAt: now })
            .where(eq(band.id, request.subjectId));
        }
      }

      await audit.record(sp, {
        actorAccountId: opts.actorAccountId,
        operatorId: opts.operatorId,
        branchId: saleRow.branchId,
        action: 'sale.print',
        entityType: 'sale',
        entityId: saleRow.id,
        actionId: scope.actionId,
        requestId: opts.requestId,
        after: {
          jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, subjectType: j.subjectType })),
          bandIds: bandRows.map((b) => b.id),
          notes,
        },
      });
      return { jobs, bands: await bandsOfSale(sp, saleRow.id), notes, failed: null };
    });
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'PRINT_ROUTING_FAILED';
    const message = 'Printing could not be queued for this sale — reprint it from History';
    await audit.record(tx, {
      actorAccountId: opts.actorAccountId,
      operatorId: opts.operatorId,
      branchId: saleRow.branchId,
      action: 'sale.print_failed',
      entityType: 'sale',
      entityId: saleRow.id,
      actionId: opts.actionId ?? null,
      requestId: opts.requestId,
      after: { error: code },
    });
    return { jobs: [], bands: [], notes: [message], failed: { code, message } };
  }
}

function prepStationOf(line: SaleLineRow): string | null {
  const payload = (line.payload ?? {}) as { prepStation?: string };
  return payload.prepStation ?? null;
}

// --- Reprints --------------------------------------------------------------------

export interface ReprintSaleInput {
  kind: SaleReprintKind;
  /** Where to print: the station the reprint was asked at; the sale's own when none. */
  stationId?: string | null;
  reason?: string | null;
  actionId: string;
}

export interface ReprintSaleResult {
  jobs: SalePrintJobView[];
  bands: BandView[];
  notes: string[];
}

/** The most recent job of these kinds for this subject — the original a reprint copies. */
async function latestJob(
  db: Exec,
  subjectType: string,
  subjectId: string,
  kinds: readonly PrintKind[],
): Promise<PrintJobRow | null> {
  const [row] = await db
    .select()
    .from(printJob)
    .where(
      and(
        eq(printJob.subjectType, subjectType),
        eq(printJob.subjectId, subjectId),
        inArray(printJob.kind, [...kinds]),
      ),
    )
    .orderBy(desc(printJob.queuedAt))
    .limit(1);
  return row ?? null;
}

/**
 * History's Reprint (`TransactionDetail.tsx:171-212`, `mockApi.ts:recordReprint`).
 *
 * The prototype only logged a reprint against the transaction; here it is the
 * print job itself, a NEW row whose `reprint_of` names the original — never the
 * copy it was made from (`reprintRootOf`) — with an audit row per job, which
 * is the history the prototype's `reprints` list was standing in for.
 *
 * A BAND reprint keeps the band: same row, same id, same code, fresh paper. The
 * band's `printed_job_id` moves to the new job and a `reprinted` event names
 * the job it replaced; `band.status` stays `active`, because it describes the
 * credential and the credential has not changed (a band that should stop
 * admitting is `revoked`, and a re-issued one is a new band that `replaced`
 * it). A ticket sale finalised while this deployment had no band key is issued
 * its bands here, by the same idempotent mint.
 */
export async function reprintSale(
  tx: Tx,
  actor: { accountId: string; operatorId: string; requestId?: string; stationId: string | null },
  saleRow: SaleRow,
  input: ReprintSaleInput,
  now: Date = new Date(),
): Promise<ReprintSaleResult> {
  if (!saleRow.receiptNumber || (saleRow.status !== 'finalised' && saleRow.status !== 'refunded')) {
    throw new AppError(409, 'SALE_NOT_FINALISED', 'Only a finalised sale has anything to reprint');
  }
  const stationId = input.stationId ?? actor.stationId ?? saleRow.stationId;
  const [stationRow] = await tx
    .select()
    .from(station)
    .where(and(eq(station.id, stationId), eq(station.operatorId, saleRow.operatorId)))
    .limit(1);
  if (!stationRow || stationRow.branchId !== saleRow.branchId) {
    throw new AppError(404, 'STATION_NOT_FOUND', 'No such station at this sale’s park');
  }
  if (!stationRow.boxId) {
    throw new AppError(409, 'STATION_HAS_NO_BOX', `${stationRow.name} is not attached to a box, so nothing on it can print`);
  }
  const reason = input.reason?.trim() || 'Reprint from History';
  const lines = await linesOf(tx, saleRow.id);
  const scope: JobScope = {
    operatorId: saleRow.operatorId,
    branchId: saleRow.branchId,
    stationRow,
    actorAccountId: actor.accountId,
    actionId: input.actionId,
    requestId: actor.requestId,
    now,
  };

  const requests: { request: JobRequest; bandRow?: typeof band.$inferSelect }[] = [];
  const copyOf = async (subjectType: JobRequest['subjectType'], subjectId: string, kind: PrintKind) => {
    const original = await latestJob(tx, subjectType, subjectId, [kind]);
    return original ? reprintRootOf({ id: original.id, reprintOf: original.reprintOf }) : null;
  };

  if (input.kind === 'receipt' || input.kind === 'merch_receipt') {
    requests.push({
      request: {
        kind: 'receipt',
        subjectType: 'sale',
        subjectId: saleRow.id,
        reprintOf: await copyOf('sale', saleRow.id, 'receipt'),
        reprintReason: reason,
      },
    });
  } else if (input.kind === 'prep') {
    const fnb = lines.filter((l) => l.kind === 'fnb_item');
    for (const ticket of groupPrepTickets(fnb.map((l) => ({ id: l.id, prepStation: prepStationOf(l) })))) {
      const kind: PrintKind = ticket.station === 'kitchen' ? 'kitchen_ticket' : 'bar_ticket';
      requests.push({
        request: {
          kind,
          subjectType: 'sale',
          subjectId: saleRow.id,
          reprintOf: await copyOf('sale', saleRow.id, kind),
          reprintReason: reason,
        },
      });
    }
  } else {
    const kind = input.kind === 'kids_bands' ? 'kid' : 'adult';
    let bands = await tx
      .select()
      .from(band)
      .where(and(eq(band.saleId, saleRow.id), eq(band.kind, kind)))
      .orderBy(asc(band.createdAt), asc(band.id));
    if (bands.length === 0 && lines.some((l) => l.ticketPackageId !== null)) {
      // A sale finalised with no band key: issue what it owes now.
      const minted = await mintSaleBands(tx, saleRow, stationRow.codePrefix ?? '', {
        stationId: stationRow.id,
        boxId: stationRow.boxId,
        now,
      }).catch((err: unknown) => {
        if (err instanceof BandKeyMissingError) {
          throw new AppError(503, 'BAND_KEY_MISSING', 'This deployment has no band key, so no band can be issued');
        }
        throw err;
      });
      bands = minted.bands.filter((b) => b.kind === kind);
    }
    for (const b of bands.filter((row) => row.status === 'active')) {
      const original = b.printedJobId
        ? await tx.select().from(printJob).where(eq(printJob.id, b.printedJobId)).limit(1)
        : [];
      const root = original[0]
        ? reprintRootOf({ id: original[0].id, reprintOf: original[0].reprintOf })
        : null;
      requests.push({
        request: {
          kind: kind === 'kid' ? 'kids_wristband' : 'adult_wristband',
          subjectType: 'band',
          subjectId: b.id,
          reprintOf: root,
          reprintReason: reason,
        },
        bandRow: b,
      });
    }
  }
  if (requests.length === 0) {
    throw new AppError(409, 'NOTHING_TO_REPRINT', `This sale has no ${input.kind.replace('_', ' ')} to reprint`);
  }

  const jobs: SalePrintJobView[] = [];
  const notes: string[] = [];
  for (const [index, { request, bandRow }] of requests.entries()) {
    const job = await writeJob(tx, scope, request, index);
    jobs.push(job);
    const note = noteFor(job);
    if (note) notes.push(note);
    if (bandRow) {
      await recordBandReprint(tx, bandRow, {
        printJobId: job.id,
        reason,
        stationId: stationRow.id,
        boxId: stationRow.boxId,
        accountId: actor.accountId,
      });
    }
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: saleRow.branchId,
      action: 'print_job.reprint',
      entityType: 'print_job',
      entityId: job.id,
      actionId: input.actionId,
      requestId: actor.requestId,
      after: {
        reprintOf: job.reprintOf,
        reason,
        kind: job.kind,
        saleId: saleRow.id,
        subjectType: job.subjectType,
        subjectId: job.subjectId,
        status: job.status,
      },
    });
  }
  return { jobs, bands: await bandsOfSale(tx, saleRow.id), notes };
}

/** Every print job for a sale, its bands and its lines, newest first. */
export async function printJobsOfSale(db: Exec, saleId: string): Promise<SalePrintJobView[]> {
  const bandIds = (await db.select({ id: band.id }).from(band).where(eq(band.saleId, saleId))).map((b) => b.id);
  const lineIds = (await db.select({ id: saleLine.id }).from(saleLine).where(eq(saleLine.saleId, saleId))).map(
    (l) => l.id,
  );
  const subjects = [and(eq(printJob.subjectType, 'sale'), eq(printJob.subjectId, saleId))];
  if (bandIds.length) subjects.push(and(eq(printJob.subjectType, 'band'), inArray(printJob.subjectId, bandIds)));
  if (lineIds.length) {
    subjects.push(and(eq(printJob.subjectType, 'sale_line'), inArray(printJob.subjectId, lineIds)));
  }
  const rows = await db
    .select({ job: printJob, deviceLabel: device.label })
    .from(printJob)
    .leftJoin(device, eq(device.id, printJob.deviceId))
    .where(or(...subjects))
    .orderBy(desc(printJob.queuedAt));
  // Attribution: reprints carry the account that asked for them. Resolve those
  // to display names in one lookup rather than per row.
  const requesterIds = [
    ...new Set(rows.map((r) => r.job.requestedByAccountId).filter((id): id is string => !!id)),
  ];
  const names = new Map<string, string>();
  if (requesterIds.length) {
    const staff = await db
      .select({ id: account.id, name: employee.name, nickname: employee.nickname })
      .from(account)
      .leftJoin(employee, eq(employee.id, account.employeeId))
      .where(inArray(account.id, requesterIds));
    for (const s of staff) {
      const label = s.nickname ?? s.name;
      if (label) names.set(s.id, label);
    }
  }
  return rows.map((r) =>
    jobViewOf(
      r.job,
      r.deviceLabel,
      r.job.requestedByAccountId ? names.get(r.job.requestedByAccountId) ?? null : null,
    ),
  );
}

// --- The document the box prints ------------------------------------------------

/** `2026-09-30 14:05` in the branch's own time. The renderer owns no clock. */
function stampIn(instant: Date, timezone: string): string {
  return `${isoDateInTz(instant, timezone)} ${hhmm(instant, timezone)}`;
}

function hhmm(instant: Date, timezone: string): string {
  const minutes = wallClockMinutesInTz(instant, timezone);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function lineName(line: SaleLineRow): string {
  const payload = (line.payload ?? {}) as {
    modifiers?: { optionName: string }[];
    variant?: { variantLabel: string };
  };
  const extras = [
    payload.variant?.variantLabel,
    ...(payload.modifiers ?? []).map((m) => m.optionName),
  ].filter((v): v is string => !!v);
  return extras.length ? `${line.label} (${extras.join(', ')})` : line.label;
}

function lineNote(line: SaleLineRow): string | undefined {
  const note = ((line.payload ?? {}) as { note?: string }).note?.trim();
  return note || undefined;
}

async function staffNameOf(db: Exec, accountId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(eq(account.id, accountId))
    .limit(1);
  return row?.nickname ?? row?.name ?? undefined;
}

/** How a tender reads on the receipt: "Cash", "Card •••• 4242", "QR". */
function tenderLabel(row: typeof paymentAttempt.$inferSelect): string {
  const token = row.methodCode ?? row.method;
  const word = token.charAt(0).toUpperCase() + token.slice(1).replace(/_/g, ' ');
  return row.last4 ? `${word} •••• ${row.last4}` : word;
}

/**
 * The allergy line for a prep ticket or a kids band: each child's allergies and
 * medical notes, named. On a kids band it is that child's; on a prep ticket
 * it is every child on the order's visit — or, with no visit, every child of
 * the member the order is for — because the kitchen cannot know which child a
 * plate is for and an allergy left off is the one mistake that matters. The
 * prototype read it off the scanned band's holder (`buildPrepTickets`); the
 * band-scan order is S2-14a, and this is the ledger's closest equivalent.
 */
function allergyTextOf(rows: { name: string; allergies: string | null; medicalNotes: string | null }[]): string | undefined {
  const parts = rows
    .map((c) => {
      const bits = [c.allergies?.trim(), c.medicalNotes?.trim()].filter((v): v is string => !!v);
      return bits.length ? `${c.name}: ${bits.join('; ')}` : null;
    })
    .filter((v): v is string => v !== null);
  return parts.length ? parts.join(' · ') : undefined;
}

async function orderChildren(db: Exec, saleRow: SaleRow) {
  if (saleRow.visitId) {
    return db
      .select({ name: child.name, allergies: child.allergies, medicalNotes: child.medicalNotes })
      .from(visitChild)
      .innerJoin(child, eq(child.id, visitChild.childId))
      .where(eq(visitChild.visitId, saleRow.visitId))
      .orderBy(asc(child.name));
  }
  if (!saleRow.memberId) return [];
  return db
    .select({ name: child.name, allergies: child.allergies, medicalNotes: child.medicalNotes })
    .from(child)
    .where(and(eq(child.memberId, saleRow.memberId), isNull(child.archivedAt)))
    .orderBy(asc(child.name));
}

/** The receipt's extra rows: every `summarizeTax` row, formatted. The template's `vat` is the included one. */
export interface ReceiptDocument extends ReceiptData {
  /** Each row of `summarizeTax(sale.tax_breakdown)`: service, VAT included, VAT added. */
  taxRows?: { label: string; amount: string; kind: string }[];
  /** True on a copy History asked for. */
  copy?: boolean;
}

export async function receiptDocument(db: Exec, saleRow: SaleRow, copy = false): Promise<ReceiptDocument> {
  const lines = await linesOf(db, saleRow.id);
  const [names] = await db
    .select({ operatorName: operator.name, branchName: branch.name })
    .from(branch)
    .innerJoin(operator, eq(operator.id, branch.operatorId))
    .where(eq(branch.id, saleRow.branchId))
    .limit(1);
  const [memberRow] = saleRow.memberId
    ? await db.select({ nickname: member.nickname }).from(member).where(eq(member.id, saleRow.memberId)).limit(1)
    : [];
  const attempts = await db
    .select()
    .from(paymentAttempt)
    .where(eq(paymentAttempt.saleId, saleRow.id))
    .orderBy(asc(paymentAttempt.createdAt));
  const taken = attempts.filter((a) => PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(a.status));
  const bands = await db
    .select({ code: band.code })
    .from(band)
    .where(eq(band.saleId, saleRow.id))
    .orderBy(asc(band.createdAt), asc(band.id));
  const rows = summarizeTax(saleRow.taxBreakdown as TaxBreakdown);
  const included = rows.filter((r) => r.kind === 'tax_included').reduce((sum, r) => sum + r.amount, 0);
  const service = rows.filter((r) => r.kind === 'service').reduce((sum, r) => sum + r.amount, 0);
  const tenders: { label: string; amount: string }[] = [];
  for (const attempt of taken) {
    tenders.push({ label: tenderLabel(attempt), amount: formatTHB(attempt.amountSatang) });
    if (attempt.tenderedSatang !== null && attempt.changeSatang !== null && attempt.changeSatang > 0) {
      tenders.push({ label: 'Cash tendered', amount: formatTHB(attempt.tenderedSatang) });
      tenders.push({ label: 'Change', amount: formatTHB(attempt.changeSatang) });
    }
  }
  const hasFnb = lines.some((l) => l.kind === 'fnb_item');
  const vouchers = itemVoucherGroups(lines.filter((l) => l.ticketPackageId !== null));
  return {
    title: copy ? 'Receipt (copy)' : 'Receipt',
    /**
     * The abbreviated tax-invoice header. The Thai title is the document's
     * name under the Revenue Code; the seller's tax id is the park's own
     * footer line on the receipt template, where the prototype kept it.
     * PROJECT_CONTEXT §8 leaves the full field list to the park's
     * accountant — this is a slot, filled with what the ledger knows.
     */
    taxInvoiceLines: [
      'ใบกำกับภาษีอย่างย่อ',
      'ABBREVIATED TAX INVOICE',
      ...(names ? [`${names.operatorName} · ${names.branchName}`] : []),
      ...(included > 0 ? ['VAT included'] : []),
    ],
    receiptNumber: saleRow.receiptNumber ?? undefined,
    dateTime: stampIn(saleRow.finalisedAt ?? saleRow.occurredAt, saleRow.timezone),
    staffName: await staffNameOf(db, saleRow.createdByAccountId),
    memberNickname: memberRow?.nickname || undefined,
    lines: lines
      .filter((l) => l.quantity > 0)
      .map((l) => ({ qty: l.quantity, name: lineName(l), price: formatTHB(l.grossSatang), note: lineNote(l) })),
    subtotal: formatTHB(saleRow.subtotalSatang),
    service: service > 0 ? formatTHB(service) : undefined,
    vat: included > 0 ? formatTHB(included) : undefined,
    total: formatTHB(saleRow.grossSatang),
    tenders,
    // The SHORT codes: a staff member matches a band to its sale by them, and
    // a receipt carrying the signed code would be a second gate credential.
    bandCodes: bands.map((b) => bandShortCode(b.code)).filter((c): c is string => c !== null),
    creditGrants: vouchers.map((v) => `${v.quantity}× ${v.label} to collect`),
    orderNote: hasFnb && saleRow.note ? saleRow.note : undefined,
    taxRows: rows.map((r) => ({ label: r.label, amount: formatTHB(r.amount), kind: r.kind })),
    copy,
  };
}

export async function prepDocument(
  db: Exec,
  saleRow: SaleRow,
  stationKind: 'kitchen' | 'bar',
): Promise<PrepTicketData> {
  const lines = (await linesOf(db, saleRow.id)).filter((l) => l.kind === 'fnb_item');
  const ticket = groupPrepTickets(lines.map((l) => ({ ...l, prepStation: prepStationOf(l) }))).find(
    (t) => t.station === stationKind,
  );
  const [memberRow] = saleRow.memberId
    ? await db.select({ nickname: member.nickname }).from(member).where(eq(member.id, saleRow.memberId)).limit(1)
    : [];
  const pickup = ((lines[0]?.payload ?? {}) as { pickupCode?: string }).pickupCode;
  return {
    title: ticket?.title ?? (stationKind === 'kitchen' ? 'Kitchen' : 'Bar'),
    orderRef: pickup ?? saleRow.receiptNumber ?? saleRow.id.slice(-6),
    time: hhmm(saleRow.finalisedAt ?? saleRow.occurredAt, saleRow.timezone),
    holderName: memberRow?.nickname || undefined,
    allergiesMedical: allergyTextOf(await orderChildren(db, saleRow)),
    lines: (ticket?.lines ?? []).map((l) => ({ qty: l.quantity, name: lineName(l), note: lineNote(l) })),
    orderNote: saleRow.note ?? undefined,
  };
}

export async function bandDocument(db: Exec, bandRow: typeof band.$inferSelect): Promise<BandData> {
  const [saleRow] = await db.select().from(sale).where(eq(sale.id, bandRow.saleId)).limit(1);
  const [lineRow] = bandRow.saleLineId
    ? await db.select().from(saleLine).where(eq(saleLine.id, bandRow.saleLineId)).limit(1)
    : [];
  const [childRow] = bandRow.childId
    ? await db
        .select({ name: child.name, allergies: child.allergies, medicalNotes: child.medicalNotes, dietary: child.dietary })
        .from(child)
        .where(eq(child.id, bandRow.childId))
        .limit(1)
    : [];
  const [memberRow] = bandRow.memberId
    ? await db.select({ nickname: member.nickname }).from(member).where(eq(member.id, bandRow.memberId)).limit(1)
    : [];
  const start = saleRow?.finalisedAt ?? saleRow?.occurredAt ?? bandRow.createdAt;
  const timezone = saleRow?.timezone ?? 'Asia/Bangkok';
  const duration =
    lineRow?.stayHours && lineRow.stayHours > 0
      ? `${lineRow.stayDurationLabel ?? `${lineRow.stayHours} hours`} · valid until ${hhmm(
          new Date(start.getTime() + lineRow.stayHours * 3_600_000),
          timezone,
        )}`
      : (lineRow?.stayDurationLabel ?? undefined);
  const allergy =
    bandRow.kind === 'kid' && childRow
      ? [childRow.allergies?.trim(), childRow.medicalNotes?.trim()].filter((v): v is string => !!v).join('; ') ||
        undefined
      : undefined;
  return {
    holderName: bandRow.kind === 'kid' ? (childRow?.name ?? undefined) : memberRow?.nickname || undefined,
    duration,
    dietaryRequirement: bandRow.kind === 'kid' ? (childRow?.dietary?.trim() || undefined) : undefined,
    allergy,
    bandCode: bandRow.code,
    shortCode: bandShortCode(bandRow.code) ?? undefined,
  };
}

async function itemVoucherDocument(db: Exec, lineRow: SaleLineRow): Promise<ItemVoucherData> {
  const lines = (await linesOf(db, lineRow.saleId)).filter((l) => l.ticketPackageId !== null);
  const group = itemVoucherGroups(lines).find((g) => g.label === lineRow.label);
  return { label: lineRow.label, quantity: group?.quantity ?? lineRow.quantity };
}

/** What `GET /box/v1/print-jobs/:id/document` answers. */
export interface PrintDocumentView {
  printJobId: string;
  kind: PrintKind;
  role: string | null;
  stationId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  reprintOf: string | null;
  /** The renderer's job: `{ kind, data }`, exactly `PrintJob` in `@oto/print`. */
  job: RenderJob;
}

/**
 * Build the content of one print job, for the box that is about to print it.
 *
 * Scoped to the asking box: a job on another box is 404, not 403, so an id
 * cannot be confirmed by probing — `recordPrintJobResult`'s rule. A job that
 * is not a sale's (a test page) has no document here; the box prints its own
 * sample for those.
 */
export async function buildPrintDocument(
  db: Exec,
  boxAuth: { boxId: string; operatorId: string },
  jobId: string,
): Promise<PrintDocumentView> {
  const [row] = await db
    .select()
    .from(printJob)
    .where(and(eq(printJob.id, jobId), eq(printJob.boxId, boxAuth.boxId)))
    .limit(1);
  if (!row || row.operatorId !== boxAuth.operatorId) {
    throw new AppError(404, 'PRINT_JOB_NOT_FOUND', 'No such print job on this box');
  }
  const base = {
    printJobId: row.id,
    kind: row.kind,
    role: row.role,
    stationId: row.stationId,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    reprintOf: row.reprintOf,
  };
  const noDocument = () =>
    new AppError(404, 'PRINT_DOCUMENT_NOT_FOUND', 'This print job has no document on the platform');
  if (row.subjectType === 'sale' && row.subjectId) {
    const [saleRow] = await db.select().from(sale).where(eq(sale.id, row.subjectId)).limit(1);
    if (!saleRow) throw noDocument();
    if (row.kind === 'receipt') {
      return { ...base, job: { kind: 'receipt', data: await receiptDocument(db, saleRow, row.reprintOf !== null) } };
    }
    if (row.kind === 'kitchen_ticket' || row.kind === 'bar_ticket') {
      const data = await prepDocument(db, saleRow, row.kind === 'kitchen_ticket' ? 'kitchen' : 'bar');
      return { ...base, job: { kind: row.kind, data } };
    }
  }
  if (row.subjectType === 'band' && row.subjectId) {
    const [bandRow] = await db.select().from(band).where(eq(band.id, row.subjectId)).limit(1);
    if (!bandRow) throw noDocument();
    const kind = bandRow.kind === 'kid' ? 'kids_wristband' : 'adult_wristband';
    return { ...base, job: { kind, data: await bandDocument(db, bandRow) } };
  }
  if (row.subjectType === 'sale_line' && row.subjectId && row.kind === 'item_voucher') {
    const [lineRow] = await db.select().from(saleLine).where(eq(saleLine.id, row.subjectId)).limit(1);
    if (!lineRow) throw noDocument();
    return { ...base, job: { kind: 'item_voucher', data: await itemVoucherDocument(db, lineRow) } };
  }
  throw noDocument();
}
