// SCRUM-629: actual registered middleware with local storage and transport doubles.
// No database, HTTP listener, credential file or external service is used.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { build } from "esbuild";
import ts from "typescript";
import { PLATFORM_SESSION_COOKIE } from "../server/lib/platformSession";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const accountId = "01900000-0000-7000-8000-000000000001";
const operatorId = "01900000-0000-7000-8000-000000000002";
const tenantId = "01900000-0000-7000-8000-000000000003";
const foreignId = "01900000-0000-7000-8000-000000000004";
const userId = "zz-test-629-advisor";
const branchId = "zz-test-629-park-a";
const context = { platformRolesEnabled: true, userId, operatorId, tenantId, role: "manager",
  permissions: { "hr:salary:view": false } };
const copy = <T>(value: T): T => structuredClone(value);
const legacyExchange = Symbol("legacy exchange without a mapping field");

function fixture() {
  const raw = { id: userId, platformUserId: accountId, role: "advisor", operatorId,
    isActive: true, fullName: "ZZ TEST advisor", email: "zz-test-629@example.invalid" };
  const access = [{ id: "zz-test-629-access", userId, tenantId, branchId, accessScope: "selected_branches" }];
  const effective = { ...raw, role: "staff", tenantId, branchAccess: access,
    hasAllBranchesAccess: false, allowedBranchIds: [branchId] };
  const operator = { id: operatorId, tenantId, status: "active", platformRolesEnabled: true };
  const branches = new Map([[branchId, { id: branchId, tenantId, operatorId }]]);
  const writes: unknown[] = [];
  const storage = {
    sessionStore: undefined,
    getUserByPlatformUserId: async (id: string) => id === accountId ? copy(raw) : undefined,
    getUser: async (id: string) => id === userId ? copy(raw) : undefined,
    getUserWithBranchAccess: async (id: string) => id === userId ? copy(effective) : undefined,
    getUserBranchAccess: async () => copy(access),
    getOperator: async (id: string) => id === operatorId ? copy(operator) : undefined,
    getBranch: async (id: string) => copy(branches.get(id)),
    updateUser: async (...args: unknown[]) => { writes.push(args); throw new Error("UNEXPECTED_APP_ROLE_WRITE"); },
  };
  return { raw, effective, access, operator, branches, writes, storage };
}

