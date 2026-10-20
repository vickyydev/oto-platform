/**
 * The seam walker (SCRUM-293): every call a front end makes to the platform
 * matches a route the api describes, and every route has a caller or a reason
 * not to — checked on every test run, so a drift fails the day it is written
 * rather than in front of someone at the till.
 *
 * Before this, the one seam a test pinned was a single route pair in
 * apps/api/test/sales.test.ts, written by hand, because no front end has a
 * test runner that could see both halves. This walks both: the front ends'
 * source (`seams.ts` says exactly what it reads as a call) and the api's own
 * OpenAPI description in `openapi.json`, which `pnpm api-types:check` holds to
 * what the api's route schemas actually declare.
 *
 * WHAT IT CHECKS, per call: the path reaches a route and the route answers
 * the call's method; each query parameter written in the path is one the
 * route reads; each key of an object-literal body is one the route's body
 * schema reads (zod strips an unknown key without a word, so a renamed field
 * is otherwise a value the server silently never sees); and a generated type
 * named at the call (`ApiResponse<'/x', 'get'>`) names the route the call
 * actually reaches. Per route: something calls it, a machine outside the
 * front ends does (named below), or it is in NOT_YET_CALLED. And the
 * hand-typed response types may not regrow (`migration-list.ts`).
 *
 * WHAT IT DOES NOT CHECK: the shape of a hand-typed response — that is what
 * moving a file onto `@oto/api-types` buys, and the typecheck then does it —
 * nor a body built in a variable rather than written at the call.
 *
 * **Hashed on what it reads.** `turbo.json` gives this package's `test` task
 * explicit inputs covering the front ends it walks, as `@oto/print#test` has,
 * so a change in apps/pos is a cache miss here and not a replayed pass.
 */
import { describe, expect, it } from 'vitest';
import { HAND_TYPED } from './migration-list';
import {
  bodyKeys,
  collectCalls,
  FRONT_ENDS,
  readFrontEnds,
  readRoutes,
  resolvePath,
  routeKey,
  trimSlash,
  type Call,
  type Route,
} from './seams';

const routes = readRoutes();
const files = readFrontEnds();
const calls = files.flatMap(collectCalls);

const where = (c: Call) => `${c.file}:${c.line} ${c.method} ${c.shown}`;

/** The routes a readable call reaches with its own method. */
function reached(c: Call): Route[] {
  return c.path ? resolvePath(c.path, routes).filter((r) => r.method === c.method) : [];
}

/**
 * Calls whose path the walker cannot read from the source, each with what
 * reaches the route instead. A new one fails until it is named here.
 */
const DYNAMIC = new Map<string, string>([
  [
    'apps/console/src/components/devices/PrintPanel.tsx GET printout.previewUrl',
    // GET /devices/{id}/printouts/{seq}/preview.png — the api mints the URL.
    'the printout preview the api names in its own answer',
  ],
]);

/**
 * Routes called by a machine rather than a screen, by path prefix. Each names
 * its caller; none of them is in a front end the walker reads.
 */
const MACHINE_CALLERS: Array<{ prefix: string; except?: string; caller: string }> = [
  {
    prefix: '/box/v1/',
    except: '/box/v1/station/',
    caller: 'the box agent (packages/box-agent), with its own credential',
  },
  // ABOVE the generic /webhooks/ entry: `find` takes the first match, and below
  // it this route would be filed under 2C2P (S2-19 I2d, plan §6).
  {
    prefix: '/webhooks/inbox/',
    caller: 'Meta (WhatsApp Cloud), or the inbox simulator in-process — signed by either',
  },
  { prefix: '/webhooks/', caller: 'the payment gateway (2C2P), signed by it' },
  {
    prefix: '/public/bookings/return',
    caller: "the payment gateway's redirect back to the booking site",
  },
  { prefix: '/health', caller: "the host's health check" },
  {
    prefix: '/admin/apps/oto_app/suite-sign-ins',
    caller:
      "the OTO App's server (SCRUM-539), with the operator-bound provision key whose digest the api holds",
  },
];

/**
 * Routes no front end calls today, each with why, dated. A route that gains a
 * caller fails until its line is removed, so the list stays the truth.
 */
