import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BOOTH_ACTION_HEADER, BOOTH_IDEMPOTENCY_HEADER } from '@oto/box-agent';
import { BOOTH_ELIGIBILITY_MODES } from '@oto/db';
import { BOOTH_STAFF_SESSION_MAX_MINUTES } from '@oto/shared';
import type { App } from '../app';
import { boothDeviceOf } from '../plugins/credential';
import { boothConsoleStatus, boothHeaders, callBooth, loadBoothStation } from '../services/booth';
import {
  BOOTH_PAIRING_CODE_TTL_MS,
  listBoothScreens,
  loadBoothScreen,
  mintBoothPairingCode,
  redeemBoothPairingCode,
  revokeBoothScreen,
} from '../services/device-credential';
import {
  BOOTH_PIN_LENGTH,
  BOOTH_TOTAL_WEIGHT_BP,
  addBoothStaff,
  archiveBoothPrize,
  boothDraft,
  clearBoothPin,
  createBoothLayout,
  createBoothPrize,
  listBoothLayouts,
  listBoothStaff,
  listBoothVersions,
  listBooths,
  loadBoothLayout,
  loadBoothPrize,
  loadBoothPrizeIncludingArchived,
  publishBoothConfig,
  removeBoothStaff,
  reorderBoothPrizes,
  setBoothPin,
  updateBoothLayout,
  updateBoothPrize,
  updateBoothSettings,
} from '../services/booth-admin';
import { loadBranchForOperator } from '../services/fleet';
import { opCtx } from '../services/tx';
import { listBoothSpins } from '../services/voucher-ledger';

/**
 * The Lucky Wheel's two surfaces (S2-07a).
 *
 * `/booth/*` is the television's, and every route on it hands the request to
 * the booth's own contract function on the box in this process
 * (`createBoothHttp` in `@oto/box-agent`) and sends back what it says. **No
 * route in this file draws a prize, mints a code, counts a cap or decides who
 * is signed in**, and none of them so much as maps a refusal: the box decides,
 * because the box is what wrote the spin row and put paper in somebody's hand.
 * Where the booth's box is not in this process the answer is 503 — never a
 * prize (`resolveInProcessBooth`).
 *
 * `GET /booths/:id/status` is the Console's, and it is a different thing
 * entirely: an administrator, a session, a permission, and a view built from
 * cloud rows rather than from the box.
 *
 * ---
 *
 * **The booth surface is paired, not open (SCRUM-244).**
 *
 * It used to be open, and the note that stood here said what that cost: on a
 * deployment running the virtual box — which staging is — `POST /booth/spin`
 * was a URL a stranger could press, and pressing it minted a voucher the park
 * would honour. That is the shape of the flaw the intake recorded against the
 * outgoing game, where `POST /api/wins` was open to anybody who found it.
 *
 * D15 is why it was open and D15 is unchanged: **nothing on a screen in a
 * shopping centre carries a bundled token.** A secret baked into `apps/booth`
 * would be readable by anyone who opened the page, on every booth at once, for
 * the life of the build. What closes the hole without breaking that rule is a
 * PAIRED credential: minted for ONE screen by a member of staff holding
 * `admin:booth:manage`, typed in at the booth, kept by that browser, naming
 * that booth, revocable from the Console. `services/device-credential.ts` is
 * where it lives and states the arithmetic behind the six digits.
 *
 * So the six television routes declare `credential: 'booth'` and are verified
 * by `plugins/credential.ts` before their bodies are even validated. They are
 * off the pinned open-surface list in `routes-guarded.test.ts`; the one route
 * that replaces them there is `POST /booth/pair`, which is open because a
 * screen with no credential is exactly what it is for.
 *
 * Three fences are underneath it and none of them were removed:
 *
 *   - **Topology.** A booth is served by ITS box. An api instance that is not
 *     the booth's box has no in-process agent and answers 503, so the api in
 *     front of the park mints nothing whatever anybody sends it. On a
 *     Raspberry Pi the surface is on the booth's own LAN.
 *   - **The box's own limits.** Eligibility, daily caps and stock are applied
 *     per draw (D5).
 *   - **Rate limits**, per IP, sized for the `#debug` distribution run rather
 *     than for one child — see the note on the bucket below.
 *
 * What is still NOT closed, said plainly: the credential lives in a browser's
 * `localStorage` on a television in a mall, so somebody with physical access
 * to the glass can read it. The answer to that is the Unpair button and the
 * box's per-draw limits, not the credential — and it is a different order of
 * problem from a URL anybody on the internet can press.
 */

/**
 * A press, with the two fields the box's surface reads off the body.
 *
 * **Naming them is load-bearing.** A zod object drops what it does not name,
 * so a body field the box learns to read and this schema does not would be
 * stripped here and never reach it — silently, with the box behaving as though
 * the caller had not sent it. Today `booth-http.ts` reads `simulate` and
 * `idempotencyKey` and nothing else.
 */
const SpinBodySchema = z.object({
  simulate: z.boolean().optional(),
  /** D7's press key, when the page puts it here rather than in the header. */
  idempotencyKey: z.string().min(1).max(200).optional(),
});

