import { z } from 'zod';
import { DisplaySnapshotResponseSchema, StationIntentSchema, StationSessionDocumentSchema } from '@oto/shared';
import type { App } from '../app';
import { AppError } from '../lib/errors';
import { displayDeviceOf, displayPairingHashOf } from '../plugins/credential';
import { holdsGrantAt } from '../services/access-control';
import {
  claimDisplay, displayIntent, displayPairingStatus, displaySession, expireDisplayPairing,
  readDisplaySnapshot, requestDisplayPairing, stationDisplays,
} from '../services/display';
import { loadCredential, loadStation } from '../services/fleet';
import { opCtx } from '../services/tx';

const IdParams = z.object({ id: z.string().uuid() });
const StationSchema = z.object({ id: z.string().uuid(), name: z.string(), kind: z.string() });
const DeviceSchema = z.object({ id: z.string().uuid(), name: z.string() });
const PairedSchema = z.object({ station: StationSchema, device: DeviceSchema });
const DocumentSchema = z.object({ document: StationSessionDocumentSchema });

/** Device credentials and finite snapshots never depend on the staff session. */
export async function displayRoutes(app: App): Promise<void> {
  app.post('/display/pairing', {
    config: { credential: 'display-pairing', secretResponse: true, rateLimit: { max: 60, timeWindow: 60_000 } },
    schema: {
      description: 'Show a short pairing code for this browser. The bearer was generated on the browser; only hashes are kept.',
      body: z.object({}),
      response: { 200: z.object({ pairingCode: z.string().regex(/^\d{6}$/), expiresAt: z.string() }) },
    },
  }, (req) => requestDisplayPairing(app.db, opCtx(req), displayPairingHashOf(req), req.ip));

  app.post('/display/pairing/expire', {
    config: { credential: 'display-pairing', rateLimit: { max: 60, timeWindow: 60_000 } },
    schema: {
      description: 'Invalidate this unpaired browser\'s current code. Paired devices are revoked by a manager.',
      body: z.object({}), response: { 200: z.object({ expired: z.literal(true) }) },
    },
  }, (req) => expireDisplayPairing(app.db, opCtx(req), displayPairingHashOf(req)));

  app.get('/display/pairing', {
    config: { credential: 'display-pairing' },
    schema: {
      description: 'Read whether this browser is waiting, paired, or needs another code. No device secret is returned.',
      response: { 200: z.object({
        status: z.enum(['pending', 'paired', 'expired']), station: StationSchema.optional(), device: DeviceSchema.optional(),
      }) },
    },
  }, (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    return displayPairingStatus(app.db, displayPairingHashOf(req));
  });

  app.post('/stations/:id/displays/claim', {
    config: { dynamicPermission: true },
    schema: {
      description: 'A manager binds the code shown on a display to one station. The code is consumed once.',
      params: IdParams,
      body: z.object({ pairingCode: z.string().regex(/^\d{6}$/), name: z.string().trim().min(1).max(80) }),
      response: { 200: PairedSchema },
    },
  }, async (req) => {
    const auth = req.requireAuth();
    const target = await loadStation(app.db, auth.operatorId, req.params.id);
    await req.requirePermission('admin:device:pair', { branchId: target.branchId });
    if (target.archivedAt) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
    return claimDisplay(app.db, opCtx(req), auth, target, req.body);
  });

  app.get('/stations/:id/displays', {
    config: { dynamicPermission: true },
    schema: {
      description: 'Active paired displays at this station, and whether one called within the last ten seconds.',
      params: IdParams,
      response: { 200: z.object({ displays: z.array(DeviceSchema.extend({
        lastSeenAt: z.string().nullable(), connected: z.boolean(),
      })) }) },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    const target = await loadStation(app.db, auth.operatorId, req.params.id);
    if (auth.stationId !== target.id || !holdsGrantAt(await req.effectivePermissions(), auth.operatorId, target.branchId)) {
      await req.requirePermission('admin:station:read', { branchId: target.branchId });
    }
    reply.header('cache-control', 'private, no-store');
    return stationDisplays(app.db, target.id, auth.operatorId);
  });

  app.get('/display/session', {
    config: { credential: 'display', displayScope: 'display:read' },
    schema: {
      description: 'The paired station snapshot, redacted on the box. No staff cookie or lease is required.',
      response: { 200: PairedSchema.extend({ document: StationSessionDocumentSchema }) },
    },
  }, (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    return displaySession(app.db, displayDeviceOf(req), req.log);
  });

  app.post('/display/intents', {
    config: { credential: 'display', displayScope: 'display:intents' },
    schema: {
      description: 'A stage-valid customer intent for this display’s own station. Source and station cannot be supplied by the browser.',
      body: StationIntentSchema,
      response: { 200: DocumentSchema },
    },
  }, (req) => displayIntent(app.db, displayDeviceOf(req), req.body, req.log));

  app.get('/credentials/:id/display-snapshot', {
    config: { dynamicPermission: true },
    schema: { description: 'Last recorded protected display response prepared by OTO Park; browser receipt is not verified.',
      params: IdParams, response: { 200: DisplaySnapshotResponseSchema } },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    const credential = await loadCredential(app.db, auth.operatorId, req.params.id);
    reply.header('cache-control', 'private, no-store');
    return readDisplaySnapshot(app.db, credential,
      async (branchId) => { await req.requirePermission('admin:station:read', { branchId }); });
  });
}
