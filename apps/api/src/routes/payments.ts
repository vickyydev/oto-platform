import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import {
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_PROVIDERS,
  SimulatorActionSchema,
  TERMINAL_OUTCOMES,
  newId,
  type Permission,
} from '@oto/shared';
import { TERMINAL_OUTCOME_KINDS, TERMINAL_TENDERS } from '@oto/box-agent';
import type { App } from '../app';
import { AppError, errors } from '../lib/errors';
import { boxAuthOf } from '../plugins/credential';
import { inProcessBox } from '../services/box';
import { loadDevice } from '../services/fleet';
import { opCtx, withTx } from '../services/tx';
import {
  confirmAttempt,
  loadAttempt,
  loadAttemptForBox,
  readAttempt,
  recordManualTender,
  recordTerminalProgress,
  recordTerminalResult,
  recordTerminalRun,
  requestInquiry,
  type TenderActor,
} from '../services/payments/terminal';
import { startPaymentTender } from '../services/payments/routing';

/**
 * THE TENDER SURFACE (S2-10a, SCRUM-206) — gateway QR, the card terminal, the inquiry, the
 * audited confirmation, a manual entry, and the box's way back.
 *
 * WHY IT IS `/payments/*` AND NOT UNDER `/sales/*`. `apps/api/test/sales.test.ts`
 * pins the `/sales` path list and the six route guards exactly, in both
 * directions, so a terminal route added there is a test failure by
 * construction — on purpose: `/sales` is the ledger's surface and a tender in
 * flight is not a sale.
 *
 *   POST /payments/attempts                 use the station's terminal or QR gateway
 *   GET  /payments/attempts/:id             what the till polls while it waits
 *   POST /payments/attempts/:id/result      the box says what the terminal did
 *   POST /payments/attempts/:id/inquire     ask the terminal again, by hand
 *   POST /payments/attempts/:id/confirm     a person reads the terminal's screen
 *   POST /payments/manual                   an approval code keyed in off a slip
 *   POST /payments/terminal-simulator       what a simulated terminal will do next
 *
 * WHY THE OUTCOME COMES BACK ON ITS OWN ROUTE rather than on the command's
 * acknowledgement: the customer-interaction budget is 120 seconds
 * (`DEVICE_INVENTORY.md:948`) and a command poll is five, so an HTTP call held
 * open for a guest tapping a card is a till that looks hung. A print job's
 * outcome already works this way (`POST /box/v1/print-jobs/:id/result`) and
 * this follows it, including the credential: the caller is a machine, it may
 * only speak about attempts on its own terminals, and an attempt it does not
 * own answers 404 rather than 403 so an id cannot be confirmed by probing.
 *
 * WHAT CLOSES THE SALE, stated here because it is the one thing a reader will
 * look for and not find: nothing in this file does. An approved tender settles
 * its attempt and leaves the sale exactly as `finaliseSale` left it — the sale
 * closes, and its receipt number is spent, on the till's own
 * `POST /sales/:id/finalise`, which sees the balance already at zero and takes
 * no second tender. That is deliberate. The box is the actor on the result
 * route and it cannot answer for the things finalising asks about — the
 * pick-up code on a food order, the branch scope of the person at the counter —
 * and a split tender has a second press coming anyway.
 */

const IdParams = z.object({ id: z.string().uuid() });

/** The same shape the telemetry plugin accepts, so one id follows one gesture. */
const ACTION_ID = /^[A-Za-z0-9._-]{8,64}$/;

function actionIdOf(headers: Record<string, unknown>): string | null {
  const sent = headers['x-oto-action-id'];
  return typeof sent === 'string' && ACTION_ID.test(sent) ? sent : null;
}

/** `PaymentAttemptView` as a schema, so the OpenAPI document carries it. */
const AttemptSchema = z.object({
  id: z.string().uuid(),
  saleId: z.string().uuid().nullable(),
  method: z.enum(PAYMENT_METHODS),
  provider: z.enum(PAYMENT_PROVIDERS),
  status: z.enum(PAYMENT_ATTEMPT_STATUSES),
  amountSatang: z.number().int(),
  tenderedSatang: z.number().int().nullable(),
  changeSatang: z.number().int().nullable(),
  terminalRef: z.string().nullable(),
  tid: z.string().nullable(),
  approvalCode: z.string().nullable(),
  last4: z.string().nullable(),
  invoiceNo: z.string().nullable(),
  tranRef: z.string().nullable(),
  actionId: z.string().nullable(),
  offline: z.boolean(),
  paidAt: z.string().nullable(),
  createdAt: z.string(),
});

