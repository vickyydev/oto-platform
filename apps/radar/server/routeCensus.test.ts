import assert from "node:assert/strict";
import test from "node:test";

/**
 * The route census (S2-18): every route Radar registers is classified exactly
 * once — public, key-protected or guarded — and nothing is listed that is not
 * registered. A new route that nobody classified fails here (and is refused at
 * runtime by the guard regardless).
 *
 * Builds the app without listening or touching the database: the pool only
 * connects on a first query, which no registration makes.
 */
process.env.DATABASE_URL ??= "postgres://census:census@127.0.0.1:1/census";

type Layer = { route?: { path: string | string[]; methods: Record<string, boolean> } };

test("every registered route is classified exactly once", async () => {
  const { buildApp } = await import("./app");
  const { PUBLIC_ROUTES, KEY_ROUTES, GUARDED_ROUTES, isOpenRoute } = await import("./routeCensus");
  const { app } = await buildApp();

  const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
  const registered = new Set<string>();
  for (const layer of stack) {
    if (!layer.route) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const path of paths) {
      for (const [method, on] of Object.entries(layer.route.methods)) {
        if (on && method !== "_all") registered.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }

  const listed = [...PUBLIC_ROUTES, ...KEY_ROUTES, ...GUARDED_ROUTES] as string[];
  const seen = new Map<string, number>();
  for (const entry of listed) seen.set(entry, (seen.get(entry) ?? 0) + 1);
  const twice = [...seen].filter(([, n]) => n > 1).map(([e]) => e);
  assert.deepEqual(twice, [], "a route is listed in more than one class");

  const unclassified = [...registered].filter((r) => !seen.has(r)).sort();
  assert.deepEqual(unclassified, [], "registered routes nobody classified");

  const stale = listed.filter((r) => !registered.has(r)).sort();
  assert.deepEqual(stale, [], "classified routes that are not registered");

  // The guard's matcher agrees with the lists: a guarded route is never open.
  for (const entry of GUARDED_ROUTES as readonly string[]) {
    const [method, path] = entry.split(" ");
    const concrete = path.replace(/:[^/]+/g, "x");
    assert.equal(isOpenRoute(method, concrete), false, `${entry} would pass the guard unsigned`);
  }
  for (const entry of [...PUBLIC_ROUTES, ...KEY_ROUTES] as string[]) {
    const [method, path] = entry.split(" ");
    assert.equal(isOpenRoute(method, path.replace(/:[^/]+/g, "x")), true, `${entry} is not open`);
  }

  console.log(
    `census: ${PUBLIC_ROUTES.length} public, ${KEY_ROUTES.length} key-protected, ${GUARDED_ROUTES.length} guarded (${registered.size} registered)`,
  );
});

test("an unclassified /api path is guarded, not open", async () => {
  const { isOpenRoute } = await import("./routeCensus");
  assert.equal(isOpenRoute("GET", "/api/anything-new"), false);
  assert.equal(isOpenRoute("POST", "/api/public/campaigns/abc/qr"), true);
  assert.equal(isOpenRoute("GET", "/api/public/campaigns/abc/qr"), false);
});
