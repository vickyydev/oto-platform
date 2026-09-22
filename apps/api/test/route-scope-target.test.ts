import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app';
import { loadEnv } from '../src/env';
import {
  readFunctions,
  readRoutes,
  reachesText,
  withoutAuditCalls,
  type SourceRoute,
} from './route-source';

/**
 * SCRUM-290 — a route that acts on a row by its id says whose row it is.
 *
 * `routes-guarded.test.ts` is the sibling of this file and the reason no
 * unguarded route exists: it walks the registry and fails the day somebody
 * writes a route with no declared guard. What it never asked is the next
 * question. A guard says *what* permission is needed; it does not say *whose*
 * record the request is aimed at, and `grantCovers` cannot work that out —
 * it is a pure function over ids, so an operator-scoped grant says yes to
 * whatever branch id the target happens to name.
 *
 * So a by-id route has to establish ownership itself, and there are two
 * honest ways:
 *
 *   - declare `target:` on the route, and the plugin reads the scope out of
 *     the request before the handler runs; or
 *   - load the row inside the caller's operator first and check against the
 *     branch that comes back — `loadX(db, auth.operatorId, id)` then
 *     `requirePermission(…, { branchId: row.branchId })`, the pattern
 *     `fleet.ts`, `print.ts` and `catalog.ts` use at some seventy sites.
 *
 * Nothing asked which of those a route did. Fifty-five of eighty-one guarded
 * routes declared no target, and nothing distinguished the fifty-one that
 * were fine from the four that leaked — a manager at one park could end a
 * shift credential on the other park's till, and an administrator of one
 * operator could acknowledge another's alert.
 *
 * **This test needs no database.** It builds the app to read the route
 * registry — which is where a declared `target` lives — and reads the handler
 * source for the other half.
 */

let app: App;
let routes: SourceRoute[];
let configs: Map<string, App['routeRegistry'][number]['config']>;
let functions: ReturnType<typeof readFunctions>;

beforeAll(async () => {
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' });
  // No connection is opened: registering routes touches the decorator, never
  // the pool, and nothing here sends a request.
  app = await buildApp({ env, db: {} as never, fileStorage: null });
  configs = new Map(app.routeRegistry.map((r) => [`${r.method} ${r.url}`, r.config]));
  routes = readRoutes();
  functions = readFunctions();
});

afterAll(async () => {
  await app.close();
});

/** Routes Fastify or a plugin registers for us, which we do not configure. */
const NOT_OURS = new Set(['/docs/json', '/*']);

/**
 * What counts as establishing ownership, read out of the handler.
 *
 * `load[A-Z]…(` is the loader family — `loadStation`, `loadTargetAccount`,
 * `loadBranchForOperator` — every one of which takes the caller's operator and
 * answers 404 for a row outside it. `auth.operatorId` is the other form: the
 * handler scopes its own query or passes the operator into the service it
 * calls, which is how `members.ts`, `accounts.ts` and `catalog.ts` do it.
 *
 * What a pass here means, exactly: the handler reaches for the caller's
 * operator before it acts. It is not a proof that the operator ended up in the
 * WHERE clause — nothing static can be — so this is a floor rather than a
 * guarantee, and the dynamic half of the question belongs with the fixture
 * that now puts a foreign row in front of every route (SCRUM-289). The one
 * thing it will not accept as evidence is an operator named only on an audit
 * row; that distinction is `withoutAuditCalls`, and SCRUM-281 is why.
 */
