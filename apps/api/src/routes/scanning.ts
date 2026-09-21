import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import {
  HidBurstReader,
  SerialScanReader,
  ScanRouter,
  buttonKeyProblem,
  simulateHidKeys,
  simulateSerialRecord,
  type ScanInput,
  type ScanResult,
  type ScanSource,
} from '@oto/box-agent';
import { SCAN_SOURCES } from '@oto/shared';
import type { App } from '../app';
import { AppError } from '../lib/errors';
import { boxStoreFor } from '../lib/box-store';
import { virtualBoxAgent } from '../services/box';
import { loadStationRow, managerForStation } from '../services/station-session';

/**
 * Scanning, over HTTP (S2-06).
 *
 * A code reaches a station three ways, and this is the door for the two that
 * come from a SCREEN: the iPad's camera and a Bluetooth scanner typing into
 * the browser (PROJECT_CONTEXT §7.4), plus the Console's scanner simulator,
 * which is the same door with a different hand on it. The third way — the
 * Zebra on the box itself, which is where DEVICE_INVENTORY D2 puts it — never
 * comes through here at all: the agent reads the device and calls the same
 * service in process.
 *
 * **Why the simulator uses this route and not a box command.** A simulated
 * scan is delivered here and vanishes; a box command is a row in
 * `edge.box_command` with a `payload` column the Console renders. A band code
 * is a gate credential, and the simulator's whole job is to carry realistic
 * codes — so routing it through a stored payload would put working credentials
 * in the database and on a web page. The same reasoning
 * `SIMULATOR_ACTIONS_WITH_SECRETS` applies to a badge and a PIN applies here,
 * and this is the door that has no stored payload.
 *
 * **What the box does with it** is in `packages/box-agent/src/scan.ts`:
 * classify, hand to whichever handler claimed the code, write a REDACTED line
 * on the station's tape, and tell every screen watching. No handler is
 * registered yet — they arrive with the tickets that own what a code means —
 * so a scan today resolves `unhandled`, which the till shows rather than
 * swallowing.
 */

const IdParams = z.object({ id: z.string().uuid() });

const ScanResultSchema = z.object({
  accepted: z.boolean(),
  kind: z.string(),
  outcome: z.string(),
  handler: z.string().nullable(),
  errorCode: z.string().nullable(),
  /** SHA-256 of the code, first 16 hex characters. Never the code. */
  codeFingerprint: z.string(),
  codeLength: z.number().int(),
  codePrefix: z.string().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  durationMs: z.number().int(),
  actionId: z.string().nullable(),
  /** Handlers registered on the box that took it, in match order. */
  handlers: z.array(z.string()),
});

/** The shape a screen sends. `SCAN_SOURCES` is the shared vocabulary. */
const ScanBody = z.object({
  code: z.string().min(1).max(4096),
  source: z.enum(SCAN_SOURCES).default('camera'),
  scannedAt: z.string().datetime().optional(),
});

/**
 * What the Console's simulator sends: a code and the mode to pretend in.
 *
 * It does not deliver the code — it produces the KEY EVENTS or the BYTES a
 * DS2278 would produce and feeds them through the same reader that will read
 * the real device. That is the difference between a simulator that proves the
 * service works and one that proves the rule works.
 */
const SimulateBody = z.object({
  code: z.string().min(1).max(4096),
  mode: z.enum(['hid', 'serial']).default('hid'),
  /** 0 / 20 / 40 on the real scanner. Above the burst gap it reads as a person. */
  interCharDelayMs: z.number().int().min(0).max(1000).default(0),
  /** False reproduces a unit set back to "Data As Is": no Enter, no CR. */
  withSuffix: z.boolean().default(true),
  /** `]C0` for Code 128, `]Q1` for QR, when "Transmit Code ID" is on. */
  codeId: z.string().max(4).optional(),
});