/**
 * PIN or badge, bounded.
 *
 * The bounds are the api edge's own: the box's surface takes any string, and
 * a booth PIN is checked by argon2 against every allowed staff member in turn
 * (D18), so an unbounded value is work somebody else chose for the box. Under
 * fifty staff and a 64-character ceiling keeps that cheap. A Pi serving its
 * own kiosk has no such bound, which is a difference worth knowing about
 * rather than one worth hiding.
 */
const StaffSignInBodySchema = z.object({
  /**
   * `account` signs in with a phone and password, which the box forwards to
   * `POST /box/v1/booth/staff/verify` under its own credential (SCRUM-223);
   * `pin`, or no mode at all, is the PIN on the box. Named here because a zod
   * object drops what it does not name, and a dropped `mode` would send a
   * phone-and-password sign-in to the box as an empty PIN.
   */
  mode: z.enum(['pin', 'account']).optional(),
  pin: z.string().min(1).max(64).optional(),
  badge: z.string().min(1).max(256).optional(),
  phone: z.string().min(1).max(32).optional(),
  password: z.string().min(1).max(256).optional(),
  /**
   * The person picked from the television's name list before the PIN pad
   * (owner, 28 September; `GET /booth/staff`). Named so that it reaches the
   * box rather than being dropped here; the box decides what it does with it,
   * and a box that reads only the PIN signs in whoever that PIN belongs to, as
   * before. The PIN's length is the box's to refuse too — with `ok: false`,
   * like any wrong PIN, never a 4xx from here.
   */
  accountId: z.string().uuid().optional(),
});

