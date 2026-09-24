import { z } from 'zod';
import { BoothStaffVerifyRequestSchema } from '@oto/shared';
import type { App } from '../app';
import { boxAuthOf } from '../plugins/credential';
import { boxSettings } from '../services/box';
import { verifyBoothStaff } from '../services/box-booth-staff';

/**
 * `POST /box/v1/booth/staff/verify` — a booth box asks whether the phone and
 * password somebody typed at its booth may sign in there (SCRUM-223).
 *
 * A box route: authenticated by the box's own credential (`credential: 'box'`,
 * enforced by `plugins/credential.ts` before the body is read), never by a
 * person's session. Declared with its full path, like the fleet's, in a file
 * of its own so the booth's sign-in rule has one home.
 *
 * `secretResponse` is about the REQUEST: the body carries a password, and the
 * idempotency store keeps a hash of request bodies. Declaring it keeps the
 * plugin from writing anything about this body anywhere, as the booth PIN
 * route does.
 */
export async function boxBoothStaffRoutes(app: App): Promise<void> {
  const settings = boxSettings();

  // `BOOTH_STAFF_VERIFY_PATH` in `@oto/shared`, written out as a literal so
  // the conformance tests' route walker can read it.
  app.post(
    '/box/v1/booth/staff/verify',
    {
      config: {
        credential: 'box',
        secretResponse: true,
        rateLimit: { max: settings.ipRateMax, timeWindow: 60_000 },
      },
      schema: {
        description:
          'A booth box forwards a phone and password typed at one of its own booths. Answers who it is — account id, display name, staff code — when the password is right, the role carries `booth:staff:sign_in` at the booth’s branch, and an administrator has put the account on the booth’s staff list. A wrong phone or password is one 401 whatever the reason, counted against the same per-phone bucket as the sign-in screen and against the booth; 403 names the reason only once the password was right; 429 carries `retryAfterS`. The password is verified and kept nowhere.',
        body: BoothStaffVerifyRequestSchema,
        response: {
          200: z.object({
            accountId: z.string().uuid(),
            displayName: z.string().nullable(),
            staffCode: z.string(),
          }),
        },
      },
    },
    async (req) =>
      verifyBoothStaff(app.db, boxAuthOf(req), req.body, {
        maxFailures: app.env.AUTH_MAX_FAILURES,
        cooldownSeconds: app.env.AUTH_COOLDOWN_SECONDS,
        requestId: req.id,
        log: req.log,
      }),
  );
}
