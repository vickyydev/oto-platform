import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  box,
  device,
  printJob,
  printTemplate,
  station,
  stationDevice,
  type Db,
} from '@oto/db';
import {
  PRINT_JOB_RETENTION_DAYS,
  PRINT_KINDS,
  PRINT_TEMPLATE_TYPE_ORDER,
  TEMPLATE_FOR_KIND,
  newId,
  reprintRootOf,
  type PrintKind,
  type PrintTemplateType,
  type PrintTemplateUpdate,
} from '@oto/shared';
import { ROLE_FOR_KIND, profileFor, testPrintJob } from '@oto/box-agent';
import { renderPreviewPng } from '@oto/print';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { queueCommand } from './fleet';
import { recordRun } from './ops';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * The cloud half of printing (S2-06).
 *
 * The box owns the paper: it renders, it opens the socket, it decides when to
 * try again. What lives here is everything a person needs in order to see and
 * steer that from somewhere other than the counter — what a printout shows,
 * what happened to a job, and the one button that starts a test print.
 *
 * **Three boundaries worth stating, because each was a choice.**
 *
 * *A template edit is not a print job.* Editing the receipt template changes
 * `pos.print_template` and bumps its version; nothing prints. The version is
 * what carries the change to a box — it is part of the config bundle's hash,
 * so the next heartbeat's ack differs and the box pulls — which is what makes
 * "toggle a field and the next preview changes, with no redeploy" true for a
 * box nobody edited anything on.
 *
 * *A test print is a command, not a request/response.* The route creates the
 * `edge.print_job` row, queues a `test_print` command and answers immediately.
 * It cannot wait for paper: the box may be offline, the printer may be out,
 * and a till holding an HTTP connection open until a roll is changed is a till
 * nobody can use. The outcome arrives on its own endpoint, minutes or an hour
 * later, and updates the row the button created.
 *
 * *A failure is an `ops_run`, a skip is not.* A printer that ate a receipt is
 * an operational event with a fingerprint, so sixty of them read as one
 * problem on the Failures page. A job skipped because no printer is assigned
 * to that role is a configuration a person chose; raising it would train
 * everybody to ignore the page.
 */

// --- Templates ---------------------------------------------------------------

export interface PrintTemplateView {
  id: string;
  branchId: string;
  type: PrintTemplateType;
  name: string;
  showLogo: boolean;
  headerText: string | null;
  footerText: string | null;
  fields: Record<string, boolean | undefined>;
  version: number;
  updatedAt: string;
}

