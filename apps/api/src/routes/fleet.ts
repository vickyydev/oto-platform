import { z } from 'zod';
import {
  BOX_COMMAND_KINDS,
  BOX_ROLES,
  BOX_STATUSES,
  DEVICE_CREDENTIAL_KINDS,
  DEVICE_KINDS,
  DEVICE_TRANSPORTS,
  STATION_ACCESS_SCOPES,
  STATION_CAPABILITIES,
  STATION_DEVICE_ROLES,
  STATION_KINDS,
} from '@oto/db';
import { newId } from '@oto/shared';
import type { App } from '../app';
import { AppError } from '../lib/errors';
import { holdsGrantAt } from '../services/access-control';
import {
  archiveBox,
  archiveDevice,
  archiveStation,
  createBox,
  createDevice,
  createStation,
  getStationView,
  listBoxes,
  listBranchStaff,
  listCommands,
  listCredentials,
  listDevices,
  listHeartbeats,
  listPickableStations,
  listStations,
  loadBox,
  loadBranchForOperator,
  loadCredential,
  loadDevice,
  loadStation,
  pairCredential,
  pickStation,
  queueCommand,
  reissueClaimCode,
  revokeCredential,
  updateBox,
  updateDevice,
  updateStation,
} from '../services/fleet';
import { opCtx } from '../services/tx';

/**
 * The fleet's ordinary HTTP surface (S2-04): what a person does to the estate,
 * and the one question a member of staff asks of it.
 *
 * **Registered with no prefix, declaring full paths**, exactly as
 * `catalogRoutes` is: branch-scoped resources are nested under
 * `/branches/:branchId/…` because that is what every other branch-scoped
 * resource in this API already does, and because a path parameter is required
 * by the router and validated before the guard runs. The querystring form the
 * POS originally proposed (`/stations?branchId=`) cannot be guarded safely:
 * omit the parameter and the permission check silently falls back to the
 * caller's session branch while the handler lists whatever it likes.
 *
 * **Every route keyed by a child id declares `dynamicPermission` and asks for
 * its permission at the row's own branch.** A plain `config: { permission }`
 * with no target checks against the CALLER's session branch and then acts on
 * whatever the id names — which would let a manager scoped to one branch edit a
 * till at another. The guard-enumeration test cannot catch that (a dynamic
 * declaration and a plain one both satisfy it), so it is stated here instead.
 *
 * **Three routes mint a one-time code** — creating a box, re-issuing its claim
 * code, pairing a screen. Each does its write inside `withTx` and returns a
 * value from that callback that does NOT contain the code, because `withTx`
 * stores exactly that value in `idempotency_key.response_body` for the length
 * of the replay window. The plaintext is merged into the HTTP answer
 * afterwards. A replay of the same key therefore answers with the row and no
 * code, which is what "one-time" has to mean.
 *
 * **Every service here returns the whole response body, wrapper key included.**
 * That is not a style: `withTx` stores its callback's return value and the
 * replay sends it back through the serializer below, so a service handing back
 * a bare view while the route wrapped it stored a body its own schema rejects —
 * and the second press of a button answered 500 for a day, with a failed
 * `ops_run` and a Sentry report behind it. The route adds nothing to what the
 * transaction stored.
 */

// --- Schemas ----------------------------------------------------------------

const BranchParams = z.object({ branchId: z.string().uuid() });
const IdParams = z.object({ id: z.string().uuid() });
const BoxIdParams = z.object({ boxId: z.string().uuid() });

/**
 * `z.coerce.boolean()` reads the string "false" as true, which is the opposite
 * of what `?includeArchived=false` asks for. An explicit two-value enum says
 * what it means and refuses anything else.
 */
