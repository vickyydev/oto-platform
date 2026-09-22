import { z } from 'zod';
import type { App } from '../app';
import { AppError } from '../lib/errors';
import {
  assertDominatesAccount,
  branchReach,
  loadTargetAccount,
} from '../services/access-control';
import { audit } from '../services/audit';
import { loadStationRow } from '../services/station-session';
import {
  listStaffTokens,
  loadStaffToken,
  mintStaffToken,
  offlineUnlock,
  revokeStaffTokens,
  staffTokenSettings,
} from '../services/staff-token';
import { opCtx, withTx } from '../services/tx';

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
 *     `POST /auth/unlock`) and DECIDED entirely against what the box has
 *     cached: the token against the box's cached signing key and deny-list,
 *     the password against the box's cached hash. **It is still an api
 *     route** — the session plugin reads `core.session` joined to
 *     `core.account` before the handler runs — so a till with no route to the
 *     cloud cannot reach it today. The verifier that would serve such a till
 *     is in `@oto/box-agent`; what it needs is a local HTTP surface on the
 *     box to call it, which is the next ticket's work and is recorded in
 *     SPRINT_2_PROGRESS.md. Nothing here should be built against as though a
 *     Raspberry Pi already answered it.
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
      /**
       * SCRUM-284 — the mint is one operation, so it is one transaction.
       *
       * `mintStaffToken` publishes the key, ends the token this session still
       * holds, inserts the new row and audits it. On the pool, a failure
       * between the revoke and the insert left the till with no live shift
       * token at all — the credential that unlocks it when the mall link is
       * down. The same function reached through `PUT /me/session/station` was
       * always inside `pickStation`'s transaction; this path now matches it,
       * so the invariant holds on both rather than on one.
       */
      const minted = await withTx(app.db, opCtx(req), 'staff_token.mint', (tx) =>
        mintStaffToken(
          tx,
          {
            accountId: auth.accountId,
            sessionId: auth.sessionId,
            operatorId: auth.operatorId,
            branchId: row.branchId,
            stationId: row.id,
            requestId: req.id,
          },
          app.env,
        ),
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
          'Unlock a locked till from the box’s cached copy: the shift token is verified against the box’s cached signing key and deny-list, and the password against the box’s cached hash — no account row decides anything. This route still needs to be reachable, so it serves a till whose box is offline, not one that cannot reach the api at all. Recorded as session.unlock with auth_method=offline_token. Refuses an expired token with "shift token expired, connect to sign in"; refuses when the box holds no deny-list and so cannot check whether the shift was ended; five wrong passwords share the online cooldown.',
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
        description:
          'Shift tokens minted for one account, newest first — the caller’s own operator, the accounts they may act on, and the branches their grant reaches.',
        params: AccountParams,
        response: { 200: z.object({ tokens: z.array(StaffTokenView) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      /**
       * SCRUM-280 — the three checks every other account route already had,
       * and this one was written without.
       *
       * A row here names a station, a box, a branch and a shift: it is a
       * colleague's working day, and it was step one of ending their shift —
       * the list hands over the jti, the revoke below spends it. So: the
       * account must be this operator's (404 otherwise, because another
       * operator's account is not ours to confirm), the caller must dominate
       * the roles it holds, and the tokens themselves are narrowed to the
       * branches the caller's `admin:account:read` actually reaches. The third
       * is what holds when the second passes vacuously — a new hire with an
       * account and no roles yet.
       */
      await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      const effective = await req.effectivePermissions();
      await assertDominatesAccount(app.db, effective, auth.operatorId, req.params.id);
      const rows = await listStaffTokens(app.db, {
        operatorId: auth.operatorId,
        accountId: req.params.id,
        reach: branchReach(effective, 'admin:account:read', auth.operatorId),
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
      /**
       * `dynamicPermission`: the branch to ask about is on the row, and the
       * row has to be read before the question can be put.
       */
      config: { dynamicPermission: true },
      schema: {
        description:
          'End one shift token, at the branch it was minted at. It joins the deny-list every box pulls, so a box that is offline honours it from its next pull — until then the token’s own expiry is the bound, which is why the expiry is hours.',
        params: JtiParams,
        response: { 200: z.object({ revoked: z.number().int() }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      /**
       * SCRUM-280 — LOAD THE TOKEN, THEN ASK ABOUT ITS BRANCH.
       *
       * This used to build its whole predicate as `eq(staff_token.jti, jti)`
       * and declare `admin:account:update` with no target, so the guard fell
       * back to whatever branch the caller had put their own session on. A
       * manager at one park ended a live shift credential on the other park's
       * till — the token that unlocks it with the mall link down — and it
       * would have surfaced as "the till logged itself out mid-shift".
       *
       * The row carries both ids, so both are used: the load is scoped to the
       * operator, the permission is asked at the branch the token was minted
       * at, and the caller must dominate the account whose shift this is —
       * ending somebody's shift is acting on their account, the same rule
       * `POST /accounts/:id/sessions/revoke` applies to ending their sessions.
       */
      const token = await loadStaffToken(app.db, auth.operatorId, req.params.jti);
      await req.requirePermission('admin:account:update', { branchId: token.branchId });
      await assertDominatesAccount(
        app.db,
        await req.effectivePermissions(),
        auth.operatorId,
        token.accountId,
      );

      // SCRUM-282 — and it leaves a row. Minting was audited from the start;
      // an administrator ending somebody's shift was not, which left the
      // Console's trail silent about the half that takes access away.
      return withTx(app.db, opCtx(req), 'staff_token.revoke', async (tx) => {
        const ended = await revokeStaffTokens(
          tx,
          { jti: token.jti, operatorId: token.operatorId, branchId: token.branchId },
          'admin',
          auth.accountId,
        );
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: token.operatorId,
          branchId: token.branchId,
          action: 'staff_token.revoke',
          entityType: 'staff_token',
          entityId: token.jti,
          // Whose shift, and whether this call is what ended it: a token
          // already revoked or already expired answers 0, and the row says so
          // rather than reading as a second revocation.
          after: { accountId: token.accountId, reason: 'admin', ended: ended.length },
          requestId: req.id,
        });
        return { revoked: ended.length };
      });
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
