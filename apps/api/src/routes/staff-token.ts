import { z } from 'zod';
import type { App } from '../app';
import { AppError } from '../lib/errors';
import { loadStationRow } from '../services/station-session';
import {
  listStaffTokens,
  mintStaffToken,
  offlineUnlock,
  revokeStaffTokens,
  staffTokenSettings,
} from '../services/staff-token';

/**
 * The shift token, over HTTP (S2-06).
 *
 * Three doors, and the split between them is the whole design:
 *
 *   - **`POST /me/staff-token`** — mint. Called by the till at the moment
 *     somebody picks a station, which is also where `PUT /me/session/station`
 *     mints one and hands it back; this route exists for the till that already
 *     had a station when the feature arrived, and for a token refreshed
 *     mid-shift. It is an ordinary authenticated request and needs the
 *     internet, which is the point: a token is the cloud vouching for a shift.
 *   - **`POST /auth/unlock-offline`** — spend it. Reachable by a LOCKED
 *     session (it is on the session plugin's exempt list beside
 *     `POST /auth/unlock`) and verified entirely against what the box has
 *     cached. This is the one that has to work when nothing else does.
 *   - **`GET /accounts/:id/staff-tokens`** and **`DELETE /staff-tokens/:jti`**
 *     — the Console's view and an administrator ending a shift by hand. Both
 *     permissioned; neither is reachable from the till.
 *
 * **Why the unlock is not `POST /auth/unlock` with a flag.** The two paths
 * answer different questions. The online one asks the database whether this
 * password matches this account, right now, and is the truth. The offline one
 * asks a copy of the staff list that a box took some hours ago, which is a
 * weaker statement and is recorded as one — `auth_method=offline_token`, with
 * the age of the cache on the audit row. Folding them into one route would
 * make "how did this person get in" a thing you work out from absence.
 */

const JtiParams = z.object({ jti: z.string().uuid() });
const AccountParams = z.object({ id: z.string().uuid() });

const StaffTokenView = z.object({
  jti: z.string().uuid(),
  accountId: z.string().uuid(),
  stationId: z.string().uuid(),
  boxId: z.string().uuid(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedReason: z.string().nullable(),
});

export async function staffTokenRoutes(app: App): Promise<void> {
  app.post(
    '/me/staff-token',
    {
      // The answer IS the credential, so no idempotency key is taken and
      // nothing is stored to be replayed — the same declaration the launcher
      // hand-off uses.
      config: { auth: 'session', secretResponse: true },
      schema: {
        description:
          'Mint a shift token for the station this session is standing at. The box verifies it offline with the public half; a second mint ends the first, so one session holds one live token.',
        response: {
          200: z.object({
            token: z.string(),
            jti: z.string().uuid(),
            expiresAt: z.string(),
            stationId: z.string().uuid(),
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
          'Take a station first — a shift token is for one station',
        );
      }
      if (!auth.branchId) {
        throw new AppError(409, 'NO_BRANCH', 'This session is not at a branch');
      }
      // Confirms the station is this operator's and not archived, with the
      // same 404 the picker gives; the token would otherwise be minted for a
      // station the caller cannot see.
      const row = await loadStationRow(app.db, auth.operatorId, auth.stationId);
      const minted = await mintStaffToken(
        app.db,
        {
          accountId: auth.accountId,
          sessionId: auth.sessionId,
          operatorId: auth.operatorId,
          branchId: row.branchId,
          stationId: row.id,
          requestId: req.id,
        },
        app.env,
      );
      return {
        token: minted.token,
        jti: minted.jti,
        expiresAt: minted.expiresAt.toISOString(),
        stationId: row.id,
      };
    },
  );

  app.post(
    '/auth/unlock-offline',
    {
      config: { auth: 'session' },
      schema: {
        description:
          'Unlock a locked till with no internet: the shift token is verified against the box’s cached signing key and deny-list, and the password against the box’s cached hash. Recorded as session.unlock with auth_method=offline_token. Refuses an expired token with "shift token expired, connect to sign in"; five wrong passwords share the online cooldown.',
        body: z.object({
          /** Absent is allowed: with STAFF_OFFLINE_SIGN_IN on, recognition decides. */
          token: z.string().min(1).max(4096).optional(),
          password: z.string().min(1),
        }),
        response: {
          200: z.object({
            locked: z.literal(false),
            authMethod: z.string(),
            cachedAt: z.string().nullable(),
            cacheAgeSeconds: z.number().int().nullable(),
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
          'This session is not standing at a station, so there is no box holding its offline copy',
        );
      }
      return offlineUnlock(app.db, app.env, {
        sessionId: auth.sessionId,
        // From the session, never from the token: the token says who it was
        // minted for, and the session says whose till is locked. They have to
        // be the same person, and the service refuses when they are not.
        accountId: auth.accountId,
        operatorId: auth.operatorId,
        branchId: auth.branchId,
        stationId: auth.stationId,
        token: req.body.token ?? null,
        password: req.body.password,
        requestId: req.id,
      });
    },
  );

  app.get(
    '/accounts/:id/staff-tokens',
    {
      config: { permission: 'admin:account:read' },
      schema: {
        description: 'Shift tokens minted for one account, newest first.',
        params: AccountParams,
        response: { 200: z.object({ tokens: z.array(StaffTokenView) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const rows = await listStaffTokens(app.db, {
        operatorId: auth.operatorId,
        accountId: req.params.id,
      });
      return {
        tokens: rows.map((t) => ({
          ...t,
          issuedAt: t.issuedAt.toISOString(),
          expiresAt: t.expiresAt.toISOString(),
          revokedAt: t.revokedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  app.delete(
    '/staff-tokens/:jti',
    {
      config: { permission: 'admin:account:update' },
      schema: {
        description:
          'End one shift token. It joins the deny-list every box pulls, so a box that is offline honours it from its next pull — until then the token’s own expiry is the bound, which is why the expiry is hours.',
        params: JtiParams,
        response: { 200: z.object({ revoked: z.number().int() }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const ended = await revokeStaffTokens(
        app.db,
        { jti: req.params.jti },
        'admin',
        auth.accountId,
      );
      return { revoked: ended.length };
    },
  );

  app.get(
    '/staff-tokens/settings',
    {
      config: { permission: 'admin:account:read' },
      schema: {
        description:
          'Whether this deployment can mint shift tokens at all, and under what rules. Never the key.',
        response: {
          200: z.object({
            available: z.boolean(),
            kid: z.string().nullable(),
            ttlSeconds: z.number().int().nullable(),
            offlineSignIn: z.boolean(),
          }),
        },
      },
    },
    async () => {
      const settings = staffTokenSettings(app.env);
      return {
        available: Boolean(settings),
        kid: settings?.kid ?? null,
        ttlSeconds: settings?.ttlS ?? null,
        offlineSignIn: settings?.offlineSignIn ?? false,
      };
    },
  );
}
