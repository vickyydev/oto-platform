import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors';
import { forcedOfflineStation } from '../services/station-offline';
import { requireRoutePermission } from './permission';

/** SCRUM-285: cloud trading cannot pass as an offline station demonstration. */
export const stationOfflinePlugin = fp(async (app: FastifyInstance) => {
  app.addHook('preHandler', async (req) => {
    if (!app.env.OPS_TEST_CONTROLS || !req.routeOptions.config.stationTrading) return;

    // Authentication and static permissions still win over the test refusal.
    // The route's normal permission guard repeats this cached check afterwards;
    // this hook must run first so idempotency cannot claim or replay a key.
    const auth = req.requireAuth();
    await requireRoutePermission(req, req.routeOptions.config);
    if (!(await forcedOfflineStation(app.db, auth))) return;

    throw new AppError(
      503,
      'STATION_FORCED_OFFLINE',
      req.routeOptions.config.stationOfflineMessage ??
        'This station is forced offline for testing. Go online before taking payment or changing the sale.',
    );
  });
});
