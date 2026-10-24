// SCRUM-632: real native pages and React/query/Radix behavior; every HTTP reply
// is local synthetic data. No database, credential, platform provisioning or SMS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { buildSync } from "esbuild";

const app = fileURLToPath(new URL("../", import.meta.url));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/users", pretendToBeVisual: true });
const g = globalThis as Record<string, any>;
// Native toast/query retention timers still run normally during assertions;
// dispose them when this standalone test has unmounted every native page.
const testTimers = new Set<ReturnType<typeof setTimeout>>();
const nativeSetTimeout = globalThis.setTimeout;
g.setTimeout = (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
  const timer = nativeSetTimeout(() => { testTimers.delete(timer); callback(...args); }, delay);
  testTimers.add(timer);
  return timer;
};
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Node", "Element", "Event", "CustomEvent", "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "DocumentFragment", "NodeFilter", "HTMLAnchorElement", "SVGElement", "location", "history"]) {
  try { g[key] = (dom.window as any)[key]; } catch { /* Node exposes a read-only navigator. */ }
}
for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) g[key] = (dom.window as any)[key].bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
g.ResizeObserver = (dom.window as any).ResizeObserver = ResizeObserverStub;
class PointerEventStub extends dom.window.MouseEvent {
  pointerId = 1;
  pointerType = "mouse";
  isPrimary = true;
}
g.PointerEvent = (dom.window as any).PointerEvent = PointerEventStub;
Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {}, hasPointerCapture() { return false; }, setPointerCapture() {}, releasePointerCapture() {} });
(dom.window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
// Native pages depend on Vite's build-time env. Compile the actual modules in
// memory with only that build define; providers and pages share one real graph.
const built = buildSync({
  absWorkingDir: app, bundle: true, platform: "node", format: "cjs", packages: "external", write: false,
  tsconfig: app + "tests/tsconfig.jsx.json", define: { "import.meta.env": "{}" }, logLevel: "silent",
  stdin: { resolveDir: app, loader: "tsx", contents: `
    export * as React from 'react'; export { act } from 'react';
    export { createRoot } from 'react-dom/client';
    export { QueryClientProvider } from '@tanstack/react-query';
    export { Router } from 'wouter';
    export { AuthContext } from './client/src/hooks/use-auth';
    export { queryClient } from './client/src/lib/queryClient';
    export { Toaster } from './client/src/components/ui/toaster';
    export { default as Users } from './client/src/pages/users-page';
    export { default as Permissions } from './client/src/pages/permissions-page';
    export { default as Operators } from './client/src/pages/operators-page';
  ` },
});
const require = createRequire(new URL("../package.json", import.meta.url));
const compiled = new Module(app + "tests/admin-managed-ui.native.cjs") as any;
compiled.filename = app + "tests/admin-managed-ui.native.cjs";
compiled.paths = require.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, Router, AuthContext, queryClient, Toaster, Users, Permissions, Operators } = compiled.exports;
const realLog = console.log;
console.log = (...args: unknown[]) => { if (!String(args[0]).startsWith("[auth-diag]")) realLog(...args); };

