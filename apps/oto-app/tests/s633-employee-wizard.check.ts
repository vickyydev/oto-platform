// Execute the native wizard closures with its real app mutation cache. Only
// captured loopback-free answers are used; this check never provisions an account.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { MutationObserver, QueryClient } from "@tanstack/query-core";
import { ApiError, queryClient as appQueryClient } from "../client/src/lib/queryClient";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const lock = JSON.parse(readFileSync(join(APP, "package-lock.json"), "utf8"));
for (const name of ["@tanstack/query-core", "typescript"]) {
  const actual = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")).version;
  assert.equal(actual, lock.packages[`node_modules/${name}`].version, "Runtime dependency must match this app's lockfile");
  console.log(`Runtime ${name} ${actual}`);
}
const source = readFileSync(join(APP, "client/src/pages/employee-editor-page.tsx"), "utf8");
const ast = ts.createSourceFile("employee-editor-page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const visit = (predicate: (node: ts.Node) => boolean): ts.Node => {
  let found: ts.Node | undefined;
  const walk = (node: ts.Node) => { if (found) return; if (predicate(node)) found = node; else ts.forEachChild(node, walk); };
  walk(ast); assert.ok(found, "Native wizard AST node must exist"); return found;
};
function variable(name: string): ts.Expression {
  const node = visit(node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) as ts.VariableDeclaration;
  assert.ok(node.initializer); return node.initializer;
}
const mutation = variable("enableLoginMutation") as ts.CallExpression;
assert.ok(ts.isCallExpression(mutation) && ts.isObjectLiteralExpression(mutation.arguments[0]));
const properties = (mutation.arguments[0] as ts.ObjectLiteralExpression).properties;
function mutationProperty(name: string): ts.Expression {
  const node = properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(ast) === name);
  assert.ok(node && ts.isPropertyAssignment(node), "Native mutation callback must exist"); return node.initializer;
}
function execute(expression: ts.Expression, scope: Record<string, unknown>): any {
  const compiled = ts.transpileModule(`(${expression.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.trim().replace(/;$/, "");
  return new Function(...Object.keys(scope), `return ${compiled}`)(...Object.values(scope));
}
const phoneInput = visit(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "Input"
  && node.attributes.properties.some(property => ts.isJsxAttribute(property) && property.name.getText(ast) === "data-testid"
    && property.initializer && ts.isStringLiteral(property.initializer) && property.initializer.text === "input-employee-suite-phone")) as ts.JsxSelfClosingElement;
const disabled = phoneInput.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(ast) === "disabled") as ts.JsxAttribute;
assert.ok(disabled.initializer && ts.isJsxExpression(disabled.initializer) && disabled.initializer.expression);
const disabledExpression = disabled.initializer.expression;
const CANARY = "ZZ TEST 633 DISPLAY ONLY CANARY";
const hasSecret = (value: unknown) => JSON.stringify(value)?.includes(CANARY) === true;
let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "check failed"}`); }
}

function harness(legacyOff = true) {
  const client = new QueryClient({ defaultOptions: appQueryClient.getDefaultOptions() });
  const lifetime = { current: { mounted: true, generation: 1, employeeId: "zz-test-633-employee" } };
  let display: unknown = null, lateAssignment = false, visiblePhone = "0816334001", frozen: unknown = null;
  let release!: (value: Response) => void, reject!: (error: Error) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const response = new Promise<Response>((resolve, fail) => { release = resolve; reject = fail; });
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const observerBinding = { get isPending() { return observer.getCurrentResult().isPending; }, reset: () => observer.reset() };
  const scope: Record<string, unknown> = {
    legacyOff, suiteRetry: null, suitePhone: visiblePhone, suiteActionId: "63300000-0000-4000-8000-000000000001",
    suiteLifetime: lifetime, employeeId: lifetime.current.employeeId, employee: { branchId: "zz-test-633-branch", email: "zz-test@example.invalid" },
    enableLoginModalOpen: true, loginEmail: "zz-test@example.invalid", tempPassword: "ZZ TEST LEGACY ONLY",
    accessLevel: "STAFF", enableCoreModule: true, enableHrModule: false, enableStudioModule: false,
    enableEventsModule: false, enableOpsModule: false, enableSetupModule: false, branchScope: "SELECTED",
    queryClient: client, refetch: () => undefined, toast: () => undefined, ApiError,
    enableLoginMutation: observerBinding,
    setSuiteAnswer: (value: unknown) => {
      if (!lifetime.current.mounted) lateAssignment ||= hasSecret(value);
      else display = value;
    },
    setSuiteRetry: (value: unknown) => { frozen = value; },
    setSuitePhone: (value: string) => { visiblePhone = value; },
    apiRequest: async (method: string, path: string, body: Record<string, unknown>) => { calls.push({ method, path, body }); markStarted(); return response; },
  };
  for (const name of ["setWizardStep", "setTempPassword", "setAccessLevel", "setEnableCoreModule", "setEnableHrModule",
    "setEnableStudioModule", "setEnableEventsModule", "setEnableOpsModule", "setEnableSetupModule", "setBranchScope",
    "setLoginEmail", "setSuiteActionId", "setEnableLoginModalOpen"]) scope[name] = () => undefined;
  const mutationFn = execute(mutationProperty("mutationFn"), scope);
  const onSuccess = execute(mutationProperty("onSuccess"), scope);
  const observer = new MutationObserver(client, { mutationFn, onSuccess, retry: false });
  const unsubscribe = observer.subscribe(() => undefined);
  scope.resetWizard = execute(variable("resetWizard"), scope);
  const close = execute(variable("closeEnableLoginModal"), scope) as () => void;
  const reply = () => release(new Response(JSON.stringify({ success: true, phone: "+66816334001",
    temporaryPassword: CANARY, replayed: false, platformManaged: false, accountId: "zz-test-core" }),
  { headers: { "content-type": "application/json" } }));
  return { client, scope, lifetime, calls, observer, reply, reject, close, started,
    display: () => display, lateAssignment: () => lateAssignment, phone: () => visiblePhone, frozen: () => frozen,
    editPhone: (value: string) => { visiblePhone = value; },
    cachedSecret: () => client.getMutationCache().getAll().some(entry => hasSecret(entry.state.data)),
    cleanup: () => { unsubscribe(); for (const entry of client.getMutationCache().getAll()) entry.destroy(); client.clear(); },
  };
}

