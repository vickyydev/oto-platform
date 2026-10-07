import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { branch, registration, sale, supervisionWaiver } from '@oto/db';
import {
  AddRegistrationChildrenSchema,
  AttachRegistrationPhotoSchema,
  CheckInNowSchema,
  CreateRegistrationSchema,
  CreateWaiverSchema,
  LeaveAsBookedSchema,
} from '@oto/shared';
import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { REPLAY_HEADER, claimClientId } from '../services/client-id';
import {
  addRegistrationChildren,
  assignNanny,
  attachRegistrationPhoto,
  boardOf,
  checkInBooked,
  checkInNow,
  checkinHistory,
  createRegistration,
  dropOffToday,
  editCheckin,
  filterBoard,
  getRegistration,
  leaveAsBooked,
  loadRegistration,
  loadStay,
  nannyRosterOf,
  recordContactStatus,
  recordWaiver,
  registrationsAwaitingCheckIn,
  saveConfirmations,
  savePolicy,
  savePricing,
  sendContactTest,
  supervisionConfigOf,
  waiverViewOf,
  type Actor,
} from '../services/checkin';
import { buildSmsSender, type SmsSender } from '../services/sms';
import { opCtx, withTx } from '../services/tx';

/**
 * S2-13 round 1 — the supervision gate's routes (plan
 * docs/progress/plans/checkin/PLAN.md §2.2), online.
 *
 * The till calls these where the prototype called its in-memory mutators:
 * the gate registers the family (`POST /checkin/registrations`), records a
 * staff-accepted waiver (`POST /checkin/waivers`) and attaches the consent
 * photo; after payment the check-in choice either puts the children in the
 * park with their bands (`POST /checkin/check-in-now`) or leaves them booked
 * (`POST /checkin/leave-as-booked`).
 *
 * Every route is a staff session's — a paired display never reaches them, so
 * the waiver is staff-only by construction as well as by permission (OD-C3).
 */

const ACTION_ID = /^[A-Za-z0-9._-]{8,64}$/;

function actorOf(req: FastifyRequest): Actor {
  const auth = req.requireAuth();
  const sent = req.headers['x-oto-action-id'];
  return {
    accountId: auth.accountId,
    operatorId: auth.operatorId,
    requestId: req.id,
    actionId: typeof sent === 'string' && ACTION_ID.test(sent) ? sent : null,
  };
}