const NOT_YET_CALLED = new Map<string, string>([
  // 2026-10-14, the walker's first run.
  [
    'GET /box/v1/station/{stationId}/channel',
    "the till's box lane opens it at the box's own origin, not /api",
  ],
  ['POST /settlements/batches/{batchId}/terminal-result', 'the box agent reports the terminal run'],
  ['POST /payments/attempts/{id}/result', 'the card terminal round trip, not a screen'],
  [
    'GET /devices/{id}/printouts/{seq}/preview.png',
    'reached through DYNAMIC: the URL the api returns',
  ],
  ['POST /boxes/{id}/simulate', 'the virtual box simulator, driven from tests and the dev harness'],
  ['POST /stations/{id}/scan/simulate', 'the virtual box simulator'],
  ['POST /stations/{id}/button', 'the virtual box simulator'],
  ['GET /stations/{id}/session', 'the till reaches the station session through the box bridge'],
  ['POST /stations/{id}/lease', 'the till reaches the station session through the box bridge'],
  [
    'POST /stations/{id}/lease/renew',
    'the till reaches the station session through the box bridge',
  ],
  [
    'POST /stations/{id}/lease/release',
    'the till reaches the station session through the box bridge',
  ],
  ['POST /stations/{id}/intents', 'the till reaches the station session through the box bridge'],
  ['PATCH /me', 'no screen edits the signed-in account yet'],
  ['GET /visits/{id}', 'no screen reads a visit back yet'],
  ['POST /sales/{id}/benefit/preview', 'the benefit preview rides the cart quote instead'],
  ['GET /branches/{branchId}/tax-overrides', 'no tax override screen yet'],
  ['POST /branches/{branchId}/tax-overrides', 'no tax override screen yet'],
  ['GET /branches/{branchId}/tax-resolve', 'no screen asks the tax resolver directly'],
  ['GET /product-categories', 'no screen reads the operator category list yet'],
  ['GET /branches/{branchId}/stock/movements', 'no stock movement screen yet'],
  ['GET /branches/{branchId}/print-jobs', 'no print job list screen yet'],
  ['POST /print-jobs/{id}/reprint', 'no reprint-a-job screen yet'],
  ['PUT /booths/{id}/prize-order', 'the Console reorders prizes some other way today'],
  ['POST /booth-layouts', 'the Console reads booth layouts but does not create one yet'],
  ['PATCH /booth-layouts/{id}', 'the Console reads booth layouts but does not edit one yet'],
  ['GET /benefits/profiles/{employeeId}/effective', 'no screen reads one effective profile yet'],
  ['GET /checkin/registrations/{id}', 'no screen reads one registration back yet'],
  ['GET /events/{id}', 'the event screens read the list, not one event'],
  ['GET /events/{id}/roster', 'no roster screen yet'],
  ['GET /analytics/sources', 'no analytics source screen yet'],
  ['PUT /analytics/sources/{branchId}', 'no analytics source screen yet'],
  ['GET /analytics/reports/benefits', 'no benefits report screen yet'],
  ['GET /analytics/reports/benefits/transactions', 'no benefits report screen yet'],
  // 2026-10-20, S2-19 I2g (SCRUM-586): the PDPA erasure lands before its
  // screen. The erasure console (an Inbox or Console settings page, with the
  // 409 preview as its second confirmation) comes later and deletes this.
  ['POST /inbox/contacts/{id}/erase', 'the erasure console lands after I3 (the api ships first, plan §3.6)'],
  // 2026-10-20, SCRUM-591 round I2: the internal assistant's api lands before
  // its screens. The launcher's ask panel, "My questions" and feedback (round
  // I3a) call the first four and delete those lines; the reviewer's view is
  // the Console's, after I3a.
  ['POST /assistant/asks', "the launcher's ask panel lands in round I3a (the api ships first, plan §F.1)"],
  ['GET /assistant/asks', "the launcher's \"My questions\" lands in round I3a"],
  ['GET /assistant/asks/{id}', "the launcher's \"My questions\" lands in round I3a"],
  ['PATCH /assistant/asks/{id}/feedback', "the launcher's answer feedback lands in round I3a"],
  ['GET /assistant/review/asks', "the reviewers' view (a Console page) follows round I3a"],
]);

function machineCaller(path: string): string | null {
  const hit = MACHINE_CALLERS.find(
    (m) => path.startsWith(m.prefix) && !(m.except && path.startsWith(m.except)),
  );
  return hit?.caller ?? null;
}

