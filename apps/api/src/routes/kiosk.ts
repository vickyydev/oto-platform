import { z } from 'zod';
import {
  KioskDeskAnswerSchema,
  KioskHealthAnswerSchema,
  KioskPairingStartAnswerSchema,
  KioskPairingStatusSchema,
  KioskSimulatorAnswerSchema,
  KioskSimulatorRequestSchema,
  newId,
} from '@oto/shared';
import type { App } from '../app';
import { AppError, errors } from '../lib/errors';
import { kioskPairingHashOf } from '../plugins/credential';
import { branchReach } from '../services/access-control';
import { loadStation } from '../services/fleet';
import { claimKiosk, expireKioskPairing, kioskPairingStatus, requestKioskPairing } from '../services/kiosk-pairing';
import { kioskDesk, kioskHealth, simulateKiosk } from '../services/kiosk-staff';
import { opCtx } from '../services/tx';
import { actionIdOf } from './stations';

const IdParams = z.object({ id: z.string().uuid() });

/**
 * S2-20 K2 (SCRUM-217) — THE SELF-SERVICE KIOSK'S SURFACE, beside K1's
 * redemption on the station bridge (`routes/station-bridge.ts`):
 *
 *   - pairing, as a customer display pairs: the kiosk's browser asks for a
 *     code with its own secret (`credential: 'kiosk-pairing'`), a manager
 *     claims the code against a kiosk station (`admin:device:pair`);
 *   - the staff desk's view of the families a kiosk sent to it
 *     (`pos:booking:read` at the branch);
 *   - the Console's Kiosk tile on Health (`admin:health:read`, in reach);
 *   - the virtual kiosk's simulator controls (`admin:box:command`).
 *
 * The kiosk's own screen calls — its state, a guest's session, walking away
 * — are on the station bridge with the paired credential, next to the redeem.
 */
export async function kioskRoutes(app: App): Promise<void> {
  // --- Pairing -----------------------------------------------------------------

  app.post(
    '/kiosk/pairing',
    {
      config: { credential: 'kiosk-pairing', secretResponse: true, rateLimit: { max: 60, timeWindow: 60_000 } },
      schema: {
        description:
          "Show a short pairing code (K and six digits) for this kiosk browser. The bearer was generated on the browser; only hashes are kept.",
        body: z.object({}).strict(),
        response: { 200: KioskPairingStartAnswerSchema },
      },
    },
    (req) => requestKioskPairing(app.db, opCtx(req), kioskPairingHashOf(req), req.ip),
  );

  app.post(
    '/kiosk/pairing/expire',
    {
      config: { credential: 'kiosk-pairing', rateLimit: { max: 60, timeWindow: 60_000 } },
      schema: {
        description: "Invalidate this unpaired kiosk browser's current code. A paired kiosk is revoked by a manager.",
        body: z.object({}).strict(),
        response: { 200: z.object({ expired: z.literal(true) }) },
      },
    },
    (req) => expireKioskPairing(app.db, opCtx(req), kioskPairingHashOf(req)),
  );

  app.get(
    '/kiosk/pairing',
    {
      config: { credential: 'kiosk-pairing' },
      schema: {
        description:
          'Read whether this kiosk browser is waiting, paired (and to which kiosk), or needs another code. No secret is returned.',
        response: { 200: KioskPairingStatusSchema },
      },
    },
    (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      return kioskPairingStatus(app.db, kioskPairingHashOf(req));
    },
  );

  app.post(
    '/stations/:id/kiosks/claim',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'A manager binds the code shown on a self-service kiosk to one kiosk station. The code is consumed once; the kiosk gets its device scope, pos:kiosk:redeem.',
        params: IdParams,
        body: z
          .object({
            pairingCode: z.string().trim().min(6).max(12),
            name: z.string().trim().min(1).max(80),
          })
          .strict(),
        response: {
          200: z.object({
            station: z.object({ id: z.string().uuid(), name: z.string(), kind: z.string() }),
            device: z.object({ id: z.string().uuid(), name: z.string() }),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const target = await loadStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:device:pair', { branchId: target.branchId });
      if (target.archivedAt) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
      return claimKiosk(app.db, opCtx(req), auth, target, req.body);
    },
  );

  // --- The staff desk ----------------------------------------------------------

  app.get(
    '/kiosk-desk',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "The families a self-service kiosk sent to the staff desk today, with their booking and what is left to do: redeem it at the till, or check its supervised children in. No child, allergy or phone.",
        querystring: z.object({ branchId: z.string().uuid().optional() }),
        response: { 200: KioskDeskAnswerSchema },
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const branchId = req.query.branchId ?? auth.branchId;
      if (!branchId) throw errors.badRequest('No active branch on this session');
      await req.requirePermission('pos:booking:read', { branchId });
      reply.header('cache-control', 'private, no-store');
      return kioskDesk(app.db, auth.operatorId, branchId);
    },
  );

  // --- The Console's Kiosk tile ------------------------------------------------

  app.get(
    '/ops/kiosks',
    {
      config: { permission: 'admin:health:read' },
      schema: {
        description:
          "Every self-service kiosk in the reader's reach: its box and screen online, its band printer and paper, today's sessions by outcome and its last redemption. Names, states and counts only.",
        response: { 200: KioskHealthAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const reach = branchReach(await req.effectivePermissions(), 'admin:health:read', auth.operatorId);
      return kioskHealth(app.db, auth.operatorId, reach);
    },
  );

  // --- The virtual kiosk's simulator controls -----------------------------------

  app.post(
    '/stations/:id/kiosk/simulate',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "Drive a kiosk failure screen without hardware: its band printer offline or out of paper, its box offline, or all of it cleared. Applied at once to the box this api runs, and audited.",
        params: IdParams,
        body: KioskSimulatorRequestSchema,
        response: { 200: KioskSimulatorAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const target = await loadStation(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('admin:box:command', { branchId: target.branchId });
      if (target.archivedAt) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
      return simulateKiosk(app.db, opCtx(req), auth, target, req.body.control, actionIdOf(req) ?? newId());
    },
  );
}