/**
 * What the box posts, and the FIRST of the three nets that keep a card number
 * out of the database.
 *
 * zod strips what it does not name, so a firmware version that starts sending
 * the cardholder's name, or an agent posting a raw frame for convenience, has
 * that dropped here before anything reads it. The second net is
 * `ATTEMPT_ALLOW_LIST` on what is stored; the third is `packages/telemetry`'s
 * redaction under every `ops_run.detail`. `apps/api/test/payments-redaction.test.ts`
 * drives all three with a real Digio `A1` frame.
 */
const ResultBody = z.discriminatedUnion('stage', [
  z.object({
    stage: z.literal('progress'),
    kind: z.enum(['sent', 'qr_payload']),
    deviceId: z.string().uuid().nullable().optional(),
    qrPayload: z.string().max(4096).nullable().optional(),
    tranRef: z.string().max(64).nullable().optional(),
    at: z.string().max(40).nullable().optional(),
  }),
  z.object({
    stage: z.literal('final'),
    deviceId: z.string().uuid().nullable().optional(),
    protocol: z.string().max(32).nullable().optional(),
    outcome: z.enum(TERMINAL_OUTCOME_KINDS),
    requestedSatang: z.number().int().min(0).nullable().optional(),
    approvedSatang: z.number().int().min(0).nullable().optional(),
    terminalRef: z.string().max(32).nullable().optional(),
    tranRef: z.string().max(64).nullable().optional(),
    invoiceNo: z.string().max(20).nullable().optional(),
    approvalCode: z.string().max(12).nullable().optional(),
    /** Four digits or nothing; the column CHECK says the same. */
    last4: z.string().regex(/^\d{4}$/).nullable().optional(),
    tid: z.string().max(32).nullable().optional(),
    mid: z.string().max(32).nullable().optional(),
    qrPayload: z.string().max(4096).nullable().optional(),
    responseCode: z.string().max(8).nullable().optional(),
    responseText: z.string().max(200).nullable().optional(),
    elapsedMs: z.number().int().min(0).nullable().optional(),
    at: z.string().max(40).nullable().optional(),
  }),
]);

/**
 * The two simulator instructions that cannot ride the command queue.
 *
 * `services/fleet.ts:1605-1611` refuses every action on
 * `SIMULATOR_ACTIONS_WITH_SECRETS` at the queue, because `box_command.payload`
 * is a stored jsonb column the Console renders as command history — and
 * `terminal.outcome` can carry the approval code the simulated terminal will
 * print. So it travels the way a badge and a PIN travel: a route that delivers
 * the value to the agent in this process and keeps none of it, which is the
 * same door `POST /stations/:id/badge` and `POST /stations/:id/scan/simulate`
 * already use.
 *
 * The narrow schema below is what OpenAPI publishes; the shared union is then
 * re-parsed in the handler, so the two vocabularies cannot drift apart without
 * this route refusing at the keyboard.
 */
const TerminalSimulatorBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('terminal.outcome'),
    deviceId: z.string().uuid(),
    outcome: z.enum(TERMINAL_OUTCOMES),
    approvedSatang: z.number().int().min(0).optional(),
    approvalCode: z.string().min(1).max(12).optional(),
  }),
  z.object({
    action: z.literal('terminal.advance_clock'),
    deviceId: z.string().uuid(),
    minutes: z.number().int().min(1).max(60 * 24 * 7),
  }),
]);

