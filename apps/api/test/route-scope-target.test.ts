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

describe('Operator selection target (SCRUM-640)', () => {
  it('targets current-session authority, never a body-selected actor or session', () => {
    const route = routes.find(r => r.method === 'PUT' && r.path === '/me/session/operator');
    expect(route).toBeDefined();
    expect(configs.get('PUT /me/session/operator')?.permission).toBe('platform:operator:switch');
    expect(configs.get('PUT /me/session/operator')?.target).toEqual({ operator: true });
    expect(route!.handlerText).toContain('accountId: auth.accountId');
    expect(route!.handlerText).toContain('sessionId: auth.sessionId');
    expect(route!.handlerText).not.toMatch(/req\.body\.(?:accountId|sessionId)/);
  });
});

describe('Platform list scope (SCRUM-639)', () => {
  it('declares the platform boundary and checks fresh null-scope authority before each read', () => {
    for (const path of ['/platform/alerts', '/platform/jobs', '/platform/environment']) {
      const route = routes.find(r => r.method === 'GET' && r.path === path);
      expect(route, path).toBeDefined();
      expect(configs.get(`GET ${path}`)?.target, path).toEqual({ operator: true });
      expect(configs.get(`GET ${path}`)?.platformWide, path).toBe(true);
      expect(reachesText(route!.handlerText, text => /req\.effectivePermissions\s*\(/.test(text), functions), path).toBe(true);
      expect(reachesText(route!.handlerText, text => /\bisPlatformWide\s*\(/.test(text), functions), path).toBe(true);
    }
  });
});

describe('Assistant settings operator ownership (SCRUM-638)', () => {
  it('declares the operator target and derives identity from fresh auth on both routes', () => {
    const settings = routes.filter(r => r.path === '/assistant-settings');
    expect(settings.map(r => r.method).sort()).toEqual(['GET', 'PUT']);
    for (const route of settings) {
      const config = configs.get(`${route.method} ${route.path}`);
      expect(config?.permission).toBe('inbox:ai:manage');
      expect(config?.target).toEqual({ operator: true });
      expect(reachesText(route.handlerText, text => /auth\.operatorId/.test(text), functions)).toBe(true);
      expect(route.optionsText).toContain('preValidation:');
      expect(route.optionsText).toContain('operatorOnly: true');
    }
  });
});

describe('Aggregate selected parks (SCRUM-636)', () => {
  it('binds every aggregate to the current operator and fresh dynamic authority', () => {
    for (const path of [
      '/aggregates/members', '/aggregates/bookings', '/aggregates/assistant-usage',
      '/aggregates/inbox-ai-usage', '/aggregates/fleet',
    ]) {
      const route = routes.find(r => r.method === 'GET' && r.path === path);
      expect(route, path).toBeDefined();
      expect(configs.get(`GET ${path}`)?.dynamicPermission, path).toBe(true);
      expect(reachesText(route!.handlerText, text => /auth\.operatorId/.test(text), functions), path).toBe(true);
      expect(reachesText(route!.handlerText, text => /req\.effectivePermissions\s*\(/.test(text), functions), path).toBe(true);
    }
  });
});

describe('Staff summary selected park (SCRUM-634)', () => {
  it('declares dynamic authority and reaches owned operator metadata before any app read', () => {
    const route = routes.find(r => r.method === 'GET' && r.path === '/staff/summary');
    expect(route).toBeDefined();
    expect(configs.get('GET /staff/summary')?.dynamicPermission).toBe(true);
    expect(reachesText(route!.handlerText, text => /auth\.operatorId/.test(text), functions)).toBe(true);
  });
});

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

/**
 * SCRUM-606 — a setting the whole operator shares is changed at OPERATOR
 * scope. These routes used to declare no target, so the guard fell back to the
 * session's branch, and a manager's grant at one park passed for a tier, a
 * tender or a menu category every park uses. `target: { operator: true }`
 * makes the plugin ask with no branch at all and `grantCovers` accept only an
 * operator-scoped grant. The reads beside them keep their gates.
 */
const OPERATOR_WIDE_WRITES = [
  'GET /assistant-settings',
  'HEAD /assistant-settings',
  'PUT /assistant-settings',
  'POST /tiers',
  'PATCH /tiers/:code',
  'DELETE /tiers/:code',
  'POST /payment-methods',
  'PATCH /payment-methods/:code',
  'POST /payment-methods/:code/move',
  'DELETE /payment-methods/:code',
  'POST /menu/categories',
  'PATCH /menu/categories/:id',
  'DELETE /menu/categories/:id',
  'POST /menu/modifier-groups',
  'PATCH /menu/modifier-groups/:id',
  'DELETE /menu/modifier-groups/:id',
  'POST /menu/discounts',
  'PATCH /menu/discounts/:id',
  'DELETE /menu/discounts/:id',
  'POST /voucher-definitions',
  'PATCH /voucher-definitions/:id',
  'DELETE /voucher-definitions/:id',
  'POST /voucher-definitions/:id/restore',
  'POST /booth-layouts',
  'PATCH /booth-layouts/:id',
  'POST /branches',
  'POST /branches/oto-app/reconcile',
  'PUT /benefits/templates/:role',
  'PUT /benefits/profiles/:employeeId',
  'PUT /me/session/operator', // SCRUM-640: service also requires a genuine null-scope switch assignment.
];
// These platform-global reads require their named permission at operator scope.
const PLATFORM_WIDE_READS = [
  'GET /console/apps', 'HEAD /console/apps',
  'GET /console/releases', 'HEAD /console/releases',
  'GET /console/releases/agents', 'HEAD /console/releases/agents',
  // SCRUM-643: the flag catalogue and the blast-radius preview read platform-global switches.
  'GET /console/flags', 'HEAD /console/flags',
  'GET /console/flags/preview', 'HEAD /console/flags/preview',
  'GET /platform/alerts', 'HEAD /platform/alerts',
  'GET /platform/jobs', 'HEAD /platform/jobs',
  'GET /platform/environment', 'HEAD /platform/environment',
];

// SCRUM-643: platform-global suite controls — the permission at operator scope AND the
// platform-wide guard (null-scope grant, re-checked against the system role in the service).
const PLATFORM_WIDE_WRITES = [
  'PUT /console/apps/:key/maintenance',
  'POST /console/apps/:key/maintenance/clear',
  'POST /console/flags/approvals',
  'POST /console/flags/approvals/:id/approve',
  'POST /console/flags/approvals/:id/apply',
  'POST /console/deploy-events',
];

describe('operator-wide settings are changed at operator scope (SCRUM-606)', () => {
  it('lifecycle scope comes from the credential and immutable owned identity event (SCRUM-633)', () => {
    const key = 'POST /admin/apps/oto_app/lifecycle-deactivations';
    const route = routes.find(r => `${r.method} ${r.path}` === key);
    expect(configs.get(key)?.credential).toBe('otoapp-provision');
    expect(route).toBeDefined();
    expect(route!.handlerText).toContain('otoAppProvisionerOf(req)');
    expect(route!.handlerText).toContain('operatorId, eventId: req.body.eventId');
    expect(reachesText(route!.handlerText, text => /otoAppLifecycleUserIsOperators\s*\(/.test(text), functions, 2)).toBe(true);
  });

  it('new Teams and routing writes resolve old/new row targets before replay instead of a seated-park default (SCRUM-626)', () => {
    const managed = routes.filter(r => /^\/inbox\/(teams|routing-rules)(\/|$)/.test(r.path)
      && ['POST', 'PATCH', 'DELETE'].includes(r.method));
    expect(managed).toHaveLength(6);
    for (const route of managed) {
      expect(configs.get(`${route.method} ${route.path}`)?.dynamicPermission).toBe(true);
      expect(route.optionsText, route.path).toContain('preValidation');
      expect(route.optionsText, route.path).toContain('authorizeBeforeReplay');
      expect(establishesOwnership(route.handlerText), route.path).toBe(true);
    }
  });

  it('every operator-wide write declares the operator target, and nothing else', () => {
    const wrong = OPERATOR_WIDE_WRITES.filter((key) => {
      const config = configs.get(key);
      return !config?.permission || JSON.stringify(config.target) !== JSON.stringify({ operator: true });
    });
    expect(wrong, 'expected `target: { operator: true }` and a named permission').toEqual([]);
  });

  it('the operator target is only on these routes, so adding one is a decision', () => {
    const declared = app.routeRegistry
      .filter((r) => r.config.target?.operator === true)
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(declared).toEqual([...OPERATOR_WIDE_WRITES, ...PLATFORM_WIDE_READS, ...PLATFORM_WIDE_WRITES].sort());
  });

  it('every platform-global suite control write is platform-wide with a named permission at operator scope (SCRUM-643)', () => {
    const wrong = PLATFORM_WIDE_WRITES.filter((key) => {
      const config = configs.get(key);
      return !config?.permission || config.platformWide !== true || JSON.stringify(config.target) !== JSON.stringify({ operator: true });
    });
    expect(wrong).toEqual([]);
    // The two catalogue-dependent writes name their permission per key, and are platform-wide too.
    for (const key of ['PUT /console/flags', 'POST /console/flags/clear']) {
      expect(configs.get(key)?.dynamicPermission, key).toBe(true);
      expect(configs.get(key)?.platformWide, key).toBe(true);
    }
  });

  it('the reads beside them keep their gates', () => {
    for (const key of ['GET /tiers', 'GET /payment-methods', 'GET /menu/discounts', 'GET /voucher-definitions', 'GET /booth-layouts', 'GET /branches']) {
      const config = configs.get(key);
      expect(config?.permission, key).toBeTruthy();
      expect(config?.target, key).toBeUndefined();
    }
  });

  it('a voucher’s product at one park is checked at that park', () => {
    expect(configs.get('PUT /voucher-definitions/:id/park-products/:branchId')?.target).toEqual({
      branchId: 'params.branchId',
    });
  });

  it('a menu item is changed at the branch in its path, and loaded against it', () => {
    for (const key of ['PATCH /branches/:branchId/menu/products/:id', 'DELETE /branches/:branchId/menu/products/:id']) {
      expect(configs.get(key)?.target, key).toEqual({ branchId: 'params.branchId' });
      const route = routes.find((r) => `${r.method} ${r.path}` === key);
      expect(route?.handlerText, key).toContain('loadMenuItem(app.db, auth.operatorId, req.params.id, req.params.branchId)');
    }
  });
});

describe('by-id routes (SCRUM-290)', () => {
  it('benefit credential actions resolve the owned employee park and require operator reach when unassigned (SCRUM-624)', () => {
    for (const key of ['POST /benefits/credentials', 'GET /benefits/credentials/:credentialId/qr', 'POST /benefits/credentials/:credentialId/revoke']) {
      expect(configs.get(key)?.dynamicPermission, key).toBe(true);
      expect(configs.get(key)?.permission, key).toBeUndefined();
      const route = routes.find((r) => `${r.method} ${r.path}` === key);
      expect(route?.handlerText, key).toContain("requirePermission('admin:benefit:credential_issue'");
      expect(route?.handlerText, key).toContain('branchId: person.branchId');
      expect(route?.handlerText, key).toContain('operatorOnly: true');
      expect(establishesOwnership(route!.handlerText), key).toBe(true);
    }
  });

  it('Roles reads carry the operator into the catalogue, holder lookup and preview (SCRUM-612)', () => {
    for (const path of ['/roles', '/roles/holders', '/roles/preview']) {
      const route = routes.find((r) => r.method === 'GET' && r.path === path);
      expect(route, path).toBeDefined();
      expect(establishesOwnership(route!.handlerText), path).toBe(true);
    }
    const preview = routes.find((r) => r.method === 'GET' && r.path === '/roles/preview');
    expect(preview!.handlerText).toContain("requirePermission('admin:role:assign')");
  });

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