describe('every front-end call reaches a route the api describes (SCRUM-293)', () => {
  it('finds what it is meant to check', () => {
    // A move or rename must not turn this into a walk over nothing.
    expect(routes.length).toBeGreaterThan(300);
    expect(calls.length).toBeGreaterThan(300);
    for (const root of FRONT_ENDS) {
      expect(
        calls.some((c) => c.file.startsWith(`${root}/`)),
        root,
      ).toBe(true);
    }
    expect(calls.some((c) => c.file === 'apps/pos/src/api/members.ts')).toBe(true);
  });

  it('reads every call path, or names it in DYNAMIC', () => {
    const unread = calls
      .filter((c) => c.path === null)
      .map((c) => `${c.file} ${c.method} ${c.shown}`);
    expect(unread.filter((key) => !DYNAMIC.has(key))).toEqual([]);
    expect([...DYNAMIC.keys()].filter((key) => !unread.includes(key))).toEqual([]);
  });

  it('reaches a route that answers the call’s method', () => {
    const lost = calls
      .filter((c) => c.path !== null && reached(c).length === 0)
      .map((c) => {
        const there = resolvePath(c.path!, routes).map((r) => r.method);
        return there.length > 0
          ? `${where(c)} — the route answers ${[...new Set(there)].join(', ')} only`
          : `${where(c)} — no route on the api has this path`;
      });
    expect(lost).toEqual([]);
  });

  it('writes only query parameters the route reads', () => {
    const unread = calls.flatMap((c) =>
      reached(c).flatMap((r) =>
        c.query
          .filter((q) => !r.query.has(q))
          .map((q) => `${where(c)} — ${r.path} reads no "${q}"`),
      ),
    );
    expect(unread).toEqual([]);
  });

  it('sends only body fields the route reads', () => {
    const dropped = calls.flatMap((c) =>
      c.bodyKeys === null || c.bodyKeys.length === 0
        ? []
        : reached(c).flatMap((r) => {
            if (!r.body)
              return [`${where(c)} — ${r.path} reads no body, sent ${c.bodyKeys!.join(', ')}`];
            const keys = bodyKeys(r.body);
            return keys === null
              ? []
              : c
                  .bodyKeys!.filter((k) => !keys.has(k))
                  .map((k) => `${where(c)} — ${r.path} does not read "${k}"; the server drops it`);
          }),
    );
    expect(dropped).toEqual([]);
  });

  it('names, in a generated type, the route the call reaches', () => {
    const wrong = calls.flatMap((c) =>
      c.generated.flatMap((g) => {
        const target = reached(c);
        const named = `${g.method.toUpperCase()} ${trimSlash(g.path)}`;
        if (!target.some((r) => routeKey(r) === named)) {
          return [
            `${where(c)} — ${g.helper} names ${named}, the call reaches ${target.map(routeKey).join(', ') || 'nothing'}`,
          ];
        }
        if (g.helper === 'ApiResponse' && !target.some((r) => r.describedResponse)) {
          return [`${where(c)} — ${named} declares no response schema, so ApiResponse is unknown`];
        }
        return [];
      }),
    );
    expect(wrong).toEqual([]);
  });

  it('leaves no route without a caller, a machine caller or a NOT_YET_CALLED reason', () => {
    const called = new Set(calls.flatMap((c) => reached(c).map(routeKey)));
    const orphans = routes
      .filter((r) => !called.has(routeKey(r)) && !machineCaller(r.path))
      .map(routeKey);
    expect(orphans.filter((key) => !NOT_YET_CALLED.has(key))).toEqual([]);
    // A line for a route that now has a caller, or no longer exists, is stale.
    expect([...NOT_YET_CALLED.keys()].filter((key) => !orphans.includes(key))).toEqual([]);
  });

  it('does not let hand-typed response types regrow (migration-list.ts)', () => {
    const counts: Record<string, number> = {};
    for (const c of calls) if (c.handTyped) counts[c.file] = (counts[c.file] ?? 0) + 1;
    const moved = Object.keys({ ...counts, ...HAND_TYPED })
      .sort()
      .filter((file) => (counts[file] ?? 0) !== (HAND_TYPED[file] ?? 0))
      .map((file) => {
        const now = counts[file] ?? 0;
        const listed = HAND_TYPED[file] ?? 0;
        return now > listed
          ? `${file}: ${now} hand-typed, ${listed} allowed — type the new call from @oto/api-types`
          : `${file}: ${now} hand-typed, list says ${listed} — lower its number in migration-list.ts`;
      });
    expect(moved).toEqual([]);
  });
});
