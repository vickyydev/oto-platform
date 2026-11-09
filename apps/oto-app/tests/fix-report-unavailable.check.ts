// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated,
// and renders the real Fix Board and Fix pages under jsdom against them.
//
// SCRUM-641 — a Fix report deleted while somebody else has it on screen:
//
//   1. A card deleted elsewhere opens as "This report is not available": no
//      status control, no reporter line, no comment bar, no delete. The card
//      leaves the board, the count falls, and the failed read is not repeated.
//   2. A card opened earlier and deleted since says the same, rather than
//      showing the copy it read before.
//   3. With the report open when it is deleted, an update, a status change or
//      completing it is refused and the screen turns to the same words, with the
//      completion sheet closed.
//   4. My Reports behaves the same way, and its row leaves the list.
//   5. A report still there opens as it always did, and a manager's own delete
//      closes the details without ever showing "not available".
//   6. A dropped connection is not a deletion: a copy already read stays on
//      screen, and a first read that failed recovers on opening again.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/fix-report-unavailable.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import pg from "pg";
import type { ComponentType } from "react";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("fix-report-unavailable.check: DATABASE_URL is not set");
  process.exit(2);
}

// The query client logs every read; this check's own lines are what matter here.
const printLine = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (!String(args[0]).startsWith("[auth-diag]")) printLine(...args);
};

// ─── jsdom, before React loads ────────────────────────────────────────────────

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/core/fix-board", pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLImageElement", "Node", "Element", "Event", "CustomEvent", "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "PointerEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "DocumentFragment", "NodeFilter", "HTMLAnchorElement", "SVGElement", "location", "history", "localStorage", "sessionStorage"]) {
  try { g[key] = (dom.window as unknown as Record<string, unknown>)[key]; } catch { /* read-only global */ }
}
for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) g[key] = (dom.window as unknown as Record<string, (...a: unknown[]) => unknown>)[key].bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
g.ResizeObserver = ResizeObserverStub;
(dom.window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
(dom.window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const doc = dom.window.document;

// ─── One park group: a branch, the Fix Department, and the people ────────────

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const PASSWORD = "zz-test-password";
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(24).toString("hex");
const JPEG = readFileSync(join(APP_DIR, "tests", "fixtures", "media", "checklist-evidence.jpg"));
const run = randomBytes(3).toString("hex");

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST fu ${run}`, `zz-fu-${run}`]);
const branch = randomUUID();
await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [branch, tenant, `ZZ TEST fu ${run}`]);
const fixDept = randomUUID();
await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [fixDept, tenant, `ZZ TEST Maintenance ${run}`]);
await q("insert into settings (tenant_id, key, value) values ($1, 'fix_department_id', $2)", [tenant, fixDept]);

/** A login reaching the branch, with an employee record in the Fix Department when asked. */
async function person(label: string, role: string, inFixDept: boolean) {
  const id = randomUUID();
  const email = `zz-fu-${label}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${label} ${run}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [tenant, id, branch]);
  if (inFixDept) {
    await q(
      `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status, primary_department_id)
       values ($1, $2, $3, $4, $5, $6, $7, 'active', $8)`,
      [randomUUID(), tenant, branch, id, `ZZ TEST ${label} ${run}`, label, email, fixDept],
    );
  }
  return { label, id, email };
}
const reporter = await person("Reporter", "staff", false);
const member = await person("Member", "staff", true);
const manager = await person("Manager", "manager", false);

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
      SESSION_SECRET,
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
  printLine(`  ok  ${title}`);
};