function templateView(row: typeof printTemplate.$inferSelect): PrintTemplateView {
  return {
    id: row.id,
    branchId: row.branchId,
    type: row.type,
    name: row.name,
    showLogo: row.showLogo,
    headerText: row.headerText,
    footerText: row.footerText,
    fields: (row.fields ?? {}) as Record<string, boolean | undefined>,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The branch's templates, in the order the prototype's panel lists them.
 *
 * Sorted in the application rather than in SQL because the order is a product
 * decision (`TemplatesPanel.tsx:10-17`) and not alphabetical — `receipt`,
 * bands, prep tickets, voucher — and a database `order by type` would quietly
 * reorder the panel the day somebody renamed a type.
 */
export async function listTemplates(db: Db, branchId: string): Promise<PrintTemplateView[]> {
  const rows = await db
    .select()
    .from(printTemplate)
    .where(and(eq(printTemplate.branchId, branchId), isNull(printTemplate.archivedAt)));
  const order = new Map(PRINT_TEMPLATE_TYPE_ORDER.map((t, i) => [t, i]));
  return rows
    .sort((a, b) => (order.get(a.type) ?? 99) - (order.get(b.type) ?? 99))
    .map(templateView);
}

export async function loadTemplate(
  db: Db,
  operatorId: string,
  id: string,
): Promise<typeof printTemplate.$inferSelect> {
  const [row] = await db
    .select()
    .from(printTemplate)
    .where(and(eq(printTemplate.id, id), eq(printTemplate.operatorId, operatorId)))
    .limit(1);
  if (!row) throw new AppError(404, 'PRINT_TEMPLATE_NOT_FOUND', 'No such print template');
  return row;
}

export async function updateTemplate(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: typeof printTemplate.$inferSelect,
  patch: PrintTemplateUpdate,
): Promise<{ template: PrintTemplateView }> {
  if (row.archivedAt) {
    throw new AppError(409, 'PRINT_TEMPLATE_ARCHIVED', 'That template has been archived');
  }
  return withTx(db, ctx, 'print_template.update', async (tx) => {
    const [updated] = await tx
      .update(printTemplate)
      .set({
        name: patch.name ?? row.name,
        showLogo: patch.showLogo ?? row.showLogo,
        headerText: patch.headerText === undefined ? row.headerText : patch.headerText,
        footerText: patch.footerText === undefined ? row.footerText : patch.footerText,
        fields: (patch.fields ?? row.fields) as never,
        /**
         * Bumped in SQL rather than read-then-written, so two administrators
         * saving the same template cannot both compute the same next number.
         * The box compares versions to decide which of two deltas is newer.
         */
        version: sql`${printTemplate.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(printTemplate.id, row.id))
      .returning();
    if (!updated) throw new AppError(404, 'PRINT_TEMPLATE_NOT_FOUND', 'No such print template');
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: row.branchId,
      action: 'print_template.update',
      entityType: 'print_template',
      entityId: row.id,
      before: templateView(row),
      after: templateView(updated),
      requestId: ctx.requestId,
    });
    return { template: templateView(updated) };
  });
}

// --- Jobs --------------------------------------------------------------------

export interface PrintJobView {
  id: string;
  branchId: string;
  boxId: string;
  stationId: string | null;
  deviceId: string | null;
  deviceLabel: string | null;
  role: string | null;
  kind: PrintKind;
  status: string;
  copies: number;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  templateId: string | null;
  templateVersion: number | null;
  reprintOf: string | null;
  actionId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PrintJobQuery {
  branchId?: string;
  boxId?: string;
  stationId?: string;
  status?: string;
  limit?: number;
}

export async function listPrintJobs(db: Db, q: PrintJobQuery): Promise<PrintJobView[]> {
  const where = [];
  if (q.branchId) where.push(eq(printJob.branchId, q.branchId));
  if (q.boxId) where.push(eq(printJob.boxId, q.boxId));
  if (q.stationId) where.push(eq(printJob.stationId, q.stationId));
  if (q.status) where.push(eq(printJob.status, q.status as never));
  const rows = await db
    .select({ job: printJob, deviceLabel: device.label })
    .from(printJob)
    .leftJoin(device, eq(printJob.deviceId, device.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(printJob.queuedAt))
    .limit(Math.min(q.limit ?? 50, 200));
  return rows.map((r) => jobView(r.job, r.deviceLabel));
}

function jobView(row: typeof printJob.$inferSelect, deviceLabel: string | null): PrintJobView {
  return {
    id: row.id,
    branchId: row.branchId,
    boxId: row.boxId,
    stationId: row.stationId,
    deviceId: row.deviceId,
    deviceLabel,
    role: row.role,
    kind: row.kind,
    status: row.status,
    copies: row.copies,
    attempts: row.attempts,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    reprintOf: row.reprintOf,
    actionId: row.actionId,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export interface TestPrintTarget {
  /** The station whose printers to route through; null uses any on the box. */
  stationId: string | null;
  boxRow: typeof box.$inferSelect;
  branchId: string;
}

/**
 * Find the box that should print this, from a branch and an optional station.
 *
 * A branch can have several boxes and a printout has to land on one of them.
 * Naming a station settles it, because a station belongs to exactly one box —
 * which is why the Print Templates panel asks which till to test on rather
 * than picking one and hoping the person was standing at it.
 */
export async function resolveTestPrintTarget(
  db: Db,
  operatorId: string,
  input: { branchId: string; stationId?: string | null },
): Promise<TestPrintTarget> {
  if (input.stationId) {
    const [row] = await db
      .select()
      .from(station)
      .where(and(eq(station.id, input.stationId), eq(station.operatorId, operatorId)))
      .limit(1);
    if (!row) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
    if (!row.boxId) {
      throw new AppError(
        409,
        'STATION_HAS_NO_BOX',
        `${row.name} is not attached to a box, so nothing on it can print`,
      );
    }
    const [boxRow] = await db.select().from(box).where(eq(box.id, row.boxId)).limit(1);
    if (!boxRow) throw new AppError(404, 'BOX_NOT_FOUND', 'No such box');
    return { stationId: row.id, boxRow, branchId: row.branchId };
  }
  const [boxRow] = await db
    .select()
    .from(box)
    .where(and(eq(box.branchId, input.branchId), isNull(box.archivedAt)))
    .orderBy(asc(box.slot))
    .limit(1);
  if (!boxRow) {
    throw new AppError(
      409,
      'BRANCH_HAS_NO_BOX',
      'This branch has no box, so there is nothing here that can print',
    );
  }
  return { stationId: null, boxRow, branchId: input.branchId };
}

/**
 * Which device this job will go to, as the cloud can see it.
 *
 * Recorded on the row up front so the Console can say "queued for Receipt
 * Printer 1" while it is still queued. The BOX re-resolves the same way on
 * every attempt and its answer wins — it is the one that knows what it can
 * actually reach — so the two can differ for as long as a job waits, which is
 * exactly the window in which somebody unplugs a printer.
 */
export async function routeOnBox(
  db: Exec,
  boxId: string,
  role: string,
  stationId: string | null,
): Promise<{ deviceId: string; stationId: string } | null> {
  const rows = await db
    .select({ deviceId: stationDevice.deviceId, stationId: stationDevice.stationId })
    .from(stationDevice)
    .innerJoin(device, eq(stationDevice.deviceId, device.id))
    .innerJoin(station, eq(stationDevice.stationId, station.id))
    .where(
      and(
        eq(stationDevice.role, role as never),
        eq(device.boxId, boxId),
        isNull(device.archivedAt),
        isNull(station.archivedAt),
        stationId ? eq(stationDevice.stationId, stationId) : undefined,
      ),
    )
    .orderBy(asc(stationDevice.stationId))
    .limit(1);
  return rows[0] ?? null;
}

// --- The preview -------------------------------------------------------------

/**
 * Draw a template's sample the way the printer would, and answer with the PNG.
 *
 * **Why the editor's preview is a picture from here rather than markup in the
 * browser.** `@oto/print` runs on Node only — it reads the bundled faces with
 * `node:fs` and deflates the PNG with `node:zlib` — so a browser cannot call
 * the renderer, and a panel that wanted a preview without one had to draw a
 * second, approximate printout in HTML. It did, and the two drifted: different
 * fonts, different line breaking, different sample content, and a "Test print"
 * button whose paper matched neither. Everything about a printout that is
 * worth looking at before printing it — whether a Thai line has glyphs or
 * boxes, whether a name wraps, whether the content fits the band stock — is
 * exactly what an approximation gets wrong.
 *
 * So there is one drawing path and it is this one. The cost is a round trip
 * per edit, which the editor pays by asking only after typing stops.
 *
 * The sample content is `testPrintJob`'s, which is the renderer's own committed
 * fixture for that kind — the same sample the Test print button puts on paper,
 * so the two agree by construction rather than by resemblance. With a printer
 * assigned and nothing unsaved on the screen they agree to the byte, which
 * `print-api.test.ts` asserts by comparing this PNG with the one the simulator
 * rebuilds from the bytes it was sent.
 */
export interface TemplatePreviewResult {
  png: Uint8Array;
  /** The printer this was laid out for, when the branch has one for the role. */
  deviceLabel: string | null;
  widthDots: number;
}

/** The printout whose sample stands for this template type. */
function sampleKindFor(type: PrintTemplateType): PrintKind {
  const kinds = PRINT_KINDS.filter((k) => TEMPLATE_FOR_KIND[k] === type);
  // `credit_voucher` is the template for both the credit voucher and the item
  // voucher, so prefer the kind named after the type where there is one.
  const kind = kinds.find((k) => k === type) ?? kinds[0];
  if (!kind) {
    throw new AppError(500, 'INTERNAL', `Nothing prints with the ${type} template`);
  }
  return kind;
}

export async function renderTemplatePreview(
  db: Db,
  operatorId: string,
  row: typeof printTemplate.$inferSelect,
  draft: PrintTemplateUpdate,
  input: { stationId?: string | null } = {},
): Promise<TemplatePreviewResult> {
  const kind = sampleKindFor(row.type);
  const role = ROLE_FOR_KIND[kind];

  /**
   * Lay the sample out for the printer the Test print button would use, so
   * "the preview fits" and "the paper fits" are the same statement. A branch
   * with no printer for the role still gets a preview: `profileFor` falls back
   * to the defaults for the kind, which is what the box would do with a device
   * nobody has measured yet.
   */
  let routed: { device: typeof device.$inferSelect } | null = null;
  try {
    const target = await resolveTestPrintTarget(db, operatorId, {
      branchId: row.branchId,
      stationId: input.stationId ?? null,
    });
    const hit = await routeOnBox(db, target.boxRow.id, role, target.stationId);
    if (hit) {
      const [deviceRow] = await db.select().from(device).where(eq(device.id, hit.deviceId)).limit(1);
      if (deviceRow) routed = { device: deviceRow };
    }
  } catch (err) {
    // No box on the branch, or a station that is not attached to one. That
    // stops a test print and it must not stop a preview: nothing here touches
    // a box, and somebody configuring a template before the hardware arrives
    // is the ordinary case rather than the odd one.
    if (!(err instanceof AppError)) throw err;
  }

  const profile = profileFor({
    id: routed?.device.id ?? row.id,
    role,
    kind: routed?.device.kind ?? (role.endsWith('band') ? 'band_printer' : 'receipt_printer'),
    label: routed?.device.label ?? 'Sample',
    transport: routed?.device.transport ?? 'simulated',
    address: routed?.device.address ?? null,
    model: routed?.device.model ?? null,
    protocol: routed?.device.protocol ?? null,
    serialNumber: null,
    terminalId: null,
    merchantId: null,
    settings: routed?.device.settings ?? null,
  });

  const job = await testPrintJob(kind);
  const png = renderPreviewPng(job, {
    device: profile,
    templates: [
      {
        id: row.id,
        type: row.type,
        name: draft.name ?? row.name,
        showLogo: draft.showLogo ?? row.showLogo,
        headerText: (draft.headerText === undefined ? row.headerText : draft.headerText) ?? undefined,
        footerText: (draft.footerText === undefined ? row.footerText : draft.footerText) ?? undefined,
        fields: (draft.fields ?? row.fields ?? {}) as never,
      },
    ],
  });
  return { png, deviceLabel: routed?.device.label ?? null, widthDots: profile.widthDots };
}

export interface TestPrintInput {
  kind: PrintKind;
  stationId?: string | null;
  /** Override the role the kind would route to — the Console's per-device test. */
  role?: string | null;
  copies?: number;
  actionId: string;
}

export interface TestPrintResult {
  printJob: PrintJobView;
  commandId: string;
  actionId: string;
}

/**
 * Queue a test print: one `print_job` row and one `test_print` command.
 *
 * The job id is minted here and carried in the command payload, so the outcome
 * the box reports lands on the row the button created. The row is written
 * before its command, in one transaction with the complete response, so a box
 * cannot collect a command without its job and a retry cannot print it twice.
 */
export async function requestTestPrint(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  target: TestPrintTarget,
  input: TestPrintInput,
): Promise<TestPrintResult> {
  const role = input.role ?? ROLE_FOR_KIND[input.kind];
  const routed = await routeOnBox(db, target.boxRow.id, role, target.stationId);
  const [template] = await db
    .select()
    .from(printTemplate)
    .where(
      and(
        eq(printTemplate.branchId, target.branchId),
        eq(printTemplate.type, templateTypeFor(input.kind) as never),
        isNull(printTemplate.archivedAt),
      ),
    )
    .limit(1);

  const jobId = newId();
  return withTx(db, ctx, 'print_job.test', async (tx) => {
    const [row] = await tx
      .insert(printJob)
      .values({
        id: jobId,
        operatorId: actor.operatorId,
        branchId: target.branchId,
        boxId: target.boxRow.id,
        stationId: routed?.stationId ?? target.stationId ?? null,
        deviceId: routed?.deviceId ?? null,
        role,
        kind: input.kind,
        templateId: template?.id ?? null,
        templateVersion: template?.version ?? null,
        copies: input.copies ?? 1,
        status: 'queued',
        subjectType: 'station',
        subjectId: routed?.stationId ?? target.stationId ?? target.boxRow.id,
        requestedByAccountId: actor.accountId,
        actionId: input.actionId,
      })
      .returning();
    if (!row) throw new AppError(500, 'INTERNAL', 'The print job could not be recorded');
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: target.branchId,
      action: 'print_job.test',
      entityType: 'print_job',
      entityId: jobId,
      after: { kind: input.kind, role, deviceId: routed?.deviceId ?? null, boxId: target.boxRow.id },
      requestId: ctx.requestId,
    });
    const command = await queueCommand(tx, ctx, actor, target.boxRow, {
      kind: 'test_print',
      payload: {
        printJobId: jobId,
        kind: input.kind,
        role,
        stationId: routed?.stationId ?? target.stationId ?? null,
        copies: input.copies ?? 1,
        /**
         * `queueCommand` insists a test print names a device on this box, which
         * is the S2-04 check that stops a command aimed at somebody else's
         * printer. Where nothing is assigned there is no device to name — and
         * that case must still produce a job, because "skipped, not printed" is
         * what the till has to be told. So the device is only named when one was
         * found, and the unrouted case is answered below rather than queued.
         */
        ...(routed ? { deviceId: routed.deviceId } : {}),
      },
      actionId: input.actionId,
    });

    return { printJob: jobView(row, null), commandId: command.commandId, actionId: command.actionId };
  });
}

/**
 * The skipped case, answered in the cloud.
 *
 * No printer is assigned to the role, so there is nothing for the box to try
 * and no reason to wake it. The row is written `skipped` and the till shows
 * "not printed" — a non-blocking note, not a failure, and nothing is raised.
 */
export async function recordSkippedPrint(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  target: TestPrintTarget,
  input: TestPrintInput,
): Promise<TestPrintResult> {
  const role = input.role ?? ROLE_FOR_KIND[input.kind];
  const jobId = newId();
  return withTx(db, ctx, 'print_job.skipped', async (tx) => {
    const now = new Date();
    const [row] = await tx
      .insert(printJob)
      .values({
        id: jobId,
        operatorId: actor.operatorId,
        branchId: target.branchId,
        boxId: target.boxRow.id,
        stationId: target.stationId,
        deviceId: null,
        role,
        kind: input.kind,
        copies: input.copies ?? 1,
        status: 'skipped',
        errorCode: 'NO_DEVICE_FOR_ROLE',
        errorMessage: `No ${role} printer is assigned${target.stationId ? ' to this station' : ' on this box'}`,
        subjectType: 'station',
        subjectId: target.stationId ?? target.boxRow.id,
        requestedByAccountId: actor.accountId,
        actionId: input.actionId,
        finishedAt: now,
      })
      .returning();
    if (!row) throw new AppError(500, 'INTERNAL', 'The print job could not be recorded');
    return { printJob: jobView(row, null), commandId: '', actionId: input.actionId };
  });
}

export interface PrintJobResultInput {
  status: 'queued' | 'printed' | 'failed' | 'skipped';
  attempts: number;
  deviceId?: string | null;
  role?: string | null;
  stationId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  overflow?: string[];
  elapsedMs?: number | null;
}

/**
 * What the box says happened.
 *
 * Authenticated by the box credential and scoped to that box: a box may only
 * speak about its own jobs, the same rule every other `/box/v1` route follows.
 * A job it does not own answers 404 rather than 403, so an id cannot be
 * confirmed by probing.
 */
export async function recordPrintJobResult(
  db: Db,
  ctx: OpContext,
  boxAuth: { boxId: string; operatorId: string; branchId: string },
  jobId: string,
  input: PrintJobResultInput,
): Promise<{ job: PrintJobView; replayed: boolean }> {
  const [existing] = await db
    .select()
    .from(printJob)
    .where(and(eq(printJob.id, jobId), eq(printJob.boxId, boxAuth.boxId)))
    .limit(1);
  if (!existing) throw new AppError(404, 'PRINT_JOB_NOT_FOUND', 'No such print job on this box');

  /**
   * A terminal job does not move again.
   *
   * The box re-sends an outcome whenever an acknowledgement is lost, which is
   * the normal condition rather than the exception, and a second `printed`
   * must not reset `finished_at` and make one receipt look like two attempts.
   * Answering `replayed` rather than an error is what stops the box retrying
   * for ever.
   */
  if (existing.status !== 'queued') {
    return { job: jobView(existing, null), replayed: true };
  }

  const finished = input.status !== 'queued';
  const now = new Date();
  const updated = await withTx(db, ctx, `print_job.${input.status}`, async (tx) => {
    const [row] = await tx
      .update(printJob)
      .set({
        status: input.status,
        attempts: input.attempts,
        deviceId: input.deviceId ?? existing.deviceId,
        role: input.role ?? existing.role,
        stationId: input.stationId ?? existing.stationId,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage?.slice(0, 500) ?? null,
        startedAt: existing.startedAt ?? now,
        finishedAt: finished ? now : null,
        updatedAt: now,
      })
      .where(eq(printJob.id, jobId))
      .returning();
    if (!row) throw new AppError(404, 'PRINT_JOB_NOT_FOUND', 'No such print job');
    return row;
  });

  if (input.status === 'failed') {
    /**
     * One `ops_run` per failure, which is the ticket's wording.
     *
     * Its `name` carries the error code rather than the job, so the
     * fingerprint groups "this printer keeps running out of paper" into one
     * row on the Failures page instead of one row per receipt. The device is
     * in the detail, where the page can show it without it being part of what
     * makes two failures the same problem.
     */
    await recordRun(db, {
      kind: 'device',
      name: `device:printer.${input.errorCode ?? 'UNKNOWN'}`,
      outcome: 'failed',
      startedAt: existing.queuedAt,
      finishedAt: now,
      error: new AppError(500, input.errorCode ?? 'PRINT_FAILED', input.errorMessage ?? 'The print job failed'),
      detail: {
        printJobId: jobId,
        kind: existing.kind,
        role: updated.role,
        deviceId: updated.deviceId,
        attempts: input.attempts,
        overflow: input.overflow ?? [],
      },
      operatorId: boxAuth.operatorId,
      branchId: boxAuth.branchId,
      stationId: updated.stationId,
      actionId: existing.actionId,
      requestId: ctx.requestId ?? null,
    });
  }

  return { job: jobView(updated, null), replayed: false };
}

/**
 * Ask for the same thing again after a failure.
 *
 * A new row rather than a retry of the old one, with `reprint_of` pointing at
 * the ORIGINAL — never at the row being copied — so counting the copies of one
 * printout is one indexed query and a retention sweep cannot leave a chain
 * with a hole in it. `reprintRootOf` in `@oto/shared` is the one place that
 * decides; the database cannot enforce it and does not claim to.
 */
export async function reprintJob(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  source: typeof printJob.$inferSelect,
  boxRow: typeof box.$inferSelect,
  reason: string,
  actionId: string,
): Promise<TestPrintResult> {
  const jobId = newId();
  const root = reprintRootOf({ id: source.id, reprintOf: source.reprintOf });
  return withTx(db, ctx, 'print_job.reprint', async (tx) => {
    const [row] = await tx
      .insert(printJob)
      .values({
        id: jobId,
        operatorId: source.operatorId,
        branchId: source.branchId,
        boxId: source.boxId,
        stationId: source.stationId,
        deviceId: source.deviceId,
        role: source.role,
        kind: source.kind,
        templateId: source.templateId,
        templateVersion: source.templateVersion,
        copies: source.copies,
        status: 'queued',
        subjectType: source.subjectType,
        subjectId: source.subjectId,
        reprintOf: root,
        reprintReason: reason,
        requestedByAccountId: actor.accountId,
        actionId,
      })
      .returning();
    if (!row) throw new AppError(500, 'INTERNAL', 'The reprint could not be recorded');
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: source.branchId,
      action: 'print_job.reprint',
      entityType: 'print_job',
      entityId: jobId,
      after: { reprintOf: root, reason, kind: source.kind },
      requestId: ctx.requestId,
    });
    const command = await queueCommand(tx, ctx, actor, boxRow, {
      kind: 'test_print',
      payload: {
        printJobId: jobId,
        kind: source.kind,
        role: source.role,
        stationId: source.stationId,
        copies: source.copies,
        ...(source.deviceId ? { deviceId: source.deviceId } : {}),
        /**
         * S2-11 — a copy of a sale's printout (a receipt, a band, a prep
         * ticket) is printed from the platform's document for the NEW job,
         * built from the ledger as it stands, exactly as the original was.
         * A test page has no document and the box prints its own sample.
         */
        ...(source.subjectType && source.subjectType !== 'station'
          ? { document: 'platform', subjectType: source.subjectType, reprintOf: root }
          : {}),
      },
      actionId,
    });
    return { printJob: jobView(row, null), commandId: command.commandId, actionId: command.actionId };
  });
}

export async function loadPrintJob(
  db: Db,
  operatorId: string,
  id: string,
): Promise<typeof printJob.$inferSelect> {
  const [row] = await db
    .select()
    .from(printJob)
    .where(and(eq(printJob.id, id), eq(printJob.operatorId, operatorId)))
    .limit(1);
  if (!row) throw new AppError(404, 'PRINT_JOB_NOT_FOUND', 'No such print job');
  return row;
}

/** Which editable template a printout reads, where there is one. */
export function templateTypeFor(kind: PrintKind): PrintTemplateType | null {
  switch (kind) {
    case 'receipt':
    case 'kitchen_ticket':
    case 'bar_ticket':
    case 'kids_wristband':
    case 'adult_wristband':
    case 'credit_voucher':
      return kind;
    /** It borrows the credit voucher's template (`printRouting.tsx:125-141`). */
    case 'item_voucher':
      return 'credit_voucher';
    default:
      return null;
  }
}

/**
 * The retention sweep the schema named and nothing called.
 *
 * Ninety days, by `queued_at`, on `print_job_queued_idx`. Queued jobs are
 * deleted too, deliberately: a job still `queued` after three months belongs
 * to a box that has not spoken in three months, and keeping it would mean a
 * printer coming back online one day and producing a receipt for a sale from
 * last quarter.
 */
export async function purgeOldPrintJobs(db: Db, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db.delete(printJob).where(lt(printJob.queuedAt, cutoff)).returning({ id: printJob.id });
  return deleted.length;
}

export const PRINT_RETENTION_DAYS = PRINT_JOB_RETENTION_DAYS;

export interface StationPrinterHealth {
  deviceId: string;
  label: string;
  role: string;
  kind: string;
  reachability: string;
  paperStatus: string;
  lastError: string | null;
  lastSeenAt: string | null;
  /** How many jobs are still waiting on this printer. */
  queued: number;
}

/**
 * What the till's header indicator reads.
 *
 * It comes from `core.device`, which the heartbeat updates, and NOT from the
 * box — PROJECT_CONTEXT §7.3 asks for "a red indicator before staff notice a
 * missing receipt", and a till that had to ask its box would show nothing at
 * all in the one case that matters most, which is the box being unreachable.
 * The worst case is therefore one heartbeat interval of staleness, which is
 * the same sixty seconds the Console's fleet page lives with.
 */
export async function listStationPrinters(
  db: Db,
  stationId: string,
): Promise<StationPrinterHealth[]> {
  const rows = await db
    .select({ role: stationDevice.role, device })
    .from(stationDevice)
    .innerJoin(device, eq(stationDevice.deviceId, device.id))
    .where(and(eq(stationDevice.stationId, stationId), isNull(device.archivedAt)))
    .orderBy(asc(stationDevice.role));
  const printers = rows.filter((r) => r.device.kind.endsWith('printer'));
  if (printers.length === 0) return [];

  const queued = await db
    .select({ deviceId: printJob.deviceId, n: sql<number>`count(*)::int` })
    .from(printJob)
    .where(
      and(
        eq(printJob.stationId, stationId),
        eq(printJob.status, 'queued'),
        inArray(printJob.deviceId, printers.map((p) => p.device.id)),
      ),
    )
    .groupBy(printJob.deviceId);
  const depth = new Map(queued.map((q) => [q.deviceId, q.n]));

  return printers.map((r) => ({
    deviceId: r.device.id,
    label: r.device.label,
    role: r.role,
    kind: r.device.kind,
    reachability: r.device.reachability,
    paperStatus: r.device.paperStatus,
    lastError: r.device.lastError,
    lastSeenAt: r.device.lastSeenAt?.toISOString() ?? null,
    queued: depth.get(r.device.id) ?? 0,
  }));
}

export type { Exec };