export async function checkinRoutes(app: App): Promise<void> {
  app.get(
    '/config',
    {
      config: { permission: 'pos:checkin:read', target: { branchId: 'query.branchId' } },
      schema: {
        description: "The branch's supervision policy, confirmations, drop-off pricing and nanny roster",
        querystring: z.object({ branchId: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await assertBranchOfOperator(app, auth.operatorId, req.query.branchId);
      const config = await supervisionConfigOf(app.db, req.query.branchId);
      return { ...config, nannies: await nannyRosterOf(app.db, req.query.branchId) };
    },
  );

  app.get(
    '/registrations',
    {
      config: { permission: 'pos:checkin:read', target: { branchId: 'query.branchId' } },
      schema: {
        description: 'Registrations at the branch still waiting for a child to be checked in',
        querystring: z.object({ branchId: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return { registrations: await registrationsAwaitingCheckIn(app.db, auth.operatorId, req.query.branchId) };
    },
  );

  app.post(
    '/registrations',
    {
      config: { permission: 'pos:checkin:create', target: { branchId: 'body.branchId' } },
      schema: {
        description:
          'Register the children left with the park, with the consent taken on the customer display. ' +
          'Client-minted id (OD-12): the same id again answers with the registration under x-oto-replay.',
        body: CreateRegistrationSchema,
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const claim = await claimClientId(
        req.body.id,
        async (id) => (await app.db.select().from(registration).where(eq(registration.id, id)).limit(1))[0],
        (row) => row.operatorId === actor.operatorId && row.branchId === req.body.branchId,
      );
      if (claim.replay) {
        reply.header(REPLAY_HEADER, 'true');
        return getRegistration(app.db, actor.operatorId, claim.id);
      }
      const config = await supervisionConfigOf(app.db, req.body.branchId);
      return withTx(app.db, { ...opCtx(req), branchId: req.body.branchId }, 'registration.create', (tx) =>
        createRegistration(tx, actor, { ...req.body, id: claim.id }, config, consoleMessenger(req)),
      );
    },
  );

  app.get(
    '/registrations/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'One registration with its children',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const reg = await loadRegistration(app.db, actor.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:read', { branchId: reg.branchId });
      return getRegistration(app.db, actor.operatorId, reg.id);
    },
  );

  app.post(
    '/registrations/:id/children',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Add a sibling to a registration still waiting to be checked in',
        params: z.object({ id: z.string().uuid() }),
        body: AddRegistrationChildrenSchema,
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const reg = await loadRegistration(app.db, actor.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:create', { branchId: reg.branchId });
      return withTx(app.db, { ...opCtx(req), branchId: reg.branchId }, 'checkin.create', (tx) =>
        addRegistrationChildren(tx, actor, reg, req.body.children),
      );
    },
  );

  app.post(
    '/registrations/:id/photo',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Attach the uploaded child-and-guardian photo to the registration',
        params: z.object({ id: z.string().uuid() }),
        body: AttachRegistrationPhotoSchema,
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const reg = await loadRegistration(app.db, actor.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:update', { branchId: reg.branchId });
      return withTx(app.db, { ...opCtx(req), branchId: reg.branchId }, 'registration.photo', (tx) =>
        attachRegistrationPhoto(tx, actor, reg, req.body),
      );
    },
  );

  app.post(
    '/waivers',
    {
      // OD-C3: staff only, ENFORCED. The prototype stored `staffOnly` and never
      // read it; here the permission is the rule, on a staff session.
      config: { permission: 'pos:checkin:update', target: { branchId: 'body.branchId' } },
      schema: {
        description:
          'Record a staff-accepted sibling waiver. Refused when the policy does not allow it for these two children. ' +
          'Client-minted id (OD-12).',
        body: CreateWaiverSchema,
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const claim = await claimClientId(
        req.body.id,
        async (id) => (await app.db.select().from(supervisionWaiver).where(eq(supervisionWaiver.id, id)).limit(1))[0],
        (row) => row.operatorId === actor.operatorId && row.branchId === req.body.branchId,
      );
      if (claim.replay) {
        reply.header(REPLAY_HEADER, 'true');
        return waiverViewOf(claim.row);
      }
      const config = await supervisionConfigOf(app.db, req.body.branchId);
      return withTx(app.db, { ...opCtx(req), branchId: req.body.branchId }, 'supervision_waiver.create', (tx) =>
        recordWaiver(tx, actor, { ...req.body, id: claim.id }, config),
      );
    },
  );

  app.post(
    '/check-in-now',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "After payment: put the registration's children in the park, link the sale, mint and print their bands — one transaction",
        body: CheckInNowSchema,
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const branchId = await saleBranchOf(app, actor.operatorId, req.body.saleId);
      await req.requirePermission('pos:checkin:update', { branchId });
      return withTx(app.db, { ...opCtx(req), branchId }, 'checkin.check_in', (tx) => checkInNow(tx, actor, req.body));
    },
  );

  app.post(
    '/leave-as-booked',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'After payment: keep the children registered with the booked start and length; no band',
        body: LeaveAsBookedSchema,
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const branchId = await saleBranchOf(app, actor.operatorId, req.body.saleId);
      await req.requirePermission('pos:checkin:update', { branchId });
      return withTx(app.db, { ...opCtx(req), branchId }, 'checkin.leave_booked', (tx) =>
        leaveAsBooked(tx, actor, req.body),
      );
    },
  );

  await boardRoutes(app);
}

// ================================================================================
// S2-13 round 2 — THE BOARD (plan §2.3). The DropOff page's reads and writes,
// where the prototype called `getCheckIns`, `updateCheckIn`, `assignNanny`,
// `checkInFamilyBooked` and the WhatsApp connection-check mutators. Reads are
// the till's branch reads (`pos:checkin:read` on the branch); every write is
// `pos:checkin:update` on the stay's own branch, in one transaction with its
// audit rows, behind the idempotency key the client sends.
// ================================================================================

const TAB = z.enum(['registered', 'in_park', 'out']);
const CHANNEL = z.enum(['whatsapp', 'telegram', 'line']);
const SERVICE = z.enum(['none', 'drop_off', 'nanny']);
const flag = z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true');

const EditCheckinSchema = z
  .object({
    childName: z.string().trim().min(1).max(120).optional(),
    childAgeYears: z.number().int().min(0).max(17).optional(),
    service: SERVICE.optional(),
    bookedMinutes: z.number().int().positive().max(24 * 60).nullable().optional(),
    mayOrderFood: z.boolean().optional(),
    foodRestrictions: z.string().max(500).nullable().optional(),
    allergies: z.string().max(1000).nullable().optional(),
    nannyId: z.string().uuid().nullable().optional(),
    guardianName: z.string().trim().min(1).max(120).optional(),
    guardianPhone: z.string().max(40).nullable().optional(),
    contactChannel: CHANNEL.optional(),
  })
  .strict();

const WeekdayWeekend = z.object({ weekday: z.number().int().min(0), weekend: z.number().int().min(0) });
const BranchQuery = z.object({ branchId: z.string().uuid() });

/** The platform's console messaging adapter (the booking confirmation's), for the connection check. */
function consoleMessenger(req: FastifyRequest): SmsSender {
  return buildSmsSender({ adapter: 'console' }, req.log as unknown as Logger);
}

async function boardRoutes(app: App): Promise<void> {
  app.get(
    '/board',
    {
      config: { permission: 'pos:checkin:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          "The drop-off board: the park's families grouped by registration, with the three status tabs' counts, " +
          'the unconfirmed-channel count and the nanny roster. Optional filters apply the board\'s own filter and sort.',
        querystring: BranchQuery.extend({
          tab: TAB.optional(),
          service: z.enum(['nanny', 'drop_off']).optional(),
          unconfirmed: flag.optional(),
          due: flag.optional(),
          q: z.string().max(100).optional(),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await assertBranchOfOperator(app, auth.operatorId, req.query.branchId);
      const board = await boardOf(app.db, auth.operatorId, req.query.branchId);
      const { tab, service, unconfirmed, due, q } = req.query;
      if (tab || service || unconfirmed || due || q) {
        return { ...board, families: filterBoard(board.families, { tab, service, unconfirmed, due, q }) };
      }
      return board;
    },
  );

  app.get(
    '/today',
    {
      config: { permission: 'pos:checkin:read', target: { branchId: 'query.branchId' } },
      schema: {
        description: "Today screen: the drop-off and nanny children in the park now, and those still waiting",
        querystring: BranchQuery,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await assertBranchOfOperator(app, auth.operatorId, req.query.branchId);
      return dropOffToday(app.db, auth.operatorId, req.query.branchId);
    },
  );

  app.patch(
    '/checkins/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "Edit one child's stay — name and age (the saved child too), service, booked minutes, food and allergies, " +
          "nanny (on shift only), and the guardian's name, phone and channel. Each change is an audit row: the change log.",
        params: z.object({ id: z.string().uuid() }),
        body: EditCheckinSchema,
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const stay = await loadStay(app.db, actor.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:update', { branchId: stay.branchId });
      const sms = consoleMessenger(req);
      return withTx(app.db, { ...opCtx(req), branchId: stay.branchId }, 'checkin.update', (tx) =>
        editCheckin(tx, actor, stay.id, req.body, { sms }),
      );
    },
  );

  app.get(
    '/checkins/:id/history',
    {
      config: { dynamicPermission: true },
      schema: {
        description: "One stay's change history, read from its audit rows",
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const stay = await loadStay(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:read', { branchId: stay.branchId });
      return { entries: await checkinHistory(app.db, auth.operatorId, stay.id) };
    },
  );

  app.post(
    '/checkins/:id/nanny',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Assign a nanny to a child. Refused unless she is on shift now; over the suggested ratio is a warning, not a refusal.',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ nannyId: z.string().uuid() }).strict(),
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const stay = await loadStay(app.db, actor.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:update', { branchId: stay.branchId });
      return withTx(app.db, { ...opCtx(req), branchId: stay.branchId }, 'checkin.assign_nanny', (tx) =>
        assignNanny(tx, actor, stay.id, req.body.nannyId),
      );
    },
  );

  app.post(
    '/check-in-booked',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Check in booked, already-paid children from the board: no payment and no sale — the band is minted on the ' +
          'sale they were paid on, and printed.',
        body: z
          .object({
            entries: z
              .array(z.object({ checkinId: z.string().uuid(), nannyId: z.string().uuid().nullable().optional() }).strict())
              .min(1)
              .max(20),
            consentAcknowledged: z.boolean().optional(),
          })
          .strict(),
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const first = await loadStay(app.db, actor.operatorId, req.body.entries[0]!.checkinId);
      await req.requirePermission('pos:checkin:update', { branchId: first.branchId });
      return withTx(app.db, { ...opCtx(req), branchId: first.branchId }, 'checkin.check_in_booked', (tx) =>
        // S2-20 K1 — a child the kiosk's sale left booked prints at the till this session stands at.
        checkInBooked(tx, actor, req.body, new Date(), { printAt: req.auth?.stationId ?? null }),
      );
    },
  );

  app.post(
    '/registrations/:id/contact-test',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "Send the guardian the connection check on their channel (through the console messaging adapter); the family's chip goes pending",
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const reg = await loadRegistration(app.db, actor.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:update', { branchId: reg.branchId });
      const sms = consoleMessenger(req);
      return withTx(app.db, { ...opCtx(req), branchId: reg.branchId }, 'registration.contact', (tx) =>
        sendContactTest(tx, actor, reg, sms),
      );
    },
  );

  app.post(
    '/registrations/:id/contact-status',
    {
      config: { dynamicPermission: true },
      schema: {
        description: "Record the guardian's answer to the connection check: confirmed, or could not be reached",
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ status: z.enum(['confirmed', 'failed']) }).strict(),
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const reg = await loadRegistration(app.db, actor.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:update', { branchId: reg.branchId });
      return withTx(app.db, { ...opCtx(req), branchId: reg.branchId }, 'registration.contact', (tx) =>
        recordContactStatus(tx, actor, reg, req.body.status),
      );
    },
  );

  // --- The admin panels: supervision policy, confirmations, drop-off pricing ---

  app.put(
    '/config/policy',
    {
      config: { permission: 'catalog:package:update', target: { branchId: 'query.branchId' } },
      schema: {
        description: "Replace the branch's age bands and sibling-waiver rule (audited)",
        querystring: BranchQuery,
        body: z
          .object({
            bands: z
              .array(
                z.object({
                  id: z.string().min(1).max(100),
                  label: z.string().max(40),
                  minAge: z.number().int().min(0).max(17),
                  maxAge: z.number().int().min(0).max(99).nullable(),
                  requirement: SERVICE,
                }),
              )
              .max(20),
            siblingWaiver: z.object({
              enabled: z.boolean(),
              guardianMinAge: z.number().int().min(0).max(17),
              waivableRequirement: SERVICE,
              staffOnly: z.boolean(),
            }),
          })
          .strict(),
      },
    },
    async (req) => {
      const actor = actorOf(req);
      return withTx(app.db, { ...opCtx(req), branchId: req.query.branchId }, 'supervision_policy.update', (tx) =>
        savePolicy(tx, actor, req.query.branchId, req.body),
      );
    },
  );

  app.put(
    '/config/confirmations',
    {
      config: { permission: 'catalog:package:update', target: { branchId: 'query.branchId' } },
      schema: {
        description: "Replace the branch's consent confirmations checklist: kept items update, new ones are created, dropped ones are archived (audited)",
        querystring: BranchQuery,
        body: z
          .object({
            items: z
              .array(
                z.object({
                  id: z.string().min(1).max(100),
                  text: z.string().max(300),
                  required: z.boolean(),
                  order: z.number().int().min(0).max(1000),
                }),
              )
              .max(30),
          })
          .strict(),
      },
    },
    async (req) => {
      const actor = actorOf(req);
      return withTx(app.db, { ...opCtx(req), branchId: req.query.branchId }, 'confirmation_item.update', (tx) =>
        saveConfirmations(tx, actor, req.query.branchId, req.body.items),
      );
    },
  );

  app.put(
    '/config/pricing',
    {
      config: { permission: 'catalog:package:update', target: { branchId: 'query.branchId' } },
      schema: {
        description: "Replace the branch's drop-off and nanny pricing, in satang, and the nanny ratio it warns at (audited)",
        querystring: BranchQuery,
        body: z
          .object({
            oneTimeFee: WeekdayWeekend,
            nannyHourly: WeekdayWeekend,
            extraHour: WeekdayWeekend,
            fullDayHours: z.number().int().min(1).max(24),
            nannyRatioSoftMax: z.number().int().min(1).max(50),
            prepaidFoodUnused: z.enum(['refund', 'forfeit']),
          })
          .strict(),
      },
    },
    async (req) => {
      const actor = actorOf(req);
      return withTx(app.db, { ...opCtx(req), branchId: req.query.branchId }, 'drop_off_pricing.update', (tx) =>
        savePricing(tx, actor, req.query.branchId, req.body),
      );
    },
  );
}

async function assertBranchOfOperator(app: App, operatorId: string, branchId: string): Promise<void> {
  const [row] = await app.db.select({ operatorId: branch.operatorId }).from(branch).where(eq(branch.id, branchId)).limit(1);
  if (!row || row.operatorId !== operatorId) throw errors.notFound('Branch not found');
}

async function saleBranchOf(app: App, operatorId: string, saleId: string): Promise<string> {
  const [row] = await app.db
    .select({ branchId: sale.branchId, operatorId: sale.operatorId })
    .from(sale)
    .where(eq(sale.id, saleId))
    .limit(1);
  if (!row || row.operatorId !== operatorId) throw errors.notFound('Sale not found');
  return row.branchId;
}