const OWNERSHIP = [/\bload[A-Z]\w*\(/, /auth\.operatorId/];

const establishesOwnership = (text: string): boolean =>
  reachesText(
    withoutAuditCalls(text),
    (body) => OWNERSHIP.some((pattern) => pattern.test(withoutAuditCalls(body))),
    functions,
    // One hop. A dozen routes do the work in a file-local helper — `standing`
    // in `stations.ts`, `station` in `scanning.ts`, `quarantineBox` in
    // `ops.ts` — and following the call is the difference between reading
    // those as conforming and reading them as twelve holes that are not there.
    1,
  );

/**
 * By-id routes that declare no target and load nothing, deliberately.
 *
 * All three are `platformWide`, and that is the whole reason: a platform-wide
 * assignment is the widest scope there is, so there is no narrower target to
 * declare. Two of them act ON an operator — the row in the path IS the tenant,
 * and managing operators is not an operator's business. The third's `:key`
 * names a deployment switch rather than anybody's record.
 *
 * Listed rather than derived from `platformWide` alone, so that a fourth
 * platform-wide route with an id in its path is a line somebody adds on
 * purpose.
 */
const NO_TARGET_NEEDED = new Set([
  'PATCH /operators/:id',
  'POST /operators/:id/administrators',
  'POST /ops/test-controls/:key',
]);

describe('by-id routes (SCRUM-290)', () => {
  it('the source walk found every route the app registered', () => {
    // Everything below reads the handler out of the source, so a file this
    // walk missed would be a file whose routes are silently unchecked. This is
    // what stops the rest of this file from passing vacuously.
    const live = new Set(
      app.routeRegistry
        .filter((r) => !NOT_OURS.has(r.url) && r.method !== 'HEAD' && r.method !== 'OPTIONS')
        .map((r) => `${r.method} ${r.url}`),
    );
    const parsed = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect([...live].filter((k) => !parsed.has(k)).sort(), 'registered but not parsed').toEqual([]);
    expect([...parsed].filter((k) => !live.has(k)).sort(), 'parsed but not registered').toEqual([]);
    expect(live.size).toBeGreaterThan(150);
  });

  it('every by-id route declares a target or establishes ownership before acting', () => {
    const failing: string[] = [];
    let considered = 0;
    for (const route of routes) {
      if (!route.path.includes('/:')) continue;
      const config = configs.get(`${route.method} ${route.path}`);
      if (!config) continue;
      /**
       * The open surface and the box surface are out of scope, and for
       * different reasons. A public route has no caller to scope to at all —
       * `GET /public/branches/:code/catalog` is a mall visitor reading a price
       * list. A box route's principal is a machine whose credential names the
       * box, so its scope comes from the credential and not from the path.
       * Both lists are pinned in `routes-guarded.test.ts`.
       */
      if (config.public || config.credential) continue;
      considered += 1;
      const key = `${route.method} ${route.path}`;
      if (NO_TARGET_NEEDED.has(key)) continue;
      const hasTarget = !!config.target && Object.keys(config.target).length > 0;
      if (hasTarget) continue;
      if (establishesOwnership(route.handlerText)) continue;
      failing.push(`${key}   [${route.file}:${route.line}]`);
    }
    // A guard on the guard: if the filter above ever stops selecting routes,
    // the assertion under it passes on an empty set.
    expect(considered).toBeGreaterThan(90);
    expect(
      failing.sort(),
      'a route acting on a row by id that neither declares a scope target nor loads the row inside the caller’s operator first — add `target:` to its config, or load-then-check as fleet.ts does',
    ).toEqual([]);
  });

  it('the routes excused from declaring a target are only these, and all are platform-wide', () => {
    const excused = [...NO_TARGET_NEEDED].sort();
    expect(
      excused.filter((key) => !configs.has(key)),
      'excused here but no longer registered — delete the line',
    ).toEqual([]);
    expect(
      excused.filter((key) => configs.get(key)?.platformWide !== true),
      'excused without a platform-wide guard, which is the only reason this list accepts',
    ).toEqual([]);
  });

  /**
   * The check, run against the two holes it exists to catch.
   *
   * Both were live on staging until SCRUM-280 and SCRUM-281, and both are now
   * fixed — which is exactly when a check like this stops being able to show
   * that it works. So the handlers as they stood at `91f5d8b` are kept here
   * verbatim and the predicate is run over them. If somebody later loosens
   * `OWNERSHIP` until everything passes, these two fail and say so.
   */
  describe('is calibrated against the leaks it was written for', () => {
    // routes/staff-token.ts at 91f5d8b — an administrator at one park ending a
    // shift credential on the other park's till. The predicate is built as
    // `eq(staffToken.jti, …)` in the service: no operator, no branch.
    const REVOKE_BEFORE_SCRUM_280 = `
      async (req) => {
        const auth = req.requireAuth();
        const ended = await revokeStaffTokens(
          app.db,
          { jti: req.params.jti },
          'admin',
          auth.accountId,
        );
        return { revoked: ended.length };
      }`;

    // routes/ops.ts at 91f5d8b — an administrator of one operator
    // acknowledging another's alert. Note the `auth.operatorId` in the audit
    // row: the operator IS named, on the record of who acted, and the row
    // itself was still updated on its id alone.
    const ACKNOWLEDGE_BEFORE_SCRUM_281 = `
      async (req) => {
        const auth = req.requireAuth();
        return withTx(app.db, opCtx(req), 'ops.alert_acknowledge', async (tx) => {
          const taken = await acknowledgeAlert(tx, req.params.alertId, auth.accountId);
          if (!taken) throw errors.notFound('That alert is not open and unacknowledged');
          await audit.record(tx, {
            actorAccountId: auth.accountId,
            operatorId: auth.operatorId,
            branchId: auth.branchId,
            action: 'ops.alert_acknowledge',
            entityType: 'alert',
            entityId: taken.id,
            after: { key: taken.key },
            requestId: req.id,
          });
          return { ok: true as const };
        });
      }`;

    // The fixed shape, for the other direction: the check has to accept the
    // fix as well as refuse the hole, or it is just a list of strings. This
    // mirrors the route as shipped in routes/ops.ts — findAlert takes the
    // caller's operator and does the tenancy filter itself, so there is no
    // operatorId comparison in the handler. (A first draft of this sample
    // called findAlert with two arguments and compared a field it does not
    // select; a review caught that it described code that would not compile.)
    const ACKNOWLEDGE_AFTER = `
      async (req) => {
        const auth = req.requireAuth();
        const row = await findAlert(app.db, req.params.alertId, auth.operatorId);
        if (!row) throw errors.notFound('That alert is not open and unacknowledged');
        await requireOpsScope(req, row.branchId);
        return withTx(app.db, opCtx(req), 'ops.alert_acknowledge', async (tx) => {
          const taken = await acknowledgeAlert(tx, row.id, auth.accountId, auth.operatorId);
          return { ok: true as const };
        });
      }`;

    it('refuses the shift-token revoke as it stood before SCRUM-280', () => {
      expect(establishesOwnership(REVOKE_BEFORE_SCRUM_280)).toBe(false);
    });

    it('refuses the alert acknowledge as it stood before SCRUM-281, audit row and all', () => {
      expect(establishesOwnership(ACKNOWLEDGE_BEFORE_SCRUM_281)).toBe(false);
    });

    it('accepts a handler that loads the row and checks the operator on it', () => {
      expect(establishesOwnership(ACKNOWLEDGE_AFTER)).toBe(true);
    });
  });
});
