// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file: it boots the app's real routes, needs a database with the otoapp schema
// migrated, and renders the real Studio checklists page under jsdom against
// them, inside the app's real auth and branch providers.
//
// SCRUM-659, the owner's ruling of 3 November 2026 — the edit screen:
//
//   1. A normal edit: the checklist's own branch is shown selected, the "Save as
//      a new checklist" box is unticked and nothing asks a question. Saving is
//      one PATCH that leaves the branches alone.
//   2. Ticked: one POST naming the original, no PATCH, the original exactly as
//      it was. A double click makes one copy.
//   3. Adding a branch: a required choice with nothing preselected, Save disabled
//      until it is answered. Taking the branch off again drops the question, and
//      adding it again asks again.
//   4. "Make a separate copy" is one template per added branch, the original on
//      its own branch. "Share" is what an edit always did: one template.
//   5. Ticked with a branch added: no question, because the original is not
//      touched at all.
//   6. A shared checklist carries the note, naming only branches the person may
//      see, and the box splits off a copy without changing it. A manager with
//      only one of its branches, first or second, copies to that branch and is
//      never asked for one out of reach.
//   7. A checklist on no branch: the all-branches note, and picking a branch
//      narrows it as today with no question.
//   8. While ticked, media cannot be changed, because media saves to the
//      original the moment it changes.
//   9. A refused copy says why, writes nothing and can be tried again. Named
//      employees reset on a branch change as they do today, and a person already
//      named stays in the picker.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/checklist-copies-ui.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createRequire, Module } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("checklist-copies-ui.check: DATABASE_URL is not set");
  process.exit(2);
}

// ─── jsdom, before React loads ────────────────────────────────────────────────

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/studio/checklists", pretendToBeVisual: true });
const g = globalThis as Record<string, any>;
const win = dom.window as unknown as Record<string, any>;
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLImageElement", "HTMLVideoElement", "HTMLTextAreaElement", "Node", "Element", "Event", "CustomEvent", "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "DocumentFragment", "NodeFilter", "HTMLAnchorElement", "SVGElement", "location", "history", "localStorage", "sessionStorage"]) {
  try { g[key] = win[key]; } catch { /* a read-only global */ }
}
for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) g[key] = win[key].bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
g.ResizeObserver = win.ResizeObserver = ResizeObserverStub;
class IntersectionObserverStub { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
g.IntersectionObserver = win.IntersectionObserver = IntersectionObserverStub;
class PointerEventStub extends dom.window.MouseEvent {
  pointerId = 1;
  pointerType = "mouse";
  isPrimary = true;
}
g.PointerEvent = win.PointerEvent = PointerEventStub;
Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {}, hasPointerCapture() { return false; }, setPointerCapture() {}, releasePointerCapture() {} });
win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
const doc = dom.window.document;
const realLog = console.log;
console.log = (...args: unknown[]) => {
  if (!/^\[(auth-diag|Checklists)/.test(String(args[0]))) realLog(...args);
};

// ─── The page, compiled as Vite would give it its build-time env ─────────────

const built = buildSync({
  absWorkingDir: APP_DIR,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  write: false,
  tsconfig: join(APP_DIR, "tests", "tsconfig.jsx.json"),
  define: { "import.meta.env": "{}", "import.meta.url": JSON.stringify("file:///checklist-copies-ui.native.cjs") },
  logLevel: "silent",
  stdin: {
    resolveDir: APP_DIR,
    loader: "tsx",
    contents: `
      export * as React from 'react';
      export { act } from 'react';
      export { createRoot } from 'react-dom/client';
      export { QueryClientProvider } from '@tanstack/react-query';
      export { Router } from 'wouter';
      export { queryClient } from './client/src/lib/queryClient';
      export { AuthProvider } from './client/src/hooks/use-auth';
      export { BranchProvider } from './client/src/hooks/use-branch-context';
      export { ModeProvider } from './client/src/hooks/use-mode';
      export { ThemeProvider } from './client/src/components/theme-provider';
      export { I18nProvider } from './client/src/lib/i18n';
      export { TooltipProvider } from './client/src/components/ui/tooltip';
      export { Toaster } from './client/src/components/ui/toaster';
      export { default as ChecklistsPage } from './client/src/pages/studio/checklists';
    `,
  },
});
const nativeRequire = createRequire(join(APP_DIR, "package.json"));
const compiled = new Module(join(APP_DIR, "tests", "checklist-copies-ui.native.cjs")) as any;
compiled.filename = join(APP_DIR, "tests", "checklist-copies-ui.native.cjs");
compiled.paths = nativeRequire.resolve.paths("react");
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { React, act, createRoot, QueryClientProvider, Router, queryClient, AuthProvider, BranchProvider, ModeProvider, ThemeProvider, I18nProvider, TooltipProvider, Toaster, ChecklistsPage } = compiled.exports;

// ─── Rows ─────────────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, any>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST ccui ${run}`, `zz-ccui-${run}`]);
async function branch(label: string): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = `ZZ ${label} ${run}`;
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [id, tenant, name]);
  return { id, name };
}
const hkt = await branch("HKT");
const robinson = await branch("Robinson");
const patong = await branch("Patong");