export async function scanningRoutes(app: App): Promise<void> {
  /**
   * The scanning service for one station's box.
   *
   * Two paths, exactly as `queueFact` in `services/station-session.ts` has
   * two: when this process runs that box's agent, the agent's own router is
   * used — so the handlers later tickets registered on the box are the ones
   * that run. When it does not (an api instance without the `edge` role, or a
   * test), a router is built on the same store, which records and publishes
   * identically and has no handlers. The difference is visible in the answer:
   * `handlers` lists what was registered, so a scan that resolved `unhandled`
   * because nothing is registered is distinguishable from one that resolved
   * `unhandled` because no handler claimed the code.
   */
  type Manager = ReturnType<typeof managerForStation>['manager'];

  function routerFor(boxId: string, manager: Manager): ScanRouter {
    const agent = virtualBoxAgent();
    const own = agent && agent.state.boxId === boxId ? agent.scanner() : null;
    if (own) return own;
    return new ScanRouter({
      boxId,
      store: boxStoreFor(app.db),
      publish: (id, message) => manager.emitScan(id, message),
      log: app.log,
    });
  }

  async function station(req: FastifyRequest, stationId: string) {
    const auth = req.requireAuth();
    const row = await loadStationRow(app.db, auth.operatorId, stationId);
    if (auth.stationId !== stationId) {
      // Everyone else has to hold the fleet's read permission AT THIS
      // STATION's branch — the same rule the session document uses, so a
      // manager scoped to one branch cannot scan into a till at another.
      await req.requirePermission('admin:station:read', { branchId: row.branchId });
    }
    const { manager, boxId } = managerForStation(app.db, row, req.log);
    return { row, boxId, auth, manager };
  }

  const ACTION_ID = /^[A-Za-z0-9._-]{8,64}$/;
  const actionIdOf = (req: FastifyRequest): string | null => {
    const sent = req.headers['x-oto-action-id'];
    return typeof sent === 'string' && ACTION_ID.test(sent) ? sent : null;
  };

  const answer = (result: ScanResult, router: ScanRouter) => ({
    ...result,
    handlers: router.registered(),
  });

  app.post(
    '/stations/:id/scan',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Deliver a scanned code to the station’s box: it classifies the code, gives it to whichever handler claimed it, writes a fingerprint-only line on the station tape and tells every screen watching. The code itself stops at the box.',
        params: IdParams,
        body: ScanBody,
        response: { 200: ScanResultSchema },
      },
    },
    async (req) => {
      const { row, boxId, auth, manager } = await station(req, req.params.id);
      const router = routerFor(boxId, manager);
      const input: ScanInput = {
        code: req.body.code,
        source: req.body.source as ScanSource,
        scannedAt: req.body.scannedAt,
        actionId: actionIdOf(req),
        accountId: auth.accountId,
      };
      const result = await router.deliver(row.id, input, {
        screen: auth.stationId === row.id ? 'till' : 'console',
      });
      return answer(result, router);
    },
  );

  app.post(
    '/stations/:id/scan/simulate',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Pretend a scanner. The code is turned into the key events or the byte record a DS2278 would produce and fed through the same reader that reads the real device, so the burst rule and the record rule are what decide — not the simulator.',
        params: IdParams,
        body: SimulateBody,
        response: {
          200: ScanResultSchema.extend({
            /** What the reader made of the simulated input, before delivery. */
            recognised: z.boolean(),
            mode: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const { row, boxId, auth, manager } = await station(req, req.params.id);
      const router = routerFor(boxId, manager);
      const actionId = actionIdOf(req);

      let produced: ScanInput | null = null;
      if (req.body.mode === 'hid') {
        const reader = new HidBurstReader({ source: 'simulator' });
        for (const key of simulateHidKeys(req.body.code, {
          interCharDelayMs: req.body.interCharDelayMs,
          withSuffix: req.body.withSuffix,
          startAt: Date.now(),
        })) {
          const event = reader.push(key);
          if (event?.kind === 'scan') produced = event.input;
        }
        if (!produced) {
          // No suffix: the real device is then finished by the quiet gap, and
          // so is this — `tick` at the far side of the timeout.
          const closed = reader.tick(Date.now() + 10_000);
          if (closed?.kind === 'scan') produced = closed.input;
        }
      } else {
        const reader = new SerialScanReader({ source: 'simulator' });
        const [first] = reader.push(
          simulateSerialRecord(req.body.code, {
            withSuffix: req.body.withSuffix,
            codeId: req.body.codeId ?? null,
          }),
          Date.now(),
        );
        produced = first ?? reader.tick(Date.now() + 10_000);
      }

      if (!produced) {
        // The reader refused it: too short to be a code, or typed at human
        // pace. That is a RESULT and the panel shows it — it is exactly the
        // behaviour the acceptance criterion asks to be able to demonstrate.
        throw new AppError(
          422,
          'SCAN_NOT_RECOGNISED',
          'The reader did not see that as a scan: too short, or typed slowly enough to be a person',
        );
      }

      const result = await router.deliver(
        row.id,
        { ...produced, actionId, accountId: auth.accountId },
        { screen: 'console' },
      );
      return { ...answer(result, router), recognised: true, mode: req.body.mode };
    },
  );

  app.post(
    '/auth/badge',
    {
      config: { auth: 'session' },
      schema: {
        description:
          'Present a staff badge or type a PIN at the till. The value reaches the box’s scanning service as a `staff_badge` code and is never written down: the station tape gets a fingerprint and the outcome. No handler is registered yet — staff credentials are S2-07b — so today the honest answer is `unhandled`, and the till says so.',
        body: z.object({
          value: z.string().min(1).max(256),
          /** `manual` when typed, `keyboard` when a scanner typed it into the page. */
          source: z.enum(['manual', 'keyboard', 'camera']).default('manual'),
        }),
        response: {
          200: z.object({
            outcome: z.string(),
            handler: z.string().nullable(),
            /** What the screen should say when nothing claimed it. */
            message: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      if (!auth.stationId) {
        throw new AppError(
          409,
          'NO_STATION_PICKED',
          'This session is not standing at a station, so there is no box to read a badge',
        );
      }
      const row = await loadStationRow(app.db, auth.operatorId, auth.stationId);
      const { manager, boxId } = managerForStation(app.db, row, req.log);
      const router = routerFor(boxId, manager);
      /**
       * A badge value is a credential on its way to an authentication path. It
       * is carried and never stored — the same rule
       * `SIMULATOR_ACTIONS_WITH_SECRETS` states for the simulator — and what
       * lands on the tape is the sixteen-character fingerprint the scanning
       * service writes for every code.
       */
      const result = await router.deliver(
        row.id,
        {
          code: req.body.value,
          source: req.body.source as ScanSource,
          actionId: actionIdOf(req),
          accountId: auth.accountId,
        },
        { screen: 'till' },
      );
      return {
        outcome: result.outcome,
        handler: result.handler,
        message:
          result.outcome === 'unhandled'
            ? 'Badges and PINs are not linked to accounts on this build yet — use your password.'
            : null,
      };
    },
  );

  app.post(
    '/stations/:id/button',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The physical counter button, as a key. Enter is refused: it is the scanner’s programmed suffix, so a button sending Enter cannot be told from the end of a scan — and on a screen it submits whatever form has focus.',
        params: IdParams,
        body: z.object({ key: z.string().min(1).max(24) }),
        response: {
          200: z.object({
            pressed: z.boolean(),
            key: z.string(),
            /** No station-event row: `station_event.kind` has no `button`. */
            recorded: z.literal(false),
          }),
        },
      },
    },
    async (req) => {
      await station(req, req.params.id);
      const problem = buttonKeyProblem(req.body.key);
      if (problem) throw new AppError(400, 'BUTTON_KEY_NOT_ALLOWED', problem);
      /**
       * A press is published and logged and writes NO row.
       * `edge.station_event.kind` is a CHECK over
       * `intent | snapshot | lease | scan | error`, and a button is none of
       * them — recording it as a `scan` would put a press on the scan tape and
       * make "how many scans failed this afternoon" wrong. Widening that CHECK
       * is a migration, and it belongs to whichever ticket gives the button
       * something to do; until then the honest record is the request log line
       * this route already writes.
       */
      req.log.info(
        { stationId: req.params.id, key: req.body.key, module: 'scan' },
        'counter button pressed',
      );
      return { pressed: true, key: req.body.key, recorded: false as const };
    },
  );
}