export async function boothRoutes(app: App): Promise<void> {
  /**
   * One bucket per route per address.
   *
   * Sized for the `#debug` distribution table, which sends two hundred
   * simulated presses in a burst from one browser (D16): a limit tuned to a
   * child at a wheel would refuse the diagnostic the ticket asks for. It is a
   * ceiling on absurdity, not a security control — what bounds a stranger is
   * the note at the top of this file.
   */
  const limited = { rateLimit: { max: 600, timeWindow: 60_000 } };

  /**
   * Fastify in, the box's answer out, and nothing decided in between.
   *
   * One consequence worth stating rather than discovering: a 5xx from the
   * booth's surface is a normal reply here, not a thrown error, so it does
   * not pass through the platform's error handler and never reaches the error
   * reporter. The box's own handler logs it. Putting booth faults in front of
   * whoever watches Failures is the alerting slice's to do, and it is not
   * done by this line.
   */
  const relay = async (
    req: FastifyRequest,
    reply: FastifyReply,
    method: string,
    path: string,
  ): Promise<FastifyReply> => {
    const answer = await callBooth(
      app.db,
      { request: req.log, instance: app.log },
      {
        method,
        path,
        body: req.body,
        headers: boothHeaders(req.headers as Record<string, unknown>),
      },
      /**
       * The paired screen, which `callBooth` checks against the booth this
       * process actually serves. The credential plugin has already refused an
       * absent, unknown or revoked one before this line runs.
       */
      boothDeviceOf(req),
    );
    // 204 carries no document; everything else is sent exactly as given —
    // the platform's error envelope included, which is the shape the box's
    // surface already builds.
    return answer.body === undefined
      ? reply.code(answer.status).send()
      : reply.code(answer.status).send(answer.body);
  };

  app.get(
    '/booth/config',
    {
      config: { credential: 'booth', ...limited },
      schema: {
        description:
          'The published wheel this booth is running, and the version number that names it — the number travels beside the bundle because the document does not carry it. A booth nobody has published to answers both as null, which the television shows as a screen rather than an error: "This booth is being set up — please ask our staff" while the booth is online, and "Booth not set up, connect to internet" while it is not.',
        /**
         * **No response schema on any booth route, deliberately.** The bodies
         * are the box's documents, and a zod object drops keys it does not
         * know about: serialising a bundle through one here would quietly
         * strip whatever a newer box added and hand the television a document
         * no booth ever published. `GET /box/v1/config` leaves its bundle
         * unserialised for the same reason. The shapes are in
         * `@oto/shared/booth` and in the box's `booth-http.ts`.
         */
      },
    },
    async (req, reply) => relay(req, reply, 'GET', '/config'),
  );

  app.get(
    '/booth/status',
    {
      config: { credential: 'booth', ...limited },
      schema: {
        description:
          'Counts and states for the corner of the television and the #debug panel: link, config version, printer, paper, vouchers pending sync, last spin, whether anybody is signed in, and which prizes have hit their cap today. Whether the box has the cloud is the agent’s answer; everything else is the booth’s. Never who is signed in.',
      },
    },
    async (req, reply) => relay(req, reply, 'GET', '/status'),
  );

  app.post(
    '/booth/spin',
    {
      config: { credential: 'booth', ...limited },
      schema: {
        description:
          `One press of the red button. The BOX draws, records the spin and mints the code before this answers; the press key travels in \`${BOOTH_IDEMPOTENCY_HEADER}\` or in the body, so a network retry is one spin and a second press is two. \`simulate\` draws and changes nothing — no spin row, no voucher, no print, no cap consumed. \`${BOOTH_ACTION_HEADER}\` is carried through to the spin row.`,
        body: SpinBodySchema,
      },
    },
    async (req, reply) => relay(req, reply, 'POST', '/spin'),
  );

  app.post(
    '/booth/staff/sign-in',
    {
      config: { credential: 'booth', ...limited },
      schema: {
        description:
          'Sign a staff member in at this booth by PIN or badge, checked on the box against the booth’s allowed staff — or, with `mode: "account"`, by phone and password, which the box forwards to the cloud under its own credential. Nothing typed is held by anybody afterwards. A refusal is 200 with `ok: false`, how long to wait, and for an account sign-in a `reason` code (`offline`, `not_assigned`, `not_allowed`, `must_change_password`, or `box_refused` / `booth_not_on_box` when the cloud refused the box or no longer has this booth on it) — not a 4xx, because a sign-in problem must never look like the booth being broken.',
        body: StaffSignInBodySchema,
      },
    },
    async (req, reply) => relay(req, reply, 'POST', '/staff/sign-in'),
  );

  app.post(
    '/booth/staff/sign-out',
    {
      config: { credential: 'booth', ...limited },
      schema: {
        description:
          'End the booth’s staff session. The wheel keeps spinning afterwards and the spins are recorded unattributed, which is the specification’s rule: a sign-in problem must never take the booth down.',
      },
    },
    async (req, reply) => relay(req, reply, 'POST', '/staff/sign-out'),
  );

  app.post(
    '/booth/reprint',
    {
      config: { credential: 'booth', ...limited },
      schema: {
        description:
          'Print a voucher that has already been issued, again: the SAME code, never a new draw — this booth’s last voucher, or `spinId`’s. Staff-only, and the box is what enforces that: 403 `staff_required` with nobody signed in at the booth, 404 `nothing_to_reprint` for a voucher the box no longer holds. The copy reaches the cloud as a `reprint` print of that voucher, recorded against the account signed in at the booth when it was made: the booth cannot tell who pressed Reprint, only whose session was open.',
        body: z.object({ spinId: z.string().uuid().optional() }),
      },
    },
    /**
     * Relayed like the rest, and emphatically not implemented here.
     *
     * A reprint needs the voucher, the printer and the staff session, and all
     * three are on the box — an offline booth is the ordinary case, and a
     * cloud that printed from its own copy would be printing a code it might
     * not even have yet. The box keeps its last vouchers for exactly this
     * (SCRUM-223); this route holds the contract, its guard and its rate limit.
     */
    async (req, reply) => relay(req, reply, 'POST', '/reprint'),
  );

  /**
   * The name list and the print after the reveal (owner, 28 September).
   *
   * Relayed like the six above, for the deployment whose box is in this
   * process — staging's virtual box — so the television there has the same
   * two calls a Raspberry Pi's kiosk serves under `/booth/*`. The box answers
   * both; nothing here decides who is listed or whether paper comes out.
   */
  app.get(
    '/booth/staff',
    {
      config: { credential: 'booth', ...limited },
      schema: {
        description:
          'Who may sign in at this booth, for the television’s name picker: each person’s account id, the name and staff code a slip prints, and whether they have a PIN. Names only — never a PIN and never a hash. The box answers from the staff list it has cached, so the picker works with the mall’s internet down.',
      },
    },
    async (req, reply) => relay(req, reply, 'GET', '/staff'),
  );

  app.post(
    '/booth/print',
    {
      config: { credential: 'booth', ...limited },
      schema: {
        description:
          'Put the voucher a press won on paper, once the wheel has shown it: `spinId` names the press. Answers with the outcome a press used to carry — printed, queued or failed, the code and the QR payload. The box prints and decides; a press it does not hold is refused by the box.',
        body: z.object({ spinId: z.string().uuid() }),
      },
    },
    async (req, reply) => relay(req, reply, 'POST', '/print'),
  );

  // --- Pairing the screen (SCRUM-244) ---------------------------------------

  app.post(
    '/booth/pair',
    {
      /**
       * The one genuinely open booth route, and the only one that can be:
       * a screen with no credential is precisely what it is for. The code IS
       * the credential here, exactly as a claim code is on
       * `POST /box/v1/register`, and it is fenced the same way — single use,
       * ten minutes, and counted per address on failure inside the service.
       *
       * `secretResponse` because the answer is a 256-bit device secret. The
       * idempotency plugin returns before the store for a caller with no
       * session anyway, so this is belt and braces — and it is the belt that
       * keeps working the day somebody calls this from a browser that does
       * happen to hold a cookie.
       *
       * The bucket is tighter than the booth's: pairing is a member of staff
       * typing six digits once, not two hundred simulated presses.
       */
      config: {
        public: true,
        secretResponse: true,
        rateLimit: { max: 30, timeWindow: 60_000 },
      },
      schema: {
        description:
          `Exchange the six digits an administrator read out of the Console for this screen's own credential. Single use, valid ${BOOTH_PAIRING_CODE_TTL_MS / 60_000} minutes, and refused per address after repeated wrong codes. The secret is returned ONCE and stored only as a hash: a screen that loses it is paired again rather than recovered. Every refusal — wrong, expired, spent, revoked — is the same 401 BOOTH_UNPAIRED, because telling a caller which it got is telling it whether the code it tried exists.`,
        body: z.object({ code: z.string().min(1).max(32) }),
        response: {
          200: z.object({
            deviceSecret: z.string(),
            /** The booth this screen is now paired to. The page shows nothing with it. */
            stationId: z.string().uuid(),
          }),
        },
      },
    },
    async (req) => {
      const paired = await redeemBoothPairingCode(
        app.db,
        opCtx(req),
        { code: req.body.code },
        { ip: req.ip, log: req.log },
      );
      return { deviceSecret: paired.deviceSecret, stationId: paired.stationId };
    },
  );

  // --- The Console ----------------------------------------------------------

  app.get(
    '/booths/:id/status',
    {
      /**
       * The booth's branch is not in the URL — `:id` is the booth's station —
       * so the row is loaded first and the permission checked against the
       * branch it belongs to. Same shape as the fleet's by-id routes.
       */
      config: { dynamicPermission: true },
      schema: {
        description:
          'What the Console shows for one booth: its box and whether it is online, the published wheel and the version the box last reported, the booth printer’s reachability and paper, and today’s spins, unattributed spins and capped prizes. Built from cloud rows, so it answers the same way for a Raspberry Pi in a mall as for the virtual box.',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:read', { branchId: row.branchId });
      return boothConsoleStatus(app.db, row);
    },
  );

  // --- The Console's control panel (S2-07b) ---------------------------------
  //
  // What a manager changes, and the one act that puts it on a television.
  //
  // **Every route keyed by `:id` declares `dynamicPermission` and asks for its
  // permission at the BOOTH's own branch**, which is not in the URL — the row
  // is loaded first and checked against `row.branchId`, exactly as the status
  // route above does and for the same reason: a plain `config: { permission }`
  // with no target checks the caller's SESSION branch and then acts on
  // whatever the id names, which would let a manager at one branch re-weight a
  // wheel at another.
  //
  // **Three permissions, and the split is deliberate** (`@oto/shared`):
  // `admin:booth:read` to look, `admin:booth:manage` to edit the draft,
  // `admin:booth:publish` to put it on a booth. A branch manager holds read
  // and `admin:booth:staff_assign` and neither of the other two, so the person
  // who decides who works the booth is not the person who decides the odds.
  //
  // **The layout routes are operator-wide** and name no branch: a design is
  // shared by every booth of the operator, and editing one from one branch
  // changes what all of them would publish. With no branch target the guard
  // checks the permission against the caller's operator and SESSION branch
  // (`requirePermission` in `plugins/session.ts`), so an operator-scoped grant
  // covers them and so does a grant at the branch the caller is signed in to;
  // the by-id route loads the design inside the caller's operator before it
  // acts. The voucher definitions work the same way, for the same reason, and
  // live in `routes/voucher-definitions.ts` (SCRUM-400).
  //
  // **No response schema on the routes that carry a row or a jsonb document.**
  // A zod object drops keys it does not name, and `design`, `assetManifest`
  // and the published `bundle` are documents whose shapes belong to the wheel
  // renderer and to `@oto/shared` — serialising one through a schema written
  // here would quietly strip whatever a newer build put in it. The routes
  // whose answers are small and wholly this file's own do declare one.

  const BoothIdParams = z.object({ id: z.string().uuid() });
  const PrizeParams = z.object({ id: z.string().uuid(), prizeId: z.string().uuid() });
  const StaffParams = z.object({ id: z.string().uuid(), accountId: z.string().uuid() });

  /** A colour the wheel can actually paint with, or nothing. */
  const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'A colour is #RRGGBB');

  const PrizeBody = z.object({
    nameEn: z.string().min(1).max(120),
    nameTh: z.string().max(120).nullable().optional(),
    wheelLabel: z.string().max(80).nullable().optional(),
    /** Basis points (D4). Integers, because "must add up to 100" has to hold. */
    weightBp: z.number().int().min(0).max(BOOTH_TOTAL_WEIGHT_BP),
    active: z.boolean().optional(),
    expiryDays: z.number().int().positive().nullable().optional(),
    dailyCap: z.number().int().positive().nullable().optional(),
    costSatang: z.number().int().min(0).optional(),
    sliceColor: HexColor.nullable().optional(),
    textColor: HexColor.nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
    voucherDefinitionId: z.string().uuid().nullable().optional(),
  });

  const SettingsBody = z
    .object({
      layoutId: z.string().uuid().nullable().optional(),
      /**
       * **Never `Enter`.** The park's USB badge scanner types digits and then
       * Enter, so a booth bound to it would spin the wheel every time somebody
       * scanned a badge. Refused here, in `@oto/shared`, and by a CHECK on the
       * column — three times, because the value reaches the box through a
       * document none of the other two can see.
       */
      buttonKey: z
        .string()
        .min(1)
        .max(32)
        .refine((key) => key !== 'Enter', {
          message: 'Enter is the badge scanner’s key and cannot be the booth button',
        })
        .optional(),
      eligibility: z.enum(BOOTH_ELIGIBILITY_MODES).optional(),
      dailySpinCap: z.number().int().positive().nullable().optional(),
      /**
       * How long a sign-in at the booth lasts, in minutes (SCRUM-400). Null is
       * the box's own twelve hours and publishes nothing; the ceiling is the
       * box's, one trading day — refused here and by the column's CHECK rather
       * than silently cut down on the box.
       */
      staffSessionMinutes: z
        .number()
        .int()
        .positive()
        .max(BOOTH_STAFF_SESSION_MAX_MINUTES, 'A booth sign-in lasts at most 24 hours')
        .nullable()
        .optional(),
    })
    .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

  app.get(
    '/branches/:branchId/booths',
    {
      config: { permission: 'admin:booth:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'The booths at one branch: the design each is on, how many prizes are live, and which config version is published. The live status tiles — box, printer, paper, today’s spins — are `GET /booths/:id/status`.',
        params: z.object({ branchId: z.string().uuid() }),
      },
    },
    /**
     * The branch is loaded scoped to the caller's operator before a booth is
     * listed (SCRUM-267).
     *
     * The guard above does not establish that the branch in the URL belongs to
     * the caller: `grantCovers` is a pure function over ids, so an
     * operator-scoped grant matches on the operator and says yes to whatever
     * branch id the target happens to name. Without this load the route
     * answered 200 with another operator's booth while every one of its
     * `/branches/:branchId/…` siblings refused the same id — the same defect
     * SCRUM-248 closed in `catalog.ts`, in a file that ticket did not cover.
     */
    async (req) => {
      const auth = req.requireAuth();
      const br = await loadBranchForOperator(app.db, auth.operatorId, req.params.branchId);
      return listBooths(app.db, auth.operatorId, br.id);
    },
  );

  app.get(
    '/booths/:id/draft',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'What would be published if somebody pressed Publish now: the settings, the prize list in slice order, the exact bundle and its hash, the bundle the booths are running now beside it so a before-and-after can be shown, whether the draft differs, when it was last edited — and every reason it cannot be published yet, each naming its field. There is no draft table: these rows ARE the draft, one per booth and shared, so a colleague’s edit is in here too.',
        params: BoothIdParams,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:read', { branchId: row.branchId });
      return boothDraft(app.db, row);
    },
  );

  app.patch(
    '/booths/:id/settings',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Change the booth itself: its wheel design, the key the red button sends, spin eligibility, the daily spin cap and how long a staff sign-in lasts (`staffSessionMinutes`, at most 1440; null is the box’s twelve hours). Saved to the draft — no booth sees any of it until a publish. Eligibility `band` and `phone` can be SAVED and cannot be published until there is a booth inside the park.',
        params: BoothIdParams,
        body: SettingsBody,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:manage', { branchId: row.branchId });
      return updateBoothSettings(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        row,
        req.body,
      );
    },
  );

  app.post(
    '/booths/:id/prizes',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Add a slice to this booth’s wheel. Goes on the end unless `sortOrder` says otherwise. A prize with no voucher definition can be saved and cannot be published while it is active.',
        params: BoothIdParams,
        body: PrizeBody,
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:manage', { branchId: row.branchId });
      const created = await createBoothPrize(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        row,
        req.body,
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/booths/:id/prizes/:prizeId',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Edit one slice: its names, the short label on the wheel, its weight in basis points, whether it is switched on, its expiry, its daily cap, what it costs the park and its colours.',
        params: PrizeParams,
        body: PrizeBody.partial(),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:manage', { branchId: row.branchId });
      const prize = await loadBoothPrize(app.db, row.stationId, req.params.prizeId);
      return updateBoothPrize(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        row,
        prize,
        req.body,
      );
    },
  );

  app.delete(
    '/booths/:id/prizes/:prizeId',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Take a slice off the wheel. Archived rather than deleted — `booth.spin` points at the prize somebody won — and the wheel loses it at the next publish, like every other edit. Archiving a slice that is already archived answers with that slice and changes nothing, so a double press is not reported as a failure.',
        params: PrizeParams,
      },
    },
    /**
     * The one by-id prize route that accepts an already-archived row
     * (`loadBoothPrizeIncludingArchived`). A second DELETE of the same prize
     * is the same request; answering 404 to it would tell a manager the
     * archive failed a moment after it succeeded.
     */
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:manage', { branchId: row.branchId });
      const prize = await loadBoothPrizeIncludingArchived(
        app.db,
        row.stationId,
        req.params.prizeId,
      );
      return archiveBoothPrize(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        row,
        prize,
      );
    },
  );

  app.put(
    '/booths/:id/prize-order',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Set the slice order as a whole list. It must name every live prize exactly once: the order IS the wheel — `SpinResponse.prizeIndex` indexes the published array — and a partial list would leave two slices sharing a position.',
        params: BoothIdParams,
        body: z.object({ prizeIds: z.array(z.string().uuid()).min(1).max(60) }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:manage', { branchId: row.branchId });
      return reorderBoothPrizes(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        row,
        req.body.prizeIds,
      );
    },
  );

  app.get(
    '/booths/:id/versions',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The wheels this booth has run, newest first: version, when, who published it, the note they left and the bundle hash. Nothing here is ever edited — a spin points at its version, so what the odds were on a given day cannot be changed by tonight’s publish.',
        params: BoothIdParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
        response: {
          200: z.object({
            versions: z.array(
              z.object({
                id: z.string().uuid(),
                version: z.number().int(),
                publishedAt: z.string(),
                bundleHash: z.string(),
                note: z.string().nullable(),
                publishedByAccountId: z.string().uuid().nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:read', { branchId: row.branchId });
      return listBoothVersions(app.db, row.stationId, req.query.limit);
    },
  );

  const SpinPerson = z.object({ accountId: z.string().uuid(), name: z.string().nullable(), code: z.string() });

  app.get(
    '/booths/:id/spins',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Every press of this booth’s button on one trading day (`date`, today at the branch when absent), newest first and paged: when, whose session was open (null: unattributed), the prize or no prize, the last four characters of the voucher code, whether its slip reached paper — printed, failed (the box reported an attempt that produced none) or not reported yet — and whether a till has redeemed it. The day’s counts beside them. Simulated `#debug` spins are left out, and a press the box has not synced yet is not here.',
        params: BoothIdParams,
        querystring: z.object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD').optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: z.object({
            businessDate: z.string(),
            total: z.number().int(),
            summary: z.object({
              spins: z.number().int(),
              unattributed: z.number().int(),
              printed: z.number().int(),
              redeemed: z.number().int(),
            }),
            spins: z.array(
              z.object({
                id: z.string().uuid(),
                occurredAt: z.string(),
                staff: SpinPerson.nullable(),
                outcome: z.enum(['prize', 'no_prize']),
                prize: z.object({ id: z.string().uuid(), nameEn: z.string() }).nullable(),
                codeLast4: z.string().nullable(),
                print: z.enum(['printed', 'failed', 'not_reported']).nullable(),
                redeemed: z.boolean(),
                redeemedAt: z.string().nullable(),
                clockSuspect: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:read', { branchId: row.branchId });
      const br = await loadBranchForOperator(app.db, auth.operatorId, row.branchId);
      return listBoothSpins(app.db, row, br, req.query);
    },
  );

  app.post(
    '/booths/:id/publish',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          `Mint the next version of this booth's wheel from the draft, and hand it to the boxes. Validated inside the transaction that writes it: the active weights must add up to exactly ${BOOTH_TOTAL_WEIGHT_BP} basis points, every active prize needs a live voucher definition (one that never expires is allowed — owner, 24 September), the booth needs a design, its station needs a code prefix of exactly two capital letters or digits (\`BOOTH_CODE_PREFIX_INVALID\`: without two letters or digits its box cannot mint a voucher code; a lower-case one would mint, and is refused because \`b1\` and \`B1\` would pass the branch uniqueness check as two prefixes minting one set of codes), and a wheel that could not be played — every prize off, or every active prize capped out today — is refused rather than published. Eligibility \`band\` or \`phone\` is refused until there is a booth inside the park. A version is never edited: this makes N+1, and the box picks it up by version at its next pull. Pass \`expectedBundleHash\` from the draft to be refused rather than publish a colleague's edit you have not seen.`,
        params: BoothIdParams,
        body: z.object({
          note: z.string().max(500).nullable().optional(),
          expectedBundleHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        }),
        response: {
          200: z.object({
            version: z.object({
              id: z.string().uuid(),
              version: z.number().int(),
              publishedAt: z.string(),
              bundleHash: z.string(),
              note: z.string().nullable(),
              publishedByAccountId: z.string().uuid().nullable(),
            }),
            prizes: z.number().int(),
            activePrizes: z.number().int(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:publish', { branchId: row.branchId });
      return publishBoothConfig(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        row,
        req.body,
      );
    },
  );

  // --- Who may work the booth, and what they type ---------------------------

  const StaffResponse = z.object({
    staff: z.array(
      z.object({
        accountId: z.string().uuid(),
        addedAt: z.string(),
        addedBy: z.string().uuid(),
        hasPin: z.boolean(),
        /** When the PIN stops working; null for never, or no PIN. Past it, the PIN opens nothing. */
        pinExpiresAt: z.string().nullable(),
      }),
    ),
  });

  app.get(
    '/booths/:id/staff',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Who may sign in at this booth, when they were added and by whom, whether each has a booth PIN, and when that PIN stops working (`pinExpiresAt`, null for never — a PIN past it is still listed and opens nothing). Never a PIN and never its hash — "can they get in" is the whole question this answers.',
        params: BoothIdParams,
        response: { 200: StaffResponse },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:read', { branchId: row.branchId });
      return listBoothStaff(app.db, row.stationId);
    },
  );

  app.put(
    '/booths/:id/staff/:accountId',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Let this account sign in at this booth. Separate from the station picker’s `station_staff`: a booth is unattended hardware in a mall and the person at it identifies with a PIN, not a password at a till. Only the staff of the booth’s branch can be added — an employee there, somebody holding a role scoped to that branch, or an operator-wide administrator — as on a till’s staff list; anybody else is refused with 400 `STAFF_NOT_AT_BRANCH`. The list is not in the published bundle: it rides beside it on the box’s `booth` cache scope, so a booth picks up an addition at the box’s next pull with no publish — the PIN works from then — while a phone-and-password sign-in is checked against this list by the platform itself, at once.',
        params: StaffParams,
        response: { 200: StaffResponse },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:staff_assign', { branchId: row.branchId });
      return addBoothStaff(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        row,
        req.params.accountId,
      );
    },
  );

  app.delete(
    '/booths/:id/staff/:accountId',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Take an account off this booth. Their PIN is NOT withdrawn by this — a PIN belongs to the person and may open another booth — so when that is what is meant, withdraw it FIRST: a PIN can be withdrawn only through a booth whose list still names the person.',
        params: StaffParams,
        response: { 200: StaffResponse },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:staff_assign', { branchId: row.branchId });
      return removeBoothStaff(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        row,
        req.params.accountId,
      );
    },
  );

  app.put(
    '/booths/:id/staff/:accountId/pin',
    {
      /**
       * `secretResponse` is about the REQUEST and, for a drawn PIN, the answer.
       *
       * The idempotency plugin stores a plain SHA-256 over method, url and
       * body for a day, and five digits behind an unsalted hash of a known
       * shape is a hundred thousand guesses; and with `generate` the answer
       * carries the PIN itself, which a replay store would hand back to
       * anybody holding the key. Declaring this makes the plugin claim no key
       * at all, so neither is ever written. A retry of a typed PIN sets the
       * same PIN again; a retry of `generate` draws a new one and revokes the
       * first — the one on screen is always the one that works.
       */
      config: { dynamicPermission: true, secretResponse: true },
      schema: {
        description:
          `Set this person’s booth PIN: exactly ${BOOTH_PIN_LENGTH} digits typed in \`pin\`, or \`generate: true\` for the platform to draw ${BOOTH_PIN_LENGTH} random digits and answer them ONCE in \`pin\` — one of the two, anything else refused with 400 (\`BOOTH_PIN_INVALID\`, \`BOOTH_PIN_INPUT\`). \`expiresAt\` (ISO 8601, in the future, else 400 \`BOOTH_PIN_EXPIRY_PAST\`) is when it stops working; absent or null, never. It is hashed with argon2id and stored on the account — one live PIN per person, so this replaces and revokes any previous one, at every booth they work — and it reaches a booth only as that hash, with its expiry, on the staff cache scope, never on the box command queue whose payloads are stored and shown on a Console screen; once expired its hash is no longer sent. The PIN itself is held nowhere: not in the audit row, not in the idempotency store, not in a log. Because the PIN is the person’s, the person must be yours: somebody who does not work at this booth’s branch is refused with 403 \`OUT_OF_BRANCH_SCOPE\`, and somebody holding a role you do not hold in full — an operator administrator, to a branch manager — with 403 \`ROLE_NOT_DOMINATED\`, as a temporary password is. They must also be on this booth (400 \`BOOTH_STAFF_NOT_FOUND\`).`,
        params: StaffParams,
        body: z.object({
          /**
           * Digits, because a booth overlay on a television is a number pad.
           * Bounded here and judged by the service, whose refusal names the
           * rule — "exactly five digits" — rather than a schema path.
           */
          pin: z.string().max(16).optional(),
          generate: z.boolean().optional(),
          expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
        }),
        response: {
          200: z.object({
            accountId: z.string().uuid(),
            hasPin: z.literal(true),
            pinExpiresAt: z.string().nullable(),
            /** Only for `generate`: the drawn PIN, shown once and kept nowhere. */
            pin: z.string().optional(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:staff_assign', { branchId: row.branchId });
      return setBoothPin(
        app.db,
        opCtx(req),
        {
          accountId: auth.accountId,
          operatorId: auth.operatorId,
          // Every grant the caller holds, for the rule that the caller must
          // hold whatever the person holds (M9). Only the request has them.
          effective: await req.effectivePermissions(),
        },
        row,
        req.params.accountId,
        {
          ...(req.body.pin !== undefined ? { pin: req.body.pin } : {}),
          ...(req.body.generate !== undefined ? { generate: req.body.generate } : {}),
          expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
        },
      );
    },
  );

  app.delete(
    '/booths/:id/staff/:accountId/pin',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Withdraw this person’s booth PIN — the Console’s Remove PIN — at every booth at once. Marked revoked with a reason rather than deleted, so "whose PIN was withdrawn, and when" stays answerable. It stops working at a booth when its box next pulls — minutes online, and however long it stays offline otherwise, which is the same window the deny-list has. Refused as setting one is — 403 `OUT_OF_BRANCH_SCOPE` for somebody who does not work at this booth’s branch, 403 `ROLE_NOT_DOMINATED` for somebody holding a role you do not hold in full — and with 400 `BOOTH_STAFF_NOT_FOUND` for somebody not on this booth.',
        params: StaffParams,
        querystring: z.object({ reason: z.string().max(200).optional() }),
        response: { 200: z.object({ accountId: z.string().uuid(), hasPin: z.literal(false) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:staff_assign', { branchId: row.branchId });
      return clearBoothPin(
        app.db,
        opCtx(req),
        {
          accountId: auth.accountId,
          operatorId: auth.operatorId,
          // As for setting a PIN: the dominance rule reads the caller's grants.
          effective: await req.effectivePermissions(),
        },
        row,
        req.params.accountId,
        req.query.reason ?? null,
      );
    },
  );

  // --- Which screens may press this booth's button (SCRUM-244) --------------
  //
  // Three routes, all keyed on the booth and all `dynamicPermission`, checked
  // against the BOOTH's branch exactly as their siblings above are.
  //
  // **Why `admin:booth:manage` and not `admin:device:pair`.** There is already
  // a general pairing route — `POST /stations/:id/credentials` in `fleet.ts` —
  // and a booth IS a station, so it would work. What it would not do is put
  // the control where the decision is made: the person who sets up a Lucky
  // Wheel does it on the Booths page holding the booth permissions, and
  // sending them to Devices for `admin:device:pair` would mean either a second
  // grant or a second person for a step that belongs to the same job. Reading
  // and revoking follow the same rule, so the whole life of a booth screen is
  // one permission family.

  const ScreenSchema = z.object({
    id: z.string().uuid(),
    label: z.string().nullable(),
    pairingOutstanding: z.boolean(),
    pairingCodeExpiresAt: z.string().nullable(),
    pairedAt: z.string().nullable(),
    pairedByAccountId: z.string().uuid().nullable(),
    lastSeenAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    revokedReason: z.string().nullable(),
  });

  app.get(
    '/booths/:id/screens',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The televisions paired to this booth, newest first, with any code still outstanding and every screen that has been unpaired. Revoked rows are kept and shown: “which screen was unpaired, and when” is what somebody asks after a television goes missing. Never a code and never a hash.',
        params: BoothIdParams,
        response: { 200: z.object({ screens: z.array(ScreenSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:read', { branchId: row.branchId });
      return { screens: await listBoothScreens(app.db, row.stationId) };
    },
  );

  app.post(
    '/booths/:id/pairing-codes',
    {
      /**
       * `secretResponse`, and what it means for a retry.
       *
       * The answer carries the code, so the idempotency plugin claims no key
       * and a repeated press genuinely mints again rather than replaying.
       * That is why the mint REVOKES this booth's previous outstanding code in
       * the same transaction: the code a manager is looking at is the only one
       * that works, and the one they pressed past is dead rather than lying
       * around for ten minutes. A store-backed replay could not have given
       * that — it would have handed the same code back to whoever held the
       * key, for a day, which is the thing `secretResponse` exists to stop.
       */
      config: { dynamicPermission: true, secretResponse: true },
      schema: {
        description:
          `Mint the six digits somebody types into a booth television to pair it. Shown once — only its hash is stored — and valid ${BOOTH_PAIRING_CODE_TTL_MS / 60_000} minutes. Pressing this again replaces the booth's previous unredeemed code rather than adding a second, so there is never more than one live code per booth.`,
        params: BoothIdParams,
        body: z
          .object({ label: z.string().min(1).max(80).nullable().optional() })
          .optional(),
        response: {
          200: z.object({
            credential: ScreenSchema,
            pairingCode: z.string(),
            expiresAt: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:manage', { branchId: row.branchId });
      return mintBoothPairingCode(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        row,
        { label: req.body?.label ?? null },
      );
    },
  );

  app.post(
    '/booths/:id/screens/:credentialId/revoke',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Unpair a screen. The row stays, with who unpaired it and why; the live secret and any unredeemed code go. The television finds out on its next call — within five seconds, because it polls status on a timer — and falls back to asking staff to pair it again.',
        params: z.object({ id: z.string().uuid(), credentialId: z.string().uuid() }),
        body: z.object({ reason: z.string().min(1).max(200).nullable().optional() }).optional(),
        response: { 200: z.object({ screen: ScreenSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadBoothStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:booth:manage', { branchId: row.branchId });
      const before = await loadBoothScreen(
        app.db,
        auth.operatorId,
        row.stationId,
        req.params.credentialId,
      );
      return {
        screen: await revokeBoothScreen(
          app.db,
          opCtx(req),
          { accountId: auth.accountId, operatorId: auth.operatorId },
          before,
          req.body?.reason ?? null,
        ),
      };
    },
  );

  // --- Designs (operator-wide) ----------------------------------------------

  const LayoutBody = z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).nullable().optional(),
    /**
     * Palette, label rules, rotation geometry — and the asset SLOT manifest,
     * which names what the wheel wants rather than carrying any bytes (D23).
     * Held as one document and validated where it is READ, by the slice that
     * draws the wheel: a field a newer booth build understands must not be
     * refused here.
     */
    design: z.record(z.string(), z.unknown()).optional(),
    assetManifest: z.record(z.string(), z.unknown()).optional(),
    active: z.boolean().optional(),
  });

  app.get(
    '/booth-layouts',
    {
      config: { permission: 'admin:booth:read' },
      schema: {
        description:
          'The wheel designs this operator has. A design is shared between booths and seasons — which is what makes a seasonal wheel a picker rather than a re-entry of six prizes.',
        querystring: z.object({ includeArchived: z.enum(['true', 'false']).default('false') }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return listBoothLayouts(app.db, auth.operatorId, req.query.includeArchived === 'true');
    },
  );

  app.post(
    '/booth-layouts',
    {
      config: { permission: 'admin:booth:manage' },
      schema: { description: 'Create a wheel design.', body: LayoutBody },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const created = await createBoothLayout(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        req.body,
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/booth-layouts/:id',
    {
      config: { permission: 'admin:booth:manage' },
      schema: {
        description:
          'Edit a wheel design. Its `version` moves whenever the design or the asset manifest does — a rename is not a new wheel — so a published bundle can name the design it took. A layout is shared, so this changes what every booth using it WOULD publish and nothing any of them is running.',
        params: BoothIdParams,
        body: LayoutBody.partial().extend({ archived: z.boolean().optional() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const before = await loadBoothLayout(app.db, auth.operatorId, req.params.id);
      return updateBoothLayout(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        before,
        req.body,
      );
    },
  );
}