const boolQuery = (fallback: 'true' | 'false' = 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');

const StationDeviceViewSchema = z.object({
  role: z.enum(STATION_DEVICE_ROLES),
  deviceId: z.string().uuid(),
  label: z.string(),
  kind: z.enum(DEVICE_KINDS),
  transport: z.enum(DEVICE_TRANSPORTS),
  address: z.string().nullable(),
});

/** A jsonb document whose shape is still moving (S2-10a names the tenders). */
const RoutingSchema = z.record(z.string(), z.unknown());

const StationSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  name: z.string(),
  kind: z.enum(STATION_KINDS),
  codePrefix: z.string().nullable(),
  boxId: z.string().uuid().nullable(),
  boxName: z.string().nullable(),
  boxStatus: z.enum(BOX_STATUSES).nullable(),
  capabilities: z.array(z.enum(STATION_CAPABILITIES)),
  accessScope: z.enum(STATION_ACCESS_SCOPES),
  configVersion: z.number().int(),
  paymentRouting: RoutingSchema.nullable(),
  offlineWalletCapSatang: z.number().int().nullable(),
  devices: z.array(StationDeviceViewSchema),
  staff: z.array(z.object({ accountId: z.string().uuid(), name: z.string().nullable() })),
  lastSeenAt: z.string().nullable(),
  archived: z.boolean(),
});

const PickableStationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(STATION_KINDS),
  accessScope: z.enum(STATION_ACCESS_SCOPES),
  boxId: z.string().uuid().nullable(),
  boxName: z.string().nullable(),
  boxStatus: z.enum(BOX_STATUSES).nullable(),
  deviceCount: z.number().int(),
});

/**
 * The device assignments are an ARRAY of `{ role, deviceId }`, not a map of
 * role to id-or-null. A map has three states — a value, an explicit null and a
 * missing key — where only two are meaningful, and each entry here maps one for
 * one onto `station_device`'s `(station_id, role)` unique index.
 *
 * `devices` and `staffAccountIds` are WHOLE sets, never deltas: present means
 * "make the table exactly this", absent means "leave it alone". One call, one
 * audit row, one before and after that reads as what it is.
 */
const StationWriteSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(STATION_KINDS),
  boxId: z.string().uuid().nullable(),
  codePrefix: z.string().min(1).max(8).nullable().optional(),
  capabilities: z.array(z.enum(STATION_CAPABILITIES)).default([]),
  accessScope: z.enum(STATION_ACCESS_SCOPES).default('all_staff'),
  staffAccountIds: z.array(z.string().uuid()).default([]),
  devices: z
    .array(z.object({ role: z.enum(STATION_DEVICE_ROLES), deviceId: z.string().uuid() }))
    .default([])
    .refine((list) => new Set(list.map((d) => d.role)).size === list.length, {
      message: 'One device per role — a second printer on a role is a change of assignment',
    }),
  paymentRouting: RoutingSchema.nullable().optional(),
  offlineWalletCapSatang: z.number().int().min(0).nullable().optional(),
});

const BoxSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  name: z.string(),
  slot: z.string(),
  role: z.enum(BOX_ROLES),
  status: z.enum(BOX_STATUSES),
  hostname: z.string().nullable(),
  agentVersion: z.string().nullable(),
  currentEpoch: z.number().int(),
  registeredAt: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
  heartbeatAgeSeconds: z.number().int().nullable(),
  lastStatus: RoutingSchema.nullable(),
  deviceCount: z.number().int(),
  stationCount: z.number().int(),
  claimCodeOutstanding: z.boolean(),
  claimCodeExpiresAt: z.string().nullable(),
  archived: z.boolean(),
});

const DeviceSchema = z.object({
  id: z.string().uuid(),
  boxId: z.string().uuid(),
  kind: z.enum(DEVICE_KINDS),
  label: z.string(),
  transport: z.enum(DEVICE_TRANSPORTS),
  address: z.string().nullable(),
  model: z.string().nullable(),
  protocol: z.string().nullable(),
  reachability: z.string(),
  paperStatus: z.string(),
  serialNumber: z.string().nullable(),
  terminalId: z.string().nullable(),
  merchantId: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  archived: z.boolean(),
});

const CredentialSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(DEVICE_CREDENTIAL_KINDS),
  stationId: z.string().uuid().nullable(),
  boxId: z.string().uuid().nullable(),
  label: z.string().nullable(),
  pairingOutstanding: z.boolean(),
  pairingCodeExpiresAt: z.string().nullable(),
  pairedAt: z.string().nullable(),
  pairedByAccountId: z.string().uuid().nullable(),
  lastSeenAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedReason: z.string().nullable(),
  scopes: z.array(z.string()),
});

const StaffCandidateSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().nullable(),
  phone: z.string(),
  status: z.enum(['active', 'invited']),
});

const CommandSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(BOX_COMMAND_KINDS),
  state: z.string(),
  payload: RoutingSchema.nullable(),
  result: RoutingSchema.nullable(),
  actionId: z.string().nullable(),
  requestedByAccountId: z.string().uuid().nullable(),
  attempts: z.number().int(),
  createdAt: z.string(),
  claimedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

const HeartbeatSchema = z.object({
  id: z.string().uuid(),
  receivedAt: z.string(),
  reportedAt: z.string().nullable(),
  clockOffsetMs: z.number().int().nullable(),
  agentVersion: z.string().nullable(),
  uptimeS: z.number().int().nullable(),
  tempC: z.number().nullable(),
  outboxDepth: z.number().int().nullable(),
});

const OkSchema = z.object({ ok: z.literal(true) });

/**
 * A one-time code is OPTIONAL in the response, and that is the rule showing
 * through rather than a hedge.
 *
 * The stored idempotency body deliberately has no code in it, so a REPLAY of a
 * minting request answers with the row alone. Declaring the code required would
 * turn every such replay into a serialization failure — the 500 the five
 * wrapper-key mismatches were answering until this pass, arrived at on purpose
 * this time — and both front ends already model it as optional. An absent code
 * does not mean "the API has not grown the field": it means this exact request
 * was already answered once and the code was shown then. The page has to say so
 * and offer to issue a new one.
 */
const oneTimeCode = z.string().optional();
const codeExpiry = z.string().optional();

/** The same shape the telemetry plugin accepts, so one id follows one gesture. */
const ACTION_ID = /^[A-Za-z0-9._-]{8,64}$/;