const sourcePaths = ["pages/users-page.tsx", "pages/permissions-page.tsx", "pages/operators-page.tsx", "hooks/use-admin-management.ts", "components/managed-in-admin-notice.tsx", "components/suite-sign-in.tsx"];
const hashes = Object.fromEntries(sourcePaths.map(path => [path, createHash("sha256").update(readFileSync(app + "client/src/" + path)).digest("hex")]));
const ENTITY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CREATED = "33333333-3333-4333-8333-333333333333";
const TENANT = "44444444-4444-4444-8444-444444444444";
const user = (id = "zz-user", managedInAdmin: any = false, operatorId: string | null = null) => ({
  id, fullName: "ZZ TEST " + id, email: id + "@example.invalid", role: "admin", isActive: true,
  operatorId, managedInAdmin, hasAllBranchesAccess: false, allowedBranchIds: [], branchAccess: [],
  platformUserId: null, phoneNumber: null, phoneE164: null, lastLoginAt: null,
});
const operator = (id = ENTITY) => ({ id, tenantId: TENANT, name: "ZZ TEST " + id, status: "active", platformRolesEnabled: false });
const person = (id: string, managedInAdmin: any = false, policy = true, departmentName = "Writable") => ({
  personId: id, fullName: "ZZ TEST " + id, preferredName: null, nickname: null, email: id + "@example.invalid",
  personType: "EMPLOYEE", userId: "zz-user", userRole: "staff", branchId: "zz-branch", branchName: "ZZ TEST branch",
  departmentId: "zz-department", departmentName, managedInAdmin, moduleOverrides: [],
  accessPolicy: policy ? { id: "zz-policy-" + id, accessLevel: "STAFF", modules: { core: true, hr: false, events: true, ops: true, setup: false }, branchScope: "SELECTED", branchIds: ["zz-branch"], source: "policy" } : null,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
type Write = { method: string; path: string; body: any };
type Fixture = {
  actor: any; actorManaged: any; users: any[]; operators: any[]; branches: any[]; people: any[];
  assignedUsers: any[]; writes: Write[]; reads: string[];
  respond?: (method: string, path: string, body: any) => Response | Promise<Response> | undefined;
};
let fixture: Fixture;
let root: any;
let host: HTMLDivElement;
let activePage: any;
const fixtureFor = (): Fixture => ({ actor: { ...user("actor-a"), tenantId: TENANT }, actorManaged: false,
  users: [user()], operators: [operator()], branches: [{ id: "zz-branch", name: "ZZ TEST branch", operatorId: null }],
  people: [person("zz-person")], assignedUsers: [], writes: [], reads: [] });
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://localhost");
  assert.equal(url.origin, "http://localhost", "LOCAL_HTTP_ONLY");
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const path = url.pathname;
  if (method !== "GET") fixture.writes.push({ method, path, body }); else fixture.reads.push(path);
  const supplied = fixture.respond?.(method, path, body);
  if (supplied !== undefined) return supplied;
  if (method !== "GET") return json({ ok: true });
  if (path === "/api/permissions/me") return json({ managedInAdmin: fixture.actorManaged, modules: [], appModes: [], role: "admin" });
  if (path === "/api/user") return json(fixture.actor);
  if (path === "/api/users") return json(fixture.users);
  if (path === "/api/branches") return json(fixture.branches);
  if (path === "/api/admin/operators") return json(fixture.operators);
  if (path === "/api/permissions/bulk") return json(fixture.people);
  if (/^\/api\/admin\/operators\/[^/]+\/users$/.test(path)) return json(fixture.assignedUsers);
  if (/^\/api\/admin\/operators\/[^/]+\/branches$/.test(path)) return json([]);
  if (path === "/api/auth/sign-in-options") return json({ legacyLogin: true, launcherUrl: null });
  throw new Error("UNKNOWN_LOCAL_HTTP_PATH");
};
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise(yes => setTimeout(yes, 8)); }); };
const element = (id: string) => dom.window.document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => { const found = element(id); assert.ok(found, "NATIVE_CONTROL_REQUIRED:" + id); return found; };
const click = async (id: string) => { await act(async () => { required(id).click(); }); await settle(); };
const fill = async (id: string, value: string) => {
  const input = required(id) as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await settle();
};
const render = async () => {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(AuthContext.Provider, { value: { user: fixture.actor, isLoading: false, error: null } },
      React.createElement(Router, { ssrPath: "/" }, React.createElement(React.Fragment, null, React.createElement(activePage), React.createElement(Toaster)))))));
  await settle();
};
const mount = async (page: any) => {
  activePage = page; queryClient.clear(); host = dom.window.document.createElement("div"); dom.window.document.body.appendChild(host); root = createRoot(host); await render();
};
const refreshActor = async (managed: any) => { fixture.actorManaged = managed; await act(async () => { queryClient.setQueryData(["/api/permissions/me", "admin-management", fixture.actor.id], { managedInAdmin: managed, modules: [], appModes: [] }); }); await settle(); };
const filterEmployees = async () => { await fill("input-permissions-filter", "Employee"); await click("filter-suggestion-type-EMPLOYEE"); };
const openMenu = async (id = "zz-user") => {
  await act(async () => required("button-user-menu-" + id).dispatchEvent(new PointerEventStub("pointerdown", { bubbles: true, button: 0, ctrlKey: false })));
  await settle();
};
const cases: Record<string, { passed: boolean; failureKind?: string; phase?: string }> = {};
let phase = "setup";
async function check(name: string, action: () => Promise<void>) {
  fixture = fixtureFor(); phase = "mount";
  try { await action(); cases[name] = { passed: true }; }
  catch (error) { cases[name] = { passed: false, failureKind: error instanceof assert.AssertionError ? "ASSERTION" : "RUNTIME", phase }; }
  finally { if (root) { await act(async () => root.unmount()); root = null; } host?.remove(); queryClient.clear(); await settle(1); }
}