type Handler = (...args: any[]) => unknown;
function application() {
  const routes = new Map<string, Handler[]>(), middlewares: Handler[] = [];
  const app: any = { routes, middlewares, set() {} };
  for (const method of ["get", "post", "put", "patch", "delete"]) app[method] = (path: string, ...handlers: Handler[]) => routes.set(method + " " + path, handlers);
  app.use = (...handlers: Handler[]) => middlewares.push(...handlers);
  return app;
}
function response() {
  const value: any = { statusCode: 200, body: undefined };
  value.status = (code: number) => { value.statusCode = code; return value; };
  value.json = (body: unknown) => { value.body = body; return value; };
  value.sendStatus = (code: number) => { value.statusCode = code; return value; };
  return value;
}
function rawAdvisorGuard(storage: ReturnType<typeof fixture>["storage"]): Handler {
  const source = fs.readFileSync(appRoot + "server/routes.ts", "utf8");
  const tree = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true);
  const guards: ts.ArrowFunction[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "app.use") {
      for (const arg of node.arguments) {
        if (ts.isArrowFunction(arg) && arg.body.getText(tree).includes("const blockedPrefixes")) guards.push(arg);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(tree); assert.equal(guards.length, 1, "the actual advisor exclusion middleware is selected once");
  const code = ts.transpileModule("const guard = " + guards[0].getText(tree) + ";", {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function("storage", code + "\nreturn guard;")(storage);
}
async function moduleAt(entry: string, f: ReturnType<typeof fixture>, exchangeContext: unknown = context) {
  const passport: any = { initialize: () => (_q: unknown, _s: unknown, next: () => void) => next(),
    session: () => (_q: unknown, _s: unknown, next: () => void) => next(), use() {},
    serializeUser(fn: Handler) { passport.serializer = fn; }, deserializeUser(fn: Handler) { passport.deserializer = fn; } };
  const sandbox: any = { storage: f.storage, passport, logger: { info() {}, warn() {}, error() {} } };
  const virtual = new Map([
    ["storage", "module.exports.storage = globalThis.test629.storage;"],
    ["logger", "module.exports.log = () => globalThis.test629.logger;"],
    ["passport", "module.exports = globalThis.test629.passport;"],
    ["passport-local", "module.exports.Strategy = class Strategy {};"],
    ["express-session", "module.exports = () => (_q, _s, next) => next();"],
    ["twilio-service", "module.exports.normalizePhoneToE164 = value => value;"],
    ["config/env", "module.exports.TRUST_PROXY = 0;"],
  ]);
  const result = await build({ entryPoints: [appRoot + entry], absWorkingDir: appRoot, bundle: true, write: false,
    platform: "node", format: "cjs", target: "node22", logLevel: "silent", plugins: [{ name: "local-629-dependencies", setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        const name = [...virtual.keys()].find(key => args.path === key || args.path.endsWith("/" + key));
        return name ? { path: name, namespace: "test629" } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "test629" }, args => ({ contents: virtual.get(args.path)!, loader: "js" }));
    } }] });
  const output = { exports: {} as any };
  const env = { PLATFORM_API_URL: "https://platform.example.invalid", OTOAPP_PUBLIC_ORIGIN: "https://app.example.invalid", OTOAPP_LEGACY_LOGIN: "false" };
  const fetchLocal = async (url: string) => url.endsWith("/auth/handoff/exchange")
    ? new Response(JSON.stringify({ accountId, mustChangePassword: false, ...(exchangeContext === legacyExchange ? {} : { otoApp: exchangeContext }) }), {
      status: 200, headers: { "set-cookie": PLATFORM_SESSION_COOKIE + "=zz-test-local-only; Path=/; HttpOnly" } })
    : new Response(JSON.stringify({ preferences: null }), { status: 200 });
  const unrefInterval = (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const timer = setInterval(callback, delay, ...args); timer.unref(); return timer;
  };
  new Function("require", "module", "exports", "globalThis", "process", "fetch", "setInterval", result.outputFiles[0].text)(require, output, output.exports, { ...globalThis, test629: sandbox }, { env }, fetchLocal, unrefInterval);
  return { exports: output.exports, passport };
}
async function signOn(f: ReturnType<typeof fixture>, claim: unknown = context) {
  const { exports } = await moduleAt("server/middleware/platformSignOn.ts", f, claim), app = application();
  exports.registerPlatformSignOn(app);
  let loggedIn: any, nextError: unknown;
  const res = response();
  const req: any = { body: { token: "zz-test-local-handoff" }, protocol: "https", requestId: "zz-test-629",
    sessionID: "zz-test-before", session: {}, get: (name: string) => name === "host" ? "app.example.invalid" : undefined,
    login(user: unknown, done: (error?: Error) => void) { loggedIn = user; req.sessionID = "zz-test-after"; req.session = { save: (cb: () => void) => cb() }; done(); } };
  app.routes.get("post /api/auth/handoff")![0](req, res, (error: unknown) => { nextError = error; });
  for (let turn = 0; turn < 200 && res.body === undefined && nextError === undefined; turn++) await new Promise(resolve => setTimeout(resolve, 1));
  if (nextError) throw new Error("ACTUAL_HANDOFF_HANDLER_FAILED");
  assert.notEqual(res.body, undefined, "actual handoff handler completes");
  return { req, res, loggedIn };
}

let checks = 0;
async function check(name: string, action: () => unknown | Promise<unknown>) { await action(); checks++; console.log("PASS " + name); }