export async function fleetRoutes(app: App): Promise<void> {
  // --- The picker: the only place the visibility rule lives -----------------

  /**
   * No permission, deliberately. Picking a station is not administrative —
   * every member of staff does it at the start of every shift — and access
   * control here IS the visibility rule. Gating it on `admin:station:read`
   * would work today only because that permission happens to sit in the
   * `staff` bundle, and would lock the whole park out of the tills the day
   * somebody tidied it out.
   */
  app.get(
    '/me/stations',
    {
      config: { auth: 'session' },
      schema: {
        description:
          'Stations this account may work at its session’s branch. A station it may not use is ABSENT, never flagged.',
        response: { 200: z.object({ stations: z.array(PickableStationSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      /**
       * The branch comes off the session and never off a parameter — and, since
       * SCRUM-264, the session's branch is one the caller holds a grant at:
       * `PUT /me/session/branch` refuses any other, and this asks again rather
       * than trusting that, because a session seated before that rule existed
       * still carries whatever the old sign-in put on it.
       *
       * No branch in reach is an empty list, the same answer this route already
       * gives a platform-wide account that has not picked a branch yet. Nothing
       * here says a station was withheld: a station somebody may not use is
       * absent, never flagged.
       */
      const seated =
        auth.branchId &&
        holdsGrantAt(await req.effectivePermissions(), auth.operatorId, auth.branchId)
          ? auth.branchId
          : null;
      return {
        stations: await listPickableStations(app.db, {
          operatorId: auth.operatorId,
          branchId: seated,
          accountId: auth.accountId,
        }),
      };
    },
  );

  app.put(
    '/me/session/station',
    {
      // `secretResponse`: the answer now carries a shift token, which is a
      // bearer credential for an offline unlock. No idempotency key is taken,
      // so it is never stored to be replayed (S2-06).
      config: { auth: 'session', secretResponse: true },
      schema: {
        description:
          'Take a station for this session. Refused if archived, elsewhere, or not yours. The answer carries the shift token this station’s box verifies offline (S2-06); `staffTokenUnavailable` says why there is none when this deployment has no signing key.',
        body: z.object({ stationId: z.string().uuid() }),
        response: {
          200: z.object({
            station: StationSchema,
            staffToken: z
              .object({
                /** Bearer, for the offline unlock only. Kept by the till, never logged. */
                token: z.string(),
                jti: z.string().uuid(),
                expiresAt: z.string(),
              })
              .nullable(),
            staffTokenUnavailable: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return pickStation(app.db, opCtx(req), auth, req.body.stationId, app.env);
    },
  );

  // --- Stations -------------------------------------------------------------

  app.get(
    '/branches/:branchId/stations',
    {
      config: { permission: 'admin:station:read', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Every station of a branch, the restricted ones included. Administrators.',
        params: BranchParams,
        querystring: z.object({ includeArchived: boolQuery() }),
        response: { 200: z.object({ stations: z.array(StationSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranchForOperator(app.db, auth.operatorId, req.params.branchId);
      return {
        stations: await listStations(app.db, {
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          includeArchived: req.query.includeArchived,
        }),
      };
    },
  );

  app.post(
    '/branches/:branchId/stations',
    {
      config: { permission: 'admin:station:create', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Create a station on a box, with its devices and its access list',
        params: BranchParams,
        body: StationWriteSchema,
        response: { 200: z.object({ station: StationSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranchForOperator(app.db, auth.operatorId, req.params.branchId);
      return createStation(app.db, opCtx(req), auth, req.params.branchId, req.body);
    },
  );

  app.get(
    '/stations/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'One station, with its devices and who may use it',
        params: IdParams,
        response: { 200: z.object({ station: StationSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      // Loaded first because the branch to ask permission about is ON the row.
      // Scoped to the operator, so another tenant's id is "not found" rather
      // than "not allowed" — a refusal must not confirm what exists.
      const row = await loadStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:station:read', { branchId: row.branchId });
      return { station: await getStationView(app.db, row) };
    },
  );

  app.patch(
    '/stations/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Edit a station. Devices and the staff list are whole sets, not deltas.',
        params: IdParams,
        body: StationWriteSchema.partial(),
        response: { 200: z.object({ station: StationSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:station:update', { branchId: row.branchId });
      return updateStation(app.db, opCtx(req), auth, row, req.body);
    },
  );

  app.delete(
    '/stations/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Archive a station. Sessions holding it are not evicted mid-sale.',
        params: IdParams,
        response: { 200: OkSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:station:archive', { branchId: row.branchId });
      await archiveStation(app.db, opCtx(req), auth, row);
      return { ok: true as const };
    },
  );

  /**
   * Guarded in the station family rather than by `admin:account:read`: this
   * serves the station editor's own picker and answers "who may I put on this
   * station's list", not "show me the staff directory".
   *
   * SCRUM-300 — but by the READ of that family, not the update. This route
   * writes nothing, and a caller refused it was being told they were missing a
   * permission to CHANGE stations, which is neither what they asked for nor
   * what they would ask to be granted. `admin:station:read` is the permission
   * that already opens the admin station list, and that list carries each
   * station's staff — so the names here are visible to exactly the people who
   * can already read them one screen along, and to nobody else: the permission
   * is deliberately kept out of the counter bundle, so reception still cannot
   * enumerate a park's staff through it.
   */
  app.get(
    '/branches/:branchId/staff',
    {
      config: { permission: 'admin:station:read', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Accounts that can be put on a station’s list: the staff of that branch',
        params: BranchParams,
        response: { 200: z.object({ staff: z.array(StaffCandidateSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranchForOperator(app.db, auth.operatorId, req.params.branchId);
      return { staff: await listBranchStaff(app.db, auth.operatorId, req.params.branchId) };
    },
  );

  // --- Boxes ----------------------------------------------------------------

  app.get(
    '/branches/:branchId/boxes',
    {
      config: { permission: 'admin:box:read', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'The boxes standing at a branch, whether or not a station uses them yet',
        params: BranchParams,
        querystring: z.object({ includeArchived: boolQuery() }),
        response: { 200: z.object({ boxes: z.array(BoxSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranchForOperator(app.db, auth.operatorId, req.params.branchId);
      return {
        boxes: await listBoxes(app.db, {
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          includeArchived: req.query.includeArchived,
        }),
      };
    },
  );

  app.post(
    '/branches/:branchId/boxes',
    {
      /**
       * SCRUM-255(c) / SCRUM-327 — THE THREE ROUTES THAT MINT A CODE SAY SO.
       *
       * This one and the two below answer with a one-time code and declared
       * nothing. What kept the code out of the replay store was a habit in the
       * service layer: `createBox`, `reissueClaimCode` and `pairCredential`
       * each return a code-FREE value from inside `withTx`, `withTx` stores
       * that value and marks the key stored, and the fuller body that goes out
       * on the wire is therefore never looked at again. Correct, and correct
       * by convention — the next person minting a credential has to know the
       * convention, and nothing would tell them.
       *
       * (Measured, because the ticket assumed otherwise: with all three
       * declarations removed, the plugin's `carriesSecret` backstop logs
       * NOTHING on this surface. It cannot — `withTx` has already stored and
       * marked the claim, so `onSend` returns before the check. The backstop
       * covers the route that returns its credential from INSIDE the
       * transaction, which is the shape these three do not have.)
       *
       * Declaring it puts the guarantee where a reader and a test can see it:
       * no key is claimed at all, so there is nothing to store whatever the
       * service returns, and the pinned list in
       * `test/route-write-conformance.test.ts` is where it is written down.
       *
       * THE COST, stated because it is real: this route was replay-idempotent
       * and is no longer. A double press used to be answered from the store
       * with the box and no code; it now runs again and is refused 409
       * `BOX_SLOT_TAKEN` by `box_slot_unique`. A clear refusal rather than a
       * second box — but it is a change, and it is the reason to keep this
       * declaration and the slot constraint together.
       */
      config: {
        permission: 'admin:box:register',
        target: { branchId: 'params.branchId' },
        secretResponse: true,
      },
      schema: {
        description:
          'Register a box and mint its claim code. The code is returned once — only its hash is stored.',
        params: BranchParams,
        body: z.object({
          name: z.string().min(1),
          slot: z.string().min(1),
          role: z.enum(BOX_ROLES).default('counter'),
        }),
        response: {
          200: z.object({ box: BoxSchema, claimCode: oneTimeCode, expiresAt: codeExpiry }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranchForOperator(app.db, auth.operatorId, req.params.branchId);
      return createBox(app.db, opCtx(req), auth, req.params.branchId, req.body);
    },
  );

  app.patch(
    '/boxes/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Edit a box, or take it out of service. Disabling revokes its credential on the spot.',
        params: IdParams,
        body: z
          .object({
            name: z.string().min(1).optional(),
            slot: z.string().min(1).optional(),
            role: z.enum(BOX_ROLES).optional(),
            status: z.enum(BOX_STATUSES).optional(),
          })
          .strict(),
        response: { 200: z.object({ box: BoxSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBox(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:box:update', { branchId: row.branchId });
      return updateBox(app.db, opCtx(req), auth, row, req.body);
    },
  );

  app.post(
    '/boxes/:id/claim-code',
    {
      /**
       * `secretResponse` for the reason given on the register route above.
       * What a retry does here: `issueClaimCode` overwrites this box's
       * `claim_code_hash` and drops its live secret, so a second identical
       * request leaves exactly one code usable — the newest — and the person
       * retrying reads the one they were last given.
       */
      config: { dynamicPermission: true, secretResponse: true },
      schema: {
        description:
          'Re-issue a claim code. The box’s live secret is dropped with it, so a stolen box is cut off now.',
        params: IdParams,
        response: { 200: z.object({ claimCode: oneTimeCode, expiresAt: codeExpiry }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBox(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:box:register', { branchId: row.branchId });
      return reissueClaimCode(app.db, opCtx(req), auth, row);
    },
  );

  app.delete(
    '/boxes/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Archive a box. Refused while live stations still sit on it.',
        params: IdParams,
        response: { 200: OkSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBox(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:box:archive', { branchId: row.branchId });
      await archiveBox(app.db, opCtx(req), auth, row);
      return { ok: true as const };
    },
  );

  app.get(
    '/boxes/:id/commands',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'What this box has been asked to do, newest first',
        params: IdParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(25) }),
        response: { 200: z.object({ commands: z.array(CommandSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBox(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:box:read', { branchId: row.branchId });
      return { commands: await listCommands(app.db, row.id, req.query.limit) };
    },
  );

  app.post(
    '/boxes/:id/commands',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Queue a command for the box to collect on its next poll: test print, restart, reset store.',
        params: IdParams,
        body: z.object({
          kind: z.string().min(1),
          payload: z.record(z.string(), z.unknown()).nullable().optional(),
        }),
        response: { 200: z.object({ commandId: z.string().uuid(), actionId: z.string() }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBox(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:box:command', { branchId: row.branchId });
      /**
       * The action id the button was pressed with, so the Console can jump to
       * the lines this one command wrote rather than to the noise of a working
       * box. Minted here when the caller sent none, and refused rather than
       * echoed when it is the wrong shape — a header copied into a log line is
       * a header that could forge one.
       */
      const sent = req.headers['x-oto-action-id'];
      const actionId = typeof sent === 'string' && ACTION_ID.test(sent) ? sent : newId();
      return queueCommand(app.db, opCtx(req), auth, row, {
        kind: req.body.kind,
        payload: req.body.payload ?? null,
        actionId,
      });
    },
  );

  app.get(
    '/boxes/:id/heartbeats',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'This box’s recent heartbeats — the 24-hour drawer on Health',
        params: IdParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(30) }),
        response: { 200: z.object({ heartbeats: z.array(HeartbeatSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBox(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:box:read', { branchId: row.branchId });
      return { heartbeats: await listHeartbeats(app.db, row.id, req.query.limit) };
    },
  );

  // --- Devices --------------------------------------------------------------
  //
  // Asked for per BOX and never per branch: a printer is reachable through the
  // box it is plugged into and through no other, so "which devices could this
  // station use" is a question about one box.

  app.get(
    '/boxes/:boxId/devices',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'What this box can reach',
        params: BoxIdParams,
        querystring: z.object({ includeArchived: boolQuery() }),
        response: { 200: z.object({ devices: z.array(DeviceSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBox(app.db, auth.operatorId, req.params.boxId);
      await req.requirePermission('admin:device:read', { branchId: row.branchId });
      return { devices: await listDevices(app.db, row.id, req.query.includeArchived) };
    },
  );

  app.post(
    '/boxes/:boxId/devices',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Declare a device the box cannot find on its own — nothing announces a printer on a TCP socket',
        params: BoxIdParams,
        body: z.object({
          kind: z.enum(DEVICE_KINDS),
          label: z.string().min(1),
          transport: z.enum(DEVICE_TRANSPORTS),
          address: z.string().min(1).nullable().optional(),
          model: z.string().nullable().optional(),
          protocol: z.string().nullable().optional(),
          serialNumber: z.string().nullable().optional(),
          terminalId: z.string().nullable().optional(),
          merchantId: z.string().nullable().optional(),
        }),
        response: { 200: z.object({ device: DeviceSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBox(app.db, auth.operatorId, req.params.boxId);
      await req.requirePermission('admin:device:create', { branchId: row.branchId });
      return createDevice(app.db, opCtx(req), auth, row, req.body);
    },
  );

  app.patch(
    '/devices/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Edit a device. Its kind, its transport and its box do not move.',
        params: IdParams,
        body: z
          .object({
            label: z.string().min(1).optional(),
            address: z.string().min(1).nullable().optional(),
            model: z.string().nullable().optional(),
            protocol: z.string().nullable().optional(),
            serialNumber: z.string().nullable().optional(),
            terminalId: z.string().nullable().optional(),
            merchantId: z.string().nullable().optional(),
          })
          .strict(),
        response: { 200: z.object({ device: DeviceSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadDevice(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:device:update', { branchId: row.branchId });
      return updateDevice(app.db, opCtx(req), auth, row, req.body);
    },
  );

  app.delete(
    '/devices/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Archive a device, and say which stations just lost it — a till must not lose a printer quietly',
        params: IdParams,
        response: {
          200: z.object({
            ok: z.literal(true),
            stillAssignedTo: z.array(
              z.object({
                stationId: z.string().uuid(),
                stationName: z.string(),
                role: z.enum(STATION_DEVICE_ROLES),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadDevice(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:device:archive', { branchId: row.branchId });
      const stillAssignedTo = await archiveDevice(app.db, opCtx(req), auth, row);
      return { ok: true as const, stillAssignedTo };
    },
  );

  // --- Credentials ----------------------------------------------------------

  app.get(
    '/branches/:branchId/credentials',
    {
      config: { permission: 'admin:device:read', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Screens paired at this branch, and the codes still outstanding',
        params: BranchParams,
        querystring: z.object({ includeRevoked: boolQuery() }),
        response: { 200: z.object({ credentials: z.array(CredentialSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadBranchForOperator(app.db, auth.operatorId, req.params.branchId);
      return {
        credentials: await listCredentials(app.db, {
          operatorId: auth.operatorId,
          branchId: req.params.branchId,
          includeRevoked: req.query.includeRevoked,
        }),
      };
    },
  );

  app.post(
    '/stations/:id/credentials',
    {
      /**
       * SCRUM-327 — the pairing code is a credential and this route says so.
       *
       * The booth's own `POST /booths/:id/pairing-codes` has always declared
       * it; this one, which mints a one-time code for a display, a kiosk or a
       * booth, did not — two routes minting the same kind of one-time code,
       * two different answers to "may this be replayed", and only one of them
       * written down anywhere.
       *
       * What a retry does here, stated plainly because it is the weakest of
       * the three: `pairCredential` INSERTS a credential row, so a second
       * identical request now leaves TWO rows outstanding, each with its own
       * live code, until they expire or are revoked. It used to be answered
       * from the store with the credential and no code. Both rows are visible
       * in `GET /branches/:branchId/credentials` and either can be revoked,
       * and a pairing code is spent by the device that redeems it — but this
       * is the one of the three where the declaration costs something rather
       * than only clarifying.
       */
      config: { dynamicPermission: true, secretResponse: true },
      schema: {
        description:
          'Mint a pairing code for a display, kiosk or booth. Returned once — only its hash is stored.',
        params: IdParams,
        body: z.object({
          kind: z.enum(DEVICE_CREDENTIAL_KINDS),
          label: z.string().min(1).nullable().optional(),
        }),
        response: {
          200: z.object({
            credential: CredentialSchema,
            pairingCode: oneTimeCode,
            expiresAt: codeExpiry,
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:device:pair', { branchId: row.branchId });
      if (row.archivedAt) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
      return pairCredential(app.db, opCtx(req), auth, row, req.body);
    },
  );

  app.post(
    '/credentials/:id/revoke',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Revoke a credential. The row stays, with who revoked it and why.',
        params: IdParams,
        body: z.object({ reason: z.string().min(1).nullable().optional() }).optional(),
        response: { 200: OkSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadCredential(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:device:revoke', { branchId: row.branchId });
      await revokeCredential(app.db, opCtx(req), auth, row, req.body?.reason ?? null);
      return { ok: true as const };
    },
  );
}