async function user(role: string, label: string, branches: string[] | "all"): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `zz-ccui-${label.toLowerCase()}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${label} ${run}`, role],
  );
  if (branches === "all") {
    await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, id]);
  } else {
    for (const b of branches) {
      await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [tenant, id, b]);
    }
  }
  return { id, email };
}
const admin = await user("admin", "Admin", "all");
const managerHkt = await user("manager", "ManagerHkt", [hkt.id]);
const managerRobinson = await user("manager", "ManagerRobinson", [robinson.id]);
const managerTwo = await user("manager", "ManagerTwo", [hkt.id, patong.id]);

async function employee(label: string, branchId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status)
     values ($1, $2, $3, $4, $5, $6, 'active')`,
    [id, tenant, branchId, `ZZ TEST ${label} ${run}`, `${label}${run}`, `zz-ccui-${label.toLowerCase()}-${run}@example.com`],
  );
  return id;
}
const ann = await employee("Ann", hkt.id);
const rita = await employee("Rita", robinson.id);

async function checklist(label: string, fields: { branchId?: string | null; branchIds?: string[]; employee?: string } = {}): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = `ZZ ${label} ${run}`;
  await q(
    `insert into checklist_templates (id, tenant_id, branch_id, branch_ids, name, recurrence, scheduled_time, assigned_employee_id, created_by)
     values ($1, $2, $3, $4::jsonb, $5, 'daily', '09:00', $6, $7)`,
    [id, tenant, fields.branchId === undefined ? hkt.id : fields.branchId, JSON.stringify(fields.branchIds ?? []), name, fields.employee ?? null, admin.id],
  );
  await q("insert into checklist_template_items (tenant_id, template_id, title, sort_order) values ($1, $2, 'First', 0), ($1, $2, 'Second', 1)", [tenant, id]);
  if (fields.employee) {
    await q("insert into checklist_template_assignees (tenant_id, template_id, employee_id) values ($1, $2, $3)", [tenant, id, fields.employee]);
  }
  return { id, name };
}
const templateRow = async (id: string) => (await q("select * from checklist_templates where id = $1", [id]))[0];
const rowsNamed = (name: string) => q("select * from checklist_templates where tenant_id = $1 and name = $2 order by created_at", [tenant, name]);
const snapshot = async (id: string) =>
  JSON.stringify({
    template: await templateRow(id),
    items: await q("select * from checklist_template_items where template_id = $1 order by sort_order", [id]),
    assignees: await q("select * from checklist_template_assignees where template_id = $1 order by id", [id]),
    media: await q("select * from checklist_attachments where checklist_template_id = $1 order by id", [id]),
  });

// ─── The server ──────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
async function serve(): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      APP_ENV: "dev",
      STORAGE_ENV_PREFIX: "zz-test",
      OBJECT_STORAGE: "local",
      OTOAPP_LEGACY_LOGIN: "true",
      LOG_LEVEL: "warn",
      TZ: "UTC",
      DEPLOY_ENV: "local",
      OTOAPP_JOBS: "platform",
      USE_AWS_REKOGNITION: "false",
      SESSION_SECRET: `zz-session-${run}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 180_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const m = /HARNESS_PORT=(\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited ${code}:\n${output}`));
    });
  });
}

let checks = 0;
const check = async (title: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  realLog(`  ok  ${title}`);
};

const realFetch = globalThis.fetch;
const settle = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const waitFor = async <T,>(what: string, find: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await settle(50);
  }
};
const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const required = (id: string) => {
  const el = byTestId(id);
  assert.ok(el, `the page has no ${id}`);
  return el!;
};
const click = async (id: string) => { await act(async () => { required(id).click(); }); await settle(); };
const type = async (id: string, value: string) => {
  const input = required(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await settle();
};
const saveButton = () => required("button-save-checklist") as HTMLButtonElement;
const checked = (id: string) => required(id).getAttribute("aria-checked") === "true" || required(id).getAttribute("data-state") === "checked";
const toastSays = (text: string) => doc.body.textContent?.includes(text) ?? false;
const isSelected = (branchId: string) => !required(`badge-edit-branch-${branchId}`).className.includes("--badge-outline");

try {
  const ORIGIN = await serve();

  const signIn = async (email: string) => {
    const res = await realFetch(`${ORIGIN}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: email, password: PASSWORD }),
    });
    assert.equal(res.status, 200, `sign-in as ${email}: ${res.status}`);
    return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  };
  const cookies = new Map<string, string>();
  for (const person of [admin, managerHkt, managerRobinson, managerTwo]) cookies.set(person.email, await signIn(person.email));
  let cookie = "";

  /** Every write the page sends, on to the real routes as the signed-in person. */
  const writes: Array<{ method: string; path: string; body: any }> = [];
  g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") writes.push({ method, path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return realFetch(`${ORIGIN}${url.pathname}${url.search}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), cookie },
    });
  };
  const templateWrites = () => writes.filter((w) => w.path.startsWith("/api/checklists/templates"));

  // The page once per person: their own session, their own working branch.
  let root: any = null;
  let host: HTMLElement | null = null;
  const mount = async (who: { email: string }, activeBranchId: string) => {
    if (root) await act(async () => root.unmount());
    host?.remove();
    await act(async () => { queryClient.clear(); });
    cookie = cookies.get(who.email)!;
    dom.window.localStorage.setItem("oto_active_branch_id", activeBranchId);
    host = doc.createElement("div");
    doc.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(QueryClientProvider, { client: queryClient },
          React.createElement(ThemeProvider, null,
            React.createElement(I18nProvider, null,
              React.createElement(AuthProvider, null,
                React.createElement(BranchProvider, null,
                  React.createElement(ModeProvider, null,
                    React.createElement(TooltipProvider, null,
                      React.createElement(Toaster),
                      React.createElement(Router, null, React.createElement(ChecklistsPage)))))))))
      );
    });
    await waitFor("the checklists heading", () => doc.querySelector("h1")?.textContent === "Checklists");
  };
  /** Open a checklist's editor, with the list fresh, and start counting writes from here. */
  const openEditor = async (id: string) => {
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["/api/checklists/templates"] }); });
    await waitFor(`the edit button of ${id}`, () => byTestId(`button-edit-checklist-${id}`));
    await settle(100);
    await click(`button-edit-checklist-${id}`);
    await waitFor("the editor", () => byTestId("input-edit-checklist-name"));
    await settle(100);
    writes.length = 0;
  };
  const save = async () => { await click("button-save-checklist"); };
  const waitClosed = () => waitFor("the editor to close", () => !byTestId("input-edit-checklist-name"));

  await mount(admin, hkt.id);

  await check("a normal edit: its own branch selected, the box unticked, no question, one PATCH that leaves the branches alone", async () => {
    const one = await checklist("Normal");
    await openEditor(one.id);
    assert.equal(isSelected(hkt.id), true, "the checklist's own branch is not shown selected");
    assert.equal(isSelected(robinson.id), false);
    assert.equal(checked("checkbox-edit-save-as-new"), false, "Save as a new checklist starts ticked");
    assert.equal(byTestId("group-edit-branch-choice"), null);
    assert.equal(byTestId("text-edit-shared-note"), null, "a one-branch checklist has a note");
    assert.equal(saveButton().disabled, false);
    assert.equal(saveButton().textContent, "Save Changes");

    await type("input-edit-checklist-name", `${one.name} edited`);
    await save();
    await waitClosed();
    assert.deepEqual(templateWrites().map((w) => `${w.method} ${w.path}`), [`PATCH /api/checklists/templates/${one.id}`]);
    const body = templateWrites()[0].body;
    for (const key of ["branchId", "branchIds", "branchCopyChoice", "copiedFromTemplateId"]) assert.equal(key in body, false, `a normal save sent ${key}`);
    const row = await templateRow(one.id);
    assert.equal(row.name, `${one.name} edited`);
    assert.equal(row.branch_id, hkt.id);
    assert.deepEqual(row.branch_ids, []);
    assert.equal(row.template_version, 2);
    await waitFor("the saved toast", () => toastSays("Checklist template updated"));
  });

  await check("ticked: one POST naming the original even on a double click, no PATCH, the original exactly as it was", async () => {
    const one = await checklist("Ticked", { employee: ann });
    const before = await snapshot(one.id);
    await openEditor(one.id);
    await click("checkbox-edit-save-as-new");
    assert.equal(checked("checkbox-edit-save-as-new"), true);
    assert.equal(saveButton().textContent, "Save as New Checklist");
    assert.match(required("text-edit-save-as-new-summary").textContent ?? "", new RegExp(`^Creates one new checklist for ${hkt.name}\\. The original stays exactly as it is`));
    const name = `${one.name} new`;
    await type("input-edit-checklist-name", name);

    const button = saveButton();
    await act(async () => { button.click(); button.click(); });
    await settle();
    await waitClosed();
    assert.deepEqual(templateWrites().map((w) => `${w.method} ${w.path}`), ["POST /api/checklists/templates"], "a double click did not make one request");
    const body = templateWrites()[0].body;
    assert.equal(body.copiedFromTemplateId, one.id);
    assert.deepEqual(body.branchIds, [hkt.id]);
    assert.deepEqual(body.assignedEmployeeIds, [ann]);
    assert.equal("isActive" in body, false);
    assert.equal(await snapshot(one.id), before, "the original changed");
    const rows = await rowsNamed(name);
    assert.equal(rows.length, 1, "a double click made two copies");
    assert.equal(rows[0].branch_id, hkt.id);
    assert.notEqual(rows[0].id, one.id);
    await waitFor("the toast", () => toastSays("New checklist created"));
  });

  await check("adding a branch: a required choice with nothing preselected, Save disabled until it is answered", async () => {
    const one = await checklist("Choice");
    await openEditor(one.id);
    await click(`badge-edit-branch-${robinson.id}`);
    const group = required("group-edit-branch-choice");
    assert.ok(group.textContent?.includes(`How should ${robinson.name} be added?`));
    assert.ok(group.textContent?.includes("Make a separate copy for this branch"));
    assert.ok(group.textContent?.includes("Share one checklist across both"));
    assert.equal(checked("radio-edit-branch-copy"), false, "the copy answer is preselected");
    assert.equal(checked("radio-edit-branch-share"), false, "the share answer is preselected");
    assert.equal(saveButton().disabled, true, "Save is open with no answer");
    assert.ok(byTestId("text-edit-choice-needed"), "nothing says why Save is closed");

    await click(`badge-edit-branch-${robinson.id}`);
    assert.equal(byTestId("group-edit-branch-choice"), null, "taking the branch off left the question");
    assert.equal(saveButton().disabled, false);

    await click(`badge-edit-branch-${robinson.id}`);
    await click("radio-edit-branch-copy");
    assert.equal(checked("radio-edit-branch-copy"), true);
    assert.equal(saveButton().disabled, false, "Save stays closed after an answer");
    await click(`badge-edit-branch-${patong.id}`);
    assert.equal(checked("radio-edit-branch-copy"), false, "an answer given for one branch carried to another");
    assert.equal(saveButton().disabled, true);
    assert.ok(required("group-edit-branch-choice").textContent?.includes("Make a separate copy for each new branch"));
    assert.ok(required("group-edit-branch-choice").textContent?.includes("Share one checklist across all of them"));
    assert.equal(templateWrites().length, 0, "the question wrote something");
    await click("button-cancel-edit");
  });

  await check("a separate copy: one template for the added branch, the original on its own branch with the rest of the edit", async () => {
    const one = await checklist("Separate");
    await openEditor(one.id);
    await type("input-edit-checklist-name", `${one.name} edited`);
    await click(`badge-edit-branch-${robinson.id}`);
    await click("radio-edit-branch-copy");
    await save();
    await waitClosed();
    assert.deepEqual(templateWrites().map((w) => `${w.method} ${w.path}`), [`PATCH /api/checklists/templates/${one.id}`]);
    const body = templateWrites()[0].body;
    assert.equal(body.branchCopyChoice, "copy");
    assert.deepEqual(body.branchIds, [hkt.id, robinson.id]);
    const original = await templateRow(one.id);
    assert.equal(original.name, `${one.name} edited`);
    assert.equal(original.branch_id, hkt.id);
    assert.deepEqual(original.branch_ids, []);
    const rows = await rowsNamed(`${one.name} edited`);
    assert.equal(rows.length, 2);
    const copy = rows.find((r) => r.id !== one.id)!;
    assert.equal(copy.branch_id, robinson.id);
    assert.deepEqual(copy.branch_ids, []);
    await waitFor("the toast", () => toastSays("Made a separate copy for the new branch."));
  });

  await check("share: what an edit always did, one template on both branches", async () => {
    const one = await checklist("Share");
    await openEditor(one.id);
    await click(`badge-edit-branch-${robinson.id}`);
    await click("radio-edit-branch-share");
    await save();
    await waitClosed();
    assert.equal(templateWrites().length, 1);
    assert.equal(templateWrites()[0].body.branchCopyChoice, "share");
    const row = await templateRow(one.id);
    assert.equal(row.branch_id, hkt.id);
    assert.deepEqual(row.branch_ids, [hkt.id, robinson.id]);
    assert.equal((await rowsNamed(one.name)).length, 1, "a share made a second template");
  });

  await check("swapping the only branch for another says it moves, and asks the same question", async () => {
    const one = await checklist("Swap");
    await openEditor(one.id);
    await click(`badge-edit-branch-${hkt.id}`);
    await click(`badge-edit-branch-${robinson.id}`);
    assert.ok(required("group-edit-branch-choice").textContent?.includes(`Move this checklist to ${robinson.name}`));
    await click("radio-edit-branch-share");
    await save();
    await waitClosed();
    const row = await templateRow(one.id);
    assert.equal(row.branch_id, robinson.id);
    assert.deepEqual(row.branch_ids, [robinson.id]);
    assert.equal((await rowsNamed(one.name)).length, 1);
  });

  await check("removing a branch from a shared checklist asks nothing and narrows it as today", async () => {
    const one = await checklist("Remove", { branchIds: [hkt.id, robinson.id] });
    await openEditor(one.id);
    await click(`badge-edit-branch-${robinson.id}`);
    assert.equal(byTestId("group-edit-branch-choice"), null);
    await save();
    await waitClosed();
    assert.equal(templateWrites()[0].body.branchCopyChoice, undefined);
    assert.deepEqual((await templateRow(one.id)).branch_ids, [hkt.id]);
  });

  await check("ticked with a branch added: no question, and the original is not touched", async () => {
    const one = await checklist("Ticked added");
    const before = await snapshot(one.id);
    await openEditor(one.id);
    await click(`badge-edit-branch-${robinson.id}`);
    assert.ok(byTestId("group-edit-branch-choice"));
    await click("checkbox-edit-save-as-new");
    assert.equal(byTestId("group-edit-branch-choice"), null, "the box did not answer the question");
    assert.equal(saveButton().disabled, false);
    assert.match(required("text-edit-save-as-new-summary").textContent ?? "", /^Creates 2 new checklists, one for each selected branch\./);
    await type("input-edit-checklist-name", `${one.name} pair`);
    await save();
    await waitClosed();
    assert.deepEqual(templateWrites().map((w) => w.method), ["POST"]);
    assert.equal(await snapshot(one.id), before);
    const rows = await rowsNamed(`${one.name} pair`);
    assert.deepEqual(rows.map((r) => r.branch_id).sort(), [hkt.id, robinson.id].sort());
    await waitFor("the toast", () => toastSays("2 new checklists created"));
  });

  await check("a shared checklist carries the note, and the box splits off a copy without changing it", async () => {
    const shared = await checklist("Shared", { branchIds: [hkt.id, robinson.id] });
    const before = await snapshot(shared.id);
    await openEditor(shared.id);
    assert.equal(required("text-edit-shared-note").textContent, `This is shared with ${robinson.name}. Changes apply to both branches.`);
    assert.equal(isSelected(hkt.id), true);
    assert.equal(isSelected(robinson.id), true);
    await click("checkbox-edit-save-as-new");
    await click(`badge-edit-branch-${hkt.id}`);
    assert.match(required("text-edit-save-as-new-summary").textContent ?? "", new RegExp(`^Creates one new checklist for ${robinson.name}\\.`));
    await type("input-edit-checklist-name", `${shared.name} split`);
    await save();
    await waitClosed();
    assert.deepEqual(templateWrites()[0].body.branchIds, [robinson.id]);
    assert.equal(await snapshot(shared.id), before, "splitting off a copy changed the shared checklist");
    const rows = await rowsNamed(`${shared.name} split`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].branch_id, robinson.id);
    assert.equal((await rowsNamed(shared.name)).length, 1, "the shared checklist was split");
  });

  await check("a checklist on no branch: the all-branches note, and picking a branch narrows it as today with no question", async () => {
    const everywhere = await checklist("Everywhere", { branchId: null });
    await openEditor(everywhere.id);
    assert.equal(required("text-edit-shared-note").textContent, "This is shared with all branches. Changes apply to every branch.");
    await click(`badge-edit-branch-${robinson.id}`);
    assert.equal(byTestId("group-edit-branch-choice"), null);
    assert.equal(saveButton().disabled, false);
    await click("button-cancel-edit");

    await openEditor(everywhere.id);
    await type("input-edit-checklist-name", `${everywhere.name} edited`);
    await save();
    await waitClosed();
    const row = await templateRow(everywhere.id);
    assert.equal(row.branch_id, null, "a save with no branch picked narrowed it");
    assert.equal((await rowsNamed(`${everywhere.name} edited`)).length, 1);
  });

  await check("while ticked, media cannot be changed: it saves to the original the moment it changes", async () => {
    const one = await checklist("Media");
    const attachment = randomUUID();
    await q(
      `insert into checklist_attachments (id, tenant_id, checklist_template_id, type, s3_key, mime_type, file_size, original_filename)
       values ($1, $2, $3, 'image', $4, 'image/jpeg', 10, 'zz.jpg')`,
      [attachment, tenant, one.id, `checklists/${one.id}/header/${randomUUID()}.jpg`],
    );
    await openEditor(one.id);
    const dialogText = () => doc.body.textContent ?? "";
    await waitFor("the media strip", () => byTestId(`media-thumbnail-${attachment}`));
    assert.ok(byTestId(`button-remove-media-${attachment}`), "media cannot be removed in a normal edit");
    assert.ok(dialogText().includes("Browse Files"));
    assert.equal(byTestId("text-edit-media-copied"), null);
    await click("checkbox-edit-save-as-new");
    assert.equal(byTestId(`button-remove-media-${attachment}`), null, "media can be removed while ticked");
    assert.ok(byTestId(`media-thumbnail-${attachment}`), "the media is no longer shown");
    assert.ok(byTestId("text-edit-media-copied"), "nothing says the media copies across");
    assert.ok(!dialogText().includes("Drag & drop files here"), "media can be added while ticked");
    await click("checkbox-edit-save-as-new");
    assert.ok(byTestId(`button-remove-media-${attachment}`), "unticking did not give media back");
    await click("button-cancel-edit");
  });

  await check("named employees reset on a branch change as today, and someone already named stays in the picker", async () => {
    const one = await checklist("Named", { employee: rita });
    await openEditor(one.id);
    assert.ok(byTestId(`select-edit-employee-${rita}`), "a named person at another branch dropped out of the picker");
    assert.ok(byTestId(`select-edit-employee-${ann}`), "the branch's own people are not listed");
    assert.equal(checked(`select-edit-employee-${rita}`), true);
    await click(`badge-edit-branch-${robinson.id}`);
    assert.equal(checked(`select-edit-employee-${rita}`), false, "the branch change did not reset the named people");
    await click("radio-edit-branch-copy");
    await save();
    await waitFor("the toast", () => toastSays("Please select at least one employee"));
    assert.equal(templateWrites().length, 0);
    await click(`select-edit-employee-${rita}`);
    await save();
    await waitClosed();
    assert.equal(templateWrites().length, 1);
    const copies = (await rowsNamed(one.name)).filter((r) => r.id !== one.id);
    assert.equal(copies.length, 1);
    assert.equal(copies[0].assigned_employee_id, rita);
  });

  const limited = await checklist("Limited", { branchIds: [hkt.id, robinson.id] });

  await mount(managerHkt, hkt.id);

  await check("a manager's note names only branches they may see, and splitting off a copy asks for none out of reach", async () => {
    const before = await snapshot(limited.id);
    await openEditor(limited.id);
    const note = required("text-edit-shared-note").textContent ?? "";
    assert.equal(note, "This is shared with 1 other branch. Changes apply to both branches.");
    assert.ok(!note.includes(robinson.name), "the note names a branch the person may not see");
    assert.equal(byTestId(`badge-edit-branch-${robinson.id}`), null, "the picker offers a branch out of reach");

    await click("checkbox-edit-save-as-new");
    assert.match(required("text-edit-save-as-new-summary").textContent ?? "", new RegExp(`^Creates one new checklist for ${hkt.name}\\.`));
    await type("input-edit-checklist-name", `${limited.name} hkt`);
    await save();
    await waitClosed();
    assert.deepEqual(templateWrites()[0].body.branchIds, [hkt.id], "the copy asked for a branch this manager does not have");
    assert.equal(await snapshot(limited.id), before);
    assert.equal((await rowsNamed(`${limited.name} hkt`))[0].branch_id, hkt.id);
  });

  await mount(managerRobinson, robinson.id);

  await check("a manager at the second branch opens the shared checklist with its items and splits off a copy for their branch", async () => {
    const before = await snapshot(limited.id);
    await openEditor(limited.id);
    assert.equal(required("text-edit-shared-note").textContent, "This is shared with 1 other branch. Changes apply to both branches.");
    await click("checkbox-edit-save-as-new");
    await type("input-edit-checklist-name", `${limited.name} robinson`);
    await save();
    await waitClosed();
    const body = templateWrites()[0].body;
    assert.deepEqual(body.branchIds, [robinson.id]);
    assert.deepEqual(body.items.map((item: { title: string }) => item.title), ["First", "Second"], "the items did not load for this manager");
    assert.equal(await snapshot(limited.id), before);
    assert.equal((await rowsNamed(`${limited.name} robinson`))[0].branch_id, robinson.id);
  });

  await mount(managerTwo, hkt.id);

  await check("a copy refused by the server says why, writes nothing, and the editor stays usable", async () => {
    const own = await checklist("Refused");
    const before = await snapshot(own.id);
    await openEditor(own.id);
    await type("input-edit-checklist-name", `${own.name} no`);
    await click(`badge-edit-branch-${patong.id}`);
    await click("radio-edit-branch-copy");
    // The branch was in reach when the screen loaded; it is not any more.
    await q("delete from user_branch_access where user_id = $1 and branch_id = $2", [managerTwo.id, patong.id]);
    await save();
    await waitFor("the refusal", () => toastSays("Access denied to create templates for one or more branches"));
    assert.ok(byTestId("input-edit-checklist-name"), "a refused save closed the editor");
    assert.equal(await snapshot(own.id), before, "a refused copy wrote to the original");
    assert.equal((await rowsNamed(`${own.name} no`)).length, 0);
    assert.equal(saveButton().disabled, false);

    await click(`badge-edit-branch-${patong.id}`);
    writes.length = 0;
    await save();
    await waitClosed();
    assert.equal(templateWrites().length, 1, "the save after a refusal did not go through");
    assert.equal((await templateRow(own.id)).name, `${own.name} no`);
  });

  if (root) await act(async () => root.unmount());
  realLog(`checklist-copies-ui.check: ${checks} checks passed`);
} catch (err) {
  console.error("checklist-copies-ui.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
  dom.window.close();
  process.exit(process.exitCode ?? 0);
}