await check("F1_operator_sequence_cannot_change_actor", async () => {
  const held = deferred<Response>();
  fixture.respond = (method, path) => method === "PATCH" && path === "/api/admin/operators/" + ENTITY ? held.promise : undefined;
  await mount(Operators); await click("button-edit-operator-" + ENTITY); await fill("input-operator-name", "ZZ TEST renamed");
  await click("button-confirm-edit"); phase = "patch_dispatched"; assert.equal(fixture.writes.filter(x => x.method === "PATCH").length, 1);
  fixture.actor = { ...fixture.actor, id: "actor-b" }; await render(); phase = "second_actor_ready";
  await act(async () => held.resolve(json(operator()))); await settle();
  assert.equal(fixture.writes.filter(x => x.method === "PUT").length, 0);
});
await check("F2_late_create_cannot_enter_next_actor_cache", async () => {
  const held = deferred<Response>(); let foreignSeen = false;
  fixture.respond = (method, path) => method === "POST" && path === "/api/admin/operators" ? held.promise : undefined;
  await mount(Operators); await click("button-add-operator"); await fill("input-operator-name", "ZZ TEST delayed entity"); await click("button-confirm-create");
  phase = "create_dispatched"; assert.equal(fixture.writes.length, 1);
  fixture.actor = { ...fixture.actor, id: "actor-b" }; fixture.operators = [operator(OTHER)];
  await act(async () => { queryClient.setQueryData(["/api/admin/operators"], fixture.operators); }); await render();
  const unsubscribe = queryClient.getQueryCache().subscribe((event: any) => { if (event.query.queryKey.length === 1 && event.query.queryKey[0] === "/api/admin/operators" && event.query.state.data?.some((row: any) => row.id === CREATED)) foreignSeen = true; });
  phase = "late_create_response"; await act(async () => held.resolve(json(operator(CREATED), 201))); await settle(); unsubscribe();
  assert.equal(foreignSeen, false); assert.equal(fixture.writes.length, 1);
});
await check("F3_fresh_assigned_user_flag_blocks_editor", async () => {
  fixture.users = [user("zz-user", false, ENTITY)]; fixture.assignedUsers = [user("zz-user", true, ENTITY)];
  await mount(Operators); await click("button-edit-operator-" + ENTITY); phase = "fresh_assignments_read";
  const save = element("button-confirm-edit") as HTMLButtonElement | null;
  assert.ok(!save || save.disabled); assert.equal(fixture.writes.length, 0);
});
await check("F4_flag_off_empty_eligible_bulk_keeps_native_refusal", async () => {
  fixture.people = [person("zz-no-policy", false, false)]; await mount(Permissions); await filterEmployees(); phase = "filtered_no_policy";
  assert.ok(element("checkbox-bulk-module-hr")); await click("checkbox-bulk-module-hr");
  assert.equal(fixture.writes.length, 0); assert.match(dom.window.document.body.textContent ?? "", /No eligible people/);
});
await check("users_actor_flag_keeps_list_but_removes_all_actions", async () => {
  fixture.actorManaged = true; await mount(Users); assert.ok(element("row-user-zz-user"));
  assert.equal(element("button-create-user"), null); assert.equal(element("button-user-menu-zz-user"), null);
  assert.match(required("managed-in-admin-notice").textContent ?? "", /Managed in Admin/);
  assert.equal(required("managed-in-admin-notice").querySelector("a")?.getAttribute("href"), "/console/people/accounts");
});
await check("users_mixed_targets_lock_only_exact_managed_row", async () => {
  fixture.users.push(user("zz-managed", true)); await mount(Users);
  assert.ok(element("button-user-menu-zz-user")); assert.equal(element("button-user-menu-zz-managed"), null);
});
await check("permissions_flagged_actor_keeps_native_values_readonly", async () => {
  fixture.actorManaged = true; await mount(Permissions);
  assert.equal(required("checkbox-module-zz-person-core").getAttribute("data-state"), "checked");
  assert.equal((required("checkbox-module-zz-person-hr") as HTMLButtonElement).disabled, true);
  assert.equal(element("button-edit-permission-zz-person"), null);
});
await check("permissions_mixed_bulk_has_no_silent_subset", async () => {
  fixture.people.push(person("zz-managed", true, true, "Managed")); await mount(Permissions); await filterEmployees();
  assert.equal(element("checkbox-bulk-module-hr"), null); assert.equal(fixture.writes.length, 0);
  assert.ok(element("button-edit-permission-zz-person")); assert.equal(element("button-edit-permission-zz-managed"), null);
});
await check("permissions_flag_off_bulk_keeps_exact_native_body", async () => {
  await mount(Permissions); await filterEmployees(); await click("checkbox-bulk-module-hr");
  assert.deepEqual(fixture.writes[0], { method: "PUT", path: "/api/permissions/bulk-update", body: { personIds: ["zz-person"], moduleKey: "hr", enabled: true } });
});
await check("open_permission_dialog_closes_on_target_authority_loss", async () => {
  await mount(Permissions); await click("button-edit-permission-zz-person"); assert.ok(element("button-save-permissions"));
  fixture.people[0] = { ...fixture.people[0], managedInAdmin: true };
  await act(async () => queryClient.setQueryData(["/api/permissions/bulk"], [...fixture.people])); await settle();
  assert.equal(element("button-save-permissions"), null); assert.equal(fixture.writes.length, 0);
});
await check("actor_unknown_does_not_default_to_flag_off", async () => {
  fixture.actorManaged = undefined; await mount(Users);
  assert.equal(element("button-create-user"), null); assert.equal(element("button-user-menu-zz-user"), null);
  assert.match(required("managed-in-admin-notice").textContent ?? "", /unavailable/);
});
await check("actor_error_retry_restores_only_confirmed_false", async () => {
  let failed = true; fixture.respond = (method, path) => method === "GET" && path === "/api/permissions/me" && failed ? json({ message: "ZZ TEST unavailable" }, 503) : undefined;
  await mount(Users); assert.equal(element("button-create-user"), null); failed = false;
  const retry = required("managed-in-admin-notice").querySelector("button")!; await act(async () => retry.click()); await settle();
  assert.ok(element("button-create-user")); assert.equal(fixture.writes.length, 0);
});
await check("operator_target_becoming_managed_stops_later_puts", async () => {
  const held = deferred<Response>(); fixture.respond = (method, path) => method === "PATCH" && path.endsWith(ENTITY) ? held.promise : undefined;
  await mount(Operators); await click("button-edit-operator-" + ENTITY); await click("button-confirm-edit");
  fixture.operators[0] = { ...fixture.operators[0], platformRolesEnabled: true };
  await act(async () => queryClient.setQueryData(["/api/admin/operators"], [...fixture.operators])); await settle();
  await act(async () => held.resolve(json(operator()))); await settle();
  assert.equal(fixture.writes.filter(x => x.method === "PUT").length, 0);
});
await check("operator_authority_loss_then_recovery_does_not_resume_sequence", async () => {
  const held = deferred<Response>(); fixture.respond = (method, path) => method === "PATCH" && path.endsWith(ENTITY) ? held.promise : undefined;
  await mount(Operators); await click("button-edit-operator-" + ENTITY); await click("button-confirm-edit");
  await refreshActor(true); await refreshActor(false);
  await act(async () => held.resolve(json(operator()))); await settle();
  assert.equal(fixture.writes.filter(x => x.method === "PUT").length, 0);
});
await check("users_unknown_target_metadata_never_becomes_writable", async () => {
  fixture.users[0] = { ...fixture.users[0], managedInAdmin: undefined }; await mount(Users);
  assert.ok(element("row-user-zz-user")); assert.equal(element("button-user-menu-zz-user"), null);
  assert.match(required("managed-in-admin-notice").textContent ?? "", /unavailable/); assert.equal(fixture.writes.length, 0);
});
await check("actor_refetch_hides_writes_and_does_not_reopen_old_dialog", async () => {
  const held = deferred<Response>(); let hold = false;
  fixture.respond = (method, path) => hold && method === "GET" && path === "/api/permissions/me" ? held.promise : undefined;
  await mount(Users); await click("button-create-user"); assert.ok(element("button-save-user")); hold = true;
  await act(async () => { void queryClient.invalidateQueries({ queryKey: ["/api/permissions/me"] }); }); await settle();
  assert.equal(element("button-create-user"), null); assert.equal(element("button-save-user"), null); assert.ok(element("row-user-zz-user"));
  hold = false; await act(async () => held.resolve(json({ managedInAdmin: false, modules: [], appModes: [] }))); await settle();
  assert.ok(element("button-create-user")); assert.equal(element("button-save-user"), null); assert.equal(fixture.writes.length, 0);
});
await check("operator_late_assignment_read_cannot_overwrite_new_editor", async () => {
  const held = deferred<Response>(); fixture.operators.push(operator(OTHER)); let hold = false;
  fixture.respond = (method, path) => method === "GET" && hold && path === `/api/admin/operators/${ENTITY}/users` ? held.promise : undefined;
  await mount(Operators); hold = true; await click("button-edit-operator-" + ENTITY); await click("button-cancel-edit");
  await click("button-edit-operator-" + OTHER); await act(async () => held.resolve(json([]))); await settle();
  assert.equal((required("input-operator-name") as HTMLInputElement).value, operator(OTHER).name);
});
await check("suite_pending_result_is_hidden_after_authority_loss", async () => {
  const held = deferred<Response>(); fixture.respond = (method, path) => method === "POST" && path.endsWith("/suite-sign-in") ? held.promise : undefined;
  await mount(Users); await openMenu(); await click("button-suite-signin-zz-user"); await fill("input-suite-signin-phone", "ZZ TEST local"); await click("button-suite-signin-provision");
  assert.equal(fixture.writes.length, 1); await refreshActor(true);
  await act(async () => held.resolve(json({ phone: "ZZ TEST local", temporaryPassword: "ZZ_TEST_SECRET_MARKER" }))); await settle();
  assert.equal(element("suite-signin-result"), null); assert.equal(element("input-suite-signin-phone"), null);
  assert.equal(dom.window.document.body.textContent?.includes("ZZ_TEST_SECRET_MARKER"), false); assert.equal(fixture.writes.length, 1);
});
await check("users_server_409_refreshes_management_without_retry_write", async () => {
  fixture.respond = (method, path) => method === "POST" && path === "/api/users" ? (fixture.actorManaged = true, json({ code: "managed_in_admin", message: "Managed in Admin. Open Admin to make changes." }, 409)) : undefined;
  await mount(Users); await click("button-create-user"); await fill("input-user-fullname", "ZZ TEST new"); await fill("input-user-email", "zz-new@example.invalid"); await click("button-save-user");
  assert.equal(fixture.writes.length, 1); assert.equal(element("button-create-user"), null);
  assert.match(required("managed-in-admin-notice").textContent ?? "", /Managed in Admin/);
});

const passed = Object.values(cases).filter(value => value.passed).length;
realLog("ADMIN_MANAGED_UI_RESULTS=" + JSON.stringify({ staging: false, database: false, network: false, actualNativePages: true, checks: Object.keys(cases).length, passed, failed: Object.keys(cases).length - passed, sourceSha256: hashes, cases }));
dom.window.close();
for (const timer of testTimers) clearTimeout(timer);
if (passed !== Object.keys(cases).length) process.exitCode = 1;