try {
  const ORIGIN = await serve();
  const realFetch = globalThis.fetch;

  const signIn = async (email: string) => {
    const res = await realFetch(`${ORIGIN}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: email, password: PASSWORD }),
    });
    assert.equal(res.status, 200, `sign-in as ${email}: ${res.status} ${await res.text()}`);
    return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  };
  const reporterCookie = await signIn(reporter.email);
  const memberCookie = await signIn(member.email);
  const managerCookie = await signIn(manager.email);

  /** What the Fix page sends: the photo first, then the report. */
  const report = async (title: string) => {
    const form = new FormData();
    form.append("media", new Blob([JPEG], { type: "image/jpeg" }), "photo.jpg");
    const upload = await realFetch(`${ORIGIN}/api/fix-reports/upload`, { method: "POST", headers: { cookie: reporterCookie }, body: form });
    assert.equal(upload.status, 200, `upload: ${upload.status}`);
    const { urls } = (await upload.json()) as { urls: string[] };
    const created = await realFetch(`${ORIGIN}/api/fix-reports`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: reporterCookie },
      body: JSON.stringify({ media: urls, title: `ZZ TEST ${title} ${run}`, priority: "normal", branchId: branch, tags: [] }),
    });
    assert.equal(created.status, 201, `report: ${created.status}`);
    return ((await created.json()) as { id: string }).id;
  };
  const deleteElsewhere = async (id: string) => {
    const res = await realFetch(`${ORIGIN}/api/fix-reports/${id}`, { method: "DELETE", headers: { cookie: managerCookie } });
    assert.equal(res.status, 204, `delete: ${res.status}`);
  };

  /** Every call the page makes goes to the real routes as the person on screen. */
  let onScreenCookie = memberCookie;
  let connectionDropped = false;
  const sent: Array<{ method: string; path: string; status: number }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (connectionDropped && url.endsWith("/details")) throw new TypeError("Failed to fetch");
    const res = await realFetch(url.startsWith("/") ? `${ORIGIN}${url}` : url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), cookie: onScreenCookie },
    });
    sent.push({ method: (init.method ?? "GET").toUpperCase(), path: url, status: res.status });
    return res;
  }) as typeof fetch;
  const detailsReads = (id: string) => sent.filter((r) => r.method === "GET" && r.path === `/api/fix-reports/${id}/details`).length;

  const React = await import("react");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClientProvider } = await import("@tanstack/react-query");
  const { queryClient } = await import("../client/src/lib/queryClient");
  const { AuthProvider } = await import("../client/src/hooks/use-auth");
  const { BranchProvider } = await import("../client/src/hooks/use-branch-context");
  const { default: FixBoardPage } = await import("../client/src/pages/core/fix-board");
  const { default: FixPage } = await import("../client/src/pages/core/fix");

  const settle = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
  const waitFor = async <T,>(what: string, find: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const found = find();
      if (found) return found;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}\n${doc.body.textContent?.slice(0, 600)}`);
      await settle(50);
    }
  };
  const byTestId = (id: string) => doc.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); await settle(); };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await settle();
  };
  const escape = async () => {
    await act(async () => {
      (doc.activeElement ?? doc.body).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle(50);
  };
  const chooseStatus = async (label: string) => {
    await click(byTestId("select-status-change")!);
    const options = () => Array.from(doc.querySelectorAll<HTMLElement>('[role="option"]'));
    await click(await waitFor(`the ${label} option`, () => options().find((option) => option.textContent === label)));
  };
  const boardDialog = () => byTestId("dialog-fix-report-detail");
  const unavailable = () => byTestId("text-report-unavailable");
  const boardCard = (id: string) => byTestId(`card-fix-report-${id}`);
  const pendingCount = () => Number(doc.querySelector(".text-amber-500")?.textContent);

  /** Mounts a page as one person, with an empty cache, as a fresh sign-in has. */
  const mount = async (cookie: string, Page: ComponentType) => {
    onScreenCookie = cookie;
    queryClient.clear();
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(AuthProvider, null, React.createElement(BranchProvider, null, React.createElement(Page))),
        ),
      );
    });
    return async () => {
      await act(async () => root.unmount());
      host.remove();
    };
  };

  const assertOffersNothing = () => {
    const words = boardDialog()?.textContent ?? "";
    assert.ok(words.includes("This report is not available."), words);
    assert.equal(byTestId("select-status-change"), null, "the status control is still offered");
    assert.equal(byTestId("text-fix-reported-by"), null, "the reporter line reads as a live report");
    assert.equal(byTestId("input-activity-comment"), null, "the comment bar is still offered");
    assert.equal(byTestId("button-delete-fix-report"), null, "delete is still offered");
  };

  // ─── The Fix Board, as a Fix Department member ─────────────────────────────

  const neverOpened = await report("never opened");
  const openedBefore = await report("opened before");
  const openWhenDeleted = await report("open when deleted");
  const statusWhenDeleted = await report("status changed when deleted");
  const completedWhenDeleted = await report("completed when deleted");
  const onAPoorConnection = await report("on a poor connection");

  const unmountBoard = await mount(memberCookie, FixBoardPage);
  await waitFor("the six cards", () => boardCard(neverOpened) && boardCard(openedBefore) && boardCard(openWhenDeleted) && boardCard(statusWhenDeleted) && boardCard(completedWhenDeleted) && boardCard(onAPoorConnection));
  // The count badge fills on its own fetch, a moment after the cards; read it the way the later steps do.
  await waitFor("the count of six", () => pendingCount() === 6);

  await check("a report still there opens as it always did", async () => {
    await click(boardCard(openedBefore)!);
    await waitFor("the details", () => byTestId("input-activity-comment"));
    await waitFor("the reporter's name", () => byTestId("text-fix-reported-by")?.textContent?.includes(`ZZ TEST Reporter ${run}`));
    assert.ok(byTestId("select-status-change"), "the status control is missing");
    assert.equal(unavailable(), null, "a live report says it is not available");
    await escape();
    await waitFor("the details to close", () => !boardDialog());
  });

  await check("a card deleted elsewhere says it is not available, and leaves the board", async () => {
    await deleteElsewhere(neverOpened);
    assert.ok(boardCard(neverOpened), "the board moved before anyone asked");
    await click(boardCard(neverOpened)!);
    await waitFor("the words", unavailable);
    assertOffersNothing();
    await waitFor("the card to leave the board", () => !boardCard(neverOpened));
    await waitFor("the count to fall", () => pendingCount() === 5);
    // Reading the lists again must not ask for the failed details again.
    await settle(600);
    assert.equal(detailsReads(neverOpened), 1, "the failed read was repeated");
    assert.ok(unavailable(), "the words did not stay");
    await escape();
    await waitFor("the details to close", () => !boardDialog());
  });

  await check("a card opened earlier and deleted since says the same", async () => {
    assert.equal(detailsReads(openedBefore), 1);
    await deleteElsewhere(openedBefore);
    await click(boardCard(openedBefore)!);
    await waitFor("the words", unavailable);
    assertOffersNothing();
    await waitFor("the card to leave the board", () => !boardCard(openedBefore));
    await waitFor("the count to fall", () => pendingCount() === 4);
    await settle(600);
    assert.equal(detailsReads(openedBefore), 2, "the read was not repeated exactly once on opening");
    await escape();
    await waitFor("the details to close", () => !boardDialog());
  });

  await check("with the report open when it is deleted, an update turns the screen to the same words", async () => {
    await click(boardCard(openWhenDeleted)!);
    const input = await waitFor("the comment bar", () => byTestId("input-activity-comment") as HTMLInputElement | null);
    await deleteElsewhere(openWhenDeleted);
    assert.equal(unavailable(), null, "the screen moved before anything asked");
    await type(input, "ZZ TEST on my way");
    await click(byTestId("button-send-update")!);
    await waitFor("the words", unavailable);
    assertOffersNothing();
    const refused = sent.find((r) => r.method === "POST" && r.path === `/api/fix-reports/${openWhenDeleted}/comments`);
    assert.equal(refused?.status, 404, "the update was not refused");
    await waitFor("the card to leave the board", () => !boardCard(openWhenDeleted));
    await waitFor("the count to fall", () => pendingCount() === 3);
    const stored = await q("select id from fix_comments where fix_id = $1 and message = 'ZZ TEST on my way'", [openWhenDeleted]);
    assert.equal(stored.length, 0, "a comment landed on a deleted report");
    await escape();
    await waitFor("the details to close", () => !boardDialog());
  });

  await check("with the report open when it is deleted, a status change turns the screen to the same words", async () => {
    await click(boardCard(statusWhenDeleted)!);
    await waitFor("the status control", () => byTestId("select-status-change"));
    await deleteElsewhere(statusWhenDeleted);
    await chooseStatus("In Progress");
    await waitFor("the words", unavailable);
    assertOffersNothing();
    const refused = sent.find((r) => r.method === "PATCH" && r.path === `/api/fix-reports/${statusWhenDeleted}/update`);
    assert.equal(refused?.status, 404, "the status change was not refused");
    await waitFor("the card to leave the board", () => !boardCard(statusWhenDeleted));
    await waitFor("the count to fall", () => pendingCount() === 2);
    const [stored] = await q<{ status: string }>("select status from fix_reports where id = $1", [statusWhenDeleted]);
    assert.equal(stored.status, "new", "a status change landed on a deleted report");
    await escape();
    await waitFor("the details to close", () => !boardDialog());
  });

  await check("with the report open when it is deleted, completing it closes the sheet on the same words", async () => {
    await click(boardCard(completedWhenDeleted)!);
    await waitFor("the status control", () => byTestId("select-status-change"));
    await chooseStatus("Complete");
    const skip = await waitFor("the completion sheet", () => byTestId("button-skip-complete"));
    await deleteElsewhere(completedWhenDeleted);
    await click(skip);
    await waitFor("the words", unavailable);
    await waitFor("the completion sheet to close", () => !byTestId("dialog-completion-photos"));
    assertOffersNothing();
    const refused = sent.find((r) => r.method === "PATCH" && r.path === `/api/fix-reports/${completedWhenDeleted}/update`);
    assert.equal(refused?.status, 404, "completing it was not refused");
    await waitFor("the card to leave the board", () => !boardCard(completedWhenDeleted));
    await waitFor("the count to fall", () => pendingCount() === 1);
    const [stored] = await q<{ status: string }>("select status from fix_reports where id = $1", [completedWhenDeleted]);
    assert.equal(stored.status, "new", "completing landed on a deleted report");
    await escape();
    await waitFor("the details to close", () => !boardDialog());
    assert.equal(byTestId("dialog-completion-photos"), null, "the completion sheet came back");
  });

  await check("a first read lost to the connection says the same, and opening again recovers", async () => {
    connectionDropped = true;
    await click(boardCard(onAPoorConnection)!);
    await waitFor("the words", unavailable);
    await escape();
    await waitFor("the details to close", () => !boardDialog());
    connectionDropped = false;
    await click(boardCard(onAPoorConnection)!);
    await waitFor("the comment bar", () => byTestId("input-activity-comment"));
    assert.equal(unavailable(), null, "the words outlasted the connection");
    assert.ok(boardCard(onAPoorConnection), "a live report left the board");
    await escape();
    await waitFor("the details to close", () => !boardDialog());
  });

  await check("a copy already read stays on screen when the connection drops", async () => {
    connectionDropped = true;
    await click(boardCard(onAPoorConnection)!);
    await settle(600);
    connectionDropped = false;
    assert.equal(unavailable(), null, "a dropped connection read as a deletion");
    assert.ok(byTestId("input-activity-comment"), "the comment bar went with the connection");
    await escape();
    await waitFor("the details to close", () => !boardDialog());
  });
  await unmountBoard();

  // ─── A manager's own delete ────────────────────────────────────────────────

  await check("a manager's own delete closes the details without ever saying not available", async () => {
    const deletedHere = await report("deleted here");
    const unmount = await mount(managerCookie, FixBoardPage);
    await click(await waitFor("the card", () => boardCard(deletedHere)));
    await waitFor("the delete button", () => byTestId("button-delete-fix-report"));
    let flashed = false;
    const watch = new dom.window.MutationObserver(() => { flashed ||= !!unavailable(); });
    watch.observe(doc.body, { childList: true, subtree: true });
    await click(byTestId("button-delete-fix-report")!);
    await click(await waitFor("the confirmation", () => byTestId("button-confirm-delete-fix-report")));
    await waitFor("the details to close", () => !boardDialog());
    await waitFor("the card to leave the board", () => !boardCard(deletedHere));
    await settle(600);
    watch.disconnect();
    assert.equal(flashed, false, "the manager's own delete said the report was not available");
    await unmount();
  });

  // ─── My Reports, as the person who reported ────────────────────────────────

  const sheet = () => byTestId("dialog-fix-report-staff-detail");
  const myRow = (id: string) => byTestId(`card-my-report-${id}`);
  const mine = await report("mine, never opened");
  const mineOpened = await report("mine, opened before");
  const unmountMine = await mount(reporterCookie, FixPage);
  await waitFor("both rows", () => myRow(mine) && myRow(mineOpened));

  await check("My Reports says the same for a report deleted elsewhere, and its row leaves", async () => {
    await deleteElsewhere(mine);
    await click(myRow(mine)!);
    await waitFor("the words", unavailable);
    assert.equal(byTestId("input-staff-comment"), null, "the comment bar is still offered");
    await waitFor("the row to leave the list", () => !myRow(mine));
    await settle(600);
    assert.equal(detailsReads(mine), 1, "the failed read was repeated");
    await escape();
    await waitFor("the sheet to close", () => !sheet());
  });

  await check("My Reports says the same for a report opened earlier and deleted since", async () => {
    await click(myRow(mineOpened)!);
    await waitFor("the comment bar", () => byTestId("input-staff-comment"));
    // The reporter line arrives with the details read, a tick after the comment
    // bar renders; waiting for it is the same assertion without the race that
    // failed twice on a busy runner on 9 November 2026.
    await waitFor("the reporter line on a live report", () => byTestId("text-detail-reported-by"));
    await escape();
    await waitFor("the sheet to close", () => !sheet());
    await deleteElsewhere(mineOpened);
    await click(myRow(mineOpened)!);
    await waitFor("the words", unavailable);
    assert.equal(byTestId("input-staff-comment"), null, "the comment bar is still offered");
    assert.equal(byTestId("text-detail-reported-by"), null, "the reporter line reads as a live report");
    await waitFor("the row to leave the list", () => !myRow(mineOpened));
  });
  await unmountMine();

  printLine(`fix-report-unavailable.check: ${checks} checks passed`);
} catch (err) {
  console.error("fix-report-unavailable.check FAILED:", err);
  process.exitCode = 1;
} finally {
  // The job shares one database across the app checks; the tenant-ownership
  // check later re-adds the baseline one-row-per-key unique on settings for a
  // staged simulation, so this check must not leave its park group's rows behind.
  await q("delete from settings where tenant_id = $1", [tenant]).catch(() => {});
  for (const child of children) child.kill();
  await pool.end();
}
process.exit(process.exitCode ?? 0);
