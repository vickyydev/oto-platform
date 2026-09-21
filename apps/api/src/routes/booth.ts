import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BOOTH_ACTION_HEADER, BOOTH_IDEMPOTENCY_HEADER } from '@oto/box-agent';
import type { App } from '../app';
import { boothConsoleStatus, boothHeaders, callBooth, loadBoothStation } from '../services/booth';

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
 * **Why the booth surface is open, what that costs, and what fences it.**
 *
 * The television carries nothing: no cookie, no account, no device key. D15
 * put it there deliberately — the outgoing game shipped a staff PIN in a
 * public bundle, and the rule that came out of it is that nothing on a screen
 * in a shopping centre may carry a token, a key or an origin. `apps/booth`
 * sends `credentials: 'omit'` for the same reason. So these six routes declare
 * `public: true`, which is the only honest label for them, and they appear on
 * the pinned open-surface list in `routes-guarded.test.ts` where anybody can
 * see them.
 *
 * What that leaves open, stated rather than glossed: on a deployment that runs
 * the virtual box, `POST /booth/spin` is a URL a stranger can press. It is the
 * shape of the flaw the intake recorded against the old game (`POST /api/wins`
 * was open, so anyone who found it could mint vouchers), and what makes it
 * tolerable here is underneath rather than on it:
 *
 *   - **Topology.** A booth is served by ITS box. An api instance that is not
 *     the booth's box has no in-process agent and answers 503, so the api in
 *     front of the park mints nothing whatever anybody sends it. On a
 *     Raspberry Pi the surface is on the booth's own LAN and reachable from
 *     the kiosk in front of it.
 *   - **The box's own limits.** Eligibility, daily caps and stock are applied
 *     per draw (D5), so a stranger pressing the button exhausts the same caps
 *     a child would and cannot exceed them.
 *   - **Rate limits**, per IP, sized for the `#debug` distribution run rather
 *     than for one child — see the note on the bucket below.
 *
 * What would actually close it is a credential the booth BOX verifies for the
 * browser in front of it; `core.device_credential` already has a `booth` kind
 * and nothing mints or checks one yet. That belongs with whoever gives the
 * booth its pairing flow, and it is not this slice.
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
  pin: z.string().min(1).max(64).optional(),
  badge: z.string().min(1).max(256).optional(),
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
      config: { public: true, ...limited },
      schema: {
        description:
          'The published wheel this booth is running, and the version number that names it — the number travels beside the bundle because the document does not carry it. A booth nobody has published to answers both as null, which is a screen ("Booth not set up, connect to internet") rather than an error.',
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
      config: { public: true, ...limited },
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
      config: { public: true, ...limited },
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
      config: { public: true, ...limited },
      schema: {
        description:
          'Sign a staff member in at this booth by PIN or badge. The value is verified on the box against the booth’s allowed staff and is held by nobody afterwards. A refusal is 200 with `ok: false` and how long to wait — not a 4xx, because a sign-in problem must never look like the booth being broken.',
        body: StaffSignInBodySchema,
      },
    },
    async (req, reply) => relay(req, reply, 'POST', '/staff/sign-in'),
  );

  app.post(
    '/booth/staff/sign-out',
    {
      config: { public: true, ...limited },
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
      config: { public: true, ...limited },
      schema: {
        description:
          'Print a voucher that has already been issued, again: the SAME code, never a new draw. Staff-only, and the box is what enforces that — the person at the booth proved who they are to the box with a PIN and there is no cloud session in this flow. NOTE: the box’s booth surface does not implement this path yet and answers 404 until it does.',
        body: z.object({ spinId: z.string().uuid().optional() }),
      },
    },
    /**
     * Relayed like the rest, and emphatically not implemented here.
     *
     * A reprint needs the voucher, the printer and the staff session, and all
     * three are on the box — an offline booth is the ordinary case, and a
     * cloud that printed from its own copy would be printing a code it might
     * not even have yet. So the route exists to hold the contract in one
     * place, with its guard and its rate limit, and it starts working the day
     * `booth-http.ts` grows the path. Until then the box answers "no such
     * booth route", which is the truth: nobody has built it.
     */
    async (req, reply) => relay(req, reply, 'POST', '/reprint'),
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
}