export async function paymentRoutes(app: App): Promise<void> {
  /**
   * The acting account, carrying the scope check for whichever branch the SALE
   * turns out to be for.
   *
   * Copied in shape from `routes/sales.ts` and for its reason: a route guard
   * can only check what is in the request, and the branch a tender belongs to
   * is on the sale rather than in the URL. `requirePermission` with an empty
   * target falls back to the SESSION's branch, which says yes to a tender
   * against any branch at all.
   */
  const actorOf = (req: FastifyRequest, permission: Permission): TenderActor => {
    const auth = req.requireAuth();
    return {
      accountId: auth.accountId,
      operatorId: auth.operatorId,
      requestId: req.id,
      assertBranchAllowed: async (branchId: string) => {
        await req.requirePermission(permission, { branchId });
      },
    };
  };

  // --- Sending a tender to the terminal -------------------------------------

  app.post(
    '/attempts',
    {
      config: { permission: 'pos:payment:capture', stationTrading: true },
      schema: {
        description:
          'Take a tender using the station’s saved routing: a terminal, the QR gateway, or ' +
          'manual card entry. Gateway QR answers with its payload and expiry; terminal outcomes ' +
          'arrive later from the box. The till polls the attempt while it waits. Manual routing ' +
          'opens no attempt.',
        body: z.object({
          saleId: z.string().uuid(),
          amountSatang: z.number().int().min(1).optional(),
          tender: z.enum(TERMINAL_TENDERS).default('card'),
          method: z.string().max(40).optional(),
          kind: z.string().max(20).optional(),
          wallet: z.string().max(32).nullish(),
          qrDirection: z.enum(['show', 'scan']).optional(),
          requestQrPayload: z.boolean().optional(),
          cashier: z.string().max(64).nullish(),
          actionId: z.string().min(1).max(200).optional(),
        }),
        response: {
          200: z.object({
            route: z.enum(['card_terminal', 'manual', 'gateway']),
            attempt: AttemptSchema.nullable(),
            replayed: z.boolean(),
            outstandingSatang: z.number().int(),
            qrPayload: z.string().nullable(),
            qrImageUrl: z.string().nullable(),
            expiresAt: z.string().nullable(),
            expiryTimerMs: z.number().int().nullable(),
          }),
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req, 'pos:payment:capture');
      const actionId = req.body.actionId ?? actionIdOf(req.headers);
      const result = await startPaymentTender(app.db, app.env, req.log, opCtx(req), actor, {
        saleId: req.body.saleId,
        ...(req.body.amountSatang === undefined ? {} : { amountSatang: req.body.amountSatang }),
        tender: req.body.tender,
        ...(req.body.method ? { methodCode: req.body.method } : {}),
        ...(req.body.kind ? { kind: req.body.kind } : {}),
        wallet: req.body.wallet ?? null,
        ...(req.body.qrDirection ? { qrDirection: req.body.qrDirection } : {}),
        ...(req.body.requestQrPayload === undefined
          ? {}
          : { requestQrPayload: req.body.requestQrPayload }),
        cashier: req.body.cashier ?? null,
        actionId,
      });
      if (result.replayed) reply.header('x-oto-replay', 'true');
      return result;
    },
  );

  // --- What the till polls ---------------------------------------------------

  app.get(
    '/attempts/:id',
    {
      config: { permission: 'pos:payment:read' },
      schema: {
        description:
          'One tender as the till reads it while it waits: the status, provider response, ' +
          'QR payload and expiry when present, and what the sale still owes.',
        params: IdParams,
        response: {
          200: z.object({
            attempt: AttemptSchema,
            qrPayload: z.string().nullable(),
            qrImageUrl: z.string().nullable(),
            expiresAt: z.string().nullable(),
            expiryTimerMs: z.number().int().nullable(),
            deviceLabel: z.string().nullable(),
            responseText: z.string().nullable(),
            outstandingSatang: z.number().int().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      // Found first, asked about second — the trade every by-id loader in this
      // codebase makes: the branch to ask permission about is on the row, and a
      // row outside the caller's operator is "not found" before either.
      const row = await loadAttempt(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:payment:read', { branchId: row.branchId });
      return readAttempt(app.db, auth.operatorId, row.id);
    },
  );

  // --- The box's answer ------------------------------------------------------

  app.post(
    '/attempts/:id/result',
    {
      config: { credential: 'box' },
      schema: {
        description:
          'What the terminal did. Its own endpoint rather than a command result: a guest finding ' +
          'a card has two minutes and a command poll is five seconds. Safe to retry — an attempt ' +
          'that has already settled is answered as a replay and nothing is written a second time.',
        params: IdParams,
        body: ResultBody,
        response: {
          200: z.object({
            attempt: AttemptSchema,
            replayed: z.boolean(),
            phase: z.enum(['sale', 'inquire', 'void']),
          }),
        },
      },
    },
    async (req) => {
      const auth = boxAuthOf(req);
      const loaded = await loadAttemptForBox(app.db, auth, req.params.id);
      const ctx = opCtx(req);
      const actionId = actionIdOf(req.headers);
      // Read once: `req.body` inside a closure is re-widened to the whole
      // union, so the discrimination has to be held in a local.
      const body = req.body;

      if (body.stage === 'progress') {
        const attempt = await withTx(app.db, ctx, 'payment.attempt.progress', (tx) =>
          recordTerminalProgress(tx, loaded, {
            kind: body.kind,
            qrPayload: body.qrPayload ?? null,
            tranRef: body.tranRef ?? null,
          }),
        );
        return { attempt, replayed: false, phase: 'sale' as const };
      }

      const startedAt = new Date();
      const recorded = await withTx(app.db, ctx, 'payment.attempt.result', (tx) =>
        recordTerminalResult(
          tx,
          ctx,
          loaded,
          {
            outcome: body.outcome,
            deviceId: body.deviceId ?? null,
            protocol: body.protocol ?? null,
            requestedSatang: body.requestedSatang ?? null,
            approvedSatang: body.approvedSatang ?? null,
            terminalRef: body.terminalRef ?? null,
            tranRef: body.tranRef ?? null,
            invoiceNo: body.invoiceNo ?? null,
            approvalCode: body.approvalCode ?? null,
            last4: body.last4 ?? null,
            tid: body.tid ?? null,
            mid: body.mid ?? null,
            qrPayload: body.qrPayload ?? null,
            responseCode: body.responseCode ?? null,
            responseText: body.responseText ?? null,
            elapsedMs: body.elapsedMs ?? null,
            at: body.at ?? null,
          },
          actionId,
        ),
      );
      /**
       * The run is written AFTER the transaction, on the pool, exactly as a
       * print job's failure is: the record of an attempt has to outlive the
       * transaction that recorded it, and an `ops_run` written inside would
       * disappear with a rollback that is itself the thing worth knowing about.
       * A replay writes none — the box retrying a lost acknowledgement is not a
       * second exchange with a terminal.
       */
      if (!recorded.replayed) {
        await recordTerminalRun(app.db, {
          run: recorded.run,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          stationId: loaded.attempt.stationId,
          actionId,
          requestId: req.id,
          startedAt,
        });
      }
      return { attempt: recorded.attempt, replayed: recorded.replayed, phase: recorded.phase };
    },
  );

  // --- Chasing an answer that never came ------------------------------------

  app.post(
    '/attempts/:id/inquire',
    {
      config: { permission: 'pos:payment:confirm', stationTrading: true },
      schema: {
        description:
          'Ask the terminal again what happened to a tender it never answered about. Refused on a ' +
          'dialect that has no inquiry for this tender — a NEXGO card sale has none at all, which ' +
          'is why the staff confirmation below is that terminal’s permanent answer and not a fallback.',
        params: IdParams,
        response: { 200: z.object({ attempt: AttemptSchema }) },
      },
    },
    async (req) => {
      const actor = actorOf(req, 'pos:payment:confirm');
      return withTx(app.db, opCtx(req), 'payment.attempt.inquire', async (tx) => ({
        attempt: await requestInquiry(tx, actor, req.params.id),
      }));
    },
  );

  app.post(
    '/attempts/:id/confirm',
    {
      config: { permission: 'pos:payment:confirm', stationTrading: true },
      schema: {
        description:
          'A person reads the terminal’s own screen and says whether the money was taken. Written ' +
          'with their account id on the attempt and in the audit log: a confirmation nobody is ' +
          'named on is the thing an investigation would be looking for.',
        params: IdParams,
        body: z.object({
          took: z.boolean(),
          approvalCode: z.string().max(12).nullish(),
          tid: z.string().max(32).nullish(),
          last4: z.string().regex(/^\d{4}$/).nullish(),
          note: z.string().max(280).nullish(),
        }),
        response: { 200: z.object({ attempt: AttemptSchema }) },
      },
    },
    async (req) => {
      const actor = actorOf(req, 'pos:payment:confirm');
      return withTx(app.db, opCtx(req), 'payment.attempt.confirm', async (tx) => ({
        attempt: await confirmAttempt(tx, actor, req.params.id, {
          took: req.body.took,
          approvalCode: req.body.approvalCode ?? null,
          tid: req.body.tid ?? null,
          last4: req.body.last4 ?? null,
          note: req.body.note ?? null,
          actionId: actionIdOf(req.headers),
        }),
      }));
    },
  );

  // --- Keyed in off the slip -------------------------------------------------

  app.post(
    '/manual',
    {
      config: { permission: 'pos:payment:capture', stationTrading: true },
      schema: {
        description:
          'Record a card tender taken on a terminal the platform cannot reach: the approval code ' +
          'and TID read off its slip, no device, provider “manual”, audited with the account that ' +
          'keyed it in. This is what a station routed card=manual uses, and what is left when a ' +
          'terminal is unplugged mid-service.',
        body: z.object({
          saleId: z.string().uuid(),
          amountSatang: z.number().int().min(1).optional(),
          method: z.string().max(40).optional(),
          kind: z.string().max(20).optional(),
          approvalCode: z.string().min(1).max(12),
          tid: z.string().max(32).nullish(),
          last4: z.string().regex(/^\d{4}$/).nullish(),
          reference: z.string().max(120).nullish(),
          actionId: z.string().min(1).max(200).optional(),
        }),
        response: {
          200: z.object({
            attempt: AttemptSchema,
            replayed: z.boolean(),
            outstandingSatang: z.number().int(),
          }),
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req, 'pos:payment:capture');
      const result = await withTx(app.db, opCtx(req), 'payment.tender.manual', (tx) =>
        recordManualTender(tx, actor, {
          saleId: req.body.saleId,
          ...(req.body.amountSatang === undefined ? {} : { amountSatang: req.body.amountSatang }),
          ...(req.body.method ? { methodCode: req.body.method } : {}),
          ...(req.body.kind ? { kind: req.body.kind } : {}),
          approvalCode: req.body.approvalCode,
          tid: req.body.tid ?? null,
          last4: req.body.last4 ?? null,
          reference: req.body.reference ?? null,
          actionId: req.body.actionId ?? actionIdOf(req.headers),
        }),
      );
      if (result.replayed) reply.header('x-oto-replay', 'true');
      return result;
    },
  );

  // --- Making a simulated terminal behave badly on purpose -------------------

  app.post(
    '/terminal-simulator',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'What a SIMULATED terminal will do with the next tender sent to it, or how far its own ' +
          'clock has moved. Delivered to the agent in this process and kept nowhere: an approval ' +
          'code is a value to carry, not a value to store in a command payload the Console renders.',
        body: TerminalSimulatorBody,
        response: {
          200: z.object({
            applied: z.boolean(),
            deviceLabel: z.string(),
            actionId: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadDevice(app.db, auth.operatorId, req.body.deviceId);
      await req.requirePermission('admin:box:command', { branchId: row.branchId });
      /**
       * Re-parsed against the shared union, which is the same validation
       * `queueCommand` runs for every other simulator action. Two copies of a
       * vocabulary that drift apart are a control that silently does nothing;
       * this makes the drift a refusal here instead.
       */
      const parsed = SimulatorActionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw errors.badRequest('That is not a simulator action this platform knows', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const action = parsed.data;
      if (action.action !== 'terminal.outcome' && action.action !== 'terminal.advance_clock') {
        throw errors.badRequest('This route carries the two terminal simulator actions only');
      }
      if (row.transport !== 'simulated') {
        throw errors.conflict(
          'DEVICE_NOT_SIMULATED',
          `${row.label} is a real terminal — an outcome can only be set on a simulated one`,
          { deviceId: row.id },
        );
      }
      if (!row.boxId) {
        throw errors.conflict('TERMINAL_HAS_NO_BOX', 'That terminal is not plugged into a box');
      }
      /**
       * IN THIS PROCESS ONLY, and the panel says so rather than pretending.
       *
       * A simulator's state lives in the agent that owns it, so it can only be
       * set from the process that agent is in — the api carrying the `edge`
       * role, which is where every simulated terminal in this deployment runs.
       * A Raspberry Pi's simulators are reached through the command queue, and
       * this action may not use it.
       */
      const terminals = inProcessBox(row.boxId)?.terminal();
      if (!terminals) {
        throw new AppError(
          409,
          'BOX_NOT_IN_THIS_PROCESS',
          'That box is not running here, so its simulated terminals cannot be reached from this api',
          { boxId: row.boxId },
        );
      }
      const applied =
        action.action === 'terminal.outcome'
          ? terminals.setOutcome(row.id, action.outcome, {
              ...(action.approvedSatang === undefined
                ? {}
                : { approvedSatang: action.approvedSatang }),
              ...(action.approvalCode === undefined ? {} : { approvalCode: action.approvalCode }),
            })
          : terminals.advanceClock(row.id, action.minutes);
      if (!applied) {
        throw errors.conflict(
          'NO_SIMULATOR_FOR_DEVICE',
          `${row.label} has no simulator standing on its box — no station is using it`,
          { deviceId: row.id },
        );
      }
      return {
        applied,
        deviceLabel: row.label,
        // Minted here: nothing is stored, so there is no command row to carry
        // an id, and the Box log line the agent writes carries this one.
        actionId: actionIdOf(req.headers) ?? newId(),
      };
    },
  );
}
