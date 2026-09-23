import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import { BOOTH_DEVICE_HEADER } from '@oto/shared';
import { AppError } from '../lib/errors';
import { authenticateBox, type BoxAuth } from '../services/box';
import {
  authenticateBoothDevice,
  boothUnpaired,
  type BoothDeviceAuth,
} from '../services/device-credential';
import type { PermissionConfig } from './permission';

/**
 * `config.credential` was a label; this makes it a guard (S2-04 review, F3).
 *
 * The permission plugin installs a preHandler only when `config.permission` is
 * set, so the box surface was authenticated purely because each handler
 * remembered to call `authenticateBox` itself. A sixth box route that forgot
 * would have been wide open and would still have passed every test, because
 * `routes-guarded.test.ts` pinned the declared LABELS and the URL list rather
 * than the behaviour.
 *
 * So the declaration now does the work: a route saying `credential: 'box'` is
 * authenticated before its handler runs, by this hook, and the handler reads
 * the result off the request. Forgetting is no longer possible, because there
 * is nothing left to forget.
 *
 * It runs at `preValidation` rather than `preHandler` on purpose: a caller with
 * no credential is refused before the body schema is applied, so an anonymous
 * probe is answered "you are not a box" rather than being told which fields a
 * box is expected to send.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by this plugin on a `credential: 'box'` route, null everywhere else. */
    boxAuth: BoxAuth | null;
    /** Set by this plugin on a `credential: 'booth'` route, null everywhere else. */
    boothDevice: BoothDeviceAuth | null;
  }
}

/** The authenticated box, for a handler on a route that declared one. */
export function boxAuthOf(req: FastifyRequest): BoxAuth {
  if (!req.boxAuth) {
    // Only reachable if a route read this without declaring `credential: 'box'`.
    throw new AppError(401, 'BOX_UNAUTHORIZED', 'This box credential is not valid');
  }
  return req.boxAuth;
}

/**
 * The paired screen, for a handler on a route that declared one.
 *
 * Reading it is how a `/booth/*` route learns WHICH booth the browser in front
 * of it belongs to — which the request itself does not say and, under D15,
 * never will.
 */
export function boothDeviceOf(req: FastifyRequest): BoothDeviceAuth {
  // Only reachable if a route read this without declaring `credential: 'booth'`.
  if (!req.boothDevice) throw boothUnpaired();
  return req.boothDevice;
}

export const credentialPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('boxAuth', null);
  app.decorateRequest('boothDevice', null);

  app.addHook('onRoute', (route: RouteOptions) => {
    const kind = (route.config as PermissionConfig | undefined)?.credential;
    if (!kind) return;

    const guard = async (req: FastifyRequest) => {
      if (kind === 'box') {
        req.boxAuth = await authenticateBox(app.db, req.headers.authorization, {
          ip: req.ip,
          log: req.log,
          requestId: req.id,
        });
        return;
      }
      if (kind === 'booth') {
        /**
         * The television's own credential (SCRUM-244).
         *
         * It runs at `preValidation` like the rest, which matters more here
         * than anywhere: an anonymous caller who found `POST /booth/spin` is
         * refused before the spin body is validated, so the refusal cannot be
         * mined for what a press is supposed to look like.
         */
        const header = req.headers[BOOTH_DEVICE_HEADER];
        req.boothDevice = await authenticateBoothDevice(
          app.db,
          typeof header === 'string' ? header : undefined,
          { ip: req.ip, log: req.log },
        );
        return;
      }
      /**
       * `box-claim`: the claim code IS the credential, and only the database
       * can say whether it is a real one — so this checks that a caller
       * presented something at all, and `registerBox` checks what. Without it
       * a code-less request fell through to schema validation and was answered
       * 400, which reads as "your body is wrong" rather than "you are not
       * anybody", and made the register route the one box route with no
       * refusal of its own.
       */
      const presented = (req.body as { claimCode?: unknown } | undefined)?.claimCode;
      if (typeof presented !== 'string' || presented.trim().length === 0) {
        throw new AppError(
          401,
          'BOX_CLAIM_INVALID',
          'That claim code is not recognised, or it has already been used',
        );
      }
    };

    const existing = route.preValidation;
    route.preValidation = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), guard]
      : [guard];
  });
});