await check("successful launcher reply keeps the one-time password in mounted display state, never mutation cache", async () => {
  const h = harness(); try {
    const pending = h.observer.mutate(); h.reply(); await pending;
    assert.equal(hasSecret(h.display()), true, "Current wizard must display the one-time answer");
    assert.equal(h.cachedSecret(), false, "Plaintext password must never enter shared mutation data");
  } finally { h.cleanup(); }
});
await check("closing the actual wizard clears display and leaves no password cached", async () => {
  const h = harness(); try {
    const pending = h.observer.mutate(); h.reply(); await pending; h.close();
    assert.equal(hasSecret(h.display()), false, "Close must clear the display");
    assert.equal(h.cachedSecret(), false, "Observer reset alone must not leave a secret in cache");
  } finally { h.cleanup(); }
});
await check("unmount before acknowledgement neither assigns nor caches a late password", async () => {
  const h = harness(); try {
    const pending = h.observer.mutate(); await h.started; h.lifetime.current.mounted = false; h.lifetime.current.generation++; h.reply(); await pending;
    assert.equal(h.lateAssignment(), false, "Unmounted wizard must discard a late secret before assigning state");
    assert.equal(h.cachedSecret(), false, "Late result must contain only safe cache metadata");
  } finally { h.cleanup(); }
});
await check("a stale wizard generation cannot display or cache an earlier answer", async () => {
  const h = harness(); try {
    const pending = h.observer.mutate(); await h.started; h.lifetime.current.generation++; h.reply(); await pending;
    assert.equal(hasSecret(h.display()), false, "Old generation must not write the current display");
    assert.equal(h.cachedSecret(), false, "Stale result must be sanitized too");
  } finally { h.cleanup(); }
});
await check("the actual phone JSX disables input during its first in-flight request", () => {
  assert.equal(execute(disabledExpression, { suiteRetry: null, enableLoginMutation: { isPending: true } }), true);
});
await check("the actual phone JSX remains editable before submission and disabled for a frozen retry", () => {
  assert.equal(execute(disabledExpression, { suiteRetry: null, enableLoginMutation: { isPending: false } }), false);
  assert.equal(execute(disabledExpression, { suiteRetry: {}, enableLoginMutation: { isPending: false } }), true);
});
await check("uncertain callback restores visible phone from the exact frozen request", async () => {
  const h = harness(); try {
    const pending = h.observer.mutate(); await h.started; h.editPhone("0816334999");
    h.reject(new ApiError("Captured uncertain platform answer", 502)); await pending.catch(() => undefined);
    const frozen = h.frozen() as Record<string, unknown>;
    assert.equal(!!frozen, true); assert.equal(frozen.phone === h.calls[0].body.phone, true);
    assert.equal(h.phone() === frozen.phone, true, "Retry field must describe the phone actually sent");
  } finally { h.cleanup(); }
});
await check("the actual mutation reuses a frozen body and action despite edited wizard fields", async () => {
  const h = harness(); try {
    const frozen = { actionId: "63300000-0000-4000-8000-000000000002", phone: "0816334002", email: "zz-frozen@example.invalid" };
    h.scope.suiteRetry = frozen;
    const fn = execute(mutationProperty("mutationFn"), h.scope);
    const pending = fn(); h.reply(); await pending;
    assert.equal(h.calls[0].body === frozen, true); assert.equal(h.calls[0].body.phone === frozen.phone, true);
  } finally { h.cleanup(); }
});
await check("legacy mode retains its local-password request without platform action or phone fields", async () => {
  const h = harness(false); try {
    const pending = h.observer.mutate(); h.reply(); await pending;
    assert.equal(typeof h.calls[0].body.password === "string", true);
    assert.equal("actionId" in h.calls[0].body, false); assert.equal("phone" in h.calls[0].body, false);
  } finally { h.cleanup(); }
});
console.log(`Source SHA256 ${createHash("sha256").update(source).digest("hex")}`);
console.log(`s633-employee-wizard.check: ${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