await check("flagged advisor uses platform effective role while raw marker and branch reach remain", async () => {
  const f = fixture(), result = await signOn(f);
  assert.equal(result.res.statusCode, 200); assert.equal(result.loggedIn?.role, "manager");
  assert.equal(f.raw.role, "advisor"); assert.equal(f.writes.length, 0);
  assert.deepEqual(result.loggedIn.allowedBranchIds, [branchId]); assert.equal(result.loggedIn.hasAllBranchesAccess, false);
  assert.deepEqual(result.req.session.platform.otoApp, context, "claim survives only after regenerated login");
  assert.equal(result.req.session.platform.otoApp.permissions["hr:salary:view"], false);
});
await check("absent claim retains today's login behavior", async () => {
  const f = fixture(), result = await signOn(f, legacyExchange);
  assert.equal(result.res.statusCode, 200); assert.equal(result.loggedIn.role, "advisor");
  assert.equal(result.req.session.platform.otoApp, undefined); assert.equal(f.writes.length, 0);
});
await check("inactive legal entity keeps the existing sign-in rule", async () => {
  const f = fixture(); f.operator.status = "archived";
  const result = await signOn(f); assert.equal(result.res.statusCode, 200);
  assert.equal(result.loggedIn?.role, "manager");
});
await check("malformed enabled claims and mismatched identity/entity/tenant refuse before login", async () => {
  for (const claim of [{ ...context, role: "global_admin" }, { ...context, userId: "zz-test-other" },
    { ...context, operatorId: foreignId }, { ...context, tenantId: foreignId },
    { ...context, permissions: { "hr:salary:view": "false" } }, { ...context, platformRolesEnabled: false }]) {
    const result = await signOn(fixture(), claim); assert.equal(result.loggedIn, undefined); assert.ok(result.res.statusCode >= 400);
  }
  for (const change of [(f: ReturnType<typeof fixture>) => { f.operator.platformRolesEnabled = false; },
    (f: ReturnType<typeof fixture>) => { f.branches.get(branchId)!.tenantId = foreignId; }]) {
    const f = fixture(); change(f); const result = await signOn(f); assert.equal(result.loggedIn, undefined); assert.ok(result.res.statusCode >= 400);
  }
});
await check("deserialization, userWithAccess middleware and api/user share the session effective role", async () => {
  const f = fixture(), { exports, passport } = await moduleAt("server/auth.ts", f), app = application(); exports.setupAuth(app);
  const req: any = { user: { id: userId }, isAuthenticated: () => true, session: { platform: { accountId, otoApp: copy(context) } } };
  const deserialized: any = await new Promise((resolve, reject) => {
    const done = (error: unknown, user: unknown) => error ? reject(error) : resolve(user);
    if (passport.deserializer.length === 3) passport.deserializer(req, userId, done); else passport.deserializer(userId, done);
  });
  assert.equal(deserialized.role, "manager");
  const middleware = (await moduleAt("server/auth-middleware.ts", f)).exports;
  await middleware.loadUserWithAccess(req, response(), (error?: unknown) => { if (error) throw error; });
  assert.equal(req.userWithAccess.role, "manager"); assert.deepEqual(req.userWithAccess.allowedBranchIds, [branchId]);
  const res = response(), userHandler = app.routes.get("get /api/user")!.at(-1)!; await userHandler(req, res);
  assert.equal(res.body.role, "manager"); assert.equal(res.body.platformRoleMapping.permissions["hr:salary:view"], false);
  assert.equal(JSON.stringify(res.body).includes("sealedToken"), false);
  const guard = rawAdvisorGuard(f.storage);
  for (const salaryView of [false, true]) for (const original of [deserialized, req.userWithAccess, res.body]) {
    const user = { ...original, platformRoleMapping: { ...original.platformRoleMapping, permissions: { "hr:salary:view": salaryView } } };
    for (const path of ["/api/contracts", "/api/schedule", "/api/rota", "/api/payroll", "/api/auth/xero", "/api/finance"]) {
      const denied = response(); let nextCalled = false;
      await guard({ user, path }, denied, (error?: unknown) => { if (error) throw error; nextCalled = true; });
      assert.equal(denied.statusCode, 403, "raw advisor restriction remains after every reload: " + path);
      assert.equal(nextCalled, false);
    }
  }
  f.raw.role = "manager";
  const ordinary = response(); let ordinaryContinued = false;
  await guard({ user: req.userWithAccess, path: "/api/payroll" }, ordinary,
    (error?: unknown) => { if (error) throw error; ordinaryContinued = true; });
  assert.equal(ordinaryContinued, true, "ordinary mapped users retain their existing role gates");
});
console.log(JSON.stringify({ passed: true, checks, database: false, network: false }));
