import { z } from 'zod';
import {
  PRINT_KINDS,
  PRINT_TEMPLATE_TYPES,
  PrintTemplateUpdateSchema,
  SimulatorActionSchema,
  newId,
} from '@oto/shared';
import { STATION_DEVICE_ROLES } from '@oto/db';
import { PRINT_SAMPLE_NAMES } from '@oto/print';
import type { App } from '../app';
import { AppError } from '../lib/errors';
import { inProcessBox } from '../services/box';
import { loadBox, loadBranchForOperator, loadDevice, loadStation, queueCommand } from '../services/fleet';
import {
  describeTestPrintDestination,
  listPrintJobs,
  listStationPrinters,
  listTemplates,
  loadPrintJob,
  loadTemplate,
  recordSkippedPrint,
  renderTemplatePreview,
  reprintJob,
  requestTestPrint,
  resolveTestPrintTarget,
  updateTemplate,
} from '../services/print';
import { opCtx } from '../services/tx';

/**
 * Printing's HTTP surface (S2-06).
 *
 * Registered with no prefix and declaring full paths, as `fleetRoutes` and
 * `catalogRoutes` do: the branch-scoped resources hang off `/branches/:branchId`
 * and the by-id routes do not, so the paths are written out rather than
 * assembled from two places.
 *
 * **Permissions are borrowed rather than invented.** A print template is
 * branch configuration, so editing one asks for `admin:branch:update`; reading
 * one asks for `pos:print:read`, because the till reads templates too; running
 * a test print or injecting a fault asks for `admin:box:command`, whose own
 * definition in `@oto/shared` already reads "Test print, restart, collect logs,
 * go offline, reset store". A `catalog:template:*` pair would be the right
 * vocabulary and adding it is a change to the permission list and the seeded
 * role bundles — a separate, deliberate step, recorded in the S2-06 report
 * rather than slipped in here.
 */

const BranchParams = z.object({ branchId: z.string().uuid() });
const IdParams = z.object({ id: z.string().uuid() });

/** The same shape the telemetry plugin accepts, so one id follows one gesture. */
const ACTION_ID = /^[A-Za-z0-9._-]{8,64}$/;

function actionIdOf(headers: Record<string, unknown>): string {
  const sent = headers['x-oto-action-id'];
  return typeof sent === 'string' && ACTION_ID.test(sent) ? sent : newId();
}

const TemplateSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  type: z.enum(PRINT_TEMPLATE_TYPES),
  name: z.string(),
  showLogo: z.boolean(),
  headerText: z.string().nullable(),
  footerText: z.string().nullable(),
  fields: z.record(z.string(), z.boolean().optional()),
  version: z.number().int(),
  updatedAt: z.string(),
});

const JobSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  boxId: z.string().uuid(),
  stationId: z.string().uuid().nullable(),
  deviceId: z.string().uuid().nullable(),
  deviceLabel: z.string().nullable(),
  role: z.string().nullable(),
  kind: z.enum(PRINT_KINDS),
  status: z.string(),
  copies: z.number().int(),
  attempts: z.number().int(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  templateId: z.string().uuid().nullable(),
  templateVersion: z.number().int().nullable(),
  reprintOf: z.string().uuid().nullable(),
  actionId: z.string().nullable(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

const PrintoutSchema = z.object({
  seq: z.number().int(),
  at: z.string(),
  widthDots: z.number().int(),
  heightDots: z.number().int(),
  jobBytes: z.number().int(),
  truncated: z.boolean(),
  setup: z.array(z.string()).optional(),
  /**
   * Fetch with the route below; the PNG itself never rides a JSON body.
   *
   * An API path, written from this server's root. A browser reaches this
   * server through its front end's `/api` prefix and has to add it — see
   * `apps/console/src/api/url.ts`, which is the one place that does.
   */
  previewUrl: z.string(),
});

export async function printRoutes(app: App): Promise<void> {
  // --- Templates ------------------------------------------------------------

  app.get(
    '/branches/:branchId/print-templates',
    {
      config: { permission: 'pos:print:read', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'What each printout shows at this branch, in the panel’s own order',
        params: BranchParams,
        response: { 200: z.object({ templates: z.array(TemplateSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranchForOperator(app.db, auth.operatorId, req.params.branchId);
      return { templates: await listTemplates(app.db, req.params.branchId) };
    },
  );

  app.patch(
    '/print-templates/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Edit a printout’s content. Which printer it routes to is Station Setup, not this.',
        params: IdParams,
        body: PrintTemplateUpdateSchema,
        response: { 200: z.object({ template: TemplateSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadTemplate(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:branch:update', { branchId: row.branchId });
      return updateTemplate(app.db, opCtx(req), auth, row, req.body);
    },
  );

  /**
   * The picture the Print Templates editor shows while somebody edits.
   *
   * POST, and it changes nothing: the draft on the screen is a record of
   * booleans and two free-text lines, which is a request body rather than
   * something to spell out in a query string — and a preview of unsaved work
   * is the whole point, so the saved row alone would not do.
   *
   * `pos:print:read` rather than the editor's own `admin:branch:update`: what
   * comes back is the renderer's fixture sample, carrying no member, no child
   * and no sale, and the till reads templates under the same permission.
   */
  app.post(
    '/print-templates/:id/preview.png',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Draw this template’s sample the way the printer would, and answer with the PNG',
        params: IdParams,
        body: PrintTemplateUpdateSchema.extend({
          /** Which till to lay it out for; omitted, the branch’s first box decides. */
          stationId: z.string().uuid().nullable().optional(),
          /**
           * Which scenario to fill it with (SCRUM-472): `standard` — the
           * default — is the Test print's own sample; the others are
           * `@oto/print`'s named sets. A name the renderer does not have is a
           * 400, never a silent fall back to the default.
           */
          sample: z.enum(PRINT_SAMPLE_NAMES).optional(),
        }),
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const row = await loadTemplate(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:print:read', { branchId: row.branchId });
      const { stationId, sample, ...draft } = req.body;
      const preview = await renderTemplatePreview(app.db, auth.operatorId, row, draft, {
        stationId: stationId ?? null,
        sample,
      });
      return reply
        .header('content-type', 'image/png')
        .header('x-oto-preview-width-dots', String(preview.widthDots))
        // A sample, but rendered for one branch's template and one branch's
        // printer. Nothing shared may hold it.
        .header('cache-control', 'private, no-store')
        .send(Buffer.from(preview.png));
    },
  );

  /**
   * Where this template's Test print would come out, from a station
   * (SCRUM-472).
   *
   * The editor's Test print button names its destination — "Receipt Printer 1"
   * — so nobody walks to the wrong counter for the paper. It is the same
   * routing the preview is laid out for and the test print itself takes, asked
   * once when the editor opens rather than riding every preview's headers.
   * `pos:print:read`, as the preview: a printer's label is what the till's own
   * header already shows under that permission.
   */
  app.get(
    '/print-templates/:id/test-print-target',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Which printer this template’s Test print would reach from this station',
        params: IdParams,
        querystring: z.object({
          /** The station asking; omitted, the branch’s first box decides, as a test print does. */
          stationId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            printer: z.object({ deviceId: z.string().uuid(), label: z.string() }).nullable(),
            note: z.string().nullable(),
            widthDots: z.number().int(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadTemplate(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:print:read', { branchId: row.branchId });
      return describeTestPrintDestination(app.db, auth.operatorId, row, {
        stationId: req.query.stationId ?? null,
      });
    },
  );

  // --- Test prints ----------------------------------------------------------

  app.post(
    '/print-templates/:id/test-print',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Print this template’s sample on a real printer, through the box that serves the station',
        params: IdParams,
        body: z
          .object({
            /** Which till to print at. Omitted, the branch’s first box decides. */
            stationId: z.string().uuid().nullable().optional(),
            copies: z.number().int().min(1).max(3).optional(),
          })
          .optional(),
        response: {
          200: z.object({
            printJob: JobSchema,
            commandId: z.string(),
            actionId: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadTemplate(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:box:command', { branchId: row.branchId });
      const target = await resolveTestPrintTarget(app.db, auth.operatorId, {
        branchId: row.branchId,
        stationId: req.body?.stationId ?? null,
      });
      return startTestPrint(req, auth, target, {
        kind: row.type,
        stationId: target.stationId,
        copies: req.body?.copies ?? 1,
        actionId: actionIdOf(req.headers as Record<string, unknown>),
        /**
         * The editor's "Save & print test" saves and prints within a second,
         * and the box would otherwise render the template it cached before the
         * save (SCRUM-472): a config pull goes ahead of the print whenever the
         * box has not confirmed the configuration it would be handed now.
         */
        refreshConfig: true,
      });
    },
  );

  app.post(
    '/stations/:id/test-print',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Print any of the nine printouts at this station, for the paper path',
        params: IdParams,
        body: z.object({
          kind: z.enum(PRINT_KINDS).default('test_page'),
          role: z.enum(STATION_DEVICE_ROLES).optional(),
          copies: z.number().int().min(1).max(3).optional(),
        }),
        response: {
          200: z.object({ printJob: JobSchema, commandId: z.string(), actionId: z.string() }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:box:command', { branchId: row.branchId });
      const target = await resolveTestPrintTarget(app.db, auth.operatorId, {
        branchId: row.branchId,
        stationId: row.id,
      });
      return startTestPrint(req, auth, target, {
        kind: req.body.kind,
        stationId: row.id,
        role: req.body.role ?? null,
        copies: req.body.copies ?? 1,
        actionId: actionIdOf(req.headers as Record<string, unknown>),
      });
    },
  );

  /**
   * A test print that found no printer must still produce a row.
   *
   * `queueCommand` refuses a `test_print` that does not name a device on the
   * box — the S2-04 check that stops a command aimed at somebody else's
   * printer — so the unrouted case cannot go through it, and answering an
   * error instead would make "skipped with a note on the till" impossible to
   * show. It is recorded here as a skipped job, which is what the till reads.
   */
  async function startTestPrint(
    req: Parameters<typeof opCtx>[0],
    auth: { accountId: string; operatorId: string },
    target: Awaited<ReturnType<typeof resolveTestPrintTarget>>,
    input: Parameters<typeof requestTestPrint>[4],
  ): ReturnType<typeof requestTestPrint> {
    try {
      return await requestTestPrint(app.db, opCtx(req), auth, target, input);
    } catch (err) {
      if (err instanceof AppError && err.code === 'COMMAND_PAYLOAD_INVALID') {
        return recordSkippedPrint(app.db, opCtx(req), auth, target, input);
      }
      throw err;
    }
  }

  app.get(
    '/stations/:id/printers',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'What this station’s printers last said about themselves — the red indicator in the till’s header',
        params: IdParams,
        response: {
          200: z.object({
            printers: z.array(
              z.object({
                deviceId: z.string().uuid(),
                label: z.string(),
                role: z.string(),
                kind: z.string(),
                reachability: z.string(),
                paperStatus: z.string(),
                lastError: z.string().nullable(),
                lastSeenAt: z.string().nullable(),
                queued: z.number().int(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:print:read', { branchId: row.branchId });
      return { printers: await listStationPrinters(app.db, row.id) };
    },
  );

  // --- The record -----------------------------------------------------------

  app.get(
    '/branches/:branchId/print-jobs',
    {
      config: { permission: 'pos:print:read', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'What has been printed at this branch, newest first',
        params: BranchParams,
        querystring: z.object({
          status: z.enum(['queued', 'printed', 'failed', 'skipped']).optional(),
          stationId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.object({ jobs: z.array(JobSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranchForOperator(app.db, auth.operatorId, req.params.branchId);
      return {
        jobs: await listPrintJobs(app.db, {
          branchId: req.params.branchId,
          status: req.query.status,
          stationId: req.query.stationId,
          limit: req.query.limit,
        }),
      };
    },
  );

  app.get(
    '/boxes/:id/print-jobs',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'This box’s print queue and its recent history',
        params: IdParams,
        querystring: z.object({
          status: z.enum(['queued', 'printed', 'failed', 'skipped']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.object({ jobs: z.array(JobSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBox(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:print:read', { branchId: row.branchId });
      return {
        jobs: await listPrintJobs(app.db, {
          boxId: row.id,
          status: req.query.status,
          limit: req.query.limit,
        }),
      };
    },
  );

  app.post(
    '/print-jobs/:id/reprint',
    {
      config: { dynamicPermission: true, stationTrading: true },
      schema: {
        description:
          'Ask for the same printout again. A new job pointing at the original, with a reason.',
        params: IdParams,
        body: z.object({ reason: z.string().min(1).max(200) }),
        response: {
          200: z.object({ printJob: JobSchema, commandId: z.string(), actionId: z.string() }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadPrintJob(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:print:reprint', { branchId: row.branchId });
      const boxRow = await loadBox(app.db, auth.operatorId, row.boxId);
      return reprintJob(
        app.db,
        opCtx(req),
        auth,
        row,
        boxRow,
        req.body.reason,
        actionIdOf(req.headers as Record<string, unknown>),
      );
    },
  );

  // --- Simulators -----------------------------------------------------------

  // --- Simulators -----------------------------------------------------------

  app.post(
    '/boxes/:id/simulate',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Make a simulated device pretend something — paper out, cover open, unplugged, a scan, a button press',
        params: IdParams,
        body: SimulatorActionSchema,
        response: { 200: z.object({ commandId: z.string().uuid(), actionId: z.string() }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBox(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:box:command', { branchId: row.branchId });
      const actionId = actionIdOf(req.headers as Record<string, unknown>);
      /**
       * A named path to the same door, not a second door.
       *
       * The Console's Simulators panel sends this through
       * `POST /boxes/:id/commands` because every other control on that drawer
       * does; this is the spelling for a caller that wants the action typed in
       * the OpenAPI rather than buried in a `payload` record. Both end in
       * `queueCommand`, which is where the two checks a simulator command
       * needs live — no credential in a stored payload, and a device that is
       * really on this box. Putting them on a route instead would have made
       * one of the two spellings the unguarded one.
       */
      return queueCommand(app.db, opCtx(req), auth, row, {
        kind: 'simulate',
        payload: { action: { ...req.body, actionId } },
        actionId,
      });
    },
  );

  // --- What came out of the machine ----------------------------------------
  //
  // Served from the in-process virtual box and from nowhere else. A rendered
  // receipt carries a member's name and what they bought, and a kids' band
  // carries a child's name and an allergy line; pushing previews up from a
  // Raspberry Pi would put all of that on the telemetry wire, which the box
  // protocol's own first rule forbids. The virtual box is in this process, so
  // its previews never cross a wire at all.

  app.get(
    '/devices/:id/printouts',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'What the simulator drew, newest last — the preview the panel shows',
        params: IdParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) }),
        response: {
          200: z.object({
            printouts: z.array(PrintoutSchema),
            events: z.array(
              z.object({ at: z.string(), kind: z.string(), detail: z.record(z.string(), z.unknown()) }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadDevice(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:device:read', { branchId: row.branchId });
      const sim = simulatorFor(row.boxId, row.id);
      return {
        printouts: sim.printouts(req.query.limit).map((p) => ({
          seq: p.seq,
          at: p.at,
          widthDots: p.widthDots,
          heightDots: p.heightDots,
          jobBytes: p.jobBytes,
          truncated: p.truncated,
          setup: p.setup,
          previewUrl: `/devices/${row.id}/printouts/${p.seq}/preview.png`,
        })),
        events: sim.events(40),
      };
    },
  );

  app.get(
    '/devices/:id/printouts/:seq/preview.png',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'The PNG of exactly the dots this device was told to burn',
        params: z.object({ id: z.string().uuid(), seq: z.coerce.number().int().min(1) }),
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const row = await loadDevice(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:device:read', { branchId: row.branchId });
      const sim = simulatorFor(row.boxId, row.id);
      const printout = sim.printouts(20).find((p) => p.seq === req.params.seq);
      if (!printout) throw new AppError(404, 'PRINTOUT_NOT_FOUND', 'That printout is no longer held');
      return reply
        .header('content-type', 'image/png')
        // It is a picture of a receipt. Nothing may cache it anywhere shared.
        .header('cache-control', 'private, no-store')
        .send(Buffer.from(printout.preview));
    },
  );

  function simulatorFor(boxId: string, deviceId: string) {
    const agent = inProcessBox(boxId);
    if (!agent) {
      throw new AppError(
        409,
        'BOX_NOT_IN_PROCESS',
        'This box is not running in this process, so what its simulator drew is on the box itself',
      );
    }
    const sim = agent.printing()?.simulator(deviceId);
    if (!sim) {
      throw new AppError(
        409,
        'DEVICE_NOT_SIMULATED',
        'That device is a real printer — what it printed is on paper',
      );
    }
    return sim;
  }
}
